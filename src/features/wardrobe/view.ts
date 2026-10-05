// Pult tab «Гардероб» (plan M27): per character in the scene — what is worn, the known outfits with «Надеть», the
// states that are on and the recent changes with «Отменить»; the current place with its location passport and
// states; which parts work by themselves. Cards and wrapped rows: readable on a phone.
import type { HistoryEntry } from '../../domain/wardrobe-doc';
import type { App, PultTab } from '../../shared/contracts';
import { badge, banner, card, emptyState, section } from '../../ui/components/card';
import { toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import { coalesce, formatTime } from '../../ui/views/format';
import type { PassportTarget, WardrobeService } from './service';
import { WARDROBE_KEY } from './settings';
import type { WardrobeSettings } from './settings';

export const WARDROBE_TAB = 'wardrobe';
/** Recent changes shown per character or place. */
const RECENT_SHOWN = 5;
/** Wordings shown under an outfit. */
const SEEN_SHOWN = 2;

export const WARDROBE_CSS = `
.maestro-m27 .maestro-m27-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; overflow-wrap: anywhere; }
.maestro-m27 .maestro-m27-list { display: flex; flex-direction: column; gap: 6px; }
.maestro-m27 .maestro-m27-outfit { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm);
    padding: 6px 8px; display: flex; flex-direction: column; gap: 4px; }
.maestro-m27 .maestro-m27-outfit-name { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m27 .maestro-m27-tags { font-size: 0.85em; opacity: 0.8; overflow-wrap: anywhere; }
.maestro-m27 .maestro-m27-seen { font-size: 0.85em; font-style: italic; opacity: 0.75; overflow-wrap: anywhere; }
.maestro-m27 .maestro-m27-change { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; font-size: 0.9em; }
.maestro-m27 .maestro-m27-change.maestro-m27-undone { opacity: 0.6; text-decoration: line-through; }
.maestro-m27 .maestro-m27-sub { font-weight: 600; margin-top: 4px; }
`;

export function wardrobeTab(app: App, service: WardrobeService, settings: () => WardrobeSettings): PultTab {
    const t = app.i18n.t.bind(app.i18n);

    const stateLabel = (id: string): string => {
        const key = `m27.state.${id}`;
        const text = t(key);
        return text === key ? id : text;
    };

    const run = async (job: () => Promise<unknown>) => {
        try {
            await job();
        } catch (error) {
            app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'warn' });
        }
    };

    const undo = (entry: HistoryEntry) =>
        run(async () => {
            const id = service.journalRecordOf(entry.op);
            if (!id || !(await app.journal.undo(id))) throw new Error(t('m27.undo.failed'));
        });

    const changeText = (entry: HistoryEntry): string => {
        if (entry.kind === 'outfit') {
            if (entry.created) return t('m27.change.created', { name: entry.state });
            return entry.state ? t('m27.change.worn', { name: entry.state }) : t('m27.change.clothing');
        }
        return t(entry.enabled ? 'm27.change.on' : 'm27.change.off', { state: stateLabel(entry.state) });
    };

    const changeMeta = (entry: HistoryEntry): string => {
        const parts: string[] = [];
        if (entry.origin === 'user') parts.push(t('m27.change.byHand'));
        else if (entry.origin === 'revision') parts.push(t('m27.change.revision'));
        if (entry.messageIndex >= 0) parts.push(t('m27.change.message', { index: entry.messageIndex }));
        if (entry.at) parts.push(formatTime(entry.at, app.i18n));
        return parts.join(' · ');
    };

    const changes = (entries: HistoryEntry[]): HTMLElement =>
        entries.length
            ? el(
                  'div',
                  { class: 'maestro-m27-list' },
                  entries.map((entry) =>
                      el('div', { class: ['maestro-m27-change', entry.undone ? 'maestro-m27-undone' : null] }, [
                          el('span', { text: changeText(entry) }),
                          el('span', { class: 'maestro-muted', text: changeMeta(entry) }),
                          entry.undone
                              ? el('span', { class: 'maestro-muted', text: t('m27.undone') })
                              : button({
                                    label: t('m27.undo'),
                                    title: t('m27.undo.hint'),
                                    icon: 'fa-rotate-left',
                                    kind: 'ghost',
                                    className: 'maestro-m27-undo',
                                    onClick: () => undo(entry),
                                }),
                      ]),
                  ),
              )
            : el('div', { class: 'maestro-muted', text: t('m27.recent.none') });

    const characterCard = (target: PassportTarget): HTMLElement => {
        const passport = target.passport;
        const active = passport.activeOutfit;
        const outfits = service.outfits().filter((outfit) => outfit.passportId === target.passportId);
        const states = passport.states.filter((state) => state.enabled).map((state) => stateLabel(state.id));
        const wear = (name: string) => run(() => service.wear(target.passportId, name));
        const outfitRows = outfits.map((outfit) =>
            el('div', { class: 'maestro-m27-outfit' }, [
                el('div', { class: 'maestro-m27-row' }, [
                    el('span', { class: 'maestro-m27-outfit-name', text: outfit.name }),
                    outfit.active ? badge(t('m27.active'), 'ok') : null,
                    el('span', { class: 'maestro-grow' }),
                    outfit.active
                        ? null
                        : button({
                              label: t('m27.wear'),
                              title: t('m27.wear.hint'),
                              icon: 'fa-shirt',
                              kind: 'primary',
                              className: 'maestro-m27-wear',
                              onClick: () => wear(outfit.name),
                          }),
                ]),
                outfit.tags ? el('div', { class: 'maestro-m27-tags', text: outfit.tags }) : null,
                outfit.seenAs.length
                    ? el('div', {
                          class: 'maestro-m27-seen',
                          text: t('m27.seenAs', { text: outfit.seenAs.slice(-SEEN_SHOWN).join(' / ') }),
                      })
                    : null,
            ]),
        );
        return card({
            className: 'maestro-m27-character',
            title: target.name,
            subtitle: el('div', { class: 'maestro-m27-row' }, [
                el('span', {
                    class: 'maestro-m27-wearing',
                    text: t('m27.wearing', { outfit: active || t('m27.clothing') }),
                }),
            ]),
            body: [
                el('div', {
                    class: 'maestro-m27-states',
                    text: states.length ? t('m27.states', { list: states.join(', ') }) : t('m27.states.none'),
                }),
                el('div', { class: 'maestro-m27-sub', text: t('m27.outfits', { count: outfits.length }) }),
                outfitRows.length
                    ? el('div', { class: 'maestro-m27-list' }, outfitRows)
                    : el('div', { class: 'maestro-muted', text: t('m27.outfits.empty') }),
                active
                    ? el('div', { class: 'maestro-m27-row' }, [
                          button({
                              label: t('m27.wear.clothing'),
                              title: t('m27.wear.clothing.hint'),
                              icon: 'fa-user',
                              kind: 'ghost',
                              className: 'maestro-m27-clothing',
                              onClick: () => wear(''),
                          }),
                      ])
                    : null,
                el('div', { class: 'maestro-m27-sub', text: t('m27.recent') }),
                changes(service.history({ passportId: target.passportId, limit: RECENT_SHOWN })),
            ],
        });
    };

    const charactersSection = (): HTMLElement => {
        const { targets, present } = service.presentCharacters();
        return section(t(present ? 'm27.section.present' : 'm27.section.all'), [
            targets.length
                ? el('div', { class: 'maestro-m27-list' }, targets.map(characterCard))
                : emptyState(t('m27.empty.characters'), 'fa-shirt'),
        ]);
    };

    const placeSection = (): HTMLElement => {
        const view = service.currentPlace();
        if (!view)
            return section(t('m27.place.title'), [el('div', { class: 'maestro-muted', text: t('m27.place.none') })]);
        const enabled = view.target?.passport.states.filter((state) => state.enabled).map((state) => state.id) ?? [];
        const states = [...new Set([...view.states, ...enabled])].map(stateLabel);
        return section(t('m27.place.title'), [
            card({
                className: 'maestro-m27-place',
                title: view.place.name,
                subtitle: view.target
                    ? el('span', {
                          text: t('m27.place.passport', { name: view.target.passport.name || view.target.passportId }),
                      })
                    : undefined,
                body: [
                    view.target ? null : banner(t('m27.place.noPassport'), 'muted', 'fa-circle-info'),
                    el('div', {
                        class: 'maestro-m27-states',
                        text: states.length ? t('m27.place.states', { list: states.join(', ') }) : t('m27.states.none'),
                    }),
                    el('div', { class: 'maestro-m27-sub', text: t('m27.recent') }),
                    changes(service.history({ placeId: view.place.id, limit: RECENT_SHOWN })),
                ],
            }),
        ]);
    };

    const settingsSection = (): HTMLElement => {
        const current = settings();
        const option = (key: keyof WardrobeSettings) =>
            toggle({
                label: t(`m27.settings.${key}`),
                checked: current[key],
                onChange: (checked) => {
                    settings()[key] = checked;
                    app.settings.notify(`modules.${WARDROBE_KEY}.${key}`);
                    app.settings.save();
                },
            });
        return section(t('m27.settings.title'), [
            el('div', { class: 'maestro-hint', text: t('m27.settings.hint') }),
            option('outfits'),
            option('states'),
            option('places'),
        ]);
    };

    return {
        id: WARDROBE_TAB,
        titleKey: 'm27.tab',
        icon: 'fa-shirt',
        order: 60,
        render(container) {
            let alive = true;
            const root = el('div', { class: 'maestro-view maestro-m27' });
            container.appendChild(root);
            const draw = () => {
                if (!alive) return;
                clear(root);
                root.appendChild(el('div', { class: 'maestro-hint', text: t('m27.hint') }));
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('m27.noChat'), 'fa-comment-slash'));
                    root.appendChild(settingsSection());
                    return;
                }
                if (app.host.isGroupChat()) {
                    root.appendChild(banner(t('m27.group'), 'muted', 'fa-users'));
                    root.appendChild(settingsSection());
                    return;
                }
                if (!service.naiApi()) root.appendChild(banner(t('m27.noNai'), 'warn'));
                else if (!app.leader.isLeader())
                    root.appendChild(banner(t('m27.notLeader'), 'muted', 'fa-circle-info'));
                root.appendChild(charactersSection());
                root.appendChild(placeSection());
                root.appendChild(settingsSection());
            };
            const redraw = coalesce(draw, 100);
            const off = service.onChange(() => alive && redraw());
            draw();
            return () => {
                alive = false;
                redraw.cancel();
                off();
            };
        },
    };
}
