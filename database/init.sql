CREATE DATABASE IF NOT EXISTS agilesys_mail;
USE agilesys_mail;

CREATE TABLE IF NOT EXISTS sync_state (
    id INT AUTO_INCREMENT PRIMARY KEY,
    last_sync_time DATETIME NOT NULL,
    status ENUM('SUCCESS', 'FAILED') NOT NULL,
    emails_processed INT DEFAULT 0
);

CREATE TABLE IF NOT EXISTS mail_logs (
    id INT AUTO_INCREMENT PRIMARY KEY,
    message_id VARCHAR(255),
    sender VARCHAR(255),
    recipient VARCHAR(255),
    subject VARCHAR(255),
    status ENUM('RECEIVED', 'DELIVERED', 'BOUNCED') NOT NULL,
    timestamp DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS webmail_settings (
    id INT AUTO_INCREMENT PRIMARY KEY,
    domain VARCHAR(255) UNIQUE NOT NULL,
    ldap_server VARCHAR(255),
    sso_enabled BOOLEAN DEFAULT TRUE,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS user_pop3_accounts (
    id INT AUTO_INCREMENT PRIMARY KEY,
    user_email VARCHAR(255) NOT NULL,
    pop3_host VARCHAR(255) NOT NULL,
    pop3_port INT DEFAULT 110,
    pop3_tls BOOLEAN DEFAULT FALSE,
    pop3_user VARCHAR(255) NOT NULL,
    pop3_pass VARCHAR(255) NOT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    last_fetched_at DATETIME NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY user_pop3_unique (user_email, pop3_host, pop3_user)
);

INSERT IGNORE INTO webmail_settings (domain, ldap_server, sso_enabled) 
VALUES ('agilesys.co.kr', 'ldap://node_ldap_auth:389', TRUE);
