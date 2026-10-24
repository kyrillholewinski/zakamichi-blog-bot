import fs from 'fs';
import FormData from 'form-data';
import { httpRequest } from '../utils/api.js';

/**
 * A thin client over the raw Telegram Bot API.
 *
 * Media may be given as a remote URL (Telegram fetches it itself — the normal
 * case for crawled blog images) or as a local path, which is uploaded as
 * multipart/form-data.
 */
export class TelegramApiClient {
    constructor(botToken) {
        if (!botToken) throw new Error('Telegram Bot Token is required.');
        this.botToken = botToken;
        this.baseUrl = `https://api.telegram.org/bot${botToken}`;
    }

    /**
     * @param {string|number} chatId
     * @param {string} text
     * @param {object} [options] - e.g. { parse_mode: 'HTML', disable_web_page_preview: true }
     */
    async sendMessage(chatId, text, options = {}) {
        return await httpRequest({
            method: 'POST',
            url: `${this.baseUrl}/sendMessage`,
            data: { chat_id: chatId, text, ...options },
            headers: { 'Content-Type': 'application/json' }
        });
    }

    async sendPhoto(chatId, media, options = {}) {
        return this._sendMedia('sendPhoto', 'photo', chatId, media, options);
    }

    async sendVideo(chatId, media, options = {}) {
        return this._sendMedia('sendVideo', 'video', chatId, media, options);
    }

    async sendAudio(chatId, media, options = {}) {
        return this._sendMedia('sendAudio', 'audio', chatId, media, options);
    }

    /**
     * Sends photos/videos as a single album.
     *
     * Telegram shows only the caption of the first item in an album, so the
     * caller is expected to put the formatted caption on `mediaItems[0]`.
     *
     * @param {string|number} chatId
     * @param {Array<{type: 'photo'|'video', media: string, caption?: string, parse_mode?: string}>} mediaItems
     * @param {object} [options]
     */
    async sendMediaGroup(chatId, mediaItems, options = {}) {
        const url = `${this.baseUrl}/sendMediaGroup`;
        const hasLocalFiles = mediaItems.some(item => !item.media.startsWith('http'));

        if (!hasLocalFiles) {
            return await httpRequest({
                method: 'POST',
                url,
                data: {
                    chat_id: chatId,
                    media: mediaItems.map(item => ({
                        type: item.type,
                        media: item.media,
                        caption: item.caption,
                        parse_mode: item.parse_mode
                    })),
                    ...options
                },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const form = new FormData();
        form.append('chat_id', String(chatId));
        for (const [key, value] of Object.entries(options)) form.append(key, String(value));

        const telegramMediaArray = [];
        let fileCounter = 0;

        for (const item of mediaItems) {
            const inputMedia = { type: item.type, caption: item.caption, parse_mode: item.parse_mode };
            if (item.media.startsWith('http')) {
                inputMedia.media = item.media;
            } else {
                const attachName = `file${fileCounter++}`;
                inputMedia.media = `attach://${attachName}`;
                form.append(attachName, fs.createReadStream(item.media));
            }
            telegramMediaArray.push(inputMedia);
        }

        form.append('media', JSON.stringify(telegramMediaArray));

        return await httpRequest({ method: 'POST', url, data: form, headers: form.getHeaders() });
    }

    /**
     * Sends one media item, choosing a JSON payload for URLs and a multipart
     * upload for local files.
     * @private
     */
    async _sendMedia(apiMethod, mediaType, chatId, media, options = {}) {
        const url = `${this.baseUrl}/${apiMethod}`;

        if (media.startsWith('http')) {
            return await httpRequest({
                method: 'POST',
                url,
                data: { chat_id: chatId, [mediaType]: media, ...options },
                headers: { 'Content-Type': 'application/json' }
            });
        }

        const form = new FormData();
        form.append('chat_id', String(chatId));
        form.append(mediaType, fs.createReadStream(media));
        for (const [key, value] of Object.entries(options)) form.append(key, String(value));

        return await httpRequest({ method: 'POST', url, data: form, headers: form.getHeaders() });
    }
}

// Bots are keyed by token so the same token is never instantiated twice.
const telegramBotCache = new Map();

export function getBot(token) {
    if (!telegramBotCache.has(token)) {
        telegramBotCache.set(token, new TelegramApiClient(token));
        console.log('🤖 New Telegram bot instance created.');
    }
    return telegramBotCache.get(token);
}
