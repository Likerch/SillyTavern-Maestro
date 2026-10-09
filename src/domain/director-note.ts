// The director's note (M14 п.2–3): a one-shot English instruction near the end of the prompt (P16) that breaks a stall
// with a twist from the story's own material — an open DES quest, an unresolved thread from memory or canon, and from
// later stages a due promise, offscreen events, a mechanic. Notes push events forward; they never steer away from dark
// or explicit content and never «save» characters for comfort (plan §11).
// Pure: no DOM, no SillyTavern.
import type { StallReason } from './director-pacing';
import type { SceneKind } from './director-scene';
import { normalizeText } from './signals-tokens';

export type TwistKind = 'quest' | 'thread' | 'deadline' | 'offscreen' | 'mechanic' | 'agenda';

export interface TwistSource {
    kind: TwistKind;
    /** Short text: a quest title, a memory, a promise, an offscreen event. */
    text: string;
    /** Higher is preferred. */
    weight: number;
    /** Identity of the twist (the same quest twice in a row is avoided). */
    key: string;
}

/** Words of open business: promises, debts, secrets, things left for later. */
const UNRESOLVED_RE =
    /(?<!\p{L})(?:обещ|поклял|клятв|долг(?:а|и|ом|у)?(?!\p{L})|тайн|секрет|не успел|незаконч|отлож|вернусь|вернется|месть|отомст|найти|узнать|загадк|неизвестн|пропал|исчез|разыск|ищет|искать|promise|swor|vow|oath|debt|owe|secret|unfinished|revenge|aveng|find out|mystery|unknown|missing|vanish|will return|hunt for|search for)/iu;

/** The text speaks of something left open (a promise, a secret, a debt, a search, «later»). */
export function hasUnresolvedWords(text: string): boolean {
    return UNRESOLVED_RE.test(normalizeText(text));
}

/** A stable key of a twist: its kind and normalised text. */
export function twistKey(kind: TwistKind, text: string): string {
    return `${kind}:${normalizeText(text).slice(0, 80)}`;
}

/** Shortens a text to `max` characters on a word boundary. */
export function shorten(text: string, max = 160): string {
    const value = String(text ?? '')
        .replace(/\s+/g, ' ')
        .trim();
    if (value.length <= max) return value;
    const cut = value.slice(0, max);
    const space = cut.lastIndexOf(' ');
    return `${(space > max * 0.6 ? cut.slice(0, space) : cut).replace(/[\s,.;:—-]+$/u, '')}…`;
}

/**
 * The twist to use: the heaviest source whose key was not used by the recent notes (falls back to a recent one when
 * nothing else is left); ties keep the input order. Null without sources.
 */
export function pickTwist(sources: readonly TwistSource[], recentKeys: readonly string[] = []): TwistSource | null {
    const usable = sources.filter((source) => source.text.trim());
    if (!usable.length) return null;
    const recent = new Set(recentKeys);
    const fresh = usable.filter((source) => !recent.has(source.key));
    const pool = fresh.length ? fresh : usable;
    let best = pool[0] as TwistSource;
    for (const source of pool) if (source.weight > best.weight) best = source;
    return best;
}

const REASON_TEXT: Record<StallReason, string> = {
    samePlace: 'the scene has stayed in one place for {n} turns',
    noEvents: 'nothing has changed for {n} turns',
    repetition: 'the replies repeat themselves',
    loop: 'the conversation keeps circling the same topic',
};

function twistText(twist: TwistSource): string {
    const text = shorten(twist.text);
    switch (twist.kind) {
        case 'quest':
            return `advance the open quest "${text}": a lead, an obstacle, a demand or a new person tied to it appears`;
        case 'thread':
            return `bring back the unresolved thread "${text}": it resurfaces now and has consequences`;
        case 'deadline':
            return `the promise or deadline "${text}" comes due now: someone demands it, or its consequences arrive`;
        case 'offscreen':
            return `what happened offscreen reaches the scene: ${text}`;
        case 'mechanic':
            return text;
        case 'agenda':
            return `a character's own plan comes to a head now: ${text} — they act on it, and the scene feels it`;
    }
}

export interface NoteInput {
    twist: TwistSource;
    reasons: readonly StallReason[];
    /** Turns without a change (fills «for N turns»). */
    turns: number;
    scene: SceneKind | null;
    /** The user's persona name: the note forbids writing for him. */
    userName: string;
    /** «Встряхнуть»: asked by the user, not by a stall. */
    nudged?: boolean;
}

/** The English one-shot note for the model. */
export function buildDirectorNote(input: NoteInput): string {
    const turns = Math.max(2, Math.floor(input.turns));
    const reasons = input.reasons.map((reason) => REASON_TEXT[reason].replace('{n}', String(turns)));
    const why = input.nudged
        ? 'The story needs a push now.'
        : reasons.length
          ? `The story has stalled: ${reasons.join('; ')}.`
          : 'The story has stalled.';
    const lines = [
        "[Director's note: pacing]",
        `${why} In your next reply, move the plot forward on your own initiative: ${twistText(input.twist)}.`,
        'Make it concrete and let it happen now, so the characters must react; it may raise the stakes or the danger.',
    ];
    if (input.scene === 'intimate') {
        lines.push('Weave it in without interrupting or cutting the current intimate scene short.');
    }
    lines.push(
        'Keep the established tone and intensity, dark or explicit content included:',
        'do not soften, censor, summarize or cut away.',
        `Do not mention this note, and do not write actions, words or thoughts for ${input.userName || 'the user'}.`,
    );
    return lines.join('\n');
}
