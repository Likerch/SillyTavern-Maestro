// Shared state and context of the BunnyMo mode views (pult tab «BunnyMo», M35 п. 4–9).
import type { App } from '../../shared/contracts';
import { el } from '../../ui/components/dom';
import type { ArchiveSheet, PackDiff } from './api';
import type { BunnyMoModeService } from './service';

export type Section = 'dictionary' | 'packs' | 'integrity' | 'sheets' | 'edits';

export const SECTIONS: readonly Section[] = ['dictionary', 'packs', 'integrity', 'sheets', 'edits'];

/** Category filter value for bare flags (`<DEPRESSION>`), which are one category each. */
export const FLAGS_FILTER = '\u0000flags';
/** Tags shown before «show more». */
export const DICTIONARY_PAGE = 120;

export interface SheetEditorState {
    book: string;
    uid: number;
    /** The sheet as read (the «discard changes» point). */
    original: ArchiveSheet;
    /** The sheet being edited. */
    draft: ArchiveSheet;
    /** Index of the tag loaded into the add row for replacement, or null. */
    editIndex: number | null;
    category: string;
    value: string;
}

/** Survives re-renders and pult close/open while the module runs. */
export interface ViewState {
    section: Section;
    dict: { search: string; category: string; open: string | null; limit: number };
    packs: { diff: { book: string; file: string; diff: PackDiff } | null; focus: string | null };
    sheets: { editor: SheetEditorState | null; pending: { book: string; uid: number } | null };
}

export function initialViewState(): ViewState {
    return {
        section: 'dictionary',
        dict: { search: '', category: '', open: null, limit: DICTIONARY_PAGE },
        packs: { diff: null, focus: null },
        sheets: { editor: null, pending: null },
    };
}

export interface ViewContext {
    app: App;
    service: BunnyMoModeService;
    state: ViewState;
    t(key: string, params?: Record<string, string | number>): string;
    /** Redraws the current section (no-op once the tab is unmounted). */
    redraw(): void;
    go(section: Section): void;
    /** Runs a user action; failures become an error notice. */
    run(job: () => Promise<unknown>): Promise<void>;
    alive(): boolean;
}

export function loading(t: ViewContext['t']): HTMLElement {
    return el('div', { class: 'maestro-muted maestro-m35b-loading', text: t('m35b.loading') });
}

export function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Deep copy of a sheet (the editor never edits what it read). */
export function copySheet(sheet: ArchiveSheet): ArchiveSheet {
    return JSON.parse(JSON.stringify(sheet)) as ArchiveSheet;
}

export function tagText(tag: { key: string; value: string }): string {
    return `<${tag.key}:${tag.value}>`;
}
