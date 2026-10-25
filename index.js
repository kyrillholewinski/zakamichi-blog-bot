import { HinatazakaCrawler } from './crawlers/hinatazaka.js';
import { SakurazakaCrawler } from './crawlers/sakurazaka.js';
import { NogizakaCrawler } from './crawlers/nogizaka.js';
import { BokuaoCrawler } from './crawlers/bokuao.js';
import { POLLING_INTERVAL_MS, ENABLE_TRANSLATION, ENABLE_BROADCAST } from './config/constants.js';
import { loadChannelConfig } from './config/channels.js';
import { runBackfill } from './services/backfill.js';
import { drainBroadcastQueue } from './services/broadcaster.js';
import { scheduleDailyQuotaReset } from './services/scheduler.js';
import { startAdminBot } from './services/admin/bot.js';

const isPollingActive = () => {
    const hour = (new Date().getUTCHours() + 9) % 24
    return hour > 7
};

const isBokuaoPollingActive = () => {
    const hour = (new Date().getUTCHours() + 9) % 24
    console.log('Bokuao Polling Hour:', hour);
    return hour === 10
};

let cycleRunning = false;

async function runAll() {
    // A quota-limited backfill can outlast the interval; never run two cycles at once.
    if (cycleRunning) {
        console.log('Previous cycle still running. Skipping this one.');
        return;
    }
    cycleRunning = true;

    try {
        const isPollingTime = isPollingActive();
        console.log(`Starting Cycle at ${new Date().toLocaleTimeString()} for ${isPollingTime ? 'Polling' : 'Translation'}`);

        // Pick up config/config.json edits before anything broadcasts, so channel
        // changes take effect from this cycle onwards.
        if (ENABLE_BROADCAST) {
            loadChannelConfig();
            await drainBroadcastQueue();
        }

        if (!isPollingTime) {
            // Overnight backfill: newest posts first, capped by the daily quota.
            if (ENABLE_TRANSLATION) await runBackfill({ shouldStop: isPollingActive });
        } else {
            console.log('Polling active. Skipping translation.');
            // Logic: Run major groups always, Bokuao only at specific time (optional)
            const crawlers = [
                new HinatazakaCrawler(),
                new SakurazakaCrawler(),
                new NogizakaCrawler()
            ];
            const isBokuaoPollingTime = isBokuaoPollingActive();
            if (isBokuaoPollingTime) {
                crawlers.push(new BokuaoCrawler());
            }
            // Run sequentially to save CPU, or Promise.all for speed
            // Promise.all is fine because they are IO bound
            await Promise.all(crawlers.map(c => c.run()));
        }
        console.log('Cycle Complete.');
    } catch (err) {
        console.error(`Cycle failed: ${err.stack || err.message}`);
    } finally {
        cycleRunning = false;
    }
}

scheduleDailyQuotaReset();
startAdminBot();

// Initial Run
runAll();

// Schedule
setInterval(runAll, POLLING_INTERVAL_MS);
