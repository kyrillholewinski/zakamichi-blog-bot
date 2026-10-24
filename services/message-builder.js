import { classifyBlocks } from './blog-content.js';

/**
 * Builds Telegram messages for a blog post, following the caption layout used by
 * zakamichi-message-bot:
 *
 *   👤 #MemberName                 <- header: author, title, timestamp
 *   📝 Title
 *   🕒 2026-09-03 20:15
 *
 *   Body                           <- body: translated text (original optional)
 *   ---------
 *   Original body
 *
 *   🔗 原文                        <- footer: source link + channel attribution
 *   📣 Attribution
 *
 * Telegram caps media captions at 1024 characters and text messages at 4096, so
 * the builder returns the caption that fits on the album plus any follow-up
 * messages carrying the rest.
 */

export const CAPTION_LIMIT = 1024;
export const MESSAGE_LIMIT = 4096;
const SEPARATOR = '---------';

/** Escapes the five characters Telegram's HTML parse mode treats as markup. */
export function escapeHtml(text) {
    return String(text ?? '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

/** "#金村美玖" — hashtags let a channel's readers filter by member. */
function toHashtag(name) {
    const cleaned = String(name || '').replace(/\s+/g, '');
    return cleaned ? `#${cleaned}` : '';
}

/** Blog timestamps are stored as UTC ISO strings; readers expect JST. */
export function formatJstTimestamp(isoString) {
    if (!isoString) return '';
    const date = new Date(isoString);
    if (Number.isNaN(date.getTime())) return String(isoString);
    return date.toLocaleString('ja-JP', {
        timeZone: 'Asia/Tokyo',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false
    });
}

function buildHeader({ memberName, groupName, title, translatedTitle, dateTime, showGroupTag }) {
    const tags = [toHashtag(memberName), showGroupTag ? toHashtag(groupName) : ''].filter(Boolean).join(' ');
    const lines = [];

    if (tags) lines.push(`👤 ${tags}`);

    const displayTitle = translatedTitle || title;
    if (displayTitle) {
        let titleLine = `📝 <b>${escapeHtml(displayTitle)}</b>`;
        // Keep the Japanese title visible when it was translated away.
        if (translatedTitle && title && translatedTitle !== title) {
            titleLine += `\n   <i>${escapeHtml(title)}</i>`;
        }
        lines.push(titleLine);
    }

    const timestamp = formatJstTimestamp(dateTime);
    if (timestamp) lines.push(`🕒 ${timestamp} JST`);

    return lines.join('\n');
}

function buildFooter({ sourceUrl, attribution, imageCount }) {
    const lines = [];
    if (sourceUrl) lines.push(`🔗 <a href="${escapeHtml(sourceUrl)}">原文 / Original Post</a>`);
    if (imageCount) lines.push(`🖼 ${imageCount} 張圖片`);
    if (attribution) lines.push(`📣 ${escapeHtml(attribution)}`);
    return lines.join('\n');
}

/**
 * Renders the classified blocks into a list of balanced HTML fragments.
 *
 * Fragments are the unit of splitting: each one is self-contained HTML, so
 * packing them into messages can never cut a tag in half.
 */
function renderBody(blocks, { showOriginal, showImageMarkers }) {
    const fragments = [];
    let imageIndex = 0;

    for (const block of blocks) {
        if (block.type === 'image' || block.type === 'video') {
            imageIndex += 1;
            if (showImageMarkers) {
                const icon = block.type === 'video' ? '🎬' : '🖼';
                fragments.push(`${icon} [${imageIndex}]`);
            }
            continue;
        }

        const original = block.text?.trim();
        if (!original) continue;

        const translated = block.translatedText?.trim();
        const primary = translated || original;
        const prefix = block.role === 'caption' ? '📷 ' : '';

        fragments.push(`${prefix}${escapeHtml(primary)}`);

        // An untranslated block already shows the Japanese, so only echo it when
        // there really is a translation above it.
        if (showOriginal && translated) {
            fragments.push(`${SEPARATOR}\n<i>${escapeHtml(original)}</i>`);
        }
    }

    return fragments;
}

/**
 * Truncates HTML without cutting a tag in half, which Telegram rejects outright.
 * Drops whole lines from the end; if even the first line is too long, falls back
 * to stripping tags so what remains is at least valid.
 */
function truncateHtmlSafe(html, limit) {
    if (html.length <= limit) return html;

    const cut = html.lastIndexOf('\n', limit);
    if (cut > 0) return html.slice(0, cut).trimEnd();

    return html.replace(/<[^>]*>/g, '').slice(0, limit).trimEnd();
}

/** Greedily packs fragments into chunks no longer than `limit`. */
function packFragments(fragments, limit, { suffix = '' } = {}) {
    const chunks = [];
    let current = '';

    const flush = () => {
        const text = current.trim();
        if (text) chunks.push(text);
        current = '';
    };

    for (const fragment of fragments) {
        const piece = current ? `\n\n${fragment}` : fragment;
        if (current.length + piece.length > limit) {
            flush();
            // A single oversized fragment still has to go somewhere: hard-split it.
            if (fragment.length > limit) {
                for (let i = 0; i < fragment.length; i += limit) {
                    chunks.push(fragment.slice(i, i + limit));
                }
                continue;
            }
            current = fragment;
            continue;
        }
        current += piece;
    }
    flush();

    if (suffix) {
        const last = chunks[chunks.length - 1];
        if (last !== undefined && last.length + suffix.length + 2 <= limit) {
            chunks[chunks.length - 1] = `${last}\n\n${suffix}`;
        } else {
            chunks.push(suffix);
        }
    }

    return chunks;
}

/**
 * Builds everything needed to broadcast one blog post.
 *
 * @param {object} post
 * @param {string} post.memberName
 * @param {string} post.groupName
 * @param {string} post.title            - Original Japanese title.
 * @param {string} [post.translatedTitle]
 * @param {string} post.dateTime         - UTC ISO string.
 * @param {string} [post.sourceUrl]
 * @param {Array<object>} post.blocks    - Blocks from parseBlogHtml, optionally translated.
 * @param {object} [settings]            - Resolved `message` settings for the destination.
 * @returns {{parseMode: string, caption: string|null, mediaGroups: Array<Array<object>>, texts: Array<string>}}
 *          `caption` rides on the first item of the first album; `texts` are sent
 *          afterwards (or on their own when there is no media).
 */
export function buildBlogMessage(post, settings = {}) {
    const {
        parse_mode: parseMode = 'HTML',
        show_original: showOriginal = false,
        show_footer: showFooter = true,
        show_image_markers: showImageMarkers = true,
        attribution = '',
        max_media_per_group: maxMediaPerGroup = 10,
        send_media: sendMedia = true
    } = settings;

    const blocks = classifyBlocks(post.blocks || []);

    const header = buildHeader({
        memberName: post.memberName,
        groupName: post.groupName,
        title: post.title,
        translatedTitle: post.translatedTitle,
        dateTime: post.dateTime,
        showGroupTag: settings.show_group_tag !== false
    });

    const mediaItems = sendMedia
        ? blocks
            .filter(b => b.type === 'image' || b.type === 'video')
            .map(b => ({ type: b.type === 'video' ? 'video' : 'photo', media: b.url }))
        : [];

    const footer = showFooter
        ? buildFooter({ sourceUrl: post.sourceUrl, attribution, imageCount: mediaItems.length })
        : '';

    const bodyFragments = renderBody(blocks, { showOriginal, showImageMarkers });
    const allFragments = [header, ...bodyFragments].filter(Boolean);
    const fullChunks = packFragments(allFragments, MESSAGE_LIMIT, { suffix: footer });

    // No media: the post is just text messages.
    if (!mediaItems.length) {
        return { parseMode, caption: null, mediaGroups: [], texts: fullChunks };
    }

    const mediaGroups = [];
    const groupSize = Math.min(Math.max(Number(maxMediaPerGroup) || 10, 1), 10);
    for (let i = 0; i < mediaItems.length; i += groupSize) {
        mediaGroups.push(mediaItems.slice(i, i + groupSize).map(item => ({ ...item, parse_mode: parseMode })));
    }

    // Best case: the whole post fits in the album caption, exactly like the
    // single-caption layout zakamichi-message-bot uses for short messages.
    const wholePost = fullChunks.join('\n\n');
    if (fullChunks.length === 1 && wholePost.length <= CAPTION_LIMIT) {
        mediaGroups[0][0].caption = wholePost;
        return { parseMode, caption: wholePost, mediaGroups, texts: [] };
    }

    // Otherwise the album carries the header (plus footer if it still fits) and
    // the body follows as separate messages — the reader still sees who posted
    // what before scrolling.
    const footerFitsInCaption = Boolean(footer) && header.length + footer.length + 2 <= CAPTION_LIMIT;
    const caption = truncateHtmlSafe(
        footerFitsInCaption ? `${header}\n\n${footer}` : header,
        CAPTION_LIMIT
    );

    mediaGroups[0][0].caption = caption;

    // The footer trails the body only when it could not ride along on the album.
    const texts = packFragments(bodyFragments, MESSAGE_LIMIT, {
        suffix: footerFitsInCaption ? '' : footer
    });

    return { parseMode, caption, mediaGroups, texts };
}
