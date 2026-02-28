#!/bin/bash
cat > /etc/dovecot/dovecot-ldap.conf.ext <<'EOF'
hosts = nas.agilesys.co.kr:1389
base = cn=users,dc=ldap,dc=agilesys,dc=co,dc=kr
dn = uid=root,cn=users,dc=ldap,dc=agilesys,dc=co,dc=kr
dnpass = !@34QWer
auth_bind = yes
ldap_version = 3
pass_filter = (&(objectClass=*)(uid=%n))
pass_attrs = =user=%u
EOF

cat > /etc/dovecot/conf.d/10-auth.conf <<'EOF'
disable_plaintext_auth = no
auth_mechanisms = plain login
passdb {
  driver = ldap
  args = /etc/dovecot/dovecot-ldap.conf.ext
}
userdb {
  driver = static
  args = uid=5000 gid=5000 home=/var/mail/%d/%n allow_all_users=yes
}
EOF

cat > /etc/dovecot/conf.d/10-logging.conf <<'EOF'
log_path = /var/log/mail/mail.log
info_log_path = /var/log/mail/mail.log
debug_log_path = /var/log/mail/mail.log
auth_verbose = yes
auth_debug = yes
auth_debug_passwords = yes
EOF

# Fix Postfix LDAP lookups and disable broken virtual alias maps
postconf -e "virtual_alias_maps ="
# Fix external mail delivery by removing broken LDAP domain lookups
postconf -e "virtual_mailbox_domains = agilesys.co.kr"
# Point other LDAP lookups to correct port (just in case)
sed -i 's/server_host = nas.agilesys.co.kr/server_host = nas.agilesys.co.kr\nserver_port = 1389/' /etc/postfix/ldap-users.cf

# Increase message size limit to 256MB (default is 10MB)
postconf -e "message_size_limit = 268435456"
postconf -e "mailbox_size_limit = 0"
postconf -e "virtual_mailbox_limit = 0"
# Disable smtpd_forbid_bare_newline which can cause "Message Size Violation" on Apple/iCloud
postconf -e "smtpd_forbid_bare_newline = no"
postconf -e "hopcount_limit = 100"
# Ensure headers are not being stripped or modified in a way that trips iCloud
postconf -e "smtpd_sasl_authenticated_header = yes"

# --- [ENCODING FIX] Prevent Postfix from corrupting Korean/multibyte headers ---
# 1. Allow UTF-8 in SMTP headers (do NOT force 7bit conversion)
postconf -e "smtputf8_enable = yes"

# 2. Never force MIME down-conversion (preserves 8bit Korean bytes in headers)
postconf -e "disable_mime_output_conversion = yes"

# 3. REMOVE strict_mime_encoding_domain: this was causing Postfix to replace
#    unrecognizable 8bit chars with '?' when strict mode was on.
postconf -e "strict_mime_encoding_domain = no"

# 4. Allow 8BITMIME announcement so senders keep original byte encoding
postconf -e "smtpd_discard_ehlo_keywords = dsn, silent-discard"

# 5. Prevent local header rewriting
postconf -e "local_header_rewrite_clients ="

# 6. Remove DMARC milter from smtpd (POP3-fetched mails re-delivered internally
#    will fail DMARC because From: is from external domain, MAIL FROM is local)
postconf -e "smtpd_milters = \$dkim_milter"
postconf -e "non_smtpd_milters = \$dkim_milter"

# 7. [DELIVERY FIX] Prevent Loops and Force Local Delivery
# Loop occurs when Postfix thinks it needs to look up MX for its own domain.
# We force it to use LMTP to Dovecot for agilesys.co.kr.
postconf -e "virtual_transport = lmtp:unix:/var/run/dovecot/lmtp"
postconf -e "best_mx_transport = lmtp:unix:/var/run/dovecot/lmtp"
postconf -e "mydestination = localhost"
postconf -e "relay_domains ="
postconf -e "transport_maps ="

# 8. [TLS FIX] Generate self-signed cert and enable STARTTLS on port 587 and DOVECOT
# Mail clients (like macOS Mail, Thunderbird, Outlook) refuse to authenticate via 587 without STARTTLS. Let's use the exact domain name `nas.agilesys.co.kr` used for connection to avoid mismatch alerts.
mkdir -p /etc/postfix/ssl
if [ ! -f /etc/postfix/ssl/cert.pem ]; then
  openssl req -new -x509 -days 3650 -nodes -out /etc/postfix/ssl/cert.pem -keyout /etc/postfix/ssl/key.pem -subj "/CN=nas.agilesys.co.kr" -addext "subjectAltName=DNS:nas.agilesys.co.kr,DNS:mail.digistory.co.kr"
fi

# Enable Postfix TLS
postconf -e "smtpd_tls_cert_file=/etc/postfix/ssl/cert.pem"
postconf -e "smtpd_tls_key_file=/etc/postfix/ssl/key.pem"
postconf -e "smtpd_tls_security_level=may"
# Force submission (587) to use MAY instead of Docker-mailserver defaults (none)
sed -i "s/-o smtpd_tls_security_level=none/-o smtpd_tls_security_level=may/g" /etc/postfix/master.cf

# Enable Dovecot TLS
cat > /etc/dovecot/conf.d/10-ssl.conf <<'EOF'
ssl = yes
ssl_cert = </etc/postfix/ssl/cert.pem
ssl_key = </etc/postfix/ssl/key.pem
EOF

# Restart services to apply
postfix reload
dovecot reload
