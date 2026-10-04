// BunnyMo mode (M35 п. 7): the archive (sheet) editor's pure parts — reading a CarrotKernel archive entry and writing
// the edited sheet back with every untouched character kept as it was.
//
// An archive entry (research §1.2, §2.2; BunnyMo core #43/#44, CK Baby Bunny) holds one `<BunnymoTags>…</BunnymoTags>`
// block: `<Name:…>` (the identity: CK cache keys, RAG collections, DES sheets — never renamed), `<KEY:VALUE>` tags,
// a bare MBTI archetype `<ENTJ-U>`, and the group wrappers `<PHYSICAL>`, `<PERSONALITY>`, `<NSFW>`, `<HEALTH>`. Prose
// sections (`<Linguistics>…</linguistics>`, `<Genre>`, `<MentalHealth>`…) follow the block (Baby Bunny) or sit inside it
// (the fullsheet template); text outside any of them is kept as untitled prose. CK's `<BunnymoTags:Title>` entry
// wrapper is left alone.
//
// Writing is a list of span edits on the original text: matched tags are replaced in place, removed ones are cut with
// their separator, new ones are inserted next to tags of their category (or into their group wrapper).

export interface Span {
    start: number;
    end: number;
}

export interface SheetTagToken extends Span {
    /** Key as written (`Dere`, `TRAIT`). */
    key: string;
    /** Value as written, trimmed. */
    value: string;
}

export interface SheetMbtiToken extends Span {
    type: string;
    variant: 'H' | 'U';
}

export interface SheetSectionToken {
    /** Tag name as written (`Linguistics`, `MentalHealth`); '' for untitled prose. */
    title: string;
    /** Inner text as written. */
    text: string;
    outer: Span;
    inner: Span;
    /** Inside the `<BunnymoTags>` block (fullsheet layout). */
    inBlock: boolean;
}

export interface SheetGroupToken {
    /** PHYSICAL, PERSONALITY, NSFW, HEALTH (upper case). */
    name: string;
    open: Span;
    close: Span | null;
}

export interface ParsedSheet {
    /** `<Name:…>` value as written; null when the block has none. */
    name: string | null;
    block: { outer: Span; inner: Span } | null;
    /** `<BunnymoTags>` blocks in the entry (CK reads only the first: one entry, one character). */
    blocks: number;
    tags: SheetTagToken[];
    mbti: SheetMbtiToken[];
    groups: SheetGroupToken[];
    linguistics: SheetSectionToken | null;
    sections: SheetSectionToken[];
}

export interface SheetDraft {
    name: string;
    tags: readonly { key: string; value: string }[];
    mbti?: { type: string; variant: 'H' | 'U' };
    linguistics?: string;
    sections: readonly { title: string; text: string }[];
}

export type SheetWriteError = 'noBlock' | 'multiBlock' | 'name' | 'tag';

export type RebuildResult = { ok: true; content: string; changed: boolean } | { ok: false; error: SheetWriteError };

const BLOCK_RE = /<bunnymotags>([\s\S]*?)<\/bunnymotags>/gi;
const SECTION_RE = /<([A-Za-z][A-Za-z_]*)>([\s\S]*?)<\/\1\s*>/gi;
const TAG_RE = /<([A-Za-z][A-Za-z0-9_-]*):([^<>\n]+)>/g;
const MBTI_RE = /<([EI][NS][FT][JP])-([UH])>/gi;
const GROUP_RE = /<(\/?)(PHYSICAL|PERSONALITY|NSFW|HEALTH)>/gi;
const WRAPPER_RE = /<\/?BunnymoTags:[^>\n]*>/gi;
const STRUCTURAL: ReadonlySet<string> = new Set(['bunnymotags', 'physical', 'personality', 'nsfw', 'health']);
const KEY_RE = /^[A-Za-z][A-Za-z0-9_-]*$/;
const MBTI_TYPE_RE = /^[EI][NS][FT][JP]$/i;

/** The 16 MBTI types in the usual order. */
export const MBTI_TYPES: readonly string[] = [
    'ISTJ',
    'ISFJ',
    'INFJ',
    'INTJ',
    'ISTP',
    'ISFP',
    'INFP',
    'INTP',
    'ESTP',
    'ESFP',
    'ENFP',
    'ENTP',
    'ESTJ',
    'ESFJ',
    'ENFJ',
    'ENTJ',
];

/** Group wrapper of a tag category (BunnyMo's TAG SYNTHESIS template, core #2). */
const GROUP_OF: Readonly<Record<string, string>> = (() => {
    const groups: Record<string, string[]> = {
        PHYSICAL: [
            'SPECIES',
            'GENDER',
            'AGE',
            'BUILD',
            'SKIN',
            'SKINCOLOR',
            'SKINTONE',
            'HAIR',
            'HAIRCOLOR',
            'EYECOLOR',
            'STYLE',
            'FONT',
        ],
        PERSONALITY: [
            'DERE',
            'MBTI',
            'TRAIT',
            'ATTACHMENT',
            'CONFLICT',
            'BOUNDARIES',
            'FLIRTING',
            'DECISION',
            'COMFORT',
            'VICE',
            'LOYALTY',
            'TRUST',
            'MASK',
            'ARCHETYPE',
        ],
        NSFW: ['ORIENTATION', 'POWER', 'KINK', 'CHEMISTRY', 'AROUSAL', 'TRAUMA', 'JEALOUSY'],
        HEALTH: [
            'BSM',
            'MENTAL',
            'MOOD',
            'ANXIETY',
            'EATING',
            'DISSOCIATIVE',
            'ADDICTION',
            'SLEEP',
            'MED',
            'REC',
            'BENZO',
            'SSRI',
            'STIMULANT',
            'CONDITION',
            'MOBILITY',
            'SENSORY',
        ],
    };
    const map: Record<string, string> = {};
    for (const [group, categories] of Object.entries(groups)) for (const category of categories) map[category] = group;
    return map;
})();

/** The group wrapper (PHYSICAL…) a category belongs to, if any. */
export function groupOfCategory(category: string): string | undefined {
    return GROUP_OF[category.toUpperCase()];
}

function inside(span: Span, position: number): boolean {
    return position >= span.start && position < span.end;
}

function trimmedSpan(content: string, start: number, end: number): Span | null {
    let from = start;
    let to = end;
    while (from < to && /\s/.test(content[from] ?? '')) from++;
    while (to > from && /\s/.test(content[to - 1] ?? '')) to--;
    return from < to ? { start: from, end: to } : null;
}

/** Reads an archive entry's text (never throws; `block` is null when there is no `<BunnymoTags>` block). */
export function parseSheet(content: string): ParsedSheet {
    const blocks: { outer: Span; inner: Span }[] = [];
    for (const match of content.matchAll(BLOCK_RE)) {
        const start = match.index ?? 0;
        const whole = match[0];
        blocks.push({
            outer: { start, end: start + whole.length },
            inner: { start: start + whole.indexOf('>') + 1, end: start + whole.lastIndexOf('</') },
        });
    }
    const block = blocks[0] ?? null;

    const found: SheetSectionToken[] = [];
    SECTION_RE.lastIndex = 0;
    for (let match = SECTION_RE.exec(content); match; match = SECTION_RE.exec(content)) {
        const title = match[1] ?? '';
        const start = match.index;
        const openLength = title.length + 2;
        if (STRUCTURAL.has(title.toLowerCase())) {
            // Look inside wrappers and blocks too (the fullsheet layout keeps its prose inside the block).
            SECTION_RE.lastIndex = start + openLength;
            continue;
        }
        const end = start + match[0].length;
        const innerStart = start + openLength;
        const innerEnd = innerStart + (match[2] ?? '').length;
        found.push({
            title,
            text: match[2] ?? '',
            outer: { start, end },
            inner: { start: innerStart, end: innerEnd },
            inBlock: block !== null && inside(block.inner, start),
        });
    }
    const linguistics = found.find((section) => section.title.toLowerCase() === 'linguistics') ?? null;
    const titled = found.filter((section) => section !== linguistics);

    let name: string | null = null;
    const tags: SheetTagToken[] = [];
    const mbti: SheetMbtiToken[] = [];
    const groups: SheetGroupToken[] = [];
    if (block) {
        const prose = found.filter((section) => section.inBlock).map((section) => section.outer);
        const free = (position: number) => !prose.some((span) => inside(span, position));
        const area = content.slice(block.inner.start, block.inner.end);
        for (const match of area.matchAll(TAG_RE)) {
            const start = block.inner.start + (match.index ?? 0);
            if (!free(start)) continue;
            const key = match[1] ?? '';
            const value = (match[2] ?? '').trim();
            if (key.toUpperCase() === 'NAME') {
                name ??= value;
                continue;
            }
            tags.push({ key, value, start, end: start + match[0].length });
        }
        for (const match of area.matchAll(MBTI_RE)) {
            const start = block.inner.start + (match.index ?? 0);
            if (!free(start)) continue;
            mbti.push({
                type: (match[1] ?? '').toUpperCase(),
                variant: (match[2] ?? '').toUpperCase() === 'H' ? 'H' : 'U',
                start,
                end: start + match[0].length,
            });
        }
        for (const match of area.matchAll(GROUP_RE)) {
            const start = block.inner.start + (match.index ?? 0);
            if (!free(start)) continue;
            const group = (match[2] ?? '').toUpperCase();
            const span = { start, end: start + match[0].length };
            if (match[1] !== '/') groups.push({ name: group, open: span, close: null });
            else {
                const open = [...groups].reverse().find((item) => item.name === group && item.close === null);
                if (open) open.close = span;
            }
        }
    }

    // Untitled prose: text outside the blocks, the titled sections and CK's entry wrappers.
    const covered: Span[] = [
        ...blocks.map((item) => item.outer),
        ...found.filter((s) => !s.inBlock).map((s) => s.outer),
    ];
    for (const match of content.matchAll(WRAPPER_RE)) {
        const start = match.index ?? 0;
        if (!blocks.some((item) => inside(item.outer, start))) covered.push({ start, end: start + match[0].length });
    }
    covered.sort((a, b) => a.start - b.start);
    const loose: SheetSectionToken[] = [];
    let cursor = 0;
    const addLoose = (from: number, to: number) => {
        const span = trimmedSpan(content, from, to);
        if (!span) return;
        const text = content.slice(span.start, span.end);
        loose.push({ title: '', text, outer: span, inner: span, inBlock: false });
    };
    for (const span of covered) {
        if (span.start > cursor) addLoose(cursor, span.start);
        cursor = Math.max(cursor, span.end);
    }
    if (cursor < content.length) addLoose(cursor, content.length);

    const sections = [...titled, ...loose].sort((a, b) => a.outer.start - b.outer.start);
    return { name, block, blocks: blocks.length, tags, mbti, groups, linguistics, sections };
}

/** The editable view of a parsed sheet (what the editor shows and sends back). */
export function sheetDraftOf(parsed: ParsedSheet): SheetDraft {
    const first = parsed.mbti[0];
    return {
        name: parsed.name ?? '',
        tags: parsed.tags.map(({ key, value }) => ({ key, value })),
        ...(first ? { mbti: { type: first.type, variant: first.variant } } : {}),
        ...(parsed.linguistics ? { linguistics: parsed.linguistics.text } : {}),
        sections: parsed.sections.map(({ title, text }) => ({ title, text })),
    };
}

/* ------------------------------------------------------------------ writing */

interface Edit {
    start: number;
    end: number;
    text: string;
    seq: number;
}

/** Weighted alignment of old and new tags: same key and value 3, same key 1; returns new index → old index. */
function alignTags(old: readonly SheetTagToken[], next: SheetDraft['tags']): Map<number, number> {
    const n = old.length;
    const m = next.length;
    const score = (i: number, j: number): number => {
        const a = old[i];
        const b = next[j];
        if (!a || !b || a.key.toUpperCase() !== b.key.toUpperCase()) return -1;
        return a.value === b.value ? 3 : 1;
    };
    const table: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
    for (let i = n - 1; i >= 0; i--) {
        const row = table[i] as number[];
        const below = table[i + 1] as number[];
        for (let j = m - 1; j >= 0; j--) {
            let best = Math.max(below[j] ?? 0, row[j + 1] ?? 0);
            const pair = score(i, j);
            if (pair > 0) best = Math.max(best, pair + (below[j + 1] ?? 0));
            row[j] = best;
        }
    }
    const result = new Map<number, number>();
    let i = 0;
    let j = 0;
    while (i < n && j < m) {
        const here = table[i]?.[j] ?? 0;
        const pair = score(i, j);
        if (pair > 0 && here === pair + (table[i + 1]?.[j + 1] ?? 0)) {
            result.set(j, i);
            i++;
            j++;
        } else if (here === (table[i + 1]?.[j] ?? 0)) i++;
        else j++;
    }
    return result;
}

/** The end of a removed token with its trailing separator (`, ` or spaces). */
function cutEnd(content: string, end: number): number {
    const rest = content.slice(end);
    const separator = /^[ \t]*,[ \t]*/.exec(rest) ?? /^[ \t]+/.exec(rest);
    return end + (separator?.[0].length ?? 0);
}

/** Insertion text before a closing wrapper, matching the separator style around it. */
function beforeClose(content: string, position: number, tag: string): string {
    const before = content.slice(0, position);
    if (/,\s*$/.test(before)) return `${tag}, `;
    if (/\s$/.test(before)) return `${tag} `;
    return `, ${tag}`;
}

function sectionText(title: string, text: string): string {
    return title ? `<${title}>${text}</${title}>` : text;
}

/** A start including one newline (and the spaces around it) right before the span, for removed sections. */
function withLeadingBreak(content: string, start: number): number {
    const before = /\r?\n[ \t]*$/.exec(content.slice(Math.max(0, start - 8), start));
    return before ? start - before[0].length : start;
}

function validDraftTag(tag: { key: string; value: string }): boolean {
    return KEY_RE.test(tag.key) && !!tag.value.trim() && !/[<>\n]/.test(tag.value);
}

/**
 * Writes an edited sheet into the archive text. Refuses a text without a block, an entry with several blocks (one
 * entry, one character), a changed `<Name:…>` and tags that cannot be written. Untouched parts stay byte-identical.
 */
export function rebuildSheet(content: string, draft: SheetDraft): RebuildResult {
    const parsed = parseSheet(content);
    const block = parsed.block;
    if (!block) return { ok: false, error: 'noBlock' };
    if (parsed.blocks > 1) return { ok: false, error: 'multiBlock' };
    if (draft.name !== (parsed.name ?? '')) return { ok: false, error: 'name' };
    if (!draft.tags.every(validDraftTag)) return { ok: false, error: 'tag' };
    if (draft.mbti && !MBTI_TYPE_RE.test(draft.mbti.type)) return { ok: false, error: 'tag' };

    const edits: Edit[] = [];
    let seq = 0;
    const edit = (start: number, end: number, text: string) => edits.push({ start, end, text, seq: seq++ });

    // Tags: replace matched ones, cut removed ones, then place the new ones.
    const matched = alignTags(parsed.tags, draft.tags);
    const kept = new Set(matched.values());
    draft.tags.forEach((tag, index) => {
        const oldIndex = matched.get(index);
        const old = oldIndex === undefined ? undefined : parsed.tags[oldIndex];
        if (old && (old.key !== tag.key || old.value !== tag.value)) {
            edit(old.start, old.end, `<${tag.key}:${tag.value}>`);
        }
    });
    parsed.tags.forEach((old, index) => {
        if (!kept.has(index)) edit(old.start, cutEnd(content, old.end), '');
    });
    const keptTags = parsed.tags.filter((_, index) => kept.has(index));
    const insertTag = (category: string, text: string, predecessor: SheetTagToken | undefined) => {
        const upper = category.toUpperCase();
        const same = keptTags.filter((tag) => tag.key.toUpperCase() === upper).pop();
        if (same) return edit(same.end, same.end, `, ${text}`);
        const group = groupOfCategory(upper);
        const wrapper = group ? parsed.groups.find((item) => item.name === group && item.close) : undefined;
        if (wrapper?.close) {
            return edit(wrapper.close.start, wrapper.close.start, beforeClose(content, wrapper.close.start, text));
        }
        if (predecessor) return edit(predecessor.end, predecessor.end, `, ${text}`);
        return edit(block.inner.end, block.inner.end, beforeClose(content, block.inner.end, text));
    };
    let predecessor: SheetTagToken | undefined;
    draft.tags.forEach((tag, index) => {
        const oldIndex = matched.get(index);
        if (oldIndex !== undefined) {
            predecessor = parsed.tags[oldIndex];
            return;
        }
        insertTag(tag.key, `<${tag.key}:${tag.value}>`, predecessor);
    });

    // MBTI: the first archetype is the sheet's; extra ones stay as written (the tag check reports them).
    const oldMbti = parsed.mbti[0];
    const nextMbti = draft.mbti ? `<${draft.mbti.type.toUpperCase()}-${draft.mbti.variant}>` : null;
    if (oldMbti && nextMbti) {
        if (content.slice(oldMbti.start, oldMbti.end) !== nextMbti) edit(oldMbti.start, oldMbti.end, nextMbti);
    } else if (oldMbti) {
        edit(oldMbti.start, cutEnd(content, oldMbti.end), '');
    } else if (nextMbti) {
        const dere = keptTags.filter((tag) => tag.key.toUpperCase() === 'DERE').pop();
        insertTag('MBTI', nextMbti, dere ?? keptTags[keptTags.length - 1]);
    }

    // Linguistics block.
    const lingOld = parsed.linguistics;
    const lingNew = draft.linguistics;
    if (lingOld) {
        if (lingNew !== lingOld.text) {
            if (lingNew === undefined || !lingNew.trim()) {
                edit(withLeadingBreak(content, lingOld.outer.start), lingOld.outer.end, '');
            } else {
                edit(lingOld.inner.start, lingOld.inner.end, lingNew);
            }
        }
    } else if (lingNew?.trim()) {
        edit(block.outer.end, block.outer.end, `\n${sectionText('Linguistics', lingNew)}`);
    }

    // Prose sections, matched by title and order of appearance.
    const byTitle = new Map<string, SheetSectionToken[]>();
    for (const section of parsed.sections) {
        const key = section.title.toLowerCase();
        const list = byTitle.get(key);
        if (list) list.push(section);
        else byTitle.set(key, [section]);
    }
    const used = new Set<SheetSectionToken>();
    const additions: string[] = [];
    for (const section of draft.sections) {
        const old = byTitle.get(section.title.toLowerCase())?.shift();
        if (!old) {
            if (section.text.trim()) additions.push(sectionText(section.title, section.text));
            continue;
        }
        used.add(old);
        if (section.text === old.text) continue;
        if (!section.text.trim()) edit(withLeadingBreak(content, old.outer.start), old.outer.end, '');
        else edit(old.inner.start, old.inner.end, section.text);
    }
    for (const section of parsed.sections) {
        if (!used.has(section)) edit(withLeadingBreak(content, section.outer.start), section.outer.end, '');
    }
    if (additions.length) {
        // After the last prose section (inside the block in the fullsheet layout), else right after the block.
        const ends = parsed.sections.map((s) => s.outer.end);
        if (parsed.linguistics) ends.push(parsed.linguistics.outer.end);
        const anchor = ends.length ? Math.max(...ends) : block.outer.end;
        edit(anchor, anchor, additions.map((text) => `\n${text}`).join(''));
    }

    // Apply in one forward pass; insertions at a position go before a cut starting there.
    edits.sort(
        (a, b) =>
            a.start - b.start || (a.end - a.start === 0 ? 0 : 1) - (b.end - b.start === 0 ? 0 : 1) || a.seq - b.seq,
    );
    let result = '';
    let cursor = 0;
    for (const item of edits) {
        const start = Math.max(item.start, cursor);
        result += content.slice(cursor, start) + item.text;
        cursor = Math.max(cursor, item.end);
    }
    result += content.slice(cursor);
    return { ok: true, content: result, changed: result !== content };
}
