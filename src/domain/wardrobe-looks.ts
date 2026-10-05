// The DES wordings a NAI Studio passport outfit is known by (plan M27 п.1 «при повторном появлении — узнаётся и
// рисуется так же»; NAI Studio 0.12.1 `Outfit.looks`): NAI Studio draws the outfit instead of the tracker look when
// the look says one of them. The wardrobe adds every DES wording it recognised or created an outfit from. Wordings are
// compared reduced the way NAI Studio reduces them, so «already there» means the same on both sides. Pure.

/** NAI Studio keeps at most this many wordings per outfit (the newest, at the end). */
export const MAX_OUTFIT_LOOKS = 12;
/** NAI Studio cuts a wording to this length. */
export const MAX_LOOK_LENGTH = 300;

/** A wording reduced like NAI Studio's lookKey: lower case, ё as е, punctuation and runs of spaces as one space. */
export function lookKey(text: string): string {
    return String(text ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim();
}

/** A wording as NAI Studio stores it: trimmed and cut. */
export function lookWording(text: string): string {
    return String(text ?? '')
        .trim()
        .slice(0, MAX_LOOK_LENGTH)
        .trim();
}

/**
 * The outfit's wordings with one more (newest last; past the cap the oldest go). Null when it is there already after
 * reduction, or says nothing.
 */
export function withLook(looks: readonly string[] | undefined, wording: string): string[] | null {
    const value = lookWording(wording);
    const key = lookKey(value);
    if (!key) return null;
    const list = (looks ?? []).filter((item): item is string => typeof item === 'string');
    if (list.some((item) => lookKey(item) === key)) return null;
    return [...list, value].slice(-MAX_OUTFIT_LOOKS);
}

/** The wordings of `after` that `before` did not have (what one change added). */
export function addedLooks(before: readonly string[], after: readonly string[]): string[] {
    const old = new Set(before.map(lookKey));
    return after.filter((item) => !old.has(lookKey(item)));
}

/** The outfit's wordings without the given ones (compared reduced): what an undo takes back. */
export function withoutLooks(looks: readonly string[] | undefined, removed: readonly string[]): string[] {
    const keys = new Set(removed.map(lookKey));
    return (looks ?? []).filter((item) => !keys.has(lookKey(item)));
}

/** An outfit with these wordings; the field goes when there are none. */
export function outfitWithLooks<T extends { looks?: string[] }>(outfit: T, looks: readonly string[]): T {
    const copy: T = { ...outfit };
    if (looks.length) copy.looks = [...looks];
    else delete copy.looks;
    return copy;
}
