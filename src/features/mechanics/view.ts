// The «Механики» window (plan §7, plan-2 §6.А п.5, §10): three sections of the mechanics group.
// - «В игре» (tab 'mechanics'): the fight, the values of everyone in the scene with inline edits, hidden values behind
//   «Подсмотреть», HUD pins, resets, the «Бросок» picker and the recent rolls and changes (widgets.ts), then statuses
//   and items per holder (view-play.ts);
// - «История» (tab 'mechanicsLog'): every change with «Отменить», the roll journal with «Отменить бросок», events;
// - «Конструктор» (tab 'mechanicsBuild'): the definitions and the module's settings (the window's gear).
// Each section owns its listeners and releases them when it is switched, hidden or closed.
import { el } from '../../ui/components/dom';
import type { PultTab, Unsubscribe } from '../../shared/contracts';
import type { MechanicsApi } from './api';
import type { ChecksPart, DefinitionsPart, PartDeps, SectionRenderer, StatePart, TrackingPart } from './parts';
import type { MechanicTranslator } from './translate';
import { constructorSection } from './view-constructor';
import { settingsSection } from './view-constructor-settings';
import { combatSection, logSection, peopleSection } from './view-play';
import { stateSection } from './widgets';

export const MECHANICS_TAB = 'mechanics';
export const MECHANICS_LOG_TAB = 'mechanicsLog';
export const MECHANICS_BUILD_TAB = 'mechanicsBuild';
const GROUP = 'mechanics';

/** Renders the sections one under another; a failing section is logged and leaves the others working. */
export function composeSections(deps: PartDeps, root: HTMLElement, sections: SectionRenderer[]): Unsubscribe {
    const offs: Unsubscribe[] = [];
    for (const render of sections) {
        const host = el('div', { class: 'maestro-m25-part' });
        root.appendChild(host);
        try {
            const off = render(host);
            if (typeof off === 'function') offs.push(off);
        } catch (error) {
            deps.log.error('mechanics: a pult section failed', error);
        }
    }
    return () => {
        for (const off of offs.splice(0)) {
            try {
                off();
            } catch (error) {
                deps.log.debug('mechanics: section cleanup failed', error);
            }
        }
    };
}

function tab(deps: PartDeps, spec: Omit<PultTab, 'render' | 'group'>, sections: () => SectionRenderer[]): PultTab {
    return {
        ...spec,
        group: GROUP,
        render(container) {
            const root = el('div', { class: 'maestro-view maestro-m25' });
            container.appendChild(root);
            const off = composeSections(deps, root, sections());
            return () => {
                off();
                root.remove();
            };
        },
    };
}

/** «В игре»: the fight, the values and rolls, statuses and items. */
export function mechanicsTab(
    deps: PartDeps,
    defs: DefinitionsPart,
    state: StatePart,
    checks: ChecksPart,
    api: MechanicsApi,
): PultTab {
    return tab(deps, { id: MECHANICS_TAB, titleKey: 'm25.tab', icon: 'fa-dice-d20', order: 63 }, () => [
        combatSection(deps, api),
        stateSection(deps, defs, state, checks, api),
        peopleSection(deps, api),
    ]);
}

/** «История»: changes with undo, the roll journal, events. */
export function mechanicsLogTab(deps: PartDeps, api: MechanicsApi): PultTab {
    return tab(
        deps,
        { id: MECHANICS_LOG_TAB, titleKey: 'm25.tab.log', icon: 'fa-clock-rotate-left', order: 64 },
        () => [logSection(deps, api)],
    );
}

/** «Конструктор»: the definitions and the module's settings. */
export function mechanicsBuildTab(
    deps: PartDeps,
    defs: DefinitionsPart,
    tracking: TrackingPart,
    api: MechanicsApi,
    translator?: MechanicTranslator,
): PultTab {
    return tab(
        deps,
        { id: MECHANICS_BUILD_TAB, titleKey: 'm25.tab.build', icon: 'fa-screwdriver-wrench', order: 65 },
        () => [
            constructorSection(deps, defs, tracking, { api, ...(translator ? { translator } : {}) }),
            settingsSection(deps, defs),
        ],
    );
}
