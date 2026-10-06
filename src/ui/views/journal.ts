// Journal tab: every Maestro action with undo (plan §4.6), plus autonomy decision stats (§4.12, §8). A record reads in
// plain words (summary, module, human kind, the change as «было → стало» from the modules' TargetSpecs); kind ids,
// locators and raw values wait under «Подробнее» (plan-2 §3).
import { kindLabel } from '../../core/labels';
import type { JournalRecord, PultTab } from '../../shared/contracts';
import { emptyState, section } from '../components/card';
import { select } from '../components/controls';
import { changeView, detailsView, humanChangeView } from '../components/diff';
import { button, clear, el } from '../components/dom';
import { table } from '../components/table';
import { formatTime, moduleTitle } from './format';
import type { ViewEnv } from './types';

export const JOURNAL_TAB = 'journal';
const LIMIT = 300;

export function journalTab(env: ViewEnv): PultTab {
    const { i18n, shell } = env;
    const t = i18n.t.bind(i18n);
    /** Human kind name; the raw kind when the module did not name it (still better than nothing in a table). */
    const kindName = (kind: string): string => kindLabel(i18n, kind) ?? kind;

    const changesView = (record: JournalRecord): HTMLElement | null => {
        if (!record.changes.length) return null;
        const open = env.settings.core().showTechnical === true;
        const human = record.changes
            .map((change) => humanChangeView(change, env.labels, i18n))
            .filter((node): node is HTMLElement => node !== null);
        const technical = detailsView(i18n, open, [
            el('div', { class: 'maestro-muted', text: t('ui.inbox.detailsKind', { kind: record.kind }) }),
            ...record.changes.map((change) => changeView(change, t)),
        ]);
        if (!human.length) return technical;
        return el('details', { class: 'maestro-journal-changes' }, [
            el('summary', { text: t('ui.journal.changes') }),
            ...human,
            technical,
        ]);
    };

    const recordView = (record: JournalRecord, redraw: () => void): HTMLElement => {
        const known = kindLabel(i18n, record.kind);
        const meta = [formatTime(record.at, i18n), moduleTitle(env.modules, i18n, record.module), known ?? ''];
        return el('div', { class: ['maestro-journal-row', record.undone ? 'maestro-undone' : null] }, [
            el('div', { class: 'maestro-journal-main' }, [
                el('div', { class: 'maestro-journal-summary', text: record.summary }),
                el('div', { class: 'maestro-muted', text: meta.filter(Boolean).join(' · ') }),
                changesView(record),
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
                        // A reply to the user's own click: always shown.
                        { level: ok ? 'info' : 'warn', importance: 'urgent' },
                    );
                    redraw();
                },
            }),
        ]);
    };

    const statsView = (): HTMLElement => {
        const stats = [...env.autonomy.stats()]
            .map((row) => ({ ...row, label: kindName(row.kind) }))
            .sort((a, b) => a.label.localeCompare(b.label));
        return section(
            t('ui.journal.stats'),
            table(
                [
                    { key: 'kind', label: t('ui.journal.kind'), cell: (row) => row.label },
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
