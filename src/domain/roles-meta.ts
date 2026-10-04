// M35 «Роли книг» — the entry-meta sidecar (plan P2, §2.1, §4.8; audit A12). Metadata Maestro keeps about entries of
// BASE books (type, passport) never goes into the book file: it lives in a Maestro file keyed by book + uid and is
// bound to a hash of the entry content. When the author changes the entry (or the uid is reused by another entry),
// the hash no longer matches and the metadata is reported stale instead of being applied to the wrong text.
// Pure: no DOM, no SillyTavern.
import { stableHash } from './hash';

export interface EntryMetaRecord {
    meta: Record<string, unknown>;
    /** entryContentHash() of the entry when the metadata was written. */
    contentHash: string;
    at: number;
}

export interface EntryMetaFile {
    schema: 1;
    entries: Record<string, EntryMetaRecord>;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function emptyEntryMetaFile(): EntryMetaFile {
    return { schema: 1, entries: {} };
}

/** Sidecar key of an entry: `${book}#${uid}`. */
export function entryMetaKey(book: string, uid: number): string {
    return `${book}#${uid}`;
}

/** Book and uid of a sidecar key (the book name may itself contain `#`). */
export function parseEntryMetaKey(key: string): { book: string; uid: number } | null {
    const index = key.lastIndexOf('#');
    if (index <= 0) return null;
    const uid = Number(key.slice(index + 1));
    if (!Number.isInteger(uid) || uid < 0) return null;
    return { book: key.slice(0, index), uid };
}

/** Hash of what the entry says: its content (keys and settings may change without invalidating a type/passport). */
export function entryContentHash(entry: unknown): string {
    const content = isDict(entry) ? entry.content : undefined;
    return stableHash(typeof content === 'string' ? content : '');
}

/** Content hashes of every entry of a book (`data.entries`), by uid. */
export function entryHashes(data: unknown): Map<number, string> {
    const hashes = new Map<number, string>();
    const entries = isDict(data) && isDict(data.entries) ? data.entries : {};
    for (const [key, entry] of Object.entries(entries)) {
        if (!isDict(entry)) continue;
        const uid = typeof entry.uid === 'number' && Number.isInteger(entry.uid) ? entry.uid : Number(key);
        if (Number.isInteger(uid)) hashes.set(uid, entryContentHash(entry));
    }
    return hashes;
}

/** A stored sidecar file with junk records dropped. */
export function readEntryMetaFile(raw: unknown): EntryMetaFile {
    const file = emptyEntryMetaFile();
    const entries = isDict(raw) && isDict(raw.entries) ? raw.entries : {};
    for (const [key, record] of Object.entries(entries)) {
        if (!parseEntryMetaKey(key) || !isDict(record) || !isDict(record.meta)) continue;
        if (typeof record.contentHash !== 'string') continue;
        file.entries[key] = {
            meta: record.meta,
            contentHash: record.contentHash,
            at: typeof record.at === 'number' ? record.at : 0,
        };
    }
    return file;
}

/** The stored meta when it still belongs to the entry; `stale` when the content changed since it was written. */
export function checkEntryMeta(
    record: EntryMetaRecord | undefined,
    currentHash: string | undefined,
): { state: 'none' | 'unknown' | 'ok' | 'stale'; meta?: Record<string, unknown> } {
    if (!record) return { state: 'none' };
    if (currentHash === undefined) return { state: 'unknown' };
    if (record.contentHash !== currentHash) return { state: 'stale' };
    return { state: 'ok', meta: record.meta };
}

/**
 * Merges another tab's file with this tab's changes: keys changed here (`dirty`) take this tab's value (absent =
 * deleted here), every other key keeps the stored one.
 */
export function mergeEntryMeta(stored: EntryMetaFile, local: EntryMetaFile, dirty: ReadonlySet<string>): EntryMetaFile {
    const merged: EntryMetaFile = { schema: 1, entries: { ...stored.entries } };
    for (const key of dirty) {
        const record = local.entries[key];
        if (record) merged.entries[key] = record;
        else delete merged.entries[key];
    }
    return merged;
}
