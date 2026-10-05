// The Lore Studio entry form (M23 stage 2): loads one entry through the LoreStore, edits a working copy with ST 1.19
// semantics, saves only the changed fields (SaveReason M23), guards unsaved edits, follows outside changes, and can
// open another entry in its place (canon override ↔ base) with «Назад». Read-only books (BunnyMo, P13) render every
// control disabled. Nothing is normalised on open: values stay as stored (research/parity-lore.md «трудные места» 5).
import { TYPED_FIELDS_KEY, readTypedMeta, sameTypedMeta } from '../../../domain/entry-types';
import type { TypedEntryMeta } from '../../../domain/entry-types';
import { cloneJson, entryPatch, sameValue, stEditorDifferences } from '../../../domain/lore-form-fields';
import type { App, Unsubscribe } from '../../../shared/contracts';
import { badge, banner, emptyState } from '../../../ui/components/card';
import { button, el } from '../../../ui/components/dom';
import type { BookRoleInfo } from '../../bookRoles/api';
import type { EntryFormContext } from '../form-api';
import { canonMetaOf, canonSection } from './canon-panel';
import { contentSection } from './content';
import { disableAll, showFieldError } from './controls';
import { RULES_TAB_ID, bookRolesApi, canonApi, entryLabel } from './env';
import type { FormEnv, FormState, StatusLevel, TypedStorage } from './env';
import {
    activationSection,
    enabledToggle,
    groupsSection,
    passportSection,
    placementSection,
    serviceSection,
    sourcesSection,
    stFixButton,
    timersSection,
} from './fields';
import { filtersSection } from './filters';
import { historySection } from './history';
import { insightsSection, testerSection } from './insights';
import { keysSection } from './keys';
import { ENTRY_FORM_CSS } from './style';
import { ENTRY_FORM_STRINGS } from './strings';

interface Navigation {
    navigate(book: string, uid: number): void;
    /** «Назад» to the previous entry; null for the first form (it closes instead). */
    back: (() => void) | null;
}

/* ------------------------------------------------------------------ stylesheet shared by nested forms */

const styleUsers = new WeakMap<App, { users: number; remove: Unsubscribe | null }>();

/** One stylesheet per App while at least one form is open (forms can be nested or shown side by side). */
function acquireStyle(app: App): Unsubscribe {
    let slot = styleUsers.get(app);
    if (!slot) {
        slot = { users: 0, remove: null };
        styleUsers.set(app, slot);
    }
    if (slot.users++ === 0) {
        try {
            slot.remove = app.ui.style('maestro-m23f', ENTRY_FORM_CSS);
        } catch {
            slot.remove = null;
        }
    }
    const owned = slot;
    let released = false;
    return () => {
        if (released) return;
        released = true;
        owned.users -= 1;
        if (owned.users === 0) {
            owned.remove?.();
            owned.remove = null;
        }
    };
}

/* ------------------------------------------------------------------ one form */

export class EntryForm {
    readonly root: HTMLElement;
    readonly env: FormEnv;
    private state: FormState | null = null;
    private readonly role: BookRoleInfo | undefined;
    private readonly readOnly: boolean;
    private scope: (() => void)[] = [];
    private readonly life: (() => void)[] = [];
    private syncs: (() => void)[] = [];
    private readonly errors = new Map<string, string>();
    private saving = false;
    private reloading = false;
    private alive = true;
    private loaded = false;
    private statusText = '';
    private statusLevel: StatusLevel = 'info';
    private chrome: {
        title: HTMLElement;
        dirty: HTMLElement;
        status: HTMLElement;
        save: HTMLButtonElement | null;
        revert: HTMLButtonElement | null;
        errors: HTMLElement;
        external: HTMLElement;
        badges: HTMLElement;
    } | null = null;

    constructor(
        container: HTMLElement,
        private readonly ctx: EntryFormContext,
        private readonly nav: Navigation,
    ) {
        this.role = ctx.role ?? bookRolesApi(ctx.app)?.roleOf(ctx.book);
        this.readOnly = ctx.readOnly || this.role?.readOnly === true;
        this.root = el('div', {
            class: ['maestro-m23f', this.readOnly ? 'maestro-m23f-readonly' : null],
            data: { book: ctx.book, uid: ctx.uid },
        });
        this.root.addEventListener('keydown', (event) => this.onKey(event));
        container.appendChild(this.root);
        const currentState = (): FormState => {
            if (!this.state) throw new Error('entry form: no state');
            return this.state;
        };
        this.env = {
            app: ctx.app,
            ctx,
            t: (key, params) => ctx.app.i18n.t(key, params),
            readOnly: this.readOnly,
            role: this.role,
            // A getter: section handlers always see the state of the latest load.
            get state(): FormState {
                return currentState();
            },
            own: (dispose) => {
                this.scope.push(dispose);
            },
            changed: () => this.onChanged(),
            sync: (run) => {
                this.syncs.push(run);
            },
            setError: (field, message) => this.setError(field, message),
            navigate: (book, uid) => nav.navigate(book, uid),
            reload: () => this.reload(),
            isDirty: () => this.isDirty(),
            status: (text, level) => this.setStatus(text, level ?? 'info'),
            hold: async <T>(job: () => Promise<T>): Promise<T> => {
                // Our own write: WORLDINFO_UPDATED of it is not an outside change (onExternalChange skips while saving).
                const was = this.saving;
                this.saving = true;
                this.refreshChrome();
                try {
                    return await job();
                } finally {
                    this.saving = was;
                    this.refreshChrome();
                }
            },
        };
        try {
            this.life.push(
                ctx.store.onChange((book) => {
                    if (book === null || book === ctx.book) void this.onExternalChange();
                }),
            );
        } catch (error) {
            ctx.app.log.debug('store onChange failed', error);
        }
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.ctx.app.i18n.t(key, params);
    }

    async start(): Promise<void> {
        this.root.replaceChildren(el('div', { class: 'maestro-m23f-hint', text: this.t('m23f.loading') }));
        await this.reload();
    }

    /* ---------------------------------------------------------------- data */

    private async load(): Promise<FormState | null> {
        const { store, book, uid, app } = this.ctx;
        const data = await store.load(book);
        const entry = data?.entries?.[String(uid)];
        if (!data || !entry) return null;
        let globals = {};
        try {
            globals = await store.globalSettings();
        } catch (error) {
            app.log.debug('global WI settings unavailable', error);
        }
        const canon = canonApi(app);
        let canonBook: string | null = null;
        if (canon) {
            try {
                canonBook = app.host.chatId() ? canon.bookName() : null;
            } catch {
                canonBook = null;
            }
        }
        const isCanonEntry =
            this.role?.role === 'canon' || (canonBook !== null && book === canonBook) || canonMetaOf(entry) !== null;
        const roles = bookRolesApi(app);
        const extensions = entry.extensions as Record<string, unknown> | undefined;
        let typedStorage: TypedStorage;
        let typedStored: TypedEntryMeta | null;
        let sidecar: Record<string, unknown> | undefined;
        if (isCanonEntry || this.role?.role === 'maestro') {
            typedStorage = 'entry';
            typedStored = readTypedMeta(extensions?.maestro);
        } else if (roles) {
            typedStorage = 'sidecar';
            try {
                // The sync read returns nothing until the roles module knows the book's content hashes.
                sidecar = roles.loadEntryMeta
                    ? await roles.loadEntryMeta<Record<string, unknown>>(book, uid)
                    : roles.entryMeta<Record<string, unknown>>(book, uid);
            } catch {
                sidecar = undefined;
            }
            typedStored = readTypedMeta(sidecar);
        } else {
            typedStorage = 'none';
            typedStored = readTypedMeta(extensions?.maestro);
        }
        return {
            data,
            stored: cloneJson(entry),
            draft: cloneJson(entry),
            globals,
            typedStorage,
            typedStored,
            typed: typedStored ? cloneJson(typedStored) : null,
            sidecar,
            canonBook,
            isCanonEntry,
        };
    }

    async reload(): Promise<void> {
        this.reloading = true;
        let state: FormState | null = null;
        let failed: unknown = null;
        try {
            state = await this.load();
        } catch (error) {
            failed = error;
        } finally {
            this.reloading = false;
        }
        if (!this.alive) return;
        if (failed) {
            this.ctx.app.log.warn('entry form load failed', failed);
            this.state = null;
            this.buildMessage(
                this.t('m23f.loadFailed', { error: failed instanceof Error ? failed.message : String(failed) }),
            );
            return;
        }
        this.state = state;
        this.loaded = true;
        this.build();
    }

    isDirty(): boolean {
        const state = this.state;
        if (!state || this.readOnly) return false;
        if (!sameValue(state.stored, state.draft)) return true;
        return state.typedStorage === 'sidecar' && !sameTypedMeta(state.typed, state.typedStored);
    }

    hasErrors(): boolean {
        return this.errors.size > 0;
    }

    /* ---------------------------------------------------------------- build */

    private disposeScope(): void {
        for (const dispose of this.scope.splice(0)) {
            try {
                dispose();
            } catch (error) {
                this.ctx.app.log.debug('entry form dispose', error);
            }
        }
        this.syncs = [];
        this.chrome = null;
    }

    private buildMessage(text: string): void {
        this.disposeScope();
        this.root.replaceChildren(
            emptyState(text, 'fa-circle-question'),
            el('div', { class: 'maestro-m23f-actions' }, [this.closeButton()]),
        );
    }

    private closeButton(): HTMLButtonElement {
        const back = this.nav.back;
        return button({
            label: back ? this.t('m23f.back') : this.t('m23f.close'),
            icon: back ? 'fa-arrow-left' : 'fa-xmark',
            kind: 'ghost',
            onClick: () => this.close(),
        });
    }

    private build(): void {
        this.disposeScope();
        this.errors.clear();
        const state = this.state;
        if (!state) {
            this.buildMessage(this.t('m23f.notFound', { book: this.ctx.book, uid: this.ctx.uid }));
            return;
        }
        const env = this.env;
        const header = this.header();
        const banners = this.banners(state);
        const edit = el('fieldset', { class: 'maestro-m23f-edit' }, [
            el('legend', { class: 'maestro-sr-only', text: this.t('m23f.legend') }),
            el('div', { class: 'maestro-m23f-quick' }, [enabledToggle(env)]),
            keysSection(env),
            contentSection(env),
            placementSection(env),
            activationSection(env),
            timersSection(env),
            groupsSection(env),
            filtersSection(env),
            sourcesSection(env),
            serviceSection(env),
            passportSection(env),
        ]);
        if (this.readOnly) {
            edit.disabled = true;
            disableAll(edit);
        }
        const extra = [canonSection(env), insightsSection(env), testerSection(env), historySection(env)].filter(
            (node): node is HTMLElement => node !== null,
        );
        this.root.replaceChildren(header, ...banners, edit, ...extra);
        this.refreshChrome();
    }

    private header(): HTMLElement {
        const t = this.t.bind(this);
        const title = el('h3', { class: 'maestro-m23f-title' });
        const dirty = el('span', { class: 'maestro-m23f-dirty', text: t('m23f.dirty'), attrs: { role: 'status' } });
        const status = el('span', { class: 'maestro-m23f-status', attrs: { 'aria-live': 'polite' } });
        const badges = el('div', { class: 'maestro-m23f-badges' });
        const save = this.readOnly
            ? null
            : button({
                  label: t('m23f.save'),
                  icon: 'fa-floppy-disk',
                  kind: 'primary',
                  title: t('m23f.saveHint'),
                  onClick: async () => {
                      await this.save();
                  },
              });
        const revert = this.readOnly
            ? null
            : button({
                  label: t('m23f.revert'),
                  icon: 'fa-rotate-left',
                  kind: 'ghost',
                  onClick: () => this.revert(),
              });
        const errors = el('div', { class: 'maestro-m23f-errors' });
        const external = el('div', { class: 'maestro-m23f-external' });
        this.chrome = { title, dirty, status, save, revert, errors, external, badges };
        return el('header', { class: 'maestro-m23f-head' }, [
            el('div', { class: 'maestro-m23f-head-row' }, [this.closeButton(), title, dirty]),
            el('div', { class: 'maestro-m23f-head-meta' }, [
                el('span', { class: 'maestro-m23f-book', text: this.ctx.book }),
                el('span', { class: 'maestro-m23f-uid', text: t('m23f.uid', { uid: this.ctx.uid }) }),
                badges,
            ]),
            el('div', { class: 'maestro-m23f-toolbar' }, [save, revert, status]),
            errors,
            external,
        ]);
    }

    private banners(state: FormState): HTMLElement[] {
        const t = this.t.bind(this);
        const list: HTMLElement[] = [];
        const role = this.role?.role;
        if (this.readOnly) {
            const bunny = role === 'bunnymo.core' || role === 'bunnymo.pack';
            const node = banner(t(bunny ? 'm23f.ro.bunnymo' : 'm23f.ro.generic'), 'info', 'fa-lock');
            node.classList.add('maestro-m23f-ro');
            if (bunny) {
                node.append(
                    button({
                        label: t('m23f.ro.openRules'),
                        icon: 'fa-wand-magic-sparkles',
                        kind: 'ghost',
                        onClick: () => this.ctx.app.ui.openPult(RULES_TAB_ID),
                    }),
                );
            }
            list.push(node);
        }
        const engine = stEditorDifferences(state.stored).filter((item) => item.engine);
        if (engine.length) {
            const node = banner(t('m23f.st.banner', { fields: engine.map((item) => item.field).join(', ') }), 'warn');
            const fix = engine.some((item) => item.field === 'selective' || item.field === 'useProbability')
                ? stFixButton(this.env)
                : null;
            if (fix) node.append(fix);
            list.push(node);
        }
        return list;
    }

    private refreshChrome(): void {
        const chrome = this.chrome;
        const state = this.state;
        if (!chrome || !state) return;
        const t = this.t.bind(this);
        chrome.title.textContent = entryLabel(state.draft);
        const dirty = this.isDirty();
        chrome.dirty.hidden = !dirty;
        this.root.classList.toggle('maestro-m23f-is-dirty', dirty);
        if (chrome.save) chrome.save.disabled = !dirty || this.errors.size > 0 || this.saving;
        if (chrome.revert) chrome.revert.disabled = !dirty || this.saving;
        chrome.status.textContent = this.statusText;
        chrome.status.className = `maestro-m23f-status maestro-m23f-status-${this.statusLevel}`;
        const draft = state.draft;
        const badges: HTMLElement[] = [];
        if (draft.disable === true) badges.push(badge(t('m23f.badge.disabled'), 'muted'));
        if (draft.constant === true) badges.push(badge(t('m23f.state.constant'), 'info'));
        else if (draft.vectorized === true) badges.push(badge(t('m23f.state.vectorized'), 'info'));
        if (this.role) badges.push(badge(t(`m23f.role.${this.role.role}`), 'muted'));
        if (state.isCanonEntry) {
            const meta = canonMetaOf(state.stored);
            if (meta?.status === 'provisional') badges.push(badge(t('m23f.canon.status.provisional'), 'warn'));
        }
        if (this.readOnly) badges.push(badge(t('m23f.badge.readOnly'), 'muted'));
        chrome.badges.replaceChildren(...badges);
        if (this.errors.size) {
            chrome.errors.replaceChildren(
                banner(t('m23f.save.fixErrors', { fields: [...this.errors.keys()].join(', ') }), 'error'),
            );
        } else {
            chrome.errors.replaceChildren();
        }
    }

    /* ---------------------------------------------------------------- changes */

    private onChanged(): void {
        for (const run of [...this.syncs]) {
            try {
                run();
            } catch (error) {
                this.ctx.app.log.debug('entry form sync', error);
            }
        }
        if (this.statusLevel === 'ok') this.statusText = '';
        this.refreshChrome();
    }

    private setError(field: string, message: string | null): void {
        if (message) this.errors.set(field, message);
        else this.errors.delete(field);
        showFieldError(this.env, field, message);
        this.refreshChrome();
    }

    private setStatus(text: string, level: StatusLevel): void {
        this.statusText = text;
        this.statusLevel = level;
        this.refreshChrome();
    }

    private revert(): void {
        const state = this.state;
        if (!state) return;
        state.draft = cloneJson(state.stored);
        state.typed = state.typedStored ? cloneJson(state.typedStored) : null;
        this.build();
        this.setStatus(this.t('m23f.reverted'), 'info');
    }

    /* ---------------------------------------------------------------- save */

    private sidecarRecord(state: FormState): Record<string, unknown> | undefined {
        const record: Record<string, unknown> = { ...(state.sidecar ?? {}) };
        if (state.typed) {
            record.type = state.typed.type;
            record[TYPED_FIELDS_KEY] = { ...state.typed.fields };
        } else {
            delete record.type;
            delete record[TYPED_FIELDS_KEY];
        }
        return Object.keys(record).length ? record : undefined;
    }

    async save(): Promise<boolean> {
        const state = this.state;
        if (this.readOnly || this.saving || !state) return false;
        const t = this.t.bind(this);
        if (this.errors.size) {
            this.setStatus(t('m23f.save.blocked'), 'error');
            this.root.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus();
            return false;
        }
        const { store, book, uid, app } = this.ctx;
        const patch = entryPatch(state.stored, state.draft);
        const fields = Object.keys(patch);
        const sidecarChanged = state.typedStorage === 'sidecar' && !sameTypedMeta(state.typed, state.typedStored);
        if (!fields.length && !sidecarChanged) {
            this.setStatus(t('m23f.save.nothing'), 'info');
            return true;
        }
        this.saving = true;
        this.setStatus(t('m23f.save.saving'), 'info');
        try {
            if (fields.length) {
                await store.updateEntry(book, uid, patch, {
                    module: 'M23',
                    summary: t('m23f.save.summary', {
                        entry: entryLabel(state.draft),
                        book,
                        fields: fields.join(', '),
                    }),
                });
            }
            // The sidecar is bound to the content hash: a content edit made here by the user keeps the type valid, so
            // the record is written again after the entry (written first, so the new hash is the one bound).
            // The same holds for a passport kept there (M28): the section shows it was made for the older text.
            const keeps = state.typedStored !== null || state.sidecar?.passport !== undefined;
            const rebind = state.typedStorage === 'sidecar' && keeps && 'content' in patch;
            if (sidecarChanged || rebind) {
                const roles = bookRolesApi(app);
                if (!roles) throw new Error(t('m23f.typed.unavailable'));
                await roles.setEntryMeta(book, uid, this.sidecarRecord(state));
            }
            await this.reload();
        } catch (error) {
            this.saving = false;
            this.setStatus(
                t('m23f.save.failed', { error: error instanceof Error ? error.message : String(error) }),
                'error',
            );
            return false;
        }
        this.saving = false;
        if (!this.alive) return true;
        this.setStatus(t('m23f.save.done'), 'ok');
        try {
            this.ctx.onSaved();
        } catch (error) {
            app.log.debug('onSaved failed', error);
        }
        return true;
    }

    /* ---------------------------------------------------------------- outside changes */

    private async onExternalChange(): Promise<void> {
        if (this.saving || this.reloading || !this.alive || !this.loaded) return;
        const { store, book, uid } = this.ctx;
        let entry: unknown;
        try {
            entry = (await store.load(book))?.entries?.[String(uid)];
        } catch {
            return;
        }
        if (!this.alive || this.saving || this.reloading) return;
        const state = this.state;
        // Echo of our own save, or a change of another entry of the book.
        if (state && entry && sameValue(entry, state.stored)) return;
        if (!this.isDirty()) {
            await this.reload();
            this.setStatus(this.t(entry ? 'm23f.external.reloaded' : 'm23f.external.gone'), 'info');
            return;
        }
        const chrome = this.chrome;
        if (!chrome) return;
        const node = banner(this.t('m23f.external.changed'), 'warn', 'fa-arrows-rotate');
        node.append(
            button({
                label: this.t('m23f.external.reload'),
                kind: 'ghost',
                onClick: async () => {
                    await this.reload();
                },
            }),
        );
        chrome.external.replaceChildren(node);
    }

    /* ---------------------------------------------------------------- leaving */

    async confirmLeave(): Promise<boolean> {
        if (!this.isDirty()) return true;
        return this.ctx.app.ui.confirm(this.t('m23f.discard.title'), this.t('m23f.discard.body'));
    }

    async close(): Promise<void> {
        if (!(await this.confirmLeave())) return;
        if (this.nav.back) this.nav.back();
        else this.ctx.onClose();
    }

    private onKey(event: KeyboardEvent): void {
        const mod = event.ctrlKey || event.metaKey;
        if (!mod) return;
        if (event.key.toLowerCase() === 's' || event.key === 'Enter') {
            event.preventDefault();
            event.stopPropagation();
            if (!this.readOnly) void this.save();
        }
    }

    dispose(): void {
        if (!this.alive) return;
        this.alive = false;
        this.disposeScope();
        for (const dispose of this.life.splice(0)) {
            try {
                dispose();
            } catch (error) {
                this.ctx.app.log.debug('entry form dispose', error);
            }
        }
        this.root.remove();
    }
}

/* ------------------------------------------------------------------ host: base ↔ canon navigation */

class FormHost {
    private readonly stack: EntryFormContext[];
    private current: EntryForm | null = null;
    private disposed = false;
    private readonly releaseStyle: Unsubscribe;

    constructor(
        private readonly container: HTMLElement,
        private readonly rootCtx: EntryFormContext,
    ) {
        this.stack = [rootCtx];
        this.releaseStyle = acquireStyle(rootCtx.app);
    }

    form(): EntryForm | null {
        return this.current;
    }

    mount(): void {
        if (this.disposed) return;
        const ctx = this.stack[this.stack.length - 1] ?? this.rootCtx;
        const nested = this.stack.length > 1;
        this.current = new EntryForm(this.container, ctx, {
            navigate: (book, uid) => void this.navigate(book, uid),
            back: nested ? () => this.back() : null,
        });
        void this.current.start();
    }

    async navigate(book: string, uid: number): Promise<void> {
        if (this.disposed) return;
        if (this.current && !(await this.current.confirmLeave())) return;
        if (this.disposed) return;
        let role: BookRoleInfo | undefined;
        try {
            role = bookRolesApi(this.rootCtx.app)?.roleOf(book);
        } catch {
            role = undefined;
        }
        const ctx: EntryFormContext = {
            ...this.rootCtx,
            book,
            uid,
            role,
            readOnly: role?.readOnly === true,
            onClose: () => this.back(),
        };
        this.current?.dispose();
        this.stack.push(ctx);
        this.mount();
    }

    back(): void {
        if (this.disposed) return;
        if (this.stack.length <= 1) {
            this.rootCtx.onClose();
            return;
        }
        this.current?.dispose();
        this.stack.pop();
        this.mount();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.current?.dispose();
        this.current = null;
        this.releaseStyle();
    }
}

/** Mounts the entry form; the returned disposer removes everything it created. */
/**
 * Optional hook of the shell (proposed addition to EntryFormContext): the form hands it a guard to await before the
 * shell switches to another entry or closes the studio, so unsaved edits are not dropped silently.
 */
type GuardedContext = EntryFormContext & { setLeaveGuard?(guard: (() => Promise<boolean>) | null): void };

export function mountEntryForm(
    container: HTMLElement,
    ctx: EntryFormContext,
): { dispose: Unsubscribe; form(): EntryForm | null; confirmLeave(): Promise<boolean> } {
    ctx.app.i18n.register(ENTRY_FORM_STRINGS);
    const host = new FormHost(container, ctx);
    host.mount();
    const confirmLeave = async (): Promise<boolean> => (await host.form()?.confirmLeave()) ?? true;
    const guarded = ctx as GuardedContext;
    try {
        guarded.setLeaveGuard?.(confirmLeave);
    } catch (error) {
        ctx.app.log.debug('setLeaveGuard failed', error);
    }
    return {
        dispose: () => {
            try {
                guarded.setLeaveGuard?.(null);
            } catch {
                // The shell is going away as well.
            }
            host.dispose();
        },
        form: () => host.form(),
        confirmLeave,
    };
}
