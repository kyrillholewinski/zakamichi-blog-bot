import { BaseCrawler } from './base.js';
import { GROUPS, MEMBERS, URLS } from '../config/constants.js';
import { fetchHtml } from '../utils/http.js';
import { parseDateTime, DateFormats } from '../utils/date-parser.js';

export class SakurazakaCrawler extends BaseCrawler {
    constructor() {
        super(GROUPS.SAKURAZAKA, MEMBERS.SAKURAZAKA);
    }

    async fetchPageList(page) {
        return await fetchHtml(`${URLS.SAKURAZAKA}/s/s46/diary/blog/list?page=${page}`);
    }

    async parsePageList(htmlDoc) {
        // Filter strictly for 'li.box'
        const nodes = htmlDoc.querySelectorAll("li.box").filter(n => n.classNames === 'box');

        const results = [];
        nodes.forEach(node => {
            const aTag = node.querySelector("a");
            if (aTag) {
                const href = aTag.getAttribute("href");
                const id = href.split('/').pop().split('?')[0];
                results.push({ id, url: `${URLS.SAKURAZAKA}${href}` });
            }
        });
        return results;
    }

    async fetchBlogDetail(id, url) {
        const doc = await fetchHtml(url);
        if (!doc) return null;

        const article = doc.querySelector("div.box-article");
        const foot = doc.querySelector("div.blog-foot");
        if (!article || !foot) return null;

        return {
            ID: id,
            Title: doc.querySelector("h3.title")?.innerText.trim(),
            Name: doc.querySelector(".name")?.innerText.trim().replace(/\s/g, ""),
            DateTime: parseDateTime(foot.querySelector(".date")?.innerText, DateFormats[4]),
            ImageList: article.querySelectorAll("img").map(img => img.getAttribute("src")),
            content: article.innerHTML
        };
    }
}