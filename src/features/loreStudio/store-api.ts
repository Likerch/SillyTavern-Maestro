// Internal data layer of the Lore Studio (M23). Implemented in store.ts; used by the studio views (books, list,
// entry form, settings) and exposed to other modules as app.modules.api<LoreStore>('loreStore').
// Rules (research/parity-lore.md "трудные места"): per-book save queue with immediate saves, reload of ST's editor
// and DES Lore Library cache after every write, global selection through ST's own change handler, unknown fields
// round-tripped, card-embedded books kept in sync with originalData.
import type { Unsubscribe } from '../../shared/contracts';

export type WiEntry = Record<string, unknown> & {
    uid: number;
    key: string[];
    keysecondary: string[];
    content: string;
    comment: string;
    disable?: boolean;
    constant?: boolean;
    position?: number;
    depth?: number;
    role?: number | null;
    order?: number;
};

export interface WiBookData {
    entries: Record<string, WiEntry>;
    originalData?: Record<string, unknown>;
    extensions?: Record<string, unknown>;
    [key: string]: unknown;
}

export interface WiBindings {
    global: string[];
    character: { primary: string | null; extra: string[] };
    chat: string | null;
    persona: string | null;
}

export type WiGlobalSettings = Record<string, number | boolean | string>;

export interface SaveReason {
    module: string;
    summary: string;
}

export interface LoreStore {
    books(): string[];
    /** Fresh deep copy of a book (never the cache object). */
    load(name: string): Promise<WiBookData | null>;
    /** Queued immediate save; reloads ST's editor and resets DES Lore Library cache; journals the change. */
    save(name: string, data: WiBookData, reason: SaveReason): Promise<void>;
    createBook(name: string): Promise<string>;
    renameBook(oldName: string, newName: string): Promise<void>;
    duplicateBook(name: string, newName: string): Promise<void>;
    deleteBook(name: string): Promise<void>;
    importBook(file: File): Promise<string>;
    exportBook(name: string): Promise<void>;
    createEntry(book: string, partial?: Partial<WiEntry>, reason?: SaveReason): Promise<number>;
    updateEntry(book: string, uid: number, patch: Partial<WiEntry>, reason: SaveReason): Promise<void>;
    deleteEntry(book: string, uid: number, reason?: SaveReason): Promise<void>;
    duplicateEntry(book: string, uid: number, reason?: SaveReason): Promise<number>;
    moveEntry(fromBook: string, uid: number, toBook: string, copy: boolean, reason?: SaveReason): Promise<number>;
    bindings(): Promise<WiBindings>;
    setGlobal(name: string, active: boolean): Promise<void>;
    setCharacterPrimary(name: string | null): Promise<void>;
    setCharacterExtra(names: string[]): Promise<void>;
    setChatBook(name: string | null): Promise<void>;
    setPersonaBook(name: string | null): Promise<void>;
    globalSettings(): Promise<WiGlobalSettings>;
    setGlobalSettings(patch: WiGlobalSettings): Promise<void>;
    /** Previous versions of an entry saved through the store (newest first), kept in a Maestro file per book. */
    history(book: string, uid: number): Promise<EntryVersion[]>;
    onChange(listener: (book: string | null) => void): Unsubscribe;
}

export interface EntryVersion {
    at: number;
    /** Who changed it: 'user' (studio), a module id ('M6', 'M8'), 'localizer', 'ck', 'st' (outside Maestro). */
    by: string;
    summary: string;
    entry: WiEntry;
}
