import fs from 'fs';
import path from 'path';
import { PATHS, DAILY_TRANSLATION_QUOTA } from '../config/constants.js';

/**
 * Runtime state owned by the admin panel, persisted to record/admin-state.json.
 *
 * config/config.json stays the hand-edited source of channel routing; this file
 * holds what the owner changes from Telegram — feature flags, the backfill
 * quota, and per-member overrides layered on top of config.json.
 *
 * {
 *   "version": 1,
 *   "flags": { "translationPaused": false, "broadcastPaused": false },
 *   "quota": { "dailyLimit": 50, "date": "2026-10-25", "used": 12 },
 *   "members": {
 *     "Hinatazaka46/金村美玖": { "autoTranslate": true, "archive": true, "chatIds": ["-100123"] }
 *   },
 *   "backfillFailures": { "Hinatazaka46/104023": 1 },
 *   "knownChats": {
 *     "-1001234567890": { "id": "-1001234567890", "title": "My channel", "type": "channel",
 *                         "status": "administrator", "canPost": true, "addedBy": 111, ... }
 *   }
 * }
 *
 * Reads are synchronous and served from memory; every change is written straight
 * back with an atomic temp-file rename.
 */

const STATE_PATH = PATHS.ADMIN_STATE;

const MEMBER_DEFAULTS = Object.freeze({ autoTranslate: true, archive: true, chatIds: null });

export function utcDateString(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function defaultState() {
    return {
        version: 1,
        flags: { translationPaused: false, broadcastPaused: false },
        quota: { dailyLimit: DAILY_TRANSLATION_QUOTA, date: utcDateString(), used: 0 },
        members: {},
        backfillFailures: {},
        knownChats: {}
    };
}

function loadState() {
    const base = defaultState();
    try {
        const raw = JSON.parse(fs.readFileSync(STATE_PATH, 'utf-8'));
        return {
            version: 1,
            flags: { ...base.flags, ...raw.flags },
            quota: { ...base.quota, ...raw.quota },
            members: raw.members && typeof raw.members === 'object' ? raw.members : {},
            backfillFailures: raw.backfillFailures && typeof raw.backfillFailures === 'object' ? raw.backfillFailures : {},
            knownChats: raw.knownChats && typeof raw.knownChats === 'object' ? raw.knownChats : {}
        };
    } catch (err) {
        if (err.code !== 'ENOENT') console.error(`[admin-state] Could not read ${STATE_PATH}, starting fresh: ${err.message}`);
        return base;
    }
}

let state = loadState();

function persist() {
    const tempPath = `${STATE_PATH}.tmp`;
    try {
        fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
        fs.writeFileSync(tempPath, JSON.stringify(state, null, 2), 'utf-8');
        fs.renameSync(tempPath, STATE_PATH);
    } catch (err) {
        console.error(`[admin-state] Failed to write ${STATE_PATH}: ${err.message}`);
    }
}

// --- Feature flags ---

export const isTranslationPaused = () => state.flags.translationPaused === true;
export const isBroadcastPaused = () => state.flags.broadcastPaused === true;

export function setTranslationPaused(paused) {
    state.flags.translationPaused = Boolean(paused);
    persist();
}

export function setBroadcastPaused(paused) {
    state.flags.broadcastPaused = Boolean(paused);
    persist();
}

// --- Daily backfill quota (resets at 00:00 UTC) ---

/**
 * Starts a new quota day if the UTC date has moved on. Called by the midnight
 * timer and lazily before every quota read, so a missed timer (sleep, restart)
 * can never carry yesterday's usage into today.
 * @returns {boolean} True if the counter was reset.
 */
export function rolloverQuota() {
    const today = utcDateString();
    if (state.quota.date === today) return false;
    state.quota.date = today;
    state.quota.used = 0;
    persist();
    return true;
}

export function getQuota() {
    rolloverQuota();
    const { dailyLimit, used, date } = state.quota;
    return { dailyLimit, used, date, remaining: Math.max(0, dailyLimit - used) };
}

/** Reserves one translation from today's quota. */
export function tryConsumeQuota() {
    rolloverQuota();
    if (state.quota.used >= state.quota.dailyLimit) return false;
    state.quota.used += 1;
    persist();
    return true;
}

export function setDailyLimit(limit) {
    state.quota.dailyLimit = Math.max(0, Math.min(10000, Math.round(Number(limit) || 0)));
    persist();
}

export function resetQuotaUsage() {
    state.quota.date = utcDateString();
    state.quota.used = 0;
    persist();
}

// --- Per-member overrides ---

export function memberKey(groupName, memberName) {
    return `${groupName}/${String(memberName || '').replace(/\s+/g, '')}`;
}

export function getMemberSettings(groupName, memberName) {
    const stored = state.members[memberKey(groupName, memberName)] || {};
    return { ...MEMBER_DEFAULTS, ...stored };
}

/**
 * Merges a patch into a member's overrides. `chatIds: null` removes the target
 * override so routing falls back to config.json. Entries that end up identical
 * to the defaults are deleted to keep the file readable.
 */
export function updateMemberSettings(groupName, memberName, patch) {
    const key = memberKey(groupName, memberName);
    const next = { ...state.members[key], ...patch };

    // No targets left means "let config.json decide", same as clearing them.
    if (!Array.isArray(next.chatIds) || !next.chatIds.length) delete next.chatIds;
    if (next.autoTranslate === MEMBER_DEFAULTS.autoTranslate) delete next.autoTranslate;
    if (next.archive === MEMBER_DEFAULTS.archive) delete next.archive;

    if (Object.keys(next).length) state.members[key] = next;
    else delete state.members[key];

    persist();
    return getMemberSettings(groupName, memberName);
}

/** Members of a group whose target chats were set from the admin panel. */
export function listMemberTargetOverrides(groupName) {
    const prefix = `${groupName}/`;
    return Object.entries(state.members)
        .filter(([key, value]) => key.startsWith(prefix) && Array.isArray(value.chatIds) && value.chatIds.length)
        .map(([key, value]) => ({ memberName: key.slice(prefix.length), chatIds: value.chatIds.map(String) }));
}

// --- Backfill failure tracking ---

export function getBackfillFailures(groupName, blogId) {
    return state.backfillFailures[`${groupName}/${blogId}`] || 0;
}

export function recordBackfillFailure(groupName, blogId) {
    const key = `${groupName}/${blogId}`;
    state.backfillFailures[key] = (state.backfillFailures[key] || 0) + 1;
    persist();
}

export function clearBackfillFailure(groupName, blogId) {
    const key = `${groupName}/${blogId}`;
    if (!(key in state.backfillFailures)) return;
    delete state.backfillFailures[key];
    persist();
}

// --- Chats the admin bot was added to ---
//
// Telegram has no "list my chats" call; a bot only learns about a group or
// channel from the my_chat_member update sent when it is added, promoted or
// removed. Those are recorded here so the owner can route members to a chat
// by tapping it instead of looking up its id.

const ACTIVE_STATUSES = new Set(['creator', 'administrator', 'member']);

function chatTitle(chat) {
    if (chat.title) return chat.title;
    if (chat.username) return `@${chat.username}`;
    return [chat.first_name, chat.last_name].filter(Boolean).join(' ') || String(chat.id);
}

function withActive(entry) {
    return entry ? { ...entry, active: ACTIVE_STATUSES.has(entry.status) && entry.canPost !== false } : null;
}

/** Records the bot's membership in a chat; returns the entry as it was before. */
export function recordKnownChat(chat, patch = {}) {
    const key = String(chat.id);
    const previous = state.knownChats[key] ? { ...state.knownChats[key] } : null;
    state.knownChats[key] = {
        ...previous,
        id: key,
        title: chatTitle(chat),
        username: chat.username || null,
        type: chat.type,
        ...patch,
        updatedAt: new Date().toISOString()
    };
    persist();
    return withActive(previous);
}

export function getKnownChat(chatId) {
    return withActive(state.knownChats[String(chatId)]);
}

export function listKnownChats() {
    return Object.values(state.knownChats).map(withActive);
}

export function forgetKnownChat(chatId) {
    const key = String(chatId);
    if (!(key in state.knownChats)) return false;
    delete state.knownChats[key];
    persist();
    return true;
}
