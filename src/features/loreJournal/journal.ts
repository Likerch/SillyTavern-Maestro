// M1 «Журнал лора»: records which lore went into the prompt on every real turn (plan M1, audit T15).
//
// Capture (send path, cheap): GENERATION_STARTED opens a collector for a real, non-quiet generation (dry runs and
// quiet runs only mark their scans as foreign); WORLDINFO_SCAN_DONE / WORLD_INFO_ACTIVATED feed it identity copies.
// Finalisation (after `reply:ready`, off the send path): recursion sources, token counts, stack tags, storage in
// the chat document 'lore-journal', listeners. Key attribution and dry runs happen only on demand.
import { adaptersOf } from '../../adapters';
import { stableHash } from '../../domain/hash';
import {
    bookReasons,
    catalogFromLists,
    desLinkedBooks,
    emptyJournal,
    ensureJournal,
    addRecord,
    decodeRecords,
    removeRecordsFrom,
    setRecordKeys,
    summarize,
    tagsFor,
} from '../../domain/lore-journal';
import type { CatalogEntry, DesLinks, StoredJournal, TagContext } from '../../domain/lore-journal';
import { buildScanText, findTriggerKey } from '../../domain/lore-match';
import type { Substitute } from '../../domain/lore-match';
import { ScanCollector, assembleRecord, attributeVia, captureEntry, entryId } from '../../domain/lore-scan';
import type { CapturedEntry } from '../../domain/lore-scan';
import type { App, GenerationInfo, Logger, Unsubscribe } from '../../shared/contracts';
import type {
    BookActivationReason,
    LoreContent,
    LoreJournalApi,
    LoreSummary,
    SimulateOptions,
    TurnLoreRecord,
    EntriesTransform,
} from './api';
import {
    cardFields,
    chatForWI,
    globalDepth,
    loadWorldInfo,
    matchGlobals,
    maxPromptTokens,
    scanInjects,
} from './st-scan';
import type { WorldInfoModule } from './st-scan';

export interface LoreJournalSettings {
    /** Turn records kept per chat (older ones stay only in the summary counters). */
    keepTurns: number;
}

export const LORE_DOC_KIND = 'lore-journal';
/** A collector older than this is a lost generation, not the one the reply belongs to. */
const STALE_COLLECTOR_MS = 15 * 60 * 1000;
/**
 * `reply:ready` comes right after the generation ends (GENERATION_ENDED fires from hideStopButton, the render a
 * tick later). A reply long after the end belongs to something else (a failed generation left its scan behind).
 */
export const REPLY_GRACE_MS = 60 * 1000;
/** Generation types whose output is not an assistant message (the impersonated text goes to the input box). */
const NOT_A_TURN = new Set(['quiet', 'impersonate']);
const TOKEN_CACHE_LIMIT = 3000;
const TOKEN_WORKERS = 4;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [];
}

/** Rough tokens when the tokenizer is unavailable (≈3.5 chars per token for mixed RU/EN text). */
export function estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
}

function emptySummary(): LoreSummary {
    return {
        turns: 0,
        heaviestBooks: [],
        heaviestEntries: [],
        alwaysActive: [],
        neverActive: [],
        avgTotalChars: 0,
        avgCanonChars: 0,
    };
}

/** ST's `getCharaFilename`: the avatar file name without its extension (key of `world_info.charLore`). */
function avatarKey(avatar: string): string {
    return avatar.replace(/\.[^/.]+$/, '');
}

interface Simulation {
    collector: ScanCollector;
    deterministic: boolean;
    transform?: EntriesTransform;
    suspended: string[];
}

interface ChatView {
    chatId: string;
    doc: StoredJournal;
    records: TurnLoreRecord[] | null;
}

interface LastTurn {
    chatId: string | null;
    record: TurnLoreRecord;
    entries: CapturedEntry[];
}

export class LoreJournal implements LoreJournalApi {
    private collector: ScanCollector | null = null;
    /** When the collector's generation ended (null: still running or not reported). */
    private collectorEndedAt: number | null = null;
    /** Scans after a dry or quiet GENERATION_STARTED belong to someone else. */
    private ignoreScans = false;
    private sim: Simulation | null = null;
    /** A simulation is being prepared or runs (re-entrance guard; `sim` is set only during the scan). */
    private simBusy = false;
    private catalogLists: unknown = null;
    private catalogCache: CatalogEntry[] | null = null;
    private view: ChatView | null = null;
    private loading: Promise<void> | null = null;
    private summaryCache: LoreSummary | null = null;
    private lastTurn: LastTurn | null = null;
    private readonly listeners = new Set<(record: TurnLoreRecord) => void>();
    private readonly tokenCache = new Map<string, number>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly settings: LoreJournalSettings,
        private readonly log: Logger,
    ) {}

    /** Subscribes to ST and the Maestro bus; every subscription goes through `own`. */
    install(own: (dispose: Unsubscribe) => void): void {
        const { host, bus } = this.app;
        const on = (key: string, handler: (...args: unknown[]) => unknown): void => {
            const name = host.events.name(key);
            if (!name) {
                this.log.warn(`ST event ${key} is missing; the lore journal cannot see it`);
                return;
            }
            own(host.events.on(name, handler));
        };
        on('WORLDINFO_ENTRIES_LOADED', (payload) => this.onEntriesLoaded(payload));
        on('WORLDINFO_SCAN_DONE', (args) => this.onScanDone(args));
        on('WORLD_INFO_ACTIVATED', (entries) => this.onActivated(entries));
        on('GENERATION_STARTED', (type, _params, dryRun) => this.onGenerationStarted(type, dryRun));
        own(bus.on('generation:before', (info) => this.onGenerationBefore(info)));
        own(
            bus.on('generation:ended', () => {
                if (this.collector) this.collectorEndedAt ??= Date.now();
            }),
        );
        own(
            bus.on('reply:ready', ({ messageIndex }) => {
                this.onReplyReady(messageIndex);
            }),
        );
        own(
            bus.on('chat:changed', () => {
                this.onChatChanged();
            }),
        );
        own(
            bus.on('message:invalidated', ({ reason }) => {
                if (reason === 'deleted') void this.onDeleted();
            }),
        );
        own(() => {
            this.disposed = true;
            this.listeners.clear();
            this.collector = null;
            this.sim = null;
        });
        void this.ensureLoaded();
    }

    /* ---------------------------------------------------------------- capture (send path) */

    private onEntriesLoaded(payload: unknown): void {
        if (!isDict(payload)) return;
        if (this.sim) {
            this.prepareSimulation(payload);
            return;
        }
        // Keep references only; the catalog is built when a summary is asked for.
        this.catalogLists = payload;
        this.catalogCache = null;
        this.summaryCache = null;
    }

    private prepareSimulation(lists: Dict): void {
        const sim = this.sim;
        if (!sim) return;
        if (sim.deterministic) {
            for (const name of ['globalLore', 'characterLore', 'chatLore', 'personaLore']) {
                const list = lists[name];
                if (!Array.isArray(list)) continue;
                // Top-level primitive on a per-scan copy: allowed (never touch nested arrays, they alias ST's cache).
                for (const entry of list) if (isDict(entry) && entry.useProbability) entry.useProbability = false;
            }
        }
        if (sim.transform) {
            try {
                sim.transform(lists as Parameters<EntriesTransform>[0]);
            } catch (error) {
                this.log.warn('simulation transform failed', error);
            }
        }
    }

    private onScanDone(args: unknown): void {
        if (this.sim) {
            this.sim.collector.scanDone(args);
            return;
        }
        if (this.ignoreScans || !this.collector) return;
        this.collector.scanDone(args);
    }

    private onActivated(entries: unknown): void {
        if (this.sim || this.ignoreScans || !this.collector) return;
        this.collector.activatedFinal(entries);
    }

    private onGenerationStarted(type: unknown, dryRun: unknown): void {
        const kind = typeof type === 'string' && type ? type : 'normal';
        if (dryRun === true || NOT_A_TURN.has(kind)) {
            this.ignoreScans = true;
            return;
        }
        this.ignoreScans = false;
        this.newCollector(kind);
    }

    /** Backup for a GENERATION_STARTED we did not see (Maestro's interceptor runs right before the scan). */
    private onGenerationBefore(info: GenerationInfo): void {
        if (info.quiet || info.dryRun || NOT_A_TURN.has(info.type)) return;
        this.ignoreScans = false;
        if (!this.collector || this.collector.hasData()) this.newCollector(info.type);
    }

    private newCollector(type: string): void {
        this.collector = new ScanCollector(type, this.app.host.chatId());
        this.collectorEndedAt = null;
    }

    /**
     * Binds the scan to the rendered reply. A collector without data is still a turn: ST returns before the first
     * loop when no lorebook entry is active at all (WI:4749), so the turn simply had no lore.
     */
    private onReplyReady(messageIndex: number): void {
        const collector = this.collector;
        if (!collector) return;
        const endedAt = this.collectorEndedAt;
        this.collector = null;
        this.collectorEndedAt = null;
        const now = Date.now();
        if (now - collector.startedAt > STALE_COLLECTOR_MS) return;
        if (endedAt !== null && now - endedAt > REPLY_GRACE_MS) return;
        void this.finalize(collector, messageIndex).catch((error: unknown) =>
            this.log.warn('could not record the lore of this turn', error),
        );
    }

    private onChatChanged(): void {
        this.collector = null;
        this.lastTurn = null;
        this.view = null;
        // The catalog stays: ST's own CHAT_CHANGED listener has usually already rescanned the new chat's books
        // (WI:1013-1018) before Maestro's bus event arrives.
        this.summaryCache = null;
        void this.ensureLoaded();
    }

    private async onDeleted(): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        // ST reports the new chat length; records of messages at or after it are gone.
        const length = this.app.host.ctx().chat.length;
        await this.updateDoc(chatId, (doc) => removeRecordsFrom(doc, length));
        if (this.lastTurn && this.lastTurn.record.messageIndex >= length) this.lastTurn = null;
    }

    /* ---------------------------------------------------------------- finalisation (after the reply) */

    private async finalize(collector: ScanCollector, messageIndex: number): Promise<TurnLoreRecord> {
        const entries = collector.result();
        const record = await this.buildRecord(entries, {
            messageIndex,
            generationType: collector.generationType,
            budgetTokens: collector.budget(),
            overflow: collector.overflow(),
        });
        const chatId = collector.chatId ?? this.app.host.chatId();
        this.lastTurn = { chatId, record, entries };
        if (chatId) {
            const keep = Math.max(1, Math.floor(Number(this.settings.keepTurns) || 200));
            await this.updateDoc(chatId, (doc) => addRecord(doc, record, keep));
        }
        this.emit(record);
        return record;
    }

    private async buildRecord(
        entries: CapturedEntry[],
        meta: {
            messageIndex: number;
            generationType: string;
            budgetTokens?: number;
            overflow: boolean;
            simulated?: boolean;
        },
    ): Promise<TurnLoreRecord> {
        const wi = await loadWorldInfo(this.app);
        const via = attributeVia(entries, matchGlobals(wi), this.substitute(), this.parseRegex(wi));
        const tokens = await this.countTokens(entries);
        const context = this.tagContext();
        return assembleRecord(entries, {
            messageIndex: meta.messageIndex,
            at: Date.now(),
            generationType: meta.generationType,
            budgetTokens: meta.budgetTokens,
            overflow: meta.overflow,
            simulated: meta.simulated,
            tokens: (entry) => tokens.get(entryId(entry.world, entry.uid)) ?? estimateTokens(entry.content),
            tags: (entry) => tagsFor(entry, context, this.hasLocalizer(entry)),
            via,
        });
    }

    private async countTokens(entries: readonly CapturedEntry[]): Promise<Map<string, number>> {
        const result = new Map<string, number>();
        const queue = entries.filter((entry) => entry.content);
        const worker = async (): Promise<void> => {
            for (let entry = queue.shift(); entry; entry = queue.shift()) {
                result.set(entryId(entry.world, entry.uid), await this.tokensOf(entry.content));
            }
        };
        await Promise.all(Array.from({ length: Math.min(TOKEN_WORKERS, queue.length) }, worker));
        return result;
    }

    /** Token count through ST's tokenizer (it caches by hash too), with our own small cache in front. */
    async tokensOf(text: string): Promise<number> {
        if (!text) return 0;
        const key = stableHash(text);
        const cached = this.tokenCache.get(key);
        if (cached !== undefined) return cached;
        let value: number;
        try {
            const counted = Number(await this.app.host.ctx().getTokenCountAsync(text));
            value = Number.isFinite(counted) && counted >= 0 ? counted : estimateTokens(text);
        } catch {
            value = estimateTokens(text);
        }
        if (this.tokenCache.size >= TOKEN_CACHE_LIMIT) {
            const oldest = this.tokenCache.keys().next().value;
            if (oldest !== undefined) this.tokenCache.delete(oldest);
        }
        this.tokenCache.set(key, value);
        return value;
    }

    private tagContext(): TagContext {
        const adapters = adaptersOf(this.app);
        const safe = <T>(read: () => T, fallback: T): T => {
            try {
                return read();
            } catch (error) {
                this.log.debug('tag context', error);
                return fallback;
            }
        };
        const bunny = safe(() => adapters.bunnymo.books(), { core: [], packs: [], archives: [] });
        const repos = safe(() => (adapters.ck.present() ? adapters.ck.repoBooks() : []), [] as string[]);
        const des = this.desLinks();
        return {
            bunnymoCore: new Set(bunny.core),
            bunnymoPacks: new Set(bunny.packs),
            ckRepos: new Set(repos),
            desBooks: new Set([...des.campaignAll, ...des.campaign, ...des.autoLinked, ...des.workshop]),
        };
    }

    private desLinks(): DesLinks {
        try {
            const des = adaptersOf(this.app).des;
            return des.present() ? desLinkedBooks(des.settings()) : desLinkedBooks(null);
        } catch (error) {
            this.log.debug('DES lorebook settings', error);
            return desLinkedBooks(null);
        }
    }

    private hasLocalizer(entry: CapturedEntry): boolean {
        try {
            return adaptersOf(this.app).localizer.markerOf({ extensions: entry.extensions }) !== null;
        } catch {
            return false;
        }
    }

    private substitute(): Substitute {
        const ctx = this.app.host.ctx();
        return (text) => {
            try {
                return typeof ctx.substituteParams === 'function' ? ctx.substituteParams(text) : text;
            } catch {
                return text;
            }
        };
    }

    private parseRegex(wi: WorldInfoModule | null): ((key: string) => RegExp | null) | undefined {
        const parse = wi?.parseRegexFromString;
        return typeof parse === 'function' ? (key) => parse(key) : undefined;
    }

    private emit(record: TurnLoreRecord): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(record);
            } catch (error) {
                this.log.warn('lore journal listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- storage */

    /** Loads the journal of the current chat (no-op when loaded). */
    async ensureLoaded(): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId || this.disposed) {
            this.view = null;
            return;
        }
        if (this.view?.chatId === chatId) return;
        if (!this.loading) {
            const pending = (async () => {
                const doc = ensureJournal(await this.app.chat.getFor(chatId, LORE_DOC_KIND, emptyJournal));
                if (this.app.host.chatId() === chatId) this.setView(chatId, doc);
            })();
            this.loading = pending
                .catch((error: unknown) => this.log.warn('could not load the lore journal', error))
                .finally(() => {
                    this.loading = null;
                });
        }
        await this.loading;
        // The chat may have changed while loading.
        if (this.app.host.chatId() !== chatId) await this.ensureLoaded();
    }

    private setView(chatId: string, doc: StoredJournal): void {
        this.view = { chatId, doc, records: null };
        this.summaryCache = null;
    }

    /** Applies a change to a chat's journal and saves it; retries once over a newer version from another tab. */
    private async updateDoc<R>(chatId: string, change: (doc: StoredJournal) => R): Promise<R | undefined> {
        let result: R | undefined;
        for (let attempt = 0; attempt < 2; attempt++) {
            const doc = ensureJournal(await this.app.chat.getFor(chatId, LORE_DOC_KIND, emptyJournal));
            result = change(doc);
            const saved = await this.app.chat.put(LORE_DOC_KIND, doc);
            if (this.app.host.chatId() === chatId) this.setView(chatId, doc);
            if (saved) return result;
        }
        this.log.warn('the lore journal was not saved (another tab keeps writing it)');
        return result;
    }

    private records(): TurnLoreRecord[] {
        const view = this.view;
        if (!view || view.chatId !== this.app.host.chatId()) return [];
        view.records ??= decodeRecords(view.doc);
        return view.records;
    }

    private catalog(): CatalogEntry[] {
        this.catalogCache ??= catalogFromLists(this.catalogLists);
        return this.catalogCache;
    }

    /* ---------------------------------------------------------------- API */

    turns(limit?: number): TurnLoreRecord[] {
        const records = this.records();
        return limit === undefined ? [...records] : limit <= 0 ? [] : records.slice(-limit);
    }

    last(): TurnLoreRecord | undefined {
        const records = this.records();
        return records[records.length - 1];
    }

    summary(): LoreSummary {
        const view = this.view;
        if (!view || view.chatId !== this.app.host.chatId()) return emptySummary();
        this.summaryCache ??= summarize(view.doc, this.catalog());
        return this.summaryCache;
    }

    onTurn(listener: (record: TurnLoreRecord) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    simulating(): boolean {
        return this.sim !== null;
    }

    suspendedRules(): string[] {
        return this.sim ? [...this.sim.suspended] : [];
    }

    markCut(world: string, uid: number): void {
        (this.sim?.collector ?? this.collector)?.markCut(world, uid);
    }

    lastContents(): LoreContent[] {
        const last = this.lastTurn;
        if (!last || last.chatId !== this.app.host.chatId()) return [];
        return last.entries
            .filter((entry) => !entry.cut)
            .map((entry) => ({ world: entry.world, uid: entry.uid, comment: entry.comment, content: entry.content }));
    }

    async whyActive(): Promise<BookActivationReason[]> {
        const ctx = this.app.host.ctx();
        const wi = await loadWorldInfo(this.app);
        const charLore = isDict(wi?.world_info) && Array.isArray(wi.world_info.charLore) ? wi.world_info.charLore : [];
        const characters = ctx.characters ?? [];
        const members = ctx.groupId
            ? ((ctx.groups ?? []).find((group) => group.id === ctx.groupId)?.members ?? []).map((avatar) =>
                  characters.find((character) => character.avatar === avatar),
              )
            : [ctx.characterId === undefined ? undefined : characters[Number(ctx.characterId)]];
        const primary: string[] = [];
        const extra: string[] = [];
        for (const character of members) {
            if (!character) continue;
            const world = character.data?.extensions?.world;
            if (typeof world === 'string' && world) primary.push(world);
            const key = avatarKey(character.avatar ?? '');
            for (const lore of charLore) {
                if (isDict(lore) && lore.name === key) extra.push(...strings(lore.extraBooks));
            }
        }
        const chatBook = ctx.chatMetadata?.world_info;
        const personaBook = ctx.powerUserSettings?.persona_description_lorebook;
        const rows = bookReasons({
            global: strings(wi?.selected_world_info),
            characterPrimary: primary,
            characterExtra: extra,
            chat: typeof chatBook === 'string' && chatBook ? chatBook : undefined,
            persona: typeof personaBook === 'string' && personaBook ? personaBook : undefined,
            ckChatBooks: strings(ctx.chatMetadata?.carrot_chat_books),
            des: this.desLinks(),
        });
        let known: string[] = [];
        try {
            known = (ctx as unknown as { getWorldInfoNames?: () => string[] }).getWorldInfoNames?.() ?? [];
        } catch {
            known = [];
        }
        return known.length ? rows.filter((row) => known.includes(row.book)) : rows;
    }

    async simulate(options: SimulateOptions = {}): Promise<TurnLoreRecord> {
        if (this.simBusy) throw new Error('a simulation is already running');
        if (this.app.turn.current()) throw new Error('a generation is in progress');
        this.simBusy = true;
        try {
            return await this.runSimulation(options);
        } finally {
            this.simBusy = false;
        }
    }

    private async runSimulation(options: SimulateOptions): Promise<TurnLoreRecord> {
        const wi = await loadWorldInfo(this.app);
        const check = wi?.checkWorldInfo;
        if (typeof check !== 'function') throw new Error('world-info.js checkWorldInfo is not available');
        const chat = await chatForWI(this.app, wi);
        const maxContext = await maxPromptTokens(this.app);
        const scanData = cardFields(this.app);
        const sim: Simulation = {
            collector: new ScanCollector('simulate', this.app.host.chatId()),
            deterministic: options.deterministic !== false,
            transform: options.transform,
            suspended: [...(options.suspendRules ?? [])],
        };
        this.sim = sim;
        let result: unknown;
        try {
            result = await check(chat, maxContext, true, scanData);
        } finally {
            this.sim = null;
        }
        // Dry runs emit no WORLD_INFO_ACTIVATED: the returned Set is the final list.
        const final = isDict(result) ? result.allActivatedEntries : undefined;
        if (final && typeof (final as Iterable<unknown>)[Symbol.iterator] === 'function') {
            sim.collector.activatedFinal([...(final as Iterable<unknown>)]);
        }
        return this.buildRecord(sim.collector.result(), {
            messageIndex: -1,
            generationType: 'simulate',
            budgetTokens: sim.collector.budget(),
            overflow: sim.collector.overflow(),
            simulated: true,
        });
    }

    async attributeKeys(record: TurnLoreRecord): Promise<TurnLoreRecord> {
        const app = this.app;
        const wi = await loadWorldInfo(app);
        const globals = matchGlobals(wi);
        const parse = this.parseRegex(wi);
        const substitute = this.substitute();
        const details = await this.entryDetails(record);
        const end =
            record.messageIndex < 0
                ? undefined
                : record.generationType === 'continue'
                  ? record.messageIndex + 1
                  : record.messageIndex;
        const messages = await chatForWI(app, wi, end);
        const global = cardFields(app);
        const injects = scanInjects(app);
        const depth = globalDepth(wi);

        const activations = record.activations.map((row) => {
            if (row.key !== undefined) return { ...row };
            const detail = details.get(entryId(row.world, row.uid));
            if (!detail || detail.constant) return { ...row, key: '' };
            // Recursion text: what earlier loops added (only for entries activated by a recursion step).
            const recursion =
                row.recursionLevel > 0
                    ? record.activations
                          .filter((other) => other.loop < row.loop && other.cut !== true)
                          .map((other) => details.get(entryId(other.world, other.uid)))
                          .filter((other): other is CapturedEntry => !!other && !other.preventRecursion)
                          .map((other) => other.content)
                    : [];
            const text = buildScanText({
                messages,
                depth: detail.scanDepth ?? depth,
                global,
                flags: detail.flags,
                injects,
                recursion,
            });
            return { ...row, key: findTriggerKey(detail, text, globals, substitute, parse) ?? '' };
        });
        const updated: TurnLoreRecord = { ...record, activations };
        const chatId = app.host.chatId();
        if (!record.simulated && record.messageIndex >= 0 && chatId) {
            await this.updateDoc(chatId, (doc) => setRecordKeys(doc, updated));
        }
        if (this.lastTurn?.record.at === record.at) this.lastTurn = { ...this.lastTurn, record: updated };
        return updated;
    }

    /** Entry fields for key matching: from memory for the last turn, else from the books (current versions). */
    private async entryDetails(record: TurnLoreRecord): Promise<Map<string, CapturedEntry>> {
        const details = new Map<string, CapturedEntry>();
        const last = this.lastTurn;
        if (last && last.record.at === record.at && last.record.messageIndex === record.messageIndex) {
            for (const entry of last.entries) details.set(entryId(entry.world, entry.uid), entry);
            return details;
        }
        const ctx = this.app.host.ctx() as unknown as { loadWorldInfo?: (name: string) => Promise<unknown> };
        const substitute = this.substitute();
        const worlds = [...new Set(record.activations.map((row) => row.world))];
        for (const world of worlds) {
            let book: unknown;
            try {
                book = await ctx.loadWorldInfo?.(world);
            } catch (error) {
                this.log.debug(`lorebook ${world} did not load`, error);
                continue;
            }
            const entries = isDict(book) && isDict(book.entries) ? book.entries : {};
            const wanted = new Map(
                record.activations.filter((row) => row.world === world).map((row) => [row.uid, row] as const),
            );
            for (const raw of Object.values(entries)) {
                if (!isDict(raw)) continue;
                const row = wanted.get(Number(raw.uid));
                if (!row) continue;
                const entry = captureEntry({ ...raw, world }, row.loop, row.recursionLevel);
                if (!entry) continue;
                entry.content = substitute(entry.content);
                details.set(entryId(world, entry.uid), entry);
            }
        }
        return details;
    }
}
