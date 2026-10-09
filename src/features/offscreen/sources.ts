// What the offscreen world reads (plan M16, §9 «минимальный контекст»): the scene of a committed reply (DES tracker:
// who is present, where, when, the open quests), the candidates (world model characters with their sources, DES's
// roster, last sightings), a compact dossier of each picked character (dossier API or the stores: canon and lore,
// relationships from the graph, the place of the last sighting, quests and promises, earlier offscreen events), and a
// short story summary (Qvink long memories, the last chronicle chapter). Every reader degrades: a module or neighbour
// that is off gives nothing.
import { adaptersOf, dramatisOf } from '../../adapters';
import { containsWithLeftBoundary, normalizeForMatch, uniqueStrings } from '../../domain/canon-keys';
import type { DesTrackerSnapshot } from '../../domain/des-tracker';
import { presentNames } from '../../domain/director-scene';
import type { CandidateInput } from '../../domain/offscreen-plan';
import { storyTimeLabel } from '../../domain/offscreen-plan';
import type { OffscreenBrief, OffscreenFact } from '../../domain/offscreen-prompt';
import { cleanLabel, normalizePlaceName } from '../../domain/places-label';
import { cleanForAnalysis } from '../../domain/text-clean';
import { normalizeName } from '../../domain/world-names';
import type { App, Logger } from '../../shared/contracts';
import type { CalendarApi } from '../calendar/api';
import type { CanonApi } from '../canon/api';
import type { ChronicleApi } from '../chronicle/api';
import type { ContradictionsApi } from '../contradictions/api';
import type { DossierApi } from '../dossier/api';
import type { PlacesApi } from '../places/api';
import type { RelationsApi } from '../relations/api';
import type { Entity, WorldModelApi } from '../world/api';
import type { OffscreenDoc } from './store';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** Dossier texts per character at most. */
const MAX_FACTS = 6;
const MAX_RELATIONS = 4;
const MAX_QUESTS = 5;
const EARLIER_EVENTS = 2;
/** Lines of Dramatis's offscreen brief per character at most. */
const ENGINE_LINES = 6;
const MEMORY_SCAN = 400;
const LONG_MEMORIES = 5;
const RECENT_MEMORIES = 3;
const CHAPTER_CHARS = 900;

/** One present character of a scene. */
export interface PresentCharacter {
    name: string;
    key: string;
}

/** The scene of a committed reply as the offscreen world sees it. */
export interface SceneInfo {
    index: number;
    present: PresentCharacter[];
    /** DES location label. */
    place?: string;
    placeKey: string | null;
    storyTime?: string;
    /** DES quests: the main one first. */
    quests: string[];
}

export interface CharacterBrief {
    brief: OffscreenBrief;
    /** Texts the event must not contradict (dossier, earlier events, quests). */
    against: OffscreenFact[];
    entity?: Entity;
}

export class OffscreenSources {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /* ---------------------------------------------------------------- module APIs */

    world(): WorldModelApi | undefined {
        return this.app.modules.api<WorldModelApi>('world');
    }
    places(): PlacesApi | undefined {
        return this.app.modules.api<PlacesApi>('places');
    }
    relations(): RelationsApi | undefined {
        return this.app.modules.api<RelationsApi>('relations');
    }
    canon(): CanonApi | undefined {
        return this.app.modules.api<CanonApi>('canon');
    }
    contradictions(): ContradictionsApi | undefined {
        return this.app.modules.api<ContradictionsApi>('contradictions');
    }
    chronicle(): ChronicleApi | undefined {
        return this.app.modules.api<ChronicleApi>('chronicle');
    }
    dossier(): DossierApi | undefined {
        return this.app.modules.api<DossierApi>('dossier');
    }
    calendar(): CalendarApi | undefined {
        return this.app.modules.api<CalendarApi>('calendar');
    }

    chat(): STChatMessage[] {
        const chat = this.app.host.ctx().chat;
        return Array.isArray(chat) ? chat : [];
    }

    persona(): string {
        return str(this.app.host.ctx().name1).trim();
    }

    /** The card character of this chat. */
    mainCharacter(): string {
        return str(this.app.host.ctx().name2).trim();
    }

    /* ---------------------------------------------------------------- names and places */

    resolve(name: string): Entity | undefined {
        try {
            return this.world()?.resolve(name, 'character') ?? this.world()?.resolve(name);
        } catch (error) {
            this.log.debug('world model resolve failed', error);
            return undefined;
        }
    }

    canonical(name: string): string {
        const entity = this.resolve(name);
        return entity && entity.kind !== 'place' ? entity.name : name.trim();
    }

    /** Place key of a DES label or a model-written place: `place:<id>` when the registry knows it, else the name. */
    placeKey(label: string | undefined): string | null {
        const clean = cleanLabel(label);
        if (!clean) return null;
        try {
            const place = this.places()?.resolve(clean);
            if (place) return `place:${place.id}`;
        } catch (error) {
            this.log.debug('place registry resolve failed', error);
        }
        return normalizePlaceName(clean) || null;
    }

    /** A place label as the registry names it («Порт-Ройал › Таверна»), else the label itself. */
    placeName(label: string | undefined): string | undefined {
        const clean = cleanLabel(label);
        if (!clean) return undefined;
        try {
            const places = this.places();
            const place = places?.resolve(clean);
            if (place) {
                const path = typeof places?.path === 'function' ? places.path(place.id) : [];
                return path.length ? path.join(' › ') : place.name;
            }
        } catch (error) {
            this.log.debug('place registry is not readable', error);
        }
        return clean;
    }

    /* ---------------------------------------------------------------- scenes */

    tracker(index: number): DesTrackerSnapshot | null {
        if (index < 0) return null;
        try {
            return adaptersOf(this.app).des.trackerFor(index);
        } catch (error) {
            this.log.debug('DES tracker is not readable', error);
            return null;
        }
    }

    /** Who is present, where and when at a committed reply (null without a DES tracker there). */
    scene(index: number): SceneInfo | null {
        const tracker = this.tracker(index);
        if (!tracker) return null;
        const persona = normalizeName(this.persona());
        const present: PresentCharacter[] = [];
        for (const raw of presentNames(tracker)) {
            const name = this.canonical(raw);
            const key = normalizeName(name);
            if (!key || key === persona || present.some((item) => item.key === key)) continue;
            present.push({ name, key });
        }
        const info: SceneInfo = {
            index,
            present,
            placeKey: this.placeKey(tracker.infoBox?.location),
            quests: tracker.quests
                ? [tracker.quests.main, ...tracker.quests.optional].filter((quest): quest is string => !!quest)
                : [],
        };
        const place = cleanLabel(tracker.infoBox?.location);
        if (place) info.place = place;
        const time = storyTimeLabel(tracker.infoBox);
        if (time) info.storyTime = time;
        return info;
    }

    /** Normalised names of the characters the world model sees in the newest reply (DES tracker). */
    presentInWorld(): Set<string> {
        const keys = new Set<string>();
        try {
            for (const entity of this.world()?.entities('character') ?? []) {
                if (entity.present) keys.add(normalizeName(entity.name));
            }
        } catch (error) {
            this.log.debug('world model is not readable', error);
        }
        return keys;
    }

    /** Characters with a relationship to someone present (rumours travel along the graph). */
    relatedTo(present: readonly PresentCharacter[]): Set<string> {
        const related = new Set<string>();
        const relations = this.relations();
        if (!relations) return related;
        for (const item of present) {
            try {
                for (const relation of relations.of(item.name)) {
                    const from = normalizeName(relation.from);
                    const to = normalizeName(relation.to);
                    related.add(from === item.key ? to : from);
                }
            } catch (error) {
                this.log.debug('relations are not readable', error);
                break;
            }
        }
        related.delete('');
        return related;
    }

    /* ---------------------------------------------------------------- candidates */

    /** Books of this chat and its card(s): the chat book, the primary book of each card in the chat. */
    localBooks(): Set<string> {
        const ctx = this.app.host.ctx();
        const books = new Set<string>();
        const chatBook = (ctx.chatMetadata as Dict | undefined)?.world_info;
        if (typeof chatBook === 'string' && chatBook) books.add(chatBook);
        const members = ctx.groupId
            ? (ctx.groups.find((group) => group.id === ctx.groupId)?.members ?? []).map((avatar) =>
                  ctx.characters.find((character) => character.avatar === avatar),
              )
            : [ctx.characterId === undefined ? undefined : ctx.characters[Number(ctx.characterId)]];
        for (const character of members) {
            const primary = character?.data?.extensions?.world;
            if (typeof primary === 'string' && primary) books.add(primary);
        }
        return books;
    }

    /** The chat's own text (cleaned, lower-case, ё→е) to tell whether a name was ever used in this story. */
    chatText(limit = 400): string {
        return normalizeForMatch(
            this.chat()
                .slice(-limit)
                .map((message) => cleanForAnalysis(message))
                .join('   '),
        );
    }

    /** Every character the offscreen world may consider: world model characters and DES's roster. */
    candidateInputs(doc: OffscreenDoc, scene: SceneInfo | null): CandidateInput[] {
        const persona = normalizeName(this.persona());
        const main = normalizeName(this.mainCharacter());
        const presentKeys = new Set([...(scene?.present.map((item) => item.key) ?? []), ...this.presentInWorld()]);
        let roster: string[] = [];
        let removed: string[] = [];
        try {
            const des = adaptersOf(this.app).des;
            roster = des.knownCharacters();
            removed = des.removedCharacters();
        } catch (error) {
            this.log.debug('DES roster is not readable', error);
        }
        const rosterKeys = new Set(roster.map((name) => normalizeName(this.canonical(name))).filter(Boolean));
        const removedKeys = new Set(removed.map((name) => normalizeName(this.canonical(name))).filter(Boolean));
        const lastEvent = new Map<string, number>();
        const pending = new Set<string>();
        for (const event of doc.events) {
            lastEvent.set(event.characterKey, Math.max(lastEvent.get(event.characterKey) ?? -Infinity, event.turn));
            if (event.status === 'inbox') pending.add(event.characterKey);
        }
        const out: CandidateInput[] = [];
        const books = this.localBooks();
        let text: string | null = null;
        const mentioned = (names: readonly string[]) => {
            text ??= this.chatText();
            const body = text;
            return names.some((name) => name.length > 1 && containsWithLeftBoundary(body, normalizeForMatch(name)));
        };
        const localSource = (entity: Entity | undefined) =>
            entity?.sources.some(
                (source) =>
                    source.kind === 'card' ||
                    source.kind === 'canon.entry' ||
                    (source.world !== undefined && books.has(source.world)),
            ) ?? false;
        const add = (name: string, sourceKinds: string[], entity?: Entity) => {
            const key = normalizeName(name);
            if (!key || out.some((item) => item.key === key)) return;
            const names = entity ? [entity.name, ...entity.aliases, ...entity.forms].map(normalizeName) : [key];
            const seen = names.map((item) => doc.seen[item]).find((record) => record !== undefined);
            const roster = names.some((item) => rosterKeys.has(item));
            const present = names.some((item) => presentKeys.has(item));
            const local =
                roster ||
                present ||
                seen !== undefined ||
                localSource(entity) ||
                mentioned(entity ? [entity.name, ...entity.aliases, ...entity.forms] : [name]);
            out.push({
                name,
                key,
                sourceKinds,
                roster: names.some((item) => rosterKeys.has(item)),
                main: key === main || sourceKinds.includes('card'),
                persona: key === persona || entity?.kind === 'persona',
                present: names.some((item) => presentKeys.has(item)),
                removed: names.some((item) => removedKeys.has(item)),
                lastSeenTurn: seen ? seen.turn : null,
                lastEventTurn: lastEvent.get(key) ?? null,
                pendingInbox: pending.has(key),
                local,
            });
        };
        try {
            for (const entity of this.world()?.entities('character') ?? []) {
                add(
                    entity.name,
                    entity.sources.map((source) => source.kind),
                    entity,
                );
            }
        } catch (error) {
            this.log.debug('world model is not readable', error);
        }
        for (const name of roster) {
            const entity = this.resolve(name);
            if (entity && entity.kind !== 'place')
                add(
                    entity.name,
                    entity.sources.map((source) => source.kind),
                    entity,
                );
            else add(name.trim(), []);
        }
        return out;
    }

    /* ---------------------------------------------------------------- dossiers */

    /** Dramatis's offscreen lines of a character (DRAMATIS_API.offscreenBrief), at most a few; [] without Dramatis. */
    engineLines(name: string): string[] {
        try {
            const dramatis = dramatisOf(this.app);
            if (!dramatis?.present()) return [];
            return dramatis.offscreenBrief(name).slice(0, ENGINE_LINES);
        } catch (error) {
            this.log.debug('Dramatis is not readable', error);
            return [];
        }
    }

    /** What the model learns about a character, and what the event must not contradict. */
    async brief(name: string, doc: OffscreenDoc, scene: SceneInfo | null): Promise<CharacterBrief> {
        const entity = this.resolve(name);
        const canonicalName = entity && entity.kind !== 'place' ? entity.name : name;
        const key = normalizeName(canonicalName);
        const aliases = entity ? uniqueStrings([...entity.aliases]).filter((alias) => alias !== canonicalName) : [];
        const facts = entity ? (await this.facts(entity)).slice(0, MAX_FACTS) : [];
        const brief: OffscreenBrief = {
            name: canonicalName,
            aliases: aliases.slice(0, 6),
            facts,
            relations: this.relationLines(canonicalName),
            quests: this.quests(canonicalName, entity, scene),
            earlier: doc.events
                .filter((event) => event.characterKey === key && event.status === 'saved')
                .slice(-EARLIER_EVENTS)
                .map((event) => event.text),
        };
        // Release 1.17: what Dramatis's engine knows of this character off screen — goals, what they tried, the outcome.
        const engine = this.engineLines(canonicalName);
        if (engine.length) brief.engine = engine;
        const names = entity ? [entity.name, ...entity.aliases, ...entity.forms].map(normalizeName) : [key];
        const seen = names.map((item) => doc.seen[item]).find((record) => record !== undefined);
        if (seen) {
            const lastSeen: NonNullable<OffscreenBrief['lastSeen']> = { turnsAgo: Math.max(0, doc.turns - seen.turn) };
            const place = this.placeName(seen.place);
            if (place) lastSeen.place = place;
            if (seen.time) lastSeen.time = seen.time;
            brief.lastSeen = lastSeen;
        }
        const against: OffscreenFact[] = [
            ...facts,
            ...brief.earlier.map((text) => ({ label: `offscreen: ${canonicalName}`, text })),
            ...brief.quests.map((text) => ({ label: 'quest', text })),
            ...engine.map((text) => ({ label: `dramatis: ${canonicalName}`, text })),
        ];
        return entity ? { brief, against, entity } : { brief, against };
    }

    /** Canon and lore texts of an entity: the dossier when it is on, else the stores. */
    private async facts(entity: Entity): Promise<OffscreenFact[]> {
        const dossier = this.dossier();
        if (dossier) {
            try {
                const page = await dossier.build(entity.id);
                const canon: OffscreenFact[] = [];
                const lore: OffscreenFact[] = [];
                for (const section of page.sections) {
                    const text = section.text.trim();
                    if (!text) continue;
                    if (section.kind === 'canon') canon.push({ label: `canon: ${section.title}`, text });
                    else if (section.kind === 'lore') lore.push({ label: `lore: ${section.title}`, text });
                }
                return [...canon, ...lore];
            } catch (error) {
                this.log.debug(`dossier of ${entity.id} failed; reading the stores`, error);
            }
        }
        return this.factsFromStores(entity);
    }

    private async factsFromStores(entity: Entity): Promise<OffscreenFact[]> {
        const canon: OffscreenFact[] = [];
        const lore: OffscreenFact[] = [];
        let items: Awaited<ReturnType<CanonApi['list']>> | null = null;
        const ctx = this.app.host.ctx();
        for (const source of entity.sources) {
            try {
                if (source.kind === 'lore.entry' && source.world && source.uid !== undefined) {
                    if (typeof ctx.loadWorldInfo !== 'function') continue;
                    const data: unknown = await ctx.loadWorldInfo(source.world);
                    const entries = isDict(data) && isDict(data.entries) ? data.entries : {};
                    const entry = entries[String(source.uid)];
                    const text = isDict(entry) ? str(entry.content).trim() : '';
                    if (text) lore.push({ label: `lore: ${source.label}`, text });
                } else if (source.kind === 'canon.entry' && source.uid !== undefined) {
                    items ??= (await this.canon()?.list()) ?? [];
                    const item = items.find((candidate) => candidate.uid === source.uid);
                    const text = str(item?.entry.content).trim();
                    if (text) canon.push({ label: `canon: ${source.label}`, text });
                }
            } catch (error) {
                this.log.debug(`source ${source.kind}:${source.ref} is not readable`, error);
            }
        }
        return [...canon, ...lore];
    }

    /** «Mira → Alex: Friendly»: the persona's relationships first, then a few others. */
    relationLines(name: string): string[] {
        const relations = this.relations();
        if (!relations) return [];
        const persona = normalizeName(this.persona());
        try {
            const list = relations.of(name).filter((relation) => relation.current.trim());
            const withPersona = (relation: { from: string; to: string }) =>
                normalizeName(relation.from) === persona || normalizeName(relation.to) === persona;
            return [...list.filter(withPersona), ...list.filter((relation) => !withPersona(relation))]
                .slice(0, MAX_RELATIONS)
                .map((relation) => `${relation.from} → ${relation.to}: ${relation.current.trim()}`);
        } catch (error) {
            this.log.debug('relations are not readable', error);
            return [];
        }
    }

    /** DES quests that name the character, and the calendar's open promises they are part of. */
    quests(name: string, entity: Entity | undefined, scene: SceneInfo | null): string[] {
        const needles = uniqueStrings([name, ...(entity?.aliases ?? []), ...(entity?.forms ?? [])])
            .map(normalizeForMatch)
            .filter((needle) => needle.length >= 2);
        const mentions = (text: string) => {
            const value = normalizeForMatch(text);
            return needles.some((needle) => containsWithLeftBoundary(value, needle));
        };
        const out = (scene?.quests ?? []).filter(mentions);
        const calendar = this.calendar();
        if (calendar) {
            try {
                const keys = new Set(needles.map(normalizeName));
                for (const promise of calendar.promises()) {
                    if (!['open', 'due', 'overdue'].includes(promise.status)) continue;
                    const people = [...promise.who, ...promise.toWhom].map(normalizeName);
                    if (!people.some((person) => keys.has(person))) continue;
                    out.push(promise.due ? `${promise.what} (due ${promise.due.label})` : promise.what);
                }
            } catch (error) {
                this.log.debug('calendar is not readable', error);
            }
        }
        return uniqueStrings(out).slice(0, MAX_QUESTS);
    }

    /** Canon keys of a character: Russian forms (DES-RU through the canon) and a few aliases. */
    async keyForms(name: string, entity: Entity | undefined): Promise<string[]> {
        let forms: string[] = [];
        try {
            forms = (await this.canon()?.russianKeys(name)) ?? [];
        } catch (error) {
            this.log.debug('canon keys are not available', error);
        }
        return uniqueStrings([...forms, ...(entity?.aliases ?? []).slice(0, 4)]);
    }

    /* ---------------------------------------------------------------- the story so far */

    /** The last chronicle chapter and Qvink's long (and latest) memories up to a message, oldest first. */
    async summary(index: number): Promise<string[]> {
        const out: string[] = [];
        const chronicle = this.chronicle();
        if (chronicle) {
            try {
                const chapters = await chronicle.chapters();
                const last = chapters[chapters.length - 1];
                if (last) {
                    let text = '';
                    try {
                        const item = (await this.canon()?.list())?.find((candidate) => candidate.uid === last.uid);
                        text = str(item?.entry.content).trim();
                    } catch (error) {
                        this.log.debug('chapter text is not readable', error);
                    }
                    const body = text.length > CHAPTER_CHARS ? `${text.slice(0, CHAPTER_CHARS - 1)}…` : text;
                    out.push(body ? `Chapter «${last.title}»: ${body}` : `Chapter «${last.title}»`);
                }
            } catch (error) {
                this.log.debug('chronicle is not readable', error);
            }
        }
        let qvink: ReturnType<typeof adaptersOf>['qvink'];
        try {
            qvink = adaptersOf(this.app).qvink;
            if (typeof qvink.memoryOf !== 'function' || !qvink.present()) return out;
        } catch {
            return out;
        }
        const long: { index: number; text: string }[] = [];
        const recent: { index: number; text: string }[] = [];
        const stop = Math.max(0, index - MEMORY_SCAN);
        for (let i = index; i >= stop; i--) {
            if (long.length >= LONG_MEMORIES && recent.length >= RECENT_MEMORIES) break;
            try {
                const memory = qvink.memoryOf(i);
                const text = memory?.memory.trim();
                if (!memory || !text || memory.exclude) continue;
                if ((memory.include === 'long' || memory.remember) && long.length < LONG_MEMORIES) {
                    long.push({ index: i, text });
                } else if (recent.length < RECENT_MEMORIES) {
                    recent.push({ index: i, text });
                }
            } catch (error) {
                this.log.debug('Qvink memory is not readable', error);
                break;
            }
        }
        const memories = [...long, ...recent].sort((a, b) => a.index - b.index).map((item) => item.text);
        return [...out, ...uniqueStrings(memories)];
    }
}
