// Public API of M6 «Канон чата» (app.modules.api<CanonApi>('canon')). Plan M6, P2, P14; audit T1.
//
// Storage: one lorebook per chat ("Maestro · канон · <short id>"), never globally active. Every canon entry
// carries `extensions.maestro` (CanonMeta). Maestro injects the canon at scan time (WORLDINFO_ENTRIES_LOADED):
// additions are pushed to chatLore, overrides REPLACE the base entry copy in place (same world/uid), suppressions
// remove the base copy, pins force activation. The base books are never written by the canon.
import type { Unsubscribe } from '../../shared/contracts';

export type CanonKind = 'override' | 'addition' | 'suppress' | 'pin';
export type CanonStatus = 'active' | 'provisional' | 'archived';
export type CanonOrigin = 'user' | 'revision' | 'living' | 'chronicle' | 'backstage' | 'entity' | 'import';

/** Typed entry of Maestro books (M23 typed entries; stored in extensions.maestro.type). */
export type EntryType =
    'character' | 'place' | 'item' | 'faction' | 'event' | 'tradition' | 'mechanic' | 'rule' | 'chapter' | 'note';

export interface CanonMeta {
    kind: CanonKind;
    status: CanonStatus;
    origin: CanonOrigin;
    type?: EntryType;
    /**
     * Base entry for override/suppress/pin. `content` (optional) is the base text when the item was made, shown as
     * «then» by baseDrift().
     */
    base?: { world: string; uid: number; contentHash: string; content?: string };
    /** Message the item was derived from (P14: only committed turns). */
    sourceMessage?: number;
    createdAt: number;
    updatedAt: number;
    /** Provisional facts (M26): turns survived without contradiction. */
    survivedTurns?: number;
    /** Pin condition: 'always' or an entity/place id that must be present. */
    pinWhen?: string;
    /** Living canon (M26): id of the fact in the chat's living-canon document. */
    livingId?: string;
    /**
     * Overrides: WI fields that replace the base (optional; put() fills it from the draft's fields, the default is
     * content, key, keysecondary and comment). Bookkeeping fields and `disable` never override.
     */
    fields?: string[];
}

export interface CanonItem {
    /** uid of the entry inside the canon book. */
    uid: number;
    meta: CanonMeta;
    /** The canon entry (WI entry fields). */
    entry: Record<string, unknown>;
}

export interface CanonDraft {
    /** WI entry fields for additions and overrides (content in English, keys incl. Russian forms). */
    entry: Record<string, unknown>;
    meta: Omit<CanonMeta, 'createdAt' | 'updatedAt'>;
}

export interface BaseDrift {
    item: CanonItem;
    /** Base content when the override was made vs now. */
    baseThen: string;
    baseNow: string;
}

export interface CanonBudget {
    limitChars: number;
    usedChars: number;
}

export interface CanonApi {
    /** Canon book name of a chat (current chat by default). */
    bookName(chatId?: string): string;
    /** Creates the canon book for the current chat when missing. */
    ensureBook(): Promise<string>;
    list(filter?: { kind?: CanonKind; status?: CanonStatus; origin?: CanonOrigin }): Promise<CanonItem[]>;
    /** Adds or updates (matching base or id) a canon item; returns its uid. Journaled with undo. */
    put(draft: CanonDraft, options?: { uid?: number }): Promise<number>;
    remove(uid: number): Promise<void>;
    setStatus(uid: number, status: CanonStatus): Promise<void>;
    /** "Make canon for all chats": writes the override into the base book (level 'ask'). */
    promote(uid: number): Promise<boolean>;
    /** Overrides whose base changed since they were made (author updated the book). */
    baseDrift(): Promise<BaseDrift[]>;
    /** Exports the canon as a plain chat lorebook (overrides materialised) — §4.9. Returns the book name. */
    exportPlain(): Promise<string>;
    budget(): CanonBudget;
    /** Russian key forms for a name/term (DES-RU declensions when available, else the term itself). */
    russianKeys(term: string): Promise<string[]>;
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M6 implementation (optional so that fakes of the stage-2 contract stay valid).
    /** What the latest real scan did with the canon. */
    lastScan?(): CanonScanReport | null;
    /** A base book was renamed (Lore Studio): items of every chat's canon follow it; returns how many moved. */
    renameBase?(oldName: string, newName: string): Promise<number>;
    /** «Подготовить к отключению»: every chat's canon as a plain lorebook; returns the created names. */
    exportAll?(): Promise<string[]>;
}

export interface CanonScanReport {
    at: number;
    added: number;
    replaced: number;
    suppressed: number;
    pinned: number;
    /** Archived items left out (not mentioned in the last messages). */
    dormant: number;
    /** Overrides/suppressions whose base was not in the scan. */
    missing: number;
    /** Canon activations cut by the canon budget. */
    cut: number;
}
