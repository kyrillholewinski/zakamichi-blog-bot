import pLimit from 'p-limit';
import os from 'os';
import { loadBlogStatus, saveBlogStatus, saveBlogContent } from '../utils/file-system.js';

export class BaseCrawler {
    constructor(groupName) {
        this.groupName = groupName;
        this.limit = pLimit(os.cpus().length);
        this.existingBlogs = {};
        this.newBlogsCount = 0;
        this.maxPages = 100; // Safe limit
        this.stopOnConsecutiveExisting = 5; // Stop if 5 pages have no new data
    }

    // Abstract methods to override
    async fetchPageList() { throw new Error("Method not implemented."); }
    async parsePageList() { throw new Error("Method not implemented."); }
    async fetchBlogDetail() { throw new Error("Method not implemented."); }

    async run() {
        console.log(`\n--- 🚀 Starting ${this.groupName} ---`);
        this.existingBlogs = await loadBlogStatus(this.groupName);
        const startCount = Object.keys(this.existingBlogs).length;
        console.log(`Loaded ${this.groupName} ${startCount} existing blogs.`);

        let page = this.groupName == "Bokuao" ? 1 : 0
        let noNewDataCount = 0;
        let isRunning = true;

        // Using a sliding window approach for pages
        while (isRunning && page < this.maxPages) {
            // Process batches of pages (e.g., 5 pages in parallel)
            const batchPromises = [];
            for (let i = 0; i < 5; i++) {
                batchPromises.push(this.processPage(page + i));
            }

            const results = await Promise.all(batchPromises);

            // Check results to decide if we stop
            const anyNewData = results.some(r => r === true);
            if (!anyNewData) {
                noNewDataCount += 5;
            } else {
                noNewDataCount = 0;
            }

            if (noNewDataCount >= this.stopOnConsecutiveExisting) {
                console.log(`Stopping: No new data found for ${this.stopOnConsecutiveExisting} pages.`);
                isRunning = false;
            }

            page += 5;
        }

        if (this.newBlogsCount > 0) {
            console.log(`💾 Saving ${this.newBlogsCount} new blogs for ${this.groupName}...`);
            await saveBlogStatus(this.groupName, this.existingBlogs);
        } else {
            console.log(`✅ Up to date.`);
        }
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
                            // Save HTML immediately
                            await saveBlogContent(this.groupName, item.id, detail.content);

                            // Remove heavy content before saving to JSON manifest
                            delete detail.content;
                            this.existingBlogs[item.id] = detail;
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