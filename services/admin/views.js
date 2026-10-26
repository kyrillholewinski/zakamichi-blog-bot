import crypto from 'crypto';
import { ADMIN_BOT_TOKEN, OWNER_USER_ID, ENABLE_TRANSLATION, ENABLE_BROADCAST, POLLING_INTERVAL_MS } from '../../config/constants.js';
import { resolveDestinations, listKnownTargets, getFallbackSettings } from '../../config/channels.js';
import { escapeHtml, formatJstTimestamp } from '../message-builder.js';
import { msUntilNextUtcMidnight } from '../scheduler.js';
import { getQueueSize } from '../broadcast-queue.js';
import { GROUP_LIST, getBlogIndex, getBackfillQueue, getTranslationStats } from '../backfill.js';
import { WINDOWS, isWithin, nextBoundary, formatWindow, nextCycleAt, getActivity } from '../schedule.js';
import { getChatDirectory, chatKindIcon, botName } from './chat-directory.js';
import {
    isTranslationPaused,
    isBroadcastPaused,
    getQuota,
    getMemberSettings,
    isGroupTranslationBlocked,
    isTranslationBlocked
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
 *   sc                       crawl / backfill schedule and last runs
 *   ch:<page>                chat directory
 *   cv|cr|cf:<chat>          chat detail, re-check it, forget it
 *   fl:t | fl:b              toggle translation / broadcasting pause
 *   q | q:d:<delta> | q:r    quota view, change daily limit, reset today's usage
 *   mg                       pick a group's members
 *   ml:<g>:<page>            member list
 *   m:<g>:<hash>             member detail
 *   mt|ma|mc|mx|mb:<g>:<hash> toggle translate, toggle archive, type targets, clear targets,
 *                            toggle the member's translation block
 *   mp:<g>:<hash>:<page>     pick target chats from the directory
 *   mpt:<g>:<hash>:<chat>:<page>  toggle one target chat
 *   gb:<g>                   toggle the whole group's translation block
 *   bl                       recent blogs: pick a group
 *   rg:<g>:<page>            recent blogs: a group's members, most recently active first
 *   rm:<g>:<hash>:<page>     recent blogs: one member's posts, newest first
 *   b:<g>:<id>:<hash>:<page> blog detail with send targets (hash/page lead back to the list)
 *   bs:<g>:<id>:<hash>       translate + send blog to target
 *   noop                     inert button (page counter)
 */

const MEMBERS_PER_PAGE = 8;
const BLOGS_PER_PAGE = 8;
const RECENT_MEMBERS_PER_PAGE = 10;
const MAX_TARGET_BUTTONS = 20;

export const shortHash = (value) => crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 8);
export const groupIndexOf = (groupName) => GROUP_LIST.indexOf(groupName);
export const groupAt = (index) => GROUP_LIST[Number(index)] || null;

const button = (text, data) => ({ text, callback_data: data });
const backRow = (data = 'menu', text = '◀ Back') => [button(text, data)];
const fmt = (n) => Number(n).toLocaleString('en-US');
// "10-25" from an ISO timestamp, in JST.
const shortDate = (iso) => iso ? formatJstTimestamp(iso).slice(5, 10) : '--/--';

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
                [button('📊 Status', 'st'), button('⏱ Schedule', 'sc')],
                [button('👥 Members', 'mg'), button('📢 Chats', 'ch:0')],
                [button('📰 Recent blogs', 'bl'), button('🧮 Quota', 'q')],
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
            members.set(entry.name, { name: entry.name, hash: shortHash(`${groupName}/${entry.name}`), latest: entry.dateTime, posts: 0, translated: 0, pending: 0, blogs: [] });
        }
        const m = members.get(entry.name);
        m.posts += 1;
        m.blogs.push(entry);
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
        const lock = isGroupTranslationBlocked(group) ? '🚫 ' : '';
        rows.push([button(`${lock}${group} (${members.length})`, `ml:${index}:0`)]);
    }
    rows.push(backRow());
    return { text: '👥 <b>Members</b>\n\nPick a group.', reply_markup: { inline_keyboard: rows } };
}

function memberBadges(groupName, name) {
    const s = getMemberSettings(groupName, name);
    const translate = isTranslationBlocked(groupName, name) ? '🚫' : s.autoTranslate ? '🌐' : '⛔';
    return `${translate}${s.archive ? '📦' : '🗑'}${s.chatIds?.length ? '📡' : ''}`;
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
    const groupBlocked = isGroupTranslationBlocked(groupName);
    rows.push([button(groupBlocked ? '✅ Unblock translation for this group' : '🚫 Block translation for this group', `gb:${groupIndex}`)]);
    rows.push(backRow('mg', '◀ Groups'));

    const text = [
        `👥 <b>${escapeHtml(groupName)}</b> · ${members.length} members`,
        ...(groupBlocked ? ['', '🚫 <b>Translation blocked for the whole group.</b> Nothing from it is translated, manual sends included.'] : []),
        '',
        '🌐 auto-translate on · ⛔ off · 🚫 blocked',
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
    const groupBlocked = isGroupTranslationBlocked(groupName);
    const routing = resolveDestinations(groupName, { ID: '', Name: member.name, Title: '' });

    const lines = [
        `👤 <b>${escapeHtml(member.name)}</b> · ${escapeHtml(groupName)}`,
        `Posts: ${fmt(member.posts)} · latest ${formatJstTimestamp(member.latest) || 'unknown'} JST`,
        `Archived: ✅ ${fmt(member.translated)} translated · ⏳ ${fmt(member.pending)} pending`,
        '',
        `🚫 Translation block: <b>${settings.translationBlocked ? 'Blocked' : 'Not blocked'}</b>${groupBlocked ? ' (whole group blocked)' : ''}`,
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
    if (!settings.autoTranslate) lines.push('', '⛔ Auto-translate off: posts are broadcast in Japanese and skipped by the backfill. Manual sends still translate.');
    if (settings.translationBlocked || groupBlocked) lines.push('', '🚫 Blocked: never translated — not on archiving, not by the backfill, not when broadcasting, and not by manual sends.');

    const rows = [
        [button(`🚫 Translation: ${settings.translationBlocked ? 'Blocked → Allow' : 'Allowed → Block'}`, `mb:${groupIndex}:${hash}`)],
        [button(`🌐 Auto-translate: ${settings.autoTranslate ? 'On → Off' : 'Off → On'}`, `mt:${groupIndex}:${hash}`)],
        [button(`📦 Archive: ${settings.archive ? 'On → Off' : 'Off → On'}`, `ma:${groupIndex}:${hash}`)],
        [button('📡 Choose target chats', `mp:${groupIndex}:${hash}:0`)]
    ];
    if (settings.chatIds?.length) rows.push([button('🧹 Clear targets (use config.json)', `mx:${groupIndex}:${hash}`)]);
    rows.push(backRow(`ml:${groupIndex}:0`, '◀ Members'));

    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// --- Recent blogs & manual send ---

/** Recent blogs, step 1: pick a group. Each button shows its latest post. */
export async function recentGroupsView() {
    const index = await getBlogIndex();
    const rows = [];
    for (const [groupIndex, group] of GROUP_LIST.entries()) {
        const entries = index.filter(e => e.group === group);
        const lock = isGroupTranslationBlocked(group) ? '🚫 ' : '';
        rows.push([button(
            `${lock}${group} · ${fmt(entries.length)} · latest ${shortDate(entries[0]?.dateTime)}`,
            `rg:${groupIndex}:0`
        )]);
    }
    rows.push(backRow());

    const text = [
        `📰 <b>Recent blogs</b> · ${fmt(index.length)} total`,
        '',
        'Pick a group, then a member.'
    ].join('\n');

    return { text, reply_markup: { inline_keyboard: rows } };
}

/** Recent blogs, step 2: a group's members, most recently active first. */
export async function recentMembersView(groupIndex, page) {
    const groupName = groupAt(groupIndex);
    if (!groupName) return recentGroupsView();

    const members = await listGroupMembers(groupName);
    const pageCount = Math.max(1, Math.ceil(members.length / RECENT_MEMBERS_PER_PAGE));
    const current = clampPage(page, pageCount);
    const slice = members.slice(current * RECENT_MEMBERS_PER_PAGE, (current + 1) * RECENT_MEMBERS_PER_PAGE);

    const rows = slice.map(m => {
        const latest = m.blogs[0];
        return [button(
            `${shortDate(m.latest)} ${truncate(m.name, 10)} · ${truncate(latest?.title, 16)} (${m.posts})`,
            `rm:${groupIndex}:${m.hash}:0`
        )];
    });
    if (pageCount > 1) rows.push(pageRow(`rg:${groupIndex}`, current, pageCount));
    rows.push(backRow('bl', '◀ Groups'));

    const text = [
        `📰 <b>${escapeHtml(groupName)}</b> · ${members.length} members`,
        '',
        'Members ordered by their latest post. Each button shows that post and the total count.'
    ].join('\n');

    return { text, reply_markup: { inline_keyboard: rows } };
}

/** Recent blogs, step 3: one member's posts, newest first. */
export async function recentMemberBlogsView(groupIndex, hash, page) {
    const groupName = groupAt(groupIndex);
    const member = groupName ? await findMember(groupName, hash) : null;
    if (!member) return { text: 'Member not found. The list may have changed.', reply_markup: { inline_keyboard: [backRow('bl', '◀ Groups')] } };

    const pageCount = Math.max(1, Math.ceil(member.blogs.length / BLOGS_PER_PAGE));
    const current = clampPage(page, pageCount);
    const slice = member.blogs.slice(current * BLOGS_PER_PAGE, (current + 1) * BLOGS_PER_PAGE);

    const rows = slice.map(e => {
        const state = e.translated ? '✅' : e.hasSource ? '⏳' : '∅';
        return [button(`${state} ${shortDate(e.dateTime)} · ${truncate(e.title || '(untitled)', 30)}`, `b:${groupIndex}:${e.id}:${hash}:${current}`)];
    });
    if (pageCount > 1) rows.push(pageRow(`rm:${groupIndex}:${hash}`, current, pageCount));
    rows.push(backRow(`rg:${groupIndex}:0`, '◀ Members'));

    const lines = [
        `📰 <b>${escapeHtml(member.name)}</b> · ${escapeHtml(groupName)} · ${fmt(member.posts)} posts`,
        '',
        '✅ translated archive · ⏳ archived, untranslated · ∅ no saved HTML',
        'Open a post to send it to a chat. A translated archive is reused, so sending it needs no new AI request.'
    ];
    if (isTranslationBlocked(groupName, member.name)) lines.push('', '🚫 Translation is blocked for this member: posts are sent in Japanese.');

    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
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

export async function blogView(groupIndex, blogId, memberHash, page = 0) {
    const groupName = groupAt(groupIndex);
    const index = await getBlogIndex();
    const entry = index.find(e => e.group === groupName && e.id === String(blogId));
    const back = backRow(`rm:${groupIndex}:${memberHash}:${page}`, '◀ Posts');
    if (!entry) return { text: 'Blog not found.', reply_markup: { inline_keyboard: [back] } };

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
        if (isTranslationBlocked(groupName, entry.name)) {
            lines.push('🚫 Translation is blocked for this group or member, so it is sent in Japanese.');
        } else if (entry.translated) {
            lines.push('🗂 The translated archive is reused, so sending needs no new AI request.');
        }
        lines.push('Tap a chat to translate this post and send it there. ⭐ = where its routing sends it. Manual sends ignore both pause switches and do not use the quota.');
        for (const target of targets.slice(0, MAX_TARGET_BUTTONS)) {
            rows.push([button(`${target.routed ? '⭐' : '➡️'} ${truncate(target.label, 28)} · ${target.chatId}`, `bs:${groupIndex}:${entry.id}:${target.hash}`)]);
        }
    }
    rows.push(back);

    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// --- Schedule ---

/** "14:05" for today (JST), "Sat 14:05" for another day. */
function formatWhen(date) {
    if (!date) return 'never';
    const d = new Date(date);
    const time = d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Tokyo', hour: '2-digit', minute: '2-digit', hour12: false });
    const day = (x) => x.toLocaleDateString('en-CA', { timeZone: 'Asia/Tokyo' });
    if (day(d) === day(new Date())) return time;
    return `${d.toLocaleDateString('en-GB', { timeZone: 'Asia/Tokyo', weekday: 'short' })} ${time}`;
}

function formatSpan(start, end) {
    const seconds = Math.max(0, Math.round((new Date(end) - new Date(start)) / 1000));
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

function windowState(window, now) {
    return isWithin(window, now)
        ? `🟢 active · ends ${formatWhen(nextBoundary(window, now))}`
        : `⏸ next ${formatWhen(nextBoundary(window, now))}`;
}

const STOP_REASONS = { done: 'backlog empty', quota: 'quota used up', paused: 'translation paused', window: 'crawl window opened' };

export function scheduleView(now = new Date()) {
    const activity = getActivity();
    const { cycle } = activity;
    const quota = getQuota();
    const intervalMin = Math.round(POLLING_INTERVAL_MS / 60000);

    const lines = [`⏱ <b>Schedule</b> · now ${formatWhen(now)} JST`, ''];

    let cycleLine = `🔁 Cycle every ${intervalMin} min · next ~${formatWhen(nextCycleAt(now))}`;
    if (cycle?.running) cycleLine += ` · ${cycle.mode} running since ${formatWhen(cycle.startedAt)}`;
    else if (cycle) cycleLine += ` · last ${cycle.mode} ${formatWhen(cycle.startedAt)} (${formatSpan(cycle.startedAt, cycle.finishedAt)})${cycle.error ? ' ❌' : ''}`;
    lines.push(cycleLine);
    if (activity.skipped.count) {
        lines.push(`   ${activity.skipped.count} cycle(s) skipped because the previous one was still running, last ${formatWhen(activity.skipped.lastAt)}`);
    }
    if (cycle?.error) lines.push(`   ❌ ${escapeHtml(cycle.error)}`);

    lines.push(
        '',
        `🕷 <b>Crawl</b> ${formatWindow(WINDOWS.crawl)} JST · ${windowState(WINDOWS.crawl, now)}`,
        '   Hinatazaka46 · Sakurazaka46 · Nogizaka46, every cycle',
        `   Bokuao ${formatWindow(WINDOWS.bokuao)} JST only · ${windowState(WINDOWS.bokuao, now)}`
    );
    for (const group of GROUP_LIST) {
        const crawl = activity.crawls[group];
        lines.push(crawl
            ? `   • ${escapeHtml(group)} ${formatWhen(crawl.startedAt)} · ${crawl.newPosts} new · ${formatSpan(crawl.startedAt, crawl.finishedAt)}`
            : `   • ${escapeHtml(group)} not crawled since start`);
    }

    const backfillBlocked = !ENABLE_TRANSLATION
        ? '❌ off (ENABLE_TRANSLATION is not true)'
        : isTranslationPaused() ? '⏸ translation paused' : null;
    lines.push(
        '',
        `🗂 <b>Backfill</b> ${formatWindow(WINDOWS.backfill)} JST · ${backfillBlocked || windowState(WINDOWS.backfill, now)}`,
        `   Quota ${quota.used} / ${quota.dailyLimit} · resets 09:00 JST (00:00 UTC), in ${formatDuration(msUntilNextUtcMidnight(now))}`
    );
    const backfill = activity.backfill;
    lines.push(backfill
        ? `   Last run ${formatWhen(backfill.startedAt)} → ${formatWhen(backfill.finishedAt)} · ${backfill.translated} translated, ${backfill.failed} failed · stopped: ${STOP_REASONS[backfill.stopReason] || backfill.stopReason}`
        : '   Not run since start');

    lines.push(
        '',
        `📬 <b>Broadcast queue</b> retried at the start of every cycle · ${getQueueSize()} waiting`,
        `📡 Broadcasting: ${!ENABLE_BROADCAST ? '❌ off (ENABLE_BROADCAST=false)' : isBroadcastPaused() ? '⏸ paused' : '▶️ running'}`,
        '',
        '<i>Run history is kept in memory and resets when the bot restarts.</i>'
    );

    return { text: lines.join('\n'), reply_markup: { inline_keyboard: [[button('🔄 Refresh', 'sc')], backRow()] } };
}

// --- Chat directory ---

const CHATS_PER_PAGE = 8;

function chatStatusIcon(chat) {
    if (!chat.reachable) return '❌';
    return chat.routes.some(r => r.enabled) ? '🟢' : '⚪';
}

export async function findChat(hash, options) {
    return (await getChatDirectory(options)).find(c => shortHash(c.chatId) === hash) || null;
}

export async function chatsView(page, { fresh = false } = {}) {
    const chats = await getChatDirectory({ fresh });
    const pageCount = Math.max(1, Math.ceil(chats.length / CHATS_PER_PAGE));
    const current = clampPage(page, pageCount);
    const slice = chats.slice(current * CHATS_PER_PAGE, (current + 1) * CHATS_PER_PAGE);

    const rows = slice.map(c => [button(
        `${chatStatusIcon(c)} ${chatKindIcon(c.type)} ${truncate(c.label, 26)} · ${c.routes.length} route${c.routes.length === 1 ? '' : 's'}`,
        `cv:${shortHash(c.chatId)}`
    )]);
    if (pageCount > 1) rows.push(pageRow('ch', current, pageCount));
    rows.push([button('🔄 Re-check all', 'ch:r')]);
    rows.push(backRow());

    const lines = [
        `📢 <b>Chats</b> · ${chats.length} known`,
        '',
        '🟢 receiving posts · ⚪ known, nothing routed · ❌ bot cannot reach it',
        '📢 channel · 👥 group · 👤 private · ❔ unknown',
        '',
        chats.length
            ? 'Tap a chat for its routes and deliveries.'
            : 'No chats yet. Add chat ids to config/config.json, set member targets, or add the admin bot to a channel as an admin.'
    ];
    if (ADMIN_BOT_TOKEN) {
        const name = await botName(ADMIN_BOT_TOKEN);
        if (name) lines.push(`Adding ${escapeHtml(name)} to a group or channel lists it here automatically.`);
    }

    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

export async function chatView(hash, { fresh = false } = {}) {
    const chat = await findChat(hash, { fresh });
    if (!chat) return { text: 'Chat not found. It may no longer be routed or known.', reply_markup: { inline_keyboard: [backRow('ch:0', '◀ Chats')] } };

    const lines = [`${chatKindIcon(chat.type)} <b>${escapeHtml(chat.label)}</b>${chat.username ? ` (@${escapeHtml(chat.username)})` : ''}`];
    lines.push(`ID: <code>${escapeHtml(chat.chatId)}</code> · ${escapeHtml(chat.type)}`);

    const names = await Promise.all(chat.botTokens.map(botName));
    if (names.length) lines.push(`Posted by: ${names.map((n, i) => escapeHtml(n || `bot #${i + 1} (token rejected)`)).join(', ')}`);
    lines.push(chat.reachable ? '✅ Reachable' : `❌ Not reachable: ${escapeHtml(chat.error || 'unknown error')}`);

    if (chat.joined) {
        const j = chat.joined;
        const by = !j.addedBy ? 'unknown'
            : String(j.addedBy) === OWNER_USER_ID ? 'you'
            : `${escapeHtml(j.addedByName || 'user')} (<code>${j.addedBy}</code>)`;
        lines.push(`Admin bot: ${escapeHtml(j.status)}${j.type === 'channel' ? ` · can post: ${j.canPost ? 'yes' : 'no'}` : ''} · changed by ${by} · ${formatJstTimestamp(j.updatedAt)} JST`);
        if (j.addedBy && String(j.addedBy) !== OWNER_USER_ID) {
            lines.push('⚠️ Someone else added the bot here. Nothing is sent unless you route a member to it.');
        }
    }

    lines.push(`Delivered: ${fmt(chat.deliveries)} post(s)${chat.lastDeliveredAt ? ` · last ${formatJstTimestamp(chat.lastDeliveredAt)} JST` : ''}`);
    lines.push('', '<b>Routes</b>');
    lines.push(...(chat.routes.length
        ? chat.routes.map(r => `• ${escapeHtml(r.label)}${r.enabled ? '' : ' <i>(disabled)</i>'}`)
        : ['• none. Pick it under 👥 Members → 📡 Choose target chats.']));

    const rows = [[button('🔄 Re-check', `cr:${hash}`)]];
    if (chat.joined && !chat.joined.active && !chat.routes.length) rows.push([button('🗑 Forget this chat', `cf:${hash}`)]);
    rows.push(backRow('ch:0', '◀ Chats'));
    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}

// --- Member target picker ---

export async function memberTargetsView(groupIndex, hash, page) {
    const groupName = groupAt(groupIndex);
    const member = groupName ? await findMember(groupName, hash) : null;
    if (!member) return { text: 'Member not found.', reply_markup: { inline_keyboard: [backRow('mg')] } };

    const selected = new Set(getMemberSettings(groupName, member.name).chatIds || []);
    // Chats the bot cannot reach are left out unless already selected, so they can still be switched off.
    const chats = (await getChatDirectory()).filter(c => c.reachable || selected.has(c.chatId));
    const pageCount = Math.max(1, Math.ceil(chats.length / CHATS_PER_PAGE));
    const current = clampPage(page, pageCount);
    const slice = chats.slice(current * CHATS_PER_PAGE, (current + 1) * CHATS_PER_PAGE);

    const rows = slice.map(c => [button(
        `${selected.has(c.chatId) ? '✅' : '⬜'} ${chatKindIcon(c.type)} ${truncate(c.label, 30)}`,
        `mpt:${groupIndex}:${hash}:${shortHash(c.chatId)}:${current}`
    )]);
    if (pageCount > 1) rows.push(pageRow(`mp:${groupIndex}:${hash}`, current, pageCount));
    rows.push([button('⌨️ Type chat ids', `mc:${groupIndex}:${hash}`)]);
    if (selected.size) rows.push([button('🧹 Clear (use config.json)', `mx:${groupIndex}:${hash}`)]);
    rows.push(backRow(`m:${groupIndex}:${hash}`, `◀ ${truncate(member.name, 20)}`));

    const lines = [
        `📡 <b>Targets for ${escapeHtml(member.name)}</b> · ${escapeHtml(groupName)}`,
        '',
        `Selected: ${selected.size || 'none, so config.json decides'}`,
        "Tap a chat to switch it on or off. Selected chats replace the member's config.json route; group and category routes still apply."
    ];
    if (!chats.length) lines.push('', 'No reachable chats are known yet. Add the admin bot to a channel, or type an id.');

    return { text: lines.join('\n'), reply_markup: { inline_keyboard: rows } };
}
