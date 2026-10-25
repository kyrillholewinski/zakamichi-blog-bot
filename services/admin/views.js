import crypto from 'crypto';
import { ADMIN_BOT_TOKEN, OWNER_USER_ID } from '../../config/constants.js';
import { resolveDestinations, listKnownTargets, getFallbackSettings } from '../../config/channels.js';
import { escapeHtml, formatJstTimestamp } from '../message-builder.js';
import { msUntilNextUtcMidnight } from '../scheduler.js';
import { getQueueSize } from '../broadcast-queue.js';
import { GROUP_LIST, getBlogIndex, getBackfillQueue, getTranslationStats } from '../backfill.js';
import {
    isTranslationPaused,
    isBroadcastPaused,
    getQuota,
    getMemberSettings
} from '../admin-state.js';

/**
 * Admin panel screens. Each view returns { text, reply_markup } ready for
 * sendMessage/editMessageText with parse_mode HTML.
 *
 * Callback data (Telegram allows 64 bytes, so members and chats are referenced
 * by short hashes, groups by their index in GROUP_LIST):
 *
 *   menu                     main menu
 *   st                       status dashboard
 *   fl:t | fl:b              toggle translation / broadcasting pause
 *   q | q:d:<delta> | q:r    quota view, change daily limit, reset today's usage
 *   mg                       pick a group's members
 *   ml:<g>:<page>            member list
 *   m:<g>:<hash>             member detail
 *   mt|ma|mc|mx:<g>:<hash>   toggle translate, toggle archive, set targets, clear targets
 *   bl:<page>                recent blogs
 *   b:<g>:<id>:<page>        blog detail with send targets
 *   bs:<g>:<id>:<hash>       translate + send blog to target
 *   noop                     inert button (page counter)
 */

const MEMBERS_PER_PAGE = 8;
const BLOGS_PER_PAGE = 8;
const MAX_TARGET_BUTTONS = 20;

export const shortHash = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 8);
export const groupIndexOf = (groupName) => GROUP_LIST.indexOf(groupName);
export const groupAt = (index) => GROUP_LIST[Number(index)] || null;

const button = (text, data) => ({ text, callback_data: data });
const backRow = (data = 'menu', text = '◀ Back') => [button(text, data)];
const fmt = (n) => Number(n).toLocaleString('en-US');

function truncate(text, max) {
    const chars = [...String(text || '')];
    return chars.length > max ? `${chars.slice(0, max - 1).join('')}…` : chars.join('');
}

function formatDuration(ms) {
    const minutes = Math.max(0, Math.round(ms / 60000));
    return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function pageRow(prefix, page, pageCount) {
    const row = [];
    if (page > 0) row.push(button('◀ Prev', `${prefix}:${page - 1}`));
    row.push(button(`${page + 1} / ${pageCount}`, 'noop'));
    if (page < pageCount - 1) row.push(button('Next ▶', `${prefix}:${page + 1}`));
    return row;
}

const clampPage = (page, pageCount) => Math.min(Math.max(Number(page) || 0, 0), Math.max(pageCount - 1, 0));

function quotaLine() {
    const { used, dailyLimit, remaining } = getQuota();
    return `🧮 Backfill quota: <b>${used} / ${dailyLimit}</b> today (${remaining} left) · resets in ${formatDuration(msUntilNextUtcMidnight())} (00:00 UTC)`;
}

// --- Main menu ---

export function mainView() {
    const translationPaused = isTranslationPaused();
    const broadcastPaused = isBroadcastPaused();

    const text = [
        '🛠 <b>Admin Panel</b>',
        '',
        `🌐 Translation: ${translationPaused ? '⏸ <b>paused</b>' : '▶️ running'}`,
        `📡 Broadcasting: ${broadcastPaused ? '⏸ <b>paused</b>' : '▶️ running'}`,
        quotaLine(),
        `📬 Broadcast queue: ${getQueueSize()} waiting`
    ].join('\n');

    return {
        text,
        reply_markup: {
            inline_keyboard: [
                [button('📊 Status', 'st'), button('👥 Members', 'mg')],
                [button('📰 Recent blogs', 'bl:0'), button('🧮 Quota', 'q')],
                [button(translationPaused ? '▶️ Resume translation' : '⏸ Pause translation', 'fl:t')],
                [button(broadcastPaused ? '▶️ Resume broadcasting' : '⏸ Pause broadcasting', 'fl:b')],
                [button('🔄 Refresh', 'menu')]
            ]
        }
    };
}

// --- Status dashboard ---

export async function statusView() {
    const [stats, backfillQueue] = await Promise.all([getTranslationStats(), getBackfillQueue()]);

    const lines = [
        '📊 <b>Status</b>',
        '',
        `✅ Translated blogs: <b>${fmt(stats.translated)}</b>`,
        `⏳ Pending (untranslated): <b>${fmt(stats.pending)}</b>`,
        `   ↳ eligible for backfill: ${fmt(backfillQueue.length)}`,
        quotaLine(),
        `📬 Broadcast queue: ${getQueueSize()} waiting`,
        '',
        '<b>By group</b>',
        ...stats.groups.map(g => `• ${escapeHtml(g.group)} — ✅ ${fmt(g.translated)} · ⏳ ${fmt(g.pending)}`)
    ];

    const topPending = stats.members.filter(m => m.pending > 0).slice(0, 10);
    if (topPending.length) {
        lines.push('', '<b>Most pending members</b>');
        for (const m of topPending) {
            lines.push(`• ${escapeHtml(m.group)} · ${escapeHtml(m.name)} — ⏳ ${fmt(m.pending)} · ✅ ${fmt(m.translated)}`);
        }
    }

    if (backfillQueue[0]) {
        const next = backfillQueue[0];
        lines.push('', `Next backfill: ${escapeHtml(next.group)} · ${escapeHtml(next.name)} · ${formatJstTimestamp(next.dateTime) || 'undated'}`);
    }

    return {
        text: lines.join('\n'),
        reply_markup: { inline_keyboard: [[button('🔄 Refresh', 'st')], backRow()] }
    };
}

// --- Quota ---

export function quotaView() {
    const { used, dailyLimit, remaining, date } = getQuota();
    const text = [
        '🧮 <b>Backfill translation quota</b>',
        '',
        `Daily limit: <b>${dailyLimit}</b>`,
        `Used today (${date} UTC): <b>${used}</b> · ${remaining} left`,
        `Resets at 00:00 UTC, in ${formatDuration(msUntilNextUtcMidnight())}.`,
        '',
        'The backfill translates archived blogs newest first. Every attempt, including a failed one, uses one unit. Live broadcasts and manual sends do not use the quota.'
    ].join('\n');

    return {
        text,
        reply_markup: {
            inline_keyboard: [
                [button('−10', 'q:d:-10'), button('−1', 'q:d:-1'), button('+1', 'q:d:1'), button('+10', 'q:d:10')],
                [button("♻️ Reset today's usage", 'q:r')],
                backRow()
            ]
        }
    };
}

// --- Members ---

/** Members of a group, most recently active first, with post counts. */
export async function listGroupMembers(groupName) {
    const index = await getBlogIndex();
    const members = new Map();
    for (const entry of index) {
        if (entry.group !== groupName) continue;
        if (!members.has(entry.name)) {
            members.set(entry.name, { name: entry.name, hash: shortHash(`${groupName}/${entry.name}`), latest: entry.dateTime, posts: 0, translated: 0, pending: 0 });
        }
        const m = members.get(entry.name);
        m.posts += 1;
        if (entry.translated) m.translated += 1;
        else if (entry.hasSource) m.pending += 1;
    }
    return [...members.values()];   // Index is newest-first, so insertion order is too.
}

export async function findMember(groupName, hash) {
    return (await listGroupMembers(groupName)).find(m => m.hash === hash) || null;
}

export async function memberGroupsView() {
    const rows = [];
    for (const [index, group] of GROUP_LIST.entries()) {
        const members = await listGroupMembers(group);
        rows.push([button(`${group} (${members.length})`, `ml:${index}:0`)]);
    }
    rows.push(backRow());
    return { text: '👥 <b>Members</b>\n\nPick a group.', reply_markup: { inline_keyboard: rows } };
}

function memberBadges(groupName, name) {
    const s = getMemberSettings(groupName, name);
    return `${s.autoTranslate ? '🌐' : '⛔'}${s.archive ? '📦' : '🗑'}${s.chatIds?.length ? '📡' : ''}`;
}

export async function memberListView(groupIndex, page) {
    const groupName = groupAt(groupIndex);
    if (!groupName) return mainView();

    const members = await listGroupMembers(groupName);
    const pageCount = Math.max(1, Math.ceil(members.length / MEMBERS_PER_PAGE));
    const current = clampPage(page, pageCount);
    const slice = members.slice(current * MEMBERS_PER_PAGE, (current + 1) * MEMBERS_PER_PAGE);

    const rows = slice.map(m => [button(
        `${memberBadges(groupName, m.name)} ${truncate(m.name, 18)} · ⏳${m.pending}`,
        `m:${groupIndex}:${m.hash}`
    )]);
    if (pageCount > 1) rows.push(pageRow(`ml:${groupIndex}`, current, pageCount));
    rows.push(backRow('mg', '◀ Groups'));

    const text = [
        `👥 <b>${escapeHtml(groupName)}</b> · ${members.length} members`,
        '',
        '🌐 auto-translate on · ⛔ off',
        '📦 archive on · 🗑 off',
        '📡 targets set from this panel',
        '⏳ untranslated archived posts'
    ].join('\n');

    return { text, reply_markup: { inline_keyboard: rows } };
}

export async function memberView(groupIndex, hash) {
    const groupName = groupAt(groupIndex);
    const member = groupName ? await findMember(groupName, hash) : null;
    if (!member) return { text: 'Member not found. The list may have changed.', reply_markup: { inline_keyboard: [backRow('mg')] } };

    const settings = getMemberSettings(groupName, member.name);
    const routing = resolveDestinations(groupName, { ID: '', Name: member.name, Title: '' });

    const lines = [
        `👤 <b>${escapeHtml(member.name)}</b> · ${escapeHtml(groupName)}`,
        `Posts: ${fmt(member.posts)} · latest ${formatJstTimestamp(member.latest) || 'unknown'} JST`,
        `Archived: ✅ ${fmt(member.translated)} translated · ⏳ ${fmt(member.pending)} pending`,
        '',
        `🌐 Auto-translate: <b>${settings.autoTranslate ? 'On' : 'Off'}</b>`,
        `📦 Archive / backup: <b>${settings.archive ? 'On' : 'Off'}</b>`,
        `📡 Targets set here: ${settings.chatIds?.length ? settings.chatIds.map(c => `<code>${escapeHtml(c)}</code>`).join(', ') : 'none (config.json decides)'}`,
        '',
        '<b>New posts currently go to</b>',
        ...(routing.length
            ? routing.map(d => `• ${escapeHtml(d.label)} → <code>${escapeHtml(d.chatId)}</code>`)
            : ['• nowhere'])
    ];
    if (!settings.archive) lines.push('', '🗑 Archive off: new posts are not saved to blogContent/ and are skipped by the backfill.');
    if (!settings.autoTranslate) lines.push('', '⛔ Auto-translate off: posts are broadcast in Japanese and skipped by the backfill.');

    const rows = [
        [button(`🌐 Auto-translate: ${settings.autoTranslate ? 'On → Off' : 'Off → On'}`, `mt:${groupIndex}:${hash}`)],
        [button(`📦 Archive: ${settings.archive ? 'On → Off' : 'Off → On'}`, `ma:${groupIndex}:${hash}`)],
        [button('📡 Set target chats', `mc:${groupIndex}:${hash}`)]
    ];
    if (settings.chatIds?.length) rows.push([button('🧹 Clear targets (use config.json)', `mx:${groupIndex}:${hash}`)]);
    rows.push(backRow(`ml:${groupIndex}:0`, '◀ Members'));

    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// --- Recent blogs & manual send ---

export async function recentBlogsView(page) {
    const index = await getBlogIndex();
    const pageCount = Math.max(1, Math.ceil(index.length / BLOGS_PER_PAGE));
    const current = clampPage(page, pageCount);
    const slice = index.slice(current * BLOGS_PER_PAGE, (current + 1) * BLOGS_PER_PAGE);

    const rows = slice.map(e => {
        const date = e.dateTime ? formatJstTimestamp(e.dateTime).slice(5, 10) : '--/--';
        const state = e.translated ? '✅' : e.hasSource ? '⏳' : '∅';
        return [button(`${state} ${date} ${truncate(e.name, 8)} · ${truncate(e.title, 22)}`, `b:${groupIndexOf(e.group)}:${e.id}:${current}`)];
    });
    rows.push(pageRow('bl', current, pageCount));
    rows.push(backRow());

    const text = [
        `📰 <b>Recent blogs</b> · ${fmt(index.length)} total`,
        '',
        '✅ translated archive · ⏳ archived, untranslated · ∅ no saved HTML',
        'Open a post to translate and send it to a chat.'
    ].join('\n');

    return { text, reply_markup: { inline_keyboard: rows } };
}

/** Builds the manifest shape the broadcaster expects from an index entry. */
export function blogFromEntry(entry) {
    return { ID: entry.id, Name: entry.name, Title: entry.title, DateTime: entry.dateTime, Url: entry.url };
}

/**
 * Chats a post can be sent to: its configured routes first (starred), then every
 * other known chat, then the owner's own DM as a preview target.
 */
export function getBlogTargets(groupName, blog) {
    const routed = resolveDestinations(groupName, blog).map(d => ({ ...d, routed: true }));
    const known = listKnownTargets(groupName).map(d => ({ ...d, routed: false }));
    const dm = ADMIN_BOT_TOKEN && OWNER_USER_ID
        ? [{ chatId: OWNER_USER_ID, botToken: ADMIN_BOT_TOKEN, label: 'My DM (preview)', routed: false, ...getFallbackSettings(groupName) }]
        : [];

    const seen = new Set();
    const targets = [];
    for (const target of [...routed, ...known, ...dm]) {
        const key = `${target.botToken}:${target.chatId}`;
        if (seen.has(key)) continue;
        seen.add(key);
        targets.push({ ...target, hash: shortHash(key) });
    }
    return targets;
}

export async function blogView(groupIndex, blogId, page = 0) {
    const groupName = groupAt(groupIndex);
    const index = await getBlogIndex();
    const entry = index.find(e => e.group === groupName && e.id === String(blogId));
    if (!entry) return { text: 'Blog not found.', reply_markup: { inline_keyboard: [backRow(`bl:${page}`)] } };

    const blog = blogFromEntry(entry);
    const targets = getBlogTargets(groupName, blog);

    const lines = [
        `📰 <b>${escapeHtml(entry.title || '(untitled)')}</b>`,
        `👤 ${escapeHtml(entry.name)} · ${escapeHtml(groupName)}`,
        `🕒 ${formatJstTimestamp(entry.dateTime) || 'unknown'} JST`
    ];
    if (entry.url) lines.push(`🔗 <a href="${escapeHtml(entry.url)}">Original post</a>`);
    lines.push(
        `Saved HTML: ${entry.hasSource ? 'yes' : 'no'} · Translated archive: ${entry.translated ? 'yes' : 'no'}`,
        ''
    );

    const rows = [];
    if (!entry.hasSource) {
        lines.push('This post has no saved HTML (archiving was off or it predates the archive), so it cannot be sent.');
    } else if (!targets.length) {
        lines.push('No chats are configured. Add targets to a member or to config/config.json.');
    } else {
        lines.push('Tap a chat to translate this post and send it there. ⭐ = where its routing sends it. Manual sends ignore both pause switches and do not use the quota.');
        for (const target of targets.slice(0, MAX_TARGET_BUTTONS)) {
            rows.push([button(`${target.routed ? '⭐' : '➡️'} ${truncate(target.label, 28)} · ${target.chatId}`, `bs:${groupIndex}:${entry.id}:${target.hash}`)]);
        }
    }
    rows.push(backRow(`bl:${page}`, '◀ Recent blogs'));

    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}
