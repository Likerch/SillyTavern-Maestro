// Sheet messages on screen (M31 п. 5, P14, audit T6): a sheet reply is folded to one line with a «Показать лист»
// toggle, the command next to it is dimmed. ST's /hide keeps hidden messages on screen (ghost icon only), so after
// the commit Maestro's own styling is what keeps them folded. Classes live on `#chat .mes[mesid]`, which ST keeps
// across re-renders of `.mes_text`; a full re-render (chat load, more messages, delete) is followed by refresh().
import type { I18n } from '../../shared/contracts';
import { sheetMark } from './marks';

export const SHEET_CLASS = 'maestro-sheet';
const REPLY_CLASS = 'maestro-sheet-reply';
const COMMAND_CLASS = 'maestro-sheet-command';
const OPEN_CLASS = 'maestro-sheet-open';
const HIDDEN_CLASS = 'maestro-sheet-hidden';
const TOGGLE_CLASS = 'maestro-sheet-toggle';
const ALL_CLASSES = [SHEET_CLASS, REPLY_CLASS, COMMAND_CLASS, OPEN_CLASS, HIDDEN_CLASS];

export const SHEET_CSS = `
#chat .mes.${REPLY_CLASS}:not(.${OPEN_CLASS}) .mes_text,
#chat .mes.${REPLY_CLASS}:not(.${OPEN_CLASS}) .mes_reasoning_details,
#chat .mes.${REPLY_CLASS}:not(.${OPEN_CLASS}) .mes_media_wrapper {
    display: none;
}
/* ST puts its editor inside .mes_text: a folded sheet opened for editing must stay editable. */
#chat .mes.${REPLY_CLASS}:not(.${OPEN_CLASS}) .mes_text:has(.edit_textarea) {
    display: block;
}
#chat .mes.${COMMAND_CLASS} .mes_text {
    opacity: 0.7;
    font-size: 0.9em;
}
#chat .mes.${HIDDEN_CLASS} {
    opacity: 0.8;
}
#chat .mes .${TOGGLE_CLASS} {
    display: inline-flex;
    align-items: center;
    gap: 0.4em;
    max-width: 100%;
    margin: 0.2em 0;
    padding: 0.15em 0.7em;
    border: 1px solid var(--SmartThemeBorderColor, rgba(128, 128, 128, 0.5));
    border-radius: 0.6em;
    background: var(--SmartThemeBlurTintColor, transparent);
    color: var(--SmartThemeBodyColor, inherit);
    font-size: 0.9em;
    cursor: pointer;
    overflow: hidden;
    white-space: nowrap;
    text-overflow: ellipsis;
}
#chat .mes .${TOGGLE_CLASS}:hover {
    border-color: var(--SmartThemeQuoteColor, currentColor);
}
`;

export interface SheetDecoratorDeps {
    i18n: I18n;
    chat: () => readonly STChatMessage[];
    /** Folding is on (settings). */
    enabled: () => boolean;
}

/** Applies and removes the classes and toggles. Every DOM write is idempotent. */
export class SheetDecorator {
    /** Sheets the user unfolded in this page session. */
    private readonly opened = new WeakSet<STChatMessage>();
    private timer: ReturnType<typeof setTimeout> | null = null;

    constructor(private readonly deps: SheetDecoratorDeps) {}

    /** Coalesces refreshes to one per tick (several ST events fire for one change). */
    schedule(): void {
        if (this.timer !== null || typeof document === 'undefined') return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.refresh();
        }, 0);
    }

    refresh(): void {
        if (typeof document === 'undefined') return;
        const chat = this.deps.chat();
        const enabled = this.deps.enabled();
        for (const element of document.querySelectorAll<HTMLElement>('#chat .mes[mesid]')) {
            const message = chat[Number(element.getAttribute('mesid'))];
            const mark = enabled ? sheetMark(message) : null;
            if (!message || !mark) {
                this.clear(element);
                continue;
            }
            element.classList.add(SHEET_CLASS);
            element.classList.toggle(REPLY_CLASS, mark.part === 'reply');
            element.classList.toggle(COMMAND_CLASS, mark.part === 'command');
            element.classList.toggle(HIDDEN_CLASS, message.is_system === true);
            if (mark.part === 'reply') this.ensureToggle(element, message, mark.target);
            else element.querySelector(`.${TOGGLE_CLASS}`)?.remove();
        }
    }

    /** Removes every trace (module disable). */
    dispose(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (typeof document === 'undefined') return;
        for (const element of document.querySelectorAll<HTMLElement>(`#chat .mes.${SHEET_CLASS}`)) this.clear(element);
        for (const toggle of document.querySelectorAll(`#chat .${TOGGLE_CLASS}`)) toggle.remove();
    }

    private clear(element: HTMLElement): void {
        if (element.classList.contains(SHEET_CLASS)) element.classList.remove(...ALL_CLASSES);
        element.querySelector(`.${TOGGLE_CLASS}`)?.remove();
    }

    private ensureToggle(element: HTMLElement, message: STChatMessage, target: string): void {
        const open = this.opened.has(message);
        element.classList.toggle(OPEN_CLASS, open);
        let toggle = element.querySelector<HTMLButtonElement>(`.${TOGGLE_CLASS}`);
        if (!toggle) {
            const text = element.querySelector('.mes_text');
            if (!text?.parentElement) return;
            toggle = document.createElement('button');
            toggle.type = 'button';
            toggle.className = TOGGLE_CLASS;
            toggle.addEventListener('click', (event) => {
                event.preventDefault();
                event.stopPropagation();
                const index = Number(element.getAttribute('mesid'));
                const current = this.deps.chat()[index];
                if (!current) return;
                if (this.opened.has(current)) this.opened.delete(current);
                else this.opened.add(current);
                this.refresh();
            });
            text.parentElement.insertBefore(toggle, text);
        }
        const i18n = this.deps.i18n;
        const label = open ? i18n.t('m31.toggle.hide') : i18n.t('m31.toggle.show', { name: target || '…' });
        if (toggle.textContent !== label) toggle.textContent = label;
        toggle.setAttribute('aria-expanded', String(open));
    }
}
