// M24 «Места»: matching DES location labels against the chat's place registry (plan M24 п.2, §4.4). A label resolves
// by the normalised name, aliases and Russian case forms of each part, checked against the nesting: «Main Hall,
// Castle» is not the Main Hall of the tavern. Labels that only resemble a known place (a prefix, a shared stem, a typo)
// are not merged automatically; the caller sends them to the Inbox. Pure: no DOM, no SillyTavern.
import { cleanLabel, normalizePlaceName, orderLabelParts, placeWords, splitLabel, wordLevel } from './places-label';
import type { LabelOrder } from './places-label';

/** What matching needs of a place (the registry's Place satisfies it). */
export interface PlaceRef {
    id: string;
    name: string;
    aliases: readonly string[];
    forms: readonly string[];
    parent: string | null;
    lastSeen?: number;
}

/** Normalised names a place answers to: its name, aliases and their case forms. */
export function placeKeys(place: PlaceRef): string[] {
    const keys = new Set<string>();
    for (const text of [place.name, ...place.aliases, ...place.forms]) {
        if (typeof text !== 'string') continue;
        const key = normalizePlaceName(text);
        if (key) keys.add(key);
    }
    return [...keys];
}

/** Normalised name → ids of the places that answer to it. */
export function placeKeyIndex(places: readonly PlaceRef[]): Map<string, string[]> {
    const index = new Map<string, string[]>();
    for (const place of places) {
        for (const key of placeKeys(place)) {
            const ids = index.get(key);
            if (!ids) index.set(key, [place.id]);
            else if (!ids.includes(place.id)) ids.push(place.id);
        }
    }
    return index;
}

export function placeMap<P extends PlaceRef>(places: readonly P[]): Map<string, P> {
    return new Map(places.map((place) => [place.id, place]));
}

/** Ancestors of a place, nearest first; stops at a missing parent or a cycle. */
export function ancestorIds(byId: ReadonlyMap<string, PlaceRef>, id: string): string[] {
    const out: string[] = [];
    const seen = new Set<string>([id]);
    let parent = byId.get(id)?.parent ?? null;
    while (parent !== null && !seen.has(parent) && byId.has(parent)) {
        out.push(parent);
        seen.add(parent);
        parent = byId.get(parent)?.parent ?? null;
    }
    return out;
}

/** True when `ancestor` is a strict ancestor of `id`. */
export function isAncestor(byId: ReadonlyMap<string, PlaceRef>, ancestor: string, id: string): boolean {
    return ancestor !== id && ancestorIds(byId, id).includes(ancestor);
}

/** Every place under `id` (children, grandchildren, …). */
export function descendantIds(places: readonly PlaceRef[], id: string): string[] {
    const byId = placeMap(places);
    return places.filter((place) => isAncestor(byId, id, place.id)).map((place) => place.id);
}

/** Path names from the top place down to this one («Город › Таверна › Зал»). */
export function placePath(byId: ReadonlyMap<string, PlaceRef>, id: string): string[] {
    const place = byId.get(id);
    if (!place) return [];
    return [
        ...ancestorIds(byId, id)
            .reverse()
            .map((ancestor) => byId.get(ancestor)?.name ?? ''),
        place.name,
    ].filter(Boolean);
}

/** A parent for `id` that keeps the tree a tree: null, or an existing place that is neither `id` nor under it. */
export function canSetParent(places: readonly PlaceRef[], id: string, parent: string | null): boolean {
    if (parent === null) return true;
    if (parent === id) return false;
    const byId = placeMap(places);
    if (!byId.has(parent)) return false;
    return !isAncestor(byId, id, parent);
}

/* ------------------------------------------------------------------ similarity */

/** Russian endings dropped by the stemmer, longest first. */
const RU_ENDINGS = [
    'иями',
    'ями',
    'ами',
    'ого',
    'его',
    'ому',
    'ему',
    'ыми',
    'ими',
    'ией',
    'ой',
    'ей',
    'ий',
    'ый',
    'ая',
    'яя',
    'ое',
    'ее',
    'ые',
    'ие',
    'ую',
    'юю',
    'ам',
    'ям',
    'ах',
    'ях',
    'ом',
    'ем',
    'ов',
    'ев',
    'ью',
    'а',
    'я',
    'о',
    'е',
    'ы',
    'и',
    'у',
    'ю',
    'ь',
    'й',
];
const CYRILLIC_RE = /\p{Script=Cyrillic}/u;
const DIGIT_RE = /\d/;

/** Words that do not tell places apart: prepositions, articles and plain descriptive adjectives. */
const STOP_WORDS = new Set([
    'the',
    'of',
    'in',
    'at',
    'on',
    'and',
    'a',
    'an',
    'to',
    'by',
    'near',
    'off',
    'main',
    'old',
    'new',
    'great',
    'grand',
    'little',
    'small',
    'big',
    'upper',
    'lower',
    'north',
    'northern',
    'south',
    'southern',
    'east',
    'eastern',
    'west',
    'western',
    'central',
    'inner',
    'outer',
    'back',
    'front',
    'royal',
    'private',
    'public',
    'first',
    'second',
    'third',
    'top',
    'ground',
    'у',
    'в',
    'во',
    'на',
    'при',
    'под',
    'над',
    'за',
    'и',
    'около',
    'возле',
    'близ',
    'к',
    'ко',
    'с',
    'со',
    'из',
    'от',
    'до',
    'для',
    'главн',
    'стар',
    'нов',
    'больш',
    'мал',
    'маленьк',
    'верхн',
    'нижн',
    'северн',
    'южн',
    'восточн',
    'западн',
    'центральн',
    'внутрен',
    'внешн',
    'задн',
    'передн',
    'королевск',
    'перв',
    'втор',
    'трет',
    'частн',
    'общ',
]);

/** A crude stem: Russian words lose one ending (keeping three letters), English ones a possessive or plural s. */
export function wordStem(word: string): string {
    const lower = normalizePlaceName(word);
    if (CYRILLIC_RE.test(lower)) {
        for (const ending of RU_ENDINGS) {
            if (lower.endsWith(ending) && lower.length - ending.length >= 3) return lower.slice(0, -ending.length);
        }
        return lower;
    }
    if (lower.endsWith("'s")) return lower.slice(0, -2);
    if (lower.length > 3 && lower.endsWith('s') && !lower.endsWith('ss')) return lower.slice(0, -1);
    return lower;
}

/** Stems of the distinctive words of a name (no place-type words, prepositions or plain adjectives). */
export function significantStems(name: string): string[] {
    const stems: string[] = [];
    for (const word of placeWords(name)) {
        if (wordLevel(word) !== null) continue;
        const stem = wordStem(word);
        if (!stem || STOP_WORDS.has(word) || STOP_WORDS.has(stem)) continue;
        if (!stems.includes(stem)) stems.push(stem);
    }
    return stems;
}

function stemsMatch(a: string, b: string): boolean {
    if (a === b) return true;
    return Math.min(a.length, b.length) >= 4 && (a.startsWith(b) || b.startsWith(a));
}

/** Levenshtein distance (names are short: a plain two-row table). */
export function editDistance(a: string, b: string): number {
    const x = [...a];
    const y = [...b];
    if (!x.length) return y.length;
    if (!y.length) return x.length;
    let previous = Array.from({ length: y.length + 1 }, (_, index) => index);
    for (let i = 1; i <= x.length; i++) {
        const row = [i];
        for (let j = 1; j <= y.length; j++) {
            const cost = x[i - 1] === y[j - 1] ? 0 : 1;
            row.push(
                Math.min((previous[j] as number) + 1, (row[j - 1] as number) + 1, (previous[j - 1] as number) + cost),
            );
        }
        previous = row;
    }
    return previous[y.length] as number;
}

/** Words with digits («3», «4b»): rooms and flats with different numbers are different places. */
function numberTokens(name: string): string {
    return placeWords(name)
        .filter((word) => DIGIT_RE.test(word))
        .sort()
        .join(' ');
}

/**
 * Two names that may be one place: equal after normalisation, one contained in the other as whole words («Rusty
 * Anchor» — «Rusty Anchor Tavern», «Таверна» — «Таверна «Якорь»»), the distinctive stems of one inside the other's
 * («Ржавый якорь» — «у Ржавого якоря»), or a typo (edit distance 1, or 2 for long names). Different numbers never
 * match.
 */
export function namesSimilar(a: string, b: string): boolean {
    const x = normalizePlaceName(a);
    const y = normalizePlaceName(b);
    if (!x || !y) return false;
    if (x === y) return true;
    if (numberTokens(x) !== numberTokens(y)) return false;
    const [shorter, longer] = x.length <= y.length ? [x, y] : [y, x];
    if (shorter.length >= 3 && ` ${longer} `.includes(` ${shorter} `)) return true;
    const stemsX = significantStems(x);
    const stemsY = significantStems(y);
    if (stemsX.length && stemsY.length) {
        const [small, big] = stemsX.length <= stemsY.length ? [stemsX, stemsY] : [stemsY, stemsX];
        if (small.every((stem) => big.some((other) => stemsMatch(stem, other)))) return true;
    }
    const longest = Math.max([...x].length, [...y].length);
    if (longest < 5) return false;
    return editDistance(x, y) <= (longest >= 12 ? 2 : 1);
}

/**
 * Places that may be the same as a new place called `name` under `parent`: similar by name or alias, on the same
 * branch of the tree (no parent on either side, or one parent at or above the other). The parent and its ancestors
 * themselves are left out («Tavern, Tavern Hall» does not offer the tavern).
 */
export function similarPlaces(places: readonly PlaceRef[], name: string, parent: string | null): string[] {
    const byId = placeMap(places);
    const excluded = new Set<string>(parent ? [parent, ...ancestorIds(byId, parent)] : []);
    const sameBranch = (place: PlaceRef): boolean => {
        if (parent === null || place.parent === null || place.parent === parent) return true;
        return isAncestor(byId, parent, place.parent) || isAncestor(byId, place.parent, parent);
    };
    return places
        .filter((place) => !excluded.has(place.id) && sameBranch(place))
        .filter((place) => [place.name, ...place.aliases].some((text) => namesSimilar(text, name)))
        .map((place) => place.id);
}

/* ------------------------------------------------------------------ resolution */

export interface LabelResolution {
    /** The cleaned label; '' when the label names no place. */
    label: string;
    /** Parts, most specific first. */
    parts: string[];
    order: LabelOrder;
    /** The place of the most specific part (the label fully resolved), or null. */
    match: string | null;
    /** The most specific known place in the label (the match, or a known container of unknown parts). */
    deepest: string | null;
    /** Parts more specific than `deepest`, most specific first (all parts when nothing is known). */
    unknown: string[];
}

export interface ResolveOptions {
    /** The current place: breaks ties between places with the same name. */
    current?: string | null;
}

/** Among places with one name: the current one, then one on its branch, then a sibling, then the latest seen. */
function pick(ids: readonly string[], byId: ReadonlyMap<string, PlaceRef>, current: string | null): string {
    if (ids.length === 1) return ids[0] as string;
    const score = (id: string): number => {
        if (current === null) return 0;
        if (id === current) return 3;
        if (isAncestor(byId, id, current) || isAncestor(byId, current, id)) return 2;
        const parent = byId.get(id)?.parent ?? null;
        return parent !== null && parent === (byId.get(current)?.parent ?? null) ? 1 : 0;
    };
    return [...ids].sort(
        (a, b) => score(b) - score(a) || (byId.get(b)?.lastSeen ?? -1) - (byId.get(a)?.lastSeen ?? -1),
    )[0] as string;
}

/**
 * Resolves a DES location label. The whole label is tried first (a place may be called «Rusty Anchor, Main Hall»);
 * then the parts: the registry votes on their order (a known part that is an ancestor of another known part is the
 * more general one), and the most specific part whose place agrees with every known more general part wins. A place
 * without a parent agrees with anything.
 */
export function resolvePlaceLabel(
    places: readonly PlaceRef[],
    label: string,
    options: ResolveOptions = {},
): LabelResolution {
    const clean = cleanLabel(label);
    if (!clean) return { label: '', parts: [], order: 'single', match: null, deepest: null, unknown: [] };
    const current = options.current ?? null;
    const byId = placeMap(places);
    const index = placeKeyIndex(places);
    const lookup = (text: string): string[] => index.get(normalizePlaceName(text)) ?? [];

    const whole = lookup(clean);
    if (whole.length) {
        const id = pick(whole, byId, current);
        return { label: clean, parts: [clean], order: 'single', match: id, deepest: id, unknown: [] };
    }

    const split = splitLabel(clean);
    const written = split.parts.map(lookup);
    let vote = 0;
    for (let i = 0; i < written.length; i++) {
        for (let j = i + 1; j < written.length; j++) {
            for (const a of written[i] as string[]) {
                for (const b of written[j] as string[]) {
                    if (isAncestor(byId, a, b)) vote++;
                    else if (isAncestor(byId, b, a)) vote--;
                }
            }
        }
    }
    const { parts, order } = orderLabelParts(clean, split, vote);
    const matches = parts.map(lookup);
    for (let k = 0; k < parts.length; k++) {
        const general = matches.slice(k + 1).filter((ids) => ids.length > 0);
        const consistent = (matches[k] as string[]).filter((id) => {
            const ancestors = ancestorIds(byId, id);
            if (!ancestors.length) return true;
            return general.every((ids) => ids.some((other) => ancestors.includes(other)));
        });
        if (!consistent.length) continue;
        const id = pick(consistent, byId, current);
        return { label: clean, parts, order, match: k === 0 ? id : null, deepest: id, unknown: parts.slice(0, k) };
    }
    return { label: clean, parts, order, match: null, deepest: null, unknown: [...parts] };
}
