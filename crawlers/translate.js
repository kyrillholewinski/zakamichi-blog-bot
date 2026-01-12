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

function getTranslationContext(text, member, group, options = {}) {
    const rules = [
        '1. **Tone**: Maintain the "Idol" persona—cute, energetic, and casual.',
        '2. **Names**: If a person\'s name is in Hiragana/Katakana, transcribe it to **Romaji**. If a person\'s name is **Kanji**, keep as original. Do NOT translate names meaningfully.',
        '3. **Format**: Output ONLY the translation. No "Translation:" prefix.'
    ];
    if (options.preserveHtml) {
        rules.push('4. **HTML**: Preserve all HTML tags/attributes/structure; translate text content only. Do NOT add or remove tags.');
    }
    const systemInstruction =
        `
        You are a professional translator specializing in Japanese Idol culture.
        RULES:
        ${rules.join('\n        ')}`;

    const safeMember = member || 'Unknown';
    const contentLabel = options.preserveHtml ? 'Blog Content in HTML' : 'message';
    const userContent =
        `Here is the ${contentLabel} by **${safeMember}** from Idol Group **${group}**
        Translate following message from Japanese to Traditional Chinese (Taiwan style).
        \n${text}`;

    return { systemInstruction, userContent };
}

/**
 * Handler for Google Gemini API
 * Note: Native systemInstruction requires Gemini 1.5 models or newer.
 */
async function translateWithGemini(text, member, group, options = {}) {
    if (!GEMINI_API_KEY) return null;

    const { systemInstruction, userContent } = getTranslationContext(text, member, group, options);
    const ai = new GoogleGenAI({ apiKey: GEMINI_API_KEY });

    let retries = 0;
    const maxRetries = 3;

    while (retries < maxRetries) {
        try {
            const modelName = geminiModels[retries];
            if (!modelName) {
                console.error('Gemini: No model available for retry index:', retries);
                return null;
            }

            // New SDK Syntax for System Instructions
            const response = await ai.models.generateContent({
                model: modelName,
                contents: userContent,
                config: {
                    systemInstruction: systemInstruction, // Native support here
                }
            });
            return response.text;
        } catch (error) {
            console.error('Gemini translate error:', error.message);
            if (error.status !== 429) return null;
            await sleep(10000);
        }
        retries += 1;
    }
    return null;
}

async function translateWithClaude(text, member, group, options = {}) {
    if (!CLAUDE_API_KEY) {
        console.error('Claude API Key missing');
        return null;
    }
    const { systemInstruction, userContent } = getTranslationContext(text, member, group, options);
    const anthropic = new Anthropic({ apiKey: CLAUDE_API_KEY });

    try {
        const response = await anthropic.messages.create({
            model: CLAUDE_API_MODEL || "claude-3-5-sonnet-20240620",
            max_tokens: 1024,
            system: systemInstruction,
            messages: [{ role: "user", content: userContent }]
        });
        return response.content[0]?.text || null;
    } catch (error) {
        console.error('Claude translate error:', error);
        return null;
    }
}

async function translateWithOpenAI(text, member, group, options = {}) {
    if (!OPENAI_API_KEY) {
        console.error('OpenAI API Key missing');
        return null;
    }
    const { systemInstruction, userContent } = getTranslationContext(text, member, group, options);
    const openai = new OpenAI({ apiKey: OPENAI_API_KEY });

    try {
        const response = await openai.chat.completions.create({
            model: OPENAI_API_MODEL || "gpt-4o",
            messages: [
                { role: "system", content: systemInstruction },
                { role: "user", content: userContent }
            ],
            temperature: 0.7,
        });
        return response.choices[0]?.message?.content || null;
    } catch (error) {
        console.error('OpenAI translate error:', error);
        return null;
    }
}

export async function translateMessage(text, member, group, provider = 'gemini', options = {}) {
    if (!text) return null;
    const selectedProvider = provider ? provider.toLowerCase() : 'gemini';

    switch (selectedProvider) {
        case 'claude': return await translateWithClaude(text, member, group, options);
        case 'openai': return await translateWithOpenAI(text, member, group, options);
        case 'gemini': default: return await translateWithGemini(text, member, group, options);
    }
}
