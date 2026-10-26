import pLimit from 'p-limit';
import os from 'os';
import { loadBlogStatus, saveBlogStatus, saveBlogContent } from '../utils/file-system.js';
import { broadcastBlogs } from '../services/broadcaster.js';
import { getMemberSettings } from '../services/admin-state.js';
import { recordCrawl } from '../services/schedule.js';

export class BaseCrawler {
    constructor(groupName, memberMap) {
        this.groupName = groupName;
        this.memberMap = memberMap
        this.limit = pLimit(os.cpus().length);
        this.existingBlogs = {};
        this.newBlogsCount = 0;
        // Details of this run's new posts, handed to the broadcaster once crawling finishes.
        this.newBlogs = [];
        this.maxPages = 100; // Safe limit
        this.stopOnConsecutiveExisting = 1; // Stop if 5 pages have no new data
    }

    // Abstract methods to override
    async fetchPageList() { throw new Error("Method not implemented."); }
    async parsePageList() { throw new Error("Method not implemented."); }
    async fetchBlogDetail() { throw new Error("Method not implemented."); }

    async run() {
        console.log(`\n--- 🚀 Starting ${this.groupName} ---`);
        const startedAt = new Date();
        this.existingBlogs = await loadBlogStatus(this.groupName);
        this.newBlogs = [];
        const startCount = Object.keys(this.existingBlogs).length;
        console.log(`Loaded ${this.groupName} ${startCount} existing blogs.`);

        let page = this.groupName == "Bokuao" ? 1 : 0
        let noNewDataCount = 0;
        let isRunning = true;

        // Using a sliding window approach for pages
        while (isRunning && page < this.maxPages) {
            // Process batches of pages (e.g., 5 pages in parallel)
            const batchPromises = [];
            for (let i = 0; i < 1; i++) {
                batchPromises.push(this.processPage(page + i));
            }

            const results = await Promise.all(batchPromises);

            // Check results to decide if we stop
            const anyNewData = results.some(r => r === true);
            if (!anyNewData) {
                noNewDataCount += 1;
            } else {
                noNewDataCount = 0;
            }

            if (noNewDataCount >= this.stopOnConsecutiveExisting) {
                console.log(`Stopping: No new data found for ${this.stopOnConsecutiveExisting} pages.`);
                isRunning = false;
            }

            page += 1;
        }
        if (this.newBlogsCount > 0) {
            console.log(`💾 Saving ${this.newBlogsCount} new blogs for ${this.groupName}...`);
            await saveBlogStatus(this.groupName, this.existingBlogs, this.memberMap);
            // Broadcast after the manifest is on disk: a crash mid-send then resumes
            // from BroadcastStatus.JSON instead of re-crawling everything.
            await broadcastBlogs(this.groupName, this.newBlogs);
        } else {
            console.log(`✅ Up to date.`);
        }
        recordCrawl(this.groupName, { startedAt, newPosts: this.newBlogsCount });
    }

    async processPage(pageNumber) {
        return this.limit(async () => {
            try {
                const listData = await this.fetchPageList(pageNumber);
                if (!listData) return false;

                const items = await this.parsePageList(listData);
                if (!items || items.length === 0) return false;

                let hasNew = false;
                for (const item of items) {
                    if (!this.existingBlogs[item.id]) {
                        // It's new! Fetch details
                        const detail = await this.fetchBlogDetail(item.id, item.url);
                        if (detail) {
                            const html = detail.content;
                            // Save HTML immediately, unless archiving is off for this member
                            if (getMemberSettings(this.groupName, detail.Name).archive) {
                                await saveBlogContent(this.groupName, item.id, html);
                            }
                            // Remove heavy content before saving to JSON manifest
                            delete detail.content;
                            this.existingBlogs[item.id] = detail;
                            // The broadcaster gets the HTML in memory, since it may not be on disk.
                            this.newBlogs.push({ ...detail, content: html });
                            this.newBlogsCount++;
                            hasNew = true;
                            console.log(`[NEW]${this.groupName}|${detail.Name}|${detail.ID}|ImageCount: ${detail.ImageList.length}|${detail.Title}`);
                        }
                    }
                }
                return hasNew;
            } catch (err) {
                console.error(`Error processing page ${pageNumber}: ${err.message}`);
                return false;
            }
        });
    }
}