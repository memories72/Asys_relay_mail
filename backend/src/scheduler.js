const cron = require('node-cron');
const { logSyncEvent, getAllPop3Accounts } = require('./db');
const { fetchPop3Account } = require('./fetcher');
const { updateProgress, clearProgress, pop3Progress } = require('./progress');

let isPaused = false;
const runningTasks = new Set(); // tracks account IDs currently being fetched

const setPaused = (paused) => {
    isPaused = paused;
    console.log(`[Scheduler] Sync state changed: Paused = ${isPaused}`);
};

const startScheduler = () => {
    // node_scheduler_1min
    // properties: { schedule_interval: '1m' }
    cron.schedule('*/1 * * * *', async () => {
        if (isPaused) {
            console.log(`[Scheduler] Sync skipped. Paused: ${isPaused}`);
            const accounts = await getAllPop3Accounts();
            for (const acc of accounts) {
                if (!pop3Progress[acc.id] || pop3Progress[acc.id].status === 'idle' || pop3Progress[acc.id].status === 'error') {
                    updateProgress(acc.id, { status: 'paused', label: acc.pop3_user, user_email: acc.user_email });
                }
            }
            return;
        }

        console.log(`[Scheduler] 1분 주기 외부 POP3 개별 수집 트리거 동작 - ${new Date().toISOString()}`);

        try {
            const accounts = await getAllPop3Accounts();
            if (accounts.length === 0) {
                console.log(`[Sync] 진행 대상 외부 POP3 계정이 없습니다.`);
                return;
            }

            console.log(`[Sync] 총 ${accounts.length}개의 POP3 계정 개별 확인 중...`);

            // Execute all account fetches in parallel independently
            const syncTasks = accounts.map(async (account) => {
                if (runningTasks.has(account.id)) {
                    // console.log(`[Sync] 계정 ${account.pop3_user} 은(는) 이미 수집 중입니다. 스킵합니다.`);
                    return 0;
                }

                try {
                    runningTasks.add(account.id);
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
                } finally {
                    runningTasks.delete(account.id);
                }
            });

            const results = await Promise.all(syncTasks);
            const totalFetched = results.reduce((acc, curr) => acc + curr, 0);

            // Log total to MariaDB
            if (totalFetched > 0) {
                await logSyncEvent('SUCCESS', totalFetched);
                console.log(`[Sync] 전체 개별 수집 루틴 완료. DB 로깅 완료 (총 새 메일: ${totalFetched}건)`);
            }
        } catch (error) {
            console.error('[Sync] 동기화 실패', error);
            await logSyncEvent('FAILED', 0);
        }
    });

    console.log('[Scheduler] 1분 주기 개별 병렬 수집 트리거 초기화 완료');
};

const getPaused = () => isPaused;

module.exports = { startScheduler, setPaused, getPaused };
