const { getPool } = require('./db');

async function getTags(email) {
    const pool = getPool();
    const [rows] = await pool.query('SELECT * FROM tags WHERE user_email = ?', [email]);
    return rows;
}

async function createTag(email, name, color) {
    const pool = getPool();
    const [result] = await pool.query(
        'INSERT INTO tags (user_email, name, color) VALUES (?, ?, ?)',
        [email, name, color]
    );
    return result.insertId;
}

async function deleteTag(email, tagId) {
    const pool = getPool();
    await pool.query('DELETE FROM tags WHERE id = ? AND user_email = ?', [tagId, email]);
}

async function addTagToEmail(email, mailbox, uid, tagId) {
    const pool = getPool();

    // Get the email_cache ID
    const [emailRows] = await pool.query('SELECT id FROM email_cache WHERE user_email = ? AND mailbox = ? AND uid = ?', [email, mailbox, uid]);
    if (emailRows.length === 0) throw new Error('Email not found in cache');
    const emailCacheId = emailRows[0].id;

    // Verify tag belongs to user
    const [tagRows] = await pool.query('SELECT id FROM tags WHERE id = ? AND user_email = ?', [tagId, email]);
    if (tagRows.length === 0) throw new Error('Tag not found or access denied');

    await pool.query('INSERT IGNORE INTO email_tags (email_cache_id, tag_id) VALUES (?, ?)', [emailCacheId, tagId]);
}

async function removeTagFromEmail(email, mailbox, uid, tagId) {
    const pool = getPool();

    const [emailRows] = await pool.query('SELECT id FROM email_cache WHERE user_email = ? AND mailbox = ? AND uid = ?', [email, mailbox, uid]);
    if (emailRows.length === 0) return;
    const emailCacheId = emailRows[0].id;

    await pool.query('DELETE FROM email_tags WHERE email_cache_id = ? AND tag_id = ?', [emailCacheId, tagId]);
}

module.exports = {
    getTags,
    createTag,
    deleteTag,
    addTagToEmail,
    removeTagFromEmail
};
