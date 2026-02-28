const { getPool } = require('./db');
const { searchCachedMails } = require('./search');

/**
 * Mail Rules Engine.
 * Run rules based on message conditions and execute actions (move, flag, delete).
 */
/**
 * Mail Rules Engine.
 * Run rules based on message conditions and execute actions (move, flag, delete).
 * Returns true if the message was moved or deleted, meaning further processing should stop.
 */
async function processRules(email, mailbox, message, imapClient) {
    const pool = getPool();

    // 1. Fetch active rules for this user
    const [rules] = await pool.query(`
        SELECT * FROM mail_rules 
        WHERE user_email = ? AND is_active = TRUE 
        ORDER BY sort_order ASC
    `, [email]);

    if (rules.length === 0) return false;

    let stopProcessing = false;

    for (const rule of rules) {
        // Conditions and actions can be arrays or single objects depending on implementation
        let conditions = typeof rule.conditions === 'string' ? JSON.parse(rule.conditions || '[]') : rule.conditions;
        let actions = typeof rule.actions === 'string' ? JSON.parse(rule.actions || '[]') : rule.actions;

        // Normalize to array if they aren't
        if (!Array.isArray(conditions)) conditions = [conditions];
        if (!Array.isArray(actions)) actions = [actions];

        let matchesAll = true;

        // Check conditions (AND logic)
        for (const cond of conditions) {
            if (!cond || !cond.field) continue;
            const field = cond.field.toLowerCase();
            const operator = cond.operator ? cond.operator.toLowerCase() : 'contains';
            const value = cond.value ? cond.value.toString().toLowerCase() : '';

            // Map common fields
            let target = '';
            if (field === 'subject') target = message.subject || '';
            else if (field === 'from') target = (message.fromAddress || message.sender_address || '');
            else if (field === 'to') target = JSON.stringify(message.to || message.recipient_address || '');
            else if (field === 'body') target = (message.text || message.html || '');
            else target = message[field] || '';

            target = target.toString().toLowerCase();

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
        if (matchesAll && conditions.length > 0) {
            console.log(`[Rules] Match for rule: ${rule.name} (User: ${email})`);
            for (const action of actions) {
                if (!action || !action.type) continue;
                const type = action.type.toLowerCase();
                const targetValue = action.target || action.value;

                try {
                    if (type === 'move' && targetValue) {
                        console.log(`[Rules] Executing Move to: ${targetValue} (UID: ${message.uid})`);
                        await imapClient.messageMove(message.uid, targetValue, { uid: true });
                        stopProcessing = true;
                    } else if (type === 'flag' && targetValue) {
                        const imapFlag = targetValue === 'star' || targetValue === 'starred' ? '\\Flagged' : '\\Important';
                        console.log(`[Rules] Executing Flag: ${imapFlag} (UID: ${message.uid})`);
                        await imapClient.messageFlagsAdd(message.uid, [imapFlag], { uid: true });
                    } else if (type === 'delete') {
                        console.log(`[Rules] Executing Delete (UID: ${message.uid})`);
                        await imapClient.messageFlagsAdd(message.uid, ['\\Deleted'], { uid: true });
                        // Expunge will happen on mailbox close
                        stopProcessing = true;
                    }
                } catch (actionErr) {
                    console.error(`[Rules] Action "${type}" failed:`, actionErr.message);
                }
            }
            // Stop after first matching rule
            break;
        }
    }
    return stopProcessing;
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
