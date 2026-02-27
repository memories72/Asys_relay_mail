const cron = require('node-cron');
const { logSyncEvent, getAllPop3Accounts } = require('./db');
const { fetchPop3Account } = require('./fetcher');
const { updateProgress, clearProgress } = require('./progress');

const startScheduler = () => {
    // node_scheduler_1min
    // properties: { schedule_interval: '1m' }
    cron.schedule('*/1 * * * *', async () => {
        console.log(`[Scheduler] 1분 주기 외부 POP3 수집 트리거 동작 - ${new Date().toISOString()}`);

        try {
            const accounts = await getAllPop3Accounts();
            if (accounts.length === 0) {
                console.log(`[Sync] 진행 대상 외부 POP3 계정이 없습니다.`);
                return;
            }

            console.log(`[Sync] 총 ${accounts.length}개의 POP3 계정 동기화 진행...`);
            let totalFetched = 0;

            for (const account of accounts) {
                try {
                    updateProgress(account.id, { current: 0, total: 0, status: 'fetching' });
                    const fetchedCount = await fetchPop3Account(account, (current, total) => {
                        updateProgress(account.id, { current, total, status: 'fetching' });
                    });
                    updateProgress(account.id, { status: 'done' });
                    setTimeout(() => { clearProgress(account.id); }, 5000);
                    totalFetched += fetchedCount;
                } catch (e) {
                    updateProgress(account.id, { status: 'error' });
                    console.error(`[Sync] ${account.user_email} POP3 Fetch Error:`, e);
                }
            }

            // Log total to MariaDB
            await logSyncEvent('SUCCESS', totalFetched);
            console.log(`[Sync] 전체 동기화 완료. DB 로깅 완료 (총 새 메일: ${totalFetched}건)`);
        } catch (error) {
            console.error('[Sync] 동기화 실패', error);
            await logSyncEvent('FAILED', 0);
        }
    });

    console.log('[Scheduler] 1분 주기 수집 트리거 초기화 완료');
};

module.exports = startScheduler;
