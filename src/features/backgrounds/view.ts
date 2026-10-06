// Pult tab «Фоны» (M29): the current place and scene, the chat background and who set it (with «Снова выбирать
// самому» while it is the user's), the best library candidates for a place with thumbnails («Поставить», «Привязать
// к месту» as the main background or a time/weather variant), what is bound to the place, «Сгенерировать фон» with an
// Anlas note (not in «Экономный»), the library size and the settings. Mobile first: wrapping rows, one column.
import { boundSet } from '../../domain/backgrounds-score';
import { libraryFileOf, cssUrlPath } from '../../domain/backgrounds-state';
import { VARIANT_TAGS, fileTitle } from '../../domain/backgrounds-tokens';
import type { App, PultTab } from '../../shared/contracts';
import { badge, banner, emptyState, section } from '../../ui/components/card';
import { field, numberInput, select, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import { coalesce } from '../../ui/views/format';
import type { Place } from '../places/api';
import type { BackgroundChoice } from './api';
import { BOUND_SCORE } from './service';
import type { BackgroundsService, BackgroundsState } from './service';
import { BACKGROUNDS_KEY, THRESHOLD_MAX, THRESHOLD_MIN } from './settings';
import type { BackgroundsSettings } from './settings';

export const BACKGROUNDS_TAB = 'backgrounds';
const CANDIDATES_SHOWN = 6;

export const BACKGROUNDS_CSS = `
.maestro-m29 { display: flex; flex-direction: column; gap: 8px; }
.maestro-m29-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; overflow-wrap: anywhere; }
.maestro-m29-row > select { flex: 1 1 160px; min-width: 0; margin: 0; }
.maestro-m29-now { display: flex; flex-wrap: wrap; gap: 8px; align-items: flex-start; }
.maestro-m29-now-text { display: flex; flex-direction: column; gap: 4px; flex: 1 1 200px; min-width: 0;
    overflow-wrap: anywhere; }
.maestro-m29-thumb { width: 160px; max-width: 100%; aspect-ratio: 16 / 9; object-fit: cover;
    border-radius: var(--maestro-radius-sm); border: 1px solid var(--maestro-border); background: var(--maestro-raised); }
.maestro-m29-list { display: flex; flex-direction: column; gap: 6px; }
.maestro-m29-item { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; padding: 6px 8px;
    border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); }
.maestro-m29-item.maestro-m29-on { border-color: var(--maestro-accent); box-shadow: inset 3px 0 0 var(--maestro-accent); }
.maestro-m29-info { display: flex; flex-direction: column; gap: 4px; flex: 1 1 180px; min-width: 0; overflow-wrap: anywhere; }
.maestro-m29-name { font-weight: 600; }
.maestro-m29-tags { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m29-actions { display: flex; flex-wrap: wrap; gap: 4px; }
@media (max-width: 600px) { .maestro-m29-thumb { width: 100%; } }
`;

export function backgroundsTab(app: App, service: BackgroundsService, settings: () => BackgroundsSettings): PultTab {
    const t = app.i18n.t.bind(app.i18n);

    const commit = (path: string) => {
        app.settings.notify(`modules.${BACKGROUNDS_KEY}.${path}`);
        app.settings.save();
    };

    const run = async (job: () => Promise<unknown>) => {
        try {
            await job();
        } catch (error) {
            // A failed action of the user's own: shown at every notification level.
            app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'warn', urgent: true });
        }
    };

    const title = (file: string) => fileTitle(file) || file;

    const describe = (value: string): string => {
        const file = libraryFileOf(value);
        return file ? title(file) : (cssUrlPath(value) ?? value);
    };

    const thumb = (src: string | null, alt: string): HTMLElement | null =>
        src ? el('img', { class: 'maestro-m29-thumb', attrs: { src, alt, loading: 'lazy' } }) : null;

    const tagText = (tag: string) => t(`m29.tag.${tag}`);

    const tagList = (tags: readonly string[]): HTMLElement =>
        el(
            'div',
            { class: 'maestro-m29-tags' },
            tags.map((tag) => badge(tagText(tag), 'muted')),
        );

    return {
        id: BACKGROUNDS_TAB,
        titleKey: 'm29.tab',
        icon: 'fa-image',
        order: 62,
        render(container) {
            let alive = true;
            let selected: string | null = null;
            let bindAs = 'main';
            let candidates: { placeId: string; list: BackgroundChoice[] } | null = null;
            /** The shown candidates are out of date (the scene, place or library changed): ask again. */
            let stale = false;
            let loadingFor: string | null = null;
            let generation = 0;
            const root = el('div', { class: 'maestro-view maestro-m29' });
            container.appendChild(root);

            const requestCandidates = (placeId: string) => {
                const mine = ++generation;
                loadingFor = placeId;
                void service
                    .candidates(placeId, CANDIDATES_SHOWN)
                    .then((list) => {
                        if (!alive || mine !== generation) return;
                        candidates = { placeId, list };
                        stale = false;
                        loadingFor = null;
                        draw();
                    })
                    .catch((error: unknown) => {
                        if (mine === generation) loadingFor = null;
                        app.log.warn('background candidates failed', error);
                    });
            };

            const nowSection = (state: BackgroundsState): HTMLElement => {
                const scene = [state.conditions.time, ...state.conditions.weather, state.conditions.season].filter(
                    (tag): tag is NonNullable<typeof tag> => !!tag,
                );
                let owner: string;
                if (state.owner === 'maestro' && state.current) {
                    owner = t('m29.owner.maestro', {
                        file: title(state.current.file),
                        source: t(`m29.source.${state.current.source}`),
                    });
                } else if (state.owner === 'user') {
                    owner = state.live ? t('m29.owner.user', { file: describe(state.live) }) : t('m29.owner.removed');
                } else if (state.owner === 'released') {
                    owner = t('m29.owner.released', { file: describe(state.live) });
                } else owner = t('m29.owner.none');
                return section(t('m29.now.title'), [
                    el('div', { class: 'maestro-m29-now' }, [
                        state.live ? thumb(service.preview(state.live), describe(state.live)) : null,
                        el('div', { class: 'maestro-m29-now-text' }, [
                            el('div', {
                                class: 'maestro-m29-place',
                                text: state.place
                                    ? t('m29.now.place', { place: state.placePath.join(' › ') || state.place.name })
                                    : t('m29.now.noPlace'),
                            }),
                            el('div', {
                                class: 'maestro-m29-scene',
                                text: scene.length
                                    ? t('m29.now.scene', { scene: scene.map(tagText).join(', ') })
                                    : t('m29.now.sceneUnknown'),
                            }),
                            el('div', { class: 'maestro-m29-owner', text: owner }),
                            state.owner === 'maestro' && state.current?.variant.length
                                ? tagList(state.current.variant)
                                : null,
                        ]),
                    ]),
                    state.pinned
                        ? el('div', { class: 'maestro-m29-row' }, [
                              button({
                                  label: t('m29.release'),
                                  title: t('m29.release.hint'),
                                  icon: 'fa-rotate',
                                  kind: 'primary',
                                  className: 'maestro-m29-release',
                                  onClick: () => run(() => service.release()),
                              }),
                          ])
                        : null,
                ]);
            };

            const candidateItem = (choice: BackgroundChoice, place: Place, state: BackgroundsState): HTMLElement => {
                const on = state.current?.file === choice.file;
                const bound = choice.score >= BOUND_SCORE;
                return el(
                    'div',
                    { class: ['maestro-m29-item', 'maestro-m29-candidate', on ? 'maestro-m29-on' : null] },
                    [
                        thumb(service.thumbnail(choice.file), title(choice.file)),
                        el('div', { class: 'maestro-m29-info' }, [
                            el('div', { class: 'maestro-m29-name', text: title(choice.file) }),
                            el('div', { class: 'maestro-m29-tags' }, [
                                bound
                                    ? badge(t('m29.candidates.bound'), 'ok')
                                    : badge(t('m29.candidates.score', { score: choice.score }), 'info'),
                                choice.source === 'generated' ? badge(t('m29.source.generated'), 'muted') : null,
                                on ? badge(t('m29.candidates.shown'), 'ok') : null,
                                ...choice.variant.map((tag) => badge(tagText(tag), 'muted')),
                            ]),
                            el('div', { class: 'maestro-m29-actions' }, [
                                button({
                                    label: t('m29.action.pick'),
                                    title: t('m29.action.pick.hint'),
                                    icon: 'fa-image',
                                    kind: 'primary',
                                    className: 'maestro-m29-pick',
                                    disabled: on,
                                    onClick: () => run(() => service.pick(place.id, choice.file)),
                                }),
                                button({
                                    label: t('m29.action.bind'),
                                    title: t('m29.action.bind.hint'),
                                    icon: 'fa-link',
                                    className: 'maestro-m29-bind',
                                    onClick: () =>
                                        run(() =>
                                            service.bind(
                                                place.id,
                                                choice.file,
                                                bindAs === 'main' ? undefined : [bindAs],
                                            ),
                                        ),
                                }),
                            ]),
                        ]),
                    ],
                );
            };

            const candidatesSection = (place: Place, state: BackgroundsState): HTMLElement => {
                const places = service.places();
                const head: HTMLElement[] = [];
                if (places.length > 1) {
                    head.push(
                        field(
                            t('m29.candidates.place'),
                            select({
                                value: place.id,
                                label: t('m29.candidates.place'),
                                options: places.map((item) => ({ value: item.id, label: item.name })),
                                onChange: (value) => {
                                    selected = value;
                                    draw();
                                },
                            }),
                        ),
                    );
                }
                head.push(
                    field(
                        t('m29.bindAs'),
                        select({
                            value: bindAs,
                            label: t('m29.bindAs'),
                            options: [
                                { value: 'main', label: t('m29.bindAs.main') },
                                ...VARIANT_TAGS.map((tag) => ({
                                    value: tag as string,
                                    label: t('m29.bindAs.variant', { tag: tagText(tag) }),
                                })),
                            ],
                            onChange: (value) => {
                                bindAs = value;
                            },
                        }),
                    ),
                );
                let body: HTMLElement;
                const shown = candidates?.placeId === place.id ? candidates : null;
                if ((!shown || stale) && loadingFor !== place.id) requestCandidates(place.id);
                if (shown) {
                    body = shown.list.length
                        ? el(
                              'div',
                              { class: 'maestro-m29-list' },
                              shown.list.map((choice) => candidateItem(choice, place, state)),
                          )
                        : emptyState(t('m29.candidates.none'), 'fa-image');
                } else {
                    body = el('div', { class: 'maestro-muted', text: t('m29.candidates.loading') });
                }
                return section(t('m29.candidates.title', { place: place.name }), [...head, body]);
            };

            const boundSection = (place: Place): HTMLElement => {
                const bound = boundSet(place);
                const rows: HTMLElement[] = [];
                const row = (label: string, file: string, unbind: () => Promise<void>) => {
                    const missing = service.inLibrary(file) === false;
                    return el('div', { class: ['maestro-m29-item', 'maestro-m29-bound'] }, [
                        thumb(service.thumbnail(file), title(file)),
                        el('div', { class: 'maestro-m29-info' }, [
                            el('div', { class: 'maestro-m29-name', text: label }),
                            el('div', { class: 'maestro-m29-row' }, [
                                el('span', { text: title(file) }),
                                missing ? badge(t('m29.bound.missing'), 'warn') : null,
                            ]),
                            el('div', { class: 'maestro-m29-actions' }, [
                                button({
                                    label: t('m29.action.unbind'),
                                    icon: 'fa-link-slash',
                                    kind: 'ghost',
                                    className: 'maestro-m29-unbind',
                                    onClick: () => run(unbind),
                                }),
                            ]),
                        ]),
                    ]);
                };
                if (bound.main) rows.push(row(t('m29.bound.main'), bound.main, () => service.unbind(place.id)));
                for (const variant of bound.variants) {
                    rows.push(
                        row(t('m29.bound.variant', { tags: variant.tags.map(tagText).join(' + ') }), variant.file, () =>
                            service.unbind(place.id, variant.tags),
                        ),
                    );
                }
                return section(t('m29.bound.title'), [
                    rows.length
                        ? el('div', { class: 'maestro-m29-list' }, rows)
                        : el('div', { class: 'maestro-muted', text: t('m29.bound.none') }),
                ]);
            };

            const generateSection = (place: Place, state: BackgroundsState): HTMLElement => {
                if (app.settings.core().mode === 'economy') {
                    return section(t('m29.generate.title'), [
                        el('div', { class: 'maestro-muted', text: t('m29.generate.economy') }),
                    ]);
                }
                const can = service.canGenerate();
                const busy = service.isGenerating(place.id);
                const noMatch = state.noMatch && state.place?.id === place.id;
                return section(t('m29.generate.title'), [
                    noMatch ? banner(t('m29.generate.noMatch'), 'info', 'fa-circle-info') : null,
                    el('div', { class: 'maestro-hint', text: t('m29.generate.hint', { place: place.name }) }),
                    can
                        ? el('div', {
                              class: 'maestro-m29-budget',
                              text: t(`m29.generate.budget.${service.budget()}`),
                          })
                        : el('div', { class: 'maestro-muted', text: t('m29.generate.missing') }),
                    el('div', { class: 'maestro-m29-row' }, [
                        button({
                            label: busy ? t('m29.generate.busy') : t('m29.generate.button'),
                            icon: 'fa-wand-magic-sparkles',
                            kind: noMatch ? 'primary' : 'default',
                            className: 'maestro-m29-generate',
                            disabled: !can || busy,
                            onClick: () => run(() => service.generate(place.id)),
                        }),
                    ]),
                ]);
            };

            const librarySection = (): HTMLElement => {
                const info = service.libraryInfo();
                return el('div', { class: 'maestro-m29-row maestro-m29-library' }, [
                    el('span', {
                        class: 'maestro-muted',
                        text: info ? t('m29.library.count', { count: info.count }) : t('m29.library.unknown'),
                    }),
                    button({
                        label: t('m29.library.refresh'),
                        icon: 'fa-arrows-rotate',
                        kind: 'ghost',
                        className: 'maestro-m29-refresh',
                        onClick: () => run(() => service.refreshLibrary()),
                    }),
                ]);
            };

            const settingsSection = (): HTMLElement => {
                const current = settings();
                return section(t('m29.settings.title'), [
                    toggle({
                        label: t('m29.settings.auto'),
                        hint: t('m29.settings.auto.hint'),
                        checked: current.auto,
                        onChange: (checked) => {
                            settings().auto = checked;
                            commit('auto');
                        },
                    }),
                    field(
                        t('m29.settings.threshold'),
                        numberInput({
                            value: current.threshold,
                            min: THRESHOLD_MIN,
                            max: THRESHOLD_MAX,
                            step: 0.5,
                            label: t('m29.settings.threshold'),
                            onChange: (value) => {
                                settings().threshold = value;
                                commit('threshold');
                            },
                        }),
                        t('m29.settings.threshold.hint'),
                    ),
                    toggle({
                        label: t('m29.settings.variants'),
                        hint: t('m29.settings.variants.hint'),
                        checked: current.variants,
                        onChange: (checked) => {
                            settings().variants = checked;
                            commit('variants');
                        },
                    }),
                ]);
            };

            const draw = () => {
                if (!alive) return;
                clear(root);
                root.appendChild(el('div', { class: 'maestro-hint', text: t('m29.hint') }));
                const state = service.state();
                if (!state.chatId) {
                    root.appendChild(emptyState(t('m29.noChat'), 'fa-comment-slash'));
                    root.appendChild(settingsSection());
                    return;
                }
                if (!app.leader.isLeader()) root.appendChild(banner(t('m29.notLeader'), 'muted', 'fa-circle-info'));
                if (!service.hasPlaces()) root.appendChild(banner(t('m29.noPlaces'), 'warn'));
                root.appendChild(nowSection(state));
                const place = (selected ? service.place(selected) : undefined) ?? state.place;
                if (place) {
                    root.appendChild(candidatesSection(place, state));
                    root.appendChild(boundSection(place));
                    root.appendChild(generateSection(place, state));
                }
                root.appendChild(librarySection());
                root.appendChild(settingsSection());
            };

            const redraw = coalesce(draw, 100);
            const off = service.onChange(() => {
                if (!alive) return;
                // Candidates depend on the scene, the place and the library: ask again after any change.
                generation++;
                loadingFor = null;
                stale = true;
                redraw();
            });
            draw();
            return () => {
                alive = false;
                redraw.cancel();
                off();
                root.remove();
            };
        },
    };
}
