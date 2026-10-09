// «Подготовить к игре» (M37, plan-2 §7 п. 4–5): pure parts of the apply step — the order items are written in
// (places from the top down, so a district finds its city), typed canon entries made of the items (English, the
// card-book and chat-canon routes share them), what a starting scene brings when it becomes the active one (its
// outfits, the type of its first scene, the canon note of the start), mechanic definitions from a template or from
// scratch with their starting values, the selection a caller passes, and the «Готово к игре» list of what is still
// missing. The feature writes through the modules' APIs. In a plan read for a Russian story the names are Russian: the
// canon texts name other items by their English names (the canon stays English; the Russian names are keys and aliases),
// and a starting outfit goes to the wardrobe as a Russian statement its parser reads.
import { hasCyrillic } from './canon-keys';
import { normName } from './dossier-names';
import { composeContent } from './entry-types';
import type { EntryTypeId } from './entry-types';
import { cleanList, newMechanicId, snakeId, uniqueId } from './mechanics-defs';
import type { AttributeDef, AttributeValue, HolderSpec, MechanicDef, MechanicScope } from './mechanics-defs';
import { NAMED_SECTIONS, isPrepareScope, sectionOrder, uniqueNames } from './prepare-plan';
import type {
    AnyPrepareItem,
    FirstScene,
    MechanicData,
    NamedData,
    PrepareItem,
    PrepareKind,
    PrepareScope,
    SceneData,
} from './prepare-plan';

/* ------------------------------------------------------------------ order */

/** Depth of a place in the plan's nesting (0 at the top); cycles stop. */
function placeDepth(item: PrepareItem<'place'>, places: readonly PrepareItem<'place'>[]): number {
    let depth = 0;
    let parent = normName(item.data.parent);
    const seen = new Set<string>([item.id]);
    while (parent && depth < 10) {
        const next = places.find((candidate) =>
            [candidate.data.name, candidate.data.english, ...candidate.data.forms].some(
                (name) => normName(name) === parent,
            ),
        );
        if (!next || seen.has(next.id)) break;
        seen.add(next.id);
        depth++;
        parent = normName(next.data.parent);
    }
    return depth;
}

/** Items in the order they are written: sections in plan order, places from the top down. */
export function applyOrder<T extends AnyPrepareItem>(items: readonly T[]): T[] {
    const places = items.filter((item): item is T & PrepareItem<'place'> => item.kind === 'place');
    const depth = new Map(places.map((item) => [item.id, placeDepth(item, places)]));
    return items
        .map((item, index) => ({ item, index }))
        .sort(
            (a, b) =>
                sectionOrder(a.item.kind) - sectionOrder(b.item.kind) ||
                (depth.get(a.item.id) ?? 0) - (depth.get(b.item.id) ?? 0) ||
                a.index - b.index,
        )
        .map(({ item }) => item);
}

/* ------------------------------------------------------------------ selection */

/** What the caller chose: an item id with its scope (default: the item's own) and optionally edited data. */
export interface SelectionRow {
    id: string;
    scope?: PrepareScope;
    /** Replaces fields of the item's data (the window's edits). */
    data?: Record<string, unknown>;
}

/**
 * The chosen items (copies, edits laid over, scopes set) in apply order. `'all'` takes every item that does not exist
 * yet (persona and existing ones left out), with the default scope unless the item came saved for the character.
 */
export function selectItems(
    items: readonly AnyPrepareItem[],
    selection: readonly SelectionRow[] | 'all',
    defaultScope: PrepareScope,
): AnyPrepareItem[] {
    const chosen: AnyPrepareItem[] = [];
    if (selection === 'all') {
        for (const item of items) {
            if (item.exists && !(item.kind === 'mechanic' && item.data.initial.length)) continue;
            const copy = JSON.parse(JSON.stringify(item)) as AnyPrepareItem;
            copy.scope = item.saved && item.scope === 'character' ? 'character' : defaultScope;
            chosen.push(copy);
        }
        return applyOrder(chosen);
    }
    for (const row of selection) {
        const item = items.find((candidate) => candidate.id === row.id);
        if (!item || chosen.some((candidate) => candidate.id === item.id)) continue;
        const copy = JSON.parse(JSON.stringify(item)) as AnyPrepareItem;
        if (row.data && typeof row.data === 'object') {
            const data = copy.data as unknown as Record<string, unknown>;
            for (const [key, value] of Object.entries(row.data)) {
                if (key in data && typeof value === typeof data[key]) data[key] = value;
            }
        }
        copy.scope = isPrepareScope(row.scope) ? row.scope : item.scope === 'character' ? 'character' : defaultScope;
        chosen.push(copy);
    }
    return applyOrder(chosen);
}

/* ------------------------------------------------------------------ canon entries */

export interface CanonEntryDraft {
    type: EntryTypeId;
    /** Entry title (comment). */
    title: string;
    /** Typed field values (stored next to the type). */
    fields: Record<string, string>;
    /** Composed English content. */
    content: string;
    /** Names, English names and Russian forms (Russian keys from DES-RU are added by the feature). */
    keys: string[];
}

/** What a name in a field points at: a person (relations, leaders, owners, the cast) or a place (parents, scenes). */
export type NameRef = 'person' | 'place';

/**
 * A name as the canon writes it: the English name of the plan's item it points at (of the kind the field names first:
 * characters for people, places for places), else as given.
 */
export type EnglishName = (name: string, ref?: NameRef) => string;

const asGiven: EnglishName = (name) => name;

const REF_KINDS: Record<NameRef, readonly PrepareKind[]> = {
    person: ['character', 'faction', 'place', 'item', 'tradition', 'world'],
    place: ['place', 'world', 'faction', 'character', 'item', 'tradition'],
};

/**
 * The plan's names → their English names (characters, places, factions, items, traditions, the world: by name, English
 * name or form), so canon texts of a Russian story name other items in English.
 */
export function englishNames(plan: readonly AnyPrepareItem[]): EnglishName {
    const maps = new Map<PrepareKind, Map<string, string>>();
    for (const item of plan) {
        if (!NAMED_SECTIONS.has(item.kind) && item.kind !== 'world') continue;
        const data = item.data as NamedData;
        const english = data.english.trim();
        if (!english) continue;
        let map = maps.get(item.kind);
        if (!map) maps.set(item.kind, (map = new Map()));
        for (const name of [data.name, english, ...data.forms]) {
            const key = normName(name);
            if (key && !map.has(key)) map.set(key, english);
        }
    }
    return (name, ref = 'person') => {
        const value = String(name ?? '').trim();
        const key = normName(value);
        for (const kind of REF_KINDS[ref]) {
            const found = maps.get(kind)?.get(key);
            if (found) return found;
        }
        return value;
    };
}

function lines(rows: readonly [string, string][]): string {
    return rows
        .filter(([, value]) => value.trim())
        .map(([label, value]) => `${label}: ${value.trim()}`)
        .join('\n');
}

/** The typed canon entry of an item; null for kinds that are not canon (secrets, mechanics…) and the persona. */
export function canonDraftOf(
    item: AnyPrepareItem,
    options: {
        /** The plan has starting scenes: each writes its own «Story start», so the calendar note leaves the start out. */
        scenes?: boolean;
        /** Other items' names as the canon writes them (englishNames of the plan); as given without it. */
        english?: EnglishName;
    } = {},
): CanonEntryDraft | null {
    const en = options.english ?? asGiven;
    switch (item.kind) {
        case 'character': {
            if (item.data.persona) return null;
            const data = item.data;
            const title = data.english || data.name;
            const fields: Record<string, string> = {
                name: title,
                aliases: data.english && data.name !== data.english ? data.name : '',
                role: data.role,
                appearance: data.appearance,
                personality: data.personality,
                relationships: data.relations.map((row) => `${en(row.to)}: ${row.relation}`).join('\n'),
                speech: data.speech,
            };
            return draft('character', title, fields, [data.name, data.english, ...data.forms]);
        }
        case 'place': {
            const data = item.data;
            const title = data.english || data.name;
            const fields: Record<string, string> = {
                name: title,
                aliases: data.english && data.name !== data.english ? data.name : '',
                kind: data.kind,
                location: data.parent ? en(data.parent, 'place') : '',
                description: data.description,
                atmosphere: data.state ? `At the start of the story: ${data.state}` : '',
            };
            return draft('place', title, fields, [data.name, data.english, ...data.forms]);
        }
        case 'faction': {
            const data = item.data;
            const title = data.english || data.name;
            const fields: Record<string, string> = {
                name: title,
                aliases: data.english && data.name !== data.english ? data.name : '',
                leader: data.leader ? en(data.leader) : '',
                goals: data.goals,
                symbols: data.description,
            };
            return draft('faction', title, fields, [data.name, data.english, ...data.forms]);
        }
        case 'item': {
            const data = item.data;
            const title = data.english || data.name;
            const fields: Record<string, string> = {
                name: title,
                aliases: data.english && data.name !== data.english ? data.name : '',
                properties: data.description,
                owner: data.owner ? en(data.owner) : '',
            };
            return draft('item', title, fields, [data.name, data.english, ...data.forms]);
        }
        case 'tradition': {
            const data = item.data;
            const title = data.english || data.name;
            const fields: Record<string, string> = {
                name: title,
                when: data.when,
                practice: data.practice,
                meaning: data.meaning,
            };
            return draft('tradition', title, fields, [data.name, data.english, ...data.forms]);
        }
        case 'world': {
            const data = item.data;
            const title = data.english || data.name || 'World';
            const text = lines([
                ['Setting', data.setting],
                ['Era', data.era],
                ['Tone', data.tone],
                ['Laws of the world', data.laws],
                ['Customs and taboos', data.customs],
            ]);
            if (!text) return null;
            return draft('note', title, { name: title, text }, [data.name, data.english, ...data.forms]);
        }
        case 'time': {
            const data = item.data;
            const start = options.scenes ? '' : [data.date, data.time].filter(Boolean).join(', ');
            const text = lines([
                ['The story starts', start],
                ['Calendar', data.calendar],
            ]);
            if (!text) return null;
            return draft('note', 'Story calendar', { name: 'Story calendar', text }, [
                'calendar',
                'календарь',
                data.date,
            ]);
        }
        default:
            return null;
    }
}

function draft(
    type: EntryTypeId,
    title: string,
    fields: Record<string, string>,
    keys: readonly string[],
): CanonEntryDraft {
    const clean = Object.fromEntries(Object.entries(fields).map(([key, value]) => [key, value.trim()]));
    return {
        type,
        title,
        fields: clean,
        content: composeContent({ type, fields: clean }),
        keys: uniqueNames(keys.filter((key) => key && key.length <= 80)),
    };
}

/* ------------------------------------------------------------------ starting scenes */

/** A starting outfit as the wardrobe takes it: who (as the story writes it), their English name, what they wear. */
export interface StartOutfit {
    name: string;
    english: string;
    wearing: string;
}

function characterItems(plan: readonly AnyPrepareItem[]): PrepareItem<'character'>[] {
    return plan.filter((item): item is PrepareItem<'character'> => item.kind === 'character');
}

function namesOf(character: PrepareItem<'character'>): string[] {
    return [character.data.name, character.data.english, ...character.data.forms].map((name) => normName(name));
}

/** The plan's character a name points at (name, English name or a form). */
export function characterNamed(plan: readonly AnyPrepareItem[], name: string): PrepareItem<'character'> | undefined {
    const wanted = normName(name);
    if (!wanted) return undefined;
    return characterItems(plan).find((character) => namesOf(character).includes(wanted));
}

/**
 * The starting outfits of a scene: its own when it lists any (scenes win), else the outfits of the characters present
 * in it (or marked present) — plans read before every greeting had a scene of its own. Never the player's character.
 */
export function sceneOutfits(scene: SceneData, plan: readonly AnyPrepareItem[]): StartOutfit[] {
    const out: StartOutfit[] = [];
    if (scene.outfits.length) {
        for (const row of scene.outfits) {
            const character = characterNamed(plan, row.name);
            if (character?.data.persona || !row.wearing.trim()) continue;
            const name = character?.data.name || row.name;
            if (out.some((other) => normName(other.name) === normName(name))) continue;
            out.push({ name, english: character?.data.english ?? '', wearing: row.wearing.trim() });
        }
        return out;
    }
    const present = new Set(scene.present.map((name) => normName(name)));
    for (const character of characterItems(plan)) {
        const data = character.data;
        if (data.persona || !data.outfit.trim()) continue;
        if (!data.present && !namesOf(character).some((name) => present.has(name))) continue;
        out.push({ name: data.name, english: data.english, wearing: data.outfit.trim() });
    }
    return out;
}

/** The type of a start's first scene: its own, else the direction's (the plan's fallback). */
export function sceneFirstScene(scene: SceneData, plan: readonly AnyPrepareItem[]): FirstScene | '' {
    if (scene.firstScene) return scene.firstScene;
    const direction = plan.find((item): item is PrepareItem<'direction'> => item.kind === 'direction');
    return direction?.data.firstScene ?? '';
}

/** What a character wears when a start begins: the scene's outfit for them, else their own `outfit`. */
export function outfitAtStart(
    character: PrepareItem<'character'>,
    scene: SceneData | null,
    plan: readonly AnyPrepareItem[],
): string {
    if (scene) {
        const names = namesOf(character);
        const found = sceneOutfits(scene, plan).find((row) => names.includes(normName(row.name)));
        if (found) return found.wearing;
    }
    return character.data.outfit.trim();
}

/** Title of the canon note of the start (one per chat: replaced when the start changes). */
export const START_NOTE_TITLE = 'Story start';

/** English names of a start's place and cast, kept with the stored scene (the canon note names them in English). */
export interface StartNames {
    place: string;
    present: string[];
}

/** The English names of a scene's place and cast (englishNames of the plan); null when they are the scene's own. */
export function startNames(scene: SceneData, english: EnglishName): StartNames | null {
    const names: StartNames = {
        place: scene.place.trim() ? english(scene.place, 'place') : '',
        present: scene.present.map((name) => english(name)),
    };
    const same =
        names.place === scene.place.trim() && names.present.every((name, index) => name === scene.present[index]);
    return same ? null : names;
}

/**
 * The canon note of a start: when, where, who and what is going on (English; the place and the cast by their English
 * names when known, the place's own name stays a key); null when the scene says nothing.
 */
export function startNoteDraft(scene: SceneData, names?: StartNames | null): CanonEntryDraft | null {
    const place = names?.place || scene.place;
    const present = names?.present.length ? names.present : scene.present;
    const text = lines([
        ['When', [scene.date, scene.time].filter((part) => part.trim()).join(', ')],
        ['Where', place],
        ['Present', present.join(', ')],
        ['Situation', scene.situation],
    ]);
    if (!text) return null;
    return draft('note', START_NOTE_TITLE, { name: START_NOTE_TITLE, text }, [
        'story start',
        'начало истории',
        scene.place,
        place,
    ]);
}

/**
 * What the wardrobe is told about a starting outfit (its revision route, wardrobe-tags outfitFromStatement): an English
 * sentence for an English wording («Vera wears a quilted watch jacket»), a Russian one for a Russian wording («Вера
 * носит: стёганая куртка портовой стражи») — the wardrobe keeps the wording after the verb as the player reads it.
 */
export function outfitStatement(outfit: StartOutfit): string {
    const wearing = outfit.wearing.trim();
    if (hasCyrillic(wearing)) return `${outfit.name} носит: ${wearing}`;
    return `${outfit.english || outfit.name} wears ${wearing}`;
}

/* ------------------------------------------------------------------ mechanics */

function holdersOf(data: MechanicData): HolderSpec {
    switch (data.holders) {
        case 'persona':
            return { kind: 'persona' };
        case 'world':
            return { kind: 'world' };
        case 'named':
            return { kind: 'named', names: [...data.holderNames] };
        case 'factions':
            return { kind: 'factions', names: [...data.holderNames] };
        default:
            return { kind: 'characters', includePersona: true };
    }
}

function attributeOf(row: MechanicData['attributes'][number], taken: Set<string>): AttributeDef {
    const id = uniqueId(snakeId(row.english || row.name, 'attr'), taken);
    taken.add(id);
    const attribute: AttributeDef = { id, name: row.name, promptName: row.english || row.name, kind: row.kind };
    if (row.kind === 'number') {
        if (row.min !== null) attribute.min = row.min;
        if (row.max !== null) attribute.max = row.max;
        const initial = Number(row.initial);
        if (row.initial.trim() && Number.isFinite(initial)) attribute.initial = initial;
    } else if (row.kind === 'scale') {
        attribute.levels = cleanList(row.levels);
        if (row.initial.trim()) attribute.initial = row.initial.trim();
    } else if (row.kind === 'list') {
        attribute.options = cleanList(row.options);
        if (row.initial.trim()) attribute.initial = cleanList(row.initial);
    } else if (row.initial.trim()) {
        attribute.initial = row.initial.trim();
    }
    return attribute;
}

/**
 * The definition a mechanic item makes: the base (a template's definition or an existing one) with the item's names,
 * texts and new attributes laid over it, or a new definition from the item alone. `scope` is where it applies.
 */
export function mechanicDefOf(
    data: MechanicData,
    base: MechanicDef | null,
    scope: MechanicScope,
    takenIds: Iterable<string>,
): MechanicDef {
    if (base) {
        const def: MechanicDef = JSON.parse(JSON.stringify(base)) as MechanicDef;
        if (data.name) def.name = data.name;
        if (data.english) def.promptName = data.english;
        if (data.summary) def.summary = data.summary;
        if (data.rules) def.rules = def.rules ? `${def.rules}\n${data.rules}` : data.rules;
        const taken = new Set(def.attributes.map((attribute) => attribute.id));
        for (const row of data.attributes) {
            if (findAttribute(def, row.english) || findAttribute(def, row.name)) continue;
            def.attributes.push(attributeOf(row, taken));
        }
        def.scope = JSON.parse(JSON.stringify(scope)) as MechanicScope;
        return def;
    }
    const taken = new Set<string>();
    return {
        id: newMechanicId(data.english || data.name, takenIds),
        name: data.name || data.english,
        ...(data.english ? { promptName: data.english } : {}),
        summary: data.summary,
        rules: data.rules,
        attributes: data.attributes.map((row) => attributeOf(row, taken)),
        holders: holdersOf(data),
        checks: [],
        tracking: 'background',
        scope: JSON.parse(JSON.stringify(scope)) as MechanicScope,
    };
}

/** An attribute of a definition by id, display name or English name. */
export function findAttribute(def: Pick<MechanicDef, 'attributes'>, name: string): AttributeDef | undefined {
    const wanted = normName(name);
    if (!wanted) return undefined;
    return def.attributes.find((attribute) =>
        [attribute.id, attribute.name, attribute.promptName].some((value) => normName(value) === wanted),
    );
}

/** A starting value typed as text, read for the attribute's kind; null when it does not fit. */
export function attributeValue(attribute: AttributeDef, value: string): AttributeValue | null {
    const text = value.trim();
    if (!text) return null;
    switch (attribute.kind) {
        case 'number': {
            const match = /[-+]?\d+(?:[.,]\d+)?/.exec(text);
            const number = match ? Number(match[0].replace(',', '.')) : NaN;
            if (!Number.isFinite(number)) return null;
            let clamped = number;
            if (attribute.min !== undefined) clamped = Math.max(attribute.min, clamped);
            if (attribute.max !== undefined) clamped = Math.min(attribute.max, clamped);
            return clamped;
        }
        case 'scale': {
            const level = (attribute.levels ?? []).find((item) => normName(item) === normName(text));
            return level ?? null;
        }
        case 'list': {
            const options = attribute.options ?? [];
            const picked = cleanList(text)
                .map((part) => options.find((option) => normName(option) === normName(part)))
                .filter((part): part is string => !!part);
            if (!picked.length) return null;
            return attribute.multi ? picked : picked.slice(0, 1);
        }
        default:
            return text;
    }
}

export interface StartingValue {
    holder: string;
    attribute: string;
    value: AttributeValue;
}

/** The item's starting values that fit the definition (attribute found, value readable). */
export function startingValues(data: MechanicData, def: MechanicDef): { values: StartingValue[]; dropped: number } {
    const values: StartingValue[] = [];
    let dropped = 0;
    for (const row of data.initial) {
        const attribute = findAttribute(def, row.attribute);
        const value = attribute ? attributeValue(attribute, row.value) : null;
        if (!attribute || value === null) {
            dropped++;
            continue;
        }
        values.push({ holder: row.holder.trim(), attribute: attribute.id, value });
    }
    return { values, dropped };
}

/* ------------------------------------------------------------------ «Готово к игре» */

export interface ReadyFacts {
    /** Characters of the story (not the persona) with what they have. */
    characters: { name: string; present: boolean; passport: boolean; portrait: boolean }[];
    places: { name: string; registered: boolean; background: boolean }[];
    /** The plan was applied (nothing applied yet: everything is «not prepared»). */
    applied: boolean;
}

export type MissingKind = 'plan' | 'passport' | 'portrait' | 'place' | 'background';

export interface MissingItem {
    kind: MissingKind;
    /** Who or what lacks it ('' for the plan itself). */
    name: string;
}

/** What is still missing before the first move: passports and portraits of those present, places and backgrounds. */
export function missingForPlay(facts: ReadyFacts): MissingItem[] {
    const out: MissingItem[] = [];
    if (!facts.applied) out.push({ kind: 'plan', name: '' });
    for (const character of facts.characters) {
        if (!character.passport) out.push({ kind: 'passport', name: character.name });
        if (character.present && !character.portrait) out.push({ kind: 'portrait', name: character.name });
    }
    for (const place of facts.places) {
        if (!place.registered) out.push({ kind: 'place', name: place.name });
        else if (!place.background) out.push({ kind: 'background', name: place.name });
    }
    return out;
}
