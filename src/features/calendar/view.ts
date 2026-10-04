// Pult tab «Календарь» (M17 п.4): the story time now, promises whose deadline came, overdue and open ones with who →
// to whom, what, by when, the quote and a link to the source message; «Выполнено» / «Отменено» / «Нарушено» (and
// «Вернуть» for closed ones), a small add form and the overdue grace. Cards and wrapped rows: readable on a phone.
import { formatMinutes } from '../../domain/calendar-time';
import type { App, PultTab } from '../../shared/contracts';
import { badge, banner, card, emptyState, section } from '../../ui/components/card';
import type { Level } from '../../ui/components/card';
import { field, numberInput } from '../../ui/components/controls';
import { button, clear, el } from '../../ui/components/dom';
import { coalesce } from '../../ui/views/format';
import type { PromiseStatus, StoryMoment } from './api';
import type { CalendarService, StoredPromise } from './service';
import { CALENDAR_KEY, DAYS_MAX, TURNS_MAX } from './settings';
import type { CalendarSettings } from './settings';

export const CALENDAR_TAB = 'calendar';
/** Closed promises shown at most. */
const CLOSED_SHOWN = 20;

export const CALENDAR_CSS = `
.maestro-m17 .maestro-m17-row { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; overflow-wrap: anywhere; }
.maestro-m17 .maestro-m17-list { display: flex; flex-direction: column; gap: 6px; }
.maestro-m17 .maestro-m17-now { display: flex; flex-wrap: wrap; gap: 4px 14px; overflow-wrap: anywhere; }
.maestro-m17 .maestro-m17-day { font-weight: 600; }
.maestro-m17 .maestro-m17-due { font-size: 0.9em; overflow-wrap: anywhere; }
.maestro-m17 .maestro-m17-quote { font-style: italic; opacity: 0.85; white-space: pre-wrap; overflow-wrap: anywhere; }
.maestro-m17 .maestro-m17-form .text_pole { width: 100%; box-sizing: border-box; }
`;

const STATUS_LEVEL: Record<PromiseStatus, Level> = {
    open: 'info',
    due: 'warn',
    overdue: 'error',
    done: 'ok',
    cancelled: 'muted',
    broken: 'error',
};

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

export function calendarTab(app: App, service: CalendarService, settings: () => CalendarSettings): PultTab {
    const t = app.i18n.t.bind(app.i18n);

    const commit = (path: string) => {
        app.settings.notify(`modules.${CALENDAR_KEY}.${path}`);
        app.settings.save();
    };

    const run = async (job: () => Promise<unknown>) => {
        try {
            await job();
        } catch (error) {
            app.ui.notice(error instanceof Error ? error.message : String(error), { level: 'warn' });
        }
    };

    const dueText = (due: StoryMoment | null): string => {
        if (!due) return t('m17.due.none');
        const parts: string[] = [];
        if (due.label) parts.push(t('m17.due.label', { label: due.label }));
        if (due.day === null) parts.push(t('m17.due.unplaced'));
        else if (due.minutes !== undefined) {
            parts.push(t('m17.due.dayTime', { day: due.day, time: formatMinutes(due.minutes) }));
        } else parts.push(t('m17.due.day', { day: due.day }));
        return parts.join(' · ');
    };

    const people = (item: StoredPromise): string => {
        const who = item.who.length ? item.who.join(', ') : t('m17.people.unknown');
        return item.toWhom.length
            ? t('m17.people', { who, toWhom: item.toWhom.join(', ') })
            : t('m17.people.who', { who });
    };

    const action = (item: StoredPromise, status: PromiseStatus, kind: 'primary' | 'ghost' | 'danger', icon: string) =>
        button({
            label: t(`m17.action.${status === 'open' ? 'reopen' : status}`),
            title: t(`m17.action.${status === 'open' ? 'reopen' : status}.hint`),
            icon,
            kind,
            className: `maestro-m17-${status === 'open' ? 'reopen' : status}`,
            onClick: () => run(() => service.setStatus(item.id, status)),
        });

    const promiseCard = (item: StoredPromise): HTMLElement => {
        const active = item.status === 'open' || item.status === 'due' || item.status === 'overdue';
        return card({
            className: 'maestro-m17-promise',
            level: item.status === 'open' ? undefined : STATUS_LEVEL[item.status],
            title: item.what,
            subtitle: el('div', { class: 'maestro-m17-row' }, [
                badge(t(`m17.status.${item.status}`), STATUS_LEVEL[item.status]),
                el('span', { class: 'maestro-m17-people', text: people(item) }),
                el('span', { class: 'maestro-muted', text: t(`m17.origin.${item.origin}`) }),
            ]),
            body: [
                el('div', { class: 'maestro-m17-due', text: dueText(item.due) }),
                item.quote ? el('div', { class: 'maestro-m17-quote', text: item.quote }) : null,
            ],
            actions: [
                item.sourceMessage >= 0
                    ? button({
                          label: t('m17.source', { index: item.sourceMessage }),
                          title: t('m17.source.hint'),
                          icon: 'fa-message',
                          kind: 'ghost',
                          className: 'maestro-m17-link',
                          onClick: () => jump(app, item.sourceMessage),
                      })
                    : null,
                el('span', { class: 'maestro-grow' }),
                ...(active
                    ? [
                          action(item, 'done', 'primary', 'fa-check'),
                          action(item, 'cancelled', 'ghost', 'fa-ban'),
                          action(item, 'broken', 'danger', 'fa-heart-crack'),
                      ]
                    : [action(item, 'open', 'ghost', 'fa-rotate-left')]),
            ],
        });
    };

    const list = (items: StoredPromise[]): HTMLElement =>
        el('div', { class: 'maestro-m17-list' }, items.map(promiseCard));

    const nowSection = (): HTMLElement => {
        const clock = service.clock();
        if (!clock)
            return section(t('m17.now.title'), [el('div', { class: 'maestro-muted', text: t('m17.now.unknown') })]);
        return section(t('m17.now.title'), [
            el('div', { class: 'maestro-m17-now' }, [
                el('span', { class: 'maestro-m17-day', text: t('m17.now.day', { day: clock.day }) }),
                clock.label ? el('span', { text: t('m17.now.date', { date: clock.label }) }) : null,
                clock.time || clock.minutes !== undefined
                    ? el('span', {
                          text: t('m17.now.time', {
                              time: clock.time ?? formatMinutes(clock.minutes ?? 0),
                          }),
                      })
                    : null,
            ]),
        ]);
    };

    const promiseSections = (): HTMLElement[] => {
        const all = service.stored();
        const of = (status: PromiseStatus) => all.filter((item) => item.status === status);
        const byDay = (a: StoredPromise, b: StoredPromise) =>
            (a.due?.day ?? Number.POSITIVE_INFINITY) - (b.due?.day ?? Number.POSITIVE_INFINITY) ||
            (a.due?.minutes ?? 0) - (b.due?.minutes ?? 0) ||
            a.createdAt - b.createdAt;
        const due = of('due').sort(byDay);
        const overdue = of('overdue').sort(byDay);
        const open = of('open').sort(byDay);
        const closed = all
            .filter((item) => item.status === 'done' || item.status === 'cancelled' || item.status === 'broken')
            .sort((a, b) => (b.closedAt ?? b.createdAt) - (a.closedAt ?? a.createdAt));
        const out: HTMLElement[] = [];
        if (due.length) out.push(section(t('m17.section.due', { count: due.length }), list(due)));
        if (overdue.length) out.push(section(t('m17.section.overdue', { count: overdue.length }), list(overdue)));
        out.push(
            section(t('m17.section.open', { count: open.length }), [
                open.length
                    ? list(open)
                    : !due.length && !overdue.length
                      ? emptyState(t('m17.empty.active'), 'fa-handshake')
                      : null,
            ]),
        );
        out.push(
            section(t('m17.section.closed', { count: closed.length }), [
                closed.length
                    ? list(closed.slice(0, CLOSED_SHOWN))
                    : emptyState(t('m17.empty.closed'), 'fa-box-archive'),
                closed.length > CLOSED_SHOWN
                    ? el('div', { class: 'maestro-muted', text: t('m17.closed.more', { count: CLOSED_SHOWN }) })
                    : null,
            ]),
        );
        return out;
    };

    const input = (label: string): HTMLInputElement =>
        el('input', { class: 'text_pole', attrs: { type: 'text', 'aria-label': label } });

    const addSection = (): HTMLElement => {
        const who = input(t('m17.add.who'));
        const toWhom = input(t('m17.add.toWhom'));
        const what = input(t('m17.add.what'));
        const when = input(t('m17.add.when'));
        const quote = input(t('m17.add.quote'));
        const submit = button({
            label: t('m17.add.submit'),
            icon: 'fa-plus',
            kind: 'primary',
            className: 'maestro-m17-submit',
            onClick: () =>
                run(async () => {
                    await service.addManual({
                        who: who.value,
                        toWhom: toWhom.value,
                        what: what.value,
                        when: when.value,
                        quote: quote.value,
                    });
                    for (const node of [who, toWhom, what, when, quote]) node.value = '';
                    app.ui.notice(t('m17.add.done'), { level: 'info' });
                }),
        });
        return section(t('m17.add.title'), [
            el('div', { class: 'maestro-m17-form' }, [
                field(t('m17.add.who'), who),
                field(t('m17.add.toWhom'), toWhom),
                field(t('m17.add.what'), what),
                field(t('m17.add.when'), when, t('m17.add.when.hint')),
                field(t('m17.add.quote'), quote),
                el('div', { class: 'maestro-m17-row' }, [submit]),
            ]),
        ]);
    };

    const settingsSection = (): HTMLElement => {
        const current = settings();
        return section(t('m17.settings.title'), [
            field(
                t('m17.settings.days'),
                numberInput({
                    value: current.overdueDays,
                    min: 0,
                    max: DAYS_MAX,
                    step: 1,
                    label: t('m17.settings.days'),
                    onChange: (value) => {
                        settings().overdueDays = Math.round(value);
                        commit('overdueDays');
                    },
                }),
                t('m17.settings.days.hint'),
            ),
            field(
                t('m17.settings.turns'),
                numberInput({
                    value: current.overdueTurns,
                    min: 0,
                    max: TURNS_MAX,
                    step: 1,
                    label: t('m17.settings.turns'),
                    onChange: (value) => {
                        settings().overdueTurns = Math.round(value);
                        commit('overdueTurns');
                    },
                }),
                t('m17.settings.turns.hint'),
            ),
        ]);
    };

    return {
        id: CALENDAR_TAB,
        titleKey: 'm17.tab',
        icon: 'fa-calendar-days',
        order: 58,
        badge: () => service.promises().filter((item) => item.status === 'due' || item.status === 'overdue').length,
        render(container) {
            let alive = true;
            const root = el('div', { class: 'maestro-view maestro-m17' });
            container.appendChild(root);
            let form: HTMLElement | null = null;
            const draw = () => {
                if (!alive) return;
                // The add form keeps what is being typed across redraws.
                form ??= addSection();
                form.remove();
                clear(root);
                root.appendChild(el('div', { class: 'maestro-hint', text: t('m17.hint') }));
                if (!app.host.chatId()) {
                    root.appendChild(emptyState(t('m17.noChat'), 'fa-comment-slash'));
                    root.appendChild(settingsSection());
                    return;
                }
                if (!app.leader.isLeader()) root.appendChild(banner(t('m17.notLeader'), 'muted', 'fa-circle-info'));
                root.appendChild(nowSection());
                for (const node of promiseSections()) root.appendChild(node);
                root.appendChild(form);
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
