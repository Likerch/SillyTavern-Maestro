// «Подготовить к игре» (M37, plan-2 §7 п. 2–3, п. 6): the parts' answers become one plan — the same character or
// place found in several parts is merged (names, forms and sources joined, texts kept or joined; a starting scene is
// the same one when it names the same greeting), what the chat
// already has is marked «уже есть» (canon by names and keys, the place registry, mechanics, NAI passports, the
// persona, promises, secrets) and a typed canon entry that says otherwise is reported as a conflict. The saved
// character-level preparation is reused: items whose sources did not change stay, the rest is read again. Pure.
import { normName } from './dossier-names';
import { ENTRY_TYPES, fieldsFromContent, isEntryType } from './entry-types';
import type { EntryTypeId } from './entry-types';
import {
    NAMED_SECTIONS,
    SINGLE_SECTIONS,
    clonePlan,
    itemNames,
    sceneGreeting,
    sectionOrder,
    uniqueNames,
} from './prepare-plan';
import type {
    AnyPrepareItem,
    ConflictInfo,
    ItemLinks,
    MechanicData,
    PrepareDataMap,
    PrepareKind,
} from './prepare-plan';
import type { SourceDiff } from './prepare-sources';

type Dict = Record<string, unknown>;

const TEXT_MAX = 1600;

/** Fields kept from the first answer that has them (names, short facts): never joined. */
const KEEP_FIRST: ReadonlySet<string> = new Set([
    'name',
    'english',
    'parent',
    'kind',
    'leader',
    'owner',
    'date',
    'time',
    'place',
    'firstScene',
    'template',
    'holders',
    'genre',
    'about',
    'due',
    'when',
    'role',
    'calendar',
]);

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sameText(a: string, b: string): boolean {
    return normName(a) === normName(b);
}

/** Two texts as one: the longer when one holds the other, else both (clipped). */
export function joinText(a: string, b: string, max = TEXT_MAX): string {
    const left = a.trim();
    const right = b.trim();
    if (!left) return right;
    if (!right) return left;
    const nl = normName(left);
    const nr = normName(right);
    if (nl.includes(nr)) return left;
    if (nr.includes(nl)) return right;
    const joined = `${left}${/[.!?…]$/.test(left) ? '' : '.'} ${right}`;
    return joined.length > max ? `${joined.slice(0, max - 1).trimEnd()}…` : joined;
}

function mergeObjectList(a: unknown[], b: unknown[], keyOf: (row: Dict) => string, joinField?: string): unknown[] {
    const out: Dict[] = a.filter(isDict).map((row) => ({ ...row }));
    for (const row of b.filter(isDict)) {
        const key = keyOf(row);
        const found = key ? out.find((other) => keyOf(other) === key) : undefined;
        if (!found) out.push({ ...row });
        else if (joinField && typeof found[joinField] === 'string' && typeof row[joinField] === 'string') {
            found[joinField] = joinText(found[joinField] as string, row[joinField] as string, 400);
        }
    }
    return out;
}

/** Field-by-field merge of two data objects of one kind (the first wins names and short facts). */
export function mergeData<K extends PrepareKind>(
    kind: K,
    a: PrepareDataMap[K],
    b: PrepareDataMap[K],
): PrepareDataMap[K] {
    const left = a as unknown as Dict;
    const right = b as unknown as Dict;
    const out: Dict = { ...left };
    for (const [key, value] of Object.entries(right)) {
        const current = out[key];
        if (typeof value === 'string') {
            if (typeof current !== 'string' || !current.trim()) out[key] = value;
            else if (!KEEP_FIRST.has(key)) out[key] = joinText(current, value);
        } else if (typeof value === 'boolean') {
            out[key] = current === true || value;
        } else if (typeof value === 'number' || value === null) {
            if (typeof current !== 'number') out[key] = value;
        } else if (Array.isArray(value)) {
            const list = Array.isArray(current) ? current : [];
            if (key === 'relations') {
                out[key] = mergeObjectList(list, value, (row) => normName(row.to), 'relation');
            } else if (key === 'attributes') {
                out[key] = mergeObjectList(list, value, (row) => normName(row.english || row.name));
            } else if (key === 'initial') {
                out[key] = mergeObjectList(list, value, (row) => `${normName(row.holder)}|${normName(row.attribute)}`);
            } else if (key === 'outfits') {
                out[key] = mergeObjectList(list, value, (row) => normName(row.name), 'wearing');
            } else out[key] = uniqueNames([...list, ...value]);
        }
    }
    // Names of the other answer that differ (Elizabeth / Элизабет) become forms.
    if (NAMED_SECTIONS.has(kind) || kind === 'world') {
        const names = [right.name, right.english].filter((name): name is string => typeof name === 'string');
        const own = [out.name, out.english].map((name) => normName(name));
        const extra = names.filter((name) => name.trim() && !own.includes(normName(name)));
        if (extra.length) out.forms = uniqueNames([...(out.forms as string[]), ...extra]);
    }
    return out as unknown as PrepareDataMap[K];
}

/** Normalised names of an item (for matching). */
export function nameKeys(item: AnyPrepareItem): Set<string> {
    return new Set(
        itemNames(item)
            .map((name) => normName(name))
            .filter(Boolean),
    );
}

function overlaps(a: Set<string>, b: Set<string>): boolean {
    for (const value of a) if (b.has(value)) return true;
    return false;
}

/** The same thing in two answers. */
export function sameItem(a: AnyPrepareItem, b: AnyPrepareItem): boolean {
    if (a.kind !== b.kind) return false;
    if (a.id === b.id) return true;
    if (SINGLE_SECTIONS.has(a.kind)) return true;
    if (a.kind === 'mechanic' && b.kind === 'mechanic') {
        const ta = normName(a.data.template);
        if (ta && ta === normName(b.data.template)) return true;
    }
    if (NAMED_SECTIONS.has(a.kind) || a.kind === 'mechanic') {
        // Only the main names (name / English): forms of different people may overlap («Александр» / «Александра»).
        const main = (item: AnyPrepareItem) =>
            new Set(
                [(item.data as { name?: string }).name ?? '', (item.data as { english?: string }).english ?? '']
                    .map((name) => normName(name))
                    .filter(Boolean),
            );
        return overlaps(main(a), main(b));
    }
    if (a.kind === 'secret' && b.kind === 'secret') return sameText(a.data.text, b.data.text);
    if (a.kind === 'promise' && b.kind === 'promise') return sameText(a.data.what, b.data.what);
    return false;
}

/** Merges the parts' answers into one list (first appearance order within each section). */
export function mergeItems(lists: readonly (readonly AnyPrepareItem[])[]): AnyPrepareItem[] {
    const out: AnyPrepareItem[] = [];
    for (const list of lists) {
        for (const item of list) {
            const found = out.find((candidate) => sameItem(candidate, item));
            if (!found) {
                out.push(clonePlan(item));
                continue;
            }
            found.data = mergeData(found.kind, found.data, item.data as never) as never;
            if (!found.russian && item.russian) found.russian = item.russian;
            found.sources = [...new Set([...found.sources, ...item.sources])];
            if (item.scope === 'character') found.scope = 'character';
        }
    }
    return out
        .map((item, index) => ({ item, index }))
        .sort(
            (a, b) =>
                sectionOrder(a.item.kind) - sectionOrder(b.item.kind) ||
                sceneGreeting(a.item) - sceneGreeting(b.item) ||
                a.index - b.index,
        )
        .map(({ item }) => item);
}

/* ------------------------------------------------------------------ what the chat already has */

export interface ExistingEntry {
    uid: number;
    /** Typed entry type when known ('character', 'place', …). */
    type?: string;
    title: string;
    keys: readonly string[];
    content: string;
}

export interface ExistingSnapshot {
    /** This chat's canon additions. */
    canon: readonly ExistingEntry[];
    places: readonly { id: string; name: string; aliases: readonly string[]; forms: readonly string[] }[];
    mechanics: readonly { id: string; name: string; promptName?: string; template?: string }[];
    /** NAI passports this chat sees (card, chat, persona). */
    passports: readonly { id: string; name: string; aliases: readonly string[] }[];
    personaName: string;
    /** Texts of the chat's promises and secrets. */
    promises: readonly string[];
    secrets: readonly string[];
}

export function emptySnapshot(): ExistingSnapshot {
    return { canon: [], places: [], mechanics: [], passports: [], personaName: '', promises: [], secrets: [] };
}

/** Typed fields compared with the canon (field of the entry ← field of the item). */
const CONFLICT_FIELDS: Partial<Record<PrepareKind, { field: string; from: string }[]>> = {
    character: [
        { field: 'role', from: 'role' },
        { field: 'appearance', from: 'appearance' },
        { field: 'personality', from: 'personality' },
    ],
    place: [{ field: 'description', from: 'description' }],
    faction: [
        { field: 'leader', from: 'leader' },
        { field: 'goals', from: 'goals' },
    ],
    item: [{ field: 'owner', from: 'owner' }],
    tradition: [{ field: 'practice', from: 'practice' }],
};

const WORD_RE = /[\p{L}\p{N}]{4,}/gu;

function words(text: string): Set<string> {
    return new Set((normName(text).match(WORD_RE) ?? []).map((word) => word.slice(0, 6)));
}

/** Two values say different things: short ones differ as names, long ones share almost no words. */
export function disagrees(existing: string, proposed: string): boolean {
    const a = existing.trim();
    const b = proposed.trim();
    if (!a || !b) return false;
    const na = normName(a);
    const nb = normName(b);
    if (na === nb || na.includes(nb) || nb.includes(na)) return false;
    const wa = words(a);
    const wb = words(b);
    if (wa.size < 3 || wb.size < 3) return wa.size > 0 && wb.size > 0 && !overlaps(wa, wb);
    let shared = 0;
    for (const word of wa) if (wb.has(word)) shared++;
    return shared / Math.min(wa.size, wb.size) < 0.2;
}

function entryNames(entry: ExistingEntry): Set<string> {
    return new Set([entry.title, ...entry.keys].map((name) => normName(name)).filter(Boolean));
}

const CANON_TYPE: Partial<Record<PrepareKind, EntryTypeId>> = {
    character: 'character',
    place: 'place',
    faction: 'faction',
    item: 'item',
    tradition: 'tradition',
    world: 'note',
};

/** The canon entry of an item: same names (title or keys), an entry of the item's type first. */
export function canonMatch(item: AnyPrepareItem, canon: readonly ExistingEntry[]): ExistingEntry | undefined {
    const names = nameKeys(item);
    if (!names.size) return undefined;
    const matches = canon.filter((entry) => overlaps(names, entryNames(entry)));
    const type = CANON_TYPE[item.kind];
    return matches.find((entry) => entry.type === type) ?? matches.find((entry) => !entry.type);
}

/** Field disagreements between an item and a typed canon entry. */
export function conflictsWith(item: AnyPrepareItem, entry: ExistingEntry): ConflictInfo[] {
    const fields = CONFLICT_FIELDS[item.kind];
    const type = entry.type;
    if (!fields || !type || !isEntryType(type) || !ENTRY_TYPES[type]) return [];
    const existing = fieldsFromContent(type, entry.content);
    const data = item.data as unknown as Dict;
    const out: ConflictInfo[] = [];
    for (const { field, from } of fields) {
        const proposed = typeof data[from] === 'string' ? (data[from] as string) : '';
        const current = existing[field] ?? '';
        if (disagrees(current, proposed)) out.push({ field, with: entry.title, existing: current, proposed });
    }
    return out;
}

function mechanicMatch(
    data: MechanicData,
    mechanics: ExistingSnapshot['mechanics'],
): ExistingSnapshot['mechanics'][number] | undefined {
    const template = data.template.trim();
    if (template) {
        const byId = mechanics.find((def) => def.id === template);
        if (byId) return byId;
    }
    const names = new Set([data.name, data.english].map((name) => normName(name)).filter(Boolean));
    return mechanics.find((def) => [def.name, def.promptName ?? ''].some((name) => name && names.has(normName(name))));
}

/** Marks what exists (and the canon conflicts) on copies of the items. */
export function markExisting(items: readonly AnyPrepareItem[], snapshot: ExistingSnapshot): AnyPrepareItem[] {
    const persona = normName(snapshot.personaName);
    const promiseTexts = new Set(snapshot.promises.map((text) => normName(text)));
    const secretTexts = new Set(snapshot.secrets.map((text) => normName(text)));
    return items.map((source) => {
        const item = clonePlan(source);
        delete item.exists;
        delete item.conflicts;
        const links: ItemLinks = {};
        const names = nameKeys(item);
        if (item.kind === 'character') {
            if (item.data.persona || (persona && names.has(persona))) {
                item.data.persona = true;
                item.exists = { where: 'persona', label: snapshot.personaName || item.data.name };
            }
            const passport = snapshot.passports.find((candidate) =>
                overlaps(names, new Set([candidate.name, ...candidate.aliases].map((name) => normName(name)))),
            );
            if (passport) links.passportId = passport.id;
        }
        if (item.kind === 'place') {
            const place = snapshot.places.find((candidate) =>
                overlaps(
                    names,
                    new Set([candidate.name, ...candidate.aliases, ...candidate.forms].map((name) => normName(name))),
                ),
            );
            if (place) {
                links.placeId = place.id;
                item.exists = { where: 'places', label: place.name, ref: place.id };
            }
        }
        if (NAMED_SECTIONS.has(item.kind) || item.kind === 'world') {
            const entry = canonMatch(item, snapshot.canon);
            if (entry) {
                links.canonUid = entry.uid;
                item.exists ??= { where: 'canon', label: entry.title, ref: entry.uid };
                const conflicts = conflictsWith(item, entry);
                if (conflicts.length) item.conflicts = conflicts;
            }
        }
        if (item.kind === 'mechanic') {
            const def = mechanicMatch(item.data, snapshot.mechanics);
            if (def) {
                links.mechanicId = def.id;
                item.exists = { where: 'mechanics', label: def.name, ref: def.id };
            }
        }
        if (item.kind === 'promise' && promiseTexts.has(normName(item.data.what))) {
            item.exists = { where: 'calendar', label: item.data.what };
        }
        if (item.kind === 'secret' && secretTexts.has(normName(item.data.text))) {
            item.exists = { where: 'knowledge', label: item.data.text };
        }
        if (Object.keys(links).length) item.links = links;
        else delete item.links;
        return item;
    });
}

/* ------------------------------------------------------------------ the saved character-level preparation */

export interface ReusePlan {
    /** Saved items whose sources did not change. */
    kept: AnyPrepareItem[];
    /** Sources to read again: changed, added, and every source of a saved item that touches a changed one. */
    reread: string[];
}

/**
 * What a saved preparation gives a new chat: items untouched by the changes stay (marked saved); an item one of whose
 * sources changed or disappeared is read again from all its remaining sources, together with the new ones.
 */
export function reusePlan(saved: readonly AnyPrepareItem[], diff: SourceDiff, current: readonly string[]): ReusePlan {
    const stale = new Set([...diff.changed, ...diff.removed]);
    const exists = new Set(current);
    const reread = new Set([...diff.changed, ...diff.added].filter((id) => exists.has(id)));
    const kept: AnyPrepareItem[] = [];
    for (const item of saved) {
        if (item.sources.some((id) => stale.has(id))) {
            for (const id of item.sources) if (exists.has(id)) reread.add(id);
            continue;
        }
        kept.push({ ...clonePlan(item), saved: true });
    }
    return { kept, reread: current.filter((id) => reread.has(id)) };
}
