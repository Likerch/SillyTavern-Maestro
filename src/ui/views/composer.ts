// The Maestro button at the message box (M40): one icon in ST's `#leftSendForm`, right after the wand
// (`#extensionsMenuButton`), styled like ST's own icons there (a `div.interactable` with a Font Awesome glyph; on phones
// `#leftSendForm` is 1.15em wide and stacks its icons in a column, so it is exactly one icon). A click opens Maestro's
// menu with the quick actions modules add through Ui.addComposerAction (groups with visibility predicates, submenus);
// the same groups are listed in the Maestro menu. The button hides while no group has items, and when switched off in
// the settings (CoreSettings.composerButton). Mounting is idempotent (LoreBook Creator's `#lbc-trigger` and other
// neighbours' icons stay where they are); ST's render events re-check whether the node is still there.
import type {
    ComposerGroup,
    ComposerItem,
    Host,
    I18n,
    Logger,
    SettingsService,
    Unsubscribe,
} from '../../shared/contracts';
import type { FloatingMenu, MenuGroup, MenuItem } from '../windows/menu';

export const COMPOSER_BUTTON_ID = 'maestro-composer-button';
export const COMPOSER_ICON = 'fa-masks-theater';
const FORM = '#leftSendForm';
const WAND = 'extensionsMenuButton';
/** ST events after which the box may have been rebuilt, the chat or the active books changed (keys of eventTypes). */
const EVENTS = [
    'APP_READY',
    'CHAT_CHANGED',
    'MESSAGE_RECEIVED',
    'MESSAGE_SENT',
    'WORLDINFO_SETTINGS_UPDATED',
    'WORLDINFO_UPDATED',
    'CHARACTER_EDITED',
    'SETTINGS_UPDATED',
];
/** A second look after the neighbours finished their own async work (capability probes, books). */
const RECHECK_MS = 800;

export interface ComposerDeps {
    host: Host;
    i18n: I18n;
    log: Logger;
    settings: SettingsService;
    menu: FloatingMenu;
    /** A failed action (an error notice). */
    onError(error: unknown): void;
}

export class ComposerActions {
    private readonly groups = new Map<string, { group: ComposerGroup; off: Unsubscribe | null }>();
    private node: HTMLElement | null = null;
    private readonly offs: Unsubscribe[] = [];
    private listening = false;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;

    constructor(private readonly deps: ComposerDeps) {}

    /** Adds a module's group (same id replaces); the remover takes it away. */
    add(group: ComposerGroup): Unsubscribe {
        if (this.disposed) return () => {};
        this.groups.get(group.id)?.off?.();
        let off: Unsubscribe | null = null;
        try {
            off = group.onChange?.(() => this.refresh()) ?? null;
        } catch (error) {
            this.deps.log.debug(`composer group ${group.id}: no change events`, error);
        }
        const entry = { group, off };
        this.groups.set(group.id, entry);
        this.refresh();
        return () => {
            if (this.groups.get(group.id) !== entry) return;
            entry.off?.();
            this.groups.delete(group.id);
            this.refresh();
        };
    }

    /** The visible groups with their items as menu groups (submenus built when opened). */
    menuGroups(): MenuGroup[] {
        const out: MenuGroup[] = [];
        const list = [...this.groups.values()]
            .map((entry) => entry.group)
            .sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
        for (const group of list) {
            try {
                if (group.visible && !group.visible()) continue;
                const items = group.items().map((item) => this.menuItem(group.id, item));
                if (items.length) out.push({ label: group.label(), items });
            } catch (error) {
                this.deps.log.warn(`composer group ${group.id} failed`, error);
            }
        }
        return out;
    }

    private menuItem(prefix: string, item: ComposerItem): MenuItem {
        const id = `${prefix}:${item.id}`;
        const out: MenuItem = {
            id,
            label: item.label,
            run: () => {
                if (!item.run) return;
                try {
                    void Promise.resolve(item.run()).catch((error: unknown) => this.deps.onError(error));
                } catch (error) {
                    this.deps.onError(error);
                }
            },
        };
        if (item.icon) out.icon = item.icon;
        if (item.hint) out.hint = item.hint;
        if (item.active) out.active = true;
        const submenu = item.submenu;
        if (submenu) {
            out.submenu = () => {
                const items = submenu.call(item).map((child) => this.menuItem(id, child));
                return [{ items }];
            };
        }
        return out;
    }

    /** Idempotent: the button where it belongs, the listeners. */
    mount(): void {
        if (this.disposed) return;
        this.refresh();
        if (this.listening) return;
        this.listening = true;
        for (const event of EVENTS) {
            try {
                this.offs.push(this.deps.host.events.on(event, () => this.schedule()));
            } catch (error) {
                this.deps.log.debug(`composer: no event ${event}`, error);
            }
        }
        this.offs.push(
            this.deps.settings.onChange((path) => {
                if (path === 'core.composerButton' || path.startsWith('modules.')) this.refresh();
            }),
        );
    }

    /** Language changed: the tooltip. */
    relocalize(): void {
        if (this.node) this.label(this.node);
    }

    dispose(): void {
        this.disposed = true;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        for (const off of this.offs.splice(0)) off();
        for (const entry of this.groups.values()) entry.off?.();
        this.groups.clear();
        this.listening = false;
        if (this.deps.menu.anchorNode() === this.node) this.deps.menu.close();
        this.node?.remove();
        this.node = null;
        document.getElementById(COMPOSER_BUTTON_ID)?.remove();
    }

    /** The button is there (or not) and shown while switched on and a group has items. */
    refresh(): void {
        if (this.disposed) return;
        const enabled = this.deps.settings.core().composerButton !== false;
        if (!enabled) {
            if (this.deps.menu.anchorNode() === this.node) this.deps.menu.close();
            this.node?.remove();
            this.node = null;
            return;
        }
        const node = this.ensure();
        if (!node) return;
        const shown = this.menuGroups().length > 0;
        node.style.display = shown ? '' : 'none';
        if (!shown && this.deps.menu.anchorNode() === node) this.deps.menu.close();
    }

    /** Now and once more after the neighbours' own async work. */
    private schedule(): void {
        this.refresh();
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.refresh();
        }, RECHECK_MS);
    }

    private ensure(): HTMLElement | null {
        const form = document.querySelector<HTMLElement>(FORM);
        if (!form) return null;
        if (this.node?.isConnected && this.node.parentElement === form) return this.node;
        document.getElementById(COMPOSER_BUTTON_ID)?.remove();
        const node = this.node ?? this.create();
        this.node = node;
        const wand = document.getElementById(WAND);
        if (wand && wand.parentElement === form) wand.after(node);
        else form.appendChild(node);
        return node;
    }

    private create(): HTMLElement {
        const node = document.createElement('div');
        node.id = COMPOSER_BUTTON_ID;
        node.className = `fa-solid ${COMPOSER_ICON} interactable maestro-composer-button`;
        node.setAttribute('role', 'button');
        node.setAttribute('tabindex', '0');
        node.setAttribute('aria-haspopup', 'menu');
        node.setAttribute('aria-expanded', 'false');
        this.label(node);
        node.addEventListener('click', (event) => {
            event.preventDefault();
            event.stopPropagation();
            this.toggle(node);
        });
        node.addEventListener('keydown', (event) => {
            if (event.key !== 'Enter' && event.key !== ' ') return;
            event.preventDefault();
            this.toggle(node);
        });
        return node;
    }

    private label(node: HTMLElement): void {
        const text = this.deps.i18n.t('ui.composer.title');
        node.title = text;
        node.setAttribute('aria-label', text);
    }

    /** Opens the menu of quick actions above the box (a second click closes it). */
    toggle(anchor: HTMLElement = this.node ?? document.createElement('div')): void {
        const { menu } = this.deps;
        if (menu.isOpen() && menu.anchorNode() === anchor) {
            menu.close();
            return;
        }
        const groups = this.menuGroups();
        if (!groups.length) {
            this.refresh();
            return;
        }
        anchor.setAttribute('aria-expanded', 'true');
        menu.open(anchor, groups, {
            label: this.deps.i18n.t('ui.composer.title'),
            className: 'maestro-composer-menu',
            backLabel: this.deps.i18n.t('ui.menu.back'),
            onClose: () => anchor.setAttribute('aria-expanded', 'false'),
        });
    }
}
