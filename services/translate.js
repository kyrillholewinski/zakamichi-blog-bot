import { GoogleGenAI } from '@google/genai';
import Anthropic from '@anthropic-ai/sdk';
import OpenAI from 'openai';
import {
    GEMINI_API_KEY,
    GEMINI_API_MODEL_1,
    GEMINI_API_MODEL_2,
    GEMINI_API_MODEL_3,
    CLAUDE_API_KEY,
    CLAUDE_API_MODEL,
    OPENAI_API_KEY,
    OPENAI_API_MODEL
} from '../config/constants.js';
import { sleep } from '../utils/misc.js';

// --- Shared Configuration ---
const geminiModels = [
    GEMINI_API_MODEL_1,
    GEMINI_API_MODEL_2,
    GEMINI_API_MODEL_3
];

const DEFAULT_TARGET_LANGUAGE = 'Traditional Chinese (Taiwan)';

// Maps abstract thinking levels to Gemini thinking budgets (reasoning tokens).
// Values are valid across the whole retry chain: gemini-2.5-pro requires >= 128,
// flash-lite requires 0 or >= 512.
const THINKING_BUDGETS = { low: 512, middle: 2048, high: 8192 };

// Rate-limit statuses worth retrying on the SAME model; any other error means
// that model is unusable for this request, so we fall through to the next one.
const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RATE_LIMIT_RETRIES = 3;

// Hiragana + Katakana. Traditional Chinese never contains kana, so kana in the
// source must disappear under a real translation.
const KANA_REGEX = /[぀-ゟ゠-ヿ]/;

// Segment framing for batched blog translation. Chosen to be something no idol
// blog would ever contain, so a stray occurrence cannot desynchronise the parse.
const SEGMENT_MARKER = (index) => `<<<SEG ${index}>>>`;
const SEGMENT_MARKER_REGEX = /<<<\s*SEG\s*(\d+)\s*>>>/g;

// Rough cap on how much source text goes into one request, so a very long blog
// is translated in several batches instead of being truncated by the model.
const MAX_BATCH_CHARS = 6000;

function getThinkingBudget(thinkingLevel) {
    const level = (thinkingLevel || 'middle').toLowerCase();
    if (!(level in THINKING_BUDGETS)) {
        console.warn(`⚠️ Unknown thinkingLevel "${thinkingLevel}". Falling back to "middle".`);
        return THINKING_BUDGETS.middle;
    }
    return THINKING_BUDGETS[level];
}

/**
 * Detects a non-translation: an empty response, or the model echoing the source
 * back verbatim. A kanji-only source (e.g. the name 坂井新奈) legitimately comes
 * back unchanged, so an identical result only counts as a failure when the
 * source contains kana.
 */
function isUntranslated(source, output) {
    if (!output || !output.trim()) return true;
    const stripped = s => s.replace(/\s+/g, '');
    return stripped(output) === stripped(source) && KANA_REGEX.test(source);
}

/**
 * Builds the glossary block. Only entries whose source term actually appears in
 * the text are injected, so unrelated entries never bloat or distract the prompt.
 */
function buildGlossarySection(text, glossary) {
    const entries = Object.entries(glossary || {}).filter(([sourceTerm]) => text.includes(sourceTerm));
    if (!entries.length) return '';
    return `\n\n## Glossary (authoritative — overrides all other rules)
Each source term below appears in this text. Where it refers to a person, use the given rendering exactly; these are nicknames/proper nouns — NEVER translate their surface meaning:
${entries.map(([src, dst]) => `- ${src} → ${dst}`).join('\n')}`;
}

function getTranslationContext(text, member, group, options = {}) {
    const targetLanguage = options.targetLanguage || DEFAULT_TARGET_LANGUAGE;
    const glossarySection = buildGlossarySection(text, options.glossary);

    const extraRules = [];
    if (options.preserveHtml) {
        extraRules.push('9. **HTML**: Preserve all HTML tags, attributes and structure exactly; translate text content only. Do NOT add or remove tags.');
    }
    if (options.segmented) {
        extraRules.push(`9. **Segments**: The input is split into numbered segments marked \`${SEGMENT_MARKER('N')}\`. Reproduce EVERY marker, in the same order, with the same numbers, each followed by the translation of that segment and nothing else. Never merge, drop, reorder or renumber segments, and never add commentary between them. A segment that needs no translation (a URL, an emoji run) is reproduced unchanged under its own marker.`);
    }

    const systemInstruction =
        `You are an expert Japanese-to-${targetLanguage} translator specializing in Japanese idol culture and fan communication.

## Objective
Translate the idol's blog post so it reads as if she had written it natively in ${targetLanguage} — precise, natural, and faithful to her personal voice.

## Rules
1. **Tone & Voice**: Reproduce the exact tone and nuance of the source — the idol persona is cute, energetic, and casual. Preserve emotional intensity, playfulness, hesitation, and emphasis. Do not make the text more formal or more casual than the original.
2. **Formatting**: Mirror the source formatting exactly — keep every line break, emoji, kaomoji (e.g. (｡•ᴗ•｡)), symbol (♪ 〜 ☆), and punctuation style in its original position. Do not merge, split, or reorder lines.
3. **Idioms & Culture**: Translate idioms and culture-specific expressions by meaning, never literally. Render idol-culture terms the way fans naturally say them.
4. **Names & Nicknames**: If a person's name is written in Hiragana/Katakana, transcribe it to Romaji. If a name is in Kanji, keep it as-is. Never translate a name's literal meaning.
5. **Nickname Trap (critical)**: Idol blogs are full of kana nicknames (typically ending in 〜たん, 〜ちゃん, 〜りん, 〜ぴ), and some look identical to ordinary Japanese words. Example: にいたん may be a fellow member's nickname and must then be transcribed as "Niitan" — NOT read as お兄ちゃん. When a kana word could be either a common noun or a person, prefer the nickname reading.
6. **Naturalness**: Avoid machine-translation artifacts — no stilted phrasing, no word-for-word calques, no unnatural word order.
7. **Fidelity**: Do not add, omit, or explain anything. If the source is ambiguous, choose the most contextually plausible reading for an idol's blog and translate it directly, without notes.
8. **Output**: Output ONLY the translation. No "Translation:" prefix, no romanization, no commentary.${extraRules.length ? `\n${extraRules.join('\n')}` : ''}${glossarySection}`;

    const safeMember = member || 'Unknown';
    const contentLabel = options.preserveHtml
        ? 'blog content in HTML'
        : options.segmented ? 'segmented blog post' : 'message';

    const userContent =
        `Here is the ${contentLabel} by **${safeMember}** from Idol Group **${group}**.
Translate it from Japanese to ${targetLanguage}.

${text}`;

    return { systemInstruction, userContent };
}

/**
 * Handler for Google Gemini API.
 *
 * Walks the configured models in order. Rate limits retry the same model;
 * anything else — a bad model name, an empty or echoed response — falls through
 * to the next model in the chain.
 */
async function translateWithGemini(text, member, group, options = {}) {
    if (!GEMINI_API_KEY) {
        console.error('❌ Gemini API key missing.');
        return null;
    }

    const { systemInstruction, userContent } = getTranslationContext(text, member, group, options);
    const thinkingBudget = getThinkingBudget(options.thinkingLevel);

    const models = geminiModels.filter(Boolean);
    if (!models.length) {
        console.error('❌ Gemini: No translation models configured (GEMINI_API_MODEL_1..3).');
        return null;
    }

    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    for (const modelName of models) {
        for (let attempt = 1; attempt <= MAX_RATE_LIMIT_RETRIES; attempt++) {
            try {
                const response = await ai.models.generateContent({
                    model: modelName,
                    contents: userContent,
                    config: {
                        systemInstruction,
                        thinkingConfig: { thinkingBudget }
                    }
                });

                const output = response.text?.trim();
                if (isUntranslated(text, output)) {
                    console.warn(`⚠️ ${modelName} returned ${output ? 'the source text unchanged' : 'no text'}. Falling back to next model...`);
                    break;
                }
                return output;
            } catch (error) {
                const status = error.status;
                if (RETRYABLE_STATUSES.has(status) && attempt < MAX_RATE_LIMIT_RETRIES) {
                    console.warn(`⏳ ${modelName} unavailable (${status}). Retry ${attempt}/${MAX_RATE_LIMIT_RETRIES - 1}...`);
                    await sleep(30000);
                    continue;
                }
                console.error(`❌ ${modelName} translate error (${status ?? 'no status'}): ${error.message}`);
                break;
            }
        }
    }

    console.error(`❌ Translation failed on all ${models.length} configured model(s): ${models.join(', ')}`);
    return null;
}

async function translateWithClaude(text, member, group, options = {}) {
    if (!CLAUDE_API_KEY) {
        console.error('❌ Claude API key missing.');
        return null;
    }
    const { systemInstruction, userContent } = getTranslationContext(text, member, group, options);
    const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });

    try {
        const response = await anthropic.messages.create({
            model: CLAUDE_API_MODEL || 'claude-sonnet-5',
            max_tokens: 8192,
            system: systemInstruction,
            messages: [{ role: 'user', content: userContent }]
        });
        return response.content[0]?.text?.trim() || null;
    } catch (error) {
        console.error(`❌ Claude translate error: ${error.message}`);
        return null;
    }
}

async function translateWithOpenAI(text, member, group, options = {}) {
    if (!OPENAI_API_KEY) {
        console.error('❌ OpenAI API key missing.');
        return null;
    }
    const { systemInstruction, userContent } = getTranslationContext(text, member, group, options);
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    try {
        const response = await openai.chat.completions.create({
            model: OPENAI_API_MODEL || 'gpt-4o',
            messages: [
                { role: 'system', content: systemInstruction },
                { role: 'user', content: userContent }
            ],
            temperature: 0.7
        });
        return response.choices[0]?.message?.content?.trim() || null;
    } catch (error) {
        console.error(`❌ OpenAI translate error: ${error.message}`);
        return null;
    }
}

/**
 * Translates a single chunk of text.
 *
 * @param {string} text
 * @param {string} member - Author name, used for context.
 * @param {string} group - Idol group name, used for context.
 * @param {string} [provider] - 'gemini' | 'claude' | 'openai'.
 * @param {object} [options] - { preserveHtml, segmented, glossary, targetLanguage, thinkingLevel }
 */
export async function translateMessage(text, member, group, provider = 'gemini', options = {}) {
    if (!text) return null;
    const selectedProvider = (provider || 'gemini').toLowerCase();

    switch (selectedProvider) {
        case 'claude': return await translateWithClaude(text, member, group, options);
        case 'openai': return await translateWithOpenAI(text, member, group, options);
        case 'gemini': default: return await translateWithGemini(text, member, group, options);
    }
}

/** Splits segment indices into batches that stay under MAX_BATCH_CHARS. */
function batchSegments(segments) {
    const batches = [];
    let current = [];
    let currentChars = 0;

    segments.forEach((segment, index) => {
        const length = segment.length;
        if (current.length && currentChars + length > MAX_BATCH_CHARS) {
            batches.push(current);
            current = [];
            currentChars = 0;
        }
        current.push(index);
        currentChars += length;
    });

    if (current.length) batches.push(current);
    return batches;
}

/** Parses a marked-up response back into a { originalIndex: translation } map. */
function parseSegmentedResponse(response, indices) {
    const result = new Map();
    if (!response) return result;

    const markers = [...response.matchAll(SEGMENT_MARKER_REGEX)];
    for (let i = 0; i < markers.length; i++) {
        const marker = markers[i];
        const segmentNumber = Number(marker[1]);
        const start = marker.index + marker[0].length;
        const end = i + 1 < markers.length ? markers[i + 1].index : response.length;
        const value = response.slice(start, end).trim();

        // Markers are 1-based positions within this batch.
        const originalIndex = indices[segmentNumber - 1];
        if (originalIndex === undefined || !value) continue;
        result.set(originalIndex, value);
    }
    return result;
}

/**
 * Translates an ordered list of text segments, preserving one-to-one alignment.
 *
 * Segments are sent in marker-delimited batches so the model sees the whole post
 * as context instead of disconnected fragments. If a batch comes back misaligned
 * — missing or renumbered markers — only the segments it failed to return are
 * retried individually, so one bad batch never costs the whole post.
 *
 * @returns {Promise<Array<string|null>>} Same length as `segments`; null where translation failed.
 */
export async function translateSegments(segments, member, group, options = {}) {
    const results = new Array(segments.length).fill(null);
    if (!segments.length) return results;

    const { provider = 'gemini', ...translateOptions } = options;

    for (const indices of batchSegments(segments)) {
        const payload = indices
            .map((originalIndex, position) => `${SEGMENT_MARKER(position + 1)}\n${segments[originalIndex]}`)
            .join('\n\n');

        const response = await translateMessage(payload, member, group, provider, {
            ...translateOptions,
            segmented: true
        });

        const parsed = parseSegmentedResponse(response, indices);
        for (const [originalIndex, value] of parsed) results[originalIndex] = value;

        // Retry whatever the batch dropped, one segment at a time and unsegmented.
        const missing = indices.filter(i => results[i] === null);
        if (missing.length) {
            console.warn(`⚠️ Segmented translation returned ${parsed.size}/${indices.length} segments. Retrying ${missing.length} individually...`);
            for (const originalIndex of missing) {
                results[originalIndex] = await translateMessage(
                    segments[originalIndex], member, group, provider, translateOptions
                );
            }
        }
    }

    return results;
}

/**
 * Translates a whole blog post: title, body prose and image captions.
 *
 * Blocks come from `parseBlogHtml`/`classifyBlocks` and are returned in the same
 * order with a `translatedText` field added to each text block, so the message
 * builder can lay the post out without re-deriving anything.
 *
 * @param {object} post
 * @param {string} post.title
 * @param {Array<object>} post.blocks - Classified blocks (text/image/video).
 * @param {string} post.member
 * @param {string} post.group
 * @param {object} [options] - { provider, glossary, targetLanguage, thinkingLevel,
 *                               translateTitle, translateBody, translateImageCaptions }
 * @returns {Promise<{title: string|null, blocks: Array<object>, translatedCount: number}>}
 */
export async function translateBlogPost({ title, blocks, member, group }, options = {}) {
    const {
        translateTitle = true,
        translateBody = true,
        translateImageCaptions = true,
        ...translateOptions
    } = options;

    // Index the pieces we actually want translated, keeping their positions so
    // results can be written straight back.
    const sources = [];
    const targets = [];

    if (translateTitle && title?.trim()) {
        sources.push(title.trim());
        targets.push({ kind: 'title' });
    }

    blocks.forEach((block, index) => {
        if (block.type !== 'text' || !block.text?.trim()) return;
        const isCaption = block.role === 'caption';
        if (isCaption ? !translateImageCaptions : !translateBody) return;
        sources.push(block.text);
        targets.push({ kind: 'block', index });
    });

    if (!sources.length) {
        return { title: null, blocks: blocks.map(b => ({ ...b })), translatedCount: 0 };
    }

    const translations = await translateSegments(sources, member, group, translateOptions);

    const outputBlocks = blocks.map(b => ({ ...b }));
    let translatedTitle = null;
    let translatedCount = 0;

    targets.forEach((target, i) => {
        const value = translations[i];
        if (!value) return;
        translatedCount += 1;
        if (target.kind === 'title') {
            translatedTitle = value;
        } else {
            outputBlocks[target.index].translatedText = value;
        }
    });

    if (translatedCount < sources.length) {
        console.warn(`⚠️ Translated ${translatedCount}/${sources.length} segment(s) for ${group}/${member}. Untranslated parts fall back to the original Japanese.`);
    }

    return { title: translatedTitle, blocks: outputBlocks, translatedCount };
}
