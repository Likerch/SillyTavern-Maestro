// BunnyMo mode of the Lore Studio (M35, stage 3, plan M35 п. 4–9): the tag dictionary of the loaded packs, the pack
// manager (versions, update from a new file with a diff, packs per chat by on-the-fly suppression), the archive
// (sheet) editor and the integrity checks. Pack files are never written (P13): per-chat selection and version
// choices act on scan copies only. Exposed as app.modules.api<BunnyMoModeApi>('bunnymoMode').
import type { Unsubscribe } from '../../shared/contracts';

/** A pack entry that pulls lore by its tag key vs an informational entry (read-me, category notes). */
export type TagEntryKind = 'pull' | 'info';

export interface TagInfo {
    /** Normalised tag as written in keys: `<SPECIES:ELF>`, `<ENFJ-U>`, `<DEPRESSION>`. */
    tag: string;
    /** Tag key (`SPECIES`, `MBTI` for bare archetypes, the tag itself for flags). */
    category: string;
    value: string | null;
    /** Pack entries keyed by this tag. */
    entries: { book: string; uid: number; kind: TagEntryKind; comment: string; chars: number }[];
    /** Archive entries (CK repositories) whose `<BunnymoTags>` use the tag. */
    usedBy: { book: string; uid: number; name: string }[];
    /** Same tag in more than one pack with different text (version conflict, see M22 pack.versionConflict). */
    conflict: boolean;
    /** Used by archives but no loaded pack has an entry for it. */
    orphan: boolean;
    // Additions of the M35 stage-3 implementation (optional).
    /** Same tag in more than one pack with identical text (merged and split editions). */
    duplicate?: boolean;
}

export interface TagDictionary {
    builtAt: number;
    /** `info`: no tag of the category pulls a pack entry; `flag`: bare tags without a value (`<DEPRESSION>`). */
    categories: { id: string; tags: number; info?: boolean; flag?: boolean }[];
    tags: TagInfo[];
}

export interface PackInfo {
    book: string;
    /** Pack name and version as recognised from the book (e.g. «MBTI», «V2»). */
    name: string;
    version?: string;
    /** 'shared' — one file for several packs; 'split' — a pack per file. */
    edition: 'shared' | 'split';
    entries: number;
    /** Active in ST now (global, card, chat, persona). */
    active: boolean;
    /** Excluded from this chat by the per-chat selection. */
    offInChat: boolean;
    // Additions of the M35 stage-3 implementation (optional).
    /** Pack family recognised by content («MBTI», «Species», «BSM-5 CoT Lenses»); `name` falls back to the book. */
    family?: string;
}

/** Per-chat pack selection: everything ST activates, or only the listed books (others suppressed on the fly). */
export type PackSelection = { mode: 'all' } | { mode: 'only'; books: string[] };

export interface PackDiff {
    added: { key: string; comment: string }[];
    removed: { key: string; comment: string }[];
    changed: { key: string; comment: string; before: string; after: string }[];
}

export interface IntegrityFinding {
    kind:
        'coreMissing' | 'coreVersion' | 'packAsRepo' | 'ckWrapRewrite' | 'ckBackup' | 'canonGlobal' | 'chatBookGlobal';
    text: string;
    book?: string;
}

/** A parsed CK archive (one entry = one character; `<Name:…>` never changes). */
export interface ArchiveSheet {
    book: string;
    uid: number;
    name: string;
    tags: { key: string; value: string }[];
    /** MBTI archetype with its H/U variant. */
    mbti?: { type: string; variant: 'H' | 'U' };
    /** `<Linguistics>` block and prose sections as written (text outside the tag block). */
    linguistics?: string;
    sections: { title: string; text: string }[];
    // Additions of the M35 stage-3 implementation (optional).
    /** Entry title (comment), for display. */
    title?: string;
    /** `<BunnymoTags>` blocks in the entry; more than one cannot be saved (one entry, one character). */
    blocks?: number;
}

export interface TagValidation {
    tag: string;
    ok: boolean;
    /** Why not: unknown category, value without a pack entry, placeholder, malformed. */
    reason?: string;
    suggestions?: string[];
    // Additions of the M35 stage-3 implementation (optional).
    /**
     * `reason` in words (translated). `reason` itself is a code: malformed, cyrillic, placeholder, transitional,
     * duplicate, unknownCategory, unknownValue, noPack.
     */
    message?: string;
}

export interface BunnyMoModeApi {
    dictionary(): Promise<TagDictionary>;
    packs(): Promise<PackInfo[]>;
    selection(): PackSelection;
    setSelection(selection: PackSelection): Promise<void>;
    /** Diff of a pack book against a new pack file (nothing is written until the user applies it via import). */
    diffWithFile(book: string, file: File): Promise<PackDiff>;
    integrity(): Promise<IntegrityFinding[]>;
    readSheet(book: string, uid: number): Promise<ArchiveSheet | null>;
    validateTags(tags: readonly string[]): Promise<TagValidation[]>;
    /** Writes the archive entry (immediate save, journal undo); refuses BunnyMo books and a changed `<Name:…>`. */
    saveSheet(sheet: ArchiveSheet): Promise<void>;
    /** Opens the BunnyMo mode view (pult tab or Lore Studio panel) on a pack, tag or archive. */
    open(target?: { book?: string; tag?: string; uid?: number }): void;
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M35 stage-3 implementation (optional so that fakes stay valid).
    /** The pack book is suppressed in this chat by the per-chat selection (cheap, sync; never true for the core). */
    isOffInChat?(book: string): boolean;
    /**
     * Applies the per-chat selection to a WORLDINFO_ENTRIES_LOADED payload now (splices entries of non-selected packs
     * out of the per-scan lists; idempotent). M22 may call it before its own pack rules so the order of listeners does
     * not matter. Returns the number of entries removed.
     */
    applySelection?(payload: unknown): number;
}
