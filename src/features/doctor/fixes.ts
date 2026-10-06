// «Исправить в файле» (plan M5 «Лечение», §8, P13; dev-plan 2.5): a finding with a file-level fix proposes a patch of
// the book through app.autonomy (kind 'doctor.fileFix', default 'ask', never 'auto'), with the changes as a preview.
// The patch is computed from the fresh book when the button is pressed, checked again before the write (nothing may
// have changed) and journaled per entry (target 'lore-entry', the previous values are the backup). BunnyMo books are
// never offered a fix and are refused again right before the write.
// Fixes: assistant role at depth → system (the user's archive books only: elsewhere the role may be intended), CK
// archive scan depth 1 → global, broken Lorebook Localizer keys (respelled or removed), Cyrillic whole-word keys →
// left-boundary regex keys (user books; archives stay with DES-RU while its BunnyMo module widens them).
import { adaptersOf } from '../../adapters';
import { isCharacterArchive } from '../../domain/bunnymo';
import {
    enabledEntriesOf,
    hasArchives,
    patchBookData,
    planCyrillicFix,
    planLocalizerFix,
    planRoleFix,
    planScanDepthFix,
} from '../../domain/doctor-fixes';
import type { BookData, EntryPatch, RawEntry } from '../../domain/doctor-fixes';
import type { App, Decision, Unsubscribe } from '../../shared/contracts';
import type { Finding, FindingKind } from './api';
import {
    LORE_ENTRY_TARGET,
    bookIo,
    bookRoles,
    isEntryPatch,
    isProtectedBook,
    patchChanges,
    undoLoreEntry,
    writePatches,
} from './files';
import { readWorldInfoSettings } from './sources';

export const FILE_FIX_KIND = 'doctor.fileFix';
/** Finding kinds with a file fix, and the short name used in strings. */
const FIXERS: Partial<Record<FindingKind, string>> = {
    'role.assistantAtDepth': 'role',
    'ck.archiveScanDepth': 'scanDepth',
    'keys.localizerBroken': 'localizer',
    'keys.cyrillicWholeWord': 'cyrillic',
};
const DESRU_BUNNYMO = 'desru.bunnymo';
const PREVIEW_LINES = 12;
const ROLE_NAMES: Record<number, string> = { 0: 'system', 1: 'user', 2: 'assistant' };

export interface FileFixPayload {
    book: string;
    kind: FindingKind;
    patches: EntryPatch[];
}

/** What the last scan knows about the books (for showing the button without reading the book). */
export interface BookFacts {
    bunny: ReadonlySet<string>;
    archive: ReadonlySet<string>;
}

export type FileFixOutcome =
    | { status: 'decided'; decision: Decision; book: string; count: number }
    | { status: 'nothing' | 'protected' | 'unavailable'; book: string };

function isFileFixPayload(value: unknown): value is FileFixPayload {
    if (typeof value !== 'object' || value === null) return false;
    const payload = value as Partial<FileFixPayload>;
    return (
        typeof payload.book === 'string' &&
        typeof payload.kind === 'string' &&
        Array.isArray(payload.patches) &&
        payload.patches.every(isEntryPatch)
    );
}

export function hasFileFixer(kind: FindingKind): boolean {
    return FIXERS[kind] !== undefined;
}

/** The finding gets «Исправить в файле»: it has a fixer, a file fix is allowed and the book is not BunnyMo. */
export function fileFixOffered(finding: Finding, facts: BookFacts): boolean {
    if (finding.fileFix !== true || !hasFileFixer(finding.kind)) return false;
    const book = finding.target.book;
    if (typeof book !== 'string' || !book || facts.bunny.has(book)) return false;
    return finding.kind !== 'role.assistantAtDepth' || facts.archive.has(book);
}

function targetUid(finding: Finding): number | null {
    const uid = finding.target.uid;
    return typeof uid === 'number' && Number.isFinite(uid) ? uid : null;
}

/** The user's archive book: M35 role 'ck.archive', or (without a role) a book that holds archives. */
export function isArchiveBook(app: App, book: string, data: BookData): boolean {
    let role;
    try {
        role = bookRoles(app)?.roleOf(book);
    } catch {
        role = undefined;
    }
    return role ? role.role === 'ck.archive' : hasArchives(data);
}

function desruWidensArchives(app: App): boolean {
    try {
        return adaptersOf(app).desru.capabilities().includes(DESRU_BUNNYMO);
    } catch {
        return false;
    }
}

/** Patches of the fix from the fresh book: null when nothing is left to fix, 'protected' for BunnyMo books. */
export async function planFileFix(app: App, finding: Finding): Promise<FileFixPayload | null | 'protected'> {
    const planned = await planWithBook(app, finding);
    return planned === null || planned === 'protected' ? planned : planned.payload;
}

async function planWithBook(
    app: App,
    finding: Finding,
): Promise<{ payload: FileFixPayload; data: BookData } | null | 'protected'> {
    const book = finding.target.book;
    const io = bookIo(app);
    if (typeof book !== 'string' || !io || !hasFileFixer(finding.kind)) return null;
    const data = await io.load(book);
    if (!data) return null;
    if (isProtectedBook(app, book, data)) return 'protected';
    const entries = enabledEntriesOf(data);
    const uid = targetUid(finding);
    const one = (plan: (uid: number, entry: RawEntry) => EntryPatch | null): EntryPatch[] => {
        const item = uid === null ? undefined : entries.find((candidate) => candidate.uid === uid);
        const patch = item ? plan(item.uid, item.entry) : null;
        return patch ? [patch] : [];
    };
    let patches: EntryPatch[];
    switch (finding.kind) {
        case 'role.assistantAtDepth':
            patches = isArchiveBook(app, book, data) ? one(planRoleFix) : [];
            break;
        case 'ck.archiveScanDepth':
            patches = one(planScanDepthFix);
            break;
        case 'keys.localizerBroken':
            patches = one(planLocalizerFix);
            break;
        case 'keys.cyrillicWholeWord': {
            const wi = await readWorldInfoSettings(app, app.log);
            const globals = { caseSensitive: wi?.caseSensitive ?? false, wholeWords: wi?.wholeWords ?? false };
            const skipArchives = desruWidensArchives(app);
            patches = entries
                .filter(({ entry }) => !(skipArchives && isCharacterArchive(entry)))
                .map(({ uid: entryUid, entry }) => planCyrillicFix(entryUid, entry, globals))
                .filter((patch): patch is EntryPatch => patch !== null);
            break;
        }
        default:
            patches = [];
    }
    return patches.length ? { payload: { book, kind: finding.kind, patches }, data } : null;
}

function valueText(app: App, field: string, value: unknown): string {
    if (field === 'scanDepth' && (value === null || value === undefined)) return app.i18n.t('m5.fixFile.globalDepth');
    if (field === 'role' && typeof value === 'number') return ROLE_NAMES[value] ?? String(value);
    if (Array.isArray(value)) return value.map(String).join(', ') || '—';
    return value === null || value === undefined ? '—' : String(value);
}

/** «Entries: «Anna», «Tavern» …» — the entries' titles (comment, else the first key) for the question. */
export function entryNames(app: App, data: Record<string, RawEntry> | null, patches: readonly EntryPatch[]): string {
    const names = patches
        .map((patch) => {
            const entry = data?.[String(patch.uid)];
            const comment = typeof entry?.comment === 'string' ? entry.comment.trim() : '';
            const key = Array.isArray(entry?.key) && typeof entry.key[0] === 'string' ? entry.key[0].trim() : '';
            return comment || key;
        })
        .filter(Boolean);
    if (!names.length) return '';
    const shown = names.slice(0, PREVIEW_LINES).map((name) => `«${name}»`);
    if (names.length > PREVIEW_LINES)
        shown.push(app.i18n.t('m5.fixFile.more', { count: names.length - PREVIEW_LINES }));
    return app.i18n.t('m5.fixFile.entries', { list: shown.join(', ') });
}

/** Technical preview of the patches (uid, field: before → after) for «Подробнее». */
export function previewText(app: App, data: Record<string, RawEntry> | null, patches: readonly EntryPatch[]): string {
    const lines = patches.slice(0, PREVIEW_LINES).map((patch) => {
        const entry = data?.[String(patch.uid)];
        const comment = typeof entry?.comment === 'string' && entry.comment.trim() ? ` «${entry.comment.trim()}»` : '';
        const fields = Object.keys(patch.after)
            .filter((field) => field !== 'extensions')
            .map(
                (field) =>
                    `${field}: ${valueText(app, field, patch.before[field])} → ${valueText(app, field, patch.after[field])}`,
            );
        return `#${patch.uid}${comment}: ${fields.join('; ') || app.i18n.t('m5.fixFile.marker')}`;
    });
    if (patches.length > PREVIEW_LINES) {
        lines.push(app.i18n.t('m5.fixFile.more', { count: patches.length - PREVIEW_LINES }));
    }
    return lines.join('\n');
}

async function applyFileFix(app: App, payload: FileFixPayload): Promise<void> {
    const result = await writePatches(app, payload.book, payload.patches);
    if (!result.ok) {
        throw new Error(app.i18n.t(`m5.fixFile.failed.${result.reason ?? 'missing'}`, { book: payload.book }));
    }
}

async function fileFixValid(app: App, payload: FileFixPayload): Promise<boolean> {
    const io = bookIo(app);
    const data = io ? await io.load(payload.book) : null;
    if (!data || isProtectedBook(app, payload.book, data)) return false;
    return patchBookData(data, payload.patches).ok;
}

/** Plans the fix and proposes it (default 'ask': the question shows the preview). */
export async function fixInFile(app: App, finding: Finding): Promise<FileFixOutcome> {
    const book = typeof finding.target.book === 'string' ? finding.target.book : '';
    if (!bookIo(app)) return { status: 'unavailable', book };
    const planned = await planWithBook(app, finding);
    if (planned === 'protected') return { status: 'protected', book };
    if (!planned) return { status: 'nothing', book };
    const { payload: plan, data } = planned;
    const t = app.i18n.t.bind(app.i18n);
    const name = FIXERS[plan.kind] ?? 'other';
    const decision = await app.autonomy.decide<FileFixPayload>(
        {
            module: 'M5',
            kind: FILE_FIX_KIND,
            title: t(`m5.fixFile.title.${name}`, { book }),
            description: [
                t('m5.fixFile.description', { book, count: plan.patches.length }),
                entryNames(app, data.entries, plan.patches),
            ]
                .filter(Boolean)
                .join('\n\n'),
            // Entry uids and field names (role, scanDepth, keys) belong under «Подробнее».
            details: previewText(app, data.entries, plan.patches),
            changes: patchChanges(book, plan.patches),
            payload: plan,
            stillValid: () => fileFixValid(app, plan),
            apply: (value) => applyFileFix(app, value),
        },
        'ask',
    );
    return { status: 'decided', decision, book, count: plan.patches.length };
}

/** Undo of 'lore-entry' changes and the Inbox applier of file fixes; the module owns the returned disposer. */
export function registerFileFixes(app: App): Unsubscribe {
    app.journal.registerUndo(LORE_ENTRY_TARGET, (change) => undoLoreEntry(app, change));
    // Edits of base books never become «auto» (plan §8).
    app.autonomy.neverAuto(FILE_FIX_KIND);
    return app.inbox.registerApplier(
        FILE_FIX_KIND,
        async (payload) => {
            if (!isFileFixPayload(payload)) throw new Error('bad file fix card');
            await applyFileFix(app, payload);
        },
        async (payload) => isFileFixPayload(payload) && fileFixValid(app, payload),
    );
}
