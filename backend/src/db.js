const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;

async function initDatabase() {
    let connection;
    let retries = 12; // Wait up to 60 seconds
    while (retries > 0) {
        try {
            connection = await mysql.createConnection({
                host: process.env.DB_HOST || '10.25.2.120',
                port: process.env.DB_PORT || 3307,
                user: process.env.DB_USER || 'root',
                password: process.env.DB_PASSWORD || '!@#45QWErt',
                connectTimeout: 5000
            });
            break; // Success
        } catch (err) {
            console.error(`[DB] Connection failed (${err.message}), retrying in 5s... (${retries - 1} left)`);
            retries--;
            if (retries === 0) throw err;
            await new Promise(r => setTimeout(r, 5000));
        }
    }

    const dbName = process.env.DB_NAME || 'agilesys_mail';

    // Create DB if not exists
    await connection.query(`CREATE DATABASE IF NOT EXISTS \`${dbName}\``);
    await connection.query(`USE \`${dbName}\``);

    // Create Tables
    await connection.query(`
        CREATE TABLE IF NOT EXISTS sync_state (
            id INT AUTO_INCREMENT PRIMARY KEY,
            last_sync_time DATETIME NOT NULL,
            status ENUM('SUCCESS', 'FAILED') NOT NULL,
            emails_processed INT DEFAULT 0,
            user_email VARCHAR(255) NULL
        )
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS mail_logs (
            id INT AUTO_INCREMENT PRIMARY KEY,
            message_id VARCHAR(255),
            sender VARCHAR(255),
            recipient VARCHAR(255),
            subject VARCHAR(255),
            status ENUM('RECEIVED', 'DELIVERED', 'BOUNCED') NOT NULL,
            timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS webmail_settings (
            id INT AUTO_INCREMENT PRIMARY KEY,
            domain VARCHAR(255) UNIQUE NOT NULL,
            ldap_server VARCHAR(255),
            sso_enabled BOOLEAN DEFAULT TRUE,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS user_pop3_accounts (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_email VARCHAR(255) NOT NULL,
            pop3_host VARCHAR(255) NOT NULL,
            pop3_port INT DEFAULT 110,
            pop3_tls BOOLEAN DEFAULT FALSE,
            pop3_user VARCHAR(255) NOT NULL,
            pop3_pass VARCHAR(255) NOT NULL,
            imap_pass VARCHAR(255) NULL,
            keep_on_server BOOLEAN DEFAULT TRUE,
            is_active BOOLEAN DEFAULT TRUE,
            last_status ENUM('PENDING', 'SUCCESS', 'FAILED') DEFAULT 'PENDING',
            last_error TEXT NULL,
            last_fetched_at DATETIME NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY user_pop3_unique (user_email, pop3_host, pop3_user)
        )
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS global_smtp_settings (
            id INT PRIMARY KEY DEFAULT 1,
            host VARCHAR(255) NOT NULL,
            port INT DEFAULT 587,
            secure BOOLEAN DEFAULT FALSE,
            user VARCHAR(255) NULL,
            pass VARCHAR(255) NULL,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    // Add columns if they don't exist
    try { await connection.query('ALTER TABLE global_smtp_settings ADD COLUMN user VARCHAR(255) NULL'); } catch (e) { }
    try { await connection.query('ALTER TABLE global_smtp_settings ADD COLUMN pass VARCHAR(255) NULL'); } catch (e) { }

    await connection.query(`
        INSERT IGNORE INTO global_smtp_settings (id, host, port, secure)
        VALUES (1, 'mail.agilesys.co.kr', 587, FALSE)
    `);

    // Ensure columns exist for existing installations
    try {
        await connection.query('ALTER TABLE user_pop3_accounts ADD COLUMN last_status ENUM(\'PENDING\', \'SUCCESS\', \'FAILED\') DEFAULT \'PENDING\'');
    } catch (e) { }
    try {
        await connection.query('ALTER TABLE user_pop3_accounts ADD COLUMN last_error TEXT NULL');
    } catch (e) { }
    try {
        await connection.query('ALTER TABLE user_pop3_accounts ADD COLUMN keep_on_server BOOLEAN DEFAULT TRUE');
    } catch (e) { }

    // pop3_uidls table for deduplication
    await connection.query(`
        CREATE TABLE IF NOT EXISTS pop3_uidls (
            id INT AUTO_INCREMENT PRIMARY KEY,
            account_id INT NOT NULL,
            uidl VARCHAR(255) NOT NULL,
            fetched_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_account_uidl (account_id, uidl),
            FOREIGN KEY (account_id) REFERENCES user_pop3_accounts(id) ON DELETE CASCADE
        )
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS mail_quotas (
            email VARCHAR(255) PRIMARY KEY,
            usage_bytes BIGINT DEFAULT 0,
            max_bytes BIGINT DEFAULT 0,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
    `);

    await connection.query(`
        INSERT IGNORE INTO webmail_settings (domain, ldap_server, sso_enabled) 
        VALUES ('agilesys.co.kr', 'ldap://node_ldap_auth:389', TRUE)
    `);

    // ============================================
    // NEW DB FEATURES (Cache, Tracking, Rules, etc)
    // ============================================

    await connection.query(`
        CREATE TABLE IF NOT EXISTS email_cache (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_email VARCHAR(255) NOT NULL,
            mailbox VARCHAR(255) NOT NULL,
            uid INT NOT NULL,
            message_id VARCHAR(255),
            in_reply_to VARCHAR(255),
            thread_id VARCHAR(255),
            sender_name VARCHAR(255),
            sender_address VARCHAR(255),
            recipient_address TEXT,
            subject VARCHAR(1024),
            snippet TEXT,
            date DATETIME,
            is_seen BOOLEAN DEFAULT FALSE,
            is_flagged BOOLEAN DEFAULT FALSE,
            has_attachments BOOLEAN DEFAULT FALSE,
            size INT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
            UNIQUE KEY unique_email_uid (user_email, mailbox, uid),
            INDEX idx_message_id (message_id),
            INDEX idx_thread_id (thread_id),
            INDEX idx_search (user_email, subject(255), sender_address),
            INDEX idx_mailbox_date (user_email, mailbox, date)
        )
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS tags (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_email VARCHAR(255) NOT NULL,
            name VARCHAR(100) NOT NULL,
            color VARCHAR(20) DEFAULT '#3b82f6',
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            UNIQUE KEY unique_user_tag (user_email, name)
        )
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS email_tags (
            email_cache_id INT NOT NULL,
            tag_id INT NOT NULL,
            PRIMARY KEY (email_cache_id, tag_id),
            FOREIGN KEY (email_cache_id) REFERENCES email_cache(id) ON DELETE CASCADE,
            FOREIGN KEY (tag_id) REFERENCES tags(id) ON DELETE CASCADE
        )
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS email_tracking (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_email VARCHAR(255) NOT NULL,
            message_id VARCHAR(255) NOT NULL,
            recipient VARCHAR(255) NOT NULL,
            tracking_id VARCHAR(100) UNIQUE NOT NULL,
            opened_at DATETIME NULL,
            open_count INT DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_tracking_id (tracking_id)
        )
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS email_outbox (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_email VARCHAR(255) NOT NULL,
            to_address TEXT NOT NULL,
            cc_address TEXT,
            bcc_address TEXT,
            subject VARCHAR(1024),
            html_body LONGTEXT,
            text_body LONGTEXT,
            attachments JSON,
            status ENUM('PENDING', 'SENDING', 'SENT', 'FAILED', 'CANCELLED') DEFAULT 'PENDING',
            scheduled_at DATETIME NOT NULL,
            error_message TEXT,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            INDEX idx_status_time (status, scheduled_at)
        )
    `);

    await connection.query(`
        CREATE TABLE IF NOT EXISTS mail_rules (
            id INT AUTO_INCREMENT PRIMARY KEY,
            user_email VARCHAR(255) NOT NULL,
            name VARCHAR(255) NOT NULL,
            conditions JSON NOT NULL,
            actions JSON NOT NULL,
            is_active BOOLEAN DEFAULT TRUE,
            sort_order INT DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        )
    `);

    // ============================================

    await connection.end();

    // Now establish the connection pool to the right database
    pool = mysql.createPool({
        host: process.env.DB_HOST || 'nas.agilesys.co.kr',
        port: process.env.DB_PORT || 13306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '!@#45QWErt',
        database: dbName,
        waitForConnections: true,
        connectionLimit: 50,
        queueLimit: 0
    });

    return pool;
}

function getPool() {
    if (!pool) throw new Error("Database not initialized yet. Call initDatabase() first.");
    return pool;
}

async function logSyncEvent(status, emailsProcessed = 0, userEmail = null) {
    try {
        const currentPool = getPool();
        const [result] = await currentPool.execute(
            'INSERT INTO sync_state (last_sync_time, status, emails_processed, user_email) VALUES (NOW(), ?, ?, ?)',
            [status, emailsProcessed, userEmail]
        );
        return result;
    } catch (error) {
        console.error('Database Sync Logging Error:', error);
    }
}

async function getRecentSyncStates(userEmail, limit = 10) {
    const currentPool = getPool();
    const [rows] = await currentPool.query(
        'SELECT last_sync_time, status, emails_processed, user_email FROM sync_state WHERE user_email = ? OR user_email IS NULL ORDER BY last_sync_time DESC LIMIT ?',
        [userEmail, limit]
    );
    return rows;
}

async function getLdapSettings() {
    try {
        const currentPool = getPool();
        const [rows] = await currentPool.execute(
            'SELECT * FROM webmail_settings WHERE domain = ?',
            ['agilesys.co.kr']
        );
        return rows[0];
    } catch (error) {
        console.error('Failed to get LDAP settings:', error);
    }
}

const getAllPop3Accounts = async () => {
    try {
        const currentPool = getPool();
        const [rows] = await currentPool.query('SELECT * FROM user_pop3_accounts WHERE is_active = TRUE');
        return rows;
    } catch (err) {
        console.error('Error fetching POP3 accounts', err);
        return [];
    }
};

const savePop3Account = async (email, host, port, tls, user, pass, keepOnServer = true, imapPass = null) => {
    try {
        const currentPool = getPool();
        await currentPool.query(`
            INSERT INTO user_pop3_accounts (user_email, pop3_host, pop3_port, pop3_tls, pop3_user, pop3_pass, keep_on_server, last_status, last_error, imap_pass)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL, ?)
            ON DUPLICATE KEY UPDATE
            pop3_host=VALUES(pop3_host), pop3_port=VALUES(pop3_port), pop3_tls=VALUES(pop3_tls), pop3_pass=VALUES(pop3_pass), keep_on_server=VALUES(keep_on_server), imap_pass=VALUES(imap_pass), is_active=TRUE, last_status='PENDING', last_error=NULL
        `, [email, host, port, tls, user, pass, keepOnServer, imapPass]);
        return true;
    } catch (err) {
        console.error('Error saving POP3 account', err);
        return false;
    }
};

const getPop3AccountById = async (email, accountId) => {
    try {
        const currentPool = getPool();
        const [rows] = await currentPool.query('SELECT * FROM user_pop3_accounts WHERE id = ? AND user_email = ?', [accountId, email]);
        return rows[0];
    } catch (err) {
        console.error('Error fetching POP3 account by id', err);
        return null;
    }
};

const updatePop3AccountStatus = async (accountId, status, errorMsg = null) => {
    try {
        const currentPool = getPool();
        await currentPool.query('UPDATE user_pop3_accounts SET last_status = ?, last_error = ? WHERE id = ?', [status, errorMsg, accountId]);
        return true;
    } catch (err) {
        console.error('Error updating POP3 account status', err);
        return false;
    }
};

const deletePop3Account = async (email, accountId) => {
    try {
        const currentPool = getPool();
        await currentPool.query('DELETE FROM user_pop3_accounts WHERE id = ? AND user_email = ?', [accountId, email]);
        return true;
    } catch (err) {
        console.error('Error deleting POP3 account', err);
        return false;
    }
};

const updateLastFetched = async (accountId) => {
    try {
        const currentPool = getPool();
        await currentPool.query('UPDATE user_pop3_accounts SET last_fetched_at = NOW(), last_status = \'SUCCESS\', last_error = NULL WHERE id = ?', [accountId]);
    } catch (err) {
        console.error('Error updating last fetched time', err);
    }
};

const updatePop3Error = async (accountId, errorMsg) => {
    try {
        const currentPool = getPool();
        await currentPool.query('UPDATE user_pop3_accounts SET last_status = \'FAILED\', last_error = ? WHERE id = ?', [errorMsg, accountId]);
    } catch (err) {
        console.error('Error updating POP3 error status', err);
    }
};

const getGlobalSmtpSettings = async () => {
    try {
        const currentPool = getPool();
        const [rows] = await currentPool.query('SELECT * FROM global_smtp_settings WHERE id = 1');
        return rows[0];
    } catch (err) {
        console.error('Error fetching global SMTP settings', err);
        return null;
    }
};

const saveGlobalSmtpSettings = async (host, port, secure, user, pass) => {
    try {
        const currentPool = getPool();
        await currentPool.query(`
            INSERT INTO global_smtp_settings (id, host, port, secure, user, pass)
            VALUES (1, ?, ?, ?, ?, ?)
            ON DUPLICATE KEY UPDATE host=VALUES(host), port=VALUES(port), secure=VALUES(secure), user=VALUES(user), pass=VALUES(pass)
        `, [host, port, secure, user, pass]);
        return true;
    } catch (err) {
        console.error('Error saving global SMTP settings', err);
        return false;
    }
};

async function isFetched(accountId, uidl) {
    const currentPool = getPool();
    const [rows] = await currentPool.query('SELECT 1 FROM pop3_uidls WHERE account_id = ? AND uidl = ? LIMIT 1', [accountId, uidl]);
    return rows.length > 0;
}

async function saveFetchedUidl(accountId, uidl) {
    const currentPool = getPool();
    await currentPool.query('INSERT IGNORE INTO pop3_uidls (account_id, uidl) VALUES (?, ?)', [accountId, uidl]);
}

module.exports = {
    initDatabase,
    getPool,
    savePop3Account,
    getAllPop3Accounts,
    deletePop3Account,
    getPop3AccountById,
    updatePop3AccountStatus,
    updatePop3Error,
    updateLastFetched,
    getGlobalSmtpSettings,
    saveGlobalSmtpSettings,
    logSyncEvent,
    getRecentSyncStates,
    isFetched,
    saveFetchedUidl
};
