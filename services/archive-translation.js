import fs from 'fs';
import path from 'path';
import {
    PATHS,
    TRANSLATE_ON_ARCHIVE,
    ARCHIVE_TRANSLATE_MAX_AGE_HOURS
} from '../config/constants.js';
import { getGroupConfig } from '../config/channels.js';
import { translateMessage, DEFAULT_TARGET_LANGUAGE } from './translate.js';
import { parseBlogHtml, classifyBlocks } from './blog-content.js';
import { escapeHtml } from './message-builder.js';
import { canAutoTranslate, isTranslationPaused } from './admin-state.js';

/**
 * The translated archive in blogContent_TC/<group>/:
 *
 *   <id>.html   translated article HTML (tags preserved)
 *   <id>.json   { "title": "…", "targetLanguage": "…", "translatedAt": "…", "source": "crawl" }
 *
 * Both the crawler (right after a new post is archived) and the overnight
 * backfill write here, and the broadcaster reads it back so a post that is
 * already translated never costs another AI request. Older backfill output has
 * no .json sidecar; it is read as the default language with no title.
 */

// The title rides along in the same request as a marked heading, so one call
// translates the whole post.
const TITLE_ATTR = 'data-zk-title';
const TITLE_REGEX = new RegExp(`<h1\\b[^>]*\\b${TITLE_ATTR}\\b[^>]*>([\\s\\S]*?)</h1>\\s*`, 'i');
const CODE_FENCE_REGEX = /^```(?:html)?\s*\n([\s\S]*?)\n```\s*$/i;

function archivePaths(groupName, blogId) {
    const dir = path.join(PATHS.BLOG_CONTENT_TC, groupName);
    return {
        dir,
        html: path.join(dir, `${blogId}.html`),
        meta: path.join(dir, `${blogId}.json`)
    };
}

export function hasArchivedTranslation(groupName, blogId) {
    return fs.existsSync(archivePaths(groupName, blogId).html);
}

function htmlToPlainText(html) {
    return parseBlogHtml(html)
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join(' ')
        .trim();
}

/** Separates the marked title heading from the translated body. */
function splitTitle(output) {
    const unfenced = output.trim().replace(CODE_FENCE_REGEX, '$1');
    const match = unfenced.match(TITLE_REGEX);
    if (!match) return { title: null, body: unfenced };
    return {
        title: htmlToPlainText(match[1]) || null,
        body: unfenced.replace(TITLE_REGEX, '').trim()
    };
}

/**
 * Translates one post's HTML (and title) with the group's settings and writes
 * it to the translated archive.
 *
 * @param {object} post
 * @param {string} post.group
 * @param {string} post.id
 * @param {string} post.name - Author, used for context.
 * @param {string} [post.title]
 * @param {string} post.html - Original article HTML.
 * @param {string} [source] - What produced it ('crawl' | 'backfill'), kept in the sidecar.
 * @returns {Promise<{title: string|null, html: string, targetLanguage: string}|null>} Null on failure.
 */
export async function translateAndArchive({ group, id, name, title, html }, source = 'crawl') {
    if (!html) return null;

    const groupConfig = getGroupConfig(group);
    const targetLanguage = groupConfig?.translation.target_language || DEFAULT_TARGET_LANGUAGE;
    const cleanTitle = title?.trim();
    const input = cleanTitle
        ? `<h1 ${TITLE_ATTR}>${escapeHtml(cleanTitle)}</h1>\n${html}`
        : html;

    const output = await translateMessage(input, name, group, {
        preserveHtml: true,
        glossary: groupConfig?.glossary,
        targetLanguage,
        thinkingLevel: groupConfig?.translation.thinking_level
    });
    if (!output) return null;

    const { title: translatedTitle, body } = splitTitle(output);
    const paths = archivePaths(group, id);
    const meta = {
        title: translatedTitle,
        targetLanguage,
        translatedAt: new Date().toISOString(),
        source
    };

    await fs.promises.mkdir(paths.dir, { recursive: true });
    await fs.promises.writeFile(paths.html, body, 'utf-8');
    await fs.promises.writeFile(paths.meta, JSON.stringify(meta, null, 2), 'utf-8');

    return { title: translatedTitle, html: body, targetLanguage };
}

/**
 * Reads a post back from the translated archive.
 * @returns {Promise<{title: string|null, html: string, targetLanguage: string}|null>}
 */
export async function loadArchivedTranslation(groupName, blogId) {
    const paths = archivePaths(groupName, blogId);

    let html;
    try {
        html = await fs.promises.readFile(paths.html, 'utf-8');
    } catch {
        return null;
    }

    let meta = {};
    try {
        meta = JSON.parse(await fs.promises.readFile(paths.meta, 'utf-8')) || {};
    } catch { }

    return {
        title: meta.title || null,
        html,
        targetLanguage: meta.targetLanguage || DEFAULT_TARGET_LANGUAGE
    };
}

/**
 * Builds the broadcaster's translated block list from an archived translation,
 * without calling the AI.
 *
 * The archive keeps every tag, so the translated HTML parses into the same
 * sequence of text and media blocks as the original; each text block then picks
 * up its counterpart's text. Returns null when the archive is in another
 * language or the two no longer line up, so the caller can translate afresh.
 *
 * @param {Array<object>} blocks - Classified blocks of the original post.
 * @param {object} archived - From loadArchivedTranslation().
 * @param {object} settings - The destination's `translation` settings.
 * @param {string} [baseUrl] - Site origin for relative media URLs.
 * @returns {{title: string|null, blocks: Array<object>, translatedCount: number}|null}
 */
export function blocksFromArchive(blocks, archived, settings, baseUrl = '') {
    if (!archived) return null;

    const wantedLanguage = settings.target_language || DEFAULT_TARGET_LANGUAGE;
    if (archived.targetLanguage !== wantedLanguage) return null;

    const translatedBlocks = classifyBlocks(parseBlogHtml(archived.html, { baseUrl }));
    if (translatedBlocks.length !== blocks.length) return null;
    if (blocks.some((block, i) => block.type !== translatedBlocks[i].type)) return null;

    const translateBody = settings.translate_body !== false;
    const translateCaptions = settings.translate_image_captions !== false;
    let translatedCount = 0;

    const outputBlocks = blocks.map((block, i) => {
        if (block.type !== 'text') return { ...block };
        const wanted = block.role === 'caption' ? translateCaptions : translateBody;
        if (!wanted) return { ...block };
        translatedCount += 1;
        return { ...block, translatedText: translatedBlocks[i].text };
    });

    const title = settings.translate_title !== false ? archived.title : null;
    return { title, blocks: outputBlocks, translatedCount };
}

function isRecent(blog) {
    const time = new Date(blog.DateTime).getTime();
    if (Number.isNaN(time)) return false;
    return Date.now() - time <= ARCHIVE_TRANSLATE_MAX_AGE_HOURS * 60 * 60 * 1000;
}

/**
 * Translates a crawl's newly archived posts into blogContent_TC/, so they are
 * ready before the broadcaster sends them.
 *
 * Skips posts that were not archived (archiving off for the member), posts
 * older than ARCHIVE_TRANSLATE_MAX_AGE_HOURS, and authors whose translation is
 * paused, blocked or switched off. These calls do not use the backfill quota;
 * a failure is left for the backfill to retry.
 *
 * @param {string} groupName
 * @param {Array<object>} blogs - Crawler detail records carrying `content`.
 * @returns {Promise<{translated: number, failed: number}>}
 */
export async function translateNewArchives(groupName, blogs) {
    const result = { translated: 0, failed: 0 };
    if (!TRANSLATE_ON_ARCHIVE || !blogs?.length) return result;

    const ordered = [...blogs].sort((a, b) => new Date(a.DateTime) - new Date(b.DateTime));

    for (const blog of ordered) {
        // Re-check per post: the owner may pause translation mid-run.
        if (isTranslationPaused()) break;
        if (!blog.content || !isRecent(blog)) continue;
        if (!canAutoTranslate(groupName, blog.Name)) continue;
        if (!fs.existsSync(path.join(PATHS.BLOG_CONTENT, groupName, `${blog.ID}.html`))) continue;
        if (hasArchivedTranslation(groupName, blog.ID)) continue;

        console.log(`🌐 Translating new archive ${groupName}/${blog.ID} by ${blog.Name}...`);
        const archived = await translateAndArchive({
            group: groupName,
            id: blog.ID,
            name: blog.Name,
            title: blog.Title,
            html: blog.content
        }, 'crawl');

        if (archived) {
            result.translated += 1;
        } else {
            result.failed += 1;
            console.error(`❌ Archive translation failed for ${groupName}/${blog.ID}. The backfill will retry it.`);
        }
    }

    if (result.translated || result.failed) {
        console.log(`🗂 ${groupName}: ${result.translated} new post(s) translated on archiving, ${result.failed} failed.`);
    }
    return result;
}
