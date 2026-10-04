// Qvink Memory 1.3.29 (research/qvink-nai-studio.md §A). It has no API and emits no events: memories live in
// `chat[i].extra.qvink_memory`, settings (of the active Qvink profile) in `extension_settings.qvink_memory`, and its
// only global is the generate interceptor `memory_intercept_messages`, which is also the runtime marker.
//
// Capabilities:
// - `qvink.present`        installed, enabled in ST and its interceptor is registered;
// - `qvink.chat`           Qvink is on for the current chat (global toggle or per-chat state);
// - `qvink.removeMessages` "Remove Messages" is on: messages older than the threshold are dropped from the prompt.
import { NeighbourBase, extensionSettingsOf, hasElement, homePageHas, isDict, pageDocument } from '../base';
import type { AdapterDeps, Dict, ExtensionManifest } from '../base';

export const QVINK_KEY = 'qvink_memory';
export const QVINK_INTERCEPTOR = 'memory_intercept_messages';
export const QVINK_KNOWN_NAMES = ['third-party/SillyTavern-MessageSummarize', 'third-party/qvink_memory'];

/** Qvink defaults for the settings Maestro reads (Q:129-169). */
const QVINK_DEFAULTS = {
    exclude_messages_after_threshold: true,
    default_chat_enabled: true,
    use_global_toggle_state: false,
    global_toggle_state: true,
} as const;

/** Qvink's per-message record, typed for reading. */
export interface QvinkMemory {
    /** Summary text without the prefill; empty when the message has none yet. */
    memory: string;
    /** Marked "long-term" by the user (brain icon). */
    remember: boolean;
    /** Force-excluded by the user. */
    exclude: boolean;
    /** Where the memory is injected now, recomputed by Qvink on every refresh. */
    include: 'short' | 'long' | null;
    /** Still newer than the injection threshold (the raw message is still in the prompt). */
    lagging: boolean;
    edited: boolean;
    error?: string;
}

export function isQvinkManifest(manifest: ExtensionManifest): boolean {
    return (
        manifest.generate_interceptor === QVINK_INTERCEPTOR ||
        manifest.display_name === QVINK_KEY ||
        homePageHas(manifest, 'qvink/qvink_memory') ||
        homePageHas(manifest, 'qvink/sillytavern-messagesummarize')
    );
}

/** Texts Qvink shows under a message while a summary is pending (SummaryQueue, Q:3238, 3303, 3381). */
const PENDING_TEXT_RE = /^(?:Summary queued|Delaying summary|Summarizing)/;

export class QvinkAdapter extends NeighbourBase<'qvink'> {
    readonly id = 'qvink' as const;

    constructor(deps: AdapterDeps) {
        super(deps);
        this.capability('qvink.present', () => this.present());
        this.capability('qvink.chat', () => this.present() && this.chatEnabled());
        this.capability('qvink.removeMessages', () => this.present() && this.chatEnabled() && this.removesMessages());
    }

    present(): boolean {
        const disabled = this.located !== null && this.deps.locator.isDisabled(this.located.name);
        return !disabled && typeof (globalThis as unknown as Dict)[QVINK_INTERCEPTOR] === 'function';
    }

    protected async connect(): Promise<boolean> {
        await this.locate(isQvinkManifest, QVINK_KNOWN_NAMES);
        return true;
    }

    /** `extension_settings.qvink_memory` (live object, read-only for Maestro). */
    settings(): Dict | null {
        return extensionSettingsOf(this.host, QVINK_KEY);
    }

    /** Qvink is on for this chat, as its `chat_enabled()` decides. */
    chatEnabled(): boolean {
        if (this.setting('use_global_toggle_state')) return this.setting('global_toggle_state');
        const chatState = this.host.ctx().chatMetadata[QVINK_KEY];
        const perChat = isDict(chatState) ? chatState.enabled : undefined;
        return typeof perChat === 'boolean' ? perChat : this.setting('default_chat_enabled');
    }

    /** "Remove Messages": every message older than the injection threshold leaves the prompt. */
    removesMessages(): boolean {
        return this.setting('exclude_messages_after_threshold');
    }

    /** Qvink's record of a message, as a typed copy; null when there is none. */
    memoryOf(index: number): QvinkMemory | null {
        const message = this.host.ctx().chat[index];
        const raw = message?.extra?.[QVINK_KEY];
        if (!isDict(raw)) return null;
        const memory: QvinkMemory = {
            memory: typeof raw.memory === 'string' ? raw.memory : '',
            remember: raw.remember === true,
            exclude: raw.exclude === true,
            include: raw.include === 'short' || raw.include === 'long' ? raw.include : null,
            lagging: raw.lagging === true,
            edited: raw.edited === true,
        };
        if (typeof raw.error === 'string' && raw.error) memory.error = raw.error;
        return memory;
    }

    /**
     * Best effort "Qvink is summarizing now" (it has no event for it, research §A3/§A4): its progress bar is on the
     * page, or a message shows a pending-summary text. Hidden memories (`display_memories` off) and single
     * summaries without a progress bar can be missed; callers should treat false as "probably idle".
     */
    isBusy(): boolean {
        if (!this.present()) return false;
        if (hasElement('.summarize.qvink_progress_bar')) return true;
        const doc = pageDocument();
        if (!doc) return false;
        for (const element of doc.querySelectorAll('#chat div.qvink_memory_text')) {
            if (PENDING_TEXT_RE.test((element.textContent ?? '').trim())) return true;
        }
        return false;
    }

    private setting(key: keyof typeof QVINK_DEFAULTS): boolean {
        const value = this.settings()?.[key];
        return typeof value === 'boolean' ? value : QVINK_DEFAULTS[key];
    }
}
