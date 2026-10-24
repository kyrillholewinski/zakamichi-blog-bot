import fs from 'fs';
import path from 'path';
import { CONFIG_FILE_NAME } from './constants.js';

/**
 * Broadcast configuration loader.
 *
 * The whole point of config/config.json is that channels can be added, retargeted
 * or switched off without touching code, so the file is re-read whenever its mtime
 * changes. A malformed edit keeps the last good config in memory rather than
 * taking the bot down mid-cycle.
 */

const BUILT_IN_DEFAULTS = {
    enabled: true,
    translation: {
        enabled: true,
        provider: 'gemini',
        thinking_level: 'middle',
        target_language: 'Traditional Chinese (Taiwan)',
        translate_title: true,
        translate_body: true,
        translate_image_captions: true
    },
    message: {
        parse_mode: 'HTML',
        show_original: false,
        show_footer: true,
        show_image_markers: true,
        attribution: '',
        max_media_per_group: 10,
        send_media: true
    }
};

let cache = null;
let cacheMtimeMs = 0;
let warnedMissing = false;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Shallow per-section merge: later sources win, `undefined` never overwrites. */
function mergeSection(...sources) {
    const out = {};
    for (const source of sources) {
        if (!isObject(source)) continue;
        for (const [key, value] of Object.entries(source)) {
            if (value !== undefined) out[key] = value;
        }
    }
    return out;
}

function toArray(value) {
    if (value == null) return [];
    return Array.isArray(value) ? value : [value];
}

/** Normalizes one raw group entry so downstream code never re-checks shapes. */
function normalizeGroup(rawGroup, defaults) {
    return {
        name: rawGroup.name,
        displayName: rawGroup.display_name || rawGroup.name,
        enabled: rawGroup.enabled !== false,
        botToken: rawGroup.telegram_bot_token || '',
        chatIds: toArray(rawGroup.telegram_chat_id).map(String),
        glossary: isObject(rawGroup.translate_glossary) ? rawGroup.translate_glossary : {},
        translation: mergeSection(defaults.translation, rawGroup.translation),
        message: mergeSection(defaults.message, rawGroup.message),
        members: toArray(rawGroup.members).map(m => ({
            name: (m.name || '').replace(/\s+/g, ''),
            enabled: m.enabled !== false,
            botToken: m.telegram_bot_token || '',
            chatIds: toArray(m.telegram_chat_id).map(String),
            translation: mergeSection(defaults.translation, rawGroup.translation, m.translation),
            message: mergeSection(defaults.message, rawGroup.message, m.message)
        })),
        categories: toArray(rawGroup.categories).map(c => ({
            name: c.name || 'category',
            enabled: c.enabled !== false,
            match: isObject(c.match) ? c.match : {},
            botToken: c.telegram_bot_token || '',
            chatIds: toArray(c.telegram_chat_id).map(String),
            translation: mergeSection(defaults.translation, rawGroup.translation, c.translation),
            message: mergeSection(defaults.message, rawGroup.message, c.message)
        }))
    };
}

function normalizeConfig(raw) {
    const defaults = {
        enabled: raw.defaults?.enabled !== false,
        translation: mergeSection(BUILT_IN_DEFAULTS.translation, raw.defaults?.translation),
        message: mergeSection(BUILT_IN_DEFAULTS.message, raw.defaults?.message)
    };

    const groups = new Map();
    for (const rawGroup of toArray(raw.groups)) {
        if (!rawGroup?.name) {
            console.warn('[config] Skipping a group entry with no "name".');
            continue;
        }
        groups.set(rawGroup.name, normalizeGroup(rawGroup, defaults));
    }

    return { enabled: defaults.enabled, defaults, groups };
}

const emptyConfig = () => ({ enabled: false, defaults: BUILT_IN_DEFAULTS, groups: new Map() });

/**
 * Returns the current config, reloading it if config/config.json changed on disk.
 */
export function loadChannelConfig() {
    const filePath = path.resolve(CONFIG_FILE_NAME);

    let stat;
    try {
        stat = fs.statSync(filePath);
    } catch {
        if (!warnedMissing) {
            console.warn(`[config] ${CONFIG_FILE_NAME} not found. Broadcasting is disabled. Copy config/config.example.json to get started.`);
            warnedMissing = true;
        }
        cache = emptyConfig();
        cacheMtimeMs = 0;
        return cache;
    }

    if (cache && stat.mtimeMs === cacheMtimeMs) return cache;

    try {
        const parsed = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        cache = normalizeConfig(parsed);
        cacheMtimeMs = stat.mtimeMs;
        warnedMissing = false;
        const groupNames = [...cache.groups.keys()].join(', ') || 'none';
        console.log(`[config] Loaded ${CONFIG_FILE_NAME} (groups: ${groupNames}).`);
    } catch (err) {
        // Keep serving the last good config; a typo mid-edit must not stop the bot.
        console.error(`[config] Failed to parse ${CONFIG_FILE_NAME}: ${err.message}`);
        if (!cache) cache = emptyConfig();
    }

    return cache;
}

export function getGroupConfig(groupName) {
    return loadChannelConfig().groups.get(groupName) || null;
}

/** True when at least one route for this group could ever fire. */
export function isGroupBroadcastEnabled(groupName) {
    const config = loadChannelConfig();
    if (!config.enabled) return false;
    const group = config.groups.get(groupName);
    if (!group || !group.enabled) return false;
    return (
        group.chatIds.length > 0 ||
        group.members.some(m => m.enabled && m.chatIds.length > 0) ||
        group.categories.some(c => c.enabled && c.chatIds.length > 0)
    );
}

function safeRegexTest(pattern, value) {
    try {
        return new RegExp(pattern, 'u').test(value);
    } catch (err) {
        console.warn(`[config] Invalid title_matches pattern "${pattern}": ${err.message}`);
        return false;
    }
}

function matchesCategory(category, blog) {
    const { match } = category;
    const title = blog.Title || '';
    const name = (blog.Name || '').replace(/\s+/g, '');

    const titleContains = toArray(match.title_contains);
    if (titleContains.length && !titleContains.some(k => title.includes(k))) return false;

    const memberIn = toArray(match.member_in).map(m => m.replace(/\s+/g, ''));
    if (memberIn.length && !memberIn.includes(name)) return false;

    const titleMatches = toArray(match.title_matches);
    if (titleMatches.length && !titleMatches.some(p => safeRegexTest(p, title))) return false;

    // A criteria-less category would silently swallow every post, so require at least one.
    return titleContains.length > 0 || memberIn.length > 0 || titleMatches.length > 0;
}

/**
 * Resolves every destination a blog post should be broadcast to.
 *
 * Per-member, per-category and group-wide routes are unioned, then de-duplicated
 * on bot token + chat id so a member who also matches a category is not messaged
 * twice. Earlier routes win, so a member override beats the group default.
 *
 * @returns {Array<{chatId: string, botToken: string, label: string, translation: object, message: object, glossary: object}>}
 */
export function resolveDestinations(groupName, blog) {
    const config = loadChannelConfig();
    if (!config.enabled) return [];

    const group = config.groups.get(groupName);
    if (!group || !group.enabled) return [];

    const memberName = (blog.Name || '').replace(/\s+/g, '');
    const routes = [];

    const member = group.members.find(m => m.name && m.name === memberName);
    if (member) {
        if (!member.enabled) return [];   // An explicitly disabled member is muted everywhere.
        if (member.chatIds.length) {
            routes.push({
                label: `${groupName}/${member.name}`,
                botToken: member.botToken || group.botToken,
                chatIds: member.chatIds,
                translation: member.translation,
                message: member.message
            });
        }
    }

    for (const category of group.categories) {
        if (!category.enabled || !category.chatIds.length) continue;
        if (!matchesCategory(category, blog)) continue;
        routes.push({
            label: `${groupName}/${category.name}`,
            botToken: category.botToken || group.botToken,
            chatIds: category.chatIds,
            translation: category.translation,
            message: category.message
        });
    }

    if (group.chatIds.length) {
        routes.push({
            label: groupName,
            botToken: group.botToken,
            chatIds: group.chatIds,
            translation: group.translation,
            message: group.message
        });
    }

    const seen = new Set();
    const destinations = [];
    for (const route of routes) {
        if (!route.botToken) {
            console.warn(`[config] Route "${route.label}" has chat ids but no bot token. Skipping.`);
            continue;
        }
        for (const chatId of route.chatIds) {
            const key = `${route.botToken}:${chatId}`;
            if (seen.has(key)) continue;
            seen.add(key);
            destinations.push({
                chatId,
                botToken: route.botToken,
                label: route.label,
                translation: route.translation,
                message: route.message,
                glossary: group.glossary
            });
        }
    }

    return destinations;
}
