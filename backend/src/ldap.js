const ldap = require('ldapjs');
require('dotenv').config();

const client = ldap.createClient({
    url: process.env.LDAP_URL || 'ldap://nas.agilesys.co.kr:1389'
});

const connectLDAP = () => {
    return new Promise((resolve, reject) => {
        const bindDN = process.env.LDAP_BIND_DN || 'uid=root,cn=users,dc=ldap,dc=agilesys,dc=co,dc=kr';
        const bindPassword = process.env.LDAP_BIND_PASSWORD || '!@34QWer';

        client.bind(bindDN, bindPassword, (err) => {
            if (err) {
                console.error('[LDAP] Connection Error:', err.message);
                reject(err);
            } else {
                console.log(`[LDAP] Successfully bound to ${process.env.LDAP_URL}`);
                resolve(client);
            }
        });
    });
};

const verifyUser = async (username, password) => {
    return new Promise((resolve) => {
        // Create a dedicated client for this user's authentication
        const authClient = ldap.createClient({
            url: process.env.LDAP_URL || 'ldap://nas.agilesys.co.kr:1389'
        });

        // The strict Bind DN format required by Synology LDAP for user 'username'
        const userDN = `uid=${username},cn=users,dc=ldap,dc=agilesys,dc=co,dc=kr`;

        authClient.bind(userDN, password, (err) => {
            if (err) {
                console.log(`[LDAP] Authentication failed for user: ${username} (Error: ${err.message})`);
                authClient.unbind();
                resolve({ success: false, message: err.message });
            } else {
                console.log(`[LDAP] Authentication successful for user: ${username}`);
                authClient.unbind();
                // We construct the agilesys.co.kr email directly from their uid
                resolve({ success: true, userEmail: `${username}@agilesys.co.kr`, uid: username });
            }
        });
    });
};

module.exports = {
    connectLDAP,
    verifyUser,
    client
};
