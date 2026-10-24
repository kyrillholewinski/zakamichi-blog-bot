import htmlParser from 'node-html-parser';

/**
 * Turns the raw article HTML saved by the crawlers into an ordered block list.
 *
 * Blocks preserve reading order, which is what lets the message builder keep a
 * paragraph next to the picture it talks about, and what lets the translator
 * translate image captions (the text sitting between two images) in context.
 *
 * Block shapes:
 *   { type: 'text',  text: string }
 *   { type: 'image', url: string, alt: string }
 *   { type: 'video', url: string }
 */

// Elements that end the current text run.
const BLOCK_TAGS = new Set(['P', 'DIV', 'BR', 'LI', 'TR', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'BLOCKQUOTE', 'SECTION', 'ARTICLE', 'UL', 'OL', 'TABLE', 'HR']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT']);

const HTML_ENTITIES = {
    '&nbsp;': ' ', '&amp;': '&', '&lt;': '<', '&gt;': '>',
    '&quot;': '"', '&#39;': "'", '&apos;': "'"
};

function decodeEntities(text) {
    return text
        .replace(/&(?:nbsp|amp|lt|gt|quot|apos|#39);/g, m => HTML_ENTITIES[m] ?? m)
        .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)));
}

/** Resolves protocol-relative and root-relative sources against the group's site. */
export function absolutizeUrl(src, baseUrl) {
    if (!src) return null;
    const trimmed = src.trim();
    if (/^https?:\/\//i.test(trimmed)) return trimmed;
    if (trimmed.startsWith('//')) return `https:${trimmed}`;
    if (!baseUrl) return null;                       // A relative src with no base is unusable.
    if (trimmed.startsWith('/')) return `${baseUrl.replace(/\/$/, '')}${trimmed}`;
    return `${baseUrl.replace(/\/$/, '')}/${trimmed}`;
}

/**
 * Parses article HTML into ordered blocks.
 *
 * @param {string} html - Inner HTML of the blog article.
 * @param {object} [options]
 * @param {string} [options.baseUrl] - Site origin used to absolutize relative media URLs.
 * @returns {Array<object>} Ordered blocks with empty text runs already dropped.
 */
export function parseBlogHtml(html, { baseUrl = '' } = {}) {
    if (!html) return [];

    const root = htmlParser.parse(html, { blockTextElements: { script: true, style: true } });
    const blocks = [];
    let buffer = '';

    const flush = () => {
        const text = normalizeText(buffer);
        if (text) blocks.push({ type: 'text', text });
        buffer = '';
    };

    const walk = (node) => {
        // node-html-parser: nodeType 3 = text, 1 = element.
        if (node.nodeType === 3) {
            buffer += decodeEntities(node.rawText || '');
            return;
        }
        if (node.nodeType !== 1) return;

        const tag = (node.rawTagName || '').toUpperCase();
        if (SKIP_TAGS.has(tag)) return;

        if (tag === 'IMG') {
            flush();
            const url = absolutizeUrl(node.getAttribute('src') || node.getAttribute('data-src'), baseUrl);
            if (url) blocks.push({ type: 'image', url, alt: decodeEntities(node.getAttribute('alt') || '').trim() });
            return;
        }

        if (tag === 'VIDEO' || tag === 'SOURCE') {
            flush();
            const direct = absolutizeUrl(node.getAttribute('src'), baseUrl);
            if (direct) {
                blocks.push({ type: 'video', url: direct });
                return;
            }
            // <video> without src carries its URL on a nested <source>.
            for (const child of node.childNodes || []) walk(child);
            return;
        }

        if (tag === 'BR') {
            buffer += '\n';
            return;
        }

        const isBlock = BLOCK_TAGS.has(tag);
        if (isBlock) buffer += '\n';
        for (const child of node.childNodes || []) walk(child);
        if (isBlock) buffer += '\n';
    };

    for (const child of root.childNodes || []) walk(child);
    flush();

    return dedupeAdjacentText(blocks);
}

/** Collapses runaway blank lines while keeping intentional paragraph breaks. */
function normalizeText(raw) {
    return raw
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t　]+/g, ' ')
        .split('\n')
        .map(line => line.trim())
        .join('\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** Two text blocks in a row mean nothing to the reader; merge them. */
function dedupeAdjacentText(blocks) {
    const merged = [];
    for (const block of blocks) {
        const previous = merged[merged.length - 1];
        if (block.type === 'text' && previous?.type === 'text') {
            previous.text = `${previous.text}\n\n${block.text}`;
            continue;
        }
        merged.push(block);
    }
    return merged;
}

/**
 * Classifies each text block as body prose or an image caption.
 *
 * A short text run wedged between two images (or trailing directly after one) is
 * how these blogs write photo captions, so it is labelled as such and rendered
 * with the picture it belongs to.
 */
const CAPTION_MAX_LENGTH = 80;

export function classifyBlocks(blocks) {
    return blocks.map((block, index) => {
        if (block.type !== 'text') return { ...block, role: block.type };

        const previous = blocks[index - 1];
        const next = blocks[index + 1];
        const isBetweenMedia = previous && previous.type !== 'text' && (!next || next.type !== 'text');
        const isCaption = Boolean(isBetweenMedia) && block.text.length <= CAPTION_MAX_LENGTH && !block.text.includes('\n\n');

        return { ...block, role: isCaption ? 'caption' : 'body' };
    });
}

/** Every media URL in reading order, ready for a Telegram album. */
export function collectMedia(blocks) {
    return blocks
        .filter(b => b.type === 'image' || b.type === 'video')
        .map(b => ({ type: b.type === 'video' ? 'video' : 'photo', media: b.url }));
}
