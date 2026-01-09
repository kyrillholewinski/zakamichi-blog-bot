import { BaseCrawler } from './base.js';
import { GROUPS, URLS, BOKUAO_COOKIE } from '../config/constants.js';
import { fetchHtml } from '../utils/http.js';
import { parseDateTime, DateFormats } from '../utils/date-parser.js';

export class BokuaoCrawler extends BaseCrawler {
    constructor() {
        super(GROUPS.BOKUAO, GROUPS.BOKUAO);
        this.cookies = BOKUAO_COOKIE;
    }

    async fetchPageList(page) {
        const url = `${URLS.BOKUAO}/blog/list/1/0/?writer=0&page=${page}`;
        return await fetchHtml(url, this.cookies);
    }

    async parsePageList(htmlDoc) {
        const nodes = htmlDoc.querySelectorAll("li[data-delighter]");
        return nodes.map(node => {
            const aTag = node.querySelector("a");
            const href = aTag ? aTag.getAttribute("href") : "";
            const id = href.split('/').pop();
            return { id, url: `${URLS.BOKUAO}${href}`, node };
        });
    }

    async fetchBlogDetail(id, url) {
        const doc = await fetchHtml(url, this.cookies);
        if (!doc) return null;

        const article = doc.querySelector("div.txt");
        if (!article) return null;

        const writerP = doc.querySelector("p.writer");
        const titleP = doc.querySelector("p.tit");
        const dateT = doc.querySelector("p.date");
        const dateStr = dateT ? dateT.innerText.trim() : "";

        return {
            ID: id,
            Title: titleP ? titleP.innerText.trim() : "",
            Name: writerP ? writerP.innerText.trim().replace(/\s/g, "") : "",
            DateTime: parseDateTime(dateStr, DateFormats[3]),
            ImageList: article.querySelectorAll("img").map(i => i.getAttribute("src")),
            content: article.innerHTML
        };
    }
}