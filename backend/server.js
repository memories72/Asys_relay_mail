require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const cors = require('cors');

const startScheduler = require('./src/scheduler');
const { initDatabase, getPool } = require('./src/db');
const { connectLDAP } = require('./src/ldap');
const { syncMailbox, getCachedMailList } = require('./src/sync');

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(express.static('public', {
    etag: false,
    lastModified: false,
    setHeaders: (res) => {
        res.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    }
}));

const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET || 'agilesys_super_secret_key_2026';

// Internal fast-path SSO exchange for Rainloop JS Injector 
app.post('/api/sso-exchange', (req, res) => {
    const { email, internal_secret } = req.body;
    if (internal_secret !== 'SYS_AGILE_RAINLOOP_9988') {
        return res.status(403).json({ error: 'Forbidden' });
    }
    const token = jwt.sign({ email }, JWT_SECRET, { expiresIn: '24h' });
    res.json({ token, success: true });
});
const { savePop3Account, getAllPop3Accounts, deletePop3Account, getPop3AccountById, updatePop3AccountStatus, getGlobalSmtpSettings, saveGlobalSmtpSettings } = require('./src/db');
const { verifyUser, searchUsers } = require('./src/ldap');
const { fetchMailList, fetchMailBody, downloadAttachment, markSeen, moveToTrash, listMailboxes, moveMessages, emptyMailbox, permanentlyDelete, appendMessage, getStorageQuota, getMailboxStatus, setFlag } = require('./src/imap');
const { fetchPop3Account } = require('./src/fetcher');
const { pop3Progress, updateProgress, clearProgress } = require('./src/progress');

const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } }); // 25MB limit

// Helper: get IMAP password from request header (sent by frontend after login)
const getImapPass = (req) => req.headers['x-mail-password'] || '';


const authenticateToken = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    const token = authHeader && authHeader.split(' ')[1];

    if (token == null) return res.status(401).json({ error: '인증 토큰이 없습니다. 다시 로그인해 주세요.' });

    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.status(403).json({ error: '인증이 만료되었습니다. 다시 로그인해 주세요.' });
        req.user = user;
        next();
    });
};

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    if (!username || !password) return res.status(400).json({ error: 'Username and password required' });

    const result = await verifyUser(username, password);
    if (result.success) {
        const userPayload = { email: result.userEmail, uid: result.uid };
        const accessToken = jwt.sign(userPayload, JWT_SECRET, { expiresIn: '24h' });
        res.json({ token: accessToken, user: userPayload });
    } else {
        res.status(401).json({ error: 'Invalid LDAP credentials', details: result.message });
    }
});

app.get('/api/contacts/search', authenticateToken, async (req, res) => {
    const q = req.query.q || '';
    if (q.length < 2) return res.json([]);
    try {
        const users = await searchUsers(q);
        res.json(users);
    } catch (e) {
        console.error('Contact search error:', e);
        res.status(500).json({ error: 'Search failed' });
    }
});

app.post('/api/pop3-settings', authenticateToken, async (req, res) => {
    const { host, port, tls, user, pass, keep_on_server } = req.body;
    const email = req.user.email; // Extracted securely from JWT

    if (!host || !user || !pass) {
        return res.status(400).json({ error: 'Missing required POP3 fields' });
    }
    const success = await savePop3Account(email, host, port || 110, tls || false, user, pass, keep_on_server !== false);
    if (success) {
        res.json({ status: 'OK', message: 'POP3 configuration saved successfully' });
    } else {
        res.status(500).json({ error: 'Failed to save POP3 configuration' });
    }
});

app.get('/api/pop3-settings', authenticateToken, async (req, res) => {
    const allAccounts = await getAllPop3Accounts();
    // Filter by the securely authenticated user email
    const accounts = allAccounts.filter(a => a.user_email === req.user.email);
    res.json({
        status: 'OK',
        accounts: accounts.map(a => ({
            id: a.id,
            email: a.user_email,
            host: a.pop3_host, // This will be the title in UI
            active: a.is_active,
            keep_on_server: !!a.keep_on_server,
            status: a.last_status,
            error: a.last_error,
            last_fetched: a.last_fetched_at,
            progress: pop3Progress[a.id] || { status: 'idle' }
        }))
    });
});

app.get('/api/pop3-progress', authenticateToken, (req, res) => {
    const userProgress = {};
    for (const [id, data] of Object.entries(pop3Progress)) {
        if (data.user_email === req.user.email) {
            userProgress[id] = data;
        }
    }
    res.json(userProgress);
});

app.post('/api/pop3-test/:id', authenticateToken, async (req, res) => {
    const accountId = req.params.id;
    const account = await getPop3AccountById(req.user.email, accountId);

    if (!account) return res.status(404).json({ error: '계정을 찾을 수 없습니다.' });

    const POP3Client = require('poplib');
    const client = new POP3Client(account.pop3_port, account.pop3_host, {
        tlserrs: false,
        ignoretlserrs: true,
        enabletls: account.pop3_tls === 1 || account.pop3_tls === true,
        debug: false
    });

    let finished = false;
    const timeout = setTimeout(() => {
        if (!finished) {
            finished = true;
            client.quit();
            res.status(500).json({ error: '연결 시간 초과 (Timeout)' });
        }
    }, 10000);

    client.on('error', async (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        console.error(`[POP3 Test] Error:`, err.message);
        await updatePop3AccountStatus(accountId, 'FAILED', err.message);
        res.status(500).json({ error: '연결 실패', details: err.message });
    });

    client.on('connect', () => {
        client.login(account.pop3_user, account.pop3_pass);
    });

    client.on('login', async (status, rawdata) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);

        if (status) {
            await updatePop3AccountStatus(accountId, 'SUCCESS', null);
            res.json({ status: 'OK', message: '로그인 성공!' });
        } else {
            console.error(`[POP3 Test] Login failed for ${account.pop3_user}`);
            await updatePop3AccountStatus(accountId, 'FAILED', 'Authentication failed');
            res.status(401).json({ error: '인증 실패', details: '아이디 또는 비밀번호를 확인하세요.' });
        }
        client.quit();
    });
});

// Direct test for unsaved configuration
app.post('/api/pop3-test-direct', authenticateToken, async (req, res) => {
    const { host, port, tls, user, pass } = req.body;

    if (!host || !user || !pass) {
        return res.status(400).json({ error: '필수 정보가 누락되었습니다.' });
    }

    const POP3Client = require('poplib');
    const client = new POP3Client(port, host, {
        tlserrs: false,
        ignoretlserrs: true,
        enabletls: tls === 1 || tls === true,
        debug: false
    });

    let finished = false;
    const timeout = setTimeout(() => {
        if (!finished) {
            finished = true;
            client.quit();
            res.status(500).json({ error: '연결 시간 초과 (Timeout)' });
        }
    }, 10000);

    client.on('error', (err) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);
        console.error(`[POP3 Direct Test] Error:`, err.message);
        res.status(500).json({ error: '연결 실패', details: err.message });
    });

    client.on('connect', () => {
        client.login(user, pass);
    });

    client.on('login', (status) => {
        if (finished) return;
        finished = true;
        clearTimeout(timeout);

        if (status) {
            res.json({ status: 'OK', message: '로그인 성공!' });
        } else {
            res.status(401).json({ error: '인증 실패', details: '아이디 또는 비밀번호를 확인하세요.' });
        }
        client.quit();
    });
});

app.delete('/api/pop3-settings/:id', authenticateToken, async (req, res) => {
    const success = await deletePop3Account(req.user.email, req.params.id);
    if (success) {
        res.json({ status: 'OK', message: '계정 연동이 해제되었습니다' });
    } else {
        res.status(500).json({ error: '계정 연동 해제 실패' });
    }
});

// ===== SMTP SETTINGS =====
app.get('/api/smtp-settings', authenticateToken, async (req, res) => {
    const settings = await getGlobalSmtpSettings();
    res.json({ status: 'OK', settings });
});

app.post('/api/smtp-settings', authenticateToken, async (req, res) => {
    const { host, port, secure, user, pass } = req.body;
    if (!host || !port) return res.status(400).json({ error: 'Host and port required' });
    const success = await saveGlobalSmtpSettings(host, port, secure, user, pass);
    if (success) {
        res.json({ status: 'OK', message: 'SMTP 설정이 저장되었습니다' });
    } else {
        res.status(500).json({ error: 'SMTP 설정 저장 실패' });
    }
});

app.post('/api/smtp-test', authenticateToken, async (req, res) => {
    const { host, port, secure, user, pass } = req.body;
    const transporter = nodemailer.createTransport({
        host, port: parseInt(port), secure: secure === true,
        auth: user ? { user, pass } : undefined,
        tls: { rejectUnauthorized: false },
        timeout: 5000
    });
    try {
        await transporter.verify();
        res.json({ status: 'OK', message: 'SMTP 서버 연결 성공!' });
    } catch (err) {
        res.status(500).json({ error: 'SMTP 연결 실패', details: err.message });
    }
});

app.post('/api/pop3-test/:id', authenticateToken, async (req, res) => {
    const allAccounts = await getAllPop3Accounts();
    const account = allAccounts.find(a => a.id == req.params.id && a.user_email === req.user.email);
    if (!account) return res.status(404).json({ error: 'Account not found' });

    try {
        updateProgress(account.id, { current: 0, total: 0, status: 'fetching', label: account.pop3_user, user_email: account.user_email });
        fetchPop3Account(account, (current, total) => {
            updateProgress(account.id, { current, total, status: 'fetching', label: account.pop3_user, user_email: account.user_email });
        }).then(() => {
            updateProgress(account.id, { status: 'done', label: account.pop3_user, user_email: account.user_email });
            setTimeout(() => { clearProgress(account.id); }, 5000);
        }).catch(() => {
            updateProgress(account.id, { status: 'error', label: account.pop3_user, user_email: account.user_email });
        });

        res.json({ status: 'OK', message: '연동 테스트 및 수집을 시작했습니다. 잠시만 기다려 주세요.' });
    } catch (err) {
        updateProgress(account.id, { status: 'error' });
        res.status(500).json({ error: '테스트 중 오류 발생', details: err.message });
    }
});

// ===== IMAP WEBMAIL API =====
app.get('/api/mail/inbox', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });
        const folder = req.query.folder || 'INBOX';
        const limit = req.query.limit !== undefined ? parseInt(req.query.limit) : 1000;

        // 1. Trigger background/foreground sync to DB
        await syncMailbox(req.user.email, mailPass, folder);

        // 2. Fetch blazing fast results from DB
        const messages = await getCachedMailList(req.user.email, folder, limit);
        res.json({ status: 'OK', messages });
    } catch (err) {
        console.error('[IMAP] inbox fetch error:', err.message);
        res.status(500).json({ error: 'IMAP connection failed', details: err.message });
    }
});

app.get('/api/mail/folders', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });
        const folders = await listMailboxes(req.user.email, mailPass);
        res.json({ status: 'OK', folders });
    } catch (err) {
        res.status(500).json({ error: 'Failed to list folders', details: err.message });
    }
});

app.get('/api/mail/quota', authenticateToken, async (req, res) => {
    try {
        console.log(`[QUOTA] Request for ${req.user.email}`);
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });

        const pool = getPool();
        const [rows] = await pool.query('SELECT usage_bytes, max_bytes, updated_at FROM mail_quotas WHERE email = ?', [req.user.email]);
        const cached = rows[0];

        const TEN_MINUTES = 10 * 60 * 1000;
        const needsUpdate = !cached || (Date.now() - new Date(cached.updated_at).getTime() > TEN_MINUTES);

        if (needsUpdate) {
            console.log(`[QUOTA] Triggering background IMAP update for ${req.user.email}`);
            getStorageQuota(req.user.email, mailPass).then(async (q) => {
                await pool.query(`
                    INSERT INTO mail_quotas (email, usage_bytes, max_bytes) 
                    VALUES (?, ?, ?)
                    ON DUPLICATE KEY UPDATE usage_bytes = VALUES(usage_bytes), max_bytes = VALUES(max_bytes)
                `, [req.user.email, q.usage, q.limit]);
                console.log(`[QUOTA CACHE] Updated DB for ${req.user.email}`);
            }).catch(e => console.error(`[QUOTA CACHE] Error updating for ${req.user.email}:`, e.message));
        }

        if (cached) {
            console.log(`[QUOTA] Returning DB cached quota for ${req.user.email}`);
            return res.json({ status: 'OK', quota: { usage: parseInt(cached.usage_bytes), limit: parseInt(cached.max_bytes) }, cached: true });
        } else {
            console.log(`[QUOTA] No cache. Returning 0 and updating in background for ${req.user.email}`);
            return res.json({ status: 'OK', quota: { usage: 0, limit: 0 }, updating: true });
        }
    } catch (err) {
        console.error(`[QUOTA] Error for ${req.user.email}:`, err.message);
        res.status(500).json({ error: 'Failed to fetch quota', details: err.message });
    }
});

app.get('/api/mail/stats', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });
        const stats = await getMailboxStatus(req.user.email, mailPass);
        res.json({ status: 'OK', stats });
    } catch (err) {
        console.error(`[STATS] Error for ${req.user.email}:`, err.message);
        res.status(500).json({ error: 'Failed to fetch mail stats', details: err.message });
    }
});

app.get('/api/mail/message/:uid', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });
        const folder = req.query.folder || 'INBOX';
        const msg = await fetchMailBody(req.user.email, mailPass, parseInt(req.params.uid), folder);
        if (!msg) return res.status(404).json({ error: 'Message not found' });
        await markSeen(req.user.email, mailPass, parseInt(req.params.uid), folder).catch(() => { });
        res.json({ status: 'OK', message: msg });
    } catch (err) {
        console.error('[IMAP] message fetch error:', err.message);
        res.status(500).json({ error: 'Failed to fetch message', details: err.message });
    }
});

app.put('/api/mail/messages/seen', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });
        const folder = req.query.folder || 'INBOX';
        const enable = req.body.seen !== false;
        const uids = req.body.uids;
        if (!Array.isArray(uids) || uids.length === 0) return res.status(400).json({ error: 'No UIDs provided' });

        await setFlag(req.user.email, mailPass, uids, '\\Seen', enable, folder);
        res.json({ status: 'OK' });
    } catch (err) {
        console.error('[IMAP] bulk toggle seen flag error:', err.message);
        res.status(500).json({ error: 'Failed to update flags', details: err.message });
    }
});

app.put('/api/mail/message/:uid/seen', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });
        const folder = req.query.folder || 'INBOX';
        const enable = req.body.seen !== false;
        await setFlag(req.user.email, mailPass, parseInt(req.params.uid), '\\Seen', enable, folder);
        res.json({ status: 'OK' });
    } catch (err) {
        console.error('[IMAP] toggle seen flag error:', err.message);
        res.status(500).json({ error: 'Failed to update flag', details: err.message });
    }
});

app.post('/api/mail/messages/delete', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });
        const folder = req.query.folder || 'INBOX';
        const uids = req.body.uids;
        if (!Array.isArray(uids) || uids.length === 0) return res.status(400).json({ error: 'No UIDs provided' });

        await moveToTrash(req.user.email, mailPass, uids.length === 1 ? uids[0] : uids, folder);
        res.json({ status: 'OK', message: 'Success' });
    } catch (err) {
        console.error('[IMAP] bulk delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete messages', details: err.message });
    }
});

app.delete('/api/mail/message/:uid', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });
        const folder = req.query.folder || 'INBOX';
        const uidStr = req.params.uid;

        // Split comma-separated UIDs and parse to numbers
        const uids = uidStr.split(',').map(n => parseInt(n.trim())).filter(n => !isNaN(n));

        if (uids.length === 0) return res.status(400).json({ error: 'No valid UIDs provided' });

        await moveToTrash(req.user.email, mailPass, uids.length === 1 ? uids[0] : uids, folder);
        res.json({ status: 'OK', message: 'Success' });
    } catch (err) {
        console.error('[IMAP] delete error:', err.message);
        res.status(500).json({ error: 'Failed to delete message', details: err.message });
    }
});

app.post('/api/mail/empty-folder', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });
        const folder = req.query.folder;
        if (!folder) return res.status(400).json({ error: 'folder query parameter required' });
        await emptyMailbox(req.user.email, mailPass, folder);
        res.json({ status: 'OK', message: `Folder ${folder} emptied` });
    } catch (err) {
        res.status(500).json({ error: 'Failed to empty folder', details: err.message });
    }
});


app.post('/api/mail/bulk-move', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });
        const { uids, targetFolder, sourceFolder } = req.body;
        if (!uids || !targetFolder) return res.status(400).json({ error: 'Missing uids or targetFolder' });
        await moveMessages(req.user.email, mailPass, uids, targetFolder, sourceFolder || 'INBOX');
        res.json({ status: 'OK', message: `Moved ${Array.isArray(uids) ? uids.length : 1} messages` });
    } catch (err) {
        console.error('[IMAP] bulk-move error:', err);
        res.status(500).json({
            error: '메일 이동 실패',
            details: err.message,
            hint: '대상 폴더가 존재하지 않거나 서버 연결에 문제가 있을 수 있습니다.'
        });
    }
});


app.post('/api/mail/star', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password required' });
        const { uid, folder } = req.body;
        await setFlag(req.user.email, mailPass, uid, '\\Flagged', true, folder || 'INBOX');
        res.json({ status: 'OK' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

app.post('/api/mail/unstar', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password required' });
        const { uid, folder } = req.body;
        await setFlag(req.user.email, mailPass, uid, '\\Flagged', false, folder || 'INBOX');
        res.json({ status: 'OK' });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

// ===== ATTACHMENT DOWNLOAD =====
app.get('/api/mail/message/:uid/attachment/:partId', authenticateToken, async (req, res) => {
    try {
        const mailPass = getImapPass(req);
        if (!mailPass) return res.status(400).json({ error: 'x-mail-password required' });
        const { uid, partId } = req.params;
        const folder = req.query.folder || 'INBOX';
        const filename = req.query.filename || 'attachment';
        const { buffer, meta } = await downloadAttachment(req.user.email, mailPass, parseInt(uid), partId, folder, filename);
        res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`);
        res.setHeader('Content-Type', meta?.contentType || 'application/octet-stream');
        res.send(buffer);
    } catch (err) {
        console.error('[IMAP] attachment download error:', err.message);
        res.status(500).json({ error: '첨부파일 다운로드 실패', details: err.message });
    }
});

// Send email via SMTP - supports file attachments (multipart/form-data)
const nodemailer = require('nodemailer');
const MailComposer = require('nodemailer/lib/mail-composer');
const SMTP_HOST = process.env.SMTP_HOST || 'node_mail_engine';
const SMTP_PORT = parseInt(process.env.SMTP_PORT || '587');

app.post('/api/mail/send', authenticateToken, upload.array('attachments', 10), async (req, res) => {
    let { to, cc, bcc, subject, body, html } = req.body;

    const sanitizeEmails = (str) => {
        if (!str || typeof str !== 'string') return undefined;
        const cleaned = str.split(';').map(s => s.trim()).filter(s => s).join(', ');
        return cleaned || undefined;
    };

    to = sanitizeEmails(to);
    cc = sanitizeEmails(cc);
    bcc = sanitizeEmails(bcc);

    if (!to || !subject) return res.status(400).json({ error: 'to와 subject는 필수입니다' });
    const mailPass = getImapPass(req);
    if (!mailPass) return res.status(400).json({ error: 'x-mail-password header required' });
    try {
        const smtpSettings = await getGlobalSmtpSettings();
        const transportConfig = {
            host: smtpSettings?.host || SMTP_HOST,
            port: parseInt(smtpSettings?.port || SMTP_PORT),
            secure: smtpSettings?.secure === 1 || smtpSettings?.secure === true,
            auth: (smtpSettings?.user && smtpSettings?.pass)
                ? { user: smtpSettings.user, pass: smtpSettings.pass }
                : { user: req.user.email, pass: mailPass },
            tls: { rejectUnauthorized: false },
            name: 'wmail.agilesys.co.kr'
        };

        const transporter = nodemailer.createTransport(transportConfig);
        console.log(`[SMTP] Sending mail from ${req.user.email} via ${transportConfig.host}:${transportConfig.port}`);

        const attachments = (req.files || []).map(f => ({
            filename: f.originalname,
            content: f.buffer,
            contentType: f.mimetype,
        }));

        const mailOptions = {
            from: req.user.email,
            to,
            cc,
            bcc,
            subject,
            text: body || '',
            html: html || undefined,
            attachments,
        };

        const mail = new MailComposer(mailOptions);
        const messageBuffer = await mail.compile().build();

        await transporter.sendMail(mailOptions);

        // Save to Sent folder
        try {
            await appendMessage(req.user.email, mailPass, 'Sent', messageBuffer);
        } catch (appendErr) {
            console.warn('[IMAP] Failed to save to Sent folder:', appendErr.message);
            // We don't fail the request if it was sent successfully but just couldn't be saved to Sent
        }

        res.json({ status: 'OK', message: '메일을 발송했습니다', attachmentCount: attachments.length });

    } catch (err) {
        console.error('[SMTP] send error:', err.message);
        res.status(500).json({ error: '메일 발송 실패', details: err.message });
    }
});

app.get('/health', async (req, res) => {

    try {
        const pool = getPool();
        await pool.query('SELECT 1');
        res.json({
            status: 'OK',
            components: {
                db: 'Connected',
                ldap: 'Client Ready',
                scheduler: 'Running'
            }
        });
    } catch (err) {
        res.status(500).json({ error: err.message });
    }
});

const PORT = process.env.PORT || 13000;
app.listen(PORT, async () => {
    console.log(`[Backend] Agilesys Mail Backend Engine is running on port ${PORT}`);

    // Verify DB connectivity & Create schema if not exists
    try {
        await initDatabase();
        console.log('[DB] MariaDB Storage is officially connected and Schema Checked.');
    } catch (err) {
        console.error('[DB] Initial DB connection and Schema creation failed:', err.message);
    }

    // Start integrated components from JSON architecture
    startScheduler();

    // Verify LDAP connectivity
    try {
        await connectLDAP();
    } catch (err) {
        console.error('[LDAP] Initial connection failed:', err.message);
    }
});
