// The block editor of the Preset Studio (research/parity-preset.md §3): name, role, position (relative / in chat),
// depth and order (in chat only), triggers, «forbid overrides» (main and jailbreak), the text with a token counter
// and macro highlighting, the source of an external marker, «Сброс» for system blocks. A side panel on desktop, an
// overlay on phones. Nothing is written until «Сохранить»; the studio asks before leaving unsaved edits (dirty()).
// With `conditions` the form has the «Условие» control of conditional blocks (M34 п.8, view-conditional.ts): it
// rewrites the text in the form, «Сохранить» writes it like any other edit.
import {
    PROMPT_ROLES,
    PROMPT_TRIGGERS,
    SYSTEM_DEFAULTS,
    blockFields,
    canEditBlock,
    canEditText,
    canForbidOverrides,
    canReset,
    maestroFlags,
    sameFields,
    sideEffectMacros,
    typeProblems,
} from '../../domain/preset-ui-blocks';
import type { BlockFields, PromptTrigger } from '../../domain/preset-ui-blocks';
import { banner } from '../../ui/components/card';
import { uid } from '../../ui/components/controls';
import { button, el } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import type { MacroEngineState } from './conditional';
import type { LayerScope, LayerScopeInfo } from './layer-api';
import type { PresetPrompt } from './store-api';
import { highlighted } from './view-blocks';
import { renderConditionControl } from './view-conditional';
import type { FlagOption } from './view-conditional';
import { scopeField } from './view-scopes';

export interface EditorModel {
    prompt: PresetPrompt;
    isNew: boolean;
    /** Edits go to the user's layer (shown in the header of the form). */
    layerMode: boolean;
    /** i18n key of an external marker's source (P-051), or null. */
    sourceKey: string | null;
    /** The «Условие» control (conditional blocks): the flag catalogue and the macro engine state. */
    conditions?: { flags: FlagOption[]; engine: MacroEngineState };
    /** Where new edits go («Везде / Этот персонаж / Этот чат»), shared with the «Слой» tab; absent: no scoped layer. */
    scope?: { value: LayerScope; context: LayerScopeInfo; onChange(scope: LayerScope): void };
}

export interface EditorActions {
    /** Writes the form; true when saved. */
    save(fields: BlockFields): Promise<boolean>;
    /** The user wants to close (the studio asks about unsaved edits). */
    close(): void;
    countTokens(text: string): Promise<number | null>;
}

export interface EditorHandle {
    element: HTMLElement;
    identifier: string;
    dirty(): boolean;
    read(): BlockFields;
    /** The preset changed under the form (P-041: PM closes its window silently; the studio keeps the edits). */
    markStale(): void;
    focus(): void;
    dispose(): void;
}

const TOKEN_DEBOUNCE_MS = 400;

export function renderBlockEditor(app: App, model: EditorModel, actions: EditorActions): EditorHandle {
    const t = app.i18n.t.bind(app.i18n);
    const prompt = model.prompt;
    const editable = model.isNew || canEditBlock(prompt);
    const textEditable = editable && canEditText(prompt);
    const initial = blockFields(prompt);
    let disposed = false;

    const field = (label: string, control: HTMLElement, hint?: string, className?: string): HTMLElement => {
        const id = control.id || uid('maestro-m34-field');
        control.id = id;
        return el('div', { class: ['maestro-m34-field', className] }, [
            el('label', { class: 'maestro-m34-label', text: label, attrs: { for: id } }),
            control,
            hint ? el('div', { class: 'maestro-field-hint', text: hint }) : null,
        ]);
    };

    const name = el('input', { class: 'text_pole maestro-m34-f-name', attrs: { type: 'text', disabled: !editable } });
    name.value = initial.name;
    const role = el('select', { class: 'text_pole maestro-m34-f-role', attrs: { disabled: !editable } });
    for (const value of PROMPT_ROLES) role.append(el('option', { text: t(`m34.role.${value}`), attrs: { value } }));
    role.value = initial.role;
    const position = el('select', { class: 'text_pole maestro-m34-f-position', attrs: { disabled: !editable } });
    position.append(
        el('option', { text: t('m34.editor.relative'), attrs: { value: '0' } }),
        el('option', { text: t('m34.editor.inChat'), attrs: { value: '1' } }),
    );
    position.value = String(initial.position);
    const depth = el('input', {
        class: 'text_pole maestro-m34-f-depth',
        attrs: { type: 'number', min: 0, max: 9999, step: 1, inputmode: 'numeric', disabled: !editable },
    });
    depth.value = String(initial.depth);
    const order = el('input', {
        class: 'text_pole maestro-m34-f-order',
        attrs: { type: 'number', min: 0, max: 9999, step: 1, inputmode: 'numeric', disabled: !editable },
    });
    order.value = String(initial.order);
    const triggerBoxes = PROMPT_TRIGGERS.map((trigger) => {
        const box = el('input', {
            attrs: { type: 'checkbox', value: trigger, disabled: !editable },
            class: 'maestro-m34-f-trigger',
        });
        box.checked = initial.triggers.includes(trigger);
        return { trigger, box };
    });
    const triggers = el('fieldset', { class: 'maestro-m34-triggers' }, [
        el('legend', { class: 'maestro-m34-label', text: t('m34.editor.triggers') }),
        ...triggerBoxes.map(({ trigger, box }) =>
            el('label', { class: 'checkbox_label' }, [box, el('span', { text: t(`m34.trigger.${trigger}`) })]),
        ),
        el('div', { class: 'maestro-field-hint', text: t('m34.editor.triggersHint') }),
    ]);
    const forbid = el('input', { attrs: { type: 'checkbox', disabled: !editable }, class: 'maestro-m34-f-forbid' });
    forbid.checked = initial.forbidOverrides;
    const content = el('textarea', {
        class: 'text_pole maestro-m34-f-content',
        attrs: { rows: 14, disabled: !textEditable, spellcheck: 'false' },
    });
    content.value = initial.content;
    const tokens = el('span', { class: 'maestro-m34-token-count', attrs: { 'aria-live': 'polite' } });
    const condition =
        textEditable && model.conditions ? renderConditionControl(app, { ...model.conditions, content }) : null;
    const highlight = el('details', { class: 'maestro-m34-highlight' });
    const stale = el('div', { class: 'maestro-m34-stale' });
    stale.hidden = true;

    const read = (): BlockFields => ({
        name: name.value,
        role: (PROMPT_ROLES as readonly string[]).includes(role.value) ? (role.value as BlockFields['role']) : 'system',
        position: position.value === '1' ? 1 : 0,
        depth: Number(depth.value),
        order: Number(order.value),
        triggers: triggerBoxes.filter(({ box }) => box.checked).map(({ trigger }) => trigger as PromptTrigger),
        forbidOverrides: forbid.checked,
        content: content.value,
    });

    const depthBlock = field(t('m34.editor.depth'), depth, t('m34.editor.depthHint'), 'maestro-m34-depth');
    const orderBlock = field(t('m34.editor.order'), order, t('m34.editor.orderHint'), 'maestro-m34-order');
    const syncPosition = () => {
        const inChat = position.value === '1';
        depthBlock.hidden = !inChat;
        orderBlock.hidden = !inChat;
    };
    position.addEventListener('change', syncPosition);
    syncPosition();

    let tokenTimer: ReturnType<typeof setTimeout> | null = null;
    let tokenRun = 0;
    const countTokens = () => {
        if (tokenTimer) clearTimeout(tokenTimer);
        tokenTimer = setTimeout(() => {
            tokenTimer = null;
            const run = ++tokenRun;
            const text = content.value;
            void actions.countTokens(text).then((value) => {
                if (disposed || run !== tokenRun) return;
                tokens.textContent = value === null ? '' : t('m34.editor.tokens', { count: value });
            });
        }, TOKEN_DEBOUNCE_MS);
    };
    const renderHighlight = () => {
        const text = content.value;
        const flags = maestroFlags(text);
        const effects = sideEffectMacros(text);
        highlight.replaceChildren(el('summary', { text: t('m34.editor.highlight') }), highlighted(text || ' '));
        if (flags.length) {
            highlight.append(
                el('div', { class: 'maestro-field-hint', text: t('m34.editor.flags', { flags: flags.join(', ') }) }),
            );
        }
        if (effects.length) {
            highlight.append(
                el('div', {
                    class: 'maestro-warn-text',
                    text: t('m34.editor.sideEffects', { macros: effects.join(', ') }),
                }),
            );
        }
    };
    content.addEventListener('input', () => {
        countTokens();
        if (highlight.open) renderHighlight();
    });
    highlight.addEventListener('toggle', () => {
        if (highlight.open) renderHighlight();
    });
    renderHighlight();
    countTokens();

    const reset = () => {
        const defaults = SYSTEM_DEFAULTS[prompt.identifier];
        if (defaults) {
            name.value = defaults.name;
            if (textEditable) {
                content.value = defaults.content;
                condition?.sync();
            }
            if (defaults.forbidOverrides === false) forbid.checked = false;
        }
        role.value = 'system';
        for (const { box } of triggerBoxes) box.checked = false;
        countTokens();
        if (highlight.open) renderHighlight();
    };

    const save = async (): Promise<void> => {
        if (!editable) return;
        await actions.save(read());
    };

    const problems = typeProblems(prompt);
    const element = el(
        'form',
        {
            class: 'maestro-m34-editor',
            attrs: { 'aria-label': t('m34.editor.title', { name: initial.name || prompt.identifier }) },
            // Enter in a field must not write the block: saving is the button, Ctrl+S or Ctrl+Enter.
            on: { submit: (event) => event.preventDefault() },
        },
        [
            el('div', { class: 'maestro-m34-editor-head' }, [
                el('h4', {
                    text: model.isNew
                        ? t('m34.editor.newTitle')
                        : t('m34.editor.title', { name: initial.name || prompt.identifier }),
                }),
                button({
                    icon: 'fa-xmark',
                    kind: 'ghost',
                    title: t('m34.editor.close'),
                    className: 'maestro-m34-editor-close',
                    onClick: () => actions.close(),
                }),
            ]),
            el('div', {
                class: 'maestro-muted maestro-m34-editor-id',
                text: t('m34.editor.identifier', { id: prompt.identifier }),
            }),
            model.layerMode ? banner(t('m34.editor.layerMode'), 'info', 'fa-layer-group') : null,
            !editable ? banner(t('m34.editor.readOnly'), 'info', 'fa-lock') : null,
            editable && !textEditable ? banner(t('m34.editor.markerText'), 'info', 'fa-thumbtack') : null,
            problems.length ? banner(t('m34.editor.types', { fields: problems.join(', ') }), 'warn') : null,
            stale,
            field(t('m34.editor.name'), name),
            el('div', { class: 'maestro-m34-grid' }, [
                field(t('m34.editor.role'), role, t('m34.editor.roleHint')),
                field(t('m34.editor.position'), position),
                depthBlock,
                orderBlock,
            ]),
            triggers,
            canForbidOverrides(prompt.identifier)
                ? el('label', { class: 'checkbox_label maestro-m34-forbid' }, [
                      forbid,
                      el('span', { text: t('m34.editor.forbid') }),
                  ])
                : null,
            model.sourceKey
                ? el('div', {
                      class: 'maestro-m34-source',
                      text: t('m34.editor.source', { source: t(model.sourceKey) }),
                  })
                : null,
            el('div', { class: 'maestro-m34-field' }, [
                el('div', { class: 'maestro-m34-label-row' }, [
                    el('label', {
                        class: 'maestro-m34-label',
                        text: t('m34.editor.content'),
                        attrs: { for: (content.id = uid('maestro-m34-content')) },
                    }),
                    tokens,
                ]),
                content,
            ]),
            condition?.element ?? null,
            highlight,
            editable && model.scope
                ? scopeField(app, {
                      value: model.scope.value,
                      context: model.scope.context,
                      onChange: (scope) => model.scope?.onChange(scope),
                      className: 'maestro-m34-editor-scope',
                  })
                : null,
            el('div', { class: 'maestro-m34-editor-actions' }, [
                editable
                    ? button({
                          icon: 'fa-floppy-disk',
                          label: t('m34.editor.save'),
                          kind: 'primary',
                          className: 'maestro-m34-editor-save',
                          onClick: save,
                      })
                    : null,
                editable && canReset(prompt)
                    ? button({
                          icon: 'fa-arrow-rotate-left',
                          label: t('m34.editor.reset'),
                          title: t('m34.editor.resetHint'),
                          className: 'maestro-m34-editor-reset',
                          onClick: reset,
                      })
                    : null,
                button({
                    label: t('m34.editor.close'),
                    kind: 'ghost',
                    className: 'maestro-m34-editor-cancel',
                    onClick: () => actions.close(),
                }),
                el('span', { class: 'maestro-field-hint', text: t('m34.editor.keys') }),
            ]),
        ],
    );
    element.addEventListener('keydown', (event) => {
        if ((event.ctrlKey || event.metaKey) && (event.key === 's' || event.key === 'S' || event.key === 'Enter')) {
            event.preventDefault();
            void save();
        }
    });

    return {
        element,
        identifier: prompt.identifier,
        dirty: () => editable && !sameFields(read(), initial),
        read,
        markStale() {
            stale.replaceChildren(banner(t('m34.editor.stale'), 'warn'));
            stale.hidden = false;
        },
        focus() {
            (editable ? name : content).focus();
        },
        dispose() {
            disposed = true;
            if (tokenTimer) clearTimeout(tokenTimer);
        },
    };
}
