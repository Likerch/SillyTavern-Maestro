// Pult tab «Лор хода» (M1): the lore of a turn, which key fired, why each book is active, chat summaries and the
// "what if" dry run. Everything heavy (key matching, dry run) runs only on a button press.
import type { App, PultTab } from '../../shared/contracts';
import { badge, banner, emptyState, MODULE_SETTINGS_CLASS, section } from '../../ui/components/card';
import { field, numberInput, select } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { table } from '../../ui/components/table';
import type { Column } from '../../ui/components/table';
import { formatTime } from '../../ui/views/format';
import type { BookActivationReason, LoreActivation, LoreSummaryRow, TurnLoreRecord } from './api';
import type { LoreJournal, LoreJournalSettings } from './journal';

export const TURN_TAB = 'turn';
const TURN_CHOICES = 30;
const NEVER_ACTIVE_SHOWN = 30;

export const M1_CSS = `
.maestro-m1-line { margin: 2px 0; }
.maestro-m1-actions { display: flex; flex-wrap: wrap; gap: 6px; margin: 8px 0; align-items: center; }
.maestro-m1-tags { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 3px; }
.maestro-m1-tags .maestro-badge-pill { font-size: 0.75em; }
.maestro-m1-cut { text-decoration: line-through; opacity: 0.65; }
.maestro-m1-why { display: flex; flex-direction: column; gap: 6px; }
.maestro-m1-why-row { display: flex; flex-wrap: wrap; align-items: center; gap: 6px; }
.maestro-m1-book { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m1-entry { overflow-wrap: anywhere; }
.maestro-m1-details > summary { cursor: pointer; margin: 6px 0; }
`;

export function turnTab(app: App, journal: LoreJournal, settings: LoreJournalSettings): PultTab {
    const i18n = app.i18n;
    const t = i18n.t.bind(i18n);
    const number = (value: number): string => {
        try {
            return new Intl.NumberFormat(i18n.locale() === 'ru' ? 'ru-RU' : 'en-US').format(value);
        } catch {
            return String(value);
        }
    };

    const entryTitle = (row: { comment?: string; uid?: number }): string =>
        row.comment || t('m1.entry.untitled', { uid: row.uid ?? '?' });

    const placeLabel = (row: LoreActivation): string => {
        if (row.position === 4) {
            const role = t(`m1.role.${row.role ?? 0}`);
            return t('m1.pos.4', { depth: row.depth ?? 4, role });
        }
        return row.position >= 0 && row.position <= 7
            ? t(`m1.pos.${row.position}`)
            : t('m1.pos.other', { position: row.position });
    };

    const activationTable = (record: TurnLoreRecord): HTMLElement => {
        const titleOf = (world: string, uid: number): string => {
            const found = record.activations.find((row) => row.world === world && row.uid === uid);
            return found ? entryTitle(found) : entryTitle({ uid });
        };
        const columns: Column<LoreActivation>[] = [
            {
                key: 'book',
                label: t('m1.col.book'),
                cell: (row) => el('span', { class: 'maestro-m1-book', text: row.world }),
            },
            {
                key: 'entry',
                label: t('m1.col.entry'),
                cell: (row) => [
                    el('span', {
                        class: ['maestro-m1-entry', row.cut ? 'maestro-m1-cut' : null],
                        text: entryTitle(row),
                    }),
                    row.tags.length
                        ? el(
                              'div',
                              { class: 'maestro-m1-tags' },
                              row.tags.map((tag) => badge(t(`m1.tag.${tag}`), 'muted')),
                          )
                        : null,
                ],
            },
            { key: 'place', label: t('m1.col.place'), cell: (row) => placeLabel(row) },
            { key: 'chars', label: t('m1.col.chars'), numeric: true, cell: (row) => number(row.chars) },
            { key: 'tokens', label: t('m1.col.tokens'), numeric: true, cell: (row) => number(row.tokens) },
            {
                key: 'loop',
                label: t('m1.col.loop'),
                cell: (row) =>
                    row.recursionLevel > 0
                        ? t('m1.loop.recursion', { loop: row.loop, level: row.recursionLevel })
                        : t('m1.loop.direct', { loop: row.loop }),
            },
            {
                key: 'via',
                label: t('m1.col.via'),
                cell: (row) =>
                    row.via ? `${row.via.world} › ${titleOf(row.via.world, row.via.uid)}` : t('m1.via.none'),
            },
            {
                key: 'key',
                label: t('m1.col.key'),
                cell: (row) => (row.key === undefined ? t('m1.key.pending') : row.key || t('m1.key.none')),
            },
            {
                key: 'cut',
                label: t('m1.col.cut'),
                cell: (row) => (row.cut ? t(`m1.cut.${row.cutBy ?? 'other'}`) : ''),
            },
        ];
        return table(columns, record.activations, { caption: t('m1.turn.title') });
    };

    const recordHead = (record: TurnLoreRecord, summaryKey: 'm1.turn.summary' | 'm1.sim.result'): Child[] => {
        const active = record.activations.filter((row) => !row.cut);
        const cut = record.activations.length - active.length;
        return [
            el('div', {
                class: 'maestro-m1-line',
                text: t(summaryKey, {
                    count: active.length,
                    chars: number(record.totalChars),
                    tokens: number(record.totalTokens),
                }),
            }),
            record.budgetTokens !== undefined
                ? el('div', {
                      class: 'maestro-m1-line maestro-muted',
                      text: t('m1.turn.budget', {
                          budget: number(record.budgetTokens),
                          percent:
                              record.budgetTokens > 0
                                  ? Math.round((record.totalTokens / record.budgetTokens) * 100)
                                  : 0,
                      }),
                  })
                : null,
            cut
                ? el('div', { class: 'maestro-m1-line maestro-muted', text: t('m1.turn.cutCount', { count: cut }) })
                : null,
            record.overflow ? banner(t('m1.turn.overflow'), 'warn') : null,
        ];
    };

    const summaryTable = (rows: LoreSummaryRow[], columns: Column<LoreSummaryRow>[]): HTMLElement =>
        rows.length ? table(columns, rows) : el('div', { class: 'maestro-muted', text: t('m1.summary.none') });

    const bookColumn: Column<LoreSummaryRow> = {
        key: 'book',
        label: t('m1.col.book'),
        cell: (row) => el('span', { class: 'maestro-m1-book', text: row.world }),
    };
    const entryColumn: Column<LoreSummaryRow> = {
        key: 'entry',
        label: t('m1.col.entry'),
        cell: (row) => el('span', { class: 'maestro-m1-entry', text: entryTitle(row) }),
    };

    const summaryView = (): HTMLElement => {
        const summary = journal.summary();
        if (!summary.turns) return section(t('m1.summary.title'), emptyState(t('m1.summary.empty'), 'fa-chart-simple'));
        const never = summary.neverActive;
        return section(t('m1.summary.title'), [
            el('div', { class: 'maestro-m1-line', text: t('m1.summary.turns', { turns: summary.turns }) }),
            el('div', {
                class: 'maestro-m1-line',
                text: t('m1.summary.avg', { chars: number(summary.avgTotalChars) }),
            }),
            el('div', {
                class: 'maestro-m1-line',
                text: t('m1.summary.canon', { chars: number(summary.avgCanonChars) }),
            }),
            el('h5', { text: t('m1.summary.books') }),
            summaryTable(summary.heaviestBooks, [
                bookColumn,
                { key: 'perTurn', label: t('m1.col.perTurn'), numeric: true, cell: (row) => number(row.avgChars) },
                {
                    key: 'activations',
                    label: t('m1.col.activations'),
                    numeric: true,
                    cell: (row) => number(row.activations),
                },
            ]),
            el('h5', { text: t('m1.summary.entries') }),
            summaryTable(summary.heaviestEntries, [
                entryColumn,
                bookColumn,
                {
                    key: 'activations',
                    label: t('m1.col.activations'),
                    numeric: true,
                    cell: (row) => number(row.activations),
                },
                { key: 'avg', label: t('m1.col.avgChars'), numeric: true, cell: (row) => number(row.avgChars) },
                {
                    key: 'last',
                    label: t('m1.col.lastSeen'),
                    numeric: true,
                    cell: (row) => (row.lastSeenTurn === undefined ? '' : `#${row.lastSeenTurn}`),
                },
            ]),
            el('h5', { text: t('m1.summary.always') }),
            summaryTable(summary.alwaysActive, [
                entryColumn,
                bookColumn,
                { key: 'avg', label: t('m1.col.avgChars'), numeric: true, cell: (row) => number(row.avgChars) },
            ]),
            el('details', { class: 'maestro-m1-details' }, [
                el('summary', { text: t('m1.summary.never', { count: never.length }) }),
                el('div', { class: 'maestro-hint', text: t('m1.summary.neverHint') }),
                summaryTable(never.slice(0, NEVER_ACTIVE_SHOWN), [
                    entryColumn,
                    bookColumn,
                    { key: 'chars', label: t('m1.col.chars'), numeric: true, cell: (row) => number(row.avgChars) },
                ]),
            ]),
        ]);
    };

    const reasonsView = (reasons: BookActivationReason[] | null): HTMLElement =>
        section(
            t('m1.why.title'),
            reasons === null
                ? el('div', { class: 'maestro-muted', text: t('m1.why.loading') })
                : reasons.length
                  ? el(
                        'div',
                        { class: 'maestro-m1-why' },
                        reasons.map((row) =>
                            el('div', { class: 'maestro-m1-why-row' }, [
                                el('span', { class: 'maestro-m1-book', text: row.book }),
                                ...row.reasons.map((reason) => badge(t(`m1.reason.${reason}`), 'info')),
                            ]),
                        ),
                    )
                  : emptyState(t('m1.why.empty'), 'fa-book'),
        );

    return {
        id: TURN_TAB,
        titleKey: 'm1.tab',
        icon: 'fa-book-open',
        order: 20,
        render(container) {
            let alive = true;
            let selectedAt: number | null = null;
            let simulation: TurnLoreRecord | null = null;
            let simNote = '';
            let keysNote = '';
            let reasons: BookActivationReason[] | null = null;

            const keysButton = (record: TurnLoreRecord, apply: (updated: TurnLoreRecord) => void): HTMLElement =>
                button({
                    label: t('m1.turn.keys'),
                    icon: 'fa-key',
                    title: t('m1.turn.keysHint'),
                    onClick: async () => {
                        const updated = await journal.attributeKeys(record);
                        const matched = updated.activations.filter((row) => row.key).length;
                        keysNote = t('m1.turn.keysDone', { found: matched, total: updated.activations.length });
                        apply(updated);
                        draw();
                    },
                });

            const turnView = (): HTMLElement => {
                const records = journal.turns();
                const record =
                    (selectedAt !== null ? records.find((item) => item.at === selectedAt) : undefined) ??
                    records[records.length - 1];
                const picker =
                    records.length > 1
                        ? select({
                              label: t('m1.turn.pick'),
                              value: String(record?.at ?? ''),
                              options: records
                                  .slice(-TURN_CHOICES)
                                  .reverse()
                                  .map((item) => ({
                                      value: String(item.at),
                                      label: t('m1.turn.option', {
                                          index: item.messageIndex,
                                          type: item.generationType,
                                          time: formatTime(item.at, i18n),
                                      }),
                                  })),
                              onChange: (value) => {
                                  selectedAt = Number(value);
                                  keysNote = '';
                                  draw();
                              },
                          })
                        : null;
                if (!record) return section(t('m1.turn.title'), emptyState(t('m1.turn.empty'), 'fa-book-open'));
                return section(
                    t('m1.turn.title'),
                    [
                        ...recordHead(record, 'm1.turn.summary'),
                        el('div', { class: 'maestro-m1-actions' }, [
                            keysButton(record, () => undefined),
                            keysNote ? el('span', { class: 'maestro-muted', text: keysNote }) : null,
                        ]),
                        activationTable(record),
                    ],
                    picker ?? undefined,
                );
            };

            const simulationView = (): HTMLElement => {
                const last = journal.last();
                const body: Child[] = [
                    el('div', { class: 'maestro-hint', text: t('m1.sim.hint') }),
                    banner(t('m1.sim.caveat'), 'info', 'fa-circle-info'),
                    el('div', { class: 'maestro-m1-actions' }, [
                        button({
                            label: t('m1.sim.run'),
                            icon: 'fa-flask',
                            kind: 'primary',
                            onClick: async () => {
                                if (app.turn.current()) {
                                    simNote = t('m1.sim.busy');
                                    draw();
                                    return;
                                }
                                try {
                                    simulation = await journal.simulate();
                                    simNote = '';
                                } catch (error) {
                                    simNote = t('m1.sim.failed', {
                                        error: error instanceof Error ? error.message : String(error),
                                    });
                                }
                                draw();
                            },
                        }),
                        simNote ? el('span', { class: 'maestro-warn-text', text: simNote }) : null,
                    ]),
                ];
                if (simulation) {
                    const sim = simulation;
                    body.push(...recordHead(sim, 'm1.sim.result'));
                    if (last) {
                        const ids = (record: TurnLoreRecord): Set<string> =>
                            new Set(
                                record.activations
                                    .filter((row) => !row.cut)
                                    .map((row) => `${row.world}\u0000${row.uid}`),
                            );
                        const now = ids(sim);
                        const before = ids(last);
                        const added = [...now].filter((id) => !before.has(id)).length;
                        const removed = [...before].filter((id) => !now.has(id)).length;
                        body.push(
                            el('div', {
                                class: 'maestro-m1-line maestro-muted',
                                text: t('m1.sim.diff', { added, removed }),
                            }),
                        );
                    }
                    body.push(
                        el('div', { class: 'maestro-m1-actions' }, [
                            keysButton(sim, (updated) => {
                                simulation = updated;
                            }),
                        ]),
                        activationTable(sim),
                    );
                }
                return section(t('m1.sim.title'), body);
            };

            const settingsView = (): HTMLElement =>
                el('details', { class: ['maestro-m1-details', MODULE_SETTINGS_CLASS] }, [
                    el('summary', { text: t('m1.settings.title') }),
                    field(
                        t('m1.settings.keepTurns'),
                        numberInput({
                            value: settings.keepTurns,
                            min: 10,
                            max: 2000,
                            step: 10,
                            label: t('m1.settings.keepTurns'),
                            onChange: (value) => {
                                settings.keepTurns = Math.round(value);
                                app.settings.notify('modules.loreJournal.keepTurns');
                                app.settings.save();
                            },
                        }),
                        t('m1.settings.keepTurnsHint'),
                    ),
                ]);

            const draw = (): void => {
                if (!alive) return;
                clear(container);
                if (!app.host.chatId()) {
                    container.append(el('div', { class: 'maestro-view' }, [emptyState(t('m1.noChat'), 'fa-comments')]));
                    return;
                }
                container.append(
                    el('div', { class: 'maestro-view maestro-m1' }, [
                        turnView(),
                        simulationView(),
                        reasonsView(reasons),
                        summaryView(),
                        settingsView(),
                    ]),
                );
            };

            const offTurn = journal.onTurn(() => {
                selectedAt = null;
                keysNote = '';
                draw();
            });
            void journal.ensureLoaded().then(draw);
            void journal
                .whyActive()
                .then((rows) => {
                    reasons = rows;
                    draw();
                })
                .catch((error: unknown) => {
                    app.log.warn('why-active failed', error);
                    reasons = [];
                    draw();
                });
            draw();
            return () => {
                alive = false;
                offTurn();
            };
        },
    };
}
