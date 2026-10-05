// The theme layer (M32): owns the page classes on <html> (`maestro-theme` + `maestro-theme-<part>`), the stylesheets
// (tokens, «st», «chat», neighbours' skins), the theme watcher and, with the «st» part, the clean chat-list previews
// (previews.ts). Off — by the setting, the module switch, Maestro's own shutdown, «Как было» — removes every class and
// sheet and puts the original previews back, so the page looks exactly as without Maestro (P11). Settings of ST and of
// the neighbours are never written.
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import { THEME_CLASS, partClass } from './api';
import type { NeighbourSkin, ThemeApi, ThemePart } from './api';
import { chatCss } from './css-chat';
import { stCss } from './css-st';
import { PreviewCleaner } from './previews';
import { ALL_PARTS, THEME_KEY, isThemePart, readThemeSettings } from './settings';
import type { ThemeSettings } from './settings';
import { TOKENS_STYLE_ID, buildTokensCss, readStTheme } from './tokens';
import { ThemeWatcher } from './watcher';

export const ST_STYLE_ID = 'maestro-theme-st';
export const CHAT_STYLE_ID = 'maestro-theme-chat';
export const skinStyleId = (skin: Pick<NeighbourSkin, 'id'>): string => `${THEME_CLASS}-${skin.id}`;
/** «Как было»: how long the original look is shown before the layer comes back by itself. */
export const PREVIEW_MS = 10_000;
/** ST's element with the user's custom CSS: Maestro's sheets go before it so the user's rules still win ties. */
const CUSTOM_CSS_ID = 'custom-style';

export interface ThemeLayerDeps {
    app: App;
    log: Logger;
    skins: readonly NeighbourSkin[];
    doc?: Document;
    debounceMs?: number;
}

export class ThemeLayer implements ThemeApi {
    private readonly app: App;
    private readonly log: Logger;
    private readonly skins: readonly NeighbourSkin[];
    private readonly doc: Document;
    private readonly watcher: ThemeWatcher;
    private readonly previews: PreviewCleaner;
    private readonly styles = new Map<string, { css: string; off: Unsubscribe }>();
    private readonly listeners = new Set<() => void>();
    private readonly brokenSkins = new Set<string>();
    private offSettings: Unsubscribe | null = null;
    private running = false;
    private applied = false;
    private previewTimer: ReturnType<typeof setTimeout> | null = null;
    private signature = '';

    constructor(deps: ThemeLayerDeps) {
        this.app = deps.app;
        this.log = deps.log;
        this.skins = deps.skins;
        this.doc = deps.doc ?? document;
        this.watcher = new ThemeWatcher({
            doc: this.doc,
            debounceMs: deps.debounceMs,
            subscribe: (event, handler) => this.app.host.events.on(event, handler),
            onChange: () => this.refresh(),
            onError: (error) => this.log.debug('theme watcher', error),
        });
        this.previews = new PreviewCleaner({
            doc: this.doc,
            onError: (error) => this.log.debug('theme previews', error),
        });
    }

    /** The chat-list previews are being cleaned (layer and «st» part on, not «Как было»). */
    cleaningPreviews(): boolean {
        return this.previews.isRunning();
    }

    /* ---------------------------------------------------------------- lifecycle */

    start(): void {
        if (this.running) return;
        this.running = true;
        this.offSettings = this.app.settings.onChange((path) => {
            if (path === `modules.${THEME_KEY}` || path.startsWith(`modules.${THEME_KEY}.`)) this.sync();
        });
        this.sync();
    }

    dispose(): void {
        this.running = false;
        this.offSettings?.();
        this.offSettings = null;
        this.clearPreviewTimer();
        this.unapply();
        this.emitIfChanged();
        this.listeners.clear();
    }

    /** The live settings slice (repaired). */
    settings(): ThemeSettings {
        return readThemeSettings(this.app.settings.module<Partial<ThemeSettings>>(THEME_KEY));
    }

    /* ---------------------------------------------------------------- ThemeApi */

    enabled(): boolean {
        return this.applied && this.previewTimer === null;
    }

    parts(): ThemePart[] {
        if (!this.enabled()) return [];
        const settings = this.settings();
        return ALL_PARTS.filter((part) => settings.parts[part]);
    }

    async setEnabled(on: boolean): Promise<void> {
        this.clearPreviewTimer();
        this.settings().enabled = on;
        this.commit('enabled');
    }

    async setPart(part: ThemePart, on: boolean): Promise<void> {
        if (!isThemePart(part)) return;
        this.clearPreviewTimer();
        this.settings().parts[part] = on;
        this.commit(`parts.${part}`);
    }

    refresh(): void {
        if (!this.applied) return;
        this.renderTokens(this.settings());
        this.keepBeforeCustomCss();
        this.emitIfChanged();
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /* ---------------------------------------------------------------- settings section helpers */

    async setDensity(density: ThemeSettings['density']): Promise<void> {
        this.settings().density = density;
        this.commit('density');
    }

    async setRadiusScale(scale: number): Promise<void> {
        this.settings().radiusScale = scale;
        this.commit('radiusScale');
    }

    /** «Как было» is showing (the classes are off for a moment, the settings are unchanged). */
    previewing(): boolean {
        return this.previewTimer !== null;
    }

    /** Shows the page without the layer for PREVIEW_MS (or until called with false). */
    preview(on: boolean): void {
        if (on && this.applied && this.previewTimer === null) {
            this.previewTimer = setTimeout(() => {
                this.previewTimer = null;
                this.sync();
            }, PREVIEW_MS);
        } else if (!on) {
            this.clearPreviewTimer();
        }
        this.sync();
    }

    /* ---------------------------------------------------------------- internals */

    /** Brings the page in line with the settings (idempotent). */
    sync(): void {
        const settings = this.settings();
        if (!this.running || !settings.enabled) {
            this.clearPreviewTimer();
            this.unapply();
        } else {
            this.apply(settings);
        }
        this.emitIfChanged();
    }

    private commit(path: string): void {
        this.app.settings.notify(`modules.${THEME_KEY}.${path}`);
        this.app.settings.save();
        this.sync();
    }

    private apply(settings: ThemeSettings): void {
        this.applied = true;
        this.setStyle(ST_STYLE_ID, stCss(settings.density));
        this.setStyle(CHAT_STYLE_ID, chatCss(settings.density));
        for (const skin of this.skins) {
            if (typeof skin.css !== 'string') {
                if (!this.brokenSkins.has(skin.id)) this.log.warn(`theme: skin ${String(skin.id)} has no css`);
                this.brokenSkins.add(skin.id);
                continue;
            }
            this.setStyle(skinStyleId(skin), skin.css);
        }
        this.renderTokens(settings);
        this.keepBeforeCustomCss();
        this.setClasses(settings, this.previewTimer === null);
        this.previews.sync(this.previewTimer === null && settings.parts.st);
        if (!this.watcher.isRunning()) this.watcher.start();
    }

    private unapply(): void {
        this.watcher.stop();
        this.previews.stop();
        this.setClasses(null, false);
        for (const { off } of this.styles.values()) {
            try {
                off();
            } catch (error) {
                this.log.warn('theme: style removal failed', error);
            }
        }
        this.styles.clear();
        this.applied = false;
    }

    private setClasses(settings: ThemeSettings | null, on: boolean): void {
        const list = this.doc.documentElement?.classList;
        if (!list) return;
        list.toggle(THEME_CLASS, on);
        for (const part of ALL_PARTS) list.toggle(partClass(part), on && settings?.parts[part] === true);
    }

    private renderTokens(settings: ThemeSettings): void {
        let css: string;
        try {
            css = buildTokensCss(readStTheme(this.doc), {
                density: settings.density,
                radiusScale: settings.radiusScale,
            });
        } catch (error) {
            this.log.warn('theme: cannot read the ST theme', error);
            return;
        }
        this.setStyle(TOKENS_STYLE_ID, css);
    }

    private setStyle(id: string, css: string): void {
        const current = this.styles.get(id);
        if (current?.css === css) return;
        this.styles.set(id, { css, off: this.app.ui.style(id, css) });
    }

    /** Moves Maestro's theme sheets in front of ST's custom CSS so the user's own rules keep the last word. */
    private keepBeforeCustomCss(): void {
        const custom = this.doc.getElementById(CUSTOM_CSS_ID);
        const parent = custom?.parentNode;
        if (!custom || !parent) return;
        for (const id of this.styles.keys()) {
            const node = this.doc.querySelector(`style[data-maestro-style="${id}"]`);
            if (!node || node.parentNode !== parent) continue;
            if (node.compareDocumentPosition(custom) & Node.DOCUMENT_POSITION_PRECEDING)
                parent.insertBefore(node, custom);
        }
    }

    private clearPreviewTimer(): void {
        if (this.previewTimer !== null) clearTimeout(this.previewTimer);
        this.previewTimer = null;
    }

    private emitIfChanged(): void {
        const settings = this.running ? this.settings() : null;
        const signature = JSON.stringify([
            this.enabled(),
            this.parts(),
            this.previewing(),
            settings?.enabled,
            settings?.density,
            settings?.radiusScale,
            this.styles.get(TOKENS_STYLE_ID)?.css ?? '',
        ]);
        if (signature === this.signature) return;
        this.signature = signature;
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.warn('theme: change listener failed', error);
            }
        }
    }
}
