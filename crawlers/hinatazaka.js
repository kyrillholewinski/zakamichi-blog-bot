import { BaseCrawler } from '../services/BaseCrawler.js';
import { GROUPS, URLS } from '../config/constants.js';
import { fetchHtml } from '../utils/http.js';
import { parseDateTime } from '../utils/date-parser.js';

export class HinatazakaCrawler extends BaseCrawler {
    constructor() {
        super(GROUPS.HINATAZAKA);
    }

    async fetchPageList(page) {
        return await fetchHtml(`${URLS.HINATAZAKA}/s/official/diary/member/list?page=${page}`);
    }

    async parsePageList(htmlDoc) {
        const nodes = htmlDoc.querySelectorAll(".p-blog-group > .p-blog-article");
        return nodes.map(node => {
            const linkTag = node.querySelector("a.c-button-blog-detail");
            const href = linkTag ? linkTag.getAttribute("href") : "";
            const id = href.split('/').pop().split('?')[0]; // Simple ID extraction
            return { id, url: `${URLS.HINATAZAKA}${href}`, node }; // Pass node to avoid re-fetching if possible
        });
    }

    async fetchBlogDetail(id, url) {
        // Optimization: Hinatazaka list page often contains the full content.
        // But for safety/consistency with your old code, let's fetch the detail page
        // OR use the node passed from parsePageList if available.
        
        const doc = await fetchHtml(url);
        if (!doc) return null;

        const title = doc.querySelector(".c-blog-article__title")?.innerText.trim();
        const member = doc.querySelector(".c-blog-article__name")?.innerText.trim().replace(/\s/g, "");
        const date = doc.querySelector(".c-blog-article__date")?.innerText.trim();
        const contentDiv = doc.querySelector(".c-blog-article__text");

        const images = contentDiv ? contentDiv.querySelectorAll("img").map(i => i.getAttribute("src")) : [];

        return {
            ID: id,
            Title: title,
            Name: member,
            DateTime: parseDateTime(date),
            ImageList: images,
            content: contentDiv ? contentDiv.innerHTML : ""
        };
    }
}