// «Что надето сейчас» (plan-2 §4 п. 1, 3): one record per character of the scene (and the persona) in the chat's
// wardrobe document — the clothing as the tracker writes it now, its tags, which outfit of the library it is (or that
// it is new), since which message, undressing. A record follows the committed turns: the same clothing again counts
// one more turn (a new outfit is made after two), other clothing starts over; the record before is kept one step back
// so a swiped or deleted reply takes its change away. Also the short prompt line «кто во что одет». Pure.
import { normalizeText } from './signals-tokens';
import { wordingScore } from './wardrobe-match';
import type { UndressKind } from './wardrobe-wear';

/**
 * Where the clothing came from: the tracker's outfit field, its appearance text, the background model, by hand, the
 * revision, the player's message, the narration of a reply.
 */
export type WearSource = 'field' | 'appearance' | 'model' | 'user' | 'revision' | 'player' | 'reply';

export interface WearState {
    /** Document key: the passport id, `name:<normalised name>` without one, `persona` for the user's character. */
    key: string;
    /** Name as the tracker (or the persona) has it. */
    name: string;
    /** NAI passport the outfit goes to; '' when the character has none (the record is Maestro's only). */
    passportId: string;
    persona?: boolean;
    /** The clothing as written. */
    wording: string;
    /** English NAI tags of it ('' when no garment is known). */
    tags: string;
    undress: UndressKind | '';
    source: WearSource;
    /** The outfit it is: a passport outfit name, '' for the own clothes (clothing slot), null while it is new. */
    outfit: string | null;
    /** Message (and its swipe) where this clothing first showed. */
    since: number;
    swipe: number;
    /** Last committed message that said it. */
    seen: number;
    /** Committed turns in a row that said it. */
    turns: number;
    /** The outfit Maestro put on (or found on) for this clothing; a different one on the passport is the user's choice. */
    applied?: string;
    /** The outfit proposed and waiting in the Inbox or as a notice: not proposed again. */
    queued?: string;
    /** In the scene at the last committed turn. */
    present: boolean;
    at: number;
    /**
     * «Переодеть сейчас» (by hand, the player's message, the narration, the model) at this message: a tracker that still
     * says the clothes from before (`was`) for the next replies is stale and does not undo it.
     */
    changedAt?: number;
    was?: string;
    wasUndress?: UndressKind | '';
}

export interface WearRecord extends WearState {
    /** The record before the last committed turn changed it (swipe / delete take the change back). */
    prior?: WearState;
}

export interface WearObservation {
    name: string;
    wording: string;
    tags: string;
    undress: UndressKind | '';
    source: WearSource;
}

export interface WearPlace {
    key: string;
    passportId: string;
    persona?: boolean;
    index: number;
    swipe: number;
    now: number;
}

/** Two wordings of the same clothing (any language: words or garments and colours). */
export const SAME_WEARING = 0.6;
const SOURCES: readonly WearSource[] = ['field', 'appearance', 'model', 'user', 'revision', 'player', 'reply'];
/** A tracker repeating the clothes from before a change is stale for this many messages after it. */
export const STALE_SPAN = 4;
const UNDRESS: readonly string[] = ['naked', 'towel', 'underwear', 'partial'];

/** The clothing did not change: the same undressing and the same clothes in other words. */
export function sameWearing(
    a: { wording: string; undress: UndressKind | '' },
    b: { wording: string; undress: UndressKind | '' },
): boolean {
    if (a.undress !== b.undress) return false;
    if (normalizeText(a.wording) === normalizeText(b.wording)) return true;
    return wordingScore(a.wording, b.wording) >= SAME_WEARING;
}

function state(record: WearRecord): WearState {
    const copy: WearRecord = { ...record };
    delete copy.prior;
    return copy;
}

/** The record after one more committed turn (or a persona answer, a hand edit) said `observation`. */
export function observeWear(previous: WearRecord | undefined, observation: WearObservation, at: WearPlace): WearRecord {
    const base = {
        key: at.key,
        name: observation.name || previous?.name || '',
        passportId: at.passportId,
        present: true,
        at: at.now,
    };
    if (at.persona) Object.assign(base, { persona: true });
    if (previous && sameWearing(previous, observation)) {
        const turns = previous.seen === at.index ? previous.turns : previous.turns + 1;
        return {
            ...state(previous),
            ...base,
            wording: observation.wording,
            tags: observation.tags || previous.tags,
            source: observation.source,
            seen: Math.max(previous.seen, at.index),
            turns,
            prior: state(previous),
        };
    }
    const record: WearRecord = {
        ...base,
        wording: observation.wording,
        tags: observation.tags,
        undress: observation.undress,
        source: observation.source,
        outfit: null,
        since: at.index,
        swipe: at.swipe,
        seen: at.index,
        turns: 1,
    };
    if (previous) record.prior = state(previous);
    return record;
}

/**
 * A tracker observation that must not undo a change made at the record's `changedAt`: it is of a message at or
 * before the change, or it repeats the clothes from before the change within STALE_SPAN messages after it.
 */
export function staleObservation(
    record: WearRecord | undefined,
    observation: { wording: string; undress: UndressKind | '' },
    index: number,
): boolean {
    if (!record || record.changedAt === undefined || index < 0) return false;
    if (index <= record.changedAt) return !sameWearing(record, observation);
    if (index - record.changedAt > STALE_SPAN || record.was === undefined || !record.was.trim()) return false;
    return sameWearing({ wording: record.was, undress: record.wasUndress ?? '' }, observation);
}

/** A swiped or deleted committed reply `index`: the record as it was before it (null: there was none). */
export function revertWear(record: WearRecord, index: number): WearRecord | null {
    if (record.seen < index) return record;
    if (record.prior && record.prior.seen < index) return { ...record.prior };
    return null;
}

type Dict = Record<string, unknown>;

const isDict = (value: unknown): value is Dict => typeof value === 'object' && value !== null && !Array.isArray(value);
const str = (value: unknown) => (typeof value === 'string' ? value : '');
const num = (value: unknown, fallback: number) =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

function stateOf(raw: unknown): WearState | null {
    if (!isDict(raw) || !str(raw.key)) return null;
    const out: WearState = {
        key: str(raw.key),
        name: str(raw.name),
        passportId: str(raw.passportId),
        wording: str(raw.wording),
        tags: str(raw.tags),
        undress: UNDRESS.includes(str(raw.undress)) ? (str(raw.undress) as UndressKind) : '',
        source: SOURCES.find((item) => item === raw.source) ?? 'appearance',
        outfit: typeof raw.outfit === 'string' ? raw.outfit : null,
        since: num(raw.since, -1),
        swipe: num(raw.swipe, 0),
        seen: num(raw.seen, -1),
        turns: Math.max(1, num(raw.turns, 1)),
        present: raw.present === true,
        at: num(raw.at, 0),
    };
    if (raw.persona === true) out.persona = true;
    if (typeof raw.applied === 'string') out.applied = raw.applied;
    if (typeof raw.queued === 'string') out.queued = raw.queued;
    if (typeof raw.changedAt === 'number' && Number.isFinite(raw.changedAt)) out.changedAt = raw.changedAt;
    if (typeof raw.was === 'string') out.was = raw.was;
    if (UNDRESS.includes(str(raw.wasUndress)) || raw.wasUndress === '') {
        out.wasUndress = str(raw.wasUndress) as UndressKind | '';
    }
    return out;
}

/** A stored record repaired; null for junk. */
export function normalizeWearRecord(raw: unknown): WearRecord | null {
    const record: WearRecord | null = stateOf(raw);
    if (!record) return null;
    const prior = isDict(raw) ? stateOf(raw.prior) : null;
    if (prior) record.prior = prior;
    return record;
}

/* ------------------------------------------------------------------ the prompt line */

/** Characters per token of the estimate (Cyrillic is close to 3). */
const CHARS_PER_TOKEN = 3;
/** One character's clothing in the line is cut to about this many characters, at a comma when it can. */
const MAX_WORDING_CHARS = 90;

function shortWording(wording: string): string {
    let text = wording.replace(/\s+/g, ' ').trim();
    if (text.length > MAX_WORDING_CHARS) {
        const cut = text.slice(0, MAX_WORDING_CHARS);
        const comma = cut.lastIndexOf(',');
        text = (comma > 20 ? cut.slice(0, comma) : cut.replace(/\s+\S*$/, '')).trim();
    }
    // «Носит белую блузку» → «носит белую блузку» after the name; "IN" or «ООО» stay.
    if (text.length > 1 && text[1] === text[1]?.toLowerCase()) text = text[0]!.toLowerCase() + text.slice(1);
    return text.replace(/[.;]+$/, '');
}

/**
 * «[header] Офелия: шёлковое платье, босиком; Кай: кожаная куртка» within `maxTokens` (estimated); characters that do
 * not fit are left out. '' when nobody is left.
 */
export function wearingLine(
    entries: readonly { name: string; wording: string }[],
    header: string,
    maxTokens: number,
): string {
    const limit = Math.max(0, maxTokens) * CHARS_PER_TOKEN;
    const parts: string[] = [];
    let length = header.length + 1;
    for (const entry of entries) {
        const name = entry.name.trim();
        const wording = shortWording(entry.wording);
        if (!name || !wording) continue;
        const part = `${name}: ${wording}`;
        const extra = part.length + (parts.length ? 2 : 0);
        if (length + extra > limit) continue;
        parts.push(part);
        length += extra;
    }
    return parts.length ? `${header} ${parts.join('; ')}` : '';
}
