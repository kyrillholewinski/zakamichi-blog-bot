import { OWNER_USER_ID } from '../../config/constants.js';

/**
 * Owner-only guard for the admin bot.
 *
 * Only messages and button presses from OWNER_USER_ID in a private chat with the
 * bot get through. Everything else (other users, groups, channels, edited
 * messages, inline queries) is dropped without any reply — not even an
 * answerCallbackQuery — so the bot reveals nothing to anyone else. Private-chat
 * only also keeps the panel out of groups where others could read it.
 */

function actorOf(update) {
    if (update.message) {
        return { from: update.message.from, chat: update.message.chat };
    }
    if (update.callback_query) {
        return { from: update.callback_query.from, chat: update.callback_query.message?.chat };
    }
    return null;
}

export function isOwnerUpdate(update) {
    if (!OWNER_USER_ID) return false;
    const actor = actorOf(update);
    if (!actor?.from || !actor.chat) return false;
    if (actor.from.is_bot) return false;
    return String(actor.from.id) === OWNER_USER_ID
        && actor.chat.type === 'private'
        && String(actor.chat.id) === OWNER_USER_ID;
}

/**
 * Token bucket: `capacity` actions in a burst, refilled at `refillPerMinute`.
 * Guards the owner's own actions too — a stuck key or a burst of taps on an
 * expensive button should not fan out into dozens of API calls.
 */
export function createRateLimiter({ capacity = 20, refillPerMinute = 30 } = {}) {
    let tokens = capacity;
    let last = Date.now();
    const refillPerMs = refillPerMinute / 60000;

    return function tryTake() {
        const now = Date.now();
        tokens = Math.min(capacity, tokens + (now - last) * refillPerMs);
        last = now;
        if (tokens < 1) return false;
        tokens -= 1;
        return true;
    };
}
