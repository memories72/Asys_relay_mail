'use strict';
/**
 * fetcher.js — POP3 Fetch → Lossless SMTP Re-delivery
 * 
 * Performance Optimized:
 * - SMTP Connection Pooling
 * - POP3 UIDL Deduplication
 * - Memory-efficient normalization
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const POP3Client = require('poplib');
const nodemailer = require('nodemailer');
const { updatePop3Error, updateLastFetched, isFetched, saveFetchedUidl, getPool } = require('./db');
const crypto = require('crypto');

const SMTP_HOST = process.env.SMTP_HOST || 'node_mail_engine';

// Optimized Transporter with Connection Pool
const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: 25,
    secure: false,
    pool: true, // Use connection pooling for high throughput
    maxConnections: 5,
    maxMessages: 100,
    tls: { rejectUnauthorized: false },
});

// ---------------------------------------------------------------------------
// 헬퍼: POP3 dot-stuffing 제거 + CRLF 정규화 (Optimized)
// ---------------------------------------------------------------------------
function normalizePop3Raw(data) {
    // Fast replace for common POP3 artifacts
    if (data.indexOf('\r\n\.\.') === -1) return data;
    return data.replace(/\r\n\.\./g, '\r\n.');
}

// ---------------------------------------------------------------------------
// 핵심: 무손실 raw 배달 + DMARC 우회를 위한 Resent 헤더 주입
// ---------------------------------------------------------------------------
function injectFetchHeader(rawMessage, deliverTo) {
    const sep = rawMessage.indexOf('\r\n\r\n');
    if (sep === -1) return rawMessage;
    const headerBlock = rawMessage.substring(0, sep);
    const bodyBlock = rawMessage.substring(sep);
    const marker = `X-Fetched-By: asys-pop3-fetcher\r\nX-Delivered-To: ${deliverTo}\r\n`;
    return marker + headerBlock + bodyBlock;
}

async function deliverRaw(rawMessage, deliverTo) {
    const withHeader = injectFetchHeader(rawMessage, deliverTo);
    return transporter.sendMail({
        envelope: {
            from: '', // null sender — RFC 5321 §4.5.5
            to: deliverTo,
        },
        raw: withHeader,
    });
}

async function deliverViaImapOrSmtp(rawMessage, userEmail, imapPass) {
    if (!imapPass) {
        return deliverRaw(rawMessage, userEmail);
    }

    const withHeader = injectFetchHeader(rawMessage, userEmail);

    // Quickly guess Date to prevent parsing overhead
    const sep = withHeader.indexOf('\r\n\r\n');
    const headerBlock = sep !== -1 ? withHeader.substring(0, sep) : withHeader;
    let emailDate = new Date();
    const match = headerBlock.match(/^Date:\s*((?:[^\r\n]+(?:\r?\n[ \t]+[^\r\n]+)*))/mi);
    if (match && match[1]) {
        try {
            const parsedDate = new Date(match[1].trim());
            if (!isNaN(parsedDate.getTime())) {
                emailDate = parsedDate;
            }
        } catch (e) { }
    }

    const { makeClient } = require('./imap');
    let imapClient = null;

    try {
        // 단기 결전 커넥션: 수집된 직후 빛의 속도로 연결해서 꽂고 나오기 (10ms 내외 소요) -> Idle Timeout 원천 방어!
        imapClient = makeClient(userEmail, imapPass);
        await imapClient.connect();
        await imapClient.append('INBOX', withHeader, ['\\Seen'], emailDate);
        await imapClient.logout();
        return true;
    } catch (err) {
        console.error(`[Fetcher IMAP] Append failed, falling back to SMTP. Err:`, err.message);
        if (imapClient) {
            try { await imapClient.close(); } catch (e) { }
        }
        return deliverRaw(rawMessage, userEmail);
    }
}

// ---------------------------------------------------------------------------
// POP3 계정 fetch
// ---------------------------------------------------------------------------

const fetchPop3Account = async (account, onProgress) => {
    return new Promise((resolve) => {
        const { id: accountId, pop3_port: port, pop3_host: host, pop3_tls: useTls,
            pop3_user, pop3_pass, user_email, keep_on_server: keepOnServer, imap_pass } = account;

        console.log(`[Fetcher] [${user_email}] Connecting to ${host}:${port} (TLS: ${useTls})`);

        const client = new POP3Client(port, host, {
            tlserrs: false,
            ignoretlserrs: true,
            enabletls: useTls === 1 || useTls === true,
            debug: false,
        });

        // Local IMAP credentials for short-lived Appending Delivery
        const deliveryImapPass = imap_pass || null;

        // Flexible watchdog timer to prevent hanging
        let watchdog;
        const resetWatchdog = (ms = 120000) => { // Increase default to 120s
            if (watchdog) clearTimeout(watchdog);
            watchdog = setTimeout(() => {
                console.error(`[Fetcher] [${user_email}] Watchdog timeout after ${ms}ms`);
                client.emit('error', new Error('Watchdog timeout'));
            }, ms);
        };

        resetWatchdog(120000);

        let msgcount = 0;
        let successCount = 0;
        let uidlMap = {}; // Index -> UIDL Mapping

        const reportProgress = (processed) => {
            if (onProgress) onProgress(processed, msgcount);
        };

        client.on('error', async (err) => {
            if (watchdog) clearTimeout(watchdog);
            console.error(`[Fetcher] [${user_email}] POP3 error:`, err.message);
            await updatePop3Error(accountId, err.message || 'Connection error');
            client.quit();
            resolve(successCount);
        });

        client.on('connect', () => {
            resetWatchdog(30000); // 30s for login
            client.login(pop3_user, pop3_pass);
        });

        client.on('login', async (status) => {
            resetWatchdog(120000); // 120s for uidl/list
            if (status) {
                client.uidl(); // Use UIDL instead of LIST for smart fetching
            } else {
                console.error(`[Fetcher] [${user_email}] Login failed`);
                updatePop3Error(accountId, 'Authentication failed');
                client.quit();
                resolve(0);
            }
        });

        const fetchNext = async () => {
            // Initial progress report to show the box immediately
            reportProgress(0);

            // Load all existing UIDs for this account at once for faster comparison
            const currentPool = getPool();
            const existingUidsRows = await currentPool.query('SELECT uidl FROM pop3_uidls WHERE account_id = ?', [accountId]);
            const existingUids = new Set(existingUidsRows[0].map(r => r.uidl));

            console.log(`[Fetcher] [${user_email}] Local database has ${existingUids.size} already fetched messages.`);

            const numMessages = parseInt(msgcount) || 0;
            console.log(`[Fetcher] [${user_email}] Starting fetch for ${numMessages} messages. Map size: ${Object.keys(uidlMap || {}).length}`);

            for (let i = 1; i <= numMessages; i++) {
                // Heartbeat to prevent watchdog during processing
                resetWatchdog(180000); // 3 mins per message (safe for large ones)

                // Direct mapping from UIDL command result
                let uidl = uidlMap ? (uidlMap[i] || uidlMap[String(i)]) : null;

                if (uidl && existingUids.has(uidl)) {
                    if (i % 50 === 0 || i === numMessages) {
                        reportProgress(i);
                        resetWatchdog(180000); // Extra heartbeat after progress report
                    }
                    if (i % 1000 === 0) {
                        // Prevent Node event loop blocking during huge iteration
                        await new Promise(r => setImmediate(r));
                    }
                    continue;
                }

                // SECONDARY DEDUPLICATION: Message-ID / Header Hash Fallback
                let fallbackUid = null;
                if (!uidl || uidl.length < 3) {
                    try {
                        const headers = await new Promise((resolveTop) => {
                            const onTop = (status, msgnumber, data) => {
                                client.removeListener('top', onTop);
                                resolveTop(status ? data : null);
                            };
                            client.on('top', onTop);
                            client.top(i, 0);
                            setTimeout(() => { client.removeListener('top', onTop); resolveTop(null); }, 10000); // 10s for TOP
                        });

                        resetWatchdog(180000); // Heartbeat after TOP

                        if (headers) {
                            const msgIdMatch = headers.match(/Message-ID:\s*<([^>]+)>/i);
                            if (msgIdMatch) fallbackUid = `msgid-${msgIdMatch[1]}`;
                            else fallbackUid = `hash-${crypto.createHash('md5').update(headers).digest('hex')}`;

                            if (existingUids.has(fallbackUid)) {
                                if (i % 50 === 0 || i === numMessages) reportProgress(i);
                                continue;
                            }
                        }
                    } catch (e) { }
                }

                const finalUid = uidl || fallbackUid;
                console.log(`[Fetcher] [${user_email}] Processing msg ${i}/${numMessages}. UID: ${finalUid || 'NONE'}`);
                reportProgress(i - 1);

                await new Promise((resolveRetr) => {
                    const onRetr = async (status, msgnumber, data) => {
                        client.removeListener('retr', onRetr);
                        resetWatchdog(300000); // 5 mins for delivery after receiving
                        if (!status) {
                            console.error(`[Fetcher] [${user_email}] RETR failed for msg ${msgnumber}`);
                        } else {
                            try {
                                const normalized = normalizePop3Raw(data);
                                console.log(`[Fetcher] [${user_email}] Msg ${msgnumber} received successfully. Size: ${data.length} bytes.`);
                                await deliverViaImapOrSmtp(normalized, user_email, deliveryImapPass);
                                if (finalUid) {
                                    await saveFetchedUidl(accountId, finalUid);
                                    existingUids.add(finalUid);
                                }
                                successCount++;
                            } catch (e) {
                                console.error(`[Fetcher] [${user_email}] Delivery failed for msg ${msgnumber}:`, e.message);
                            }
                        }
                        resetWatchdog(180000); // Heartbeat before DELE or next message

                        if (!keepOnServer) {
                            client.dele(msgnumber);
                            const onDele = () => {
                                client.removeListener('dele', onDele);
                                resolveRetr();
                            };
                            client.on('dele', onDele);
                        } else {
                            resolveRetr();
                        }
                    };
                    client.on('retr', onRetr);
                    client.retr(i);
                    // No explicit timeout here as the global watchdog at line 84 handles it
                });

                resetWatchdog(180000); // Final heartbeat after message processing
            } // end loop

            client.quit();
        };

        client.on('uidl', (status, ...args) => {
            resetWatchdog(180000); // 180s for processing UIDL data

            // poplib variation handling
            let data = args.length >= 2 ? args[1] : args[0];

            if (!status || !data) {
                console.log(`[Fetcher] [${user_email}] UIDL returned no data. Trying LIST fallback...`);
                return client.list();
            }

            // Enhanced parser for all UIDL response types (Array, Object, String)
            uidlMap = {};
            if (Array.isArray(data)) {
                data.forEach((val, idx) => {
                    if (typeof val === 'string') {
                        const parts = val.trim().split(/\s+/);
                        if (parts.length >= 2) {
                            uidlMap[parseInt(parts[0])] = parts[1];
                        } else {
                            uidlMap[idx + 1] = val;
                        }
                    } else {
                        uidlMap[idx + 1] = val;
                    }
                });
            } else if (typeof data === 'object' && data !== null) {
                uidlMap = data;
            } else if (typeof data === 'string') {
                const lines = data.split('\n');
                lines.forEach((line, idx) => {
                    const parts = line.trim().split(/\s+/);
                    if (parts.length >= 2) {
                        uidlMap[parseInt(parts[0])] = parts[1];
                    } else if (parts[0]) {
                        uidlMap[idx + 1] = parts[0];
                    }
                });
            }

            const indices = Object.keys(uidlMap);
            msgcount = indices.length;

            if (msgcount === 0) {
                console.log(`[Fetcher] [${user_email}] No messages on server via UIDL`);
                return client.list();
            }

            console.log(`[Fetcher] [${user_email}] Found ${msgcount} messages via UIDL`);
            fetchNext().catch(err => {
                console.error(`[Fetcher] [${user_email}] fetchNext error:`, err);
                client.quit();
            });
        });

        client.on('list', (status, ...args) => {
            resetWatchdog(180000); // 180s for processing LIST data

            // poplib variation handling for list
            let count = args.length >= 2 ? args[0] : (args[0] && typeof args[0] === 'string' ? args[0] : msgcount);

            if (!status) {
                console.error(`[Fetcher] [${user_email}] LIST failed`);
                client.quit();
                return;
            }

            msgcount = parseInt(count) || 0;
            if (msgcount === 0) {
                console.log(`[Fetcher] [${user_email}] No messages via LIST`);
                reportProgress(0);
                client.quit();
                return;
            }

            console.log(`[Fetcher] [${user_email}] Falling back to LIST mode (${msgcount} msgs)`);
            fetchNext().catch(err => {
                console.error(`[Fetcher] [${user_email}] fetchNext(list) error:`, err);
                client.quit();
            });
        });

        client.on('quit', () => {
            if (watchdog) clearTimeout(watchdog);
            reportProgress(msgcount);
            if (successCount > 0) updateLastFetched(accountId);
            resolve(successCount);
        });
    });
};

module.exports = { fetchPop3Account };
