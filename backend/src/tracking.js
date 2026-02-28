const { getPool } = require('./db');
const crypto = require('crypto');

async function createTrackingRecord(userEmail, messageId, toList) {
    const pool = getPool();
    const trackingIds = [];

    for (const recipient of toList) {
        const trackingId = crypto.randomBytes(16).toString('hex');
        await pool.query(
            'INSERT INTO email_tracking (user_email, message_id, recipient, tracking_id) VALUES (?, ?, ?, ?)',
            [userEmail, messageId, recipient, trackingId]
        );
        trackingIds.push(trackingId);
    }

    return trackingIds; // returns one per recipient, useful for per-recipient injection if we wanted to send separate emails, but usually we just track one generic "opened" event if it's sent to multiple people in one go.
}

async function createSingleTrackingId(userEmail, messageId, allRecipientsString) {
    const pool = getPool();
    const trackingId = crypto.randomBytes(16).toString('hex');
    await pool.query(
        'INSERT INTO email_tracking (user_email, message_id, recipient, tracking_id) VALUES (?, ?, ?, ?)',
        [userEmail, messageId, allRecipientsString, trackingId]
    );
    return trackingId;
}

async function recordOpen(trackingId) {
    const pool = getPool();
    await pool.query(
        'UPDATE email_tracking SET open_count = open_count + 1, opened_at = NOW() WHERE tracking_id = ?',
        [trackingId]
    );
}

module.exports = {
    createTrackingRecord,
    createSingleTrackingId,
    recordOpen
};
