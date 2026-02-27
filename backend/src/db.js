const mysql = require('mysql2/promise');
require('dotenv').config();

let pool;

async function initDatabase() {
    // First connect to MySQL without specifying a database to ensure it exists
    const connection = await mysql.createConnection({
        host: process.env.DB_HOST || 'nas.agilesys.co.kr',
        port: process.env.DB_PORT || 13306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '!@#45QWErt'
    });

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
            emails_processed INT DEFAULT 0
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

    await connection.query(`
        INSERT IGNORE INTO webmail_settings (domain, ldap_server, sso_enabled) 
        VALUES ('agilesys.co.kr', 'ldap://node_ldap_auth:389', TRUE)
    `);

    await connection.end();

    // Now establish the connection pool to the right database
    pool = mysql.createPool({
        host: process.env.DB_HOST || 'nas.agilesys.co.kr',
        port: process.env.DB_PORT || 13306,
        user: process.env.DB_USER || 'root',
        password: process.env.DB_PASSWORD || '!@#45QWErt',
        database: dbName,
        waitForConnections: true,
        connectionLimit: 10,
        queueLimit: 0
    });

    return pool;
}

function getPool() {
    if (!pool) throw new Error("Database not initialized yet. Call initDatabase() first.");
    return pool;
}

async function logSyncEvent(status, emailsProcessed = 0) {
    try {
        const currentPool = getPool();
        const [result] = await currentPool.execute(
            'INSERT INTO sync_state (last_sync_time, status, emails_processed) VALUES (NOW(), ?, ?)',
            [status, emailsProcessed]
        );
        return result;
    } catch (error) {
        console.error('Database Sync Logging Error:', error);
    }
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

const savePop3Account = async (email, host, port, tls, user, pass, keepOnServer = true) => {
    try {
        const currentPool = getPool();
        await currentPool.query(`
            INSERT INTO user_pop3_accounts (user_email, pop3_host, pop3_port, pop3_tls, pop3_user, pop3_pass, keep_on_server, last_status, last_error)
            VALUES (?, ?, ?, ?, ?, ?, ?, 'PENDING', NULL)
            ON DUPLICATE KEY UPDATE
            pop3_host=VALUES(pop3_host), pop3_port=VALUES(pop3_port), pop3_tls=VALUES(pop3_tls), pop3_pass=VALUES(pop3_pass), keep_on_server=VALUES(keep_on_server), is_active=TRUE, last_status='PENDING', last_error=NULL
        `, [email, host, port, tls, user, pass, keepOnServer]);
        return true;
    } catch (err) {
        console.error('Error saving POP3 account', err);
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

module.exports = {
    initDatabase,
    getPool,
    logSyncEvent,
    getLdapSettings,
    getAllPop3Accounts,
    savePop3Account,
    deletePop3Account,
    updateLastFetched,
    updatePop3Error,
    getGlobalSmtpSettings,
    saveGlobalSmtpSettings
};
