// ST has no «theme changed» event (plan M32 §2): power-user.js applyTheme*/applyThemeColor write the theme as custom
// properties into <html style>, switch body classes (no-blur, noShadows, bubblechat, documentstyle…) and rewrite the
// user's custom CSS in <style id="custom-style">. The watcher observes exactly those, plus the theme <select>
// (#themes) and ST's settings events, and calls back once per burst (debounced) so the tokens are recomputed.
import type { Unsubscribe } from '../../shared/contracts';

export const WATCH_DEBOUNCE_MS = 150;
/** ST events after which the theme may have changed (keys of eventTypes). */
export const WATCH_EVENTS = ['SETTINGS_UPDATED', 'SETTINGS_LOADED_AFTER', 'APP_READY'] as const;
/** Controls of ST's «User Settings» drawer whose change re-themes the page. */
const THEME_CONTROLS = '#themes, #user-settings-block, #UI-Theme-Block, #UI-Customization';
const CUSTOM_CSS_ID = 'custom-style';

export interface ThemeWatcherDeps {
    doc?: Document;
    debounceMs?: number;
    /** Subscribes to a ST event (app.host.events.on); failures are ignored. */
    subscribe?(event: string, handler: () => void): Unsubscribe;
    onChange(): void;
    onError?(error: unknown): void;
}

export class ThemeWatcher {
    private readonly doc: Document;
    private readonly debounceMs: number;
    private observers: MutationObserver[] = [];
    private customCssObserver: MutationObserver | null = null;
    private customCssNode: Element | null = null;
    private offs: Unsubscribe[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;

    constructor(private readonly deps: ThemeWatcherDeps) {
        this.doc = deps.doc ?? document;
        this.debounceMs = deps.debounceMs ?? WATCH_DEBOUNCE_MS;
    }

    isRunning(): boolean {
        return this.running;
    }

    start(): void {
        if (this.running) return;
        this.running = true;
        const Observer = this.doc.defaultView?.MutationObserver ?? globalThis.MutationObserver;
        if (Observer) {
            const html = this.doc.documentElement;
            const body = this.doc.body;
            const attributes = new Observer(() => this.poke());
            if (html) attributes.observe(html, { attributes: true, attributeFilter: ['style'] });
            if (body) attributes.observe(body, { attributes: true, attributeFilter: ['class', 'style'] });
            this.observers.push(attributes);
            if (this.doc.head) {
                // ST creates #custom-style once; watch for it to appear (or be replaced), then watch its text.
                const head = new Observer((records) => {
                    const touched = records.some((record) =>
                        [...record.addedNodes, ...record.removedNodes].some(
                            (node) => (node as Element).id === CUSTOM_CSS_ID || node.nodeName === 'LINK',
                        ),
                    );
                    if (touched) {
                        this.watchCustomCss(Observer);
                        this.poke();
                    }
                });
                head.observe(this.doc.head, { childList: true });
                this.observers.push(head);
            }
            this.watchCustomCss(Observer);
        }
        const onControl = (event: Event) => {
            const target = event.target as Element | null;
            if (target && typeof target.closest === 'function' && target.closest(THEME_CONTROLS)) this.poke();
        };
        this.doc.addEventListener('change', onControl, true);
        this.offs.push(() => this.doc.removeEventListener('change', onControl, true));
        for (const event of WATCH_EVENTS) {
            if (!this.deps.subscribe) break;
            try {
                this.offs.push(this.deps.subscribe(event, () => this.poke()));
            } catch (error) {
                this.deps.onError?.(error);
            }
        }
    }

    stop(): void {
        this.running = false;
        for (const observer of this.observers.splice(0)) observer.disconnect();
        this.customCssObserver?.disconnect();
        this.customCssObserver = null;
        this.customCssNode = null;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.onError?.(error);
            }
        }
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }

    /** Schedules one callback after the burst settles. */
    poke(): void {
        if (!this.running) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            this.fire();
        }, this.debounceMs);
    }

    /** Runs a pending callback now (tests, refresh()). */
    flush(): void {
        if (this.timer === null) return;
        clearTimeout(this.timer);
        this.timer = null;
        this.fire();
    }

    private fire(): void {
        if (!this.running) return;
        try {
            this.deps.onChange();
        } catch (error) {
            this.deps.onError?.(error);
        }
    }

    private watchCustomCss(Observer: typeof MutationObserver): void {
        const node = this.doc.getElementById(CUSTOM_CSS_ID);
        if (node === this.customCssNode) return;
        this.customCssObserver?.disconnect();
        this.customCssObserver = null;
        this.customCssNode = node;
        if (!node) return;
        this.customCssObserver = new Observer(() => this.poke());
        this.customCssObserver.observe(node, { childList: true, characterData: true, subtree: true });
    }
}
