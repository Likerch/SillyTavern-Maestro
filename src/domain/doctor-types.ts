// Shared shapes of M5 «Доктор»: the light copy of a World Info entry the checks read, and the issue the checks
// return. The feature turns issues into `Finding`s (id + the same fields); `DoctorIssueKind` must stay a subset of
// `FindingKind` in src/features/doctor/api.ts (the compiler checks the assignment there).

export type DoctorSeverity = 'info' | 'warn' | 'error';

export type DoctorIssueKind =
    | 'pack.duplicate'
    | 'pack.versionConflict'
    | 'recursion.chain'
    | 'recursion.vacuum'
    | 'role.assistantAtDepth'
    | 'ck.archiveScanDepth'
    | 'ck.archiveMultiBlock'
    | 'ck.archivePlaceholder'
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

export interface DoctorIssue {
    kind: DoctorIssueKind;
    severity: DoctorSeverity;
    /** i18n key of the message (`m5.f.*`). */
    messageKey: string;
    params?: Record<string, string | number>;
    /** Locator: `{book, uid, comment}` for lore, `{books}` for book pairs, `{scripts: [{id, name, type}]}` for regex. */
    target: Record<string, unknown>;
    /** Rule id (M22) that fixes it on the fly. */
    fixRule?: string;
    /** A file-level fix is possible ("Спросить", stage 2). Never for BunnyMo books (P13). */
    fileFix?: boolean;
}

/** Rule ids of M22 the doctor points to (stage 1). */
export const DOCTOR_RULES = {
    duplicates: 'pack.duplicates',
    bookCap: 'book.cap',
    assistantToSystem: 'role.assistantToSystem',
} as const;

/** A World Info entry as the doctor reads it: a light, normalised copy (never ST's object). */
export interface DoctorEntry {
    book: string;
    uid: number;
    comment: string;
    content: string;
    /** Primary keys, trimmed, without empty ones. */
    key: string[];
    keysecondary: string[];
    disable: boolean;
    constant: boolean;
    /** world_info_position: 0 before, 1 after, 2/3 AN, 4 at depth, 5/6 examples, 7 outlet. */
    position: number;
    depth: number;
    /** 0 system, 1 user, 2 assistant (used at depth); null when unset. */
    role: number | null;
    /** null = the global scan depth. */
    scanDepth: number | null;
    /** null = the global setting. */
    caseSensitive: boolean | null;
    /** null = the global setting. */
    matchWholeWords: boolean | null;
    excludeRecursion: boolean;
    preventRecursion: boolean;
    ignoreBudget: boolean;
    /** Keys Lorebook Localizer appended (from its provenance marker). */
    localizerKeys: string[];
}

/** BunnyMo role of a book (P13: core and packs are never edited in files). */
export type BunnyBookKind = 'core' | 'pack';

function str(value: unknown): string {
    return typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
}

function keyList(value: unknown): string[] {
    return Array.isArray(value) ? value.map((key) => str(key).trim()).filter(Boolean) : [];
}

function num(value: unknown, fallback: number): number {
    const parsed = typeof value === 'number' ? value : typeof value === 'string' && value !== '' ? Number(value) : NaN;
    return Number.isFinite(parsed) ? parsed : fallback;
}

function nullableNum(value: unknown): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = num(value, NaN);
    return Number.isFinite(parsed) ? parsed : null;
}

function nullableBool(value: unknown): boolean | null {
    return typeof value === 'boolean' ? value : null;
}

/**
 * Normalises a raw entry of a loaded book (`loadWorldInfo(name).entries[uid]`). Missing fields take ST's template
 * defaults (world-info.js `newWorldInfoEntryDefinition`): position 0, depth 4, null for "use the global setting".
 */
export function toDoctorEntry(
    book: string,
    raw: Record<string, unknown>,
    fallbackUid: number,
    localizerKeys: string[] = [],
): DoctorEntry {
    return {
        book,
        uid: num(raw.uid, fallbackUid),
        comment: str(raw.comment),
        content: str(raw.content),
        key: keyList(raw.key),
        keysecondary: keyList(raw.keysecondary),
        disable: raw.disable === true,
        constant: raw.constant === true,
        position: num(raw.position, 0),
        depth: num(raw.depth, 4),
        role: nullableNum(raw.role),
        scanDepth: nullableNum(raw.scanDepth),
        caseSensitive: nullableBool(raw.caseSensitive),
        matchWholeWords: nullableBool(raw.matchWholeWords),
        excludeRecursion: raw.excludeRecursion === true,
        preventRecursion: raw.preventRecursion === true,
        ignoreBudget: raw.ignoreBudget === true,
        localizerKeys: [...localizerKeys],
    };
}

/** "Comment" or "#uid" for messages. */
export function entryLabel(entry: Pick<DoctorEntry, 'comment' | 'uid'>): string {
    const comment = entry.comment.trim();
    return comment ? (comment.length > 80 ? `${comment.slice(0, 77)}…` : comment) : `#${entry.uid}`;
}

/** Up to `limit` items joined for a message, with "…" when more exist. */
export function sample(items: string[], limit = 3): string {
    const unique = [...new Set(items)];
    const shown = unique.slice(0, limit).join(', ');
    return unique.length > limit ? `${shown}, …` : shown;
}

/** Enabled entries only (disabled ones never reach the prompt). */
export function enabledEntries(entries: readonly DoctorEntry[]): DoctorEntry[] {
    return entries.filter((entry) => !entry.disable);
}
