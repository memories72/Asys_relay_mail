const { getPool } = require('./db');
const { makeClient } = require('./imap');
const { simpleParser } = require('mailparser');
const { repairHeader } = require('./utils');

async function syncMailbox(email, password, mailbox = 'INBOX') {
    const client = makeClient(email, password);
    const pool = getPool();

    try {
        await client.connect();
    } catch (err) {
        console.error(`[Sync] IMAP connect failed for ${email}:`, err.message);
        return;
    }

    let lock;
    try {
        lock = await client.getMailboxLock(mailbox);

        // 1. Get all UIDs and flags currently in the IMAP mailbox
        const imapUids = new Map();
        for await (const msg of client.fetch('1:*', { uid: true, flags: true })) {
            imapUids.set(msg.uid, {
                seen: msg.flags.has('\\Seen'),
                flagged: msg.flags.has('\\Flagged')
            });
        }

        // 2. Get all UIDs currently in the DB for this user/mailbox
        const [dbRows] = await pool.query(
            'SELECT uid, is_seen, is_flagged FROM email_cache WHERE user_email = ? AND mailbox = ?',
            [email, mailbox]
        );
        const dbUids = new Map();
        for (const row of dbRows) {
            dbUids.set(row.uid, {
                seen: row.is_seen === 1,
                flagged: row.is_flagged === 1
            });
        }

        // 3. Determine differences
        const uidsToFetch = [];
        const uidsToUpdateFlags = [];
        const uidsToDelete = [];

        for (const [uid, flags] of imapUids.entries()) {
            if (!dbUids.has(uid)) {
                uidsToFetch.push(uid);
            } else {
                const dbFlags = dbUids.get(uid);
                if (dbFlags.seen !== flags.seen || dbFlags.flagged !== flags.flagged) {
                    uidsToUpdateFlags.push({ uid, flags });
                }
            }
        }

        for (const uid of dbUids.keys()) {
            if (!imapUids.has(uid)) {
                uidsToDelete.push(uid);
            }
        }

        console.log(`[Sync] ${email} / ${mailbox}: ${uidsToFetch.length} new, ${uidsToUpdateFlags.length} flag updates, ${uidsToDelete.length} deleted.`);

        // 4. Delete removed emails from DB
        if (uidsToDelete.length > 0) {
            // chunk deletion to avoid sql placeholder limits if too large
            for (let i = 0; i < uidsToDelete.length; i += 1000) {
                const chunk = uidsToDelete.slice(i, i + 1000);
                await pool.query(
                    `DELETE FROM email_cache WHERE user_email = ? AND mailbox = ? AND uid IN (?)`,
                    [email, mailbox, chunk]
                );
            }
        }

        // 5. Update changed flags in DB
        for (const { uid, flags } of uidsToUpdateFlags) {
            await pool.query(
                `UPDATE email_cache SET is_seen = ?, is_flagged = ? WHERE user_email = ? AND mailbox = ? AND uid = ?`,
                [flags.seen, flags.flagged, email, mailbox, uid]
            );
        }

        // 6. Fetch full metadata for new emails
        if (uidsToFetch.length > 0) {
            // Fetch in chunks to avoid IMAP string limits (uid: '1,2,3...')
            for (let i = 0; i < uidsToFetch.length; i += 500) {
                const chunk = uidsToFetch.slice(i, i + 500);
                const sequence = chunk.join(',');

                for await (const msg of client.fetch(sequence, {
                    uid: true, flags: true, envelope: true, bodyStructure: true,
                    headers: ['subject', 'from', 'to', 'message-id', 'in-reply-to', 'references']
                })) {
                    const parsedHeaders = await simpleParser(msg.headers);

                    const rawSubBuf = (() => {
                        const hText = msg.headers.toString('binary');
                        const match = hText.match(/^Subject:\s*((?:[^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*))/mi);
                        if (match && match[1].trim() !== '') {
                            return Buffer.from(match[1].replace(/\r?\n[ \t]+/g, ' ').trim(), 'binary');
                        }
                        return null;
                    })();

                    const subject = repairHeader(rawSubBuf) || repairHeader(parsedHeaders.subject) || repairHeader(msg.envelope.subject) || '(제목 없음)';
                    const parsedFrom = parsedHeaders.from?.value?.[0];
                    const envFrom = msg.envelope.from?.[0];
                    const senderName = repairHeader(parsedFrom?.name ?? envFrom?.name) || '';
                    const senderAddress = parsedFrom?.address ?? (envFrom ? `${envFrom.mailbox}@${envFrom.host}` : '');

                    const finalTo = (parsedHeaders.to?.value || msg.envelope.to || []).map(t => ({
                        name: repairHeader(t.name) || '',
                        address: t.address || (t.mailbox ? `${t.mailbox}@${t.host}` : '')
                    }));

                    const hasAttachments = msg.bodyStructure?.childNodes !== undefined ||
                        (msg.bodyStructure?.disposition?.toLowerCase() === 'attachment');

                    const messageId = msg.envelope?.messageId || '';
                    const inReplyTo = msg.envelope?.inReplyTo || '';
                    const date = msg.envelope?.date ? new Date(msg.envelope.date) : new Date();

                    // --- MAIL RULES ENGINE INTEGRATION ---
                    // Run rules for the new message. If it's moved or deleted, stop processing it for this mailbox.
                    const { processRules } = require('./rules');
                    try {
                        const messageForRules = {
                            uid: msg.uid,
                            subject,
                            fromAddress: senderAddress,
                            sender_address: senderAddress,
                            from: senderAddress, // alias
                            to: finalTo,
                            recipient_address: JSON.stringify(finalTo),
                            date
                        };
                        const ruleProcessed = await processRules(email, mailbox, messageForRules, client);
                        if (ruleProcessed) {
                            console.log(`[Sync] Rule applied: Message ${msg.uid} was moved or deleted from ${mailbox}. Skipping cache.`);
                            continue; // Skip DB insertion for this folder
                        }
                    } catch (ruleErr) {
                        console.error('[Sync] Rule processing error:', ruleErr.message);
                    }
                    // -------------------------------------

                    await pool.query(`
                        INSERT INTO email_cache 
                        (user_email, mailbox, uid, message_id, in_reply_to, sender_name, sender_address, recipient_address, subject, date, is_seen, is_flagged, has_attachments, size) 
                        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        ON DUPLICATE KEY UPDATE
                        is_seen = VALUES(is_seen), is_flagged = VALUES(is_flagged)
                    `, [
                        email, mailbox, msg.uid, messageId, inReplyTo, senderName, senderAddress, JSON.stringify(finalTo), subject, date,
                        msg.flags.has('\\Seen'), msg.flags.has('\\Flagged'), hasAttachments, msg.size || 0
                    ]);
                }
            }
        }

    } catch (err) {
        console.error(`[Sync] Error syncing mailbox ${mailbox} for ${email}:`, err.message);
    } finally {
        if (lock) lock.release();
        await client.logout();
    }
}

async function getCachedMailList(email, mailbox, limit) {
    const pool = getPool();
    const limitClause = limit > 0 ? `LIMIT ${parseInt(limit)}` : '';

    // Read from DB with tags grouped together by email ID
    const [rows] = await pool.query(`
        SELECT 
            ec.*,
            (
                SELECT JSON_ARRAYAGG(JSON_OBJECT('id', t.id, 'name', t.name, 'color', t.color))
                FROM email_tags et
                JOIN tags t ON et.tag_id = t.id
                WHERE et.email_cache_id = ec.id
            ) as tagsJSON
        FROM email_cache ec
        WHERE user_email = ? AND mailbox = ?
        ORDER BY date DESC
        ${limitClause}
    `, [email, mailbox]);

    return rows.map(r => {
        let toArr = [];
        try { toArr = JSON.parse(r.recipient_address || '[]'); } catch (e) { }

        let tags = [];
        try {
            if (r.tagsJSON) {
                tags = JSON.parse(r.tagsJSON);
            }
        } catch (e) { }

        return {
            uid: r.uid,
            seq: 0,
            subject: r.subject || '(제목 없음)',
            from: { name: r.sender_name || '', address: r.sender_address || '' },
            to: toArr,
            date: r.date,
            seen: r.is_seen === 1,
            flagged: r.is_flagged === 1,
            hasAttachment: r.has_attachments === 1,
            attachmentCount: r.has_attachments ? 1 : 0,
            tags: tags
        };
    });
}

async function getDeduplicatedStats(email) {
    const pool = getPool();

    // Using an intelligent SQL to count unique Message-IDs or fallback to UIDs
    // Filters:
    // - Only for this user (user_email partition)
    // - Deduplicated by Message-ID (or UID if missing)
    // - Restricted to the user's own identity to avoid noise in shared relay folders
    const [rows] = await pool.query(`
        SELECT 
            SUM(CASE WHEN LOWER(mailbox) = 'inbox' THEN 1 ELSE 0 END) AS inbox,
            SUM(CASE WHEN LOWER(mailbox) LIKE '%sent%' THEN 1 ELSE 0 END) AS sent,
            SUM(CASE WHEN LOWER(mailbox) LIKE '%trash%' OR LOWER(mailbox) LIKE '%휴지통%' THEN 1 ELSE 0 END) AS trash,
            SUM(CASE WHEN LOWER(mailbox) LIKE '%junk%' OR LOWER(mailbox) LIKE '%spam%' THEN 1 ELSE 0 END) AS junk,
            SUM(CASE WHEN LOWER(mailbox) LIKE '%draft%' THEN 1 ELSE 0 END) AS drafts
        FROM (
            SELECT mailbox, MIN(uid) as min_uid 
            FROM email_cache 
            WHERE user_email = ?
            AND (
                sender_address = ? 
                OR recipient_address LIKE ?
                OR mailbox != 'INBOX' -- Trust non-inbox folders as intentionally organized
            )
            GROUP BY mailbox, COALESCE(NULLIF(message_id, ''), CAST(uid AS CHAR))
        ) AS distinct_mails
    `, [email, email, `%${email}%`]);

    return {
        inbox: rows[0].inbox || 0,
        sent: rows[0].sent || 0,
        trash: rows[0].trash || 0,
        junk: rows[0].junk || 0,
        drafts: rows[0].drafts || 0
    };
}

module.exports = {
    syncMailbox,
    getCachedMailList,
    getDeduplicatedStats
};
