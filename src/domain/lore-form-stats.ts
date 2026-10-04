// Analytics of one entry in the Lore Studio form (plan M23 new possibilities 5 and 12): its activations in the
// lore journal of the chat (M1 records) and the doctor findings (M5) that point at it. Structural types only, so
// the domain does not depend on the feature APIs.

export interface ActivationLike {
    world: string;
    uid: number;
    chars: number;
    key?: string;
    cut?: boolean;
    recursionLevel?: number;
}

export interface TurnLike {
    messageIndex: number;
    at: number;
    activations: readonly ActivationLike[];
    simulated?: boolean;
}

export interface EntryActivation {
    messageIndex: number;
    at: number;
    chars: number;
    key?: string;
    cut: boolean;
    recursionLevel: number;
}

export interface EntryActivationStats {
    /** Real (non-simulated) turns in the journal. */
    turns: number;
    /** Turns where the entry was activated (cut ones included). */
    activations: number;
    /** activations / turns (0 without turns). */
    frequency: number;
    /** Turns where the budget or a rule cut it. */
    cut: number;
    /** Average characters over the activations that reached the prompt (0 when none). */
    avgChars: number;
    /** Newest activation first, at most `recent` items. */
    recent: EntryActivation[];
    /** Last key known for the entry (newest activation with an attributed key). */
    lastKey?: string;
}

/** Statistics of one entry over the journal turns (oldest first, as M1 returns them). */
export function entryActivationStats(
    turns: readonly TurnLike[],
    book: string,
    uid: number,
    recent = 5,
): EntryActivationStats {
    const real = turns.filter((turn) => !turn.simulated);
    const hits: EntryActivation[] = [];
    for (const turn of real) {
        const activation = turn.activations.find((item) => item.world === book && item.uid === uid);
        if (!activation) continue;
        hits.push({
            messageIndex: turn.messageIndex,
            at: turn.at,
            chars: activation.chars,
            ...(activation.key ? { key: activation.key } : {}),
            cut: activation.cut === true,
            recursionLevel: activation.recursionLevel ?? 0,
        });
    }
    const delivered = hits.filter((hit) => !hit.cut);
    const avgChars = delivered.length
        ? Math.round(delivered.reduce((sum, hit) => sum + hit.chars, 0) / delivered.length)
        : 0;
    const newest = [...hits].reverse();
    const lastKey = newest.find((hit) => hit.key)?.key;
    return {
        turns: real.length,
        activations: hits.length,
        frequency: real.length ? hits.length / real.length : 0,
        cut: hits.length - delivered.length,
        avgChars,
        recent: newest.slice(0, recent),
        ...(lastKey ? { lastKey } : {}),
    };
}

/** True when a doctor finding's locator points at this entry (`{book, uid}`, `{book, uids}`, CK `archives`). */
export function findingTargetsEntry(target: Record<string, unknown>, book: string, uid: number): boolean {
    if (target.book === book) {
        if (target.uid === uid) return true;
        if (Array.isArray(target.uids) && target.uids.includes(uid)) return true;
    }
    if (Array.isArray(target.archives)) {
        return target.archives.some(
            (item) =>
                typeof item === 'object' &&
                item !== null &&
                (item as Record<string, unknown>).book === book &&
                (item as Record<string, unknown>).uid === uid,
        );
    }
    return false;
}
