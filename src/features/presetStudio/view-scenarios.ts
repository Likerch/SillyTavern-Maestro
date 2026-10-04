// «Параметры по сценариям» in the Preset Studio's «Параметры» tab (M34 п. 7, п. 9): every scenario with editable
// parameters (the scenarios API, scenarios/api.ts — built-ins «impersonate» and «continue» are off by default) — on/off,
// response length, temperature, stop strings, reasoning, and an optional message set that replaces the prompt of
// that one generation (a message that is exactly `{{history}}` stands for the recent chat). Each change is stored at
// once through setParams; «Сбросить» returns to the scenario's defaults.
import { stopsToText, textToStops } from '../../domain/preset-ui-params';
import { banner } from '../../ui/components/card';
import { uid } from '../../ui/components/controls';
import { button, el } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import type { ScenarioDescriptor, ScenarioParamValues } from '../scenarios/api';

type Message = NonNullable<ScenarioParamValues['messages']>[number];

export interface ScenariosModel {
    /** The scenarios module is running and offers editable parameters (list/params/setParams). */
    available: boolean;
    items: { descriptor: ScenarioDescriptor; values: ScenarioParamValues }[];
}

export interface ScenariosActions {
    set(id: string, values: Partial<ScenarioParamValues>): void;
    reset(id: string): void;
}

const HISTORY = '{{history}}';
const MESSAGE_ROLES: Message['role'][] = ['system', 'user', 'assistant'];

export function renderScenariosPanel(app: App, model: ScenariosModel, actions: ScenariosActions): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const root = el('section', { class: 'maestro-m34-scenarios' }, [
        el('h4', { class: 'maestro-m34-h', text: t('m34.scn.title') }),
        el('div', { class: 'maestro-field-hint', text: t('m34.scn.hint') }),
    ]);
    // A field being typed into is marked: the studio postpones refreshes until the value is committed.
    root.addEventListener('input', (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.type === 'checkbox') return;
        if (target instanceof HTMLElement) target.classList.add('maestro-m34-typing');
    });
    root.addEventListener('focusout', (event) => {
        if (event.target instanceof HTMLElement) event.target.classList.remove('maestro-m34-typing');
    });
    root.addEventListener('change', (event) => {
        if (event.target instanceof HTMLElement) event.target.classList.remove('maestro-m34-typing');
    });
    if (!model.available) {
        root.append(banner(t('m34.scn.unavailable'), 'info', 'fa-circle-info'));
        return root;
    }
    if (!model.items.length) {
        root.append(el('div', { class: 'maestro-muted', text: t('m34.scn.empty') }));
        return root;
    }
    for (const item of model.items) root.append(renderScenario(item.descriptor, item.values));
    return root;

    function labelled(text: string, control: HTMLElement, hint?: string): HTMLElement {
        const id = uid('maestro-m34-scn');
        control.id = id;
        return el('div', { class: 'maestro-m34-param' }, [
            el('label', { class: 'maestro-m34-label', text, attrs: { for: id } }),
            control,
            hint ? el('div', { class: 'maestro-field-hint', text: hint }) : null,
        ]);
    }

    function numberField(
        descriptor: ScenarioDescriptor,
        key: 'max_tokens' | 'temperature' | 'historyMessages',
        value: number | undefined,
        limits: { min: number; max: number; step: number },
    ): HTMLElement {
        const input = el('input', {
            class: 'text_pole',
            attrs: { type: 'number', ...limits, placeholder: t('m34.params.unset') },
            data: { focusKey: `scn:${descriptor.id}:${key}` },
        });
        input.value = value === undefined ? '' : String(value);
        input.addEventListener('change', () => {
            const text = input.value.trim();
            if (!text) {
                actions.set(descriptor.id, { [key]: undefined });
                return;
            }
            const number = Number(text.replace(',', '.'));
            if (!Number.isFinite(number) || number < limits.min || number > limits.max) {
                input.setAttribute('aria-invalid', 'true');
                app.ui.notice(t('m34.params.error.range', { key }), { urgent: true, level: 'warn' });
                return;
            }
            input.removeAttribute('aria-invalid');
            actions.set(descriptor.id, { [key]: key === 'temperature' ? number : Math.round(number) });
        });
        return labelled(t(`m34.scn.field.${key}`), input);
    }

    function renderMessages(descriptor: ScenarioDescriptor, messages: Message[]): HTMLElement {
        const list = el('ol', { class: 'maestro-m34-scn-messages' });
        const rows: { role: HTMLSelectElement; content: HTMLTextAreaElement }[] = [];
        const commit = (next: Message[]) => actions.set(descriptor.id, { messages: next });
        const collect = (): Message[] =>
            rows.map((row) => ({ role: row.role.value as Message['role'], content: row.content.value }));
        messages.forEach((message, index) => {
            const role = el('select', {
                class: 'text_pole maestro-m34-scn-role',
                attrs: { 'aria-label': t('m34.scn.role', { index: index + 1 }) },
                data: { focusKey: `scn:${descriptor.id}:role:${index}` },
            });
            for (const value of MESSAGE_ROLES)
                role.append(el('option', { text: t(`m34.role.${value}`), attrs: { value } }));
            role.value = message.role;
            const content = el('textarea', {
                class: 'text_pole maestro-m34-scn-content',
                attrs: {
                    rows: message.content === HISTORY ? 1 : 3,
                    'aria-label': t('m34.scn.content', { index: index + 1 }),
                },
                data: { focusKey: `scn:${descriptor.id}:content:${index}` },
            });
            content.value = message.content;
            const row = { role, content };
            rows.push(row);
            role.addEventListener('change', () => commit(collect()));
            content.addEventListener('change', () => commit(collect()));
            list.append(
                el(
                    'li',
                    {
                        class: [
                            'maestro-m34-scn-message',
                            message.content === HISTORY ? 'maestro-m34-scn-history' : null,
                        ],
                    },
                    [
                        role,
                        content,
                        button({
                            icon: 'fa-trash-can',
                            kind: 'ghost',
                            title: t('m34.scn.removeMessage'),
                            className: 'maestro-m34-scn-remove',
                            onClick: () => commit(collect().filter((_item, at) => at !== index)),
                        }),
                    ],
                ),
            );
        });
        return el('div', { class: 'maestro-m34-param maestro-m34-param-textarea' }, [
            el('div', { class: 'maestro-m34-label', text: t('m34.scn.field.messages') }),
            el('div', { class: 'maestro-field-hint', text: t('m34.scn.messagesHint') }),
            list,
            el('div', { class: 'maestro-row' }, [
                button({
                    icon: 'fa-plus',
                    label: t('m34.scn.addMessage'),
                    className: 'maestro-m34-scn-add',
                    onClick: () => commit([...collect(), { role: 'system', content: '' }]),
                }),
                button({
                    icon: 'fa-clock-rotate-left',
                    label: t('m34.scn.addHistory'),
                    className: 'maestro-m34-scn-add-history',
                    onClick: () => commit([...collect(), { role: 'user', content: HISTORY }]),
                }),
            ]),
        ]);
    }

    function renderScenario(descriptor: ScenarioDescriptor, values: ScenarioParamValues): HTMLElement {
        const fields: HTMLElement[] = [];
        for (const field of descriptor.fields) {
            switch (field) {
                case 'enabled': {
                    const box = el('input', {
                        attrs: { type: 'checkbox' },
                        class: 'maestro-m34-scn-enabled',
                        data: { focusKey: `scn:${descriptor.id}:enabled` },
                    });
                    box.checked = values.enabled === true;
                    box.addEventListener('change', () => actions.set(descriptor.id, { enabled: box.checked }));
                    fields.push(
                        el('div', { class: 'maestro-m34-param maestro-m34-param-bool' }, [
                            el('label', { class: 'checkbox_label' }, [
                                box,
                                el('span', { text: t('m34.scn.field.enabled') }),
                            ]),
                        ]),
                    );
                    break;
                }
                case 'max_tokens':
                    fields.push(
                        numberField(descriptor, 'max_tokens', values.max_tokens, { min: 1, max: 1_000_000, step: 1 }),
                    );
                    break;
                case 'temperature':
                    fields.push(
                        numberField(descriptor, 'temperature', values.temperature, { min: 0, max: 2, step: 0.01 }),
                    );
                    break;
                case 'historyMessages':
                    fields.push(
                        numberField(descriptor, 'historyMessages', values.historyMessages, {
                            min: 0,
                            max: 200,
                            step: 1,
                        }),
                    );
                    break;
                case 'stop': {
                    const area = el('textarea', {
                        class: 'text_pole maestro-m34-scn-stop',
                        attrs: { rows: 2, placeholder: t('m34.scn.stopPlaceholder') },
                        data: { focusKey: `scn:${descriptor.id}:stop` },
                    });
                    area.value = stopsToText(values.stop ?? []);
                    area.addEventListener('change', () =>
                        actions.set(descriptor.id, { stop: textToStops(area.value) }),
                    );
                    fields.push(labelled(t('m34.scn.field.stop'), area, t('m34.scn.stopHint')));
                    break;
                }
                case 'reasoning': {
                    const select = el('select', {
                        class: 'text_pole maestro-m34-scn-reasoning',
                        data: { focusKey: `scn:${descriptor.id}:reasoning` },
                    });
                    for (const value of ['keep', 'off'] as const)
                        select.append(el('option', { text: t(`m34.scn.reasoning.${value}`), attrs: { value } }));
                    select.value = values.reasoning ?? 'keep';
                    select.addEventListener('change', () =>
                        actions.set(descriptor.id, { reasoning: select.value === 'off' ? 'off' : 'keep' }),
                    );
                    fields.push(labelled(t('m34.scn.field.reasoning'), select));
                    break;
                }
                case 'messages':
                    fields.push(renderMessages(descriptor, values.messages ?? []));
                    break;
                default:
                    break;
            }
        }
        return el('div', { class: 'maestro-m34-scenario', data: { id: descriptor.id } }, [
            el('div', { class: 'maestro-m34-scenario-head' }, [
                el('strong', { text: t(descriptor.titleKey) }),
                ...descriptor.types.map((type) =>
                    el('span', { class: 'maestro-m34-chip', text: t(`m34.trigger.${type}`) }),
                ),
                button({
                    icon: 'fa-arrow-rotate-left',
                    label: t('m34.scn.reset'),
                    kind: 'ghost',
                    className: 'maestro-m34-scn-reset',
                    onClick: () => actions.reset(descriptor.id),
                }),
            ]),
            descriptor.descriptionKey
                ? el('div', { class: 'maestro-field-hint', text: t(descriptor.descriptionKey) })
                : null,
            el('div', { class: 'maestro-m34-param-grid' }, fields),
        ]);
    }
}
