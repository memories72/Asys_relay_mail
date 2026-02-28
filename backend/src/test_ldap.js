const { connectLDAP, searchUsers } = require('./ldap');

(async () => {
    try {
        await connectLDAP();
        const users = await searchUsers('mg');
        console.log('Result:', users);
    } catch (e) {
        console.error(e);
    }
    process.exit(0);
})();
