/**
 * Pauses execution for a given number of milliseconds.
 * @param {number} ms - The number of milliseconds to sleep.
 */
export const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));