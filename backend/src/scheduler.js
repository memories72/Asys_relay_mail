const cron = require('node-cron');
const { logSyncEvent, getAllPop3Accounts } = require('./db');
const { fetchPop3Account } = require('./fetcher');
const { updateProgress, clearProgress, pop3Progress } = require('./progress');

let isRunning = false;
let isPaused = false;

const setPaused = (paused) => {
    isPaused = paused;
    console.log(`[Scheduler] Sync state changed: Paused = ${isPaused}`);
};

const startScheduler = () => {
    // node_scheduler_1min
    // properties: { schedule_interval: '1m' }
    cron.schedule('*/1 * * * *', async () => {
        if (isRunning || isPaused) {
            console.log(`[Scheduler] Sync skipped. Running: ${isRunning}, Paused: ${isPaused}`);
            // Update all accounts to 'waiting' if not already fetching
            const accounts = await getAllPop3Accounts();
            for (const acc of accounts) {
                if (!pop3Progress[acc.id] || pop3Progress[acc.id].status === 'idle') {
                    updateProgress(acc.id, { status: isPaused ? 'paused' : 'waiting', label: acc.pop3_user, user_email: acc.user_email });
                }
            }
            return;
        }

        isRunning = true;
        console.log(`[Scheduler] 1분 주기 외부 POP3 수집 트리거 동작 - ${new Date().toISOString()}`);

        try {
            const accounts = await getAllPop3Accounts();
            if (accounts.length === 0) {
                console.log(`[Sync] 진행 대상 외부 POP3 계정이 없습니다.`);
                return;
            }

            console.log(`[Sync] 총 ${accounts.length}개의 POP3 계정 병렬 동기화 진행...`);

            // Execute all account fetches in parallel
            const syncTasks = accounts.map(async (account) => {
                try {
                    updateProgress(account.id, { current: 0, total: 0, status: 'fetching', label: account.pop3_user, user_email: account.user_email });
                    const fetchedCount = await fetchPop3Account(account, (current, total) => {
                        updateProgress(account.id, { current, total, status: 'fetching', label: account.pop3_user, user_email: account.user_email });
                    });
                    updateProgress(account.id, { status: 'done', label: account.pop3_user, user_email: account.user_email });
                    setTimeout(() => { clearProgress(account.id); }, 5000);
                    return fetchedCount;
                } catch (e) {
                    updateProgress(account.id, { status: 'error', label: account.pop3_user, user_email: account.user_email });
                    console.error(`[Sync] ${account.user_email} POP3 Fetch Error:`, e);
                    return 0;
                }
            });

            const results = await Promise.all(syncTasks);
            const totalFetched = results.reduce((acc, curr) => acc + curr, 0);

            // Log total to MariaDB
            await logSyncEvent('SUCCESS', totalFetched);
            console.log(`[Sync] 전체 병렬 동기화 완료. DB 로깅 완료 (총 새 메일: ${totalFetched}건)`);
        } catch (error) {
            console.error('[Sync] 동기화 실패', error);
            await logSyncEvent('FAILED', 0);
        } finally {
            isRunning = false;
        }
    });

    console.log('[Scheduler] 1분 주기 병렬 수집 트리거 초기화 완료');
};

const getPaused = () => isPaused;

module.exports = { startScheduler, setPaused, getPaused };
