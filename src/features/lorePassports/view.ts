// Pult tab «Паспорта» (M28): whether NAI Studio takes the scene's passports, what it received last and what is in the
// scene now, the entries of the active books that have a passport (opened in the Lore Studio), and the typed entries
// that could have one — generated in one go after a confirmation with the cost estimate. Mobile first: one column.
import { passportTagLine } from '../../domain/lore-passport';
import { estimatePassportCost } from '../../domain/lore-passport-gen';
import type { App, PultTab } from '../../shared/contracts';
import { badge, emptyState, section } from '../../ui/components/card';
import { button, el } from '../../ui/components/dom';
import { coalesce, formatTime, formatUsd } from '../../ui/views/format';
import type { IndexedBook, IndexedEntry } from './scene';
import type { LorePassportsService, LorePassportsSettings } from './service';
import { LORE_PASSPORTS_KEY } from './service';

export const LORE_PASSPORTS_TAB = 'lorePassports';
const MISSING_SHOWN = 15;

export const LORE_PASSPORTS_CSS = `
.maestro-m28 { display: flex; flex-direction: column; gap: 8px; }
.maestro-m28-status { display: flex; flex-direction: column; gap: 4px; }
.maestro-m28-list { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.maestro-m28-item { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 6px 8px;
    display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
.maestro-m28-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m28-name { font-weight: 600; }
.maestro-m28-book, .maestro-m28-tags { font-size: 0.9em; opacity: 0.85; }
.maestro-m28-actions { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
`;

/** Opens an entry in the Lore Studio when it runs (closing the pult). */
function openEntry(app: App, world: string, uid: number): void {
    const studio = app.modules.api<{ open?(book?: string, uid?: number): void }>('loreStudio');
    if (typeof studio?.open !== 'function') return;
    app.ui.closePult?.();
    studio.open(world, uid);
}

export function lorePassportsTab(
    app: App,
    service: LorePassportsService,
    settings: () => LorePassportsSettings,
): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: LORE_PASSPORTS_TAB,
        titleKey: 'm28.tab',
        icon: 'fa-id-card',
        order: 61,
        render(container) {
            let alive = true;
            let books: IndexedBook[] | null = null;
            const root = el('div', { class: 'maestro-view maestro-m28' });
            container.appendChild(root);

            const load = async () => {
                try {
                    books = await service.catalog();
                } catch (error) {
                    app.log.debug('passport catalog failed', error);
                    books = [];
                }
                if (alive) draw();
            };

            const kindBadge = (kind: unknown) =>
                badge(typeof kind === 'string' && kind ? t(`m28.kind.${kind}`) : '?', 'info');

            const statusLines = (): HTMLElement => {
                const nai = app.adapters.nai;
                let provider: string;
                if (!settings().provider) provider = 'm28.view.provider.off';
                else if (service.scene.providerRegistered()) provider = 'm28.view.provider.on';
                else if (service.scene.providerSupported()) provider = 'm28.view.provider.waiting';
                else if (typeof nai?.present === 'function' && nai.present()) provider = 'm28.view.provider.old';
                else provider = 'm28.view.provider.absent';
                const generator = service.generator();
                const toggle = el('input', { attrs: { type: 'checkbox', name: 'm28Provider' } });
                toggle.checked = settings().provider;
                toggle.addEventListener('change', () => {
                    settings().provider = toggle.checked;
                    app.settings.notify(`modules.${LORE_PASSPORTS_KEY}`);
                    app.settings.save();
                    service.scene.syncProvider();
                    draw();
                });
                return el('div', { class: 'maestro-m28-status' }, [
                    el('div', { class: 'maestro-muted', text: t('m28.view.intro') }),
                    el('label', { class: 'checkbox_label' }, [
                        toggle,
                        el('span', { text: t('m28.view.provider.toggle') }),
                    ]),
                    el('div', { text: t(provider) }),
                    el('div', {
                        text:
                            generator.kind === 'none'
                                ? t('m28.view.generator.none', { reason: t(`m28.gen.${generator.reason}`) })
                                : t(`m28.view.generator.${generator.kind}`),
                    }),
                ]);
            };

            const sentSection = (): HTMLElement => {
                const sent = service.lastSent();
                if (!sent)
                    return section(
                        t('m28.view.sent.title'),
                        el('div', { class: 'maestro-muted', text: t('m28.view.sent.none') }),
                    );
                const names = sent.passports.map((item) => item.name).join(', ');
                return section(
                    t('m28.view.sent.title'),
                    el('div', {
                        text: t('m28.view.sent.at', {
                            index: sent.messageIndex,
                            time: formatTime(sent.at, app.i18n),
                            count: names || t('m28.view.sent.empty'),
                        }),
                    }),
                );
            };

            const sceneSection = (): HTMLElement => {
                const items = service.forScene();
                return section(
                    t('m28.view.scene.title'),
                    items.length
                        ? el(
                              'ul',
                              { class: 'maestro-m28-list' },
                              items.map((item) =>
                                  el('li', { class: 'maestro-m28-head' }, [
                                      kindBadge(item.passport.kind),
                                      el('span', { class: 'maestro-m28-name', text: item.name }),
                                      el('span', { class: 'maestro-m28-book', text: item.world }),
                                  ]),
                              ),
                          )
                        : el('div', { class: 'maestro-muted', text: t('m28.view.scene.none') }),
                );
            };

            const row = (entry: IndexedEntry): HTMLElement => {
                const record = entry.record;
                const passport = record?.passport ?? {};
                const name = typeof passport.name === 'string' && passport.name ? passport.name : entry.name;
                const studio = app.modules.api<{ open?: unknown }>('loreStudio');
                return el('li', { class: 'maestro-m28-item', data: { world: entry.world, uid: entry.uid } }, [
                    el('div', { class: 'maestro-m28-head' }, [
                        kindBadge(record ? passport.kind : entry.typedKind),
                        el('span', { class: 'maestro-m28-name', text: name }),
                        badge(t(`m28.storage.${entry.storage}`), 'muted'),
                        record?.generatedBy ? badge(t(`m28.by.${record.generatedBy}`), 'muted') : null,
                    ]),
                    el('div', { class: 'maestro-m28-book', text: entry.world }),
                    record ? el('div', { class: 'maestro-m28-tags', text: passportTagLine(passport) }) : null,
                    typeof studio?.open === 'function'
                        ? el('div', { class: 'maestro-m28-actions' }, [
                              button({
                                  label: t('m28.view.open'),
                                  icon: 'fa-pen-to-square',
                                  kind: 'ghost',
                                  onClick: () => openEntry(app, entry.world, entry.uid),
                              }),
                          ])
                        : null,
                ]);
            };

            const batchLine = (): HTMLElement | null => {
                const state = service.batch();
                if (!state) return null;
                const params = { done: state.done, total: state.total, failed: state.failed, skipped: state.skipped };
                return el('div', { class: 'maestro-m28-actions' }, [
                    el('span', { text: t(state.running ? 'm28.view.batch.progress' : 'm28.view.batch.done', params) }),
                    state.running
                        ? button({
                              label: t('m28.view.stop'),
                              icon: 'fa-stop',
                              kind: 'ghost',
                              onClick: () => service.stop(),
                          })
                        : null,
                    !state.running && state.lastError
                        ? el('span', {
                              class: 'maestro-warn-text',
                              text: t('m28.view.batch.error', { error: state.lastError }),
                          })
                        : null,
                ]);
            };

            const generateMissing = async (missing: IndexedEntry[]) => {
                const generator = service.generator();
                if (generator.kind === 'none') {
                    app.ui.notice(t(`m28.gen.${generator.reason}`), { level: 'warn', urgent: true });
                    return;
                }
                const estimate = estimatePassportCost(missing.map((entry) => entry.chars));
                const ok = await app.ui.confirm(
                    t('m28.view.batch.title'),
                    t('m28.view.batch.body', {
                        count: missing.length,
                        by: t(`m28.by.${generator.kind}`),
                        tokens: estimate.tokens,
                        usd: formatUsd(estimate.usd, app.i18n),
                    }),
                );
                if (!ok) return;
                void service.generateMissing(missing.map((entry) => ({ world: entry.world, uid: entry.uid })));
            };

            const booksSections = (): HTMLElement[] => {
                if (books === null) return [emptyState(t('m28.view.loading'), 'fa-hourglass-half')];
                if (!books.length) return [emptyState(t('m28.view.noBooks'), 'fa-book')];
                const all = books.flatMap((book) => [...book.entries.values()]);
                const withPassport = all.filter((entry) => entry.record);
                const missing = all.filter((entry) => !entry.record && entry.typedKind && entry.chars > 0);
                const running = service.batch()?.running === true;
                return [
                    section(
                        t('m28.view.list.title', { count: withPassport.length }),
                        withPassport.length
                            ? el('ul', { class: 'maestro-m28-list' }, withPassport.map(row))
                            : el('div', { class: 'maestro-muted', text: t('m28.view.list.none') }),
                    ),
                    section(
                        t('m28.view.missing.title', { count: missing.length }),
                        [
                            missing.length
                                ? el('ul', { class: 'maestro-m28-list' }, missing.slice(0, MISSING_SHOWN).map(row))
                                : el('div', { class: 'maestro-muted', text: t('m28.view.missing.none') }),
                            missing.length > MISSING_SHOWN
                                ? el('div', {
                                      class: 'maestro-muted',
                                      text: t('m28.view.missing.more', { count: missing.length - MISSING_SHOWN }),
                                  })
                                : null,
                            batchLine(),
                        ],
                        missing.length && !running
                            ? button({
                                  label: t('m28.view.generateMissing', { count: missing.length }),
                                  icon: 'fa-wand-magic-sparkles',
                                  onClick: () => generateMissing(missing),
                              })
                            : undefined,
                    ),
                ];
            };

            const draw = () => {
                if (!alive) return;
                root.replaceChildren(
                    statusLines(),
                    sentSection(),
                    sceneSection(),
                    ...booksSections(),
                    el('div', { class: 'maestro-m28-actions' }, [
                        button({
                            label: t('m28.view.refresh'),
                            icon: 'fa-rotate',
                            kind: 'ghost',
                            onClick: async () => {
                                service.scene.invalidate(null);
                                books = null;
                                draw();
                                await load();
                            },
                        }),
                    ]),
                );
            };

            const redraw = coalesce(() => draw(), 50);
            const offIndex = service.onIndex(() => {
                if (!alive) return;
                // A batch or a write changed passports: read the books again (the index already follows).
                void load();
                redraw();
            });
            service.scene.syncProvider();
            draw();
            void load();
            return () => {
                alive = false;
                redraw.cancel();
                offIndex();
                root.remove();
            };
        },
    };
}
