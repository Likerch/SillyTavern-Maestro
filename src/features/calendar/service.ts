// Calendar service (plan M17, M8 routing «Договорённость, срок → календарь», M14 п.3; P14, P15):
// - story time: after every committed reply (turn:committed, a moment after the send — never on the send path) the
//   DES tracker's date and time move a per-chat story clock (src/domain/calendar-time: real dates, «Day N», fantasy
//   calendars by label changes, clock wraps); the clock of every turn is kept so a promise found later is placed in
//   the story time of its own message;
// - promises: the revision's deferred cards 'deferred.promise' (the backlog of stages 4–8 too) and, from this stage,
//   its direct route (intake()) become promises with a deadline read from the statement or the quote; a statement
//   that a promise was kept, broken or called off closes the known one;
// - statuses open → due → overdue are recomputed on every committed turn; transitions go to app.bus as signals
//   'promise.due' / 'promise.overdue' (data.source 'calendar': the signals service ignores them, the director reads
//   due() and the overdue list directly);
// - everything lives in the chat document 'calendar' (compare-and-swap); background writes (turns, intake,
//   invalidation) only in the leader tab, the user's own actions in any tab.
import { adaptersOf } from '../../adapters';
import {
    cleanStatement,
    evaluatePromise,
    findPromiseMatch,
    isActive,
    isPromiseState,
    promiseOutcome,
    samePromise,
    splitNames,
} from '../../domain/calendar-promises';
import type { Grace, PromiseOutcome } from '../../domain/calendar-promises';
import { advanceClock, labelDay, momentOf, parseDueExpression, resolveDue } from '../../domain/calendar-time';
import type { StoryClock } from '../../domain/calendar-time';
import type { DesTrackerSnapshot } from '../../domain/des-tracker';
import { pushCapped } from '../../domain/revision-plan';
import { normalizeText } from '../../domain/signals-tokens';
import { isImagePost } from '../../domain/text-clean';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { DeferredCard, RevisionApi } from '../revision/api';
import type { WorldModelApi } from '../world/api';
import type { CalendarApi, PromiseIntake, PromiseStatus, StoryMoment, StoryPromise } from './api';
import { CALENDAR_DOC } from './settings';
import type { CalendarSettings } from './settings';

export type PromiseOrigin = 'revision' | 'user' | 'api';

/** A promise as stored: the API shape plus bookkeeping. */
export interface StoredPromise extends StoryPromise {
    origin: PromiseOrigin;
    /** Turn counter when it came due (due() lists those of the last committed turn). */
    dueTurn?: number;
    /** When the user (or a revision statement) closed it. */
    closedAt?: number;
    /** The revision's deferred card it came from. */
    cardId?: string;
}

export interface ClockEntry {
    /** Assistant message index. */
    index: number;
    clock: StoryClock;
}

export interface CalendarDoc {
    /** Story time after the last committed reply with a DES date or time. */
    clock: StoryClock | null;
    /** The clock after each committed reply (oldest first, capped). */
    history: ClockEntry[];
    /** Last committed message index read (-1: none yet). */
    lastIndex: number;
    /** Committed replies read: the grace in turns counts on it. */
    turn: number;
    promises: StoredPromise[];
    /** Deferred card ids already taken in (dismissed in the revision, kept in case dismissing failed). */
    taken: string[];
}

export function emptyCalendarDoc(): CalendarDoc {
    return { clock: null, history: [], lastIndex: -1, turn: 0, promises: [], taken: [] };
}

/** What the add form sends. */
export interface ManualPromise {
    who: string;
    toWhom: string;
    what: string;
    /** Deadline as typed: a phrase («к закату», "in two days") or a DES-like date («15 Зимня»). */
    when: string;
    quote: string;
}

export interface CalendarServiceOptions {
    /** Pause between the send (turn:committed) and reading the committed reply: keeps it off the send path. */
    settleMs?: number;
    /** Debounce of the deferred-card intake after a revision run or change. */
    intakeMs?: number;
}

interface Transition {
    promise: StoredPromise;
    to: 'due' | 'overdue';
}

interface Recomputed {
    transitions: Transition[];
    changed: boolean;
}

const KEEP_HISTORY = 300;
const KEEP_TAKEN = 500;
const KEEP_PROMISES = 300;
/** Committed messages read at most when catching up (a chat opened for the first time). */
const CATCH_UP = 400;
const SETTLE_MS = 400;
const INTAKE_MS = 300;
const PUT_ATTEMPTS = 3;
const MAX_QUOTE = 400;
const SIGNAL_SOURCE = 'calendar';
const NO_WRITE = Symbol('no-write');

const OUTCOME_STATUS: Record<PromiseOutcome, PromiseStatus> = {
    done: 'done',
    broken: 'broken',
    cancelled: 'cancelled',
};

function newId(): string {
    return `prm-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringList(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
        : [];
}

function isMoment(value: unknown): value is StoryMoment {
    return (
        isDict(value) &&
        typeof value.label === 'string' &&
        (value.day === null || (typeof value.day === 'number' && Number.isFinite(value.day)))
    );
}

function isClock(value: unknown): value is StoryClock {
    return isDict(value) && typeof value.label === 'string' && typeof value.day === 'number';
}

function copyMoment(moment: StoryMoment | null): StoryMoment | null {
    if (!moment) return null;
    const copy: StoryMoment = { label: moment.label, day: moment.day };
    if (typeof moment.minutes === 'number') copy.minutes = moment.minutes;
    return copy;
}

/** Repairs a stored document in place (older or hand-edited files). */
export function normaliseCalendarDoc(doc: CalendarDoc): CalendarDoc {
    if (!isClock(doc.clock)) doc.clock = null;
    if (!Array.isArray(doc.history)) doc.history = [];
    doc.history = doc.history.filter(
        (entry) => isDict(entry) && typeof entry.index === 'number' && isClock(entry.clock),
    );
    if (typeof doc.lastIndex !== 'number' || !Number.isFinite(doc.lastIndex)) doc.lastIndex = -1;
    if (typeof doc.turn !== 'number' || !Number.isFinite(doc.turn)) doc.turn = 0;
    if (!Array.isArray(doc.taken)) doc.taken = [];
    doc.taken = doc.taken.filter((id) => typeof id === 'string');
    if (!Array.isArray(doc.promises)) doc.promises = [];
    doc.promises = doc.promises.filter(
        (item) => isDict(item) && typeof item.id === 'string' && typeof item.what === 'string',
    );
    for (const promise of doc.promises) {
        promise.who = stringList(promise.who);
        promise.toWhom = stringList(promise.toWhom);
        if (typeof promise.quote !== 'string') promise.quote = '';
        if (!isMoment(promise.due)) promise.due = null;
        if (!isPromiseState(promise.status)) promise.status = 'open';
        if (typeof promise.sourceMessage !== 'number') promise.sourceMessage = -1;
        if (typeof promise.createdAt !== 'number') promise.createdAt = 0;
        if (promise.origin !== 'revision' && promise.origin !== 'user' && promise.origin !== 'api')
            promise.origin = 'api';
    }
    return doc;
}

/** The clock of the committed reply at or before a message; the oldest known one when `oldest` and none is. */
export function clockAt(history: readonly ClockEntry[], index: number, oldest = false): StoryClock | null {
    let found: StoryClock | null = null;
    for (const entry of history) {
        if (entry.index > index) break;
        found = entry.clock;
    }
    return found ?? (oldest ? (history[0]?.clock ?? null) : null);
}

/** The last assistant reply that has a user message after it (the last committed turn), -1 if none. */
export function lastCommittedIndex(chat: readonly STChatMessage[]): number {
    let sawUser = false;
    for (let i = chat.length - 1; i >= 0; i--) {
        const message = chat[i];
        if (!message || message.is_system) continue;
        if (message.is_user) {
            sawUser = true;
            continue;
        }
        if (sawUser) return i;
    }
    return -1;
}

/** Deadline order: earliest day first, promises without a day last. */
export function byDue(a: StoryPromise, b: StoryPromise): number {
    const day = (item: StoryPromise) => item.due?.day ?? Number.POSITIVE_INFINITY;
    const minutes = (item: StoryPromise) => item.due?.minutes ?? 0;
    return day(a) - day(b) || minutes(a) - minutes(b) || a.createdAt - b.createdAt;
}

function publicPromise(promise: StoredPromise): StoryPromise {
    return {
        id: promise.id,
        who: [...promise.who],
        toWhom: [...promise.toWhom],
        what: promise.what,
        quote: promise.quote,
        due: copyMoment(promise.due),
        status: promise.status,
        sourceMessage: promise.sourceMessage,
        createdAt: promise.createdAt,
    };
}

export class CalendarService implements Required<CalendarApi> {
    private doc: CalendarDoc | null = null;
    private docChat: string | null = null;
    private loading: Promise<CalendarDoc> | null = null;
    private readonly listeners = new Set<() => void>();
    private turnTimer: ReturnType<typeof setTimeout> | null = null;
    private intakeTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingTurn: number | null = null;
    private revisionApi: RevisionApi | null = null;
    private revisionOff: Unsubscribe[] = [];
    private queue: Promise<unknown> = Promise.resolve();
    /** Bumped on chat change: work of the previous chat stops. */
    private generation = 0;
    private disposed = false;
    private readonly settleMs: number;
    private readonly intakeMs: number;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => CalendarSettings,
        options: CalendarServiceOptions = {},
    ) {
        this.settleMs = options.settleMs ?? SETTLE_MS;
        this.intakeMs = options.intakeMs ?? INTAKE_MS;
    }

    install(): Unsubscribe[] {
        const { bus } = this.app;
        this.ensureRevision();
        void this.open();
        return [
            bus.on('turn:committed', ({ messageIndex }) => this.onCommitted(messageIndex)),
            bus.on('chat:changed', () => this.onChatChanged()),
            bus.on('leader:changed', ({ leader }) => {
                if (leader) void this.open();
            }),
            bus.on('message:invalidated', ({ messageIndex, reason }) => this.onInvalidated(messageIndex, reason)),
            () => this.dispose(),
        ];
    }

    private dispose(): void {
        this.disposed = true;
        this.generation++;
        if (this.turnTimer !== null) clearTimeout(this.turnTimer);
        if (this.intakeTimer !== null) clearTimeout(this.intakeTimer);
        this.turnTimer = null;
        this.intakeTimer = null;
        for (const off of this.revisionOff.splice(0)) off();
        this.revisionApi = null;
        this.listeners.clear();
    }

    /* ---------------------------------------------------------------- public API */

    now(): StoryMoment | null {
        return momentOf(this.cached()?.clock);
    }

    /** The story clock (pult: the time as written, the weekday). */
    clock(): StoryClock | null {
        const clock = this.cached()?.clock;
        return clock ? structuredClone(clock) : null;
    }

    promises(filter?: { status?: PromiseStatus }): StoryPromise[] {
        const list = this.cached()?.promises ?? [];
        return list.filter((item) => !filter?.status || item.status === filter.status).map(publicPromise);
    }

    /** Stored promises with their bookkeeping (pult). */
    stored(): StoredPromise[] {
        return (this.cached()?.promises ?? []).map((item) => structuredClone(item));
    }

    due(): StoryPromise[] {
        const doc = this.cached();
        if (!doc) return [];
        return doc.promises
            .filter((item) => item.status === 'due' && item.dueTurn !== undefined && item.dueTurn >= doc.turn)
            .sort(byDue)
            .map(publicPromise);
    }

    momentAt(messageIndex: number): StoryMoment | null {
        const doc = this.cached();
        return doc ? momentOf(clockAt(doc.history, messageIndex)) : null;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async add(promise: Omit<StoryPromise, 'id' | 'createdAt' | 'status'>): Promise<string> {
        const what = cleanStatement(promise?.what);
        if (!what) throw new Error(this.app.i18n.t('m17.error.what'));
        if (!this.app.host.chatId()) throw new Error(this.app.i18n.t('m17.error.noChat'));
        const sourceMessage = Number.isInteger(promise.sourceMessage) ? promise.sourceMessage : -1;
        const id = await this.enqueue(() =>
            this.store(
                {
                    who: stringList(promise.who).map((name) => name.trim()),
                    toWhom: stringList(promise.toWhom).map((name) => name.trim()),
                    what,
                    quote: cleanStatement(promise.quote, MAX_QUOTE, false),
                    due: isMoment(promise.due) ? copyMoment(promise.due) : null,
                    sourceMessage,
                },
                'api',
            ),
        );
        if (!id) throw new Error(this.app.i18n.t('m17.error.notSaved'));
        return id;
    }

    /** The add form: the deadline is read from what the user typed, against the current story time. */
    async addManual(input: ManualPromise): Promise<string> {
        const what = cleanStatement(input.what);
        if (!what) throw new Error(this.app.i18n.t('m17.error.what'));
        if (!this.app.host.chatId()) throw new Error(this.app.i18n.t('m17.error.noChat'));
        const id = await this.enqueue(async () => {
            const doc = await this.loadDoc();
            return this.store(
                {
                    who: splitNames(input.who),
                    toWhom: splitNames(input.toWhom),
                    what,
                    quote: cleanStatement(input.quote, MAX_QUOTE, false),
                    due: this.typedDue(input.when, doc.clock),
                    sourceMessage: -1,
                },
                'user',
            );
        });
        if (!id) throw new Error(this.app.i18n.t('m17.error.notSaved'));
        return id;
    }

    /** A deadline typed by hand: a phrase, a DES-like date compared with the clock's, or just a label. */
    typedDue(text: string, clock: StoryClock | null): StoryMoment | null {
        const value = text.trim();
        if (!value) return null;
        const expression = parseDueExpression(value);
        if (expression) return resolveDue(expression, clock);
        return { label: value, day: labelDay(value, clock) };
    }

    async setStatus(id: string, status: PromiseStatus): Promise<void> {
        if (!isPromiseState(status)) throw new Error(`unknown status ${String(status)}`);
        const transitions = await this.enqueue(() =>
            this.mutate((doc) => {
                const promise = doc.promises.find((item) => item.id === id);
                if (!promise) return NO_WRITE;
                this.applyStatus(promise, status, doc.turn);
                return this.recompute(doc).transitions;
            }),
        );
        if (transitions) await this.announce(transitions);
        this.emitChange();
    }

    async intake(statement: PromiseIntake): Promise<string | null> {
        if (!this.app.host.chatId()) return null;
        const result = await this.enqueue(() =>
            this.mutate((doc) => {
                const id = this.take(doc, statement, 'revision');
                if (!id) return NO_WRITE;
                return { id, transitions: this.recompute(doc).transitions };
            }),
        );
        if (!result) return null;
        await this.announce(result.transitions);
        this.emitChange();
        return result.id;
    }

    /* ---------------------------------------------------------------- lifecycle */

    private writable(): boolean {
        return !this.disposed && !!this.app.host.chatId() && this.app.leader.isLeader();
    }

    /** Loads the chat's document; the leader catches up with committed replies and takes the deferred backlog. */
    private async open(): Promise<void> {
        const generation = this.generation;
        let doc: CalendarDoc;
        try {
            doc = await this.loadDoc();
        } catch (error) {
            this.log.warn('calendar document could not be loaded', error);
            return;
        }
        if (generation !== this.generation || !this.writable()) return;
        this.ensureRevision();
        const index = lastCommittedIndex(this.chat());
        if (index > doc.lastIndex) await this.enqueue(() => this.readTurn(index, generation, true));
        await this.enqueue(() => this.takeDeferred(generation));
    }

    private onChatChanged(): void {
        this.generation++;
        if (this.turnTimer !== null) clearTimeout(this.turnTimer);
        this.turnTimer = null;
        this.pendingTurn = null;
        this.doc = null;
        this.docChat = null;
        this.loading = null;
        this.emitChange();
        void this.open();
    }

    private onCommitted(index: number): void {
        if (this.disposed || !Number.isInteger(index) || index < 0) return;
        this.pendingTurn = index;
        if (this.turnTimer !== null) clearTimeout(this.turnTimer);
        const generation = this.generation;
        this.turnTimer = setTimeout(() => {
            this.turnTimer = null;
            const pending = this.pendingTurn;
            this.pendingTurn = null;
            if (pending === null || generation !== this.generation) return;
            this.ensureRevision();
            void this.enqueue(() => this.readTurn(pending, generation, false)).catch((error: unknown) =>
                this.log.error('calendar turn failed', error),
            );
        }, this.settleMs);
    }

    /** Reads committed replies up to `index` into the clock and recomputes the statuses (leader only). */
    private async readTurn(index: number, generation: number, quiet: boolean): Promise<void> {
        if (generation !== this.generation || !this.writable()) return;
        const chat = this.chat();
        const result = await this.mutate((doc) => {
            const moved = this.advanceTo(doc, index, chat);
            const recomputed = this.recompute(doc);
            return moved || recomputed.changed ? recomputed.transitions : NO_WRITE;
        });
        if (result && !quiet) await this.announce(result);
        this.emitChange();
    }

    private advanceTo(doc: CalendarDoc, index: number, chat: readonly STChatMessage[]): boolean {
        if (index < 0 || index === doc.lastIndex) return false;
        if (index < doc.lastIndex) this.rollback(doc, index);
        const from = Math.max(doc.lastIndex + 1, index - CATCH_UP + 1, 0);
        for (let i = from; i <= index && i < chat.length; i++) {
            const message = chat[i];
            if (!message || message.is_user || message.is_system || isImagePost(message)) continue;
            doc.turn += 1;
            const box = this.trackerAt(i)?.infoBox;
            if (!box) continue;
            const step = advanceClock(doc.clock, { date: box.date, start: box.time?.start, end: box.time?.end });
            if (!step) continue;
            doc.clock = step.clock;
            pushCapped(doc.history, { index: i, clock: step.clock }, KEEP_HISTORY);
        }
        doc.lastIndex = index;
        return true;
    }

    /** Forgets the clock from `index` on (a deleted or swiped committed reply; a commit before the last one read). */
    private rollback(doc: CalendarDoc, index: number): void {
        doc.history = doc.history.filter((entry) => entry.index < index);
        doc.clock = doc.history[doc.history.length - 1]?.clock ?? null;
        doc.lastIndex = Math.min(doc.lastIndex, index - 1);
    }

    private grace(): Grace {
        const settings = this.settings();
        return { days: settings.overdueDays, turns: settings.overdueTurns };
    }

    private recompute(doc: CalendarDoc): Recomputed {
        const now = momentOf(doc.clock);
        const grace = this.grace();
        const transitions: Transition[] = [];
        let changed = false;
        for (const promise of doc.promises) {
            const before = promise.status;
            const next = evaluatePromise(promise, now, doc.turn, grace);
            if (next.status === before && next.dueTurn === promise.dueTurn) continue;
            changed = true;
            promise.status = next.status;
            if (next.dueTurn === undefined) delete promise.dueTurn;
            else promise.dueTurn = next.dueTurn;
            if (next.status !== before && (next.status === 'due' || next.status === 'overdue')) {
                transitions.push({ promise, to: next.status });
            }
        }
        return { transitions, changed };
    }

    private applyStatus(promise: StoredPromise, status: PromiseStatus, turn: number): void {
        if (!isActive(status)) {
            promise.status = status;
            promise.closedAt = Date.now();
            return;
        }
        delete promise.closedAt;
        if (status === 'open') {
            promise.status = 'open';
            delete promise.dueTurn;
            return;
        }
        promise.status = status;
        promise.dueTurn ??= turn;
    }

    private async announce(transitions: readonly Transition[]): Promise<void> {
        const chatId = this.app.host.chatId();
        const messageIndex = this.cached()?.lastIndex ?? -1;
        for (const { promise, to } of transitions) {
            try {
                await this.app.bus.emit('signal', {
                    kind: `promise.${to}`,
                    chatId,
                    ...(messageIndex >= 0 ? { messageIndex } : {}),
                    ...(promise.who[0] ? { entity: promise.who[0] } : {}),
                    data: { id: promise.id, what: promise.what, who: [...promise.who], source: SIGNAL_SOURCE },
                    at: Date.now(),
                });
            } catch (error) {
                this.log.debug('promise signal failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- invalidation */

    private onInvalidated(index: number, reason: 'swiped' | 'deleted' | 'edited'): void {
        // An edit keeps the tracker and usually the promise; a swipe or a deletion takes the turn with it.
        if (reason === 'edited' || !this.writable()) return;
        const doc = this.cached();
        if (!doc) return;
        const fromTurn = doc.lastIndex >= index;
        const dropped = (item: StoredPromise) =>
            item.sourceMessage === index && item.origin === 'revision' && isActive(item.status);
        if (!fromTurn && !doc.promises.some(dropped)) return;
        const generation = this.generation;
        void this.enqueue(async () => {
            if (generation !== this.generation) return;
            await this.mutate((fresh) => {
                if (fresh.lastIndex >= index) this.rollback(fresh, index);
                fresh.promises = fresh.promises.filter((item) => !dropped(item));
                this.recompute(fresh);
                return true;
            });
            this.emitChange();
        }).catch((error: unknown) => this.log.warn('calendar invalidation failed', error));
    }

    /* ---------------------------------------------------------------- intake */

    private ensureRevision(): RevisionApi | null {
        let api: RevisionApi | null;
        try {
            api = this.app.modules.api<RevisionApi>('revision') ?? null;
        } catch {
            api = null;
        }
        if (api === this.revisionApi) return api;
        for (const off of this.revisionOff.splice(0)) off();
        this.revisionApi = api;
        if (!api || this.disposed) return api;
        try {
            this.revisionOff.push(api.onRun(() => this.scheduleIntake()));
            if (typeof api.onChange === 'function') this.revisionOff.push(api.onChange(() => this.scheduleIntake()));
        } catch (error) {
            this.log.debug('revision events are not available', error);
        }
        return api;
    }

    private scheduleIntake(): void {
        if (this.disposed) return;
        if (this.intakeTimer !== null) clearTimeout(this.intakeTimer);
        const generation = this.generation;
        this.intakeTimer = setTimeout(() => {
            this.intakeTimer = null;
            void this.enqueue(() => this.takeDeferred(generation)).catch((error: unknown) =>
                this.log.warn('calendar intake failed', error),
            );
        }, this.intakeMs);
    }

    /** Takes the revision's deferred promise cards (leader only), then dismisses them there. */
    private async takeDeferred(generation: number): Promise<void> {
        if (generation !== this.generation || !this.writable()) return;
        const revision = this.ensureRevision();
        if (!revision) return;
        let cards: DeferredCard[];
        try {
            cards = revision.deferred().filter((card) => card.target === 'deferred.promise');
        } catch (error) {
            this.log.debug('deferred cards are not readable', error);
            return;
        }
        if (!cards.length) return;
        const known = await this.loadDoc();
        if (generation !== this.generation) return;
        let transitions: Transition[] = [];
        if (cards.some((card) => !known.taken.includes(card.id))) {
            const result = await this.mutate((doc) => {
                for (const card of cards) {
                    if (doc.taken.includes(card.id)) continue;
                    this.take(
                        doc,
                        {
                            entityName: card.entityName,
                            value: card.value,
                            evidence: card.evidence,
                            sourceMessage: card.sourceMessage,
                        },
                        'revision',
                        card.id,
                    );
                    pushCapped(doc.taken, card.id, KEEP_TAKEN);
                }
                return this.recompute(doc).transitions;
            });
            if (!result) return;
            transitions = result;
        }
        const taken = new Set(this.cached()?.taken ?? []);
        if (typeof revision.dismissDeferred === 'function') {
            for (const card of cards) {
                if (!taken.has(card.id)) continue;
                try {
                    await revision.dismissDeferred(card.id);
                } catch (error) {
                    this.log.warn('deferred card was not dismissed', error);
                }
            }
        }
        await this.announce(transitions);
        this.emitChange();
    }

    /** One statement into the document: an outcome closes a known promise, otherwise a new (or known) promise. */
    private take(doc: CalendarDoc, statement: PromiseIntake, origin: PromiseOrigin, cardId?: string): string | null {
        const value = cleanStatement(statement.value);
        const quote = cleanStatement(statement.evidence, MAX_QUOTE, false);
        if (!value && !quote) return null;
        const name = typeof statement.entityName === 'string' ? statement.entityName.trim() : '';
        const who = name ? [this.canonical(name)] : [];
        const outcome = value ? promiseOutcome(value) : null;
        if (outcome) {
            const match = findPromiseMatch(doc.promises, who, value);
            if (!match) {
                this.log.debug(`calendar: no promise matches «${value}»`);
                return null;
            }
            this.applyStatus(match, OUTCOME_STATUS[outcome], doc.turn);
            return match.id;
        }
        const sourceMessage = Number.isInteger(statement.sourceMessage) ? statement.sourceMessage : -1;
        const base = sourceMessage >= 0 ? clockAt(doc.history, sourceMessage, true) : null;
        const expression = parseDueExpression(value) ?? parseDueExpression(quote);
        const due = expression ? resolveDue(expression, base ?? doc.clock) : null;
        return this.insert(
            doc,
            { who, toWhom: this.recipients(who, value, quote), what: value || quote, quote, due, sourceMessage },
            origin,
            cardId,
        );
    }

    private async store(
        promise: Omit<StoryPromise, 'id' | 'createdAt' | 'status'>,
        origin: PromiseOrigin,
    ): Promise<string | null> {
        const result = await this.mutate((doc) => {
            const id = this.insert(doc, promise, origin);
            return { id, transitions: this.recompute(doc).transitions };
        });
        if (!result) return null;
        await this.announce(result.transitions);
        this.emitChange();
        return result.id;
    }

    /** Adds a promise unless the same one is known (then a missing deadline is filled in); returns its id. */
    private insert(
        doc: CalendarDoc,
        promise: Omit<StoryPromise, 'id' | 'createdAt' | 'status'>,
        origin: PromiseOrigin,
        cardId?: string,
    ): string {
        const existing = doc.promises.find((item) => samePromise(item, promise));
        if (existing) {
            if (!existing.due?.label && promise.due) existing.due = copyMoment(promise.due);
            return existing.id;
        }
        const stored: StoredPromise = {
            id: newId(),
            who: [...promise.who],
            toWhom: [...promise.toWhom],
            what: promise.what,
            quote: promise.quote,
            due: copyMoment(promise.due),
            status: 'open',
            sourceMessage: promise.sourceMessage,
            createdAt: Date.now(),
            origin,
        };
        if (cardId) stored.cardId = cardId;
        doc.promises.push(stored);
        this.trim(doc);
        return stored.id;
    }

    /** Keeps every active promise; drops the oldest closed ones above the cap. */
    private trim(doc: CalendarDoc): void {
        while (doc.promises.length > KEEP_PROMISES) {
            let oldest = -1;
            doc.promises.forEach((item, index) => {
                if (isActive(item.status)) return;
                const at = item.closedAt ?? item.createdAt;
                const best = oldest >= 0 ? doc.promises[oldest] : undefined;
                if (!best || at < (best.closedAt ?? best.createdAt)) oldest = index;
            });
            if (oldest < 0) return;
            doc.promises.splice(oldest, 1);
        }
    }

    /* ---------------------------------------------------------------- people */

    private world(): WorldModelApi | undefined {
        try {
            return this.app.modules.api<WorldModelApi>('world');
        } catch {
            return undefined;
        }
    }

    private canonical(name: string): string {
        try {
            return this.world()?.resolve(name)?.name ?? name;
        } catch {
            return name;
        }
    }

    /**
     * To whom: people the statement names (world model), the persona when named or addressed («the user»,
     * {{user}}); by default the persona — or the card character when the persona made the promise.
     */
    private recipients(who: readonly string[], value: string, quote: string): string[] {
        const ctx = this.app.host.ctx();
        const persona = (ctx.name1 ?? '').trim();
        const character = (ctx.name2 ?? '').trim();
        const whoKeys = new Set(who.map((name) => normalizeText(name)));
        const names: string[] = [];
        const push = (name: string) => {
            const key = normalizeText(name);
            if (!key || whoKeys.has(key) || names.some((item) => normalizeText(item) === key)) return;
            names.push(name);
        };
        try {
            // The quote often names the addressee («Анна, я верну меч к закату»).
            for (const entity of this.world()?.mentions(`${value}\n${quote}`) ?? []) {
                if (entity.kind === 'character' || entity.kind === 'persona') push(entity.name);
            }
        } catch (error) {
            this.log.debug('world mentions failed', error);
        }
        const text = normalizeText(value);
        if (persona && (text.includes(normalizeText(persona)) || /\{\{user\}\}|\bthe user\b/.test(text))) push(persona);
        if (!names.length) {
            const fallback = whoKeys.has(normalizeText(persona)) ? character : persona;
            if (fallback) push(fallback);
        }
        return names;
    }

    /* ---------------------------------------------------------------- the chat document */

    private chat(): readonly STChatMessage[] {
        try {
            return this.app.host.ctx().chat ?? [];
        } catch {
            return [];
        }
    }

    private trackerAt(index: number): DesTrackerSnapshot | null {
        try {
            return adaptersOf(this.app).des.trackerFor(index);
        } catch (error) {
            this.log.debug('DES tracker is not readable', error);
            return null;
        }
    }

    private cached(): CalendarDoc | null {
        const chatId = this.app.host.chatId();
        if (!chatId) return null;
        if (this.docChat !== chatId || !this.doc) {
            void this.loadDoc().catch(() => undefined);
            return null;
        }
        return this.doc;
    }

    async loadDoc(): Promise<CalendarDoc> {
        const chatId = this.app.host.chatId();
        if (!chatId) return emptyCalendarDoc();
        if (this.docChat === chatId && this.doc) return this.doc;
        if (this.loading && this.docChat === chatId) return this.loading;
        this.docChat = chatId;
        const loading = this.app.chat
            .get<CalendarDoc>(CALENDAR_DOC, emptyCalendarDoc)
            .then((doc) => {
                const ready = normaliseCalendarDoc(doc);
                if (this.app.host.chatId() === chatId && this.docChat === chatId) {
                    this.doc = ready;
                    this.emitChange();
                }
                return ready;
            })
            .finally(() => {
                if (this.loading === loading) this.loading = null;
            });
        this.loading = loading;
        return loading;
    }

    /** Compare-and-swap write: re-read, change, put; a newer version from another tab is re-read and changed again. */
    private async mutate<R>(change: (doc: CalendarDoc) => R | typeof NO_WRITE): Promise<R | undefined> {
        const chatId = this.app.host.chatId();
        if (!chatId) return undefined;
        for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
            const doc = normaliseCalendarDoc(await this.app.chat.get<CalendarDoc>(CALENDAR_DOC, emptyCalendarDoc));
            if (this.app.host.chatId() !== chatId) return undefined;
            const result = change(doc);
            if (result === NO_WRITE) {
                this.adopt(doc, chatId);
                return undefined;
            }
            if (await this.app.chat.put(CALENDAR_DOC, doc)) {
                this.adopt(doc, chatId);
                return result;
            }
        }
        this.log.warn(`calendar document could not be saved after ${PUT_ATTEMPTS} attempts`);
        return undefined;
    }

    private adopt(doc: CalendarDoc, chatId: string): void {
        if (this.app.host.chatId() !== chatId) return;
        this.doc = doc;
        this.docChat = chatId;
    }

    private enqueue<R>(job: () => Promise<R>): Promise<R> {
        const next = this.queue.then(job, job);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private emitChange(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('calendar listener failed', error);
            }
        }
    }
}
