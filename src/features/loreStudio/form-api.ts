// Contract between the Lore Studio shell (books, list, actions) and the entry form (form/**).
import type { App, Unsubscribe } from '../../shared/contracts';
import type { BookRoleInfo } from '../bookRoles/api';
import type { LoreStore } from './store-api';

export interface EntryFormContext {
    app: App;
    store: LoreStore;
    book: string;
    uid: number;
    /** Role of the book (BunnyMo core/packs are read-only, P13). */
    role?: BookRoleInfo;
    readOnly: boolean;
    /** Called after a successful save (the list refreshes the row). */
    onSaved(): void;
    onClose(): void;
    /** The form registers a guard (null on dispose); the shell awaits it before switching entries or closing. */
    setLeaveGuard?(guard: (() => Promise<boolean>) | null): void;
}

/** Implemented in form/index.ts: renders the full entry editor into `container`; returns a disposer. */
export type RenderEntryForm = (container: HTMLElement, ctx: EntryFormContext) => Unsubscribe;
