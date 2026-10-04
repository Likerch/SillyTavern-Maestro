// Badges on chat messages (autonomy level "notify", M12 "Redo" buttons). ST rebuilds message DOM on edits,
// swipes, chat changes and lazy loading, so badges are kept in a map and re-applied after those events.
import type { Host, Logger, Unsubscribe } from '../../shared/contracts';
import { el, icon } from '../components/dom';

export interface MessageBadgeSpec {
    id: string;
    text: string;
    action?: { label: string; run: () => void };
}

interface Entry extends MessageBadgeSpec {
    key: string;
    index: number;
    /** Chat the badge belongs to: the same index in another chat is another message. */
    chatId: string | null;
}

/** ST events after which message DOM may have been rebuilt. Keys of eventTypes (see HostEvents.on). */
const RERENDER_EVENTS = [
    'CHARACTER_MESSAGE_RENDERED',
    'USER_MESSAGE_RENDERED',
    'MESSAGE_UPDATED',
    'MESSAGE_EDITED',
    'MESSAGE_SWIPED',
    'MORE_MESSAGES_LOADED',
    'CHAT_CHANGED',
];

export class MessageBadges {
    private readonly entries = new Map<string, Entry>();
    private readonly unsubscribers: Unsubscribe[] = [];
    private listening = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly host: Host,
        private readonly log: Logger,
    ) {}

    add(index: number, spec: MessageBadgeSpec): Unsubscribe {
        const key = `${index}:${spec.id}`;
        this.removeNode(this.entries.get(key));
        const entry: Entry = { ...spec, key, index, chatId: this.currentChat() };
        this.entries.set(key, entry);
        this.listen();
        this.apply(entry);
        return () => {
            if (this.entries.get(key) !== entry) return;
            this.entries.delete(key);
            this.removeNode(entry);
        };
    }

    /** Re-applies every badge of the current chat (idempotent). */
    applyAll(): void {
        for (const entry of this.entries.values()) this.apply(entry);
    }

    dispose(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        for (const unsubscribe of this.unsubscribers.splice(0)) unsubscribe();
        this.listening = false;
        for (const entry of this.entries.values()) this.removeNode(entry);
        this.entries.clear();
    }

    private currentChat(): string | null {
        try {
            return this.host.chatId();
        } catch {
            return null;
        }
    }

    private listen(): void {
        if (this.listening) return;
        this.listening = true;
        for (const event of RERENDER_EVENTS) {
            try {
                this.unsubscribers.push(this.host.events.on(event, () => this.schedule()));
            } catch (error) {
                this.log.debug(`message badges: no event ${event}`, error);
            }
        }
    }

    /** Applies now and once more after ST finishes its own post-render work. */
    private schedule(): void {
        this.applyAll();
        if (this.timer !== null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.applyAll();
        }, 50);
    }

    private findMessage(index: number): HTMLElement | null {
        return document.querySelector<HTMLElement>(`#chat .mes[mesid="${index}"]`);
    }

    private existing(message: HTMLElement, entry: Entry): HTMLElement | null {
        return (
            [...message.querySelectorAll<HTMLElement>('.maestro-badge')].find(
                (node) => node.dataset.maestroBadge === entry.id,
            ) ?? null
        );
    }

    private apply(entry: Entry): void {
        const message = this.findMessage(entry.index);
        const ours = entry.chatId === this.currentChat();
        if (!message) return;
        const present = this.existing(message, entry);
        if (!ours) {
            present?.remove();
            return;
        }
        if (present) return;
        const node = this.build(entry);
        const buttons = message.querySelector('.mes_buttons');
        if (buttons) {
            buttons.insertBefore(node, buttons.firstChild);
            return;
        }
        const text = message.querySelector('.mes_text');
        if (text) text.after(node);
        else message.appendChild(node);
    }

    private build(entry: Entry): HTMLElement {
        const node = el('div', { class: 'maestro-badge', data: { maestroBadge: entry.id }, title: entry.text }, [
            icon('fa-wand-magic-sparkles'),
            el('span', { class: 'maestro-badge-text', text: entry.text }),
        ]);
        if (entry.action) {
            const action = entry.action;
            const run = el('button', { class: 'maestro-badge-action', text: action.label, attrs: { type: 'button' } });
            run.addEventListener('click', (event) => {
                event.stopPropagation();
                try {
                    action.run();
                } catch (error) {
                    this.log.error(`message badge action "${entry.id}" failed`, error);
                }
            });
            node.appendChild(run);
        }
        return node;
    }

    private removeNode(entry: Entry | undefined): void {
        if (!entry) return;
        const message = this.findMessage(entry.index);
        if (message) this.existing(message, entry)?.remove();
    }
}
