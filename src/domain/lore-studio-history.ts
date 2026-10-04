// Entry version history of the Lore Studio (M23 «История версий записи»): one Maestro file per book keeps the
// previous versions of changed entries, newest last on disk, at most `limit` per entry. Pure.
import { cloneJson, isRecord, sameJson } from './lore-studio-entries';
import type { LoreEntry } from './lore-studio-entries';

export const HISTORY_LIMIT = 20;
export const HISTORY_VERSION = 1;

export interface HistoryVersion {
    at: number;
    /** 'user', a module id ('M6'), 'localizer', 'ck', 'st'. */
    by: string;
    summary: string;
    entry: LoreEntry;
}

export interface HistoryDoc {
    version: number;
    book: string;
    /** uid → versions, oldest first. */
    entries: Record<string, HistoryVersion[]>;
}

export function emptyHistory(book: string): HistoryDoc {
    return { version: HISTORY_VERSION, book, entries: {} };
}

/** A stored document, repaired: unknown shapes become an empty history of `book`. */
export function readHistory(raw: unknown, book: string): HistoryDoc {
    if (!isRecord(raw) || !isRecord(raw.entries)) return emptyHistory(book);
    const entries: Record<string, HistoryVersion[]> = {};
    for (const [uid, list] of Object.entries(raw.entries)) {
        if (!Array.isArray(list)) continue;
        const versions = list.filter(
            (item): item is HistoryVersion =>
                isRecord(item) && typeof item.at === 'number' && isRecord(item.entry) && typeof item.by === 'string',
        );
        if (versions.length) entries[uid] = versions;
    }
    return { version: HISTORY_VERSION, book, entries };
}

/**
 * Adds previous versions (one per entry). A version equal to the newest stored one is skipped (two saves with the
 * same "before" do not duplicate). Keeps the newest `limit` per entry. Returns a new document.
 */
export function pushVersions(
    doc: HistoryDoc,
    versions: readonly { uid: number; version: HistoryVersion }[],
    limit = HISTORY_LIMIT,
): HistoryDoc {
    const next: HistoryDoc = { ...doc, entries: { ...doc.entries } };
    for (const { uid, version } of versions) {
        const key = String(uid);
        const list = [...(next.entries[key] ?? [])];
        const newest = list[list.length - 1];
        if (newest && sameJson(newest.entry, version.entry)) continue;
        list.push(cloneJson(version));
        while (list.length > limit) list.shift();
        next.entries[key] = list;
    }
    return next;
}

/** Versions of one entry, newest first. */
export function versionsOf(doc: HistoryDoc, uid: number): HistoryVersion[] {
    return [...(doc.entries[String(uid)] ?? [])].reverse().map((version) => cloneJson(version));
}

export function versionCount(doc: HistoryDoc): number {
    return Object.values(doc.entries).reduce((sum, list) => sum + list.length, 0);
}
