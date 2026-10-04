// Public API of M5 «Доктор» (app.modules.api<DoctorApi>('doctor')).
import type { Decision, Unsubscribe } from '../../shared/contracts';

export type FindingSeverity = 'info' | 'warn' | 'error';

export type FindingKind =
    | 'pack.duplicate'
    | 'pack.versionConflict'
    | 'recursion.chain'
    | 'recursion.vacuum'
    | 'role.assistantAtDepth'
    | 'ck.archiveScanDepth'
    | 'ck.archiveMultiBlock'
    | 'ck.archivePlaceholder'
    /** The archive block is not spelled `<BunnymoTags>` exactly (CK parsers are case-sensitive). */
    | 'ck.archiveTagCase'
    | 'ck.archiveNotRepo'
    | 'wrapper.collision'
    | 'keys.noRussian'
    | 'keys.cyrillicWholeWord'
    | 'keys.localizerBroken'
    | 'budget.overflow'
    | 'budget.strategy'
    | 'regex.breaksJson'
    | 'regex.breaksMarkers'
    | 'regex.stripsTags'
    | 'regex.duplicate'
    | 'regex.dead'
    | 'regex.conflict';

export interface Finding {
    id: string;
    kind: FindingKind;
    severity: FindingSeverity;
    /** i18n key + params for the message. */
    messageKey: string;
    params?: Record<string, string | number>;
    /** Locator: book/uid for lore, script id/name and type for regex. */
    target: Record<string, unknown>;
    /** Rule id (M22) that fixes it on the fly, if any. */
    fixRule?: string;
    /** File-level fix available ("Спросить"); never for BunnyMo packs (P13). */
    fileFix?: boolean;
}

/** Regex treatment: dead scripts are only ever disabled (other chats may need them). */
export type RegexAction = 'enable' | 'disable' | 'delete';

export interface RegexInfo {
    id: string;
    name: string;
    type: 'global' | 'scoped' | 'preset';
    disabled: boolean;
    placement: number[];
    promptOnly: boolean;
    markdownOnly: boolean;
    /** Best-effort owner guess: des, marinara, rpgCompanion, horae, rm, user, unknown. */
    owner: string;
    /** Find pattern as stored (`/…/flags`). */
    find?: string;
    replace?: string;
    /** Scoped/preset scripts run only when ST allows them for this character/preset. */
    allowed?: boolean;
    minDepth?: number | null;
    maxDepth?: number | null;
}

/** Lore statistics of one active book from the last scan (static, no chat text involved). */
export interface BookStat {
    book: string;
    /** Enabled entries. */
    entries: number;
    /** Characters of enabled entries. */
    chars: number;
    /** Characters of constant entries. */
    constantChars: number;
    /** Recursion links that start in this book. */
    links: number;
    /** Longest recursion chain starting in this book (steps). */
    maxDepth: number;
    /** Entries that pull in 5+ others directly. */
    vacuums: number;
    /** BunnyMo role of the book, if any (P13: never edited in files). */
    bunnymo: 'core' | 'pack' | null;
    /** The user's archive book (M35 'ck.archive', or a non-BunnyMo book with CK archives). */
    archive?: boolean;
}

export interface DoctorApi {
    /** Re-runs every check (lorebooks of the active chat + all regex scripts). */
    scan(): Promise<Finding[]>;
    findings(): Finding[];
    regexInventory(): Promise<RegexInfo[]>;
    /** Book statistics of the last scan (empty before the first scan). */
    bookStats?(): BookStat[];
    /** When the last scan finished (ms), 0 before the first scan. */
    lastScanAt?(): number;
    /**
     * Runs one script (by RegexInfo id) on a text through ST's regex engine, even when the script is disabled.
     * Null when the engine is unavailable (capability `st.regex`) or the script is unknown.
     */
    testRegex?(id: string, text: string): Promise<string | null>;
    /** Fires after every scan. */
    onChange?(listener: () => void): Unsubscribe;
    /**
     * «Исправить в файле» for a finding of the last scan (autonomy kind 'doctor.fileFix', default 'ask'); 'skipped'
     * when the finding has no file fix (BunnyMo books never do) or nothing is left to fix.
     */
    fixInFile?(findingId: string): Promise<Decision>;
    /** Enables, disables or deletes one regex script (RegexInfo id) through autonomy. */
    regexAction?(id: string, action: RegexAction): Promise<Decision>;
}
