// Inbox cards in the strip under their message (plan-2 §5): the line is the card's title with the Inbox buttons (its
// accept/reject labels, «Изменить» for an editable value, «Завтра»), the body is the card itself (the Inbox renderer in
// its compact form, «Подробнее» included). Identity questions ('world.sameAs') are questions, not proposals; they have
// no source message (answering must not hang on a swipe of it) and name the message where the name first appears in
// their payload (`messageIndex`). Cards without a message and deferred cards stay in the Inbox window only. Items come
// from the stored Inbox of the chat: they come back after a reload and go once decided.
import type { InboxCard, MessageStripProvider, StripAction, StripItem } from '../../shared/contracts';
import { clear } from '../components/dom';
import { inboxCardRenderer, SNOOZE_MS } from './inbox';
import type { ViewEnv } from './types';

export const INBOX_STRIP = 'maestro.inbox';
const INBOX_STRIP_ORDER = 10;
/** Card kinds that ask a question rather than propose a change. */
export const QUESTION_KINDS: ReadonlySet<string> = new Set(['world.sameAs']);

/** The message a card belongs to, if any. */
export function stripMessageOf(card: InboxCard): number | undefined {
    if (typeof card.sourceMessage === 'number') return card.sourceMessage >= 0 ? card.sourceMessage : undefined;
    if (!QUESTION_KINDS.has(card.kind)) return undefined;
    const payload = card.payload;
    const at =
        typeof payload === 'object' && payload !== null ? (payload as Record<string, unknown>).messageIndex : undefined;
    return typeof at === 'number' && Number.isInteger(at) && at >= 0 ? at : undefined;
}

export function inboxStripProvider(env: ViewEnv): MessageStripProvider {
    const t = env.i18n.t.bind(env.i18n);
    const renderer = inboxCardRenderer(env);
    /**
     * Cards by message (items() is called per message on each repaint), kept while someone listens to the Inbox's
     * changes — they are what makes it stale.
     */
    let byMessage: Map<number, InboxCard[]> | null = null;
    let listening = 0;

    const indexed = (): Map<number, InboxCard[]> => {
        if (byMessage && listening > 0) return byMessage;
        const map = new Map<number, InboxCard[]>();
        const cards = env.inbox.list();
        for (const card of cards) {
            if (card.deferred) continue;
            const at = stripMessageOf(card);
            if (at === undefined) continue;
            const list = map.get(at);
            if (list) list.push(card);
            else map.set(at, [card]);
        }
        for (const list of map.values()) list.sort((a, b) => a.createdAt - b.createdAt);
        renderer.keepDrafts(new Set(cards.map((card) => card.id)));
        byMessage = map;
        return map;
    };

    const toItem = (card: InboxCard): StripItem => {
        const question = QUESTION_KINDS.has(card.kind);
        const actions: StripAction[] = [
            {
                label: card.acceptLabel ?? t('ui.inbox.accept'),
                primary: true,
                run: async () => {
                    await renderer.accept(card);
                },
            },
        ];
        if (renderer.editable(card)) {
            actions.push({
                label: t('ui.strip.edit'),
                run: () => {
                    renderer.startEdit(card);
                },
            });
        }
        actions.push(
            { label: card.rejectLabel ?? t('ui.inbox.reject'), run: () => env.inbox.reject(card.id) },
            { label: t('ui.inbox.snooze'), run: () => env.inbox.snooze(card.id, SNOOZE_MS) },
        );
        return {
            id: card.id,
            kind: question ? 'question' : 'proposal',
            text: card.title,
            icon: question ? 'fa-circle-question' : 'fa-inbox',
            actions,
            body: (container) => {
                const draw = () => {
                    clear(container);
                    container.appendChild(renderer.cardView(card, draw, { compact: true }));
                };
                draw();
            },
        };
    };

    return {
        id: INBOX_STRIP,
        order: INBOX_STRIP_ORDER,
        items: (messageIndex) => (indexed().get(messageIndex) ?? []).map(toItem),
        onChange(listener) {
            listening++;
            const off = env.inbox.onChange(() => {
                const before = byMessage;
                byMessage = null;
                if (!before) {
                    listener();
                    return;
                }
                // Repaint the messages that had cards and those that have them now.
                listener([...new Set([...before.keys(), ...indexed().keys()])]);
            });
            return () => {
                off();
                listening--;
                byMessage = null;
            };
        },
    };
}
