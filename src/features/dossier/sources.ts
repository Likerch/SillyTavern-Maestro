// What the stack knows about one entity (M7 п. 1–3, plan §2.1): read on demand from every owner — lorebooks with the
// chat canon on top, CK archives, NAI passports (card values plus the chat's override from NAI Studio 0.10's raw
// store `chat_metadata.nai_studio.passports`, and the chat's own passports), DES (roster,
// aliases, the character's last tracker entry, Workshop stores), DES-RU case forms, Qvink memories, CK RAG, the last
// BunnyMo sheet in the chat, the place registry and the persona. Read-only: nothing here writes.
//
// Entities come from the world model (WorldModelApi). Without it the dossier still knows the card character(s), the
// persona, DES's roster and the registered places, built directly from those sources.
//
// Other stories (plan-2 §9): what lives outside this chat — CK repos, global books, NPC passports of the card, DES
// Workshop data kept by name — is shown only when it is part of the entity: the world model's sources (the card's own
// or bound with «Тот же»), never found by a bare name. Without the world model only the card's own names (its
// characters, the persona, names its text uses) reach outside the chat's own books.
import { adaptersOf } from '../../adapters';
import { readPassport } from '../../adapters/nai';
import type { NaiPassport, NaiStudioApi } from '../../adapters/nai';
import { entryKeys, isCharacterArchive } from '../../domain/bunnymo';
import type { DesCharacter } from '../../domain/des-tracker';
import { enabledEntriesOf, isBookData, isBunnyMoBook } from '../../domain/doctor-fixes';
import type { BookData } from '../../domain/doctor-fixes';
import {
    findLastSheet,
    pickMemories,
    ragCollectionsFor,
    readSheetMark,
    summarizeArchive,
} from '../../domain/dossier-data';
import type { ArchiveSummary, FoundSheet, MemoryLike, RagCollection } from '../../domain/dossier-data';
import {
    entityIdFor,
    keysCover,
    mentionMatcher,
    mentionsAny,
    namesOverlap,
    normName,
    normSet,
} from '../../domain/dossier-names';
import { archiveMatch } from '../../domain/sheet-context';
import { stripDesTrackerJson } from '../../domain/text-clean';
import { cardNameMatcher, cardTexts, chatOriginTag, entryOrigin, localBookNames } from '../../domain/world-scope';
import type { App, Logger } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { CanonApi, CanonItem } from '../canon/api';
import type { Place, PlacesApi } from '../places/api';
import type { RelationsApi } from '../relations/api';
import type { SheetsApi } from '../sheets/api';
import type { Entity, EntityIdentity, EntitySource, WorldModelApi } from '../world/api';
import type { DossierSettings } from './settings';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function unique(values: Iterable<string>): string[] {
    return [...new Set([...values].filter(Boolean))];
}

export const PLACE_PREFIX = 'place:';

/**
 * Chat-level passport store of NAI Studio 0.10 (`chat_metadata.nai_studio.passports`): overrides of card/persona
 * passports by id (only the changed fields, `owner` = card avatar or `persona:<avatar>`) and the chat's own passports.
 */
export interface NaiChatStore {
    overrides: Record<string, Dict>;
    extra: NaiPassport[];
}

export interface LoreFact {
    world: string;
    uid: number;
    entry: Dict;
    title: string;
    /** Base primary keys. */
    baseKeys: string[];
    /** Effective primary keys (the canon override's when it overrides keys). */
    keys: string[];
    protected: boolean;
    override?: CanonItem;
    suppressed?: boolean;
    /** The place's description entry (kind place). */
    description?: boolean;
    source: EntitySource;
}

export interface ArchiveFact {
    world: string;
    uid: number;
    entry: Dict;
    summary: ArchiveSummary;
    source: EntitySource;
}

export interface PassportFact {
    /** The stored passport: the card's or persona's, or the chat's own (level 'chat'). */
    passport: NaiPassport;
    /** Card avatar ('' for the persona and chat-only passports). */
    avatar: string;
    owner: string;
    level: 'card' | 'persona' | 'chat';
    /** Chat-level override of this passport (the changed fields, without `owner`), when the chat has one. */
    chat: Dict | null;
    source: EntitySource;
}

export interface DesFact {
    canonical: string;
    aliases: string[];
    inRoster: boolean;
    character?: DesCharacter;
    messageIndex?: number;
    rosterEmoji?: string;
    /** Workshop stores (global DES settings). */
    portraitPrompt?: string;
    workshopDescription?: string;
    relationshipOverride?: string;
    /** `userCharacters[name]` for the persona (colour, pronouns). */
    user?: Dict;
}

export interface PersonaFact {
    name: string;
    avatar: string;
    description: string;
    lorebook: string | null;
    lorebookEntries: { uid: number; title: string }[];
}

export interface PlaceFact {
    place: Place;
    parents: Place[];
    children: Place[];
}

export interface EntityFacts {
    entity: Entity;
    worldOn: boolean;
    /** Every name to match: canonical, aliases, forms. */
    names: string[];
    lore: LoreFact[];
    canonBook: string | null;
    canonOn: boolean;
    /** Canon additions about the entity. */
    canon: CanonItem[];
    archives: ArchiveFact[];
    ckPresent: boolean;
    ragEnabled: boolean;
    rag: RagCollection[];
    passports: PassportFact[];
    naiPresent: boolean;
    naiApi: boolean;
    desPresent: boolean;
    des: DesFact | null;
    desruPresent: boolean;
    forms: string[];
    formsKey: string | null;
    memories: MemoryLike[];
    qvinkPresent: boolean;
    sheet: FoundSheet | null;
    place: PlaceFact | null;
    persona: PersonaFact | null;
    /** Relationship with the user now (relations graph or DES). */
    relation: string | null;
    /** Card description of the card character (AI comparison). */
    cardDescription: string | null;
    cardAvatar: string | null;
    /** Card/global sources of the name: used here, waiting for an answer, declared another one's (world model). */
    identity: EntityIdentity | null;
}

/** What of the stores outside this chat the dossier may read for an entity (plan-2 §9). */
interface Reach {
    /** World model on: archives and card passports only through the entity's sources. */
    world: boolean;
    /** Books outside the chat may be searched by the entity's names (the card's own names). */
    wide: boolean;
    /** The chat's books (the chat book, the canon, the cards' books). */
    local: Set<string>;
    /** `${book}#${uid}` of a namesake's entries: never shown. */
    foreign: Set<string>;
}

export class DossierSources {
    constructor(
        private readonly app: App,
        private readonly settings: () => DossierSettings,
        private readonly log: Logger,
    ) {}

    /* ---------------------------------------------------------------- other modules */

    world(): WorldModelApi | undefined {
        return this.app.modules.api<WorldModelApi>('world');
    }

    places(): PlacesApi | undefined {
        return this.app.modules.api<PlacesApi>('places');
    }

    canon(): CanonApi | undefined {
        return this.app.modules.api<CanonApi>('canon');
    }

    private roles(): BookRolesApi | undefined {
        return this.app.modules.api<BookRolesApi>('bookRoles');
    }

    /** NAI Studio's public API (0.10.0+): writes go only through it; undefined before that (read-only). */
    naiApi(): NaiStudioApi | undefined {
        try {
            return adaptersOf(this.app).nai.api();
        } catch {
            return undefined;
        }
    }

    private safe<T>(read: () => T, fallback: T): T {
        try {
            return read();
        } catch (error) {
            this.log.debug('dossier source failed', error);
            return fallback;
        }
    }

    /* ---------------------------------------------------------------- entities */

    /** Entities to pick from: the world model's, or the fallback set without it. */
    entities(): { entities: Entity[]; worldOn: boolean } {
        const world = this.world();
        if (world) {
            try {
                return { entities: world.entities(), worldOn: true };
            } catch (error) {
                this.log.warn('world model entities failed', error);
            }
        }
        return { entities: this.fallbackEntities(), worldOn: false };
    }

    entity(id: string): Entity | undefined {
        const world = this.world();
        if (world) {
            const found = this.safe(() => world.get(id), undefined);
            if (found) return found;
        }
        return this.fallbackEntities().find((entity) => entity.id === id);
    }

    resolve(name: string): Entity | undefined {
        const wanted = normName(name);
        if (!wanted) return undefined;
        const world = this.world();
        if (world) {
            const found = this.safe(() => world.resolve(name), undefined);
            if (found) return found;
        }
        return this.entities().entities.find((entity) =>
            normSet([entity.name, ...entity.aliases, ...entity.forms]).has(wanted),
        );
    }

    private desAliases(): Record<string, string[]> {
        return this.safe(() => adaptersOf(this.app).des.aliases(), {});
    }

    /** Russian case forms of a name (DES-RU), empty without its API. */
    formsOf(name: string): string[] | null {
        const api = this.safe(() => adaptersOf(this.app).desru.api(), undefined);
        if (!api) return null;
        return this.safe(() => api.nameForms(name), []);
    }

    formsKeyOf(name: string): string | null {
        const api = this.safe(() => adaptersOf(this.app).desru.api(), undefined);
        if (!api) return null;
        return this.safe(() => api.nameFormsKey(name), null);
    }

    /** Names in the newest DES tracker (on scene). */
    private presentNames(): Set<string> {
        const des = adaptersOf(this.app).des;
        const chat = this.app.host.ctx().chat;
        const lookback = this.settings().trackerLookback;
        let seen = 0;
        for (let index = chat.length - 1; index >= 0 && seen < lookback; index--) {
            if (chat[index]?.is_user) continue;
            seen++;
            const snapshot = this.safe(() => des.trackerFor(index), null);
            if (snapshot?.characters.length) {
                return normSet(snapshot.characters.filter((item) => !item.offScene).map((item) => item.name));
            }
        }
        return new Set();
    }

    private cardCharacters(): STCharacter[] {
        const ctx = this.app.host.ctx();
        if (ctx.groupId) {
            const group = ctx.groups.find((item) => item.id === ctx.groupId);
            return (group?.members ?? [])
                .map((avatar) => ctx.characters.find((character) => character.avatar === avatar))
                .filter((character): character is STCharacter => !!character);
        }
        const character = ctx.characterId === undefined ? undefined : ctx.characters[Number(ctx.characterId)];
        return character ? [character] : [];
    }

    /** Card character(s), persona, DES roster and places, without the world model. */
    fallbackEntities(): Entity[] {
        const ctx = this.app.host.ctx();
        const aliases = this.desAliases();
        const present = this.safe(() => this.presentNames(), new Set<string>());
        const out: Entity[] = [];
        const known = new Set<string>();
        const aliasesOf = (name: string): string[] => {
            const norm = normName(name);
            for (const [canonical, list] of Object.entries(aliases)) {
                if (normName(canonical) === norm) return unique(list);
            }
            return [];
        };
        const push = (entity: Entity) => {
            const names = [entity.name, ...entity.aliases];
            if (names.some((name) => known.has(`${entity.kind}:${normName(name)}`))) return;
            for (const name of names) known.add(`${entity.kind}:${normName(name)}`);
            out.push(entity);
        };
        const person = (kind: 'character' | 'persona', name: string, source: EntitySource): Entity => {
            const list = aliasesOf(name);
            const entity: Entity = {
                id: entityIdFor(kind, name),
                kind,
                name,
                aliases: list,
                forms: unique([name, ...list].flatMap((item) => this.formsOf(item) ?? [])),
                sources: [source],
            };
            if (kind === 'character') entity.present = [name, ...list].some((item) => present.has(normName(item)));
            return entity;
        };
        const personaName = str(ctx.name1).trim();
        if (personaName)
            push(person('persona', personaName, { kind: 'persona', ref: personaName, label: personaName }));
        for (const character of this.cardCharacters()) {
            push(
                person('character', character.name, {
                    kind: 'card',
                    ref: character.avatar,
                    label: character.name,
                    avatar: character.avatar,
                }),
            );
        }
        const roster = this.safe(() => adaptersOf(this.app).des.knownCharacters(), []);
        for (const name of roster) {
            if (normName(name) === normName(personaName)) continue;
            push(person('character', name, { kind: 'des.character', ref: name, label: name }));
        }
        for (const place of this.safe(() => this.places()?.list() ?? [], [])) {
            push({
                id: `${PLACE_PREFIX}${place.id}`,
                kind: 'place',
                name: place.name,
                aliases: [...place.aliases],
                forms: [...place.forms],
                sources: [{ kind: 'place', ref: place.id, label: place.name }],
            });
        }
        return out;
    }

    /* ---------------------------------------------------------------- books */

    private async loadBook(name: string, cache: Map<string, BookData | null>): Promise<BookData | null> {
        if (cache.has(name)) return cache.get(name) ?? null;
        let data: BookData | null = null;
        try {
            const raw: unknown = await this.app.host.ctx().loadWorldInfo?.(name);
            data = isBookData(raw) ? raw : null;
        } catch (error) {
            this.log.debug(`lorebook ${name} did not load`, error);
        }
        cache.set(name, data);
        return data;
    }

    /** BunnyMo core or pack (P13): by its M35 role, the BunnyMo adapter or the book's content. */
    isProtected(book: string, data: BookData | null): boolean {
        const role = this.safe(() => this.roles()?.roleOf(book), undefined);
        if (role && (role.readOnly || role.role === 'bunnymo.core' || role.role === 'bunnymo.pack')) return true;
        const books = this.safe(() => adaptersOf(this.app).bunnymo.books(), { core: [], packs: [], archives: [] });
        if (books.core.includes(book) || books.packs.includes(book)) return true;
        return !!data && isBunnyMoBook(book, data);
    }

    /** Loads a book for a write check (fresh) and tells whether it is protected. */
    async bookState(book: string): Promise<{ data: BookData | null; protected: boolean }> {
        const data = await this.loadBook(book, new Map());
        return { data, protected: this.isProtected(book, data) };
    }

    private async activeBooks(): Promise<string[]> {
        try {
            return await adaptersOf(this.app).bunnymo.activeBooks();
        } catch (error) {
            this.log.debug('active books are not available', error);
            return [];
        }
    }

    private archiveBooks(): string[] {
        const adapters = adaptersOf(this.app);
        return unique([
            ...this.safe(() => adapters.ck.repoBooks(), []),
            ...this.safe(() => adapters.bunnymo.books().archives, []),
        ]);
    }

    /* ---------------------------------------------------------------- facts */

    async facts(entity: Entity): Promise<EntityFacts> {
        const adapters = adaptersOf(this.app);
        const world = this.world();
        const worldOn = !!world;
        const personlike = entity.kind === 'character' || entity.kind === 'persona';
        const names = unique([entity.name, ...entity.aliases]);
        const allNames = unique([...names, ...entity.forms]);
        const cache = new Map<string, BookData | null>();
        const canon = this.canon();
        const canonBook = canon && this.app.host.chatId() ? this.safe(() => canon.bookName() || null, null) : null;
        const items = canon && canonBook ? await this.canonItems(canon) : [];
        const identity = world?.identity ? this.safe(() => world.identity?.(entity.id) ?? null, null) : null;
        const reach = await this.reach(entity, identity, canonBook);

        const place = entity.kind === 'place' ? this.placeFact(entity) : null;
        const lore = await this.loreFacts(entity, names, items, canonBook, cache, place, reach);
        const archives = personlike ? await this.archiveFacts(entity, names, cache, reach) : [];
        const ck = adapters.ck;
        const ckPresent = this.safe(() => ck.present(), false);
        const ragEnabled = ckPresent && this.safe(() => ck.ragEnabled(), false);
        const desPresent = this.safe(() => adapters.des.present(), false);
        const desruApi = this.safe(() => adapters.desru.api(), undefined);
        const persona = entity.kind === 'persona' ? await this.personaFact(entity, cache) : null;

        const facts: EntityFacts = {
            entity,
            worldOn,
            names: allNames,
            lore,
            canonBook,
            canonOn: !!canon,
            canon: this.canonAdditions(entity, names, items),
            archives,
            ckPresent,
            ragEnabled,
            // CK keeps RAG collections by name for every chat: none while a namesake's data is kept out (plan-2 §9).
            rag:
                personlike && ckPresent && !(identity && [...identity.pending, ...identity.apart].length)
                    ? ragCollectionsFor(
                          this.safe(() => ck.settings()?.rag, undefined),
                          names,
                      )
                    : [],
            passports: await this.passportFacts(entity, names, place, persona, reach),
            naiPresent: this.safe(() => adapters.nai.present(), false),
            naiApi: !!this.naiApi(),
            desPresent,
            des: personlike && desPresent ? this.desFact(entity, names, identity) : null,
            desruPresent: !!desruApi,
            forms: entity.forms.length
                ? unique(entity.forms)
                : unique(names.flatMap((name) => this.formsOf(name) ?? [])),
            formsKey: desruApi ? this.formsKeyOf(entity.name) : null,
            memories: this.memories(entity, allNames),
            qvinkPresent: this.safe(() => adapters.qvink.present(), false),
            sheet: personlike ? this.sheet(names) : null,
            place,
            persona,
            relation: personlike ? this.relation(entity) : null,
            cardDescription: null,
            cardAvatar: null,
            identity,
        };
        const card = this.cardOf(entity);
        if (card) {
            facts.cardAvatar = card.avatar;
            facts.cardDescription = str(card.description).trim() || null;
        }
        return facts;
    }

    /**
     * How far the dossier may look outside the chat for this entity: the card's own names (its characters, the persona,
     * a name the card's text uses — the world model's answer, else read here) and names the user bound reach every
     * book; others only the chat's own books. A namesake's entries are never shown.
     */
    private async reach(entity: Entity, identity: EntityIdentity | null, canonBook: string | null): Promise<Reach> {
        const ctx = this.app.host.ctx();
        const cards = this.cardCharacters();
        let charLore: unknown;
        try {
            const settings = (await this.app.host.modules.worldInfo()).world_info;
            charLore = isDict(settings) ? settings.charLore : undefined;
        } catch (error) {
            this.log.debug('world-info.js is not available; extra card books count as global', error);
        }
        const books = localBookNames({ chatBook: ctx.chatMetadata?.world_info, cards, charLore });
        const local = new Set([...books.chat, ...books.card, ...(canonBook ? [canonBook] : [])]);
        const anchor = entity.sources.some((source) => source.kind === 'card' || source.kind === 'persona');
        const world = this.world();
        const foreign = new Set(world?.foreignRefs ? this.safe(() => world.foreignRefs?.() ?? [], []) : []);
        let wide = anchor || entity.kind === 'persona';
        if (!wide && identity) {
            wide = identity.ofCard || identity.shared.some((source) => source.kind !== 'des.workshop');
        } else if (!wide) {
            const persona = str(ctx.name1).trim();
            const ofCard = cardNameMatcher({
                names: [...cards.map((character) => character.name), ...(persona ? [persona] : [])],
                texts: cards.flatMap((character) => cardTexts(character)),
                forms: (name) => this.formsOf(name) ?? [],
            });
            wide = [entity.name, ...entity.aliases].some((name) => ofCard(name));
        }
        return { world: !!world, wide, local, foreign };
    }

    private async canonItems(canon: CanonApi): Promise<CanonItem[]> {
        try {
            return await canon.list();
        } catch (error) {
            this.log.debug('canon list failed', error);
            return [];
        }
    }

    private canonAdditions(entity: Entity, names: readonly string[], items: readonly CanonItem[]): CanonItem[] {
        const fromWorld = new Set(
            entity.sources.filter((source) => source.kind === 'canon.entry').map((source) => source.uid),
        );
        return items.filter(
            (item) =>
                item.meta.kind === 'addition' &&
                (fromWorld.has(item.uid) || names.some((name) => keysCover(strings(item.entry.key), name))),
        );
    }

    private loreFact(
        world: string,
        uid: number,
        entry: Dict,
        data: BookData,
        items: readonly CanonItem[],
        canonBook: string | null,
    ): LoreFact {
        const baseKeys = strings(entry.key);
        const title = str(entry.comment).trim() || baseKeys[0] || `#${uid}`;
        const related = items.filter((item) => item.meta.base?.world === world && item.meta.base.uid === uid);
        const override = related.find((item) => item.meta.kind === 'override');
        const overridesKeys = override && (!override.meta.fields || override.meta.fields.includes('key'));
        const fact: LoreFact = {
            world,
            uid,
            entry,
            title,
            baseKeys,
            keys: overridesKeys ? strings(override.entry.key) : baseKeys,
            protected: this.isProtected(world, data),
            source: { kind: 'lore.entry', ref: `${world}#${uid}`, label: title, world, uid },
        };
        if (override) fact.override = override;
        if (related.some((item) => item.meta.kind === 'suppress')) fact.suppressed = true;
        if (canonBook && world === canonBook) fact.source = { ...fact.source, kind: 'canon.entry' };
        return fact;
    }

    private async loreFacts(
        entity: Entity,
        names: readonly string[],
        items: readonly CanonItem[],
        canonBook: string | null,
        cache: Map<string, BookData | null>,
        place: PlaceFact | null,
        reach: Reach,
    ): Promise<LoreFact[]> {
        const out: LoreFact[] = [];
        const seen = new Set<string>();
        const add = async (world: string, uid: number, extra: Partial<LoreFact> = {}) => {
            const id = `${world}#${uid}`;
            if (seen.has(id) || world === canonBook || reach.foreign.has(id)) return;
            const data = await this.loadBook(world, cache);
            const entry = data?.entries[String(uid)];
            if (!data || !isDict(entry)) return;
            seen.add(id);
            out.push({ ...this.loreFact(world, uid, entry, data, items, canonBook), ...extra });
        };
        const description = place?.place.entry;
        if (description) await add(description.world, description.uid, { description: true });
        for (const source of entity.sources) {
            if (source.kind === 'lore.entry' && source.world && typeof source.uid === 'number') {
                await add(source.world, source.uid);
            }
        }
        const archiveBooks = new Set(this.archiveBooks());
        for (const book of await this.activeBooks()) {
            if (book === canonBook || archiveBooks.has(book)) continue;
            // A name found in a book outside the chat may be a namesake of another story (plan-2 §9).
            if (!reach.wide && !reach.local.has(book)) continue;
            const data = await this.loadBook(book, cache);
            if (!data || this.isProtected(book, data)) continue;
            for (const { uid, entry } of enabledEntriesOf(data)) {
                if (isCharacterArchive(entry)) continue;
                const keys = strings(entry.key);
                if (names.some((name) => keysCover(keys, name))) await add(book, uid);
            }
        }
        return out;
    }

    /**
     * The entity's archives: with the world model only its own sources (an archive of the same name in a repo may be
     * a namesake's, plan-2 §9); without it archives named exactly so, in the chat's books or — for the card's own
     * names — in every archive book.
     */
    private async archiveFacts(
        entity: Entity,
        names: readonly string[],
        cache: Map<string, BookData | null>,
        reach: Reach,
    ): Promise<ArchiveFact[]> {
        const out: ArchiveFact[] = [];
        const seen = new Set<string>();
        const add = (world: string, uid: number, entry: Dict) => {
            const id = `${world}#${uid}`;
            if (seen.has(id)) return;
            seen.add(id);
            const summary = summarizeArchive(entry);
            const label = summary.name ?? (str(entry.comment).trim() || `#${uid}`);
            out.push({ world, uid, entry, summary, source: { kind: 'ck.archive', ref: id, label, world, uid } });
        };
        for (const source of entity.sources) {
            if (source.kind !== 'ck.archive' || !source.world || typeof source.uid !== 'number') continue;
            const entry = (await this.loadBook(source.world, cache))?.entries[String(source.uid)];
            if (isDict(entry)) add(source.world, source.uid, entry);
        }
        if (reach.world) return out;
        const chatId = this.app.host.chatId();
        const origin = chatId ? chatOriginTag(chatId) : null;
        const books = unique([...this.archiveBooks(), ...(await this.activeBooks())]);
        for (const book of books) {
            // Outside the chat's books only archives Maestro wrote for this chat, unless the name is the card's.
            const own = !reach.wide && !reach.local.has(book);
            if (own && !origin) continue;
            const data = await this.loadBook(book, cache);
            if (!data || this.isProtected(book, data)) continue;
            for (const { uid, entry } of enabledEntriesOf(data)) {
                if (own && entryOrigin(entry) !== origin) continue;
                // Canonical names: only the exact name counts (an inflected match would give Александр Александра's).
                if (names.some((name) => archiveMatch(entry, name) === 'exact')) add(book, uid, entry);
            }
        }
        return out;
    }

    /* ---------------------------------------------------------------- NAI */

    /** The raw chat-level store (read directly: the API returns resolved copies, the dossier shows base and override). */
    naiChatStore(): NaiChatStore {
        const meta = this.app.host.ctx().chatMetadata.nai_studio;
        const store = isDict(meta) ? meta.passports : undefined;
        const overrides: Record<string, Dict> = {};
        if (isDict(store) && isDict(store.overrides)) {
            for (const [id, value] of Object.entries(store.overrides)) if (isDict(value)) overrides[id] = value;
        }
        const extra =
            isDict(store) && Array.isArray(store.extra)
                ? store.extra.map(readPassport).filter((item): item is NaiPassport => item !== null)
                : [];
        return { overrides, extra };
    }

    /** The chat's override of a passport when it belongs to this owner (`owner` absent: any owner). */
    private chatOverride(store: NaiChatStore, id: string, owner: string): Dict | null {
        const raw = store.overrides[id];
        if (!raw) return null;
        if (typeof raw.owner === 'string' && raw.owner && raw.owner !== owner) return null;
        const fields = { ...raw };
        delete fields.owner;
        return fields;
    }

    private cardIndexes(entity: Entity): number[] {
        const ctx = this.app.host.ctx();
        const avatars = new Set(this.cardCharacters().map((character) => character.avatar));
        for (const source of entity.sources) if (source.avatar) avatars.add(source.avatar);
        const indexes: number[] = [];
        ctx.characters.forEach((character, index) => {
            if (avatars.has(character.avatar)) indexes.push(index);
        });
        return indexes;
    }

    private cardOf(entity: Entity): STCharacter | undefined {
        if (entity.kind !== 'character') return undefined;
        const ctx = this.app.host.ctx();
        const avatar = entity.sources.find((source) => source.kind === 'card')?.avatar;
        if (avatar) return ctx.characters.find((character) => character.avatar === avatar);
        const names = normSet([entity.name, ...entity.aliases]);
        return this.cardCharacters().find((character) => names.has(normName(character.name)));
    }

    private async passportFacts(
        entity: Entity,
        names: readonly string[],
        place: PlaceFact | null,
        persona: PersonaFact | null,
        reach: Reach,
    ): Promise<PassportFact[]> {
        const ctx = this.app.host.ctx();
        const nai = adaptersOf(this.app).nai;
        const out: PassportFact[] = [];
        const store = this.naiChatStore();
        if (persona) {
            const stored = this.personaPassport(persona.avatar);
            if (stored) {
                out.push({
                    passport: stored,
                    avatar: '',
                    owner: persona.name,
                    level: 'persona',
                    chat: this.chatOverride(store, stored.id, `persona:${persona.avatar}`),
                    source: {
                        kind: 'nai.passport',
                        ref: `persona#${stored.id}`,
                        label: persona.name,
                        passportId: stored.id,
                    },
                });
            }
            return out;
        }
        const wanted = new Set(
            entity.sources
                .filter((source) => source.kind === 'nai.passport' && source.passportId)
                .map((source) => `${source.avatar ?? ''}#${source.passportId ?? ''}`),
        );
        const matches = (passport: NaiPassport, ref: string, cardName: string, card: boolean): boolean => {
            if (wanted.has(ref)) return true;
            if (entity.kind === 'place' && passport.id === place?.place.passportId) return true;
            // A card passport of another name-bearer may be a namesake's (an NPC NAI Studio once saved into the card):
            // with the world model only the entity's own sources count; without it, the card's own names (plan-2 §9).
            if (card && (reach.world || !reach.wide)) return false;
            if (entity.kind === 'place') {
                return passport.kind === 'location' && namesOverlap([passport.name, ...passport.aliases], names);
            }
            return (
                passport.kind === 'character' && namesOverlap([passport.name || cardName, ...passport.aliases], names)
            );
        };
        for (const index of this.cardIndexes(entity)) {
            const character = ctx.characters[index];
            if (!character) continue;
            for (const passport of this.safe(() => nai.passportsOf(index), [])) {
                const ref = `${character.avatar}#${passport.id}`;
                if (!matches(passport, ref, character.name, true)) continue;
                out.push({
                    passport,
                    avatar: character.avatar,
                    owner: character.name,
                    level: 'card',
                    chat: this.chatOverride(store, passport.id, character.avatar),
                    source: {
                        kind: 'nai.passport',
                        ref,
                        label: passport.name || character.name,
                        passportId: passport.id,
                        avatar: character.avatar,
                    },
                });
            }
        }
        // Passports of the chat itself (NPCs made in this chat): resolved by the API, else the raw store.
        const own = this.naiApi() ? this.safe(() => nai.chatPassports({ chat: true }), []) : store.extra;
        for (const passport of own) {
            const ref = `#${passport.id}`;
            if (!passport.name || !matches(passport, ref, '', false)) continue;
            out.push({
                passport,
                avatar: '',
                owner: '',
                level: 'chat',
                chat: null,
                source: { kind: 'nai.passport', ref: `chat${ref}`, label: passport.name, passportId: passport.id },
            });
        }
        return out;
    }

    private personaPassport(avatar: string): NaiPassport | null {
        const settings = this.safe(() => adaptersOf(this.app).nai.settings(), null);
        const scene = isDict(settings) ? settings.scene : undefined;
        const store = isDict(scene) ? scene.personaPassports : undefined;
        if (!isDict(store)) return null;
        return readPassport(store[avatar || 'default'] ?? store.default);
    }

    /* ---------------------------------------------------------------- DES */

    private desFact(entity: Entity, names: readonly string[], identity: EntityIdentity | null): DesFact | null {
        const des = adaptersOf(this.app).des;
        const wanted = normSet(names);
        const aliases = this.desAliases();
        let canonical: string | null = null;
        let aliasList: string[] = [];
        for (const [name, list] of Object.entries(aliases)) {
            if (wanted.has(normName(name)) || list.some((alias) => wanted.has(normName(alias)))) {
                canonical = name;
                aliasList = unique(list);
                break;
            }
        }
        const roster = this.safe(() => des.knownCharacters(), []);
        const inRoster = roster.find((name) => wanted.has(normName(name)));
        canonical ??= inRoster ?? null;
        const fact: DesFact = { canonical: canonical ?? entity.name, aliases: aliasList, inRoster: !!inRoster };
        const chat = this.app.host.ctx().chat;
        const lookback = this.settings().trackerLookback;
        let seen = 0;
        for (let index = chat.length - 1; index >= 0 && seen < lookback; index--) {
            if (chat[index]?.is_user) continue;
            seen++;
            const snapshot = this.safe(() => des.trackerFor(index), null);
            const character = snapshot?.characters.find((item) => wanted.has(normName(item.name)));
            if (character) {
                fact.character = character;
                fact.messageIndex = index;
                break;
            }
        }
        const meta = this.app.host.ctx().chatMetadata.dooms_tracker;
        const known = isDict(meta) && isDict(meta.knownCharacters) ? meta.knownCharacters : {};
        const rosterEntry = inRoster ? known[inRoster] : undefined;
        if (isDict(rosterEntry) && typeof rosterEntry.emoji === 'string') fact.rosterEmoji = rosterEntry.emoji;
        const settings = this.safe(() => des.settings(), null) ?? {};
        const key = fact.canonical;
        const pick = (store: unknown): unknown => (isDict(store) ? store[key] : undefined);
        // DES keeps Workshop data by name for every chat: a namesake's (waiting for an answer or declared another
        // one's) stays hidden here (plan-2 §9).
        const hidden = [...(identity?.pending ?? []), ...(identity?.apart ?? [])].some(
            (source) => source.kind === 'des.workshop',
        );
        const appearance = hidden ? undefined : pick(settings.characterAppearance);
        if (typeof appearance === 'string' && appearance.trim()) fact.portraitPrompt = appearance.trim();
        const injection = hidden ? undefined : pick(settings.characterInjection);
        if (isDict(injection) && typeof injection.description === 'string' && injection.description.trim()) {
            fact.workshopDescription = injection.description.trim();
        }
        const relationship = hidden ? undefined : pick(settings.characterRelationships);
        if (typeof relationship === 'string' && relationship.trim()) fact.relationshipOverride = relationship.trim();
        const user = pick(settings.userCharacters);
        if (isDict(user)) fact.user = user;
        if (!fact.inRoster && !canonical && !fact.character && !fact.user) return null;
        return fact;
    }

    private relation(entity: Entity): string | null {
        const relations = this.app.modules.api<RelationsApi>('relations');
        if (!relations) return null;
        const user = normName(this.app.host.ctx().name1);
        const names = normSet([entity.name, ...entity.aliases]);
        const list = this.safe(() => relations.of(entity.name), []);
        const found = list.find(
            (relation) =>
                (names.has(normName(relation.from)) && normName(relation.to) === user) ||
                (names.has(normName(relation.to)) && normName(relation.from) === user),
        );
        return found?.current ?? list[0]?.current ?? null;
    }

    /* ---------------------------------------------------------------- chat: Qvink, sheets */

    private memories(entity: Entity, names: readonly string[]): MemoryLike[] {
        const qvink = adaptersOf(this.app).qvink;
        if (!this.safe(() => qvink.present(), false)) return [];
        const world = this.world();
        const matcher = mentionMatcher(names);
        const chat = this.app.host.ctx().chat;
        const found: MemoryLike[] = [];
        for (let index = 0; index < chat.length; index++) {
            const memory = this.safe(() => qvink.memoryOf(index), null);
            const text = memory?.memory.trim();
            if (!memory || !text) continue;
            const hit =
                mentionsAny(matcher, text) ||
                (world ? this.safe(() => world.mentions(text).some((item) => item.id === entity.id), false) : false);
            if (hit) found.push({ index, text, longTerm: memory.remember || memory.include === 'long' });
        }
        return pickMemories(found, this.settings().memories);
    }

    private sheet(names: readonly string[]): FoundSheet | null {
        const chat = this.app.host.ctx().chat;
        const sheets = this.app.modules.api<SheetsApi>('sheets');
        if (sheets) {
            const list = names.flatMap((name) => this.safe(() => sheets.sheetsFor(name), []));
            const full = list.filter((item) => item.command === 'fullsheet');
            const best = (full.length ? full : list).sort((a, b) => b.index - a.index)[0];
            const message = best ? chat[best.index] : undefined;
            if (best && message) {
                return { index: best.index, text: stripDesTrackerJson(str(message.mes)).trim(), command: best.command };
            }
        }
        return findLastSheet(
            chat.map((message, index) => ({
                index,
                text: str(message.mes),
                isUser: message.is_user === true,
                mark: readSheetMark(message.extra),
            })),
            names,
        );
    }

    /* ---------------------------------------------------------------- places, persona */

    private placeFact(entity: Entity): PlaceFact | null {
        const places = this.places();
        if (!places) return null;
        const id = entity.id.startsWith(PLACE_PREFIX)
            ? entity.id.slice(PLACE_PREFIX.length)
            : (entity.sources.find((source) => source.kind === 'place')?.ref ?? '');
        const place = this.safe(() => places.get(id), undefined);
        if (!place) return null;
        const parents: Place[] = [];
        const guard = new Set<string>([place.id]);
        let parentId = place.parent;
        while (parentId && !guard.has(parentId)) {
            guard.add(parentId);
            const parent = this.safe(() => places.get(parentId ?? ''), undefined);
            if (!parent) break;
            parents.push(parent);
            parentId = parent.parent;
        }
        const children = this.safe(() => places.list(), []).filter((item) => item.parent === place.id);
        return { place, parents, children };
    }

    private async personaAvatar(): Promise<string> {
        try {
            const module = await this.app.host.modules.load('personas.js');
            return typeof module.user_avatar === 'string' ? module.user_avatar : '';
        } catch (error) {
            this.log.debug('personas.js is not available', error);
            return '';
        }
    }

    private async personaFact(entity: Entity, cache: Map<string, BookData | null>): Promise<PersonaFact> {
        const ctx = this.app.host.ctx();
        const power = ctx.powerUserSettings ?? {};
        const lorebook = str(power.persona_description_lorebook).trim() || null;
        const fact: PersonaFact = {
            name: str(ctx.name1).trim() || entity.name,
            avatar: await this.personaAvatar(),
            description: str(power.persona_description).trim(),
            lorebook,
            lorebookEntries: [],
        };
        if (lorebook) {
            const data = await this.loadBook(lorebook, cache);
            if (data) {
                fact.lorebookEntries = enabledEntriesOf(data).map(({ uid, entry }) => ({
                    uid,
                    title: str(entry.comment).trim() || entryKeys(entry)[0] || `#${uid}`,
                }));
            }
        }
        return fact;
    }
}
