// Pult tab «Режиссёр» (M13, M14): the current scene type with its confidence and how long it holds, the override,
// the flags set for the next generation, the stall state with its reasons, the prepared note, recent director's notes
// with their sources, «Встряхнуть» and the settings. Cards and wrapped chips: readable on a phone.
import { DIRECTOR_FLAGS } from '../../domain/director-flags';
import { SCENE_KINDS } from '../../domain/director-scene';
import type { App, PultTab } from '../../shared/contracts';
import { badge, banner, card, emptyState, section } from '../../ui/components/card';
import { field, numberInput, select, toggle } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import { coalesce, formatTime } from '../../ui/views/format';
import type { DirectorNote, SceneType } from './api';
import type { DirectorService } from './service';
import { DIRECTOR_KEY, DIRECTOR_MODES, EVERY_MAX, STALL_MAX, STALL_MIN, USER_WEIGHT_MAX } from './settings';
import type { DirectorSettings } from './settings';

export const DIRECTOR_TAB = 'director';

export const DIRECTOR_CSS = `
.maestro-m13 .maestro-m13-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center;
    overflow-wrap: anywhere; }
.maestro-m13 .maestro-m13-flags { display: flex; flex-wrap: wrap; gap: 4px; }
.maestro-m13 .maestro-m13-flag { border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius-sm);
    padding: 1px 6px; font-family: var(--monoFontFamily, monospace); font-size: 0.85em; overflow-wrap: anywhere; }
.maestro-m13 .maestro-m13-note { white-space: pre-wrap; overflow-wrap: anywhere; font-size: 0.9em; opacity: 0.85; }
.maestro-m13 .maestro-m13-detail { font-weight: 600; overflow-wrap: anywhere; }
.maestro-m13 .maestro-m13-list { display: flex; flex-direction: column; gap: 6px; }
.maestro-m13 .maestro-m13-every { display: flex; flex-wrap: wrap; gap: 8px; }
`;

type Override = SceneType | 'auto';

/** Russian plural form key suffix (one / few / many); English uses one / many. */
export function pluralKey(count: number, locale: 'ru' | 'en'): 'one' | 'few' | 'many' {
    const value = Math.abs(Math.floor(count));
    if (locale === 'en') return value === 1 ? 'one' : 'many';
    const ten = value % 10;
    const hundred = value % 100;
    if (ten === 1 && hundred !== 11) return 'one';
    if (ten >= 2 && ten <= 4 && (hundred < 12 || hundred > 14)) return 'few';
    return 'many';
}

export function directorTab(app: App, service: DirectorService, settings: () => DirectorSettings): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    const typeName = (type: SceneType) => t(`m13.scene.type.${type}`);

    const commit = (path: string) => {
        app.settings.notify(`modules.${DIRECTOR_KEY}.${path}`);
        app.settings.save();
    };

    const sceneSection = (): HTMLElement => {
        const scene = service.scene();
        const rows: (HTMLElement | null)[] = [];
        if (scene) {
            rows.push(
                el('div', { class: 'maestro-m13-row maestro-m13-scene' }, [
                    badge(typeName(scene.type), scene.by === 'user' ? 'warn' : 'info'),
                    scene.by !== 'user'
                        ? el('span', { text: t('m13.scene.confidence', { value: Math.round(scene.confidence * 100) }) })
                        : null,
                    el('span', {
                        text: t(`m13.scene.held.${pluralKey(scene.held, app.i18n.locale())}`, { count: scene.held }),
                    }),
                    el('span', {
                        class: 'maestro-muted maestro-m13-by',
                        text: t(
                            scene.fromUserMessage && scene.by !== 'user'
                                ? 'm13.scene.by.userMessage'
                                : `m13.scene.by.${scene.by}`,
                        ),
                    }),
                ]),
            );
        } else {
            rows.push(el('div', { class: 'maestro-muted', text: t('m13.scene.none') }));
        }
        const candidate = service.candidate();
        if (candidate && service.override() === null) {
            rows.push(
                el('div', {
                    class: 'maestro-muted maestro-m13-candidate',
                    text: t('m13.scene.candidate', {
                        type: typeName(candidate.type),
                        value: Math.round(candidate.confidence * 100),
                    }),
                }),
            );
        }
        const model = service.modelState();
        if (model) {
            rows.push(
                el('div', {
                    class: 'maestro-muted maestro-m13-model',
                    text:
                        model.state === 'answered' && model.type
                            ? t('m13.model.answered', { type: typeName(model.type) })
                            : t(`m13.model.${model.state === 'answered' ? 'failed' : model.state}`),
                }),
            );
        }
        const current: Override = service.override() ?? 'auto';
        rows.push(
            field(
                t('m13.override.label'),
                select<Override>({
                    value: current,
                    label: t('m13.override.label'),
                    options: [
                        { value: 'auto', label: t('m13.override.auto') },
                        ...SCENE_KINDS.map((type) => ({ value: type as Override, label: typeName(type) })),
                    ],
                    onChange: (value) => service.setScene(value === 'auto' ? null : value),
                }),
                t('m13.override.hint'),
            ),
        );
        return section(t('m13.scene.title'), rows);
    };

    const flagsSection = (): HTMLElement => {
        const flags = service.flags();
        const names = Object.keys(flags);
        const known = new Map(DIRECTOR_FLAGS.map((flag) => [flag.name, flag]));
        const cues = service.pictureCues();
        return section(t('m13.flags.title'), [
            el('div', { class: 'maestro-hint', text: t('m13.flags.hint') }),
            names.length
                ? el(
                      'div',
                      { class: 'maestro-m13-flags' },
                      names.map((name) => {
                          const info = known.get(name);
                          return el('code', {
                              class: 'maestro-m13-flag',
                              text: name,
                              title: info ? `${t(info.titleKey)}. ${t(info.descriptionKey)}` : undefined,
                          });
                      }),
                  )
                : el('div', { class: 'maestro-muted', text: t('m13.flags.none') }),
            flags['maestro_picture_moment'] && cues.length
                ? el('div', {
                      class: 'maestro-muted',
                      text: t('m13.picture.cues', {
                          cues: cues.map((cue) => t(`m13.picture.cue.${cue}`)).join(', '),
                      }),
                  })
                : null,
        ]);
    };

    const noteBody = (note: DirectorNote): HTMLElement[] => {
        const body: HTMLElement[] = [];
        if (note.detail) body.push(el('div', { class: 'maestro-m13-detail', text: note.detail }));
        body.push(el('div', { class: 'maestro-m13-note', text: note.text }));
        return body;
    };

    const pacingSection = (): HTMLElement => {
        const stall = service.stall();
        const mode = app.settings.core().mode;
        const every = settings().every[mode] ?? 0;
        const pending = service.pending();
        const suppressed = service.suppressed();
        const rows: (HTMLElement | null)[] = [
            el('div', { text: t('m14.stall.turns', { count: stall.turns }) }),
            el('div', {
                class: 'maestro-m13-reasons',
                text: stall.reasons.length
                    ? t('m14.stall.reasons', {
                          reasons: stall.reasons.map((reason) => t(`m14.reason.${reason}`)).join(', '),
                      })
                    : t('m14.stall.none'),
            }),
            every === 0 ? banner(t('m14.mode.off', { mode: t(`ui.mode.${mode}`) }), 'muted', 'fa-circle-info') : null,
            pending
                ? card({
                      title: t('m14.pending.title'),
                      className: 'maestro-m13-pending',
                      subtitle: [badge(t(`m14.source.${pending.source}`), 'info')],
                      body: [...noteBody(pending), el('div', { class: 'maestro-hint', text: t('m14.pending.hint') })],
                  })
                : null,
            suppressed
                ? el('div', {
                      class: 'maestro-muted maestro-m13-suppressed',
                      text: t('m14.suppressed', { reason: t(`m14.steer.${suppressed.reason}`) }),
                  })
                : null,
        ];
        return section(
            t('m14.stall.title'),
            rows,
            button({
                label: t('m14.nudge'),
                icon: 'fa-bolt',
                title: t('m14.nudge.hint'),
                className: 'maestro-m13-nudge',
                onClick: async () => {
                    const note = await service.nudge();
                    app.ui.notice(t(note ? 'm14.nudge.done' : 'm14.nudge.nothing'), { level: note ? 'info' : 'warn' });
                },
            }),
        );
    };

    const notesSection = (): HTMLElement => {
        const notes = service.notes().reverse();
        return section(t('m14.notes.title'), [
            notes.length
                ? el(
                      'div',
                      { class: 'maestro-m13-list' },
                      notes.map((note) =>
                          card({
                              className: 'maestro-m13-written',
                              title: t(`m14.source.${note.source}`),
                              subtitle: el('div', { class: 'maestro-m13-row' }, [
                                  el('span', { text: formatTime(note.at, app.i18n) }),
                                  el('span', { text: t('m14.notes.index', { index: note.messageIndex }) }),
                                  note.nudged ? badge(t('m14.notes.nudged'), 'muted') : null,
                              ]),
                              body: noteBody(note),
                          }),
                      ),
                  )
                : emptyState(t('m14.notes.empty'), 'fa-clapperboard'),
        ]);
    };

    const settingsSection = (): HTMLElement => {
        const current = settings();
        return section(t('m14.settings.title'), [
            field(
                t('m14.settings.stall'),
                numberInput({
                    value: current.stallTurns,
                    min: STALL_MIN,
                    max: STALL_MAX,
                    step: 1,
                    label: t('m14.settings.stall'),
                    onChange: (value) => {
                        settings().stallTurns = Math.round(value);
                        commit('stallTurns');
                    },
                }),
                t('m14.settings.stall.hint'),
            ),
            field(
                t('m13.settings.userWeight'),
                numberInput({
                    value: current.userWeight,
                    min: 0,
                    max: USER_WEIGHT_MAX,
                    step: 0.1,
                    label: t('m13.settings.userWeight'),
                    onChange: (value) => {
                        settings().userWeight = Math.round(value * 10) / 10;
                        commit('userWeight');
                    },
                }),
                t('m13.settings.userWeight.hint'),
            ),
            field(
                t('m14.settings.every'),
                el(
                    'div',
                    { class: 'maestro-m13-every' },
                    DIRECTOR_MODES.map((mode) =>
                        el('label', { class: 'maestro-m13-row' }, [
                            el('span', { text: t(`ui.mode.${mode}`) }),
                            numberInput({
                                value: current.every[mode],
                                min: 0,
                                max: EVERY_MAX,
                                step: 1,
                                label: t(`ui.mode.${mode}`),
                                onChange: (value) => {
                                    settings().every[mode] = Math.round(value);
                                    commit(`every.${mode}`);
                                },
                            }),
                        ]),
                    ),
                ),
                t('m14.settings.every.hint'),
            ),
            toggle({
                label: t('m13.settings.model'),
                hint: t('m13.settings.model.hint'),
                checked: current.model,
                onChange: (checked) => {
                    settings().model = checked;
                    commit('model');
                },
            }),
            toggle({
                label: t('m13.settings.pictures'),
                hint: t('m13.settings.pictures.hint'),
                checked: current.pictures,
                onChange: (checked) => {
                    settings().pictures = checked;
                    commit('pictures');
                },
            }),
        ]);
    };

    return {
        id: DIRECTOR_TAB,
        titleKey: 'm13.tab',
        icon: 'fa-clapperboard',
        order: 55,
        render(container) {
            let alive = true;
            const root = el('div', { class: 'maestro-view maestro-m13' });
            container.appendChild(root);
            const draw = () => {
                if (!alive) return;
                clear(root);
                root.appendChild(el('div', { class: 'maestro-hint', text: t('m13.hint') }));
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('m13.noChat'), 'fa-comment-slash'));
                    root.appendChild(settingsSection());
                    return;
                }
                root.appendChild(sceneSection());
                root.appendChild(flagsSection());
                root.appendChild(pacingSection());
                root.appendChild(notesSection());
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
