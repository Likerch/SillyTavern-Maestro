// Global World Info settings in the Lore Studio (research/parity-lore.md §5, L-129…L-141): every control of ST's
// «Global World Info/Lorebook activation settings» with the same ranges; changes go through ST's own handlers
// (store → StLore.applySettings), so the classic panel, the save and WORLDINFO_SETTINGS_UPDATED stay consistent.
import { WI_SETTINGS } from '../../domain/lore-studio-settings';
import type { WiSettingSpec, WiSettingsValues } from '../../domain/lore-studio-settings';
import { el } from '../../ui/components/dom';
import { field, numberInput, select, toggle } from '../../ui/components/controls';
import type { App } from '../../shared/contracts';

export interface SettingsActions {
    change(key: string, value: number | boolean): Promise<void>;
}

const STRATEGY_KEYS: Record<number, string> = {
    0: 'm23.wi.strategyEven',
    1: 'm23.wi.strategyCharacter',
    2: 'm23.wi.strategyGlobal',
};

function control(app: App, spec: WiSettingSpec, value: number | boolean, actions: SettingsActions): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    if (spec.kind === 'boolean') {
        return el('div', { class: 'maestro-m23-setting', data: { key: spec.key } }, [
            toggle({
                label: t(spec.labelKey),
                checked: value === true,
                onChange: (checked) => actions.change(spec.key, checked),
            }),
            el('div', { class: 'maestro-field-hint', text: t(spec.hintKey) }),
        ]);
    }
    if (spec.kind === 'select') {
        const options = (spec.options ?? []).map((option) => ({
            value: String(option),
            label: t(STRATEGY_KEYS[option] ?? ''),
        }));
        return el('div', { class: 'maestro-m23-setting', data: { key: spec.key } }, [
            field(
                t(spec.labelKey),
                select({
                    value: String(value),
                    options,
                    label: t(spec.labelKey),
                    onChange: (next) => actions.change(spec.key, Number(next)),
                }),
                t(spec.hintKey),
            ),
        ]);
    }
    return el('div', { class: 'maestro-m23-setting', data: { key: spec.key } }, [
        field(
            t(spec.labelKey),
            numberInput({
                value: Number(value),
                min: spec.min,
                max: spec.max,
                step: 1,
                label: t(spec.labelKey),
                onChange: (next) => actions.change(spec.key, next),
            }),
            t(spec.hintKey, { min: spec.min ?? 0, max: spec.max ?? 0 }),
        ),
    ]);
}

export function renderSettingsPanel(app: App, values: WiSettingsValues, actions: SettingsActions): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    return el('div', { class: 'maestro-m23-settings' }, [
        el('h3', { text: t('m23.wi.title') }),
        el('p', { class: 'maestro-muted', text: t('m23.wi.intro') }),
        el(
            'div',
            { class: 'maestro-m23-settings-grid' },
            WI_SETTINGS.map((spec) => control(app, spec, values[spec.key] ?? spec.defaultValue, actions)),
        ),
        el('p', { class: 'maestro-muted', text: t('m23.wi.related') }),
    ]);
}
