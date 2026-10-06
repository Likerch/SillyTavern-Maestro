// Pult tab «Подготовка» (M37): a minimal face of the engine until the preparation window of the next wave — whether
// this chat can be prepared, the saved character-level preparation, the estimate and the analysis with its progress,
// the plan by sections (what exists, where the canon says otherwise), «Применить» for the chat or the character,
// the result and «Готово к игре».
import { PREPARE_SECTIONS, sectionCounts } from '../../domain/prepare-plan';
import type { AnyPrepareItem, PreparePlan } from '../../domain/prepare-plan';
import type { App, PultTab, UserJobInfo } from '../../shared/contracts';
import { badge, banner, card, emptyState, section } from '../../ui/components/card';
import { button, clear, el } from '../../ui/components/dom';
import { coalesce, formatTime, formatUsd } from '../../ui/views/format';
import type { PrepareApplySummary, PrepareEstimateResult, ReadyStatus, SavedPreparationInfo } from './api';
import type { PrepareService } from './service';
import { PREPARE_TAB } from './settings';

export const PREPARE_CSS = `
.maestro-m37-list { display: flex; flex-direction: column; gap: 4px; }
.maestro-m37-item { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; overflow-wrap: anywhere; }
.maestro-m37-buttons { display: flex; flex-wrap: wrap; gap: 6px; }
.maestro-m37-counts { overflow-wrap: anywhere; }
`;

/** Lines of the plan by section, for the view and the slash command. */
export function planLines(app: App, service: PrepareService, plan: PreparePlan): string[] {
    const t = app.i18n.t.bind(app.i18n);
    const lines: string[] = [];
    for (const kind of PREPARE_SECTIONS) {
        const items = plan.items.filter((item) => item.kind === kind);
        if (!items.length) continue;
        lines.push(`${t(`m37.section.${kind}`)} (${items.length})`);
        for (const item of items) lines.push(`• ${itemLine(app, service, item)}`);
    }
    return lines;
}

function itemLine(app: App, service: PrepareService, item: AnyPrepareItem): string {
    const t = app.i18n.t.bind(app.i18n);
    const marks: string[] = [];
    if (item.exists) marks.push(t(`m37.exists.${item.exists.where}`));
    if (item.conflicts?.length) {
        marks.push(
            t('m37.conflict', { fields: item.conflicts.map((row) => t(`m37.conflictField.${row.field}`)).join(', ') }),
        );
    }
    if (item.scope === 'character') marks.push(t('m37.scope.character'));
    return `${service.describe(item)}${marks.length ? ` [${marks.join('; ')}]` : ''}`;
}

export function prepareTab(app: App, service: PrepareService): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: PREPARE_TAB,
        titleKey: 'm37.tab',
        icon: 'fa-wand-magic-sparkles',
        order: 40,
        group: 'world',
        render(container) {
            let alive = true;
            let generation = 0;
            let estimate: PrepareEstimateResult | null = null;
            let result: PrepareApplySummary | null = null;
            // The saved preparation compares every source with the card: read once per opening (and after applying).
            let savedLoad: Promise<SavedPreparationInfo | null> | null = null;
            const root = el('div', { class: 'maestro-view maestro-m37' });
            container.appendChild(root);
            const unwatch = service.watch();

            const report = (error: unknown) =>
                app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'error', urgent: true });

            const jobBlock = (job: UserJobInfo | undefined): HTMLElement | null => {
                if (!job || job.state !== 'active') return null;
                const progress = job.total ? `${job.done ?? 0}/${job.total}` : '';
                return card({
                    title: job.label ?? job.title,
                    subtitle: progress ? badge(progress, 'muted') : undefined,
                    actions: button({ label: t('m37.view.stop'), onClick: () => void service.cancel() }),
                });
            };

            const draw = async (): Promise<void> => {
                const mine = ++generation;
                await service.load().catch(() => null);
                const eligibility = service.eligibility();
                const state = service.state();
                const plan = service.plan();
                if (eligibility.ok) savedLoad ??= service.savedFor().catch((): SavedPreparationInfo | null => null);
                const saved = eligibility.ok && savedLoad ? await savedLoad : null;
                const status: ReadyStatus | null = plan ? await service.status().catch(() => null) : null;
                if (!alive || mine !== generation) return;
                clear(root);
                root.appendChild(el('p', { class: 'maestro-muted', text: t('m37.view.intro') }));
                if (!eligibility.ok && eligibility.reason) {
                    root.appendChild(banner(t(`m37.view.notNew.${eligibility.reason}`), 'info'));
                }
                const job = state.jobKey ? app.jobs?.get(state.jobKey) : undefined;
                const running = jobBlock(job);
                if (running) root.appendChild(running);

                if (saved) {
                    root.appendChild(
                        section(t('m37.view.saved'), [
                            el('div', {
                                text: t('m37.view.savedLine', {
                                    time: formatTime(saved.savedAt, app.i18n),
                                    count: saved.items.length,
                                }),
                            }),
                            saved.changed.length
                                ? el('div', {
                                      class: 'maestro-muted',
                                      text: t('m37.view.changed', { list: saved.changed.slice(0, 8).join(', ') }),
                                  })
                                : null,
                            el('div', { class: 'maestro-m37-buttons' }, [
                                button({
                                    label: t('m37.view.applySaved'),
                                    kind: 'primary',
                                    onClick: async () => {
                                        result = await service.applySaved().catch((error: unknown) => {
                                            report(error);
                                            return null;
                                        });
                                        savedLoad = null;
                                        void draw();
                                    },
                                }),
                                button({
                                    label: t('m37.view.reuse'),
                                    disabled: state.stage === 'running',
                                    onClick: async () => {
                                        await service.start({ reuse: true });
                                    },
                                }),
                            ]),
                        ]),
                    );
                }

                if (eligibility.ok && state.stage !== 'running') {
                    root.appendChild(
                        el('div', { class: 'maestro-m37-buttons' }, [
                            button({
                                label: t('m37.view.estimate'),
                                onClick: async () => {
                                    estimate = await service.estimate().catch((error: unknown) => {
                                        report(error);
                                        return null;
                                    });
                                    void draw();
                                },
                            }),
                            button({
                                label: t('m37.view.start'),
                                kind: 'primary',
                                onClick: async () => {
                                    await service.start();
                                },
                            }),
                        ]),
                    );
                    if (estimate) {
                        root.appendChild(
                            el('div', {
                                class: 'maestro-muted',
                                text: t('m37.view.estimateLine', {
                                    chunks: estimate.chunks,
                                    sources: estimate.sources,
                                    usd: formatUsd(estimate.usd, app.i18n),
                                }),
                            }),
                        );
                        if (estimate.skippedLabels.length) {
                            root.appendChild(
                                el('div', {
                                    class: 'maestro-muted',
                                    text: t('m37.view.skipped', {
                                        list: estimate.skippedLabels.slice(0, 10).join(', '),
                                    }),
                                }),
                            );
                        }
                    }
                }

                if (plan) {
                    const counts = sectionCounts(plan.items);
                    const head = PREPARE_SECTIONS.filter((kind) => counts[kind])
                        .map((kind) => `${t(`m37.section.${kind}`)} (${counts[kind]})`)
                        .join(' · ');
                    const body: HTMLElement[] = [el('div', { class: 'maestro-m37-counts', text: head })];
                    if (plan.partial) body.push(banner(t('m37.view.partial'), 'warn'));
                    if (plan.failedChunks)
                        body.push(banner(t('m37.view.failedParts', { count: plan.failedChunks }), 'warn'));
                    const list = el('div', { class: 'maestro-m37-list' });
                    for (const line of planLines(app, service, plan)) {
                        list.appendChild(el('div', { class: 'maestro-m37-item', text: line }));
                    }
                    body.push(list);
                    if (!plan.items.length) body.push(emptyState(t('m37.slash.empty')));
                    body.push(
                        el('div', { class: 'maestro-m37-buttons' }, [
                            button({
                                label: t('m37.view.applyChat'),
                                kind: 'primary',
                                onClick: async () => {
                                    result = await service.apply('all').catch((error: unknown) => {
                                        report(error);
                                        return null;
                                    });
                                    savedLoad = null;
                                    void draw();
                                },
                            }),
                            button({
                                label: t('m37.view.applyCharacter'),
                                onClick: async () => {
                                    const rows = plan.items
                                        .filter((item) => !item.exists)
                                        .map((item) => ({ id: item.id, scope: 'character' as const }));
                                    result = await service.apply(rows).catch((error: unknown) => {
                                        report(error);
                                        return null;
                                    });
                                    savedLoad = null;
                                    void draw();
                                },
                            }),
                            button({
                                label: t('m37.view.discard'),
                                kind: 'ghost',
                                onClick: async () => {
                                    await service.discard();
                                },
                            }),
                        ]),
                    );
                    root.appendChild(section(t('m37.view.plan'), body));
                }

                if (result) {
                    const lines = [...result.done, ...result.failed, ...result.skipped].map((line) => line.text);
                    root.appendChild(
                        section(t('m37.view.result'), [
                            ...lines.map((line) => el('div', { text: line })),
                            ...result.proposals.map((line) => el('div', { class: 'maestro-muted', text: line })),
                        ]),
                    );
                }

                if (status) {
                    root.appendChild(
                        section(
                            t('m37.view.status'),
                            status.lines.length
                                ? status.lines.map((line) => el('div', { text: line }))
                                : [emptyState(t('m37.view.ready'))],
                        ),
                    );
                }
            };

            const redraw = coalesce(() => void draw(), 120);
            const offService = service.onChange(() => redraw());
            const offJobs = app.jobs?.on((_job, key) => {
                if (key.startsWith('prepare:')) redraw();
            });
            void draw();
            return () => {
                alive = false;
                redraw.cancel();
                offService();
                offJobs?.();
                unwatch();
            };
        },
    };
}
