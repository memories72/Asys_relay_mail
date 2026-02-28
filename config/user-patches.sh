#!/bin/bash

# --- 1. Dovecot LDAP & Auth Configuration (Confirmed working for IMAP) ---
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
  args = uid=5000 gid=5000 home=/var/mail/%d/%n allow_all_users=yes quota_rule=*:storage=0
}
EOF

# --- 1.1 Special Use Folders & Auto-creation ---
cat > /etc/dovecot/conf.d/15-mailboxes.conf <<'EOF'
namespace inbox {
  mailbox Drafts {
    special_use = \Drafts
    auto = subscribe
  }
  mailbox Junk {
    special_use = \Junk
    auto = subscribe
  }
  mailbox Trash {
    special_use = \Trash
    auto = subscribe
  }
  mailbox Sent {
    special_use = \Sent
    auto = subscribe
  }
  mailbox "Sent Messages" {
    special_use = \Sent
  }
}
EOF

# Dedicated SASL bridge for Postfix
cat > /etc/dovecot/conf.d/10-master.conf <<'EOF'
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0666
    user = postfix
    group = postfix
  }
}
EOF

# --- 2. SSL Certificate Generation (CRITICAL for STARTTLS/SMTPS) ---
mkdir -p /etc/postfix/ssl
if [ ! -f /etc/postfix/ssl/cert.pem ]; then
  openssl req -new -x509 -days 3650 -nodes -out /etc/postfix/ssl/cert.pem -keyout /etc/postfix/ssl/key.pem -subj "/CN=nas.agilesys.co.kr" -addext "subjectAltName=DNS:nas.agilesys.co.kr,DNS:mail.digistory.co.kr,DNS:localhost,IP:127.0.0.1"
fi
cat /etc/postfix/ssl/key.pem /etc/postfix/ssl/cert.pem > /etc/postfix/ssl/combined.pem
chmod 600 /etc/postfix/ssl/combined.pem

# --- 3. Postfix Global Settings ---
postconf -e "myhostname = nas.agilesys.co.kr"
postconf -e "virtual_mailbox_domains = agilesys.co.kr"
postconf -e "virtual_alias_maps ="
postconf -e "virtual_transport = lmtp:unix:/var/run/dovecot/lmtp"
postconf -e "best_mx_transport = lmtp:unix:/var/run/dovecot/lmtp"
postconf -e "mydestination = localhost"
postconf -e "relay_domains ="
postconf -e "transport_maps ="

# Configure Postfix's internal LDAP lookups to use the correct 1389 port 
# (Otherwise defaults to 389, fails, and returns 451 Temporary lookup failure for all recipients)
sed -i 's/server_host = nas.agilesys.co.kr/server_host = nas.agilesys.co.kr\nserver_port = 1389/' /etc/postfix/ldap-users.cf

# Re-apply Message Size Limits and format compliance
postconf -e "message_size_limit = 268435456"
postconf -e "mailbox_size_limit = 0"
postconf -e "virtual_mailbox_limit = 0"
postconf -e "smtpd_forbid_bare_newline = no"
postconf -e "smtpd_sasl_authenticated_header = yes"
postconf -e "smtputf8_enable = yes"
postconf -e "disable_mime_output_conversion = yes"
postconf -e "strict_mime_encoding_domain = no"
postconf -e "smtpd_discard_ehlo_keywords = dsn, silent-discard"

# SSL/TLS - Global set to 'none' for Port 25 as requested
postconf -e "smtpd_tls_cert_file = /etc/postfix/ssl/cert.pem"
postconf -e "smtpd_tls_key_file = /etc/postfix/ssl/key.pem"
postconf -e "smtpd_tls_security_level = none" 
postconf -e "smtpd_tls_auth_only = no"

# SASL Auth - Global enabled
postconf -e "smtpd_sasl_auth_enable = yes"
postconf -e "smtpd_sasl_type = dovecot"
postconf -e "smtpd_sasl_path = private/auth"
postconf -e "smtpd_sasl_security_options = noanonymous"
postconf -e "broken_sasl_auth_clients = yes"

# --- 4. Master.cf Overrides (Ensures SSL/Auth on specific ports) ---
sed -i 's/^#submission/submission/' /etc/postfix/master.cf
sed -i 's/^#smtps/smtps/' /etc/postfix/master.cf

# Dynamic cleanup and re-application of overrides to ensure clean master.cf
sed -i '/^submission/,/^[^ ]/ { /^  -o /d }' /etc/postfix/master.cf
sed -i '/^smtps/,/^[^ ]/ { /^  -o /d }' /etc/postfix/master.cf

sed -i '/^submission/a \  -o smtpd_sasl_auth_enable=yes\n  -o smtpd_sasl_type=dovecot\n  -o smtpd_sasl_path=private/auth\n  -o smtpd_tls_security_level=may' /etc/postfix/master.cf
sed -i '/^smtps/a \  -o smtpd_tls_wrappermode=yes\n  -o smtpd_sasl_auth_enable=yes\n  -o smtpd_sasl_type=dovecot\n  -o smtpd_sasl_path=private/auth\n  -o smtpd_tls_security_level=encrypt' /etc/postfix/master.cf

# --- 5. Quota Configuration (Verified fix) ---
cat > /etc/dovecot/conf.d/90-quota.conf <<'EOF'
plugin {
  quota = maildir:User quota
  quota_rule = *:storage=0
}
EOF

if ! grep -q "quota" /etc/dovecot/conf.d/10-mail.conf; then
  sed -i '/^mail_plugins =/ s/$/ quota/' /etc/dovecot/conf.d/10-mail.conf
fi
