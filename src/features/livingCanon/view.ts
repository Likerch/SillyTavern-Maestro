// Pult tab «Живой канон» (M26): names of the last reply waiting for the commit, provisional facts (quote, source
// message, turns survived, confirm / drop, «Принять все пробные»), disputed ones (the Inbox decides), recently
// confirmed facts with the reason, the batch extraction (status, «Извлечь сейчас») and the settings K, N and the
// extraction interval. Mobile first: one column, wrapping rows.
import type { DraftData, FactData } from '../../domain/living-facts';
import type { App, PultTab } from '../../shared/contracts';
import { badge, banner, emptyState, section } from '../../ui/components/card';
import { field, numberInput } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import { coalesce, formatTime } from '../../ui/views/format';
import type { LivingCanonService, LivingCanonSettings } from './service';
import { LIVING_KEY } from './service';

export const LIVING_TAB = 'living';
const INBOX_TAB = 'inbox';
/** The module the living canon writes to (M6). */
const CANON_KEY = 'canon';
const KEYS_SHOWN = 8;

export const LIVING_CSS = `
.maestro-m26 { display: flex; flex-direction: column; gap: 8px; }
.maestro-m26-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m26-list { display: flex; flex-direction: column; gap: 6px; }
.maestro-m26-fact { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 6px 8px;
    display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
.maestro-m26-draft { border-style: dashed; }
.maestro-m26-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m26-name { font-weight: 600; }
.maestro-m26-quote { font-style: italic; opacity: 0.9; white-space: pre-wrap; }
.maestro-m26-text { font-size: 0.9em; white-space: pre-wrap; }
.maestro-m26-small { font-size: 0.85em; opacity: 0.8; }
.maestro-m26-link { padding: 0 6px; min-height: 0; }
`;

function quoteText(quote: string): string {
    const text = quote.trim().replace(/^[«"“„]+|[»"”]+$/g, '');
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

export function livingTab(app: App, service: LivingCanonService, settings: () => LivingCanonSettings): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: LIVING_TAB,
        titleKey: 'm26.tab',
        icon: 'fa-seedling',
        order: 50,
        badge: () => service.provisional().length,
        render(container) {
            let alive = true;
            const root = el('div', { class: 'maestro-view maestro-m26' });
            container.appendChild(root);

            const run = async (job: () => Promise<unknown>): Promise<void> => {
                try {
                    await job();
                } catch (error) {
                    app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'error' });
                }
                if (alive) draw();
            };

            const typeBadge = (type: string) => badge(t(`m26.type.${type}`), 'muted');

            const sourceLink = (index: number) =>
                index >= 0
                    ? button({
                          label: t('m26.source', { index }),
                          icon: 'fa-message',
                          kind: 'ghost',
                          className: 'maestro-m26-link',
                          title: t('m26.source.hint'),
                          onClick: () => jump(app, index),
                      })
                    : null;

            const draftView = (draft: DraftData, facts: readonly FactData[]): HTMLElement => {
                const target = draft.mergeInto ? facts.find((fact) => fact.id === draft.mergeInto) : undefined;
                return el('div', { class: 'maestro-m26-fact maestro-m26-draft' }, [
                    el('div', { class: 'maestro-m26-head' }, [
                        el('span', { class: 'maestro-m26-name', text: draft.name }),
                        typeBadge(draft.type),
                        target
                            ? el('span', {
                                  class: 'maestro-muted',
                                  text: t('m26.draft.extends', { name: target.name }),
                              })
                            : null,
                    ]),
                    el('div', { class: 'maestro-m26-quote', text: quoteText(draft.quote) }),
                ]);
            };

            const factBody = (fact: FactData): (HTMLElement | null)[] => {
                const keys = fact.keys.filter((key) => key !== fact.name).slice(0, KEYS_SHOWN);
                return [
                    fact.russian ? el('div', { class: 'maestro-m26-text', text: fact.russian }) : null,
                    el('div', { class: 'maestro-m26-quote', text: quoteText(fact.quote) }),
                    fact.text
                        ? el('div', {
                              class: 'maestro-m26-small maestro-muted',
                              text: t('m26.text', { text: fact.text }),
                          })
                        : el('div', { class: 'maestro-m26-small maestro-muted', text: t('m26.noText') }),
                    keys.length
                        ? el('div', { class: 'maestro-m26-small', text: t('m26.keys', { keys: keys.join(', ') }) })
                        : null,
                    fact.conflict ? banner(t('m26.conflict', { conflict: fact.conflict }), 'warn') : null,
                ];
            };

            const provisionalView = (fact: FactData): HTMLElement => {
                const uid = fact.uid;
                return el('div', { class: 'maestro-m26-fact' }, [
                    el('div', { class: 'maestro-m26-head' }, [
                        el('span', { class: 'maestro-m26-name', text: fact.name }),
                        typeBadge(fact.type),
                        badge(t('m26.survived', { count: fact.survivedTurns, total: settings().surviveTurns }), 'info'),
                        sourceLink(fact.sourceMessage),
                    ]),
                    ...factBody(fact),
                    uid === undefined
                        ? null
                        : el('div', { class: 'maestro-m26-row' }, [
                              button({
                                  label: t('m26.accept'),
                                  icon: 'fa-check',
                                  kind: 'primary',
                                  title: t('m26.accept.hint'),
                                  onClick: () => run(() => service.accept(uid)),
                              }),
                              button({
                                  label: t('m26.drop'),
                                  icon: 'fa-trash-can',
                                  kind: 'ghost',
                                  title: t('m26.drop.hint'),
                                  onClick: () => run(() => service.drop(uid)),
                              }),
                          ]),
                ]);
            };

            const disputedView = (fact: FactData): HTMLElement =>
                el('div', { class: 'maestro-m26-fact' }, [
                    el('div', { class: 'maestro-m26-head' }, [
                        el('span', { class: 'maestro-m26-name', text: fact.name }),
                        typeBadge(fact.type),
                        badge(
                            t(fact.dispute === 'kept' ? 'm26.disputed.kept' : 'm26.disputed.pending'),
                            fact.dispute === 'kept' ? 'muted' : 'warn',
                        ),
                        sourceLink(fact.sourceMessage),
                    ]),
                    ...factBody(fact),
                    el('div', { class: 'maestro-m26-row' }, [
                        button({
                            label: t('m26.disputed.inbox'),
                            icon: 'fa-inbox',
                            onClick: () => app.ui.openPult(INBOX_TAB),
                        }),
                        button({
                            label: t('m26.drop'),
                            icon: 'fa-trash-can',
                            kind: 'ghost',
                            title: t('m26.drop.hint'),
                            onClick: () =>
                                run(() =>
                                    fact.uid !== undefined ? service.drop(fact.uid) : service.dropById(fact.id),
                                ),
                        }),
                    ]),
                ]);

            const confirmedView = (fact: FactData): HTMLElement =>
                el('div', { class: 'maestro-m26-fact' }, [
                    el('div', { class: 'maestro-m26-head' }, [
                        el('span', { class: 'maestro-m26-name', text: fact.name }),
                        typeBadge(fact.type),
                        fact.confirmedBy ? badge(t(`m26.reason.${fact.confirmedBy}`), 'ok') : null,
                        sourceLink(fact.sourceMessage),
                    ]),
                    fact.text
                        ? el('div', { class: 'maestro-m26-text', text: fact.text })
                        : el('div', { class: 'maestro-m26-quote', text: quoteText(fact.quote) }),
                ]);

            const extractLine = (): HTMLElement => {
                const state = service.extractState();
                let text = t('m26.extract.never');
                if (state?.lastRun) {
                    const when = formatTime(state.lastRun, app.i18n);
                    text = state.lastError
                        ? t('m26.extract.failed', { when, error: state.lastError })
                        : t('m26.extract.last', { when, added: state.added ?? 0, updated: state.updated ?? 0 });
                }
                return el('div', { class: 'maestro-m26-small', text });
            };

            const settingsView = (): HTMLElement => {
                const slice = settings();
                const save = (key: keyof LivingCanonSettings, value: number) => {
                    slice[key] = Math.max(0, Math.round(value));
                    app.settings.notify(`modules.${LIVING_KEY}.${key}`);
                    app.settings.save();
                    draw();
                };
                const number = (key: keyof LivingCanonSettings, label: string, max: number, hint: string) =>
                    field(
                        label,
                        numberInput({
                            value: slice[key],
                            min: 0,
                            max,
                            step: 1,
                            label,
                            onChange: (value) => save(key, value),
                        }),
                        hint,
                    );
                return el('details', {}, [
                    el('summary', { text: t('m26.settings') }),
                    number('maxPerTurn', t('m26.settings.k'), 10, t('m26.settings.kHint')),
                    number('surviveTurns', t('m26.settings.survive'), 100, t('m26.settings.surviveHint')),
                    number('extractEvery', t('m26.settings.extract'), 200, t('m26.settings.extractHint')),
                ]);
            };

            const draw = (): void => {
                if (!alive) return;
                clear(root);
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('m26.noChat'), 'fa-seedling'));
                    return;
                }
                if (app.host.isGroupChat()) {
                    root.appendChild(emptyState(t('m26.group'), 'fa-users'));
                    return;
                }
                const records = service.records();
                const drafts = service.draftRecords();
                const provisional = records.filter((fact) => fact.status === 'provisional' && fact.uid !== undefined);
                const disputed = records.filter(
                    (fact) =>
                        fact.status === 'disputed' || (fact.status === 'provisional' && fact.dispute === 'pending'),
                );
                const confirmed = service.confirmedRecords();
                const current = settings();
                root.appendChild(
                    section(
                        t('m26.title'),
                        [
                            el('div', {
                                class: 'maestro-hint',
                                text: t('m26.hint', { k: current.maxPerTurn, n: current.surviveTurns }),
                            }),
                            app.modules.api(CANON_KEY)
                                ? null
                                : el('div', { class: 'maestro-row' }, [
                                      banner(t('m26.noCanon'), 'warn'),
                                      button({
                                          label: t('m26.enableCanon'),
                                          icon: 'fa-power-off',
                                          onClick: () => run(() => app.modules.enable(CANON_KEY)),
                                      }),
                                  ]),
                            extractLine(),
                        ],
                        [
                            button({
                                label: t('m26.extract'),
                                icon: 'fa-wand-magic-sparkles',
                                title: t('m26.extract.hint'),
                                onClick: () =>
                                    run(async () => {
                                        await service.extractNow();
                                        app.ui.notice(t('m26.extract.queued'), { urgent: true });
                                    }),
                            }),
                            provisional.length
                                ? button({
                                      label: t('m26.acceptAll'),
                                      icon: 'fa-check-double',
                                      onClick: () =>
                                          run(async () => {
                                              const result = await service.acceptAll();
                                              app.ui.notice(t('m26.acceptAll.done', result), { urgent: true });
                                          }),
                                  })
                                : null,
                        ],
                    ),
                );
                if (drafts.length) {
                    root.appendChild(
                        section(t('m26.drafts', { count: drafts.length }), [
                            el('div', { class: 'maestro-hint', text: t('m26.drafts.hint') }),
                            el(
                                'div',
                                { class: 'maestro-m26-list' },
                                drafts.map((draft) => draftView(draft, records)),
                            ),
                        ]),
                    );
                }
                root.appendChild(
                    section(
                        t('m26.provisional', { count: provisional.length }),
                        provisional.length
                            ? el('div', { class: 'maestro-m26-list' }, provisional.map(provisionalView))
                            : emptyState(t('m26.provisional.empty'), 'fa-seedling'),
                    ),
                );
                if (disputed.length) {
                    root.appendChild(
                        section(t('m26.disputed', { count: disputed.length }), [
                            el('div', { class: 'maestro-hint', text: t('m26.disputed.hint') }),
                            el('div', { class: 'maestro-m26-list' }, disputed.map(disputedView)),
                        ]),
                    );
                }
                root.appendChild(
                    section(
                        t('m26.confirmed', { count: confirmed.length }),
                        confirmed.length
                            ? el('div', { class: 'maestro-m26-list' }, confirmed.map(confirmedView))
                            : emptyState(t('m26.confirmed.empty'), 'fa-circle-check'),
                    ),
                );
                root.appendChild(settingsView());
            };

            const later = coalesce(draw, 50);
            const off = service.onChange(later);
            draw();
            return () => {
                alive = false;
                later.cancel();
                off();
            };
        },
    };
}
