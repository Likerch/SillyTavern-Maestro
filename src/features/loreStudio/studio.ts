// The Lore Studio window (M23): a Maestro window (plan-2 §10: non-modal, floating and large by default, full screen
// on phones ≤1000px; the module registers it as 'loreStudio' and this class renders its body). «Books» view: books by role
// on the left, entries of the selected book in the centre, the entry form on the right (an overlay on phones, one
// pane at a time); «WI settings» and «DES campaigns» views. All data goes through the LoreStore (store.ts).
import { bookLinks, freeBookName, linkCount } from '../../domain/lore-studio-books';
import type { BookLinks } from '../../domain/lore-studio-books';
import { moveCampaign } from '../../domain/lore-studio-campaigns';
import { backfillComments, statusPatch } from '../../domain/lore-studio-entries';
import type { EntryStatus, LoreBook, LoreEntry } from '../../domain/lore-studio-entries';
import { readWiSettings } from '../../domain/lore-studio-settings';
import {
    DEFAULT_PAGE_SIZE,
    DEFAULT_SORT_ID,
    PAGE_SIZES,
    SORT_OPTIONS,
    applyOrder,
    plainSearch,
    reorderPage,
} from '../../domain/lore-studio-sort';
import { adaptersOf } from '../../adapters';
import type { LocalizerApi } from '../../adapters';
import { segmented } from '../../ui/components/controls';
import { button, el } from '../../ui/components/dom';
import type { App, Logger, MaestroWindowSpec, Unsubscribe, UserJobInfo, UserJobs } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { CanonApi } from '../canon/api';
import type { DoctorApi } from '../doctor/api';
import type { LoreJournalApi } from '../loreJournal/api';
import { applyOrderForm, bulkEditForm, moveTargetForm } from './dialog-forms';
import { Dialogs } from './dialogs';
import type { RenderEntryForm } from './form-api';
import { userJobs } from './jobs';
import { bookJobKey, startLocalizeJob } from './localize-job';
import type { LoreStoreService } from './store';
import type { SaveReason } from './store-api';
import { renderBooksPanel } from './view-books';
import type { BooksActions, BooksModel, BooksState } from './view-books';
import { renderCampaignsPanel } from './view-campaigns';
import type { CampaignsActions, CampaignsModel } from './view-campaigns';
import { renderEntriesPanel, visibleEntries } from './view-entries';
import type { EntriesActions, EntriesModel, EntriesState } from './view-entries';
import { renderJobStrip } from './view-job';
import { renderSettingsPanel } from './view-settings';

export interface LoreStudioSettings {
    /** Replace ST's «Worlds/Lorebooks» button with the studio (plan M23: only when parity is green). */
    takeoverButton: boolean;
    sort: number;
    pageSize: number;
    /** DES auto-link toggle explained once (audit T9: the studio and DES must not fight over active books). */
    autoLinkAsked: boolean;
}

export function defaultStudioSettings(): LoreStudioSettings {
    return { takeoverButton: false, sort: DEFAULT_SORT_ID, pageSize: DEFAULT_PAGE_SIZE, autoLinkAsked: false };
}

export interface StudioDeps {
    app: App;
    log: Logger;
    store: LoreStoreService;
    /** The entry form (form/index.ts); null when it is not built in. */
    renderForm: RenderEntryForm | null;
    settings: LoreStudioSettings;
    saveSettings(): void;
    openClassic(book?: string): Promise<boolean>;
}

/** Id of the studio's Maestro window (also the id of its launcher tab in the «Maestro» window). */
export const LORE_STUDIO_WINDOW = 'loreStudio';

/**
 * The studio's window (plan-2 §10): non-modal, floating and large the first time (full screen on phones), hidden from
 * the window list (opened by studio.open(), the launchers and the Maestro menu). The assistant can stay open beside it.
 */
export function loreStudioWindow(studio: LoreStudio): MaestroWindowSpec {
    return {
        id: LORE_STUDIO_WINDOW,
        titleKey: 'm23.title',
        icon: 'fa-book-atlas',
        order: 200,
        hidden: true,
        defaultDock: 'float',
        defaultWidth: 1400,
        defaultHeight: 900,
        render: (container) => studio.mount(container),
        canClose: () => studio.canClose(),
    };
}

export type StudioView = 'library' | 'settings' | 'campaigns';
type Pane = 'books' | 'entries' | 'form';

const REFRESH_DELAY_MS = 30;
const FOCUS_CLASSES = ['maestro-m23-entry-search', 'maestro-m23-book-search'];

export class LoreStudio {
    private readonly app: App;
    private readonly dialogs: Dialogs;
    /** Localization jobs outlive the window: the book header draws them from here (plan-2 §8). */
    private readonly jobs: UserJobs;
    private jobsOff: Unsubscribe | null = null;
    /** The studio's body while its window is open (null: closed). */
    private root: HTMLElement | null = null;
    private main: HTMLElement | null = null;
    private columns: { books: HTMLElement; entries: HTMLElement; form: HTMLElement } | null = null;
    private view: StudioView = 'library';
    private pane: Pane = 'books';
    private book: string | null = null;
    private bookData: LoreBook | null = null;
    private booksModel: BooksModel | null = null;
    private formCleanup: Unsubscribe | null = null;
    private storeOff: Unsubscribe | null = null;
    private rolesOff: Unsubscribe | null = null;
    private refreshTimer: ReturnType<typeof setTimeout> | null = null;
    private dirtyAll = false;
    private dirtyBook = false;
    private renderToken = 0;
    /** The open form's «may I leave?» (unsaved edits); set through EntryFormContext.setLeaveGuard. */
    private leaveGuard: (() => Promise<boolean>) | null = null;
    private formToken = 0;
    /** Per opening: a close we already allowed (or forced) skips the guard in the window's canClose. */
    private closing: { allowed: boolean } | null = null;
    private readonly booksState: BooksState = {
        search: '',
        onlyActive: false,
        collapsed: new Set(['backup']),
        selected: null,
        bindingsOpen: false,
    };
    private readonly entriesState: EntriesState;

    constructor(private readonly deps: StudioDeps) {
        this.app = deps.app;
        this.dialogs = new Dialogs(deps.app);
        this.jobs = userJobs(deps.app);
        const sort = SORT_OPTIONS.some((option) => option.id === deps.settings.sort)
            ? deps.settings.sort
            : DEFAULT_SORT_ID;
        const size = (PAGE_SIZES as readonly number[]).includes(deps.settings.pageSize)
            ? deps.settings.pageSize
            : DEFAULT_PAGE_SIZE;
        this.entriesState = {
            search: '',
            sort,
            pageSize: size,
            page: 0,
            selected: new Set(),
            expanded: new Set(),
            scores: null,
            focusUid: null,
            openUid: null,
        };
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    isOpen(): boolean {
        return this.root !== null;
    }

    currentBook(): string | null {
        return this.book;
    }

    /** Opens the window (on a book and entry when given); a second call brings it forward and switches to them. */
    open(book?: string, uid?: number): void {
        const fresh = this.root === null;
        if (typeof this.app.ui.openWindow !== 'function') {
            this.deps.log.error('Maestro windows are not available; cannot open the Lore Studio');
            return;
        }
        // Mounts the body through mount() (the module's window spec) or brings the open window forward.
        this.app.ui.openWindow(LORE_STUDIO_WINDOW);
        if (!this.root) return;
        if (book && this.deps.store.books().includes(book)) {
            this.view = 'library';
            void this.selectBook(book).then((selected) => {
                if (selected && uid !== undefined) void this.openEntry(uid);
            });
            return;
        }
        if (!fresh) void this.render();
    }

    /** The window body (MaestroWindowSpec.render): the studio lives here until the window closes. */
    mount(container: HTMLElement): Unsubscribe {
        if (this.root) this.handleClosed();
        this.closing = { allowed: false };
        this.root = this.buildChrome();
        container.appendChild(this.root);
        this.storeOff = this.deps.store.onChange((changed) => this.scheduleRefresh(changed));
        this.jobsOff = this.jobs.on((_job, key) => {
            if (this.book !== null && key === bookJobKey(this.book)) this.updateJobSlot();
        });
        // M35 detects every book once (lazily, in the background); until then unknown books stay read-only.
        const roles = this.app.modules.api<BookRolesApi>('bookRoles');
        if (roles) {
            this.rolesOff = roles.onChange(() => this.scheduleRefresh(null));
            void roles.refresh().catch((error: unknown) => this.deps.log.warn('book roles refresh failed', error));
        }
        this.dirtyAll = true;
        void this.render();
        const root = this.root;
        return () => {
            if (this.root === root) this.handleClosed();
        };
    }

    /** The window's close guard (× , Escape): the open entry form may keep it open for unsaved edits. */
    canClose(): boolean | Promise<boolean> {
        if (!this.root || this.closing?.allowed) return true;
        // Nothing to ask (no open entry form): close at once.
        if (!this.leaveGuard || this.entriesState.openUid === null) return true;
        return this.canLeave();
    }

    /** True when nothing stops leaving the open entry (no form, no guard, or the form agreed). */
    private async canLeave(): Promise<boolean> {
        const guard = this.leaveGuard;
        if (!guard || this.entriesState.openUid === null) return true;
        try {
            return await guard();
        } catch (error) {
            this.deps.log.warn('entry form leave guard failed', error);
            return false;
        }
    }

    /** A close the user asked for («Классический редактор»): the form is asked first. */
    async requestClose(): Promise<boolean> {
        if (!this.root) return true;
        if (!(await this.canLeave())) return false;
        this.close();
        return true;
    }

    /** Closes without asking (module disable, or after the guard agreed). */
    close(): void {
        if (!this.root) return;
        if (this.closing) this.closing.allowed = true;
        this.app.ui.closeWindow?.(LORE_STUDIO_WINDOW);
        // No window manager (or the window is already gone): take the body down here.
        if (this.root) this.handleClosed();
    }

    dispose(): void {
        this.close();
    }

    private handleClosed(): void {
        this.closeForm(false);
        this.storeOff?.();
        this.storeOff = null;
        this.jobsOff?.();
        this.jobsOff = null;
        this.rolesOff?.();
        this.rolesOff = null;
        if (this.refreshTimer) clearTimeout(this.refreshTimer);
        this.refreshTimer = null;
        this.root?.remove();
        this.root = null;
        this.main = null;
        this.columns = null;
        this.closing = null;
    }

    /* ---------------------------------------------------------------- chrome and views */

    private buildChrome(): HTMLElement {
        this.main = el('div', { class: 'maestro-m23-main' });
        const nav = segmented<StudioView>({
            value: this.view,
            label: this.t('m23.nav.label'),
            options: [
                { value: 'library', label: this.t('m23.nav.library') },
                { value: 'settings', label: this.t('m23.nav.settings') },
                { value: 'campaigns', label: this.t('m23.nav.campaigns') },
            ],
            onChange: async (view) => {
                // Leaving the books view closes the entry form: ask it first.
                if (view !== 'library' && this.view === 'library' && !(await this.canLeave())) {
                    this.markNav();
                    return;
                }
                this.view = view;
                void this.render();
            },
        });
        // The window's header carries the title and the close button.
        return el('div', { class: 'maestro-m23 maestro-ui' }, [
            el('div', { class: 'maestro-m23-header' }, [
                nav,
                button({
                    icon: 'fa-book-open',
                    label: this.t('m23.classic'),
                    title: this.t('m23.classicHint'),
                    className: 'maestro-m23-classic',
                    onClick: () => this.openClassic(this.book ?? undefined),
                }),
            ]),
            this.main,
        ]);
    }

    /** The view switch follows programmatic view changes (a book opened from the campaigns view). */
    private markNav(): void {
        for (const node of this.root?.querySelectorAll<HTMLElement>('.maestro-m23-header .maestro-segment') ?? []) {
            const on = node.dataset.value === this.view;
            node.classList.toggle('maestro-on', on);
            node.setAttribute('aria-checked', on ? 'true' : 'false');
        }
    }

    private async render(): Promise<void> {
        const main = this.main;
        if (!main) return;
        this.markNav();
        const token = ++this.renderToken;
        // The form lives in the library layout: leaving it closes the form (its own cleanup saves pending input).
        if (this.view !== 'library') this.closeForm(false);
        if (this.view === 'settings') {
            const values = await this.deps.store.globalSettings();
            if (token !== this.renderToken || !this.main) return;
            this.columns = null;
            this.preserveFocus(main, () =>
                main.replaceChildren(
                    renderSettingsPanel(this.app, readWiSettings(values), {
                        change: async (key, value) => {
                            await this.dialogs.run(() => this.deps.store.setGlobalSettings({ [key]: value }));
                            void this.render();
                        },
                    }),
                ),
            );
            return;
        }
        if (this.view === 'campaigns') {
            const model = await this.campaignsModel();
            if (token !== this.renderToken || !this.main) return;
            this.columns = null;
            main.replaceChildren(renderCampaignsPanel(this.app, model, this.campaignActions()));
            return;
        }
        await this.renderLibrary(token);
    }

    private async renderLibrary(token: number): Promise<void> {
        const main = this.main;
        if (!main) return;
        if (this.dirtyAll || !this.booksModel) {
            this.dirtyAll = false;
            this.booksModel = await this.loadBooksModel();
            if (this.book && !this.booksModel.books.includes(this.book)) this.clearBook();
        }
        if (this.dirtyBook && this.book) {
            this.dirtyBook = false;
            this.bookData = await this.deps.store.load(this.book);
        }
        const entriesModel = this.book ? await this.loadEntriesModel(this.book) : null;
        if (token !== this.renderToken || !this.main || !this.booksModel) return;
        if (!this.columns) {
            this.columns = {
                books: el('div', { class: 'maestro-m23-col maestro-m23-col-books' }),
                entries: el('div', { class: 'maestro-m23-col maestro-m23-col-entries' }),
                form: el('div', { class: 'maestro-m23-col maestro-m23-col-form' }),
            };
            main.replaceChildren(
                el('div', { class: 'maestro-m23-layout' }, [
                    this.columns.books,
                    this.columns.entries,
                    this.columns.form,
                ]),
            );
        }
        const { books, entries, form } = this.columns;
        const layout = books.parentElement;
        if (layout) {
            layout.dataset.pane = this.pane;
            layout.classList.toggle('maestro-m23-with-form', this.entriesState.openUid !== null);
        }
        this.booksState.selected = this.book;
        const model = this.booksModel;
        this.preserveFocus(books, () =>
            books.replaceChildren(renderBooksPanel(this.app, model, this.booksState, this.bookActions())),
        );
        this.preserveFocus(entries, () =>
            entries.replaceChildren(
                entriesModel
                    ? renderEntriesPanel(this.app, entriesModel, this.entriesState, this.entryActions())
                    : el('div', { class: 'maestro-empty maestro-m23-pick', text: this.t('m23.entries.pickBook') }),
            ),
        );
        form.hidden = this.entriesState.openUid === null;
    }

    /** Re-rendering must not steal the cursor from a search box (refreshes arrive while typing). */
    private preserveFocus(container: HTMLElement, render: () => void): void {
        const active = document.activeElement;
        const key =
            active instanceof HTMLInputElement && container.contains(active)
                ? FOCUS_CLASSES.find((name) => active.classList.contains(name))
                : undefined;
        const start = key && active instanceof HTMLInputElement ? active.selectionStart : null;
        const end = key && active instanceof HTMLInputElement ? active.selectionEnd : null;
        render();
        if (!key) return;
        const next = container.querySelector<HTMLInputElement>(`.${key}`);
        if (!next) return;
        next.focus();
        if (start !== null && end !== null) {
            try {
                next.setSelectionRange(start, end);
            } catch {
                // type=search may refuse selection ranges in some engines
            }
        }
    }

    private scheduleRefresh(book: string | null): void {
        if (book === null) this.dirtyAll = true;
        else if (book === this.book) this.dirtyBook = true;
        else return;
        if (this.refreshTimer) return;
        this.refreshTimer = setTimeout(() => {
            this.refreshTimer = null;
            if (this.isOpen()) void this.render();
        }, REFRESH_DELAY_MS);
    }

    /* ---------------------------------------------------------------- models */

    private async loadBooksModel(): Promise<BooksModel> {
        const store = this.deps.store;
        const books = store.books();
        const hints = store.roleHints();
        const roles = new Map<string, ReturnType<LoreStoreService['roleOf']>>();
        const roleOf = (book: string) => {
            let role = roles.get(book);
            if (!role) {
                role = store.roleOf(book, hints);
                roles.set(book, role);
            }
            return role;
        };
        const bindings = await store.bindings();
        const reasons = await this.reasons(bindings);
        let canonBook: string | null = null;
        const canon = this.app.modules.api<CanonApi>('canon');
        if (canon && this.app.host.chatId()) {
            try {
                canonBook = canon.bookName();
            } catch {
                canonBook = null;
            }
        }
        const campaignOf = new Map<string, string>();
        if (store.des.present()) {
            for (const campaign of store.des.view(books, bindings.global).campaigns) {
                for (const book of campaign.books) campaignOf.set(book, campaign.name);
            }
        }
        return {
            books,
            roleOf,
            bindings,
            reasons,
            character: store.st.currentCharacter(),
            canonBook,
            campaignOf,
            groupChat: this.app.host.isGroupChat(),
            hasChat: !!this.app.host.chatId(),
            cardBook: store.cardBookName(),
        };
    }

    /** Why each book is active in this chat: M1's whyActive (DES, CK, canon included), else from the bindings. */
    private async reasons(bindings: BooksModel['bindings']): Promise<Map<string, string[]>> {
        const map = new Map<string, string[]>();
        const journal = this.app.modules.api<LoreJournalApi>('loreJournal');
        if (journal) {
            try {
                for (const row of await journal.whyActive()) map.set(row.book, [...row.reasons]);
                return map;
            } catch (error) {
                this.deps.log.debug('whyActive failed', error);
            }
        }
        const add = (book: string | null, reason: string) => {
            if (!book) return;
            const list = map.get(book) ?? [];
            if (!list.includes(reason)) list.push(reason);
            map.set(book, list);
        };
        for (const book of bindings.global) add(book, 'global');
        add(bindings.character.primary, 'character');
        for (const book of bindings.character.extra) add(book, 'characterExtra');
        add(bindings.chat, 'chat');
        add(bindings.persona, 'persona');
        return map;
    }

    private async loadEntriesModel(book: string): Promise<EntriesModel> {
        const store = this.deps.store;
        if (!this.bookData) this.bookData = await store.load(book);
        const model = this.booksModel;
        const canon = new Map<number, string[]>();
        const canonApi = this.app.modules.api<CanonApi>('canon');
        if (canonApi && this.app.host.chatId()) {
            try {
                for (const item of await canonApi.list()) {
                    const base = item.meta.base;
                    if (!base || base.world !== book) continue;
                    const list = canon.get(base.uid) ?? [];
                    if (!list.includes(item.meta.kind)) list.push(item.meta.kind);
                    canon.set(base.uid, list);
                }
            } catch (error) {
                this.deps.log.debug('canon list failed', error);
            }
        }
        const findings = new Map<number, number>();
        for (const finding of this.app.modules.api<DoctorApi>('doctor')?.findings() ?? []) {
            if (finding.target.book !== book) continue;
            const uids = Array.isArray(finding.target.uids) ? finding.target.uids : [finding.target.uid];
            for (const uid of uids) {
                if (typeof uid === 'number') findings.set(uid, (findings.get(uid) ?? 0) + 1);
            }
        }
        const lastSeen = new Map<number, number>();
        const turns = this.app.modules.api<LoreJournalApi>('loreJournal')?.turns() ?? [];
        for (let index = turns.length - 1; index >= 0; index--) {
            const turn = turns[index];
            if (!turn || turn.simulated || turn.messageIndex < 0) continue;
            for (const activation of turn.activations) {
                if (activation.world === book && !lastSeen.has(activation.uid))
                    lastSeen.set(activation.uid, turn.messageIndex);
            }
        }
        const workshop = store.des.present()
            ? Object.entries(store.des.workshop())
                  .filter(([, linked]) => linked === book)
                  .map(([npc]) => npc)
            : [];
        return {
            book,
            data: this.bookData,
            role: store.roleOf(book),
            canon,
            findings,
            lastSeen,
            reasons: model?.reasons.get(book) ?? [],
            campaign: model?.campaignOf.get(book) ?? null,
            workshop,
            targets: (model?.books ?? store.books()).filter(
                (name) => name !== book && !(model?.roleOf(name).readOnly ?? false),
            ),
            localizer: this.localizerApi() !== undefined,
            localizeJob: this.jobs.get(bookJobKey(book)),
        };
    }

    private async campaignsModel(): Promise<CampaignsModel> {
        const store = this.deps.store;
        const des = store.des;
        const active = (await store.bindings()).global;
        const view = des.view(store.books(), active);
        let unavailable: CampaignsModel['unavailable'] = null;
        if (!des.present()) unavailable = 'absent';
        else if (!(await des.ready())) unavailable = 'loading';
        return {
            unavailable,
            view,
            switching: des.isSwitching(),
            workshop: des.present() ? des.workshop() : {},
            active,
        };
    }

    /* ---------------------------------------------------------------- selection */

    private clearBook(): void {
        this.closeForm(false);
        this.book = null;
        this.bookData = null;
        this.pane = 'books';
    }

    /** Shows a book; false when the open entry form asked to stay (unsaved edits). */
    async selectBook(book: string | null): Promise<boolean> {
        if (book !== this.book) {
            if (!(await this.canLeave())) return false;
            this.closeForm(false);
            this.book = book;
            this.bookData = null;
            const state = this.entriesState;
            state.search = '';
            state.scores = null;
            state.page = 0;
            state.selected.clear();
            state.expanded.clear();
        }
        this.pane = book ? 'entries' : 'books';
        if (book) this.bookData = await this.deps.store.load(book);
        await this.render();
        return true;
    }

    /** Opens an entry in the form; false when the entry open now asked to stay. */
    async openEntry(uid: number): Promise<boolean> {
        if (!this.book || !this.columns) return false;
        if (this.entriesState.openUid !== null && !(await this.canLeave())) return false;
        if (!this.book || !this.columns) return false;
        this.closeForm(false);
        const form = this.columns.form;
        const role = this.deps.store.roleOf(this.book);
        this.entriesState.openUid = uid;
        this.pane = 'form';
        form.hidden = false;
        form.replaceChildren();
        const layout = form.parentElement;
        if (layout) {
            layout.dataset.pane = 'form';
            layout.classList.add('maestro-m23-with-form');
        }
        for (const row of this.columns.entries.querySelectorAll<HTMLElement>('.maestro-m23-entry')) {
            row.classList.toggle('maestro-on', row.dataset.uid === String(uid));
        }
        const render = this.deps.renderForm;
        if (!render) {
            form.append(el('div', { class: 'maestro-empty', text: this.t('m23.form.unavailable') }));
            return true;
        }
        const token = ++this.formToken;
        try {
            this.formCleanup = render(form, {
                app: this.app,
                store: this.deps.store,
                book: this.book,
                uid,
                role: role.info,
                readOnly: role.readOnly,
                onSaved: () => this.scheduleRefresh(this.book),
                // The form asks about unsaved edits itself before calling onClose.
                onClose: () => this.closeForm(true),
                setLeaveGuard: (guard) => {
                    if (token === this.formToken) this.leaveGuard = guard;
                },
            });
        } catch (error) {
            this.deps.log.error('entry form failed', error);
            form.replaceChildren(el('div', { class: 'maestro-empty', text: this.t('m23.form.failed') }));
        }
        return true;
    }

    private closeForm(render: boolean): void {
        const cleanup = this.formCleanup;
        this.formCleanup = null;
        if (cleanup) {
            try {
                cleanup();
            } catch (error) {
                this.deps.log.warn('entry form cleanup failed', error);
            }
        }
        this.leaveGuard = null;
        if (this.entriesState.openUid === null) return;
        this.entriesState.openUid = null;
        if (this.pane === 'form') this.pane = this.book ? 'entries' : 'books';
        if (this.columns) {
            this.columns.form.replaceChildren();
            this.columns.form.hidden = true;
        }
        if (render) void this.render();
    }

    private async openClassic(book?: string): Promise<void> {
        if (!(await this.requestClose())) return;
        const ok = await this.deps.openClassic(book);
        if (!ok) this.app.ui.notice(this.t('m23.error.classicUnavailable'), { urgent: true, level: 'warn' });
    }

    /* ---------------------------------------------------------------- actions: books */

    private reason(key: string, params: Record<string, string | number> = {}): SaveReason {
        return { module: 'user', summary: this.t(key, params) };
    }

    private async linksOf(book: string): Promise<BookLinks> {
        return bookLinks(await this.deps.store.linkState(), book);
    }

    private linksText(links: BookLinks): string {
        const parts: string[] = [];
        if (links.global) parts.push(this.t('m23.links.global'));
        if (links.primaryOf.length) parts.push(this.t('m23.links.primary', { names: links.primaryOf.join(', ') }));
        if (links.extraOf.length) parts.push(this.t('m23.links.extra', { names: links.extraOf.join(', ') }));
        if (links.personas.length) parts.push(this.t('m23.links.personas', { names: links.personas.join(', ') }));
        else if (links.currentPersona) parts.push(this.t('m23.links.persona'));
        if (links.chat) parts.push(this.t('m23.links.chat'));
        if (links.campaigns.length) parts.push(this.t('m23.links.campaigns', { names: links.campaigns.join(', ') }));
        if (links.workshop.length) parts.push(this.t('m23.links.workshop', { names: links.workshop.join(', ') }));
        return parts.join('; ');
    }

    private bookActions(): BooksActions {
        const store = this.deps.store;
        return {
            select: (book) => void this.selectBook(book),
            toggleGlobal: async (book, on) => {
                await this.dialogs.run(() => store.setGlobal(book, on));
            },
            create: async () => {
                const name = await this.dialogs.input(
                    this.t('m23.books.createTitle'),
                    freeBookName(this.t('m23.books.newName'), store.books()),
                );
                if (!name) return;
                const created = await this.dialogs.run(() => store.createBook(name));
                if (created) await this.selectBook(created);
            },
            importFile: async (file) => {
                const name = await this.dialogs.run(() => store.importBook(file));
                if (name) await this.selectBook(name);
                else if (name === '')
                    this.app.ui.notice(this.t('m23.books.notImported', { file: file.name }), { level: 'warn' });
            },
            setPrimary: async (name) => {
                await this.dialogs.run(() => store.setCharacterPrimary(name));
            },
            setExtra: async (names) => {
                await this.dialogs.run(() => store.setCharacterExtra(names));
            },
            setChat: async (name) => {
                await this.dialogs.run(() => store.setChatBook(name));
            },
            setPersona: async (name) => {
                await this.dialogs.run(() => store.setPersonaBook(name));
            },
            importCardBook: async () => {
                const name = store.cardBookName();
                if (!name) return;
                const exists = store.books().some((book) => book.toLowerCase() === name.toLowerCase());
                const body = exists ? this.t('m23.card.overwrite') : this.t('m23.card.importBody');
                if (!(await this.dialogs.confirm(this.t('m23.card.importTitle', { book: name }), body))) return;
                const imported = await this.dialogs.run(() => store.importCardBook());
                if (imported) {
                    this.dirtyAll = true;
                    await this.selectBook(imported);
                }
            },
            changed: () => void this.render(),
        };
    }

    /* ---------------------------------------------------------------- actions: entries */

    private entries(): Record<string, LoreEntry> {
        return this.bookData?.entries ?? {};
    }

    private entryActions(): EntriesActions {
        const store = this.deps.store;
        const state = this.entriesState;
        const book = (): string => this.book ?? '';
        const titleOf = (uid: number) => {
            const entry = this.entries()[String(uid)];
            const comment = typeof entry?.comment === 'string' ? entry.comment.trim() : '';
            return comment || this.t('m23.entries.untitled', { uid });
        };
        return {
            open: (uid) => void this.openEntry(uid),
            create: async () => {
                const uid = await this.dialogs.run(() => store.createEntry(book()));
                if (uid === undefined) return;
                state.focusUid = uid;
                this.bookData = await store.load(book());
                await this.render();
                await this.openEntry(uid);
            },
            duplicate: async (uid) => {
                const copy = await this.dialogs.run(() => store.duplicateEntry(book(), uid));
                if (copy === undefined) return;
                state.focusUid = copy;
                this.dirtyBook = true;
                await this.render();
            },
            remove: async (uids) => {
                const body =
                    uids.length === 1
                        ? this.t('m23.entries.deleteOne', { title: titleOf(uids[0] as number), uid: uids[0] as number })
                        : this.t('m23.entries.deleteMany', { count: uids.length });
                if (!(await this.dialogs.confirm(this.t('m23.entries.deleteTitle'), body, this.t('m23.dialog.delete'))))
                    return;
                const removed = await this.dialogs.run(() => store.deleteEntries(book(), uids));
                if (!removed) return;
                for (const uid of uids) state.selected.delete(uid);
                if (state.openUid !== null && uids.includes(state.openUid)) this.closeForm(false);
                this.dirtyBook = true;
                await this.render();
            },
            moveCopy: async (uids) => {
                const model = this.booksModel;
                const targets = (model?.books ?? store.books()).filter(
                    (name) => name !== book() && !(model?.roleOf(name).readOnly ?? false),
                );
                if (!targets.length) {
                    this.app.ui.notice(this.t('m23.move.noTargets'), { urgent: true, level: 'warn' });
                    return;
                }
                const form = moveTargetForm(this.app, targets);
                const title =
                    uids.length === 1
                        ? this.t('m23.move.titleOne', { title: titleOf(uids[0] as number) })
                        : this.t('m23.move.titleMany', { count: uids.length });
                const readOnly = store.isReadOnly(book());
                const choice = await this.dialogs.choose(
                    title,
                    form.content,
                    readOnly
                        ? [{ value: 'copy', label: this.t('m23.move.copy') }]
                        : [
                              { value: 'move', label: this.t('m23.move.move') },
                              { value: 'copy', label: this.t('m23.move.copy') },
                          ],
                );
                if (!choice) return;
                const target = form.read();
                const created = await this.dialogs.run(() =>
                    store.moveEntries(book(), uids, target, choice === 'copy'),
                );
                if (!created?.length) return;
                if (choice === 'move') {
                    for (const uid of uids) state.selected.delete(uid);
                    if (state.openUid !== null && uids.includes(state.openUid)) this.closeForm(false);
                }
                this.app.ui.notice(
                    this.t(choice === 'copy' ? 'm23.move.copied' : 'm23.move.moved', {
                        count: created.length,
                        book: target,
                    }),
                    { urgent: true },
                );
                this.dirtyBook = true;
                await this.render();
            },
            setDisabled: async (uids, disabled) => {
                await this.dialogs.run(() =>
                    store.patchEntries(
                        book(),
                        uids.map((uid) => ({ uid, patch: { disable: disabled } })),
                        this.reason(disabled ? 'm23.journal.disable' : 'm23.journal.enable', {
                            count: uids.length,
                            book: book(),
                        }),
                    ),
                );
            },
            setStatus: async (uid, status: EntryStatus) => {
                await this.dialogs.run(() =>
                    store.patchEntries(
                        book(),
                        [{ uid, patch: statusPatch(status) }],
                        this.reason('m23.journal.status', { uid, book: book() }),
                    ),
                );
            },
            reorder: async (pageOrder) => {
                const changes = reorderPage(pageOrder, this.entries());
                if (!changes.length) return;
                await this.dialogs.run(() =>
                    store.patchEntries(
                        book(),
                        changes.map((change) => ({ uid: change.uid, patch: { displayIndex: change.displayIndex } })),
                        this.reason('m23.journal.reorder', { book: book() }),
                    ),
                );
                this.dirtyBook = true;
                await this.render();
            },
            applyOrder: async (sorted) => {
                const form = applyOrderForm(this.app, sorted.length);
                if (!(await this.dialogs.form(this.t('m23.order.title'), form.content))) return;
                const options = form.read();
                if (options.error) {
                    this.app.ui.notice(this.t(`m23.order.invalid.${options.error}`), { urgent: true, level: 'error' });
                    return;
                }
                const changes = applyOrder(sorted, options);
                if (!changes.length) {
                    this.app.ui.notice(this.t('m23.order.upToDate'), { urgent: true });
                    return;
                }
                const done = await this.dialogs.run(() =>
                    store.patchEntries(
                        book(),
                        changes.map((change) => ({ uid: change.uid, patch: { order: change.order } })),
                        this.reason('m23.journal.applyOrder', { count: changes.length, book: book() }),
                    ),
                );
                if (done !== undefined)
                    this.app.ui.notice(this.t('m23.order.updated', { count: changes.length }), { urgent: true });
            },
            backfill: async () => {
                const changes = backfillComments(this.entries());
                if (!changes.length) {
                    this.app.ui.notice(this.t('m23.backfill.none'), { urgent: true });
                    return;
                }
                const done = await this.dialogs.run(() =>
                    store.patchEntries(
                        book(),
                        changes.map((change) => ({ uid: change.uid, patch: { comment: change.comment } })),
                        this.reason('m23.journal.backfill', { count: changes.length, book: book() }),
                    ),
                );
                if (done !== undefined)
                    this.app.ui.notice(this.t('m23.backfill.done', { count: changes.length }), { urgent: true });
            },
            bulkEdit: async (uids) => {
                const list = uids
                    .map((uid) => this.entries()[String(uid)])
                    .filter((entry): entry is LoreEntry => !!entry);
                if (!list.length) return;
                const form = bulkEditForm(this.app, list);
                if (!(await this.dialogs.form(this.t('m23.bulkEdit.title', { count: list.length }), form.content)))
                    return;
                const patch = form.read();
                if (!Object.keys(patch).length) return;
                await this.dialogs.run(() =>
                    store.patchEntries(
                        book(),
                        list.map((entry) => ({ uid: entry.uid, patch })),
                        this.reason('m23.journal.bulkEdit', { count: list.length, book: book() }),
                    ),
                );
            },
            search: (term) => void this.search(term),
            setSort: (id) => {
                state.sort = id;
                state.page = 0;
                this.deps.settings.sort = id;
                this.deps.saveSettings();
                void this.render();
            },
            setPageSize: (size) => {
                state.pageSize = size;
                state.page = 0;
                this.deps.settings.pageSize = size;
                this.deps.saveSettings();
                void this.render();
            },
            refresh: async () => {
                if (!this.book) return;
                await store.st.dropCache(this.book);
                this.bookData = await store.load(this.book);
                this.dirtyAll = true;
                await this.render();
            },
            renameBook: async () => {
                const current = book();
                const links = await this.linksOf(current);
                const hint = linkCount(links)
                    ? this.t('m23.book.renameLinks', { links: this.linksText(links) })
                    : undefined;
                const name = await this.dialogs.input(this.t('m23.book.renameTitle', { book: current }), current, hint);
                if (!name || name === current) return;
                const before = store.books();
                const done = await this.dialogs.run(async () => {
                    await store.renameBook(current, name);
                    return true;
                });
                if (!done) return;
                // The store sanitizes the name: find what was really created.
                const renamed = store.books().find((item) => !before.includes(item)) ?? null;
                this.dirtyAll = true;
                await this.selectBook(renamed);
            },
            duplicateBook: async () => {
                const current = book();
                const name = await this.dialogs.input(
                    this.t('m23.book.duplicateTitle', { book: current }),
                    freeBookName(current, store.books()),
                );
                if (!name) return;
                const before = store.books();
                const done = await this.dialogs.run(async () => {
                    await store.duplicateBook(current, name);
                    return true;
                });
                if (!done) return;
                this.dirtyAll = true;
                const copy = store.books().find((item) => !before.includes(item));
                await this.selectBook(copy ?? current);
            },
            exportBook: async () => {
                await this.dialogs.run(() => store.exportBook(book()));
            },
            localizeBook: async () => {
                const current = book();
                const api = this.localizerApi();
                if (!api) return;
                // The strip already stands in for the button; a stale button (another render) must not start a twin.
                if (this.jobs.get(bookJobKey(current))?.state === 'active') {
                    this.updateJobSlot();
                    return;
                }
                const uids = Object.values(this.bookData?.entries ?? {})
                    .map((entry) => Number(entry.uid))
                    .filter((uid) => Number.isInteger(uid));
                if (!uids.length) return;
                if (await this.isProtected(api, current)) {
                    this.app.ui.notice(this.t('m23.book.localizeProtected'), { urgent: true, level: 'warn' });
                    return;
                }
                const body = el('p', { text: this.t('m23.book.localizeBody', { book: current, count: uids.length }) });
                if (!(await this.dialogs.confirm(this.t('m23.book.localize'), body, this.t('m23.book.localizeRun'))))
                    return;
                this.startLocalize(current, uids);
            },
            renderLocalizeJob: (job) => this.renderLocalizeJob(job),
            deleteBook: async () => {
                const current = book();
                const links = await this.linksOf(current);
                const body = el('div', {}, [
                    el('p', { text: this.t('m23.book.deleteBody', { book: current }) }),
                    linkCount(links)
                        ? el('p', {
                              class: 'maestro-warn-text',
                              text: this.t('m23.book.deleteLinks', { links: this.linksText(links) }),
                          })
                        : null,
                    el('p', { class: 'maestro-muted', text: this.t('m23.book.deleteUndo') }),
                ]);
                if (!(await this.dialogs.confirm(this.t('m23.book.deleteTitle'), body, this.t('m23.dialog.delete'))))
                    return;
                const done = await this.dialogs.run(async () => {
                    await store.deleteBook(current);
                    return true;
                });
                if (!done) return;
                this.clearBook();
                this.dirtyAll = true;
                await this.render();
            },
            openClassic: () => void this.openClassic(book()),
            back: () => {
                this.pane = 'books';
                void this.render();
            },
        };
    }

    /** ST's own fuzzy search (power-user.js) for exact parity; a plain search with Fuse's operators otherwise. */
    private async search(term: string): Promise<void> {
        const state = this.entriesState;
        state.search = term;
        state.page = 0;
        if (!term.trim()) {
            state.scores = null;
            await this.render();
            return;
        }
        const entries = Object.values(this.entries());
        let scores: Map<number, number> | null = null;
        try {
            const power = await this.app.host.modules.load('/scripts/power-user.js');
            const fuzzy = power.fuzzySearchWorldInfo;
            if (typeof fuzzy === 'function') {
                const results = (
                    fuzzy as (data: unknown[], value: string) => { item?: { uid?: unknown }; score?: number }[]
                )(entries, term);
                scores = new Map();
                for (const result of results) {
                    const uid = Number(result.item?.uid);
                    if (Number.isFinite(uid)) scores.set(uid, typeof result.score === 'number' ? result.score : 0);
                }
            }
        } catch (error) {
            this.deps.log.debug('ST fuzzy search unavailable', error);
        }
        if (state.search !== term) return;
        state.scores = scores ?? plainSearch(entries, term);
        await this.render();
    }

    /* ---------------------------------------------------------------- actions: DES campaigns */

    private campaignActions(): CampaignsActions {
        const des = this.deps.store.des;
        const rerender = async () => {
            this.dirtyAll = true;
            await this.render();
        };
        const run = async (action: () => unknown) => {
            await this.dialogs.run(async () => {
                await action();
            });
            await rerender();
        };
        const view = () => des.view(this.deps.store.books(), this.booksModel?.bindings.global ?? []);
        return {
            create: async () => {
                const name = await this.dialogs.input(this.t('m23.des.createTitle'), '');
                if (name) await run(() => des.createCampaign(name));
            },
            rename: async (id) => {
                const campaign = view().campaigns.find((item) => item.id === id);
                const name = await this.dialogs.input(this.t('m23.des.renameTitle'), campaign?.name ?? '');
                if (name) await run(() => des.renameCampaign(id, name));
            },
            remove: async (id) => {
                const campaign = view().campaigns.find((item) => item.id === id);
                if (!campaign) return;
                const body = campaign.active
                    ? this.t('m23.des.deleteActive', { name: campaign.name })
                    : this.t('m23.des.deleteBody', { name: campaign.name });
                if (!(await this.dialogs.confirm(this.t('m23.des.deleteTitle'), body, this.t('m23.dialog.delete'))))
                    return;
                await run(() => des.deleteCampaign(id));
            },
            setIcon: (id, name) => run(() => des.setIcon(id, name)),
            setColor: (id, color) => run(() => des.setColor(id, color)),
            move: (id, delta) =>
                run(() =>
                    des.reorder(
                        moveCampaign(
                            view().campaigns.map((item) => item.id),
                            id,
                            delta,
                        ),
                    ),
                ),
            activate: (id) => run(() => des.setActive(id)),
            toggleCollapsed: (id) => run(() => des.toggleCollapsed(id)),
            moveBook: (book, toId) => run(() => des.moveBook(book, toId)),
            toggleDesGlobal: (book) => run(() => des.toggleGlobal(book)),
            setActive: async (book, on) => {
                const library = view();
                const inActive = library.campaigns.some((campaign) => campaign.active && campaign.books.includes(book));
                if (!on && (inActive || library.autoLinked.includes(book))) {
                    this.app.ui.notice(this.t('m23.des.manualOffHint', { book }), { urgent: true, level: 'warn' });
                }
                await run(() => this.deps.store.setGlobal(book, on));
            },
            setAutoLink: async (on) => {
                if (!this.deps.settings.autoLinkAsked) {
                    const ok = await this.dialogs.confirm(
                        this.t('m23.des.autoLinkTitle'),
                        this.t('m23.des.autoLinkExplain'),
                    );
                    this.deps.settings.autoLinkAsked = true;
                    this.deps.saveSettings();
                    if (!ok) {
                        await rerender();
                        return;
                    }
                }
                await run(() => des.setAutoLink(on));
            },
            openBook: (book) => {
                this.view = 'library';
                void this.selectBook(book);
            },
        };
    }

    /* ---------------------------------------------------------------- localization jobs (plan-2 §8) */

    private async isProtected(api: LocalizerApi, book: string): Promise<boolean> {
        if (typeof api.isProtectedBook !== 'function') return false;
        try {
            return await api.isProtectedBook(book);
        } catch (error) {
            this.deps.log.debug('isProtectedBook failed', error);
            return false;
        }
    }

    /** Starts Russian keys for these entries of a book as a user job; the work goes on after the studio closes. */
    private startLocalize(book: string, uids: number[]): void {
        const api = this.localizerApi();
        if (!api || !uids.length) return;
        const entries = this.book === book ? this.entries() : {};
        const titles: Record<number, string> = {};
        for (const uid of uids) {
            const entry = entries[String(uid)];
            const comment = typeof entry?.comment === 'string' ? (entry.comment.trim().split('\n')[0] ?? '') : '';
            titles[uid] = comment || this.t('m23.entries.untitled', { uid });
        }
        startLocalizeJob({
            app: this.app,
            jobs: this.jobs,
            api,
            scope: 'book',
            book,
            uids,
            titles,
            visible: () => this.isOpen() && this.view === 'library' && this.book === book,
            open: () => {
                this.app.ui.closePult?.();
                this.open(book);
            },
            afterRun: (name) => this.afterLocalize(name),
        });
        this.updateJobSlot();
    }

    /** The Localizer wrote the book: forget ST's cached copy and show the new keys if the book is on screen. */
    private async afterLocalize(book: string): Promise<void> {
        await this.deps.store.st.dropCache(book);
        if (!this.isOpen() || this.book !== book) return;
        this.bookData = await this.deps.store.load(book);
        this.dirtyAll = true;
        await this.render();
    }

    private renderLocalizeJob(job: UserJobInfo): HTMLElement {
        const book = this.book ?? '';
        return renderJobStrip(this.app, job, {
            stop: () => {
                this.jobs.cancel(job.key);
            },
            retry: (uids) => this.startLocalize(book, uids),
            dismiss: () => this.jobs.dismiss(job.key),
        });
    }

    /** Redraws the strip in place (no list re-render: progress ticks must not reset the scroll). */
    private updateJobSlot(): void {
        const panel = this.columns?.entries;
        if (!panel || !this.book) return;
        const job = this.jobs.get(bookJobKey(this.book));
        panel.querySelector('.maestro-m23-job-slot')?.replaceChildren(...(job ? [this.renderLocalizeJob(job)] : []));
        const trigger = panel.querySelector<HTMLElement>('.maestro-m23-localize');
        if (trigger) trigger.hidden = job !== undefined;
    }

    /** Lorebook Localizer's API (0.2+), when the adapter is there and sees it. */
    private localizerApi(): LocalizerApi | undefined {
        try {
            return adaptersOf(this.deps.app)?.localizer?.api();
        } catch {
            return undefined;
        }
    }

    /** Test helper: the entries currently listed (filtered and sorted). */
    listedEntries(): LoreEntry[] {
        if (!this.book || !this.bookData) return [];
        return visibleEntries(
            {
                book: this.book,
                data: this.bookData,
                role: this.deps.store.roleOf(this.book),
                canon: new Map(),
                findings: new Map(),
                lastSeen: new Map(),
                reasons: [],
                campaign: null,
                workshop: [],
                targets: [],
            },
            this.entriesState,
        );
    }
}
