// Tasks tab: jobs the user started himself (plan-2 §8: progress and «Stop» outside the window that started them)
// and Maestro's background queue (plan §4.5). The queue has no change event, so the open tab polls; jobs report
// their changes and redraw the tab at once (coalesced).
import type { PultTab, TaskInfo } from '../../shared/contracts';
import { badge, section } from '../components/card';
import type { Level } from '../components/card';
import { button, clear, el } from '../components/dom';
import { table } from '../components/table';
import { coalesce, formatTime } from './format';
import { renderJobs } from './jobs';
import type { ViewEnv } from './types';

export const TASKS_TAB = 'tasks';
const POLL_MS = 3000;

const STATE_ORDER: Record<TaskInfo['state'], number> = { running: 0, pending: 1, failed: 2, expired: 3, done: 4 };
const STATE_LEVEL: Record<TaskInfo['state'], Level> = {
    running: 'info',
    pending: 'muted',
    failed: 'error',
    expired: 'warn',
    done: 'ok',
};

export function tasksTab(env: ViewEnv): PultTab {
    const { i18n } = env;
    const t = i18n.t.bind(i18n);

    return {
        id: TASKS_TAB,
        titleKey: 'ui.tab.tasks',
        icon: 'fa-list-check',
        order: 75,
        render(container) {
            const draw = () => {
                clear(container);
                const list = [...env.tasks.list()].sort(
                    (a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || b.createdAt - a.createdAt,
                );
                const jobs = env.jobs;
                container.append(
                    el('div', { class: 'maestro-view maestro-tasks' }, [
                        jobs
                            ? section(t('ui.jobs.title'), [
                                  renderJobs(jobs, i18n, draw),
                                  el('div', { class: 'maestro-hint', text: t('ui.jobs.hint') }),
                              ])
                            : null,
                        section(
                            t('ui.tasks.title'),
                            table(
                                [
                                    { key: 'kind', label: t('ui.tasks.kind'), cell: (task) => task.kind },
                                    {
                                        key: 'state',
                                        label: t('ui.tasks.state'),
                                        cell: (task) =>
                                            badge(t(`ui.tasks.state.${task.state}`), STATE_LEVEL[task.state]),
                                    },
                                    {
                                        key: 'attempts',
                                        label: t('ui.tasks.attempts'),
                                        numeric: true,
                                        cell: (task) => String(task.attempts),
                                    },
                                    {
                                        key: 'created',
                                        label: t('ui.tasks.created'),
                                        cell: (task) => formatTime(task.createdAt, i18n),
                                    },
                                    {
                                        key: 'error',
                                        label: t('ui.tasks.error'),
                                        cell: (task) =>
                                            task.error
                                                ? el('span', { class: 'maestro-error-text', text: task.error })
                                                : '',
                                    },
                                ],
                                list,
                                { empty: t('ui.tasks.empty') },
                            ),
                            [
                                button({ label: t('ui.tasks.kick'), icon: 'fa-play', onClick: () => env.tasks.kick() }),
                                button({
                                    icon: 'fa-arrows-rotate',
                                    title: t('ui.refresh'),
                                    kind: 'ghost',
                                    onClick: draw,
                                }),
                            ],
                        ),
                        el('div', { class: 'maestro-hint', text: t('ui.tasks.hint') }),
                    ]),
                );
            };
            draw();
            const timer = setInterval(draw, POLL_MS);
            const redraw = coalesce(draw, 100);
            const offJobs = env.jobs?.on(() => redraw());
            return () => {
                clearInterval(timer);
                redraw.cancel();
                offJobs?.();
            };
        },
    };
}
