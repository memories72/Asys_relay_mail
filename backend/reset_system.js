const { initDatabase, getPool } = require('./src/db');
require('dotenv').config();

async function resetSystem() {
    console.log('---------------------------------------------------------');
    console.log('⚠️  SYSTEM RESET SCRIPT (SYSTEM DATA PURGE)  ⚠️');
    console.log('---------------------------------------------------------');
    console.log('This script will PERMANENTLY DELETE the following data:');
    console.log('- All cached emails (email_cache)');
    console.log('- All email tags mappings (email_tags)');
    console.log('- All POP3 UIDLs (Resetting fetch memory)');
    console.log('- All sync progress and history (sync_state)');
    console.log('- All mail tracking logs (email_tracking)');
    console.log('- All mail delivery logs (mail_logs)');
    console.log('- All queued/sent outbox history (email_outbox)');
    console.log('- All mail quota estimates');
    console.log('---------------------------------------------------------');
    console.log('NOTE: User accounts, SMTP relay settings, and Filter rules will be PRESERVED.');
    console.log('---------------------------------------------------------');

    // Check for confirmation argument
    if (process.argv[2] !== '--confirm') {
        console.log('\n❌ ERROR: Confirmation required.');
        console.log('Please run the script with the --confirm flag:');
        console.log('   node reset_system.js --confirm\n');
        process.exit(1);
    }

    try {
        console.log('🔄 Initializing database connection...');
        const pool = await initDatabase();

        const tablesToClear = [
            'email_tags',      // Clear mappings first (Foreign Keys)
            'email_cache',     // Clear cached emails
            'pop3_uidls',      // Clear UIDL history (Force re-fetch)
            'sync_state',      // Clear sync status/history
            'email_tracking',  // Clear open tracking logs
            'mail_logs',       // Clear delivery logs
            'email_outbox',    // Clear outbox history
            'mail_quotas'      // Clear quota cache
        ];

        console.log('🚀 Starting data purge...');

        for (const table of tablesToClear) {
            try {
                console.log(`   - Clearing table: ${table}...`);
                await pool.query(`DELETE FROM ${table}`);
                // Also reset auto-increment for cleanliness
                await pool.query(`ALTER TABLE ${table} AUTO_INCREMENT = 1`);
            } catch (err) {
                if (err.code === 'ER_NO_SUCH_TABLE') {
                    console.log(`     (Table ${table} does not exist, skipping)`);
                } else {
                    console.error(`     ❌ Error clearing ${table}:`, err.message);
                }
            }
        }

        // Additional update: Reset status on user accounts so they show as "PENDING"
        console.log('   - Resetting account sync statuses...');
        await pool.query("UPDATE user_pop3_accounts SET last_status = 'PENDING', last_error = NULL, last_fetched_at = NULL");

        console.log('---------------------------------------------------------');
        console.log('✅ SUCCESS: System data has been completely reset.');
        console.log('Emails will be re-synchronized during the next sync cycle.');
        console.log('---------------------------------------------------------');

        process.exit(0);
    } catch (error) {
        console.error('\n❌ FATAL ERROR during reset:', error);
        process.exit(1);
    }
}

resetSystem();
