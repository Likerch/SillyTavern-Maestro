// Pult tab «Правила» (plan M22, §7): every rule with its switch, owner, stage, description, the changes of the last
// scan and a before/after comparison through M1; per-book caps with hints from the lore journal's summary.
import type { App, Decision, PultTab } from '../../shared/contracts';
import { banner, card, emptyState, section } from '../../ui/components/card';
import { field, numberInput, select, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { table } from '../../ui/components/table';
import { coalesce } from '../../ui/views/format';
import type { LoreJournalApi, LoreSummary, LoreSummaryRow } from '../loreJournal/api';
import type { BookCap, RuleChange, RuleImpact, RuleState } from './api';
import { CAP_RULE_ID, GAP_RULE_ID } from './builtin';
import { LORE_JOURNAL_KEY } from './engine';
import type { RulesEngine } from './engine';

export const RULES_TAB = 'rules';
const MAX_CHANGES = 30;
const MAX_ROWS = 50;
const MAX_RECURSION_LEVEL = 5;

export const RULES_VIEW_CSS = `
.maestro-rules-card .maestro-card-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    align-items: center;
}
.maestro-rules-description {
    margin-bottom: 4px;
}
.maestro-rules-impact {
    margin-top: 6px;
}
.maestro-rules-caps {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
    gap: 8px;
}
`;

type Translate = (key: string, params?: Record<string, string | number>) => string;

export function rulesTab(engine: RulesEngine, app: App): PultTab {
    const t: Translate = (key, params) => app.i18n.t(key, params);
    const lore = () => app.modules.api<LoreJournalApi>(LORE_JOURNAL_KEY);
    const num = (value: number): string => {
        try {
            return new Intl.NumberFormat(app.i18n.locale() === 'ru' ? 'ru-RU' : 'en-US').format(Math.round(value));
        } catch {
            return String(Math.round(value));
        }
    };
    const signed = (value: number): string => (value > 0 ? `+${num(value)}` : num(value));

    return {
        id: RULES_TAB,
        titleKey: 'm22.tab',
        icon: 'fa-sliders',
        order: 60,
        render(container) {
            const results = new Map<string, RuleImpact | string>();
            let disposed = false;

            const draw = (): void => {
                if (disposed) return;
                clear(container);
                container.append(el('div', { class: 'maestro-view maestro-rules' }, [rulesSection(), capsSection()]));
            };
            const redraw = coalesce(draw, 50);

            /* ---------------------------------------------------------- rules */

            const changesView = (changes: RuleChange[]): HTMLElement => {
                if (!changes.length) return el('div', { class: 'maestro-muted', text: t('m22.changesNone') });
                const shown = changes.slice(0, MAX_CHANGES);
                return el('details', {}, [
                    el('summary', { text: t('m22.changes', { count: changes.length }) }),
                    table(
                        [
                            { key: 'book', label: t('m22.col.book'), cell: (row: RuleChange) => row.world },
                            { key: 'entry', label: t('m22.col.entry'), cell: (row: RuleChange) => `#${row.uid}` },
                            { key: 'field', label: t('m22.col.field'), cell: (row: RuleChange) => row.field },
                            {
                                key: 'before',
                                label: t('m22.col.before'),
                                cell: (row: RuleChange) => String(row.before),
                            },
                            { key: 'after', label: t('m22.col.after'), cell: (row: RuleChange) => String(row.after) },
                        ],
                        shown,
                    ),
                    changes.length > shown.length
                        ? el('div', {
                              class: 'maestro-muted',
                              text: t('m22.changesMore', { count: changes.length - shown.length }),
                          })
                        : null,
                ]);
            };

            const activationTable = (rows: RuleImpact['removed']): HTMLElement =>
                table(
                    [
                        {
                            key: 'book',
                            label: t('m22.col.book'),
                            cell: (row: RuleImpact['removed'][number]) => row.world,
                        },
                        {
                            key: 'entry',
                            label: t('m22.col.entry'),
                            cell: (row: RuleImpact['removed'][number]) => row.comment || `#${row.uid}`,
                        },
                        {
                            key: 'chars',
                            label: t('m22.col.chars'),
                            numeric: true,
                            cell: (row: RuleImpact['removed'][number]) => num(row.chars),
                        },
                    ],
                    rows.slice(0, MAX_ROWS),
                );

            const impactView = (impact: RuleImpact | string): HTMLElement => {
                if (typeof impact === 'string') return el('div', { class: 'maestro-error-text', text: impact });
                if (!impact.removed.length && !impact.added.length && impact.charsDelta === 0) {
                    return el('div', { class: 'maestro-rules-impact maestro-muted', text: t('m22.compare.same') });
                }
                return el('div', { class: 'maestro-rules-impact' }, [
                    el('div', {
                        text: t('m22.compare.result', {
                            removed: impact.removed.length,
                            added: impact.added.length,
                            delta: signed(impact.charsDelta),
                        }),
                    }),
                    impact.removed.length
                        ? el('details', {}, [
                              el('summary', { text: t('m22.compare.removed') }),
                              activationTable(impact.removed),
                          ])
                        : null,
                    impact.added.length
                        ? el('details', {}, [
                              el('summary', { text: t('m22.compare.added') }),
                              activationTable(impact.added),
                          ])
                        : null,
                ]);
            };

            const onToggle = async (state: RuleState, checked: boolean): Promise<void> => {
                const decision: Decision = await engine.toggle(state.id, checked);
                if (decision !== 'applied' && engine.isEnabled(state.id) !== checked) {
                    const level = decision === 'queued' || decision === 'notified' ? 'info' : 'warn';
                    app.ui.notice(t('m22.toggle.notApplied', { decision }), { level });
                }
                draw();
            };

            const onCompare = async (state: RuleState): Promise<void> => {
                try {
                    results.set(state.id, await engine.compare([state.id]));
                } catch (error) {
                    results.set(
                        state.id,
                        t('m22.compare.failed', { error: error instanceof Error ? error.message : String(error) }),
                    );
                }
                draw();
            };

            const ruleCard = (state: RuleState): HTMLElement => {
                const def = state.definition;
                const isLore = !!(def.applyEntries || def.applyScanDone);
                const meta = t('m22.meta', {
                    owner: t(`m22.owner.${def.owner}`),
                    stage: def.stage,
                    kind: t(`m22.kind.${def.kind}`),
                });
                const body: Child[] = [el('div', { class: 'maestro-rules-description', text: t(def.descriptionKey) })];
                if (state.available === false) {
                    body.push(
                        el('div', {
                            class: 'maestro-warn-text',
                            text: t('m22.unavailable', { missing: (state.missing ?? []).join(', ') }),
                        }),
                    );
                }
                if (isLore && state.enabled && state.available !== false) body.push(changesView(state.lastChanges));
                if (def.id === GAP_RULE_ID) {
                    body.push(
                        field(
                            t('m22.gap.limit'),
                            numberInput({
                                value: engine.settings().gapGuardLimit,
                                min: 0,
                                max: 200,
                                step: 1,
                                label: t('m22.gap.limit'),
                                onChange: (value) => engine.setGapGuardLimit(value),
                            }),
                        ),
                    );
                }
                const result = results.get(def.id);
                if (result !== undefined) body.push(impactView(result));
                const actions: Child[] = [
                    toggle({
                        label: t('m22.toggle'),
                        checked: state.enabled,
                        hint: isLore ? t('m22.toggle.loreHint') : undefined,
                        onChange: (checked) => onToggle(state, checked),
                    }),
                ];
                if (isLore) {
                    actions.push(
                        button({
                            label: t('m22.compare'),
                            icon: 'fa-code-compare',
                            title: lore() ? undefined : t('m22.compare.noJournal'),
                            disabled: !lore() || state.available === false,
                            onClick: () => onCompare(state),
                        }),
                    );
                }
                return card({
                    title: t(def.titleKey),
                    subtitle: [
                        meta,
                        state.explicit ? t('m22.explicit') : t('m22.default'),
                        state.waiting ? t('m22.waiting') : '',
                    ]
                        .filter(Boolean)
                        .join(' · '),
                    level: state.available === false ? 'muted' : undefined,
                    body,
                    actions,
                    className: 'maestro-rules-card',
                });
            };

            const rulesSection = (): HTMLElement => {
                const children: Child[] = [el('p', { class: 'maestro-hint', text: t('m22.intro') })];
                if (!app.settings.core().firstRunDone)
                    children.push(banner(t('m22.firstRun'), 'info', 'fa-circle-info'));
                children.push(el('div', { class: 'maestro-cards' }, engine.list().map(ruleCard)));
                return section(
                    t('m22.section.rules'),
                    children,
                    button({ icon: 'fa-rotate', title: t('m22.refresh'), onClick: () => draw() }),
                );
            };

            /* ---------------------------------------------------------- book caps */

            const summary = (): LoreSummary | undefined => {
                try {
                    return lore()?.summary();
                } catch {
                    return undefined;
                }
            };

            const updateCap = (book: string, patch: BookCap): void => {
                engine.setBookCap(book, { ...engine.bookCaps()[book], ...patch });
            };

            const bookCard = (book: string, cap: BookCap, heavy: LoreSummaryRow | undefined, active: boolean) => {
                const notes = [
                    active ? null : t('m22.caps.inactive'),
                    heavy ? t('m22.caps.heavy', { chars: num(heavy.avgChars), count: heavy.activations }) : null,
                ].filter((note): note is string => !!note);
                const levels = Array.from({ length: MAX_RECURSION_LEVEL }, (_, index) => index + 1);
                return card({
                    title: book,
                    subtitle: notes.length ? notes.join(' · ') : undefined,
                    body: el('div', { class: 'maestro-rules-caps' }, [
                        field(
                            t('m22.caps.maxTokens'),
                            numberInput({
                                value: cap.maxTokens ?? 0,
                                min: 0,
                                step: 100,
                                label: t('m22.caps.maxTokens'),
                                onChange: (value) => updateCap(book, { maxTokens: value }),
                            }),
                        ),
                        field(
                            t('m22.caps.maxRecursion'),
                            select({
                                value: cap.maxRecursionLevel === undefined ? '' : String(cap.maxRecursionLevel),
                                label: t('m22.caps.maxRecursion'),
                                options: [
                                    { value: '', label: t('m22.caps.noLimit') },
                                    { value: '0', label: t('m22.caps.level0') },
                                    ...levels.map((level) => ({
                                        value: String(level),
                                        label: t('m22.caps.level', { level }),
                                    })),
                                ],
                                onChange: (value) =>
                                    updateCap(book, { maxRecursionLevel: value === '' ? undefined : Number(value) }),
                            }),
                        ),
                    ]),
                });
            };

            const capsSection = (): HTMLElement => {
                const caps = engine.bookCaps();
                const active = engine.activeBooks();
                const books = [...new Set([...active, ...Object.keys(caps)])].sort((a, b) => a.localeCompare(b));
                const heaviest = summary()?.heaviestBooks ?? [];
                const heavy = new Map(heaviest.map((row) => [row.world, row]));
                const children: Child[] = [el('p', { class: 'maestro-hint', text: t('m22.caps.hint') })];
                if (!engine.isActive(CAP_RULE_ID))
                    children.push(banner(t('m22.caps.ruleOff'), 'info', 'fa-circle-info'));
                if (heaviest.length) {
                    const list = heaviest
                        .slice(0, 3)
                        .map((row) => `${row.world} (${num(row.avgChars)})`)
                        .join(', ');
                    children.push(el('div', { class: 'maestro-muted', text: t('m22.caps.heaviest', { list }) }));
                }
                const cuts = engine.lastRealCuts();
                if (cuts.length)
                    children.push(
                        el('div', { class: 'maestro-muted', text: t('m22.caps.cut', { count: cuts.length }) }),
                    );
                if (!books.length) children.push(emptyState(t('m22.caps.none'), 'fa-book'));
                for (const book of books) {
                    children.push(bookCard(book, caps[book] ?? {}, heavy.get(book), active.includes(book)));
                }
                return section(t('m22.caps.title'), children);
            };

            draw();
            const offSettings = app.settings.onChange((path) => {
                if (path.startsWith('m22.') || path === 'core.firstRunDone') redraw();
            });
            return () => {
                disposed = true;
                offSettings();
                redraw.cancel();
            };
        },
    };
}
