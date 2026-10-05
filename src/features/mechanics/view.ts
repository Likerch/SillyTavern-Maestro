// Pult tab «Механики» (plan §7: конструктор, состояние, броски): the state and checks section of the widgets part on
// top, the constructor below, the module settings last. Each section owns its listeners; the tab releases them all
// when it is closed.
import { el } from '../../ui/components/dom';
import type { PultTab, Unsubscribe } from '../../shared/contracts';
import type { ChecksPart, DefinitionsPart, PartDeps, SectionRenderer, StatePart, TrackingPart } from './parts';
import { constructorSection } from './view-constructor';
import { settingsSection } from './view-constructor-settings';
import { stateSection } from './widgets';

export const MECHANICS_TAB = 'mechanics';

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

export function mechanicsTab(
    deps: PartDeps,
    defs: DefinitionsPart,
    state: StatePart,
    checks: ChecksPart,
    tracking: TrackingPart,
): PultTab {
    return {
        id: MECHANICS_TAB,
        titleKey: 'm25.tab',
        icon: 'fa-dice-d20',
        order: 63,
        render(container) {
            const root = el('div', { class: 'maestro-view maestro-m25' });
            container.appendChild(root);
            const off = composeSections(deps, root, [
                stateSection(deps, defs, state, checks),
                constructorSection(deps, defs, tracking),
                settingsSection(deps),
            ]);
            return () => {
                off();
                root.remove();
            };
        },
    };
}
