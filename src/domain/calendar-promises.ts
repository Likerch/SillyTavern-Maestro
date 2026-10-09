// Promises of the calendar (M17, plan M17 п.1, п.3): an agreement or a deadline extracted by the revision (M8 deferred
// cards 'deferred.promise': the model's one English sentence plus a verbatim quote) becomes a promise with a status:
// open → due (its moment in story time came) → overdue (not kept within the grace: a story day or N turns). Done,
// cancelled and broken are set by the user, or by a later revision whose statement says the promise was kept, called
// off or broken. Pure: no DOM, no SillyTavern.
import { elapsedMinutes, MINUTES_PER_DAY } from './calendar-time';
import type { Moment } from './calendar-time';
import { normalizeText, tokenSet } from './signals-tokens';

export type PromiseState = 'open' | 'due' | 'overdue' | 'done' | 'cancelled' | 'broken';
export type PromiseOutcome = 'done' | 'broken' | 'cancelled';

export const ACTIVE_STATES: readonly PromiseState[] = ['open', 'due', 'overdue'];
export const CLOSED_STATES: readonly PromiseState[] = ['done', 'cancelled', 'broken'];
export const ALL_STATES: readonly PromiseState[] = [...ACTIVE_STATES, ...CLOSED_STATES];

export interface Grace {
    /** Story days after the deadline; 0 = no day limit. */
    days: number;
    /** Committed turns after the promise came due; 0 = no turn limit. */
    turns: number;
}

export interface TrackedPromise {
    status: PromiseState;
    due: Moment | null;
    /** Turn counter when it came due. */
    dueTurn?: number;
}

export interface Evaluation {
    status: PromiseState;
    dueTurn?: number;
}

export function isActive(status: PromiseState): boolean {
    return ACTIVE_STATES.includes(status);
}

export function isPromiseState(value: unknown): value is PromiseState {
    return typeof value === 'string' && (ALL_STATES as readonly string[]).includes(value);
}

/**
 * The automatic status of a promise at the story moment `now` and the turn counter `turn`. Closed promises keep
 * theirs. A deadline that is ahead again (a deleted turn moved the clock back) reopens the promise; a promise without
 * a deadline in story time only runs out of turns once it was marked due.
 */
export function evaluatePromise(promise: TrackedPromise, now: Moment | null, turn: number, grace: Grace): Evaluation {
    const keep = (): Evaluation =>
        promise.dueTurn === undefined
            ? { status: promise.status }
            : { status: promise.status, dueTurn: promise.dueTurn };
    if (!isActive(promise.status)) return keep();
    const elapsed = promise.due && now ? elapsedMinutes(promise.due, now) : null;
    if (elapsed === null) {
        if (promise.status !== 'due') return keep();
        const dueTurn = promise.dueTurn ?? turn;
        const late = grace.turns > 0 && turn - dueTurn >= grace.turns;
        return { status: late ? 'overdue' : 'due', dueTurn };
    }
    if (elapsed < 0) return { status: 'open' };
    const dueTurn = promise.dueTurn ?? turn;
    const late =
        promise.status === 'overdue' ||
        (grace.turns > 0 && turn - dueTurn >= grace.turns) ||
        (grace.days > 0 && elapsed >= grace.days * MINUTES_PER_DAY);
    return { status: late ? 'overdue' : 'due', dueTurn };
}

/* ------------------------------------------------------------------ outcomes */

const NOUN_RE =
    /\b(?:promises?|word|oath|vows?|agreements?|deal|bargain|pledge|debts?|commitments?)\b|(?<!\p{L})(?:обещани\p{L}*|слов\p{L}*|клятв\p{L}*|уговор\p{L}*|договор\p{L}*|сделк\p{L}*|долг\p{L}*)/u;
const BROKEN_RE =
    /\b(?:broke|breaks|broken|breaking|betray(?:ed|s)?|went\s+back\s+on|reneged(?:\s+on)?|failed\s+to\s+(?:keep|honou?r|fulfill?|deliver\s+on)|(?:did\s+not|didn't|never)\s+(?:keep|honou?r|fulfill?))\b|(?<!\p{L})(?:нарушил\p{L}*|не\s+сдержал\p{L}*|не\s+выполнил\p{L}*|предал\p{L}*)/u;
const CANCELLED_RE =
    /\b(?:cancel(?:l?ed|s)?|called\s+off|calls\s+off|released\s+\S+\s+from|withdr(?:ew|awn|aws)|voided|no\s+longer\s+(?:needed|required|binding|stands|valid))\b|(?<!\p{L})(?:отменил\p{L}*|отменен\p{L}*|освободил\p{L}*\s+от)/u;
const DONE_RE =
    /\b(?:kept|keeps|fulfill?(?:ed|s)|honou?red|made\s+good\s+on|delivered\s+on|carried\s+out|paid\s+off|repaid)\b|(?<!\p{L})(?<!не\s)(?:сдержал\p{L}*|выполнил\p{L}*|исполнил\p{L}*)/u;
const AS_PROMISED_RE = /\bas\s+(?:promised|agreed)\b|(?<!\p{L})как\s+и\s+(?:обещал\p{L}*|договаривал\p{L}*)/u;

/** A statement that a promise was kept, broken or called off («Kept her promise to …»); null for a new promise. */
export function promiseOutcome(text: string | undefined): PromiseOutcome | null {
    const value = normalizeText(text ?? '');
    if (!value) return null;
    const noun = NOUN_RE.test(value);
    if (noun && BROKEN_RE.test(value)) return 'broken';
    if (noun && CANCELLED_RE.test(value)) return 'cancelled';
    if (AS_PROMISED_RE.test(value) || (noun && DONE_RE.test(value))) return 'done';
    return null;
}

/* ------------------------------------------------------------------ matching */

// prettier-ignore
const FILLER: ReadonlySet<string> = new Set([
    'promis', 'promise', 'agre', 'agree', 'kept', 'keep', 'fulfil', 'fulfill', 'honor', 'honour', 'broke', 'broken',
    'word', 'oath', 'vow', 'deal', 'cancel', 'cancell', 'call', 'off', 'swor', 'swear', 'will', 'would', 'not',
    'обещал', 'обещан', 'сдержал', 'выполнил', 'нарушил', 'слов', 'клятв',
]);

function contentTokens(text: string): Set<string> {
    const out = new Set<string>();
    for (const token of tokenSet(text)) if (!FILLER.has(token)) out.add(token);
    return out;
}

/** Overlap coefficient of the content words of two promise statements (0..1). */
export function similarity(a: string, b: string): number {
    const left = contentTokens(a);
    const right = contentTokens(b);
    if (!left.size || !right.size) return normalizeText(a) === normalizeText(b) && !!normalizeText(a) ? 1 : 0;
    let common = 0;
    for (const token of left) if (right.has(token)) common++;
    return common / Math.min(left.size, right.size);
}

function nameKey(name: string): string {
    return normalizeText(name);
}

/** Two name lists share a person (an empty list matches anyone). */
export function sharePeople(a: readonly string[], b: readonly string[]): boolean {
    if (!a.length || !b.length) return true;
    const keys = new Set(a.map(nameKey));
    return b.some((name) => keys.has(nameKey(name)));
}

/** How close a statement is to a promise: its wording or its English copy (a Russian story's prepared promise). */
function promiseSimilarity(item: { what: string; english?: string }, text: string): number {
    const own = similarity(item.what, text);
    return item.english ? Math.max(own, similarity(item.english, text)) : own;
}

/** The active promise a statement is about (same promiser, most similar wording above `min`). */
export function findPromiseMatch<T extends { who: string[]; what: string; english?: string; status: PromiseState }>(
    list: readonly T[],
    who: readonly string[],
    text: string,
    min = 0.5,
): T | null {
    let best: T | null = null;
    let bestScore = min;
    for (const item of list) {
        if (!isActive(item.status) || !sharePeople(item.who, who)) continue;
        const score = promiseSimilarity(item, text);
        if (score >= bestScore) {
            best = item;
            bestScore = score;
        }
    }
    return best;
}

/** The same promise found again (the next revision often reports it once more; either may carry an English copy). */
export function samePromise(
    a: { who: readonly string[]; what: string; english?: string; quote?: string },
    b: { who: readonly string[]; what: string; english?: string; quote?: string },
): boolean {
    if (!sharePeople(a.who, b.who)) return false;
    if (a.quote && b.quote && normalizeText(a.quote) === normalizeText(b.quote)) return true;
    const left = [a.what, a.english ?? ''].filter(Boolean);
    const right = [b.what, b.english ?? ''].filter(Boolean);
    return left.some((x) => right.some((y) => similarity(x, y) >= 0.75));
}

const MAX_WHAT = 240;

/** A promise statement for storage: one line, capped; wrapping quotes dropped unless `unwrap` is false (quotes). */
export function cleanStatement(text: string | undefined, max = MAX_WHAT, unwrap = true): string {
    let value = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    if (unwrap) value = value.replace(/^["«“'](.*)["»”']$/u, '$1').trim();
    if (value.length > max) {
        const head = value.slice(0, max);
        const space = head.lastIndexOf(' ');
        value = `${(space > max * 0.6 ? head.slice(0, space) : head).trimEnd()}…`;
    }
    return value;
}

/** Splits a «who» field of the add form: «Анна, Борис» → ['Анна', 'Борис']. */
export function splitNames(text: string | undefined): string[] {
    const names = String(text ?? '')
        .split(/[,;]|\s+(?:and|и)\s+/u)
        .map((name) => name.trim())
        .filter(Boolean);
    return [...new Set(names)];
}
