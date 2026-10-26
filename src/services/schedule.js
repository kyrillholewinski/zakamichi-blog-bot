import { POLLING_INTERVAL_MS } from '../config/constants.js';

/**
 * When the bot crawls and when it backfills, plus a record of what it last did.
 *
 * The windows are the single source of truth for both index.js (deciding what a
 * cycle does) and the admin panel (showing it), so the two cannot disagree.
 * Hours are JST, start inclusive, end exclusive.
 */

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

export const WINDOWS = {
    crawl: { label: 'Crawl', startHour: 8, endHour: 24 },
    bokuao: { label: 'Bokuao crawl', startHour: 10, endHour: 11 },
    backfill: { label: 'Backfill', startHour: 0, endHour: 8 }
};

export function jstHour(date = new Date()) {
    return (date.getUTCHours() + 9) % 24;
}

export function isWithin(window, date = new Date()) {
    const hour = jstHour(date);
    return hour >= window.startHour && hour < window.endHour;
}

/** The next moment the window opens (if closed) or closes (if open). */
export function nextBoundary(window, date = new Date()) {
    const targetHour = isWithin(window, date) ? window.endHour % 24 : window.startHour;
    const jst = new Date(date.getTime() + JST_OFFSET_MS);
    let next = Date.UTC(jst.getUTCFullYear(), jst.getUTCMonth(), jst.getUTCDate(), targetHour) - JST_OFFSET_MS;
    if (next <= date.getTime()) next += DAY_MS;
    return new Date(next);
}

/** "08:00–24:00" */
export function formatWindow(window) {
    const pad = (h) => `${String(h).padStart(2, '0')}:00`;
    return `${pad(window.startHour)}–${pad(window.endHour)}`;
}

// --- Activity (in memory: resets on restart) ---

const activity = {
    startedAt: null,
    intervalMs: POLLING_INTERVAL_MS,
    cycle: null,          // { mode, startedAt, finishedAt, running, error }
    skipped: { count: 0, lastAt: null },
    crawls: {},           // group → { startedAt, finishedAt, newPosts }
    backfill: null        // { startedAt, finishedAt, translated, failed, stopReason }
};

export function markSchedulerStarted(date = new Date()) {
    activity.startedAt = date;
}

/** When setInterval will next fire, counted from the scheduler's start. */
export function nextCycleAt(now = new Date()) {
    if (!activity.startedAt) return null;
    const start = activity.startedAt.getTime();
    const elapsed = Math.max(0, now.getTime() - start);
    return new Date(start + (Math.floor(elapsed / activity.intervalMs) + 1) * activity.intervalMs);
}

export function recordCycleStart(mode) {
    activity.cycle = { mode, startedAt: new Date(), finishedAt: null, running: true, error: null };
}

export function recordCycleEnd(error = null) {
    if (!activity.cycle) return;
    activity.cycle.running = false;
    activity.cycle.finishedAt = new Date();
    activity.cycle.error = error ? String(error.message || error) : null;
}

export function recordCycleSkipped() {
    activity.skipped.count += 1;
    activity.skipped.lastAt = new Date();
}

export function recordCrawl(groupName, { startedAt, newPosts }) {
    activity.crawls[groupName] = { startedAt, finishedAt: new Date(), newPosts };
}

export function recordBackfill(startedAt, result) {
    activity.backfill = { startedAt, finishedAt: new Date(), ...result };
}

export function getActivity() {
    return activity;
}
