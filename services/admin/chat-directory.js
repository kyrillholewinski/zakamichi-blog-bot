import { ADMIN_BOT_TOKEN } from '../../config/constants.js';
import { listRouteUsages } from '../../config/channels.js';
import { listKnownChats } from '../admin-state.js';
import { loadBroadcastStatus } from '../broadcaster.js';
import { GROUP_LIST } from '../backfill.js';
import { getBot } from '../telegram.js';

/**
 * Every chat or channel the bot broadcasts to, or could: chats named in
 * config.json, targets set from the admin panel, and chats the admin bot was
 * added to. Each is labelled with its live name from getChat, asked through the
 * bot that posts there, so "unreachable" means that bot really cannot post.
 */

const INFO_TTL_MS = 10 * 60 * 1000;
const chatInfoCache = new Map();   // `${token}:${chatId}` → { at, ok, chat, error }
const botNameCache = new Map();    // token → '@username'

/** 📢 channel · 👥 group · 👤 private · ❔ unknown/unreachable */
export function chatKindIcon(type) {
    if (type === 'channel') return '📢';
    if (type === 'group' || type === 'supergroup') return '👥';
    if (type === 'private') return '👤';
    return '❔';
}

function labelOfChat(chat) {
    if (chat.title) return chat.title;
    if (chat.username) return `@${chat.username}`;
    return [chat.first_name, chat.last_name].filter(Boolean).join(' ') || String(chat.id);
}

async function fetchChat(token, chatId, fresh) {
    const key = `${token}:${chatId}`;
    const cached = chatInfoCache.get(key);
    if (!fresh && cached && Date.now() - cached.at < INFO_TTL_MS) return cached;

    const result = await getBot(token).getChat(chatId);
    const info = result.success
        ? { at: Date.now(), ok: true, chat: result.data.result }
        : { at: Date.now(), ok: false, error: result.data?.description || 'unreachable' };
    chatInfoCache.set(key, info);
    return info;
}

/** "@my_bot" for a token, cached; null if the token is rejected. */
export async function botName(token) {
    if (!token) return null;
    if (botNameCache.has(token)) return botNameCache.get(token);
    const result = await getBot(token).getMe();
    const name = result.success ? `@${result.data.result.username}` : null;
    if (name) botNameCache.set(token, name);
    return name;
}

/** Posts delivered per chat, from every group's BroadcastStatus.JSON. */
async function loadDeliveryStats() {
    const stats = new Map();
    for (const group of GROUP_LIST) {
        const status = await loadBroadcastStatus(group);
        for (const [key, at] of Object.entries(status)) {
            // Keys are `${blogId}@${chatId}`; a chat id may itself start with '@'.
            const chatId = key.slice(key.indexOf('@') + 1);
            const entry = stats.get(chatId) || { count: 0, lastAt: null };
            entry.count += 1;
            if (!entry.lastAt || at > entry.lastAt) entry.lastAt = at;
            stats.set(chatId, entry);
        }
    }
    return stats;
}

/**
 * @param {object} [options]
 * @param {boolean} [options.fresh] - Re-ask Telegram instead of using cached names.
 * @returns {Promise<Array<{chatId, label, username, type, reachable, error, botToken,
 *          routes, joined, deliveries, lastDeliveredAt}>>} Reachable chats in use first.
 */
export async function getChatDirectory({ fresh = false } = {}) {
    const chats = new Map();
    const ensure = (chatId) => {
        const key = String(chatId);
        if (!chats.has(key)) chats.set(key, { chatId: key, routes: [], tokens: [], joined: null });
        return chats.get(key);
    };

    for (const usage of listRouteUsages()) {
        const entry = ensure(usage.chatId);
        entry.routes.push(usage);
        if (usage.botToken && !entry.tokens.includes(usage.botToken)) entry.tokens.push(usage.botToken);
    }
    for (const joined of listKnownChats()) {
        const entry = ensure(joined.id);
        entry.joined = joined;
        if (joined.active && ADMIN_BOT_TOKEN && !entry.tokens.includes(ADMIN_BOT_TOKEN)) entry.tokens.unshift(ADMIN_BOT_TOKEN);
    }

    const deliveries = await loadDeliveryStats();
    const directory = [];

    for (const entry of chats.values()) {
        const botToken = entry.tokens[0] || null;
        let label = entry.joined?.title || entry.chatId;
        let username = entry.joined?.username || null;
        let type = entry.joined?.type || 'unknown';
        let reachable = false;
        let error = botToken ? null : 'no bot token configured for this chat';

        if (botToken) {
            const info = await fetchChat(botToken, entry.chatId, fresh);
            if (info.ok) {
                reachable = true;
                label = labelOfChat(info.chat);
                username = info.chat.username || null;
                type = info.chat.type;
            } else {
                error = info.error;
            }
        }

        const stats = deliveries.get(entry.chatId);
        directory.push({
            chatId: entry.chatId,
            label,
            username,
            type: reachable ? type : (entry.joined?.type || 'unknown'),
            reachable,
            error,
            botToken,
            botTokens: entry.tokens,
            routes: entry.routes,
            joined: entry.joined,
            deliveries: stats?.count || 0,
            lastDeliveredAt: stats?.lastAt || null
        });
    }

    const inUse = (c) => c.routes.some(r => r.enabled);
    return directory.sort((a, b) =>
        Number(b.reachable) - Number(a.reachable) ||
        Number(inUse(b)) - Number(inUse(a)) ||
        a.label.localeCompare(b.label));
}
