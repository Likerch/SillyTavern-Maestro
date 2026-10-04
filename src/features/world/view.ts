// Pult tab «Мир» (M7): entities by kind with a search, the number of sources, the «in the scene» badge, sources and
// forms on demand; merge candidates with «Merge» / «Different»; the chat alias editor. Plain DOM, mobile-first
// (rows wrap, no fixed widths).
import type { App, PultTab } from '../../shared/contracts';
import { badge, emptyState, section } from '../../ui/components/card';
import { button, clear, el } from '../../ui/components/dom';
import { select } from '../../ui/components/controls';
import { coalesce, formatTime, tOr } from '../../ui/views/format';
import { normalizeName, WORLD_KINDS } from '../../domain/world-names';
import type { Entity, MergeCandidate } from './api';
import type { WorldModel } from './model';

export const WORLD_TAB = 'world';
const LIST_PREVIEW = 6;

export const WORLD_CSS = `
.maestro-m7w-head { display: flex; flex-direction: column; gap: 6px; }
.maestro-m7w-search { width: 100%; box-sizing: border-box; }
.maestro-m7w-list { display: flex; flex-direction: column; gap: 6px; }
.maestro-m7w-entity { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm); padding: 6px 8px; }
.maestro-m7w-entity-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m7w-name { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m7w-line { font-size: 0.9em; overflow-wrap: anywhere; }
.maestro-m7w-sources { margin: 4px 0 0; padding-left: 18px; font-size: 0.9em; }
.maestro-m7w-sources li { overflow-wrap: anywhere; }
.maestro-m7w-pair { display: flex; flex-direction: column; gap: 4px; border: 1px solid var(--maestro-border);
    border-radius: var(--maestro-radius-sm); padding: 6px 8px; }
.maestro-m7w-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.maestro-m7w-alias { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m7w-alias-form { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; margin-top: 6px; }
.maestro-m7w-alias-form input, .maestro-m7w-alias-form select { flex: 1 1 160px; min-width: 0; }
`;

function matches(entity: Entity, query: string): boolean {
    if (!query) return true;
    return [entity.name, ...entity.aliases, ...entity.forms].some((name) => normalizeName(name).includes(query));
}

function preview(list: readonly string[]): string {
    return list.length > LIST_PREVIEW ? `${list.slice(0, LIST_PREVIEW).join(', ')}, …` : list.join(', ');
}

export function worldTab(app: App, model: WorldModel): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: WORLD_TAB,
        titleKey: 'm7w.tab',
        icon: 'fa-earth-europe',
        order: 45,
        badge: () => (app.host.chatId() ? model.candidateCount() : 0),
        render(container) {
            let alive = true;
            let query = '';
            let aliasDraft = '';
            let aliasTarget = '';
            const root = el('div', { class: 'maestro-view maestro-m7w' });
            container.appendChild(root);
            const listBox = el('div', { class: 'maestro-m7w-body' });

            const run = async (job: () => Promise<unknown>) => {
                try {
                    await job();
                } catch (error) {
                    app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'error' });
                }
            };

            const entityView = (entity: Entity): HTMLElement => {
                const sourceItems = entity.sources.map((source) =>
                    el('li', {}, [
                        el('span', {
                            class: 'maestro-muted',
                            text: `${tOr(app.i18n, `m7w.source.${source.kind}`, source.kind)}: `,
                        }),
                        el('span', { text: source.world ? `${source.label} (${source.world})` : source.label }),
                    ]),
                );
                return el('div', { class: 'maestro-m7w-entity', data: { id: entity.id } }, [
                    el('div', { class: 'maestro-m7w-entity-head' }, [
                        el('span', { class: 'maestro-m7w-name', text: entity.name }),
                        entity.present === true ? badge(t('m7w.present'), 'ok') : null,
                        entity.present === false ? badge(t('m7w.absent'), 'muted') : null,
                        badge(t('m7w.sources', { count: entity.sources.length }), 'muted'),
                    ]),
                    entity.aliases.length
                        ? el('div', {
                              class: 'maestro-m7w-line maestro-muted',
                              text: t('m7w.aliasList', { list: preview(entity.aliases) }),
                          })
                        : null,
                    el('details', {}, [
                        el('summary', { text: t('m7w.details') }),
                        el('ul', { class: 'maestro-m7w-sources' }, sourceItems),
                        entity.forms.length
                            ? el('div', {
                                  class: 'maestro-m7w-line maestro-muted',
                                  text: t('m7w.formList', { list: entity.forms.join(', ') }),
                              })
                            : null,
                    ]),
                ]);
            };

            const drawList = () => {
                clear(listBox);
                const entities = model.entities();
                if (!entities.length) {
                    listBox.appendChild(emptyState(t('m7w.empty'), 'fa-earth-europe'));
                    return;
                }
                const q = normalizeName(query);
                const shown = entities.filter((entity) => matches(entity, q));
                if (!shown.length) {
                    listBox.appendChild(emptyState(t('m7w.nothingFound'), 'fa-magnifying-glass'));
                    return;
                }
                for (const kind of WORLD_KINDS) {
                    const group = shown.filter((entity) => entity.kind === kind);
                    if (!group.length) continue;
                    listBox.appendChild(
                        section(
                            t(`m7w.kind.${kind}`, { count: group.length }),
                            el('div', { class: 'maestro-m7w-list' }, group.map(entityView)),
                        ),
                    );
                }
            };

            const candidateView = (candidate: MergeCandidate): HTMLElement | null => {
                const a = model.get(candidate.a);
                const b = model.get(candidate.b);
                if (!a || !b) return null;
                return el('div', { class: 'maestro-m7w-pair' }, [
                    el('div', { class: 'maestro-m7w-name', text: t('m7w.candidate.pair', { a: a.name, b: b.name }) }),
                    el('div', {
                        class: 'maestro-m7w-line maestro-muted',
                        text: t(`m7w.reason.${candidate.reason}`, {
                            name: candidate.name ?? b.name,
                            a: a.name,
                            b: b.name,
                        }),
                    }),
                    el('div', { class: 'maestro-m7w-actions' }, [
                        button({
                            label: t('m7w.candidate.merge'),
                            icon: 'fa-link',
                            kind: 'primary',
                            title: t('m7w.candidate.mergeHint', { a: a.name, b: b.name }),
                            onClick: () =>
                                run(async () => {
                                    await model.mergeAndRecord(a.id, b.id);
                                    app.ui.notice(t('m7w.merge.done', { alias: b.name }));
                                }),
                        }),
                        button({
                            label: t('m7w.candidate.separate'),
                            icon: 'fa-link-slash',
                            title: t('m7w.candidate.separateHint'),
                            onClick: () =>
                                run(async () => {
                                    await model.separateAndRecord(a.id, b.id);
                                    app.ui.notice(t('m7w.separate.done'));
                                }),
                        }),
                    ]),
                ]);
            };

            const aliasesView = (): HTMLElement => {
                const aliases = Object.entries(model.chatAliases()).sort(([x], [y]) => x.localeCompare(y));
                const entities = model.entities();
                const rows = aliases.map(([alias, id]) => {
                    const target = model.get(id);
                    return el('div', { class: 'maestro-m7w-alias' }, [
                        el('span', { class: 'maestro-m7w-name', text: alias }),
                        el('span', { class: 'maestro-muted', text: '→' }),
                        el('span', { text: target ? target.name : t('m7w.alias.missing', { id }) }),
                        button({
                            icon: 'fa-xmark',
                            kind: 'ghost',
                            title: t('m7w.alias.remove'),
                            onClick: () => run(() => model.setAliasAndRecord(alias, null)),
                        }),
                    ]);
                });
                const input = el('input', {
                    class: 'text_pole',
                    attrs: { type: 'text', 'aria-label': t('m7w.alias.input'), placeholder: t('m7w.alias.input') },
                });
                input.value = aliasDraft;
                input.addEventListener('input', () => {
                    aliasDraft = input.value;
                });
                if (!entities.some((entity) => entity.id === aliasTarget)) aliasTarget = entities[0]?.id ?? '';
                const picker = select({
                    value: aliasTarget,
                    label: t('m7w.alias.entity'),
                    options: entities.map((entity) => ({ value: entity.id, label: entity.name })),
                    onChange: (value) => {
                        aliasTarget = value;
                    },
                });
                const form = el('div', { class: 'maestro-m7w-alias-form' }, [
                    input,
                    picker,
                    button({
                        label: t('m7w.alias.add'),
                        icon: 'fa-plus',
                        disabled: !entities.length,
                        onClick: () =>
                            run(async () => {
                                await model.setAliasAndRecord(aliasDraft, aliasTarget || null);
                                aliasDraft = '';
                            }),
                    }),
                ]);
                return section(t('m7w.aliases.title'), [
                    el('div', { class: 'maestro-hint', text: t('m7w.aliases.hint') }),
                    rows.length
                        ? el('div', { class: 'maestro-m7w-list' }, rows)
                        : el('div', { class: 'maestro-muted', text: t('m7w.aliases.none') }),
                    form,
                ]);
            };

            const draw = () => {
                if (!alive) return;
                clear(root);
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('m7w.noChat'), 'fa-comment-slash'));
                    return;
                }
                const entities = model.entities();
                const readAt = model.loreReadAt();
                const search = el('input', {
                    class: 'text_pole maestro-m7w-search',
                    attrs: { type: 'search', 'aria-label': t('m7w.search'), placeholder: t('m7w.search') },
                });
                search.value = query;
                search.addEventListener('input', () => {
                    query = search.value;
                    drawList();
                });
                root.appendChild(
                    section(
                        t('m7w.title'),
                        el('div', { class: 'maestro-m7w-head' }, [
                            el('div', { class: 'maestro-hint', text: t('m7w.hint') }),
                            el('div', { text: t('m7w.count', { count: entities.length }) }),
                            el('div', {
                                class: 'maestro-muted',
                                text:
                                    readAt !== null
                                        ? t('m7w.lore.read', { time: formatTime(readAt, app.i18n) })
                                        : t('m7w.lore.pending'),
                            }),
                            search,
                        ]),
                        [
                            button({
                                label: t('m7w.rebuild'),
                                icon: 'fa-rotate',
                                title: t('m7w.rebuild.hint'),
                                onClick: () => run(() => model.rebuild()),
                            }),
                        ],
                    ),
                );
                const candidates = model
                    .mergeCandidates()
                    .map(candidateView)
                    .filter((node): node is HTMLElement => node !== null);
                root.appendChild(
                    section(t('m7w.candidates.title', { count: candidates.length }), [
                        el('div', { class: 'maestro-hint', text: t('m7w.candidates.hint') }),
                        candidates.length
                            ? el('div', { class: 'maestro-m7w-list' }, candidates)
                            : el('div', { class: 'maestro-muted', text: t('m7w.candidates.none') }),
                    ]),
                );
                root.appendChild(listBox);
                drawList();
                root.appendChild(aliasesView());
            };

            const redraw = coalesce(() => {
                // Keep focus in the search or alias field while the model updates underneath.
                const active = typeof document !== 'undefined' ? document.activeElement : null;
                if (active && root.contains(active) && active.tagName === 'INPUT') {
                    drawList();
                    return;
                }
                draw();
                app.ui.refresh();
            }, 100);
            const off = model.onChange(() => alive && redraw());
            draw();
            return () => {
                alive = false;
                redraw.cancel();
                off();
            };
        },
    };
}
