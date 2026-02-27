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
const { updatePop3Error, updateLastFetched, isFetched, saveFetchedUidl } = require('./db');

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

// ---------------------------------------------------------------------------
// POP3 계정 fetch
// ---------------------------------------------------------------------------

const fetchPop3Account = async (account, onProgress) => {
    return new Promise((resolve) => {
        const { id: accountId, pop3_port: port, pop3_host: host, pop3_tls: useTls,
            pop3_user, pop3_pass, user_email, keep_on_server: keepOnServer } = account;

        console.log(`[Fetcher] [${user_email}] Connecting to ${host}:${port} (TLS: ${useTls})`);

        const client = new POP3Client(port, host, {
            tlserrs: false,
            ignoretlserrs: true,
            enabletls: useTls === 1 || useTls === true,
            debug: false,
        });

        let msgcount = 0;
        let currentMsg = 1;
        let successCount = 0;
        let uidlMap = {}; // Index -> UIDL Mapping

        const reportProgress = (processed) => {
            if (onProgress) onProgress(processed, msgcount);
        };

        client.on('error', async (err) => {
            console.error(`[Fetcher] [${user_email}] POP3 error:`, err.message);
            await updatePop3Error(accountId, err.message || 'Connection error');
            client.quit();
            resolve(successCount);
        });

        client.on('connect', () => client.login(pop3_user, pop3_pass));

        client.on('login', (status) => {
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
            if (currentMsg > msgcount) {
                client.quit();
                return;
            }

            const uidl = uidlMap[currentMsg];
            if (uidl) {
                const alreadyFetched = await isFetched(accountId, uidl);
                if (alreadyFetched) {
                    // Skip if already fetched
                    currentMsg++;
                    return fetchNext();
                }
            }

            reportProgress(currentMsg - 1);
            client.retr(currentMsg);
        };

        client.on('uidl', (status, data) => {
            if (!status) {
                // Fallback to list if UIDL is not supported
                return client.list();
            }

            // data is an object: { index: "uidl" }
            uidlMap = data;
            const indices = Object.keys(uidlMap);
            msgcount = indices.length;

            if (msgcount === 0) {
                console.log(`[Fetcher] [${user_email}] No messages on server`);
                reportProgress(0);
                client.quit();
                return;
            }

            console.log(`[Fetcher] [${user_email}] Found ${msgcount} messages via UIDL`);
            fetchNext();
        });

        client.on('list', (status, count) => {
            msgcount = parseInt(count) || 0;
            if (msgcount === 0) {
                reportProgress(0);
                client.quit();
                return;
            }
            fetchNext();
        });

        client.on('retr', async (status, msgnumber, data) => {
            if (!status) {
                console.error(`[Fetcher] [${user_email}] RETR failed for msg ${msgnumber}`);
                currentMsg++;
                return fetchNext();
            }

            try {
                const normalized = normalizePop3Raw(data);
                await deliverRaw(normalized, user_email);

                const uidl = uidlMap[msgnumber];
                if (uidl) await saveFetchedUidl(accountId, uidl);

                successCount++;

                if (keepOnServer) {
                    currentMsg++;
                    fetchNext();
                } else {
                    client.dele(msgnumber);
                }
            } catch (e) {
                console.error(`[Fetcher] [${user_email}] Delivery failed for msg ${msgnumber}:`, e.message);
                currentMsg++;
                fetchNext();
            }
        });

        client.on('dele', () => {
            currentMsg++;
            fetchNext();
        });

        client.on('quit', () => {
            reportProgress(msgcount);
            if (successCount > 0) updateLastFetched(accountId);
            resolve(successCount);
        });
    });
};

module.exports = { fetchPop3Account };
