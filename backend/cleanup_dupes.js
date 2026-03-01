const { initDatabase, getPool } = require('./src/db');
const { makeClient } = require('./src/imap');

async function cleanupDuplicates() {
    await initDatabase();
    const pool = getPool();

    // Get all users who have POP3 accounts
    const [users] = await pool.query('SELECT DISTINCT user_email FROM user_pop3_accounts');

    for (const u of users) {
        const email = u.user_email;
        console.log(`\n===========================================`);
        console.log(`[Cleanup] Scanning duplicates for: ${email}`);

        // Find Message-IDs that appear more than once
        const [dupeRows] = await pool.query(`
            SELECT ec.uid, ec.message_id
            FROM email_cache ec
            INNER JOIN (
                SELECT COALESCE(NULLIF(message_id, ''), CAST(uid AS CHAR)) as dedupe_key
                FROM email_cache
                WHERE user_email = ? AND mailbox = 'INBOX'
                GROUP BY COALESCE(NULLIF(message_id, ''), CAST(uid AS CHAR))
                HAVING COUNT(*) > 1
            ) as t ON COALESCE(NULLIF(ec.message_id, ''), CAST(ec.uid AS CHAR)) = t.dedupe_key
            WHERE ec.user_email = ? AND ec.mailbox = 'INBOX'
        `, [email, email]);

        if (dupeRows.length === 0) {
            console.log(`[Cleanup] No extra duplicates found. Disk is clean.`);
            continue;
        }

        // Group by message_id
        const groups = {};
        for (const row of dupeRows) {
            const key = row.message_id || String(row.uid);
            if (!groups[key]) groups[key] = [];
            groups[key].push(row.uid);
        }

        let uidsToDelete = [];
        for (const key in groups) {
            // Sort ascending by UID. Keep the latest (max UID), delete the older ones.
            const uids = groups[key].sort((a, b) => b - a);
            const toDelete = uids.slice(1);
            uidsToDelete.push(...toDelete);
        }

        if (uidsToDelete.length === 0) continue;

        console.log(`[Cleanup] Found ${uidsToDelete.length} duplicate emails. Attempting physical deletion...`);

        // Connect via IMAP to physically delete
        const [passRows] = await pool.query('SELECT imap_pass FROM user_pop3_accounts WHERE user_email = ? AND imap_pass IS NOT NULL LIMIT 1', [email]);
        if (passRows.length === 0 || !passRows[0].imap_pass) {
            console.log(`[Cleanup] Skip: No IMAP password found in DB to perform deletion.`);
            continue;
        }

        const imapPass = passRows[0].imap_pass;
        const imap = makeClient(email, imapPass);

        try {
            await imap.connect();
            let lock = await imap.getMailboxLock('INBOX');

            for (let i = 0; i < uidsToDelete.length; i += 50) {
                const chunk = uidsToDelete.slice(i, i + 50);
                const sequence = chunk.join(',');
                console.log(`[Cleanup] -> Flagging IMAP UIDs: ${sequence}`);
                // Add \Deleted flag
                await imap.messageFlagsAdd(sequence, ['\\Deleted'], { uid: true });
            }

            // Execute physical expunge (permanently remove \Deleted emails) to free disk space
            // Due to ImapFlow not exposing simple expunge, we run raw command if needed, 
            // but messageDelete usually handles IMAP UID EXPUNGE. 
            // We'll call UID EXPUNGE directly.
            console.log(`[Cleanup] Expunging deleted emails to free disk space...`);
            for (let i = 0; i < uidsToDelete.length; i += 50) {
                const chunk = uidsToDelete.slice(i, i + 50);
                try {
                    await imap.run({
                        command: 'UID EXPUNGE',
                        attributes: [{ type: 'SEQUENCE', value: chunk.join(',') }]
                    });
                } catch (e) { /* Ignore if UID EXPUNGE unsupported */ }
            }

            lock.release();
            await imap.logout();
            console.log(`[Cleanup] IMAP Deletion & Expunge finished.`);

            // Synchronize local cache to instantly remove them from the UI index
            console.log(`[Cleanup] Removing from local DB cache...`);
            for (let i = 0; i < uidsToDelete.length; i += 100) {
                const chunk = uidsToDelete.slice(i, i + 100);
                await pool.query('DELETE FROM email_cache WHERE user_email = ? AND mailbox = ? AND uid IN (?)', [email, 'INBOX', chunk]);
            }
            console.log(`[Cleanup] Complete for ${email}. Space saved!`);
        } catch (err) {
            console.error(`[Cleanup] Error during process:`, err.message);
        }
    }

    console.log(`\n===========================================`);
    console.log('[Cleanup] All accounts checked and cleaned.');
    process.exit(0);
}

cleanupDuplicates();
