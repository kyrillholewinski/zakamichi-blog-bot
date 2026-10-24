import fs from 'fs';
import path from 'path';
import {
    PATHS,
    ENABLE_BROADCAST,
    GROUP_BASE_URLS,
    BLOG_URL_TEMPLATES
} from '../config/constants.js';
import { resolveDestinations, isGroupBroadcastEnabled } from '../config/channels.js';
import { parseBlogHtml, classifyBlocks } from './blog-content.js';
import { translateBlogPost } from './translate.js';
import { buildBlogMessage } from './message-builder.js';
import { getBot } from './telegram.js';
import { sleep } from '../utils/misc.js';

/**
 * Broadcasts crawled blog posts to the Telegram channels configured in
 * config/config.json.
 *
 * Delivery is recorded per group in record/<group>/BroadcastStatus.JSON keyed by
 * blog id + destination, so a restart mid-cycle re-sends nothing already
 * delivered, and adding a channel later only sends future posts to it.
 */

const MAX_SEND_RETRIES = 3;
const MEDIA_THROTTLE_MS = 2000;
const TEXT_THROTTLE_MS = 500;

export function resolveSourceUrl(groupName, blog) {
    if (blog.Url) return blog.Url;
    const template = BLOG_URL_TEMPLATES[groupName];
    return template ? template(blog.ID) : null;
}

function statusPath(groupName) {
    return path.join(PATHS.getGroupDir(groupName), PATHS.BROADCAST_STATUS);
}

export async function loadBroadcastStatus(groupName) {
    try {
        const data = await fs.promises.readFile(statusPath(groupName), 'utf-8');
        const parsed = JSON.parse(data);
        return typeof parsed === 'object' && parsed !== null ? parsed : {};
    } catch {
        return {};
    }
}

async function saveBroadcastStatus(groupName, status) {
    const filePath = statusPath(groupName);
    await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
    const tempPath = `${filePath}.tmp`;
    try {
        await fs.promises.writeFile(tempPath, JSON.stringify(status, null, 2), 'utf-8');
        await fs.promises.rename(tempPath, filePath);
    } catch (err) {
        console.error(`❌ Failed to write ${filePath}: ${err.message}`);
        try { await fs.promises.unlink(tempPath); } catch { }
    }
}

async function readBlogHtml(groupName, blogId) {
    const filePath = path.join(PATHS.BLOG_CONTENT, groupName, `${blogId}.html`);
    try {
        return await fs.promises.readFile(filePath, 'utf-8');
    } catch {
        return null;
    }
}

/**
 * Sends one Telegram call with rate-limit aware retries.
 * @returns {Promise<boolean>} True once the call succeeded.
 */
async function sendWithRetry(description, send) {
    for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
        let result;
        try {
            result = await send();
        } catch (err) {
            console.error(`❌ Exception sending ${description}: ${err.message}`);
            await sleep(5000);
            continue;
        }

        if (result?.success) return true;

        const retryAfter = result?.data?.parameters?.retry_after;
        if (retryAfter) {
            const sleepMs = Math.min(retryAfter * 1000, 60000);
            console.warn(`⏳ Rate limit hit on ${description}. Waiting ${sleepMs}ms...`);
            await sleep(sleepMs);
            continue;
        }

        console.error(`❌ Failed ${description} (attempt ${attempt}/${MAX_SEND_RETRIES}):`, result?.data);
        if (attempt < MAX_SEND_RETRIES) await sleep(5000);
    }
    return false;
}

/**
 * Delivers a built message to one chat: albums first (the first album's first
 * item carries the formatted caption), then any overflow text.
 */
async function deliver(bot, chatId, plan, label) {
    const { parseMode, mediaGroups, texts } = plan;

    for (const [index, group] of mediaGroups.entries()) {
        const ok = await sendWithRetry(`media group ${index + 1}/${mediaGroups.length} → ${label}`, () =>
            bot.sendMediaGroup(chatId, group)
        );
        if (!ok) return false;
        await sleep(MEDIA_THROTTLE_MS);
    }

    for (const [index, text] of texts.entries()) {
        const ok = await sendWithRetry(`text ${index + 1}/${texts.length} → ${label}`, () =>
            bot.sendMessage(chatId, text, { parse_mode: parseMode, disable_web_page_preview: true })
        );
        if (!ok) return false;
        await sleep(TEXT_THROTTLE_MS);
    }

    return true;
}

/**
 * A translation is only worth redoing when the settings that shape it differ,
 * so destinations sharing a signature share one translation pass.
 */
function translationSignature(settings, glossary) {
    return JSON.stringify([
        settings.enabled !== false,
        settings.provider || 'gemini',
        settings.target_language || '',
        settings.thinking_level || '',
        settings.translate_title !== false,
        settings.translate_body !== false,
        settings.translate_image_captions !== false,
        glossary || {}
    ]);
}

/**
 * Broadcasts a single blog post to every destination configured for it.
 *
 * @param {string} groupName
 * @param {object} blog - Crawler detail record ({ ID, Title, Name, DateTime, Url, ... }).
 * @param {string} [html] - Article HTML; read from blogContent/ when omitted.
 * @returns {Promise<{sent: number, skipped: number, failed: number}>}
 */
export async function broadcastBlog(groupName, blog, html = null) {
    const summary = { sent: 0, skipped: 0, failed: 0 };
    if (!ENABLE_BROADCAST) return summary;

    const destinations = resolveDestinations(groupName, blog);
    if (!destinations.length) return summary;

    const status = await loadBroadcastStatus(groupName);
    const pending = destinations.filter(d => !status[`${blog.ID}@${d.chatId}`]);
    summary.skipped = destinations.length - pending.length;
    if (!pending.length) return summary;

    const articleHtml = html ?? await readBlogHtml(groupName, blog.ID);
    if (!articleHtml) {
        console.warn(`⚠️ No stored HTML for ${groupName}/${blog.ID}. Skipping broadcast.`);
        return summary;
    }

    const blocks = classifyBlocks(parseBlogHtml(articleHtml, { baseUrl: GROUP_BASE_URLS[groupName] }));
    if (!blocks.length) {
        console.warn(`⚠️ ${groupName}/${blog.ID} parsed to zero blocks. Skipping broadcast.`);
        return summary;
    }

    const sourceUrl = resolveSourceUrl(groupName, blog);
    const translationCache = new Map();
    let statusDirty = false;

    for (const destination of pending) {
        const { translation, message, glossary, chatId, botToken, label } = destination;

        // --- Translate (once per distinct translation configuration) ---
        let translated = { title: null, blocks };
        if (translation.enabled !== false) {
            const signature = translationSignature(translation, glossary);
            if (!translationCache.has(signature)) {
                console.log(`🌐 Translating ${groupName}/${blog.ID} by ${blog.Name} for "${label}"...`);
                translationCache.set(signature, await translateBlogPost(
                    { title: blog.Title, blocks, member: blog.Name, group: groupName },
                    {
                        provider: translation.provider,
                        glossary,
                        targetLanguage: translation.target_language,
                        thinkingLevel: translation.thinking_level,
                        translateTitle: translation.translate_title !== false,
                        translateBody: translation.translate_body !== false,
                        translateImageCaptions: translation.translate_image_captions !== false
                    }
                ));
            }
            translated = translationCache.get(signature);
        }

        // --- Format & send ---
        const plan = buildBlogMessage({
            memberName: blog.Name,
            groupName,
            title: blog.Title,
            translatedTitle: translated.title,
            dateTime: blog.DateTime,
            sourceUrl,
            blocks: translated.blocks
        }, message);

        const bot = getBot(botToken);
        const ok = await deliver(bot, chatId, plan, `${label} (${chatId})`);

        if (ok) {
            status[`${blog.ID}@${chatId}`] = new Date().toISOString();
            statusDirty = true;
            summary.sent += 1;
            console.log(`✅ Broadcast ${groupName}/${blog.ID} → ${label} (${chatId}).`);
        } else {
            summary.failed += 1;
            console.error(`❌ Broadcast failed for ${groupName}/${blog.ID} → ${label} (${chatId}). It will be retried next cycle.`);
        }
    }

    if (statusDirty) await saveBroadcastStatus(groupName, status);
    return summary;
}

/** Sequential so a burst of new posts cannot trip Telegram's per-chat rate limit. */
export async function broadcastBlogs(groupName, blogs) {
    const total = { sent: 0, skipped: 0, failed: 0 };
    if (!ENABLE_BROADCAST || !blogs?.length) return total;
    if (!isGroupBroadcastEnabled(groupName)) return total;

    // Oldest first, so a channel reads in the order the posts were written.
    const ordered = [...blogs].sort((a, b) => new Date(a.DateTime) - new Date(b.DateTime));

    for (const blog of ordered) {
        const result = await broadcastBlog(groupName, blog);
        total.sent += result.sent;
        total.skipped += result.skipped;
        total.failed += result.failed;
    }

    if (total.sent || total.failed) {
        console.log(`📡 ${groupName}: broadcast ${total.sent} sent, ${total.failed} failed, ${total.skipped} already delivered.`);
    }
    return total;
}
