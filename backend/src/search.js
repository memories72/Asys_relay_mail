const { getPool } = require('./db');
const Fuse = require('fuse.js');

/**
 * Perform a fast full-text search across cached emails.
 * Uses Fuse.js for fuzzy matching on name, address and subject.
 */
async function searchCachedMails(email, query, limit = 100) {
    const pool = getPool();
    const q = `%${query}%`;

    // 1. Initial filter from DB (speed up Fuse by narrowing set)
    // We search across subject, sender name, address, and recipient JSON
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
        WHERE user_email = ? 
        AND (
            subject LIKE ? 
            OR sender_name LIKE ? 
            OR sender_address LIKE ? 
            OR recipient_address LIKE ?
        )
        ORDER BY date DESC
        LIMIT 1000
    `, [email, q, q, q, q]);

    if (rows.length === 0) return [];

    const fuseData = rows.map(r => {
        let toArr = [];
        try { toArr = JSON.parse(r.recipient_address || '[]'); } catch (e) { }
        let tags = [];
        try { if (r.tagsJSON) tags = JSON.parse(r.tagsJSON); } catch (e) { }

        return {
            uid: r.uid,
            mailbox: r.mailbox,
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

    // 2. Refine with Fuse.js for fuzzy relevance
    const fuse = new Fuse(fuseData, {
        keys: ['subject', 'from.name', 'from.address', 'to.name', 'to.address'],
        threshold: 0.3, // Lower is stricter
        ignoreLocation: true
    });

    const results = fuse.search(query);
    return results.slice(0, limit).map(res => res.item);
}

module.exports = {
    searchCachedMails
};
