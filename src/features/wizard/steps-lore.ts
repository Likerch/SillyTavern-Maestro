// Wizard steps 4–5: the Doctor's findings (regex inventory included) and the stage 1 rules with before/after
// comparison and book caps (plan §7 пп. 3–4, M20 п. 2, M22). Doctor, Rules and the lore journal are other modules:
// they are used only through app.modules.api and may be off.
import { charsToTokens, suggestBookCaps } from '../../domain/doctor-budget';
import type { CapSuggestion } from '../../domain/doctor-budget';
import type { App, JournalChange, WizardStep } from '../../shared/contracts';
import { badge, banner, emptyState } from '../../ui/components/card';
import { field, numberInput, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import type { DoctorApi, Finding } from '../doctor/api';
import type { LoreJournalApi } from '../loreJournal/api';
import type { RuleImpact, RuleKind, RuleState, RulesApi } from '../rules/api';
import { onNext } from './leave';
import type { WizardSettings } from './settings';

/** Rule kinds the wizard offers (neighbour rules are switched by their owners). */
const OFFERED_KINDS: readonly RuleKind[] = ['lore', 'prompt', 'display', 'ui'];
export const BOOK_CAP_RULE = 'book.cap';
/** Journal targets of the wizard (undo handlers in index.ts). */
export const RULE_TARGET = 'wizard-rule';
export const CAPS_TARGET = 'wizard-book-caps';

/** Optional extension of RulesApi for rule parameters (book caps); used only when the rules module offers it. */
export type RulesWithOptions = RulesApi & {
    setOptions?(id: string, options: Record<string, unknown>): void | Promise<void>;
    options?(id: string): Record<string, unknown> | undefined;
};

function errorText(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function localize(app: App, finding: Finding): string {
    const params: Record<string, string | number> = {};
    for (const [key, value] of Object.entries(finding.params ?? {})) {
        params[key] = key === 'type' && typeof value === 'string' ? app.i18n.t(`m5.regexType.${value}`) : value;
    }
    return app.i18n.t(finding.messageKey, params);
}

export function findingsStep(app: App): WizardStep {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: 'w1.findings',
        order: 50,
        titleKey: 'w1.findings.title',
        render(container, done) {
            const doctor = app.modules.api<DoctorApi>('doctor');
            if (!doctor) {
                container.append(banner(t('w1.findings.off'), 'info', 'fa-circle-info'));
                done();
                return;
            }
            const body = el('div', { class: 'maestro-w1-findings' });
            container.append(el('p', { text: t('w1.findings.intro') }), body);
            const run = async (): Promise<void> => {
                clear(body);
                body.append(el('div', { class: 'maestro-muted', text: t('w1.findings.scanning') }));
                let findings: Finding[];
                let regexCount: number;
                try {
                    findings = await doctor.scan();
                    regexCount = (await doctor.regexInventory()).length;
                } catch (error) {
                    clear(body);
                    body.append(banner(t('w1.findings.failed', { error: errorText(error) }), 'error'));
                    done();
                    return;
                }
                const count = (severity: Finding['severity']) =>
                    findings.filter((finding) => finding.severity === severity).length;
                clear(body);
                body.append(
                    el('div', { class: 'maestro-row' }, [
                        badge(
                            t('w1.findings.counts', {
                                error: count('error'),
                                warn: count('warn'),
                                info: count('info'),
                            }),
                            count('error') ? 'error' : count('warn') ? 'warn' : 'ok',
                        ),
                        badge(t('w1.findings.regexes', { count: regexCount }), 'info'),
                    ]),
                    findings.length
                        ? el('div', {}, [
                              el('h4', { text: t('w1.findings.top') }),
                              el(
                                  'ul',
                                  { class: 'maestro-w1-top' },
                                  findings
                                      .filter((finding) => finding.severity !== 'info')
                                      .slice(0, 5)
                                      .map((finding) => el('li', { text: localize(app, finding) })),
                              ),
                          ])
                        : emptyState(t('w1.findings.none')),
                    el('div', { class: 'maestro-actions' }, [
                        button({
                            label: t('w1.findings.open'),
                            icon: 'fa-stethoscope',
                            onClick: () => app.ui.openPult('doctor'),
                        }),
                        button({ label: t('w1.findings.rescan'), icon: 'fa-rotate', kind: 'ghost', onClick: run }),
                    ]),
                );
                done();
            };
            void run();
        },
    };
}

/** Per-turn book sizes from the lore journal (M1), or the Doctor's static sizes as a fallback. */
async function capSuggestions(app: App): Promise<{ list: CapSuggestion[]; perTurn: boolean }> {
    const journal = app.modules.api<LoreJournalApi>('loreJournal');
    try {
        const summary = journal?.summary();
        if (summary && summary.turns > 0 && summary.heaviestBooks.length) {
            const rows = summary.heaviestBooks.map((row) => ({ book: row.world, chars: row.avgChars }));
            return { list: suggestBookCaps(rows, { minChars: 8000 }), perTurn: true };
        }
    } catch (error) {
        app.log.debug('lore journal summary failed', error);
    }
    const doctor = app.modules.api<DoctorApi>('doctor');
    if (!doctor) return { list: [], perTurn: false };
    try {
        if (!doctor.lastScanAt?.()) await doctor.scan();
        const rows = (doctor.bookStats?.() ?? []).map((row) => ({ book: row.book, chars: row.chars }));
        return { list: suggestBookCaps(rows), perTurn: false };
    } catch (error) {
        app.log.debug('doctor book stats failed', error);
        return { list: [], perTurn: false };
    }
}

function impactView(app: App, impact: RuleImpact): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const locale = app.i18n.locale() === 'ru' ? 'ru-RU' : 'en-US';
    const list = (items: RuleImpact['removed']) =>
        items
            .slice(0, 5)
            .map((item) => `«${item.comment || `#${item.uid}`}» (${item.world})`)
            .join(', ') + (items.length > 5 ? ', …' : '');
    if (impact.charsDelta === 0 && !impact.removed.length && !impact.added.length)
        return el('div', { class: 'maestro-muted', text: t('w1.rules.noChange') });
    const delta = `${impact.charsDelta > 0 ? '+' : impact.charsDelta < 0 ? '−' : ''}${Math.abs(impact.charsDelta).toLocaleString(locale)}`;
    return el('div', { class: 'maestro-w1-impact' }, [
        el('div', { text: t('w1.rules.delta', { delta }) }),
        impact.removed.length
            ? el('div', {
                  class: 'maestro-muted',
                  text: t('w1.rules.removed', { count: impact.removed.length, list: list(impact.removed) }),
              })
            : null,
        impact.added.length
            ? el('div', {
                  class: 'maestro-muted',
                  text: t('w1.rules.added', { count: impact.added.length, list: list(impact.added) }),
              })
            : null,
    ]);
}

/** Applies the rule choices and book caps; journals what changed. Exported for tests. */
export async function applyRuleChoices(
    app: App,
    settings: WizardSettings,
    choices: Map<string, boolean>,
    caps: Map<string, number>,
): Promise<number> {
    const rules = app.modules.api<RulesWithOptions>('rules');
    if (!rules) return 0;
    const changes: JournalChange[] = [];
    for (const [id, wanted] of choices) {
        const before = rules.isEnabled(id);
        if (before === wanted) continue;
        await rules.setEnabled(id, wanted);
        changes.push({ target: RULE_TARGET, ref: { rule: id }, before, after: wanted });
    }
    const after: Record<string, number> = {};
    for (const [book, tokens] of caps) if (tokens > 0) after[book] = Math.round(tokens);
    const before = currentCaps(app, settings);
    if (JSON.stringify(before) !== JSON.stringify(after) && (caps.size || Object.keys(before).length)) {
        await writeCaps(app, settings, after);
        changes.push({ target: CAPS_TARGET, ref: { rule: BOOK_CAP_RULE }, before, after });
    }
    if (changes.length) {
        await app.journal.record({
            module: 'W1',
            kind: 'wizard.rules',
            summary: app.i18n.t('w1.rules.journal', { count: changes.length }),
            changes,
        });
    }
    return changes.length;
}

/** Caps known to the rules module (if it takes options) or kept by the wizard. */
export function currentCaps(app: App, settings: WizardSettings): Record<string, number> {
    const rules = app.modules.api<RulesWithOptions>('rules');
    const fromRules = rules?.options?.(BOOK_CAP_RULE)?.caps;
    const source =
        fromRules && typeof fromRules === 'object' ? (fromRules as Record<string, unknown>) : settings.bookCaps;
    const caps: Record<string, number> = {};
    for (const [book, value] of Object.entries(source)) if (typeof value === 'number' && value > 0) caps[book] = value;
    return caps;
}

/** Hands caps to the rules module when it takes options; otherwise keeps them in the wizard slice. */
export async function writeCaps(app: App, settings: WizardSettings, caps: Record<string, number>): Promise<void> {
    const rules = app.modules.api<RulesWithOptions>('rules');
    if (typeof rules?.setOptions === 'function') {
        await rules.setOptions(BOOK_CAP_RULE, { caps: { ...caps } });
    }
    settings.bookCaps = { ...caps };
    app.settings.save();
    app.settings.notify('wizard.bookCaps');
}

export function rulesStep(app: App, settings: WizardSettings, alive: () => boolean): WizardStep {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: 'w1.rules',
        order: 60,
        titleKey: 'w1.rules.title',
        render(container, done) {
            const rules = app.modules.api<RulesWithOptions>('rules');
            if (!rules) {
                container.append(banner(t('w1.rules.off'), 'info', 'fa-circle-info'));
                done();
                return;
            }
            let offered: RuleState[] = [];
            try {
                offered = rules
                    .list()
                    .filter((rule) => rule.definition.stage === 1 && OFFERED_KINDS.includes(rule.definition.kind));
            } catch (error) {
                app.log.warn('rules list failed', error);
            }
            const firstRun = !app.settings.core().firstRunDone;
            const choices = new Map<string, boolean>(
                offered.map((rule) => [rule.id, firstRun ? rule.definition.enabledByDefault : rule.enabled]),
            );
            const caps = new Map<string, number>(Object.entries(currentCaps(app, settings)));

            const ruleRows = offered.map((rule) => {
                const result = el('div', { class: 'maestro-w1-compare' });
                return el('div', { class: 'maestro-w1-rule', data: { rule: rule.id } }, [
                    toggle({
                        label: t(rule.definition.titleKey),
                        checked: choices.get(rule.id) === true,
                        onChange: (checked) => {
                            choices.set(rule.id, checked);
                        },
                    }),
                    el('div', { class: 'maestro-hint', text: t(rule.definition.descriptionKey) }),
                    rule.definition.kind === 'lore'
                        ? button({
                              label: t('w1.rules.compare'),
                              icon: 'fa-scale-balanced',
                              kind: 'ghost',
                              onClick: async () => {
                                  clear(result);
                                  result.append(el('div', { class: 'maestro-muted', text: t('w1.rules.comparing') }));
                                  try {
                                      const impact = await rules.compare([rule.id]);
                                      clear(result);
                                      result.append(impactView(app, impact));
                                  } catch (error) {
                                      clear(result);
                                      result.append(
                                          el('div', {
                                              class: 'maestro-error-text',
                                              text: t('w1.rules.compareFailed', { error: errorText(error) }),
                                          }),
                                      );
                                  }
                              },
                          })
                        : null,
                    result,
                ]);
            });

            const capsBox = el('div', { class: 'maestro-w1-caps' }, [
                el('div', { class: 'maestro-muted', text: t('w1.caps.loading') }),
            ]);
            void capSuggestions(app).then(({ list, perTurn }) => {
                clear(capsBox);
                for (const suggestion of list)
                    if (!caps.has(suggestion.book)) caps.set(suggestion.book, suggestion.capTokens);
                const known = new Map(list.map((item) => [item.book, item]));
                if (!caps.size) {
                    capsBox.append(el('div', { class: 'maestro-muted', text: t('w1.caps.none') }));
                    return;
                }
                for (const [book, value] of caps) {
                    const info = known.get(book);
                    capsBox.append(
                        field(
                            t('w1.caps.label', { book }),
                            numberInput({
                                value,
                                min: 0,
                                step: 500,
                                label: t('w1.caps.label', { book }),
                                onChange: (next) => {
                                    caps.set(book, next);
                                },
                            }),
                            info
                                ? t(perTurn ? 'w1.caps.current' : 'w1.caps.static', {
                                      tokens: charsToTokens(info.currentChars).toLocaleString(
                                          app.i18n.locale() === 'ru' ? 'ru-RU' : 'en-US',
                                      ),
                                  })
                                : undefined,
                        ),
                    );
                }
            });

            const apply = async (): Promise<void> => {
                try {
                    await applyRuleChoices(app, settings, choices, caps);
                } catch (error) {
                    app.ui.notice(t('w1.rules.applyFailed', { error: errorText(error) }), { level: 'error' });
                }
            };

            container.append(
                el('p', { text: t('w1.rules.intro') }),
                offered.length ? el('div', { class: 'maestro-w1-rules' }, ruleRows) : emptyState(t('w1.rules.none')),
                el('h4', { text: t('w1.caps.title') }),
                el('div', { class: 'maestro-hint', text: t('w1.caps.intro') }),
                capsBox,
            );
            const hooked = onNext(
                container,
                apply,
                (error) => app.log.error('wizard rules apply failed', error),
                alive,
            );
            if (!hooked) {
                container.append(
                    el('div', { class: 'maestro-actions' }, [
                        button({
                            label: t('w1.rules.apply'),
                            icon: 'fa-check',
                            kind: 'primary',
                            onClick: async () => {
                                await apply();
                                app.ui.notice(t('w1.rules.applied'));
                            },
                        }),
                    ]),
                );
            }
            done();
        },
    };
}
