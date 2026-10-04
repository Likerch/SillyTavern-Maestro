// S4 «Сигналы»: commit-on-send comparison behind SignalsApi (plan §4.4, §5 phase 1 and «Отмена», P14, P15, M8).
//
// `turn:committed` (the user sent a message, so the reply before it is final) only remembers the index: the
// comparison runs in an idle slot after the send (requestIdleCallback, at most 1 s; setTimeout 0 without it), never
// on the send path. A pass (leader tab only) rolls back the records whose reply changed (stamp `send_date|swipe_id`),
// then reads the committed replies after the last record: DES tracker of the reply and of the committed reply before
// it, DES aliases, Qvink flags of the recent messages and the names in the reply → signals (src/domain/signals-diff.ts)
// → folded → stored in the chat document 'signals' (compare-and-swap with retries) → app.bus 'signal' and onBatch.
// With the place registry (M24) on, location changes come from its enter events. `message:invalidated` rolls back
// from the message and re-reads the replies after it quietly (their signals were emitted once already).
// Other modules may put 'fact.new' signals on the bus for a committed turn: kept with the turn unless they carry a
// `data.source` (a consumer's own output, e.g. the revision's): those are never stored, counted or folded. Signals of
// this service carry no `data.source`.
import { adaptersOf } from '../../adapters';
import { desSwipeRecord, parseDesTracker } from '../../domain/des-tracker';
import type { DesTrackerSnapshot } from '../../domain/des-tracker';
import { committedIndices } from '../../domain/places-registry';
import { foldSignals, observe, step } from '../../domain/signals-diff';
import type {
    EnteredPlace,
    MemoryObservation,
    Observation,
    RawSignal,
    SignalKindName,
    SignalSubject,
    StepOptions,
} from '../../domain/signals-diff';
import {
    emptySignalsDoc,
    firstStaleRecord,
    lastRecordIndex,
    lastTrackerRecord,
    messageStamp,
    messagesSince,
    normalizeSignalsDoc,
    pendingSignals,
    rollbackFrom,
    trimRecords,
} from '../../domain/signals-doc';
import type { SignalRecord, SignalsDocData } from '../../domain/signals-doc';
import { findNameCandidates, isKnownName, knownNameKeys } from '../../domain/signals-names';
import type { NameCandidate } from '../../domain/signals-names';
import { cleanForAnalysis } from '../../domain/text-clean';
import { entityIdOf, normalizeName } from '../../domain/world-names';
import type { App, Logger, Signal, Unsubscribe } from '../../shared/contracts';
import type { Place, PlacesApi } from '../places/api';
import type { WorldModelApi } from '../world/api';
import type { SignalBatch, SignalKind, SignalsApi } from './api';

export const SIGNALS_KEY = 'signals';
export const SIGNALS_ID = 'S4';
export const SIGNALS_DOC = 'signals';

/** Records checked against the chat on every commit (a full check runs on invalidation, open and leadership). */
const RECENT_CHECK = 20;
/** Committed replies read at most in one pass (after a long gap or in another tab). */
const CATCH_UP = 30;
/** Replies read silently on the first visit of a chat (they set the baselines). */
const BOOT_TURNS = 3;
const IDLE_TIMEOUT_MS = 1000;
/** A place change the registry reports this long after a commit still belongs to that turn. */
const COMMIT_WINDOW_MS = 30_000;
/** Messages whose Qvink flags are compared on every commit. */
const QVINK_WINDOW = 40;
const PUT_ATTEMPTS = 3;
/** Kinds other modules may add to a committed turn through the bus. */
const EXTERNAL_KINDS: ReadonlySet<string> = new Set(['fact.new']);

type IdleRequest = (callback: () => void, options?: { timeout?: number }) => number;
type Mode = 'commit' | 'open' | 'catchup' | 'replay';

// The domain's kind list is exactly the API's (src/domain cannot import feature types).
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const sameKinds: Exact<SignalKind, SignalKindName> = true;
void sameKinds;

export interface SignalsSettings {
    /** A forward jump of more than this many story hours is a time skip (scene end). */
    timeSkipHours: number;
    /** Appearance and outfit texts less similar than this (0–1, word sets) count as a change. */
    appearanceThreshold: number;
    /** Look for new names in replies ('name.new'). */
    names: boolean;
    /** Turns kept in the chat document (older ones can no longer be rolled back one by one). */
    keepRecords: number;
}

export function defaultSignalsSettings(): SignalsSettings {
    return { timeSkipHours: 6, appearanceThreshold: 0.5, names: true, keepRecords: 80 };
}

/** Repairs the stored slice in place (bad values → defaults). */
export function readSignalsSettings(slice: Partial<SignalsSettings>): SignalsSettings {
    const defaults = defaultSignalsSettings();
    const number = (value: unknown, min: number, max: number): value is number =>
        typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
    if (!number(slice.timeSkipHours, 0, 10_000)) slice.timeSkipHours = defaults.timeSkipHours;
    if (!number(slice.appearanceThreshold, 0, 1)) slice.appearanceThreshold = defaults.appearanceThreshold;
    if (typeof slice.names !== 'boolean') slice.names = defaults.names;
    if (!number(slice.keepRecords, 5, 1000)) slice.keepRecords = defaults.keepRecords;
    return slice as SignalsSettings;
}

interface PassContext {
    chatId: string;
    settings: SignalsSettings;
    known: Set<string> | null;
}

export class SignalsService implements SignalsApi {
    private doc: SignalsDocData | null = null;
    private docChat: string | null = null;
    private loading: { chatId: string; promise: Promise<SignalsDocData | null> } | null = null;
    private generation = 0;
    private chain: Promise<unknown> = Promise.resolve();
    private readonly batchListeners = new Set<(batch: SignalBatch) => void>();
    private readonly changeListeners = new Set<() => void>();
    private lastBatch: { chatId: string; batch: SignalBatch } | null = null;
    /** Place changes the registry reported for a turn not read yet. */
    private readonly entered = new Map<number, EnteredPlace>();
    /** Signals other modules emitted for a turn not read yet. */
    private readonly external = new Map<number, Signal[]>();
    /** Signals this service emitted (not captured back). */
    private readonly emittedByUs = new WeakSet<Signal>();
    private window: { index: number; until: number } | null = null;
    private places: { api: PlacesApi; off: Unsubscribe } | null = null;
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly idles = new Set<number>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => SignalsSettings,
    ) {}

    /* ---------------------------------------------------------------- lifecycle */

    install(): Unsubscribe[] {
        const { app } = this;
        const offs: Unsubscribe[] = [
            app.bus.on('turn:committed', ({ messageIndex }) => {
                // P15: MESSAGE_SENT is on the send path — remember the index, compare in an idle slot.
                this.window = { index: messageIndex, until: Date.now() + COMMIT_WINDOW_MS };
                this.schedule(() => this.pass({ upTo: messageIndex, mode: 'commit' }), true);
            }),
            app.bus.on('message:invalidated', ({ messageIndex, reason }) => {
                this.window = null;
                for (const index of [...this.entered.keys()]) if (index >= messageIndex) this.entered.delete(index);
                for (const index of [...this.external.keys()]) if (index >= messageIndex) this.external.delete(index);
                this.schedule(() => this.invalidate(messageIndex, reason));
            }),
            app.bus.on('chat:changed', () => {
                this.reset();
                this.schedule(() => this.open());
            }),
            app.bus.on('signal', (signal) => this.capture(signal)),
            app.leader.onChange((leader) => {
                if (leader) this.schedule(() => this.pass({ mode: 'catchup' }));
            }),
        ];
        this.watchPlaces();
        this.schedule(() => this.open());
        return offs;
    }

    dispose(): void {
        this.disposed = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        const cancel = (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
        for (const handle of this.idles) cancel?.(handle);
        this.idles.clear();
        this.places?.off();
        this.places = null;
        this.batchListeners.clear();
        this.changeListeners.clear();
    }

    /** Runs a job after the current handlers; `idle` waits for an idle moment of the page (at most 1 s). */
    private schedule(job: () => Promise<void>, idle = false): void {
        if (this.disposed) return;
        const run = () => {
            if (this.disposed) return;
            job().catch((error: unknown) => this.log.error('signals update failed', error));
        };
        const request = (globalThis as { requestIdleCallback?: IdleRequest }).requestIdleCallback;
        if (idle && typeof request === 'function') {
            const handle = request(
                () => {
                    this.idles.delete(handle);
                    run();
                },
                { timeout: IDLE_TIMEOUT_MS },
            );
            this.idles.add(handle);
            return;
        }
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            run();
        }, 0);
        this.timers.add(timer);
    }

    private reset(): void {
        this.generation++;
        this.doc = null;
        this.docChat = null;
        this.loading = null;
        this.lastBatch = null;
        this.window = null;
        this.entered.clear();
        this.external.clear();
        this.changed();
    }

    /** Loads the open chat's document, then (leader) reads what was committed since. */
    async open(): Promise<void> {
        await this.load();
        this.changed();
        await this.pass({ mode: 'open' });
    }

    onChange(listener: () => void): Unsubscribe {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }

    private changed(): void {
        for (const listener of [...this.changeListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('signals listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- document */

    private peek(): SignalsDocData | null {
        const chatId = this.app.host.chatId();
        return chatId !== null && chatId === this.docChat ? this.doc : null;
    }

    /** True once the open chat's document is loaded (the pult shows «loading» until then). */
    loaded(): boolean {
        return this.peek() !== null;
    }

    private load(): Promise<SignalsDocData | null> {
        const chatId = this.app.host.chatId();
        if (!chatId) return Promise.resolve(null);
        const ready = this.peek();
        if (ready) return Promise.resolve(ready);
        if (this.loading?.chatId === chatId) return this.loading.promise;
        const generation = this.generation;
        const promise = this.app.chat
            .get<object>(SIGNALS_DOC, emptySignalsDoc)
            .then((raw) => {
                if (generation !== this.generation || this.app.host.chatId() !== chatId) return null;
                if (this.docChat !== chatId || !this.doc) {
                    this.doc = normalizeSignalsDoc(structuredClone(raw));
                    this.docChat = chatId;
                    this.changed();
                }
                return this.doc;
            })
            .catch((error: unknown) => {
                this.log.warn('signals of this chat could not be read', error);
                return null;
            })
            .finally(() => {
                if (this.loading?.promise === promise) this.loading = null;
            });
        this.loading = { chatId, promise };
        return promise;
    }

    /**
     * Applies `change` to a fresh copy of the chat document and saves it when it says so; on a version conflict the
     * newer document is re-read and the change applied again. Resolves undefined when the chat switched, there is no
     * chat, or saving failed every time. Serialised.
     */
    private mutate<R>(change: (doc: SignalsDocData) => { changed: boolean; result: R }): Promise<R | undefined> {
        const job = async (): Promise<R | undefined> => {
            const chatId = this.app.host.chatId();
            const generation = this.generation;
            if (!chatId) return undefined;
            for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
                const live = await this.app.chat.get<object>(SIGNALS_DOC, emptySignalsDoc);
                if (generation !== this.generation || this.app.host.chatId() !== chatId) return undefined;
                // A copy: a failed write must not leave the change in the chat store's cached document.
                const doc = normalizeSignalsDoc(structuredClone(live));
                const outcome = change(doc);
                if (!outcome.changed) {
                    this.adopt(chatId, doc);
                    return outcome.result;
                }
                if (generation !== this.generation || this.app.host.chatId() !== chatId) return undefined;
                if (await this.app.chat.put(SIGNALS_DOC, doc)) {
                    this.adopt(chatId, doc);
                    return outcome.result;
                }
                this.log.info('signals were changed in another tab; retrying on the fresh copy');
            }
            this.log.warn(`signals could not be saved after ${PUT_ATTEMPTS} attempts`);
            return undefined;
        };
        const next = this.chain.then(job, job);
        this.chain = next.catch(() => undefined);
        return next;
    }

    private adopt(chatId: string, doc: SignalsDocData): void {
        if (this.app.host.chatId() !== chatId) return;
        this.doc = doc;
        this.docChat = chatId;
        this.changed();
    }

    /* ---------------------------------------------------------------- reading the chat */

    private chat(): STChatMessage[] {
        const chat = this.app.host.ctx().chat;
        return Array.isArray(chat) ? chat : [];
    }

    private stampAt(index: number): string | null {
        const message = this.chat()[index];
        if (!message || message.is_user || message.is_system) return null;
        return messageStamp(message);
    }

    private tracker(index: number): DesTrackerSnapshot | null {
        const message = this.chat()[index];
        if (!message || message.is_user || message.is_system) return null;
        try {
            const des = adaptersOf(this.app).des;
            if (typeof des?.trackerFor === 'function') return des.trackerFor(index);
        } catch (error) {
            this.log.debug('DES tracker is not available', error);
        }
        const record = desSwipeRecord(message);
        return record ? parseDesTracker(record) : null;
    }

    private worldApi(): WorldModelApi | undefined {
        return this.app.modules.api<WorldModelApi>('world');
    }

    private placesApi(): PlacesApi | undefined {
        return this.app.modules.api<PlacesApi>('places');
    }

    /** Subscribes to the place registry's enter events (again when it was switched off and on). */
    private watchPlaces(): void {
        const api = this.placesApi();
        if (api === this.places?.api) return;
        this.places?.off();
        this.places = null;
        if (!api || typeof api.onEnter !== 'function') return;
        try {
            this.places = { api, off: api.onEnter((place, previous) => this.onEnter(place, previous)) };
        } catch (error) {
            this.log.debug('cannot listen to the place registry', error);
        }
    }

    private desAliases(): Record<string, string[]> {
        try {
            return adaptersOf(this.app).des.aliases?.() ?? {};
        } catch {
            return {};
        }
    }

    /** DES/world canonical name of a character as DES wrote it. */
    private canonicalResolver(): (name: string) => string {
        const world = this.worldApi();
        const byAlias = new Map<string, string>();
        for (const [canonical, list] of Object.entries(this.desAliases())) {
            for (const alias of [canonical, ...list]) byAlias.set(normalizeName(alias), canonical);
        }
        return (name) => {
            try {
                const entity = world?.resolve(name, 'character') ?? world?.resolve(name, 'persona');
                if (entity?.name) return entity.name;
            } catch (error) {
                this.log.debug('world model resolve failed', error);
            }
            return byAlias.get(normalizeName(name)) ?? name;
        };
    }

    private observationAt(index: number, canonical: (name: string) => string): Observation | null {
        const snapshot = this.tracker(index);
        return snapshot ? observe(snapshot, canonical) : null;
    }

    /** Current DES aliases; null without DES. */
    private aliases(): Record<string, string[]> | null {
        try {
            const des = adaptersOf(this.app).des;
            if (!des?.present?.()) return null;
            return des.aliases();
        } catch {
            return null;
        }
    }

    /** Qvink records of the messages up to `index` (the last QVINK_WINDOW); null without Qvink. */
    private memories(index: number): MemoryObservation[] | null {
        let qvink;
        try {
            qvink = adaptersOf(this.app).qvink;
            if (!qvink?.present?.() || typeof qvink.memoryOf !== 'function') return null;
        } catch {
            return null;
        }
        const chat = this.chat();
        const out: MemoryObservation[] = [];
        for (let i = Math.max(0, index - QVINK_WINDOW + 1); i <= index && i < chat.length; i++) {
            try {
                const memory = qvink.memoryOf(i);
                if (memory)
                    out.push({
                        index: i,
                        stamp: messageStamp(chat[i]),
                        text: memory.memory,
                        remember: memory.remember,
                    });
            } catch (error) {
                this.log.debug('Qvink memory is not readable', error);
            }
        }
        return out;
    }

    /** Names the stack already knows: world model, DES roster and aliases, persona and card, places. */
    private knownKeys(): Set<string> {
        const names: string[] = [];
        try {
            for (const entity of this.worldApi()?.entities() ?? []) {
                names.push(entity.name, ...entity.aliases, ...entity.forms);
            }
        } catch (error) {
            this.log.debug('world model entities are not readable', error);
        }
        for (const [canonical, list] of Object.entries(this.desAliases())) names.push(canonical, ...list);
        try {
            names.push(...(adaptersOf(this.app).des.knownCharacters?.() ?? []));
        } catch {
            // DES roster not readable: the world model usually has it
        }
        try {
            for (const place of this.placesApi()?.list() ?? [])
                names.push(place.name, ...place.aliases, ...place.forms);
        } catch (error) {
            this.log.debug('places are not readable', error);
        }
        const ctx = this.app.host.ctx();
        names.push(ctx.name1, ctx.name2);
        return knownNameKeys(names);
    }

    private namesOf(index: number): NameCandidate[] {
        return findNameCandidates(cleanForAnalysis(this.chat()[index]));
    }

    /* ---------------------------------------------------------------- the pass */

    /**
     * One pass (leader only): rolls back from the first record whose reply changed (and from `from`), then reads the
     * committed replies after the last record — up to `upTo` for a commit, only the rolled-back ones for a replay.
     */
    async pass(options: { upTo?: number; mode: Mode; from?: number }): Promise<void> {
        if (this.disposed || !this.app.leader.isLeader() || this.app.host.isGroupChat()) return;
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        const generation = this.generation;
        this.watchPlaces();
        const context: PassContext = { chatId, settings: this.settings(), known: null };
        const created: SignalRecord[] = [];
        const done = await this.mutate((doc) => {
            created.length = 0;
            context.known = null;
            const before = lastRecordIndex(doc);
            let changed = false;
            const check = options.mode === 'commit' ? RECENT_CHECK : Infinity;
            let from = firstStaleRecord(doc, (index) => this.stampAt(index), check);
            if (options.from !== undefined) from = from === null ? options.from : Math.min(from, options.from);
            if (from !== null && rollbackFrom(doc, from) > 0) changed = true;
            const last = lastRecordIndex(doc);
            const limit = options.mode === 'replay' ? before : (options.upTo ?? Infinity);
            const committed = committedIndices(this.chat());
            let pending = committed.filter((index) => index > last && index <= limit);
            const fresh = !doc.initialized;
            const emitNewest = options.mode === 'commit';
            if (fresh) pending = pending.slice(-(BOOT_TURNS + (emitNewest ? 1 : 0)));
            else if (pending.length > CATCH_UP) pending = pending.slice(-CATCH_UP);
            const canonical = this.canonicalResolver();
            pending.forEach((index, n) => {
                const newest = n === pending.length - 1;
                const silent = fresh && !(emitNewest && newest);
                const record = this.read(doc, index, { silent, newest, canonical, context });
                doc.records.push(record);
                changed = true;
                if (!silent && options.mode !== 'replay') created.push(record);
            });
            if (fresh && pending.length) {
                doc.initialized = true;
                const consumed = emitNewest ? pending[pending.length - 2] : pending[pending.length - 1];
                doc.consumedUpTo = Math.max(doc.consumedUpTo, consumed ?? -1);
            }
            if (doc.records.length > context.settings.keepRecords) {
                trimRecords(doc, context.settings.keepRecords);
                changed = true;
            }
            return { changed, result: true };
        });
        if (!done || generation !== this.generation) return;
        const newest = lastRecordIndex(this.peek() ?? emptySignalsDoc());
        for (const index of [...this.entered.keys()]) if (index <= newest) this.entered.delete(index);
        for (const index of [...this.external.keys()]) if (index <= newest) this.external.delete(index);
        for (const record of created) await this.emitRecord(record, chatId, false);
    }

    /** Reads one committed reply into a record (signals folded; none when silent). */
    private read(
        doc: SignalsDocData,
        index: number,
        flags: { silent: boolean; newest: boolean; canonical: (name: string) => string; context: PassContext },
    ): SignalRecord {
        const { context } = flags;
        const current = this.observationAt(index, flags.canonical);
        const previousRecord = lastTrackerRecord(doc);
        const previous = previousRecord ? this.observationAt(previousRecord.index, flags.canonical) : null;
        const settings = context.settings;
        const options: StepOptions = {
            timeSkipHours: settings.timeSkipHours,
            appearanceThreshold: settings.appearanceThreshold,
        };
        let names = null;
        if (settings.names) {
            const before = lastRecordIndex(doc);
            context.known ??= this.knownKeys();
            const known = context.known;
            // Characters and places of the two trackers count as known too (DES names them before the world does).
            const local = knownNameKeys(
                [current, previous].flatMap((observation) => [
                    ...(observation?.chars.map((char) => char.name) ?? []),
                    observation?.location ?? '',
                ]),
            );
            names = {
                current: this.namesOf(index),
                previous: before >= 0 ? this.namesOf(before) : [],
                known: (key: string) => isKnownName(key, known) || isKnownName(key, local),
            };
        }
        const { signals: raw, trace } = step(doc.baseline, {
            current,
            previous,
            aliases: flags.newest ? this.aliases() : null,
            memories: flags.newest ? this.memories(index) : null,
            names,
            registry: this.placesApi() ? { entered: this.entered.get(index) ?? null } : null,
            options,
        });
        const { signals: folded, folded: count } = foldSignals(raw);
        const at = Date.now();
        const record: SignalRecord = {
            index,
            stamp: messageStamp(this.chat()[index]),
            tracker: current !== null,
            at,
            signals: flags.silent ? [] : folded.map((signal) => this.toSignal(signal, index, context.chatId, at)),
            folded: flags.silent ? 0 : count,
            trace,
        };
        const extra = this.external.get(index);
        if (extra?.length && !flags.silent) record.extra = structuredClone(extra);
        return record;
    }

    private toSignal(raw: RawSignal, index: number, chatId: string, at: number): Signal {
        const signal: Signal = { kind: raw.kind, chatId, messageIndex: index, at, data: raw.data };
        const entity = raw.subject ? this.entityOf(raw.subject) : undefined;
        if (entity) signal.entity = entity;
        return signal;
    }

    /** World model id of a signal's subject; a `kind:name` id like the world model's when it does not know it. */
    private entityOf(subject: SignalSubject): string | undefined {
        const world = this.worldApi();
        const resolve = (name: string, kind: Parameters<WorldModelApi['resolve']>[1]) => {
            try {
                return world?.resolve(name, kind)?.id;
            } catch {
                return undefined;
            }
        };
        if (subject.type === 'character') {
            return (
                resolve(subject.name, 'character') ??
                resolve(subject.name, 'persona') ??
                entityIdOf('character', subject.name)
            );
        }
        if (subject.type === 'quest') return resolve(subject.name, 'quest') ?? entityIdOf('quest', subject.name);
        if (subject.id) return `place:${subject.id}`;
        try {
            const place = this.placesApi()?.resolve(subject.name);
            if (place) return `place:${place.id}`;
        } catch {
            // fall through to the world model
        }
        return resolve(subject.name, 'place');
    }

    private async emitRecord(record: SignalRecord, chatId: string, late: boolean, only?: Signal[]): Promise<void> {
        const batch: SignalBatch = {
            messageIndex: record.index,
            signals: structuredClone(only ?? record.signals),
            folded: only ? 0 : record.folded,
        };
        if (late) batch.late = true;
        this.lastBatch = { chatId, batch };
        for (const signal of batch.signals) {
            this.emittedByUs.add(signal);
            await this.app.bus.emit('signal', signal);
        }
        for (const listener of [...this.batchListeners]) {
            try {
                listener(batch);
            } catch (error) {
                this.log.error('signal batch listener failed', error);
            }
        }
        this.changed();
    }

    /* ---------------------------------------------------------------- late additions */

    /** The place registry moved to another place (M24 onEnter): kept for the turn just committed. */
    private onEnter(place: Place | null, previous: Place | null): void {
        if (!place || !previous || place.id === previous.id) return;
        if (!this.app.leader.isLeader()) return;
        const window = this.window;
        if (!window || Date.now() > window.until) return;
        const entered: EnteredPlace = {
            id: place.id,
            name: place.name,
            previousId: previous.id,
            previousName: previous.name,
        };
        if (this.peek()?.records.some((record) => record.index === window.index)) {
            this.schedule(() => this.addLate(window.index, entered));
        } else {
            this.entered.set(window.index, entered);
        }
    }

    /** Adds a registry place change to the latest record (only the latest: the baseline must stay in order). */
    private async addLate(index: number, entered: EnteredPlace): Promise<void> {
        if (!this.app.leader.isLeader()) return;
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        const generation = this.generation;
        const settings = this.settings();
        const added = await this.mutate<{ record: SignalRecord; signals: Signal[] } | null>((doc) => {
            const record = doc.records[doc.records.length - 1];
            if (!record || record.index !== index) return { changed: false, result: null };
            const { signals: raw, trace } = step(doc.baseline, {
                current: null,
                previous: null,
                registry: { entered },
                options: { timeSkipHours: settings.timeSkipHours, appearanceThreshold: settings.appearanceThreshold },
            });
            const at = Date.now();
            const fresh = raw
                .filter(
                    (signal) => signal.kind !== 'scene.ended' || !record.signals.some((s) => s.kind === 'scene.ended'),
                )
                .map((signal) => this.toSignal(signal, index, chatId, at));
            if (!fresh.length) return { changed: false, result: null };
            record.trace.push(...trace);
            record.signals.push(...fresh);
            return { changed: true, result: { record, signals: fresh } };
        });
        if (!added || generation !== this.generation) return;
        await this.emitRecord(added.record, chatId, true, added.signals);
    }

    /**
     * 'fact.new' put on the bus for a committed turn without a `data.source`: stored with the turn for the revision.
     * Signals a consumer module marks with its source ('revision', 'living', …) are its own results, never pending.
     */
    private capture(signal: Signal): void {
        if (this.emittedByUs.has(signal) || !EXTERNAL_KINDS.has(signal.kind)) return;
        const source = signal.data?.source;
        if (source !== undefined && source !== null) return;
        if (!this.app.leader.isLeader() || typeof signal.messageIndex !== 'number') return;
        const chatId = this.app.host.chatId();
        if (!chatId || (signal.chatId !== null && signal.chatId !== chatId)) return;
        const index = signal.messageIndex;
        const copy = JSON.parse(JSON.stringify(signal)) as Signal;
        if (this.peek()?.records.some((record) => record.index === index)) {
            this.schedule(() => this.attach(index, copy));
            return;
        }
        const list = this.external.get(index) ?? [];
        list.push(copy);
        this.external.set(index, list);
    }

    private async attach(index: number, signal: Signal): Promise<void> {
        await this.mutate((doc) => {
            const record = doc.records.find((item) => item.index === index);
            if (!record) return { changed: false, result: undefined };
            record.extra = [...(record.extra ?? []), signal];
            return { changed: true, result: undefined };
        });
    }

    /* ---------------------------------------------------------------- invalidation */

    private async invalidate(index: number, reason: 'swiped' | 'deleted' | 'edited'): Promise<void> {
        if (reason === 'edited' && this.chat()[index]?.is_user) return;
        await this.load();
        // ST reports a deletion with the new chat length and shifts later messages: the full stamp check finds it.
        await this.pass({ mode: 'replay', from: reason === 'deleted' ? undefined : index });
    }

    /* ---------------------------------------------------------------- API */

    pending(): Signal[] {
        const doc = this.peek();
        if (!doc) {
            void this.load();
            return [];
        }
        return structuredClone(pendingSignals(doc));
    }

    async consume(upToMessageIndex: number): Promise<void> {
        if (!Number.isFinite(upToMessageIndex)) return;
        if (!this.app.leader.isLeader()) {
            this.log.debug('not the leader tab: signals are consumed by the leader');
            return;
        }
        await this.mutate((doc) => {
            if (upToMessageIndex <= doc.consumedUpTo) return { changed: false, result: undefined };
            doc.consumedUpTo = upToMessageIndex;
            return { changed: true, result: undefined };
        });
    }

    last(): SignalBatch | null {
        const chatId = this.app.host.chatId();
        if (this.lastBatch && this.lastBatch.chatId === chatId) return structuredClone(this.lastBatch.batch);
        const record = this.peek()?.records.at(-1);
        if (!record) return null;
        return { messageIndex: record.index, signals: structuredClone(record.signals), folded: record.folded };
    }

    messagesSinceRevision(): number {
        const doc = this.peek();
        if (!doc) {
            void this.load();
            return 0;
        }
        return doc.initialized ? messagesSince(doc, this.chat()) : 0;
    }

    onBatch(listener: (batch: SignalBatch) => void): Unsubscribe {
        this.batchListeners.add(listener);
        return () => this.batchListeners.delete(listener);
    }

    /** Last revision point (pult). */
    consumedUpTo(): number {
        return this.peek()?.consumedUpTo ?? -1;
    }
}
