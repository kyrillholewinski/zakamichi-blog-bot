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
import {
    WINDOWS, isWithin, jstHour,
    markSchedulerStarted, recordCycleStart, recordCycleEnd, recordCycleSkipped, recordBackfill
} from './services/schedule.js';

const isPollingActive = () => isWithin(WINDOWS.crawl);

let cycleRunning = false;

async function runAll() {
    // A quota-limited backfill can outlast the interval; never run two cycles at once.
    if (cycleRunning) {
        console.log('Previous cycle still running. Skipping this one.');
        recordCycleSkipped();
        return;
    }
    cycleRunning = true;

    const isPollingTime = isPollingActive();
    recordCycleStart(isPollingTime ? 'crawl' : 'backfill');
    let cycleError = null;

    try {
        console.log(`Starting Cycle at ${new Date().toLocaleTimeString()} for ${isPollingTime ? 'Polling' : 'Translation'}`);

        // Pick up config/config.json edits before anything broadcasts, so channel
        // changes take effect from this cycle onwards.
        if (ENABLE_BROADCAST) {
            loadChannelConfig();
            await drainBroadcastQueue();
        }

        if (!isPollingTime) {
            // Overnight backfill: newest posts first, capped by the daily quota.
            if (ENABLE_TRANSLATION) {
                const startedAt = new Date();
                const result = await runBackfill({ shouldStop: isPollingActive });
                recordBackfill(startedAt, result);
            }
        } else {
            console.log('Polling active. Skipping translation.');
            const crawlers = [
                new HinatazakaCrawler(),
                new SakurazakaCrawler(),
                new NogizakaCrawler()
            ];
            if (isWithin(WINDOWS.bokuao)) {
                console.log('Bokuao Polling Hour:', jstHour());
                crawlers.push(new BokuaoCrawler());
            }
            // Run sequentially to save CPU, or Promise.all for speed
            // Promise.all is fine because they are IO bound
            await Promise.all(crawlers.map(c => c.run()));
        }
        console.log('Cycle Complete.');
    } catch (err) {
        cycleError = err;
        console.error(`Cycle failed: ${err.stack || err.message}`);
    } finally {
        recordCycleEnd(cycleError);
        cycleRunning = false;
    }
}

scheduleDailyQuotaReset();
startAdminBot();

// Initial Run
markSchedulerStarted();
runAll();

// Schedule
setInterval(runAll, POLLING_INTERVAL_MS);
