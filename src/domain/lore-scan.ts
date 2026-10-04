// Collects one World Info scan from SillyTavern's per-loop events (research/st-world-info.md §1–§2):
// WORLDINFO_SCAN_DONE after every loop (`state.loopCount`, `state.current`, `new.successful`, the cumulative
// `activated.entries` Map keyed "world.uid", `budget`), then WORLD_INFO_ACTIVATED with the final list (real
// generations only). Listeners run on the send path, so `scanDone()` only copies identity fields and references
// to strings; sizes, tokens, tags and recursion sources are computed after the reply (P15).
import { findVia } from './lore-match';
import type { GlobalMatchSettings, ScanFlags, Substitute, ViaCandidate } from './lore-match';

const SCAN_FLAG_NAMES = [
    'matchPersonaDescription',
    'matchCharacterDescription',
    'matchCharacterPersonality',
    'matchCharacterDepthPrompt',
    'matchScenario',
    'matchCreatorNotes',
] as const satisfies readonly (keyof ScanFlags)[];

/** `scan_state` of world-info.js (WI:43). */
export const SCAN_STATE = { NONE: 0, INITIAL: 1, RECURSION: 2, MIN_ACTIVATIONS: 3 } as const;

/** Stack tags of an activated entry (same union as the M1 API's LoreTag). */
export type LoreTagId =
    'bunnymo.core' | 'bunnymo.pack' | 'ck.archive' | 'localizer' | 'des.book' | 'canon' | 'maestro.book' | 'constant';

/** Why an activated entry did not reach the prompt. 'other' = another extension removed it after our listener. */
export type CutReason = 'budget' | 'maestro' | 'other';

/** A light copy of a scanned entry: identity, placement and the strings needed later (no nested arrays kept). */
export interface CapturedEntry {
    world: string;
    uid: number;
    comment: string;
    /** Content as ST injects it (macro-substituted by the scan, not regexed). */
    content: string;
    position: number;
    depth?: number;
    role?: number;
    order: number;
    constant: boolean;
    preventRecursion: boolean;
    /** Copies of the key lists (ST's arrays alias its cache and must never be mutated). */
    key: string[];
    keysecondary: string[];
    selective: boolean;
    selectiveLogic: number;
    caseSensitive: boolean | null;
    matchWholeWords: boolean | null;
    /** Own scan depth (null = the global `world_info_depth`). */
    scanDepth: number | null;
    /** Extra scan sources (`matchPersonaDescription`, …) that are on. */
    flags?: ScanFlags;
    /** `entry.extensions` reference (read-only: Localizer marker, Maestro canon meta). */
    extensions?: unknown;
    loop: number;
    recursionLevel: number;
    cut?: CutReason;
}

/** A finished activation row; structurally the M1 API's LoreActivation. */
export interface ActivationRow {
    world: string;
    uid: number;
    comment: string;
    chars: number;
    tokens: number;
    position: number;
    depth?: number;
    role?: number;
    order: number;
    loop: number;
    recursionLevel: number;
    via?: { world: string; uid: number };
    key?: string;
    cut?: boolean;
    cutBy?: 'budget' | 'maestro';
    tags: LoreTagId[];
}

/** A turn record; structurally the M1 API's TurnLoreRecord. */
export interface LoreRecordRow {
    messageIndex: number;
    at: number;
    generationType: string;
    activations: ActivationRow[];
    totalChars: number;
    totalTokens: number;
    overflow: boolean;
    budgetTokens?: number;
    canonChars?: number;
    simulated?: boolean;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function num(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function optNum(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function optBool(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

/** Our id of an entry. ST keys its Map with `${world}.${uid}`, which is ambiguous for names with dots. */
export function entryId(world: string, uid: number): string {
    return `${world}\u0000${uid}`;
}

/** Our id of a raw scan entry; null when it has no world/uid. */
function rawId(raw: unknown): string | null {
    if (!isDict(raw) || typeof raw.world !== 'string') return null;
    const uid = Number(raw.uid);
    return Number.isFinite(uid) ? entryId(raw.world, uid) : null;
}

/** Copies the fields M1 needs from a scan entry; null when it has no world/uid. */
export function captureEntry(raw: unknown, loop: number, recursionLevel: number): CapturedEntry | null {
    if (!isDict(raw)) return null;
    const uid = Number(raw.uid);
    if (typeof raw.world !== 'string' || !Number.isFinite(uid)) return null;
    const entry: CapturedEntry = {
        world: raw.world,
        uid,
        comment: typeof raw.comment === 'string' ? raw.comment : '',
        content: typeof raw.content === 'string' ? raw.content : '',
        position: num(raw.position),
        order: num(raw.order, 100),
        constant: raw.constant === true,
        preventRecursion: raw.preventRecursion === true,
        key: strings(raw.key),
        keysecondary: strings(raw.keysecondary),
        selective: raw.selective === true,
        selectiveLogic: num(raw.selectiveLogic),
        caseSensitive: optBool(raw.caseSensitive),
        matchWholeWords: optBool(raw.matchWholeWords),
        scanDepth: optNum(raw.scanDepth) ?? null,
        loop,
        recursionLevel,
    };
    let flags: ScanFlags | undefined;
    for (const flag of SCAN_FLAG_NAMES) {
        if (raw[flag] === true) (flags ??= {})[flag] = true;
    }
    if (flags) entry.flags = flags;
    const depth = optNum(raw.depth);
    if (depth !== undefined) entry.depth = depth;
    const role = optNum(raw.role);
    if (role !== undefined) entry.role = role;
    if (raw.extensions !== undefined) entry.extensions = raw.extensions;
    return entry;
}

interface MapLike {
    values(): Iterable<unknown>;
}

function isMapLike(value: unknown): value is MapLike {
    return typeof value === 'object' && value !== null && typeof (value as MapLike).values === 'function';
}

/**
 * State of one scan. Feed it every WORLDINFO_SCAN_DONE payload of the scan (`scanDone`) and the
 * WORLD_INFO_ACTIVATED list (`activatedFinal`); read the entries with `result()`.
 */
export class ScanCollector {
    readonly startedAt: number;
    private lastLoop = 0;
    private recursionSteps = 0;
    private budgetTokens: number | undefined;
    private overflowed = false;
    private complete = false;
    private readonly activated = new Map<string, CapturedEntry>();
    /** Passed a loop but never reached the activated Map (cut by the budget or removed by a listener). */
    private readonly cutEntries = new Map<string, CapturedEntry>();
    private finalIds: Set<string> | null = null;
    private readonly maestroCuts = new Set<string>();

    constructor(
        readonly generationType: string,
        readonly chatId: string | null = null,
        now = Date.now(),
    ) {
        this.startedAt = now;
    }

    /** At least one loop or the final list arrived. */
    hasData(): boolean {
        return this.lastLoop > 0 || this.finalIds !== null;
    }

    /** The scan finished (final list seen, or a loop reported no next state): later scans are someone else's. */
    isComplete(): boolean {
        return this.complete;
    }

    loops(): number {
        return this.lastLoop;
    }

    budget(): number | undefined {
        return this.budgetTokens;
    }

    overflow(): boolean {
        return this.overflowed;
    }

    /** One WORLDINFO_SCAN_DONE payload. Cheap: identity copies only. */
    scanDone(args: unknown): void {
        if (this.complete || !isDict(args)) return;
        const state = isDict(args.state) ? args.state : {};
        const loop = num(state.loopCount, this.lastLoop + 1);
        // A first loop again means a new scan (several scans in one collector only happen when an extension runs
        // its own scan before ours finished; the latest one wins).
        if (loop <= this.lastLoop) this.reset();
        this.lastLoop = loop;
        const current = num(state.current, SCAN_STATE.INITIAL);
        if (current === SCAN_STATE.RECURSION) this.recursionSteps++;
        const level = current === SCAN_STATE.RECURSION ? this.recursionSteps : 0;

        // The Map is cumulative: identify first, copy only entries not seen yet (keeps every loop O(new entries)).
        const activated = isDict(args.activated) ? args.activated.entries : undefined;
        if (isMapLike(activated)) {
            for (const raw of activated.values()) {
                const id = rawId(raw);
                if (id === null) continue;
                this.cutEntries.delete(id);
                if (this.activated.has(id)) continue;
                const entry = captureEntry(raw, loop, level);
                if (entry) this.activated.set(id, entry);
            }
        }
        // Successful this loop but not in the activated Map: cut by the budget (WI:5061-5073) — which always sets
        // `overflowed` — or, without an overflow, removed by a listener that ran before ours.
        const budget = isDict(args.budget) ? args.budget : {};
        const reason: CutReason = budget.overflowed === true ? 'budget' : 'other';
        const fresh = isDict(args.new) && Array.isArray(args.new.successful) ? args.new.successful : [];
        for (const raw of fresh) {
            const id = rawId(raw);
            if (id === null || this.activated.has(id) || this.cutEntries.has(id)) continue;
            const entry = captureEntry(raw, loop, level);
            if (entry) this.cutEntries.set(id, { ...entry, cut: reason });
        }
        const budgetNow = optNum(budget.current);
        if (budgetNow !== undefined) this.budgetTokens = budgetNow;
        if (budget.overflowed === true) this.overflowed = true;
        if (num(state.next, SCAN_STATE.NONE) === SCAN_STATE.NONE) this.complete = true;
    }

    /** WORLD_INFO_ACTIVATED: the entries that really went into the prompt. */
    activatedFinal(entries: unknown): void {
        if (!Array.isArray(entries)) return;
        const ids = new Set<string>();
        for (const raw of entries) {
            const entry = captureEntry(raw, Math.max(1, this.lastLoop), 0);
            if (!entry) continue;
            const id = entryId(entry.world, entry.uid);
            ids.add(id);
            const known = this.activated.get(id);
            // Content is macro-substituted by now; keep the final string.
            if (known) known.content = entry.content;
            else {
                this.cutEntries.delete(id);
                this.activated.set(id, entry);
            }
        }
        this.finalIds = ids;
        this.complete = true;
    }

    /** A Maestro rule removed this entry (M22 calls it through the M1 API). */
    markCut(world: string, uid: number): void {
        this.maestroCuts.add(entryId(world, uid));
    }

    /** Activated entries in activation order, then the cut ones. */
    result(): CapturedEntry[] {
        const rows: CapturedEntry[] = [];
        for (const [id, entry] of this.activated) {
            const removed = this.finalIds !== null && !this.finalIds.has(id);
            if (this.maestroCuts.has(id)) rows.push({ ...entry, cut: 'maestro' });
            else if (removed) rows.push({ ...entry, cut: 'other' });
            else rows.push({ ...entry });
        }
        for (const [id, entry] of this.cutEntries) {
            rows.push(this.maestroCuts.has(id) ? { ...entry, cut: 'maestro' } : { ...entry });
        }
        return rows.sort((a, b) => a.loop - b.loop);
    }

    private reset(): void {
        this.activated.clear();
        this.cutEntries.clear();
        this.recursionSteps = 0;
        this.overflowed = false;
        this.budgetTokens = undefined;
        this.finalIds = null;
    }
}

/**
 * Recursion sources: for every entry activated in a recursion loop, the entry from an earlier loop whose content
 * contains one of its keys (most recent loop first, the way the recursion buffer grew). Entries flagged
 * `preventRecursion` never feed the buffer (WI:5139-5144).
 */
export function attributeVia(
    entries: readonly CapturedEntry[],
    globals: GlobalMatchSettings,
    substitute?: Substitute,
    parseRegex?: (key: string) => RegExp | null,
): Map<string, { world: string; uid: number }> {
    const result = new Map<string, { world: string; uid: number }>();
    const feeding = entries.filter((entry) => !entry.preventRecursion && entry.cut !== 'other');
    for (const entry of entries) {
        if (entry.recursionLevel <= 0) continue;
        const candidates: ViaCandidate[] = feeding
            .filter((other) => other.loop < entry.loop)
            .sort((a, b) => b.loop - a.loop)
            .map((other) => ({ world: other.world, uid: other.uid, content: other.content }));
        const via = findVia(entry, candidates, globals, substitute, parseRegex);
        if (via) result.set(entryId(entry.world, entry.uid), via);
    }
    return result;
}

export interface AssembleOptions {
    messageIndex: number;
    at: number;
    generationType: string;
    budgetTokens?: number;
    overflow: boolean;
    simulated?: boolean;
    tokens(entry: CapturedEntry): number;
    tags(entry: CapturedEntry): LoreTagId[];
    via?: Map<string, { world: string; uid: number }>;
}

/** Builds the turn record. Totals count only entries that reached the prompt. */
export function assembleRecord(entries: readonly CapturedEntry[], options: AssembleOptions): LoreRecordRow {
    const activations: ActivationRow[] = entries.map((entry) => {
        const tags = options.tags(entry);
        const row: ActivationRow = {
            world: entry.world,
            uid: entry.uid,
            comment: entry.comment,
            chars: entry.content.length,
            tokens: options.tokens(entry),
            position: entry.position,
            order: entry.order,
            loop: entry.loop,
            recursionLevel: entry.recursionLevel,
            tags,
        };
        if (entry.depth !== undefined) row.depth = entry.depth;
        if (entry.role !== undefined) row.role = entry.role;
        const via = options.via?.get(entryId(entry.world, entry.uid));
        if (via) row.via = via;
        if (entry.cut) {
            row.cut = true;
            if (entry.cut !== 'other') row.cutBy = entry.cut;
        }
        return row;
    });
    let totalChars = 0;
    let totalTokens = 0;
    let canonChars = 0;
    for (const row of activations) {
        if (row.cut) continue;
        totalChars += row.chars;
        totalTokens += row.tokens;
        if (row.tags.includes('canon')) canonChars += row.chars;
    }
    const record: LoreRecordRow = {
        messageIndex: options.messageIndex,
        at: options.at,
        generationType: options.generationType,
        activations,
        totalChars,
        totalTokens,
        overflow: options.overflow,
        canonChars,
    };
    if (options.budgetTokens !== undefined) record.budgetTokens = options.budgetTokens;
    if (options.simulated) record.simulated = true;
    return record;
}
