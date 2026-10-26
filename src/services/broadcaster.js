import fs from 'fs';
import path from 'path';
import {
    PATHS,
    ENABLE_BROADCAST,
    BROADCAST_MAX_AGE_HOURS,
    GROUP_BASE_URLS,
    BLOG_URL_TEMPLATES
} from '../config/constants.js';
import { resolveDestinations } from '../config/channels.js';
import { parseBlogHtml, classifyBlocks } from './blog-content.js';
import { translateBlogPost } from './translate.js';
import { loadArchivedTranslation, blocksFromArchive } from './archive-translation.js';
import { buildBlogMessage } from './message-builder.js';
import { getBot } from './telegram.js';
import { isBroadcastPaused, canAutoTranslate, isTranslationBlocked } from './admin-state.js';
import { enqueueBroadcast, listQueue, removeFromQueue, recordQueueAttempt } from './broadcast-queue.js';
import { sleep } from '../utils/misc.js';

/**
 * Broadcasts crawled blog posts to the Telegram channels configured in
 * config/config.json and the admin panel.
 *
 * New posts enter the persistent broadcast queue before the crawler records
 * them, and leave it once every destination has them. Delivery is recorded per
 * group in record/<group>/BroadcastStatus.JSON keyed by blog id + destination,
 * so a restart mid-cycle re-sends nothing already delivered, and adding a
 * channel later only sends future posts to it.
 */

const MAX_SEND_RETRIES = 3;
const MEDIA_THROTTLE_MS = 2000;
const TEXT_THROTTLE_MS = 500;
// After this many cycles with a failed destination, a queued post is dropped.
const MAX_QUEUE_ATTEMPTS = 5;

// BroadcastStatus.JSON is read-modify-written per post, and crawlers for several
// groups, the queue drain and the admin panel can all send at once. Running
// sends one at a time keeps those writes from overwriting each other, and suits
// Telegram's rate limits anyway.
let sendChain = Promise.resolve();
function serialized(task) {
    const run = sendChain.then(task, task);
    sendChain = run.catch(() => { });
    return run;
}

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

export async function readBlogHtml(groupName, blogId) {
    const filePath = path.join(PATHS.BLOG_CONTENT, groupName, `${blogId}.html`);
    try {
        return await fs.promises.readFile(filePath, 'utf-8');
    } catch {
        return null;
    }
}

/**
 * Sends one Telegram call with rate-limit aware retries.
 *
 * A 4xx other than 429 (bad chat id, bot not in the chat, a photo Telegram
 * cannot fetch) fails the same way every time, so it is not retried.
 *
 * @returns {Promise<{ok: boolean, status: number|null}>}
 */
async function sendWithRetry(description, send) {
    let status = null;
    for (let attempt = 1; attempt <= MAX_SEND_RETRIES; attempt++) {
        let result;
        try {
            result = await send();
        } catch (err) {
            console.error(`❌ Exception sending ${description}: ${err.message}`);
            await sleep(5000);
            continue;
        }

        if (result?.success) return { ok: true, status: result.status };
        status = result?.status ?? null;

        const retryAfter = result?.data?.parameters?.retry_after;
        if (retryAfter) {
            const sleepMs = Math.min(retryAfter * 1000, 60000);
            console.warn(`⏳ Rate limit hit on ${description}. Waiting ${sleepMs}ms...`);
            await sleep(sleepMs);
            continue;
        }

        console.error(`❌ Failed ${description} (attempt ${attempt}/${MAX_SEND_RETRIES}):`, result?.data);
        if (status >= 400 && status < 500) break;
        if (attempt < MAX_SEND_RETRIES) await sleep(5000);
    }
    return { ok: false, status };
}

function sendMediaItem(bot, chatId, item) {
    const options = item.caption ? { caption: item.caption, parse_mode: item.parse_mode } : {};
    return item.type === 'video'
        ? bot.sendVideo(chatId, item.media, options)
        : bot.sendPhoto(chatId, item.media, options);
}

/**
 * Sends one album.
 *
 * sendMediaGroup only accepts 2–10 items, so a lone photo (a one-photo post, or
 * the 11th photo of a long one) goes out with sendPhoto/sendVideo. And Telegram
 * rejects a whole album when it cannot fetch a single item (too large, gone,
 * unsupported), so after a 400 the items are sent one by one and the ones it
 * refuses are skipped. If no item carried the caption, it is sent as text so the
 * post is still announced. A 400 will not go away on retry, so once this
 * fallback has run the album counts as delivered rather than failing the post
 * (which would resend the albums before it).
 */
async function deliverAlbum(bot, chatId, group, description, parseMode) {
    let fallbackItems;
    if (group.length === 1) {
        const single = await sendWithRetry(description, () => sendMediaItem(bot, chatId, group[0]));
        if (single.ok || single.status !== 400) return single.ok;
        fallbackItems = [];   // The only item was just refused.
    } else {
        const album = await sendWithRetry(description, () => bot.sendMediaGroup(chatId, group));
        if (album.ok || album.status !== 400) return album.ok;
        fallbackItems = group;
    }
    console.warn(`⚠️ Telegram rejected ${description}; sending what it will accept.`);

    const caption = group[0].caption;
    let captionSent = !caption;
    let delivered = 0;
    for (const [i, item] of fallbackItems.entries()) {
        const result = await sendWithRetry(`${description} item ${i + 1}/${fallbackItems.length}`, () =>
            sendMediaItem(bot, chatId, { ...item, caption: captionSent ? undefined : caption })
        );
        if (result.ok) {
            delivered += 1;
            captionSent = true;
        }
        await sleep(TEXT_THROTTLE_MS);
    }
    console.warn(`⚠️ ${description}: ${delivered}/${group.length} item(s) delivered individually.`);

    if (!captionSent) {
        const text = await sendWithRetry(`${description} caption`, () =>
            bot.sendMessage(chatId, caption, { parse_mode: parseMode, disable_web_page_preview: true })
        );
        return text.ok;
    }
    return true;
}

/**
 * Delivers a built message to one chat: albums first (the first album's first
 * item carries the formatted caption), then any overflow text.
 */
async function deliver(bot, chatId, plan, label) {
    const { parseMode, mediaGroups, texts } = plan;

    for (const [index, group] of mediaGroups.entries()) {
        const ok = await deliverAlbum(bot, chatId, group, `media group ${index + 1}/${mediaGroups.length} → ${label}`, parseMode);
        if (!ok) return false;
        await sleep(MEDIA_THROTTLE_MS);
    }

    for (const [index, text] of texts.entries()) {
        const { ok } = await sendWithRetry(`text ${index + 1}/${texts.length} → ${label}`, () =>
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
        settings.target_language || '',
        settings.thinking_level || '',
        settings.translate_title !== false,
        settings.translate_body !== false,
        settings.translate_image_captions !== false,
        glossary || {}
    ]);
}

async function broadcastBlogNow(groupName, blog, html, options) {
    const summary = { sent: 0, skipped: 0, failed: 0 };
    const { destinations: explicitDestinations, force = false, forceTranslate = false } = options;

    const destinations = explicitDestinations ?? resolveDestinations(groupName, blog);
    if (!destinations.length) return summary;

    // Forced (manual) sends neither consult nor update the delivery record.
    const status = force ? {} : await loadBroadcastStatus(groupName);
    const pending = destinations.filter(d => !status[`${blog.ID}@${d.chatId}`]);
    summary.skipped = destinations.length - pending.length;
    if (!pending.length) return summary;

    const articleHtml = html ?? blog.content ?? await readBlogHtml(groupName, blog.ID);
    if (!articleHtml) {
        console.warn(`⚠️ No HTML available for ${groupName}/${blog.ID}. Skipping broadcast.`);
        summary.failed = pending.length;
        return summary;
    }

    const blocks = classifyBlocks(parseBlogHtml(articleHtml, { baseUrl: GROUP_BASE_URLS[groupName] }));
    if (!blocks.length) {
        console.warn(`⚠️ ${groupName}/${blog.ID} parsed to zero blocks. Skipping broadcast.`);
        return summary;
    }

    const sourceUrl = resolveSourceUrl(groupName, blog);
    const baseUrl = GROUP_BASE_URLS[groupName];
    // A block wins over everything, manual sends included.
    const blocked = isTranslationBlocked(groupName, blog.Name);
    const autoTranslate = canAutoTranslate(groupName, blog.Name);
    const hasMedia = blocks.some(b => b.type === 'image' || b.type === 'video');
    const translationCache = new Map();
    let archived;   // Loaded on first use; null once known to be missing.
    let statusDirty = false;

    for (const destination of pending) {
        const { translation, glossary, chatId, botToken, label } = destination;
        const mode = destination.mode || 'translated';

        // A photos-only chat has nothing to receive from a text-only post.
        if (mode === 'photos' && !hasMedia) {
            summary.skipped += 1;
            console.log(`⏭ ${groupName}/${blog.ID} has no photos; skipped for photos-only "${label}" (${chatId}).`);
            continue;
        }

        // Photos-only: the album with a header/footer caption, no body text.
        const message = mode === 'photos'
            ? { ...destination.message, include_body: false, send_media: true, show_image_markers: false }
            : destination.message;

        // --- Translate (once per distinct translation configuration) ---
        // Only a "translated" chat is translated; Japanese and photos-only chats never cost an AI request.
        let translated = { title: null, blocks };
        const shouldTranslate = mode === 'translated' && !blocked
            && (forceTranslate || (autoTranslate && translation.enabled !== false));
        if (shouldTranslate) {
            const signature = translationSignature(translation, glossary);
            if (!translationCache.has(signature)) {
                // Prefer the translated archive; only fall back to a new AI request without one.
                if (archived === undefined) archived = await loadArchivedTranslation(groupName, blog.ID);
                const fromArchive = blocksFromArchive(blocks, archived, translation, baseUrl);
                if (fromArchive) {
                    console.log(`🗂 Using archived translation of ${groupName}/${blog.ID} for "${label}".`);
                    translationCache.set(signature, fromArchive);
                }
            }
            if (!translationCache.has(signature)) {
                if (archived) console.warn(`⚠️ Archived translation of ${groupName}/${blog.ID} does not fit "${label}". Translating afresh.`);
                console.log(`🌐 Translating ${groupName}/${blog.ID} by ${blog.Name} for "${label}"...`);
                translationCache.set(signature, await translateBlogPost(
                    { title: blog.Title, blocks, member: blog.Name, group: groupName },
                    {
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
            if (!force) {
                status[`${blog.ID}@${chatId}`] = new Date().toISOString();
                statusDirty = true;
            }
            summary.sent += 1;
            console.log(`✅ Broadcast ${groupName}/${blog.ID} → ${label} (${chatId}).`);
        } else {
            summary.failed += 1;
            console.error(`❌ Broadcast failed for ${groupName}/${blog.ID} → ${label} (${chatId}).`);
        }
    }

    if (statusDirty) await saveBroadcastStatus(groupName, status);
    return summary;
}

/**
 * Broadcasts a single blog post.
 *
 * @param {string} groupName
 * @param {object} blog - Crawler detail record ({ ID, Title, Name, DateTime, Url, content? }).
 * @param {string} [html] - Article HTML; falls back to blog.content, then blogContent/.
 * @param {object} [options]
 * @param {Array<object>} [options.destinations] - Send here instead of the configured routes.
 * @param {boolean} [options.force] - Ignore and don't update the delivery record (manual sends).
 * @param {boolean} [options.forceTranslate] - Translate even if paused or switched off for the member
 *                                            (never when the group or member is blocked, and only
 *                                            for chats in "translated" mode).
 * @returns {Promise<{sent: number, skipped: number, failed: number}>}
 */
export function broadcastBlog(groupName, blog, html = null, options = {}) {
    if (!ENABLE_BROADCAST && !options.destinations) {
        return Promise.resolve({ sent: 0, skipped: 0, failed: 0 });
    }
    return serialized(() => broadcastBlogNow(groupName, blog, html, options));
}

function isTooOldToBroadcast(blog) {
    const time = new Date(blog.DateTime).getTime();
    if (Number.isNaN(time)) return false;
    return Date.now() - time > BROADCAST_MAX_AGE_HOURS * 60 * 60 * 1000;
}

/**
 * Puts a crawl's new posts in the persistent broadcast queue. The crawler calls
 * this BEFORE it saves BlogStatus.JSON: once a post is recorded there it is never
 * "new" again, so a restart between the two would otherwise lose it for good.
 *
 * Posts older than BROADCAST_MAX_AGE_HOURS are not queued, and nothing is queued
 * on a group's first crawl (`bootstrap`): with an empty or unreadable
 * BlogStatus.JSON every historical post looks new, and broadcasting them would
 * flood every channel with the whole archive.
 *
 * @returns {{queued: number, tooOld: number, unrouted: number}}
 */
export function queueNewPosts(groupName, blogs, { bootstrap = false } = {}) {
    const result = { queued: 0, tooOld: 0, unrouted: 0 };
    if (!ENABLE_BROADCAST || !blogs?.length) return result;

    if (bootstrap) {
        console.log(`📭 ${groupName}: first crawl recorded ${blogs.length} post(s); none are broadcast, so the archive does not flood the channels.`);
        return result;
    }

    // Oldest first, so a channel reads in the order they were written.
    const ordered = [...blogs].sort((a, b) => new Date(a.DateTime) - new Date(b.DateTime));
    for (const blog of ordered) {
        if (isTooOldToBroadcast(blog)) { result.tooOld += 1; continue; }
        if (!resolveDestinations(groupName, blog).length) { result.unrouted += 1; continue; }
        enqueueBroadcast(groupName, blog);
        result.queued += 1;
    }

    if (result.tooOld) {
        console.log(`📭 ${groupName}: ${result.tooOld} new post(s) older than ${BROADCAST_MAX_AGE_HOURS}h not broadcast.`);
    }
    return result;
}

async function drainOnce() {
    let sent = 0;
    for (const entry of listQueue()) {
        if (isBroadcastPaused()) break;

        const result = await broadcastBlog(entry.group, entry.blog, entry.html);
        sent += result.sent;

        if (!result.failed) {
            removeFromQueue(entry.group, entry.blog.ID);
            continue;
        }

        const attempts = recordQueueAttempt(entry.group, entry.blog.ID);
        if (attempts >= MAX_QUEUE_ATTEMPTS) {
            console.error(`❌ Giving up on ${entry.group}/${entry.blog.ID} after ${attempts} attempts.`);
            removeFromQueue(entry.group, entry.blog.ID);
        }
    }
    return sent;
}

let drainPromise = null;
let drainAgain = false;

/**
 * Sends everything in the queue. Already-delivered destinations are skipped
 * through BroadcastStatus.JSON, so only the chats that missed a post receive it.
 *
 * Crawlers for several groups finish at about the same time; a call made while
 * a drain is running joins it and makes it go round once more, so the later
 * group's posts go out now rather than a cycle later.
 */
export function drainBroadcastQueue() {
    if (!ENABLE_BROADCAST) return Promise.resolve({ sent: 0, remaining: listQueue().length });
    if (drainPromise) {
        drainAgain = true;
        return drainPromise;
    }

    drainPromise = (async () => {
        let sent = 0;
        do {
            drainAgain = false;
            sent += await drainOnce();
        } while (drainAgain && !isBroadcastPaused());

        const remaining = listQueue().length;
        if (sent || remaining) console.log(`📬 Broadcast queue: ${sent} delivered, ${remaining} still waiting.`);
        return { sent, remaining };
    })().finally(() => { drainPromise = null; });

    return drainPromise;
}
