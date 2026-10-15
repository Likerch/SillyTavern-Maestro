// M25 «Механики», «Учёт» at the top of «В игре» (release 1.25): what keeps the values from following the story now
// (MechanicsApi.trackingHealth) with the fix next to each — «Профили» for a missing background profile, «Сделать
// статами DES» for DES-stat attributes DES does not track yet, the settings for a background parse switched off.
// Nothing is drawn while all is well; the HUD shows the same warnings as ⚠.
import type { Unsubscribe } from '../../shared/contracts';
import { banner, section } from '../../ui/components/card';
import type { Level } from '../../ui/components/card';
import { button, clear, el } from '../../ui/components/dom';
import type { MechanicsApi, TrackingProblem } from './api';
import type { PartDeps, SectionRenderer, TrackingPart } from './parts';

const MECHANICS_WINDOW = 'mechanics';
const BUILD_TAB = 'mechanicsBuild';
const SETTINGS_TAB = 'settings';

export const HEALTH_CSS = `
.maestro-m25-health .maestro-banner { align-items: flex-start; }
.maestro-m25-health-row { display: flex; flex-direction: column; gap: 4px; margin-bottom: 6px; }
.maestro-m25-health-actions { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m25-health-detail { opacity: 0.7; font-size: 0.85em; }
`;

export function healthSection(
    deps: PartDeps,
    api: MechanicsApi,
    tracking?: Pick<TrackingPart, 'enableDesStats'>,
): SectionRenderer {
    const { app } = deps;
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);

    const open = (windowId: string, tab: string) => app.ui.openWindow?.(windowId, { tab });

    const actions = (problem: TrackingProblem): HTMLElement[] => {
        switch (problem.code) {
            case 'noProfile': {
                const windowId = app.ui.windowOfTab?.(SETTINGS_TAB);
                return windowId
                    ? [
                          button({
                              label: t('m25.health.action.profiles'),
                              icon: 'fa-plug',
                              onClick: () => open(windowId, SETTINGS_TAB),
                          }),
                      ]
                    : [];
            }
            case 'backgroundOff':
                return [
                    button({
                        label: t('m25.health.action.settings'),
                        icon: 'fa-gear',
                        onClick: () => open(MECHANICS_WINDOW, BUILD_TAB),
                    }),
                ];
            case 'desStatsPending':
                if (!tracking) return [];
                return problem.mechanics.flatMap((id) => {
                    const def = api.get(id);
                    if (!def) return [];
                    return [
                        button({
                            label: t('m25.health.action.desStats', { name: def.name }),
                            icon: 'fa-list-check',
                            onClick: async () => {
                                await tracking.enableDesStats(def);
                            },
                        }),
                    ];
                });
            default:
                return [];
        }
    };

    const row = (problem: TrackingProblem): HTMLElement => {
        const level: Level = problem.level === 'warn' ? 'warn' : 'info';
        const children: HTMLElement[] = [
            banner(problem.text, level, level === 'warn' ? 'fa-triangle-exclamation' : 'fa-circle-info'),
        ];
        if (problem.detail) children.push(el('div', { class: 'maestro-m25-health-detail', text: problem.detail }));
        const buttons = actions(problem);
        if (buttons.length) children.push(el('div', { class: 'maestro-m25-health-actions' }, buttons));
        return el('div', { class: 'maestro-m25-health-row', attrs: { 'data-code': problem.code } }, children);
    };

    return (container) => {
        const host = el('div', { class: 'maestro-m25-health' });
        container.appendChild(host);
        const draw = () => {
            clear(host);
            let problems: TrackingProblem[] = [];
            try {
                problems = api.trackingHealth?.() ?? [];
            } catch (error) {
                deps.log.debug('mechanics: the tracking health is not readable', error);
            }
            if (!problems.length) return;
            host.appendChild(section(t('m25.health.title'), problems.map(row)));
        };
        draw();
        const offs: Unsubscribe[] = [api.onChange(draw), app.bus.on('reply:ready', () => draw())];
        return () => {
            for (const off of offs.splice(0)) off();
            host.remove();
        };
    };
}
