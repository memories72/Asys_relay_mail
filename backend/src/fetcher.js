'use strict';
/**
 * fetcher.js — POP3 Fetch → Lossless SMTP Re-delivery
 *
 * 아키텍처:
 * - MIME 구조를 건드리지 않고 raw 방식으로 로컬 배달
 * - SMTP Envelope만 교체 (MAIL FROM, RCPT TO)
 * - DMARC 우회: 로컬 Postfix에 직접 inject (permit_mynetworks 경로)
 *   → 외부 서버가 아닌 내부 네트워크이므로 DMARC 검사 적용 안 됨
 */
process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';

const POP3Client = require('poplib');
const nodemailer = require('nodemailer');
const { updatePop3Error, updateLastFetched } = require('./db');

const SMTP_HOST = process.env.SMTP_HOST || 'node_mail_engine';

// 포트 25 (permit_mynetworks) — 내부 네트워크이므로 DMARC/SPF 검사 없음
// 단, Postfix의 smtpd_recipient_restrictions에 permit_mynetworks 포함해야 함
const transporter = nodemailer.createTransport({
    host: SMTP_HOST,
    port: 25,
    secure: false,
    tls: { rejectUnauthorized: false },
    // 인증 없음 — permit_mynetworks로 허용
});

// ---------------------------------------------------------------------------
// 헬퍼: POP3 dot-stuffing 제거 + CRLF 정규화
// ---------------------------------------------------------------------------
function normalizePop3Raw(data) {
    let s = data.split(/\r?\n/).join('\r\n');
    s = s.replace(/\r\n\.\./g, '\r\n.');
    return s;
}

// ---------------------------------------------------------------------------
// 핵심: 무손실 raw 배달 + DMARC 우회를 위한 Resent 헤더 주입
// ---------------------------------------------------------------------------

/**
 * raw 메시지에 X-Fetched-By 헤더만 주입 (Resent-* 는 루프 유발하므로 제거)
 */
function injectFetchHeader(rawMessage, deliverTo) {
    const sep = rawMessage.indexOf('\r\n\r\n');
    if (sep === -1) return rawMessage;
    const headerBlock = rawMessage.substring(0, sep);
    const bodyBlock = rawMessage.substring(sep);
    const marker = `X-Fetched-By: asys-pop3-fetcher\r\nX-Delivered-To: ${deliverTo}\r\n`;
    return marker + headerBlock + bodyBlock;
}

async function deliverRaw(rawMessage, deliverTo, deliverFrom) {
    // MAIL FROM: <> — RFC 5321 §4.5.5: re-delivered/injected mail은 null sender 사용
    // 이유:
    //   1. MAIL FROM에 agilesys.co.kr 주소를 쓰면 Postfix가 자기 도메인으로 판단해 루프 발생
    //   2. null sender는 DMARC/SPF 검사 대상 외 (bounce mail 취급)
    //   3. Resent-* 헤더는 Postfix가 새 제출로 인식해 MX 재조회 → 루프 유발
    const withHeader = injectFetchHeader(rawMessage, deliverTo);

    await transporter.sendMail({
        envelope: {
            from: '',      // null sender — SMTP MAIL FROM: <>
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
        const { pop3_port: port, pop3_host: host, pop3_tls: useTls,
            pop3_user, pop3_pass, user_email } = account;

        console.log(`[Fetcher] Initiating POP3 connect for ${user_email} to ${host}:${port} (TLS: ${useTls})`);

        const client = new POP3Client(port, host, {
            tlserrs: false,
            ignoretlserrs: true,
            enabletls: useTls === 1 || useTls === true,
            debug: false,
        });

        let msgcount = 0;
        let currentMsg = 1;
        let successCount = 0;

        const reportProgress = (processed) => {
            if (onProgress) onProgress(processed, msgcount);
        };

        client.on('error', async (err) => {
            console.error(`[Fetcher] ${user_email} POP3 error:`, err.message);
            await updatePop3Error(account.id, err.message || 'Connection error');
            client.quit();
            resolve(successCount);
        });

        client.on('connect', () => client.login(pop3_user, pop3_pass));

        client.on('login', async (status) => {
            if (status) {
                client.list();
            } else {
                console.error(`[Fetcher] ${user_email} Login failed`);
                await updatePop3Error(account.id, 'Authentication failed');
                client.quit();
                resolve(0);
            }
        });

        const fetchNext = () => {
            if (currentMsg > msgcount) { client.quit(); return; }
            reportProgress(currentMsg - 1);
            client.retr(currentMsg);
        };

        client.on('list', async (status, count) => {
            if (!status) {
                await updatePop3Error(account.id, 'Failed to list messages');
                client.quit();
                return resolve(0);
            }
            msgcount = parseInt(count) || 0;
            if (msgcount === 0) {
                console.log(`[Fetcher] ${user_email} No new messages`);
                await updatePop3Error(account.id, null);
                updateLastFetched(account.id);
                reportProgress(0); // 0/0
                client.quit();
                return;
            }
            console.log(`[Fetcher] ${user_email} Found ${msgcount} new messages`);
            fetchNext();
        });

        client.on('retr', async (status, msgnumber, data) => {
            if (!status) {
                console.error(`[Fetcher] ${user_email} RETR failed for msg ${msgnumber}`);
                currentMsg++;
                fetchNext();
                return;
            }

            try {
                const normalized = normalizePop3Raw(data);
                await deliverRaw(normalized, user_email, user_email);
                successCount++;
                client.dele(currentMsg);
            } catch (e) {
                console.error(`[Fetcher] ${user_email} Delivery failed for msg ${msgnumber}:`, e.message);
                currentMsg++;
                fetchNext();
            }
        });

        client.on('dele', () => {
            currentMsg++;
            fetchNext();
        });

        client.on('quit', () => {
            reportProgress(msgcount); // Finish
            if (successCount > 0) updateLastFetched(account.id);
            resolve(successCount);
        });
    });
};

module.exports = { fetchPop3Account };
