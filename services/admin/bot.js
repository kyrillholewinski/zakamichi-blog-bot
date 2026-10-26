import { ADMIN_BOT_TOKEN, OWNER_USER_ID } from '../../config/constants.js';
import { getBot } from '../telegram.js';
import { broadcastBlog, drainBroadcastQueue } from '../broadcaster.js';
import { invalidateBlogIndex, getBlogIndex } from '../backfill.js';
import { escapeHtml } from '../message-builder.js';
import { sleep } from '../../utils/misc.js';
import { isOwnerUpdate, createRateLimiter } from './auth.js';
import {
    mainView, statusView, quotaView, scheduleView,
    memberGroupsView, memberListView, memberView, memberTargetsView, findMember,
    chatsView, chatView, findChat,
    recentGroupsView, recentMembersView, recentMemberBlogsView,
    blogView, blogFromEntry, getBlogTargets, groupAt
} from './views.js';
import { chatKindIcon } from './chat-directory.js';
import {
    isTranslationPaused, setTranslationPaused,
    isBroadcastPaused, setBroadcastPaused,
    getQuota, setDailyLimit, resetQuotaUsage,
    getMemberSettings, updateMemberSettings,
    isGroupTranslationBlocked, setGroupTranslationBlocked,
    recordKnownChat, getKnownChat, forgetKnownChat
} from '../admin-state.js';

/**
 * Owner-only admin bot, driven by long polling (no webhook or open port needed).
 *
 * Every update passes the owner guard first; anything else is dropped without a
 * reply. Updates are handled one at a time, and the slow work (manual
 * translate + send) runs in the background so the panel stays responsive.
 */

const POLL_TIMEOUT_SECONDS = 30;
const INPUT_TTL_MS = 5 * 60 * 1000;
// Telegram chat ids are integers (channels/supergroups are -100…); public chats can be @usernames.
const CHAT_ID_PATTERN = /^(-?\d{5,20}|@[A-Za-z][A-Za-z0-9_]{4,31})$/;

const allowAction = createRateLimiter({ capacity: 20, refillPerMinute: 30 });
// Anyone can add the bot to their group, so "added to …" notices to the owner are capped.
const allowMembershipNotice = createRateLimiter({ capacity: 5, refillPerMinute: 1 });

let pendingInput = null;     // { kind: 'memberChats', groupIndex, hash, memberName, expiresAt }
let manualJob = null;        // the one manual send allowed at a time
let started = false;

const html = { parse_mode: 'HTML', disable_web_page_preview: true };

async function show(bot, view, target) {
    if (target?.messageId) {
        const result = await bot.editMessageText(target.chatId, target.messageId, view.text, { ...html, reply_markup: view.reply_markup });
        // Re-rendering an unchanged screen (e.g. Refresh) is not an error worth logging.
        if (result.success || /message is not modified/i.test(result.data?.description || '')) return;
        console.warn('[admin] editMessageText failed, sending a new message:', result.data?.description || result.data);
    }
    await bot.sendMessage(OWNER_USER_ID, view.text, { ...html, reply_markup: view.reply_markup });
}

const toast = (bot, callbackId, text, showAlert = false) =>
    bot.answerCallbackQuery(callbackId, text ? { text, show_alert: showAlert } : {});

// --- Manual translate + send ---

async function runManualSend(bot, groupName, entry, target) {
    const label = `${groupName}/${entry.id} → ${target.label} (${target.chatId})`;
    try {
        const result = await broadcastBlog(groupName, blogFromEntry(entry), null, {
            destinations: [target],
            force: true,
            forceTranslate: true
        });
        const ok = result.sent > 0;
        await bot.sendMessage(OWNER_USER_ID,
            `${ok ? '✅ Sent' : '❌ Failed to send'}: ${escapeHtml(entry.title || entry.id)}\n${escapeHtml(label)}`,
            html);
    } catch (err) {
        console.error(`[admin] Manual send failed for ${label}: ${err.message}`);
        await bot.sendMessage(OWNER_USER_ID, `❌ Error while sending ${escapeHtml(label)}: ${escapeHtml(err.message)}`, html);
    } finally {
        manualJob = null;
    }
}

// --- Callback dispatch ---

async function handleCallback(bot, query) {
    const data = query.data || '';
    const target = { chatId: query.message.chat.id, messageId: query.message.message_id };
    const [action, ...args] = data.split(':');

    if (action === 'noop') return toast(bot, query.id);

    if (!allowAction()) return toast(bot, query.id, '⏳ Too many actions. Wait a few seconds.');

    switch (action) {
        case 'menu':
            await toast(bot, query.id);
            return show(bot, mainView(), target);

        case 'st':
            await toast(bot, query.id, 'Counting…');
            invalidateBlogIndex();
            return show(bot, await statusView(), target);

        case 'sc':
            await toast(bot, query.id);
            return show(bot, scheduleView(), target);

        case 'ch': {
            const fresh = args[0] === 'r';
            await toast(bot, query.id, fresh ? 'Asking Telegram about every chat…' : undefined);
            return show(bot, await chatsView(fresh ? 0 : args[0], { fresh }), target);
        }

        case 'cv':
        case 'cr':
            await toast(bot, query.id, action === 'cr' ? 'Re-checking…' : undefined);
            return show(bot, await chatView(args[0], { fresh: action === 'cr' }), target);

        case 'cf': {
            const chat = await findChat(args[0]);
            if (!chat?.joined || chat.joined.active || chat.routes.length) {
                return toast(bot, query.id, 'Only a chat the bot has left, with no routes, can be forgotten.', true);
            }
            forgetKnownChat(chat.chatId);
            await toast(bot, query.id, 'Forgotten');
            return show(bot, await chatsView(0), target);
        }

        case 'mp':
            await toast(bot, query.id, 'Loading chats…');
            return show(bot, await memberTargetsView(args[0], args[1], args[2]), target);

        case 'mpt': {
            const groupName = groupAt(args[0]);
            const member = groupName ? await findMember(groupName, args[1]) : null;
            const chat = await findChat(args[2]);
            if (!member || !chat) return toast(bot, query.id, 'That member or chat is no longer listed.', true);

            const current = getMemberSettings(groupName, member.name).chatIds || [];
            const on = !current.includes(chat.chatId);
            updateMemberSettings(groupName, member.name, {
                chatIds: on ? [...current, chat.chatId] : current.filter(id => id !== chat.chatId)
            });
            await toast(bot, query.id, `${on ? '✅ Added' : '⬜ Removed'} ${chat.label}`);
            return show(bot, await memberTargetsView(args[0], args[1], args[3]), target);
        }

        case 'fl': {
            if (args[0] === 't') {
                setTranslationPaused(!isTranslationPaused());
                await toast(bot, query.id, isTranslationPaused() ? '⏸ Translation paused' : '▶️ Translation resumed');
            } else if (args[0] === 'b') {
                setBroadcastPaused(!isBroadcastPaused());
                const paused = isBroadcastPaused();
                await toast(bot, query.id, paused ? '⏸ Broadcasting paused. New posts will queue.' : '▶️ Broadcasting resumed. Sending queued posts…');
                if (!paused) drainBroadcastQueue().catch(err => console.error(`[admin] Queue drain failed: ${err.message}`));
            }
            return show(bot, mainView(), target);
        }

        case 'q': {
            if (args[0] === 'd') {
                setDailyLimit(getQuota().dailyLimit + Number(args[1] || 0));
                await toast(bot, query.id, `Daily limit: ${getQuota().dailyLimit}`);
            } else if (args[0] === 'r') {
                resetQuotaUsage();
                await toast(bot, query.id, "Today's usage reset to 0");
            } else {
                await toast(bot, query.id);
            }
            return show(bot, quotaView(), target);
        }

        case 'mg':
            await toast(bot, query.id);
            return show(bot, await memberGroupsView(), target);

        case 'ml':
            await toast(bot, query.id);
            return show(bot, await memberListView(args[0], args[1]), target);

        case 'm':
            await toast(bot, query.id);
            return show(bot, await memberView(args[0], args[1]), target);

        case 'mt':
        case 'ma':
        case 'mb':
        case 'mx': {
            const groupName = groupAt(args[0]);
            const member = groupName ? await findMember(groupName, args[1]) : null;
            if (!member) return toast(bot, query.id, 'Member not found.', true);

            const current = getMemberSettings(groupName, member.name);
            if (action === 'mt') updateMemberSettings(groupName, member.name, { autoTranslate: !current.autoTranslate });
            if (action === 'ma') updateMemberSettings(groupName, member.name, { archive: !current.archive });
            if (action === 'mb') updateMemberSettings(groupName, member.name, { translationBlocked: !current.translationBlocked });
            if (action === 'mx') updateMemberSettings(groupName, member.name, { chatIds: null });
            await toast(bot, query.id, 'Saved');
            return show(bot, await memberView(args[0], args[1]), target);
        }

        case 'gb': {
            const groupName = groupAt(args[0]);
            if (!groupName) return toast(bot, query.id, 'Group not found.', true);
            const blocked = !isGroupTranslationBlocked(groupName);
            setGroupTranslationBlocked(groupName, blocked);
            await toast(bot, query.id, blocked ? `🚫 Translation blocked for ${groupName}` : `✅ Translation allowed for ${groupName}`);
            return show(bot, await memberListView(args[0], 0), target);
        }

        case 'mc': {
            const groupName = groupAt(args[0]);
            const member = groupName ? await findMember(groupName, args[1]) : null;
            if (!member) return toast(bot, query.id, 'Member not found.', true);

            pendingInput = { kind: 'memberChats', groupIndex: args[0], hash: args[1], groupName, memberName: member.name, expiresAt: Date.now() + INPUT_TTL_MS };
            await toast(bot, query.id);
            const current = getMemberSettings(groupName, member.name).chatIds;
            return bot.sendMessage(OWNER_USER_ID, [
                `📡 Send the target chat(s) for <b>${escapeHtml(member.name)}</b> (${escapeHtml(groupName)}).`,
                '',
                'Separate several with spaces or commas, e.g. <code>-1001234567890 @my_channel</code>',
                'Send <code>-</code> to clear, or /cancel to keep the current setting.',
                `Current: ${current?.length ? current.map(c => `<code>${escapeHtml(c)}</code>`).join(', ') : 'none'}`,
                '',
                'The bot that posts there must be an admin of that chat.'
            ].join('\n'), { ...html, reply_markup: { force_reply: true, input_field_placeholder: '-1001234567890 @my_channel' } });
        }

        case 'bl':
            await toast(bot, query.id);
            invalidateBlogIndex();
            return show(bot, await recentGroupsView(), target);

        case 'rg':
            await toast(bot, query.id);
            return show(bot, await recentMembersView(args[0], args[1]), target);

        case 'rm':
            await toast(bot, query.id);
            return show(bot, await recentMemberBlogsView(args[0], args[1], args[2]), target);

        case 'b':
            await toast(bot, query.id);
            return show(bot, await blogView(args[0], args[1], args[2], args[3]), target);

        case 'bs': {
            const groupName = groupAt(args[0]);
            const entry = groupName ? (await getBlogIndex()).find(e => e.group === groupName && e.id === args[1]) : null;
            if (!entry?.hasSource) return toast(bot, query.id, 'This blog has no saved HTML.', true);

            const destination = getBlogTargets(groupName, blogFromEntry(entry)).find(t => t.hash === args[2]);
            if (!destination) return toast(bot, query.id, 'That chat is no longer configured.', true);

            if (manualJob) return toast(bot, query.id, '⏳ A manual send is already running. Try again when it finishes.', true);

            await toast(bot, query.id, `📤 Sending to ${destination.label}…`);
            manualJob = runManualSend(bot, groupName, entry, destination);
            return;
        }

        default:
            return toast(bot, query.id);
    }
}

// --- Text messages ---

function parseChatIds(text) {
    const parts = text.split(/[\s,]+/).map(s => s.trim()).filter(Boolean);
    const valid = parts.filter(p => CHAT_ID_PATTERN.test(p));
    const invalid = parts.filter(p => !CHAT_ID_PATTERN.test(p));
    return { valid: [...new Set(valid)], invalid };
}

async function handleMessage(bot, message) {
    const text = (message.text || '').trim();
    if (!text) return;
    if (!allowAction()) return;

    const command = text.split(/\s+/)[0].split('@')[0].toLowerCase();

    if (command === '/start' || command === '/admin') {
        pendingInput = null;
        return show(bot, mainView());
    }

    if (command === '/cancel') {
        const hadInput = Boolean(pendingInput);
        pendingInput = null;
        return bot.sendMessage(OWNER_USER_ID, hadInput ? 'Cancelled.' : 'Nothing to cancel.');
    }

    if (pendingInput && pendingInput.expiresAt < Date.now()) pendingInput = null;
    if (!pendingInput) {
        return bot.sendMessage(OWNER_USER_ID, 'Send /admin to open the admin panel.');
    }

    // pendingInput.kind === 'memberChats'
    const { groupName, memberName, groupIndex, hash } = pendingInput;

    if (text === '-') {
        updateMemberSettings(groupName, memberName, { chatIds: null });
    } else {
        const { valid, invalid } = parseChatIds(text);
        if (invalid.length || !valid.length) {
            return bot.sendMessage(OWNER_USER_ID,
                `❌ Not a chat id: ${escapeHtml(invalid.join(', ') || text)}\nUse numeric ids like <code>-1001234567890</code> or <code>@channel_name</code>. Try again, or /cancel.`,
                html);
        }
        updateMemberSettings(groupName, memberName, { chatIds: valid });
    }

    pendingInput = null;
    return show(bot, await memberView(groupIndex, hash));
}

// --- The bot being added to / removed from chats ---

const ACTIVE = new Set(['creator', 'administrator', 'member']);

function canPostIn(chat, member) {
    if (chat.type === 'channel') {
        return member.status === 'creator' || (member.status === 'administrator' && member.can_post_messages === true);
    }
    return ACTIVE.has(member.status) || (member.status === 'restricted' && member.can_send_messages === true);
}

/**
 * Records a my_chat_member update so the chat shows up under 📢 Chats.
 *
 * These updates come from whoever added or removed the bot, usually not the
 * owner, so nothing is ever sent back into that chat. The owner gets a short
 * notice in their DM when the bot gains or loses the ability to post there.
 */
async function handleMembership(bot, update) {
    const { chat, from, new_chat_member: member } = update;
    if (!chat || !member || chat.type === 'private') return;   // DMs: a user blocking/unblocking the bot.

    const canPost = canPostIn(chat, member);
    const previous = recordKnownChat(chat, {
        status: member.status,
        canPost,
        addedBy: from?.id ?? null,
        addedByName: [from?.first_name, from?.last_name].filter(Boolean).join(' ') || (from?.username ? `@${from.username}` : null)
    });
    const now = getKnownChat(chat.id);
    console.log(`[admin] Bot is now "${member.status}" in ${chat.type} ${chat.id} (${now.title}); can post: ${canPost}.`);

    if (Boolean(previous?.active) === now.active && previous?.status === now.status) return;
    if (!allowMembershipNotice()) return;

    const who = from && String(from.id) !== OWNER_USER_ID ? ` by ${escapeHtml(now.addedByName || 'someone')} (<code>${from.id}</code>)` : '';
    const name = `${chatKindIcon(chat.type)} <b>${escapeHtml(now.title)}</b> <code>${escapeHtml(now.id)}</code>`;
    let text;
    if (now.active) {
        text = `📢 Added to ${name}${who}. It is listed under /admin → 📢 Chats; route a member to it to start posting there.`;
    } else if (ACTIVE.has(member.status)) {
        text = `⚠️ In ${name}${who}, but I can't post there. Make me an admin with "Post messages".`;
    } else {
        text = `🚪 Removed from ${name}${who}. Posts routed there will fail until I'm added back.`;
    }
    await bot.sendMessage(OWNER_USER_ID, text, html);
}

// --- Update loop ---

async function handleUpdate(bot, update) {
    if (update.my_chat_member) return handleMembership(bot, update.my_chat_member);

    // Owner guard: no reply of any kind to anyone else.
    if (!isOwnerUpdate(update)) return;

    if (update.callback_query) return handleCallback(bot, update.callback_query);
    if (update.message) return handleMessage(bot, update.message);
}

async function pollLoop(bot) {
    let offset = 0;
    let backoffMs = 5000;

    while (true) {
        const result = await bot.getUpdates({
            offset,
            timeout: POLL_TIMEOUT_SECONDS,
            allowed_updates: ['message', 'callback_query', 'my_chat_member']
        });

        if (!result.success) {
            const description = result.data?.description || result.data;
            if (result.status === 401 || result.status === 404) {
                console.error(`[admin] ADMIN_BOT_TOKEN was rejected (${description}). Admin panel stopped.`);
                return;
            }
            if (result.status === 409) {
                console.error(`[admin] Telegram refused polling (${description}). Another process is polling this bot, or a webhook is set (remove it with deleteWebhook).`);
            } else {
                console.warn(`[admin] getUpdates failed: ${description}`);
            }
            await sleep(backoffMs);
            backoffMs = Math.min(backoffMs * 2, 60000);
            continue;
        }
        backoffMs = 5000;

        for (const update of result.data.result || []) {
            offset = update.update_id + 1;
            try {
                await handleUpdate(bot, update);
            } catch (err) {
                console.error(`[admin] Failed to handle update ${update.update_id}: ${err.message}`);
            }
        }
    }
}

export function startAdminBot() {
    if (started) return;
    if (!ADMIN_BOT_TOKEN || !OWNER_USER_ID) {
        console.log('[admin] Admin panel disabled. Set ADMIN_BOT_TOKEN and OWNER_USER_ID in .env to enable it.');
        return;
    }
    if (!/^\d+$/.test(OWNER_USER_ID)) {
        console.error('[admin] OWNER_USER_ID must be your numeric Telegram user id. Admin panel disabled.');
        return;
    }
    started = true;
    console.log('[admin] Admin panel listening for /admin from the owner.');
    pollLoop(getBot(ADMIN_BOT_TOKEN)).catch(err => {
        started = false;
        console.error(`[admin] Poll loop crashed: ${err.message}`);
    });
}
