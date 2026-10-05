// Section «Паспорт» of the entry form (M28 п. 4): the entry's visual passport in NAI Studio's format next to its
// text — kind, name, aliases, tags (places, objects, the world) or slots (characters), the NSFW layer, the negative —
// edited with the plan §9 checks (English tags in lower case, explicit anatomy only in the NSFW layer), generated
// (NAI Studio or the background model) and removed through the LorePassportsApi. Passport writes are immediate and
// separate from the entry's «Save»; the form's working copy follows them, so a later save keeps the passport.
// Hidden while M28 is off; BunnyMo entries never have one (P13); base books keep it in the Maestro registry (P2).
import { cloneJson, entryPatch, sameValue } from '../../../domain/lore-form-fields';
import {
    PASSPORT_KINDS,
    PASSPORT_SLOTS,
    fixPassport,
    hasErrors,
    isFixable,
    isPassportKind,
    isUserMade,
    normalizePassport,
    passportKindOf,
    passportOfEntry,
    validatePassport,
    withPassport,
} from '../../../domain/lore-passport';
import type { PassportIssue, PassportIssueCode, PassportKind, PassportSlot } from '../../../domain/lore-passport';
import { entryContentHash } from '../../../domain/roles-meta';
import type { App } from '../../../shared/contracts';
import { badge } from '../../../ui/components/card';
import { uid as domId } from '../../../ui/components/controls';
import { button, el } from '../../../ui/components/dom';
import type { Child } from '../../../ui/components/dom';
import type { LorePassport, LorePassportsApi, PassportPlace } from '../../lorePassports/api';
import type { WiEntry } from '../store-api';
import { formSection, note, row } from './controls';
import { bookRolesApi, entryLabel } from './env';
import type { FormEnv, FormState } from './env';

type Dict = Record<string, unknown>;
type Level = 'info' | 'ok' | 'warn' | 'error';

const KIND_KEYS: Record<PassportKind, string> = {
    character: 'm23f.passport.kind.character',
    location: 'm23f.passport.kind.location',
    object: 'm23f.passport.kind.object',
    world: 'm23f.passport.kind.world',
    scenario: 'm23f.passport.kind.scenario',
};

const SLOT_KEYS: Record<PassportSlot, string> = {
    base: 'm23f.passport.slot.base',
    hair: 'm23f.passport.slot.hair',
    eyes: 'm23f.passport.slot.eyes',
    body: 'm23f.passport.slot.body',
    skin: 'm23f.passport.slot.skin',
    clothing: 'm23f.passport.slot.clothing',
    accessories: 'm23f.passport.slot.accessories',
    style: 'm23f.passport.slot.style',
};

const BY_KEYS = {
    nai: 'm23f.passport.by.nai',
    model: 'm23f.passport.by.model',
    user: 'm23f.passport.by.user',
} as const;

const ISSUE_KEYS: Record<PassportIssueCode, string> = {
    notEnglish: 'm23f.passport.issue.notEnglish',
    upperCase: 'm23f.passport.issue.upperCase',
    underscore: 'm23f.passport.issue.underscore',
    anatomy: 'm23f.passport.issue.anatomy',
    empty: 'm23f.passport.issue.empty',
};

/** M28's API when the module runs. */
export function lorePassportsApi(app: App): LorePassportsApi | undefined {
    try {
        const api = app.modules.api<LorePassportsApi>('lorePassports');
        return typeof api?.get === 'function' && typeof api.set === 'function' ? api : undefined;
    } catch {
        return undefined;
    }
}

function replaceInPlace(target: Dict, source: Dict): void {
    for (const key of Object.keys(target)) if (!(key in source)) delete target[key];
    Object.assign(target, source);
}

/**
 * The form state after a passport write into the entry: the stored copy becomes the fresh entry, the draft becomes
 * the fresh entry with the user's unsaved edits on top — and when those edits touch `extensions` (the type), the
 * fresh passport is kept in them, so saving the entry later does not bring the old passport back. In place: the
 * section builders keep references to the same objects.
 */
export function rebaseOnEntry(state: Pick<FormState, 'stored' | 'draft'>, fresh: WiEntry): void {
    const pending = entryPatch(state.stored, state.draft);
    const next: Dict = cloneJson(fresh);
    for (const [field, value] of Object.entries(pending)) {
        if (value === undefined) delete next[field];
        else next[field] = cloneJson(value);
    }
    if ('extensions' in pending) {
        const extensions = withPassport(next.extensions, passportOfEntry(fresh));
        if (extensions === undefined) delete next.extensions;
        else next.extensions = extensions;
    }
    replaceInPlace(state.stored, cloneJson(fresh));
    replaceInPlace(state.draft, next);
}

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

class PassportPanel {
    private alive = true;
    private place: PassportPlace | null = null;
    private loaded: LorePassport | null = null;
    private working: Dict | null = null;
    private busy = false;
    private message: { text: string; level: Level } | null = null;
    private readonly book: string;
    private readonly uid: number;
    private live: {
        issues: HTMLElement;
        save: HTMLButtonElement | null;
        revert: HTMLButtonElement | null;
        fix: HTMLButtonElement | null;
        dirty: HTMLElement;
    } | null = null;

    constructor(
        private readonly env: FormEnv,
        private readonly api: LorePassportsApi,
        private readonly summary: HTMLElement,
        private readonly body: HTMLElement,
    ) {
        this.book = env.ctx.book;
        this.uid = env.ctx.uid;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.env.t(key, params);
    }

    start(): void {
        this.env.own(() => {
            this.alive = false;
        });
        try {
            this.env.own(
                this.api.onChange(() => {
                    if (this.alive && !this.busy && !this.isDirty()) void this.reload();
                }),
            );
        } catch (error) {
            this.env.app.log.debug('passport onChange failed', error);
        }
        this.render();
        void this.reload();
    }

    /* ---------------------------------------------------------------- data */

    private async where(): Promise<PassportPlace> {
        const role = this.env.role?.role;
        if (role === 'bunnymo.core' || role === 'bunnymo.pack') return 'bunnymo';
        let place: PassportPlace | undefined;
        if (typeof this.api.storageOf === 'function') {
            try {
                place = await this.api.storageOf(this.book);
            } catch {
                place = undefined;
            }
        }
        if (place === 'bunnymo') return place;
        // The form knows canon entries of any chat (their CanonMeta): those keep the passport in the entry.
        if (this.env.state.typedStorage === 'entry') return 'entry';
        if (place) return place;
        return this.env.state.typedStorage === 'sidecar' ? 'sidecar' : 'noRegistry';
    }

    async reload(): Promise<void> {
        let place: PassportPlace;
        let loaded: LorePassport | null = null;
        try {
            place = await this.where();
            if (place === 'entry' || place === 'sidecar') loaded = await this.api.get(this.book, this.uid);
        } catch (error) {
            if (!this.alive) return;
            this.message = { text: errorText(error), level: 'error' };
            this.render();
            return;
        }
        if (!this.alive) return;
        this.place = place;
        this.loaded = loaded;
        this.working = loaded ? cloneJson(loaded.passport) : null;
        this.render();
    }

    private isDirty(): boolean {
        if (!this.working) return false;
        return !this.loaded || !sameValue(this.working, this.loaded.passport);
    }

    /** Brings the form's working copy in line with what was just written (inside env.hold when the form offers it). */
    private async sync(): Promise<void> {
        let state: FormState;
        try {
            state = this.env.state;
        } catch {
            return;
        }
        if (this.place === 'entry') {
            const fresh = (await this.env.ctx.store.load(this.book))?.entries?.[String(this.uid)];
            if (fresh) rebaseOnEntry(state, fresh);
        } else if (this.place === 'sidecar') {
            const roles = bookRolesApi(this.env.app);
            if (roles) {
                const meta = roles.loadEntryMeta
                    ? await roles.loadEntryMeta<Dict>(this.book, this.uid)
                    : roles.entryMeta<Dict>(this.book, this.uid);
                state.sidecar = meta ? { ...meta } : undefined;
            }
        }
        this.env.changed();
    }

    private hold<T>(job: () => Promise<T>): Promise<T> {
        return this.env.hold ? this.env.hold(job) : job();
    }

    /** Runs an action: busy while it runs, its error shown, the passport read again afterwards. */
    private async run(job: () => Promise<{ text: string; level: Level } | null>): Promise<void> {
        if (this.busy) return;
        this.busy = true;
        this.message = null;
        this.render();
        let message: { text: string; level: Level } | null;
        try {
            message = await job();
        } catch (error) {
            message = { text: errorText(error), level: 'error' };
        }
        this.busy = false;
        if (!this.alive) return;
        this.message = message;
        await this.reload();
    }

    /* ---------------------------------------------------------------- actions */

    private save(): Promise<void> {
        const working = this.working;
        if (!working) return Promise.resolve();
        if (hasErrors(validatePassport(working))) {
            this.message = { text: this.t('m23f.passport.fixFirst'), level: 'error' };
            this.render();
            return Promise.resolve();
        }
        return this.run(async () => {
            await this.hold(async () => {
                await this.api.set(this.book, this.uid, working, 'user');
                await this.sync();
            });
            return { text: this.t('m23f.passport.saved'), level: 'ok' };
        });
    }

    private async generate(): Promise<void> {
        const confirm = (title: string, body: string) => this.env.app.ui.confirm(this.t(title), this.t(body));
        if (this.isDirty() && !(await confirm('m23f.passport.discardTitle', 'm23f.passport.discardBody'))) return;
        await this.run(async () => {
            const api = this.api;
            if (typeof api.propose !== 'function') {
                // An API without propose(): generate() writes (and asks about a hand-made passport) by itself.
                const result = await api.generate(this.book, this.uid);
                if (!result) return { text: this.t('m23f.passport.kept'), level: 'info' };
                await this.hold(() => this.sync());
                return { text: this.t('m23f.passport.generated', { by: this.t(BY_KEYS.model) }), level: 'ok' };
            }
            const proposed = await api.propose(this.book, this.uid);
            if (!proposed) return { text: this.t('m23f.passport.nothing'), level: 'warn' };
            const current = await api.get(this.book, this.uid);
            if (current && isUserMade(current)) {
                if (!(await confirm('m23f.passport.overwriteTitle', 'm23f.passport.overwriteBody'))) {
                    return { text: this.t('m23f.passport.kept'), level: 'info' };
                }
            }
            await this.hold(async () => {
                await api.set(this.book, this.uid, proposed.passport, proposed.by);
                await this.sync();
            });
            return { text: this.t('m23f.passport.generated', { by: this.t(BY_KEYS[proposed.by]) }), level: 'ok' };
        });
    }

    private async remove(): Promise<void> {
        const ok = await this.env.app.ui.confirm(
            this.t('m23f.passport.removeTitle'),
            this.t('m23f.passport.removeBody', { entry: entryLabel(this.env.state.stored) }),
        );
        if (!ok) return;
        await this.run(async () => {
            await this.hold(async () => {
                await this.api.remove(this.book, this.uid);
                await this.sync();
            });
            return { text: this.t('m23f.passport.removed'), level: 'ok' };
        });
    }

    private async create(): Promise<void> {
        let kind: string | null = passportKindOf(this.env.state.typed?.type);
        if (!kind && typeof this.api.kindOf === 'function') {
            // An untyped entry: the world model may know it is a place or an item.
            kind = await this.api.kindOf(this.book, this.uid).catch(() => null);
        }
        const name = this.env.state.typed?.fields.name?.trim() || entryLabel(this.env.state.stored);
        this.working = normalizePassport({ kind: kind ?? 'character', name }) ?? {};
        this.message = null;
        this.render();
    }

    private revert(): void {
        this.working = this.loaded ? cloneJson(this.loaded.passport) : null;
        this.message = null;
        this.render();
    }

    private fix(): void {
        if (!this.working) return;
        this.working = fixPassport(this.working);
        this.render();
    }

    /* ---------------------------------------------------------------- view */

    private fieldLabel(field: string): string {
        if (field === '') return '';
        if (field === 'tags') return this.t('m23f.passport.tags');
        if (field === 'nsfw') return this.t('m23f.passport.nsfw');
        if (field === 'negative') return this.t('m23f.passport.negative');
        if (field.startsWith('outfits.')) return this.t('m23f.passport.outfit');
        if (field.startsWith('states.')) return this.t('m23f.passport.state');
        const slot = field.slice('slots.'.length);
        return slot in SLOT_KEYS ? this.t(SLOT_KEYS[slot as PassportSlot]) : slot;
    }

    private issueLine(issue: PassportIssue): HTMLElement {
        return el('li', {
            class: issue.level === 'error' ? 'maestro-m23f-passport-error' : 'maestro-m23f-passport-warn',
            text: this.t(ISSUE_KEYS[issue.code], { field: this.fieldLabel(issue.field), tag: issue.tag ?? '' }),
        });
    }

    /** Validation, dirty mark and buttons after an edit (no rebuild: the focused input stays). */
    private refresh(): void {
        const live = this.live;
        if (!live || !this.working) return;
        const issues = validatePassport(this.working);
        live.issues.replaceChildren(...issues.map((issue) => this.issueLine(issue)));
        live.issues.hidden = issues.length === 0;
        const dirty = this.isDirty();
        live.dirty.hidden = !dirty;
        if (live.save) live.save.disabled = this.busy || !dirty || hasErrors(issues);
        if (live.revert) live.revert.disabled = this.busy || !dirty;
        if (live.fix) live.fix.hidden = !issues.some(isFixable);
    }

    private input(name: string, label: string, value: string, apply: (value: string) => void, hint?: string) {
        const id = domId('maestro-m23f-pp');
        const input = el('input', {
            class: 'text_pole',
            attrs: { id, type: 'text', name, autocomplete: 'off', spellcheck: 'false' },
        });
        input.value = value;
        input.disabled = this.env.readOnly;
        input.addEventListener('input', () => {
            apply(input.value);
            this.refresh();
        });
        return row(this.env, { label, control: input, for: id, hint });
    }

    private editor(working: Dict): HTMLElement {
        const t = this.t.bind(this);
        const kind: PassportKind = isPassportKind(working.kind) ? working.kind : 'character';
        const kindId = domId('maestro-m23f-pp-kind');
        const kindSelect = el(
            'select',
            { class: 'text_pole', attrs: { id: kindId, name: 'passportKind' } },
            PASSPORT_KINDS.map((value) => el('option', { text: t(KIND_KEYS[value]), attrs: { value } })),
        );
        kindSelect.value = kind;
        kindSelect.disabled = this.env.readOnly;
        kindSelect.addEventListener('change', () => {
            if (!this.working || !isPassportKind(kindSelect.value)) return;
            this.working.kind = kindSelect.value;
            this.render();
        });
        const slots = (working.slots ?? {}) as Record<string, string>;
        const nsfw = (working.nsfw ?? { enabled: false, tags: '' }) as { enabled: boolean; tags: string };
        const parts: Child[] = [
            row(this.env, { label: t('m23f.passport.kind'), control: kindSelect, for: kindId }),
            this.input('passportName', t('m23f.passport.name'), String(working.name ?? ''), (value) => {
                if (this.working) this.working.name = value.trim();
            }),
            this.input(
                'passportAliases',
                t('m23f.passport.aliases'),
                ((working.aliases ?? []) as string[]).join(', '),
                (value) => {
                    if (this.working) {
                        this.working.aliases = value
                            .split(',')
                            .map((alias) => alias.trim())
                            .filter(Boolean);
                    }
                },
                t('m23f.passport.aliasesHint'),
            ),
        ];
        if (kind === 'character') {
            for (const slot of PASSPORT_SLOTS) {
                parts.push(
                    this.input(`passportSlot-${slot}`, t(SLOT_KEYS[slot]), slots[slot] ?? '', (value) => {
                        if (this.working) this.working.slots = { ...(this.working.slots as Dict), [slot]: value };
                    }),
                );
            }
            const nsfwId = domId('maestro-m23f-pp-nsfw');
            const nsfwOn = el('input', { attrs: { type: 'checkbox', id: nsfwId, name: 'passportNsfwOn' } });
            nsfwOn.checked = nsfw.enabled;
            nsfwOn.disabled = this.env.readOnly;
            nsfwOn.addEventListener('change', () => {
                if (this.working) this.working.nsfw = { ...(this.working.nsfw as Dict), enabled: nsfwOn.checked };
                this.refresh();
            });
            parts.push(
                el('div', { class: 'maestro-m23f-check' }, [
                    el('label', { class: 'checkbox_label', attrs: { for: nsfwId } }, [
                        nsfwOn,
                        el('span', { text: t('m23f.passport.nsfwOn') }),
                    ]),
                ]),
                this.input(
                    'passportNsfw',
                    t('m23f.passport.nsfw'),
                    nsfw.tags,
                    (value) => {
                        if (this.working) this.working.nsfw = { ...(this.working.nsfw as Dict), tags: value };
                    },
                    t('m23f.passport.nsfwHint'),
                ),
            );
        } else {
            parts.push(
                this.input(
                    'passportTags',
                    t('m23f.passport.tags'),
                    String(working.tags ?? ''),
                    (value) => {
                        if (this.working) this.working.tags = value;
                    },
                    t('m23f.passport.tagsHint'),
                ),
            );
        }
        parts.push(
            this.input('passportNegative', t('m23f.passport.negative'), String(working.negative ?? ''), (value) => {
                if (this.working) this.working.negative = value;
            }),
        );
        const outfits = ((working.outfits ?? []) as { name: string }[]).map((outfit) => outfit.name);
        if (outfits.length) {
            parts.push(
                el('div', {
                    class: 'maestro-m23f-hint',
                    text: t('m23f.passport.outfits', { list: outfits.join(', ') }),
                }),
            );
        }
        const states = ((working.states ?? []) as { id: string; enabled: boolean }[])
            .filter((state) => state.enabled)
            .map((state) => state.id);
        if (states.length) {
            parts.push(
                el('div', { class: 'maestro-m23f-hint', text: t('m23f.passport.states', { list: states.join(', ') }) }),
            );
        }
        return el('div', { class: 'maestro-m23f-passport-edit' }, parts);
    }

    private whereLine(place: 'entry' | 'sidecar'): HTMLElement {
        const t = this.t.bind(this);
        return el('div', { class: 'maestro-m23f-passport-where' }, [
            badge(t(place === 'sidecar' ? 'm23f.passport.badge.sidecar' : 'm23f.passport.badge.entry'), 'muted'),
            el('span', {
                class: 'maestro-m23f-hint',
                text: t(place === 'sidecar' ? 'm23f.passport.whereSidecar' : 'm23f.passport.whereEntry'),
            }),
        ]);
    }

    private metaLine(loaded: LorePassport): HTMLElement | null {
        const t = this.t.bind(this);
        const by = loaded.generatedBy ? t(BY_KEYS[loaded.generatedBy]) : t(BY_KEYS.user);
        const parts: Child[] = [el('span', { text: t('m23f.passport.madeBy', { by }) })];
        const stale =
            loaded.contentHash !== undefined && loaded.contentHash !== entryContentHash(this.env.state.stored);
        return el('div', { class: 'maestro-m23f-passport-meta' }, [
            ...parts,
            stale ? note(t('m23f.passport.stale'), 'warn') : null,
        ]);
    }

    private actions(): HTMLElement | null {
        if (this.env.readOnly) return null;
        const t = this.t.bind(this);
        const live = this.live;
        const generate = button({
            label: t('m23f.passport.generate'),
            icon: 'fa-wand-magic-sparkles',
            disabled: this.busy,
            onClick: () => this.generate(),
        });
        if (!this.working) {
            return el('div', { class: 'maestro-m23f-actions' }, [
                generate,
                button({
                    label: t('m23f.passport.create'),
                    icon: 'fa-plus',
                    kind: 'ghost',
                    disabled: this.busy,
                    onClick: () => void this.create(),
                }),
            ]);
        }
        const save = button({
            label: t('m23f.passport.save'),
            icon: 'fa-floppy-disk',
            kind: 'primary',
            onClick: () => this.save(),
        });
        const revert = button({
            label: t('m23f.passport.revert'),
            icon: 'fa-rotate-left',
            kind: 'ghost',
            onClick: () => this.revert(),
        });
        const fix = button({
            label: t('m23f.passport.fix'),
            icon: 'fa-broom',
            kind: 'ghost',
            onClick: () => this.fix(),
        });
        if (live) Object.assign(live, { save, revert, fix });
        return el('div', { class: 'maestro-m23f-actions' }, [
            save,
            revert,
            fix,
            generate,
            this.loaded
                ? button({
                      label: t('m23f.passport.remove'),
                      icon: 'fa-trash-can',
                      kind: 'danger',
                      disabled: this.busy,
                      onClick: () => this.remove(),
                  })
                : null,
        ]);
    }

    render(): void {
        if (!this.alive) return;
        const t = this.t.bind(this);
        const parts: Child[] = [];
        this.live = null;
        const place = this.place;
        if (place === null) {
            parts.push(el('div', { class: 'maestro-m23f-hint', text: t('m23f.passport.loading') }));
        } else if (place === 'bunnymo') {
            parts.push(note(t('m23f.passport.bunnymo')));
        } else if (place === 'noRegistry') {
            parts.push(note(t('m23f.passport.noRegistry'), 'warn'));
        } else {
            parts.push(this.whereLine(place));
            if (this.loaded) parts.push(this.metaLine(this.loaded));
            const working = this.working;
            if (!working) {
                parts.push(el('div', { class: 'maestro-m23f-hint', text: t('m23f.passport.none') }));
            } else {
                const dirty = el('span', { class: 'maestro-m23f-dirty', text: t('m23f.passport.dirty') });
                const issues = el('ul', { class: 'maestro-m23f-passport-issues', attrs: { role: 'alert' } });
                this.live = { issues, save: null, revert: null, fix: null, dirty };
                parts.push(this.editor(working), dirty, issues);
            }
            parts.push(this.actions());
            if (this.busy) parts.push(el('div', { class: 'maestro-m23f-hint', text: t('m23f.passport.working') }));
        }
        if (this.message) {
            parts.push(
                el('div', {
                    class: ['maestro-m23f-passport-message', `maestro-m23f-status-${this.message.level}`],
                    text: this.message.text,
                    attrs: { role: 'status' },
                }),
            );
        }
        this.body.replaceChildren(...parts.filter((part): part is HTMLElement => part instanceof HTMLElement));
        this.refresh();
        const kind = this.loaded?.passport.kind;
        this.summary.replaceChildren(
            ...(this.loaded && isPassportKind(kind) ? [badge(t(KIND_KEYS[kind]), 'info')] : []),
        );
    }
}

/** The «Паспорт» section: hidden while M28 is off (a disabled module leaves no trace, P11). */
export function passportSection(env: FormEnv): HTMLElement {
    const body = el('div', { class: 'maestro-m23f-passport' });
    const node = formSection(env.t('m23f.section.passport'), [body], { id: 'passport', open: false });
    const api = lorePassportsApi(env.app);
    if (!api) {
        node.hidden = true;
        return node;
    }
    const summary = el('span', { class: 'maestro-m23f-passport-badge' });
    node.querySelector('summary')?.append(summary);
    new PassportPanel(env, api, summary, body).start();
    return node;
}
