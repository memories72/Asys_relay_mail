const { getPool } = require('./db');
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const { getGlobalSmtpSettings, getImapPass } = require('./db');
const { appendMessage } = require('./imap');
const { createSingleTrackingId } = require('./tracking');

const BASE_URL = process.env.BASE_URL || 'http://localhost:13000'; // Need correct public URL for tracking image to load remotely

async function queueEmail(userEmail, mailPass, to, cc, bcc, subject, html, text, attachments, scheduleSeconds = 5) {
    const pool = getPool();
    // Schedule for N seconds in the future (allows Undo)
    const scheduledAt = new Date(Date.now() + scheduleSeconds * 1000);

    // We must somehow securely store or pass the IMAP password if we are sending asynchronously.
    // However, saving cleartext password in DB is bad. Since we only delay short term (5s), 
    // we can either keep it in memory queue, or just not append to "Sent" if password isn't available,
    // or store an encrypted token. For simplicity, we are forced to store the pass in memory if scheduled, 
    // or just rely on global SMTP if available.

    const [result] = await pool.query(`
        INSERT INTO email_outbox 
        (user_email, to_address, cc_address, bcc_address, subject, html_body, text_body, attachments, scheduled_at, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'PENDING')
    `, [
        userEmail, JSON.stringify(to), JSON.stringify(cc), JSON.stringify(bcc), subject, html, text, JSON.stringify(attachments), scheduledAt
    ]);

    // Store the transient password in memory map for appending to IMAP Sent later
    const outboxId = result.insertId;
    passwordVault.set(outboxId, mailPass);
    setTimeout(() => { passwordVault.delete(outboxId); }, 60000); // clear after 1 minute

    return outboxId;
}

const passwordVault = new Map();

async function processOutboxQueue() {
    const pool = getPool();
    // Find due emails
    const [rows] = await pool.query(`
        SELECT * FROM email_outbox
        WHERE status = 'PENDING' AND scheduled_at <= NOW()
    `);

    for (const job of rows) {
        // Mark as sending
        await pool.query("UPDATE email_outbox SET status = 'SENDING' WHERE id = ?", [job.id]);

        try {
            const smtpSettings = await getGlobalSmtpSettings();
            const mailPass = passwordVault.get(job.id); // might be undefined, but we fall back to global smtp

            const transportConfig = {
                host: smtpSettings?.host || process.env.SMTP_HOST || 'mail.agilesys.co.kr',
                port: parseInt(smtpSettings?.port || process.env.SMTP_PORT || '587'),
                secure: smtpSettings?.secure === 1 || smtpSettings?.secure === true,
                auth: (smtpSettings?.user && smtpSettings?.pass)
                    ? { user: smtpSettings.user, pass: smtpSettings.pass }
                    : { user: job.user_email, pass: mailPass },
                tls: { rejectUnauthorized: false },
                name: 'wmail.agilesys.co.kr'
            };

            const transporter = nodemailer.createTransport(transportConfig);

            // 1. Generate Tracking ID & inject pixel
            const allRecipients = [...JSON.parse(job.to_address), ...JSON.parse(job.cc_address || '[]'), ...JSON.parse(job.bcc_address || '[]')].join(', ');

            // Generate a random Message-ID
            const messageId = `<${Date.now()}.${Math.random().toString(36).substring(2)}@agilesys.co.kr>`;
            const trackingId = await createSingleTrackingId(job.user_email, messageId, allRecipients);

            const trackingPixel = `<img src="${BASE_URL}/api/mail/track?id=${trackingId}" width="1" height="1" alt="" style="display:none;" />`;
            const finalHtml = (job.html_body || '') + trackingPixel;

            const mailOptions = {
                from: job.user_email,
                to: JSON.parse(job.to_address),
                cc: JSON.parse(job.cc_address || '[]'),
                bcc: JSON.parse(job.bcc_address || '[]'),
                subject: job.subject,
                text: job.text_body || '',
                html: finalHtml,
                messageId: messageId,
                attachments: JSON.parse(job.attachments || '[]'),
            };

            // Send via SMTP
            await transporter.sendMail(mailOptions);

            // Append to IMAP Sent using the MailComposer
            if (mailPass) {
                const mail = new MailComposer(mailOptions);
                const messageBuffer = await mail.compile().build();
                try {
                    await appendMessage(job.user_email, mailPass, 'Sent', messageBuffer);
                } catch (appendErr) {
                    console.error('[Outbox] Failed to append to Sent folder:', appendErr.message);
                }
            }
            passwordVault.delete(job.id);

            // Mark completed
            await pool.query("UPDATE email_outbox SET status = 'SENT' WHERE id = ?", [job.id]);

        } catch (err) {
            console.error(`[Outbox] Job ${job.id} failed:`, err);
            await pool.query("UPDATE email_outbox SET status = 'FAILED', error_message = ? WHERE id = ?", [err.message, job.id]);
        }
    }
}

async function cancelOutboxJob(jobId, userEmail) {
    const pool = getPool();
    const [result] = await pool.query(
        "UPDATE email_outbox SET status = 'CANCELLED' WHERE id = ? AND user_email = ? AND status = 'PENDING'",
        [jobId, userEmail]
    );
    if (result.affectedRows === 0) {
        throw new Error('Email is already sending or sent, cannot cancel.');
    }
}

function startOutboxProcessor() {
    setInterval(async () => {
        try {
            await processOutboxQueue();
        } catch (e) { /* ignore */ }
    }, 5000);
}

module.exports = {
    queueEmail,
    processOutboxQueue,
    cancelOutboxJob,
    startOutboxProcessor
};
