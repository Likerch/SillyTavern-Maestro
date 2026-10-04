// The Preset Studio's place in ST's «AI Response Configuration» drawer (research/parity-preset.md §10.4 а, P-013,
// P-014, P-015): `div#maestro-preset-launcher` goes right before `#completion_prompt_manager` (inside the same
// `.range-block` of `#openai_settings`, so ST hides it itself for Text Completion, P-016) with a compact summary —
// preset name, enabled blocks, PM's tokenUsage and error, the unsaved badge — and «Открыть Пресет-студию» /
// «Классический редактор». PM is hidden by a body class and a stylesheet only: its DOM, handlers, edit popup and
// quick-edit fields stay and it keeps rendering (P-007, P-012, P-013, P-131). Restore removes everything.
import { enabledCount } from '../../domain/preset-ui-blocks';
import { activeOrderOf, promptsOf } from '../../domain/preset-ui-diff';
import { button, el, icon } from '../../ui/components/dom';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { PresetServices } from './studio';

export const LAUNCHER_ID = 'maestro-preset-launcher';
export const PM_CONTAINER_ID = 'completion_prompt_manager';
export const REPLACED_CLASS = 'maestro-pm-replaced';
/** P-006: the summary's own reasons to refresh (counts are final at PROMPT_READY, OAI:1606). */
export const LAUNCHER_EVENTS = ['CHAT_COMPLETION_PROMPT_READY', 'OAI_PRESET_CHANGED_AFTER', 'SETTINGS_UPDATED'];
const REFRESH_DELAY_MS = 250;

interface PromptManagerLike {
    tokenUsage?: unknown;
    error?: unknown;
    overriddenPrompts?: unknown;
    tokenHandler?: { getCounts?: () => unknown } | null;
}

/** Live read-outs of ST's promptManager (openai.js export, P-190): token usage, error, counts, overrides. */
export class PmInfo {
    private openai: Record<string, unknown> | null = null;
    private loading: Promise<void> | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /** Imports openai.js once (the summary and the studio read it synchronously afterwards). */
    load(): Promise<void> {
        this.loading ??= (async () => {
            try {
                if (!this.app.host.caps.has('st.oai.promptManager')) return;
                this.openai = await this.app.host.modules.openai();
            } catch (error) {
                this.log.debug('openai.js is not available', error);
            }
        })();
        return this.loading;
    }

    private pm(): PromptManagerLike | null {
        const pm = this.openai?.promptManager;
        return pm && typeof pm === 'object' ? (pm as PromptManagerLike) : null;
    }

    /** «Всего токенов» of PM's header (P-009), or null before the first assembly. */
    tokenUsage(): number | null {
        const value = this.pm()?.tokenUsage;
        return typeof value === 'number' && Number.isFinite(value) ? value : null;
    }

    /** The assembly error PM shows (P-010). */
    error(): string | null {
        const value = this.pm()?.error;
        return typeof value === 'string' && value ? value : null;
    }

    /** Per-block counts of the last assembly (P-008). */
    counts(): Map<string, number> {
        const map = new Map<string, number>();
        try {
            const counts = this.pm()?.tokenHandler?.getCounts?.();
            if (counts && typeof counts === 'object') {
                for (const [identifier, value] of Object.entries(counts as Record<string, unknown>)) {
                    if (typeof value === 'number' && Number.isFinite(value)) map.set(identifier, value);
                }
            }
        } catch (error) {
            this.log.debug('PM counts', error);
        }
        return map;
    }

    /** Blocks a character card replaced in the last assembly (P-040). */
    overridden(): Set<string> {
        const list = this.pm()?.overriddenPrompts;
        return new Set(Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : []);
    }
}

export interface LauncherSummary {
    preset: string;
    enabled: number;
    total: number;
    tokens: number | null;
    error: string | null;
    dirty: boolean;
}

export interface LauncherDeps {
    app: App;
    log: Logger;
    services: PresetServices;
    pm: PmInfo;
    open(): void;
}

export class PmLauncher {
    private node: HTMLElement | null = null;
    private parts: {
        preset: HTMLElement;
        unsaved: HTMLElement;
        stats: HTMLElement;
        error: HTMLElement;
        classic: HTMLButtonElement;
    } | null = null;
    private offs: Unsubscribe[] = [];
    private timer: ReturnType<typeof setTimeout> | null = null;
    private installed = false;
    /** «Классический редактор» pressed: PM is visible for this session (not saved). */
    private classic = false;

    constructor(private readonly deps: LauncherDeps) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.deps.app.i18n.t(key, params);
    }

    /** Starts replacing PM; false while ST's PM container is not on the page yet (retried on every refresh). */
    install(): boolean {
        if (!this.installed) {
            this.installed = true;
            const events = this.deps.app.host.events;
            for (const key of LAUNCHER_EVENTS) {
                const name = events.name(key) ?? key;
                this.offs.push(events.on(name, () => this.schedule()));
            }
            const store = this.deps.services.store();
            if (store) this.offs.push(store.onChange(() => this.schedule()));
            void this.deps.pm.load().then(() => this.schedule());
        }
        const placed = this.place();
        this.refreshNow();
        return placed;
    }

    /** Puts PM back and removes the launcher and our listeners. Safe to call twice. */
    restore(): void {
        this.installed = false;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.log.debug('launcher listener', error);
            }
        }
        if (this.timer) clearTimeout(this.timer);
        this.timer = null;
        this.node?.remove();
        this.node = null;
        this.parts = null;
        document.body.classList.remove(REPLACED_CLASS);
    }

    active(): boolean {
        return this.installed && this.node?.isConnected === true;
    }

    classicVisible(): boolean {
        return !this.installed || this.classic;
    }

    /** «Классический редактор»: PM is shown again until the page reloads or the user hides it. */
    showClassic(): void {
        this.classic = true;
        this.applyClass();
        this.renderClassicButton();
        document.getElementById(PM_CONTAINER_ID)?.scrollIntoView?.({ block: 'start', behavior: 'smooth' });
    }

    hideClassic(): void {
        this.classic = false;
        this.applyClass();
        this.renderClassicButton();
    }

    private place(): boolean {
        if (!this.installed) return false;
        if (this.node?.isConnected) return true;
        const container = document.getElementById(PM_CONTAINER_ID);
        const parent = container?.parentElement;
        if (!container || !parent) {
            this.applyClass();
            return false;
        }
        this.node ??= this.build();
        parent.insertBefore(this.node, container);
        this.applyClass();
        return true;
    }

    /** PM is hidden only while our launcher stands in its place (never a page without both). */
    private applyClass(): void {
        const hide = this.installed && !this.classic && this.node?.isConnected === true;
        document.body.classList.toggle(REPLACED_CLASS, hide);
    }

    private build(): HTMLElement {
        const preset = el('span', { class: 'maestro-m34-launcher-preset' });
        const unsaved = el('span', {
            class: 'maestro-m34-badge maestro-m34-badge-warn maestro-m34-launcher-unsaved',
            text: this.t('m34.launcher.unsaved'),
            title: this.t('m34.launcher.unsavedHint'),
        });
        unsaved.hidden = true;
        const stats = el('div', { class: 'maestro-m34-launcher-stats', attrs: { 'aria-live': 'polite' } });
        const error = el('div', { class: 'maestro-m34-launcher-error', attrs: { role: 'alert' } });
        error.hidden = true;
        const classic = button({
            icon: 'fa-list-ul',
            label: this.t('m34.classic'),
            className: 'maestro-m34-launcher-classic',
            onClick: () => (this.classic ? this.hideClassic() : this.showClassic()),
        });
        this.parts = { preset, unsaved, stats, error, classic };
        return el('div', { class: 'maestro-m34-launcher maestro-theme', attrs: { id: LAUNCHER_ID } }, [
            el('div', { class: 'maestro-m34-launcher-head' }, [
                icon('fa-sliders'),
                el('strong', { text: this.t('m34.title') }),
                preset,
                unsaved,
            ]),
            stats,
            error,
            el('div', { class: 'maestro-m34-launcher-actions' }, [
                button({
                    icon: 'fa-up-right-from-square',
                    label: this.t('m34.launcher.open'),
                    kind: 'primary',
                    className: 'maestro-m34-launcher-open',
                    onClick: () => this.deps.open(),
                }),
                classic,
            ]),
        ]);
    }

    private renderClassicButton(): void {
        const classic = this.parts?.classic;
        if (!classic) return;
        const label = classic.querySelector('span');
        if (label) label.textContent = this.classic ? this.t('m34.launcher.hideClassic') : this.t('m34.classic');
        classic.setAttribute('aria-pressed', this.classic ? 'true' : 'false');
    }

    schedule(): void {
        if (!this.installed || this.timer) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            this.refreshNow();
        }, REFRESH_DELAY_MS);
    }

    /** The summary of the working copy (store), or of ST's live settings when the store is absent. */
    summary(): LauncherSummary {
        const pm = this.deps.pm;
        const store = this.deps.services.store();
        if (store) {
            const counts = enabledCount(store.prompts());
            return {
                preset: store.current(),
                ...counts,
                tokens: pm.tokenUsage(),
                error: pm.error(),
                dirty: store.draft().dirty,
            };
        }
        const settings = this.deps.app.host.ctx().chatCompletionSettings ?? {};
        const prompts = new Map(promptsOf(settings).map((prompt) => [prompt.identifier, prompt]));
        const rows = activeOrderOf(settings).map((item) => ({ item, prompt: prompts.get(item.identifier) ?? null }));
        const name = settings.preset_settings_openai;
        return {
            preset: typeof name === 'string' ? name : '',
            ...enabledCount(rows),
            tokens: pm.tokenUsage(),
            error: pm.error(),
            dirty: false,
        };
    }

    refreshNow(): void {
        if (!this.installed) return;
        this.place();
        const parts = this.parts;
        if (!parts) return;
        let summary: LauncherSummary;
        try {
            summary = this.summary();
        } catch (error) {
            this.deps.log.debug('launcher summary', error);
            return;
        }
        parts.preset.textContent = summary.preset || this.t('m34.launcher.noPreset');
        parts.unsaved.hidden = !summary.dirty;
        parts.stats.textContent = [
            this.t('m34.launcher.blocks', { enabled: summary.enabled, total: summary.total }),
            summary.tokens === null
                ? this.t('m34.launcher.noTokens')
                : this.t('m34.launcher.tokens', { count: summary.tokens.toLocaleString() }),
        ].join(' · ');
        parts.error.hidden = !summary.error;
        parts.error.replaceChildren(
            ...(summary.error ? [icon('fa-triangle-exclamation'), el('span', { text: summary.error })] : []),
        );
        this.renderClassicButton();
    }
}
