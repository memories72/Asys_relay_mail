const { getPool } = require('./db');
const { searchCachedMails } = require('./search');

/**
 * Threaded view Logic.
 * Group emails into conversations based on message-id, in-reply-to, and references.
 */
async function buildConversationThread(email, mailbox, limit = 100) {
    const pool = getPool();

    // Fetch base emails, with tag mapping
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
        LIMIT 1000
    `, [email, mailbox]);

    const messages = rows.map(r => {
        let toArr = JSON.parse(r.recipient_address || '[]');
        let tags = [];
        try { if (r.tagsJSON) tags = JSON.parse(r.tagsJSON); } catch (e) { }

        return {
            uid: r.uid,
            messageId: r.message_id,
            inReplyTo: r.in_reply_to,
            subject: r.subject || '(제목 없음)',
            from: { name: r.sender_name || '', address: r.sender_address || '' },
            to: toArr,
            date: r.date,
            seen: r.is_seen === 1,
            flagged: r.is_flagged === 1,
            hasAttachment: r.has_attachments === 1,
            tags: tags
        };
    });

    const threads = [];
    const idMap = new Map();

    // Map by messageId for quick lookup
    messages.forEach(m => {
        if (m.messageId) idMap.set(m.messageId, m);
    });

    // Strategy: Simple linking for now (child points to parent)
    const processed = new Set();

    messages.forEach(m => {
        if (processed.has(m.uid)) return;

        // Try to find the root of this thread
        let current = m;
        const group = [current];
        processed.add(current.uid);

        // Find replies to this message
        // (This is a simplified approach; in production you'd use a more robust algorithm like JWZ)
        const replies = messages.filter(other => other.inReplyTo === current.messageId && !processed.has(other.uid));
        replies.forEach(r => {
            group.push(r);
            processed.add(r.uid);
        });

        // Add as a thread entry
        threads.push({
            root: current,
            count: group.length,
            messages: group.sort((a, b) => new Date(a.date) - new Date(b.date)),
            latestDate: group.reduce((max, cur) => new Date(cur.date) > new Date(max) ? cur.date : max, group[0].date),
            isUnread: group.some(msg => !msg.seen)
        });
    });

    return threads.sort((a, b) => new Date(b.latestDate) - new Date(a.latestDate)).slice(0, limit);
}

module.exports = {
    buildConversationThread
};
