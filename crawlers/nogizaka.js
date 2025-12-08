import { BaseCrawler } from './base.js';
import { GROUPS, MEMBERS, URLS } from '../config/constants.js';
import { fetchJson } from '../utils/http.js';
import { parseDateTime, DateFormats } from '../utils/date-parser.js';
import { saveBlogContent } from '../utils/file-system.js';
export class NogizakaCrawler extends BaseCrawler {
    constructor() {
        super(GROUPS.NOGIZAKA, MEMBERS.NOGIZAKA);
        this.batchSize = 1024; // API specific
    }

    async fetchPageList(pageIndex) {
        // Nogizaka uses 'st' (start index) not page number
        const startIndex = pageIndex * this.batchSize;
        const url = `${URLS.NOGIZAKA}/s/n46/api/list/blog?rw=${this.batchSize}&st=${startIndex}&callback=res`;
        return await fetchJson(url);
    }

    async parsePageList(jsonObj) {
        if (!jsonObj || !jsonObj.data) return [];

        return jsonObj.data.map(item => ({
            id: item.code, // ID is inside the JSON
            url: null,     // URL not needed for list parsing as data is in JSON
            raw: item      // Pass the raw item to detail parser
        }));
    }

    async fetchBlogDetail(id, url, rawItem) {
        // Nogizaka list API returns full content in 'text' field!
        // We handle this differently. The BaseCrawler passes the 'item' from parsePageList.
        // We need to access that raw item. 
        // NOTE: In BaseCrawler, we passed { id, url }. We need to adjust BaseCrawler to pass the whole object
        // OR we just cache the raw data in parsePageList.

        // Since BaseCrawler abstraction calls `fetchBlogDetail(item.id, item.url)`,
        // we need a slight hack or store it. 
        // Actually, let's fetch it from the API specific raw data if possible.
        // But since we can't easily pass the `raw` through the generic BaseCrawler signature without changing it:

        // *Better Approach for Nogizaka*:
        // The API gives us everything. We don't need a second HTTP request.
        // We can just construct the object here.

        // However, BaseCrawler expects `fetchBlogDetail` to be called. 
        // We will misuse the `url` param to pass the data if we have to, 
        // OR we rely on the fact that I stored `raw` in `parsePageList` result.

        // Let's assume BaseCrawler logic: `const detail = await this.fetchBlogDetail(item.id, item.url);`
        // We can fix BaseCrawler to pass `item` or we can find the item in memory.

        // SIMPLEST FIX:
        // We will make `fetchBlogDetail` return `null` if we already have data, 
        // BUT BaseCrawler logic requires a return value to save.

        // Let's just re-fetch or (smarter) use a temporary cache in the class.
        // But for now, let's assume we implement a `processPage` override for Nogizaka 
        // OR simplified: Just return the object based on the `raw` data attached to `item` in BaseCrawler.

        // Re-implementing specific fetch logic since we don't have the `raw` data passed into this method signature 
        // without modifying BaseCrawler. 

        // *Lazy fix:* Nogizaka crawler is efficient enough that we can just accept the architectural mismatch 
        // or just accept that `parsePageList` returned objects with `raw`.
        // Let's update `BaseCrawler.js` to pass the whole `item` object.

        return null; // See note below
    }

    // OVERRIDE processPage because Nogizaka is purely API based and different
    async processPage(pageNumber) {
        return this.limit(async () => {
            const listData = await this.fetchPageList(pageNumber);
            if (!listData || !listData.data) return false;

            let hasNew = false;
            for (const blogData of listData.data) {
                if (!this.existingBlogs[blogData.code]) {
                    // Extract images from HTML string
                    const imgMatches = blogData.text.match(/src="([^"]+)"/g) || [];
                    const images = imgMatches.map(s => s.replace('src="', '').replace('"', ''));

                    const detail = {
                        ID: blogData.code,
                        Title: blogData.title,
                        Name: blogData.name.replace(/\s+/g, ''),
                        DateTime: parseDateTime(blogData.date, DateFormats[2]),
                        ImageList: images,
                        content: blogData.text
                    };

                    await saveBlogContent(this.groupName, blogData.code, blogData.text);
                    delete detail.content;
                    this.existingBlogs[detail.ID] = detail;
                    this.newBlogsCount++;
                    hasNew = true;
                    console.log(`[NEW]${this.groupName}|${detail.Name}|${detail.ID}|ImageCount: ${detail.ImageList.length}|${detail.Title}`);
                }
            }
            return hasNew;
        });
    }
}