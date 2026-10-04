// Journal tab: every Maestro action with undo (plan §4.6), plus autonomy decision stats (§4.12, §8).
import type { JournalRecord, PultTab } from '../../shared/contracts';
import { emptyState, section } from '../components/card';
import { select } from '../components/controls';
import { changeView } from '../components/diff';
import { button, clear, el } from '../components/dom';
import { table } from '../components/table';
import { formatTime, moduleTitle } from './format';
import type { ViewEnv } from './types';

export const JOURNAL_TAB = 'journal';
const LIMIT = 300;

export function journalTab(env: ViewEnv): PultTab {
    const { i18n, shell } = env;
    const t = i18n.t.bind(i18n);

    const recordView = (record: JournalRecord, redraw: () => void): HTMLElement =>
        el('div', { class: ['maestro-journal-row', record.undone ? 'maestro-undone' : null] }, [
            el('div', { class: 'maestro-journal-main' }, [
                el('div', { class: 'maestro-journal-summary', text: record.summary }),
                el('div', {
                    class: 'maestro-muted',
                    text: `${formatTime(record.at, i18n)} · ${moduleTitle(env.modules, i18n, record.module)} · ${record.kind}`,
                }),
                record.changes.length
                    ? el('details', { class: 'maestro-journal-changes' }, [
                          el('summary', { text: t('ui.journal.changes', { count: record.changes.length }) }),
                          ...record.changes.map((change) => changeView(change, t)),
                      ])
                    : null,
            ]),
            button({
                label: record.undone ? t('ui.journal.undoneLabel') : t('ui.journal.undo'),
                icon: 'fa-rotate-left',
                disabled: record.undone === true,
                onClick: async () => {
                    const ok = await env.journal.undo(record.id);
                    shell.notice(
                        ok
                            ? t('ui.journal.undoDone', { summary: record.summary })
                            : t('ui.journal.undoFailed', { summary: record.summary }),
                        {
                            level: ok ? 'info' : 'warn',
                        },
                    );
                    redraw();
                },
            }),
        ]);

    const statsView = (): HTMLElement => {
        const stats = [...env.autonomy.stats()].sort((a, b) => a.kind.localeCompare(b.kind));
        return section(
            t('ui.journal.stats'),
            table(
                [
                    { key: 'kind', label: t('ui.journal.kind'), cell: (row) => row.kind },
                    {
                        key: 'accepted',
                        label: t('ui.journal.accepted'),
                        numeric: true,
                        cell: (row) => String(row.accepted),
                    },
                    { key: 'edited', label: t('ui.journal.edited'), numeric: true, cell: (row) => String(row.edited) },
                    {
                        key: 'rejected',
                        label: t('ui.journal.rejected'),
                        numeric: true,
                        cell: (row) => String(row.rejected),
                    },
                    {
                        key: 'undone',
                        label: t('ui.journal.undoneCount'),
                        numeric: true,
                        cell: (row) => String(row.undone),
                    },
                    { key: 'streak', label: t('ui.journal.streak'), numeric: true, cell: (row) => String(row.streak) },
                ],
                stats,
                { empty: t('ui.journal.statsEmpty') },
            ),
        );
    };

    return {
        id: JOURNAL_TAB,
        titleKey: 'ui.tab.journal',
        icon: 'fa-clock-rotate-left',
        order: 80,
        render(container) {
            let filter = '';
            const draw = () => {
                clear(container);
                const records = [...env.journal.list({ module: filter || undefined, limit: LIMIT })].sort(
                    (a, b) => b.at - a.at,
                );
                const modules = [...new Set(env.journal.list({ limit: LIMIT }).map((record) => record.module))].sort();
                const filterSelect = select({
                    value: filter,
                    label: t('ui.journal.filter'),
                    options: [
                        { value: '', label: t('ui.journal.allModules') },
                        ...modules.map((id) => ({ value: id, label: moduleTitle(env.modules, i18n, id) })),
                    ],
                    onChange: (value) => {
                        filter = value;
                        draw();
                    },
                });
                container.append(
                    el('div', { class: 'maestro-view maestro-journal' }, [
                        section(
                            t('ui.journal.title'),
                            records.length
                                ? el(
                                      'div',
                                      { class: 'maestro-journal-list' },
                                      records.map((record) => recordView(record, draw)),
                                  )
                                : emptyState(t('ui.journal.empty'), 'fa-feather'),
                            [
                                filterSelect,
                                button({
                                    icon: 'fa-arrows-rotate',
                                    title: t('ui.refresh'),
                                    kind: 'ghost',
                                    onClick: draw,
                                }),
                            ],
                        ),
                        statsView(),
                    ]),
                );
            };
            draw();
        },
    };
}
