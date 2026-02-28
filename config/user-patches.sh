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
  args = uid=5000 gid=5000 home=/var/mail/%d/%n allow_all_users=yes quota_rule=*:storage=0
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
postconf -e "virtual_mailbox_domains = agilesys.co.kr"
postconf -e "message_size_limit = 268435456"
postconf -e "mailbox_size_limit = 0"
postconf -e "virtual_mailbox_limit = 0"
postconf -e "smtpd_forbid_bare_newline = no"
postconf -e "smtpd_sasl_authenticated_header = yes"
postconf -e "smtputf8_enable = yes"
postconf -e "disable_mime_output_conversion = yes"
postconf -e "strict_mime_encoding_domain = no"
postconf -e "smtpd_discard_ehlo_keywords = dsn, silent-discard"
postconf -e "virtual_transport = lmtp:unix:/var/run/dovecot/lmtp"
postconf -e "best_mx_transport = lmtp:unix:/var/run/dovecot/lmtp"
postconf -e "mydestination = localhost"
postconf -e "relay_domains ="
postconf -e "smtpd_tls_security_level = may" 
postconf -e "smtpd_tls_auth_only = no"
postconf -e "smtpd_sasl_auth_enable = yes"
postconf -e "smtpd_sasl_type = dovecot"
postconf -e "smtpd_sasl_path = /dev/shm/sasl-auth.sock"
postconf -e "smtpd_sasl_security_options = noanonymous"
postconf -e "broken_sasl_auth_clients = yes"
postconf -e "myhostname = nas.agilesys.co.kr"

# SMTPS/Submission
sed -i '/^#smtps/s/^#//' /etc/postfix/master.cf
sed -i '/^#  -o smtpd_tls_wrappermode=yes/s/^#//' /etc/postfix/master.cf
sed -i '/^#  -o smtpd_sasl_auth_enable=yes/s/^#//' /etc/postfix/master.cf
sed -i '/^#submission/s/^#//' /etc/postfix/master.cf
sed -i '/^#  -o smtpd_sasl_auth_enable=yes/s/^#//' /etc/postfix/master.cf

cat > /etc/dovecot/conf.d/10-ssl.conf <<'EOF'
ssl = yes
ssl_cert = </etc/postfix/ssl/cert.pem
ssl_key = </etc/postfix/ssl/key.pem
EOF

cat > /etc/dovecot/conf.d/90-quota.conf <<'EOF'
plugin {
  quota = maildir:User quota
  quota_rule = *:storage=0
}
EOF

# SSL Cert for Postfix
mkdir -p /etc/postfix/ssl
if [ ! -f /etc/postfix/ssl/cert.pem ]; then
  openssl req -new -x509 -days 3650 -nodes -out /etc/postfix/ssl/cert.pem -keyout /etc/postfix/ssl/key.pem -subj "/CN=nas.agilesys.co.kr" -addext "subjectAltName=DNS:nas.agilesys.co.kr,DNS:mail.digistory.co.kr,DNS:localhost,IP:127.0.0.1"
fi

# Dovecot Plugins
sed -i 's/ quota//g' /etc/dovecot/conf.d/10-mail.conf
sed -i '/^mail_plugins =/ s/$/ quota/' /etc/dovecot/conf.d/10-mail.conf
sed -i 's/ imap_quota//g' /etc/dovecot/conf.d/20-imap.conf
sed -i '/^  mail_plugins =/ s/$/ imap_quota/' /etc/dovecot/conf.d/20-imap.conf
