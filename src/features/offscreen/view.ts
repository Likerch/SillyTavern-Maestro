// Pult tab «Закулисье» (M16): when the next automatic run comes (or why it does not), «Сейчас» with a picker of the
// absent characters, the recent events (character, story time, text, rumour, where they went, canon or Inbox status)
// and the settings: turns per mode, scene ends, characters per run, turns away, rumours.
import { pluralForm } from '../../domain/offscreen-plan';
import type { App, PultTab } from '../../shared/contracts';
import { badge, emptyState, section } from '../../ui/components/card';
import type { Level } from '../../ui/components/card';
import { field, numberInput, toggle } from '../../ui/components/controls';
import { append, button, clear, el } from '../../ui/components/dom';
import { coalesce, formatTime, formatUsd, tOr } from '../../ui/views/format';
import type { OffscreenEvent } from './api';
import type { OffscreenService } from './service';
import { ABSENT_MAX, EVERY_MAX, MAX_CHARACTERS, OFFSCREEN_KEY, OFFSCREEN_TAB } from './settings';
import type { OffscreenSettings } from './settings';
import type { OffscreenRun } from './store';

export const OFFSCREEN_CSS = `
.maestro-m16-events { display: flex; flex-direction: column; gap: 8px; }
.maestro-m16-event { display: flex; flex-direction: column; gap: 4px; padding: 8px 10px;
    border: 1px solid var(--maestro-border); border-radius: var(--maestro-radius); }
.maestro-m16-event-head { display: flex; flex-wrap: wrap; gap: 6px; align-items: baseline; }
.maestro-m16-event-text { margin: 0; overflow-wrap: anywhere; }
.maestro-m16-event-actions { display: flex; flex-wrap: wrap; gap: 6px; }
.maestro-m16-picker { display: flex; flex-direction: column; gap: 2px; }
`;

const EVENTS_SHOWN = 20;
const STATUS_LEVEL: Record<OffscreenEvent['status'], Level> = { saved: 'ok', inbox: 'warn', rejected: 'muted' };

export function offscreenTab(app: App, service: OffscreenService, settings: () => OffscreenSettings): PultTab {
    const t = app.i18n.t.bind(app.i18n);
    const plural = (key: string, count: number) => t(`${key}.${pluralForm(count, app.i18n.locale())}`, { count });
    const commit = (path: string) => {
        app.settings.save();
        app.settings.notify(`${OFFSCREEN_KEY}.${path}`);
    };
    /** Characters ticked in the picker (kept while the tab is open). */
    let picked: Set<string> | null = null;

    const nextLine = (): string => {
        const status = service.status();
        if (status.mode === 'economy') return t('m16.next.economy');
        const next = service.nextIn();
        const sceneEnd = settings().sceneEnd[status.mode] ? ` ${t('m16.next.sceneEnd')}` : '';
        if (next === null) return `${t('m16.next.off')}${sceneEnd}`;
        if (next === 0) return `${t('m16.next.now')}${sceneEnd}`;
        return `${plural('m16.next.in', next)}${sceneEnd}`;
    };

    const runLine = (run: OffscreenRun): string => {
        const reason = tOr(app.i18n, `m16.reason.${run.reason}`, run.reason);
        const time = formatTime(run.at, app.i18n);
        if (run.error) {
            const error = tOr(app.i18n, `m16.runError.${run.error}`, t('m16.runError.other', { error: run.error }));
            return t('m16.lastRun.failed', { time, reason, error });
        }
        return t('m16.lastRun', {
            time,
            reason,
            names: run.characters.join(', '),
            count: run.events,
            cost: formatUsd(run.costUsd, app.i18n),
        });
    };

    const eventView = (event: OffscreenEvent): HTMLElement =>
        el('div', { class: 'maestro-m16-event' }, [
            el('div', { class: 'maestro-m16-event-head' }, [
                el('strong', { text: event.character }),
                event.storyTime ? el('span', { class: 'maestro-muted', text: event.storyTime }) : null,
                badge(t(`m16.status.${event.status}`), STATUS_LEVEL[event.status]),
                event.drastic ? badge(t('m16.event.drastic'), 'error') : null,
                el('span', { class: 'maestro-muted', text: formatTime(event.at, app.i18n) }),
            ]),
            el('p', { class: 'maestro-m16-event-text', text: event.text }),
            event.location
                ? el('div', { class: 'maestro-muted', text: t('m16.event.location', { place: event.location }) })
                : null,
            event.rumour
                ? el('div', {
                      class: 'maestro-muted',
                      text: t(event.rumourUsed ? 'm16.event.rumourUsed' : 'm16.event.rumour', { text: event.rumour }),
                  })
                : null,
            event.conflict
                ? el('div', { class: 'maestro-warn-text', text: t('m16.event.conflict', { list: event.conflict }) })
                : null,
            event.status === 'saved' || event.status === 'inbox'
                ? el('div', { class: 'maestro-m16-event-actions' }, [
                      event.status === 'saved'
                          ? button({
                                label: t('m16.event.openCanon'),
                                icon: 'fa-book',
                                kind: 'ghost',
                                onClick: () => app.ui.openPult('canon'),
                            })
                          : button({
                                label: t('m16.event.openInbox'),
                                icon: 'fa-inbox',
                                kind: 'ghost',
                                onClick: () => app.ui.openPult('inbox'),
                            }),
                  ])
                : null,
        ]);

    const nowView = (draw: () => void): HTMLElement => {
        const status = service.status();
        const candidates = service.candidates();
        if (picked === null) picked = new Set(candidates.filter((item) => item.preferred).map((item) => item.name));
        const chosen = picked;
        for (const name of [...chosen]) if (!candidates.some((item) => item.name === name)) chosen.delete(name);
        const picker = candidates.length
            ? el(
                  'div',
                  { class: 'maestro-m16-picker' },
                  candidates.map((candidate) =>
                      toggle({
                          label:
                              candidate.absent === null
                                  ? t('m16.now.neverSeen', { name: candidate.name })
                                  : `${candidate.name} — ${plural('m16.now.absent', candidate.absent)}`,
                          checked: chosen.has(candidate.name),
                          onChange: (checked) => {
                              if (checked) chosen.add(candidate.name);
                              else chosen.delete(candidate.name);
                          },
                      }),
                  ),
              )
            : el('div', { class: 'maestro-muted', text: t('m16.now.none') });
        const run = button({
            label: t('m16.now.run'),
            title: t('m16.now.run.hint', { max: MAX_CHARACTERS }),
            icon: 'fa-play',
            kind: 'primary',
            disabled: status.queued,
            onClick: async () => {
                const names = candidates.filter((item) => chosen.has(item.name)).map((item) => item.name);
                try {
                    // Replies to the user's own click: shown whatever the notification level.
                    await service.runNow(names.length ? names : undefined);
                    app.ui.notice(t('m16.now.queued'), { urgent: true });
                } catch (error) {
                    app.ui.notice(error instanceof Error ? error.message : String(error), {
                        level: 'warn',
                        urgent: true,
                    });
                }
                draw();
            },
        });
        return section(t('m16.now.title'), [
            el('div', { class: 'maestro-hint', text: t('m16.now.hint') }),
            picker,
            el('div', { class: 'maestro-row' }, [el('span', { class: 'maestro-grow' }), run]),
        ]);
    };

    const settingsView = (): HTMLElement => {
        const current = settings();
        const every = (mode: 'balanced' | 'cinema') =>
            field(
                t(`m16.settings.every.${mode}`),
                numberInput({
                    value: current.every[mode],
                    min: 0,
                    max: EVERY_MAX,
                    step: 1,
                    label: t(`m16.settings.every.${mode}`),
                    onChange: (value) => {
                        settings().every[mode] = Math.round(value);
                        commit(`every.${mode}`);
                    },
                }),
            );
        const sceneEnd = (mode: 'balanced' | 'cinema') =>
            toggle({
                label: t(`m16.settings.sceneEnd.${mode}`),
                checked: current.sceneEnd[mode],
                onChange: (checked) => {
                    settings().sceneEnd[mode] = checked;
                    commit(`sceneEnd.${mode}`);
                },
            });
        return section(t('m16.settings.title'), [
            el('div', { class: 'maestro-hint', text: t('m16.settings.every.hint') }),
            every('balanced'),
            every('cinema'),
            sceneEnd('balanced'),
            sceneEnd('cinema'),
            field(
                t('m16.settings.max'),
                numberInput({
                    value: current.maxCharacters,
                    min: 1,
                    max: MAX_CHARACTERS,
                    step: 1,
                    label: t('m16.settings.max'),
                    onChange: (value) => {
                        settings().maxCharacters = Math.round(value);
                        commit('maxCharacters');
                    },
                }),
            ),
            field(
                t('m16.settings.absent'),
                numberInput({
                    value: current.minAbsentTurns,
                    min: 1,
                    max: ABSENT_MAX,
                    step: 1,
                    label: t('m16.settings.absent'),
                    onChange: (value) => {
                        settings().minAbsentTurns = Math.round(value);
                        commit('minAbsentTurns');
                    },
                }),
                t('m16.settings.absent.hint'),
            ),
            toggle({
                label: t('m16.settings.rumours'),
                hint: t('m16.settings.rumours.hint'),
                checked: current.rumours,
                onChange: (checked) => {
                    settings().rumours = checked;
                    commit('rumours');
                },
            }),
        ]);
    };

    return {
        id: OFFSCREEN_TAB,
        titleKey: 'm16.tab',
        icon: 'fa-masks-theater',
        order: 57,
        render(container) {
            const root = el('div', { class: 'maestro-view maestro-m16' });
            container.appendChild(root);
            const draw = () => {
                clear(root);
                root.appendChild(el('div', { class: 'maestro-hint', text: t('m16.hint') }));
                if (!app.host.chatId()) {
                    append(root, [emptyState(t('m16.noChat'), 'fa-comment-slash'), settingsView()]);
                    return;
                }
                if (app.host.isGroupChat()) {
                    append(root, [emptyState(t('m16.group'), 'fa-users'), settingsView()]);
                    return;
                }
                const status = service.status();
                const events = service.events(EVENTS_SHOWN);
                append(root, [
                    el('div', { class: 'maestro-row' }, [el('span', { class: 'maestro-m16-next', text: nextLine() })]),
                    status.queued ? el('div', { class: 'maestro-muted', text: t('m16.status.queued') }) : null,
                    status.lastRun
                        ? el('div', { class: 'maestro-muted maestro-m16-last', text: runLine(status.lastRun) })
                        : null,
                    nowView(draw),
                    section(
                        t('m16.events.title'),
                        events.length
                            ? el('div', { class: 'maestro-m16-events' }, events.map(eventView))
                            : emptyState(t('m16.events.empty'), 'fa-masks-theater'),
                    ),
                    settingsView(),
                ]);
            };
            draw();
            const later = coalesce(draw, 80);
            const off = service.onChange(later);
            return () => {
                later.cancel();
                off();
            };
        },
    };
}
