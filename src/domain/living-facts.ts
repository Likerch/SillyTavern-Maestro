// M26 «Живой канон» — the per-chat document and the rules of the provisional status (plan M26 п. 2–4, P14, §5
// «Отмена»): drafts of uncommitted replies, facts saved as provisional canon, the confirmation rules, invalidation
// by swipe/delete/edit, the seed and English canon texts. Pure: no DOM, no SillyTavern; ids and clocks come from
// the caller.
import { ENTRY_TYPES } from './entry-types';
import type { EntryTypeId } from './entry-types';
import { stableHash } from './hash';
import { LIVING_TYPES } from './living-detect';
import type { LivingType, NamePattern } from './living-detect';

export type ConfirmReasonId = 'userMentioned' | 'userAccepted' | 'resurfaced' | 'survived';
export type LivingStatusId = 'provisional' | 'active' | 'disputed' | 'dropped';
/** Why a fact left the canon: the user dropped it, its message went away, an undo, it vanished from the book. */
export type DropReason = 'user' | 'invalidated' | 'undone' | 'missing' | 'duplicate';
/** Where a fact came from: the cheap search of a reply, the batch extraction, the revision (M8 class 'new'). */
export type FactOrigin = 'reply' | 'extract' | 'revision';

export const CONFIRM_REASONS: readonly ConfirmReasonId[] = ['userMentioned', 'userAccepted', 'resurfaced', 'survived'];
const NAME_PATTERNS: readonly NamePattern[] = ['quoted', 'naming', 'typed', 'titled', 'multiword', 'single'];
const STATUSES: readonly LivingStatusId[] = ['provisional', 'active', 'disputed', 'dropped'];
const DROP_REASONS: readonly DropReason[] = ['user', 'invalidated', 'undone', 'missing', 'duplicate'];
const ORIGINS: readonly FactOrigin[] = ['reply', 'extract', 'revision'];

/** Marker that opens the cheap seed text of a provisional entry (plan M26 п. 3). */
export const SEED_MARKER = '[provisional]';
const SEED_MAX = 900;
const KEEP_COMMITS = 40;
const MAX_QUOTES = 4;

/** A name found in a reply that is not committed yet (P14: nothing reaches the canon before the send). */
export interface DraftData {
    name: string;
    type: LivingType;
    pattern: NamePattern;
    quote: string;
    count: number;
    descriptive: boolean;
    variants: string[];
    sourceMessage: number;
    /** Fingerprint of the message when it was read (a swipe or an edit changes it). */
    stamp: string;
    /** Significance at detection time. */
    score: number;
    /** Another name of this living fact (id): the commit extends its keys and quotes instead of adding a new one. */
    mergeInto?: string;
    at: number;
}

export interface FactData {
    id: string;
    /** Canon item uid once saved. */
    uid?: number;
    name: string;
    type: LivingType;
    /** The first quote, as the model wrote it. */
    quote: string;
    /** Later quotes merged into the fact. */
    quotes: string[];
    /** English canon text (batch extraction). */
    text?: string;
    english?: string;
    keys: string[];
    sourceMessage: number;
    stamp: string;
    status: LivingStatusId;
    survivedTurns: number;
    confirmedBy?: ConfirmReasonId;
    confirmedAt?: number;
    createdAt: number;
    /** Hash of the canon entry (content and keys) as Maestro last wrote or saw it: a change means someone edited it. */
    entryHash?: string;
    /** The contradiction that blocks it (disputed facts, failed confirmations). */
    conflict?: string;
    /** An Inbox card about a contradiction is open ('pending'), or the user kept the fact despite it ('kept'). */
    dispute?: 'pending' | 'kept';
    droppedBy?: DropReason;
    origin: FactOrigin;
    /** The last committed turn counted for survival (a turn is counted once). */
    countedTurn?: number;
    /** Counted in the statistics as confirmed / as contradicted after confirmation (each fact once). */
    wasConfirmed?: boolean;
    wasContradicted?: boolean;
}

/** Counters for the R3 metrics (plan §14, dev-plan 4.6), since the chat started using M26. */
export interface LivingStats {
    /** Provisional facts ever created. */
    provisional: number;
    /** Facts the user removed himself (drop, the pult, a rejected Inbox card) — not swipe/edit removals. */
    droppedByUser: number;
    /** Facts that became confirmed canon. */
    confirmed: number;
    /** Confirmed facts that later got a contradiction (a conflict card). */
    contradictedAfterConfirm: number;
}

export const STAT_KEYS: readonly (keyof LivingStats)[] = [
    'provisional',
    'droppedByUser',
    'confirmed',
    'contradictedAfterConfirm',
];

export function emptyStats(): LivingStats {
    return { provisional: 0, droppedByUser: 0, confirmed: 0, contradictedAfterConfirm: 0 };
}

export interface ExtractState {
    /** Messages up to this index were extracted. */
    upTo: number;
    /** Last attempt (successful or not) covered messages up to this index. */
    attemptAt: number;
    lastRun?: number;
    lastError?: string;
    added?: number;
    updated?: number;
}

export interface LivingDocData {
    drafts: DraftData[];
    facts: FactData[];
    /** Committed replies already processed: index and fingerprint (recent only). */
    committed: { index: number; stamp: string }[];
    extract: ExtractState;
    /** False until the first pass set the extraction start (no backlog of old history). */
    started: boolean;
    stats: LivingStats;
}

export function emptyLivingDoc(): LivingDocData {
    return {
        drafts: [],
        facts: [],
        committed: [],
        extract: { upTo: -1, attemptAt: -1 },
        started: false,
        stats: emptyStats(),
    };
}

/* ------------------------------------------------------------------ normalisation */

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, fallback = ''): string {
    return typeof value === 'string' ? value : fallback;
}

function int(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.floor(value) : fallback;
}

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
        : [];
}

function oneOf<T extends string>(list: readonly T[], value: unknown, fallback: T): T {
    return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : fallback;
}

export function isLivingType(value: unknown): value is LivingType {
    return typeof value === 'string' && (LIVING_TYPES as readonly string[]).includes(value);
}

function draftOf(raw: unknown): DraftData | null {
    if (!isDict(raw) || typeof raw.name !== 'string' || !raw.name.trim()) return null;
    const source = int(raw.sourceMessage, -1);
    if (source < 0) return null;
    const draft: DraftData = {
        name: raw.name.trim(),
        type: isLivingType(raw.type) ? raw.type : 'other',
        pattern: oneOf(NAME_PATTERNS, raw.pattern, 'single'),
        quote: str(raw.quote),
        count: Math.max(1, int(raw.count, 1)),
        descriptive: raw.descriptive === true,
        variants: strings(raw.variants),
        sourceMessage: source,
        stamp: str(raw.stamp),
        score: int(raw.score, 0),
        at: int(raw.at, 0),
    };
    if (typeof raw.mergeInto === 'string' && raw.mergeInto) draft.mergeInto = raw.mergeInto;
    return draft;
}

function factOf(raw: unknown): FactData | null {
    if (!isDict(raw) || typeof raw.id !== 'string' || typeof raw.name !== 'string' || !raw.name.trim()) return null;
    const fact: FactData = {
        id: raw.id,
        name: raw.name.trim(),
        type: isLivingType(raw.type) ? raw.type : 'other',
        quote: str(raw.quote),
        quotes: strings(raw.quotes),
        keys: strings(raw.keys),
        sourceMessage: int(raw.sourceMessage, -1),
        stamp: str(raw.stamp),
        status: oneOf(STATUSES, raw.status, 'provisional'),
        survivedTurns: Math.max(0, int(raw.survivedTurns, 0)),
        createdAt: int(raw.createdAt, 0),
        origin: oneOf(ORIGINS, raw.origin, 'reply'),
    };
    if (Number.isInteger(raw.uid)) fact.uid = raw.uid as number;
    if (typeof raw.text === 'string' && raw.text.trim()) fact.text = raw.text;
    if (typeof raw.english === 'string' && raw.english.trim()) fact.english = raw.english;
    if (typeof raw.confirmedBy === 'string') fact.confirmedBy = oneOf(CONFIRM_REASONS, raw.confirmedBy, 'survived');
    if (typeof raw.confirmedAt === 'number') fact.confirmedAt = raw.confirmedAt;
    if (typeof raw.entryHash === 'string') fact.entryHash = raw.entryHash;
    if (typeof raw.conflict === 'string' && raw.conflict) fact.conflict = raw.conflict;
    if (raw.dispute === 'pending' || raw.dispute === 'kept') fact.dispute = raw.dispute;
    if (typeof raw.droppedBy === 'string') fact.droppedBy = oneOf(DROP_REASONS, raw.droppedBy, 'missing');
    if (typeof raw.countedTurn === 'number') fact.countedTurn = raw.countedTurn;
    if (raw.wasConfirmed === true) fact.wasConfirmed = true;
    if (raw.wasContradicted === true) fact.wasContradicted = true;
    return fact;
}

/** A stored document of any shape → a valid one (unknown entries dropped). */
export function normalizeLivingDoc(raw: unknown): LivingDocData {
    const doc = emptyLivingDoc();
    if (!isDict(raw)) return doc;
    if (Array.isArray(raw.drafts)) doc.drafts = raw.drafts.map(draftOf).filter((item): item is DraftData => !!item);
    if (Array.isArray(raw.facts)) doc.facts = raw.facts.map(factOf).filter((item): item is FactData => !!item);
    if (Array.isArray(raw.committed)) {
        doc.committed = raw.committed
            .filter((item): item is Dict => isDict(item) && typeof item.index === 'number')
            .map((item) => ({ index: item.index as number, stamp: str(item.stamp) }));
    }
    if (isDict(raw.extract)) {
        const extract = raw.extract;
        doc.extract = { upTo: int(extract.upTo, -1), attemptAt: int(extract.attemptAt, -1) };
        if (typeof extract.lastRun === 'number') doc.extract.lastRun = extract.lastRun;
        if (typeof extract.lastError === 'string' && extract.lastError) doc.extract.lastError = extract.lastError;
        if (typeof extract.added === 'number') doc.extract.added = extract.added;
        if (typeof extract.updated === 'number') doc.extract.updated = extract.updated;
    }
    doc.started = raw.started === true;
    if (isDict(raw.stats)) {
        const stats = raw.stats;
        for (const key of STAT_KEYS) doc.stats[key] = Math.max(0, int(stats[key], 0));
    }
    return doc;
}

/* ------------------------------------------------------------------ messages and commits */

/** Fingerprint of a chat message: send date, swipe and text (a swipe, an edit or a regeneration changes it). */
export function messageStamp(message: unknown): string {
    if (!isDict(message)) return '';
    const swipe = typeof message.swipe_id === 'number' ? message.swipe_id : 0;
    return `${str(message.send_date)}|${swipe}|${stableHash(str(message.mes))}`;
}

/**
 * Records a committed reply. False when exactly this reply (index and fingerprint) was processed already — a
 * repeated MESSAGE_SENT, or the user re-sending after deleting their own message.
 */
export function rememberCommit(doc: LivingDocData, index: number, stamp: string, keep = KEEP_COMMITS): boolean {
    const known = doc.committed.find((item) => item.index === index);
    if (known && known.stamp === stamp) return false;
    doc.committed = doc.committed.filter((item) => item.index !== index);
    doc.committed.push({ index, stamp });
    doc.committed.sort((a, b) => a.index - b.index);
    if (doc.committed.length > keep) doc.committed.splice(0, doc.committed.length - keep);
    return true;
}

/** Facts that came from one message and still count against the per-turn limit (dropped ones do not). */
export function factsFrom(doc: LivingDocData, sourceMessage: number): FactData[] {
    return doc.facts.filter((fact) => fact.sourceMessage === sourceMessage && fact.status !== 'dropped');
}

/** Messages a swipe/edit (that message) or a deletion (that index and everything after) takes away. */
export function affectedBy(sourceMessage: number, index: number, reason: 'swiped' | 'deleted' | 'edited'): boolean {
    return reason === 'deleted' ? sourceMessage >= index : sourceMessage === index;
}

export interface InvalidationPlan {
    drafts: DraftData[];
    /** Provisional facts to remove from the canon («Само», with the journal). */
    provisional: FactData[];
    /** Disputed facts (not in the canon) to forget. */
    disputed: FactData[];
}

/** What a swipe/delete/edit takes back: drafts, provisional and disputed facts; confirmed canon stays (§5). */
export function invalidationPlan(
    doc: LivingDocData,
    index: number,
    reason: 'swiped' | 'deleted' | 'edited',
): InvalidationPlan {
    const hit = (source: number) => affectedBy(source, index, reason);
    return {
        drafts: doc.drafts.filter((draft) => hit(draft.sourceMessage)),
        provisional: doc.facts.filter((fact) => fact.status === 'provisional' && hit(fact.sourceMessage)),
        disputed: doc.facts.filter((fact) => fact.status === 'disputed' && hit(fact.sourceMessage)),
    };
}

/**
 * Marks facts dropped. They stay in the document: a user drop stops the same name from coming back, and a fact whose
 * entry returns (an undo in the journal) revives with its confirmation reason.
 */
export function markDropped(doc: LivingDocData, ids: Iterable<string>, reason: DropReason): number {
    const set = new Set(ids);
    let count = 0;
    for (const fact of doc.facts) {
        if (!set.has(fact.id) || fact.status === 'dropped') continue;
        fact.status = 'dropped';
        fact.droppedBy = reason;
        count++;
    }
    return count;
}

/* ------------------------------------------------------------------ confirmation (plan M26 п. 4) */

export interface ConfirmInput {
    /** The user named it in their own message after the source message. */
    userMentioned: boolean;
    /** The user accepted it explicitly (pult, accept()). */
    userAccepted: boolean;
    /** It came up again in a reply whose prompt did not contain the entry. */
    resurfaced: boolean;
    survivedTurns: number;
    surviveTurns: number;
    /** The contradiction check is clean. */
    clean: boolean;
}

/** Why the fact is confirmed now, or null. Every path needs a clean contradiction check. */
export function confirmReason(input: ConfirmInput): ConfirmReasonId | null {
    if (!input.clean) return null;
    if (input.userAccepted) return 'userAccepted';
    if (input.userMentioned) return 'userMentioned';
    if (input.resurfaced) return 'resurfaced';
    if (input.surviveTurns > 0 && input.survivedTurns >= input.surviveTurns) return 'survived';
    return null;
}

/** The canon entry of `uid` reached the prompt of a turn (an activation of the canon book that was not cut). */
export function entryInPrompt(
    activations: readonly { world: string; uid: number; cut?: boolean }[],
    book: string,
    uid: number,
): boolean {
    return activations.some((item) => item.world === book && item.uid === uid && !item.cut);
}

/* ------------------------------------------------------------------ canon entries */

/** Canon entry type of a living type ('person' → character, 'other' → note). */
export function canonTypeOf(type: LivingType): EntryTypeId {
    if (type === 'person') return 'character';
    if (type === 'other') return 'note';
    return type;
}

/** «Tradition: Праздник Фонарей» style label. */
export function typeLabel(type: LivingType): string {
    return ENTRY_TYPES[canonTypeOf(type)].label;
}

function guillemets(quote: string): string {
    const text = quote.trim().replace(/^[«"“„]+|[»"”]+$/g, '');
    return `«${text}»`;
}

/**
 * The cheap seed of a provisional entry: the marker, the type and name, the Russian quotes (plan M26 п. 3: the
 * English text comes with the next batch extraction).
 */
export function seedContent(fact: {
    name: string;
    type: LivingType;
    quote: string;
    quotes?: readonly string[];
}): string {
    const lines = [`${SEED_MARKER} ${typeLabel(fact.type)}: ${fact.name}`];
    let size = lines[0]?.length ?? 0;
    for (const quote of [fact.quote, ...(fact.quotes ?? [])]) {
        if (!quote.trim()) continue;
        const line = guillemets(quote);
        if (size + line.length + 1 > SEED_MAX) break;
        lines.push(line);
        size += line.length + 1;
    }
    return lines.join('\n');
}

export function isSeedContent(content: unknown): boolean {
    return typeof content === 'string' && content.trimStart().startsWith(SEED_MARKER);
}

/** English canon content: «Tradition: Lantern Festival (Праздник Фонарей)», then the text. */
export function englishContent(fact: { name: string; type: LivingType; english?: string; text: string }): string {
    const english = fact.english?.trim();
    const title = english && english !== fact.name ? `${english} (${fact.name})` : fact.name;
    return `${typeLabel(fact.type)}: ${title}\n${fact.text.trim()}`;
}

/** Fingerprint of what a user may edit in an entry: content and keys. */
export function entryHash(entry: { content?: unknown; key?: unknown }): string {
    const keys = Array.isArray(entry.key) ? entry.key.filter((key) => typeof key === 'string') : [];
    return stableHash(JSON.stringify([typeof entry.content === 'string' ? entry.content : '', keys]));
}

/** Keys of both lists, first spelling kept, at most `max`. */
export function mergeKeys(existing: readonly string[], added: readonly string[], max = 40): string[] {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const key of [...existing, ...added]) {
        if (typeof key !== 'string') continue;
        const trimmed = key.trim();
        const norm = trimmed.toLowerCase();
        if (!trimmed || seen.has(norm)) continue;
        seen.add(norm);
        out.push(trimmed);
        if (out.length >= max) break;
    }
    return out;
}

/** Adds a quote unless it is already there (by normalised text); at most MAX_QUOTES extra quotes are kept. */
export function addQuote(fact: { quote: string; quotes: string[] }, quote: string): boolean {
    const norm = (text: string) =>
        text
            .toLowerCase()
            .replace(/\s+/g, ' ')
            .replace(/[«»"“”„]/g, '')
            .trim();
    const value = quote.trim();
    if (!value) return false;
    const target = norm(value);
    if (norm(fact.quote) === target || fact.quotes.some((item) => norm(item) === target)) return false;
    if (fact.quotes.length >= MAX_QUOTES) return false;
    fact.quotes.push(value);
    return true;
}

/** Confirmed facts, newest confirmation first. */
export function recentlyConfirmed(doc: LivingDocData, limit = 10): FactData[] {
    return doc.facts
        .filter((fact) => fact.status === 'active')
        .sort((a, b) => (b.confirmedAt ?? b.createdAt) - (a.confirmedAt ?? a.createdAt))
        .slice(0, limit);
}

/** Adds one to a counter. */
export function bumpStat(doc: LivingDocData, key: keyof LivingStats): void {
    doc.stats[key] = (doc.stats[key] ?? 0) + 1;
}

/** Counts a fact as confirmed (once per fact; a fact confirmed again after a dispute is not counted twice). */
export function countConfirmed(doc: LivingDocData, fact: FactData): boolean {
    if (fact.wasConfirmed) return false;
    fact.wasConfirmed = true;
    bumpStat(doc, 'confirmed');
    return true;
}

/** Counts a confirmed fact that got contradicted (once per fact). */
export function countContradicted(doc: LivingDocData, fact: FactData): boolean {
    if (fact.wasContradicted) return false;
    fact.wasContradicted = true;
    bumpStat(doc, 'contradictedAfterConfirm');
    return true;
}

/**
 * Where a message went after a deletion. ST reports only the new chat length, and deleting a message in the middle
 * shifts the later ones: a message is found again by its fingerprint at its index or up to `window` places before
 * it. Without a fingerprint, everything at or after the new length is gone. Null when the message is gone.
 */
export function relocate(
    stamps: readonly string[],
    source: number,
    stamp: string,
    length: number,
    window = 50,
): number | null {
    if (!stamp) return source >= length ? null : source;
    if (stamps[source] === stamp) return source;
    for (let i = Math.min(source - 1, stamps.length - 1); i >= Math.max(0, source - window); i--) {
        if (stamps[i] === stamp) return i;
    }
    return null;
}
