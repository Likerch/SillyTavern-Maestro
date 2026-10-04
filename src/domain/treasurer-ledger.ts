// Turn attribution of the core cost meter's entries (M21): which assistant message (turn) each entry belongs to.
//
// - A main entry belongs to the generation it answered: the newest generation of its type (the core labels main
//   entries with the generation type) that started before the entry. The generation's message index comes later
//   with reply:ready, so its entries wait in the generation until then.
// - Any other entry (Qvink, Maestro's tasks, NAI Studio's LLM calls, quiet generations, Anlas) belongs to the turn
//   during which it was recorded: the generation running then, else the latest reply at that time.
// - A generation that ended without a reply (stopped before any text, impersonate, an error) falls back to the turn
//   that was current when it ended, after a short grace (GENERATION_ENDED comes a tick before reply:ready).
// - Anlas the caller knows the message of (NAI Studio records) are routed by hints: amount + turn.
//
// Pure and synchronous: the caller feeds events and today's entries (sorted or not) and applies the results.
import { classifyEntry, isAnlasEntry, positive } from './treasurer-spend';
import type { LedgerEntry, SpendSource } from './treasurer-spend';

export interface Classified {
    entry: LedgerEntry;
    source: SpendSource;
}

export interface Assignment extends Classified {
    /** Assistant message index; -1 when the chat has no reply yet. */
    turn: number;
}

export interface IngestResult {
    /** New entries of the ledger's chat, classified (session totals). */
    fresh: Classified[];
    /** Entries now bound to a turn (fresh ones and those that waited for a reply). */
    assigned: Assignment[];
}

export interface Flight {
    id: number;
    type: string;
    auto: boolean;
    startedAt: number;
    endedAt?: number;
    /** End of the window that background entries count into (reply or end, whichever came first). */
    closedAt?: number;
    turn?: number;
    pending: Classified[];
}

export interface LedgerOptions {
    chatId: string | null;
    /** Turn current when the ledger starts (latest reply of the chat, -1 if none). */
    turn: number;
    /** Entries recorded before this are not attributed (they belong to an earlier page session). */
    since: number;
    /** How long an ended generation waits for its reply before it falls back (default 1500 ms). */
    graceMs?: number;
    /** Lifetime of an Anlas hint (default 60 s). */
    hintTtlMs?: number;
}

const MAX_FLIGHTS = 20;
const MAX_MARKS = 100;
const MAX_HINTS = 50;
/** The core records Anlas in its own reply:ready listener, which may run a little before the hint is given. */
const HINT_EARLY_MS = 2000;

export function entryKey(entry: LedgerEntry): string {
    return `${entry.at}|${entry.source}|${entry.usd}|${entry.task ?? ''}|${entry.anlas ?? ''}`;
}

export class TurnLedger {
    private flights: Flight[] = [];
    private marks: { at: number; turn: number }[] = [];
    private hints: { amount: number; turn: number; at: number }[] = [];
    private resolved: Assignment[] = [];
    private chatId: string | null;
    private initialTurn: number;
    private cursorAt: number;
    private cursorSeen = new Map<string, number>();
    private seq = 0;
    private readonly graceMs: number;
    private readonly hintTtlMs: number;

    constructor(options: LedgerOptions) {
        this.chatId = options.chatId;
        this.initialTurn = options.turn;
        this.cursorAt = options.since;
        this.graceMs = options.graceMs ?? 1500;
        this.hintTtlMs = options.hintTtlMs ?? 60_000;
    }

    /** Another chat: generations still waiting fall back now and are returned for the previous chat. */
    reset(chatId: string | null, turn: number, since: number): Assignment[] {
        for (const flight of this.flights) if (flight.turn === undefined) this.fallback(flight);
        const leftovers = this.takeResolved();
        this.chatId = chatId;
        this.initialTurn = turn;
        this.flights = [];
        this.marks = [];
        this.hints = [];
        if (since > this.cursorAt) {
            this.cursorAt = since;
            this.cursorSeen = new Map();
        }
        return leftovers;
    }

    /** A non-quiet generation started (bus generation:before). */
    begin(type: string, auto: boolean, at: number): void {
        // A new generation means earlier ones without a reply never got one.
        for (const flight of this.flights) if (flight.turn === undefined) this.fallback(flight, at);
        this.flights.push({ id: ++this.seq, type, auto, startedAt: at, pending: [] });
        if (this.flights.length > MAX_FLIGHTS) this.flights.splice(0, this.flights.length - MAX_FLIGHTS);
    }

    /** A reply was rendered (bus reply:ready for an assistant message that is not a picture post). */
    reply(turn: number, at: number): void {
        // begin() already settled older generations: only the newest one can still wait for its reply.
        for (let i = this.flights.length - 1; i >= 0; i--) {
            const flight = this.flights[i]!;
            if (flight.turn === undefined && flight.startedAt <= at) {
                flight.closedAt ??= at;
                this.resolve(flight, turn);
                break;
            }
        }
        this.marks.push({ at, turn });
        if (this.marks.length > MAX_MARKS) this.marks.splice(0, this.marks.length - MAX_MARKS);
    }

    /** The generation in flight ended (bus generation:ended). */
    end(at: number): void {
        const flight = this.flights[this.flights.length - 1];
        if (!flight || flight.endedAt !== undefined) return;
        flight.endedAt = at;
        flight.closedAt ??= at;
    }

    /** Ended generations whose reply did not come within the grace fall back to the turn current at their end. */
    settle(now: number): void {
        for (const flight of this.flights) {
            if (flight.turn === undefined && flight.endedAt !== undefined && now - flight.endedAt >= this.graceMs) {
                this.fallback(flight);
            }
        }
    }

    /** The next Anlas entry of this amount belongs to `turn` (NAI Studio records of a known message). */
    hint(amount: number, turn: number, at: number): void {
        if (positive(amount) <= 0) return;
        this.hints.push({ amount, turn, at });
        if (this.hints.length > MAX_HINTS) this.hints.splice(0, this.hints.length - MAX_HINTS);
    }

    /** Generations waiting for their reply (tests, debug). */
    waiting(): number {
        return this.flights.filter((flight) => flight.turn === undefined).length;
    }

    /** Processes entries not seen yet (the core meter's today list, any order); returns what can be applied now. */
    ingest(entries: readonly LedgerEntry[], now: number): IngestResult {
        this.settle(now);
        this.hints = this.hints.filter((hint) => now - hint.at <= this.hintTtlMs);
        const fresh: Classified[] = [];
        const sorted = entries
            .filter((entry) => typeof entry.at === 'number' && Number.isFinite(entry.at))
            .slice()
            .sort((a, b) => a.at - b.at);
        let groupAt = Number.NaN;
        const group = new Map<string, number>();
        for (const entry of sorted) {
            if (entry.at < this.cursorAt) continue;
            if (entry.at !== groupAt) {
                groupAt = entry.at;
                group.clear();
            }
            const key = entryKey(entry);
            const occurrence = (group.get(key) ?? 0) + 1;
            group.set(key, occurrence);
            if (entry.at === this.cursorAt && occurrence <= (this.cursorSeen.get(key) ?? 0)) continue;
            if (entry.at > this.cursorAt) {
                this.cursorAt = entry.at;
                this.cursorSeen = new Map();
            }
            this.cursorSeen.set(key, occurrence);
            // Entries of other chats (or with no chat) are not this ledger's; they still move the cursor.
            const chat = entry.chatId === undefined ? this.chatId : entry.chatId;
            if (chat === null || chat !== this.chatId) continue;
            fresh.push(this.place(entry));
        }
        return { fresh, assigned: this.takeResolved() };
    }

    /* ------------------------------------------------------------ internals */

    private place(entry: LedgerEntry): Classified {
        if (isAnlasEntry(entry)) {
            const index = this.hints.findIndex(
                (hint) => Math.abs(hint.amount - positive(entry.anlas)) < 1e-9 && entry.at >= hint.at - HINT_EARLY_MS,
            );
            if (index >= 0) {
                const [hint] = this.hints.splice(index, 1);
                const item: Classified = { entry, source: 'nai' };
                this.resolved.push({ ...item, turn: hint!.turn });
                return item;
            }
        }
        if (entry.source === 'main' && entry.task !== 'quiet') {
            const flight = this.ownerOf(entry);
            if (flight) {
                const item: Classified = { entry, source: classifyEntry(entry, flight.auto) };
                this.attach(flight, item);
                return item;
            }
        }
        const item: Classified = { entry, source: classifyEntry(entry) };
        const running = this.runningAt(entry.at);
        if (running) this.attach(running, item);
        else this.resolved.push({ ...item, turn: this.turnAt(entry.at) });
        return item;
    }

    /** The generation a main entry answered: the newest of its type started before it. */
    private ownerOf(entry: LedgerEntry): Flight | undefined {
        for (let i = this.flights.length - 1; i >= 0; i--) {
            const flight = this.flights[i]!;
            if (flight.startedAt <= entry.at && (entry.task === undefined || flight.type === entry.task)) {
                return flight;
            }
        }
        return undefined;
    }

    /** The generation running at a moment (started, not yet replied or ended). */
    private runningAt(at: number): Flight | undefined {
        for (let i = this.flights.length - 1; i >= 0; i--) {
            const flight = this.flights[i]!;
            if (flight.startedAt <= at && (flight.closedAt === undefined || at <= flight.closedAt)) return flight;
        }
        return undefined;
    }

    private turnAt(at: number): number {
        let turn = this.initialTurn;
        for (const mark of this.marks) {
            if (mark.at <= at) turn = mark.turn;
            else break;
        }
        return turn;
    }

    private attach(flight: Flight, item: Classified): void {
        if (flight.turn !== undefined) this.resolved.push({ ...item, turn: flight.turn });
        else flight.pending.push(item);
    }

    private resolve(flight: Flight, turn: number): void {
        flight.turn = turn;
        for (const item of flight.pending.splice(0)) this.resolved.push({ ...item, turn });
    }

    private fallback(flight: Flight, at?: number): void {
        const end = flight.endedAt ?? at ?? flight.startedAt;
        flight.closedAt ??= end;
        this.resolve(flight, this.turnAt(end));
    }

    private takeResolved(): Assignment[] {
        return this.resolved.splice(0);
    }
}
