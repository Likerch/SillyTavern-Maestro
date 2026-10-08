// The window «Подготовка к игре» (plan-2 §7 п. 2–5): a window of its own when the shell has windows (Ui.addWindow,
// docked right, wide; full screen on a phone), else the pult tab «Подготовка» with the same body. The step comes from
// the engine's state and the chat's draft (controller.ts), so closing the window, switching chats or a reload loses
// nothing that matters:
// 1. before the run — what will be read (and what not), the price «≈ $0.02, 3 части», the saved preparation of the
//    character (apply it, or read only what changed), [Начать];
// 2. the run — the job's progress («Читаю часть 2 из 3…») and «Остановить»;
// 3. the review (review.ts) — sections, cards, choices, edits, scopes;
// 4. the result — what was done in story words, each with «Отменить» and a link to the window that now holds it;
// 5. «Готово к игре» — what is still missing, with a button for each (a passport, the place, a background…).
import type { AnyPrepareItem, PrepareKind } from '../../domain/prepare-plan';
import { pluralForm } from '../../domain/plural';
import type { MaestroWindowSpec, PultTab, Unsubscribe, WindowContext } from '../../shared/contracts';
import { badge, banner, emptyState, section } from '../../ui/components/card';
import { toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import { progressBar } from '../../ui/components/progress';
import { coalesce, formatTime, formatUsd } from '../../ui/views/format';
import type { ApplyLine, MissingItem, PrepareStage, ReadyStatus, SavedPreparationInfo } from './api';
import { PREPARE_WINDOW } from './controller';
import type { PrepareUi } from './controller';
import { mergeSummary, stepOf, syncDraft } from './drafts';
import type { ChatDraft, PrepareStep } from './drafts';
import { jobProgress } from './offer';
import { reviewStep } from './review';
import { PREPARE_KEY, PREPARE_TAB } from './settings';

/** The section of another module that holds what an item became (its window opens from the result list). */
export const KIND_TAB: Readonly<Record<PrepareKind, string>> = {
    world: 'canon',
    time: 'canon',
    place: 'places',
    faction: 'canon',
    character: 'dossier',
    item: 'canon',
    tradition: 'canon',
    secret: 'knowledge',
    promise: 'calendar',
    mechanic: 'mechanics',
    scene: 'wardrobe',
    direction: 'director',
};
const BACKGROUNDS_TAB = 'backgrounds';
const DOSSIER_TAB = 'dossier';
const STEPS: readonly PrepareStep[] = ['start', 'running', 'review', 'done'];

export const PREPARE_CSS = `
.maestro-m37w { overflow-wrap: anywhere; }
/* A window body of its own does not scroll (the studios scroll inside): this one scrolls itself. */
.maestro-window-custom > .maestro-m37w {
    min-height: 0; overflow-y: auto; overscroll-behavior: contain; padding: 12px 14px 20px;
}
.maestro-window-sheet > .maestro-window-custom > .maestro-m37w {
    padding: 10px 10px calc(24px + env(safe-area-inset-bottom));
}
.maestro-m37w-steps { display: flex; flex-wrap: wrap; gap: 2px 14px; font-size: 0.9em; color: var(--maestro-muted); }
.maestro-m37w-steps .maestro-on { color: var(--maestro-accent); font-weight: 600; }
.maestro-m37w-nav { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m37w-nav .maestro-btn { margin: 0; padding: 2px 8px; font-size: 0.9em; }
.maestro-m37w-sections { display: flex; flex-direction: column; gap: var(--maestro-gap); }
.maestro-m37w-section-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--maestro-gap-sm); }
.maestro-m37w-section-head .maestro-section-title { margin: 0; }
.maestro-m37w-items { display: flex; flex-direction: column; gap: var(--maestro-gap-sm); }
.maestro-m37w-item {
    display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
    border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); background: var(--maestro-raised);
}
.maestro-m37w-item.maestro-m37w-off { opacity: 0.6; }
.maestro-m37w-item.maestro-m37w-conflict { border-color: var(--maestro-warn); }
.maestro-m37w-head { display: flex; flex-wrap: wrap; align-items: center; gap: var(--maestro-gap-sm); }
.maestro-m37w-check { display: flex; align-items: center; gap: 8px; flex: 1 1 12em; min-width: 0; cursor: pointer; }
.maestro-m37w-check input { margin: 0; flex: none; }
.maestro-m37w-title { font-weight: 600; }
.maestro-m37w-scope { width: auto; min-width: 9em; margin: 0; }
.maestro-m37w-facts, .maestro-m37w-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m37w-fact, .maestro-m37w-chip {
    padding: 1px 8px; border-radius: 999px; font-size: 0.85em;
    background: var(--maestro-raised-strong); color: var(--maestro-muted);
}
.maestro-m37w-conflicts { border-left: 3px solid var(--maestro-warn); padding-left: 8px; font-size: 0.92em; }
.maestro-m37w-quote { font-style: italic; color: var(--maestro-muted); white-space: pre-wrap; }
.maestro-m37w-edit { display: flex; flex-direction: column; gap: 6px; }
.maestro-m37w-field { display: flex; flex-direction: column; gap: 2px; color: var(--maestro-text); }
.maestro-m37w-field .text_pole { margin: 0; width: 100%; box-sizing: border-box; }
.maestro-m37w-field textarea { min-height: 4.5em; resize: vertical; }
.maestro-m37w-cost { font-weight: 600; font-size: 1.05em; }
.maestro-m37w-footer {
    position: sticky; bottom: 0; z-index: 1; display: flex; flex-wrap: wrap; align-items: center;
    gap: var(--maestro-gap-sm); padding: 8px 0; background: var(--maestro-surface);
    border-top: 1px solid var(--maestro-border);
}
.maestro-m37w-footer .maestro-m37w-buttons { margin-left: auto; }
.maestro-m37w-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--maestro-gap-sm); }
.maestro-m37w-line > .maestro-m37w-text { flex: 1 1 14em; min-width: 0; }
.maestro-m37w-line .maestro-btn { margin: 0; }
.maestro-m37w-undone .maestro-m37w-text { text-decoration: line-through; color: var(--maestro-muted); }
.maestro-m37w-failed .maestro-m37w-text { color: var(--maestro-warn); }
.maestro-m37w-job { display: flex; flex-direction: column; gap: 8px; }
@media screen and (max-width: 1000px) {
    .maestro-m37w-footer .maestro-m37w-buttons { margin-left: 0; width: 100%; }
    .maestro-m37w-footer .maestro-btn-primary { flex: 1 1 100%; }
    .maestro-m37w-scope { flex: 1 1 100%; }
}
@media (hover: none) {
    .maestro-m37w-check input { width: 22px; height: 22px; }
    .maestro-m37w-line .maestro-btn, .maestro-m37w-footer .maestro-btn { min-height: var(--maestro-tap); }
}
`;

/** The window's body (also the pult tab's): draws the step of the current chat and keeps it current. */
export function renderPrepare(container: HTMLElement, ui: PrepareUi, ctx?: WindowContext): Unsubscribe {
    const { app, engine } = ui;
    const t = ui.t.bind(ui);
    const root = el('div', { class: 'maestro-view maestro-m37w' });
    container.appendChild(root);
    const unwatch = engine.watch?.();
    // The card or its books may have changed since the last opening: the price is worked out again.
    const opened = ui.draft();
    if (opened.estimate?.state !== 'loading') opened.estimate = null;
    let alive = true;
    let signature = '';
    let jobBlock: { key: string | null; update(): void } | null = null;
    /** «Готово к игре» of the current result, by the state it was read for. */
    let status: { key: string; value?: ReadyStatus | null } | null = null;

    const report = (error: unknown) =>
        app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'error', urgent: true });

    const steps = (current: PrepareStep): HTMLElement =>
        el(
            'div',
            { class: 'maestro-m37w-steps', attrs: { role: 'list' } },
            STEPS.map((step, index) =>
                el('span', {
                    class: [step === current ? 'maestro-on' : null],
                    text: `${index + 1}. ${t(`m37.ui.step.${step}`)}`,
                    attrs: { role: 'listitem', 'aria-current': step === current ? 'step' : null },
                }),
            ),
        );

    /* ------------------------------------------------------------ step 1: what will be read, the price */

    const estimateOf = (draft: ChatDraft, reuse: boolean): void => {
        if (draft.estimate && draft.estimate.reuse === reuse) return;
        const slot: NonNullable<ChatDraft['estimate']> = { reuse, state: 'loading' };
        draft.estimate = slot;
        void engine
            .estimate(reuse ? { reuse: true } : {})
            .then((result) => {
                slot.state = 'done';
                slot.result = result;
            })
            .catch((error: unknown) => {
                slot.state = 'error';
                slot.error = error instanceof Error ? error.message : String(error);
            })
            .finally(() => {
                if (draft.estimate === slot) ui.changed();
            });
    };

    const savedBlock = (saved: SavedPreparationInfo): HTMLElement =>
        section(t('m37.ui.saved'), [
            el('div', {
                text: t('m37.view.savedLine', { time: formatTime(saved.savedAt, app.i18n), count: saved.items.length }),
            }),
            el('div', {
                class: 'maestro-muted',
                text: saved.changed.length
                    ? t('m37.view.changed', { list: saved.changed.slice(0, 8).join(', ') })
                    : t('m37.ui.savedSame'),
            }),
            el('div', { class: 'maestro-actions' }, [
                button({
                    label: t('m37.offer.applySaved'),
                    icon: 'fa-check',
                    kind: 'primary',
                    onClick: async () => {
                        await ui.applySaved().catch(report);
                    },
                }),
            ]),
        ]);

    const startStep = (draft: ChatDraft, stage: PrepareStage, error: string | undefined, hasPlan: boolean) => {
        const out: HTMLElement[] = [el('p', { class: 'maestro-muted', text: t('m37.view.intro') })];
        if (stage === 'failed' && error) out.push(banner(t('m37.ui.failed', { error }), 'error'));
        const saved = ui.savedInfo();
        if (saved) out.push(savedBlock(saved));
        const reuse = draft.reuse ?? !!saved;
        const body: HTMLElement[] = [];
        if (saved === undefined) {
            body.push(el('div', { class: 'maestro-muted', text: t('m37.ui.counting') }));
        } else {
            estimateOf(draft, reuse && !!saved);
            const slot = draft.estimate;
            if (!slot || slot.state === 'loading') {
                body.push(el('div', { class: 'maestro-muted', text: t('m37.ui.counting') }));
            } else if (slot.state === 'error' || !slot.result) {
                body.push(banner(t('m37.ui.estimateFailed', { error: slot.error ?? '—' }), 'error'));
            } else {
                const result = slot.result;
                if (result.chunks) {
                    body.push(
                        el('div', {
                            class: 'maestro-m37w-cost',
                            text: t(`m37.ui.cost.${pluralForm(result.chunks, app.i18n.locale())}`, {
                                usd: formatUsd(result.usd, app.i18n),
                                count: result.chunks,
                            }),
                        }),
                    );
                    body.push(
                        el(
                            'div',
                            { class: 'maestro-m37w-chips' },
                            result.labels.map((label) => el('span', { class: 'maestro-m37w-chip', text: label })),
                        ),
                    );
                } else {
                    body.push(el('div', { text: t('m37.ui.nothingToRead') }));
                }
                if (result.skippedLabels.length) {
                    body.push(
                        el('div', { class: 'maestro-muted' }, [
                            t('m37.ui.skipped', { list: result.skippedLabels.slice(0, 12).join(', ') }),
                        ]),
                    );
                }
                body.push(el('div', { class: 'maestro-hint', text: t('m37.ui.costHint') }));
            }
        }
        if (saved) {
            body.push(
                toggle({
                    label: t('m37.ui.reuse'),
                    checked: reuse,
                    onChange: (checked) => {
                        draft.reuse = checked;
                        ui.changed();
                    },
                }),
            );
        }
        out.push(section(t('m37.ui.read'), body));
        out.push(
            el('div', { class: 'maestro-m37w-footer' }, [
                toggle({
                    label: t('m37.ui.offerSetting'),
                    checked: ui.settings().offer,
                    onChange: (checked) => {
                        ui.settings().offer = checked;
                        app.settings.save();
                        app.settings.notify(`modules.${PREPARE_KEY}.offer`);
                    },
                }),
                el('div', { class: 'maestro-actions maestro-m37w-buttons' }, [
                    hasPlan
                        ? button({
                              label: t('m37.ui.backToPlan'),
                              kind: 'ghost',
                              onClick: () => {
                                  draft.restart = false;
                                  draft.review = true;
                                  ui.changed();
                              },
                          })
                        : null,
                    button({
                        label: t('m37.ui.start'),
                        icon: 'fa-play',
                        kind: 'primary',
                        onClick: async () => {
                            const key = await ui.start(reuse && !!saved);
                            if (!key) app.ui.notice(t('m37.ui.notStarted'), { urgent: true, level: 'warn' });
                        },
                    }),
                ]),
            ]),
        );
        return out;
    };

    /* ------------------------------------------------------------ step 2: the run */

    const runningStep = (jobKey: string | null): HTMLElement[] => {
        const label = el('div', { attrs: { 'aria-live': 'polite' } });
        const bar = el('div');
        const stop = button({
            label: t('m37.view.stop'),
            icon: 'fa-stop',
            onClick: () => {
                engine.cancel();
                update();
            },
        });
        const update = () => {
            const job = jobKey ? app.jobs?.get(jobKey) : undefined;
            label.textContent = job?.cancelRequested ? t('m37.ui.stopping') : jobProgress(ui, jobKey);
            clear(bar);
            bar.appendChild(progressBar(job?.done, job?.total, label.textContent));
            stop.disabled = !!job?.cancelRequested;
        };
        jobBlock = { key: jobKey, update };
        update();
        return [
            section(t('m37.ui.running'), [
                el('div', { class: 'maestro-m37w-job' }, [label, bar]),
                el('div', { class: 'maestro-hint', text: t('m37.ui.runningHint') }),
                el('div', { class: 'maestro-actions' }, [stop]),
            ]),
        ];
    };

    /* ------------------------------------------------------------ steps 4–5: the result and «Готово к игре» */

    const openButton = (kind: PrepareKind): HTMLElement => {
        const tab = KIND_TAB[kind];
        return button({
            label: t(`m37.ui.open.${tab}`),
            icon: 'fa-arrow-up-right-from-square',
            kind: 'ghost',
            onClick: () => ui.openSection(tab),
        });
    };

    const resultLine = (line: ApplyLine, draft: ChatDraft, kind: 'done' | 'failed'): HTMLElement => {
        const undone = kind === 'done' && draft.undone.has(line.itemId);
        return el(
            'div',
            {
                class: [
                    'maestro-m37w-line',
                    undone ? 'maestro-m37w-undone' : null,
                    kind === 'failed' ? 'maestro-m37w-failed' : null,
                ],
                data: { item: line.itemId },
            },
            [
                el('span', { class: 'maestro-m37w-text', text: line.text }),
                undone ? badge(t('m37.ui.undone'), 'muted') : null,
                !undone ? openButton(line.kind) : null,
                kind === 'done' && line.journalId && !undone
                    ? button({
                          label: t('m37.ui.undo'),
                          icon: 'fa-rotate-left',
                          kind: 'ghost',
                          onClick: async () => {
                              const ok = await ui.undo(line.itemId).catch((error: unknown) => {
                                  report(error);
                                  return true;
                              });
                              if (!ok) {
                                  app.ui.notice(t('m37.ui.undoFailed', { text: line.text }), {
                                      urgent: true,
                                      level: 'warn',
                                  });
                              }
                          },
                      })
                    : null,
            ],
        );
    };

    const resultSection = (draft: ChatDraft): HTMLElement | null => {
        const summary = draft.summary;
        if (!summary) return null;
        const body: HTMLElement[] = [];
        for (const line of summary.done) body.push(resultLine(line, draft, 'done'));
        for (const line of summary.failed) body.push(resultLine(line, draft, 'failed'));
        if (!summary.done.length && !summary.failed.length)
            body.push(emptyState(t('m37.ui.nothingDone'), 'fa-circle-info'));
        for (const proposal of summary.proposals) {
            body.push(
                el('div', { class: 'maestro-m37w-line' }, [
                    el('span', { class: 'maestro-m37w-text', text: proposal }),
                    button({
                        label: t(`m37.ui.open.${BACKGROUNDS_TAB}`),
                        icon: 'fa-image',
                        kind: 'ghost',
                        onClick: () => ui.openSection(BACKGROUNDS_TAB),
                    }),
                ]),
            );
        }
        if (summary.skipped.length) {
            const details = el('details', { class: 'maestro-details' }, [
                el('summary', { text: t('m37.ui.skippedLines', { count: summary.skipped.length }) }),
                ...summary.skipped.map((line) => el('div', { text: line.text })),
            ]);
            body.push(details);
        }
        return section(t('m37.ui.result'), body);
    };

    /** The plan item a «Готово к игре» line is about. */
    const itemFor = (missing: MissingItem, items: readonly AnyPrepareItem[]): AnyPrepareItem | undefined => {
        const kind = missing.kind === 'place' ? 'place' : missing.kind === 'passport' ? 'character' : null;
        if (!kind) return undefined;
        return items.find((item) => item.kind === kind && (item.data as { name?: string }).name === missing.name);
    };

    const fix = async (item: AnyPrepareItem, draft: ChatDraft): Promise<void> => {
        const summary = await engine.apply([{ id: item.id, scope: 'chat' }], { passports: true, confirmed: true });
        draft.summary = mergeSummary(draft.summary, summary);
        if (!summary.done.length) {
            const why = [...summary.failed, ...summary.skipped].map((line) => line.text).join('\n');
            if (why) app.ui.notice(why, { urgent: true, level: 'warn' });
        }
        ui.changed();
    };

    const fixButton = (missing: MissingItem, items: readonly AnyPrepareItem[], draft: ChatDraft) => {
        switch (missing.kind) {
            case 'plan':
                return button({
                    label: t('m37.ui.fix.plan'),
                    kind: 'ghost',
                    onClick: () => {
                        draft.review = true;
                        ui.changed();
                    },
                });
            case 'portrait':
                return button({
                    label: t('m37.ui.fix.portrait'),
                    icon: 'fa-address-card',
                    kind: 'ghost',
                    onClick: () => ui.openSection(DOSSIER_TAB),
                });
            case 'background':
                return button({
                    label: t('m37.ui.fix.background'),
                    icon: 'fa-image',
                    kind: 'ghost',
                    onClick: () => ui.openSection(BACKGROUNDS_TAB),
                });
            default: {
                const item = itemFor(missing, items);
                if (!item) return null;
                return button({
                    label: t(`m37.ui.fix.${missing.kind}`),
                    icon: missing.kind === 'passport' ? 'fa-id-card' : 'fa-location-dot',
                    kind: 'ghost',
                    onClick: async () => {
                        await fix(item, draft).catch(report);
                    },
                });
            }
        }
    };

    const statusSection = (draft: ChatDraft, key: string, items: readonly AnyPrepareItem[]): HTMLElement => {
        if (status?.key !== key) {
            const slot: { key: string; value?: ReadyStatus | null } = { key };
            status = slot;
            void engine
                .status()
                .catch((error: unknown) => {
                    app.log.debug('prepare: the status was not read', error);
                    return null;
                })
                .then((value) => {
                    slot.value = value;
                    if (status === slot) redraw();
                });
        }
        const value = status.value;
        const body: HTMLElement[] = [];
        if (value === undefined) body.push(el('div', { class: 'maestro-muted', text: t('m37.ui.statusLoading') }));
        else if (!value || !value.lines.length) body.push(emptyState(t('m37.view.ready')));
        else {
            value.missing.forEach((missing, index) => {
                body.push(
                    el('div', { class: 'maestro-m37w-line', data: { missing: missing.kind } }, [
                        el('span', { class: 'maestro-m37w-text', text: value.lines[index] ?? '' }),
                        fixButton(missing, items, draft),
                    ]),
                );
            });
        }
        return section(t('m37.view.status'), body);
    };

    const doneStep = (draft: ChatDraft, appliedAt: number | undefined, eligible: boolean, hasPlan: boolean) => {
        const out: HTMLElement[] = [];
        const result = resultSection(draft);
        if (result) out.push(result);
        else if (appliedAt) {
            out.push(el('p', { text: t('m37.ui.appliedAt', { time: formatTime(appliedAt, app.i18n) }) }));
        }
        const summary = draft.summary;
        const statusKey = JSON.stringify([
            ui.chatId(),
            appliedAt ?? 0,
            summary?.done.length ?? 0,
            summary?.failed.length ?? 0,
            draft.undone.size,
        ]);
        out.push(statusSection(draft, statusKey, engine.plan()?.items ?? []));
        out.push(
            el('div', { class: 'maestro-m37w-footer' }, [
                el('div', { class: 'maestro-actions maestro-m37w-buttons' }, [
                    hasPlan
                        ? button({
                              label: t('m37.ui.toPlan'),
                              icon: 'fa-list-check',
                              onClick: () => {
                                  draft.review = true;
                                  ui.changed();
                              },
                          })
                        : null,
                    eligible
                        ? button({
                              label: t('m37.ui.again'),
                              icon: 'fa-rotate',
                              kind: 'ghost',
                              onClick: () => {
                                  draft.restart = true;
                                  ui.changed();
                              },
                          })
                        : null,
                ]),
            ]),
        );
        return out;
    };

    /* ------------------------------------------------------------ drawing */

    const draw = (): void => {
        if (!alive) return;
        const eligibility = engine.eligibility();
        const state = engine.state();
        const plan = engine.plan();
        const draft = ui.draft();
        syncDraft(draft, plan);
        const step = stepOf({ eligible: eligibility.ok, stage: state.stage, hasPlan: !!plan, draft });
        const saved = step === 'start' ? ui.savedInfo() : null;
        const next = JSON.stringify([
            ui.chatId(),
            app.i18n.locale(),
            step,
            eligibility.reason ?? '',
            state.stage,
            state.jobKey,
            state.error ?? '',
            state.appliedAt ?? 0,
            plan?.createdAt ?? 0,
            plan?.items.map((item) => [item.id, item.exists?.where ?? '', item.conflicts?.length ?? 0]) ?? [],
            saved === undefined ? 'loading' : saved ? [saved.savedAt, saved.items.length, saved.changed] : null,
            draft.estimate ? [draft.estimate.reuse, draft.estimate.state] : null,
            draft.reuse,
            draft.summary
                ? [draft.summary.done.length, draft.summary.failed.length, draft.summary.skipped.length]
                : null,
            [...draft.undone],
            status?.key ?? '',
            status?.value === undefined ? 'loading' : (status.value?.lines ?? null),
        ]);
        if (next === signature) {
            jobBlock?.update();
            return;
        }
        signature = next;
        // In a window the body scrolls itself (custom window bodies do not); in the pult tab the tab does.
        const scroller = ctx ? root : container;
        const scrollTop = scroller.scrollTop;
        jobBlock = null;
        clear(root);
        if (plan?.card.name) ctx?.setTitle(t('m37.window.card', { card: plan.card.name }));
        if (step === 'blocked') {
            root.appendChild(el('p', { class: 'maestro-muted', text: t('m37.view.intro') }));
            root.appendChild(banner(t(`m37.view.notNew.${eligibility.reason ?? 'noChat'}`), 'info', 'fa-circle-info'));
            return;
        }
        root.appendChild(steps(step));
        let parts: HTMLElement[];
        switch (step) {
            case 'start':
                parts = startStep(draft, state.stage, state.error, !!plan);
                break;
            case 'running':
                parts = runningStep(state.jobKey);
                break;
            case 'review':
                parts = plan
                    ? reviewStep(ui, plan, draft, {
                          eligible: eligibility.ok,
                          onAgain: () => {
                              draft.restart = true;
                              draft.review = false;
                              ui.changed();
                          },
                          onDiscard: async () => {
                              const ok = await app.ui.confirm(t('m37.ui.discardTitle'), t('m37.ui.discardBody'));
                              if (!ok) return;
                              await engine.discard();
                              draft.review = false;
                              draft.summary = null;
                              draft.undone.clear();
                              ui.changed();
                          },
                      })
                    : [];
                break;
            default:
                parts = doneStep(draft, state.appliedAt, eligibility.ok, !!plan);
        }
        for (const part of parts) root.appendChild(part);
        scroller.scrollTop = scrollTop;
    };

    const redraw = coalesce(draw, 40);
    const offEngine = engine.onChange(() => redraw());
    const offUi = ui.onChange(() => redraw());
    const offJobs = app.jobs?.on((job, key) => {
        if (!key.startsWith('prepare:')) return;
        if (job?.state === 'active' && jobBlock?.key === key) jobBlock.update();
        else redraw();
    });
    const offParams = ctx?.onParams(() => redraw());
    void engine
        .load()
        .catch(() => null)
        .then(() => redraw());
    draw();
    return () => {
        alive = false;
        redraw.cancel();
        offEngine();
        offUi();
        offJobs?.();
        offParams?.();
        unwatch?.();
        root.remove();
    };
}

export function prepareWindow(ui: PrepareUi): MaestroWindowSpec {
    return {
        id: PREPARE_WINDOW,
        titleKey: 'm37.window',
        icon: 'fa-wand-magic-sparkles',
        order: 55,
        defaultDock: 'right',
        defaultWidth: 640,
        render: (container, ctx) => renderPrepare(container, ui, ctx),
        // A plan waiting to be looked through.
        badge: () => (ui.engine.state().stage === 'ready' ? 1 : 0),
    };
}

/** The pult tab «Подготовка» with the same body, for a shell without windows. */
export function prepareTab(ui: PrepareUi): PultTab {
    return {
        id: PREPARE_TAB,
        titleKey: 'm37.tab',
        icon: 'fa-wand-magic-sparkles',
        order: 40,
        group: 'world',
        render: (container) => renderPrepare(container, ui),
        badge: () => (ui.engine.state().stage === 'ready' ? 1 : 0),
    };
}

/** A window of its own when the shell has windows, else the pult tab. */
export function registerPrepareView(ui: PrepareUi): Unsubscribe {
    const { app } = ui;
    if (typeof app.ui.addWindow === 'function') {
        const off = app.ui.addWindow(prepareWindow(ui));
        ui.setMode('window');
        return () => {
            ui.setMode(null);
            off();
        };
    }
    const off = app.ui.addTab(prepareTab(ui));
    ui.setMode('tab');
    return () => {
        ui.setMode(null);
        off();
    };
}
