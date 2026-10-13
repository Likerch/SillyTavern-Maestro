// Public API of M35 roles (app.modules.api<BookRolesApi>('bookRoles')). Plan M35, P2, P13.
import type { Unsubscribe } from '../../shared/contracts';

export type BookRole =
    | 'bunnymo.core'
    | 'bunnymo.pack'
    | 'ck.archive'
    | 'world'
    | 'card'
    | 'npc'
    | 'canon'
    | 'maestro'
    | 'chat'
    | 'persona'
    | 'backup'
    | 'unknown';

export interface BookRoleInfo {
    book: string;
    role: BookRole;
    /** Detected automatically or set by the user. */
    source: 'auto' | 'user';
    /** Content fingerprint the detection was made on. */
    fingerprint: string;
    /** BunnyMo pack name/version when known. */
    pack?: { name: string; version?: string };
    /** True for roles that are read-only in Lore Studio (BunnyMo core/packs). */
    readOnly: boolean;
    /** Localizer may add Russian keys (false for BunnyMo). */
    localizable: boolean;
}

export interface BookRolesApi {
    roleOf(book: string): BookRoleInfo | undefined;
    all(): BookRoleInfo[];
    /** `by`: the journal module of the change (default M35; MAESTRO_API passes the neighbour's, release 1.24). */
    setRole(book: string, role: BookRole, by?: string): Promise<void>;
    refresh(): Promise<void>;
    /** Per-entry metadata of base books kept outside the files (type, passport) — P2/A12. */
    entryMeta<T = Record<string, unknown>>(book: string, uid: number): T | undefined;
    setEntryMeta(book: string, uid: number, meta: Record<string, unknown> | undefined): Promise<void>;
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M35 implementation (optional so that fakes of the stage-2 contract stay valid).
    /** Drops the user's role so the book is detected automatically again (setRole(book, 'unknown') does the same). */
    resetRole?(book: string, by?: string): Promise<void>;
    /** entryMeta() after reading the book when its content hashes are not known yet. */
    loadEntryMeta?<T = Record<string, unknown>>(book: string, uid: number): Promise<T | undefined>;
    /** Sidecar records whose entry changed since the metadata was written (the content hash no longer matches). */
    staleEntryMeta?(): { book: string; uid: number }[];
    /** A book was renamed (Lore Studio): the role record and entry metadata move to the new name. */
    renameBook?(oldName: string, newName: string): Promise<void>;
    /**
     * Detects these books now (release 1.24): a book made a moment ago is read-only for the Lore Studio until its role
     * is known (P13), so a neighbour writing into it waits for this first.
     */
    detect?(books: readonly string[]): Promise<void>;
}
