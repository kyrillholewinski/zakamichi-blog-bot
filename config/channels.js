import fs from 'fs';
import path from 'path';
import { CONFIG_FILE_NAME, ADMIN_BOT_TOKEN, GROUPS } from './constants.js';
import { getMemberSettings, listMemberTargetOverrides, getKnownChat, listKnownChats } from '../services/admin-state.js';

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
    if (listMemberTargetOverrides(groupName).length) return true;
    const group = config.groups.get(groupName);
    if (!group || !group.enabled) return false;
    return (
        group.chatIds.length > 0 ||
        group.members.some(m => m.enabled && m.chatIds.length > 0) ||
        group.categories.some(c => c.enabled && c.chatIds.length > 0)
    );
}

/**
 * The bot that should post to a chat picked in the admin panel: the admin bot
 * for a chat it has been added to, else whichever bot config.json already uses
 * for that chat, else `fallback`. A bot can only post where it is a member, so
 * the bot known to reach the chat beats the member's or group's default bot.
 */
function tokenForChat(config, chatId, fallback) {
    if (ADMIN_BOT_TOKEN && getKnownChat(chatId)?.active) return ADMIN_BOT_TOKEN;
    for (const group of config.groups.values()) {
        for (const route of [group, ...group.members, ...group.categories]) {
            if (route.chatIds.includes(chatId)) return route.botToken || group.botToken || fallback;
        }
    }
    return fallback;
}

/**
 * Routes for targets the owner set from the admin panel, one per bot that will
 * post them. Settings come from the member's config entry when there is one,
 * else the group's, else the defaults.
 */
function adminRoutes(config, groupName, memberName, chatIds) {
    const group = config.groups.get(groupName);
    const member = group?.members.find(m => m.name === memberName);
    const fallback = member?.botToken || group?.botToken || ADMIN_BOT_TOKEN;

    const byToken = new Map();
    for (const chatId of chatIds) {
        const token = tokenForChat(config, chatId, fallback);
        if (!byToken.has(token)) byToken.set(token, []);
        byToken.get(token).push(chatId);
    }

    return [...byToken].map(([botToken, ids]) => ({
        label: `${groupName}/${memberName} (admin)`,
        botToken,
        chatIds: ids,
        translation: member?.translation || group?.translation || config.defaults.translation,
        message: member?.message || group?.message || config.defaults.message
    }));
}

/** Expands routes into de-duplicated destinations (first route wins per chat). */
function routesToDestinations(routes, glossary) {
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
                glossary
            });
        }
    }
    return destinations;
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

    const memberName = (blog.Name || '').replace(/\s+/g, '');
    const group = config.groups.get(groupName);
    const routes = [];

    // Targets set from the admin panel replace the member's config.json route and
    // apply even when the group is disabled there: setting them is the opt-in.
    const adminChatIds = getMemberSettings(groupName, memberName).chatIds;
    if (adminChatIds?.length) {
        routes.push(...adminRoutes(config, groupName, memberName, adminChatIds.map(String)));
    }

    if (!group || !group.enabled) return routesToDestinations(routes, group?.glossary || {});

    const member = group.members.find(m => m.name && m.name === memberName);
    if (member) {
        // An explicitly disabled member is muted everywhere config.json routes it.
        if (!member.enabled) return routesToDestinations(routes, group.glossary);
        if (member.chatIds.length && !adminChatIds?.length) {
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

    return routesToDestinations(routes, group.glossary);
}

/**
 * Every destination the bot knows about, across all groups — what the admin
 * panel offers for a manual send. Disabled flags are ignored on purpose: the
 * owner is picking a chat explicitly. The glossary is the post's group's.
 */
export function listKnownTargets(forGroupName) {
    const config = loadChannelConfig();
    const routes = [];

    for (const [groupName, group] of config.groups) {
        for (const member of group.members) {
            if (member.chatIds.length) routes.push({
                label: `${groupName}/${member.name}`,
                botToken: member.botToken || group.botToken,
                chatIds: member.chatIds,
                translation: member.translation,
                message: member.message
            });
        }
        for (const category of group.categories) {
            if (category.chatIds.length) routes.push({
                label: `${groupName}/${category.name}`,
                botToken: category.botToken || group.botToken,
                chatIds: category.chatIds,
                translation: category.translation,
                message: category.message
            });
        }
        if (group.chatIds.length) routes.push({
            label: groupName,
            botToken: group.botToken,
            chatIds: group.chatIds,
            translation: group.translation,
            message: group.message
        });
    }

    const groupNames = new Set([...config.groups.keys(), ...Object.values(GROUPS), forGroupName]);
    for (const groupName of groupNames) {
        for (const { memberName, chatIds } of listMemberTargetOverrides(groupName)) {
            routes.push(...adminRoutes(config, groupName, memberName, chatIds));
        }
    }

    // Chats the admin bot was added to, even if nothing routes there yet.
    if (ADMIN_BOT_TOKEN) {
        const fallback = getFallbackSettings(forGroupName);
        for (const chat of listKnownChats().filter(c => c.active)) {
            routes.push({ label: chat.title, botToken: ADMIN_BOT_TOKEN, chatIds: [chat.id], ...fallback });
        }
    }

    return routesToDestinations(routes, config.groups.get(forGroupName)?.glossary || {});
}

/**
 * Every place a chat id appears in the routing, one entry per use, so the chat
 * directory can show which routes feed each chat and with which bot.
 *
 * @returns {Array<{chatId: string, botToken: string, label: string, enabled: boolean}>}
 */
export function listRouteUsages() {
    const config = loadChannelConfig();
    const usages = [];

    for (const [groupName, group] of config.groups) {
        const groupOn = config.enabled && group.enabled;
        for (const chatId of group.chatIds) {
            usages.push({ chatId, botToken: group.botToken, label: `${groupName} (group-wide)`, enabled: groupOn });
        }
        for (const member of group.members) {
            for (const chatId of member.chatIds) {
                usages.push({ chatId, botToken: member.botToken || group.botToken, label: `${groupName}/${member.name}`, enabled: groupOn && member.enabled });
            }
        }
        for (const category of group.categories) {
            for (const chatId of category.chatIds) {
                usages.push({ chatId, botToken: category.botToken || group.botToken, label: `${groupName}/${category.name} (category)`, enabled: groupOn && category.enabled });
            }
        }
    }

    const groupNames = new Set([...config.groups.keys(), ...Object.values(GROUPS)]);
    for (const groupName of groupNames) {
        for (const { memberName, chatIds } of listMemberTargetOverrides(groupName)) {
            for (const route of adminRoutes(config, groupName, memberName, chatIds)) {
                for (const chatId of route.chatIds) {
                    usages.push({ chatId, botToken: route.botToken, label: `${groupName}/${memberName} (admin panel)`, enabled: config.enabled });
                }
            }
        }
    }

    return usages;
}

/** Translation/message settings to use for a chat that has no route of its own. */
export function getFallbackSettings(groupName) {
    const config = loadChannelConfig();
    const group = config.groups.get(groupName);
    return {
        translation: group?.translation || config.defaults.translation,
        message: group?.message || config.defaults.message,
        glossary: group?.glossary || {}
    };
}
