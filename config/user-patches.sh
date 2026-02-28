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
postconf -e "smtpd_tls_cert_file = /etc/postfix/ssl/cert.pem"
postconf -e "smtpd_tls_key_file = /etc/postfix/ssl/key.pem"
postconf -e "smtpd_tls_security_level = may"
postconf -e "smtpd_tls_auth_only = no"
postconf -e "smtpd_sasl_auth_enable = yes"
postconf -e "smtpd_sasl_type = dovecot"
postconf -e "smtpd_sasl_path = private/auth"
postconf -e "smtpd_sasl_security_options = noanonymous"
postconf -e "broken_sasl_auth_clients = yes"

# --- 4. Master.cf Overrides (Ensures SSL/Auth on specific ports) ---
# Enable submission (587) and smtps (465)
sed -i 's/^#submission/submission/' /etc/postfix/master.cf
sed -i 's/^#smtps/smtps/' /etc/postfix/master.cf

# Clean up any previously added options to prevent duplicates
sed -i '/^submission/!b;n;/-o smtpd_sasl_auth_enable/d' /etc/postfix/master.cf
sed -i '/^submission/!b;n;/-o smtpd_sasl_type/d' /etc/postfix/master.cf
sed -i '/^submission/!b;n;/-o smtpd_sasl_path/d' /etc/postfix/master.cf
sed -i '/^submission/!b;n;/-o smtpd_tls_security_level/d' /etc/postfix/master.cf

sed -i '/^smtps/!b;n;/-o smtpd_tls_wrappermode/d' /etc/postfix/master.cf
sed -i '/^smtps/!b;n;/-o smtpd_sasl_auth_enable/d' /etc/postfix/master.cf

# Re-add clean options
sed -i '/^submission/a \  -o smtpd_sasl_auth_enable=yes\n  -o smtpd_sasl_type=dovecot\n  -o smtpd_sasl_path=private/auth\n  -o smtpd_tls_security_level=may' /etc/postfix/master.cf
sed -i '/^smtps/a \  -o smtpd_tls_wrappermode=yes\n  -o smtpd_sasl_auth_enable=yes\n  -o smtpd_sasl_type=dovecot\n  -o smtpd_sasl_path=private/auth' /etc/postfix/master.cf

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
