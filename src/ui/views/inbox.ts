// Inbox tab: proposals waiting for a decision (plan §4.7, §7). Accepting re-validates the card in core; a
// stale card is reported instead of applied.
import type { InboxCard, PultTab } from '../../shared/contracts';
import { badge, card, emptyState, section } from '../components/card';
import { changeView } from '../components/diff';
import { button, clear, el } from '../components/dom';
import { coalesce, formatTime, moduleTitle } from './format';
import type { ViewEnv } from './types';

export const INBOX_TAB = 'inbox';
export const SNOOZE_MS = 24 * 60 * 60 * 1000;

export function inboxTab(env: ViewEnv): PultTab {
    const { i18n, shell } = env;
    const t = i18n.t.bind(i18n);

    const accept = async (item: InboxCard): Promise<boolean> => {
        const ok = await env.inbox.accept(item.id);
        if (!ok) shell.notice(t('ui.inbox.stale', { title: item.title }), { level: 'warn' });
        return ok;
    };

    const cardView = (item: InboxCard): HTMLElement => {
        const meta: (HTMLElement | string)[] = [
            el('span', {
                class: 'maestro-muted',
                text: `${moduleTitle(env.modules, i18n, item.module)} · ${item.kind} · ${formatTime(item.createdAt, i18n)}`,
            }),
        ];
        if (item.deferred) meta.push(badge(t('ui.inbox.deferred'), 'muted'));
        if (item.expiresAt)
            meta.push(badge(t('ui.inbox.expires', { time: formatTime(item.expiresAt, i18n) }), 'muted'));
        const source =
            item.sourceMessage !== undefined
                ? button({
                      label: t('ui.inbox.source', { index: item.sourceMessage }),
                      icon: 'fa-message',
                      kind: 'ghost',
                      onClick: () => shell.scrollToMessage(item.sourceMessage ?? 0),
                  })
                : null;
        return card({
            title: item.title,
            subtitle: meta,
            className: 'maestro-inbox-card',
            body: [
                item.description ? el('div', { class: 'maestro-card-text', text: item.description }) : null,
                ...item.changes.map((change) => changeView(change, t)),
            ],
            actions: [
                source,
                el('span', { class: 'maestro-grow' }),
                button({
                    label: t('ui.inbox.snooze'),
                    icon: 'fa-clock',
                    kind: 'ghost',
                    onClick: () => env.inbox.snooze(item.id, SNOOZE_MS),
                }),
                button({
                    label: t('ui.inbox.reject'),
                    icon: 'fa-xmark',
                    kind: 'danger',
                    onClick: () => env.inbox.reject(item.id),
                }),
                button({
                    label: t('ui.inbox.accept'),
                    icon: 'fa-check',
                    kind: 'primary',
                    disabled: item.deferred === true,
                    title: item.deferred ? t('ui.inbox.deferredHint') : undefined,
                    onClick: async () => {
                        await accept(item);
                    },
                }),
            ],
        });
    };

    return {
        id: INBOX_TAB,
        titleKey: 'ui.tab.inbox',
        icon: 'fa-inbox',
        order: 30,
        badge: () => env.inbox.count(),
        render(container) {
            const draw = () => {
                clear(container);
                const cards = [...env.inbox.list()].sort((a, b) => b.createdAt - a.createdAt);
                const actionable = cards.filter((item) => !item.deferred);
                const acceptAll = button({
                    label: t('ui.inbox.acceptAll', { count: actionable.length }),
                    icon: 'fa-check-double',
                    disabled: actionable.length === 0,
                    onClick: async () => {
                        let failed = 0;
                        for (const item of actionable) {
                            try {
                                if (!(await env.inbox.accept(item.id))) failed++;
                            } catch (error) {
                                failed++;
                                shell.log.error('accept failed', item.id, error);
                            }
                        }
                        const accepted = actionable.length - failed;
                        shell.notice(
                            failed
                                ? t('ui.inbox.acceptAllPartial', { accepted, failed })
                                : t('ui.inbox.acceptAllDone', { accepted }),
                            { level: failed ? 'warn' : 'info' },
                        );
                    },
                });
                container.append(
                    el('div', { class: 'maestro-view maestro-inbox' }, [
                        section(
                            t('ui.inbox.title'),
                            cards.length
                                ? el('div', { class: 'maestro-cards' }, cards.map(cardView))
                                : emptyState(t('ui.inbox.empty')),
                            cards.length ? acceptAll : undefined,
                        ),
                    ]),
                );
            };
            draw();
            const later = coalesce(draw, 50);
            const unsubscribe = env.inbox.onChange(later);
            return () => {
                later.cancel();
                unsubscribe();
            };
        },
    };
}
