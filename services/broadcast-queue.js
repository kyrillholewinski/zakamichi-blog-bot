import fs from 'fs';
import path from 'path';
import { PATHS } from '../config/constants.js';

/**
 * Posts waiting to be broadcast, persisted to record/broadcast-queue.json.
 *
 * A post lands here when broadcasting is paused, or when at least one of its
 * destinations failed. Each entry carries the article HTML because a member with
 * archiving switched off has no copy in blogContent/ to fall back on.
 *
 * [{ "group": "Bokuao", "blog": { "ID": "17618", ... }, "html": "<p>…</p>",
 *    "attempts": 0, "queuedAt": "2026-10-25T03:00:00.000Z" }]
 */

const QUEUE_PATH = PATHS.BROADCAST_QUEUE;

function loadQueue() {
    try {
        const parsed = JSON.parse(fs.readFileSync(QUEUE_PATH, 'utf-8'));
        return Array.isArray(parsed) ? parsed : [];
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(`[queue] Could not read ${QUEUE_PATH}, starting empty: ${err.message}`);
        return [];
    }
}

let queue = loadQueue();

function persist() {
    const tempPath = `${QUEUE_PATH}.tmp`;
    try {
        fs.mkdirSync(path.dirname(QUEUE_PATH), { recursive: true });
        fs.writeFileSync(tempPath, JSON.stringify(queue, null, 2), 'utf-8');
        fs.renameSync(tempPath, QUEUE_PATH);
    } catch (err) {
        console.error(`[queue] Failed to write ${QUEUE_PATH}: ${err.message}`);
    }
}

const sameEntry = (entry, groupName, blogId) => entry.group === groupName && String(entry.blog.ID) === String(blogId);

/** Adds a post to the queue; a post already queued keeps its place and attempt count. */
export function enqueueBroadcast(groupName, blog, html = null) {
    if (queue.some(entry => sameEntry(entry, groupName, blog.ID))) return;
    const { content, ...manifest } = blog;
    queue.push({
        group: groupName,
        blog: manifest,
        html: html ?? content ?? null,
        attempts: 0,
        queuedAt: new Date().toISOString()
    });
    persist();
}

export function getQueueSize() {
    return queue.length;
}

/** Snapshot in queue order (oldest queued first). */
export function listQueue() {
    return queue.map(entry => ({ ...entry }));
}

export function removeFromQueue(groupName, blogId) {
    const before = queue.length;
    queue = queue.filter(entry => !sameEntry(entry, groupName, blogId));
    if (queue.length !== before) persist();
}

/** Increments an entry's attempt count and returns the new value. */
export function recordQueueAttempt(groupName, blogId) {
    const entry = queue.find(e => sameEntry(e, groupName, blogId));
    if (!entry) return 0;
    entry.attempts += 1;
    entry.lastAttemptAt = new Date().toISOString();
    persist();
    return entry.attempts;
}
