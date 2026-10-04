// World model identity resolution (M7, plan §4.2, dev-plan 3.1): records from every store of the stack (cards, the
// persona, the DES roster, NAI passports, CK archives, typed lorebook and canon entries, the place registry) are
// glued into entities. One person under several names is merged by:
// - the same normalised name in one family (characters and the persona share a family);
// - DES canonical alias groups (DES-RU's view of them too);
// - the chat alias map and the user's merge decisions;
// - an alias of one record (passport alias, entry key) equal to the name of exactly one other entity.
// A Russian form of an English name is never guessed: it only joins through DES/DES-RU aliases.
// Doubtful cases become merge candidates instead (one name claimed by two entities of one kind; a short first name
// matching full names; two cards/personas/places that an alias would glue). Pure: no DOM, no SillyTavern.
import type { WorldKind } from './world-names';
import { entityIdOf, kindFamily, kindOrder, normalizeName, pairKey, wordsOf } from './world-names';

export type WorldSourceKind =
    | 'card'
    | 'persona'
    | 'des.character'
    | 'des.alias'
    | 'chat.alias'
    | 'lore.entry'
    | 'canon.entry'
    | 'ck.archive'
    | 'nai.passport'
    | 'qvink.memory'
    | 'place';

/** Same shape as `EntitySource` of the world API. */
export interface WorldSource {
    kind: WorldSourceKind;
    ref: string;
    label: string;
    world?: string;
    uid?: number;
    messageIndex?: number;
    passportId?: string;
    avatar?: string;
}

/** Same shape as `Entity` of the world API. */
export interface WorldEntity {
    id: string;
    kind: WorldKind;
    name: string;
    aliases: string[];
    forms: string[];
    sources: WorldSource[];
    present?: boolean;
}

/** Same shape as `MergeCandidate` of the world API. */
export interface WorldCandidate {
    a: string;
    b: string;
    /** 'sharedName' | 'sharedAlias' | 'firstName' | 'anchors'. */
    reason: string;
    score: number;
    /** The name both entities answer to. */
    name?: string;
}

/** What one store knows about one entity. */
export interface WorldRecord {
    kind: WorldKind;
    name: string;
    /** Other names this store gives (passport aliases, entry keys that look like names). They may glue records. */
    aliases?: readonly string[];
    /** Extra search forms given by the store (the place registry keeps its own case forms). */
    forms?: readonly string[];
    source: WorldSource;
    /** Fixed entity id (places use their registry id). */
    id?: string;
    /** Canonical-name priority, lower wins (card 1 … DES roster 5). */
    rank?: number;
    present?: boolean;
    /** Kept only when one of its names is already known (archives of CK repos that are not active). */
    optional?: boolean;
}

/** A lorebook entry without a known type: attached as a source to the entity it names, never an entity itself. */
export interface WorldAttach {
    names: readonly string[];
    source: WorldSource;
}

export interface WorldDecisions {
    /** Chat alias map: alias → entity id. */
    aliases: Record<string, string>;
    /** Merged entity id → kept entity id. */
    merged: Record<string, string>;
    /** Pair keys (pairKey) of entities declared different. */
    separated: readonly string[];
}

export interface AssembleInput {
    records: readonly WorldRecord[];
    attach?: readonly WorldAttach[];
    /** DES canonical aliases `{canonical: [aliases]}` (DES's and DES-RU's views). */
    aliasGroups?: readonly Readonly<Record<string, readonly string[]>>[];
    decisions?: WorldDecisions;
    /** Russian case forms of a name (DES-RU), the name itself included or not. */
    forms?: (name: string) => readonly string[];
}

/** 0 = a name of the entity, 1 = an alias, 2 = a case form. */
export interface WorldIndexHit {
    id: string;
    strength: 0 | 1 | 2;
}

export interface WorldBuild {
    entities: WorldEntity[];
    byId: Map<string, WorldEntity>;
    /** Normalised name, alias or form → entities. */
    index: Map<string, WorldIndexHit[]>;
    candidates: WorldCandidate[];
    /** Former or per-record ids (`kind:name` of a merged record, a kept id) → the entity id now. */
    redirects: Map<string, string>;
}

const DEFAULT_RANK = 9;
const SCORE = { sharedName: 0.6, sharedAlias: 0.5, firstNameUnique: 0.7, firstNameMany: 0.4, anchors: 0.5 };
/** Sources that make an entity distinct by themselves: two of them never merge without the user. */
const ANCHOR_SOURCES = new Set<WorldSourceKind>(['card', 'persona', 'place']);

interface Group {
    members: number[];
    desCanonical?: string;
    extraAliases: string[];
    /** Where the extra aliases come from (DES alias groups, the chat alias map). */
    extraSources: WorldSource[];
    forcedId?: string;
}

class Groups {
    private readonly parent: number[];
    private readonly data = new Map<number, Group>();

    constructor(
        private readonly records: readonly WorldRecord[],
        private readonly separated: ReadonlySet<string>,
    ) {
        this.parent = records.map((_, index) => index);
        records.forEach((_, index) => this.data.set(index, { members: [index], extraAliases: [], extraSources: [] }));
    }

    find(index: number): number {
        let root = index;
        while (this.parent[root] !== root) root = this.parent[root] ?? root;
        let node = index;
        while (this.parent[node] !== root) {
            const next = this.parent[node] ?? root;
            this.parent[node] = root;
            node = next;
        }
        return root;
    }

    group(index: number): Group {
        return this.data.get(this.find(index)) as Group;
    }

    roots(): number[] {
        return [...this.data.keys()].sort((a, b) => a - b);
    }

    union(a: number, b: number): number {
        const ra = this.find(a);
        const rb = this.find(b);
        if (ra === rb) return ra;
        const [keep, drop] = ra < rb ? [ra, rb] : [rb, ra];
        const kept = this.data.get(keep) as Group;
        const dropped = this.data.get(drop) as Group;
        kept.members.push(...dropped.members);
        kept.extraAliases.push(...dropped.extraAliases);
        kept.extraSources.push(...dropped.extraSources);
        kept.desCanonical ??= dropped.desCanonical;
        kept.forcedId ??= dropped.forcedId;
        this.parent[drop] = keep;
        this.data.delete(drop);
        return keep;
    }

    /** The member that names the group: lowest rank, then first seen. */
    lead(root: number): WorldRecord {
        const group = this.group(root);
        let best = group.members[0] as number;
        for (const member of group.members) {
            const rank = this.records[member]?.rank ?? DEFAULT_RANK;
            const bestRank = this.records[best]?.rank ?? DEFAULT_RANK;
            if (rank < bestRank || (rank === bestRank && member < best)) best = member;
        }
        return this.records[best] as WorldRecord;
    }

    rank(root: number): number {
        return this.lead(root).rank ?? DEFAULT_RANK;
    }

    kind(root: number): WorldKind {
        const group = this.group(root);
        if (group.members.some((member) => this.records[member]?.kind === 'persona')) return 'persona';
        return this.lead(root).kind;
    }

    name(root: number): string {
        return this.group(root).desCanonical ?? this.lead(root).name.trim();
    }

    id(root: number): string {
        const group = this.group(root);
        if (group.forcedId) return group.forcedId;
        const fixed = group.members
            .map((member) => this.records[member])
            .filter((record): record is WorldRecord => !!record?.id)
            .sort((a, b) => (a.rank ?? DEFAULT_RANK) - (b.rank ?? DEFAULT_RANK))[0];
        if (fixed?.id) return fixed.id;
        return entityIdOf(this.kind(root), this.name(root));
    }

    /** Normalised primary names of the members. */
    primaryNames(root: number): Set<string> {
        const names = new Set<string>();
        for (const member of this.group(root).members) {
            const name = normalizeName(this.records[member]?.name ?? '');
            if (name) names.add(name);
        }
        const canonical = this.group(root).desCanonical;
        if (canonical) names.add(normalizeName(canonical));
        return names;
    }

    /** Every normalised name: primary names, own aliases, DES group names and chat aliases. */
    allNames(root: number): Set<string> {
        const names = this.primaryNames(root);
        const group = this.group(root);
        for (const member of group.members) {
            for (const alias of this.records[member]?.aliases ?? []) {
                const name = normalizeName(alias);
                if (name) names.add(name);
            }
        }
        for (const alias of group.extraAliases) {
            const name = normalizeName(alias);
            if (name) names.add(name);
        }
        return names;
    }

    anchors(root: number): number {
        const refs = new Set<string>();
        for (const member of this.group(root).members) {
            const source = this.records[member]?.source;
            if (source && ANCHOR_SOURCES.has(source.kind)) refs.add(`${source.kind}\u0000${source.ref}`);
        }
        return refs.size;
    }

    isSeparated(a: number, b: number): boolean {
        return this.separated.has(pairKey(this.id(a), this.id(b)));
    }
}

function family(kind: string): string {
    return kindFamily(kind);
}

/** Drops optional records none of whose names is known from the other records (or DES groups linked to them). */
function keepKnown(input: AssembleInput): WorldRecord[] {
    const base = input.records.filter((record) => !record.optional);
    const optional = input.records.filter((record) => record.optional);
    if (!optional.length) return [...base];
    const known = new Set<string>();
    for (const record of base) {
        for (const name of [record.name, ...(record.aliases ?? [])]) known.add(normalizeName(name));
    }
    for (const groups of input.aliasGroups ?? []) {
        for (const [canonical, list] of Object.entries(groups)) {
            const names = [canonical, ...list].map(normalizeName);
            if (names.some((name) => known.has(name))) for (const name of names) known.add(name);
        }
    }
    known.delete('');
    const kept = optional.filter((record) =>
        [record.name, ...(record.aliases ?? [])].some((name) => known.has(normalizeName(name))),
    );
    return [...base, ...kept];
}

function addCandidate(
    out: Map<string, { a: number; b: number; reason: string; score: number; name?: string }>,
    groups: Groups,
    x: number,
    y: number,
    reason: string,
    score: number,
    name?: string,
): void {
    const rx = groups.find(x);
    const ry = groups.find(y);
    if (rx === ry || groups.isSeparated(rx, ry)) return;
    // The kept side is the more authoritative one (card before passport before roster).
    const [a, b] = groups.rank(rx) <= groups.rank(ry) ? [rx, ry] : [ry, rx];
    const key = pairKey(String(a), String(b));
    const known = out.get(key);
    if (!known || known.score < score) out.set(key, { a, b, reason, score, name });
}

/** Builds the entities, the name index and the merge candidates. Deterministic for the same input. */
export function assembleWorld(input: AssembleInput): WorldBuild {
    const records = keepKnown(input).filter((record) => normalizeName(record.name));
    const decisions: WorldDecisions = input.decisions ?? { aliases: {}, merged: {}, separated: [] };
    const groups = new Groups(records, new Set(decisions.separated));

    // 1. Same normalised name in one family; 2. same fixed id.
    const byName = new Map<string, number>();
    const byId = new Map<string, number>();
    records.forEach((record, index) => {
        const key = `${family(record.kind)}\u0000${normalizeName(record.name)}`;
        const first = byName.get(key);
        if (first === undefined) byName.set(key, index);
        else groups.union(first, index);
        if (record.id) {
            const same = byId.get(record.id);
            if (same === undefined) byId.set(record.id, index);
            else groups.union(same, index);
        }
    });

    // 3. DES canonical alias groups (people only): every record named by a group is one entity.
    const beingNames = new Map<string, number[]>();
    records.forEach((record, index) => {
        if (family(record.kind) !== 'being') return;
        for (const name of [record.name, ...(record.aliases ?? [])]) {
            const key = normalizeName(name);
            if (!key) continue;
            const list = beingNames.get(key) ?? [];
            if (!list.includes(index)) list.push(index);
            beingNames.set(key, list);
        }
    });
    for (const aliasGroups of input.aliasGroups ?? []) {
        for (const [canonical, list] of Object.entries(aliasGroups)) {
            const names = [canonical, ...list].filter((name) => typeof name === 'string' && name.trim());
            const members = new Set<number>();
            for (const name of names) for (const index of beingNames.get(normalizeName(name)) ?? []) members.add(index);
            if (!members.size) continue;
            const [first, ...rest] = [...members];
            let root = first as number;
            for (const other of rest) root = groups.union(root, other);
            const group = groups.group(root);
            group.desCanonical ??= canonical.trim();
            group.extraAliases.push(...names.map((name) => name.trim()));
            group.extraSources.push({ kind: 'des.alias', ref: canonical.trim(), label: canonical.trim() });
        }
    }

    // 4. The user's decisions: merges (keep the kept id) and chat aliases (glue the named entity to the target).
    const lookup = (): Map<string, number> => {
        const map = new Map<string, number>();
        for (const root of groups.roots()) map.set(groups.id(root), root);
        records.forEach((record, index) => {
            const own = record.id ?? entityIdOf(record.kind, record.name);
            if (!map.has(own)) map.set(own, groups.find(index));
        });
        return map;
    };
    let ids = lookup();
    for (const [mergeId, keepId] of Object.entries(decisions.merged)) {
        const merge = ids.get(mergeId);
        const keep = ids.get(keepId);
        if (merge === undefined || keep === undefined) continue;
        const rm = groups.find(merge);
        const rk = groups.find(keep);
        if (rm === rk) continue;
        const kept = groups.id(rk);
        groups.group(groups.union(rk, rm)).forcedId = kept;
        ids = lookup();
    }
    for (const [alias, targetId] of Object.entries(decisions.aliases)) {
        const target = ids.get(targetId);
        const name = normalizeName(alias);
        if (target === undefined || !name) continue;
        let root = groups.find(target);
        const targetFamily = family(groups.kind(root));
        const kept = groups.id(root);
        let merged = false;
        for (const other of groups.roots()) {
            if (other === root || family(groups.kind(other)) !== targetFamily) continue;
            if (!groups.allNames(other).has(name)) continue;
            root = groups.union(root, other);
            merged = true;
        }
        const group = groups.group(root);
        if (merged) group.forcedId = kept;
        group.extraAliases.push(alias.trim());
        group.extraSources.push({ kind: 'chat.alias', ref: alias.trim(), label: alias.trim() });
        if (merged) ids = lookup();
    }

    // 5. Glue by own aliases; doubtful claims become candidates.
    const candidates = new Map<string, { a: number; b: number; reason: string; score: number; name?: string }>();
    const claims = new Map<string, { raw: string; claimants: Set<number> }>();
    records.forEach((record, index) => {
        for (const alias of record.aliases ?? []) {
            const name = normalizeName(alias);
            if (!name) continue;
            const key = `${family(record.kind)}\u0000${name}`;
            const claim = claims.get(key) ?? { raw: alias.trim(), claimants: new Set<number>() };
            claim.claimants.add(index);
            claims.set(key, claim);
        }
    });
    // Owners of a name: records named so, and groups whose DES canonical it is (roots are re-read after unions).
    const primaryIndex = new Map<string, number[]>();
    const addPrimary = (key: string, index: number) => {
        const list = primaryIndex.get(key) ?? [];
        list.push(index);
        primaryIndex.set(key, list);
    };
    records.forEach((record, index) => addPrimary(`${family(record.kind)}\u0000${normalizeName(record.name)}`, index));
    for (const root of groups.roots()) {
        const canonical = groups.group(root).desCanonical;
        if (canonical) addPrimary(`${family(groups.kind(root))}\u0000${normalizeName(canonical)}`, root);
    }
    for (const [key, claim] of claims) {
        const owners = new Set((primaryIndex.get(key) ?? []).map((index) => groups.find(index)));
        const claimants = new Set<number>();
        for (const index of claim.claimants) {
            const root = groups.find(index);
            if (!owners.has(root)) claimants.add(root);
        }
        if (owners.size === 1) {
            const owner = [...owners][0] as number;
            if (claimants.size === 1) {
                const other = [...claimants][0] as number;
                if (groups.anchors(owner) > 0 && groups.anchors(other) > 0) {
                    addCandidate(candidates, groups, owner, other, 'anchors', SCORE.anchors, claim.raw);
                } else if (!groups.isSeparated(owner, other)) {
                    groups.union(owner, other);
                }
            } else {
                for (const other of claimants) {
                    addCandidate(candidates, groups, owner, other, 'sharedAlias', SCORE.sharedAlias, claim.raw);
                }
            }
        } else if (owners.size === 0 && claimants.size >= 2) {
            const list = [...claimants];
            for (let i = 0; i < list.length; i++) {
                for (let j = i + 1; j < list.length; j++) {
                    const x = list[i] as number;
                    const y = list[j] as number;
                    if (groups.kind(groups.find(x)) !== groups.kind(groups.find(y))) continue;
                    addCandidate(candidates, groups, x, y, 'sharedName', SCORE.sharedName, claim.raw);
                }
            }
        }
    }

    // 6. A short first name of one entity that starts full names of others.
    const beings = groups.roots().filter((root) => family(groups.kind(root)) === 'being');
    const fullNames = new Map<number, Set<string>>();
    for (const root of beings) {
        const firsts = new Set<string>();
        for (const name of groups.allNames(root)) {
            const words = wordsOf(name);
            if (words.length >= 2 && words[0]) firsts.add(words[0]);
        }
        fullNames.set(root, firsts);
    }
    for (const root of beings) {
        for (const name of groups.primaryNames(root)) {
            if (name.includes(' ') || fullNames.get(root)?.has(name)) continue;
            const hits = beings.filter((other) => other !== root && fullNames.get(other)?.has(name));
            const score = hits.length === 1 ? SCORE.firstNameUnique : SCORE.firstNameMany;
            const raw = records.find((record) => normalizeName(record.name) === name)?.name.trim() ?? name;
            for (const other of hits) addCandidate(candidates, groups, other, root, 'firstName', score, raw);
        }
    }

    // 7. Entities.
    const forms = input.forms ?? (() => []);
    const entities: WorldEntity[] = [];
    const entityOfRoot = new Map<number, WorldEntity>();
    const usedIds = new Set<string>();
    const redirects = new Map<string, string>();
    for (const root of groups.roots()) {
        const group = groups.group(root);
        const members = group.members.map((member) => records[member] as WorldRecord);
        let id = groups.id(root);
        if (usedIds.has(id)) {
            let n = 2;
            while (usedIds.has(`${id}~${n}`)) n++;
            id = `${id}~${n}`;
        }
        usedIds.add(id);
        const name = groups.name(root);
        const nameKey = normalizeName(name);
        const aliases: string[] = [];
        const seen = new Set<string>([nameKey]);
        const addAlias = (value: string) => {
            const key = normalizeName(value);
            if (!key || seen.has(key)) return;
            seen.add(key);
            aliases.push(value.trim());
        };
        for (const record of members) addAlias(record.name);
        for (const record of members) for (const alias of record.aliases ?? []) addAlias(alias);
        for (const alias of group.extraAliases) addAlias(alias);
        const formList: string[] = [];
        const addForm = (value: unknown) => {
            if (typeof value !== 'string') return;
            const key = normalizeName(value);
            if (!key || seen.has(key)) return;
            seen.add(key);
            formList.push(value.trim());
        };
        for (const value of [name, ...aliases]) for (const form of forms(value)) addForm(form);
        for (const record of members) for (const form of record.forms ?? []) addForm(form);
        const sources: WorldSource[] = [];
        const sourceKeys = new Set<string>();
        for (const source of [...members.map((record) => record.source), ...group.extraSources]) {
            const key = `${source.kind}\u0000${source.ref}`;
            if (sourceKeys.has(key)) continue;
            sourceKeys.add(key);
            sources.push({ ...source });
        }
        const entity: WorldEntity = { id, kind: groups.kind(root), name, aliases, forms: formList, sources };
        if (members.some((record) => record.present === true)) entity.present = true;
        else if (members.some((record) => record.present === false)) entity.present = false;
        entities.push(entity);
        entityOfRoot.set(root, entity);
        for (const record of members) {
            const own = record.id ?? entityIdOf(record.kind, record.name);
            if (own !== id && !redirects.has(own)) redirects.set(own, id);
        }
    }
    for (const [mergeId, keepId] of Object.entries(decisions.merged)) {
        const target = redirects.get(keepId) ?? keepId;
        if (!usedIds.has(mergeId) && usedIds.has(target)) redirects.set(mergeId, target);
    }

    // 8. Index: names, aliases, forms.
    const index = new Map<string, WorldIndexHit[]>();
    const indexAdd = (value: string, id: string, strength: 0 | 1 | 2) => {
        const key = normalizeName(value);
        if (!key) return;
        const list = index.get(key) ?? [];
        const known = list.find((hit) => hit.id === id);
        if (known) {
            if (strength < known.strength) known.strength = strength;
        } else {
            list.push({ id, strength });
        }
        index.set(key, list);
    };
    for (const root of groups.roots()) {
        const entity = entityOfRoot.get(root) as WorldEntity;
        indexAdd(entity.name, entity.id, 0);
        for (const name of groups.primaryNames(root)) indexAdd(name, entity.id, 0);
        for (const alias of entity.aliases) indexAdd(alias, entity.id, 1);
        for (const form of entity.forms) indexAdd(form, entity.id, 2);
    }

    // 9. Untyped entries join the entity they name (only when the name is unambiguous).
    for (const item of input.attach ?? []) {
        const ids = new Set<string>();
        for (const name of item.names) {
            for (const hit of index.get(normalizeName(name)) ?? []) if (hit.strength < 2) ids.add(hit.id);
        }
        if (ids.size !== 1) continue;
        const entity = entities.find((candidate) => candidate.id === [...ids][0]);
        if (!entity) continue;
        if (entity.sources.some((source) => source.kind === item.source.kind && source.ref === item.source.ref)) {
            continue;
        }
        entity.sources.push({ ...item.source });
    }

    entities.sort(
        (a, b) =>
            kindOrder(a.kind) - kindOrder(b.kind) ||
            a.name.localeCompare(b.name, 'ru') ||
            (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
    );
    const byEntityId = new Map(entities.map((entity) => [entity.id, entity]));

    const separated = new Set(decisions.separated);
    const finalCandidates: WorldCandidate[] = [];
    const seenPairs = new Set<string>();
    for (const candidate of candidates.values()) {
        const a = entityOfRoot.get(groups.find(candidate.a));
        const b = entityOfRoot.get(groups.find(candidate.b));
        if (!a || !b || a === b) continue;
        const key = pairKey(a.id, b.id);
        if (separated.has(key) || seenPairs.has(key)) continue;
        seenPairs.add(key);
        const item: WorldCandidate = { a: a.id, b: b.id, reason: candidate.reason, score: candidate.score };
        if (candidate.name) item.name = candidate.name;
        finalCandidates.push(item);
    }
    finalCandidates.sort((x, y) => y.score - x.score || (x.a + x.b).localeCompare(y.a + y.b, 'ru'));

    return { entities, byId: byEntityId, index, candidates: finalCandidates, redirects };
}

/** The entity a stale or merged id now belongs to. */
export function entityById(build: WorldBuild, id: string): WorldEntity | undefined {
    return build.byId.get(id) ?? build.byId.get(build.redirects.get(id) ?? '');
}

/**
 * Exact normalised lookup: names first, then aliases, then forms. Several entities on one level → the person among
 * them when there is exactly one (without a kind filter), else nothing (ambiguous).
 */
export function resolveName(build: WorldBuild, name: string, kind?: string): WorldEntity | undefined {
    const key = normalizeName(name);
    if (!key) return undefined;
    const hits = (build.index.get(key) ?? []).filter((hit) => !kind || build.byId.get(hit.id)?.kind === kind);
    for (const strength of [0, 1, 2] as const) {
        const ids = [...new Set(hits.filter((hit) => hit.strength === strength).map((hit) => hit.id))];
        if (ids.length === 1) return build.byId.get(ids[0] as string);
        if (ids.length > 1) {
            if (kind) return undefined;
            const people = ids.filter((id) => family(build.byId.get(id)?.kind ?? '') === 'being');
            return people.length === 1 ? build.byId.get(people[0] as string) : undefined;
        }
    }
    return undefined;
}
