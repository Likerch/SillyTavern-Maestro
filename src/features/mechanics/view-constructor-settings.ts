// M25 «Механики», the settings section of the pult tab: the book of new definitions, checks by trigger words, the
// widgets strip, the background parse, the prompt budget and depth (the live slice of settings.ts; P16: the depth
// keeps the injection near the end).
import { section } from '../../ui/components/card';
import { field, numberInput, toggle } from '../../ui/components/controls';
import { el } from '../../ui/components/dom';
import { DEFAULT_MECHANICS_BOOK, MECHANICS_KEY } from './parts';
import type { MechanicsSettings, PartDeps, SectionRenderer } from './parts';
import { DEPTH_LIMITS, PROMPT_BUDGET_LIMITS } from './settings';

type Flag = 'autoChecks' | 'strip' | 'background';
type Count = 'promptBudget' | 'depth';

export function settingsSection(deps: PartDeps): SectionRenderer {
    const { app } = deps;
    const t = (key: string) => app.i18n.t(key);

    const commit = <K extends keyof MechanicsSettings>(key: K, value: MechanicsSettings[K]) => {
        deps.settings()[key] = value;
        app.settings.notify(`modules.${MECHANICS_KEY}.${key}`);
        app.settings.save();
    };

    return (container) => {
        const current = deps.settings();
        const flag = (key: Flag) =>
            toggle({
                label: t(`m25.def.settings.${key}`),
                checked: current[key],
                onChange: (checked) => commit(key, checked),
            });
        const count = (key: Count, limits: { min: number; max: number }) =>
            field(
                t(`m25.def.settings.${key}`),
                numberInput({
                    value: current[key],
                    min: limits.min,
                    max: limits.max,
                    step: 1,
                    label: t(`m25.def.settings.${key}`),
                    onChange: (value) => commit(key, Math.round(value)),
                }),
                t(`m25.def.settings.${key}.hint`),
            );
        const book = el('input', {
            class: ['text_pole', 'maestro-m25-input', 'maestro-m25-book'],
            attrs: { type: 'text', 'aria-label': t('m25.def.book'), placeholder: DEFAULT_MECHANICS_BOOK },
        });
        book.value = current.book;
        book.addEventListener('change', () => {
            const value = book.value.trim() || DEFAULT_MECHANICS_BOOK;
            book.value = value;
            commit('book', value);
        });
        const node = section(t('m25.def.settings.title'), [
            flag('autoChecks'),
            flag('strip'),
            flag('background'),
            count('promptBudget', PROMPT_BUDGET_LIMITS),
            count('depth', DEPTH_LIMITS),
            field(t('m25.def.book'), book, t('m25.def.book.hint')),
        ]);
        node.classList.add('maestro-m25-settings');
        container.appendChild(node);
        return () => node.remove();
    };
}
