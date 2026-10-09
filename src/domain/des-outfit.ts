// What a character wears, written into DES's tracker (M27 «Переодеть сейчас», setting «Записывать одежду в трекер
// DES»): the clothing field of that character in the `characterThoughts` JSON of a reply — Maestro's «Одежда» / an
// "Outfit" field of the config, or a clothing key the tracker already has. Without a clothing field the appearance
// field is used only when it holds clothes already (that is how such a setup stores them): the clothing pieces in it
// are replaced by the new wording, hair, eyes and body stay. Otherwise nothing is written. The JSON keeps its shape
// (an array or `{characters: [...]}`); DES stores it as a string. Pure.
import { parseTrackerJson } from './des-tracker';
import { fieldAspect } from './signals-diff';
import { clothingPieces } from './wardrobe-wear';
import { normalizeName } from './world-names';

export interface DesFieldLike {
    name: string;
    enabled: boolean;
}

export interface DesOutfitEdit {
    /** The new `characterThoughts` string. */
    thoughts: string;
    /** The detail key written. */
    key: string;
    field: 'outfit' | 'appearance';
    /** The detail's value before ('' when the key was not there). */
    before: string;
    after: string;
}

const CYRILLIC_RE = /\p{Script=Cyrillic}/u;

/** DES's JSON key of a per-character field (jsonPromptHelpers.js toFieldKey); a Cyrillic name is its own key. */
export function desFieldKey(name: string): string {
    const base = String(name ?? '')
        .replace(/\s*\(.*\)\s*$/, '')
        .trim();
    if (CYRILLIC_RE.test(base)) return base;
    return base
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '');
}

type Dict = Record<string, unknown>;
const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown): string {
    if (typeof value === 'string') return value;
    if (isDict(value)) {
        for (const key of ['value', 'text', 'description']) if (typeof value[key] === 'string') return value[key];
    }
    return '';
}

/** Sets a detail keeping a `{value}` wrapper when the tracker uses one. */
function setDetail(details: Dict, key: string, value: string): void {
    const current = details[key];
    if (isDict(current) && typeof current.value === 'string') details[key] = { ...current, value };
    else details[key] = value;
}

/**
 * An appearance text with its clothing replaced by `wording` (the first clothing piece becomes the wording, the other
 * pieces go, the separators are tidied). Null when the text holds no clothing.
 */
export function replaceClothing(appearance: string, wording: string): string | null {
    const source = String(appearance ?? '');
    const value = String(wording ?? '').trim();
    const pieces = clothingPieces(source);
    if (!pieces.length || !value) return null;
    const spans: { start: number; end: number }[] = [];
    let from = 0;
    for (const piece of pieces) {
        const at = source.indexOf(piece, from);
        if (at < 0) continue;
        spans.push({ start: at, end: at + piece.length });
        from = at + piece.length;
    }
    if (!spans.length) return null;
    let out = '';
    let last = 0;
    spans.forEach((span, index) => {
        out += source.slice(last, span.start);
        if (index === 0) out += value;
        last = span.end;
    });
    out += source.slice(last);
    return out
        .replace(/\s*,(?:\s*,)+/g, ',')
        .replace(/\s+([,.;])/g, '$1')
        .replace(/([,;])\s*([.;])/g, '$2')
        .replace(/\.\s+\./g, '.')
        .replace(/(?<!\.)\.\.(?!\.)/g, '.')
        .replace(/^[\s,;.]+/, '')
        .replace(/\s{2,}/g, ' ')
        .trim();
}

/** The characters list of a parsed `characterThoughts` (an array, or `{characters}`), or null. */
function charactersOf(data: unknown): unknown[] | null {
    if (Array.isArray(data)) return data;
    if (isDict(data) && Array.isArray(data.characters)) return data.characters;
    return null;
}

/**
 * Writes what a character wears into a `characterThoughts` value (see the header). `names` are the character's name
 * and aliases as DES may write it. Null when the character is not in it, the tracker has no place for clothes, or
 * nothing changes.
 */
export function setDesOutfit(
    raw: unknown,
    names: string | readonly string[],
    wording: string,
    fields: readonly DesFieldLike[] | null,
): DesOutfitEdit | null {
    const value = String(wording ?? '').trim();
    if (!value) return null;
    const data = parseTrackerJson(raw);
    const list = charactersOf(data);
    if (!list) return null;
    const keys = new Set((typeof names === 'string' ? [names] : names).map(normalizeName).filter(Boolean));
    const character = list.find(
        (item) => isDict(item) && typeof item.name === 'string' && keys.has(normalizeName(item.name)),
    );
    if (!isDict(character)) return null;
    const details: Dict = isDict(character.details) ? { ...character.details } : {};
    let key = Object.keys(details).find((item) => fieldAspect(item) === 'outfit');
    let field: DesOutfitEdit['field'] = 'outfit';
    let after = value;
    if (!key) {
        const configured = (fields ?? []).find(
            (item) => item.enabled && item.name.trim() && fieldAspect(item.name) === 'outfit',
        );
        if (configured) key = desFieldKey(configured.name);
    }
    if (!key) {
        const appearance = Object.keys(details).find((item) => fieldAspect(item) === 'appearance');
        const replaced = appearance ? replaceClothing(text(details[appearance]), value) : null;
        if (!appearance || replaced === null) return null;
        key = appearance;
        field = 'appearance';
        after = replaced;
    }
    const before = text(details[key]);
    if (before.trim() === after.trim()) return null;
    setDetail(details, key, after);
    const edited = { ...character, details };
    const nextList = list.map((item) => (item === character ? edited : item));
    const next = Array.isArray(data) ? nextList : { ...(data as Dict), characters: nextList };
    return { thoughts: JSON.stringify(next), key, field, before, after };
}
