// M25 «Механики», the module's own settings (the gear of the «Механики» window, plan-2 §10 п.4): the book of new
// definitions, auto checks, the widgets strip, the background parse, the prompt budget and depth (the live slice of
// settings.ts; P16: the depth keeps the injection near the end); plan-2 §6: rolls asked by the model, fights by the
// director's scene, how the user's own character's DES stats are read, and how far back factions are looked for;
// plan-2 §6.А: the HUD, the user's character under the DES portraits and which values show there. Narrator messages
// and the status block are places of each mechanic («Где видно» in the constructor; В22: off by default).
import { resolveVisibility } from '../../domain/mechanics-visibility';
import { moduleSettingsSection } from '../../ui/components/card';
import { field, numberInput, select, toggle } from '../../ui/components/controls';
import { el } from '../../ui/components/dom';
import { DEFAULT_MECHANICS_BOOK, MECHANICS_KEY } from './parts';
import type { DefinitionsPart, MechanicsSettings, PartDeps, SectionRenderer } from './parts';
import { DEPTH_LIMITS, PROMPT_BUDGET_LIMITS, RELEVANCE_LIMITS } from './settings';
import { nextPins, pinKey } from './widgets';

type Flag = 'autoChecks' | 'strip' | 'background' | 'modelRolls' | 'autoCombat' | 'hud' | 'desPersona';
type Count = 'promptBudget' | 'depth' | 'relevance';

export function settingsSection(deps: PartDeps, defs?: Pick<DefinitionsPart, 'active'>): SectionRenderer {
    const { app } = deps;
    const t = (key: string) => app.i18n.t(key);

    const commit = <K extends keyof MechanicsSettings>(key: K, value: MechanicsSettings[K]) => {
        deps.settings()[key] = value;
        app.settings.notify(`modules.${MECHANICS_KEY}.${key}`);
        app.settings.save();
    };

    /** «Под портретами DES»: a switch per attribute that may show there (none chosen: all of them). */
    const desChoice = (): HTMLElement | null => {
        if (!defs) return null;
        let active: ReturnType<typeof defs.active>;
        try {
            active = defs.active();
        } catch {
            active = [];
        }
        const options = active.flatMap((def) =>
            def.holders.kind === 'world' || def.holders.kind === 'factions'
                ? []
                : def.attributes
                      .filter((attribute) => {
                          const visibility = resolveVisibility(def, attribute);
                          return visibility.places.des && visibility.preset !== 'secret';
                      })
                      .map((attribute) => ({ key: pinKey(def, attribute), label: `${def.name}: ${attribute.name}` })),
        );
        if (!options.length) return null;
        const all = options.map((option) => option.key);
        const chosen = deps.settings().desAttrs ?? [];
        return field(
            t('m25.ctor.settings.desAttrs'),
            el(
                'div',
                { class: 'maestro-m25-des-attrs' },
                options.map((option) =>
                    toggle({
                        label: option.label,
                        checked: !chosen.length || chosen.includes(option.key),
                        onChange: (checked) =>
                            commit('desAttrs', nextPins(deps.settings().desAttrs ?? [], all, option.key, checked)),
                    }),
                ),
            ),
            t('m25.ctor.settings.desAttrs.hint'),
        );
    };

    return (container) => {
        const current = deps.settings();
        const flag = (key: Flag, label = `m25.def.settings.${key}`) =>
            toggle({
                label: t(label),
                checked: current[key] !== false,
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
        const fallback = field(
            t('m25.def.settings.personaFallback'),
            select({
                value: current.personaFallback,
                options: (['background', 'block'] as const).map((value) => ({
                    value,
                    label: t(`m25.def.settings.personaFallback.${value}`),
                })),
                label: t('m25.def.settings.personaFallback'),
                onChange: (value) => commit('personaFallback', value === 'block' ? 'block' : 'background'),
            }),
            t('m25.def.settings.personaFallback.hint'),
        );
        const node = moduleSettingsSection(t('m25.def.settings.title'), [
            flag('autoChecks'),
            flag('modelRolls'),
            flag('autoCombat'),
            flag('hud', 'm25.ctor.settings.hud'),
            el('div', { class: 'maestro-hint', text: t('m25.ctor.settings.hud.hint') }),
            flag('strip'),
            flag('desPersona', 'm25.ctor.settings.desPersona'),
            desChoice(),
            el('div', { class: 'maestro-hint', text: t('m25.ctor.settings.places.hint') }),
            flag('background'),
            fallback,
            count('promptBudget', PROMPT_BUDGET_LIMITS),
            count('depth', DEPTH_LIMITS),
            count('relevance', RELEVANCE_LIMITS),
            field(t('m25.def.book'), book, t('m25.def.book.hint')),
        ]);
        node.classList.add('maestro-m25-settings');
        container.appendChild(node);
        return () => node.remove();
    };
}
