// Story text of a chat message for Maestro's analysis modules (plan §10.13, M22 «Дампы CK»). Messages carry
// service noise that must never reach an analysis prompt or a text heuristic:
// - DES together mode: the tracker JSON block at the start of the reply (research/des.md §together, pitfall 7);
// - CarrotKernel "thinking" display: a `<BunnyMoTags>` dump appended to `mes` and saved (research/
//   bunnymo-carrotkernel.md §3.2 item 6; same detection as DES-RU src/lib/carrot-data.js stripCarrotDumps);
// - NAI Studio: `[nai:img:<id>]` placeholders of inline images, and whole picture posts (research/
//   qvink-nai-studio.md §B5);
// - HTML from models, DES-RU and regexes;
// - a mechanics service block (M25) the mechanics module has not stripped yet.
// Pure: no DOM, no SillyTavern.
import { stripBlock } from './mechanics-block';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ HTML element names */

/** Names of real HTML elements (lower case). BunnyMo tags (`<SPECIES:ELF>`, `<PHYSICAL>`) are not among them. */
// prettier-ignore
const HTML_ELEMENTS: ReadonlySet<string> = new Set([
    'a', 'abbr', 'address', 'area', 'article', 'aside', 'audio', 'b', 'base', 'bdi', 'bdo', 'big', 'blink',
    'blockquote', 'body', 'br', 'button', 'canvas', 'caption', 'center', 'cite', 'code', 'col', 'colgroup',
    'data', 'datalist', 'dd', 'del', 'details', 'dfn', 'dialog', 'dir', 'div', 'dl', 'dt', 'em', 'embed',
    'fieldset', 'figcaption', 'figure', 'font', 'footer', 'form', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'head',
    'header', 'hgroup', 'hr', 'html', 'i', 'iframe', 'img', 'input', 'ins', 'kbd', 'label', 'legend', 'li',
    'link', 'main', 'map', 'mark', 'marquee', 'math', 'menu', 'meta', 'meter', 'nav', 'nobr', 'noscript',
    'object', 'ol', 'optgroup', 'option', 'output', 'p', 'param', 'picture', 'pre', 'progress', 'q', 'rp', 'rt',
    'ruby', 's', 'samp', 'script', 'search', 'section', 'select', 'slot', 'small', 'source', 'span', 'strike',
    'strong', 'style', 'sub', 'summary', 'sup', 'svg', 'table', 'tbody', 'td', 'template', 'textarea', 'tfoot',
    'th', 'thead', 'time', 'title', 'tr', 'track', 'tt', 'u', 'ul', 'var', 'video', 'wbr',
]);

/** Elements whose tags separate lines of text. */
// prettier-ignore
const BLOCK_ELEMENTS: ReadonlySet<string> = new Set([
    'address', 'article', 'aside', 'blockquote', 'br', 'center', 'dd', 'details', 'div', 'dl', 'dt', 'figcaption',
    'figure', 'footer', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'header', 'hr', 'li', 'main', 'nav', 'ol', 'p', 'pre',
    'section', 'summary', 'table', 'tr', 'ul',
]);

/**
 * True for a real HTML element name (any case), or a custom element (lower case with a hyphen — `<INTJ-U>` is a
 * BunnyMo tag, not an element).
 */
export function isHtmlElementName(name: string): boolean {
    return HTML_ELEMENTS.has(name.toLowerCase()) || /^[a-z][a-z0-9]*-[a-z0-9-]+$/.test(name);
}

/* ------------------------------------------------------------------ DES tracker JSON */

const TRACKER_KEYS = ['quests', 'infoBox', 'infobox', 'characterThoughts', 'characters'];
const TRACKER_KEY_RE = /"(?:quests|infoBox|infobox|characterThoughts|characters)"\s*:/;
/** A fence at the very start: ```json, ```markdown, ```md or a bare ```; the body runs to the closing fence. */
const LEADING_FENCE_RE = /^\s*```(?:json|markdown|md)?[ \t]*\r?\n([\s\S]*?)\r?\n?[ \t]*```[ \t]*(?:\r?\n|$)/i;

/** End index (exclusive) of the balanced `{…}` starting at `start`, strings respected; -1 when unbalanced. */
function balancedObjectEnd(text: string, start: number): number {
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const char = text[i];
        if (escaped) {
            escaped = false;
        } else if (char === '\\') {
            escaped = inString;
        } else if (char === '"') {
            inString = !inString;
        } else if (!inString) {
            if (char === '{') depth++;
            else if (char === '}') {
                depth--;
                if (depth === 0) return i + 1;
            }
        }
    }
    return -1;
}

/** The JSON text is DES tracker data: an object with one of DES's sections (parsed or, if broken, by its keys). */
function looksLikeTracker(json: string): boolean {
    const body = json.trim();
    if (!body.startsWith('{')) return false;
    try {
        const parsed: unknown = JSON.parse(body);
        return isDict(parsed) && TRACKER_KEYS.some((key) => key in parsed);
    } catch {
        // Models write broken JSON and DES still reads it (brace matching): fall back to the section keys.
        return TRACKER_KEY_RE.test(body);
    }
}

/**
 * Removes the DES tracker JSON that opens a reply in together mode: a leading ```json fence (or ```markdown / a
 * bare fence) whose body is tracker JSON, or an unfenced leading JSON object with tracker sections. Any other
 * code block or JSON is kept.
 */
export function stripDesTrackerJson(text: string): string {
    if (typeof text !== 'string' || !text) return typeof text === 'string' ? text : '';
    const fence = LEADING_FENCE_RE.exec(text);
    if (fence) {
        return looksLikeTracker(fence[1] ?? '') ? text.slice(fence[0].length).replace(/^\s+/, '') : text;
    }
    const start = text.search(/\S/);
    if (start < 0 || text[start] !== '{') return text;
    const end = balancedObjectEnd(text, start);
    if (end < 0 || !looksLikeTracker(text.slice(start, end))) return text;
    return text.slice(end).replace(/^\s+/, '');
}

/* ------------------------------------------------------------------ HTML */

const NAMED_ENTITIES: Record<string, string> = {
    lt: '<',
    gt: '>',
    quot: '"',
    apos: "'",
    nbsp: ' ',
    amp: '&',
};

function decodeEntities(text: string): string {
    if (!text.includes('&')) return text;
    return text.replace(/&(#x[0-9a-f]{1,6}|#[0-9]{1,7}|[a-z]+);/gi, (whole, body: string) => {
        if (body[0] === '#') {
            const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
}

/**
 * Removes HTML: comments, `<style>`/`<script>` blocks with their content, and tags of real HTML elements (block
 * tags become line breaks); entities are decoded. Tags that are not HTML (`<SPECIES:ELF>`, `<PHYSICAL>`,
 * `<STYLE:GOTHIC>`) stay: a tag name must be followed by whitespace, `/` or `>` to count as HTML.
 */
export function stripHtml(text: string): string {
    if (typeof text !== 'string') return '';
    if (!text.includes('<') && !text.includes('&')) return text;
    const stripped = text
        .replace(/<!--[\s\S]*?-->/g, '')
        .replace(/<(style|script)(?=[\s>])[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
        .replace(/<\/?([A-Za-z][A-Za-z0-9-]*)(?=[\s/>])[^<>]*>/g, (whole, name: string) => {
            if (!isHtmlElementName(name)) return whole;
            return BLOCK_ELEMENTS.has(name.toLowerCase()) ? '\n' : '';
        });
    return decodeEntities(stripped);
}

/* ------------------------------------------------------------------ CarrotKernel dumps */

/** The block CK appends in "thinking" display mode: `<BunnyMoTags>`, then "Name:" and "• CATEGORY: values" lines. */
const DUMP_BLOCK_RE = /(\n[ \t]*)*<BunnyMoTags>\n?([\s\S]*?)<\/BunnyMoTags>/g;

/**
 * The body is a CK dump: only "Name:" and "• CATEGORY: values" lines (categories may be missing — CK skips tags
 * saved as arrays), no `<KEY:VALUE>` tags. A BunnyMo sheet looks different and is kept.
 */
export function isCkDumpBody(body: string): boolean {
    const lines = String(body ?? '')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);
    if (!lines.length || /<[A-Za-z][A-Za-z0-9_]*:/.test(body)) return false;
    return lines.every((line) => line.startsWith('•') || line.endsWith(':'));
}

/** Removes CarrotKernel's `<BunnyMoTags>` dumps (with the blank lines before them); sheets are kept. */
export function stripCkDumps(text: string): string {
    if (typeof text !== 'string' || !text.includes('<BunnyMoTags>')) return typeof text === 'string' ? text : '';
    return text.replace(DUMP_BLOCK_RE, (whole: string, _spacing: string | undefined, body: string) =>
        isCkDumpBody(body) ? '' : whole,
    );
}

/* ------------------------------------------------------------------ NAI Studio */

const NAI_PLACEHOLDER_RE = /[ \t]*\[nai:img:[^\]\s]{1,80}\][ \t]*/g;

/**
 * Removes NAI Studio's inline image placeholders `[nai:img:<id>]` with the spaces around them; inside a line one
 * space keeps the words apart.
 */
export function stripNaiPlaceholders(text: string): string {
    if (typeof text !== 'string') return '';
    if (!text.includes('[nai:img:')) return text;
    return text.replace(NAI_PLACEHOLDER_RE, (match: string, offset: number, whole: string) => {
        const before = whole[offset - 1];
        const after = whole[offset + match.length];
        const lineEdge = before === undefined || before === '\n' || after === undefined || after === '\n';
        return lineEdge ? '' : ' ';
    });
}

/**
 * A picture post (NAI Studio `postToChat`): `extra.nai_studio` on the message, or a gallery whose every item carries
 * NAI metadata while the text is empty or just the image prompt. A story reply illustrated later (paintbrush) keeps
 * its own text and is not a picture post.
 */
export function isImagePost(message: unknown): boolean {
    if (!isDict(message) || !isDict(message.extra)) return false;
    const extra = message.extra;
    if (isDict(extra.nai_studio)) return true;
    const media = extra.media;
    if (!Array.isArray(media) || !media.length || !media.every((item) => isDict(item) && isDict(item.nai_studio))) {
        return false;
    }
    const text = typeof message.mes === 'string' ? message.mes.trim() : '';
    if (!text) return true;
    return media.some((item) => {
        const meta = (item as Dict).nai_studio as Dict;
        const title = (item as Dict).title;
        return (typeof title === 'string' && title.trim() === text) || meta.prompt === text;
    });
}

/* ------------------------------------------------------------------ all together */

function normalizeWhitespace(text: string): string {
    return text
        .replace(/\r\n?/g, '\n')
        .replace(/[ \t]+$/gm, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/**
 * Story text of a message (or of a raw string) for analysis: picture posts give '', otherwise the text without
 * the DES tracker JSON, CK dumps, NAI placeholders and HTML, with tidy whitespace.
 */
export function cleanForAnalysis(message: unknown): string {
    if (typeof message !== 'string' && isImagePost(message)) return '';
    const raw = typeof message === 'string' ? message : isDict(message) ? message.mes : undefined;
    if (typeof raw !== 'string' || !raw) return '';
    let text = stripDesTrackerJson(raw);
    text = stripCkDumps(text);
    text = stripNaiPlaceholders(text);
    text = stripBlock(text);
    text = stripHtml(text);
    return normalizeWhitespace(text);
}
