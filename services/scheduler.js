import { rolloverQuota, getQuota } from './admin-state.js';

/**
 * Resets the backfill translation quota at 00:00 UTC every day.
 *
 * The timer is re-armed from the clock after each firing rather than with a
 * fixed 24h interval, so it cannot drift. Quota reads also roll the day over
 * lazily, so a timer delayed by sleep or a restart still never carries usage
 * into the next day.
 */

export function msUntilNextUtcMidnight(now = new Date()) {
    const next = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
    return next - now.getTime();
}

let timer = null;

export function scheduleDailyQuotaReset() {
    if (rolloverQuota()) console.log('🧮 New UTC day: translation quota reset.');
    if (timer) return;

    const arm = () => {
        // A one-second margin guarantees the UTC date has changed when we fire.
        timer = setTimeout(() => {
            if (rolloverQuota()) {
                const { dailyLimit } = getQuota();
                console.log(`🧮 00:00 UTC: translation quota reset (0/${dailyLimit}).`);
            }
            arm();
        }, msUntilNextUtcMidnight() + 1000);
        timer.unref?.();
    };
    arm();
}
