// Pult tab «Качество» (M12): the last verdicts (defects, quotes, what was done, «Проверить ещё раз», «Переделать»,
// «Не брак»), the action per defect kind (Выкл / Само / Уведомить), the judge and early-cutoff switches, the
// statistics with false-positive rates, the content boundary editor (§11) and the test mode. Mobile first: one
// column; the lists re-render on changes, the editors keep what is being typed.
import { DEFAULT_BOUNDARY_RULES } from '../../domain/quality-checks';
import { JUDGE_THRESHOLD } from '../../domain/quality-types';
import type { App, PultTab } from '../../shared/contracts';
import { banner, emptyState, section } from '../../ui/components/card';
import { field, select, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import type { Child } from '../../ui/components/dom';
import { table } from '../../ui/components/table';
import { coalesce, formatTime, formatUsd } from '../../ui/views/format';
import type { BoundaryRule, Defect, DefectAction, DefectKind, QualityVerdict } from './api';
import type { QualityService } from './service';
import { copyRules, DEFECT_KINDS, patternError, QUALITY_KEY } from './settings';
import type { QualitySettings } from './settings';

export const QUALITY_TAB = 'quality';
const VERDICTS_SHOWN = 20;

export const QUALITY_CSS = `
.maestro-m12 { display: flex; flex-direction: column; gap: 8px; }
.maestro-m12-list { display: flex; flex-direction: column; gap: 6px; }
.maestro-m12-item { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 6px 8px;
    display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
.maestro-m12-item.maestro-m12-gone { opacity: 0.65; }
.maestro-m12-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m12-name { font-weight: 600; }
.maestro-m12-small { font-size: 0.85em; opacity: 0.8; }
.maestro-m12-ok { color: var(--maestro-ok, #4a9d5b); }
.maestro-m12-bad { color: var(--maestro-warn, #d08a2c); }
.maestro-m12-defect { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.maestro-m12-quote { font-style: italic; opacity: 0.9; white-space: pre-wrap; }
.maestro-m12-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m12-rule { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 6px 8px;
    display: flex; flex-direction: column; gap: 6px; }
.maestro-m12-rule textarea, .maestro-m12-test textarea { width: 100%; min-height: 5em; font-family: monospace;
    font-size: 0.9em; box-sizing: border-box; }
.maestro-m12-error { color: var(--maestro-error, #c0392b); font-size: 0.85em; }
.maestro-m12-link { padding: 0 6px; min-height: 0; }
`;

function percent(value: number): string {
    return `${Math.round(value * 100)} %`;
}

function quoteText(quote: string): string {
    const text = quote.trim();
    return text ? `«${text}»` : '';
}

/** Opens a chat message (`/chat-jump` loads older messages first). */
async function jump(app: App, index: number): Promise<void> {
    app.ui.closePult?.();
    const ctx = app.host.ctx();
    if (typeof ctx.executeSlashCommandsWithOptions !== 'function') return;
    try {
        await ctx.executeSlashCommandsWithOptions(`/chat-jump ${index}`, { handleExecutionErrors: true });
    } catch (error) {
        app.log.debug('chat-jump failed', error);
    }
}

export function qualityTab(app: App, service: QualityService, settings: () => QualitySettings): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    const kindLabel = (kind: DefectKind) => t(`m12.kind.${kind}`);

    return {
        id: QUALITY_TAB,
        titleKey: 'm12.tab',
        icon: 'fa-clipboard-check',
        order: 52,
        render(container) {
            let alive = true;
            const root = el('div', { class: 'maestro-m12' });
            container.appendChild(root);
            const verdictsBox = el('div');
            const statsBox = el('div');
            const headBox = el('div');
            const rulesBox = el('div');
            let draft: BoundaryRule[] = service.boundary();
            let testText = '';
            let testResult: Defect[] | null = null;
            const testBox = el('div');

            /* -------------------------------------------- verdicts */

            const defectView = (verdict: QualityVerdict, defect: Defect, live: boolean): HTMLElement => {
                const status = defect.status ? t(`m12.status.${defect.status}`) : '';
                return el('div', { class: 'maestro-m12-defect' }, [
                    el('span', { class: 'maestro-m12-name', text: kindLabel(defect.kind) }),
                    el('span', {
                        class: 'maestro-m12-small',
                        text: [
                            percent(defect.confidence),
                            defect.suspected ? t('m12.defect.suspected') : '',
                            defect.by === 'judge' || defect.by.startsWith('judge:') ? t('m12.defect.byJudge') : '',
                            status,
                        ]
                            .filter(Boolean)
                            .join(' · '),
                        title: defect.by,
                    }),
                    defect.quote ? el('span', { class: 'maestro-m12-quote', text: quoteText(defect.quote) }) : null,
                    live && defect.status === 'notified'
                        ? button({
                              label: t('m12.badge.dismiss'),
                              kind: 'ghost',
                              className: 'maestro-m12-link',
                              onClick: () => service.dismiss(verdict.messageIndex, defect.kind),
                          })
                        : null,
                ]);
            };

            const verdictView = (verdict: QualityVerdict & { invalidated?: string }): HTMLElement => {
                const current = service.verdict(verdict.messageIndex);
                const live = !verdict.invalidated && current !== undefined && current.at === verdict.at;
                const open = verdict.defects.filter((defect) => defect.status === 'notified');
                const state = verdict.invalidated
                    ? t(`m12.invalidated.${verdict.invalidated}`)
                    : verdict.ok
                      ? t('m12.verdict.ok')
                      : t(`m12.action.${verdict.action}`);
                return el('div', { class: ['maestro-m12-item', live ? null : 'maestro-m12-gone'] }, [
                    el('div', { class: 'maestro-m12-head' }, [
                        el('span', {
                            class: 'maestro-m12-name',
                            text: t('m12.verdict.title', {
                                index: verdict.messageIndex + 1,
                                swipe: verdict.swipeId + 1,
                            }),
                        }),
                        el('span', {
                            class: ['maestro-m12-small', verdict.ok ? 'maestro-m12-ok' : 'maestro-m12-bad'],
                            text: state,
                        }),
                        el('span', { class: 'maestro-m12-small', text: formatTime(verdict.at, app.i18n) }),
                        verdict.judged
                            ? el('span', {
                                  class: 'maestro-m12-small',
                                  text: t('m12.verdict.judged', { cost: formatUsd(verdict.costUsd, app.i18n) }),
                              })
                            : null,
                    ]),
                    verdict.defects.length
                        ? el(
                              'div',
                              { class: 'maestro-m12-list' },
                              verdict.defects.map((defect) => defectView(verdict, defect, live)),
                          )
                        : el('div', { class: 'maestro-m12-small', text: t('m12.verdict.clean') }),
                    el('div', { class: 'maestro-m12-row' }, [
                        button({
                            label: t('m12.verdict.jump'),
                            icon: 'fa-location-arrow',
                            kind: 'ghost',
                            className: 'maestro-m12-link',
                            onClick: () => jump(app, verdict.messageIndex),
                        }),
                        live || verdict.invalidated === undefined
                            ? button({
                                  label: t('m12.verdict.recheck'),
                                  icon: 'fa-rotate',
                                  kind: 'ghost',
                                  className: 'maestro-m12-link',
                                  onClick: async () => {
                                      await service.check(verdict.messageIndex);
                                  },
                              })
                            : null,
                        live && open.length
                            ? button({
                                  label: t('m12.badge.redo'),
                                  icon: 'fa-wand-magic-sparkles',
                                  className: 'maestro-m12-link',
                                  onClick: () => service.redo(verdict.messageIndex),
                              })
                            : null,
                    ]),
                ]);
            };

            const drawVerdicts = (): void => {
                clear(verdictsBox);
                const list = (service.history?.() ?? []).slice(0, VERDICTS_SHOWN);
                verdictsBox.appendChild(
                    section(
                        t('m12.verdicts'),
                        list.length
                            ? el('div', { class: 'maestro-m12-list' }, list.map(verdictView))
                            : emptyState(t('m12.verdicts.empty'), 'fa-clipboard-check'),
                    ),
                );
            };

            /* -------------------------------------------- head, actions, switches */

            const drawHead = (): void => {
                clear(headBox);
                const parts: Child[] = [el('div', { class: 'maestro-hint', text: t('m12.hint') })];
                if (service.isEconomy()) parts.push(banner(t('m12.economy'), 'info', 'fa-leaf'));
                parts.push(
                    el('div', {
                        class: 'maestro-m12-small',
                        text: t(service.naiGateActive() ? 'm12.nai.on' : 'm12.nai.off'),
                    }),
                );
                headBox.appendChild(section(t('m12.title'), parts));
            };

            const actionsView = (): HTMLElement => {
                const options = (kind: DefectKind): { value: DefectAction; label: string }[] =>
                    (['off', 'auto', 'notify'] as const)
                        .filter((value) => kind !== 'boundary' || value !== 'auto')
                        .map((value) => ({ value, label: t(`m12.actionSetting.${value}`) }));
                const rows = DEFECT_KINDS.map((kind) =>
                    field(
                        kindLabel(kind),
                        select<DefectAction>({
                            value: service.configuredAction(kind),
                            options: options(kind),
                            label: kindLabel(kind),
                            onChange: (value) => service.setAction(kind, value),
                        }),
                        t(`m12.kindHint.${kind}`),
                    ),
                );
                const slice = settings();
                const save = (key: 'judge' | 'earlyCutoff', value: boolean) => {
                    slice[key] = value;
                    app.settings.notify(`modules.${QUALITY_KEY}.${key}`);
                    app.settings.save();
                };
                return section(t('m12.actions'), [
                    el('div', { class: 'maestro-hint', text: t('m12.actions.hint') }),
                    ...rows,
                    toggle({
                        label: t('m12.judge'),
                        hint: t('m12.judge.hint'),
                        checked: slice.judge,
                        onChange: (value) => save('judge', value),
                    }),
                    toggle({
                        label: t('m12.cutoff'),
                        hint: t('m12.cutoff.hint'),
                        checked: slice.earlyCutoff,
                        onChange: (value) => save('earlyCutoff', value),
                    }),
                ]);
            };

            /* -------------------------------------------- statistics */

            const drawStats = (): void => {
                clear(statsBox);
                const stats = service.stats();
                statsBox.appendChild(
                    section(t('m12.stats'), [
                        table(
                            [
                                { key: 'kind', label: t('m12.stats.kind'), cell: (row) => kindLabel(row.kind) },
                                {
                                    key: 'detected',
                                    label: t('m12.stats.detected'),
                                    cell: (row) => String(row.detected),
                                    numeric: true,
                                },
                                {
                                    key: 'fp',
                                    label: t('m12.stats.falsePositives'),
                                    cell: (row) => String(row.falsePositives),
                                    numeric: true,
                                },
                                {
                                    key: 'rate',
                                    label: t('m12.stats.rate'),
                                    cell: (row) =>
                                        row.detected > 0 ? percent(row.falsePositives / row.detected) : '—',
                                    numeric: true,
                                },
                                {
                                    key: 'auto',
                                    label: t('m12.stats.auto'),
                                    cell: (row) => String(row.autoActions),
                                    numeric: true,
                                },
                            ],
                            stats,
                            { caption: t('m12.stats') },
                        ),
                        el('div', { class: 'maestro-m12-small', text: t('m12.stats.hint') }),
                    ]),
                );
            };

            /* -------------------------------------------- boundary editor */

            const ruleView = (rule: BoundaryRule, index: number): HTMLElement => {
                const errors = el('div', { class: 'maestro-m12-error' });
                const showErrors = () => {
                    const bad = rule.patterns.map(patternError).filter((item): item is string => item !== null);
                    errors.textContent = bad.length ? t('m12.boundary.badPattern', { pattern: bad.join(', ') }) : '';
                };
                const title = el('input', {
                    class: 'text_pole',
                    attrs: { type: 'text', 'aria-label': t('m12.boundary.ruleTitle') },
                });
                title.value = rule.title;
                title.addEventListener('input', () => {
                    rule.title = title.value;
                });
                const patterns = el('textarea', {
                    class: 'text_pole',
                    attrs: { rows: 4, 'aria-label': t('m12.boundary.patterns') },
                });
                patterns.value = rule.patterns.join('\n');
                patterns.addEventListener('input', () => {
                    rule.patterns = patterns.value
                        .split('\n')
                        .map((line) => line.trim())
                        .filter(Boolean);
                    showErrors();
                });
                showErrors();
                return el('div', { class: 'maestro-m12-rule' }, [
                    el('div', { class: 'maestro-m12-row' }, [
                        toggle({
                            label: t('m12.boundary.enabled'),
                            checked: rule.enabled,
                            onChange: (value) => {
                                rule.enabled = value;
                            },
                        }),
                        button({
                            label: t('m12.boundary.remove'),
                            icon: 'fa-trash',
                            kind: 'ghost',
                            className: 'maestro-m12-link',
                            onClick: () => {
                                draft.splice(index, 1);
                                drawRules();
                            },
                        }),
                    ]),
                    field(t('m12.boundary.ruleTitle'), title),
                    field(t('m12.boundary.patterns'), patterns),
                    errors,
                ]);
            };

            const drawRules = (): void => {
                clear(rulesBox);
                rulesBox.appendChild(
                    section(t('m12.boundary'), [
                        el('div', { class: 'maestro-hint', text: t('m12.boundary.hint') }),
                        draft.length
                            ? el('div', { class: 'maestro-m12-list' }, draft.map(ruleView))
                            : emptyState(t('m12.boundary.empty'), 'fa-shield-halved'),
                        el('div', { class: 'maestro-m12-row' }, [
                            button({
                                label: t('m12.boundary.add'),
                                icon: 'fa-plus',
                                onClick: () => {
                                    draft.push({
                                        id: `rule-${Date.now().toString(36)}`,
                                        title: '',
                                        patterns: [],
                                        enabled: true,
                                    });
                                    drawRules();
                                },
                            }),
                            button({
                                label: t('m12.boundary.reset'),
                                icon: 'fa-rotate-left',
                                kind: 'ghost',
                                onClick: () => {
                                    draft = copyRules(DEFAULT_BOUNDARY_RULES);
                                    drawRules();
                                },
                            }),
                            button({
                                label: t('m12.boundary.save'),
                                icon: 'fa-floppy-disk',
                                kind: 'primary',
                                onClick: async () => {
                                    const bad = draft.some(
                                        (rule) => !rule.patterns.length || rule.patterns.some((p) => patternError(p)),
                                    );
                                    // Replies to his «Сохранить»: always shown.
                                    if (bad) {
                                        app.ui.notice(t('m12.boundary.invalid'), { level: 'warn', urgent: true });
                                        return;
                                    }
                                    await service.setBoundary(draft);
                                    draft = service.boundary();
                                    drawRules();
                                    app.ui.notice(t('m12.boundary.saved'), { urgent: true });
                                },
                            }),
                        ]),
                    ]),
                );
            };

            /* -------------------------------------------- test mode */

            const drawTestResult = (): void => {
                clear(testBox);
                if (testResult === null) return;
                testBox.appendChild(
                    testResult.length
                        ? el(
                              'div',
                              { class: 'maestro-m12-list' },
                              testResult.map((defect) =>
                                  el('div', { class: 'maestro-m12-defect' }, [
                                      el('span', { class: 'maestro-m12-name', text: kindLabel(defect.kind) }),
                                      el('span', {
                                          class: 'maestro-m12-small',
                                          text: [
                                              percent(defect.confidence),
                                              defect.by,
                                              defect.confidence < JUDGE_THRESHOLD ? t('m12.test.judge') : '',
                                          ]
                                              .filter(Boolean)
                                              .join(' · '),
                                      }),
                                      defect.quote
                                          ? el('span', { class: 'maestro-m12-quote', text: quoteText(defect.quote) })
                                          : null,
                                  ]),
                              ),
                          )
                        : emptyState(t('m12.test.clean'), 'fa-circle-check'),
                );
            };

            const testView = (): HTMLElement => {
                const area = el('textarea', { class: 'text_pole', attrs: { rows: 6, 'aria-label': t('m12.test') } });
                area.value = testText;
                area.addEventListener('input', () => {
                    testText = area.value;
                });
                drawTestResult();
                return section(t('m12.test'), [
                    el('div', { class: 'maestro-hint', text: t('m12.test.hint') }),
                    el('div', { class: 'maestro-m12-test' }, [area]),
                    el('div', { class: 'maestro-m12-row' }, [
                        button({
                            label: t('m12.test.run'),
                            icon: 'fa-vial',
                            onClick: () => {
                                testResult = testText.trim() ? (service.test?.(testText, draft) ?? []) : null;
                                drawTestResult();
                            },
                        }),
                    ]),
                    testBox,
                ]);
            };

            /* -------------------------------------------- assembly */

            const draw = (): void => {
                if (!alive) return;
                clear(root);
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('m12.noChat'), 'fa-clipboard-check'));
                } else if (app.host.isGroupChat()) {
                    root.appendChild(banner(t('m12.group'), 'warn', 'fa-users'));
                }
                drawHead();
                drawVerdicts();
                drawStats();
                drawRules();
                root.append(headBox, verdictsBox, actionsView(), statsBox, rulesBox, testView());
            };

            const refresh = coalesce(() => {
                if (!alive) return;
                drawHead();
                drawVerdicts();
                drawStats();
            }, 50);
            const offChange = service.onChange(refresh);
            const offChat = app.bus.on('chat:changed', () => {
                if (alive) draw();
            });
            draw();
            return () => {
                alive = false;
                refresh.cancel();
                offChange();
                offChat();
            };
        },
    };
}
