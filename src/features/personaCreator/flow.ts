// The flow of M41 in one window, stage by stage:
// - form: the player's comment (optional) and the checkboxes — «Паспорт NAI», «Картинка (бесплатно)», «Связать с этим
//   персонажем» (on; remembered) and «Сделать текущей в этом чате» (off every time);
// - thinking: the model works (a user job: progress in Maestro's task list, «Остановить»); closing the window stops it;
// - review: the answer as an editable form — name, title, the description ST will keep (its «Гардероб» line follows
//   the outfits), the outfits (name, wording, NovelAI tags) — with «Создать», «Ещё раз» (a different character, the
//   comment may be changed) and «Отмена»;
// - creating: the steps with their state; the window may be hidden, the job goes on and reports its end with «Показать»;
// - done: what was done and what was skipped and why, the picture, «Сделать текущей», «Открыть персоны», «Готово».
// One flow at a time; the editor button shows it is busy.
import { createUserJobs } from '../../core/jobs';
import { personaDescription, withWardrobeLine } from '../../domain/persona-create';
import type { LoreDigest, PersonaDraft, PersonaOutfit, StoryLanguage } from '../../domain/persona-create';
import type { App, Logger, Unsubscribe, UserJobHandle, UserJobs } from '../../shared/contracts';
import { uid } from '../../ui/components/controls';
import { append, clear, el, icon } from '../../ui/components/dom';
import type { CardRef } from './collect';
import type { DialogHandle, DialogOpener } from './dialog';
import type { CreateOptions, CreateOutcome, PersonaCreator, StepId, StepState } from './service';
import { PERSONA_CREATOR_KEY } from './settings';
import type { PersonaCreatorSettings } from './settings';

export type FlowStage = 'form' | 'thinking' | 'review' | 'creating' | 'done';

interface ReviewEdit {
    name: string;
    title: string;
    description: string;
    outfits: PersonaOutfit[];
}

interface Flow {
    card: CardRef;
    stage: FlowStage;
    comment: string;
    options: CreateOptions;
    /** The last error, shown above the buttons. */
    error: string;
    /** The progress line of the thinking stage. */
    phase: string;
    draft: PersonaDraft | null;
    language: StoryLanguage;
    lore: LoreDigest | null;
    edit: ReviewEdit | null;
    /** Names of the answers so far («Ещё раз» asks for another). */
    attempts: string[];
    steps: StepState[];
    outcome: CreateOutcome | null;
    handle: UserJobHandle | null;
    dialog: DialogHandle | null;
    /** Bumped by every model run: a late answer of a replaced run is dropped. */
    token: number;
}

const fallbackJobs = new WeakMap<object, UserJobs>();

/** The user jobs service (a bare App of an older stand gets a private one). */
function userJobs(app: App): UserJobs {
    if (app.jobs) return app.jobs;
    let jobs = fallbackJobs.get(app);
    if (!jobs) {
        jobs = createUserJobs({ log: app.log, notice: (text, options) => app.ui?.notice?.(text, options) });
        fallbackJobs.set(app, jobs);
    }
    return jobs;
}

/** The job key of a card: one flow per card. */
export function personaJobKey(card: CardRef): string {
    return `persona:${card.avatar}`;
}

const STEP_ICONS: Record<StepState['status'], string> = {
    pending: 'fa-circle',
    running: 'fa-spinner',
    done: 'fa-check',
    skipped: 'fa-minus',
    failed: 'fa-xmark',
};

export class PersonaUi {
    private current: Flow | null = null;
    private readonly busyListeners = new Set<() => void>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly service: PersonaCreator,
        private readonly settings: () => PersonaCreatorSettings,
        private readonly openDialog: DialogOpener,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private jobs(): UserJobs {
        return userJobs(this.app);
    }

    /* ---------------------------------------------------------------- state for others */

    /** The stage of the flow on hand (tests, the button). */
    stage(): FlowStage | null {
        return this.current?.stage ?? null;
    }

    /** The model or the creation is working for this card. */
    isBusy(avatar?: string): boolean {
        const flow = this.current;
        if (!flow || (avatar !== undefined && flow.card.avatar !== avatar)) return false;
        return flow.stage === 'thinking' || flow.stage === 'creating';
    }

    onBusyChange(listener: () => void): Unsubscribe {
        this.busyListeners.add(listener);
        return () => this.busyListeners.delete(listener);
    }

    private busyChanged(): void {
        for (const listener of [...this.busyListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.debug('persona busy listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- opening and closing */

    /** Opens the flow for a card (the same card: shows it again); `comment` with `autostart` asks the model at once. */
    open(card: CardRef, options: { comment?: string; autostart?: boolean } = {}): void {
        if (this.disposed) return;
        const flow = this.current;
        // The same card: its flow again — unless it is a finished one nobody looks at (the button makes a new one).
        if (flow && flow.card.avatar === card.avatar && !(flow.stage === 'done' && !flow.dialog?.open)) {
            this.show();
            return;
        }
        if (flow && this.isBusy()) {
            this.app.ui.notice(this.t('m41.busy', { name: flow.card.name }), { level: 'warn', importance: 'urgent' });
            return;
        }
        if (flow) this.discard(flow);
        const remembered = this.settings();
        const next: Flow = {
            card,
            stage: 'form',
            comment: options.comment?.trim() ?? '',
            options: {
                passport: remembered.passport,
                picture: remembered.picture,
                link: remembered.link,
                makeCurrent: false,
            },
            error: '',
            phase: '',
            draft: null,
            language: 'ru',
            lore: null,
            edit: null,
            attempts: [],
            steps: [],
            outcome: null,
            handle: null,
            dialog: null,
            token: 0,
        };
        this.current = next;
        this.show();
        if (options.autostart && next.comment && this.current === next) void this.think(next);
    }

    /** Puts the flow's window on screen (again). */
    show(): void {
        const flow = this.current;
        if (!flow || this.disposed) return;
        if (!flow.dialog?.open) {
            const dialog = this.openDialog(() => this.closedByUser(flow));
            if (!dialog) {
                this.app.ui.notice(this.t('m41.noWindow'), { level: 'warn', importance: 'urgent' });
                if (flow.stage !== 'creating' && flow.stage !== 'thinking') this.discard(flow);
                return;
            }
            flow.dialog = dialog;
        }
        this.render(flow);
    }

    private closedByUser(flow: Flow): void {
        flow.dialog = null;
        if (this.current !== flow) return;
        if (flow.stage === 'creating') return; // the job goes on and reports its end
        if (flow.stage === 'thinking') this.jobs().cancel(personaJobKey(flow.card));
        this.discard(flow);
    }

    private discard(flow: Flow): void {
        flow.token++;
        flow.dialog?.close();
        flow.dialog = null;
        if (this.current === flow) {
            this.current = null;
            this.busyChanged();
        }
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        const flow = this.current;
        if (flow) {
            if (this.isBusy()) this.jobs().cancel(personaJobKey(flow.card));
            this.discard(flow);
        }
        this.busyListeners.clear();
    }

    /* ---------------------------------------------------------------- the model */

    private async think(flow: Flow): Promise<void> {
        const handle = this.jobs().start({
            key: personaJobKey(flow.card),
            title: this.t('m41.job.title', { name: flow.card.name }),
            module: PERSONA_CREATOR_KEY,
            cancellable: true,
            visible: () => flow.dialog?.open === true,
            open: { label: this.t('m41.job.show'), run: () => this.show() },
        });
        if (!handle) {
            flow.error = this.t('m41.busy', { name: flow.card.name });
            this.render(flow);
            return;
        }
        const token = ++flow.token;
        flow.handle = handle;
        flow.stage = 'thinking';
        flow.error = '';
        flow.phase = this.t('m41.phase.reading');
        this.render(flow);
        this.busyChanged();
        let result: Awaited<ReturnType<PersonaCreator['generate']>>;
        try {
            result = await this.service.generate(flow.card, {
                comment: flow.comment,
                avoid: flow.attempts,
                signal: handle.signal,
                phase: (label) => {
                    if (token !== flow.token) return;
                    flow.phase = label;
                    handle.phase('running', label);
                    this.renderPhase(flow);
                },
            });
        } catch (error) {
            this.log.error('persona generation failed', error);
            result = { ok: false, error: this.t('m41.error.request', { reason: String(error) }) };
        }
        // A stopped job ends as stopped whatever came back (no notice about a window the user closed).
        if (handle.signal.aborted || (!result.ok && result.cancelled)) {
            handle.finish(this.t('m41.detail.cancelled'), { cancelled: true });
        } else if (result.ok) handle.finish(this.t('m41.job.thought', { name: result.draft.name }));
        else handle.fail(result.error);
        if (this.current !== flow || token !== flow.token) return;
        flow.handle = null;
        if (!result.ok) {
            flow.stage = flow.edit ? 'review' : 'form';
            flow.error = result.cancelled ? '' : result.error;
        } else {
            flow.draft = result.draft;
            flow.language = result.language;
            flow.lore = result.lore;
            flow.edit = {
                name: result.draft.name,
                title: result.draft.title,
                description: personaDescription(result.draft),
                outfits: result.draft.outfits.map((outfit) => ({ ...outfit })),
            };
            flow.attempts.push(result.draft.name);
            flow.stage = 'review';
            flow.error = '';
        }
        this.render(flow);
        this.busyChanged();
    }

    /* ---------------------------------------------------------------- creation */

    private async createNow(flow: Flow): Promise<void> {
        const edit = flow.edit;
        const draft = flow.draft;
        if (!edit || !draft) return;
        const name = edit.name.trim();
        if (!name) {
            flow.error = this.t('m41.review.noName');
            this.render(flow);
            return;
        }
        const outfits = edit.outfits
            .map((outfit) => ({ name: outfit.name.trim(), wording: outfit.wording.trim(), tags: outfit.tags.trim() }))
            .filter((outfit) => outfit.name && outfit.tags);
        this.remember(flow.options);
        const handle = this.jobs().start({
            key: personaJobKey(flow.card),
            title: this.t('m41.job.title', { name: flow.card.name }),
            module: PERSONA_CREATOR_KEY,
            cancellable: true,
            visible: () => flow.dialog?.open === true,
            open: { label: this.t('m41.job.show'), run: () => this.show() },
        });
        if (!handle) {
            flow.error = this.t('m41.busy', { name: flow.card.name });
            this.render(flow);
            return;
        }
        flow.handle = handle;
        flow.stage = 'creating';
        flow.error = '';
        flow.steps = [];
        handle.phase('running', this.t('m41.creating.title', { name }));
        this.render(flow);
        this.busyChanged();
        let outcome: CreateOutcome;
        try {
            outcome = await this.service.create(
                {
                    card: flow.card,
                    name,
                    title: edit.title.trim(),
                    description: withWardrobeLine(
                        edit.description,
                        outfits.map((outfit) => outfit.name),
                    ),
                    outfits,
                    draft,
                    language: flow.language,
                    options: { ...flow.options },
                },
                {
                    signal: handle.signal,
                    onStep: (steps) => {
                        flow.steps = steps;
                        if (flow.stage === 'creating') this.renderSteps(flow);
                    },
                },
            );
        } catch (error) {
            this.log.error('persona creation failed', error);
            outcome = {
                ok: false,
                avatarId: '',
                name,
                steps: flow.steps,
                current: false,
                picture: false,
                outfits: 0,
                error: this.t('m41.error.create', { reason: String(error) }),
            };
        }
        flow.handle = null;
        flow.outcome = outcome;
        flow.steps = outcome.steps;
        if (outcome.ok) {
            handle.finish(this.summary(outcome), { warn: outcome.steps.some((step) => step.status === 'failed') });
        } else handle.fail(outcome.error ?? this.t('m41.done.failed'));
        if (this.current !== flow) return;
        flow.stage = 'done';
        if (flow.dialog?.open) this.render(flow);
        this.busyChanged();
    }

    /** The checkboxes the user leaves on stay on next time («Сделать текущей» is never remembered). */
    private remember(options: CreateOptions): void {
        try {
            const slice = this.app.settings.module<PersonaCreatorSettings>(PERSONA_CREATOR_KEY);
            if (
                slice.passport === options.passport &&
                slice.picture === options.picture &&
                slice.link === options.link
            ) {
                return;
            }
            slice.passport = options.passport;
            slice.picture = options.picture;
            slice.link = options.link;
            this.app.settings.save();
        } catch (error) {
            this.log.debug('persona options were not remembered', error);
        }
    }

    /** One line of what was done: «Мира: персона, связь с персонажем, паспорт (6 нарядов), без картинки (…)». */
    summary(outcome: CreateOutcome): string {
        const parts: string[] = [];
        const step = (id: StepId) => outcome.steps.find((item) => item.id === id);
        if (step('persona')?.status === 'done') parts.push(this.t('m41.part.persona'));
        if (step('link')?.status === 'done') parts.push(this.t('m41.part.link'));
        const passport = step('passport');
        if (passport?.status === 'done') parts.push(this.t('m41.part.passport', { outfits: passport.detail ?? '' }));
        else if (passport && passport.detail) parts.push(this.t('m41.part.noPassport', { why: passport.detail }));
        const picture = step('picture');
        if (picture?.status === 'done') parts.push(this.t('m41.part.picture'));
        else if (picture && picture.detail && passport?.status === 'done') {
            parts.push(this.t('m41.part.noPicture', { why: picture.detail }));
        }
        if (step('current')?.status === 'done') parts.push(this.t('m41.part.current'));
        return this.t('m41.summary', { name: outcome.name, parts: parts.join(', ') });
    }

    /* ---------------------------------------------------------------- done actions */

    private async makeCurrent(flow: Flow): Promise<void> {
        const outcome = flow.outcome;
        if (!outcome?.ok) return;
        outcome.current = await this.service.makeCurrent(outcome.avatarId);
        if (!outcome.current) flow.error = this.t('m41.error.select');
        this.render(flow);
    }

    private openPersonas(flow: Flow): void {
        const outcome = flow.outcome;
        this.discard(flow);
        try {
            this.app.ui.closePult?.();
        } catch (error) {
            this.log.debug('pult did not close', error);
        }
        if (outcome?.ok) {
            void this.service.personas
                .open(outcome.avatarId)
                .catch((error: unknown) => this.log.debug('persona panel did not open', error));
        }
    }

    /* ---------------------------------------------------------------- rendering */

    private render(flow: Flow): void {
        const dialog = flow.dialog;
        if (!dialog?.open || this.current !== flow) return;
        const body = dialog.body;
        clear(body);
        body.dataset.stage = flow.stage;
        switch (flow.stage) {
            case 'form':
                body.append(...this.formView(flow));
                break;
            case 'thinking':
                body.append(...this.thinkingView(flow));
                break;
            case 'review':
                body.append(...this.reviewView(flow));
                break;
            case 'creating':
                body.append(...this.creatingView(flow));
                break;
            case 'done':
                body.append(...this.doneView(flow));
                break;
        }
    }

    private renderPhase(flow: Flow): void {
        const node = flow.dialog?.body.querySelector('.maestro-m41-phase-text');
        if (node) node.textContent = flow.phase;
    }

    private renderSteps(flow: Flow): void {
        const list = flow.dialog?.body.querySelector('.maestro-m41-steps');
        if (!list) return;
        list.replaceWith(this.stepsView(flow));
    }

    private heading(text: string): HTMLElement {
        return el('h3', { class: 'maestro-m41-heading', text });
    }

    private actionButton(
        action: string,
        label: string,
        run: () => void | Promise<void>,
        options: { primary?: boolean; disabled?: boolean; iconName?: string } = {},
    ): HTMLButtonElement {
        const node = el(
            'button',
            {
                class: ['menu_button', 'maestro-btn', options.primary ? 'maestro-btn-primary' : null],
                data: { action },
                attrs: { type: 'button', disabled: options.disabled === true },
            },
            [options.iconName ? icon(options.iconName) : null, el('span', { text: label })],
        );
        node.addEventListener('click', () => {
            if (node.disabled) return;
            try {
                const result = run();
                if (result instanceof Promise) {
                    result.catch((error: unknown) => this.log.error(`persona action ${action} failed`, error));
                }
            } catch (error) {
                this.log.error(`persona action ${action} failed`, error);
            }
        });
        return node;
    }

    private errorLine(flow: Flow): HTMLElement | null {
        return flow.error
            ? el('div', { class: 'maestro-m41-error', attrs: { role: 'alert' }, text: flow.error })
            : null;
    }

    private checkbox(
        name: keyof CreateOptions,
        label: string,
        hint: string,
        state: { checked: boolean; disabled: boolean },
        onChange: (checked: boolean) => void,
    ): HTMLElement {
        const id = uid('maestro-m41');
        const input = el('input', {
            data: { option: name },
            attrs: { type: 'checkbox', id, disabled: state.disabled },
        });
        input.checked = state.checked;
        input.addEventListener('change', () => onChange(input.checked));
        return el('label', { class: 'checkbox_label maestro-m41-option', attrs: { for: id }, title: hint }, [
            input,
            el('span', { text: label }),
        ]);
    }

    /** The four checkboxes; the picture follows the passport, both need NAI Studio with persona keys. */
    private optionsView(flow: Flow): HTMLElement {
        const support = this.service.naiSupport();
        const nai = support === 'ok';
        const box = el('div', { class: 'maestro-m41-options' });
        const draw = () => {
            clear(box);
            append(box, [
                this.checkbox(
                    'passport',
                    this.t('m41.opt.passport'),
                    this.t('m41.opt.passportHint'),
                    { checked: nai && flow.options.passport, disabled: !nai },
                    (checked) => {
                        flow.options.passport = checked;
                        draw();
                    },
                ),
                this.checkbox(
                    'picture',
                    this.t('m41.opt.picture'),
                    this.t('m41.opt.pictureHint'),
                    {
                        checked: nai && flow.options.passport && flow.options.picture,
                        disabled: !nai || !flow.options.passport,
                    },
                    (checked) => {
                        flow.options.picture = checked;
                    },
                ),
                this.checkbox(
                    'link',
                    this.t('m41.opt.link', { name: flow.card.name }),
                    this.t('m41.opt.linkHint'),
                    { checked: flow.options.link, disabled: false },
                    (checked) => {
                        flow.options.link = checked;
                    },
                ),
                this.checkbox(
                    'makeCurrent',
                    this.t('m41.opt.current'),
                    this.t('m41.opt.currentHint'),
                    { checked: flow.options.makeCurrent, disabled: false },
                    (checked) => {
                        flow.options.makeCurrent = checked;
                    },
                ),
                nai
                    ? null
                    : el('div', {
                          class: 'maestro-m41-note',
                          text: this.t(support === 'old' ? 'm41.nai.old' : 'm41.nai.absent'),
                      }),
            ]);
        };
        draw();
        return box;
    }

    private formView(flow: Flow): Node[] {
        const comment = el('textarea', {
            class: 'text_pole maestro-m41-comment',
            data: { field: 'comment' },
            attrs: { rows: 3, placeholder: this.t('m41.dialog.commentHint') },
        });
        comment.value = flow.comment;
        comment.addEventListener('input', () => {
            flow.comment = comment.value;
        });
        const noProfile = !this.service.available();
        return [
            this.heading(this.t('m41.dialog.title', { name: flow.card.name })),
            el('p', { class: 'maestro-m41-intro', text: this.t('m41.dialog.intro') }),
            el('label', { class: 'maestro-m41-label', text: this.t('m41.dialog.comment') }),
            comment,
            el('div', { class: 'maestro-m41-hint', text: this.t('m41.dialog.commentHelp') }),
            this.optionsView(flow),
            noProfile ? el('div', { class: 'maestro-m41-error', text: this.t('m41.error.noProfile') }) : null,
            this.errorLine(flow),
            el('div', { class: 'maestro-m41-buttons' }, [
                this.actionButton('think', this.t('m41.action.think'), () => this.think(flow), {
                    primary: true,
                    disabled: noProfile,
                    iconName: 'fa-wand-magic-sparkles',
                }),
                this.actionButton('cancel', this.t('m41.action.cancel'), () => this.discard(flow)),
            ]),
        ].filter((node): node is HTMLElement => node !== null);
    }

    private thinkingView(flow: Flow): Node[] {
        return [
            this.heading(this.t('m41.dialog.title', { name: flow.card.name })),
            el('div', { class: 'maestro-m41-phase' }, [
                icon('fa-spinner', 'fa-spin'),
                el('span', { class: 'maestro-m41-phase-text', text: flow.phase }),
            ]),
            el('div', { class: 'maestro-m41-hint', text: this.t('m41.phase.wait') }),
            el('div', { class: 'maestro-m41-buttons' }, [
                this.actionButton('stop', this.t('m41.action.stop'), () => {
                    this.jobs().cancel(personaJobKey(flow.card));
                }),
            ]),
        ];
    }

    private textInput(
        field: string,
        value: string,
        onInput: (value: string) => void,
        label?: string,
    ): HTMLInputElement {
        const input = el('input', {
            class: 'text_pole',
            data: { field },
            attrs: { type: 'text', 'aria-label': label },
        });
        input.value = value;
        input.addEventListener('input', () => onInput(input.value));
        return input;
    }

    private reviewView(flow: Flow): Node[] {
        const edit = flow.edit;
        if (!edit) return [];
        const description = el('textarea', {
            class: 'text_pole maestro-m41-description',
            data: { field: 'description' },
            attrs: { rows: 12 },
        });
        description.value = edit.description;
        description.addEventListener('input', () => {
            edit.description = description.value;
        });
        const syncWardrobe = () => {
            edit.description = withWardrobeLine(
                edit.description,
                edit.outfits.map((outfit) => outfit.name),
            );
            description.value = edit.description;
        };
        const outfitsTitle = el('div', {
            class: 'maestro-m41-label',
            text: this.t('m41.review.outfits', { count: edit.outfits.length }),
        });
        const outfitList = el('div', { class: 'maestro-m41-outfits' });
        const drawOutfits = () => {
            clear(outfitList);
            outfitsTitle.textContent = this.t('m41.review.outfits', { count: edit.outfits.length });
            edit.outfits.forEach((outfit, index) => {
                const remove = this.actionButton(
                    'remove-outfit',
                    '',
                    () => {
                        edit.outfits.splice(index, 1);
                        syncWardrobe();
                        drawOutfits();
                    },
                    { disabled: edit.outfits.length <= 1, iconName: 'fa-xmark' },
                );
                remove.title = this.t('m41.action.removeOutfit');
                remove.setAttribute('aria-label', this.t('m41.action.removeOutfit'));
                outfitList.append(
                    el('div', { class: 'maestro-m41-outfit', data: { index } }, [
                        el('div', { class: 'maestro-m41-outfit-head' }, [
                            this.textInput(
                                'outfit-name',
                                outfit.name,
                                (value) => {
                                    outfit.name = value;
                                    syncWardrobe();
                                },
                                this.t('m41.review.outfitName'),
                            ),
                            remove,
                        ]),
                        this.textInput(
                            'outfit-wording',
                            outfit.wording,
                            (value) => {
                                outfit.wording = value;
                            },
                            this.t('m41.review.outfitWording'),
                        ),
                        this.textInput(
                            'outfit-tags',
                            outfit.tags,
                            (value) => {
                                outfit.tags = value;
                            },
                            this.t('m41.review.outfitTags'),
                        ),
                    ]),
                );
            });
        };
        drawOutfits();
        const comment = el('textarea', {
            class: 'text_pole maestro-m41-comment',
            data: { field: 'comment' },
            attrs: { rows: 2, placeholder: this.t('m41.dialog.commentHint') },
        });
        comment.value = flow.comment;
        comment.addEventListener('input', () => {
            flow.comment = comment.value;
        });
        const lore = flow.lore;
        const loreLine = lore
            ? lore.total
                ? this.t('m41.review.lore', { picked: lore.entries.length, total: lore.total })
                : this.t('m41.review.noLore')
            : '';
        return [
            this.heading(this.t('m41.dialog.title', { name: flow.card.name })),
            el('div', { class: 'maestro-m41-row' }, [
                el('div', { class: 'maestro-m41-col' }, [
                    el('label', { class: 'maestro-m41-label', text: this.t('m41.review.name') }),
                    this.textInput('name', edit.name, (value) => {
                        edit.name = value;
                    }),
                ]),
                el('div', { class: 'maestro-m41-col' }, [
                    el('label', { class: 'maestro-m41-label', text: this.t('m41.review.title') }),
                    this.textInput('title', edit.title, (value) => {
                        edit.title = value;
                    }),
                ]),
            ]),
            el('label', { class: 'maestro-m41-label', text: this.t('m41.review.description') }),
            description,
            el('div', { class: 'maestro-m41-hint', text: this.t('m41.review.descriptionHint') }),
            outfitsTitle,
            el('div', { class: 'maestro-m41-hint', text: this.t('m41.review.outfitsHint') }),
            outfitList,
            this.optionsView(flow),
            el('label', { class: 'maestro-m41-label', text: this.t('m41.review.comment') }),
            comment,
            loreLine ? el('div', { class: 'maestro-m41-hint', text: loreLine }) : null,
            this.errorLine(flow),
            el('div', { class: 'maestro-m41-buttons' }, [
                this.actionButton('create', this.t('m41.action.create'), () => this.createNow(flow), {
                    primary: true,
                    iconName: 'fa-user-plus',
                }),
                this.actionButton('again', this.t('m41.action.again'), () => this.think(flow), {
                    iconName: 'fa-rotate',
                }),
                this.actionButton('cancel', this.t('m41.action.cancel'), () => this.discard(flow)),
            ]),
        ].filter((node): node is HTMLElement => node !== null);
    }

    private stepLabel(flow: Flow, id: StepId): string {
        return this.t(`m41.step.${id}`, { name: flow.card.name });
    }

    private stepsView(flow: Flow): HTMLElement {
        const chosen = (id: StepId) =>
            (id !== 'link' || flow.options.link) && (id !== 'current' || flow.options.makeCurrent);
        const steps = flow.steps.length
            ? flow.steps
            : (['persona', 'avatar', 'link', 'passport', 'picture', 'current'] as StepId[]).map((id): StepState => ({
                  id,
                  status: 'pending',
              }));
        return el(
            'ul',
            { class: 'maestro-m41-steps' },
            steps
                .filter((step) => chosen(step.id))
                .map((step) =>
                    el('li', { class: ['maestro-m41-step', `maestro-m41-${step.status}`], data: { step: step.id } }, [
                        icon(STEP_ICONS[step.status], step.status === 'running' ? 'fa-spin' : undefined),
                        el('span', { class: 'maestro-m41-step-label', text: this.stepLabel(flow, step.id) }),
                        step.detail ? el('span', { class: 'maestro-m41-step-detail', text: step.detail }) : null,
                    ]),
                ),
        );
    }

    private creatingView(flow: Flow): Node[] {
        return [
            this.heading(this.t('m41.creating.title', { name: flow.edit?.name.trim() ?? '' })),
            this.stepsView(flow),
            el('div', { class: 'maestro-m41-buttons' }, [
                this.actionButton('stop', this.t('m41.action.stop'), () => {
                    this.jobs().cancel(personaJobKey(flow.card));
                }),
                this.actionButton('hide', this.t('m41.action.hide'), () => {
                    flow.dialog?.close();
                    flow.dialog = null;
                }),
            ]),
        ];
    }

    private preview(outcome: CreateOutcome): HTMLElement | null {
        if (!outcome.ok) return null;
        let url = '';
        try {
            const ctx = this.app.host.ctx();
            if (typeof ctx.getThumbnailUrl === 'function') url = ctx.getThumbnailUrl('persona', outcome.avatarId);
        } catch {
            url = '';
        }
        if (!url) return null;
        const separator = url.includes('?') ? '&' : '?';
        return el('img', {
            class: 'maestro-m41-preview',
            attrs: { src: `${url}${separator}t=${Date.now()}`, alt: outcome.name },
        });
    }

    private doneView(flow: Flow): Node[] {
        const outcome = flow.outcome;
        if (!outcome) return [];
        const partial = outcome.steps.some((step) => step.status === 'failed');
        const title = !outcome.ok
            ? this.t('m41.done.failed')
            : this.t(partial ? 'm41.done.partial' : 'm41.done.title', { name: outcome.name });
        const buttons: HTMLElement[] = [];
        if (outcome.ok) {
            buttons.push(
                outcome.current
                    ? this.actionButton('makeCurrent', this.t('m41.action.isCurrent'), () => undefined, {
                          disabled: true,
                          iconName: 'fa-check',
                      })
                    : this.actionButton('makeCurrent', this.t('m41.action.makeCurrent'), () => this.makeCurrent(flow), {
                          primary: true,
                      }),
                this.actionButton('openPersonas', this.t('m41.action.openPersonas'), () => this.openPersonas(flow), {
                    iconName: 'fa-face-smile',
                }),
            );
        }
        buttons.push(this.actionButton('done', this.t('m41.action.done'), () => this.discard(flow)));
        return [
            el('div', { class: 'maestro-m41-result' }, [
                this.preview(outcome),
                el('div', { class: 'maestro-m41-result-text' }, [
                    this.heading(title),
                    outcome.error ? el('div', { class: 'maestro-m41-error', text: outcome.error }) : null,
                    this.stepsView(flow),
                ]),
            ]),
            outcome.ok ? el('div', { class: 'maestro-m41-hint', text: this.t('m41.done.noUndo') }) : null,
            this.errorLine(flow),
            el('div', { class: 'maestro-m41-buttons' }, buttons),
        ].filter((node): node is HTMLElement => node !== null);
    }
}
