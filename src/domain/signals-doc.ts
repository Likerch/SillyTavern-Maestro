// The chat document 'signals' (plan §4.4, P14, §5 «Отмена»): one record per committed assistant reply with its
// message stamp (`send_date|swipe_id`), the signals it gave and the baseline trace that undoes it. A swiped, edited
// or deleted reply no longer matches its stamp: its record and every later one are rolled back exactly. Pending
// signals are those of records after the last revision (`consumedUpTo`). Pure: no DOM, no SillyTavern.
import type { Signal } from '../shared/contracts';
import { committedIndices } from './places-registry';
import { emptyBaseline, rollbackTrace } from './signals-diff';
import type { SignalsBaseline, TraceEntry } from './signals-diff';

export interface SignalRecord {
    index: number;
    stamp: string;
    /** The reply had DES tracker data (the two-turn rule compares with the last such reply). */
    tracker: boolean;
    at: number;
    /** Signals of this turn after folding (empty for turns read silently on the first visit). */
    signals: Signal[];
    folded: number;
    /** Signals other modules put on the bus for this turn (M26 'fact.new'): kept for the revision, not re-emitted. */
    extra?: Signal[];
    trace: TraceEntry[];
}

export interface SignalsDocData {
    records: SignalRecord[];
    baseline: SignalsBaseline;
    /** Last message index a revision consumed (-1: none). */
    consumedUpTo: number;
    /** The chat was read once (the first visit sets baselines silently). */
    initialized: boolean;
}

/** What a stamp is computed from. */
export interface StampSource {
    send_date?: unknown;
    swipe_id?: unknown;
}

export function emptySignalsDoc(): SignalsDocData {
    return { records: [], baseline: emptyBaseline(), consumedUpTo: -1, initialized: false };
}

/** `send_date|swipe_id`: changes when the reply is swiped or replaced; an edit keeps it (reported separately). */
export function messageStamp(message: StampSource | null | undefined): string {
    if (!message) return '';
    const swipe = typeof message.swipe_id === 'number' && message.swipe_id >= 0 ? message.swipe_id : 0;
    const sent = message.send_date;
    return `${typeof sent === 'string' || typeof sent === 'number' ? sent : ''}|${swipe}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readSignal(value: unknown): Signal | null {
    if (!isRecord(value) || typeof value.kind !== 'string') return null;
    const signal: Signal = {
        kind: value.kind,
        chatId: typeof value.chatId === 'string' ? value.chatId : null,
        at: typeof value.at === 'number' ? value.at : 0,
    };
    if (typeof value.messageIndex === 'number') signal.messageIndex = value.messageIndex;
    if (typeof value.entity === 'string') signal.entity = value.entity;
    if (isRecord(value.data)) signal.data = value.data;
    return signal;
}

function readSignals(value: unknown): Signal[] {
    return Array.isArray(value) ? value.map(readSignal).filter((signal): signal is Signal => signal !== null) : [];
}

function readTrace(value: unknown): TraceEntry[] {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is TraceEntry => isRecord(entry) && typeof entry.k === 'string');
}

function readRecord(value: unknown): SignalRecord | null {
    if (!isRecord(value) || typeof value.index !== 'number' || !Number.isInteger(value.index)) return null;
    const record: SignalRecord = {
        index: value.index,
        stamp: typeof value.stamp === 'string' ? value.stamp : '',
        tracker: value.tracker === true,
        at: typeof value.at === 'number' ? value.at : 0,
        signals: readSignals(value.signals),
        folded: typeof value.folded === 'number' ? value.folded : 0,
        trace: readTrace(value.trace),
    };
    const extra = readSignals(value.extra);
    if (extra.length) record.extra = extra;
    return record;
}

function readBaseline(value: unknown): SignalsBaseline {
    if (!isRecord(value)) return emptyBaseline();
    const baseline = value as unknown as SignalsBaseline;
    if (!isRecord(baseline.chars)) baseline.chars = {};
    if (!isRecord(baseline.names)) baseline.names = {};
    if (baseline.aliases !== undefined && !isRecord(baseline.aliases)) delete baseline.aliases;
    if (baseline.memories !== undefined && !isRecord(baseline.memories)) delete baseline.memories;
    if (baseline.quests !== undefined && !Array.isArray(baseline.quests)) delete baseline.quests;
    return baseline;
}

/** Repairs a stored document (a copy is made by the caller): bad records dropped, records kept in index order. */
export function normalizeSignalsDoc(raw: unknown): SignalsDocData {
    if (!isRecord(raw)) return emptySignalsDoc();
    const records = (Array.isArray(raw.records) ? raw.records : [])
        .map(readRecord)
        .filter((record): record is SignalRecord => record !== null)
        .sort((a, b) => a.index - b.index);
    const unique = records.filter((record, i) => i === 0 || (records[i - 1] as SignalRecord).index !== record.index);
    return {
        records: unique,
        baseline: readBaseline(raw.baseline),
        consumedUpTo: typeof raw.consumedUpTo === 'number' && Number.isFinite(raw.consumedUpTo) ? raw.consumedUpTo : -1,
        initialized: raw.initialized === true,
    };
}

/** Index of the latest record, -1 when none. */
export function lastRecordIndex(doc: SignalsDocData): number {
    return doc.records.length ? (doc.records[doc.records.length - 1] as SignalRecord).index : -1;
}

/** The latest record whose reply had tracker data. */
export function lastTrackerRecord(doc: SignalsDocData): SignalRecord | null {
    for (let i = doc.records.length - 1; i >= 0; i--) {
        const record = doc.records[i] as SignalRecord;
        if (record.tracker) return record;
    }
    return null;
}

/**
 * Message index of the first record (among the last `recent`) whose message no longer has its stamp: swiped,
 * replaced or shifted by a deletion. Null when every checked record matches.
 */
export function firstStaleRecord(
    doc: SignalsDocData,
    stampAt: (index: number) => string | null,
    recent = Infinity,
): number | null {
    const start = Math.max(0, doc.records.length - recent);
    for (let i = start; i < doc.records.length; i++) {
        const record = doc.records[i] as SignalRecord;
        if (stampAt(record.index) !== record.stamp) return record.index;
    }
    return null;
}

/** Drops every record from `index` on, newest first, undoing their baseline changes. Returns how many went. */
export function rollbackFrom(doc: SignalsDocData, index: number): number {
    let count = 0;
    while (doc.records.length && (doc.records[doc.records.length - 1] as SignalRecord).index >= index) {
        const record = doc.records.pop() as SignalRecord;
        rollbackTrace(doc.baseline, record.trace);
        count++;
    }
    return count;
}

/** Keeps the newest `keep` records (older ones can no longer be rolled back one by one). */
export function trimRecords(doc: SignalsDocData, keep: number): void {
    const limit = Math.max(1, Math.floor(keep));
    if (doc.records.length > limit) doc.records.splice(0, doc.records.length - limit);
}

/** Signals not consumed by a revision yet, oldest first (each record's own, then other modules'). */
export function pendingSignals(doc: SignalsDocData): Signal[] {
    const out: Signal[] = [];
    for (const record of doc.records) {
        if (record.index <= doc.consumedUpTo) continue;
        out.push(...record.signals, ...(record.extra ?? []));
    }
    return out;
}

/** Committed assistant replies after the last revision (the «every N messages» trigger). */
export function messagesSince(
    doc: SignalsDocData,
    chat: readonly ({ is_user?: boolean; is_system?: boolean } | null | undefined)[],
): number {
    return committedIndices(chat).filter((index) => index > doc.consumedUpTo).length;
}
