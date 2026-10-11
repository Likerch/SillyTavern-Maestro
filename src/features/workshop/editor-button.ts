// M42's switch in ST's character editor (ST 1.19 index.html `#avatar_controls .form_create_bottom_buttons_block` and
// the «More…» list `#char-management-dropdown`, the same places M41 uses): a wrench button lit while the card is a
// workshop card, and an option of the list. Both show only while the editor holds one existing character
// (`#form_create[actiontype=editcharacter]`, no group); a MutationObserver follows the form's `actiontype` and the card
// it holds (`#avatar_url_pole`), the nodes are put back on APP_READY and CHARACTER_EDITOR_OPENED (ST may rebuild the
// block). dispose() takes everything back.
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import { el } from '../../ui/components/dom';

export const M42_NODES = {
    button: 'maestro_m42_workshop_button',
    option: 'maestro_m42_workshop_option',
    on: 'maestro-m42-on',
} as const;

const BLOCK = '#avatar_controls .form_create_bottom_buttons_block';
const DROPDOWN = '#char-management-dropdown';
/** After M41's «Создать персону» when it is there, else after «Connected Personas». */
const ANCHORS = ['#maestro_m41_persona_button', '#char_connections_button', '#export_button'];

function page(): Document | null {
    return typeof document === 'undefined' ? null : document;
}

export class WorkshopButton {
    private observer: MutationObserver | null = null;
    private observedForm: Element | null = null;
    private readonly offs: Unsubscribe[] = [];
    private busy = false;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly isWorkshop: (avatar: string) => boolean,
        private readonly toggle: (avatar: string, on: boolean) => Promise<boolean>,
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
        this.on('CHARACTER_EDITOR_OPENED', 'character_editor_opened', () => this.ensure());
        this.on('CHAT_CHANGED', 'chat_id_changed', () => this.update());
        this.on('SETTINGS_UPDATED', 'settings_updated', () => this.update());
        this.on('CHARACTER_MANAGEMENT_DROPDOWN', 'charManagementDropdown', (target) => {
            if (target === M42_NODES.option) void this.press();
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
                this.log.debug('M42: a listener did not detach', error);
            }
        }
        this.observer?.disconnect();
        this.observer = null;
        this.observedForm = null;
        const doc = page();
        doc?.getElementById(M42_NODES.button)?.remove();
        doc?.getElementById(M42_NODES.option)?.remove();
    }

    /** The avatar of the card the editor holds, or null (create form, group, nothing open). */
    card(): string | null {
        const doc = page();
        if (!doc) return null;
        try {
            if (this.app.host.ctx().groupId) return null;
        } catch {
            return null;
        }
        const form = doc.getElementById('form_create');
        if (!form || form.getAttribute('actiontype') !== 'editcharacter') return null;
        const field = doc.getElementById('avatar_url_pole');
        const avatar = field instanceof HTMLInputElement ? field.value.trim() : '';
        if (!avatar) return null;
        try {
            const known = this.app.host.ctx().characters?.some((character) => character?.avatar === avatar);
            return known ? avatar : null;
        } catch {
            return null;
        }
    }

    ensure(): void {
        if (this.disposed) return;
        const doc = page();
        if (!doc) return;
        const block = doc.querySelector(BLOCK);
        if (block && !doc.getElementById(M42_NODES.button)) {
            const button = el('div', {
                class: ['menu_button', 'fa-solid', 'fa-screwdriver-wrench', 'interactable'],
                attrs: { id: M42_NODES.button, role: 'button', tabindex: 0 },
            });
            button.addEventListener('click', () => void this.press());
            button.addEventListener('keydown', (event) => {
                if (event.key === 'Enter' || event.key === ' ') {
                    event.preventDefault();
                    void this.press();
                }
            });
            const anchor = ANCHORS.map((selector) => block.querySelector(selector)).find(Boolean);
            if (anchor) anchor.after(button);
            else block.append(button);
        }
        const dropdown = doc.querySelector(DROPDOWN);
        if (dropdown && !doc.getElementById(M42_NODES.option)) {
            dropdown.append(el('option', { text: this.t('m42.option.on'), attrs: { id: M42_NODES.option } }));
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

    /** Shown only for one existing character; lit while that card is a workshop card. */
    update(): void {
        if (this.disposed) return;
        const doc = page();
        if (!doc) return;
        const avatar = this.card();
        const on = avatar !== null && this.isWorkshop(avatar);
        const title = this.t(on ? 'm42.button.on' : 'm42.button.off');
        const button = doc.getElementById(M42_NODES.button);
        if (button) {
            button.style.display = avatar ? '' : 'none';
            button.classList.toggle(M42_NODES.on, on);
            button.title = title;
            button.setAttribute('aria-label', title);
            button.setAttribute('aria-pressed', on ? 'true' : 'false');
        }
        const option = doc.getElementById(M42_NODES.option);
        if (option instanceof HTMLOptionElement) {
            option.hidden = !avatar;
            option.disabled = !avatar;
            option.text = this.t(on ? 'm42.option.off' : 'm42.option.on');
        }
    }

    private async press(): Promise<void> {
        if (this.busy) return;
        const avatar = this.card();
        if (!avatar) {
            this.app.ui.notice(this.t('m42.noCard'), { level: 'warn', urgent: true });
            return;
        }
        this.busy = true;
        try {
            const on = !this.isWorkshop(avatar);
            if (await this.toggle(avatar, on)) {
                this.app.ui.notice(this.t(on ? 'm42.tag.added' : 'm42.tag.removed'), { urgent: true });
            }
        } catch (error) {
            this.log.error('M42: the workshop switch failed', error);
        } finally {
            this.busy = false;
            this.update();
        }
    }
}

export const WORKSHOP_CSS = `
#${M42_NODES.button}.${M42_NODES.on} { color: var(--maestro-accent, var(--SmartThemeQuoteColor)); }
`;
