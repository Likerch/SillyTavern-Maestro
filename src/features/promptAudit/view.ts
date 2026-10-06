// M38 «Проверка промпта»: the report view (plan-2 §2 п. 4) — what was checked (the last turn or a test assembly), the
// buttons (rules, test assembly, the AI check with its estimate first), the conflicts grouped by importance: both
// quotes with their owners in plain words, why it matters, what it does on this model, the proposed fix as «было /
// стало» with the side to change and why, the scope switch (Везде / Этот персонаж / Этот чат) and «Исправить»,
// «Пропустить», «Не считать конфликтом»; ticked conflicts are fixed together (one undo); «Проверить ещё раз» after
// fixes. The element redraws itself on the service's changes until it leaves the page.
import { banner, emptyState } from '../../ui/components/card';
import { diffView } from '../../ui/components/diff';
import { button, el } from '../../ui/components/dom';
import { progressBar } from '../../ui/components/progress';
import { SEVERITIES } from '../../domain/prompt-audit-rules';
import type { FixScope } from '../../domain/prompt-audit-rules';
import type { App } from '../../shared/contracts';
import type { AuditConflict, AuditSide, FixPlan } from './api';
import { refLabel } from './labels';
import { AI_JOB } from './service';
import type { PromptAuditService } from './service';

/** What the user ticked and chose, kept per service across redraws (the studio redraws its tab often). */
interface ViewState {
    selected: Set<string>;
    scopes: Map<string, FixScope>;
    batchScope: FixScope;
}

const states = new WeakMap<PromptAuditService, ViewState>();

function stateOf(service: PromptAuditService): ViewState {
    let state = states.get(service);
    if (!state) {
        state = { selected: new Set(), scopes: new Map(), batchScope: 'global' };
        states.set(service, state);
    }
    return state;
}

function time(app: App, at: number): string {
    try {
        return new Date(at).toLocaleTimeString(app.i18n.locale() === 'ru' ? 'ru-RU' : 'en-US', {
            hour: '2-digit',
            minute: '2-digit',
        });
    } catch {
        return '';
    }
}

function money(usd: number): string {
    return usd < 0.01 ? '<$0.01' : `$${usd.toFixed(2)}`;
}

/** The report view; it redraws itself on the service's changes until it leaves the page. */
export function renderAuditReport(app: App, service: PromptAuditService): HTMLElement {
    const root = el('div', { class: 'maestro-m38 maestro-ui' });
    const state = stateOf(service);
    let attached = false;
    let off: (() => void) | null = null;
    const redraw = () => {
        if (root.isConnected) attached = true;
        else if (attached) {
            off?.();
            off = null;
            return;
        }
        draw(app, service, root, state, redraw);
    };
    off = service.onChange(redraw);
    draw(app, service, root, state, redraw);
    void service.ready().then(redraw);
    return root;
}

function draw(app: App, service: PromptAuditService, root: HTMLElement, state: ViewState, redraw: () => void): void {
    const t = app.i18n.t.bind(app.i18n);
    const report = service.report();
    const capture = service.capture();
    const busy = service.busy();
    const children: (HTMLElement | null)[] = [];
    children.push(el('p', { class: 'maestro-field-hint', text: t('m38.view.intro') }));

    /* what was checked */
    if (capture) {
        const parts = [
            capture.source === 'dry'
                ? t('m38.view.sourceDry', { time: time(app, capture.at) })
                : t('m38.view.sourceTurn', { time: time(app, capture.at) }),
            capture.preset ? t('m38.view.preset', { name: capture.preset }) : '',
            capture.connection?.model ? t('m38.view.model', { model: capture.connection.model }) : '',
            t('m38.view.items', { count: capture.items.length }),
        ].filter(Boolean);
        children.push(el('div', { class: 'maestro-muted maestro-m38-source', text: parts.join(' · ') }));
        if (capture.items.some((item) => item.fromTurn)) {
            children.push(el('div', { class: 'maestro-field-hint', text: t('m38.view.fromTurn') }));
        }
    } else {
        children.push(banner(t('m38.view.noCapture'), 'info', 'fa-circle-info'));
    }

    /* buttons */
    const estimate = service.aiEstimate();
    children.push(
        el('div', { class: 'maestro-row maestro-m38-toolbar' }, [
            button({
                icon: 'fa-list-check',
                label: t('m38.view.check'),
                kind: 'primary',
                className: 'maestro-m38-check',
                disabled: !!busy || !capture,
                onClick: async () => {
                    state.selected.clear();
                    await service.check();
                },
            }),
            button({
                icon: 'fa-flask',
                label: t('m38.view.dry'),
                className: 'maestro-m38-dry',
                title: t('m38.view.dryHint'),
                disabled: !!busy || !service.dryRunAvailable(),
                onClick: async () => {
                    state.selected.clear();
                    await service.check({ dry: true });
                },
            }),
            button({
                icon: 'fa-wand-magic-sparkles',
                label: t('m38.view.ai'),
                className: 'maestro-m38-ai',
                disabled: !!busy || !estimate,
                onClick: async () => {
                    const now = service.aiEstimate();
                    if (!now) return;
                    const ok = await app.ui.confirm(
                        t('m38.ai.confirmTitle'),
                        t('m38.ai.confirmBody', { tokens: now.inputTokens + now.outputTokens, cost: money(now.usd) }),
                    );
                    if (ok) await service.runAi();
                },
            }),
        ]),
    );
    if (estimate && !busy) {
        children.push(
            el('div', {
                class: 'maestro-field-hint maestro-m38-estimate',
                text: t('m38.view.estimate', {
                    tokens: estimate.inputTokens + estimate.outputTokens,
                    cost: money(estimate.usd),
                }),
            }),
        );
    }
    const job = service.jobs().get(AI_JOB);
    if (job?.state === 'active') {
        children.push(
            el('div', { class: 'maestro-m38-job' }, [
                progressBar(job.done, job.total, job.label ?? job.title),
                el('div', { class: 'maestro-row' }, [
                    el('span', { class: 'maestro-muted', text: job.label ?? job.title }),
                    button({
                        icon: 'fa-stop',
                        label: t('m38.view.stop'),
                        kind: 'ghost',
                        className: 'maestro-m38-stop',
                        onClick: () => {
                            service.jobs().cancel(AI_JOB);
                        },
                    }),
                ]),
            ]),
        );
    } else if (busy === 'dry' || busy === 'check' || busy === 'fix') {
        children.push(progressBar(undefined, undefined, t(`m38.view.busy.${busy}`)));
    }
    if (report?.ai?.error) {
        children.push(
            el('div', { class: 'maestro-warn-text', text: t('m38.view.aiError', { error: report.ai.error }) }),
        );
    }

    /* the report */
    if (report && capture) {
        const open = report.conflicts.filter((conflict) => conflict.status !== 'skipped');
        const counts = SEVERITIES.map((severity) => open.filter((conflict) => conflict.severity === severity).length);
        children.push(
            el('div', {
                class: 'maestro-m38-summary',
                text: open.length
                    ? t('m38.view.summary', { high: counts[0]!, medium: counts[1]!, low: counts[2]! })
                    : '',
            }),
        );
        if (!open.length) children.push(emptyState(t('m38.view.clean'), 'fa-circle-check'));
        if (report.hidden) {
            children.push(
                el('div', { class: 'maestro-row maestro-m38-hidden' }, [
                    el('span', { class: 'maestro-muted', text: t('m38.view.hidden', { count: report.hidden }) }),
                    button({
                        label: t('m38.view.restore'),
                        kind: 'ghost',
                        className: 'maestro-m38-restore',
                        onClick: () => service.restoreIgnored(),
                    }),
                ]),
            );
        }
        for (const severity of SEVERITIES) {
            const list = open.filter((conflict) => conflict.severity === severity);
            if (!list.length) continue;
            children.push(
                el('section', { class: 'maestro-m38-group', data: { severity } }, [
                    el('h4', { class: 'maestro-m34-h', text: t(`m38.severity.${severity}`) }),
                    ...list.map((conflict) => conflictCard(app, service, conflict, state, redraw)),
                ]),
            );
        }
        const selectable = open.filter((conflict) => state.selected.has(conflict.id) && conflict.status !== 'fixed');
        const fixed = report.conflicts.some((conflict) => conflict.status === 'fixed');
        if (selectable.length || fixed) {
            const scope = el('select', {
                class: 'text_pole maestro-m38-batch-scope',
                attrs: { 'aria-label': t('m38.view.scope') },
            });
            for (const value of ['global', 'character', 'chat'] as const) {
                scope.append(el('option', { text: t(`m38.scope.${value}`), attrs: { value } }));
            }
            scope.value = state.batchScope;
            scope.addEventListener('change', () => {
                state.batchScope = scope.value as FixScope;
            });
            children.push(
                el('div', { class: 'maestro-row maestro-m38-footer' }, [
                    selectable.length
                        ? el('label', { class: 'maestro-m34-label', text: t('m38.view.scope') }, [scope])
                        : null,
                    selectable.length
                        ? button({
                              icon: 'fa-screwdriver-wrench',
                              label: t('m38.view.fixSelected', { count: selectable.length }),
                              kind: 'primary',
                              className: 'maestro-m38-fix-selected',
                              disabled: !!busy,
                              onClick: async () => {
                                  const ids = selectable.map((conflict) => conflict.id);
                                  await service.fixMany(ids, state.batchScope);
                                  state.selected.clear();
                                  redraw();
                              },
                          })
                        : null,
                    fixed
                        ? button({
                              icon: 'fa-rotate',
                              label: t('m38.view.recheck'),
                              className: 'maestro-m38-recheck',
                              disabled: !!busy,
                              onClick: async () => {
                                  state.selected.clear();
                                  await service.check({ dry: false });
                              },
                          })
                        : null,
                ]),
            );
            if (fixed) children.push(el('div', { class: 'maestro-field-hint', text: t('m38.view.recheckHint') }));
        }
    } else if (capture) {
        children.push(el('div', { class: 'maestro-muted', text: t('m38.view.notChecked') }));
    }
    root.replaceChildren(...children.filter((child): child is HTMLElement => child !== null));
}

function quoteBlock(app: App, service: PromptAuditService, side: AuditSide): HTMLElement {
    return el('div', { class: 'maestro-m38-quote' }, [
        el('div', { class: 'maestro-m38-owner', text: refLabel(app, service.capture(), side.ref) }),
        el('blockquote', { class: 'maestro-m38-text', text: side.quote }),
    ]);
}

function conflictCard(
    app: App,
    service: PromptAuditService,
    conflict: AuditConflict,
    state: ViewState,
    redraw: () => void,
): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const fixed = conflict.status === 'fixed';
    const plan = fixed ? null : service.plan(conflict.id, state.scopes.get(conflict.id));
    const canFix = !!plan && plan.scopes.length > 0;
    const head = el('div', { class: 'maestro-m38-head' }, [
        canFix
            ? el('input', {
                  class: 'maestro-m38-select',
                  attrs: {
                      type: 'checkbox',
                      'aria-label': t('m38.view.select'),
                      checked: state.selected.has(conflict.id),
                  },
                  on: {
                      change: (event) => {
                          const box = event.target as HTMLInputElement;
                          if (box.checked) state.selected.add(conflict.id);
                          else state.selected.delete(conflict.id);
                          redraw();
                      },
                  },
              })
            : null,
        el('strong', { text: conflict.title }),
        el('span', {
            class: 'maestro-m34-badge maestro-m34-badge-layer',
            text: t(conflict.source === 'ai' ? 'm38.view.byAi' : 'm38.view.byRules'),
        }),
        fixed ? el('span', { class: 'maestro-m34-badge maestro-m38-fixed', text: t('m38.view.fixed') }) : null,
    ]);
    const card = el('div', { class: 'maestro-m38-conflict', data: { id: conflict.id, severity: conflict.severity } }, [
        head,
        quoteBlock(app, service, conflict.a),
        conflict.b ? quoteBlock(app, service, conflict.b) : null,
        conflict.also?.length
            ? el('div', {
                  class: 'maestro-muted maestro-m38-also',
                  text: t('m38.view.also', {
                      names: conflict.also.map((side) => refLabel(app, service.capture(), side.ref)).join(', '),
                  }),
              })
            : null,
        el('p', { class: 'maestro-m38-why', text: conflict.why }),
        conflict.risk
            ? el('p', {
                  class: 'maestro-warn-text maestro-m38-risk',
                  text: t('m38.view.risk', { risk: conflict.risk }),
              })
            : null,
    ]);
    if (plan) card.append(fixBlock(app, service, conflict, plan, state, redraw));
    if (!fixed) {
        card.append(
            el('div', { class: 'maestro-row maestro-m38-actions' }, [
                button({
                    icon: 'fa-forward',
                    label: t('m38.view.skip'),
                    kind: 'ghost',
                    className: 'maestro-m38-skip',
                    onClick: () => {
                        state.selected.delete(conflict.id);
                        service.skip(conflict.id);
                    },
                }),
                button({
                    icon: 'fa-eye-slash',
                    label: t('m38.view.ignore'),
                    kind: 'ghost',
                    className: 'maestro-m38-ignore',
                    title: t('m38.view.ignoreHint'),
                    onClick: () => {
                        state.selected.delete(conflict.id);
                        service.ignore(conflict.id);
                    },
                }),
            ]),
        );
    }
    card.append(
        el('details', { class: 'maestro-m38-details' }, [
            el('summary', { text: t('m38.view.details') }),
            el('div', {
                class: 'maestro-muted maestro-m38-tech',
                text: [
                    conflict.a.ref,
                    conflict.b?.ref,
                    conflict.fix ? `${conflict.fix.kind} → ${conflict.fix.target}` : '',
                ]
                    .filter(Boolean)
                    .join(' · '),
            }),
        ]),
    );
    return card;
}

function fixBlock(
    app: App,
    service: PromptAuditService,
    conflict: AuditConflict,
    plan: FixPlan,
    state: ViewState,
    redraw: () => void,
): HTMLElement {
    const t = app.i18n.t.bind(app.i18n);
    const block = el('div', { class: 'maestro-m38-fix' }, [
        el('div', { class: 'maestro-m38-fix-target', text: t('m38.view.fixTarget', { target: plan.target }) }),
        plan.reason ? el('div', { class: 'maestro-field-hint', text: plan.reason }) : null,
    ]);
    if (plan.kind === 'edit' || plan.kind === 'remove') {
        block.append(
            el('div', { class: 'maestro-m38-diff' }, [
                el('div', { class: 'maestro-muted', text: t('m38.view.wasBecame') }),
                diffView(plan.before, plan.after, t),
            ]),
        );
    } else {
        block.append(
            el('div', {
                class: 'maestro-m38-diff',
                text: t('m38.view.stateChange', { before: plan.before, after: plan.after }),
            }),
        );
    }
    if (plan.warning) block.append(el('div', { class: 'maestro-warn-text', text: plan.warning }));
    if (plan.advice) {
        block.append(el('div', { class: 'maestro-m38-advice', text: plan.advice }));
        return block;
    }
    const chosen = state.scopes.get(conflict.id);
    const scope: FixScope = chosen && plan.scopes.includes(chosen) ? chosen : (plan.scopes[0] ?? 'global');
    const controls: (HTMLElement | null)[] = [];
    if (plan.scopes.length > 1) {
        const select = el('select', {
            class: 'text_pole maestro-m38-scope',
            attrs: { 'aria-label': t('m38.view.scope') },
        });
        for (const value of plan.scopes)
            select.append(el('option', { text: t(`m38.scope.${value}`), attrs: { value } }));
        select.value = scope;
        select.addEventListener('change', () => {
            state.scopes.set(conflict.id, select.value as FixScope);
        });
        controls.push(el('label', { class: 'maestro-m34-label', text: t('m38.view.scope') }, [select]));
    }
    controls.push(
        button({
            icon: 'fa-check',
            label: t('m38.view.fix'),
            kind: 'primary',
            className: 'maestro-m38-fix-one',
            disabled: !!service.busy(),
            onClick: async () => {
                await service.fix(conflict.id, state.scopes.get(conflict.id) ?? scope);
                state.selected.delete(conflict.id);
                redraw();
            },
        }),
    );
    block.append(el('div', { class: 'maestro-row' }, controls));
    return block;
}

export const M38_CSS = `
.maestro-m38 { display: flex; flex-direction: column; gap: 8px; }
.maestro-m38-toolbar, .maestro-m38-footer { flex-wrap: wrap; gap: 6px; }
.maestro-m38-group { display: flex; flex-direction: column; gap: 8px; }
.maestro-m38-conflict { border: 1px solid var(--maestro-border, var(--SmartThemeBorderColor)); border-radius: 8px;
  padding: 8px 10px; display: flex; flex-direction: column; gap: 6px; }
.maestro-m38-conflict[data-severity="high"] { border-left: 4px solid var(--maestro-danger, #c0392b); }
.maestro-m38-conflict[data-severity="medium"] { border-left: 4px solid var(--maestro-warn, #d68910); }
.maestro-m38-head { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.maestro-m38-owner { font-size: 0.9em; opacity: 0.85; }
.maestro-m38-text { margin: 2px 0 0; padding: 4px 8px; border-left: 3px solid var(--maestro-border, #888);
  white-space: pre-wrap; overflow-wrap: anywhere; }
.maestro-m38-why, .maestro-m38-risk { margin: 0; }
.maestro-m38-fix { display: flex; flex-direction: column; gap: 4px; padding: 6px 8px; border-radius: 6px;
  background: var(--maestro-surface-2, rgba(127,127,127,0.08)); }
.maestro-m38-fix-target { font-weight: 600; }
.maestro-m38-advice { white-space: pre-wrap; }
.maestro-m38-actions { gap: 6px; }
.maestro-m38-tech { overflow-wrap: anywhere; font-size: 0.85em; }
@media (max-width: 600px) { .maestro-m38-conflict { padding: 6px; } }
`;
