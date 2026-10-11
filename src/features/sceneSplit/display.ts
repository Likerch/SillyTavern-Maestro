// How the `<offscreen>` block looks in the chat (M43 «Сцена и вокруг»): one folded «Вокруг» under the scene. Display
// only — the stored message keeps the raw block.
//
// Left alone, SillyTavern drops the unknown tag on render (DOMPurify keeps the words, `power_user.encode_tags` is off by
// default) and the block reads as the last paragraph of the scene; DES chat bubbles then make it one more narrator card.
// So two hooks of ST's message formatter (ST 1.19 message-formatter.js) handle it before Markdown and the sanitizer:
// - stage beforeRegex, order 5: the block leaves the scene and comes back once at the end between two marker
//   paragraphs (domain/scene-split.ts markForDisplay) — before regex scripts that may strip tags, before tag encoding;
// - stage afterMarkdown, order 20 (before NAI Studio's 50 and the message style's 90): the formatted HTML between the
//   markers becomes `<div style=…><details><summary>Вокруг</summary>…</details></div>` at the very end, outside any
//   paragraph. DOMPurify keeps `<details>`, `<summary>`, the style and data attributes, and prefixes classes
//   (`custom-maestro-around`).
// DES cards (and Discord) take a top-level `<div>` with an inline colour and margin for a preset's styled block and
// keep it whole after the speaker cards (chatBubbles.js applyChatBubbles, «skip styled blocks», on by default); with
// that option off the `<details>` goes as one piece into one narration card (font colours inside are spans, so DES
// does not split it). HTML comments (DES's GFX markers) do not survive DOMPurify, so they are not used.
// ST cannot remove a hook: they are added once per formatter and switched by their state. Messages rendered while the
// hooks were off (Maestro started after the chat, the module switched, a workshop chat left) are rendered again with
// rerenderMessage(), which announces MESSAGE_UPDATED so DES lays its cards out again.
import { AROUND_ATTR, hasOffscreen, markForDisplay, wrapDisplay } from '../../domain/scene-split';
import { isEditing, rerenderMessage } from '../../host/messages';
import type { App, Logger } from '../../shared/contracts';

export const MARK_ORDER = 5;
export const WRAP_ORDER = 20;
/** The chat on screen is checked again this long after a start, a chat switch or a settings change. */
export const REFRESH_MS = 300;

interface HookState {
    active: boolean;
    label: string;
}

interface Formatter {
    addHook?: unknown;
}

type Hook = (mes: string, info: unknown) => string;

/** One pair of hooks per formatter for the page (ST has no removeHook). */
const HOOKS = new WeakMap<object, HookState>();

function infoOf(info: unknown): Record<string, unknown> {
    return typeof info === 'object' && info !== null ? (info as Record<string, unknown>) : {};
}

export class AroundDisplay {
    private state: HookState | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private running = false;
    private refreshing: Promise<void> = Promise.resolve();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly wanted: () => { active: boolean; label: string },
        private readonly refreshMs = REFRESH_MS,
    ) {}

    /** The hooks are in place (ST 1.19 with its message formatter). */
    hooked(): boolean {
        return this.state !== null;
    }

    /** Folded boxes are drawn now. */
    active(): boolean {
        return this.state?.active === true;
    }

    start(): void {
        this.running = true;
        this.install();
        this.sync();
    }

    /** Hooks off; boxes on screen go back to how SillyTavern draws the message (P11). */
    async dispose(): Promise<void> {
        this.running = false;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (!this.state?.active) return;
        this.state.active = false;
        await this.refresh();
    }

    /** Brings the hooks in line with the settings and checks the chat on screen a moment later. */
    sync(): void {
        const state = this.state;
        if (!state) return;
        const wanted = this.wanted();
        state.active = this.running && wanted.active;
        state.label = wanted.label;
        this.schedule();
    }

    /** Checks the chat on screen a moment later (chat switch, start, settings). */
    schedule(): void {
        if (!this.state) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.refresh();
        }, this.refreshMs);
    }

    /** Re-renders the messages on screen whose look does not match the hooks (one pass at a time). */
    refresh(): Promise<void> {
        this.refreshing = this.refreshing
            .then(() => this.refreshNow())
            .catch((error: unknown) => {
                this.log.debug('scene split: the chat could not be refreshed', error);
            });
        return this.refreshing;
    }

    private async refreshNow(): Promise<void> {
        const state = this.state;
        if (!state || typeof document === 'undefined') return;
        const root = document.getElementById('chat');
        if (!root) return;
        const chat = (this.app.host.ctx().chat ?? []) as STChatMessage[];
        const busy = this.app.turn.current() !== null;
        for (const node of Array.from(root.querySelectorAll('.mes[mesid]'))) {
            const index = Number(node.getAttribute('mesid'));
            const message = chat[index];
            if (!message || message.is_user || message.is_system || !hasOffscreen(message.mes)) continue;
            // The reply being written is drawn by the stream; the user's editor is never replaced.
            if ((busy && index === chat.length - 1) || isEditing(index)) continue;
            const text = node.querySelector('.mes_text');
            if (!text) continue;
            const box = text.querySelector(`details[${AROUND_ATTR}]`);
            const summary = box?.querySelector('summary')?.textContent ?? null;
            const fine = state.active ? box !== null && summary === state.label : box === null;
            if (fine) continue;
            await rerenderMessage(this.app.host, index, message, { log: this.log });
        }
    }

    private install(): void {
        if (this.state) return;
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
            const created: HookState = { active: false, label: '' };
            // Called on the formatter: ST's addHook keeps its hooks in a private field of `this`.
            const target = formatter;
            const add = (hook: Hook, options: object): void =>
                (target.addHook as (this: Formatter, hook: Hook, options: object) => void).call(target, hook, options);
            // Plain functions: ST rejects async hooks. The player's messages and reasoning are left alone.
            const mark: Hook = function maestroSceneSplitMark(mes, info) {
                const meta = infoOf(info);
                if (!created.active || typeof mes !== 'string' || meta.isUser === true || meta.isReasoning === true)
                    return mes;
                try {
                    return markForDisplay(mes);
                } catch {
                    return mes;
                }
            };
            const wrap: Hook = function maestroSceneSplitWrap(mes, info) {
                const meta = infoOf(info);
                if (typeof mes !== 'string' || meta.isUser === true || meta.isReasoning === true) return mes;
                try {
                    return wrapDisplay(mes, created.label);
                } catch {
                    return mes;
                }
            };
            try {
                add(mark, { stage: 'beforeRegex', order: MARK_ORDER });
                add(wrap, { stage: 'afterMarkdown', order: WRAP_ORDER });
            } catch (error) {
                this.log.warn('scene split: the formatter hooks could not be added', error);
                return;
            }
            HOOKS.set(formatter, created);
            state = created;
        }
        this.state = state;
    }
}
