import { HinatazakaCrawler } from './crawlers/hinatazaka.js';
import { SakurazakaCrawler } from './crawlers/sakurazaka.js';
import { NogizakaCrawler } from './crawlers/nogizaka.js';
import { BokuaoCrawler } from './crawlers/bokuao.js';
import { POLLING_INTERVAL_MS } from './config/constants.js';


const isPollingActive = () => {
    const hour = (new Date().getUTCHours() + 9) % 24
    return hour > 7
};

const isBokuaoPollingActive = () => {
    const hour = (new Date().getUTCHours() + 9) % 24
    return hour === 22
};

async function runAll() {

    if (!isPollingActive()) {
        return;
    }
    // Logic: Run major groups always, Bokuao only at specific time (optional)
    const crawlers = [
        new HinatazakaCrawler(),
        new SakurazakaCrawler(),
        new NogizakaCrawler()
    ];

    if (isBokuaoPollingActive) {
        crawlers.push(new BokuaoCrawler());
    }

    console.log(`Starting Cycle at ${new Date().toLocaleTimeString()}`);

    // Run sequentially to save CPU, or Promise.all for speed
    // Promise.all is fine because they are IO bound
    await Promise.all(crawlers.map(c => c.run()));

    console.log('Cycle Complete.');
}

// Initial Run
runAll();

// Schedule
setInterval(runAll, POLLING_INTERVAL_MS);