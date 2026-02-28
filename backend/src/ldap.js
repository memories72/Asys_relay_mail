const ldap = require('ldapjs');
require('dotenv').config();

const client = ldap.createClient({
    url: process.env.LDAP_URL || 'ldap://nas.agilesys.co.kr:1389'
});

// Handle global client connection errors to prevent unhandled exceptions
client.on('error', (err) => {
    console.error('[LDAP] Global Client Error:', err.message);
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

        authClient.on('error', (err) => {
            console.error(`[LDAP Auth] Connection Error:`, err.message);
            resolve({ success: false, message: 'LDAP Connection Failed' });
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

const searchUsers = async (queryStr) => {
    return new Promise((resolve) => {
        if (!client || !client.connected) {
            console.error('[LDAP] Client not connected for search');
            return resolve([]);
        }
        const baseDN = process.env.LDAP_BASE_DN || 'cn=users,dc=ldap,dc=agilesys,dc=co,dc=kr';
        // Search by name (cn/gecos) or id (uid) or email (mail)
        const filterStr = `(|(cn=*${queryStr}*)(uid=*${queryStr}*)(mail=*${queryStr}*)(gecos=*${queryStr}*))`;
        console.log(`[LDAP] Searching with filter: ${filterStr}`);

        const opts = {
            filter: filterStr,
            scope: 'sub',
            attributes: ['uid', 'cn', 'mail', 'gecos'],
            sizeLimit: 20
        };

        client.search(baseDN, opts, (err, res) => {
            if (err) {
                console.error('[LDAP] Search Error:', err.message);
                return resolve([]);
            }

            const users = [];
            res.on('searchEntry', (entry) => {
                try {
                    if (!entry) return;

                    // Helper to convert ldapjs entry/attributes to a simple object
                    const getFlatObject = (item) => {
                        const obj = {};
                        // Case 1: item is a SearchResultEntry with attributes array
                        if (item.attributes && Array.isArray(item.attributes)) {
                            item.attributes.forEach(attr => {
                                if (attr.type && attr.values && attr.values.length > 0) {
                                    obj[attr.type] = attr.values[0];
                                }
                            });
                        }
                        // Case 2: item.pojo or item.object exists
                        const source = item.object || item.pojo;
                        if (source && typeof source === 'object') {
                            Object.assign(obj, source);
                        }
                        // Case 3: item itself has the fields
                        ['uid', 'cn', 'mail', 'displayName'].forEach(key => {
                            if (item[key] && !obj[key]) obj[key] = item[key];
                        });
                        return obj;
                    };

                    const user = getFlatObject(entry);

                    if (!user.uid && !user.cn) {
                        console.log('[LDAP] Entry missing uid/cn, skipping. Rawkeys:', Object.keys(entry));
                        return;
                    }

                    const newUser = {
                        uid: user.uid || user.cn,
                        name: user.gecos || user.cn || user.uid, // Prioritize Korean name (gecos)
                        email: user.mail || (user.uid ? `${user.uid}@agilesys.co.kr` : '')
                    };

                    if (newUser.uid) {
                        users.push(newUser);
                        console.log(`[LDAP] Found user: ${newUser.uid} (${newUser.name}) <${newUser.email}>`);
                    }
                } catch (e) {
                    console.error('[LDAP] Error parsing search entry:', e.stack);
                }
            });

            res.on('error', (err) => {
                console.error('[LDAP] Search stream error:', err.message);
                resolve(users);
            });

            res.on('end', (result) => {
                console.log(`[LDAP] Search finished. Found ${users.length} results.`);
                resolve(users);
            });
        });
    });
};

module.exports = {
    connectLDAP,
    verifyUser,
    searchUsers,
    client
};
