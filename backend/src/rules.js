const { getPool } = require('./db');
const { searchCachedMails } = require('./search');

/**
 * Mail Rules Engine.
 * Run rules based on message conditions and execute actions (move, flag, delete).
 */
async function processRules(email, mailbox, message) {
    const pool = getPool();

    // 1. Fetch active rules for this user
    const [rules] = await pool.query(`
        SELECT * FROM mail_rules 
        WHERE user_email = ? AND is_active = TRUE 
        ORDER BY sort_order ASC
    `, [email]);

    if (rules.length === 0) return;

    for (const rule of rules) {
        const conditions = JSON.parse(rule.conditions || '[]');
        const actions = JSON.parse(rule.actions || '[]');
        let matchesAll = true;

        // Check conditions (default is AND)
        for (const cond of conditions) {
            const field = cond.field.toLowerCase();
            const operator = cond.operator.toLowerCase();
            const value = cond.value.toLowerCase();
            const target = (message[field] || '').toLowerCase();

            if (operator === 'contains') {
                if (!target.includes(value)) matchesAll = false;
            } else if (operator === 'equals') {
                if (target !== value) matchesAll = false;
            } else if (operator === 'starts_with') {
                if (!target.startsWith(value)) matchesAll = false;
            } else if (operator === 'ends_with') {
                if (!target.endsWith(value)) matchesAll = false;
            } else if (operator === 'not_contains') {
                if (target.includes(value)) matchesAll = false;
            }

            if (!matchesAll) break;
        }

        // Execute actions if condition matches
        if (matchesAll) {
            console.log(`[Rules] Match for rule: ${rule.name}`);
            for (const action of actions) {
                const type = action.type.toLowerCase();
                const value = action.value;

                if (type === 'move') {
                    // Logic to move message (via IMAP)
                    // (Queue this or execute via common move helper)
                    console.log(`[Rules] Executing action: Move to ${value}`);
                } else if (type === 'flag') {
                    console.log(`[Rules] Executing action: Flagging message`);
                } else if (type === 'delete') {
                    console.log(`[Rules] Executing action: Deleting message`);
                }
            }
            // Usually stop at the first matching rule, or some engines process all
            break;
        }
    }
}

async function getRulesList(email) {
    const pool = getPool();
    const [rows] = await pool.query(`
        SELECT * FROM mail_rules WHERE user_email = ? ORDER BY sort_order ASC
    `, [email]);
    return rows;
}

async function createRule(email, name, conditions, actions) {
    const pool = getPool();
    const [result] = await pool.query(`
        INSERT INTO mail_rules (user_email, name, conditions, actions) 
        VALUES (?, ?, ?, ?)
    `, [email, name, JSON.stringify(conditions), JSON.stringify(actions)]);
    return result.insertId;
}

async function deleteRule(email, ruleId) {
    const pool = getPool();
    await pool.query('DELETE FROM mail_rules WHERE id = ? AND user_email = ?', [ruleId, email]);
}

module.exports = {
    processRules,
    getRulesList,
    createRule,
    deleteRule
};
