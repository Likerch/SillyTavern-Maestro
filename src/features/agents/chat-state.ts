// What agents keep per chat (plan §4.3): the documents 'agents' (their records and memory, the prepared injections,
// the last successful run of each agent, the results of every reply per swipe) and 'agents-log' (the run log, a ring;
// full requests and answers only for the newest runs). Saved with a delay; a write over another tab's newer version
// takes theirs and puts ours on top (the same pattern as M12's verdicts).
import type { AgentRun } from '../../domain/agents/types';
import type { App, Logger } from '../../shared/contracts';

export const STATE_DOC_KIND = 'agents';
export const LOG_DOC_KIND = 'agents-log';
const SAVE_DELAY_MS = 600;
export const MAX_RESULTS = 400;
export const MAX_RUNS = 300;
export const FULL_RUNS = 30;

/** An agent's records in this chat (type «Записи»): fields, locks, the previous versions. */
export interface AgentMemory {
    fields: Record<string, string>;
    locked: string[];
    history: { at: number; fields: Record<string, string> }[];
    updatedAt: number;
}

/** A prepared «заранее» result: valid while the chat still ends with the same reply (`anchor` index + text hash). */
export interface Prepared {
    agentId: string;
    anchor: number;
    hash: string;
    /** inject text or flags. */
    text?: string;
    flags?: Record<string, string | number | boolean>;
    at: number;
    /** The user edited the injection in «Вставки хода». */
    edited?: boolean;
}

/** A result shown with a reply (note, verdict, choices, rewrite original), per swipe. */
export interface MessageResult {
    agentId: string;
    agentName: string;
    messageIndex: number;
    swipeId: number;
    type: 'note' | 'verdict' | 'choices' | 'rewrite' | 'memory' | 'inject' | 'flags';
    data: Record<string, unknown>;
    at: number;
    /** The user dismissed it (choices used, note hidden). */
    dismissed?: boolean;
    invalidated?: boolean;
}

export interface AgentsChatDoc {
    version: 1;
    memory: Record<string, AgentMemory>;
    prepared: Record<string, Prepared>;
    /** Injections that hold «until the agent runs again» (lifetime 'untilNext'). */
    standing: Record<string, { text: string; at: number }>;
    /** Message index of the last successful run per agent (counters count from it). */
    lastOk: Record<string, { index: number; at: number }>;
    results: MessageResult[];
    /** Runs per agent and turn (limits.perTurn): turn key → agent → count. */
    perTurn: { turn: number; counts: Record<string, number> };
}

export interface AgentsLogDoc {
    version: 1;
    runs: AgentRun[];
}

export function emptyState(): AgentsChatDoc {
    return {
        version: 1,
        memory: {},
        prepared: {},
        standing: {},
        lastOk: {},
        results: [],
        perTurn: { turn: -1, counts: {} },
    };
}

export function emptyLog(): AgentsLogDoc {
    return { version: 1, runs: [] };
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sanitizeState(raw: unknown): AgentsChatDoc {
    const doc = emptyState();
    if (!isDict(raw)) return doc;
    if (isDict(raw.memory)) doc.memory = raw.memory as Record<string, AgentMemory>;
    if (isDict(raw.prepared)) doc.prepared = raw.prepared as Record<string, Prepared>;
    if (isDict(raw.standing)) doc.standing = raw.standing as AgentsChatDoc['standing'];
    if (isDict(raw.lastOk)) doc.lastOk = raw.lastOk as AgentsChatDoc['lastOk'];
    if (Array.isArray(raw.results)) doc.results = (raw.results as MessageResult[]).filter((item) => isDict(item));
    if (isDict(raw.perTurn) && typeof raw.perTurn.turn === 'number' && isDict(raw.perTurn.counts))
        doc.perTurn = raw.perTurn as AgentsChatDoc['perTurn'];
    return doc;
}

function sanitizeLog(raw: unknown): AgentsLogDoc {
    const doc = emptyLog();
    if (isDict(raw) && Array.isArray(raw.runs)) doc.runs = (raw.runs as AgentRun[]).filter((run) => isDict(run));
    return doc;
}

/** A per-chat document loaded on chat change and saved with a delay. */
class ChatDoc<T extends object> {
    doc: T;
    private chatId: string | null = null;
    private loading: Promise<void> | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly kind: string,
        private readonly empty: () => T,
        private readonly sanitize: (raw: unknown) => T,
        private readonly merge: (theirs: T, ours: T) => T,
    ) {
        this.doc = empty();
    }

    load(): Promise<void> {
        const chatId = this.app.host.chatId();
        this.flushTimer();
        this.chatId = chatId;
        this.doc = this.empty();
        if (!chatId) {
            this.loading = null;
            return Promise.resolve();
        }
        const pending = this.app.chat
            .get<T>(this.kind, this.empty)
            .then((raw) => {
                if (this.chatId !== chatId || this.loading !== pending) return;
                this.doc = this.merge(this.sanitize(raw), this.doc);
            })
            .catch((error: unknown) => this.log.warn(`could not load ${this.kind}`, error));
        this.loading = pending;
        return pending;
    }

    ready(): Promise<void> {
        return this.loading ?? Promise.resolve();
    }

    chat(): string | null {
        return this.chatId;
    }

    changed(): void {
        if (!this.chatId || this.timer !== null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.save();
        }, SAVE_DELAY_MS);
    }

    async flush(): Promise<void> {
        if (this.timer === null) return;
        this.flushTimer();
        await this.save();
    }

    private flushTimer(): void {
        if (this.timer !== null) {
            clearTimeout(this.timer);
            this.timer = null;
            void this.save();
        }
    }

    private async save(): Promise<void> {
        const chatId = this.chatId;
        if (!chatId) return;
        if (this.loading) await this.loading;
        if (this.chatId !== chatId) return;
        const doc = this.doc;
        try {
            if (await this.app.chat.put(this.kind, doc)) return;
            const fresh = this.sanitize(await this.app.chat.getFor<T>(chatId, this.kind, this.empty));
            const merged = this.merge(fresh, doc);
            if (this.chatId === chatId) this.doc = merged;
            if (!(await this.app.chat.put(this.kind, merged))) this.log.info(`${this.kind}: write conflict`);
        } catch (error) {
            this.log.warn(`could not save ${this.kind}`, error);
        }
    }
}

function mergeState(theirs: AgentsChatDoc, ours: AgentsChatDoc): AgentsChatDoc {
    const results = new Map<string, MessageResult>();
    for (const item of [...theirs.results, ...ours.results])
        results.set(`${item.agentId}:${item.messageIndex}:${item.swipeId}:${item.at}`, item);
    return {
        version: 1,
        memory: { ...theirs.memory, ...ours.memory },
        prepared: { ...theirs.prepared, ...ours.prepared },
        standing: { ...theirs.standing, ...ours.standing },
        lastOk: { ...theirs.lastOk, ...ours.lastOk },
        results: [...results.values()].sort((a, b) => a.at - b.at).slice(-MAX_RESULTS),
        perTurn: ours.perTurn.turn >= theirs.perTurn.turn ? ours.perTurn : theirs.perTurn,
    };
}

function mergeLog(theirs: AgentsLogDoc, ours: AgentsLogDoc): AgentsLogDoc {
    const runs = new Map<string, AgentRun>();
    for (const run of [...theirs.runs, ...ours.runs]) runs.set(run.id, run);
    return { version: 1, runs: trimRuns([...runs.values()].sort((a, b) => a.startedAt - b.startedAt)) };
}

/** Keeps MAX_RUNS runs; only the newest FULL_RUNS keep their request and raw answer. */
export function trimRuns(runs: AgentRun[]): AgentRun[] {
    const kept = runs.slice(-MAX_RUNS);
    const fullFrom = kept.length - FULL_RUNS;
    return kept.map((run, index) => {
        if (index >= fullFrom || (!run.request && run.raw === undefined)) return run;
        const rest = { ...run };
        delete rest.request;
        delete rest.raw;
        return rest;
    });
}

export class AgentsChatState {
    readonly state: ChatDoc<AgentsChatDoc>;
    readonly log: ChatDoc<AgentsLogDoc>;
    private readonly listeners = new Set<(indexes?: number[]) => void>();

    constructor(app: App, log: Logger) {
        this.state = new ChatDoc(app, log, STATE_DOC_KIND, emptyState, sanitizeState, mergeState);
        this.log = new ChatDoc(app, log, LOG_DOC_KIND, emptyLog, sanitizeLog, mergeLog);
    }

    async load(): Promise<void> {
        await Promise.all([this.state.load(), this.log.load()]);
        this.notify();
    }

    onChange(listener: (indexes?: number[]) => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify(indexes?: number[]): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(indexes);
            } catch {
                // a view failed; the others still repaint
            }
        }
    }

    get doc(): AgentsChatDoc {
        return this.state.doc;
    }

    /* ------------------------------------------------------------ runs */

    addRun(run: AgentRun): void {
        this.log.doc.runs = trimRuns([...this.log.doc.runs, run]);
        this.log.changed();
        this.notify();
    }

    runs(): AgentRun[] {
        return this.log.doc.runs;
    }

    /* ------------------------------------------------------------ results per reply */

    putResult(result: MessageResult): void {
        const doc = this.state.doc;
        doc.results = doc.results.filter(
            (item) =>
                item.invalidated ||
                item.agentId !== result.agentId ||
                item.messageIndex !== result.messageIndex ||
                item.swipeId !== result.swipeId ||
                item.type !== result.type,
        );
        doc.results.push(result);
        if (doc.results.length > MAX_RESULTS) doc.results.splice(0, doc.results.length - MAX_RESULTS);
        this.state.changed();
        this.notify([result.messageIndex]);
    }

    resultsOf(messageIndex: number, swipeId: number): MessageResult[] {
        return this.state.doc.results.filter(
            (item) => item.messageIndex === messageIndex && item.swipeId === swipeId && !item.invalidated,
        );
    }

    dismiss(result: MessageResult): void {
        result.dismissed = true;
        this.state.changed();
        this.notify([result.messageIndex]);
    }

    /**
     * A message changed or went: its results (and later ones) stop applying. A deletion from the middle moves the later
     * results down by `removed`.
     */
    invalidate(index: number, reason: 'swiped' | 'deleted' | 'edited', removedAt?: number, removed?: number): void {
        const doc = this.state.doc;
        if (reason === 'deleted' && removedAt !== undefined && removed) {
            doc.results = doc.results.filter(
                (item) => item.messageIndex < removedAt || item.messageIndex >= removedAt + removed,
            );
            for (const item of doc.results) if (item.messageIndex >= removedAt + removed) item.messageIndex -= removed;
        } else if (reason === 'deleted') {
            doc.results = doc.results.filter((item) => item.messageIndex < index);
        } else if (reason === 'edited') {
            for (const item of doc.results)
                if (item.messageIndex === index && item.type !== 'rewrite') item.invalidated = true;
        }
        // A swipe keeps the old swipe's results: they come back with it.
        this.state.changed();
        this.notify();
    }

    /* ------------------------------------------------------------ memory */

    memory(agentId: string): AgentMemory {
        return this.state.doc.memory[agentId] ?? { fields: {}, locked: [], history: [], updatedAt: 0 };
    }

    /** Merges fields into an agent's records; locked fields stay; the previous version goes to the history. */
    updateMemory(agentId: string, fields: Record<string, string>, now: number, byUser = false): string[] {
        const current = this.memory(agentId);
        const changed: string[] = [];
        const next = { ...current.fields };
        for (const [name, value] of Object.entries(fields)) {
            if (!byUser && current.locked.includes(name)) continue;
            if (next[name] === value) continue;
            next[name] = value;
            changed.push(name);
        }
        if (!changed.length) return changed;
        const history = [...current.history, { at: current.updatedAt || now, fields: current.fields }].slice(-10);
        this.state.doc.memory[agentId] = { fields: next, locked: current.locked, history, updatedAt: now };
        this.state.changed();
        this.notify();
        return changed;
    }

    setLocked(agentId: string, field: string, locked: boolean): void {
        const current = this.memory(agentId);
        const set = new Set(current.locked);
        if (locked) set.add(field);
        else set.delete(field);
        this.state.doc.memory[agentId] = { ...current, locked: [...set] };
        this.state.changed();
        this.notify();
    }

    /* ------------------------------------------------------------ prepared and standing injections */

    setPrepared(item: Prepared): void {
        this.state.doc.prepared[item.agentId] = item;
        this.state.changed();
        this.notify();
    }

    dropPrepared(agentId: string): void {
        delete this.state.doc.prepared[agentId];
        this.state.changed();
        this.notify();
    }

    setStanding(agentId: string, text: string | null, now: number): void {
        if (text === null) delete this.state.doc.standing[agentId];
        else this.state.doc.standing[agentId] = { text, at: now };
        this.state.changed();
        this.notify();
    }

    /* ------------------------------------------------------------ counters */

    markOk(agentId: string, index: number, now: number): void {
        this.state.doc.lastOk[agentId] = { index, at: now };
        this.state.changed();
    }

    /** Counts a run for limits.perTurn; returns the count after it. */
    countTurn(agentId: string, turn: number): number {
        const doc = this.state.doc;
        if (doc.perTurn.turn !== turn) doc.perTurn = { turn, counts: {} };
        doc.perTurn.counts[agentId] = (doc.perTurn.counts[agentId] ?? 0) + 1;
        this.state.changed();
        return doc.perTurn.counts[agentId];
    }

    async flush(): Promise<void> {
        await Promise.all([this.state.flush(), this.log.flush()]);
    }
}
