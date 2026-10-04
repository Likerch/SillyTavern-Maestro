// Revision (M8) checks before writing (plan M8 «Проверки перед записью», research/bunnymo-carrotkernel.md §5,
// research/qvink-nai-studio.md §B6) and the text edits the routes make:
// - CK tags: well-formed `<KEY:VALUE>` / `<XXXX-H|U>`, English, no placeholders, no `!updatesheet` transitional
//   markup (the loaded pack dictionary is checked by the BunnyMo mode service on top); `<Name:…>` never changes;
// - passport tags: English Danbooru tags in lower case, explicit anatomy only in the NSFW layer (never written here);
// - keys: valid regex keys only; aliases: short plain names;
// - canon facts: one English statement, inserted in place of the outdated one or appended.
// Pure: no DOM, no SillyTavern.
import { checkTags, parseTagKey } from './bunnymo-mode-tags';
import type { TagVocabulary } from './bunnymo-mode-tags';
import { parseSheet, rebuildSheet, sheetDraftOf } from './bunnymo-mode-sheet';
import type { SheetDraft } from './bunnymo-mode-sheet';
import { regexKeyProblem } from './doctor-keys';
import { normName } from './dossier-names';

/** Why a change was not written (stored in RevisionRun.rejected as `code` or `code|detail`). */
export type RevisionRejectCode =
    | 'lowConfidence'
    | 'unknownEntity'
    | 'unknownPlace'
    | 'noTarget'
    | 'noDictionary'
    | 'tag'
    | 'cyrillic'
    | 'notEnglish'
    | 'placeholder'
    | 'transitional'
    | 'malformed'
    | 'duplicate'
    | 'multiBlock'
    | 'anatomy'
    | 'uppercase'
    | 'slot'
    | 'keys'
    | 'name'
    | 'markup'
    | 'beforeMissing'
    | 'noChange'
    | 'protectedBook'
    | 'empty'
    | 'tooLong'
    | 'failed';

export interface Rejection {
    code: RevisionRejectCode;
    detail?: string;
}

/** `code` or `code|detail` (what RevisionRun.rejected[].reason stores). */
export function formatRejection(rejection: Rejection): string {
    return rejection.detail ? `${rejection.code}|${rejection.detail}` : rejection.code;
}

export function parseRejection(reason: string): Rejection {
    const index = reason.indexOf('|');
    if (index < 0) return { code: reason as RevisionRejectCode };
    return { code: reason.slice(0, index) as RevisionRejectCode, detail: reason.slice(index + 1) };
}

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const CYRILLIC_G = /\p{Script=Cyrillic}/gu;
const LATIN_G = /[A-Za-z]/g;
const MAX_FACT = 500;

/* ------------------------------------------------------------------ canon facts */

/**
 * A canon statement: English (names as in the chat may be Cyrillic, so the text only has to be mostly Latin), short,
 * without CK markup or template placeholders.
 */
export function checkFactText(value: string): Rejection | null {
    const text = value.trim();
    if (!text) return { code: 'empty' };
    if (text.length > MAX_FACT) return { code: 'tooLong' };
    const cyrillic = (text.match(CYRILLIC_G) ?? []).length;
    const latin = (text.match(LATIN_G) ?? []).length;
    if (cyrillic > latin) return { code: 'notEnglish' };
    if (/<\/?bunnymotags|<\s*name\s*:/i.test(text)) return { code: 'markup' };
    if (/\b(?:TBD|PLACEHOLDER|BLANK|LOREM IPSUM)\b/.test(text) || /\{\{(?!user\}\}|char\}\})[^}]*\}\}/i.test(text)) {
        return { code: 'placeholder' };
    }
    return null;
}

function squash(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

/**
 * The content with a fact put in: in place of `replace` (the outdated statement) when it is found, else as a new
 * paragraph at the end. Null when the fact is already there.
 */
export function insertFact(
    content: string,
    fact: string,
    replace?: string,
): { content: string; replaced: boolean } | null {
    const statement = fact.trim();
    const text = content ?? '';
    if (!statement) return null;
    if (squash(text).toLowerCase().includes(squash(statement).toLowerCase())) return null;
    const old = replace?.trim();
    if (old) {
        const at = text.indexOf(old);
        if (at >= 0) {
            return { content: text.slice(0, at) + statement + text.slice(at + old.length), replaced: true };
        }
    }
    const body = text.trimEnd();
    return { content: body ? `${body}\n\n${statement}` : statement, replaced: false };
}

/** The content without one statement (what the contradiction check compares a replacing fact with). */
export function withoutStatement(content: string, statement?: string): string {
    const old = statement?.trim();
    if (!old) return content;
    return content
        .split(old)
        .join('')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/* ------------------------------------------------------------------ CK tags */

const EMPTY_VOCABULARY: TagVocabulary = { values: new Map(), flags: new Set(), info: new Set() };
const FORMAT_PROBLEMS = new Set(['malformed', 'cyrillic', 'placeholder', 'transitional', 'duplicate']);

/** Tags written in a value ("<TRAIT:BRAVE>, <INTJ-H>"); text that is not a tag makes `junk` true. */
export function parseTagList(text: string): { tags: string[]; junk: boolean } {
    const value = String(text ?? '');
    const tags = (value.match(/<[^<>]*>/g) ?? []).map((tag) => tag.trim());
    const rest = value.replace(/<[^<>]*>/g, ' ').replace(/[\s,;]+/g, '');
    return { tags, junk: rest.length > 0 };
}

/**
 * Format of tags a revision writes, before the dictionary: readable, English, no placeholder, no transitional markup,
 * no repeats, never the `<Name:…>` identity. Null when every tag is fine.
 */
export function checkTagFormat(tags: readonly string[]): Rejection | null {
    for (const tag of tags) {
        if (/^<\s*name\s*:/i.test(tag)) return { code: 'name', detail: tag };
    }
    for (const check of checkTags(tags, EMPTY_VOCABULARY)) {
        if (!check.ok && check.reason && FORMAT_PROBLEMS.has(check.reason)) {
            return { code: check.reason as RevisionRejectCode, detail: check.tag };
        }
    }
    return null;
}

/** Normalised tag (`<SPECIES:ELF>`, `<INTJ-H>`), or null when it is not a tag. */
export function normalTag(tag: string): string | null {
    return parseTagKey(tag)?.tag ?? null;
}

function tagOf(key: string, value: string): string {
    return `<${key.trim().toUpperCase()}:${value.trim().toUpperCase()}>`;
}

/** Tags of an archive's block, normalised (MBTI included). */
export function sheetTags(content: string): string[] {
    const parsed = parseSheet(content);
    return [
        ...parsed.tags.map((tag) => tagOf(tag.key, tag.value)),
        ...parsed.mbti.map((item) => `<${item.type}-${item.variant}>`),
    ];
}

/** `<Name:…>` of an archive (null without one). */
export function sheetName(content: string): string | null {
    return parseSheet(content).name;
}

export type TagChangeResult = { ok: true; content: string } | { ok: false; rejection: Rejection };

/**
 * Archive text with tags removed and added (research §5: a clean final set, no transitional markup). Every tag to
 * remove must be in the block now; the `<Name:…>` and the rest of the text stay byte-identical (rebuildSheet).
 */
export function applyTagChange(content: string, remove: readonly string[], add: readonly string[]): TagChangeResult {
    const parsed = parseSheet(content);
    if (!parsed.block) return { ok: false, rejection: { code: 'noTarget' } };
    if (parsed.blocks > 1) return { ok: false, rejection: { code: 'multiBlock' } };
    const base = sheetDraftOf(parsed);
    const draft: SheetDraft & { tags: { key: string; value: string }[] } = {
        ...base,
        tags: base.tags.map((tag) => ({ ...tag })),
        sections: [...base.sections],
    };
    let mbti = draft.mbti ? { ...draft.mbti } : undefined;
    for (const raw of remove) {
        const parsedTag = parseTagKey(raw);
        if (!parsedTag) return { ok: false, rejection: { code: 'malformed', detail: raw } };
        if (parsedTag.category === 'MBTI') {
            if (!mbti || `${mbti.type}-${mbti.variant}` !== parsedTag.value) {
                return { ok: false, rejection: { code: 'beforeMissing', detail: parsedTag.tag } };
            }
            mbti = undefined;
            continue;
        }
        const index = draft.tags.findIndex((tag) => tagOf(tag.key, tag.value) === parsedTag.tag);
        if (index < 0) return { ok: false, rejection: { code: 'beforeMissing', detail: parsedTag.tag } };
        draft.tags.splice(index, 1);
    }
    for (const raw of add) {
        const parsedTag = parseTagKey(raw);
        if (!parsedTag) return { ok: false, rejection: { code: 'malformed', detail: raw } };
        if (parsedTag.category === 'NAME') return { ok: false, rejection: { code: 'name', detail: parsedTag.tag } };
        if (parsedTag.category === 'MBTI' && parsedTag.value) {
            mbti = {
                type: parsedTag.value.slice(0, 4),
                variant: parsedTag.value.endsWith('H') ? 'H' : 'U',
            };
            continue;
        }
        // Bare flags (`<DEPRESSION>`) are pack keys, not archive tags.
        if (parsedTag.value === null) return { ok: false, rejection: { code: 'malformed', detail: parsedTag.tag } };
        if (draft.tags.some((tag) => tagOf(tag.key, tag.value) === parsedTag.tag)) continue;
        draft.tags.push({ key: parsedTag.category, value: parsedTag.value });
    }
    const result = rebuildSheet(content, { ...draft, mbti });
    if (!result.ok) {
        const code: RevisionRejectCode =
            result.error === 'name' ? 'name' : result.error === 'multiBlock' ? 'multiBlock' : 'malformed';
        return { ok: false, rejection: { code } };
    }
    if (!result.changed) return { ok: false, rejection: { code: 'noChange' } };
    if (parseSheet(result.content).name !== parsed.name) return { ok: false, rejection: { code: 'name' } };
    return { ok: true, content: result.content };
}

/* ------------------------------------------------------------------ passport tags */

/** Slots a revision may change (research/qvink-nai-studio.md §B6: the permanent ones). */
export const REVISION_SLOTS: readonly string[] = ['hair', 'eyes', 'body', 'skin', 'base'];

/** Explicit anatomy: NAI Studio keeps it in `nsfw.tags` only (moveExplicitAnatomy). */
const ANATOMY_RE =
    /\b(?:penis|penises|cock|dick|testicles?|scrotum|vagina|vulva|pussy|clitoris|labia|nipples?|areolae?|areola|anus|asshole|erection|cum|semen|pubic hair|futanari|genitals?)\b/;

export function isExplicitAnatomy(tag: string): boolean {
    return ANATOMY_RE.test(tag.toLowerCase());
}

/**
 * Passport tags as NAI Studio stores them: comma-separated English Danbooru tags, lower case, spaces not
 * underscores. Rejects Cyrillic, upper case and explicit anatomy; returns the tidy tag line otherwise.
 */
export function checkPassportTags(value: string): { ok: true; tags: string } | { ok: false; rejection: Rejection } {
    const parts = String(value ?? '')
        .split(',')
        .map((part) => part.replace(/_/g, ' ').replace(/\s+/g, ' ').trim())
        .filter(Boolean);
    if (!parts.length) return { ok: false, rejection: { code: 'empty' } };
    const seen = new Set<string>();
    const tags: string[] = [];
    for (const tag of parts) {
        if (CYRILLIC_RE.test(tag)) return { ok: false, rejection: { code: 'cyrillic', detail: tag } };
        if (tag !== tag.toLowerCase()) return { ok: false, rejection: { code: 'uppercase', detail: tag } };
        if (isExplicitAnatomy(tag)) return { ok: false, rejection: { code: 'anatomy', detail: tag } };
        if (/[<>{}[\]]/.test(tag)) return { ok: false, rejection: { code: 'malformed', detail: tag } };
        if (seen.has(tag)) continue;
        seen.add(tag);
        tags.push(tag);
    }
    return { ok: true, tags: tags.join(', ') };
}

/* ------------------------------------------------------------------ aliases and keys */

/** A chat nickname: a short plain name (no markup, no placeholder, one line). */
export function checkAlias(alias: string): Rejection | null {
    const text = alias.trim();
    if (!text) return { code: 'empty' };
    if (text.length > 40 || text.split(/\s+/).length > 4) return { code: 'tooLong' };
    if (/[<>{}[\]|\\/\n]/.test(text)) return { code: 'malformed', detail: text };
    if (/^(?:BLANK|NEW|NAME|TBD|PLACEHOLDER|X{3,})$/i.test(text)) return { code: 'placeholder', detail: text };
    return null;
}

/** Keys ST would reject or misread: empty, multi-line, broken regex keys. */
export function invalidKeys(keys: readonly string[]): string[] {
    return keys.filter((key) => {
        const text = key.trim();
        return !text || text.includes('\n') || regexKeyProblem(text) !== null;
    });
}

/** The key list with new keys added (compared by normalised name); null when nothing is new. */
export function mergeKeys(keys: readonly string[], added: readonly string[]): string[] | null {
    const seen = new Set(keys.map((key) => normName(key)));
    const next = [...keys];
    for (const key of added) {
        const text = key.trim();
        if (!text || seen.has(normName(text))) continue;
        seen.add(normName(text));
        next.push(text);
    }
    return next.length === keys.length ? null : next;
}
