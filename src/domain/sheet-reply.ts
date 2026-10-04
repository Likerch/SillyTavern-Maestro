// BunnyMo sheet replies (M31 п. 3, п. 9): where the sheet ends, what the model added after it (a scene
// continuation, DES tracker JSON) and which tags the sheet carries. Pure text logic; the feature applies it.
//
// Shapes handled (research/bunnymo-carrotkernel.md §1.2-1.3, BunnyMo core #2-#7, tools/mock-llm sheetText):
// - fullsheet / quicksheet: `## SECTION n/m` sections, a TAG SYNTHESIS `<BunnymoTags>…</BunnymoTags>` block, then an
//   optional "✨ … COMPLETE ✨" banner with a bold subtitle and an italic note between `---` rules;
// - tagsheet: several `<BunnymoTags>` blocks with tag lists between them;
// - memsheet / updatesheet / physheet: markdown sections closing with a "**✓ … COMPLETE / CATALOGUED**" banner;
// - DES together mode: one ```json tracker block, normally at the start of a reply, here possibly at the end;
// - CarrotKernel "thinking" mode: a `<BunnyMoTags>` dump (lines "Name:" / "• CATEGORY: values") appended to `mes`.
//
// The cut is conservative: only a run of plain prose paragraphs at the very end, after something that is clearly a
// sheet, is removed. Anything with markdown structure or tags stays.
import { isCkDumpBody, stripDesTrackerJson } from './text-clean';

export interface SheetTrimResult {
    /** The reply without tracker JSON and without the trailing scene. */
    text: string;
    changed: boolean;
    /** The cleaned text looks like a BunnyMo sheet. */
    isSheet: boolean;
    /** DES tracker blocks removed. */
    trackerBlocks: number;
    /** Removed scene continuation ('' when none). */
    tail: string;
}

export interface SheetTagReport {
    /** `<Name:…>` of the reply's sheet block, as written. */
    name: string | null;
    /** `<Name:…>` of the archive block. */
    archiveName: string | null;
    /** Normalised `KEY:VALUE` tags (and bare MBTI `XXXX-H`) inside the reply's sheet blocks. */
    reply: string[];
    /** The same for the stored archive. */
    archive: string[];
    /** In the reply, missing from the archive. */
    missing: string[];
    /** In the archive, not in the reply. */
    added: string[];
    /** Tags the reply has only outside its `<BunnymoTags>` blocks (they never reach an archive). */
    outside: string[];
    /** Tag-like fragments CarrotKernel cannot parse (`<SKINCOLOR,FAIR>`, parentheses inside a tag). */
    malformed: string[];
    /** Archive tags CarrotKernel's `<KEY:VALUE>` parser cannot see (bare MBTI). */
    ckInvisible: string[];
}

/** `<BunnymoTags>…</BunnymoTags>` in any case; the `<BunnymoTags:Title>` entry wrapper does not match. */
const BLOCK_RE = /<bunnymotags>([\s\S]*?)<\/bunnymotags>/gi;
const TAG_RE = /<([A-Za-z][A-Za-z0-9_-]*):([^<>\n]+)>/g;
const HAS_TAG_RE = /<[A-Za-z][A-Za-z0-9_-]*:[^<>\n]+>/;
const MBTI_RE = /<([EI][NS][FT][JP]-[UH])>/gi;
const PLACEHOLDER_RE = /^(?:BLANK|NEW|VALUE|TARGET|NAME|NAME[\s_]HERE|PLACEHOLDER|TBD|X{3,})$/i;
/** A fenced block: opening fence with an optional language, body, closing fence on its own line. */
const FENCE_RE = /(^|\n)[ \t]*```[ \t]*([A-Za-z]*)[ \t]*\n([\s\S]*?)\n[ \t]*```[ \t]*(?=\n|$)/g;
const TRACKER_KEY_RE = /"(?:infoBox|characters|quests|characterThoughts)"\s*:/;
/** CK's "thinking" dump at the end of a message (DES-RU src/lib/carrot-data.js). */
const TRAILING_DUMP_RE = /\s*<BunnyMoTags>\n?([\s\S]*?)<\/BunnyMoTags>\s*$/;
const NAI_PLACEHOLDER_RE = /\[nai:img:[^\]\n]*\]/g;
/** Marks where a tracker block was removed, so only the whitespace around it is normalised. */
const CUT_MARK = '';
const CUT_MARK_RE = /\s*(?:\s*)+/g;
const SECTION_RE = /^#{0,6}\s*\S+\s+\d+\s*\/\s*\d+/gim;

/** Completion banners of the BunnyMo templates ("✨ ANALYSIS COMPLETE ✨", "✓ MEMORY CATALOGUED") and their Russian forms. */
const BANNER_RE =
    /[✓✔✅✨][^\n]*?(?:\b(?:COMPLETE|COMPLETED|CATALOGUED|CATALOGED|ARCHIVED)\b|ЗАВЕРШ[ЁЕ]Н|ЗАВЕРШЕНО|ГОТОВ|СОСТАВЛЕН)/u;

const HEADING_RE = /^\s{0,3}#{1,6}\s/;
const RULE_RE = /^\s*(?:-{3,}|\*{3,}|_{3,}|[═━─=]{3,})\s*$/;
const LIST_RE = /^\s*(?:[-+•]|\*(?=\s)|\d{1,3}[.)])\s+/;
const BOLD_LEAD_RE = /^\s*\*\*[^*\n]+\*\*/;
const TABLE_RE = /^\s*\|.*\|\s*$/;
const TAG_LINE_RE = /^\s*<\/?[A-Za-z][\w-]*(?:[\s:>/]|$)/;
const ITALIC_LINE_RE = /^\s*[*_][^*_\s][\s\S]*[*_]\s*$/;
const OPEN_BLOCK_RE = /^\s*<([A-Za-z][\w-]*)(?:\s[^<>]*)?>/;

function hasSheetTags(body: string): boolean {
    HAS_TAG_RE.lastIndex = 0;
    MBTI_RE.lastIndex = 0;
    return HAS_TAG_RE.test(body) || MBTI_RE.test(body);
}

/** Bodies of the `<BunnymoTags>` blocks that carry tags (CK dumps excluded). */
export function sheetTagBlocks(text: string): string[] {
    const blocks: string[] = [];
    for (const match of String(text ?? '').matchAll(BLOCK_RE)) {
        const body = match[1] ?? '';
        if (hasSheetTags(body) && !isCkDumpBody(body)) blocks.push(body);
    }
    return blocks;
}

/** End offset of the last tag-carrying `<BunnymoTags>` block, -1 when there is none. */
function lastBlockEnd(text: string): number {
    let end = -1;
    for (const match of text.matchAll(BLOCK_RE)) {
        const body = match[1] ?? '';
        if (hasSheetTags(body) && !isCkDumpBody(body)) end = (match.index ?? 0) + match[0].length;
    }
    return end;
}

/** Does this text look like a BunnyMo sheet (a tag block, a completion banner, numbered sections or many tags)? */
export function looksLikeSheet(text: string): boolean {
    const value = String(text ?? '');
    if (lastBlockEnd(value) >= 0) return true;
    if (value.split('\n').some((line) => BANNER_RE.test(line))) return true;
    if ((value.match(SECTION_RE) ?? []).length >= 2) return true;
    return (value.match(new RegExp(TAG_RE.source, 'g')) ?? []).length >= 3;
}

/**
 * Removes DES tracker JSON: fenced blocks with tracker keys anywhere (a sheet reply may end with one) and an
 * unfenced tracker object at the start (text-clean's rule for together mode).
 */
export function stripTrackerBlocks(text: string): { text: string; removed: number } {
    let removed = 0;
    const source = String(text ?? '');
    const result = source.replace(FENCE_RE, (whole: string, lead: string, lang: string, body: string) => {
        const language = lang.toLowerCase();
        if ((language && language !== 'json') || !body.trim().startsWith('{') || !TRACKER_KEY_RE.test(body)) {
            return whole;
        }
        removed++;
        return `${lead}${CUT_MARK}`;
    });
    // Only the whitespace around a removed block is normalised; the rest of the sheet keeps its layout.
    let cleaned = removed ? result.replace(CUT_MARK_RE, '\n\n').trim() : source;
    const leading = stripDesTrackerJson(cleaned);
    if (leading !== cleaned) {
        removed++;
        cleaned = leading;
    }
    return { text: cleaned, removed };
}

interface Paragraph {
    start: number;
    end: number;
    structural: boolean;
    /** Every line is an italic-only line. */
    italic: boolean;
    /** Holds a completion banner or a bold-only line. */
    banner: boolean;
}

/** Splits into blank-line separated paragraphs and marks those with markdown structure, tags or open blocks. */
function paragraphs(text: string): Paragraph[] {
    const result: Paragraph[] = [];
    const lines = text.split('\n');
    const open: string[] = [];
    let offset = 0;
    let current: Paragraph | null = null;
    for (const line of lines) {
        const lineStart = offset;
        offset += line.length + 1;
        if (!line.trim()) {
            if (current) result.push(current);
            current = null;
            continue;
        }
        const insideBlock = open.length > 0;
        const structural =
            insideBlock ||
            HEADING_RE.test(line) ||
            RULE_RE.test(line) ||
            LIST_RE.test(line) ||
            BOLD_LEAD_RE.test(line) ||
            TABLE_RE.test(line) ||
            TAG_LINE_RE.test(line) ||
            HAS_TAG_RE.test(line);
        trackBlocks(line, open);
        const italic = ITALIC_LINE_RE.test(line) && !LIST_RE.test(line);
        const banner = BANNER_RE.test(line) || (BOLD_LEAD_RE.test(line) && /\*\*\s*$/.test(line));
        if (!current) current = { start: lineStart, end: lineStart + line.length, structural, italic, banner };
        else {
            current.end = lineStart + line.length;
            current.structural ||= structural;
            current.italic &&= italic;
            current.banner ||= banner;
        }
    }
    if (current) result.push(current);
    return result;
}

/** Keeps a stack of XML-like blocks (`<Linguistics>`, `<details>`) opened on a line and not closed on it. */
function trackBlocks(line: string, open: string[]): void {
    const lower = line.toLowerCase();
    for (let i = open.length - 1; i >= 0; i--) {
        if (lower.includes(`</${open[i]}`)) open.splice(i, 1);
    }
    const match = OPEN_BLOCK_RE.exec(line);
    const name = match?.[1]?.toLowerCase();
    if (!name || name.includes(':') || lower.includes(`</${name}`)) return;
    if (/^(?:br|hr|img|input|meta|link)$/.test(name)) return;
    open.push(name);
}

/**
 * Cleans a sheet reply: drops DES tracker blocks anywhere and cuts the plain prose that follows the sheet.
 * CK dumps at the end and NAI Studio image placeholders found in the cut part are kept.
 */
export function trimSheetReply(text: string): SheetTrimResult {
    const original = String(text ?? '');
    const stripped = stripTrackerBlocks(original);
    let body = stripped.text;

    const dumps: string[] = [];
    for (let match = TRAILING_DUMP_RE.exec(body); match; match = TRAILING_DUMP_RE.exec(body)) {
        if (!isCkDumpBody(match[1] ?? '')) break;
        dumps.unshift(match[0].trim());
        body = body.slice(0, match.index).trimEnd();
    }

    let tail = '';
    const list = paragraphs(body);
    let cutIndex = list.length;
    for (let i = list.length - 1; i >= 0; i--) {
        const paragraph = list[i]!;
        if (paragraph.structural) break;
        // An italic note right under a completion banner belongs to the sheet ("*This analysis provides…*").
        if (paragraph.italic && i > 0 && list[i - 1]!.banner) break;
        cutIndex = i;
    }
    if (cutIndex < list.length && cutIndex > 0) {
        const start = list[cutIndex]!.start;
        const head = body.slice(0, start).trimEnd();
        if (looksLikeSheet(head)) {
            tail = body.slice(start).trim();
            body = head;
        }
    }

    const keep = [...(tail.match(NAI_PLACEHOLDER_RE) ?? []), ...dumps];
    const result = keep.length ? `${body}\n\n${keep.join('\n\n')}` : body;
    const changed = stripped.removed > 0 || tail.length > 0;
    return {
        text: changed ? result : original,
        changed,
        isSheet: looksLikeSheet(body),
        trackerBlocks: stripped.removed,
        tail,
    };
}

/** `KEY:VALUE` with the key upper-cased and the value upper-cased, `_` → space, spaces collapsed. */
export function normalizeTag(key: string, value: string): string {
    const clean = (part: string) => part.trim().replace(/_/g, ' ').replace(/\s+/g, ' ').toUpperCase();
    return `${clean(key)}:${clean(value)}`;
}

interface TagSet {
    name: string | null;
    tags: string[];
}

function collectTags(bodies: readonly string[]): TagSet {
    let name: string | null = null;
    const tags = new Set<string>();
    for (const body of bodies) {
        for (const match of body.matchAll(TAG_RE)) {
            const key = (match[1] ?? '').trim();
            const value = (match[2] ?? '').trim();
            if (key.toUpperCase() === 'NAME') {
                name ??= value;
                continue;
            }
            if (PLACEHOLDER_RE.test(value)) continue;
            tags.add(normalizeTag(key, value));
        }
        for (const match of body.matchAll(MBTI_RE)) tags.add((match[1] ?? '').toUpperCase());
    }
    return { name, tags: [...tags] };
}

function malformedTags(bodies: readonly string[]): string[] {
    const found = new Set<string>();
    for (const body of bodies) {
        for (const match of body.matchAll(/<[A-Za-z][A-Za-z0-9_-]*(?:,[^<>\n]*|:[^<>\n]*\([^<>\n]*)>/g)) {
            found.add(match[0]);
        }
    }
    return [...found];
}

/**
 * Tag-loss check (M31 п. 9): which tags of the generated sheet did not make it into the stored archive.
 * `rawReply` is the model's reply as received, `archiveText` the archive entry content (CK repo / Baby Bunny).
 */
export function compareSheetTags(rawReply: string, archiveText: string): SheetTagReport {
    const replyBlocks = sheetTagBlocks(rawReply);
    const archiveBlocks = sheetTagBlocks(archiveText);
    const reply = collectTags(replyBlocks);
    const archive = collectTags(archiveBlocks);
    const archiveSet = new Set(archive.tags);
    const replySet = new Set(reply.tags);

    let outsideText = String(rawReply ?? '');
    for (const body of replyBlocks) outsideText = outsideText.replace(body, ' ');
    const outsideTags = collectTags([outsideText]).tags.filter((tag) => !replySet.has(tag));

    return {
        name: reply.name,
        archiveName: archive.name,
        reply: reply.tags,
        archive: archive.tags,
        missing: reply.tags.filter((tag) => !archiveSet.has(tag)),
        added: archive.tags.filter((tag) => !replySet.has(tag)),
        outside: outsideTags,
        malformed: malformedTags(replyBlocks),
        ckInvisible: archive.tags.filter((tag) => !tag.includes(':')),
    };
}
