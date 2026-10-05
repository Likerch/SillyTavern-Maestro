// The message style layer (M32 «Стиль сообщений»): the page class `maestro-msgstyle` on <html>, the generated
// stylesheet, ST's formatter hook and the messages already on screen. Off — by the setting, the module switch or
// Maestro's shutdown — removes the class and the sheet, makes the hook a no-op and takes Maestro's marks out of the
// visible messages, so the chat looks exactly as SillyTavern draws it. Stored messages are never touched: the hook
// only changes the HTML ST is about to show.
//
// Hook stage: `afterMarkdown`, order 90 (ST 1.19 message-formatter.js) — the final HTML before DOMPurify, after
// NAI Studio's placeholders (order 50); classes come out of the sanitizer with a `custom-` prefix, the stylesheet
// matches both spellings. ST cannot remove a hook, so it is added once per formatter and switched by its plans.
// Messages rendered before the hook was on (or before the rules changed what is marked) are marked in place on the
// live DOM — no ST re-render, so neighbours' decorations (DES bubbles and thoughts, NAI pictures) stay as they are.
import { buildPlan, planSignature } from '../../domain/message-style';
import type { Scope, ScopePlan } from '../../domain/message-style';
import { buildMessageStyleCss } from '../../domain/message-style-css';
import { sampleHtml } from '../../domain/message-style-model';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import { annotateHtml, annotateNode, clearAnnotations, hasAnnotations } from './annotate';
import { MESSAGE_STYLE_KEY, readMessageStyleSettings } from './settings';
import type { MessageStyleSettings } from './settings';

/** Page class of the whole module. */
export const MESSAGE_STYLE_CLASS = 'maestro-msgstyle';
/** ui.style id of the generated rules. */
export const RULES_STYLE_ID = 'maestro-m32m-rules';
/** Class of the editor's preview boxes (their text is `-text`, the name `-name`). */
export const PREVIEW_CLASS = 'maestro-m32m-preview';
/** Page classes of the theme layer and its chat part (src/features/theme/api.ts). */
const THEME_CLASSES = { layer: 'maestro-theme', chat: 'maestro-theme-chat' };
/** ST's element with the user's custom CSS: Maestro's sheet goes before it so the user's rules keep the last word. */
const CUSTOM_CSS_ID = 'custom-style';
export const HOOK_ORDER = 90;
/** Visible messages are marked again this long after the rules changed what is marked. */
export const RESTYLE_MS = 60;

type Plans = Record<Scope, ScopePlan>;

interface HookState {
    plans: Plans | null;
    doc: Document;
}

interface Formatter {
    addHook?: unknown;
    format?: unknown;
}

/** One hook per formatter for the page (ST has no removeHook). */
const HOOKS = new WeakMap<object, HookState>();

export interface MessageStylerDeps {
    app: App;
    log: Logger;
    doc?: Document;
    restyleMs?: number;
}

export class MessageStyler {
    private readonly app: App;
    private readonly log: Logger;
    private readonly doc: Document;
    private readonly restyleMs: number;
    private readonly listeners = new Set<() => void>();
    private hook: HookState | null = null;
    private plans: Plans | null = null;
    private signature = '';
    private css = '';
    private offStyle: Unsubscribe | null = null;
    private offSettings: Unsubscribe | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;

    constructor(deps: MessageStylerDeps) {
        this.app = deps.app;
        this.log = deps.log;
        this.doc = deps.doc ?? document;
        this.restyleMs = deps.restyleMs ?? RESTYLE_MS;
    }

    /* ---------------------------------------------------------------- lifecycle */

    start(): void {
        if (this.running) return;
        this.running = true;
        this.offSettings = this.app.settings.onChange((path) => {
            if (path === `modules.${MESSAGE_STYLE_KEY}` || path.startsWith(`modules.${MESSAGE_STYLE_KEY}.`))
                this.sync();
        });
        this.installHook();
        this.sync();
    }

    dispose(): void {
        this.running = false;
        this.offSettings?.();
        this.offSettings = null;
        this.unapply();
        this.emit();
        this.listeners.clear();
    }

    /** The live settings slice (repaired). */
    settings(): MessageStyleSettings {
        return readMessageStyleSettings(this.app.settings.module<Partial<MessageStyleSettings>>(MESSAGE_STYLE_KEY));
    }

    /** ST's formatter hook is in place (kinds ST does not mark can be styled). */
    annotated(): boolean {
        return this.hook !== null;
    }

    /** Messages are being styled now. */
    active(): boolean {
        return this.running && this.offStyle !== null;
    }

    /** The hook's plan for a scope while active. */
    plan(scope: Scope): ScopePlan | null {
        return this.plans?.[scope] ?? null;
    }

    /** Applies an edit of the settings and saves it (`path` under the module, e.g. `rules`); the notice syncs. */
    update(path: string, change: (settings: MessageStyleSettings) => void): void {
        change(this.settings());
        this.app.settings.notify(`modules.${MESSAGE_STYLE_KEY}.${path}`);
        this.app.settings.save();
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** Marks the messages on screen again (after a neighbour rebuilt them, for instance). */
    refresh(): void {
        if (this.plans) this.restyleVisible();
    }

    /* ---------------------------------------------------------------- the preview */

    /**
     * HTML of a sample message as the chat would show it: ST's own formatter (it runs this hook too) when available,
     * else a close imitation of ST's output marked for the current plan.
     */
    formatPreview(text: string, scope: Scope, name: string): string {
        if (this.hook) {
            try {
                const formatter = this.app.host.ctx().messageFormatter as Formatter | undefined;
                if (typeof formatter?.format === 'function') {
                    const html = (formatter.format as (...args: unknown[]) => unknown)(
                        text,
                        name,
                        false,
                        scope === 'user',
                        -1,
                    );
                    if (typeof html === 'string') return html;
                }
            } catch (error) {
                this.log.debug('message style: ST could not format the preview', error);
            }
        }
        const html = sampleHtml(text);
        const plan = this.plan(scope);
        return plan ? annotateHtml(html, plan, this.doc) : html;
    }

    /* ---------------------------------------------------------------- internals */

    /** Brings the page in line with the settings (idempotent). */
    sync(): void {
        const settings = this.settings();
        if (!this.running || !settings.enabled) {
            this.unapply();
            this.emit();
            return;
        }
        this.doc.documentElement?.classList.add(MESSAGE_STYLE_CLASS);
        this.setStyle(
            buildMessageStyleCss(settings.rules, settings.player, {
                pageClass: MESSAGE_STYLE_CLASS,
                previewClass: PREVIEW_CLASS,
                annotated: this.annotated(),
                themeClasses: THEME_CLASSES,
            }),
        );
        const plans: Plans | null = this.hook
            ? { user: buildPlan(settings.rules, 'user'), char: buildPlan(settings.rules, 'char') }
            : null;
        this.plans = plans;
        if (this.hook) this.hook.plans = plans;
        const signature = planSignature(plans);
        if (signature !== this.signature) {
            this.signature = signature;
            this.scheduleRestyle();
        }
        this.emit();
    }

    private unapply(): void {
        this.clearTimer();
        this.doc.documentElement?.classList.remove(MESSAGE_STYLE_CLASS);
        if (this.offStyle) {
            try {
                this.offStyle();
            } catch (error) {
                this.log.warn('message style: style removal failed', error);
            }
        }
        this.offStyle = null;
        this.css = '';
        if (this.hook) this.hook.plans = null;
        this.plans = null;
        if (this.signature) {
            this.signature = '';
            this.clearVisible();
        }
    }

    private installHook(): void {
        let formatter: Formatter | undefined;
        try {
            formatter = this.app.host.ctx().messageFormatter as Formatter | undefined;
        } catch {
            formatter = undefined;
        }
        if (!formatter || typeof formatter.addHook !== 'function') return;
        if (!this.app.host.caps.has('st.messageFormatter')) return;
        let state = HOOKS.get(formatter);
        if (!state) {
            const created: HookState = { plans: null, doc: this.doc };
            try {
                // A plain function: ST rejects async hooks. Reasoning blocks are not message text.
                (formatter.addHook as (hook: (mes: string, info: unknown) => string, options: object) => void)(
                    function maestroMessageStyle(mes: string, info: unknown): string {
                        const plans = created.plans;
                        if (!plans || typeof mes !== 'string' || !mes) return mes;
                        const meta = typeof info === 'object' && info !== null ? (info as Record<string, unknown>) : {};
                        if (meta.isReasoning === true) return mes;
                        try {
                            return annotateHtml(mes, plans[meta.isUser === true ? 'user' : 'char'], created.doc);
                        } catch {
                            return mes;
                        }
                    },
                    { stage: 'afterMarkdown', order: HOOK_ORDER },
                );
            } catch (error) {
                this.log.warn('message style: the formatter hook could not be added', error);
                return;
            }
            HOOKS.set(formatter, created);
            state = created;
        }
        state.doc = this.doc;
        this.hook = state;
    }

    private setStyle(css: string): void {
        if (css === this.css && this.offStyle) return;
        this.offStyle = this.app.ui.style(RULES_STYLE_ID, css);
        this.css = css;
        this.keepBeforeCustomCss();
    }

    private keepBeforeCustomCss(): void {
        const custom = this.doc.getElementById(CUSTOM_CSS_ID);
        const node = this.doc.querySelector(`style[data-maestro-style="${RULES_STYLE_ID}"]`);
        const parent = custom?.parentNode;
        if (!custom || !node || !parent || node.parentNode !== parent) return;
        if (node.compareDocumentPosition(custom) & 2 /* Node.DOCUMENT_POSITION_PRECEDING */) {
            parent.insertBefore(node, custom);
        }
    }

    private scheduleRestyle(): void {
        this.clearTimer();
        this.timer = setTimeout(() => {
            this.timer = null;
            this.restyleVisible();
        }, this.restyleMs);
    }

    private clearTimer(): void {
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
    }

    /** Message texts on screen; ST's message editor (a textarea inside `.mes_text`) is left alone. */
    private visibleTexts(): { text: Element; scope: Scope }[] {
        const chat = this.doc.getElementById('chat');
        if (!chat) return [];
        const out: { text: Element; scope: Scope }[] = [];
        for (const mes of Array.from(chat.querySelectorAll('.mes'))) {
            const text = mes.querySelector('.mes_text');
            if (!text || text.querySelector('textarea')) continue;
            out.push({ text, scope: mes.getAttribute('is_user') === 'true' ? 'user' : 'char' });
        }
        return out;
    }

    private restyleVisible(): void {
        const plans = this.plans;
        if (!plans) return;
        for (const { text, scope } of this.visibleTexts()) {
            try {
                clearAnnotations(text);
                annotateNode(text, plans[scope]);
            } catch (error) {
                this.log.debug('message style: a message could not be marked', error);
            }
        }
    }

    private clearVisible(): void {
        for (const { text } of this.visibleTexts()) {
            try {
                if (hasAnnotations(text)) clearAnnotations(text);
            } catch (error) {
                this.log.debug('message style: marks could not be removed', error);
            }
        }
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.warn('message style: change listener failed', error);
            }
        }
    }
}
