// M28 «Паспорта в лорбуках» service (plan M28, §2.1, P2, P13, §16): the LorePassportsApi.
// - Storage (io.ts): Maestro and canon books keep the passport in the entry, base books in the bookRoles sidecar,
//   BunnyMo books are refused. Every write is journaled with undo: entry writes through the LoreStore are journaled by
//   the store itself (whole-entry undo); the others get a 'lore-passport' record that puts back the previous passport.
// - Generation: NAI Studio's generator when its API offers one (adapter `generatePassport`, NAI Studio 0.12.0+), else
//   the cheap background model as a task (kind 'lorePassports.generate'; leader tab, open chat, never during a
//   generation, daily cap) with NAI Studio's schema; the answer is cleaned and validated before it is saved. A passport
//   made by hand is never replaced without the user's confirmation.
// - Scene (scene.ts): what NAI Studio receives through the passport provider.
import { ENTRY_TYPES, readTypedMeta } from '../../domain/entry-types';
import { sameValue } from '../../domain/lore-form-fields';
import {
    entryDisplayName,
    fixPassport,
    isPassportEmpty,
    isPassportKind,
    isUserMade,
    joinTags,
    makePassportRecord,
    normalizePassport,
    passportKindOf,
    passportOfEntry,
    readPassportRecord,
} from '../../domain/lore-passport';
import type { PassportKind, PassportRecord, PassportSource } from '../../domain/lore-passport';
import {
    CONTENT_LIMIT,
    PASSPORT_SCHEMA,
    PASSPORT_SCHEMA_NAME,
    contentLanguage,
    parseGeneratedPassport,
    passportGenMessages,
} from '../../domain/lore-passport-gen';
import { entryContentHash } from '../../domain/roles-meta';
import type { App, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { LoreJournalApi } from '../loreJournal/api';
import type { WorldModelApi } from '../world/api';
import type {
    GeneratorState,
    LorePassport,
    LorePassportsApi,
    PassportPlace,
    ProposedPassport,
    ScenePassportsSent,
} from './api';
import { PassportError, PassportIo, isDict } from './io';
import type { Dict } from './io';
import { ScenePassports, naiHooks } from './scene';
import type { GeneratePassport, IndexedBook, SceneItem, ScenePassportsSettings } from './scene';

export const LORE_PASSPORTS_KEY = 'lorePassports';
export const LORE_PASSPORTS_ID = 'M28';
export const GENERATE_TASK = 'lorePassports.generate';
export const PASSPORT_TARGET = 'lore-passport';
const MAX_TOKENS = 700;
const WAIT_MS = 4 * 60_000;
const TASK_TTL_MS = 10 * 60_000;

export type LorePassportsSettings = ScenePassportsSettings;

export function defaultLorePassportsSettings(): LorePassportsSettings {
    return { provider: true, lastMessages: 2, maxPerScene: 12 };
}

/** One entry as the service works on it. */
interface Target {
    world: string;
    uid: number;
    entry: Dict;
    place: 'entry' | 'sidecar';
    record: PassportRecord | null;
    name: string;
    /** NAI kind from the entry's type (typed entries). */
    kind: PassportKind | null;
    /** English label of the entry's type ('Character', 'Place'), when typed. */
    typeLabel?: string;
}

interface Pending {
    resolve(value: Dict | null): void;
    reject(error: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

export interface BatchState {
    total: number;
    done: number;
    failed: number;
    skipped: number;
    running: boolean;
    lastError?: string;
}

function newId(): string {
    return `lp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export class LorePassportsService implements LorePassportsApi {
    readonly io: PassportIo;
    readonly scene: ScenePassports;
    private readonly listeners = new Set<() => void>();
    private readonly indexListeners = new Set<() => void>();
    private readonly pending = new Map<string, Pending>();
    private readonly inflight = new Map<string, Promise<Dict | null>>();
    private batchState: BatchState | null = null;
    private stopBatch = false;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        settings: () => LorePassportsSettings,
    ) {
        this.io = new PassportIo(app, log);
        this.scene = new ScenePassports(app, log, this.io, settings, () => this.emitIndex());
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /** Registrations of the module (the journal's undo handler is permanent, like every journal target). */
    install(): Unsubscribe[] {
        this.app.journal.registerUndo(PASSPORT_TARGET, (change) => this.undo(change));
        const offs: Unsubscribe[] = [this.app.tasks.register(GENERATE_TASK, (payload) => this.runTask(payload))];
        const event = this.app.host.events.name('WORLDINFO_UPDATED');
        if (event) {
            offs.push(
                this.app.host.events.on(event, (name) => {
                    this.scene.invalidate(typeof name === 'string' ? name : null);
                }),
            );
        }
        const roles = this.io.roles();
        if (roles) offs.push(roles.onChange(() => this.scene.invalidateSidecars()));
        offs.push(
            this.app.bus.on('chat:changed', () => {
                this.scene.resetSent();
                this.scene.syncProvider();
                this.emitIndex();
            }),
            this.app.bus.on('reply:ready', () => {
                this.scene.syncProvider();
                // Read the books of this turn now, not when NAI Studio asks (it waits a few seconds at most).
                void this.scene
                    .ensure(this.scene.booksOf(this.scene.keys()))
                    .catch((error: unknown) => this.log.debug('scene books', error));
            }),
            () => this.dispose(),
        );
        this.scene.syncProvider();
        return offs;
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.stopBatch = true;
        this.scene.dispose();
        for (const [id, pending] of this.pending) {
            clearTimeout(pending.timer);
            pending.reject(new PassportError(this.t('m28.gen.error.off'), 'off'));
            this.pending.delete(id);
        }
        this.listeners.clear();
        this.indexListeners.clear();
    }

    /* ---------------------------------------------------------------- events */

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Index or scene answer changed (pult), besides every passport change. */
    onIndex(listener: () => void): Unsubscribe {
        this.indexListeners.add(listener);
        return () => this.indexListeners.delete(listener);
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('lore passports listener failed', error);
            }
        }
        this.emitIndex();
    }

    private emitIndex(): void {
        for (const listener of [...this.indexListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('lore passports listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- reading */

    private error(code: string, params?: Record<string, string | number>): PassportError {
        return new PassportError(this.t(`m28.error.${code}`, params), code);
    }

    /** The entry with where its passport lives; throws for missing entries, BunnyMo books and a missing registry. */
    private async target(world: string, uid: number): Promise<Target> {
        const entry = await this.io.loadEntry(world, uid);
        if (!entry) throw this.error('missing', { book: world, uid });
        const place = this.io.place(world, entry);
        if (place === 'bunnymo' || place === 'noRegistry') throw this.error(place);
        let record: PassportRecord | null;
        let typedSource: unknown;
        if (place === 'entry') {
            record = passportOfEntry(entry);
            typedSource = isDict(entry.extensions) ? entry.extensions.maestro : undefined;
        } else {
            const meta = await this.io.readSidecar(world, uid);
            record = readPassportRecord(meta?.passport);
            typedSource = meta;
        }
        const typed = readTypedMeta(typedSource);
        const target: Target = {
            world,
            uid,
            entry,
            place,
            record,
            name: entryDisplayName(entry, typed?.fields.name),
            kind: passportKindOf(typed?.type),
        };
        if (typed) target.typeLabel = ENTRY_TYPES[typed.type].label;
        return target;
    }

    private view(target: Target, record: PassportRecord): LorePassport {
        const view: LorePassport = {
            passport: JSON.parse(JSON.stringify(record.passport)) as Dict,
            storage: target.place,
            updatedAt: record.updatedAt,
        };
        if (record.contentHash !== undefined) view.contentHash = record.contentHash;
        if (record.generatedBy !== undefined) view.generatedBy = record.generatedBy;
        return view;
    }

    async get(world: string, uid: number): Promise<LorePassport | null> {
        let target: Target;
        try {
            target = await this.target(world, uid);
        } catch {
            return null;
        }
        return target.record ? this.view(target, target.record) : null;
    }

    async storageOf(world: string): Promise<PassportPlace> {
        return this.io.place(world);
    }

    /* ---------------------------------------------------------------- writing */

    async set(
        world: string,
        uid: number,
        passport: Record<string, unknown>,
        by: PassportSource = 'user',
    ): Promise<void> {
        const target = await this.target(world, uid);
        await this.save(target, passport, by);
    }

    private async save(target: Target, passport: Dict, by: PassportSource): Promise<PassportRecord> {
        const normal = normalizePassport(passport, { kind: target.kind ?? undefined, name: target.name });
        if (!normal) throw this.error('invalid');
        const record = makePassportRecord(normal, by, entryContentHash(target.entry), Date.now());
        const key = by === 'user' ? 'm28.journal.set' : 'm28.journal.generated';
        await this.write(
            target,
            record,
            this.t(key, { entry: target.name, book: target.world, by: this.t(`m28.by.${by}`) }),
        );
        return record;
    }

    async remove(world: string, uid: number): Promise<void> {
        const target = await this.target(world, uid);
        if (!target.record) return;
        await this.write(target, null, this.t('m28.journal.remove', { entry: target.name, book: target.world }));
    }

    /** Writes (null: removes) the passport where it lives; journals unless `journal` is false (undo). */
    private async write(target: Target, record: PassportRecord | null, summary: string, journal = true): Promise<void> {
        let way: 'store' | 'direct' | 'sidecar';
        if (target.place === 'entry') {
            way = await this.io.writeEntry(target.world, target.uid, record, summary);
        } else {
            await this.io.writeSidecar(target.world, target.uid, record);
            way = 'sidecar';
        }
        this.scene.update(target.world, target.uid, record);
        if (journal && way !== 'store') {
            try {
                await this.app.journal.record({
                    module: LORE_PASSPORTS_ID,
                    kind: record ? 'lorePassports.set' : 'lorePassports.remove',
                    summary,
                    changes: [
                        {
                            target: PASSPORT_TARGET,
                            ref: { world: target.world, uid: target.uid, storage: target.place },
                            before: target.record,
                            after: record,
                        },
                    ],
                });
            } catch (error) {
                this.log.warn('passport change was not journaled', error);
            }
        }
        this.emit();
    }

    /** Puts the previous passport back while the current one is still the one the record made. */
    private async undo(change: JournalChange): Promise<boolean> {
        const world = change.ref.world;
        const uid = change.ref.uid;
        if (typeof world !== 'string' || typeof uid !== 'number') return false;
        let target: Target;
        try {
            target = await this.target(world, uid);
        } catch {
            return false;
        }
        const after = change.after === null ? null : readPassportRecord(change.after);
        if (!sameValue(target.record, after)) return false;
        const before = change.before === null ? null : readPassportRecord(change.before);
        await this.write(target, before, '', false);
        return true;
    }

    /* ---------------------------------------------------------------- generation */

    /** NAI Studio's generator through the adapter (NAI Studio 0.12.0+), when present. */
    private naiGenerator(): GeneratePassport | undefined {
        const nai = naiHooks(this.app);
        if (typeof nai?.generatePassport !== 'function') return undefined;
        try {
            if (typeof nai.api === 'function' && !nai.api()) return undefined;
        } catch {
            return undefined;
        }
        return nai.generatePassport.bind(nai);
    }

    /** Why the background model cannot run in this tab now (null when it can). */
    private modelBlocker(): Extract<GeneratorState, { kind: 'none' }>['reason'] | null {
        const host = this.app.host;
        if (host.isGroupChat()) return 'groupChat';
        if (!host.chatId()) return 'noChat';
        if (!this.app.leader.isLeader()) return 'notLeader';
        if (!this.app.llm.available(GENERATE_TASK)) return 'noProfile';
        if (this.app.cost.backgroundCapReached()) return 'cap';
        return null;
    }

    generator(): GeneratorState {
        if (this.naiGenerator()) return { kind: 'nai' };
        const reason = this.modelBlocker();
        return reason ? { kind: 'none', reason } : { kind: 'model' };
    }

    /** NAI kind to generate: the entry's type, else the world model's entity, else the current passport's. */
    private kindFor(target: Target): PassportKind | null {
        if (target.kind) return target.kind;
        const world = this.app.modules.api<WorldModelApi>('world');
        try {
            const ref = `${target.world}#${target.uid}`;
            const entity = world
                ?.entities()
                .find((item) =>
                    item.sources.some(
                        (source) =>
                            (source.kind === 'lore.entry' || source.kind === 'canon.entry') &&
                            (source.ref === ref || (source.world === target.world && source.uid === target.uid)),
                    ),
                );
            const kind = passportKindOf(entity?.kind);
            if (kind) return kind;
        } catch (error) {
            this.log.debug('world model lookup failed', error);
        }
        const current = target.record?.passport.kind;
        return isPassportKind(current) ? current : null;
    }

    async kindOf(world: string, uid: number): Promise<PassportKind | null> {
        return this.kindFor(await this.target(world, uid));
    }

    async propose(world: string, uid: number): Promise<ProposedPassport | null> {
        const target = await this.target(world, uid);
        return this.proposeFor(target);
    }

    private async proposeFor(target: Target): Promise<ProposedPassport | null> {
        const content = str(target.entry.content);
        if (!content.trim()) throw this.error('emptyEntry');
        const kind = this.kindFor(target);
        const nai = this.naiGenerator();
        let naiFailed = false;
        if (nai) {
            try {
                const result = await nai({
                    name: target.name,
                    kind: kind === 'scenario' || !kind ? 'world' : kind,
                    description: content.slice(0, CONTENT_LIMIT),
                    language: contentLanguage(content),
                });
                const passport = this.fromNai(result, target, kind);
                if (passport) return { passport, by: 'nai' };
            } catch (error) {
                this.log.warn('NAI Studio passport generator failed', error);
            }
            naiFailed = true;
        }
        const blocker = this.modelBlocker();
        if (blocker) {
            if (naiFailed) throw new PassportError(this.t('m28.gen.error.nai'), 'nai');
            throw new PassportError(this.t(`m28.gen.${blocker}`), blocker);
        }
        const passport = await this.runModel(target, kind);
        return passport ? { passport, by: 'model' } : null;
    }

    /** NAI Studio's passport as ours: its own id dropped, tags fixed (lower case, anatomy into the NSFW layer). */
    private fromNai(result: unknown, target: Target, kind: PassportKind | null): Dict | null {
        const normal = normalizePassport(result, { kind: kind ?? undefined, name: target.name });
        if (!normal) return null;
        delete normal.id;
        if (kind && kind !== normal.kind) normal.kind = kind;
        // Only characters are drawn from slots: anything else keeps its look in the tags.
        if (normal.kind !== 'character' && !String(normal.tags ?? '').trim()) {
            normal.tags = joinTags(...Object.values(normal.slots as Record<string, string>));
        }
        const fixed = fixPassport(normal);
        return isPassportEmpty(fixed) ? null : fixed;
    }

    async generate(world: string, uid: number): Promise<LorePassport | null> {
        const before = await this.target(world, uid);
        let confirmed = false;
        if (isUserMade(before.record)) {
            confirmed = await this.confirmOverwrite(before);
            if (!confirmed) return null;
        }
        const proposed = await this.proposeFor(before);
        if (!proposed) return null;
        const now = await this.target(world, uid);
        // Made by hand while the model was writing: ask (again) before replacing it.
        if (isUserMade(now.record) && !(confirmed && sameValue(now.record, before.record))) {
            if (!(await this.confirmOverwrite(now))) return null;
        }
        const record = await this.save(now, proposed.passport, proposed.by);
        return this.view(now, record);
    }

    private confirmOverwrite(target: Target): Promise<boolean> {
        return this.app.ui.confirm(this.t('m28.overwrite.title'), this.t('m28.overwrite.body', { entry: target.name }));
    }

    /** Enqueues the background model and waits for its passport (shared by concurrent requests for one entry). */
    private runModel(target: Target, kind: PassportKind | null): Promise<Dict | null> {
        const key = `${target.world}#${target.uid}`;
        const running = this.inflight.get(key);
        if (running) return running;
        const request = this.enqueueAndWait(target, kind).finally(() => this.inflight.delete(key));
        this.inflight.set(key, request);
        return request;
    }

    private async enqueueAndWait(target: Target, kind: PassportKind | null): Promise<Dict | null> {
        const requestId = newId();
        const done = new Promise<Dict | null>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                reject(new PassportError(this.t('m28.gen.error.timeout'), 'timeout'));
            }, WAIT_MS);
            this.pending.set(requestId, { resolve, reject, timer });
        });
        try {
            await this.app.tasks.enqueue({
                kind: GENERATE_TASK,
                dedupeKey: `${target.world}#${target.uid}`,
                payload: { world: target.world, uid: target.uid, requestId, kind },
                ttlMs: TASK_TTL_MS,
                priority: 1,
            });
        } catch (error) {
            const pending = this.pending.get(requestId);
            if (pending) clearTimeout(pending.timer);
            this.pending.delete(requestId);
            throw new PassportError(error instanceof Error ? error.message : String(error), 'enqueue');
        }
        this.app.tasks.kick();
        return done;
    }

    private settle(requestId: unknown, value: Dict | null | PassportError): boolean {
        if (typeof requestId !== 'string') return false;
        const pending = this.pending.get(requestId);
        if (!pending) return false;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        if (value instanceof PassportError) pending.reject(value);
        else pending.resolve(value);
        return true;
    }

    /**
     * Task runner: never throws (a bad answer is not worth the queue's retries; transport retries are the client's).
     * A task left from before a reload (nobody waits) saves its passport only where the entry still has none.
     */
    private async runTask(payload: Record<string, unknown>): Promise<void> {
        const world = str(payload.world);
        const uid = typeof payload.uid === 'number' ? payload.uid : NaN;
        const fail = (code: string, params?: Record<string, string | number>) => {
            this.settle(payload.requestId, new PassportError(this.t(`m28.gen.error.${code}`, params), code));
        };
        let target: Target;
        try {
            target = await this.target(world, uid);
        } catch (error) {
            this.settle(
                payload.requestId,
                error instanceof PassportError ? error : this.error('missing', { book: world, uid }),
            );
            return;
        }
        const kind = isPassportKind(payload.kind) ? payload.kind : this.kindFor(target);
        const typeLabel = target.typeLabel;
        const response = await this.app.llm.request<unknown>({
            task: GENERATE_TASK,
            messages: passportGenMessages({
                name: target.name,
                kind,
                ...(typeLabel ? { typeLabel } : {}),
                keys: Array.isArray(target.entry.key)
                    ? target.entry.key.filter((key): key is string => typeof key === 'string')
                    : [],
                content: str(target.entry.content),
            }),
            maxTokens: MAX_TOKENS,
            temperature: 0.2,
            schema: { name: PASSPORT_SCHEMA_NAME, schema: PASSPORT_SCHEMA },
        });
        if (!response.ok) {
            if (response.refusal) fail('refusal');
            else if (response.error === 'parse') fail('parse');
            else fail('failed', { error: response.error ?? '?' });
            return;
        }
        const passport = parseGeneratedPassport(response.data ?? response.text ?? null, { name: target.name, kind });
        if (!passport) {
            fail('empty');
            return;
        }
        if (this.settle(payload.requestId, passport)) return;
        if (target.record) return;
        try {
            await this.save(target, passport, 'model');
        } catch (error) {
            this.log.warn('generated passport was not saved', error);
        }
    }

    /* ---------------------------------------------------------------- batch */

    batch(): BatchState | null {
        return this.batchState ? { ...this.batchState } : null;
    }

    stop(): void {
        this.stopBatch = true;
    }

    /**
     * Generates passports for entries that have none, one after another (the caller confirmed the cost). An entry
     * that got a passport meanwhile is skipped; errors are counted, the first stops nothing.
     */
    async generateMissing(items: readonly { world: string; uid: number }[]): Promise<BatchState> {
        if (this.batchState?.running) return { ...this.batchState };
        const state: BatchState = { total: items.length, done: 0, failed: 0, skipped: 0, running: true };
        this.batchState = state;
        this.stopBatch = false;
        this.emitIndex();
        for (const item of items) {
            if (this.stopBatch || this.disposed) break;
            try {
                const target = await this.target(item.world, item.uid);
                if (target.record) {
                    state.skipped++;
                } else {
                    const proposed = await this.proposeFor(target);
                    const fresh = await this.target(item.world, item.uid);
                    if (!proposed || fresh.record) state.skipped++;
                    else {
                        await this.save(fresh, proposed.passport, proposed.by);
                        state.done++;
                    }
                }
            } catch (error) {
                state.failed++;
                state.lastError = error instanceof Error ? error.message : String(error);
                this.log.debug('batch passport failed', error);
            }
            this.emitIndex();
        }
        state.running = false;
        this.emitIndex();
        return { ...state };
    }

    /* ---------------------------------------------------------------- catalog (pult) */

    /** Books active now: the Lore Studio's bindings (else the books of recent turns) and the chat canon. */
    async activeBooks(): Promise<string[]> {
        const names: string[] = [];
        const store = this.io.store();
        let bound = false;
        if (store && typeof store.bindings === 'function') {
            try {
                const bindings = await store.bindings();
                names.push(...bindings.global, ...bindings.character.extra);
                for (const name of [bindings.character.primary, bindings.chat, bindings.persona]) {
                    if (name) names.push(name);
                }
                bound = true;
            } catch (error) {
                this.log.debug('lorebook bindings unavailable', error);
            }
        }
        if (!bound) {
            const journal = this.app.modules.api<LoreJournalApi>('loreJournal');
            try {
                for (const record of journal?.turns(20) ?? []) {
                    for (const activation of record.activations) names.push(activation.world);
                }
            } catch (error) {
                this.log.debug('lore journal unavailable', error);
            }
        }
        const canon = this.io.canonBook();
        if (canon) names.push(canon);
        return [...new Set(names.filter((name) => typeof name === 'string' && name))];
    }

    /** The active books, read (BunnyMo books and base books without the registry come back without entries). */
    async catalog(): Promise<IndexedBook[]> {
        const names = await this.activeBooks();
        await this.scene.ensure(names);
        return names.map((name) => this.scene.book(name)).filter((book): book is IndexedBook => !!book);
    }

    /* ---------------------------------------------------------------- scene */

    forScene(): SceneItem[] {
        return this.scene.forScene();
    }

    lastSent(): ScenePassportsSent | null {
        return this.scene.lastSent();
    }
}
