// Pult tab «Места» (M24): the chat's places as a tree by nesting with the current one marked, each place unfolding
// into its names (rename, aliases), parent, merge, the description entry («Описание») and its visit history (who was
// there, when, the story date, what happened); then the candidates DES named but the registry does not know yet.
// Mobile first: one column, wrapping rows, native <details> for unfolding.
import { flattenTree, placeTree } from '../../domain/places-registry';
import { descendantIds } from '../../domain/places-match';
import type { App, PultTab } from '../../shared/contracts';
import { badge, emptyState, section } from '../../ui/components/card';
import { button, clear, el, icon } from '../../ui/components/dom';
import { coalesce } from '../../ui/views/format';
import type { Place, PlaceCandidate, PlaceVisit } from './api';
import type { PlacesService } from './service';

export const PLACES_TAB = 'places';
const MAX_DEPTH = 6;
const VISITS_SHOWN = 10;

export const PLACES_CSS = `
.maestro-m24 { display: flex; flex-direction: column; gap: 8px; }
.maestro-m24-now { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m24-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; }
.maestro-m24-row > input, .maestro-m24-row > select { flex: 1 1 160px; min-width: 0; margin: 0; }
.maestro-m24-tree { display: flex; flex-direction: column; gap: 4px; }
.maestro-m24-place { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm);
    margin-left: calc(var(--maestro-m24-depth, 0) * 12px); }
.maestro-m24-place > summary { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 6px 8px;
    cursor: pointer; min-height: 36px; }
.maestro-m24-current { border-color: var(--maestro-accent); box-shadow: inset 3px 0 0 var(--maestro-accent); }
.maestro-m24-name { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m24-body { display: flex; flex-direction: column; gap: 8px; padding: 0 8px 8px; }
.maestro-m24-label { font-size: 0.9em; opacity: 0.85; }
.maestro-m24-chips { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m24-chip { display: inline-flex; align-items: center; gap: 2px; padding: 0 0 0 8px; border-radius: 999px;
    background: var(--maestro-raised-strong); overflow-wrap: anywhere; }
.maestro-m24-visits { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 6px; }
.maestro-m24-visit { border-left: 2px solid var(--maestro-border); padding-left: 6px; overflow-wrap: anywhere; }
.maestro-m24-visit-head { display: flex; flex-wrap: wrap; gap: 6px; }
.maestro-m24-events { margin: 2px 0 0; padding-left: 16px; font-size: 0.9em; opacity: 0.85; }
.maestro-m24-candidates { display: flex; flex-direction: column; gap: 6px; }
.maestro-m24-candidate { border: 1px dashed var(--maestro-border); border-radius: var(--maestro-radius-sm);
    padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; overflow-wrap: anywhere; }
@media (max-width: 600px) { .maestro-m24-place { margin-left: calc(var(--maestro-m24-depth, 0) * 8px); } }
`;

function textInput(value: string, label: string, placeholder?: string): HTMLInputElement {
    const input = el('input', {
        class: 'text_pole maestro-m24-input',
        attrs: { type: 'text', 'aria-label': label, placeholder },
    });
    input.value = value;
    return input;
}

/** Opens a description entry: the Lore Studio API when it exposes one, else `/maestro-lore <book>`. */
export async function openEntry(app: App, entry: { world: string; uid: number }): Promise<boolean> {
    const studio = app.modules.api<{ open?(book?: string, uid?: number): void }>('loreStudio');
    if (typeof studio?.open === 'function') {
        app.ui.closePult?.();
        studio.open(entry.world, entry.uid);
        return true;
    }
    const ctx = app.host.ctx();
    if (typeof ctx.executeSlashCommandsWithOptions !== 'function') return false;
    app.ui.closePult?.();
    await ctx.executeSlashCommandsWithOptions(`/maestro-lore ${entry.world.replace(/\|/g, '\\|')}`, {
        handleExecutionErrors: true,
        source: 'maestro',
    });
    return true;
}

export function placesTab(app: App, service: PlacesService): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    return {
        id: PLACES_TAB,
        titleKey: 'm24.tab',
        icon: 'fa-map-location-dot',
        order: 47,
        render(container) {
            let alive = true;
            const open = new Set<string>();
            const root = el('div', { class: 'maestro-view maestro-m24' });
            container.appendChild(root);

            const run = async (job: () => Promise<unknown>): Promise<void> => {
                try {
                    await job();
                } catch (error) {
                    app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'error' });
                }
                if (alive) draw();
            };

            const range = (visit: PlaceVisit): string => {
                if (visit.to === null) return t('m24.visit.now', { from: visit.from });
                if (visit.to === visit.from) return t('m24.visit.one', { at: visit.from });
                return t('m24.visit.range', { from: visit.from, to: visit.to });
            };

            const visitsView = (place: Place): HTMLElement => {
                if (!place.visits.length) return el('div', { class: 'maestro-muted', text: t('m24.visits.none') });
                const shown = [...place.visits].reverse().slice(0, VISITS_SHOWN);
                const hidden = place.visits.length - shown.length;
                return el('div', {}, [
                    el('div', { class: 'maestro-m24-label', text: t('m24.visits', { count: place.visits.length }) }),
                    el(
                        'ul',
                        { class: 'maestro-m24-visits' },
                        shown.map((visit) =>
                            el('li', { class: 'maestro-m24-visit' }, [
                                el('div', { class: 'maestro-m24-visit-head' }, [
                                    el('span', { text: range(visit) }),
                                    visit.storyDate
                                        ? el('span', { class: 'maestro-muted', text: visit.storyDate })
                                        : null,
                                ]),
                                visit.present.length
                                    ? el('div', { text: t('m24.visit.present', { names: visit.present.join(', ') }) })
                                    : null,
                                visit.events.length
                                    ? el(
                                          'ul',
                                          { class: 'maestro-m24-events' },
                                          visit.events.map((event) => el('li', { text: event })),
                                      )
                                    : null,
                            ]),
                        ),
                    ),
                    hidden > 0
                        ? el('div', { class: 'maestro-muted', text: t('m24.visits.more', { count: hidden }) })
                        : null,
                ]);
            };

            const placeBody = (place: Place, all: Place[]): HTMLElement => {
                const byId = new Map(all.map((item) => [item.id, item]));
                const name = textInput(place.name, t('m24.name'));
                const alias = textInput('', t('m24.alias.add'), t('m24.alias.placeholder'));
                const below = new Set(descendantIds(all, place.id));
                const parent = el('select', {
                    class: 'text_pole maestro-select',
                    attrs: { 'aria-label': t('m24.parent') },
                });
                parent.appendChild(el('option', { text: t('m24.parent.none'), attrs: { value: '' } }));
                for (const other of all) {
                    if (other.id === place.id || below.has(other.id)) continue;
                    parent.appendChild(
                        el('option', { text: service.path(other.id).join(' › '), attrs: { value: other.id } }),
                    );
                }
                parent.value = place.parent ?? '';
                parent.addEventListener('change', () => {
                    void run(() => service.update(place.id, { parent: parent.value || null }));
                });
                const mergeTarget = el('select', {
                    class: 'text_pole maestro-select',
                    attrs: { 'aria-label': t('m24.merge.into') },
                });
                mergeTarget.appendChild(el('option', { text: t('m24.merge.pick'), attrs: { value: '' } }));
                for (const other of all) {
                    if (other.id === place.id) continue;
                    mergeTarget.appendChild(
                        el('option', { text: service.path(other.id).join(' › '), attrs: { value: other.id } }),
                    );
                }
                const children = all.filter((item) => item.parent === place.id).map((item) => item.name);
                const path = service.path(place.id);
                return el('div', { class: 'maestro-m24-body' }, [
                    path.length > 1 ? el('div', { class: 'maestro-muted', text: path.join(' › ') }) : null,
                    el('div', { class: 'maestro-m24-label', text: t('m24.name') }),
                    el('div', { class: 'maestro-m24-row' }, [
                        name,
                        button({
                            label: t('m24.rename'),
                            icon: 'fa-pen',
                            onClick: () => run(() => service.update(place.id, { name: name.value })),
                        }),
                    ]),
                    el('div', { class: 'maestro-m24-label', text: t('m24.aliases') }),
                    place.aliases.length
                        ? el(
                              'div',
                              { class: 'maestro-m24-chips' },
                              place.aliases.map((item) =>
                                  el('span', { class: 'maestro-m24-chip' }, [
                                      el('span', { text: item }),
                                      button({
                                          icon: 'fa-xmark',
                                          kind: 'ghost',
                                          title: t('m24.alias.remove', { alias: item }),
                                          onClick: () =>
                                              run(() =>
                                                  service.update(place.id, {
                                                      aliases: place.aliases.filter((other) => other !== item),
                                                  }),
                                              ),
                                      }),
                                  ]),
                              ),
                          )
                        : el('div', { class: 'maestro-muted', text: t('m24.aliases.none') }),
                    el('div', { class: 'maestro-m24-row' }, [
                        alias,
                        button({
                            label: t('m24.alias.add'),
                            icon: 'fa-plus',
                            onClick: () =>
                                run(async () => {
                                    const value = alias.value.trim();
                                    if (value) await service.update(place.id, { aliases: [...place.aliases, value] });
                                }),
                        }),
                    ]),
                    place.forms.length
                        ? el('div', { class: 'maestro-muted', text: t('m24.forms', { forms: place.forms.join(', ') }) })
                        : null,
                    el('div', { class: 'maestro-m24-label', text: t('m24.parent') }),
                    el('div', { class: 'maestro-m24-row' }, [parent]),
                    children.length
                        ? el('div', { class: 'maestro-muted', text: t('m24.inside', { names: children.join(', ') }) })
                        : null,
                    el('div', { class: 'maestro-m24-label', text: t('m24.merge.into') }),
                    el('div', { class: 'maestro-m24-row' }, [
                        mergeTarget,
                        button({
                            label: t('m24.merge.action'),
                            icon: 'fa-code-merge',
                            onClick: () =>
                                run(async () => {
                                    const target = byId.get(mergeTarget.value);
                                    if (!target) return;
                                    const ok = await app.ui.confirm(
                                        t('m24.merge.confirmTitle'),
                                        t('m24.merge.confirmBody', { from: place.name, to: target.name }),
                                    );
                                    if (ok) await service.merge(target.id, place.id);
                                }),
                        }),
                    ]),
                    el('div', { class: 'maestro-m24-row' }, [
                        button({
                            label: t('m24.entry.action'),
                            icon: 'fa-book-open',
                            title: t('m24.entry.hint'),
                            onClick: () =>
                                run(async () => {
                                    const entry = await service.ensureEntry(place.id);
                                    if (!(await openEntry(app, entry))) {
                                        app.ui.notice(t('m24.entry.ready', { book: entry.world, uid: entry.uid }));
                                    }
                                }),
                        }),
                        button({
                            label: t('m24.remove'),
                            icon: 'fa-trash-can',
                            kind: 'danger',
                            onClick: () =>
                                run(async () => {
                                    const ok = await app.ui.confirm(
                                        t('m24.remove.title'),
                                        t('m24.remove.body', { name: place.name }),
                                    );
                                    if (ok) await service.remove(place.id);
                                }),
                        }),
                    ]),
                    visitsView(place),
                ]);
            };

            const placeView = (place: Place, depth: number, all: Place[], currentId: string | null): HTMLElement => {
                const here = place.id === currentId;
                const details = el('details', {
                    class: ['maestro-m24-place', here ? 'maestro-m24-current' : null],
                    data: { id: place.id },
                    attrs: { style: `--maestro-m24-depth: ${Math.min(depth, MAX_DEPTH)}` },
                });
                if (open.has(place.id)) details.open = true;
                details.addEventListener('toggle', () => {
                    if (details.open) open.add(place.id);
                    else open.delete(place.id);
                });
                details.appendChild(
                    el('summary', {}, [
                        icon(here ? 'fa-location-dot' : 'fa-map-pin'),
                        el('span', { class: 'maestro-m24-name', text: place.name }),
                        here ? badge(t('m24.here'), 'ok') : null,
                        place.entry ? badge(t('m24.described'), 'muted') : null,
                        el('span', {
                            class: 'maestro-muted',
                            text: place.lastSeen >= 0 ? t('m24.lastSeen', { at: place.lastSeen }) : t('m24.notSeen'),
                        }),
                    ]),
                );
                details.appendChild(placeBody(place, all));
                return details;
            };

            const candidateView = (candidate: PlaceCandidate, all: Place[]): HTMLElement => {
                const key = candidate.key ?? candidate.label;
                const pick = el('select', {
                    class: 'text_pole maestro-select',
                    attrs: { 'aria-label': t('m24.candidate.pick') },
                });
                const similar = candidate.similar.filter((id) => all.some((place) => place.id === id));
                const others = all.filter((place) => !similar.includes(place.id));
                for (const id of [...similar, ...others.map((place) => place.id)]) {
                    pick.appendChild(el('option', { text: service.path(id).join(' › '), attrs: { value: id } }));
                }
                const parentPath = candidate.parent ? service.path(candidate.parent).join(' › ') : '';
                const name = candidate.name ?? candidate.label;
                return el('div', { class: 'maestro-m24-candidate', data: { key } }, [
                    el('div', { class: 'maestro-m24-row' }, [
                        el('span', { class: 'maestro-m24-name', text: name }),
                        badge(t('m24.candidate.seen', { count: candidate.seen.length }), 'muted'),
                        candidate.proposed ? badge(t('m24.candidate.inbox'), 'info') : null,
                    ]),
                    candidate.label !== name
                        ? el('div', {
                              class: 'maestro-muted',
                              text: t('m24.candidate.label', { label: candidate.label }),
                          })
                        : null,
                    parentPath
                        ? el('div', { class: 'maestro-muted', text: t('m24.candidate.in', { place: parentPath }) })
                        : null,
                    similar.length
                        ? el('div', {
                              text: t('m24.candidate.similar', {
                                  places: similar.map((id) => service.path(id).join(' › ')).join('; '),
                              }),
                          })
                        : null,
                    el('div', { class: 'maestro-m24-row' }, [
                        button({
                            label: t('m24.candidate.create'),
                            icon: 'fa-plus',
                            kind: 'primary',
                            onClick: () => run(() => service.createCandidate(key)),
                        }),
                        button({
                            label: t('m24.candidate.dismiss'),
                            icon: 'fa-ban',
                            kind: 'ghost',
                            title: t('m24.candidate.dismissHint'),
                            onClick: () => run(() => service.dismissCandidate(key)),
                        }),
                    ]),
                    all.length
                        ? el('div', { class: 'maestro-m24-row' }, [
                              pick,
                              button({
                                  label: t('m24.candidate.same'),
                                  icon: 'fa-link',
                                  onClick: () => run(() => service.mergeCandidate(key, pick.value)),
                              }),
                          ])
                        : null,
                ]);
            };

            const draw = (): void => {
                if (!alive) return;
                clear(root);
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('m24.noChat'), 'fa-map'));
                    return;
                }
                const all = service.list();
                const current = service.current();
                const candidates = service.candidates();
                const newName = textInput('', t('m24.add.name'), t('m24.add.placeholder'));
                root.appendChild(
                    section(t('m24.title'), [
                        el('div', {
                            class: 'maestro-m24-now',
                            text: current
                                ? t('m24.now', { path: service.path(current.id).join(' › ') })
                                : t('m24.now.unknown'),
                        }),
                        el('div', { class: 'maestro-hint', text: t('m24.hint') }),
                        el('div', { class: 'maestro-m24-row' }, [
                            newName,
                            button({
                                label: t('m24.add.action'),
                                icon: 'fa-plus',
                                onClick: () =>
                                    run(async () => {
                                        const value = newName.value.trim();
                                        if (value) open.add((await service.create(value)).id);
                                    }),
                            }),
                        ]),
                    ]),
                );
                root.appendChild(
                    section(
                        t('m24.places', { count: all.length }),
                        all.length
                            ? el(
                                  'div',
                                  { class: 'maestro-m24-tree' },
                                  flattenTree(placeTree(all)).map((node) =>
                                      placeView(node.place, node.depth, all, current?.id ?? null),
                                  ),
                              )
                            : emptyState(t('m24.empty'), 'fa-map'),
                    ),
                );
                if (candidates.length) {
                    root.appendChild(
                        section(t('m24.candidates', { count: candidates.length }), [
                            el('div', { class: 'maestro-hint', text: t('m24.candidates.hint') }),
                            el(
                                'div',
                                { class: 'maestro-m24-candidates' },
                                candidates.map((candidate) => candidateView(candidate, all)),
                            ),
                        ]),
                    );
                }
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
