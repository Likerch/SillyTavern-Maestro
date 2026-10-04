// Text preparation for the free reply checks of M12 (plan §6 M12, §11). A stored reply carries service parts
// that are NORMAL and must never look like a defect:
// - the DES tracker JSON block at the start (together mode, research/des.md §together);
// - NAI Studio image markers `<figure><img data-nai='{…}'><figcaption>…</figcaption></figure>`, the legacy
//   formats (`[IMG:GEN:{…}]`, `<!--img-prompt="…"-->`, `/gen?prompt=` image URLs) and the `[nai:img:<id>]`
//   placeholders the finaliser leaves (research/qvink-nai-studio.md §B5);
// - CarrotKernel `<BunnyMoTags>` dumps, BunnyMo `<KEY:VALUE>` tags, folded `<details>` blocks, reasoning blocks
//   that presets hide with regexes, and tracker blocks of other extensions.
// The story text («prose») is what is left; it is split into paragraphs, sentences, narration and dialogue.
// Pure: no DOM, no SillyTavern.
import type { QualityInput, QualityMessage } from './quality-types';
import { stripCkDumps, stripDesTrackerJson, stripHtml, stripNaiPlaceholders } from './text-clean';

/** Longest quote of a defect. */
export const QUOTE_CHARS = 160;

/**
 * Chat-template tokens that leak from providers: DeepSeek's fullwidth-bar tokens (`<｜begin▁of▁sentence｜>`),
 * ChatML / Llama 3 / Phi (`<|im_start|>`, `<|eot_id|>`), Gemma (`<start_of_turn>`), Llama 2 (`[INST]`, `<<SYS>>`)
 * and the bare EOS `</s>`. Used to clean the prose; the junk check has its own, stricter list with offsets.
 */
const SERVICE_TOKEN_RE =
    /<｜[^｜\n]{1,64}｜>|<\|[A-Za-z][A-Za-z0-9_]{0,40}\|>|<(?:start_of_turn|end_of_turn|bos|eos|pad|unk|eot)>|\[\/?INST\]|<<\/?SYS>>|<\/s>/g;

/** Blocks removed with their content: reasoning, folded details, tag dumps, tool calls, trackers of other add-ons. */
const HIDDEN_BLOCK_RE =
    /<(think|thinking|reasoning|details|bunnymotags|tool_calls?|function_calls?|function_results?|script|style|iframe|noscript|head|title|horae|status|tracker)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
/** A reasoning tail whose opening tag was in the prefill: everything up to a lone closing tag. */
const LONE_THINK_END_RE = /^[\s\S]*?<\/(?:think|thinking|reasoning)\s*>/i;
const THINK_OPEN_RE = /<(?:think|thinking|reasoning)\b/i;
const FIGURE_RE = /<figure\b[\s\S]*?<\/figure\s*>/gi;
/** An `<img>` tag with quoted attributes (a NAI marker's JSON may hold `>`). */
const IMG_TAG_RE = /<img\b(?:[^>"']|"[^"]*"|'[^']*')*>/gi;
const IIG_MARKER_RE = /\[IMG:GEN:\{[\s\S]*?\}\]/g;
const COMMENT_RE = /<!--[\s\S]*?-->/g;
/** Any tag left after the HTML pass: BunnyMo `<SPECIES:ELF>`, `<INTJ-U>`, `<NPC name="…">`, custom tags. */
const ANY_TAG_RE = /<\/?\p{L}[^<>\n]{0,200}>/gu;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/g;

/* ------------------------------------------------------------------ fenced blocks */

export interface FenceBlock {
    /** Offset of the opening fence line. */
    start: number;
    /** End (exclusive) of the closing fence line, without its line break; text end for an unclosed block. */
    end: number;
    /** Info string after the opening fence (` ```json ` → `json`). */
    info: string;
    body: string;
    closed: boolean;
}

const FENCE_LINE_RE = /^[ \t]*```/;

/** Fenced code blocks of a text with offsets (line scanner: an unclosed fence runs to the end). */
export function fenceBlocks(text: string): FenceBlock[] {
    const blocks: FenceBlock[] = [];
    if (!text.includes('```')) return blocks;
    let open: { start: number; info: string; bodyStart: number } | null = null;
    let pos = 0;
    for (;;) {
        const newline = text.indexOf('\n', pos);
        const lineEnd = newline < 0 ? text.length : newline;
        const line = text.slice(pos, lineEnd).replace(/\r$/, '');
        if (FENCE_LINE_RE.test(line)) {
            const after = line.replace(FENCE_LINE_RE, '');
            if (open) {
                const body = text.slice(open.bodyStart, pos).replace(/\r?\n$/, '');
                blocks.push({ start: open.start, end: lineEnd, info: open.info, body, closed: true });
                open = null;
            } else if (after.includes('```')) {
                const body = after.slice(0, after.indexOf('```'));
                blocks.push({ start: pos, end: lineEnd, info: '', body, closed: true });
            } else {
                open = {
                    start: pos,
                    info: after.trim().toLowerCase(),
                    bodyStart: newline < 0 ? text.length : lineEnd + 1,
                };
            }
        }
        if (newline < 0) break;
        pos = newline + 1;
    }
    if (open) {
        blocks.push({
            start: open.start,
            end: text.length,
            info: open.info,
            body: text.slice(open.bodyStart),
            closed: false,
        });
    }
    return blocks;
}

const TRACKER_KEY_RE = /"(?:quests|infoBox|infobox|characterThoughts|characters)"\s*:/;

/** The block body is DES tracker data (an object with one of DES's sections; broken JSON is accepted). */
export function isTrackerBody(body: string): boolean {
    const trimmed = body.trim();
    return trimmed.startsWith('{') && TRACKER_KEY_RE.test(trimmed);
}

function removeFences(text: string): string {
    const blocks = fenceBlocks(text);
    if (!blocks.length) return text;
    let out = '';
    let cursor = 0;
    for (const block of blocks) {
        out += `${text.slice(cursor, block.start)}\n`;
        cursor = block.end;
    }
    return out + text.slice(cursor);
}

/* ------------------------------------------------------------------ story text */

/** NAI Studio markers in all formats (with their `<figure>`), comments included. */
export function stripImageMarkers(text: string): string {
    return text.replace(COMMENT_RE, '').replace(FIGURE_RE, '\n').replace(IMG_TAG_RE, '').replace(IIG_MARKER_RE, '');
}

function tidy(text: string): string {
    return text
        .replace(/[\u00a0\u202f]/g, ' ')
        .replace(/[ \t]+$/gm, '')
        .replace(/^[ \t]+/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Story text of a reply: no service tokens, DES tracker JSON, fenced blocks, reasoning/details/tag blocks, NAI
 * markers and placeholders, HTML or other tags, URLs; tidy whitespace. Never shown to anyone: analysis only.
 */
export function storyText(raw: string): string {
    let text = String(raw ?? '')
        .replace(/\r\n?/g, '\n')
        .replace(SERVICE_TOKEN_RE, '');
    text = stripDesTrackerJson(text);
    text = removeFences(text);
    if (!THINK_OPEN_RE.test(text)) text = text.replace(LONE_THINK_END_RE, '');
    text = text.replace(HIDDEN_BLOCK_RE, '\n');
    text = stripImageMarkers(text);
    text = stripCkDumps(text);
    text = stripNaiPlaceholders(text);
    text = stripHtml(text);
    text = text.replace(ANY_TAG_RE, '').replace(URL_RE, '');
    return tidy(text);
}

/* ------------------------------------------------------------------ units */

/** Non-empty lines (models write one paragraph per line). */
export function splitParagraphs(text: string): string[] {
    return text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
}

const SENTENCE_SPLIT_RE = /(?<=[.!?…]["»”’')\]*_]*)\s+/u;

/** Sentences of a text: paragraphs split after terminal punctuation (with closing quotes and emphasis). */
export function splitSentences(text: string): string[] {
    const out: string[] = [];
    for (const paragraph of splitParagraphs(text)) {
        for (const sentence of paragraph.split(SENTENCE_SPLIT_RE)) {
            const trimmed = sentence.trim();
            if (trimmed) out.push(trimmed);
        }
    }
    return out;
}

export interface SpeechSplit {
    /** The prose without dialogue (quoted speech and the speech parts of dash lines), line structure kept. */
    narration: string;
    /** Spoken parts. */
    dialogue: string[];
    /** Author's words after a speech part of a dash line («— …, — сказал Кай.» → «сказал Кай.»), with the speech. */
    attributions: { speech: string; words: string }[];
}

const DASH_LINE_RE = /^[*_]*[—–-][ \t]*/;
const DASH_SPLIT_RE = /[ \t][—–][ \t]/;
const QUOTED_RE = /«[^«»\n]*»|“[^“”\n]*”|„[^„“”\n]*[“”]|"[^"\n]*"/g;

/**
 * Narration and dialogue of the prose. A line opening with a dash is Russian dialogue: its parts between spaced
 * dashes alternate speech and author's words. Quoted segments («…», “…”, "…") are speech anywhere.
 */
export function splitSpeech(prose: string): SpeechSplit {
    const dialogue: string[] = [];
    const attributions: { speech: string; words: string }[] = [];
    const lines: string[] = [];
    for (const line of prose.split('\n')) {
        let narration = line;
        if (DASH_LINE_RE.test(line)) {
            const parts = line.replace(DASH_LINE_RE, '').split(DASH_SPLIT_RE);
            const kept: string[] = [];
            parts.forEach((part, index) => {
                if (index % 2 === 0) {
                    dialogue.push(part);
                } else {
                    kept.push(part);
                    attributions.push({ speech: parts[index - 1] ?? '', words: part });
                }
            });
            narration = kept.join(' ');
        }
        narration = narration.replace(QUOTED_RE, (quoted) => {
            dialogue.push(quoted.slice(1, -1));
            return ' ';
        });
        lines.push(narration);
    }
    return { narration: lines.join('\n'), dialogue, attributions };
}

/* ------------------------------------------------------------------ quotes and languages */

/** A quote for a defect: whitespace runs with line breaks become one space, at most QUOTE_CHARS characters. */
export function clip(text: string, max = QUOTE_CHARS): string {
    const flat = text.replace(/\s*\n\s*/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1).trimEnd()}…` : flat;
}

/** The sentence around a match (`index`, `length` in `source`), clipped. */
export function contextQuote(source: string, index: number, length: number): string {
    let start = index;
    const leftLimit = Math.max(0, index - 60);
    while (start > leftLimit && !/[.!?…\n]/.test(source[start - 1] ?? '')) start--;
    let end = index + length;
    const rightLimit = Math.min(source.length, end + 100);
    while (end < rightLimit && !/[.!?…\n]/.test(source[end] ?? '')) end++;
    if (end < source.length && /[.!?…]/.test(source[end] ?? '')) end++;
    return clip(source.slice(start, end));
}

/** 'ru', 'en', … from a code or a name ('ru-RU', 'Russian', 'русский'); '' when unknown. */
export function normalizeLanguage(language: string | null | undefined): string {
    const value = String(language ?? '')
        .trim()
        .toLowerCase();
    if (!value) return '';
    if (value.startsWith('рус') || value.startsWith('russ')) return 'ru';
    if (value.startsWith('англ') || value.startsWith('engl')) return 'en';
    const code = /^[a-z]{2,3}/.exec(value)?.[0] ?? '';
    return code === 'eng' ? 'en' : code === 'rus' ? 'ru' : code.slice(0, 2);
}

const LANGUAGE_NAMES: Record<string, string> = {
    ru: 'Russian',
    en: 'English',
    uk: 'Ukrainian',
    be: 'Belarusian',
    bg: 'Bulgarian',
    sr: 'Serbian',
    kk: 'Kazakh',
    de: 'German',
    fr: 'French',
    es: 'Spanish',
    it: 'Italian',
    pt: 'Portuguese',
    pl: 'Polish',
    cs: 'Czech',
    nl: 'Dutch',
    tr: 'Turkish',
    ja: 'Japanese',
    zh: 'Chinese',
    ko: 'Korean',
};

/** English name of a language code for instructions to the model. */
export function languageName(code: string): string {
    return LANGUAGE_NAMES[code] ?? (code || 'the language of the chat');
}

/* ------------------------------------------------------------------ prepared input */

export interface PreparedReply {
    prose: string;
    paragraphs: string[];
    sentences: string[];
    speech: SpeechSplit;
    narrationSentences: string[];
    language: string;
}

const prepared = new WeakMap<QualityInput, PreparedReply>();

/** Story text and its units for a reply, computed once per input object (all checks share it). */
export function prepareReply(input: QualityInput): PreparedReply {
    const cached = prepared.get(input);
    if (cached) return cached;
    const prose = storyText(input.reply?.text ?? '');
    const speech = splitSpeech(prose);
    const result: PreparedReply = {
        prose,
        paragraphs: splitParagraphs(prose),
        sentences: splitSentences(prose),
        speech,
        narrationSentences: splitSentences(speech.narration),
        language: normalizeLanguage(input.language),
    };
    prepared.set(input, result);
    return result;
}

const HISTORY_CACHE_LIMIT = 64;
const historyCache = new Map<string, string>();

/** Story text of an earlier message (small LRU cache: the same history is checked turn after turn). */
export function historyProse(message: QualityMessage): string {
    const text = String(message?.text ?? '');
    const cached = historyCache.get(text);
    if (cached !== undefined) {
        historyCache.delete(text);
        historyCache.set(text, cached);
        return cached;
    }
    const prose = storyText(text);
    historyCache.set(text, prose);
    if (historyCache.size > HISTORY_CACHE_LIMIT) {
        const oldest = historyCache.keys().next().value;
        if (oldest !== undefined) historyCache.delete(oldest);
    }
    return prose;
}

/** The last `count` assistant messages of the history with story text, oldest first. */
export function recentReplies(history: readonly QualityMessage[] | undefined, count: number): string[] {
    const out: string[] = [];
    const list = history ?? [];
    for (let i = list.length - 1; i >= 0 && out.length < count; i--) {
        const message = list[i];
        if (!message || message.isUser) continue;
        const prose = historyProse(message);
        if (prose) out.unshift(prose);
    }
    return out;
}

/** Story text of the last user message ('' when none). */
export function lastUserProse(history: readonly QualityMessage[] | undefined): string {
    const list = history ?? [];
    for (let i = list.length - 1; i >= 0; i--) {
        const message = list[i];
        if (message?.isUser) return historyProse(message);
    }
    return '';
}
