// «Условные блоки» of the Preset Studio (M34 п.8) and the «Условие» control of the block editor.
// - The tab: the macro engine state (a prominent banner when it is off: `{{if}}` then reaches the model literally,
//   P-133), a flag simulator (checkboxes; unchecked = the flag is absent, as with Maestro off) and the conditional
//   blocks of the preset with what each one would send for the checked flags, and their issues. Read-only: a row
//   opens its block in the editor.
// - The control: «Всегда» / «Только когда …» / «Кроме когда …», a flag from the catalogue or a free `maestro_*` name,
//   an optional «Иначе» text. «Применить к тексту» rewrites the form's text (nothing outside the tags); the block is
//   written by the editor's «Сохранить» like any other edit (into the user's layer in layer mode).
import { applyCondition, customFlagName } from '../../domain/preset-conditional-check';
import type { FlagSource } from '../../domain/preset-conditional-check';
import { blockCondition, parseConditional, wrapBlockers } from '../../domain/preset-conditional-syntax';
import { banner, emptyState } from '../../ui/components/card';
import { uid } from '../../ui/components/controls';
import { button, el, icon } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import { issueText, simulate } from './conditional';
import type { ConditionalRow, MacroEngineState, SimulatedStatus } from './conditional';

/** A flag as the views show it. */
export interface FlagOption {
    name: string;
    label: string;
    hint?: string;
    source: FlagSource;
}

/* ------------------------------------------------------------------ the tab */

export interface ConditionalModel {
    engine: MacroEngineState;
    flags: FlagOption[];
    /** Flags checked in the simulator. */
    on: ReadonlySet<string>;
    rows: ConditionalRow[];
    /** The director's flags for the next generation («Как сейчас»), null when the director is not running. */
    current: Record<string, string> | null;
    /** Rows with the preview open. */
    expanded: ReadonlySet<string>;
}

export interface ConditionalActions {
    setFlag(name: string, on: boolean): void;
    /** Every flag off (as without Maestro). */
    reset(): void;
    /** The director's current flags. */
    useCurrent(): void;
    open(identifier: string): void;
    expand(identifier: string, open: boolean): void;
}

const STATUS_ICON: Record<SimulatedStatus, string> = {
    sent: 'fa-paper-plane',
    empty: 'fa-ban',
    whitespace: 'fa-triangle-exclamation',
    off: 'fa-power-off',
    literal: 'fa-triangle-exclamation',
};

/** The engine banner: off is an error (everything goes literally), unknown a warning; on shows nothing. */
export function engineBanner(app: App, engine: MacroEngineState): HTMLElement | null {
    const t = app.i18n.t.bind(app.i18n);
    if (engine === 'off') {
        const node = banner(t('m34.cond.engine.off'), 'error', 'fa-triangle-exclamation');
        node.classList.add('maestro-m34-cond-engine');
        node.append(el('div', { class: 'maestro-m34-cond-howto', text: t('m34.cond.engine.howto') }));
        return node;
    }
    if (engine === 'unknown') {
        const node = banner(t('m34.cond.engine.unknown'), 'warn', 'fa-circle-question');
        node.classList.add('maestro-m34-cond-engine');
        return node;
    }
    return null;
}

export function renderConditionalPanel(app: App, model: ConditionalModel, actions: ConditionalActions): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const labels = new Map(model.flags.map((flag) => [flag.name, flag.label]));
    const label = (name: string) => labels.get(name) ?? name;
    const root = el('div', { class: 'maestro-m34-conditional' });
    root.append(el('p', { class: 'maestro-muted maestro-m34-cond-intro', text: t('m34.cond.intro') }));
    const engine = engineBanner(app, model.engine);
    if (engine) root.append(engine);

    /* -------------------------------------------------------- simulator */
    const boxes = model.flags.map((flag) => {
        const id = uid('maestro-m34-cond-flag');
        const box = el('input', { attrs: { type: 'checkbox', id }, class: 'maestro-m34-cond-check' });
        box.checked = model.on.has(flag.name);
        box.dataset.flag = flag.name;
        box.dataset.focusKey = `cond-flag-${flag.name}`;
        box.addEventListener('change', () => actions.setFlag(flag.name, box.checked));
        return el('label', { class: 'checkbox_label maestro-m34-cond-flag', attrs: { for: id }, title: flag.hint }, [
            box,
            el('span', { text: flag.label }),
            flag.label !== flag.name ? el('code', { class: 'maestro-m34-cond-name', text: flag.name }) : null,
        ]);
    });
    root.append(
        el('h4', { class: 'maestro-m34-h', text: t('m34.cond.simulator') }),
        el('div', { class: 'maestro-field-hint', text: t('m34.cond.simulatorHint') }),
        model.flags.length
            ? el('fieldset', { class: 'maestro-m34-cond-flags' }, [
                  el('legend', { class: 'maestro-sr-only', text: t('m34.cond.simulator') }),
                  ...boxes,
              ])
            : el('div', { class: 'maestro-muted', text: t('m34.cond.noCatalogue') }),
        el('div', { class: 'maestro-m34-toolbar maestro-m34-cond-tools' }, [
            button({
                icon: 'fa-power-off',
                label: t('m34.cond.reset'),
                title: t('m34.cond.resetHint'),
                className: 'maestro-m34-cond-reset',
                onClick: () => actions.reset(),
            }),
            model.current
                ? button({
                      icon: 'fa-clapperboard',
                      label: t('m34.cond.current'),
                      title: t('m34.cond.currentHint'),
                      className: 'maestro-m34-cond-current',
                      onClick: () => actions.useCurrent(),
                  })
                : null,
        ]),
    );

    /* -------------------------------------------------------- blocks */
    const results = model.rows.map((row) => ({ row, result: simulate(row, model.on, model.engine) }));
    const sent = results.filter(({ result }) => result.status === 'sent' || result.status === 'literal').length;
    root.append(
        el('h4', {
            class: 'maestro-m34-h maestro-m34-cond-summary',
            text: t('m34.cond.summary', { count: model.rows.length, sent }),
        }),
    );
    if (!model.rows.length) {
        root.append(emptyState(t('m34.cond.empty'), 'fa-code-branch'));
        return root;
    }
    root.append(
        el(
            'ul',
            { class: 'maestro-m34-cond-list' },
            results.map(({ row, result }) => {
                const open = model.expanded.has(row.identifier);
                const preview = el('details', { class: 'maestro-m34-cond-preview' }, [
                    el('summary', { text: t('m34.cond.preview') }),
                    result.text === ''
                        ? el('div', { class: 'maestro-muted', text: t('m34.cond.previewEmpty') })
                        : el('div', { class: 'maestro-m34-text maestro-m34-cond-text', text: visible(result.text) }),
                ]);
                preview.open = open;
                preview.addEventListener('toggle', () => {
                    if (preview.open !== open) actions.expand(row.identifier, preview.open);
                });
                const uses = row.info.flags.map((name) =>
                    el('span', {
                        class: 'maestro-m34-cond-chip',
                        text: label(name),
                        title: name,
                    }),
                );
                return el(
                    'li',
                    {
                        class: ['maestro-m34-cond-row', `maestro-m34-cond-${result.status}`],
                        data: { id: row.identifier, status: result.status },
                    },
                    [
                        el('div', { class: 'maestro-m34-cond-head' }, [
                            icon(STATUS_ICON[result.status]),
                            button({
                                label: row.name,
                                kind: 'ghost',
                                title: t('m34.cond.open'),
                                className: 'maestro-m34-cond-open',
                                onClick: () => actions.open(row.identifier),
                            }),
                            el('span', {
                                class: 'maestro-m34-badge maestro-m34-cond-status',
                                text: t(`m34.cond.status.${result.status}`),
                            }),
                            row.inChat ? el('span', { class: 'maestro-m34-badge', text: t('m34.cond.inChat') }) : null,
                        ]),
                        el('div', { class: 'maestro-m34-cond-what' }, [
                            el('span', { class: 'maestro-muted', text: conditionText(app, row, label) }),
                            ...uses,
                        ]),
                        row.issues.length
                            ? el(
                                  'ul',
                                  { class: 'maestro-m34-cond-issues' },
                                  row.issues.map((issue) =>
                                      el('li', { class: `maestro-m34-sev-${issue.severity}` }, [
                                          icon(
                                              issue.severity === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info',
                                          ),
                                          el('span', { text: issueText(app, row, issue) }),
                                      ]),
                                  ),
                              )
                            : null,
                        preview,
                    ],
                );
            }),
        ),
    );
    return root;
}

/** «Только когда «Бой»», «Кроме когда …», or «условия внутри текста». */
function conditionText(app: App, row: ConditionalRow, label: (name: string) => string): string {
    const t = app.i18n.t.bind(app.i18n);
    const condition = row.condition;
    if (!condition) return t('m34.cond.what.mixed');
    const key = condition.negate ? 'm34.cond.what.unless' : 'm34.cond.what.when';
    const text = t(key, { flag: label(condition.flag) });
    return condition.elseText ? `${text} ${t('m34.cond.what.else')}` : text;
}

/** Whitespace-only previews must be visible. */
function visible(text: string): string {
    return text.trim() ? text : text.replace(/\n/g, '↵\n').replace(/ /g, '·').replace(/\t/g, '→');
}

/* ------------------------------------------------------------------ the editor control */

const CUSTOM = '__custom';

export interface ConditionControlOptions {
    flags: FlagOption[];
    engine: MacroEngineState;
    /** The block text of the editor's form. */
    content: HTMLTextAreaElement;
}

export interface ConditionControlHandle {
    element: HTMLElement;
    /** Reads the form's text again (after the user typed in it). */
    sync(): void;
}

export function renderConditionControl(app: App, options: ConditionControlOptions): ConditionControlHandle {
    const t = app.i18n.t.bind(app.i18n);
    const { content } = options;
    const mode = el('select', { class: 'text_pole maestro-m34-cond-mode' });
    for (const value of ['always', 'when', 'unless'] as const) {
        mode.append(el('option', { text: t(`m34.cond.mode.${value}`), attrs: { value } }));
    }
    const flag = el('select', { class: 'text_pole maestro-m34-cond-pick' });
    const fillFlags = (extra: string | null) => {
        flag.replaceChildren();
        for (const option of options.flags) {
            const text = option.label === option.name ? option.name : `${option.label} (${option.name})`;
            flag.append(el('option', { text, attrs: { value: option.name } }));
        }
        if (extra && !options.flags.some((option) => option.name === extra)) {
            flag.append(el('option', { text: extra, attrs: { value: extra } }));
        }
        flag.append(el('option', { text: t('m34.cond.customFlag'), attrs: { value: CUSTOM } }));
    };
    fillFlags(null);
    const custom = el('input', {
        class: 'text_pole maestro-m34-cond-custom',
        attrs: { type: 'text', placeholder: t('m34.cond.customPlaceholder'), spellcheck: 'false' },
    });
    const elseText = el('textarea', {
        class: 'text_pole maestro-m34-cond-else',
        attrs: { rows: 3, spellcheck: 'false' },
    });
    const state = el('div', { class: 'maestro-field-hint maestro-m34-cond-state', attrs: { 'aria-live': 'polite' } });
    const error = el('div', { class: 'maestro-warn-text maestro-m34-cond-error', attrs: { role: 'alert' } });
    error.hidden = true;

    const labelled = (text: string, control: HTMLElement, className: string, hint?: string) => {
        control.id ||= uid('maestro-m34-cond');
        return el('div', { class: ['maestro-m34-field', className] }, [
            el('label', { class: 'maestro-m34-label', text, attrs: { for: control.id } }),
            control,
            hint ? el('div', { class: 'maestro-field-hint', text: hint }) : null,
        ]);
    };
    const flagRow = labelled(t('m34.cond.flagLabel'), flag, 'maestro-m34-cond-flag-row');
    const customRow = labelled(
        t('m34.cond.customLabel'),
        custom,
        'maestro-m34-cond-custom-row',
        t('m34.cond.customHint'),
    );
    const elseRow = labelled(t('m34.cond.elseLabel'), elseText, 'maestro-m34-cond-else-row', t('m34.cond.elseHint'));

    const layout = () => {
        const conditional = mode.value !== 'always';
        flagRow.hidden = !conditional;
        customRow.hidden = !conditional || flag.value !== CUSTOM;
        elseRow.hidden = !conditional;
    };
    const flagName = (name: string) => {
        const option = options.flags.find((item) => item.name === name);
        return option && option.label !== option.name ? `«${option.label}» (${name})` : name;
    };

    /** What the text says about the condition: typing that does not change it keeps an unapplied choice. */
    const signatureOf = (text: string): string => {
        const current = blockCondition(text);
        if (current) return `${current.negate ? '!' : ''}${current.flag}\u0000${current.elseText ?? ''}`;
        if (wrapBlockers(text).length) return 'malformed';
        return parseConditional(text).tagged ? 'mixed' : 'always';
    };
    let signature = '';

    const sync = () => {
        error.hidden = true;
        const text = content.value;
        signature = signatureOf(text);
        const current = blockCondition(text);
        if (current) {
            fillFlags(current.flag);
            mode.value = current.negate ? 'unless' : 'when';
            flag.value = current.flag;
            elseText.value = current.elseText ?? '';
            state.textContent = t(current.negate ? 'm34.cond.state.unless' : 'm34.cond.state.when', {
                flag: flagName(current.flag),
            });
        } else {
            fillFlags(null);
            mode.value = 'always';
            elseText.value = '';
            // 'malformed' | 'mixed' | 'always'
            state.textContent = t(`m34.cond.state.${signature}`);
        }
        layout();
    };

    const apply = () => {
        error.hidden = true;
        let result: ReturnType<typeof applyCondition>;
        if (mode.value === 'always') result = applyCondition(content.value, { mode: 'always' });
        else {
            const name = flag.value === CUSTOM ? customFlagName(custom.value) : flag.value;
            if (!name) {
                error.textContent = t('m34.cond.error.flag');
                error.hidden = false;
                return;
            }
            result = applyCondition(content.value, {
                mode: mode.value === 'unless' ? 'unless' : 'when',
                flag: name,
                elseText: elseText.value,
            });
        }
        if (!result.ok) {
            error.textContent =
                result.reason === 'blocked'
                    ? t('m34.cond.error.blocked', {
                          tags: result.codes.map((code) => t(`m34.cond.tag.${code}`)).join(', '),
                      })
                    : t('m34.cond.error.flag');
            error.hidden = false;
            return;
        }
        if (result.text === content.value) {
            sync();
            return;
        }
        content.value = result.text;
        // The editor recounts tokens and redraws the highlight on input; sync() follows from the listener below.
        content.dispatchEvent(new Event('input', { bubbles: true }));
    };

    mode.addEventListener('change', layout);
    flag.addEventListener('change', layout);
    content.addEventListener('input', () => {
        if (signatureOf(content.value) !== signature) sync();
    });

    const element = el('fieldset', { class: 'maestro-m34-cond-control' }, [
        el('legend', { class: 'maestro-m34-label', text: t('m34.cond.legend') }),
        engineBanner(app, options.engine),
        labelled(t('m34.cond.modeLabel'), mode, 'maestro-m34-cond-mode-row'),
        flagRow,
        customRow,
        elseRow,
        state,
        error,
        el('div', { class: 'maestro-m34-cond-actions' }, [
            button({
                icon: 'fa-code-branch',
                label: t('m34.cond.apply'),
                title: t('m34.cond.applyHint'),
                className: 'maestro-m34-cond-apply',
                onClick: apply,
            }),
        ]),
    ]);
    sync();
    return { element, sync };
}
