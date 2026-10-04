// «Параметры» tab of the Preset Studio (research/parity-preset.md §4.2): body keys of the working copy grouped as
// samplers, context, reasoning and the rest (prompt behaviour, formats, utility prompts), by preset key. Values are
// checked against ST's limits before store.setKeys (and the layer, in layer mode). Connection keys stay in ST's drawer.
import { PARAM_GROUPS, coerceParam, optionKey, paramsOf } from '../../domain/preset-ui-params';
import type { ParamSpec } from '../../domain/preset-ui-params';
import { banner } from '../../ui/components/card';
import { uid } from '../../ui/components/controls';
import { el } from '../../ui/components/dom';
import type { App } from '../../shared/contracts';
import type { PresetBody } from './store-api';

export interface ParamsModel {
    body: PresetBody;
    layerMode: boolean;
}

export interface ParamsActions {
    set(key: string, value: unknown): Promise<void>;
}

export function renderParamsPanel(app: App, model: ParamsModel, actions: ParamsActions): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const root = el('div', { class: 'maestro-m34-params' });
    root.append(el('div', { class: 'maestro-field-hint', text: t('m34.params.hint') }));
    if (model.layerMode) root.append(banner(t('m34.params.layerMode'), 'info', 'fa-layer-group'));

    // A field being typed into is marked: the studio postpones refreshes until the value is committed.
    root.addEventListener('input', (event) => {
        const target = event.target;
        if (target instanceof HTMLInputElement && target.type === 'checkbox') return;
        if (target instanceof HTMLElement) target.classList.add('maestro-m34-typing');
    });
    root.addEventListener('focusout', (event) => {
        if (event.target instanceof HTMLElement) event.target.classList.remove('maestro-m34-typing');
    });

    const commit = async (spec: ParamSpec, raw: string | boolean, control: HTMLElement): Promise<void> => {
        control.classList.remove('maestro-m34-typing');
        const result = coerceParam(spec, raw);
        if (!result.ok) {
            control.classList.add('maestro-m34-invalid');
            control.setAttribute('aria-invalid', 'true');
            app.ui.notice(t(`m34.params.error.${result.error}`, { key: spec.key }), { urgent: true, level: 'warn' });
            return;
        }
        control.classList.remove('maestro-m34-invalid');
        control.removeAttribute('aria-invalid');
        await actions.set(spec.key, result.value);
    };

    for (const group of PARAM_GROUPS) {
        const fields = paramsOf(group).map((spec) => renderField(spec));
        root.append(
            el('section', { class: 'maestro-m34-param-group', data: { group } }, [
                el('h4', { class: 'maestro-m34-h', text: t(`m34.params.group.${group}`) }),
                el('div', { class: 'maestro-m34-param-grid' }, fields),
            ]),
        );
    }
    return root;

    function renderField(spec: ParamSpec): HTMLElement {
        const id = uid('maestro-m34-param');
        const value = model.body[spec.key];
        const label = el('label', { class: 'maestro-m34-label', attrs: { for: id } }, [
            el('span', { text: t(`m34.params.key.${spec.key}`) }),
            el('code', { class: 'maestro-m34-param-key', text: spec.key }),
        ]);
        let control: HTMLElement;
        switch (spec.type) {
            case 'boolean': {
                const input = el('input', {
                    attrs: { type: 'checkbox', id },
                    data: { key: spec.key, focusKey: spec.key },
                });
                input.checked = value === true;
                input.addEventListener('change', () => void commit(spec, input.checked, input));
                return el('div', { class: 'maestro-m34-param maestro-m34-param-bool' }, [
                    el('label', { class: 'checkbox_label', attrs: { for: id } }, [
                        input,
                        el('span', { text: t(`m34.params.key.${spec.key}`) }),
                        el('code', { class: 'maestro-m34-param-key', text: spec.key }),
                    ]),
                ]);
            }
            case 'number': {
                const input = el('input', {
                    class: 'text_pole',
                    attrs: {
                        type: 'number',
                        id,
                        min: spec.min,
                        max: spec.max,
                        step: spec.step,
                        inputmode: spec.integer ? 'numeric' : 'decimal',
                        placeholder: t('m34.params.unset'),
                    },
                    data: { key: spec.key, focusKey: spec.key },
                });
                input.value = typeof value === 'number' ? String(value) : '';
                input.addEventListener('change', () => void commit(spec, input.value, input));
                control = input;
                break;
            }
            case 'select': {
                const node = el('select', {
                    class: 'text_pole',
                    attrs: { id },
                    data: { key: spec.key, focusKey: spec.key },
                });
                const known = spec.options.some((option) => option === value);
                if (!known && !spec.options.includes(''))
                    node.append(el('option', { text: t('m34.params.unset'), attrs: { value: '' } }));
                for (const option of spec.options) {
                    node.append(
                        el('option', {
                            text: t(`m34.params.opt.${spec.key}.${optionKey(option)}`),
                            attrs: { value: String(option) },
                        }),
                    );
                }
                node.value = known ? String(value) : '';
                node.addEventListener('change', () => {
                    if (node.value === '' && !spec.options.includes('')) return;
                    void commit(spec, node.value, node);
                });
                control = node;
                break;
            }
            case 'textarea': {
                const node = el('textarea', {
                    class: 'text_pole',
                    attrs: { id, rows: 3, placeholder: t('m34.params.unset') },
                    data: { key: spec.key, focusKey: spec.key },
                });
                node.value = typeof value === 'string' ? value : '';
                node.addEventListener('change', () => void commit(spec, node.value, node));
                control = node;
                break;
            }
            default: {
                const node = el('input', {
                    class: 'text_pole',
                    attrs: { type: 'text', id, placeholder: t('m34.params.unset') },
                    data: { key: spec.key, focusKey: spec.key },
                });
                node.value = typeof value === 'string' ? value : '';
                node.addEventListener('change', () => void commit(spec, node.value, node));
                control = node;
            }
        }
        return el('div', { class: ['maestro-m34-param', `maestro-m34-param-${spec.type}`] }, [label, control]);
    }
}
