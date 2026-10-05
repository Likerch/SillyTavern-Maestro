// Passport generation for lorebook entries (M28 п. 2): when NAI Studio's API offers no generator, the cheap background
// model writes the passport from the entry text with NAI Studio's rules (N:domain/passport-gen.ts): English Danbooru
// tags in lower case, only what the text says, no explicit anatomy, no art style or palette tags. Here: the messages,
// the strict JSON schema, a forgiving reader of the answer and the cost estimate. Pure: the feature sends the request.
import { hasCyrillic } from './canon-keys';
import { bootstrapCostUsd } from './doctor-budget';
import {
    PASSPORT_SLOTS,
    cleanTag,
    isEnglishTag,
    isExplicitAnatomy,
    isPassportEmpty,
    isPassportKind,
    joinTags,
    normalizePassport,
    splitTags,
} from './lore-passport';
import type { PassportKind } from './lore-passport';

type Dict = Record<string, unknown>;

/** Kinds the generator writes (scenario passports belong to cards, not to lore entries). */
export const GENERATED_KINDS = ['character', 'location', 'object', 'world'] as const;

/** Slots the generator fills (`style` is the user's: no art style from the model). */
export const GENERATED_SLOTS = PASSPORT_SLOTS.filter((slot) => slot !== 'style');

/** The entry text is cut to this many characters. */
export const CONTENT_LIMIT = 6000;
const OVERHEAD_TOKENS = 700;
const OUTPUT_TOKENS = 350;

export const PASSPORT_SCHEMA_NAME = 'lore_passport';

const text = (description: string) => ({ type: 'string', description });

export const PASSPORT_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['kind', 'name', 'aliases', 'tags', 'slots', 'negative'],
    properties: {
        kind: { type: 'string', enum: [...GENERATED_KINDS] },
        name: text('The name as written in the entry'),
        aliases: { type: 'array', items: { type: 'string' } },
        tags: text('Visual tags of a location, object or world; empty for a character'),
        slots: {
            type: 'object',
            additionalProperties: false,
            required: [...GENERATED_SLOTS],
            properties: Object.fromEntries(GENERATED_SLOTS.map((slot) => [slot, { type: 'string' }])),
        },
        negative: text('Tags that must never be drawn for it'),
    },
};

const SYSTEM_PROMPT = [
    'You read one lorebook entry of a roleplay world and write one visual "passport" of what it describes for an image generator (NovelAI, Danbooru tags).',
    'Answer only with JSON that matches the schema.',
    '- kind "character": a person or a creature. Fill slots: base (count tag and what they are: "1girl, elf, adult", "1boy, demon", "1other, slime"), hair, eyes, body (build, height, figure, notable features), skin, clothing (ONE default outfit: one item per body part, one colour per item, never alternatives), accessories. Leave "tags" empty.',
    '- kind "location": a place, how it looks, in "tags". kind "object": an item or a vehicle, how it looks, in "tags". kind "world": a faction, culture, event or the setting as a whole (era, technology, magic, overall look) in "tags". Leave the slots empty for these kinds.',
    '- name: as written in the entry. aliases: other names the text uses, and the name written in Cyrillic as a Russian text would spell it when it is not Cyrillic already.',
    '- negative: only what must never be drawn for it; usually empty.',
    'Rules: English Danbooru tags, lowercase, comma separated, spaces instead of underscores. Only what the text says or clearly implies, never invent (a species or race only when the text names it); leave a field empty when unknown. No explicit anatomy (genitals, nipples). No quality, art style or colour palette tags (pastel colors, vibrant colors, monochrome, masterpiece).',
].join('\n');

export interface PassportGenInput {
    name: string;
    /** The kind to write (typed entries); null lets the model choose. */
    kind: PassportKind | null;
    /** English entry type label ('Character', 'Place'), when typed. */
    typeLabel?: string;
    keys?: readonly string[];
    content: string;
}

function clip(value: string, max: number): string {
    const trimmed = value.trim();
    return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/** System and user messages for one entry. */
export function passportGenMessages(input: PassportGenInput): { role: 'system' | 'user'; content: string }[] {
    const lines = [`Name: ${input.name}`];
    if (input.typeLabel) lines.push(`Entry type: ${input.typeLabel}`);
    lines.push(
        input.kind && (GENERATED_KINDS as readonly string[]).includes(input.kind)
            ? `Kind to write: ${input.kind}`
            : 'Kind: choose the one that fits.',
    );
    const keys = (input.keys ?? []).filter((key) => key.trim());
    if (keys.length) lines.push(`Keywords: ${keys.slice(0, 12).join(', ')}`);
    lines.push(`Entry text:\n${clip(input.content, CONTENT_LIMIT)}`);
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: lines.join('\n') },
    ];
}

/** The first JSON value in a text (code fences, chatter around it); null when there is none. */
export function extractJson(raw: string): unknown {
    const cleaned = raw.replace(/```(?:json)?/gi, '').trim();
    try {
        return JSON.parse(cleaned);
    } catch {
        // look for the outermost object
    }
    const start = cleaned.indexOf('{');
    const end = cleaned.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        return JSON.parse(cleaned.slice(start, end + 1));
    } catch {
        return null;
    }
}

const asText = (value: unknown): string =>
    typeof value === 'string'
        ? value
        : Array.isArray(value)
          ? value.filter((item): item is string => typeof item === 'string').join(', ')
          : '';

/** Palette and quality words that belong to the art style, not to a passport (N:passport-gen STYLE_TAG). */
const STYLE_TAG =
    /^(?:(?:pastel|vibrant|muted|vivid|bright|dark|soft|warm|cool|earth|neutral|light) colou?rs?|colou?rful|monochrome|limited palette|masterpiece|best quality|high quality|amazing quality|very aesthetic|absurdres|highres)$/i;

/** Clean tags of a field; explicit anatomy goes to `anatomy`, non-English and style tags are dropped. */
function generatedTags(value: unknown, anatomy: string[]): string {
    const kept: string[] = [];
    for (const raw of splitTags(asText(value))) {
        const tag = cleanTag(raw);
        if (!tag || !isEnglishTag(tag) || STYLE_TAG.test(tag)) continue;
        if (isExplicitAnatomy(tag)) anatomy.push(tag);
        else kept.push(tag);
    }
    return joinTags(...kept);
}

/** The passport object of an answer: the object itself, `{passport}`, or the first of `{passports: [...]}`. */
function answerObject(raw: unknown): Dict | null {
    const data = typeof raw === 'string' ? extractJson(raw) : raw;
    if (typeof data !== 'object' || data === null) return null;
    if (Array.isArray(data)) return typeof data[0] === 'object' && data[0] !== null ? (data[0] as Dict) : null;
    const object = data as Dict;
    if (typeof object.passport === 'object' && object.passport !== null && !Array.isArray(object.passport)) {
        return object.passport as Dict;
    }
    if (Array.isArray(object.passports)) {
        const first = object.passports[0];
        return typeof first === 'object' && first !== null && !Array.isArray(first) ? (first as Dict) : null;
    }
    return object;
}

/**
 * The passport from the model's answer (parsed JSON or text): tags cleaned (lower case, spaces, no style words, no
 * non-English tags), explicit anatomy moved to the NSFW layer (switched off), the given kind kept over the model's.
 * Null when the answer has nothing to draw.
 */
export function parseGeneratedPassport(
    raw: unknown,
    fallback: { name: string; kind: PassportKind | null },
): Dict | null {
    const object = answerObject(raw);
    if (!object) return null;
    const answered = isPassportKind(object.kind) ? object.kind : null;
    const kind: PassportKind = fallback.kind ?? answered ?? 'world';
    const anatomy: string[] = [];
    const slotsIn: Dict =
        typeof object.slots === 'object' && object.slots !== null && !Array.isArray(object.slots)
            ? (object.slots as Dict)
            : object;
    const slots: Record<string, string> = {};
    for (const slot of GENERATED_SLOTS) slots[slot] = generatedTags(slotsIn[slot], anatomy);
    let tags = generatedTags(object.tags, anatomy);
    if (kind === 'character') {
        // NAI Studio draws a character from its slots only: loose tags join the base slot.
        if (tags) slots.base = joinTags(slots.base ?? '', tags);
        tags = '';
    } else {
        tags = joinTags(tags, ...GENERATED_SLOTS.map((slot) => slots[slot] ?? ''));
        for (const slot of GENERATED_SLOTS) slots[slot] = '';
    }
    const name = asText(object.name).trim() || fallback.name.trim();
    const passport = normalizePassport(
        {
            kind,
            name,
            aliases: Array.isArray(object.aliases) ? object.aliases : asText(object.aliases),
            tags,
            slots,
            nsfw: { enabled: false, tags: joinTags(...anatomy) },
            negative: generatedTags(object.negative, []),
        },
        { kind, name: fallback.name },
    );
    if (!passport || isPassportEmpty({ ...passport, nsfw: { enabled: false, tags: '' } })) return null;
    return passport;
}

/** Language of an entry text for NAI Studio's generator: Russian when it has Cyrillic. */
export function contentLanguage(content: string): 'ru' | 'en' {
    return hasCyrillic(content) ? 'ru' : 'en';
}

/** Tokens and cost of generating passports with the background model for entries of these lengths (estimate). */
export function estimatePassportCost(lengths: readonly number[]): { tokens: number; usd: number } {
    const tokens = lengths.reduce(
        (sum, chars) =>
            sum + Math.ceil(Math.min(Math.max(0, chars), CONTENT_LIMIT) / 4) + OVERHEAD_TOKENS + OUTPUT_TOKENS,
        0,
    );
    return { tokens, usd: bootstrapCostUsd(tokens) };
}
