// Taking over ST's «Worlds/Lorebooks» button (plan M23, audit-v0.4 T9, research/parity-lore.md L-001, L-006, L-177,
// §9.9 п. 6). jQuery binds ST's exported `doNavbarIconClick` to every `.drawer-toggle` (script.js:12150) before DES
// adds `click.rpgLorebook` to the same element, so intercepting "after" never works. Instead, on the WI toggle only:
// ST's handler is unbound (it stays callable as «Классический редактор»), DES's namespaced handlers are stored and
// unbound, and ours is bound. Everything is put back on restore() — DES's handlers in their original order and only
// if DES has not re-bound them meanwhile (it does on re-enable without .off()).
//
// Deep links: ST's `openWorldInfoEditor(name)` clicks the icon and then selects the book in `#world_editor_select`
// synchronously; a click followed by that change in the same task opens the studio on that book.
import type { App, Logger } from '../../shared/contracts';

type Handler = (this: Element, event: Event) => unknown;

interface JQueryHandle {
    on(events: string, handler: Handler): JQueryHandle;
    off(events: string, handler?: Handler): JQueryHandle;
    trigger(event: string): JQueryHandle;
    val(value: string | number): JQueryHandle;
}

interface JQueryStatic {
    (target: Element | string): JQueryHandle;
    _data?: (element: Element, key: string) => unknown;
}

interface JQueryEventRecord {
    handler?: Handler;
    namespace?: string;
}

export const WI_TOGGLE_SELECTOR = '#WI-SP-button .drawer-toggle';
export const DES_NAMESPACE = 'rpgLorebook';
export const OUR_NAMESPACE = 'maestroLore';

function jq(): JQueryStatic | null {
    const value = (globalThis as { jQuery?: unknown }).jQuery;
    return typeof value === 'function' ? (value as JQueryStatic) : null;
}

export interface TakeoverDeps {
    app: App;
    log: Logger;
    /** Opens the Lore Studio (on a book when known). */
    open(book?: string): void;
}

interface Installed {
    element: Element;
    st: Handler;
    des: Handler[];
    ours: Handler;
    editorHook: Handler;
}

export class ButtonTakeover {
    private installed: Installed | null = null;
    /** The latest request: a restore() while install() awaits ST's module cancels that install. */
    private wanted = false;
    private armed = false;
    private pendingBook: string | undefined;
    private classicOpening = false;

    constructor(private readonly deps: TakeoverDeps) {}

    active(): boolean {
        return this.installed !== null;
    }

    private async stHandler(): Promise<Handler | null> {
        try {
            const script = await this.deps.app.host.modules.script();
            const handler = script.doNavbarIconClick;
            return typeof handler === 'function' ? (handler as Handler) : null;
        } catch (error) {
            this.deps.log.warn('script.js is not available', error);
            return null;
        }
    }

    /** True when installed. False (and nothing changed) without jQuery, the toggle or ST's exported handler. */
    async install(): Promise<boolean> {
        this.wanted = true;
        if (this.installed) return true;
        const $ = jq();
        const element = document.querySelector(WI_TOGGLE_SELECTOR);
        const st = await this.stHandler();
        if (!this.wanted) return false;
        if (!$ || !element || !st || this.installed) return this.installed !== null;
        const des = this.desHandlers(element);
        $(element).off('click', st);
        $(element).off(`click.${DES_NAMESPACE}`);
        const ours: Handler = (event) => this.onClick(event, st, element);
        const editorHook: Handler = () => this.onEditorChange();
        $(element).on(`click.${OUR_NAMESPACE}`, ours);
        $('#world_editor_select').on(`change.${OUR_NAMESPACE}`, editorHook);
        this.installed = { element, st, des, ours, editorHook };
        this.deps.log.info('World Info button taken over');
        return true;
    }

    /** Puts ST's and DES's handlers back; ours removed. Safe to call twice. */
    restore(): void {
        this.wanted = false;
        const installed = this.installed;
        if (!installed) return;
        this.installed = null;
        const $ = jq();
        if (!$) return;
        const { element } = installed;
        $(element).off(`click.${OUR_NAMESPACE}`, installed.ours);
        $('#world_editor_select').off(`change.${OUR_NAMESPACE}`, installed.editorHook);
        $(element).on('click', installed.st);
        if (!this.desHandlers(element).length) {
            for (const handler of installed.des) $(element).on(`click.${DES_NAMESPACE}`, handler);
        }
        this.deps.log.info('World Info button restored');
    }

    private desHandlers(element: Element): Handler[] {
        const data = jq()?._data?.(element, 'events') as { click?: JQueryEventRecord[] } | undefined;
        return (data?.click ?? [])
            .filter((record) => (record.namespace ?? '').split('.').includes(DES_NAMESPACE))
            .map((record) => record.handler)
            .filter((handler): handler is Handler => typeof handler === 'function');
    }

    private classicIsOpen(): boolean {
        return document.getElementById('WorldInfo')?.classList.contains('openDrawer') === true;
    }

    private onClick(event: Event, st: Handler, element: Element): void {
        event.preventDefault();
        event.stopImmediatePropagation();
        // The classic drawer is open (opened through «Классический редактор»): this click closes it, as Escape does.
        if (this.classicIsOpen()) {
            void Promise.resolve(st.call(element, event)).catch((error: unknown) =>
                this.deps.log.warn('classic drawer toggle failed', error),
            );
            return;
        }
        if (this.armed) return;
        this.armed = true;
        this.pendingBook = undefined;
        setTimeout(() => {
            const book = this.pendingBook;
            this.armed = false;
            this.pendingBook = undefined;
            this.deps.open(book);
        }, 0);
    }

    private onEditorChange(): void {
        if (!this.armed || this.classicOpening) return;
        const select = document.getElementById('world_editor_select');
        if (!(select instanceof HTMLSelectElement)) return;
        const option = select.options[select.selectedIndex];
        if (option && option.value !== '') this.pendingBook = option.text;
    }

    /**
     * Opens ST's own drawer (and a book in it). Calls ST's handler directly, so neither our takeover nor DES's
     * interception is involved (DES's mobile «Edit in ST» bug is not repeated: the editor select, not #world_info).
     */
    async openClassic(book?: string): Promise<boolean> {
        const element = document.querySelector(WI_TOGGLE_SELECTOR);
        const st = this.installed?.st ?? (await this.stHandler());
        if (!element || !st) return false;
        if (!this.classicIsOpen()) await Promise.resolve(st.call(element, new Event('click')));
        if (book) {
            const names = this.deps.app.host.ctx().getWorldInfoNames?.() ?? [];
            const index = names.indexOf(book);
            const $ = jq();
            if (index >= 0 && $) {
                this.classicOpening = true;
                try {
                    $('#world_editor_select').val(index).trigger('change');
                } finally {
                    this.classicOpening = false;
                }
            }
        }
        return true;
    }
}
