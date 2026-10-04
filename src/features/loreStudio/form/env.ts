// Shared state and services of one entry form (M23 stage 2). Section builders get a FormEnv: the working copy
// (draft) of the entry, the stored copy, change/validation hooks and safe accessors to the neighbouring modules.
// Other modules are optional: every accessor returns undefined when the module is off (P11).
import { adaptersOf } from '../../../adapters';
import type { LocalizerApi } from '../../../adapters';
import type { TypedEntryMeta } from '../../../domain/entry-types';
import type { App } from '../../../shared/contracts';
import type { BookRoleInfo, BookRolesApi } from '../../bookRoles/api';
import type { CanonApi } from '../../canon/api';
import type { DoctorApi } from '../../doctor/api';
import type { LoreJournalApi } from '../../loreJournal/api';
import type { RulesApi } from '../../rules/api';
import type { EntryFormContext } from '../form-api';
import type { WiBookData, WiEntry, WiGlobalSettings } from '../store-api';

/** Where the typed-entry meta of this entry lives (P2: base books keep it in the bookRoles sidecar). */
export type TypedStorage = 'entry' | 'sidecar' | 'none';

export interface FormState {
    data: WiBookData;
    /** The entry as stored (fresh copy from the store). */
    stored: WiEntry;
    /** Working copy edited by the controls. */
    draft: WiEntry;
    /** ST's global World Info settings (for the «global» tri-states and the tester). */
    globals: WiGlobalSettings;
    typedStorage: TypedStorage;
    typedStored: TypedEntryMeta | null;
    typed: TypedEntryMeta | null;
    /** The whole sidecar record of a base entry (other keys, e.g. a passport, are kept on save). */
    sidecar: Record<string, unknown> | undefined;
    /** Canon book of the current chat, when the canon module runs and a chat is open. */
    canonBook: string | null;
    isCanonEntry: boolean;
}

export type StatusLevel = 'info' | 'ok' | 'warn' | 'error';

export interface FormEnv {
    app: App;
    ctx: EntryFormContext;
    t(key: string, params?: Record<string, string | number>): string;
    readOnly: boolean;
    role: BookRoleInfo | undefined;
    state: FormState;
    /** Releases something when the form is rebuilt or closed. */
    own(dispose: () => void): void;
    /** The draft (or the typed meta) changed: recompute dirty state and run the sync callbacks. */
    changed(): void;
    /** Registers a callback run after every change (visibility, placeholders, chips). */
    sync(run: () => void): void;
    setError(field: string, message: string | null): void;
    /** Opens another entry in place of this form (canon override); «back» returns here. */
    navigate(book: string, uid: number): void;
    /** Re-reads the entry from the store and rebuilds the form (drops unsaved edits). */
    reload(): Promise<void>;
    isDirty(): boolean;
    /** Short status line in the toolbar. */
    status(text: string, level?: StatusLevel): void;
}

function safeApi<T>(app: App, key: string): T | undefined {
    try {
        return app.modules.api<T>(key);
    } catch {
        return undefined;
    }
}

export const canonApi = (app: App) => safeApi<CanonApi>(app, 'canon');
export const bookRolesApi = (app: App) => safeApi<BookRolesApi>(app, 'bookRoles');
export const doctorApi = (app: App) => safeApi<DoctorApi>(app, 'doctor');
export const loreJournalApi = (app: App) => safeApi<LoreJournalApi>(app, 'loreJournal');
export const rulesApi = (app: App) => safeApi<RulesApi>(app, 'rules');

/** Pult tab id of M22 «Правила» (src/features/rules/view.ts RULES_TAB; features do not import each other). */
export const RULES_TAB_ID = 'rules';

/** Lorebook Localizer's programmatic API (0.2.0+) through the adapter; undefined when absent or incomplete. */
export function localizerApi(app: App): LocalizerApi | undefined {
    try {
        const adapter = adaptersOf(app).localizer;
        if (typeof adapter?.api !== 'function') return undefined;
        const api = adapter.api();
        return api && typeof api.localizeEntries === 'function' ? api : undefined;
    } catch {
        return undefined;
    }
}

/** Keys the Localizer appended to this entry (shown with a badge; never treated as the author's keys). */
export function localizerKeys(app: App, entry: unknown): Set<string> {
    try {
        const adapter = adaptersOf(app).localizer;
        return typeof adapter?.addedKeysOf === 'function' ? adapter.addedKeysOf(entry) : new Set();
    } catch {
        return new Set();
    }
}

/** Global settings value by any of its names (ST's `world_info_*` or a short alias), when it has the right type. */
export function globalValue<T extends 'number' | 'boolean'>(
    globals: WiGlobalSettings,
    names: string[],
    type: T,
): (T extends 'number' ? number : boolean) | undefined {
    for (const name of names) {
        const value = globals[name];
        if (typeof value === type) return value as T extends 'number' ? number : boolean;
    }
    return undefined;
}

export const GLOBAL_NAMES = {
    caseSensitive: ['world_info_case_sensitive', 'caseSensitive'],
    matchWholeWords: ['world_info_match_whole_words', 'matchWholeWords'],
    useGroupScoring: ['world_info_use_group_scoring', 'useGroupScoring'],
    scanDepth: ['world_info_depth', 'depth', 'scanDepth'],
} as const;

/** Label of an entry for titles and summaries: comment, else the first keys, else «#uid». */
export function entryLabel(entry: { comment?: unknown; key?: unknown; uid: number }): string {
    const comment = typeof entry.comment === 'string' ? entry.comment.trim() : '';
    if (comment) return comment.split('\n')[0]!.slice(0, 80);
    const keys = Array.isArray(entry.key) ? entry.key.filter((key) => typeof key === 'string').join(', ') : '';
    return keys ? keys.slice(0, 80) : `#${entry.uid}`;
}
