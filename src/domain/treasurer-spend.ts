// Treasurer (M21) pure helpers: spend sources, per-source totals, classification of the core cost meter's entries
// (src/core/cost.ts), the per-turn document of a chat and day summaries from the core meter's day files.
// The shapes mirror src/features/treasurer/api.ts structurally (domain cannot import features).

/** Same union as TreasurerApi's SpendSource. */
export type SpendSource = 'main' | 'regeneration' | 'autoSwipe' | 'qvink' | 'maestro' | 'nai' | 'other';

/** Display and summary order. */
export const SPEND_SOURCES: readonly SpendSource[] = [
    'main',
    'regeneration',
    'autoSwipe',
    'qvink',
    'maestro',
    'nai',
    'other',
];

/** Generation types that redo the last reply (ST swipe and regenerate); M12's auto-swipes are swipes too. */
export const REDO_TYPES: ReadonlySet<string> = new Set(['swipe', 'regenerate']);

/**
 * A core meter entry as `recent()` returns it: Anlas entries carry `anlas` (usd 0), `tokens.cached` appears once
 * the core reads cached prompt tokens from `usage`.
 */
export interface LedgerEntry {
    source: string;
    task?: string;
    usd: number;
    tokens?: { prompt: number; completion: number; cached?: number };
    estimated?: boolean;
    at: number;
    chatId?: string | null;
    anlas?: number;
}

/** Running totals of one source. `estimated` counts responses without a real cost. */
export interface LineTotals {
    usd: number;
    anlas: number;
    requests: number;
    prompt: number;
    completion: number;
    cached: number;
    estimated: number;
}

export type LineMap = Partial<Record<SpendSource, LineTotals>>;

/** Structural twin of TreasurerApi's SpendLine. */
export interface SpendLineData {
    source: SpendSource;
    usd: number;
    anlas?: number;
    requests: number;
    tokens: { prompt: number; completion: number; cached?: number };
    estimated: boolean;
}

/** Structural twin of TreasurerApi's SpendSummary. */
export interface SpendSummaryData {
    period: 'turn' | 'session' | 'day';
    from: number;
    to: number;
    totalUsd: number;
    totalAnlas: number;
    lines: SpendLineData[];
}

/** Structural twin of TreasurerApi's TurnSpend. */
export interface TurnSpendData {
    messageIndex: number;
    at: number;
    lines: SpendLineData[];
}

/* ------------------------------------------------------------------ numbers */

function isDict(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Finite positive number, else 0 (hand edits, NaN, negatives). */
export function positive(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/** Drops float dust left by subtractions. */
function clean(value: number): number {
    return value > 1e-12 ? value : 0;
}

/* ------------------------------------------------------------------ classification */

export function isAnlasEntry(entry: Pick<LedgerEntry, 'anlas'>): boolean {
    return positive(entry.anlas) > 0;
}

/** A main generation by its type: normal / continue / impersonate → main, swipe / regenerate → redo, quiet → other. */
export function classifyGeneration(type: string | undefined, auto: boolean): SpendSource {
    if (type === 'quiet') return 'other';
    if (type !== undefined && REDO_TYPES.has(type)) return auto ? 'autoSwipe' : 'regeneration';
    return 'main';
}

/** Treasurer source of a core meter entry; `auto` = the generation it belongs to was M12's automatic swipe. */
export function classifyEntry(entry: Pick<LedgerEntry, 'source' | 'task' | 'anlas'>, auto = false): SpendSource {
    if (isAnlasEntry(entry)) return 'nai';
    switch (entry.source) {
        case 'main':
            return classifyGeneration(entry.task, auto);
        case 'qvink':
        case 'maestro':
        case 'nai':
            return entry.source;
        default:
            return 'other';
    }
}

/* ------------------------------------------------------------------ lines */

export function emptyLine(): LineTotals {
    return { usd: 0, anlas: 0, requests: 0, prompt: 0, completion: 0, cached: 0, estimated: 0 };
}

/** Adds one entry to the line of `source` (Anlas entries add Anlas only, never a request). */
export function addToLines(lines: LineMap, source: SpendSource, entry: LedgerEntry): void {
    const line = lines[source] ?? (lines[source] = emptyLine());
    if (isAnlasEntry(entry)) {
        line.anlas += positive(entry.anlas);
        return;
    }
    line.usd += positive(entry.usd);
    line.requests += 1;
    line.prompt += positive(entry.tokens?.prompt);
    line.completion += positive(entry.tokens?.completion);
    line.cached += positive(entry.tokens?.cached);
    if (entry.estimated) line.estimated += 1;
}

function lineEmpty(line: LineTotals | undefined): boolean {
    return !line || (line.usd <= 0 && line.anlas <= 0 && line.requests <= 0);
}

export function toSpendLine(source: SpendSource, line: LineTotals): SpendLineData {
    const tokens: SpendLineData['tokens'] = { prompt: line.prompt, completion: line.completion };
    if (line.cached > 0) tokens.cached = line.cached;
    const result: SpendLineData = {
        source,
        usd: line.usd,
        requests: line.requests,
        tokens,
        estimated: line.estimated > 0,
    };
    if (line.anlas > 0) result.anlas = line.anlas;
    return result;
}

/** Non-empty lines in SPEND_SOURCES order. */
export function toSpendLines(lines: LineMap): SpendLineData[] {
    const result: SpendLineData[] = [];
    for (const source of SPEND_SOURCES) {
        const line = lines[source];
        if (line && !lineEmpty(line)) result.push(toSpendLine(source, line));
    }
    return result;
}

export function totalsOf(lines: readonly SpendLineData[]): { usd: number; anlas: number } {
    let usd = 0;
    let anlas = 0;
    for (const line of lines) {
        usd += line.usd;
        anlas += line.anlas ?? 0;
    }
    return { usd, anlas };
}

export function summaryOf(
    period: SpendSummaryData['period'],
    from: number,
    to: number,
    lines: SpendLineData[],
): SpendSummaryData {
    const totals = totalsOf(lines);
    return { period, from, to, totalUsd: totals.usd, totalAnlas: totals.anlas, lines };
}

/** The line of one source in a list (absent sources read as an empty line). */
export function lineOf(lines: readonly SpendLineData[], source: SpendSource): SpendLineData | undefined {
    return lines.find((line) => line.source === source);
}

/* ------------------------------------------------------------------ per-chat document */

export const TURN_CAP = 300;
export const ANLAS_KEY_CAP = 1000;
export const DOC_VERSION = 1;

export interface StoredTurn {
    /** Assistant message index of the turn. */
    messageIndex: number;
    /** First spend of the turn. */
    at: number;
    /** Latest spend of the turn. */
    last: number;
    lines: LineMap;
}

/** app.chat document kind 'treasurer'. */
export interface TreasurerDoc {
    version: number;
    /** Sorted by messageIndex, oldest first, at most TURN_CAP. */
    turns: StoredTurn[];
    /** NAI Studio records whose Anlas the treasurer added itself (inline images, later media), newest last. */
    anlasKeys: string[];
}

export function emptyDoc(): TreasurerDoc {
    return { version: DOC_VERSION, turns: [], anlasKeys: [] };
}

function readLine(raw: unknown): LineTotals | undefined {
    if (!isDict(raw)) return undefined;
    return {
        usd: positive(raw['usd']),
        anlas: positive(raw['anlas']),
        requests: positive(raw['requests']),
        prompt: positive(raw['prompt']),
        completion: positive(raw['completion']),
        cached: positive(raw['cached']),
        estimated: positive(raw['estimated']),
    };
}

/** Repairs whatever the store returned (older versions, hand edits) in place and returns it. */
export function sanitizeDoc(raw: unknown): TreasurerDoc {
    const doc = (isDict(raw) ? raw : {}) as unknown as TreasurerDoc;
    doc.version = DOC_VERSION;
    const turns: StoredTurn[] = [];
    for (const item of Array.isArray(doc.turns) ? (doc.turns as unknown[]) : []) {
        if (!isDict(item) || typeof item['messageIndex'] !== 'number' || !Number.isInteger(item['messageIndex'])) {
            continue;
        }
        const lines: LineMap = {};
        const rawLines = isDict(item['lines']) ? item['lines'] : {};
        for (const source of SPEND_SOURCES) {
            const line = readLine(rawLines[source]);
            if (line) lines[source] = line;
        }
        const at = positive(item['at']);
        turns.push({ messageIndex: item['messageIndex'], at, last: Math.max(at, positive(item['last'])), lines });
    }
    turns.sort((a, b) => a.messageIndex - b.messageIndex);
    doc.turns = turns.slice(-TURN_CAP);
    const keys = Array.isArray(doc.anlasKeys) ? (doc.anlasKeys as unknown[]) : [];
    doc.anlasKeys = keys.filter((key): key is string => typeof key === 'string').slice(-ANLAS_KEY_CAP);
    return doc;
}

/** One change of the per-chat document; kept until saved so it can be replayed over a newer copy (other tab). */
export type DocOp =
    { kind: 'spend'; turn: number; source: SpendSource; entry: LedgerEntry } | { kind: 'anlasKey'; key: string };

function findTurn(turns: StoredTurn[], messageIndex: number): number {
    for (let i = turns.length - 1; i >= 0; i--) {
        const turn = turns[i]!;
        if (turn.messageIndex === messageIndex) return i;
        if (turn.messageIndex < messageIndex) return -(i + 2);
    }
    return -1;
}

export function applyOp(doc: TreasurerDoc, op: DocOp, caps = { turns: TURN_CAP, keys: ANLAS_KEY_CAP }): void {
    if (op.kind === 'anlasKey') {
        if (!doc.anlasKeys.includes(op.key)) doc.anlasKeys.push(op.key);
        if (doc.anlasKeys.length > caps.keys) doc.anlasKeys.splice(0, doc.anlasKeys.length - caps.keys);
        return;
    }
    if (!Number.isInteger(op.turn) || op.turn < 0) return;
    const found = findTurn(doc.turns, op.turn);
    let turn: StoredTurn;
    if (found >= 0) {
        turn = doc.turns[found]!;
    } else {
        // -1: before every turn; -(i + 2): right after turns[i].
        const insertAt = found === -1 ? 0 : -found - 1;
        turn = { messageIndex: op.turn, at: op.entry.at, last: op.entry.at, lines: {} };
        doc.turns.splice(insertAt, 0, turn);
    }
    addToLines(turn.lines, op.source, op.entry);
    if (op.entry.at < turn.at || turn.at <= 0) turn.at = op.entry.at;
    if (op.entry.at > turn.last) turn.last = op.entry.at;
    if (doc.turns.length > caps.turns) doc.turns.splice(0, doc.turns.length - caps.turns);
}

/** The last `limit` turns, oldest first. */
export function turnList(doc: TreasurerDoc, limit: number): TurnSpendData[] {
    const count = Math.max(0, Math.floor(limit));
    if (count === 0) return [];
    return doc.turns.slice(-count).map((turn) => ({
        messageIndex: turn.messageIndex,
        at: turn.at,
        lines: toSpendLines(turn.lines),
    }));
}

/* ------------------------------------------------------------------ dates */

/** Local date YYYY-MM-DD (the core meter's dateKey). */
export function dayKey(ms: number): string {
    const date = new Date(ms);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight of a date key and the last millisecond of that day; null for a malformed key. */
export function dayRange(date: string): { from: number; to: number } | null {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
    if (!match) return null;
    const [year, month, day] = [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
    const from = new Date(year, month, day).getTime();
    const to = new Date(year, month, day + 1).getTime() - 1;
    return { from, to };
}

/** The last `count` local dates ending with the day of `now`, oldest first (DST-safe). */
export function lastDays(now: number, count: number): string[] {
    const today = new Date(now);
    const days: string[] = [];
    for (let i = Math.max(1, Math.floor(count)) - 1; i >= 0; i--) {
        days.push(dayKey(new Date(today.getFullYear(), today.getMonth(), today.getDate() - i).getTime()));
    }
    return days;
}

/* ------------------------------------------------------------------ day files */

/** What the treasurer reads from a core day file (src/core/cost.ts DayTotals). */
export interface DayData {
    date: string;
    totalUsd: number;
    bySource: Record<string, number>;
    byTask: Record<string, number>;
    anlas: number;
    /** Today's last entries (at most 200 in the core meter): requests and tokens per source come from here. */
    recent: LedgerEntry[];
}

function numberMap(value: unknown): Record<string, number> {
    const out: Record<string, number> = {};
    if (!isDict(value)) return out;
    for (const [key, item] of Object.entries(value)) {
        const n = positive(item);
        if (n > 0) out[key] = n;
    }
    return out;
}

function readEntry(raw: unknown): LedgerEntry | null {
    if (!isDict(raw) || typeof raw['at'] !== 'number' || typeof raw['source'] !== 'string') return null;
    const entry: LedgerEntry = { source: raw['source'], usd: positive(raw['usd']), at: raw['at'] };
    if (typeof raw['task'] === 'string') entry.task = raw['task'];
    if (raw['estimated'] === true) entry.estimated = true;
    if (positive(raw['anlas']) > 0) entry.anlas = positive(raw['anlas']);
    if (isDict(raw['tokens'])) {
        const tokens = raw['tokens'];
        entry.tokens = { prompt: positive(tokens['prompt']), completion: positive(tokens['completion']) };
        if (positive(tokens['cached']) > 0) entry.tokens.cached = positive(tokens['cached']);
    }
    if (typeof raw['chatId'] === 'string' || raw['chatId'] === null) entry.chatId = raw['chatId'];
    return entry;
}

/** A day file as the core meter writes it (or its live totals); null when absent or for another date. */
export function readDay(raw: unknown, date: string): DayData | null {
    if (!isDict(raw) || raw['date'] !== date) return null;
    const recent = Array.isArray(raw['recent'])
        ? raw['recent'].map(readEntry).filter((entry): entry is LedgerEntry => entry !== null)
        : [];
    return {
        date,
        totalUsd: positive(raw['totalUsd']),
        bySource: numberMap(raw['bySource']),
        byTask: numberMap(raw['byTask']),
        anlas: positive(raw['anlas']),
        recent,
    };
}

/** Auto-swipe spend of one day (the core day file cannot tell an automatic swipe from the user's). */
export interface AutoDay {
    usd: number;
    requests: number;
    prompt: number;
    completion: number;
}

/**
 * Day summary: USD per source exactly from the core totals (main split by generation type through byTask:
 * swipe + regenerate → regeneration, quiet → other, the auto-swipe share from the treasurer's own day notes),
 * requests and tokens per source from the day's recent entries (complete for days with up to 200 responses).
 */
export function daySummary(day: DayData | null, date: string, auto?: AutoDay): SpendSummaryData {
    const range = dayRange(date) ?? { from: 0, to: 0 };
    if (!day) return summaryOf('day', range.from, range.to, []);
    const by = day.bySource;
    const task = day.byTask;
    const mainTotal = by['main'] ?? 0;
    const quiet = Math.min(mainTotal, task['quiet'] ?? 0);
    const redo = Math.min(mainTotal - quiet, (task['swipe'] ?? 0) + (task['regenerate'] ?? 0));
    const autoUsd = Math.min(redo, positive(auto?.usd));
    let unknown = 0;
    for (const [source, usd] of Object.entries(by)) {
        if (!['main', 'qvink', 'maestro', 'nai', 'other'].includes(source)) unknown += usd;
    }
    const usd: Record<SpendSource, number> = {
        main: clean(mainTotal - quiet - redo),
        regeneration: clean(redo - autoUsd),
        autoSwipe: clean(autoUsd),
        qvink: by['qvink'] ?? 0,
        maestro: by['maestro'] ?? 0,
        nai: by['nai'] ?? 0,
        other: (by['other'] ?? 0) + quiet + unknown,
    };

    const counts: LineMap = {};
    for (const entry of day.recent) addToLines(counts, classifyEntry(entry), entry);
    if (auto && positive(auto.requests) > 0) {
        const regeneration = counts.regeneration ?? emptyLine();
        const moved = Math.min(regeneration.requests, positive(auto.requests));
        regeneration.requests -= moved;
        regeneration.prompt = Math.max(0, regeneration.prompt - positive(auto.prompt));
        regeneration.completion = Math.max(0, regeneration.completion - positive(auto.completion));
        counts.regeneration = regeneration;
        counts.autoSwipe = {
            ...emptyLine(),
            requests: positive(auto.requests),
            prompt: positive(auto.prompt),
            completion: positive(auto.completion),
        };
    }

    const lines: SpendLineData[] = [];
    for (const source of SPEND_SOURCES) {
        const line = counts[source] ?? emptyLine();
        line.usd = usd[source];
        line.anlas = source === 'nai' ? day.anlas : 0;
        if (!lineEmpty(line)) lines.push(toSpendLine(source, line));
    }
    return { period: 'day', from: range.from, to: range.to, totalUsd: day.totalUsd, totalAnlas: day.anlas, lines };
}

/* ------------------------------------------------------------------ the treasurer's own day notes */

export const AUTO_DAYS_KEEP = 62;

export interface AutoDaysDoc {
    version: number;
    days: Record<string, AutoDay>;
}

export function readAutoDays(raw: unknown): AutoDaysDoc {
    const doc: AutoDaysDoc = { version: 1, days: {} };
    const days = isDict(raw) && isDict(raw['days']) ? raw['days'] : {};
    for (const [date, value] of Object.entries(days)) {
        if (!dayRange(date) || !isDict(value)) continue;
        doc.days[date] = {
            usd: positive(value['usd']),
            requests: positive(value['requests']),
            prompt: positive(value['prompt']),
            completion: positive(value['completion']),
        };
    }
    return doc;
}

export function addAutoDay(days: Record<string, AutoDay>, date: string, entry: LedgerEntry): void {
    const day = days[date] ?? (days[date] = { usd: 0, requests: 0, prompt: 0, completion: 0 });
    day.usd += positive(entry.usd);
    day.requests += 1;
    day.prompt += positive(entry.tokens?.prompt);
    day.completion += positive(entry.tokens?.completion);
}

/** Adds a delta of days to a base (both untouched) and keeps the newest `keep` days. */
export function mergeAutoDays(base: AutoDaysDoc, delta: Record<string, AutoDay>, keep = AUTO_DAYS_KEEP): AutoDaysDoc {
    const days: Record<string, AutoDay> = {};
    for (const [date, day] of Object.entries(base.days)) days[date] = { ...day };
    for (const [date, day] of Object.entries(delta)) {
        const target = days[date] ?? (days[date] = { usd: 0, requests: 0, prompt: 0, completion: 0 });
        target.usd += day.usd;
        target.requests += day.requests;
        target.prompt += day.prompt;
        target.completion += day.completion;
    }
    const kept = Object.keys(days).sort().slice(-Math.max(1, keep));
    return { version: 1, days: Object.fromEntries(kept.map((date) => [date, days[date]!])) };
}
