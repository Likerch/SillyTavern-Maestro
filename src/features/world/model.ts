// M7 «Модель мира» (plan §4.2, M7; dev-plan 3.1): the read model of the chat's world. Entities are assembled from the
// cheap sources on demand and after committed turns, and from lorebooks lazily (first entities() call or rebuild()),
// never on the send path (P15): work triggered while a generation runs waits for it to end. Lore results are kept
// until WORLDINFO_UPDATED of a book that was read, a change of the active books, roles or canon; DES-RU's
// onNamesChanged and the place registry trigger a cheap rebuild. Merge candidates become one Inbox card each
// (kind 'world.merge'), proposed by the leader tab only; decisions live in the chat document 'world'.
import { adaptersOf } from '../../adapters';
import type { DesRuApi } from '../../adapters';
import type { DesCharacter, DesTrackerSnapshot } from '../../domain/des-tracker';
import { lastCommittedIndex } from '../../domain/relations-history';
import { canonFact, desFacts, storyTimeOf } from '../../domain/world-facts';
import { assembleWorld, entityById, resolveName } from '../../domain/world-identity';
import type { WorldBuild } from '../../domain/world-identity';
import { buildMentionMatcher, findMentions, mentionNeedles, normalizeName, pairKey } from '../../domain/world-names';
import type { MentionMatcher } from '../../domain/world-names';
import type { App, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { CanonApi } from '../canon/api';
import type { PlacesApi } from '../places/api';
import type { Entity, EntityKind, Fact, MergeCandidate, WorldModelApi } from './api';
import { WorldSources } from './sources';
import type { LoreSources } from './sources';
import { addPair, aliasTarget, putAlias } from './store';
import type { WorldDoc, WorldStore } from './store';

export const WORLD_ID = 'M7w';
export const WORLD_KEY = 'world';
export const MERGE_KIND = 'world.merge';
export const ALIAS_TARGET = 'world-alias';
export const MERGE_TARGET = 'world-merge';
export const SEPARATE_TARGET = 'world-separate';

/** Delay of the cheap rebuild after a committed turn (the send continues meanwhile). */
const COMMIT_DELAY_MS = 1500;
const CHANGE_DELAY_MS = 300;
/** How far back the DES tracker is read for each character's latest data. */
const DES_LOOKBACK = 150;
/** New Inbox cards per build (the rest wait for the next build or the World tab). */
const MAX_NEW_CARDS = 3;

const EMPTY_BUILD: WorldBuild = {
    entities: [],
    byId: new Map(),
    index: new Map(),
    candidates: [],
    redirects: new Map(),
};

interface DesLatest {
    character: DesCharacter;
    messageIndex: number;
    storyTime?: string;
}

interface MergePayload {
    a: string;
    b: string;
}

function mergePayload(value: unknown): MergePayload | null {
    if (!value || typeof value !== 'object') return null;
    const { a, b } = value as Record<string, unknown>;
    return typeof a === 'string' && typeof b === 'string' && a && b ? { a, b } : null;
}

function copyEntity(entity: Entity): Entity {
    return {
        ...entity,
        aliases: [...entity.aliases],
        forms: [...entity.forms],
        sources: entity.sources.map((source) => ({ ...source })),
    };
}

/** Index of the assistant message committed last (P14), -1 if none. */
export function committedIndex(chat: readonly STChatMessage[]): number {
    return lastCommittedIndex(chat);
}

export class WorldModel {
    private build: WorldBuild = EMPTY_BUILD;
    private built = false;
    private lore: LoreSources | null = null;
    private loreStale = true;
    private loreWanted = false;
    private loreLoading: Promise<void> | null = null;
    private matcher: MentionMatcher | null = null;
    private generation = 0;
    private committed = -1;
    private snapshot: DesTrackerSnapshot | null = null;
    private desLatest = new Map<string, DesLatest>();
    private desFresh = false;
    private readonly formsCache = new Map<string, string[]>();
    private formsApi: DesRuApi | undefined;
    private readonly listeners = new Set<() => void>();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pending = { cheap: false, lore: false };
    private waitingForIdle = false;
    private proposing = false;
    private disposed = false;
    private readonly subscriptions = new Map<string, { api: unknown; off: Unsubscribe }>();
    /** Inbox cards of kind world.merge seen last time (id → pair), to notice rejections. */
    private knownCards = new Map<string, MergePayload>();
    private rejectedSeen = 0;
    private readonly appliedPairs = new Set<string>();
    readonly sources: WorldSources;

    constructor(
        private readonly app: App,
        readonly store: WorldStore,
        private readonly log: Logger,
    ) {
        this.sources = new WorldSources(app, log);
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(): Unsubscribe[] {
        const { app } = this;
        const offs: Unsubscribe[] = [];
        const on = (key: string, handler: (...args: unknown[]) => unknown) => {
            const name = app.host.events.name(key);
            if (name) offs.push(app.host.events.on(name, handler));
        };
        offs.push(app.bus.on('chat:changed', () => this.chatChanged()));
        offs.push(
            app.bus.on('turn:committed', ({ messageIndex }) => {
                // P15: only bookkeeping here; the rebuild runs later and after the generation.
                this.committed = Math.max(this.committed, messageIndex);
                this.desFresh = false;
                this.request({ cheap: true }, COMMIT_DELAY_MS);
            }),
        );
        offs.push(
            app.bus.on('message:invalidated', ({ messageIndex }) => {
                // A swipe of the reply in progress changes nothing committed.
                const previous = this.committed;
                this.committed = committedIndex(app.host.ctx().chat ?? []);
                if (messageIndex > previous && previous === this.committed) return;
                this.desFresh = false;
                this.request({ cheap: true }, COMMIT_DELAY_MS);
            }),
        );
        offs.push(
            app.bus.on('generation:ended', () => {
                if (!this.waitingForIdle) return;
                this.waitingForIdle = false;
                this.arm(CHANGE_DELAY_MS);
            }),
        );
        on('WORLDINFO_UPDATED', (name) => {
            if (typeof name !== 'string' || !this.lore) return;
            if (this.lore.books.has(name) || name === this.lore.canonBook) this.loreChanged();
        });
        on('WORLDINFO_SETTINGS_UPDATED', () => this.loreChanged());
        offs.push(
            app.inbox.onChange(() => {
                setTimeout(() => this.checkRejections(), 0);
            }),
        );
        offs.push(this.registerApplier());
        app.journal.registerUndo(ALIAS_TARGET, (change) => this.undoAlias(change));
        app.journal.registerUndo(MERGE_TARGET, (change) => this.undoMerge(change));
        app.journal.registerUndo(SEPARATE_TARGET, (change) => this.undoSeparate(change));
        offs.push(() => this.dispose());
        return offs;
    }

    /** First load for the chat open when the module starts. */
    start(): void {
        this.committed = committedIndex(this.app.host.ctx().chat ?? []);
        this.rejectedSeen = this.rejectedCount();
        setTimeout(() => this.checkRejections(), 0);
        void this.store.load().then(() => {
            if (this.built) this.request({ cheap: true }, 0);
        });
    }

    private dispose(): void {
        this.disposed = true;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        for (const { off } of this.subscriptions.values()) off();
        this.subscriptions.clear();
        this.listeners.clear();
    }

    private chatChanged(): void {
        this.generation++;
        this.build = EMPTY_BUILD;
        this.built = false;
        this.lore = null;
        this.loreStale = true;
        this.loreWanted = false;
        this.loreLoading = null;
        this.matcher = null;
        this.snapshot = null;
        this.desLatest = new Map();
        this.desFresh = false;
        this.pending = { cheap: false, lore: false };
        this.knownCards = new Map();
        this.appliedPairs.clear();
        this.committed = committedIndex(this.app.host.ctx().chat ?? []);
        this.store.reset();
        this.emit();
        void this.store.load().then(() => {
            if (this.built) this.request({ cheap: true }, 0);
        });
    }

    private loreChanged(): void {
        this.loreStale = true;
        if (this.loreWanted) this.request({ lore: true }, CHANGE_DELAY_MS);
    }

    /* ---------------------------------------------------------------- scheduling (off the send path) */

    private request(what: { cheap?: boolean; lore?: boolean }, delay: number): void {
        if (this.disposed) return;
        if (what.cheap) this.pending.cheap = true;
        if (what.lore) this.pending.lore = true;
        this.arm(delay);
    }

    private arm(delay: number): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, delay);
    }

    private generating(): boolean {
        return this.app.turn.current() !== null;
    }

    private async flush(): Promise<void> {
        if (this.disposed) return;
        if (this.generating()) {
            this.waitingForIdle = true;
            return;
        }
        const { cheap, lore } = this.pending;
        this.pending = { cheap: false, lore: false };
        if (lore && this.loreWanted) {
            await this.loadLore();
            return;
        }
        if (cheap && this.built) this.rebuildNow();
    }

    /* ---------------------------------------------------------------- building */

    private forms = (name: string): string[] => {
        let api: DesRuApi | undefined;
        try {
            api = adaptersOf(this.app).desru.api();
        } catch {
            api = undefined;
        }
        if (api !== this.formsApi) {
            this.formsApi = api;
            this.formsCache.clear();
        }
        if (!api) return [];
        const key = name.trim();
        const cached = this.formsCache.get(key);
        if (cached) return cached;
        let forms: string[] = [];
        try {
            const raw = api.nameForms(key);
            forms = Array.isArray(raw) ? raw.filter((form): form is string => typeof form === 'string') : [];
        } catch (error) {
            this.log.debug('DES-RU nameForms failed', error);
        }
        this.formsCache.set(key, forms);
        return forms;
    };

    /** Keeps one subscription per neighbour API instance (APIs appear late or are replaced on re-enable). */
    private subscribe(key: string, api: unknown, attach: () => Unsubscribe): void {
        const known = this.subscriptions.get(key);
        if (known?.api === api) return;
        known?.off();
        this.subscriptions.delete(key);
        if (!api) return;
        try {
            this.subscriptions.set(key, { api, off: attach() });
        } catch (error) {
            this.log.debug(`cannot listen to ${key}`, error);
        }
    }

    private syncSubscriptions(): void {
        let desru: DesRuApi | undefined;
        try {
            desru = adaptersOf(this.app).desru.api();
        } catch {
            desru = undefined;
        }
        this.subscribe('desru', desru, () => {
            const off = (desru as DesRuApi).onNamesChanged(() => this.request({ cheap: true }, CHANGE_DELAY_MS));
            return typeof off === 'function' ? off : () => {};
        });
        const nai = adaptersOf(this.app).nai;
        let naiApi: unknown;
        try {
            naiApi = nai.api();
        } catch {
            naiApi = undefined;
        }
        this.subscribe('nai', naiApi, () =>
            nai.on('passportsSaved', () => this.request({ cheap: true }, CHANGE_DELAY_MS)),
        );
        const places = this.app.modules.api<PlacesApi>('places');
        this.subscribe('places', places, () =>
            (places as PlacesApi).onChange(() => this.request({ cheap: true }, CHANGE_DELAY_MS)),
        );
        const roles = this.app.modules.api<BookRolesApi>('bookRoles');
        this.subscribe('bookRoles', roles, () => (roles as BookRolesApi).onChange(() => this.loreChanged()));
        const canon = this.app.modules.api<CanonApi>('canon');
        this.subscribe('canon', canon, () => (canon as CanonApi).onChange(() => this.loreChanged()));
    }

    /**
     * Reads the committed tracker and each character's latest DES data (up to DES_LOOKBACK assistant messages). During
     * a generation (a first build asked for on the send path) only the committed tracker is read; the rest follows.
     */
    private readDes(full: boolean): void {
        const des = adaptersOf(this.app).des;
        const chat = this.app.host.ctx().chat ?? [];
        if (this.committed >= chat.length) this.committed = committedIndex(chat);
        this.desLatest = new Map();
        this.snapshot = null;
        const lookback = full ? DES_LOOKBACK : 1;
        let seen = 0;
        for (let i = Math.min(this.committed, chat.length - 1); i >= 0 && seen < lookback; i--) {
            const message = chat[i];
            if (!message || message.is_user || message.is_system) continue;
            seen++;
            let snapshot: DesTrackerSnapshot | null;
            try {
                snapshot = des.trackerFor(i);
            } catch (error) {
                this.log.debug('DES tracker is not available', error);
                break;
            }
            if (i === this.committed) this.snapshot = snapshot;
            if (!snapshot) continue;
            const storyTime = storyTimeOf(snapshot.infoBox);
            for (const character of snapshot.characters) {
                const key = normalizeName(character.name);
                if (!key || this.desLatest.has(key)) continue;
                const latest: DesLatest = { character, messageIndex: i };
                if (storyTime) latest.storyTime = storyTime;
                this.desLatest.set(key, latest);
            }
        }
        this.desFresh = full;
        if (!full) this.request({ cheap: true }, CHANGE_DELAY_MS);
    }

    /** Synchronous cheap rebuild over the loaded lore (or none). */
    private rebuildNow(): void {
        if (this.disposed) return;
        this.syncSubscriptions();
        if (!this.desFresh) this.readDes(!this.generating());
        const cheap = this.sources.cheap(this.snapshot);
        const doc = this.store.current();
        const lore = this.lore;
        this.build = assembleWorld({
            records: [...cheap.records, ...(lore?.records ?? [])],
            attach: lore?.attach ?? [],
            aliasGroups: cheap.aliasGroups,
            decisions: { aliases: doc.aliases, merged: doc.merged, separated: doc.separated },
            forms: this.forms,
        });
        this.matcher = null;
        this.built = true;
        this.emit();
        if (lore && !this.loreStale) void this.proposeCandidates();
    }

    /** Builds the cheap part now if nothing is built yet; asks for the lorebooks (read later, off the send path). */
    private ensureBuilt(): void {
        if (!this.built) this.rebuildNow();
        this.loreWanted = true;
        if (this.loreStale && !this.loreLoading && !this.pending.lore) this.request({ lore: true }, 0);
    }

    private loadLore(): Promise<void> {
        if (this.loreLoading) return this.loreLoading;
        const startedIn = this.generation;
        const isCurrent = () => startedIn === this.generation && !this.disposed;
        this.loreStale = false;
        const loading = this.sources
            .lore(isCurrent)
            .then((lore) => {
                if (!lore || !isCurrent()) return;
                this.lore = lore;
                this.rebuildNow();
            })
            .catch((error: unknown) => {
                this.loreStale = true;
                this.log.warn('lorebooks could not be read for the world model', error);
            })
            .finally(() => {
                if (this.loreLoading === loading) this.loreLoading = null;
            });
        this.loreLoading = loading;
        return loading;
    }

    /** Resolves when no generation runs (P15: explicit rebuilds wait for the reply to finish). */
    private async idle(): Promise<void> {
        while (this.generating() && !this.disposed) {
            await new Promise<void>((resolve) => {
                const off = this.app.bus.on('generation:ended', () => {
                    off();
                    resolve();
                });
                setTimeout(() => {
                    off();
                    resolve();
                }, 5000);
            });
        }
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('world listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- reading */

    entities(kind?: EntityKind): Entity[] {
        this.ensureBuilt();
        return this.build.entities.filter((entity) => !kind || entity.kind === kind).map(copyEntity);
    }

    get(id: string): Entity | undefined {
        this.ensureBuilt();
        const entity = entityById(this.build, id);
        return entity ? copyEntity(entity) : undefined;
    }

    resolve(name: string, kind?: EntityKind): Entity | undefined {
        this.ensureBuilt();
        const entity = resolveName(this.build, name, kind);
        return entity ? copyEntity(entity) : undefined;
    }

    mentions(text: string): Entity[] {
        this.ensureBuilt();
        if (!this.matcher) {
            const stems = !this.formsApi;
            this.matcher = buildMentionMatcher(
                this.build.entities.map((entity) => ({
                    id: entity.id,
                    needles: mentionNeedles([entity.name, ...entity.aliases], entity.forms, stems),
                })),
            );
        }
        return findMentions(this.matcher, text)
            .map((id) => this.build.byId.get(id))
            .filter((entity): entity is Entity => !!entity)
            .map(copyEntity);
    }

    facts(id: string): Fact[] {
        this.ensureBuilt();
        const entity = entityById(this.build, id);
        if (!entity) return [];
        const facts: Fact[] = [];
        for (const latest of this.desLatest.values()) {
            if (resolveName(this.build, latest.character.name)?.id !== entity.id) continue;
            facts.push(...desFacts(entity.id, latest.character, latest.messageIndex, latest.storyTime));
        }
        const canonRefs = new Set(
            entity.sources.filter((source) => source.kind === 'canon.entry').map((source) => source.ref),
        );
        for (const item of this.lore?.canonItems ?? []) {
            if (!canonRefs.has(`${this.lore?.canonBook}#${item.uid}`)) continue;
            const fact = canonFact(entity.id, item, this.lore?.canonBook ?? '');
            if (fact) facts.push(fact);
        }
        return facts;
    }

    mergeCandidates(): MergeCandidate[] {
        this.ensureBuilt();
        return this.build.candidates.map((candidate) => ({ ...candidate }));
    }

    /** Candidates of the current build without building anything (tab badge). */
    candidateCount(): number {
        return this.build.candidates.length;
    }

    chatAliases(): Record<string, string> {
        return { ...this.store.current().aliases };
    }

    /** When the lorebooks were read for this chat (null: not yet). */
    loreReadAt(): number | null {
        return this.lore && !this.loreStale ? this.lore.at : null;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /* ---------------------------------------------------------------- decisions */

    async rebuild(): Promise<void> {
        await this.idle();
        await this.store.load();
        this.loreWanted = true;
        this.loreStale = true;
        this.desFresh = false;
        await this.loadLore();
        if (!this.lore) this.rebuildNow();
    }

    async setChatAlias(alias: string, entityId: string | null): Promise<void> {
        const name = alias.trim();
        if (!name) throw new Error(this.app.i18n.t('m7w.error.emptyAlias'));
        let target: string | null = null;
        if (entityId !== null) {
            const entity = this.get(entityId);
            if (!entity) throw new Error(this.app.i18n.t('m7w.error.noEntity'));
            target = entity.id;
        }
        await this.store.load();
        const changed = await this.store.mutate((doc) => putAlias(doc, name, target));
        if (changed) this.rebuildNow();
    }

    async merge(keepId: string, mergeId: string): Promise<void> {
        const keep = this.get(keepId);
        const merged = this.get(mergeId);
        if (!keep || !merged) throw new Error(this.app.i18n.t('m7w.error.noEntity'));
        if (keep.id === merged.id) return;
        await this.store.load();
        const changed = await this.store.mutate((doc) => {
            let dirty = false;
            if (doc.merged[merged.id] !== keep.id) {
                doc.merged[merged.id] = keep.id;
                dirty = true;
            }
            if (aliasTarget(doc, merged.name) !== keep.id) dirty = putAlias(doc, merged.name, keep.id) || dirty;
            const key = pairKey(keep.id, merged.id);
            const index = doc.separated.indexOf(key);
            if (index >= 0) {
                doc.separated.splice(index, 1);
                dirty = true;
            }
            return dirty;
        });
        if (changed) this.rebuildNow();
    }

    async separate(aId: string, bId: string): Promise<void> {
        if (!aId || !bId || aId === bId) return;
        const a = this.build.byId.get(aId);
        const b = this.build.byId.get(bId);
        await this.store.load();
        const changed = await this.store.mutate((doc) => this.applySeparation(doc, aId, bId, a?.name, b?.name));
        if (changed) this.rebuildNow();
    }

    /** Separation: the pair is remembered, and a merge between the two (and its alias) is taken back. */
    private applySeparation(doc: WorldDoc, aId: string, bId: string, aName?: string, bName?: string): boolean {
        let dirty = addPair(doc.separated, aId, bId);
        for (const [from, to] of [
            [aId, bId],
            [bId, aId],
        ] as const) {
            if (doc.merged[from] === to) {
                delete doc.merged[from];
                dirty = true;
            }
        }
        const nameOf = (id: string, name?: string) => name ?? id.slice(id.indexOf(':') + 1);
        for (const [name, target] of [
            [nameOf(aId, aName), bId],
            [nameOf(bId, bName), aId],
        ] as const) {
            if (aliasTarget(doc, name) === target) dirty = putAlias(doc, name, null) || dirty;
        }
        return dirty;
    }

    /* ---------------------------------------------------------------- journal (UI actions) */

    async mergeAndRecord(keepId: string, mergeId: string): Promise<void> {
        const keep = this.get(keepId);
        const merged = this.get(mergeId);
        if (!keep || !merged || keep.id === merged.id) return;
        await this.merge(keep.id, merged.id);
        await this.app.journal.record({
            module: WORLD_ID,
            kind: MERGE_KIND,
            summary: this.app.i18n.t('m7w.journal.merge', { a: keep.name, b: merged.name }),
            changes: [this.mergeChange(keep, merged)],
        });
    }

    async separateAndRecord(aId: string, bId: string): Promise<void> {
        const a = this.get(aId);
        const b = this.get(bId);
        await this.separate(aId, bId);
        await this.app.journal.record({
            module: WORLD_ID,
            kind: 'world.separate',
            summary: this.app.i18n.t('m7w.journal.separate', { a: a?.name ?? aId, b: b?.name ?? bId }),
            changes: [{ target: SEPARATE_TARGET, ref: { a: aId, b: bId }, before: false, after: true }],
        });
    }

    async setAliasAndRecord(alias: string, entityId: string | null): Promise<void> {
        const before = aliasTarget(this.store.current(), alias);
        await this.setChatAlias(alias, entityId);
        const after = aliasTarget(this.store.current(), alias);
        if (before === after) return;
        const target = entityId ? this.get(entityId) : undefined;
        await this.app.journal.record({
            module: WORLD_ID,
            kind: 'world.alias',
            summary: target
                ? this.app.i18n.t('m7w.journal.alias', { alias: alias.trim(), name: target.name })
                : this.app.i18n.t('m7w.journal.aliasRemoved', { alias: alias.trim() }),
            changes: [{ target: ALIAS_TARGET, ref: { alias: alias.trim() }, before, after }],
        });
    }

    private mergeChange(keep: Entity, merged: Entity): JournalChange {
        return {
            target: MERGE_TARGET,
            ref: { keep: keep.id, merge: merged.id, alias: merged.name },
            before: null,
            after: keep.id,
        };
    }

    private async undoAlias(change: JournalChange): Promise<boolean> {
        const alias = typeof change.ref.alias === 'string' ? change.ref.alias : '';
        if (!alias) return false;
        const before = typeof change.before === 'string' ? change.before : null;
        await this.store.load();
        await this.store.mutate((doc) => putAlias(doc, alias, before));
        this.rebuildNow();
        return true;
    }

    private async undoMerge(change: JournalChange): Promise<boolean> {
        const keep = typeof change.ref.keep === 'string' ? change.ref.keep : '';
        const merged = typeof change.ref.merge === 'string' ? change.ref.merge : '';
        const alias = typeof change.ref.alias === 'string' ? change.ref.alias : '';
        if (!keep || !merged) return false;
        await this.store.load();
        await this.store.mutate((doc) => {
            let dirty = false;
            if (doc.merged[merged] === keep) {
                delete doc.merged[merged];
                dirty = true;
            }
            if (alias && aliasTarget(doc, alias) === keep) dirty = putAlias(doc, alias, null) || dirty;
            return dirty;
        });
        this.rebuildNow();
        return true;
    }

    private async undoSeparate(change: JournalChange): Promise<boolean> {
        const a = typeof change.ref.a === 'string' ? change.ref.a : '';
        const b = typeof change.ref.b === 'string' ? change.ref.b : '';
        if (!a || !b) return false;
        await this.store.load();
        await this.store.mutate((doc) => {
            const index = doc.separated.indexOf(pairKey(a, b));
            if (index < 0) return false;
            doc.separated.splice(index, 1);
            return true;
        });
        this.rebuildNow();
        return true;
    }

    /* ---------------------------------------------------------------- Inbox */

    private proposal(candidate: MergeCandidate): Proposal<MergePayload> | null {
        const a = this.build.byId.get(candidate.a);
        const b = this.build.byId.get(candidate.b);
        if (!a || !b) return null;
        const t = this.app.i18n.t.bind(this.app.i18n);
        return {
            module: WORLD_ID,
            kind: MERGE_KIND,
            title: t('m7w.merge.title', { a: a.name, b: b.name }),
            description: t(`m7w.reason.${candidate.reason}`, { name: candidate.name ?? b.name, a: a.name, b: b.name }),
            changes: [this.mergeChange(a, b)],
            payload: { a: a.id, b: b.id },
            apply: (payload) => this.applyCard(payload),
            stillValid: async () => this.cardValid({ a: a.id, b: b.id }),
        };
    }

    private async applyCard(payload: unknown): Promise<void> {
        const pair = mergePayload(payload);
        if (!pair) throw new Error(this.app.i18n.t('m7w.error.noEntity'));
        this.appliedPairs.add(pairKey(pair.a, pair.b));
        await this.merge(pair.a, pair.b);
    }

    private cardValid(payload: unknown): boolean {
        const pair = mergePayload(payload);
        if (!pair) return false;
        const a = entityById(this.build, pair.a);
        const b = entityById(this.build, pair.b);
        return !!a && !!b && a.id !== b.id;
    }

    private registerApplier(): Unsubscribe {
        // ST-independent forward compatibility: an Inbox that learns to report rejections (a fourth argument) calls
        // separate() directly; until then checkRejections() infers them.
        const register = this.app.inbox.registerApplier as (
            kind: string,
            apply: (payload: unknown) => Promise<void>,
            stillValid?: (payload: unknown) => Promise<boolean>,
            onReject?: (payload: unknown) => Promise<void>,
        ) => Unsubscribe;
        return register.call(
            this.app.inbox,
            MERGE_KIND,
            (payload) => this.applyCard(payload),
            async (payload) => this.cardValid(payload),
            async (payload) => {
                const pair = mergePayload(payload);
                if (pair) await this.separate(pair.a, pair.b);
            },
        );
    }

    private rejectedCount(): number {
        try {
            return this.app.autonomy.stats().find((stat) => stat.kind === MERGE_KIND)?.rejected ?? 0;
        } catch {
            return 0;
        }
    }

    /**
     * The Inbox reports no rejections to modules: a world.merge card that vanished while the autonomy statistics
     * counted as many new rejections of this kind was rejected (snoozed and expired cards add no rejection).
     */
    private checkRejections(): void {
        if (this.disposed) return;
        const cards = new Map<string, MergePayload>();
        for (const card of this.app.inbox.list()) {
            if (card.kind !== MERGE_KIND) continue;
            const pair = mergePayload(card.payload);
            if (pair) cards.set(card.id, pair);
        }
        const rejected = this.rejectedCount();
        const delta = rejected - this.rejectedSeen;
        this.rejectedSeen = rejected;
        if (delta > 0) {
            const vanished = [...this.knownCards]
                .filter(([id, pair]) => !cards.has(id) && !this.appliedPairs.has(pairKey(pair.a, pair.b)))
                .map(([, pair]) => pair);
            if (vanished.length && vanished.length <= delta) {
                for (const pair of vanished) void this.separate(pair.a, pair.b);
            }
        }
        this.knownCards = cards;
    }

    /** Leader only: one Inbox card per new candidate (at most MAX_NEW_CARDS per build). */
    private async proposeCandidates(): Promise<void> {
        if (this.proposing || !this.app.leader.isLeader() || !this.app.host.chatId()) return;
        this.proposing = true;
        const startedIn = this.generation;
        try {
            const doc = await this.store.load();
            const fresh = this.build.candidates
                .filter((candidate) => {
                    const key = pairKey(candidate.a, candidate.b);
                    return !doc.proposed.includes(key) && !doc.separated.includes(key);
                })
                .slice(0, MAX_NEW_CARDS);
            if (!fresh.length || startedIn !== this.generation) return;
            const marked = await this.store.mutate((next) => {
                let dirty = false;
                for (const candidate of fresh) dirty = addPair(next.proposed, candidate.a, candidate.b) || dirty;
                return dirty;
            });
            if (!marked || startedIn !== this.generation) return;
            for (const candidate of fresh) {
                const proposal = this.proposal(candidate);
                if (!proposal) continue;
                try {
                    await this.app.autonomy.decide(proposal, 'inbox');
                } catch (error) {
                    this.log.warn('merge proposal failed', error);
                }
            }
        } finally {
            this.proposing = false;
        }
    }

    /* ---------------------------------------------------------------- API */

    api(): WorldModelApi {
        return {
            entities: (kind) => this.entities(kind),
            get: (id) => this.get(id),
            resolve: (name, kind) => this.resolve(name, kind),
            mentions: (text) => this.mentions(text),
            facts: (id) => this.facts(id),
            rebuild: () => this.rebuild(),
            chatAliases: () => this.chatAliases(),
            setChatAlias: (alias, entityId) => this.setChatAlias(alias, entityId),
            merge: (keepId, mergeId) => this.merge(keepId, mergeId),
            separate: (aId, bId) => this.separate(aId, bId),
            mergeCandidates: () => this.mergeCandidates(),
            onChange: (listener) => this.onChange(listener),
        };
    }
}
