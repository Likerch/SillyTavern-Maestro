// What M20's lore rules know about the scene (plan M20 п. 3): who is present (the last committed DES tracker, P14;
// the world model's presence flags when there is no tracker), the DES roster, the current place and its
// neighbourhood (places registry), which characters and places the last K messages mention (world.mentions on
// cleaned text), what an entry is about, the canon book and its pins, and book roles.
//
// Everything here runs inside scan listeners, so it is cached (P15, §4.11): the scene snapshot per generation
// (chat length, last message, committed index, generation type, K, world/places versions), entry subjects per entry
// identity (world, uid, comment, first key, type marker) until the world model, places or roles change, mentions per
// message. Other modules are reached through their APIs only and re-bound when one of them restarts.
import {
    judgeSubject,
    mentionDistances,
    nearPlaceIds,
    placeEntityId,
    subjectCacheKey,
    subjectNames,
    typedMetaOf,
} from '../../domain/architect-presence';
import type { PresenceFacts, SubjectRef } from '../../domain/architect-presence';
import { quickHash } from '../../domain/architect-cache';
import { activationKey, isCanonActivation } from '../../domain/canon-inject';
import { desSwipeRecord, parseDesTracker } from '../../domain/des-tracker';
import { CANON_BOOK_PREFIX } from '../../domain/lore-journal';
import { lastCommittedIndex } from '../../domain/relations-history';
import { cleanForAnalysis } from '../../domain/text-clean';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { CanonApi } from '../canon/api';
import type { PlacesApi } from '../places/api';
import type { Entity, WorldModelApi } from '../world/api';
import type { ArchitectSettings } from './settings';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Messages looked at for «messages since the last mention» beyond K (only cached results are used there). */
export const MENTION_LOOKBACK = 40;
const MENTION_CACHE_LIMIT = 600;
const SUBJECT_CACHE_LIMIT = 6000;
/** Book roles whose entries M20 never touches (P13: BunnyMo is a vocabulary, not a cast). */
const PROTECTED_ROLES: ReadonlySet<string> = new Set(['bunnymo.core', 'bunnymo.pack', 'canon']);
const ARCHIVE_ROLE = 'ck.archive';

export interface SceneSnapshot extends PresenceFacts {
    key: string;
    /** The DES tracker of the committed reply gave the cast (otherwise the world model's flags did). */
    fromTracker: boolean;
}

interface Bound<T> {
    api: T | undefined;
    off: Unsubscribe | null;
}

type VersionKey = 'world' | 'places' | 'canon' | 'roles';

interface Cast {
    version: number;
    roster: Set<string>;
    present: Set<string>;
    absent: Set<string>;
}

function isRelevant(entity: Entity | undefined): entity is Entity {
    return !!entity && (entity.kind === 'character' || entity.kind === 'place');
}

function refOf(entity: Entity): SubjectRef {
    return { id: entity.id, kind: entity.kind === 'place' ? 'place' : 'character' };
}

export class SceneContext {
    private readonly world: Bound<WorldModelApi> = { api: undefined, off: null };
    private readonly places: Bound<PlacesApi> = { api: undefined, off: null };
    private readonly canon: Bound<CanonApi> = { api: undefined, off: null };
    private readonly roles: Bound<BookRolesApi> = { api: undefined, off: null };
    private readonly versions: Record<VersionKey, number> = { world: 0, places: 0, canon: 0, roles: 0 };
    private snap: SceneSnapshot | null = null;
    private readonly subjects = new Map<string, SubjectRef | null>();
    private subjectsKey = '';
    private index: { key: string; map: Map<string, SubjectRef> } | null = null;
    private cast: Cast | null = null;
    private placeInfo: { version: number; current: string | null; near: Set<string> } | null = null;
    private tracker: { key: string; names: string[] | null } | null = null;
    private readonly mentionCache = new Map<string, string[]>();
    private mentionVersion = -1;
    private pins: { key: string; set: Set<string> } = { key: '', set: new Set() };
    private pinsLoading: string | null = null;
    private warmTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly settings: () => ArchitectSettings,
        private readonly log: Logger,
    ) {}

    dispose(): void {
        this.disposed = true;
        for (const bound of [this.world, this.places, this.canon, this.roles]) {
            bound.off?.();
            bound.off = null;
            bound.api = undefined;
        }
        if (this.warmTimer) clearTimeout(this.warmTimer);
        this.warmTimer = null;
    }

    /* ---------------------------------------------------------------- bindings */

    private bind<T extends { onChange(listener: () => void): Unsubscribe }>(
        bound: Bound<T>,
        key: string,
        version: VersionKey,
        extra?: (api: T, bump: () => void) => Unsubscribe | undefined,
    ): T | undefined {
        const api = this.app.modules.api<T>(key);
        if (api === bound.api) return api;
        bound.off?.();
        bound.off = null;
        bound.api = api;
        const bump = () => {
            this.versions[version]++;
        };
        bump();
        if (api && !this.disposed) {
            const offs: Unsubscribe[] = [];
            try {
                offs.push(api.onChange(bump));
                const more = extra?.(api, bump);
                if (more) offs.push(more);
            } catch (error) {
                this.log.debug(`could not follow ${key}`, error);
            }
            bound.off = () => offs.forEach((off) => off());
        }
        return api;
    }

    /** Re-binds to the current module APIs (cheap identity checks); call at the start of every scan handler. */
    track(): void {
        if (this.disposed) return;
        this.bind(this.world, 'world', 'world');
        this.bind(this.places, 'places', 'places', (api, bump) => api.onEnter(() => bump()));
        this.bind(this.canon, 'canon', 'canon');
        this.bind(this.roles, 'bookRoles', 'roles');
    }

    worldApi(): WorldModelApi | undefined {
        return this.world.api;
    }

    placesApi(): PlacesApi | undefined {
        return this.places.api;
    }

    /* ---------------------------------------------------------------- books */

    canonBook(): string {
        try {
            return this.canon.api?.bookName() ?? '';
        } catch {
            return '';
        }
    }

    /** An entry of the chat canon (its book, or an override copy carrying the canon marker). */
    isCanonEntry(entry: Dict): boolean {
        const world = typeof entry.world === 'string' ? entry.world : '';
        if (world.startsWith(CANON_BOOK_PREFIX)) return true;
        const book = this.canonBook();
        return isCanonActivation(entry, book || CANON_BOOK_PREFIX);
    }

    bookRole(book: string): string | undefined {
        if (!book) return undefined;
        try {
            return this.roles.api?.roleOf(book)?.role;
        } catch {
            return undefined;
        }
    }

    /** BunnyMo core and packs, canon books: M20 never damps, cuts or rewrites their entries. */
    isProtectedBook(book: string): boolean {
        if (book.startsWith(CANON_BOOK_PREFIX)) return true;
        const role = this.bookRole(book);
        return role !== undefined && PROTECTED_ROLES.has(role);
    }

    /** BunnyMo core or pack books (P13: never rewritten, not even on a scan copy). */
    isBunnyMoBook(book: string): boolean {
        const role = this.bookRole(book);
        return role === 'bunnymo.core' || role === 'bunnymo.pack';
    }

    isArchiveBook(book: string): boolean {
        return this.bookRole(book) === ARCHIVE_ROLE;
    }

    /**
     * Activation keys (`world.uid`) of the base entries the canon pins. Read from the canon asynchronously and cached
     * per chat and canon version; a scan uses what is known (M6 forces them itself, this only protects them).
     */
    canonPins(): ReadonlySet<string> {
        const api = this.canon.api;
        if (!api) return this.pins.set;
        const key = `${this.app.host.chatId() ?? ''}|${this.versions.canon}`;
        if (this.pins.key !== key && this.pinsLoading !== key) {
            this.pinsLoading = key;
            void api
                .list({ kind: 'pin' })
                .then((items) => {
                    const set = new Set<string>();
                    for (const item of items) {
                        const base = item.meta.base;
                        if (base) set.add(activationKey(base.world, base.uid));
                    }
                    this.pins = { key, set };
                })
                .catch((error: unknown) => this.log.debug('canon pins are not available', error))
                .finally(() => {
                    if (this.pinsLoading === key) this.pinsLoading = null;
                });
        }
        return this.pins.set;
    }

    /* ---------------------------------------------------------------- subjects */

    /** The character or place an entry is about (cached per entry identity until the world, places or roles change). */
    subject(entry: Dict): SubjectRef | null {
        const world = this.world.api;
        if (!world) return null;
        const versionKey = `${this.versions.world}.${this.versions.places}.${this.versions.roles}`;
        if (versionKey !== this.subjectsKey) {
            this.subjects.clear();
            this.subjectsKey = versionKey;
        }
        const key = subjectCacheKey(entry);
        const cached = this.subjects.get(key);
        if (cached !== undefined) return cached;
        let result: SubjectRef | null = null;
        try {
            result = this.resolveSubject(world, entry);
        } catch (error) {
            this.log.debug('entry subject could not be resolved', error);
        }
        if (this.subjects.size >= SUBJECT_CACHE_LIMIT) this.subjects.clear();
        this.subjects.set(key, result);
        return result;
    }

    private resolveSubject(world: WorldModelApi, entry: Dict): SubjectRef | null {
        const book = typeof entry.world === 'string' ? entry.world : '';
        const uid = Number(entry.uid);
        let sidecar: unknown;
        try {
            sidecar = this.roles.api?.entryMeta(book, uid);
        } catch {
            sidecar = undefined;
        }
        const typed = typedMetaOf(entry, sidecar);
        if (typed && typed.type !== 'character' && typed.type !== 'place') return null;
        if (typed) {
            for (const name of subjectNames(entry, typed)) {
                const entity = world.resolve(name.name, name.kind);
                if (isRelevant(entity)) return refOf(entity);
            }
        }
        const indexed = this.subjectIndex(world).get(`${book}#${uid}`);
        if (indexed) return indexed;
        if (typed) return null;
        for (const name of subjectNames(entry, null)) {
            const entity = world.resolve(name.name);
            if (isRelevant(entity)) return refOf(entity);
        }
        return null;
    }

    /** `${world}#${uid}` → subject, from the world model's entity sources and the places' description entries. */
    private subjectIndex(world: WorldModelApi): Map<string, SubjectRef> {
        const key = `${this.versions.world}.${this.versions.places}`;
        if (this.index?.key === key) return this.index.map;
        const map = new Map<string, SubjectRef>();
        try {
            for (const entity of world.entities()) {
                if (!isRelevant(entity)) continue;
                for (const source of entity.sources) {
                    if (source.world === undefined || source.uid === undefined) continue;
                    if (source.kind !== 'lore.entry' && source.kind !== 'canon.entry' && source.kind !== 'ck.archive')
                        continue;
                    const ref = `${source.world}#${source.uid}`;
                    if (!map.has(ref)) map.set(ref, refOf(entity));
                }
            }
            for (const place of this.places.api?.list() ?? []) {
                if (place.entry)
                    map.set(`${place.entry.world}#${place.entry.uid}`, { id: placeEntityId(place.id), kind: 'place' });
            }
        } catch (error) {
            this.log.debug('subject index could not be built', error);
        }
        this.index = { key, map };
        return map;
    }

    /* ---------------------------------------------------------------- scene */

    /** The scene facts for the generation in progress; null without the world model. */
    snapshot(): SceneSnapshot | null {
        const world = this.world.api;
        if (!world) return null;
        const chat = (this.app.host.ctx().chat ?? []) as unknown[];
        const type = this.app.turn.current()?.type ?? 'normal';
        const window = this.settings().presence.mentionWindow;
        let end = chat.length;
        const last = chat[end - 1];
        // A swipe replaces the last reply: its old text is not part of the scene.
        if (type === 'swipe' && isDict(last) && last.is_user !== true && last.is_system !== true) end--;
        const committed = lastCommittedIndex(chat as STChatMessage[]);
        const lastText = isDict(last) && typeof last.mes === 'string' ? last.mes : '';
        const key = [
            this.app.host.chatId() ?? '',
            end,
            lastText.length,
            isDict(last) ? String(last.swipe_id ?? 0) : '',
            committed,
            type,
            window,
            this.versions.world,
            this.versions.places,
        ].join('|');
        if (this.snap?.key === key) return this.snap;

        const cast = this.castOf(world);
        const names = this.trackerNames(chat, committed);
        let present: Set<string>;
        let absent: Set<string>;
        if (names) {
            present = new Set<string>();
            for (const name of names) {
                const entity = world.resolve(name, 'character');
                if (entity) present.add(entity.id);
            }
            absent = new Set([...cast.roster].filter((id) => !present.has(id)));
        } else {
            present = cast.present;
            absent = cast.absent;
        }
        const place = this.placesNow();
        const mentions = mentionDistances(this.mentionRows(world, chat, end, window));
        this.snap = {
            key,
            present,
            absent,
            currentPlace: place.current,
            nearPlaces: place.near,
            mentions,
            window,
            fromTracker: names !== null,
        };
        return this.snap;
    }

    /** DES roster and the world model's presence flags (per world version). */
    private castOf(world: WorldModelApi): Cast {
        if (this.cast?.version === this.versions.world) return this.cast;
        const roster = new Set<string>();
        const present = new Set<string>();
        const absent = new Set<string>();
        try {
            for (const entity of world.entities('character')) {
                const inRoster = entity.sources.some((source) => source.kind === 'des.character');
                if (inRoster) roster.add(entity.id);
                if (entity.present === true) present.add(entity.id);
                else if (entity.present === false && inRoster) absent.add(entity.id);
            }
        } catch (error) {
            this.log.debug('characters are not available', error);
        }
        this.cast = { version: this.versions.world, roster, present, absent };
        return this.cast;
    }

    /** Names of the characters in the scene of the committed reply; null when it has no DES characters. */
    private trackerNames(chat: readonly unknown[], committed: number): string[] | null {
        const message = committed >= 0 ? chat[committed] : undefined;
        const text = isDict(message) && typeof message.mes === 'string' ? message.mes : '';
        const key = `${committed}|${isDict(message) ? String(message.swipe_id ?? 0) : ''}|${text.length}`;
        if (this.tracker?.key === key) return this.tracker.names;
        let names: string[] | null = null;
        try {
            const record = desSwipeRecord(message);
            if (record) {
                const characters = parseDesTracker(record).characters;
                if (characters.length) names = characters.filter((item) => !item.offScene).map((item) => item.name);
            }
        } catch (error) {
            this.log.debug('DES tracker of the committed reply could not be read', error);
        }
        this.tracker = { key, names };
        return names;
    }

    private placesNow(): { current: string | null; near: Set<string> } {
        const api = this.places.api;
        if (!api) return { current: null, near: new Set() };
        if (this.placeInfo?.version === this.versions.places) return this.placeInfo;
        let current: string | null = null;
        let near = new Set<string>();
        try {
            const place = api.current();
            if (place) {
                current = placeEntityId(place.id);
                near = new Set([...nearPlaceIds(api.list(), place.id)].map(placeEntityId));
            }
        } catch (error) {
            this.log.debug('places are not available', error);
        }
        this.placeInfo = { version: this.versions.places, current, near };
        return this.placeInfo;
    }

    /**
     * Entity ids mentioned per message, oldest first: the last K non-system messages are computed (cached per
     * message text); older ones up to MENTION_LOOKBACK only when already cached (warmMentions fills them in the
     * background), so «messages since the last mention» costs nothing on the send path.
     */
    private mentionRows(world: WorldModelApi, chat: readonly unknown[], end: number, window: number): string[][] {
        if (this.mentionVersion !== this.versions.world) {
            this.mentionCache.clear();
            this.mentionVersion = this.versions.world;
        }
        const rows: string[][] = [];
        let counted = 0;
        for (let i = end - 1; i >= 0 && counted < MENTION_LOOKBACK; i--) {
            const message = chat[i];
            if (!isDict(message) || message.is_system === true) continue;
            const ids = this.mentionsOf(world, i, message, counted < window);
            if (!ids) break;
            rows.unshift(ids);
            counted++;
        }
        return rows;
    }

    private mentionsOf(world: WorldModelApi, index: number, message: Dict, compute: boolean): string[] | null {
        const text = typeof message.mes === 'string' ? message.mes : '';
        const key = `${index}|${String(message.swipe_id ?? 0)}|${text.length}|${quickHash(text)}`;
        const cached = this.mentionCache.get(key);
        if (cached) return cached;
        if (!compute) return null;
        let ids: string[] = [];
        try {
            ids = world
                .mentions(cleanForAnalysis(message))
                .filter((entity) => isRelevant(entity))
                .map((entity) => entity.id);
        } catch (error) {
            this.log.debug('mentions could not be read', error);
        }
        if (this.mentionCache.size >= MENTION_CACHE_LIMIT) this.mentionCache.clear();
        this.mentionCache.set(key, ids);
        return ids;
    }

    /** Fills the mention cache for the look-back window when the page is idle (never on the send path). */
    warmMentions(): void {
        if (this.warmTimer || this.disposed) return;
        this.warmTimer = setTimeout(() => {
            this.warmTimer = null;
            const world = this.world.api;
            if (!world || this.disposed) return;
            const chat = (this.app.host.ctx().chat ?? []) as unknown[];
            let counted = 0;
            for (let i = chat.length - 1; i >= 0 && counted < MENTION_LOOKBACK; i--) {
                const message = chat[i];
                if (!isDict(message) || message.is_system === true) continue;
                this.mentionsOf(world, i, message, true);
                counted++;
            }
        }, 0);
    }

    /** What the presence rule does with this entry now (null subject: nothing). */
    verdict(entry: Dict, scene: SceneSnapshot): ReturnType<typeof judgeSubject> & { subject: SubjectRef | null } {
        const subject = this.subject(entry);
        if (!subject) return { action: 'none', subject };
        return { ...judgeSubject(subject, scene), subject };
    }
}
