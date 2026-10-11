// «Сцена и вокруг» (M43): the scene and the world around it are kept apart. The model narrates only the characters
// present and writes what happens elsewhere after the scene as one block, `<offscreen>…</offscreen>`. This file reads
// and rewrites that block in a reply:
// - for analysis: the scene without the block (text-clean.ts cleanForAnalysis, quality-text.ts storyText);
// - for the prompt: a recent reply keeps it as one plain bracket line `[Elsewhere, not in the scene: …]` (no tags: it
//   survives the «Clean HTML» prompt regex of DES), an older one loses it;
// - for the display: ST's formatter hooks (stage beforeRegex, then afterMarkdown) turn it into one folded
//   `<details>` under the scene (features/sceneSplit/display.ts), so it never reaches DES chat bubbles as narration.
// A reply that copies the bracket line of the prompt history instead of writing the tag counts as a block too.
// Pure: no DOM, no SillyTavern.

export const OFFSCREEN_TAG = 'offscreen';
/** The words the prompt keeps of a recent block (English: the prompt's language). */
export const ELSEWHERE_PREFIX = 'Elsewhere, not in the scene:';
/** Longest bracket line kept in the prompt. */
export const ELSEWHERE_MAX_CHARS = 600;

/** Display markers between the two formatter stages: letters only (Markdown, quotes and regexes leave them alone). */
export const AROUND_OPEN = 'MAESTROAROUNDOPEN';
export const AROUND_CLOSE = 'MAESTROAROUNDCLOSE';
/** The data attribute of the folded box (classes are renamed `custom-…` by ST's sanitizer, attributes are not). */
export const AROUND_ATTR = 'data-maestro-around';

export interface OffscreenBlock {
    start: number;
    end: number;
    /** Raw text inside the block (tags of the block removed). */
    body: string;
    /** The closing tag was there (false: the block runs to the end of the text, a reply being written or cut). */
    closed: boolean;
    form: 'tag' | 'bracket';
}

const BLOCK_RE = /<offscreen\b[^<>]*>([\s\S]*?)(?:<\/offscreen\s*>|$)/gi;
const STRAY_CLOSE_RE = /<\/offscreen\s*>/gi;
const BRACKET_RE = /^[ \t]*\[[ \t]*Elsewhere,[ \t]*not in the scene:[ \t]*([^\]\n]*)\][ \t]*$/gim;
/** Quick test: nothing to do for most messages. */
const ANY_RE = /<\/?offscreen\b|\[[ \t]*elsewhere,/i;
const TAG_RE = /<\/?[A-Za-z][^<>]*>/g;

/** The text has an offscreen block (or a stray tag of one). */
export function hasOffscreen(text: unknown): boolean {
    return typeof text === 'string' && ANY_RE.test(text);
}

/** The blocks of a text in order: `<offscreen>…</offscreen>` (also unclosed at the end) and copied bracket lines. */
export function findOffscreen(text: string): OffscreenBlock[] {
    if (!hasOffscreen(text)) return [];
    const blocks: OffscreenBlock[] = [];
    for (const match of text.matchAll(BLOCK_RE)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        blocks.push({ start, end, body: match[1] ?? '', closed: /<\/offscreen\s*>$/i.test(match[0]), form: 'tag' });
    }
    for (const match of text.matchAll(BRACKET_RE)) {
        const start = match.index ?? 0;
        const end = start + match[0].length;
        if (blocks.some((block) => block.form === 'tag' && start < block.end && end > block.start)) continue;
        blocks.push({ start, end, body: match[1] ?? '', closed: true, form: 'bracket' });
    }
    return blocks.sort((a, b) => a.start - b.start);
}

function tidyJoin(text: string): string {
    return text
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s+$/, '');
}

/** The text without its blocks (and stray closing tags); a text without them comes back unchanged. */
export function stripOffscreen(text: string): string {
    if (typeof text !== 'string') return '';
    const blocks = findOffscreen(text);
    if (!blocks.length) return hasOffscreen(text) ? text.replace(STRAY_CLOSE_RE, '') : text;
    let out = '';
    let cursor = 0;
    for (const block of blocks) {
        out += text.slice(cursor, block.start);
        cursor = block.end;
    }
    out += text.slice(cursor);
    return tidyJoin(out.replace(STRAY_CLOSE_RE, ''));
}

/** A block's words as one line: tags out, whitespace collapsed, brackets turned into parentheses. */
export function plainBody(body: string): string {
    return String(body ?? '')
        .replace(TAG_RE, ' ')
        .replace(/\[/g, '(')
        .replace(/\]/g, ')')
        .replace(/\s+/g, ' ')
        .trim();
}

/** What the blocks of a text say, one line each (empty blocks left out). */
export function offscreenLines(text: string): string[] {
    return findOffscreen(text)
        .map((block) => plainBody(block.body))
        .filter(Boolean);
}

function cutAt(text: string, max: number): string {
    if (text.length <= max) return text;
    const cut = text.slice(0, max - 1);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** The bracket line a recent reply keeps in the prompt ('' when nothing was said). */
export function elsewhereLine(lines: readonly string[]): string {
    const words = lines.map(plainBody).filter(Boolean).join(' ');
    return words ? `[${ELSEWHERE_PREFIX} ${cutAt(words, ELSEWHERE_MAX_CHARS)}]` : '';
}

/**
 * The prompt form of a reply: its blocks removed; with `keep`, one bracket line of what they said goes after the scene.
 * A text without blocks comes back unchanged.
 */
export function promptForm(text: string, keep: boolean): string {
    if (typeof text !== 'string' || !hasOffscreen(text)) return typeof text === 'string' ? text : '';
    const lines = offscreenLines(text);
    const scene = stripOffscreen(text);
    const line = keep ? elsewhereLine(lines) : '';
    if (!line) return scene;
    return scene.trim() ? `${scene}\n\n${line}` : line;
}

/* ------------------------------------------------------------------ prompt entries */

export interface PromptEntryInput {
    /** The text ST put into the prompt (after its prompt regexes, reasoning and attachments). */
    mes: string;
    /** The stored text of the assistant reply it came from; null for other entries or when it was not found. */
    live: string | null;
    /** The regex depth ST gave the entry. */
    depth: number;
}

export interface PromptRewriteOptions {
    /** Recent assistant replies that keep a bracket line of their block. */
    keep: number;
    /** The last entry is the reply being continued: its block goes without a line (the model continues the scene). */
    continued: boolean;
    /** ST's prompt regexes for an assistant reply at a depth; null without the regex engine. */
    regex: ((text: string, depth: number) => string) | null;
}

/**
 * One entry: the prompt text still has the block (no tag-stripping regex) → it is rewritten in place; otherwise ST's
 * prompt regexes are run over the stored text with and without the block and the result is put where the old one was
 * (reasoning before it and attachments after it stay). Undefined when nothing changes or the text cannot be matched.
 */
function rewriteEntry(
    entry: PromptEntryInput,
    keep: boolean,
    regex: PromptRewriteOptions['regex'],
): string | undefined {
    const live = entry.live;
    if (live === null || !hasOffscreen(live)) return undefined;
    if (hasOffscreen(entry.mes)) {
        const out = promptForm(entry.mes, keep);
        return out === entry.mes ? undefined : out;
    }
    if (!regex) return undefined;
    const before = regex(live, entry.depth);
    const after = regex(promptForm(live, keep), entry.depth);
    if (before === after || !before) return undefined;
    const at = entry.mes.lastIndexOf(before);
    if (at < 0) return undefined;
    return entry.mes.slice(0, at) + after + entry.mes.slice(at + before.length);
}

/**
 * The prompt texts of the entries with old blocks gone (undefined: unchanged): the `keep` newest assistant replies keep
 * one bracket line `[Elsewhere, not in the scene: …]`, older ones lose the block, the reply being continued too.
 */
export function rewritePromptEntries(
    entries: readonly PromptEntryInput[],
    options: PromptRewriteOptions,
): (string | undefined)[] {
    const out: (string | undefined)[] = entries.map(() => undefined);
    const keep = Math.max(0, Math.floor(options.keep));
    let rank = 0;
    for (let i = entries.length - 1; i >= 0; i--) {
        const entry = entries[i]!;
        if (entry.live === null) continue;
        const continued = options.continued && i === entries.length - 1;
        const kept = !continued && rank < keep;
        if (!continued) rank++;
        out[i] = rewriteEntry(entry, kept, options.regex);
    }
    return out;
}

/* ------------------------------------------------------------------ the instruction */

const LANGUAGE_NAMES: Record<'ru' | 'en', string> = { ru: 'Russian', en: 'English' };

/**
 * The note every normal generation gets near the end of the prompt (English, like Maestro's other notes): narrate the
 * scene only, put what happens elsewhere into one block after it, in the story's language, or leave it out.
 */
export function sceneSplitInstruction(language: 'ru' | 'en', player = ''): string {
    const who = player.trim() ? `${player.trim()} (the player)` : 'the player';
    return (
        '[Scene focus: narrate only the characters present in the current scene and what they can perceive. ' +
        'A character who has left is out of the scene: do not follow them or keep describing where they are. ' +
        "If something notable happens elsewhere this turn (an absent character's business, the world moving on), " +
        `write it after the scene as ONE block <${OFFSCREEN_TAG}>…</${OFFSCREEN_TAG}>: 1–3 short sentences in ` +
        `${LANGUAGE_NAMES[language]}. Leave the block out when nothing notable happens. Never put the characters ` +
        `present or ${who} in it.]`
    );
}

/* ------------------------------------------------------------------ display */

/** The longest unfinished tag a reply being written may end with (`<offs`, `</offscr`). */
const PARTIAL_TAG_RE = /<\/?o(?:f(?:f(?:s(?:c(?:r(?:e(?:e(?:n)?)?)?)?)?)?)?)?$/i;

/**
 * Stage beforeRegex of ST's formatter: the blocks leave the scene and come back once, after it, between two marker
 * paragraphs (Markdown still formats their words). A reply being written may end inside a block or inside its tag: the
 * open block is shown folded already, a half-written tag is hidden. Text without blocks comes back unchanged.
 */
export function markForDisplay(text: string): string {
    if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
    let source = text;
    const partial = PARTIAL_TAG_RE.exec(source);
    if (partial && partial[0].length >= 3) source = source.slice(0, partial.index);
    if (!hasOffscreen(source)) return source;
    const blocks = findOffscreen(source);
    const bodies = blocks.map((block) => block.body.trim()).filter(Boolean);
    const scene = stripOffscreen(source);
    if (!bodies.length) return scene;
    return `${scene}\n\n${AROUND_OPEN}\n\n${bodies.join('\n\n')}\n\n${AROUND_CLOSE}\n`;
}

const OPEN_MARK_RE = new RegExp(`(?:<p>\\s*)?${AROUND_OPEN}(?:\\s*(?:<br\\s*\\/?>)?\\s*<\\/p>)?`);
const CLOSE_MARK_RE = new RegExp(`(?:<p>\\s*)?(?:<br\\s*\\/?>\\s*)?${AROUND_CLOSE}(?:\\s*<\\/p>)?`);
const STRAY_MARK_RE = new RegExp(`${AROUND_OPEN}|${AROUND_CLOSE}`, 'g');

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * `<font color>` inside the box becomes a coloured `<span>`: DES chat bubbles split narration at font tags, and with its
 * «skip styled blocks» off the box would be cut into speaker cards.
 */
function fontsToSpans(html: string): string {
    if (!/<font\b/i.test(html)) return html;
    return html
        .replace(/<font\b([^<>]*)>/gi, (_whole, attrs: string) => {
            const color = /\bcolor\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(attrs);
            const value = (color?.[1] ?? color?.[2] ?? color?.[3] ?? '').replace(/[^#\w(),.%\s-]/g, '').trim();
            return value ? `<span style="color: ${value}">` : '<span>';
        })
        .replace(/<\/font\s*>/gi, '</span>');
}

/**
 * The folded box. The wrapper's inline style (margin and colour) is what DES chat bubbles take for a styled block of a
 * preset and leave whole (chatBubbles.js applyChatBubbles, `skipStyledDivs`, on by default); with that option off DES
 * puts the `<details>` as it is into one narration card.
 */
export function aroundBox(innerHtml: string, label: string): string {
    return (
        `<div class="maestro-around" ${AROUND_ATTR}="1" style="margin: 0.5em 0 0; padding: 0; color: inherit;">` +
        `<details class="maestro-around-box" ${AROUND_ATTR}="box">` +
        `<summary class="maestro-around-summary">${escapeHtml(label)}</summary>` +
        `<div class="maestro-around-body">${fontsToSpans(innerHtml.trim())}</div>` +
        '</details></div>'
    );
}

/**
 * Stage afterMarkdown of ST's formatter: the HTML between the markers goes into the folded box at the very end of the
 * message, outside any paragraph. Without both markers the HTML comes back without them.
 */
export function wrapDisplay(html: string, label: string): string {
    if (typeof html !== 'string' || !html.includes(AROUND_OPEN)) {
        return typeof html === 'string' && html.includes(AROUND_CLOSE) ? html.replace(STRAY_MARK_RE, '') : html;
    }
    const open = OPEN_MARK_RE.exec(html);
    if (!open) return html.replace(STRAY_MARK_RE, '');
    const afterOpen = open.index + open[0].length;
    const rest = html.slice(afterOpen);
    const close = CLOSE_MARK_RE.exec(rest);
    const inner = close ? rest.slice(0, close.index) : rest;
    const after = close ? rest.slice(close.index + close[0].length) : '';
    const before = html.slice(0, open.index);
    const body = inner.replace(/^\s*<\/p>/, '').replace(/<p>\s*$/, '');
    if (!body.replace(/<[^<>]*>/g, '').trim()) return `${before}${after}`.replace(STRAY_MARK_RE, '');
    return `${before.trimEnd()}${after.trim() ? after : ''}${aroundBox(body, label)}`.replace(STRAY_MARK_RE, '');
}
