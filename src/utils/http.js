import axios from 'axios';
import htmlParser from 'node-html-parser';

const client = axios.create({
    timeout: 15000,
    headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/json,application/xhtml+xml'
    }
});

export async function fetchHtml(url, cookies = null) {
    try {
        const config = {};
        if (cookies) config.headers = { 'Cookie': cookies };
        const { data } = await client.get(url, config);
        return htmlParser.parse(data, {
            blockTextElements: {
                script: true,
                style: true
            }
        });
    } catch (err) {
        console.error(`[HTTP] Error fetching ${url}: ${err.message}`);
        return null;
    }
}

export async function fetchJson(url) {
    try {
        const { data } = await client.get(url);
        // Handle the specific Nogizaka "res(...)" callback format if raw string
        if (typeof data === 'string' && data.startsWith('res(')) {
            const cleanJson = data.slice(4, -2);
            return JSON.parse(cleanJson);
        }
        return data;
    } catch (err) {
        console.error(`[HTTP] Error fetching JSON ${url}: ${err.message}`);
        return null;
    }
}