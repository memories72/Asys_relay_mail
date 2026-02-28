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

# Standard Postfix Settings
postconf -e "virtual_mailbox_domains = agilesys.co.kr"
postconf -e "myhostname = nas.agilesys.co.kr"
postconf -e "smtpd_tls_security_level = may"
postconf -e "smtpd_tls_auth_only = no"
postconf -e "smtpd_sasl_auth_enable = yes"
postconf -e "smtpd_sasl_type = dovecot"
postconf -e "smtpd_sasl_path = private/auth"

# Activate Ports
sed -i '/^#submission/s/^#//' /etc/postfix/master.cf
sed -i '/^#smtps/s/^#//' /etc/postfix/master.cf

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
