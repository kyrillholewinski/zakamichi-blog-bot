import fs from 'fs';
import path from 'path';
import { HinatazakaCrawler } from './crawlers/hinatazaka.js';
import { SakurazakaCrawler } from './crawlers/sakurazaka.js';
import { NogizakaCrawler } from './crawlers/nogizaka.js';
import { BokuaoCrawler } from './crawlers/bokuao.js';
import { translateMessage } from './crawlers/translate.js';
import { POLLING_INTERVAL_MS, PATHS, ENABLE_TRANSLATION } from './config/constants.js';
import { loadBlogStatus } from './utils/file-system.js';

const isPollingActive = () => {
    const hour = (new Date().getUTCHours() + 8) % 24
    return hour > 8
};

const isBokuaoPollingActive = () => {
    const hour = (new Date().getUTCHours() + 8) % 24
    console.log('Bokuao Polling Hour:', hour);
    return hour === 21
};

async function translateExistingBlogContent() {
    if (isPollingActive()) {
        console.log('Polling active. Skipping translation.');
        return;
    }
    let groupEntries = [];
    try {
        groupEntries = await fs.promises.readdir(PATHS.BLOG_CONTENT, { withFileTypes: true });
    } catch {
        console.log('No blog content directory found. Skipping translation.');
        return;
    }

    let translatedCount = 0;

    for (const groupEntry of groupEntries) {
        if (!groupEntry.isDirectory()) continue;
        const groupName = groupEntry.name;
        const groupDir = path.join(PATHS.BLOG_CONTENT, groupName);
        const statusMap = await loadBlogStatus(groupName);

        let fileEntries = [];
        try {
            fileEntries = await fs.promises.readdir(groupDir, { withFileTypes: true });
        } catch {
            continue;
        }

        for (const fileEntry of fileEntries) {
            if (isPollingActive()) {
                console.log('Polling active. Stopping translation.');
                return;
            }
            if (!fileEntry.isFile() || !fileEntry.name.endsWith('.html')) continue;
            const blogId = path.basename(fileEntry.name, '.html');
            const targetDir = path.join(PATHS.BLOG_CONTENT_TC, groupName);
            const targetPath = path.join(targetDir, fileEntry.name);

            try {
                await fs.promises.access(targetPath);
                continue;
            } catch {
                // File does not exist yet.
            }

            const sourcePath = path.join(groupDir, fileEntry.name);
            try {
                await fs.promises.access(sourcePath);
                const html = await fs.promises.readFile(sourcePath, 'utf-8');
                const memberName = statusMap[blogId]?.Name || 'Unknown';
                const dateTime = statusMap[blogId]?.DateTime || null;
                const translatedHtml = await translateMessage(
                    html,
                    memberName,
                    groupName,
                    'gemini',
                    { preserveHtml: true }
                );
                console.log(`Translated blog Id ${blogId} for ${groupName} by ${memberName} at ${dateTime}`);
                if (!translatedHtml) {
                    console.error(`Translation failed blog Id ${blogId} for ${groupName} by ${memberName} at ${dateTime}`);
                    continue;
                }
                await fs.promises.mkdir(targetDir, { recursive: true });
                await fs.promises.writeFile(targetPath, translatedHtml, 'utf-8');
                translatedCount += 1;
            } catch {
                console.log(`Source not found. Skipping ${groupName}/${fileEntry.name}.`);
                continue;
            }
        }
    }

    if (translatedCount === 0) {
        console.log('No untranslated HTML files found.');
        return;
    }

    console.log(`Translation complete. Saved ${translatedCount} file(s) to ${PATHS.BLOG_CONTENT_TC}.`);
}

async function runAll() {
    const isPollingTime = isPollingActive();
    console.log(`Starting Cycle at ${new Date().toLocaleTimeString()} for ${isPollingTime ? 'Polling' : 'Translation'}`);
    if (!isPollingTime) {
        if (ENABLE_TRANSLATION) await translateExistingBlogContent();
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
}

// Initial Run
runAll();

// Schedule
setInterval(runAll, POLLING_INTERVAL_MS);
