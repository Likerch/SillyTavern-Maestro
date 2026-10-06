// One Maestro button in every chat message's extra buttons (ST's «…» row, `.extraMesButtons`) with a small menu:
// the speaker's dossier, the mechanics window (plan-2 §10 п.3). ST clones `#message_template` for every message it
// renders, so the button goes into the template too; messages already on screen get it directly, and the render
// events re-check (another extension may rebuild the row). Everything is removed on dispose.
import type { Host, I18n, Logger, Unsubscribe } from '../../shared/contracts';
import type { FloatingMenu, MenuItem } from '../windows/menu';

export const MESSAGE_BUTTON_CLASS = 'maestro-mes-button';
const ROW = '.extraMesButtons';
const TEMPLATE_ROW = `#message_template .mes ${ROW}`;

/** ST events after which message DOM may have been rebuilt. Keys of eventTypes (see HostEvents.on). */
const RENDER_EVENTS = [
    'CHARACTER_MESSAGE_RENDERED',
    'USER_MESSAGE_RENDERED',
    'MESSAGE_UPDATED',
    'MESSAGE_SWIPED',
    'MORE_MESSAGES_LOADED',
    'CHAT_CHANGED',
];

export interface MessageButtonDeps {
    host: Host;
    i18n: I18n;
    log: Logger;
    menu: FloatingMenu;
    /** The menu of one message (by its index in the chat). */
    items(messageIndex: number): MenuItem[];
}

export class MessageButtons {
    private readonly offs: Unsubscribe[] = [];
    private listening = false;
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly deps: MessageButtonDeps) {}

    /** Idempotent: the template, the messages on screen, the listeners. */
    mount(): void {
        this.applyAll();
        if (this.listening) return;
        this.listening = true;
        for (const event of RENDER_EVENTS) {
            try {
                this.offs.push(this.deps.host.events.on(event, () => this.schedule()));
            } catch (error) {
                this.deps.log.debug(`message button: no event ${event}`, error);
            }
        }
        const onClick = (event: MouseEvent) => {
            const target =
                event.target instanceof Element ? event.target.closest<HTMLElement>(`.${MESSAGE_BUTTON_CLASS}`) : null;
            if (!target || !target.closest('#chat')) return;
            event.preventDefault();
            event.stopPropagation();
            this.openMenu(target);
        };
        const onKey = (event: KeyboardEvent) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            const target = event.target instanceof HTMLElement ? event.target : null;
            if (!target?.classList.contains(MESSAGE_BUTTON_CLASS) || !target.closest('#chat')) return;
            event.preventDefault();
            this.openMenu(target);
        };
        document.addEventListener('click', onClick);
        document.addEventListener('keydown', onKey);
        this.offs.push(
            () => document.removeEventListener('click', onClick),
            () => document.removeEventListener('keydown', onKey),
        );
    }

    /** Language changed: the buttons' tooltips. */
    relocalize(): void {
        for (const node of document.querySelectorAll<HTMLElement>(`.${MESSAGE_BUTTON_CLASS}`)) this.label(node);
    }

    dispose(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        for (const off of this.offs.splice(0)) off();
        this.listening = false;
        for (const node of document.querySelectorAll(`.${MESSAGE_BUTTON_CLASS}`)) node.remove();
    }

    applyAll(): void {
        const template = document.querySelector<HTMLElement>(TEMPLATE_ROW);
        if (template) this.ensure(template);
        for (const row of document.querySelectorAll<HTMLElement>(`#chat .mes ${ROW}`)) this.ensure(row);
    }

    /** Now and once more after ST finishes its own post-render work. */
    private schedule(): void {
        this.applyAll();
        if (this.timer !== null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.applyAll();
        }, 50);
    }

    private ensure(row: HTMLElement): void {
        if ([...row.children].some((child) => child.classList.contains(MESSAGE_BUTTON_CLASS))) return;
        const node = document.createElement('div');
        node.className = `mes_button ${MESSAGE_BUTTON_CLASS} fa-solid fa-wand-magic-sparkles`;
        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        node.setAttribute('aria-haspopup', 'menu');
        this.label(node);
        row.insertBefore(node, row.firstChild);
    }

    private label(node: HTMLElement): void {
        const text = this.deps.i18n.t('ui.mesButton.title');
        node.title = text;
        node.setAttribute('aria-label', text);
    }

    private openMenu(button: HTMLElement): void {
        const index = Number(button.closest('.mes')?.getAttribute('mesid'));
        if (!Number.isInteger(index) || index < 0) return;
        const { menu } = this.deps;
        if (menu.isOpen() && menu.anchorNode() === button) {
            menu.close();
            return;
        }
        let items: MenuItem[] = [];
        try {
            items = this.deps.items(index);
        } catch (error) {
            this.deps.log.error('message menu failed', error);
        }
        if (!items.length) return;
        button.setAttribute('aria-expanded', 'true');
        menu.open(button, [{ items }], {
            label: this.deps.i18n.t('ui.mesButton.title'),
            className: 'maestro-mes-menu',
            onClose: () => button.setAttribute('aria-expanded', 'false'),
        });
    }
}
