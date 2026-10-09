// M41's entry points in ST's character editor (ST 1.19 index.html: `#avatar_controls .form_create_bottom_buttons_block`
// and `#char-management-dropdown`; script.js select_selected_character / select_rm_create): a «Создать персону»
// button right after «Connected Personas» (`#char_connections_button`) and an option of the «More…» list (ST emits
// CHARACTER_MANAGEMENT_DROPDOWN with the option's id). Both show only while the editor holds one existing character
// (`#form_create[actiontype=editcharacter]`, no group): a MutationObserver follows the form's `actiontype`, and the
// nodes are put back on APP_READY and CHARACTER_EDITOR_OPENED (ST may rebuild the block). dispose() takes everything back.
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import { el } from '../../ui/components/dom';
import { editedCard } from './collect';
import type { CardRef } from './collect';

export const M41_NODES = {
    button: 'maestro_m41_persona_button',
    option: 'maestro_m41_persona_option',
    busy: 'maestro-m41-busy',
} as const;

const BLOCK = '#avatar_controls .form_create_bottom_buttons_block';
const ANCHOR = '#char_connections_button';
const DROPDOWN = '#char-management-dropdown';

function page(): Document | null {
    return typeof document === 'undefined' ? null : document;
}

export class EditorButton {
    private observer: MutationObserver | null = null;
    private observedForm: Element | null = null;
    private readonly offs: Unsubscribe[] = [];
    /** The character id of the last CHARACTER_EDITOR_OPENED. */
    private lastId: number | null = null;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly onPress: (card: CardRef) => void,
        private readonly isBusy: (avatar: string) => boolean,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private on(key: string, raw: string, handler: (...args: unknown[]) => void): void {
        const name = this.app.host.events.name(key) ?? raw;
        this.offs.push(this.app.host.events.on(name, handler));
    }

    install(): void {
        this.on('APP_READY', 'app_ready', () => this.ensure());
        this.on('CHARACTER_EDITOR_OPENED', 'character_editor_opened', (id) => {
            const index = typeof id === 'number' ? id : typeof id === 'string' && id.trim() ? Number(id) : NaN;
            this.lastId = Number.isInteger(index) ? index : null;
            this.ensure();
        });
        this.on('CHAT_CHANGED', 'chat_id_changed', () => this.update());
        this.on('CHARACTER_MANAGEMENT_DROPDOWN', 'charManagementDropdown', (target) => {
            if (target === M41_NODES.option) this.press();
        });
        this.ensure();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.log.debug('M41: a listener did not detach', error);
            }
        }
        this.observer?.disconnect();
        this.observer = null;
        this.observedForm = null;
        const doc = page();
        doc?.getElementById(M41_NODES.button)?.remove();
        doc?.getElementById(M41_NODES.option)?.remove();
    }

    /** The card the editor holds now, or null (create form, group, nothing open). */
    card(): CardRef | null {
        return editedCard(this.app, this.lastId);
    }

    /** Puts the button and the option in place (once), follows the form's mode, shows or hides them. */
    ensure(): void {
        if (this.disposed) return;
        const doc = page();
        if (!doc) return;
        const block = doc.querySelector(BLOCK);
        if (block && !doc.getElementById(M41_NODES.button)) {
            const button = el('div', {
                class: ['menu_button', 'fa-solid', 'fa-user-plus', 'interactable'],
                title: this.t('m41.button.title'),
                attrs: { id: M41_NODES.button, role: 'button', tabindex: 0, 'aria-label': this.t('m41.button.title') },
            });
            button.addEventListener('click', () => this.press());
            button.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    this.press();
                }
            });
            const anchor = block.querySelector(ANCHOR) ?? block.querySelector('#export_button');
            if (anchor) anchor.after(button);
            else block.append(button);
        }
        const dropdown = doc.querySelector(DROPDOWN);
        if (dropdown && !doc.getElementById(M41_NODES.option)) {
            dropdown.append(el('option', { text: this.t('m41.option'), attrs: { id: M41_NODES.option } }));
        }
        this.observe(doc);
        this.update();
    }

    private observe(doc: Document): void {
        const form = doc.getElementById('form_create');
        if (!form || form === this.observedForm || typeof MutationObserver === 'undefined') return;
        this.observer?.disconnect();
        this.observer = new MutationObserver(() => this.update());
        this.observer.observe(form, { attributes: true, attributeFilter: ['actiontype'] });
        this.observedForm = form;
    }

    /** Shown only for one existing character; marked while a persona is being made for it. */
    update(): void {
        if (this.disposed) return;
        const doc = page();
        if (!doc) return;
        const card = this.card();
        const button = doc.getElementById(M41_NODES.button);
        if (button) {
            button.style.display = card ? '' : 'none';
            button.classList.toggle(M41_NODES.busy, !!card && this.isBusy(card.avatar));
        }
        const option = doc.getElementById(M41_NODES.option);
        if (option instanceof HTMLOptionElement) {
            option.hidden = !card;
            option.disabled = !card;
        }
    }

    private press(): void {
        const card = this.card();
        if (!card) {
            this.app.ui.notice(this.t('m41.noCard'), { level: 'warn', importance: 'urgent' });
            return;
        }
        try {
            this.onPress(card);
        } catch (error) {
            this.log.error('M41: the persona window did not open', error);
        }
    }
}
