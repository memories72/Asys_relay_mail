'use strict';

const pop3Progress = {}; // { accountId: { current: 0, total: 0, status: 'fetching'|'done'|'idle' } }

module.exports = {
    pop3Progress,
    updateProgress: (id, data) => {
        pop3Progress[id] = { ...pop3Progress[id], ...data };
    },
    clearProgress: (id) => {
        delete pop3Progress[id];
    }
};
