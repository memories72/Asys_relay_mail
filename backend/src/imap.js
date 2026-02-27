'use strict';
const { ImapFlow } = require('imapflow');
const { simpleParser } = require('mailparser');
const { repairLiteralMime, safeDecodeQP, unmangleString, isLikelyMangled, repairHeader } = require('./utils');

const IMAP_HOST = process.env.IMAP_HOST || 'node_mail_engine';
const IMAP_PORT = parseInt(process.env.IMAP_PORT || '143');

function makeClient(email, password) {
    return new ImapFlow({
        host: IMAP_HOST,
        port: IMAP_PORT,
        secure: false,
        auth: { user: email, pass: password },
        logger: false,
        tls: { rejectUnauthorized: false },
        connectionTimeout: 10000,
        greetingTimeout: 5000,
    });
}

/**
 * Recursively parse MIME bodyStructure to find attachments
 */
function parseAttachments(structure, partId = '') {
    const attachments = [];
    if (!structure) return attachments;

    // Leaf node
    if (!structure.childNodes) {
        const disp = structure.disposition || '';
        const type = `${structure.type}/${structure.subtype}`.toLowerCase();
        const isAttachment = disp.toLowerCase() === 'attachment' ||
            (structure.dispositionParameters?.filename) ||
            (structure.parameters?.name);
        if (isAttachment) {
            const filename =
                structure.dispositionParameters?.filename ||
                structure.parameters?.name ||
                `attachment${partId}`;
            const size = structure.size || 0;
            attachments.push({
                partId: partId || '1',
                filename,
                mimeType: type,
                size,
                encoding: structure.encoding || '7bit',
            });
        }
        return attachments;
    }

    // Multi-part: recurse into children
    structure.childNodes.forEach((child, idx) => {
        const childId = partId ? `${partId}.${idx + 1}` : `${idx + 1}`;
        attachments.push(...parseAttachments(child, childId));
    });
    return attachments;
}

async function fetchMailList(email, password, mailbox = 'INBOX', limit = 1000) {
    const client = makeClient(email, password);
    await client.connect();
    try {
        const lock = await client.getMailboxLock(mailbox);
        try {
            const total = client.mailbox.exists || 0;
            if (total === 0) return [];
            const from = limit > 0 ? Math.max(1, total - limit + 1) : 1;
            const messages = [];
            for await (const msg of client.fetch(`${from}:*`, {
                uid: true, flags: true, envelope: true, bodyStructure: true,
                headers: ['subject', 'from', 'to'],
            })) {
                const attachments = parseAttachments(msg.bodyStructure);

                // ── 헤더 파싱 전략 ─────────────────────────────────────────────
                // simpleParser를 headers Buffer에만 적용하여:
                //  1. Subject / From display-name / To display-name을 RFC2047 디코딩
                //  2. From/To를 {name, address}로 분리 (address는 ASCII이므로 손실 없음)
                //  3. repairHeader로 EUC-KR 등 charset fallback 처리
                //
                // 이전 방식의 버그:
                //   repairHeader(rawFrom) → 전체 "Name <addr>" 문자열을 name 필드로 사용
                //   → 프론트에 "DB손해보험 <email>" 이 통째로 name으로 보임
                const parsedHeaders = await simpleParser(msg.headers);

                // Subject: simpleParser decode + our repair fallback for EUC-KR edge cases
                const rawSubBuf = (() => {
                    const hText = msg.headers.toString('binary');
                    for (const line of hText.split(/\r?\n/)) {
                        if (line.toLowerCase().startsWith('subject:')) {
                            return Buffer.from(line.substring('subject:'.length).trim(), 'binary');
                        }
                    }
                    return null;
                })();
                const subject = repairHeader(rawSubBuf ?? parsedHeaders.subject ?? msg.envelope.subject);

                // From: simpleParser가 name과 address를 분리해줌
                // From: simpleParser가 name과 address를 분리해줌
                const parsedFrom = parsedHeaders.from?.value?.[0];
                const envFrom = msg.envelope.from?.[0];
                const finalFrom = {
                    name: repairHeader(parsedFrom?.name ?? envFrom?.name),
                    address: parsedFrom?.address ?? (envFrom ? `${envFrom.mailbox}@${envFrom.host}` : ''),
                };

                // To: multiple recipients might exist
                const finalTo = (parsedHeaders.to?.value || msg.envelope.to || []).map(t => ({
                    name: repairHeader(t.name),
                    address: t.address || (t.mailbox ? `${t.mailbox}@${t.host}` : '')
                }));

                messages.push({
                    uid: msg.uid,
                    seq: msg.seq,
                    subject: subject || '(제목 없음)',
                    from: finalFrom,
                    to: finalTo,
                    date: msg.envelope.date,
                    seen: msg.flags.has('\\Seen'),
                    flagged: msg.flags.has('\\Flagged'),
                    hasAttachment: attachments.length > 0,
                    attachmentCount: attachments.length,
                });
            }
            return messages.reverse();
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
}

async function fetchMailBody(email, password, uid, mailbox = 'INBOX') {
    const client = makeClient(email, password);
    await client.connect();
    try {
        const lock = await client.getMailboxLock(mailbox);
        try {
            let result = null;
            for await (const msg of client.fetch({ uid }, {
                uid: true, envelope: true, source: true, bodyStructure: true,
            }, { uid: true })) {

                // ── 올바른 MIME 파싱 ────────────────────────────────────────────
                // msg.source = 완전한 RFC 822 raw 메시지 Buffer
                // simpleParser가 multipart 구조, base64, QP, charset을 모두 처리함
                // 이전 방식(regex + split)은 base64 덩어리가 그대로 노출되는 버그 유발
                const parsed = await simpleParser(msg.source, {
                    skipHtmlToText: false,
                    skipTextToHtml: false,
                    skipImageLinks: false,
                    decodeStrings: true,
                });

                const attachments = parseAttachments(msg.bodyStructure);

                result = {
                    uid: msg.uid,
                    subject: repairHeader(parsed.subject || msg.envelope.subject) || '(제목 없음)',
                    from: {
                        name: repairHeader(parsed.from?.value?.[0]?.name || msg.envelope.from?.[0]?.name),
                        address: parsed.from?.value?.[0]?.address || (msg.envelope.from?.[0] ? `${msg.envelope.from[0].mailbox}@${msg.envelope.from[0].host}` : ''),
                    },
                    to: (msg.envelope.to || []).map(t => ({
                        name: repairHeader(t.name),
                        address: t.address || (t.mailbox ? `${t.mailbox}@${t.host}` : '')
                    })),
                    cc: (msg.envelope.cc || []).map(t => ({
                        name: repairHeader(t.name),
                        address: t.address || (t.mailbox ? `${t.mailbox}@${t.host}` : '')
                    })),
                    bcc: (msg.envelope.bcc || []).map(t => ({
                        name: repairHeader(t.name),
                        address: t.address || (t.mailbox ? `${t.mailbox}@${t.host}` : '')
                    })),
                    date: parsed.date || msg.envelope.date,
                    html: parsed.html || null,
                    text: parsed.text || null,
                    attachments,
                };
            }
            return result;
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
}

/**
 * Download a specific attachment by partId and return as Buffer.
 * 
 * imapflow의 client.download(uid, partId) 는 Dovecot에서 특정 MIME 구조
 * (특히 partId가 "2.2" 같은 중첩 경로)에서 "Command failed"를 반환하는 버그가 있음.
 * 대신 전체 source를 fetch 후 simpleParser로 첨부파일을 추출함.
 */
async function downloadAttachment(email, password, uid, partId, mailbox = 'INBOX', filename = '') {
    console.log(`[IMAP] downloadAttachment uid=${uid} partId=${JSON.stringify(partId)} mailbox=${mailbox}`);
    const client = makeClient(email, password);
    await client.connect();
    try {
        const lock = await client.getMailboxLock(mailbox);
        try {
            // 전체 소스를 가져와서 mailparser로 첨부파일 추출
            let source = null;
            for await (const msg of client.fetch({ uid }, { uid: true, source: true }, { uid: true })) {
                source = msg.source;
            }
            if (!source) throw new Error('Message not found');

            const parsed = await simpleParser(source);

            const attachments = parsed.attachments || [];
            console.log(`[IMAP] Found ${attachments.length} attachments in parsed message`);
            attachments.forEach((a, i) => {
                console.log(`  [${i}] filename=${JSON.stringify(a.filename)} contentType=${a.contentType} size=${a.size}`);
            });

            if (attachments.length === 0) throw new Error('No attachments in message');

            // 매칭 전략 (우선순위 순):
            // 1. filename 일치 (가장 안정적)
            // 2. partId를 숫자 인덱스로 해석
            // 3. 첫 번째 첨부파일 fallback
            let attachment =
                attachments.find(a => a.filename === filename) ||
                attachments[parseInt(partId, 10)] ||
                attachments[0];

            if (!attachment) throw new Error(`Attachment not found (partId=${partId})`);

            const buffer = attachment.content;
            console.log(`[IMAP] downloadAttachment OK size=${buffer.length} contentType=${attachment.contentType}`);
            return {
                buffer,
                meta: { contentType: attachment.contentType, filename: attachment.filename }
            };
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
}

async function markSeen(email, password, uid, mailbox = 'INBOX') {
    const client = makeClient(email, password);
    await client.connect();
    try {
        const lock = await client.getMailboxLock(mailbox, { readOnly: false });
        try {
            await client.messageFlagsAdd({ uid }, ['\\Seen'], { uid: true });
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
}

async function moveMessages(email, password, uids, targetMailbox, sourceMailbox = 'INBOX') {
    const client = makeClient(email, password);
    await client.connect();
    try {
        const lock = await client.getMailboxLock(sourceMailbox, { readOnly: false });
        try {
            await client.messageMove(uids, targetMailbox, { uid: true });
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
}

async function moveToTrash(email, password, uidOrUids, mailbox = 'INBOX') {
    const client = makeClient(email, password);
    await client.connect();
    try {
        const lock = await client.getMailboxLock(mailbox, { readOnly: false });
        try {
            const trashBoxes = ['Trash', 'INBOX.Trash', '[Gmail]/Trash', '휴지통'];
            let moved = false;
            // If already in trash, just delete permanently
            if (trashBoxes.includes(mailbox)) {
                await client.messageFlagsAdd(uidOrUids, ['\\Deleted'], { uid: true });
                await client.mailboxClose();
                return;
            }

            for (const trash of trashBoxes) {
                try {
                    await client.messageMove(uidOrUids, trash, { uid: true });
                    moved = true;
                    break;
                } catch (e) { /* try next */ }
            }
            if (!moved) {
                await client.messageFlagsAdd(uidOrUids, ['\\Deleted'], { uid: true });
                await client.mailboxClose();
            }
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
}

async function permanentlyDelete(email, password, uidOrUids, mailbox = 'INBOX') {
    const client = makeClient(email, password);
    await client.connect();
    try {
        const lock = await client.getMailboxLock(mailbox, { readOnly: false });
        try {
            await client.messageFlagsAdd(uidOrUids, ['\\Deleted'], { uid: true });
            await client.mailboxClose(); // Expunges by default in imapflow
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
}

async function emptyMailbox(email, password, mailbox = 'Trash') {
    const client = makeClient(email, password);
    await client.connect();
    try {
        const lock = await client.getMailboxLock(mailbox, { readOnly: false });
        try {
            await client.messageFlagsAdd('1:*', ['\\Deleted']);
            await client.mailboxClose();
        } finally {
            lock.release();
        }
    } finally {
        await client.logout();
    }
}

async function listMailboxes(email, password) {
    const client = makeClient(email, password);
    await client.connect();
    try {
        const boxes = await client.list();
        return boxes.map(box => ({
            name: box.name,
            path: box.path,
            flags: [...(box.flags || [])]
        }));
    } finally {
        await client.logout();
    }
}

async function appendMessage(email, password, mailbox, messageBuffer, flags = ['\\Seen']) {
    const client = makeClient(email, password);
    await client.connect();
    try {
        const lock = await client.getMailboxLock(mailbox, { readOnly: false });
        try {
            await client.append(mailbox, messageBuffer, flags);
        } finally {
            lock.release();
        }

    } finally {
        await client.logout();
    }
}

async function getStorageQuota(email, password) {
    const client = makeClient(email, password);
    await client.connect();

    // Add a strict timeout to this entire operation
    return Promise.race([
        new Promise((resolve) => {
            setTimeout(() => {
                client.logout().catch(() => { });
                resolve({ usage: 0, limit: 10 * 1024 * 1024 * 1024 });
            }, 8000); // 8 second max timeout
        }),
        (async () => {
            try {
                let usage = 0;
                let limit = 10 * 1024 * 1024 * 1024; // Default: 10 GB

                // Method 1: IMAP QUOTA extension (Fastest & most accurate if supported)
                try {
                    // Try to get quota for INBOX root
                    const quota = await client.getQuota('INBOX');
                    if (quota && quota.storage) {
                        // IMAP QUOTA storage resource is in units of 1024 octets (KB)
                        if (quota.storage.usage !== undefined) usage = quota.storage.usage * 1024;
                        if (quota.storage.limit !== undefined) limit = quota.storage.limit * 1024;
                        console.log(`[QUOTA] Success via extension for ${email}: ${usage} / ${limit}`);
                        return { usage, limit };
                    }
                } catch (e) {
                    console.warn(`[QUOTA] Extension failed for ${email}: ${e.message}. Trying full folder scan fallback.`);
                }

                // Method 2: Fallback estimation (Iterate all folders)
                try {
                    const mailboxes = await client.list();
                    let estimatedUsage = 0;
                    for (const box of mailboxes) {
                        try {
                            // STATUS command with 'size' item (RFC 8438)
                            const st = await client.status(box.path, { size: true });
                            if (st && st.size !== undefined) {
                                estimatedUsage += st.size;
                            }
                        } catch (err) {
                            // Some folders might be restricted or not support STATUS
                        }
                    }
                    usage = estimatedUsage;
                    console.log(`[QUOTA] Success via folder scan for ${email}: ${usage} bytes`);
                } catch (err) {
                    console.error(`[QUOTA] Fallback scan failed for ${email}:`, err.message);
                }

                return { usage, limit };
            } catch (e) {
                console.error(`[QUOTA] Critical error for ${email}:`, e);
                return { usage: 0, limit: 10 * 1024 * 1024 * 1024 };
            } finally {
                await client.logout().catch(() => { });
            }
        })()
    ]);
}

async function getMailboxStatus(email, password) {
    const client = makeClient(email, password);
    await client.connect();
    try {
        const stats = {
            inbox: 0,
            sent: 0,
            trash: 0,
            junk: 0,
            drafts: 0
        };
        const mailboxes = await client.list();
        for (const box of mailboxes) {
            try {
                const st = await client.status(box.path, { messages: true });
                if (st && st.messages !== undefined) {
                    const pathLower = box.path.toLowerCase();
                    if (pathLower === 'inbox') stats.inbox += st.messages;
                    else if (pathLower.includes('sent')) stats.sent += st.messages;
                    else if (pathLower.includes('trash') || pathLower.includes('휴지통')) stats.trash += st.messages;
                    else if (pathLower.includes('junk') || pathLower.includes('spam')) stats.junk += st.messages;
                    else if (pathLower.includes('draft')) stats.drafts += st.messages;
                }
            } catch (err) {
                // Ignore errors for specific folders if they can't be stat-ed
            }
        }
        return stats;
    } finally {
        await client.logout().catch(() => { });
    }
}

module.exports = { fetchMailList, fetchMailBody, downloadAttachment, markSeen, moveToTrash, listMailboxes, moveMessages, permanentlyDelete, emptyMailbox, appendMessage, getStorageQuota, getMailboxStatus };
