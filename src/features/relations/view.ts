// Pult tab «Отношения» (M19): one row per pair with the current status and a compact timeline of changes (no chart
// library: chips joined by arrows, wrapping on phones; the table turns into stacked blocks there).
import type { App, PultTab } from '../../shared/contracts';
import { badge, emptyState, section } from '../../ui/components/card';
import { button, clear, el } from '../../ui/components/dom';
import { table } from '../../ui/components/table';
import { coalesce } from '../../ui/views/format';
import type { EngineStance, Relation, RelationPoint } from './api';
import type { RelationsService } from './service';

export const RELATIONS_TAB = 'relations';
/** Points shown per pair; older ones are summed up. */
const TIMELINE_POINTS = 12;

export const RELATIONS_CSS = `
.maestro-m19-head { display: flex; flex-direction: column; gap: 6px; }
.maestro-m19-pair { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m19-timeline { display: flex; flex-wrap: wrap; gap: 4px; align-items: center; }
.maestro-m19-point { display: inline-flex; gap: 4px; align-items: baseline; border: 1px solid var(--maestro-border);
    border-radius: var(--maestro-radius-sm); padding: 1px 6px; overflow-wrap: anywhere; }
.maestro-m19-point-index { font-size: 0.8em; opacity: 0.7; }
.maestro-m19-arrow { opacity: 0.6; }
.maestro-m19-last { border-color: var(--maestro-accent); }
.maestro-m19-reasons { overflow-wrap: anywhere; font-size: 0.9em; }
`;

export function relationsTab(app: App, service: RelationsService): PultTab {
    const t = app.i18n.t.bind(app.i18n);

    const pointView = (point: RelationPoint, last: boolean): HTMLElement =>
        el(
            'span',
            {
                class: ['maestro-m19-point', last ? 'maestro-m19-last' : null],
                title: point.storyTime
                    ? t('m19.pointTime', { index: point.messageIndex, time: point.storyTime })
                    : t('m19.point', { index: point.messageIndex }),
            },
            [
                el('span', { text: point.status }),
                el('span', { class: 'maestro-m19-point-index', text: `#${point.messageIndex}` }),
                point.source !== 'des'
                    ? el('span', { class: 'maestro-muted', text: t(`m19.source.${point.source}`) })
                    : null,
            ],
        );

    const timeline = (relation: Relation): HTMLElement => {
        const points = relation.history.slice(-TIMELINE_POINTS);
        const hidden = relation.history.length - points.length;
        const children: (HTMLElement | null)[] = [
            hidden > 0 ? el('span', { class: 'maestro-muted', text: t('m19.earlier', { count: hidden }) }) : null,
        ];
        points.forEach((point, index) => {
            if (index > 0 || hidden > 0) children.push(el('span', { class: 'maestro-m19-arrow', text: '→' }));
            children.push(pointView(point, index === points.length - 1));
        });
        return el('div', { class: 'maestro-m19-timeline' }, children);
    };

    /** «−3 … +3» as a signed number. */
    const signed = (value: number): string => (value > 0 ? `+${value}` : String(value));

    /** Release 1.17: what Dramatis's engine says, marked as its own (Maestro stores none of it). */
    const engineSection = (stances: EngineStance[]): HTMLElement =>
        section(t('m19.engine.title'), [
            el('div', { class: 'maestro-hint', text: t('m19.engine.hint') }),
            table<EngineStance>(
                [
                    {
                        key: 'pair',
                        label: t('m19.col.pair'),
                        cell: (stance) =>
                            el('span', { class: 'maestro-m19-pair' }, [
                                el('span', { text: t('m19.pair', { from: stance.from, to: stance.to }) }),
                                ' ',
                                badge(t('m19.engine.source'), 'muted'),
                            ]),
                    },
                    {
                        key: 'current',
                        label: t('m19.col.current'),
                        cell: (stance) =>
                            badge(
                                stance.label
                                    ? t('m19.engine.stance', { label: stance.label, value: signed(stance.stance) })
                                    : signed(stance.stance),
                                stance.stance > 0 ? 'ok' : stance.stance < 0 ? 'warn' : 'info',
                            ),
                    },
                    {
                        key: 'reasons',
                        label: t('m19.engine.col.reasons'),
                        cell: (stance) =>
                            el('span', {
                                class: 'maestro-m19-reasons',
                                text: stance.reasons.length ? stance.reasons.join('; ') : '—',
                            }),
                    },
                ],
                stances,
                { caption: t('m19.engine.title') },
            ),
        ]);

    return {
        id: RELATIONS_TAB,
        titleKey: 'm19.tab',
        icon: 'fa-people-arrows',
        order: 46,
        render(container) {
            let alive = true;
            const root = el('div', { class: 'maestro-view maestro-m19' });
            container.appendChild(root);

            const draw = () => {
                if (!alive) return;
                clear(root);
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('m19.noChat'), 'fa-comment-slash'));
                    return;
                }
                const relations = service.all();
                const head = el('div', { class: 'maestro-m19-head' }, [
                    el('div', { class: 'maestro-hint', text: t('m19.hint') }),
                    service.loaded() ? el('div', { text: t('m19.count', { count: relations.length }) }) : null,
                ]);
                root.appendChild(
                    section(t('m19.title'), head, [
                        button({
                            label: t('m19.rebuild'),
                            icon: 'fa-rotate',
                            title: t('m19.rebuild.hint'),
                            onClick: async () => {
                                try {
                                    await service.rebuild();
                                    app.ui.notice(t('m19.rebuild.done'));
                                } catch (error) {
                                    app.ui.notice(error instanceof Error ? error.message : String(error), {
                                        level: 'error',
                                    });
                                }
                            },
                        }),
                    ]),
                );
                const engine = service.engine();
                if (engine.length) root.appendChild(engineSection(engine));
                if (!service.loaded()) {
                    root.appendChild(el('div', { class: 'maestro-muted', text: t('m19.loading') }));
                    return;
                }
                if (!relations.length) {
                    root.appendChild(emptyState(t('m19.empty'), 'fa-people-arrows'));
                    return;
                }
                root.appendChild(
                    table<Relation>(
                        [
                            {
                                key: 'pair',
                                label: t('m19.col.pair'),
                                cell: (relation) =>
                                    el('span', {
                                        class: 'maestro-m19-pair',
                                        text: t('m19.pair', { from: relation.from, to: relation.to }),
                                    }),
                            },
                            {
                                key: 'current',
                                label: t('m19.col.current'),
                                cell: (relation) => badge(relation.current, 'info'),
                            },
                            { key: 'history', label: t('m19.col.history'), cell: (relation) => timeline(relation) },
                        ],
                        relations,
                        { caption: t('m19.title') },
                    ),
                );
            };

            const redraw = coalesce(draw, 100);
            const off = service.onChange(() => alive && redraw());
            draw();
            return () => {
                alive = false;
                redraw.cancel();
                off();
            };
        },
    };
}
