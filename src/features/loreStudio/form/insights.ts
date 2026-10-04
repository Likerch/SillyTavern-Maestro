// What the stack knows about this entry: activations in the lore journal of the chat (M1; plan M23 new
// possibility 5), doctor findings that point at it with the M22 rule that fixes them on the fly (new possibility
// 12), and the tester «Проверить срабатывание» (new possibility 6) — which keys match a text, by ST's own logic.
import { testEntry } from '../../../domain/lore-form-keys';
import type { EntryTestResult, KeyHit } from '../../../domain/lore-form-keys';
import { entryActivationStats, findingTargetsEntry } from '../../../domain/lore-form-stats';
import { badge, emptyState } from '../../../ui/components/card';
import { uid as domId } from '../../../ui/components/controls';
import { button, el } from '../../../ui/components/dom';
import { formatTime } from '../../../ui/views/format';
import type { Finding } from '../../doctor/api';
import type { TurnLoreRecord } from '../../loreJournal/api';
import { formSection, row } from './controls';
import { GLOBAL_NAMES, RULES_TAB_ID, doctorApi, globalValue, loreJournalApi, rulesApi } from './env';
import type { FormEnv } from './env';

function percent(value: number): string {
    return `${Math.round(value * 100)}%`;
}

function analyticsBlock(env: FormEnv): HTMLElement {
    const t = env.t;
    const journal = loreJournalApi(env.app);
    const box = el('div', { class: 'maestro-m23f-stats' });
    if (!journal) {
        box.append(el('div', { class: 'maestro-m23f-hint', text: t('m23f.stats.noJournal') }));
        return box;
    }
    let turns: TurnLoreRecord[];
    try {
        turns = journal.turns();
    } catch (error) {
        env.app.log.debug('journal turns failed', error);
        turns = [];
    }
    const stats = entryActivationStats(turns, env.ctx.book, env.ctx.uid);
    if (!stats.turns) {
        box.append(emptyState(t('m23f.stats.noTurns'), 'fa-scroll'));
        return box;
    }
    const last = stats.recent[0];
    const keyLine = el('div', { class: 'maestro-kv' }, [
        el('span', { text: t('m23f.stats.lastKey') }),
        el('span', { text: stats.lastKey ?? '—' }),
    ]);
    box.append(
        el('div', { class: 'maestro-kv' }, [
            el('span', { text: t('m23f.stats.frequency') }),
            el('span', {
                text: t('m23f.stats.frequencyValue', {
                    count: stats.activations,
                    turns: stats.turns,
                    percent: percent(stats.frequency),
                }),
            }),
        ]),
        el('div', { class: 'maestro-kv' }, [
            el('span', { text: t('m23f.stats.last') }),
            el('span', {
                text: last
                    ? t('m23f.stats.lastValue', { index: last.messageIndex, time: formatTime(last.at, env.app.i18n) })
                    : t('m23f.stats.never'),
            }),
        ]),
        el('div', { class: 'maestro-kv' }, [
            el('span', { text: t('m23f.stats.avgChars') }),
            el('span', { text: stats.avgChars ? String(stats.avgChars) : '—' }),
        ]),
        keyLine,
    );
    if (stats.cut) {
        box.append(
            el('div', {
                class: 'maestro-m23f-hint maestro-warn-text',
                text: t('m23f.stats.cut', { count: stats.cut }),
            }),
        );
    }
    if (stats.recent.length) {
        box.append(
            el('div', { class: 'maestro-m23f-label', text: t('m23f.stats.recent') }),
            el(
                'ul',
                { class: 'maestro-m23f-list maestro-m23f-recent' },
                stats.recent.map((item) =>
                    el('li', {
                        class: item.cut ? 'maestro-warn-text' : undefined,
                        text: [
                            t('m23f.stats.recentItem', {
                                index: item.messageIndex,
                                time: formatTime(item.at, env.app.i18n),
                                chars: item.chars,
                            }),
                            item.key ? t('m23f.stats.recentKey', { key: item.key }) : null,
                            item.recursionLevel
                                ? t('m23f.stats.recentRecursion', { level: item.recursionLevel })
                                : null,
                            item.cut ? t('m23f.stats.recentCut') : null,
                        ]
                            .filter(Boolean)
                            .join(' · '),
                    }),
                ),
            ),
        );
    }
    if (last && !stats.lastKey) {
        // M1 attributes keys lazily (ST does not record them): ask for the turn of the last activation.
        const record = turns.find((turn) => turn.messageIndex === last.messageIndex && !turn.simulated);
        if (record) {
            keyLine.append(
                button({
                    label: t('m23f.stats.findKey'),
                    kind: 'ghost',
                    onClick: async () => {
                        const done = await journal.attributeKeys(record);
                        const hit = done.activations.find(
                            (item) => item.world === env.ctx.book && item.uid === env.ctx.uid,
                        );
                        keyLine.replaceChildren(
                            el('span', { text: t('m23f.stats.lastKey') }),
                            el('span', { text: hit?.key || t('m23f.stats.noKey') }),
                        );
                    },
                }),
            );
        }
    }
    return box;
}

function findingText(env: FormEnv, finding: Finding): string {
    return env.app.i18n.t(finding.messageKey, finding.params);
}

function doctorBlock(env: FormEnv): HTMLElement {
    const t = env.t;
    const doctor = doctorApi(env.app);
    const box = el('div', { class: 'maestro-m23f-findings' });
    if (!doctor) {
        box.append(el('div', { class: 'maestro-m23f-hint', text: t('m23f.doctor.off') }));
        return box;
    }
    let findings: Finding[];
    try {
        findings = doctor
            .findings()
            .filter((finding) => findingTargetsEntry(finding.target, env.ctx.book, env.ctx.uid));
    } catch (error) {
        env.app.log.debug('doctor findings failed', error);
        findings = [];
    }
    if (!findings.length) {
        box.append(el('div', { class: 'maestro-m23f-hint', text: t('m23f.doctor.none') }));
        return box;
    }
    const rules = rulesApi(env.app);
    box.append(
        el(
            'ul',
            { class: 'maestro-m23f-list' },
            findings.map((finding) => {
                const rule = finding.fixRule ? rules?.list().find((item) => item.id === finding.fixRule) : undefined;
                return el('li', { class: 'maestro-m23f-finding' }, [
                    badge(t(`m23f.doctor.sev.${finding.severity}`), finding.severity),
                    el('span', { text: ` ${findingText(env, finding)}` }),
                    finding.fixRule
                        ? el('div', { class: 'maestro-m23f-row-inline' }, [
                              el('span', {
                                  class: 'maestro-m23f-hint',
                                  text: rule
                                      ? t(rule.enabled ? 'm23f.doctor.ruleOn' : 'm23f.doctor.ruleOff', {
                                            rule: env.app.i18n.t(rule.definition.titleKey),
                                        })
                                      : t('m23f.doctor.ruleUnknown', { rule: finding.fixRule }),
                              }),
                              button({
                                  label: t('m23f.doctor.openRules'),
                                  icon: 'fa-wand-magic-sparkles',
                                  kind: 'ghost',
                                  onClick: () => env.app.ui.openPult(RULES_TAB_ID),
                              }),
                          ])
                        : null,
                ]);
            }),
        ),
    );
    return box;
}

export function insightsSection(env: FormEnv): HTMLElement {
    const t = env.t;
    return formSection(
        t('m23f.section.insights'),
        [
            el('div', { class: 'maestro-m23f-label', text: t('m23f.stats.title') }),
            analyticsBlock(env),
            el('div', { class: 'maestro-m23f-label', text: t('m23f.doctor.title') }),
            doctorBlock(env),
        ],
        { id: 'insights', open: false },
    );
}

/* ------------------------------------------------------------------ tester */

function hitList(env: FormEnv, title: string, hits: KeyHit[]): HTMLElement | null {
    if (!hits.length) return null;
    return el('div', { class: 'maestro-m23f-test-keys' }, [
        el('div', { class: 'maestro-m23f-label', text: title }),
        el(
            'div',
            { class: 'maestro-m23f-chips' },
            hits.map((hit) =>
                el(
                    'span',
                    {
                        class: ['maestro-m23f-chip', hit.matched ? 'maestro-m23f-chip-hit' : 'maestro-m23f-chip-miss'],
                        title: hit.matched ? env.t('m23f.test.hit') : env.t('m23f.test.miss'),
                    },
                    [el('span', { text: hit.matched ? '✓ ' : '✗ ' }), el('span', { text: hit.key })],
                ),
            ),
        ),
    ]);
}

function outcomeText(env: FormEnv, result: EntryTestResult): string {
    const t = env.t;
    if (result.outcome === 'secondaryFailed')
        return t('m23f.test.secondaryFailed', { logic: t(`m23f.logic.${result.logic}`) });
    return t(`m23f.test.outcome.${result.outcome}`);
}

export function testerSection(env: FormEnv): HTMLElement {
    const t = env.t;
    const id = domId('maestro-m23f-test');
    const input = el('textarea', {
        class: 'text_pole maestro-m23f-textarea',
        attrs: { id, rows: 3, placeholder: t('m23f.test.placeholder') },
    });
    const output = el('div', { class: 'maestro-m23f-test-out', attrs: { 'aria-live': 'polite' } });
    const run = () => {
        const text = input.value;
        if (!text.trim()) {
            output.replaceChildren(el('div', { class: 'maestro-m23f-hint', text: t('m23f.test.enterText') }));
            return;
        }
        const globals = {
            caseSensitive: globalValue(env.state.globals, [...GLOBAL_NAMES.caseSensitive], 'boolean') ?? false,
            matchWholeWords: globalValue(env.state.globals, [...GLOBAL_NAMES.matchWholeWords], 'boolean') ?? false,
        };
        let substitute = (value: string) => value;
        try {
            const ctx = env.app.host.ctx();
            if (typeof ctx.substituteParams === 'function') substitute = (value) => ctx.substituteParams(value);
        } catch {
            // No context (tests, early start): keys are matched as written.
        }
        const result = testEntry(env.state.draft, text, globals, substitute);
        const nodes: (HTMLElement | null)[] = [
            el(
                'div',
                { class: ['maestro-m23f-test-result', result.activates ? 'maestro-level-ok' : 'maestro-level-warn'] },
                [
                    el('strong', { text: result.activates ? t('m23f.test.yes') : t('m23f.test.no') }),
                    el('span', { text: ` ${outcomeText(env, result)}` }),
                ],
            ),
            hitList(env, t('m23f.test.primary'), result.primary),
            result.secondary.length
                ? hitList(
                      env,
                      result.secondaryUsed
                          ? t('m23f.test.secondary', { logic: t(`m23f.logic.${result.logic}`) })
                          : t('m23f.test.secondaryIgnored'),
                      result.secondary,
                  )
                : null,
            el('div', { class: 'maestro-m23f-hint', text: t('m23f.test.scope') }),
        ];
        output.replaceChildren(...nodes.filter((node): node is HTMLElement => node !== null));
    };
    input.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
            event.preventDefault();
            event.stopPropagation();
            run();
        }
    });
    env.sync(() => {
        // Re-run with the edited keys when a result is on screen.
        if (output.firstChild && input.value.trim()) run();
    });
    return formSection(
        t('m23f.section.tester'),
        [
            row(env, { label: t('m23f.test.label'), control: input, for: id, hint: t('m23f.test.hint') }),
            el('div', { class: 'maestro-m23f-actions' }, [
                button({ label: t('m23f.test.run'), icon: 'fa-vial', kind: 'primary', onClick: run }),
            ]),
            output,
        ],
        { id: 'tester', open: false },
    );
}
