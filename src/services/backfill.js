import fs from 'fs';
import path from 'path';
import { PATHS, GROUPS } from '../config/constants.js';
import { loadBlogStatus } from '../utils/file-system.js';
import { translateAndArchive } from './archive-translation.js';
import {
    isTranslationPaused,
    getMemberSettings,
    isTranslationBlocked,
    tryConsumeQuota,
    getQuota,
    getBackfillFailures,
    recordBackfillFailure,
    clearBackfillFailure
} from './admin-state.js';

/**
 * Translates archived blog HTML (blogContent/) into blogContent_TC/ under a
 * daily quota, most recent posts first. New posts are normally translated as
 * they are archived; the backfill covers older posts and retries failures.
 */

export const GROUP_LIST = Object.values(GROUPS);

// A post that failed this many times is skipped so it cannot eat the quota every day.
export const MAX_BACKFILL_FAILURES = 3;
const INDEX_TTL_MS = 30 * 1000;

async function listHtmlIds(dir) {
    try {
        const entries = await fs.promises.readdir(dir);
        return new Set(entries.filter(f => f.endsWith('.html')).map(f => f.slice(0, -5)));
    } catch {
        return new Set();
    }
}

let indexCache = null;
let indexBuiltAt = 0;

/**
 * Every known post across all groups: recorded in BlogStatus.JSON and/or saved
 * as HTML. Cached briefly because each admin panel view reads it.
 *
 * @returns {Promise<Array<{group, id, name, title, dateTime, time, url, hasSource, translated}>>}
 *          Newest first; posts with no known date sort last.
 */
export async function getBlogIndex({ maxAgeMs = INDEX_TTL_MS } = {}) {
    if (indexCache && Date.now() - indexBuiltAt < maxAgeMs) return indexCache;

    const index = [];
    for (const group of GROUP_LIST) {
        const [records, sourceIds, translatedIds] = await Promise.all([
            loadBlogStatus(group),
            listHtmlIds(path.join(PATHS.BLOG_CONTENT, group)),
            listHtmlIds(path.join(PATHS.BLOG_CONTENT_TC, group))
        ]);

        const ids = new Set([...Object.keys(records), ...sourceIds]);
        for (const id of ids) {
            const record = records[id];
            const time = record?.DateTime ? new Date(record.DateTime).getTime() : NaN;
            index.push({
                group,
                id,
                name: (record?.Name || 'Unknown').replace(/\s+/g, ''),
                title: record?.Title || '',
                dateTime: record?.DateTime || null,
                time: Number.isNaN(time) ? -Infinity : time,
                url: record?.Url || null,
                hasSource: sourceIds.has(id),
                translated: translatedIds.has(id)
            });
        }
    }

    index.sort((a, b) => b.time - a.time);
    indexCache = index;
    indexBuiltAt = Date.now();
    return index;
}

export function invalidateBlogIndex() {
    indexCache = null;
}

export async function findBlog(groupName, blogId) {
    const index = await getBlogIndex();
    return index.find(e => e.group === groupName && e.id === String(blogId)) || null;
}

/** Whether a member's archived posts take part in the backfill at all. */
function memberInBackfill(entry) {
    const settings = getMemberSettings(entry.group, entry.name);
    return settings.archive && settings.autoTranslate && !isTranslationBlocked(entry.group, entry.name);
}

/** Untranslated posts the backfill will pick up, newest first (LIFO). */
export async function getBackfillQueue() {
    const index = await getBlogIndex();
    return index.filter(e =>
        e.hasSource &&
        !e.translated &&
        memberInBackfill(e) &&
        getBackfillFailures(e.group, e.id) < MAX_BACKFILL_FAILURES
    );
}

/**
 * Translates as many backlog posts as today's quota allows.
 *
 * Every attempt costs one unit of quota, including failures, since the API call
 * was made either way. A post that keeps failing is skipped after
 * MAX_BACKFILL_FAILURES attempts.
 *
 * @param {object} [options]
 * @param {() => boolean} [options.shouldStop] - Checked between posts (e.g. the polling window opened).
 * @returns {Promise<{translated: number, failed: number, stopReason: string}>}
 */
export async function runBackfill({ shouldStop = () => false } = {}) {
    const result = { translated: 0, failed: 0, stopReason: 'done' };

    if (isTranslationPaused()) {
        console.log('⏸ Translation paused from the admin panel. Skipping backfill.');
        return { ...result, stopReason: 'paused' };
    }

    const backlog = await getBackfillQueue();
    if (!backlog.length) {
        console.log('No untranslated HTML files found.');
        return result;
    }

    const quota = getQuota();
    console.log(`🗂 Backfill: ${backlog.length} post(s) pending, quota ${quota.used}/${quota.dailyLimit} used today (UTC).`);

    for (const entry of backlog) {
        if (shouldStop()) { result.stopReason = 'window'; break; }
        if (isTranslationPaused()) { result.stopReason = 'paused'; break; }
        // Re-check per post: a toggle may have flipped while we were translating.
        if (!memberInBackfill(entry)) continue;
        if (!tryConsumeQuota()) { result.stopReason = 'quota'; break; }

        const sourcePath = path.join(PATHS.BLOG_CONTENT, entry.group, `${entry.id}.html`);

        let html;
        try {
            html = await fs.promises.readFile(sourcePath, 'utf-8');
        } catch {
            console.log(`Source not found. Skipping ${entry.group}/${entry.id}.html.`);
            continue;
        }

        const archived = await translateAndArchive({
            group: entry.group,
            id: entry.id,
            name: entry.name,
            title: entry.title,
            html
        }, 'backfill');

        if (!archived) {
            recordBackfillFailure(entry.group, entry.id);
            result.failed += 1;
            console.error(`Translation failed blog Id ${entry.id} for ${entry.group} by ${entry.name} at ${entry.dateTime}`);
            continue;
        }

        clearBackfillFailure(entry.group, entry.id);
        entry.translated = true;   // Keep the cached index in step without a rescan.
        result.translated += 1;
        console.log(`Translated blog Id ${entry.id} for ${entry.group} by ${entry.name} at ${entry.dateTime}`);
    }

    if (result.stopReason === 'quota') {
        const { used, dailyLimit } = getQuota();
        console.log(`🧮 Daily translation quota reached (${used}/${dailyLimit}). Resuming after 00:00 UTC.`);
    }
    console.log(`Backfill finished (${result.stopReason}): ${result.translated} translated, ${result.failed} failed. Output in ${PATHS.BLOG_CONTENT_TC}.`);
    return result;
}

/**
 * Translated/pending counts for the status view.
 * "Translated" means a blogContent_TC copy exists; "pending" means saved HTML
 * without one, whether or not the backfill is allowed to pick it up.
 */
export async function getTranslationStats() {
    const index = await getBlogIndex();
    const groups = new Map(GROUP_LIST.map(g => [g, { translated: 0, pending: 0 }]));
    const members = new Map();
    let translated = 0;
    let pending = 0;

    for (const entry of index) {
        if (!entry.hasSource && !entry.translated) continue;
        const groupStats = groups.get(entry.group);
        const memberKey = `${entry.group}/${entry.name}`;
        if (!members.has(memberKey)) members.set(memberKey, { group: entry.group, name: entry.name, translated: 0, pending: 0 });
        const memberStats = members.get(memberKey);

        if (entry.translated) {
            translated += 1; groupStats.translated += 1; memberStats.translated += 1;
        } else {
            pending += 1; groupStats.pending += 1; memberStats.pending += 1;
        }
    }

    return {
        translated,
        pending,
        groups: [...groups].map(([group, stats]) => ({ group, ...stats })),
        members: [...members.values()].sort((a, b) => b.pending - a.pending)
    };
}
