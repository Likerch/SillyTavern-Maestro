// Lorebook writes of the doctor's file fixes (plan M5 «Лечение», P13). ST rules (research/st-world-info.md §6): an
// immediate `saveWorldInfo(name, data, true)` (the debounced save is shared by every book), `reloadWorldInfoEditor(name)`
// so an open editor does not write back its stale copy, then DES's Lore Library cache. BunnyMo books are refused by
// their M35 role (read-only), the BunnyMo adapter's classification and their content — right before the write.
// Journal target 'lore-entry' (shared with M22): ref `{book, uid}`, before/after are the changed fields of the entry;
// they are also the backup — undo writes `before` back while the entry still holds `after`.
import { adaptersOf } from '../../adapters';
import { commitPatches, isBookData, isBunnyMoBook } from '../../domain/doctor-fixes';
import type { BookData, BookIo, EntryPatch, FieldValues, PatchResult } from '../../domain/doctor-fixes';
import type { App, JournalChange } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';

export const LORE_ENTRY_TARGET = 'lore-entry';

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function bookRoles(app: App): BookRolesApi | undefined {
    return app.modules.api<BookRolesApi>('bookRoles');
}

/** ST's lorebook functions from the context; null when this ST lacks them. */
export function bookIo(app: App): BookIo | null {
    const ctx = app.host.ctx();
    if (typeof ctx.loadWorldInfo !== 'function' || typeof ctx.saveWorldInfo !== 'function') return null;
    return {
        async load(book) {
            const data: unknown = await app.host.ctx().loadWorldInfo?.(book);
            return isBookData(data) ? data : null;
        },
        async save(book, data) {
            const current = app.host.ctx();
            await current.saveWorldInfo?.(book, data, true);
            try {
                current.reloadWorldInfoEditor?.(book);
            } catch (error) {
                app.log.debug('lorebook editor reload failed', error);
            }
            try {
                adaptersOf(app).des.invalidateLoreCache(book);
            } catch (error) {
                app.log.debug('DES Lore Library cache reset failed', error);
            }
        },
    };
}

/** BunnyMo core or pack (P13): by its M35 role, the BunnyMo adapter or the book's content. */
export function isProtectedBook(app: App, book: string, data: BookData | null): boolean {
    try {
        const role = bookRoles(app)?.roleOf(book);
        if (role && (role.readOnly || role.role === 'bunnymo.core' || role.role === 'bunnymo.pack')) return true;
    } catch (error) {
        app.log.debug('book roles are not available', error);
    }
    try {
        const known = adaptersOf(app).bunnymo.books();
        if (known.core.includes(book) || known.packs.includes(book)) return true;
    } catch (error) {
        app.log.debug('BunnyMo classification is not available', error);
    }
    return !!data && isBunnyMoBook(book, data);
}

/** Writes the patches unless the book is protected. */
export async function writePatches(
    app: App,
    book: string,
    patches: readonly EntryPatch[],
    direction: 'apply' | 'revert' = 'apply',
): Promise<PatchResult> {
    const io = bookIo(app);
    if (!io) return { ok: false, reason: 'missing', uids: [] };
    return commitPatches(io, book, patches, { direction, guard: (data) => !isProtectedBook(app, book, data) });
}

export function patchChanges(book: string, patches: readonly EntryPatch[]): JournalChange[] {
    return patches.map((patch) => ({
        target: LORE_ENTRY_TARGET,
        ref: { book, uid: patch.uid },
        before: patch.before,
        after: patch.after,
    }));
}

export async function undoLoreEntry(app: App, change: JournalChange): Promise<boolean> {
    const book = change.ref.book;
    const uid = Number(change.ref.uid);
    if (typeof book !== 'string' || !Number.isFinite(uid) || !isDict(change.before) || !isDict(change.after)) {
        return false;
    }
    const patch: EntryPatch = { uid, before: change.before as FieldValues, after: change.after as FieldValues };
    return (await writePatches(app, book, [patch], 'revert')).ok;
}

export function isEntryPatch(value: unknown): value is EntryPatch {
    return isDict(value) && typeof value.uid === 'number' && isDict(value.before) && isDict(value.after);
}
