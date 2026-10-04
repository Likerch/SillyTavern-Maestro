// Lorebook checks of M3 «Медик»: entries injected at depth with the assistant role (the M22 rule
// 'role.assistantToSystem' fixes them on the fly; research/st-world-info.md §entry fields) and Lorebook Localizer
// keys that its marker says were added but are gone from the entry. Pure: entries come as plain objects.

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** `world_info_position.atDepth` (world-info.js). */
export const WI_POSITION_AT_DEPTH = 4;
/** `extension_prompt_roles.ASSISTANT`. */
export const WI_ROLE_ASSISTANT = 2;

export interface EntryRef {
    uid: number;
    comment: string;
}

/** Entries of a book (`{entries: {uid: entry}}` or a list), as plain objects. */
export function bookEntries(book: unknown): Dict[] {
    const entries = isDict(book) ? book.entries : undefined;
    if (Array.isArray(entries)) return entries.filter(isDict);
    if (isDict(entries)) return Object.values(entries).filter(isDict);
    return [];
}

function ref(entry: Dict): EntryRef {
    const uid = typeof entry.uid === 'number' ? entry.uid : Number(entry.uid);
    return { uid: Number.isFinite(uid) ? uid : -1, comment: typeof entry.comment === 'string' ? entry.comment : '' };
}

/** Enabled entries placed in the chat at depth with the assistant role. */
export function assistantDepthEntries(entries: readonly Dict[]): EntryRef[] {
    return entries
        .filter(
            (entry) =>
                entry.disable !== true &&
                Number(entry.position) === WI_POSITION_AT_DEPTH &&
                Number(entry.role) === WI_ROLE_ASSISTANT,
        )
        .map(ref);
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** Keys the Localizer marker lists as appended (`added.key` / `added.keysecondary`) that the entry no longer has. */
export function missingAddedKeys(
    entry: Dict,
    added: { key: readonly string[]; keysecondary: readonly string[] },
): string[] {
    const primary = new Set(stringList(entry.key));
    const secondary = new Set(stringList(entry.keysecondary));
    const missing: string[] = [];
    for (const key of added.key) if (!primary.has(key)) missing.push(key);
    for (const key of added.keysecondary) if (!secondary.has(key)) missing.push(key);
    return missing;
}
