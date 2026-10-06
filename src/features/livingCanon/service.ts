// M26 «Живой канон» — the service behind LivingCanonApi (plan M26, P14, P15, §5 «Отмена», §8; dev-plan 4.4).
//
// Life of an invented name:
// - reply:ready (after DES, DES-RU and NAI markers; idle-scheduled, never on the send path): the cheap search of
//   src/domain/living-detect.ts → drafts, in memory and (leader) in the chat document. Nothing reaches the canon (P14).
// - turn:committed (the user sent the next message; idle-scheduled, leader only): survival count of older
//   provisional facts, then the reply's significant drafts (at most K) become canon additions (origin 'living',
//   status 'provisional', Russian keys, the Russian quote as a seed) through autonomy kind 'living.fact' («Само»);
//   a draft that is another name of a living fact extends it; contradicting ones go to the Inbox ('living.disputed').
//   Then the confirmation rules of plan M26 п. 4 and the extraction trigger.
// - message:invalidated: drafts of that reply go; provisional facts from it are removed from the canon («Само»: the
//   canon journals the removal with undo); confirmed canon is untouched.
// - background task 'living.extract' (every N messages or by hand, leader only): English canon texts for provisional
//   facts and the facts the cheap search missed.
// Passes run one at a time (a serial chain), so an invalidation never interleaves with the commit of the same reply.
import { adaptersOf } from '../../adapters';
import { tPlural } from '../../core/labels';
import { uniqueStrings } from '../../domain/canon-keys';
import { desSwipeRecord, parseDesCharacters, parseDesInfoBox } from '../../domain/des-tracker';
import {
    buildKnownNames,
    detectNames,
    distinctiveStems,
    findName,
    guessType,
    indexText,
    isKnownName,
    mentionsAny,
    nameKey,
    quoteAround,
    significance,
    similarNames,
    SIGNIFICANT_SCORE,
    stemRegexKey,
} from '../../domain/living-detect';
import type { KnownNames, LivingType, NameCandidate, TextIndex } from '../../domain/living-detect';
import { buildExtractMessages, EXTRACT_SCHEMA, isEnglishText, parseExtraction } from '../../domain/living-extract';
import type { ExtractFact, ExtractUpdate } from '../../domain/living-extract';
import {
    addQuote,
    bumpStat,
    canonTypeOf,
    confirmReason,
    countConfirmed,
    countContradicted,
    emptyStats,
    englishContent,
    entryHash,
    entryInPrompt,
    factsFrom,
    invalidationPlan,
    isLivingType,
    isSeedContent,
    markDropped,
    mergeKeys,
    messageStamp,
    recentlyConfirmed,
    relocate,
    rememberCommit,
    seedContent,
} from '../../domain/living-facts';
import type {
    ConfirmReasonId,
    DraftData,
    FactData,
    FactOrigin,
    LivingDocData,
    LivingStats,
} from '../../domain/living-facts';
import { cleanForAnalysis } from '../../domain/text-clean';
import type { App, JournalChange, Logger, Proposal, Signal, TaskInfo, Unsubscribe } from '../../shared/contracts';
import type { CanonApi, CanonDraft, CanonItem } from '../canon/api';
import type { Contradiction, ContradictionInput, ContradictionsApi } from '../contradictions/api';
import type { LoreJournalApi } from '../loreJournal/api';
import type { WorldModelApi } from '../world/api';
import type { LivingCanonApi, LivingFact, LivingProposal } from './api';
import { LivingStore } from './store';

export const LIVING_KEY = 'livingCanon';
export const LIVING_ID = 'M26';
/** Autonomy kinds: a new provisional fact («Само», §8) and a disputed one («Входящие», §8). */
export const FACT_KIND = 'living.fact';
export const DISPUTED_KIND = 'living.disputed';
export const EXTRACT_TASK = 'living.extract';
/** Journal target of a living fact added through autonomy or the Inbox (undo removes it from the canon). */
export const FACT_TARGET = 'living-fact';

const CANON_KEY = 'canon';
const WORLD_KEY = 'world';
const LORE_KEY = 'loreJournal';
const CONTRADICTIONS_KEY = 'contradictions';

/** Longest wait for an idle moment after an event. */
const IDLE_WAIT_MS = 1500;
/** Known names are rebuilt at most this often (world model, canon keys, card text, last turn's lore). */
const KNOWN_TTL_MS = 10_000;
/** Earlier assistant replies checked for «repeated across turns». */
const SEEN_BEFORE_MESSAGES = 20;
/** Messages a batch extraction looks at, at most. */
const EXTRACT_WINDOW = 30;
const EXTRACT_CHARS = 14_000;
const EXTRACT_PROVISIONAL = 15;
const EXTRACT_MAX_TOKENS = 1800;
const EXTRACT_TTL_MS = 30 * 60_000;
/** Canon items compared with a statement at most. */
const MAX_AGAINST = 20;
/** contradictions.check() may wait for a background task or a direct request: never longer than this. */
const CHECK_TIMEOUT_MS = 30_000;
const CANON_RECONCILE_MS = 300;
const MAX_KEYS = 24;

type IdleRequest = (callback: () => void, options?: { timeout?: number }) => number;
type Dict = Record<string, unknown>;

export interface LivingCanonSettings {
    /** K: most new facts per committed turn (plan M26 п. 4). */
    maxPerTurn: number;
    /** N: committed turns without contradictions or edits that confirm a provisional fact. */
    surviveTurns: number;
    /** Batch extraction every this many messages; 0 = only by hand. */
    extractEvery: number;
}

export function defaultLivingSettings(): LivingCanonSettings {
    return { maxPerTurn: 3, surviveTurns: 10, extractEvery: 10 };
}

/** A fact on its way into the canon (JSON payload of 'living.fact' and of disputed 'new' cards). */
export interface CandidatePayload {
    id: string;
    name: string;
    type: LivingType;
    quote: string;
    keys: string[];
    sourceMessage: number;
    stamp: string;
    origin: FactOrigin;
    text?: string;
    english?: string;
    /** The fact in one short Russian sentence (batch extraction), for cards and notices. */
    russian?: string;
    conflict?: string;
    /** The quote again, for the Inbox card's evidence line (core view convention). */
    evidence?: string;
}

/** What a disputed card says to the user: the reply's quote and the names of what it contradicts. */
interface DisputedView {
    evidence?: string;
    /** Labels of the canon items it contradicts (the full conflict text stays in `conflict`, for details). */
    against?: string[];
}

/** Payload of a 'living.disputed' card: a new fact, an existing provisional one, or a conflict with confirmed canon. */
export type DisputedPayload = DisputedView &
    (
        | { mode: 'new'; candidate: CandidatePayload; conflict: string }
        | { mode: 'existing'; id: string; uid: number; conflict: string }
        | { mode: 'conflict'; id: string; uid: number; quote: string; sourceMessage: number; conflict: string }
    );

interface CandidateInput {
    name: string;
    type: LivingType;
    quote: string;
    sourceMessage: number;
    stamp: string;
    origin: FactOrigin;
    variants?: string[];
    text?: string;
    english?: string;
    russian?: string;
    mergeInto?: string;
}

type AddOutcome = 'added' | 'merged' | 'queued' | 'disputed' | 'skipped';
/** How hard contradictions are checked (see contradictionsOf). */
type CheckMode = 'rules' | 'queued' | 'inline';

interface Budget {
    left: number;
}

function isRecord(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readCandidate(value: unknown): CandidatePayload | null {
    if (!isRecord(value) || typeof value.id !== 'string' || typeof value.name !== 'string') return null;
    if (typeof value.sourceMessage !== 'number' || typeof value.quote !== 'string') return null;
    const candidate: CandidatePayload = {
        id: value.id,
        name: value.name,
        type: isLivingType(value.type) ? value.type : 'other',
        quote: value.quote,
        keys: strings(value.keys),
        sourceMessage: value.sourceMessage,
        stamp: typeof value.stamp === 'string' ? value.stamp : '',
        origin: value.origin === 'extract' || value.origin === 'revision' ? value.origin : 'reply',
    };
    if (typeof value.text === 'string' && value.text.trim()) candidate.text = value.text;
    if (typeof value.english === 'string' && value.english.trim()) candidate.english = value.english;
    if (typeof value.russian === 'string' && value.russian.trim()) candidate.russian = value.russian;
    if (typeof value.conflict === 'string' && value.conflict) candidate.conflict = value.conflict;
    return candidate;
}

function readDisputed(value: unknown): DisputedPayload | null {
    if (!isRecord(value) || typeof value.conflict !== 'string') return null;
    if (value.mode === 'new') {
        const candidate = readCandidate(value.candidate);
        return candidate ? { mode: 'new', candidate, conflict: value.conflict } : null;
    }
    if (typeof value.id !== 'string' || typeof value.uid !== 'number') return null;
    if (value.mode === 'existing') return { mode: 'existing', id: value.id, uid: value.uid, conflict: value.conflict };
    if (value.mode === 'conflict' && typeof value.quote === 'string' && typeof value.sourceMessage === 'number') {
        return {
            mode: 'conflict',
            id: value.id,
            uid: value.uid,
            quote: value.quote,
            sourceMessage: value.sourceMessage,
            conflict: value.conflict,
        };
    }
    return null;
}

function newId(): string {
    return `lf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function clip(text: string, max: number): string {
    const value = text.replace(/\s+/g, ' ').trim();
    return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** Names of what a statement contradicts, for the user (at most three). */
function againstOf(hits: readonly Contradiction[]): string[] {
    return uniqueStrings(hits.map((hit) => hit.label.trim()).filter(Boolean)).slice(0, 3);
}

/** A sentence without its final full stop (it goes into a longer line). */
function bare(sentence: string): string {
    return sentence.trim().replace(/[.。]+$/u, '');
}

/** Canon meta of an item (unknown fields such as `livingId` kept) without the bookkeeping put() fills in itself. */
function draftMeta(item: CanonItem, changes: Partial<CanonDraft['meta']> = {}): CanonDraft['meta'] {
    const meta: Dict = { ...item.meta, ...changes };
    delete meta.createdAt;
    delete meta.updatedAt;
    return meta as unknown as CanonDraft['meta'];
}

function livingIdOf(item: CanonItem): string | undefined {
    const id = (item.meta as unknown as Dict).livingId;
    return typeof id === 'string' ? id : undefined;
}

function contentOf(item: CanonItem | undefined): string {
    const content = item?.entry.content;
    return typeof content === 'string' ? content : '';
}

function commentOf(item: CanonItem): string {
    const comment = item.entry.comment;
    if (typeof comment === 'string' && comment.trim()) return comment.trim();
    return strings(item.entry.key).find((key) => key.trim() && !key.startsWith('/')) ?? `#${item.uid}`;
}

export class LivingCanonService implements Required<LivingCanonApi> {
    readonly store: LivingStore;
    private readonly listeners = new Set<() => void>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private readonly idles = new Set<number>();
    private readonly textCache = new Map<string, TextIndex>();
    private chain: Promise<unknown> = Promise.resolve();
    /** Proposals being decided inside a pass: autonomy applies them right there (no new pass, no deadlock). */
    private readonly inline = new Set<string>();
    /** Drafts of this tab (the leader also keeps them in the chat document). */
    private memoryDrafts: DraftData[] = [];
    private canonOff: Unsubscribe | null = null;
    private canonFor: CanonApi | null = null;
    private reconcileTimer: ReturnType<typeof setTimeout> | null = null;
    private knownCache: { at: number; chatId: string | null; known: KnownNames; names: string[] } | null = null;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => LivingCanonSettings,
    ) {
        this.store = new LivingStore(app, log);
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(): Unsubscribe[] {
        const { app } = this;
        const offs: Unsubscribe[] = [
            this.store.onChange(() => this.emit()),
            app.bus.on('reply:ready', ({ messageIndex }) => {
                this.later(() => this.serial(() => this.onReply(messageIndex)), true);
            }),
            app.bus.on('turn:committed', ({ messageIndex }) => {
                // MESSAGE_SENT is on the send path (P15): wait for an idle moment (the request is in flight).
                this.later(() => this.serial(() => this.onCommit(messageIndex)), true);
            }),
            app.bus.on('message:invalidated', ({ messageIndex, reason }) => {
                this.later(() => this.serial(() => this.onInvalidated(messageIndex, reason)));
            }),
            app.bus.on('chat:changed', () => {
                this.store.reset();
                this.memoryDrafts = [];
                this.knownCache = null;
                this.textCache.clear();
                this.later(() => this.serial(() => this.open()));
            }),
            app.bus.on('signal', (signal) => {
                if (signal.kind === 'fact.new') this.later(() => this.fromSignal(signal).then(() => undefined));
            }),
            app.leader.onChange((leader) => {
                if (leader) this.later(() => this.serial(() => this.open()));
            }),
            app.tasks.register(EXTRACT_TASK, (payload, info) => this.serial(() => this.runExtraction(payload, info))),
            app.inbox.registerApplier(
                FACT_KIND,
                async (payload) => {
                    const candidate = readCandidate(payload);
                    if (!candidate) throw new Error(this.t('m26.error.payload'));
                    await this.serial(() => this.saveCandidate(candidate));
                },
                async (payload) => {
                    const candidate = readCandidate(payload);
                    return !!candidate && this.candidateValid(candidate);
                },
            ),
            app.inbox.registerApplier(
                DISPUTED_KIND,
                async (payload) => {
                    const disputed = readDisputed(payload);
                    if (!disputed) throw new Error(this.t('m26.error.payload'));
                    await this.serial(() => this.acceptDisputed(disputed));
                },
                async (payload) => {
                    const disputed = readDisputed(payload);
                    return !!disputed && this.disputedValid(disputed);
                },
                async (payload) => {
                    const disputed = readDisputed(payload);
                    if (disputed) await this.serial(() => this.rejectDisputed(disputed));
                },
            ),
        ];
        app.journal.registerUndo(FACT_TARGET, (change) => this.undoFact(change));
        this.later(() => this.serial(() => this.open()));
        return offs;
    }

    dispose(): void {
        this.disposed = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        if (this.reconcileTimer) clearTimeout(this.reconcileTimer);
        const cancel = (globalThis as { cancelIdleCallback?: (handle: number) => void }).cancelIdleCallback;
        for (const handle of this.idles) cancel?.(handle);
        this.idles.clear();
        this.canonOff?.();
        this.canonOff = null;
        this.listeners.clear();
    }

    /** Runs a job after the current handlers; `idle` waits for an idle moment of the page (P15). */
    private later(job: () => Promise<unknown>, idle = false): void {
        if (this.disposed) return;
        const run = () => {
            if (this.disposed) return;
            job().catch((error: unknown) => this.log.error('living canon update failed', error));
        };
        const request = (globalThis as { requestIdleCallback?: IdleRequest }).requestIdleCallback;
        if (idle && typeof request === 'function') {
            const handle = request(
                () => {
                    this.idles.delete(handle);
                    run();
                },
                { timeout: IDLE_WAIT_MS },
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

    /** One pass at a time (entry points only; code inside a pass calls the inner functions directly). */
    private serial<T>(job: () => Promise<T>): Promise<T> {
        const next = this.chain.then(job, job);
        this.chain = next.catch(() => undefined);
        return next;
    }

    /** Autonomy may apply a proposal right inside the pass that made it ('auto'), or later (a badge, the Inbox). */
    private async decideInline<T>(key: string, decide: () => Promise<T>): Promise<T> {
        this.inline.add(key);
        try {
            return await decide();
        } finally {
            this.inline.delete(key);
        }
    }

    private applyLater<T>(key: string, job: () => Promise<T>): Promise<T> {
        return this.inline.has(key) ? job() : this.serial(job);
    }

    /** Resolves when the passes queued so far are done (tests, the pult). */
    async idle(): Promise<void> {
        await this.chain;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('living canon listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- neighbours */

    private canon(): CanonApi | undefined {
        const canon = this.app.modules.api<CanonApi>(CANON_KEY);
        if (canon && canon !== this.canonFor) {
            // The canon may come later than this module (or be re-enabled): follow its changes.
            this.canonOff?.();
            this.canonFor = canon;
            this.canonOff = canon.onChange(() => this.scheduleReconcile());
        }
        return canon;
    }

    private world(): WorldModelApi | undefined {
        return this.app.modules.api<WorldModelApi>(WORLD_KEY);
    }

    private lore(): LoreJournalApi | undefined {
        return this.app.modules.api<LoreJournalApi>(LORE_KEY);
    }

    private contradictions(): ContradictionsApi | undefined {
        return this.app.modules.api<ContradictionsApi>(CONTRADICTIONS_KEY);
    }

    private desru(): { nameForms?(name: string): unknown; nameFormsKey?(name: string): unknown } | null {
        try {
            const adapter = adaptersOf(this.app).desru as unknown as { api?: () => unknown } | undefined;
            const api = typeof adapter?.api === 'function' ? adapter.api() : undefined;
            return api && typeof api === 'object' ? (api as { nameForms?(name: string): unknown }) : null;
        } catch {
            return null;
        }
    }

    private active(): boolean {
        return !!this.app.host.chatId() && !this.app.host.isGroupChat();
    }

    /* ---------------------------------------------------------------- the chat */

    private chat(): STChatMessage[] {
        const chat = this.app.host.ctx().chat;
        return Array.isArray(chat) ? chat : [];
    }

    private isReply(message: STChatMessage | undefined): message is STChatMessage {
        return !!message && !message.is_user && !message.is_system;
    }

    /** The last assistant reply before the last user message: everything up to it is committed (P14). */
    committedIndex(): number {
        const chat = this.chat();
        let user = -1;
        for (let i = chat.length - 1; i >= 0; i--) {
            if (chat[i]?.is_user) {
                user = i;
                break;
            }
        }
        for (let i = user - 1; i >= 0; i--) if (this.isReply(chat[i])) return i;
        return -1;
    }

    /** Stem index of a message's story text (cached by its fingerprint). */
    private textOf(index: number): TextIndex | null {
        const message = this.chat()[index];
        if (!message) return null;
        const key = `${index}|${messageStamp(message)}`;
        const cached = this.textCache.get(key);
        if (cached) return cached;
        const text = indexText(cleanForAnalysis(message));
        if (this.textCache.size > 200) this.textCache.clear();
        this.textCache.set(key, text);
        return text;
    }

    private stampValid(sourceMessage: number, stamp: string): boolean {
        const message = this.chat()[sourceMessage];
        return this.isReply(message) && (!stamp || messageStamp(message) === stamp);
    }

    /* ---------------------------------------------------------------- known names */

    private async knownNames(): Promise<{ known: KnownNames; names: string[] }> {
        const chatId = this.app.host.chatId();
        const cache = this.knownCache;
        if (cache && cache.chatId === chatId && Date.now() - cache.at < KNOWN_TTL_MS) return cache;
        const names: string[] = [];
        const texts: string[] = [];
        try {
            for (const entity of this.world()?.entities() ?? []) {
                // Living facts reach the world model through the canon; they are handled as facts, not as known names.
                if (entity.sources.every((source) => source.kind === 'canon.entry')) continue;
                names.push(entity.name, ...entity.aliases, ...entity.forms);
            }
        } catch (error) {
            this.log.debug('world model names are not available', error);
        }
        const canon = this.canon();
        const book = canon?.bookName() ?? '';
        if (canon) {
            try {
                for (const item of await canon.list()) {
                    if (item.meta.origin === 'living') continue;
                    names.push(...strings(item.entry.key), ...strings(item.entry.keysecondary));
                    if (typeof item.entry.comment === 'string') names.push(item.entry.comment);
                }
            } catch (error) {
                this.log.debug('canon keys are not available', error);
            }
        }
        const ctx = this.app.host.ctx();
        names.push(ctx.name1, ctx.name2);
        const character = ctx.characters?.[Number(ctx.characterId)];
        if (character) {
            texts.push(character.description ?? '', character.personality ?? '', character.scenario ?? '');
            texts.push(character.first_mes ?? '');
        }
        const persona = ctx.powerUserSettings?.persona_description;
        if (typeof persona === 'string') texts.push(persona);
        try {
            for (const content of this.lore()?.lastContents?.() ?? []) {
                if (content.world === book) continue;
                names.push(content.comment);
                texts.push(content.content);
            }
        } catch (error) {
            this.log.debug('lore of the last turn is not available', error);
        }
        const fresh = { at: Date.now(), chatId, known: buildKnownNames(names, texts), names: uniqueStrings(names) };
        this.knownCache = fresh;
        return fresh;
    }

    /** DES names of a reply (its scene's characters and location): the world model may not have them yet. */
    private desNames(message: STChatMessage): string[] {
        const record = desSwipeRecord(message);
        if (!record) return [];
        const names = parseDesCharacters(record.characterThoughts).map((character) => character.name);
        const location = parseDesInfoBox(record.infoBox)?.location;
        if (location) names.push(location, ...location.split(/[,;>|/›]+/));
        return names;
    }

    /** The name was used by an earlier assistant reply (the «repeated across turns» signal). */
    private seenBefore(candidate: { name: string; variants?: string[] }, index: number): boolean {
        const names = [candidate.name, ...(candidate.variants ?? [])];
        const chat = this.chat();
        let checked = 0;
        for (let i = index - 1; i >= 0 && checked < SEEN_BEFORE_MESSAGES; i--) {
            if (!this.isReply(chat[i])) continue;
            checked++;
            const text = this.textOf(i);
            if (text && names.some((name) => findName(text, name).length > 0)) return true;
        }
        return false;
    }

    /** Living facts that are not dropped. */
    private liveFacts(doc: LivingDocData | null): FactData[] {
        return (doc?.facts ?? []).filter((fact) => fact.status !== 'dropped');
    }

    /** A candidate names this fact exactly (its name, a key or a case form): a mention, not a new name. */
    private sameAsFact(fact: FactData, names: readonly string[]): boolean {
        const own = buildKnownNames([fact.name, ...fact.keys, ...(fact.english ? [fact.english] : [])]);
        return names.some((name) => isKnownName(own, name));
    }

    private similarFact(facts: readonly FactData[], name: string): FactData | undefined {
        return facts.find(
            (fact) =>
                similarNames(fact.name, name) ||
                fact.keys.some((key) => !key.startsWith('/') && similarNames(key, name)) ||
                (!!fact.english && similarNames(fact.english, name)),
        );
    }

    /* ---------------------------------------------------------------- open and reconcile */

    private async open(): Promise<void> {
        if (!this.active()) return;
        const doc = await this.store.load();
        if (!doc) return;
        this.memoryDrafts = doc.drafts.map((draft) => ({ ...draft }));
        this.canon();
        if (this.app.leader.isLeader() && !doc.started) {
            // The batch extraction starts from now: old history is not mined (only new inventions count).
            const committed = this.committedIndex();
            await this.store.mutate((next) => {
                if (next.started) return { changed: false, result: undefined };
                next.started = true;
                next.extract.upTo = Math.max(next.extract.upTo, committed);
                next.extract.attemptAt = Math.max(next.extract.attemptAt, committed);
                return { changed: true, result: undefined };
            });
        }
        await this.reconcile();
        this.emit();
    }

    private scheduleReconcile(): void {
        if (this.disposed || this.reconcileTimer) return;
        this.knownCache = null;
        this.reconcileTimer = setTimeout(() => {
            this.reconcileTimer = null;
            this.later(() => this.serial(() => this.reconcile()));
        }, CANON_RECONCILE_MS);
    }

    /**
     * Brings the document in line with the canon book (leader only): facts whose entry vanished are dropped (an undo,
     * a removal in the Lore Studio), entries that came back revive their facts, status changes made in the canon
     * (confirming by hand) are mirrored, and living entries the document does not know are adopted.
     */
    private async reconcile(): Promise<void> {
        const canon = this.canon();
        if (!canon || !this.active() || !this.app.leader.isLeader()) return;
        let items: CanonItem[];
        try {
            items = await canon.list({ origin: 'living' });
        } catch (error) {
            this.log.debug('canon list failed', error);
            return;
        }
        const now = Date.now();
        await this.store.mutate((doc) => {
            let changed = false;
            const byId = new Map<string, CanonItem>();
            for (const item of items) {
                const id = livingIdOf(item);
                if (id) byId.set(id, item);
            }
            const claimed = new Set<number>();
            for (const fact of doc.facts) {
                if (fact.uid === undefined) continue;
                const byUid = items.find(
                    (item) =>
                        item.uid === fact.uid && !livingIdOf(item) && nameKey(commentOf(item)) === nameKey(fact.name),
                );
                const item = byId.get(fact.id) ?? byUid;
                if (!item) {
                    if (fact.status === 'provisional' || fact.status === 'active') {
                        fact.status = 'dropped';
                        fact.droppedBy = 'missing';
                        changed = true;
                    }
                    continue;
                }
                claimed.add(item.uid);
                if (fact.uid !== item.uid) {
                    fact.uid = item.uid;
                    changed = true;
                }
                const canonActive = item.meta.status === 'active';
                if (fact.status === 'dropped') {
                    if (fact.droppedBy === 'user' || fact.droppedBy === 'duplicate') continue;
                    fact.status = canonActive ? 'active' : 'provisional';
                    if (canonActive) {
                        fact.confirmedBy ??= 'userAccepted';
                        countConfirmed(doc, fact);
                    } else {
                        delete fact.confirmedBy;
                    }
                    delete fact.droppedBy;
                    changed = true;
                } else if (fact.status === 'provisional' && canonActive) {
                    // Confirmed by hand in the canon tab or the Lore Studio.
                    fact.status = 'active';
                    fact.confirmedBy ??= 'userAccepted';
                    fact.confirmedAt = now;
                    countConfirmed(doc, fact);
                    changed = true;
                } else if (fact.status === 'active' && item.meta.status === 'provisional') {
                    fact.status = 'provisional';
                    delete fact.confirmedBy;
                    delete fact.confirmedAt;
                    changed = true;
                }
            }
            for (const item of items) {
                const id = livingIdOf(item);
                if (claimed.has(item.uid) || (id && doc.facts.some((fact) => fact.id === id))) continue;
                const content = contentOf(item);
                doc.facts.push({
                    id: id ?? newId(),
                    uid: item.uid,
                    name: commentOf(item),
                    type: isLivingType(item.meta.type) ? item.meta.type : guessType(commentOf(item)),
                    quote: clip(content.replace(/^\[provisional\][^\n]*\n?/, ''), 280),
                    quotes: [],
                    keys: strings(item.entry.key),
                    sourceMessage: item.meta.sourceMessage ?? -1,
                    stamp: '',
                    status: item.meta.status === 'active' ? 'active' : 'provisional',
                    survivedTurns: item.meta.survivedTurns ?? 0,
                    createdAt: item.meta.createdAt || now,
                    entryHash: entryHash(item.entry),
                    origin: 'reply',
                });
                changed = true;
            }
            return { changed, result: undefined };
        });
    }

    /* ---------------------------------------------------------------- reply: drafts */

    private async onReply(index: number): Promise<void> {
        if (!this.active()) return;
        const message = this.chat()[index];
        if (!this.isReply(message)) return;
        const doc = await this.store.load();
        const drafts = await this.detectDrafts(index, message, doc);
        this.memoryDrafts = [...this.memoryDrafts.filter((draft) => draft.sourceMessage !== index), ...drafts];
        if (this.app.leader.isLeader()) {
            await this.store.mutate((next) => {
                const had = next.drafts.some((draft) => draft.sourceMessage === index);
                if (!had && !drafts.length) return { changed: false, result: undefined };
                next.drafts = [...next.drafts.filter((draft) => draft.sourceMessage !== index), ...drafts];
                return { changed: true, result: undefined };
            });
        }
        this.emit();
    }

    /** Significant new names of a reply, and other names of living facts (to extend them at the commit). */
    private async detectDrafts(index: number, message: STChatMessage, doc: LivingDocData | null): Promise<DraftData[]> {
        const text = cleanForAnalysis(message);
        const candidates = detectNames(text);
        if (!candidates.length) return [];
        const { known } = await this.knownNames();
        const local = buildKnownNames(this.desNames(message));
        const facts = this.liveFacts(doc);
        const refused = (doc?.facts ?? []).filter((fact) => fact.status === 'dropped' && fact.droppedBy === 'user');
        const stamp = messageStamp(message);
        const drafts: DraftData[] = [];
        for (const candidate of candidates) {
            const names = [candidate.name, ...candidate.variants];
            const fact = this.similarFact(facts, candidate.name);
            if (fact) {
                if (!this.sameAsFact(fact, names)) drafts.push(this.draftOf(candidate, index, stamp, 0, fact.id));
                continue;
            }
            if (refused.some((item) => similarNames(item.name, candidate.name))) continue;
            if (names.some((name) => isKnownName(known, name) || isKnownName(local, name))) continue;
            const score = significance(candidate, this.seenBefore(candidate, index));
            if (score < SIGNIFICANT_SCORE) continue;
            drafts.push(this.draftOf(candidate, index, stamp, score));
        }
        return drafts;
    }

    private draftOf(
        candidate: NameCandidate,
        index: number,
        stamp: string,
        score: number,
        mergeInto?: string,
    ): DraftData {
        const draft: DraftData = {
            name: candidate.name,
            type: candidate.type,
            pattern: candidate.pattern,
            quote: candidate.quote,
            count: candidate.count,
            descriptive: candidate.descriptive,
            variants: candidate.variants,
            sourceMessage: index,
            stamp,
            score,
            at: Date.now(),
        };
        if (mergeInto) draft.mergeInto = mergeInto;
        return draft;
    }

    /* ---------------------------------------------------------------- commit */

    private async onCommit(index: number): Promise<void> {
        if (!this.active() || !this.app.leader.isLeader()) return;
        const message = this.chat()[index];
        if (!this.isReply(message)) return;
        const stamp = messageStamp(message);
        const doc = await this.store.load();
        if (!doc) return;
        const fresh = await this.store.mutate((next) => {
            const changed = rememberCommit(next, index, stamp);
            return { changed, result: changed };
        });
        if (!fresh) return;
        const canon = this.canon();
        await this.reconcile();
        await this.countSurvival(index);

        // Drafts of this reply (and of older uncommitted ones still unchanged); a reply nobody read is read now.
        const current = this.store.peek() ?? doc;
        const pending = current.drafts.filter(
            (draft) => draft.sourceMessage <= index && this.stampValid(draft.sourceMessage, draft.stamp),
        );
        let drafts = pending;
        if (!pending.some((draft) => draft.sourceMessage === index && draft.stamp === stamp)) {
            drafts = [
                ...pending.filter((draft) => draft.sourceMessage !== index),
                ...(await this.detectDrafts(index, message, current)),
            ];
        }
        await this.store.mutate((next) => {
            const before = next.drafts.length;
            next.drafts = next.drafts.filter((draft) => draft.sourceMessage > index);
            return { changed: next.drafts.length !== before, result: undefined };
        });
        this.memoryDrafts = this.memoryDrafts.filter((draft) => draft.sourceMessage > index);
        if (canon) {
            await this.commitDrafts(drafts);
            await this.confirmPass(index);
            await this.checkConfirmedConflicts(index);
        }
        await this.maybeExtract(index);
        this.emit();
    }

    /** Extensions first, then new facts by significance, at most K new ones per source message. */
    private async commitDrafts(drafts: readonly DraftData[]): Promise<void> {
        const k = Math.max(0, Math.floor(this.settings().maxPerTurn));
        const sources = [...new Set(drafts.map((draft) => draft.sourceMessage))].sort((a, b) => a - b);
        for (const source of sources) {
            const doc = this.store.peek();
            const budget: Budget = { left: k - (doc ? factsFrom(doc, source).length : 0) };
            const mine = drafts
                .filter((draft) => draft.sourceMessage === source)
                .sort((a, b) => Number(!!b.mergeInto) - Number(!!a.mergeInto) || b.score - a.score);
            for (const draft of mine) {
                if (!draft.mergeInto && budget.left <= 0) break;
                await this.addCandidate(
                    {
                        name: draft.name,
                        type: draft.type,
                        quote: draft.quote,
                        sourceMessage: draft.sourceMessage,
                        stamp: draft.stamp,
                        origin: 'reply',
                        variants: draft.variants,
                        ...(draft.mergeInto ? { mergeInto: draft.mergeInto } : {}),
                    },
                    budget,
                    'rules',
                );
            }
        }
    }

    /** Older provisional facts survive one more committed turn; an entry edited by someone starts again. */
    private async countSurvival(index: number): Promise<void> {
        const canon = this.canon();
        if (!canon) return;
        let items: CanonItem[];
        try {
            items = await canon.list({ origin: 'living' });
        } catch {
            return;
        }
        const byUid = new Map(items.map((item) => [item.uid, item]));
        await this.store.mutate((doc) => {
            let changed = false;
            for (const fact of doc.facts) {
                if (fact.status !== 'provisional' || fact.uid === undefined || fact.sourceMessage >= index) continue;
                if (fact.countedTurn === index) continue;
                const item = byUid.get(fact.uid);
                if (!item) continue;
                const hash = entryHash(item.entry);
                if (fact.entryHash && hash !== fact.entryHash) {
                    fact.survivedTurns = 0;
                    fact.entryHash = hash;
                } else {
                    fact.survivedTurns++;
                }
                fact.countedTurn = index;
                changed = true;
            }
            return { changed, result: undefined };
        });
    }

    /* ---------------------------------------------------------------- adding facts */

    private async keysFor(name: string, extra: readonly string[] = []): Promise<string[]> {
        const api = this.desru();
        let forms: string[] = [];
        try {
            const list = api?.nameForms?.(name);
            forms = Array.isArray(list) ? uniqueStrings(list) : [];
            if (!forms.length) {
                const key = api?.nameFormsKey?.(name);
                if (typeof key === 'string' && key.trim()) forms = [key.trim()];
            }
        } catch (error) {
            this.log.debug('DES-RU name forms failed', error);
        }
        if (!forms.length) {
            try {
                forms = (await this.canon()?.russianKeys(name)) ?? [];
            } catch (error) {
                this.log.debug('canon russianKeys failed', error);
            }
            // The canon's key does not decline the words of a longer name («Празднике Фонарей»).
            const stems = stemRegexKey(name);
            if (stems) forms = [...forms, stems];
        }
        return mergeKeys(
            [name],
            [...forms, ...extra].filter((key) => !key.includes('{{')),
            MAX_KEYS,
        );
    }

    /**
     * The common road of a new name (reply, extraction, revision): extend a living fact it is another name of, skip
     * known and refused names, respect K, check contradictions, then autonomy ('living.fact', «Само») or the Inbox.
     */
    private async addCandidate(input: CandidateInput, budget: Budget, mode: CheckMode): Promise<AddOutcome> {
        const doc = (await this.store.load()) ?? null;
        const facts = this.liveFacts(doc);
        const names = [input.name, ...(input.variants ?? [])];
        const target =
            (input.mergeInto ? facts.find((fact) => fact.id === input.mergeInto) : undefined) ??
            this.similarFact(facts, input.name);
        if (target) {
            if (this.sameAsFact(target, names) && !input.mergeInto) return 'skipped';
            if (target.status === 'provisional') return (await this.mergeInto(target, input)) ? 'merged' : 'skipped';
            if (target.status === 'active') await this.conflictWithConfirmed(target, input.quote, input.sourceMessage);
            return 'skipped';
        }
        const refused = (doc?.facts ?? []).some(
            (fact) => fact.status === 'dropped' && fact.droppedBy === 'user' && similarNames(fact.name, input.name),
        );
        if (refused || budget.left <= 0) return 'skipped';
        const keys = await this.keysFor(input.name, [
            ...(input.variants ?? []),
            ...(input.english ? [input.english] : []),
        ]);
        const payload: CandidatePayload = {
            id: newId(),
            name: input.name,
            type: input.type,
            quote: input.quote,
            keys,
            sourceMessage: input.sourceMessage,
            stamp: input.stamp,
            origin: input.origin,
        };
        if (input.text) payload.text = input.text;
        if (input.english) payload.english = input.english;
        if (input.russian) payload.russian = input.russian;
        if (input.quote) payload.evidence = clip(input.quote, 300);
        const hits = await this.contradictionsOf(input.text ?? input.quote, input.name, undefined, mode);
        budget.left--;
        if (hits.length) {
            payload.conflict = this.describe(hits);
            await this.dispute({
                mode: 'new',
                candidate: payload,
                conflict: payload.conflict,
                against: againstOf(hits),
            });
            return 'disputed';
        }
        const decision = await this.decideInline(payload.id, () =>
            this.app.autonomy.decide<CandidatePayload>(this.factProposal(payload), 'auto'),
        );
        if (decision === 'applied') return 'added';
        if (decision === 'queued' || decision === 'notified') return 'queued';
        return 'skipped';
    }

    /** The fact in plain words: the model's Russian sentence, else «Традиция: Праздник урожая». */
    private statement(fact: { name: string; type: LivingType; russian?: string }): string {
        if (fact.russian?.trim()) return fact.russian.trim();
        return this.t('m26.statement', { type: this.typeName(fact.type, true), name: fact.name });
    }

    private typeName(type: LivingType, capital = false): string {
        const name = this.t(`m26.type.${type}`);
        return capital ? name.charAt(0).toUpperCase() + name.slice(1) : name;
    }

    /** Technical lines of a card: canon book, keys, the English canon text, the full contradiction. */
    private details(parts: { book?: string; keys?: readonly string[]; text?: string; conflict?: string }): string {
        const lines: string[] = [];
        if (parts.book) lines.push(this.t('m26.details.book', { book: parts.book }));
        if (parts.keys?.length) lines.push(this.t('m26.details.keys', { keys: parts.keys.join(', ') }));
        if (parts.text) lines.push(this.t('m26.details.text', { text: parts.text }));
        if (parts.conflict) lines.push(this.t('m26.details.conflict', { conflict: parts.conflict }));
        return lines.join('\n');
    }

    private factProposal(payload: CandidatePayload): Proposal<CandidatePayload> {
        const book = this.canon()?.bookName() ?? '';
        const statement = this.statement(payload);
        const what = payload.russian?.trim()
            ? bare(payload.russian)
            : this.t('m26.notice.what', { name: payload.name, type: this.typeName(payload.type) });
        const after: Record<string, unknown> = {
            name: payload.name,
            type: payload.type,
            quote: payload.quote,
            keys: payload.keys,
        };
        if (payload.russian) after.russian = payload.russian;
        return {
            module: LIVING_ID,
            kind: FACT_KIND,
            title: this.t('m26.proposal.fact', { name: payload.name }),
            description: this.t('m26.proposal.factBody', { statement }),
            details: this.details({ book, keys: payload.keys, text: payload.text }),
            appliedNotice: {
                text: this.t('m26.notice.captured', { what }),
                group: 'living.captured',
                groupText: (count) => tPlural(this.app.i18n, 'm26.notice.capturedMany', count),
            },
            changes: [{ target: FACT_TARGET, ref: { id: payload.id, book }, before: null, after }],
            payload,
            sourceMessage: payload.sourceMessage,
            apply: async (value) => {
                await this.applyLater(value.id, () => this.saveCandidate(value));
            },
            stillValid: async () => this.candidateValid(payload),
        };
    }

    private candidateValid(candidate: CandidatePayload): boolean {
        if (!this.stampValid(candidate.sourceMessage, candidate.stamp)) return false;
        const doc = this.store.peek();
        return !(doc?.facts ?? []).some((fact) => fact.id === candidate.id && fact.status !== 'dropped');
    }

    /** Writes a candidate into the canon as a provisional addition and records the fact. */
    private async saveCandidate(candidate: CandidatePayload): Promise<number> {
        const canon = this.canon();
        if (!canon) throw new Error(this.t('m26.error.noCanon'));
        if (!this.stampValid(candidate.sourceMessage, candidate.stamp)) throw new Error(this.t('m26.error.stale'));
        const existing = this.store.peek()?.facts.find((fact) => fact.id === candidate.id && fact.uid !== undefined);
        if (existing?.uid !== undefined && existing.status !== 'dropped') return existing.uid;
        const content = candidate.text
            ? englishContent({
                  name: candidate.name,
                  type: candidate.type,
                  english: candidate.english,
                  text: candidate.text,
              })
            : seedContent({ name: candidate.name, type: candidate.type, quote: candidate.quote });
        const entry = { comment: candidate.name, key: candidate.keys, content };
        // `livingId` ties the canon item to its fact (unknown meta fields are kept by the canon, canon-book.ts).
        const meta: CanonDraft['meta'] & { livingId: string } = {
            kind: 'addition',
            status: 'provisional',
            origin: 'living',
            type: canonTypeOf(candidate.type),
            sourceMessage: candidate.sourceMessage,
            survivedTurns: 0,
            livingId: candidate.id,
        };
        const uid = await canon.put({ entry, meta });
        const now = Date.now();
        await this.store.mutate((doc) => {
            if (!doc.facts.some((fact) => fact.id === candidate.id && fact.uid !== undefined)) {
                bumpStat(doc, 'provisional');
            }
            doc.facts = doc.facts.filter((fact) => fact.id !== candidate.id);
            for (const fact of doc.facts) if (fact.uid === uid && fact.status === 'dropped') delete fact.uid;
            const fact: FactData = {
                id: candidate.id,
                uid,
                name: candidate.name,
                type: candidate.type,
                quote: candidate.quote,
                quotes: [],
                keys: candidate.keys,
                sourceMessage: candidate.sourceMessage,
                stamp: candidate.stamp,
                status: 'provisional',
                survivedTurns: 0,
                createdAt: now,
                entryHash: entryHash(entry),
                origin: candidate.origin,
            };
            if (candidate.text) fact.text = candidate.text;
            if (candidate.english) fact.english = candidate.english;
            if (candidate.russian) fact.russian = candidate.russian;
            if (candidate.conflict) {
                fact.conflict = candidate.conflict;
                fact.dispute = 'kept';
            }
            doc.facts.push(fact);
            return { changed: true, result: undefined };
        });
        this.log.info(`living fact «${candidate.name}» saved as provisional canon #${uid}`);
        return uid;
    }

    /** Another name of a provisional fact: its keys and quotes grow (an entry edited by someone keeps its text). */
    private async mergeInto(fact: FactData, input: CandidateInput): Promise<boolean> {
        const canon = this.canon();
        if (!canon || fact.uid === undefined) return false;
        const item = (await canon.list({ origin: 'living' })).find((candidate) => candidate.uid === fact.uid);
        if (!item) return false;
        const added = await this.keysFor(input.name, input.variants ?? []);
        const keys = mergeKeys(strings(item.entry.key), added, MAX_KEYS);
        const next = { quote: fact.quote, quotes: [...fact.quotes] };
        const quoteAdded = addQuote(next, input.quote);
        const edited = !!fact.entryHash && entryHash(item.entry) !== fact.entryHash;
        const content =
            isSeedContent(item.entry.content) && !edited
                ? seedContent({ name: fact.name, type: fact.type, quote: next.quote, quotes: next.quotes })
                : contentOf(item);
        const keysChanged = keys.length !== strings(item.entry.key).length;
        if (!keysChanged && content === contentOf(item)) {
            if (!quoteAdded) return false;
            await this.store.mutate((doc) => {
                const live = doc.facts.find((candidate) => candidate.id === fact.id);
                if (live) live.quotes = next.quotes;
                return { changed: !!live, result: undefined };
            });
            return true;
        }
        const entry = { ...item.entry, key: keys, content };
        await canon.put({ entry, meta: draftMeta(item, { survivedTurns: fact.survivedTurns }) }, { uid: fact.uid });
        await this.store.mutate((doc) => {
            const live = doc.facts.find((candidate) => candidate.id === fact.id);
            if (!live) return { changed: false, result: undefined };
            live.keys = keys;
            live.quotes = next.quotes;
            if (!edited) live.entryHash = entryHash(entry);
            return { changed: true, result: undefined };
        });
        this.log.info(`living fact «${fact.name}» extended by «${input.name}»`);
        return true;
    }

    /* ---------------------------------------------------------------- contradictions */

    private async canonItems(): Promise<CanonItem[]> {
        try {
            return (await this.canon()?.list()) ?? [];
        } catch {
            return [];
        }
    }

    /** What a statement must not contradict: relevant canon items and the world model's facts of its entities. */
    private async contradictionInput(
        statement: string,
        name: string,
        excludeUid: number | undefined,
    ): Promise<ContradictionInput> {
        const index = indexText(statement);
        const entities: string[] = [name];
        const against: ContradictionInput['against'] = [];
        let mentioned: { id: string; name: string }[] = [];
        try {
            mentioned = (this.world()?.mentions(statement) ?? []).map((entity) => ({
                id: entity.id,
                name: entity.name,
            }));
        } catch (error) {
            this.log.debug('world mentions failed', error);
        }
        entities.push(...mentioned.map((entity) => entity.name));
        for (const item of await this.canonItems()) {
            if (item.uid === excludeUid || item.meta.status === 'archived') continue;
            const content = contentOf(item);
            if (!content.trim() || isSeedContent(content)) continue;
            const keys = [...strings(item.entry.key), commentOf(item)];
            if (!mentionsAny(index, keys) && !similarNames(commentOf(item), name)) continue;
            against.push({ label: commentOf(item), text: clip(content, 1500) });
            if (against.length >= MAX_AGAINST) break;
        }
        for (const entity of mentioned) {
            if (against.length >= MAX_AGAINST) break;
            try {
                for (const fact of (this.world()?.facts(entity.id) ?? []).slice(0, 4)) {
                    if (fact.source.kind === 'canon.entry') continue;
                    against.push({ label: `${entity.name}: ${fact.source.label}`, text: clip(fact.text, 600) });
                }
            } catch (error) {
                this.log.debug('world facts failed', error);
            }
        }
        return { statement, entities: uniqueStrings(entities), against: against.slice(0, MAX_AGAINST) };
    }

    /**
     * Contradictions of a statement. 'rules': quick() only (the commit path, P15). 'queued' (a user action) and
     * 'inline' (inside the extraction task, where a queued check would wait for this very task): check() — the rules,
     * then the cheap model when they are not sure — with a bounded wait; its failure leaves the rules' answer.
     * No contradictions service → nothing found.
     */
    private async contradictionsOf(
        statement: string,
        name: string,
        excludeUid: number | undefined,
        mode: CheckMode,
        input?: ContradictionInput,
    ): Promise<Contradiction[]> {
        const api = this.contradictions();
        if (!api || !statement.trim()) return [];
        const request = input ?? (await this.contradictionInput(statement, name, excludeUid));
        if (!request.against.length) return [];
        let hits: Contradiction[];
        try {
            hits = api.quick(request);
        } catch (error) {
            this.log.warn('contradiction rules failed', error);
            return [];
        }
        if (mode === 'rules' || typeof api.check !== 'function' || !this.app.leader.isLeader()) return hits;
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            const timeout = new Promise<null>((resolve) => {
                timer = setTimeout(() => resolve(null), CHECK_TIMEOUT_MS);
            });
            const options = { inline: mode === 'inline', timeoutMs: CHECK_TIMEOUT_MS - 5000 };
            const result = await Promise.race([api.check(request, options), timeout]);
            if (!result) return hits;
            return result.clean ? [] : result.contradictions;
        } catch (error) {
            this.log.warn('contradiction check failed; the rules decide', error);
            return hits;
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private describe(hits: readonly Contradiction[]): string {
        return hits
            .slice(0, 3)
            .map((hit) =>
                this.t('m26.conflict.line', { label: hit.label, statement: hit.statement, other: hit.conflicting }),
            )
            .join('\n');
    }

    /** Sends a disputed proposal through autonomy kind 'living.disputed' (the Inbox by default, §8). */
    private async dispute(payload: DisputedPayload): Promise<void> {
        const key = payload.mode === 'new' ? payload.candidate.id : payload.id;
        const name =
            payload.mode === 'new'
                ? payload.candidate.name
                : (this.store.peek()?.facts.find((fact) => fact.id === payload.id)?.name ?? '');
        const quote =
            payload.mode === 'new'
                ? payload.candidate.quote
                : payload.mode === 'conflict'
                  ? payload.quote
                  : (this.store.peek()?.facts.find((fact) => fact.id === payload.id)?.quote ?? '');
        const sourceMessage =
            payload.mode === 'new'
                ? payload.candidate.sourceMessage
                : payload.mode === 'conflict'
                  ? payload.sourceMessage
                  : this.store.peek()?.facts.find((fact) => fact.id === payload.id)?.sourceMessage;
        const book = this.canon()?.bookName() ?? '';
        const known =
            payload.mode === 'new' ? undefined : this.store.peek()?.facts.find((fact) => fact.id === payload.id);
        const subject = payload.mode === 'new' ? payload.candidate : known;
        const after: Record<string, unknown> = { name, quote };
        if (payload.mode === 'new') {
            after.type = payload.candidate.type;
            after.keys = payload.candidate.keys;
            if (payload.candidate.russian) after.russian = payload.candidate.russian;
        }
        const changes: JournalChange[] =
            payload.mode === 'new'
                ? [{ target: FACT_TARGET, ref: { id: payload.candidate.id, book }, before: null, after }]
                : [];
        await this.store.mutate((doc) => {
            if (payload.mode === 'new') {
                const candidate = payload.candidate;
                doc.facts = doc.facts.filter((fact) => fact.id !== candidate.id);
                const fact: FactData = {
                    id: candidate.id,
                    name: candidate.name,
                    type: candidate.type,
                    quote: candidate.quote,
                    quotes: [],
                    keys: candidate.keys,
                    sourceMessage: candidate.sourceMessage,
                    stamp: candidate.stamp,
                    status: 'disputed',
                    survivedTurns: 0,
                    createdAt: Date.now(),
                    conflict: payload.conflict,
                    dispute: 'pending',
                    origin: candidate.origin,
                };
                if (candidate.text) fact.text = candidate.text;
                if (candidate.english) fact.english = candidate.english;
                if (candidate.russian) fact.russian = candidate.russian;
                doc.facts.push(fact);
                return { changed: true, result: undefined };
            }
            const fact = doc.facts.find((item) => item.id === payload.id);
            if (!fact) return { changed: false, result: undefined };
            fact.conflict = payload.conflict;
            fact.dispute = 'pending';
            if (payload.mode === 'conflict') countContradicted(doc, fact);
            return { changed: true, result: undefined };
        });
        const titleKey = {
            new: 'm26.proposal.disputed',
            existing: 'm26.proposal.existing',
            conflict: 'm26.proposal.conflict',
        }[payload.mode];
        const against = payload.against?.length ? payload.against.join(', ') : this.t('m26.against.unknown');
        const description = this.t(`m26.proposal.${payload.mode}Body`, {
            statement: subject ? this.statement(subject) : name,
            name,
            against,
        });
        if (quote) payload.evidence = clip(quote, 300);
        const proposal: Proposal<DisputedPayload> = {
            module: LIVING_ID,
            kind: DISPUTED_KIND,
            title: this.t(titleKey, { name }),
            description,
            details: this.details({
                book,
                keys: payload.mode === 'new' ? payload.candidate.keys : undefined,
                text: subject?.text,
                conflict: payload.conflict,
            }),
            changes,
            payload,
            apply: (value) => this.applyLater(key, () => this.acceptDisputed(value)),
            stillValid: async () => this.disputedValid(payload),
        };
        if (sourceMessage !== undefined && sourceMessage >= 0) proposal.sourceMessage = sourceMessage;
        const decision = await this.decideInline(key, () =>
            this.app.autonomy.decide<DisputedPayload>(proposal, 'inbox'),
        );
        if (decision === 'skipped' || decision === 'rejected') {
            this.log.info(`disputed living fact «${name}»: ${decision}`);
        }
    }

    private disputedValid(payload: DisputedPayload): boolean {
        const doc = this.store.peek();
        if (payload.mode === 'new') {
            const fact = doc?.facts.find((item) => item.id === payload.candidate.id);
            return (
                this.stampValid(payload.candidate.sourceMessage, payload.candidate.stamp) &&
                (!fact || fact.status === 'disputed')
            );
        }
        const fact = doc?.facts.find((item) => item.id === payload.id);
        if (!fact || fact.uid !== payload.uid) return false;
        return payload.mode === 'existing' ? fact.status === 'provisional' : fact.status === 'active';
    }

    /**
     * Accepting a disputed card: a new fact is saved as provisional (it keeps the conflict note and is not offered
     * again); an existing provisional one stays provisional; a conflicting confirmed entry takes the new statement as
     * a provisional seed (the user decided the story is right), to be re-extracted and re-confirmed.
     */
    private async acceptDisputed(payload: DisputedPayload): Promise<void> {
        if (payload.mode === 'new') {
            await this.saveCandidate({ ...payload.candidate, conflict: payload.conflict });
            return;
        }
        if (payload.mode === 'existing') {
            await this.store.mutate((doc) => {
                const fact = doc.facts.find((item) => item.id === payload.id);
                if (!fact) return { changed: false, result: undefined };
                fact.dispute = 'kept';
                return { changed: true, result: undefined };
            });
            return;
        }
        const canon = this.canon();
        if (!canon) throw new Error(this.t('m26.error.noCanon'));
        const item = (await canon.list({ origin: 'living' })).find((candidate) => candidate.uid === payload.uid);
        const fact = this.store.peek()?.facts.find((candidate) => candidate.id === payload.id);
        if (!item || !fact) throw new Error(this.t('m26.error.stale'));
        const content = seedContent({ name: fact.name, type: fact.type, quote: payload.quote });
        const entry = { ...item.entry, content };
        await canon.put(
            { entry, meta: draftMeta(item, { status: 'provisional', survivedTurns: 0 }) },
            { uid: payload.uid },
        );
        await this.store.mutate((doc) => {
            const live = doc.facts.find((candidate) => candidate.id === payload.id);
            if (!live) return { changed: false, result: undefined };
            live.status = 'provisional';
            live.quote = payload.quote;
            live.quotes = [];
            live.survivedTurns = 0;
            live.entryHash = entryHash(entry);
            delete live.text;
            delete live.confirmedBy;
            delete live.confirmedAt;
            delete live.dispute;
            delete live.conflict;
            return { changed: true, result: undefined };
        });
    }

    /** Rejecting a disputed card: a new or existing provisional fact goes; a confirmed entry stays as it is. */
    private async rejectDisputed(payload: DisputedPayload): Promise<void> {
        if (payload.mode === 'conflict') {
            await this.store.mutate((doc) => {
                const fact = doc.facts.find((item) => item.id === payload.id);
                if (!fact) return { changed: false, result: undefined };
                fact.dispute = 'kept';
                return { changed: true, result: undefined };
            });
            return;
        }
        if (payload.mode === 'existing') {
            await this.dropFact(payload.id, 'user');
            return;
        }
        await this.store.mutate((doc) => ({
            changed: markDropped(doc, [payload.candidate.id], 'user') > 0,
            result: undefined,
        }));
    }

    /** A reply says something about a confirmed fact that its entry contradicts: Inbox card (never overwritten). */
    private async conflictWithConfirmed(fact: FactData, statement: string, sourceMessage: number): Promise<void> {
        if (fact.uid === undefined || fact.dispute || !statement.trim()) return;
        const item = (await this.canonItems()).find((candidate) => candidate.uid === fact.uid);
        const content = contentOf(item);
        if (!item || !content.trim()) return;
        const input: ContradictionInput = {
            statement,
            entities: [fact.name],
            against: [{ label: fact.name, text: clip(content, 1500) }],
        };
        const hits = await this.contradictionsOf(statement, fact.name, undefined, 'rules', input);
        if (!hits.length) return;
        await this.dispute({
            mode: 'conflict',
            id: fact.id,
            uid: fact.uid,
            quote: statement,
            sourceMessage,
            conflict: this.describe(hits),
            against: againstOf(hits),
        });
    }

    /** Confirmed facts mentioned again in the committed reply: a contradicting statement goes to the Inbox. */
    private async checkConfirmedConflicts(index: number): Promise<void> {
        const reply = this.textOf(index);
        if (!reply) return;
        const facts = (this.store.peek()?.facts ?? []).filter(
            (fact) => fact.status === 'active' && fact.uid !== undefined && fact.sourceMessage < index && !fact.dispute,
        );
        for (const fact of facts) {
            const hits = [fact.name, ...fact.keys]
                .filter((term) => !term.startsWith('/'))
                .flatMap((term) => findName(reply, term));
            const first = hits.sort((a, b) => a - b)[0];
            if (first === undefined) continue;
            const sentence = quoteAround(reply.text, reply.offsets[first] ?? 0);
            await this.conflictWithConfirmed(fact, sentence, index);
        }
    }

    /* ---------------------------------------------------------------- confirmation (plan M26 п. 4) */

    private async confirmPass(index: number): Promise<void> {
        const canon = this.canon();
        const doc = this.store.peek();
        if (!canon || !doc) return;
        const book = canon.bookName();
        const reply = this.textOf(index);
        const users: TextIndex[] = [];
        const chat = this.chat();
        for (let i = index + 1; i < chat.length; i++) {
            if (!chat[i]?.is_user) continue;
            const text = this.textOf(i);
            if (text) users.push(text);
        }
        const lore = this.loreRecord(index);
        const surviveTurns = Math.max(0, Math.floor(this.settings().surviveTurns));
        for (const fact of doc.facts) {
            if (fact.status !== 'provisional' || fact.uid === undefined) continue;
            const terms = this.termsOf(fact);
            const userMentioned = users.some((text) => mentionsAny(text, terms));
            const resurfaced =
                fact.sourceMessage < index &&
                !!lore &&
                !!reply &&
                mentionsAny(reply, terms) &&
                !entryInPrompt(lore, book, fact.uid);
            const survived = surviveTurns > 0 && fact.survivedTurns >= surviveTurns;
            if (!userMentioned && !resurfaced && !survived) continue;
            const hits = await this.contradictionsOf(fact.text ?? fact.quote, fact.name, fact.uid, 'rules');
            const reason = confirmReason({
                userMentioned,
                userAccepted: false,
                resurfaced,
                survivedTurns: fact.survivedTurns,
                surviveTurns,
                clean: !hits.length,
            });
            if (reason) {
                await this.confirm(fact, reason);
                continue;
            }
            const conflict = this.describe(hits);
            if (survived && !fact.dispute) {
                await this.dispute({
                    mode: 'existing',
                    id: fact.id,
                    uid: fact.uid,
                    conflict,
                    against: againstOf(hits),
                });
            } else if (fact.conflict !== conflict) {
                await this.store.mutate((next) => {
                    const live = next.facts.find((item) => item.id === fact.id);
                    if (!live) return { changed: false, result: undefined };
                    live.conflict = conflict;
                    return { changed: true, result: undefined };
                });
            }
        }
    }

    private termsOf(fact: FactData): string[] {
        return uniqueStrings([fact.name, ...fact.keys, ...(fact.english ? [fact.english] : [])]);
    }

    /** Activations of the canon book in the prompt of the turn that produced `index` (M1), or null when unknown. */
    private loreRecord(index: number): { world: string; uid: number; cut?: boolean }[] | null {
        try {
            const turns = this.lore()?.turns() ?? [];
            for (let i = turns.length - 1; i >= 0; i--) {
                const turn = turns[i];
                if (turn && turn.messageIndex === index && !turn.simulated) return turn.activations;
            }
        } catch (error) {
            this.log.debug('lore journal is not available', error);
        }
        return null;
    }

    private async confirm(fact: FactData, reason: ConfirmReasonId): Promise<void> {
        const canon = this.canon();
        if (!canon || fact.uid === undefined) return;
        await canon.setStatus(fact.uid, 'active');
        await this.store.mutate((doc) => {
            const live = doc.facts.find((item) => item.id === fact.id);
            if (!live) return { changed: false, result: undefined };
            live.status = 'active';
            live.confirmedBy = reason;
            live.confirmedAt = Date.now();
            delete live.conflict;
            countConfirmed(doc, live);
            return { changed: true, result: undefined };
        });
        this.log.info(`living fact «${fact.name}» confirmed (${reason})`);
        // The user's own «Подтвердить» needs no toast; the story confirming a fact by itself is news (plan-2 §5).
        if (reason !== 'userAccepted') {
            this.app.ui.notice(
                this.t('m26.notice.confirmed', { name: fact.name, reason: this.t(`m26.reason.${reason}`) }),
                {
                    group: 'living.confirmed',
                    groupText: (count) => tPlural(this.app.i18n, 'm26.notice.confirmedMany', count),
                },
            );
        }
    }

    /** Provisional facts that left the canon because their reply changed: one calm notice per turn. */
    private announceDropped(names: readonly string[], reason: 'swiped' | 'deleted' | 'edited'): void {
        for (const name of names) {
            this.app.ui.notice(this.t(`m26.notice.dropped.${reason}`, { name }), {
                group: 'living.dropped',
                groupText: (count) => tPlural(this.app.i18n, 'm26.notice.droppedMany', count),
            });
        }
    }

    /* ---------------------------------------------------------------- invalidation (§5 «Отмена») */

    private async onInvalidated(index: number, reason: 'swiped' | 'deleted' | 'edited'): Promise<void> {
        if (reason === 'deleted') {
            await this.onDeleted(index);
            return;
        }
        const hit = (source: number) => source === index;
        this.memoryDrafts = this.memoryDrafts.filter((draft) => !hit(draft.sourceMessage));
        if (!this.active() || !this.app.leader.isLeader()) {
            this.emit();
            return;
        }
        const doc = await this.store.load();
        if (!doc) return;
        const plan = invalidationPlan(doc, index, reason);
        const canon = this.canon();
        const removed: string[] = [];
        const names: string[] = [];
        for (const fact of plan.provisional) {
            if (fact.uid === undefined || !canon) continue;
            try {
                await canon.remove(fact.uid);
                removed.push(fact.id);
                names.push(fact.name);
            } catch (error) {
                this.log.warn(`provisional fact «${fact.name}» was not removed`, error);
            }
        }
        await this.store.mutate((next) => {
            const drafts = next.drafts.length;
            next.drafts = next.drafts.filter((draft) => !hit(draft.sourceMessage));
            const commits = next.committed.length;
            next.committed = next.committed.filter((item) => !hit(item.index));
            const dropped = markDropped(next, [...removed, ...plan.disputed.map((fact) => fact.id)], 'invalidated');
            const changed = dropped > 0 || drafts !== next.drafts.length || commits !== next.committed.length;
            return { changed, result: undefined };
        });
        if (removed.length) {
            this.log.info(`${removed.length} provisional fact(s) of message ${index} removed (${reason})`);
            this.announceDropped(names, reason);
        }
        this.emit();
    }

    /**
     * ST reports a deletion with the new chat length only; deleting a message in the middle shifts the later ones.
     * Drafts, facts and commit records follow their message by its fingerprint; what lost its message goes like a
     * swiped reply (provisional facts leave the canon, confirmed ones stay).
     */
    private async onDeleted(length: number): Promise<void> {
        const stamps = this.chat().map((message) => messageStamp(message));
        const where = (source: number, stamp: string) => relocate(stamps, source, stamp, length);
        this.memoryDrafts = this.memoryDrafts.flatMap((draft) => {
            const at = where(draft.sourceMessage, draft.stamp);
            return at === null ? [] : [{ ...draft, sourceMessage: at }];
        });
        if (!this.active() || !this.app.leader.isLeader()) {
            this.emit();
            return;
        }
        const doc = await this.store.load();
        if (!doc) return;
        const canon = this.canon();
        const removed: string[] = [];
        const names: string[] = [];
        for (const fact of doc.facts) {
            if (fact.status !== 'provisional' || fact.uid === undefined || !canon) continue;
            if (where(fact.sourceMessage, fact.stamp) !== null) continue;
            try {
                await canon.remove(fact.uid);
                removed.push(fact.id);
                names.push(fact.name);
            } catch (error) {
                this.log.warn(`provisional fact «${fact.name}» was not removed`, error);
            }
        }
        await this.store.mutate((next) => {
            let changed = false;
            const drafts: DraftData[] = [];
            for (const draft of next.drafts) {
                const at = where(draft.sourceMessage, draft.stamp);
                changed ||= at !== draft.sourceMessage;
                if (at !== null) drafts.push({ ...draft, sourceMessage: at });
            }
            next.drafts = drafts;
            const committed: LivingDocData['committed'] = [];
            for (const item of next.committed) {
                const at = where(item.index, item.stamp);
                changed ||= at !== item.index;
                if (at !== null) committed.push({ ...item, index: at });
            }
            next.committed = committed;
            const gone: string[] = [...removed];
            for (const fact of next.facts) {
                if (fact.status === 'dropped' || fact.sourceMessage < 0) continue;
                const at = where(fact.sourceMessage, fact.stamp);
                if (at === null) {
                    if (fact.status === 'disputed') gone.push(fact.id);
                    continue;
                }
                if (at !== fact.sourceMessage) {
                    fact.sourceMessage = at;
                    changed = true;
                }
            }
            if (markDropped(next, gone, 'invalidated') > 0) changed = true;
            return { changed, result: undefined };
        });
        if (removed.length) {
            this.log.info(`${removed.length} provisional fact(s) removed: their messages were deleted`);
            this.announceDropped(names, 'deleted');
        }
        this.emit();
    }

    /* ---------------------------------------------------------------- signals and proposals from other modules */

    private async fromSignal(signal: Signal): Promise<boolean> {
        const data = signal.data ?? {};
        const sourceMessage =
            typeof data.sourceMessage === 'number' ? data.sourceMessage : (signal.messageIndex ?? Number.NaN);
        return this.propose({
            name: typeof data.name === 'string' ? data.name : '',
            quote: typeof data.quote === 'string' ? data.quote : '',
            sourceMessage,
            ...(typeof data.type === 'string' ? { type: data.type } : {}),
            ...(typeof data.text === 'string' ? { text: data.text } : {}),
        });
    }

    async propose(fact: LivingProposal): Promise<boolean> {
        return this.serial(async () => {
            if (!this.active() || !this.app.leader.isLeader() || !this.canon()) return false;
            const name = typeof fact.name === 'string' ? fact.name.trim() : '';
            const quote = typeof fact.quote === 'string' ? fact.quote.trim() : '';
            const source = fact.sourceMessage;
            if (!name || !quote || !Number.isInteger(source) || source < 0 || source > this.committedIndex())
                return false;
            const message = this.chat()[source];
            if (!this.isReply(message)) return false;
            const { known } = await this.knownNames();
            if (isKnownName(known, name)) return false;
            const doc = await this.store.load();
            const k = Math.max(0, Math.floor(this.settings().maxPerTurn));
            const budget: Budget = { left: k - (doc ? factsFrom(doc, source).length : 0) };
            const outcome = await this.addCandidate(
                {
                    name,
                    type: isLivingType(fact.type) ? fact.type : guessType(name, quote),
                    quote,
                    sourceMessage: source,
                    stamp: messageStamp(message),
                    origin: 'revision',
                    // Canon text is English (P6); anything else stays out and the extraction writes it later.
                    ...(typeof fact.text === 'string' && isEnglishText(fact.text.trim())
                        ? { text: fact.text.trim() }
                        : {}),
                    ...(typeof fact.russian === 'string' && fact.russian.trim()
                        ? { russian: fact.russian.trim() }
                        : {}),
                },
                budget,
                'rules',
            );
            this.emit();
            return outcome !== 'skipped';
        });
    }

    /* ---------------------------------------------------------------- user actions */

    accept(uid: number): Promise<boolean> {
        return this.serial(async () => {
            const fact = this.store.peek()?.facts.find((item) => item.uid === uid && item.status === 'provisional');
            if (!fact) return false;
            const hits = await this.contradictionsOf(fact.text ?? fact.quote, fact.name, uid, 'queued');
            if (hits.length) {
                const conflict = this.describe(hits);
                await this.store.mutate((doc) => {
                    const live = doc.facts.find((item) => item.id === fact.id);
                    if (!live) return { changed: false, result: undefined };
                    live.conflict = conflict;
                    return { changed: true, result: undefined };
                });
                // A reply to the user's own click: always shown.
                this.app.ui.notice(
                    this.t('m26.accept.conflict', { name: fact.name, against: againstOf(hits).join(', ') }),
                    { level: 'warn', urgent: true },
                );
                return false;
            }
            await this.confirm(fact, 'userAccepted');
            this.app.autonomy.record(FACT_KIND, 'accepted');
            this.emit();
            return true;
        });
    }

    /** «Принять все пробные»: accepts each provisional fact; returns how many were confirmed and blocked. */
    async acceptAll(): Promise<{ confirmed: number; blocked: number }> {
        const uids = this.provisional()
            .map((fact) => fact.uid)
            .filter((uid): uid is number => uid !== undefined);
        let confirmed = 0;
        for (const uid of uids) if (await this.accept(uid)) confirmed++;
        return { confirmed, blocked: uids.length - confirmed };
    }

    drop(uid: number): Promise<void> {
        return this.serial(async () => {
            const fact = this.store.peek()?.facts.find((item) => item.uid === uid && item.status !== 'dropped');
            if (!fact) return;
            await this.dropFact(fact.id, 'user');
            this.app.autonomy.record(FACT_KIND, 'rejected');
            this.emit();
        });
    }

    /** Drops a fact by id (disputed ones have no uid). */
    dropById(id: string): Promise<void> {
        return this.serial(async () => {
            await this.dropFact(id, 'user');
            this.emit();
        });
    }

    private async dropFact(id: string, reason: 'user' | 'undone'): Promise<void> {
        const fact = this.store.peek()?.facts.find((item) => item.id === id);
        if (!fact || fact.status === 'dropped') return;
        if (fact.uid !== undefined && (fact.status === 'provisional' || fact.status === 'active')) {
            await this.canon()?.remove(fact.uid);
        }
        await this.store.mutate((doc) => {
            const dropped = markDropped(doc, [id], reason) > 0;
            if (dropped && reason === 'user') bumpStat(doc, 'droppedByUser');
            return { changed: dropped, result: undefined };
        });
    }

    /** Journal undo of a fact added through autonomy or the Inbox: the canon entry goes, the fact is dropped. */
    private async undoFact(change: JournalChange): Promise<boolean> {
        const id = change.ref.id;
        if (typeof id !== 'string') return false;
        await this.store.load();
        await this.serial(() => this.dropFact(id, 'undone'));
        this.emit();
        return true;
    }

    /* ---------------------------------------------------------------- batch extraction */

    private async maybeExtract(index: number): Promise<void> {
        const every = Math.max(0, Math.floor(this.settings().extractEvery));
        const doc = this.store.peek();
        if (!every || !doc || !this.app.leader.isLeader()) return;
        const mark = Math.max(doc.extract.upTo, doc.extract.attemptAt);
        if (index - mark < every || !this.app.llm.available(EXTRACT_TASK)) return;
        await this.enqueueExtraction(Math.max(doc.extract.upTo + 1, index - EXTRACT_WINDOW + 1), index, false);
    }

    private async enqueueExtraction(from: number, to: number, manual: boolean): Promise<void> {
        await this.app.tasks.enqueue({
            kind: EXTRACT_TASK,
            dedupeKey: 'extract',
            payload: { from: Math.max(0, from), to, manual },
            ttlMs: EXTRACT_TTL_MS,
        });
    }

    async extractNow(): Promise<void> {
        if (!this.active()) return;
        const doc = await this.store.load();
        const to = this.committedIndex();
        const from = Math.max((doc?.extract.upTo ?? -1) + 1, to - EXTRACT_WINDOW + 1);
        await this.enqueueExtraction(from, to, true);
        this.app.tasks.kick();
    }

    /** Messages of the range for the request: committed replies only, newest kept when over the budget. */
    private extractSources(from: number, to: number): { index: number; text: string }[] {
        const chat = this.chat();
        const out: { index: number; text: string }[] = [];
        let size = 0;
        for (let i = Math.min(to, chat.length - 1); i >= Math.max(0, from); i--) {
            if (!this.isReply(chat[i])) continue;
            const text = cleanForAnalysis(chat[i]);
            if (!text) continue;
            if (size + text.length > EXTRACT_CHARS && out.length) break;
            size += text.length;
            out.unshift({ index: i, text });
        }
        return out;
    }

    private async finishExtraction(
        to: number,
        result: { error?: string; added?: number; updated?: number },
    ): Promise<void> {
        await this.store.mutate((doc) => {
            doc.extract.attemptAt = Math.max(doc.extract.attemptAt, to);
            doc.extract.lastRun = Date.now();
            if (result.error) {
                doc.extract.lastError = result.error;
            } else {
                doc.extract.upTo = Math.max(doc.extract.upTo, to);
                delete doc.extract.lastError;
                doc.extract.added = result.added ?? 0;
                doc.extract.updated = result.updated ?? 0;
            }
            return { changed: true, result: undefined };
        });
        this.emit();
    }

    private async runExtraction(payload: Record<string, unknown>, info: TaskInfo): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!this.active() || (info.chatId && info.chatId !== chatId)) return;
        const canon = this.canon();
        if (!canon) return;
        const committed = this.committedIndex();
        const to = Math.min(typeof payload.to === 'number' ? payload.to : committed, committed);
        const from = typeof payload.from === 'number' ? payload.from : to - EXTRACT_WINDOW + 1;
        const doc = await this.store.load();
        if (!doc) return;
        if (!this.app.llm.available(EXTRACT_TASK)) {
            await this.finishExtraction(to, { error: 'unavailable' });
            return;
        }
        const items = await canon.list({ origin: 'living' });
        const byUid = new Map(items.map((item) => [item.uid, item]));
        const needsText = doc.facts.filter((fact) => {
            if (fact.uid === undefined || (fact.status !== 'provisional' && fact.status !== 'active')) return false;
            const item = byUid.get(fact.uid);
            if (!item || (fact.entryHash && entryHash(item.entry) !== fact.entryHash)) return false;
            return fact.status === 'provisional'
                ? !fact.text || isSeedContent(item.entry.content)
                : isSeedContent(item.entry.content);
        });
        const provisional = needsText.slice(0, EXTRACT_PROVISIONAL);
        const sources = this.extractSources(from, to);
        if (!sources.length && !provisional.length) {
            await this.finishExtraction(to, { added: 0, updated: 0 });
            return;
        }
        const { known, names } = await this.knownNames();
        const facts = this.liveFacts(doc);
        const k = Math.max(0, Math.floor(this.settings().maxPerTurn));
        const response = await this.app.llm.request<unknown>({
            task: EXTRACT_TASK,
            messages: buildExtractMessages({
                messages: sources,
                provisional: provisional.map((fact) => ({
                    uid: fact.uid as number,
                    name: fact.name,
                    type: fact.type,
                    quotes: [fact.quote, ...fact.quotes],
                })),
                known: names,
                max: k,
            }),
            maxTokens: EXTRACT_MAX_TOKENS,
            temperature: 0.2,
            schema: { name: 'living_canon', schema: EXTRACT_SCHEMA },
        });
        if (!response.ok) {
            this.log.warn(`living canon extraction failed: ${response.error ?? 'unknown error'}`);
            await this.finishExtraction(to, { error: response.refusal ? 'refusal' : (response.error ?? 'failed') });
            return;
        }
        const result = parseExtraction(response.data ?? response.text, {
            uids: provisional.map((fact) => fact.uid as number),
            messages: new Map(sources.map((source) => [source.index, source.text])),
            known: (name) => isKnownName(known, name) || !!this.similarFact(facts, name),
            max: k,
        });
        if (!result) {
            this.log.warn('living canon extraction: the answer is not the expected JSON');
            await this.finishExtraction(to, { error: 'parse' });
            return;
        }
        for (const item of result.rejected) this.log.debug('extraction item dropped', item.reason, item.item);
        let updated = 0;
        for (const update of result.updates) {
            if (await this.applyUpdate(update, byUid)) updated++;
        }
        let added = 0;
        const budgets = new Map<number, Budget>();
        for (const fact of result.facts) {
            const budget = budgets.get(fact.message) ?? {
                left: k - factsFrom(this.store.peek() ?? doc, fact.message).length,
            };
            budgets.set(fact.message, budget);
            if ((await this.addExtracted(fact, budget)) !== 'skipped') added++;
        }
        await this.finishExtraction(to, { added, updated });
    }

    /** English text for a provisional fact (or a confirmed one still carrying the seed); user edits are kept. */
    private async applyUpdate(update: ExtractUpdate, byUid: Map<number, CanonItem>): Promise<boolean> {
        const canon = this.canon();
        const fact = this.store.peek()?.facts.find((item) => item.uid === update.uid && item.status !== 'dropped');
        const item = byUid.get(update.uid);
        if (!canon || !fact || !item) return false;
        if (update.duplicateOf) {
            if (fact.status !== 'provisional') return false;
            await canon.remove(update.uid);
            await this.store.mutate((doc) => ({
                changed: markDropped(doc, [fact.id], 'duplicate') > 0,
                result: undefined,
            }));
            this.log.info(`living fact «${fact.name}» is «${update.duplicateOf}»; removed`);
            this.app.ui.notice(this.t('m26.notice.duplicate', { name: fact.name, other: update.duplicateOf }), {
                group: 'living.duplicate',
            });
            return true;
        }
        if (fact.entryHash && entryHash(item.entry) !== fact.entryHash) return false;
        const name =
            update.name && distinctiveStems(update.name).length && similarNames(update.name, fact.name)
                ? update.name
                : fact.name;
        const type = update.type && update.type !== 'other' ? update.type : fact.type;
        const extra = [
            ...(name !== fact.name ? await this.keysFor(name) : []),
            ...(update.english ? [update.english] : []),
        ];
        const keys = mergeKeys(strings(item.entry.key), extra, MAX_KEYS);
        const content = englishContent({ name, type, english: update.english, text: update.text });
        const entry = { ...item.entry, comment: name, key: keys, content };
        await canon.put(
            { entry, meta: draftMeta(item, { type: canonTypeOf(type), survivedTurns: fact.survivedTurns }) },
            { uid: update.uid },
        );
        await this.store.mutate((doc) => {
            const live = doc.facts.find((candidate) => candidate.id === fact.id);
            if (!live) return { changed: false, result: undefined };
            live.text = update.text;
            if (update.english) live.english = update.english;
            if (update.russian) live.russian = update.russian;
            live.name = name;
            live.type = type;
            live.keys = keys;
            live.entryHash = entryHash(entry);
            return { changed: true, result: undefined };
        });
        return true;
    }

    private async addExtracted(fact: ExtractFact, budget: Budget): Promise<AddOutcome> {
        const message = this.chat()[fact.message];
        if (!this.isReply(message)) return 'skipped';
        const outcome = await this.addCandidate(
            {
                name: fact.name,
                type: fact.type,
                quote: fact.quote,
                sourceMessage: fact.message,
                stamp: messageStamp(message),
                origin: 'extract',
                text: fact.text,
                ...(fact.english ? { english: fact.english } : {}),
                ...(fact.russian ? { russian: fact.russian } : {}),
            },
            budget,
            'inline',
        );
        return outcome;
    }

    /* ---------------------------------------------------------------- API views */

    private view(fact: FactData): LivingFact {
        const view: LivingFact = {
            name: fact.name,
            type: fact.type,
            quote: fact.quote,
            keys: [...fact.keys],
            sourceMessage: fact.sourceMessage,
            status: fact.status,
            survivedTurns: fact.survivedTurns,
        };
        if (fact.uid !== undefined) view.uid = fact.uid;
        if (fact.text) view.text = fact.text;
        if (fact.confirmedBy) view.confirmedBy = fact.confirmedBy;
        return view;
    }

    drafts(): LivingFact[] {
        const drafts = this.app.leader.isLeader()
            ? (this.store.peek()?.drafts ?? this.memoryDrafts)
            : this.memoryDrafts;
        return drafts.map((draft) => ({
            name: draft.name,
            type: draft.type,
            quote: draft.quote,
            keys: [],
            sourceMessage: draft.sourceMessage,
            status: 'draft',
            survivedTurns: 0,
        }));
    }

    /** Raw drafts (the pult shows which living fact a draft extends). */
    draftRecords(): DraftData[] {
        return this.app.leader.isLeader() ? (this.store.peek()?.drafts ?? this.memoryDrafts) : this.memoryDrafts;
    }

    provisional(): LivingFact[] {
        return (this.store.peek()?.facts ?? [])
            .filter((fact) => fact.status === 'provisional' && fact.uid !== undefined)
            .map((fact) => this.view(fact));
    }

    facts(): LivingFact[] {
        return this.liveFacts(this.store.peek()).map((fact) => this.view(fact));
    }

    /** The document's facts (pult). */
    records(): FactData[] {
        return this.store.peek()?.facts ?? [];
    }

    /** Counters for the R3 metrics (since the chat started using M26). */
    stats(): LivingStats {
        return { ...(this.store.peek()?.stats ?? emptyStats()) };
    }

    /** Confirmed facts, newest confirmation first (pult). */
    confirmedRecords(limit = 10): FactData[] {
        const doc = this.store.peek();
        return doc ? recentlyConfirmed(doc, limit) : [];
    }

    extractState(): LivingDocData['extract'] | null {
        return this.store.peek()?.extract ?? null;
    }
}
