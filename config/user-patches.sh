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

cat > /etc/dovecot/conf.d/10-master.conf <<'EOF'
service auth {
  unix_listener /var/spool/postfix/private/auth {
    mode = 0666
    user = postfix
    group = postfix
  }
}
EOF

# Standard Postfix Settings
postconf -e "virtual_mailbox_domains = agilesys.co.kr"
postconf -e "myhostname = nas.agilesys.co.kr"

# SSL/TLS for STARTTLS (Ensures STARTTLS is offered in EHLO)
postconf -e "smtpd_tls_cert_file = /etc/postfix/ssl/cert.pem"
postconf -e "smtpd_tls_key_file = /etc/postfix/ssl/key.pem"
postconf -e "smtpd_tls_security_level = may"
postconf -e "smtpd_tls_auth_only = no"

# SASL Auth
postconf -e "smtpd_sasl_auth_enable = yes"
postconf -e "smtpd_sasl_type = dovecot"
postconf -e "smtpd_sasl_path = private/auth"
postconf -e "smtpd_sasl_security_options = noanonymous"
postconf -e "broken_sasl_auth_clients = yes"

# Activate Ports with correct authentication glue
sed -i 's/^#submission/submission/' /etc/postfix/master.cf
sed -i 's/^#smtps/smtps/' /etc/postfix/master.cf

# Ensure 587 has the auth link
if ! grep -q "smtpd_sasl_path=private/auth" /etc/postfix/master.cf; then
  sed -i '/^submission/a \  -o smtpd_sasl_auth_enable=yes\n  -o smtpd_sasl_type=dovecot\n  -o smtpd_sasl_path=private/auth\n  -o smtpd_tls_security_level=may' /etc/postfix/master.cf
fi

# Ensure 465 uses SSL wrappermode
if ! grep -q "smtpd_tls_wrappermode=yes" /etc/postfix/master.cf; then
  sed -i '/^smtps/a \  -o smtpd_tls_wrappermode=yes\n  -o smtpd_sasl_auth_enable=yes' /etc/postfix/master.cf
fi

cat > /etc/dovecot/conf.d/90-quota.conf <<'EOF'
plugin {
  quota = maildir:User quota
  quota_rule = *:storage=0
}
EOF

# Ensure quota is applied in mail plugins
if ! grep -q "quota" /etc/dovecot/conf.d/10-mail.conf; then
  sed -i '/^mail_plugins =/ s/$/ quota/' /etc/dovecot/conf.d/10-mail.conf
fi
