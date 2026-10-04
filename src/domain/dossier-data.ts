// Dossier (M7) readers over stored data: NAI passports (and a chat-level override on top), CK archive tags with the
// MBTI archetype, Qvink memories worth showing, the last BunnyMo sheet of a character in the chat and CK RAG triggers.
// Pure: callers pass plain copies of what they read from SillyTavern and the neighbours.
import { archiveTags } from './bunnymo';
import type { BunnyMoEntryLike } from './bunnymo';
import { exactName } from './sheet-context';
import { sheetTagBlocks } from './sheet-reply';
import { stripDesTrackerJson } from './text-clean';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** Cuts a text to `max` characters at a word boundary when one is near, with an ellipsis. */
export function truncate(text: string, max: number): string {
    const value = text.trim();
    if (max <= 0 || value.length <= max) return value;
    const cut = value.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/* ------------------------------------------------------------------ passports */

/** The passport fields the dossier reads (NAI Studio's Passport, as the adapter types it). */
export interface PassportLike {
    id: string;
    kind: string;
    name: string;
    aliases: string[];
    tags: string;
    slots: Record<string, string>;
    outfits: { name: string; tags: string }[];
    activeOutfit: string;
    states: { id: string; tags: string; enabled: boolean }[];
    negative: string;
}

/** NAI Studio's slot order (passportTags, N:domain/passport.ts:240-263). */
export const PASSPORT_SLOTS: readonly string[] = [
    'base',
    'hair',
    'eyes',
    'body',
    'skin',
    'clothing',
    'accessories',
    'style',
];

function joinTags(parts: readonly string[]): string {
    return parts
        .map((part) => part.trim())
        .filter(Boolean)
        .join(', ');
}

/** The prompt tags a passport gives: slots in order (the active outfit replaces clothing) and enabled states. */
export function passportTagLine(passport: PassportLike): string {
    if (passport.kind !== 'character') return joinTags([passport.tags]);
    const outfit = passport.activeOutfit
        ? passport.outfits.find((item) => item.name === passport.activeOutfit)
        : undefined;
    const parts = PASSPORT_SLOTS.map((slot) =>
        slot === 'clothing' && outfit ? outfit.tags : (passport.slots[slot] ?? ''),
    );
    for (const state of passport.states) if (state.enabled) parts.push(state.tags);
    return joinTags(parts);
}

/** Rows for the dossier: identity, slots, outfits, states. Empty values are left out. */
export function passportFields(passport: PassportLike): Record<string, string> {
    const fields: Record<string, string> = {};
    const set = (key: string, value: string) => {
        if (value.trim()) fields[key] = value.trim();
    };
    set('id', passport.id);
    set('kind', passport.kind);
    set('name', passport.name);
    set('aliases', passport.aliases.join(', '));
    set('tags', passport.tags);
    for (const slot of PASSPORT_SLOTS) set(`slot.${slot}`, passport.slots[slot] ?? '');
    for (const [slot, value] of Object.entries(passport.slots)) {
        if (!PASSPORT_SLOTS.includes(slot)) set(`slot.${slot}`, value);
    }
    set('outfits', passport.outfits.map((outfit) => `${outfit.name}: ${outfit.tags}`).join('; '));
    set('activeOutfit', passport.activeOutfit);
    set(
        'states',
        passport.states
            .filter((state) => state.enabled)
            .map((state) => state.id)
            .join(', '),
    );
    set('negative', passport.negative);
    return fields;
}

/**
 * Applies a chat-level override (fields of the same passport stored for one chat) on a card passport: slots merge
 * per slot, other known fields replace. Returns the effective passport and the overridden field names.
 */
export function overridePassport(
    base: PassportLike,
    override: unknown,
): { passport: PassportLike; overridden: string[] } {
    if (!isDict(override)) return { passport: base, overridden: [] };
    const passport: PassportLike = {
        ...base,
        aliases: [...base.aliases],
        slots: { ...base.slots },
        outfits: base.outfits.map((outfit) => ({ ...outfit })),
        states: base.states.map((state) => ({ ...state })),
    };
    const overridden: string[] = [];
    if (isDict(override.slots)) {
        for (const [slot, value] of Object.entries(override.slots)) {
            if (typeof value !== 'string' || passport.slots[slot] === value) continue;
            passport.slots[slot] = value;
            overridden.push(`slot.${slot}`);
        }
    }
    for (const field of ['tags', 'activeOutfit', 'negative', 'name'] as const) {
        const value = override[field];
        if (typeof value === 'string' && value !== passport[field]) {
            passport[field] = value;
            overridden.push(field);
        }
    }
    if (Array.isArray(override.aliases)) {
        passport.aliases = override.aliases.filter((item): item is string => typeof item === 'string');
        overridden.push('aliases');
    }
    if (Array.isArray(override.outfits)) {
        passport.outfits = override.outfits
            .filter(isDict)
            .map((outfit) => ({ name: str(outfit.name), tags: str(outfit.tags) }));
        overridden.push('outfits');
    }
    if (Array.isArray(override.states)) {
        passport.states = override.states
            .filter(isDict)
            .map((state) => ({ id: str(state.id), tags: str(state.tags), enabled: state.enabled === true }));
        overridden.push('states');
    }
    return { passport, overridden };
}

/* ------------------------------------------------------------------ archives and tags */

export interface Mbti {
    type: string;
    /** H = healthy, U = unhealthy; null when the archive gives the type alone. */
    variant: 'H' | 'U' | null;
}

const MBTI_RE = /^<(?:MBTI:)?\s*([EI][NS][FT][JP])(?:-([HU]))?\s*>$/i;

/** The MBTI archetype among archive tags: bare `<ESFP-H>` or `<MBTI:ESFP-H>`. */
export function mbtiOf(tags: readonly string[]): Mbti | null {
    for (const tag of tags) {
        const match = MBTI_RE.exec(tag.trim());
        if (match?.[1]) {
            const variant = match[2]?.toUpperCase();
            return { type: match[1].toUpperCase(), variant: variant === 'H' || variant === 'U' ? variant : null };
        }
    }
    return null;
}

const TAG_PARTS_RE = /^<([^:<>]+)(?::([^<>]*))?>$/;

/** Tags grouped by category (`SPECIES` → `ELF, HUMAN`); bare tags go under `MBTI` or `OTHER`. */
export function tagGroups(tags: readonly string[]): Record<string, string> {
    const groups = new Map<string, string[]>();
    for (const tag of tags) {
        const match = TAG_PARTS_RE.exec(tag.trim());
        if (!match?.[1]) continue;
        const bare = match[2] === undefined;
        const category = bare ? (MBTI_RE.test(tag.trim()) ? 'MBTI' : 'OTHER') : match[1].trim().toUpperCase();
        const value = bare ? match[1].trim() : (match[2] ?? '').trim();
        if (!value) continue;
        const list = groups.get(category) ?? [];
        if (!list.includes(value)) list.push(value);
        groups.set(category, list);
    }
    const out: Record<string, string> = {};
    for (const [category, values] of groups) out[category] = values.join(', ');
    return out;
}

const TAG_BLOCK_RE = /<bunnymotags>[\s\S]*?<\/bunnymotags>/gi;

/** Archive text outside its `<BunnymoTags>` blocks (Linguistics, prose sections), blank runs collapsed. */
export function archiveProse(content: unknown): string {
    return str(content)
        .replace(TAG_BLOCK_RE, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export interface ArchiveSummary {
    name: string | null;
    tags: string[];
    mbti: Mbti | null;
    groups: Record<string, string>;
    prose: string;
}

export function summarizeArchive(entry: BunnyMoEntryLike): ArchiveSummary {
    const { name, tags } = archiveTags(entry);
    return { name, tags, mbti: mbtiOf(tags), groups: tagGroups(tags), prose: archiveProse(entry.content) };
}

/* ------------------------------------------------------------------ Qvink memories */

export interface MemoryLike {
    index: number;
    text: string;
    longTerm: boolean;
}

/** Every long-term memory plus the last `limit` others, oldest first. */
export function pickMemories(memories: readonly MemoryLike[], limit: number): MemoryLike[] {
    const sorted = [...memories].filter((memory) => memory.text.trim()).sort((a, b) => a.index - b.index);
    const others = sorted.filter((memory) => !memory.longTerm);
    const recent = new Set((limit > 0 ? others.slice(-limit) : []).map((memory) => memory.index));
    return sorted.filter((memory) => memory.longTerm || recent.has(memory.index));
}

/* ------------------------------------------------------------------ BunnyMo sheets in the chat */

export interface SheetMarkLike {
    command: string;
    target: string;
    part: string;
}

/** M31's mark `extra.maestro.sheet` of a message, when it is there. */
export function readSheetMark(extra: unknown): SheetMarkLike | null {
    const maestro = isDict(extra) ? extra.maestro : undefined;
    const sheet = isDict(maestro) ? maestro.sheet : undefined;
    if (!isDict(sheet) || typeof sheet.command !== 'string') return null;
    return { command: sheet.command, target: str(sheet.target), part: str(sheet.part) || 'reply' };
}

export interface SheetMessageLike {
    index: number;
    text: string;
    isUser: boolean;
    mark: SheetMarkLike | null;
}

export interface FoundSheet {
    index: number;
    text: string;
    command: string | null;
}

const NAME_TAG_RE = /<name:([^<>\n]+)>/i;

function blockName(text: string): string | null {
    for (const body of sheetTagBlocks(text)) {
        const name = NAME_TAG_RE.exec(body)?.[1]?.trim();
        if (name) return name;
    }
    return null;
}

/** Exact names only: an inflected match would hand Александр the sheet of Александра. */
function isFor(target: string | null, names: readonly string[]): boolean {
    return !!target && names.some((name) => exactName(target, name));
}

/**
 * The newest sheet of a character: a `!fullsheet` reply marked by M31 first, then any marked sheet reply, then an
 * unmarked reply whose `<BunnymoTags>` block names the character. Text without DES tracker JSON.
 */
export function findLastSheet(messages: readonly SheetMessageLike[], names: readonly string[]): FoundSheet | null {
    const newest = [...messages].filter((message) => !message.isUser).sort((a, b) => b.index - a.index);
    const found = (message: SheetMessageLike): FoundSheet => ({
        index: message.index,
        text: stripDesTrackerJson(message.text).trim(),
        command: message.mark?.command ?? null,
    });
    const marked = newest.filter((message) => message.mark?.part === 'reply' && isFor(message.mark.target, names));
    const full = marked.find((message) => message.mark?.command === 'fullsheet');
    if (full) return found(full);
    if (marked[0]) return found(marked[0]);
    const tagged = newest.find((message) => isFor(blockName(message.text), names));
    return tagged ? found(tagged) : null;
}

/* ------------------------------------------------------------------ CK RAG */

export interface RagCollection {
    id: string;
    keywords: string[];
    alwaysActive: boolean;
}

/** CK RAG collections of a character (`rag.collectionMetadata[id].characterName`) with their triggers. */
export function ragCollectionsFor(rag: unknown, names: readonly string[]): RagCollection[] {
    const metadata = isDict(rag) ? rag.collectionMetadata : undefined;
    if (!isDict(metadata)) return [];
    const out: RagCollection[] = [];
    for (const [id, raw] of Object.entries(metadata)) {
        if (!isDict(raw) || !isFor(str(raw.characterName) || null, names)) continue;
        const keywords = Array.isArray(raw.keywords)
            ? raw.keywords.filter((item): item is string => typeof item === 'string' && item.trim() !== '')
            : [];
        out.push({ id, keywords, alwaysActive: raw.alwaysActive === true });
    }
    return out.sort((a, b) => a.id.localeCompare(b.id));
}
