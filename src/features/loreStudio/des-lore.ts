// DES Lore Library through DES's own modules (research/parity-lore.md §9; plan Q32: DES stays the owner of
// campaigns, global flags, journals and auto-link). The modules are imported from the URL of DES's own script, so
// they are the very instances DES uses (shared caches, the `switchChain` queue). Nothing here runs before DES has
// loaded its settings (its drawer toggle is on the page): campaignManager would otherwise save defaults over the
// user's data (D/cm:44-66).
import { adaptersOf } from '../../adapters';
import { isRecord } from '../../domain/lore-studio-entries';
import { libraryView, workshopLinks } from '../../domain/lore-studio-campaigns';
import type { LibraryView } from '../../domain/lore-studio-campaigns';
import type { App, Logger } from '../../shared/contracts';
import { LoreStudioError } from './st-lore';

type Namespace = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

export const DES_LORE_MODULES = {
    campaigns: 'src/systems/lorebook/campaignManager.js',
    api: 'src/systems/lorebook/lorebookAPI.js',
    autoLink: 'src/systems/lorebook/autoLink.js',
    persistence: 'src/core/persistence.js',
} as const;

/** DES puts this toggle on the page once its settings are loaded (adapters/des DES_SELECTORS.drawerToggle). */
const DES_LOADED_SELECTOR = '#rpg-extension-enabled';

export class DesLore {
    private modules: Partial<Record<keyof typeof DES_LORE_MODULES, Namespace>> = {};
    private loading: Promise<boolean> | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private adapter() {
        return adaptersOf(this.app).des;
    }

    present(): boolean {
        try {
            return this.adapter().present();
        } catch {
            return false;
        }
    }

    /** DES finished loading its settings (safe to call its mutators). */
    loaded(): boolean {
        return this.present() && !!document.querySelector(DES_LOADED_SELECTOR);
    }

    /** Imports DES's lorebook modules once; false when DES is absent, not loaded yet or the modules moved. */
    ready(): Promise<boolean> {
        if (this.modules.campaigns) return Promise.resolve(true);
        if (!this.loaded()) return Promise.resolve(false);
        this.loading ??= this.importAll().finally(() => {
            this.loading = null;
        });
        return this.loading;
    }

    private scriptBase(): string | null {
        const name = this.adapter().extensionName?.();
        if (!name) return null;
        const marker = `/scripts/extensions/${name}/`;
        for (const script of document.querySelectorAll('script[type="module"][src]')) {
            const raw = script.getAttribute('src');
            if (!raw) continue;
            try {
                const url = new URL(raw, document.baseURI || 'http://localhost/');
                // Same directory as DES's own `import('./src/…')`, so the URL (and the module instance) match.
                if (decodeURIComponent(url.pathname).includes(marker)) return new URL('./', url).pathname;
            } catch {
                // unparseable src: skip
            }
        }
        return null;
    }

    private async importAll(): Promise<boolean> {
        const base = this.scriptBase();
        if (!base) return false;
        for (const [key, path] of Object.entries(DES_LORE_MODULES) as [keyof typeof DES_LORE_MODULES, string][]) {
            try {
                this.modules[key] = await this.app.host.modules.load(`${base}${path}`);
            } catch (error) {
                this.log.warn(`DES ${path} did not load`, error);
            }
        }
        return typeof this.modules.campaigns?.createCampaign === 'function';
    }

    private call(module: keyof typeof DES_LORE_MODULES, name: string, ...args: unknown[]): unknown {
        const target = this.modules[module]?.[name];
        if (typeof target !== 'function') throw new LoreStudioError('desUnavailable');
        return (target as Fn)(...args);
    }

    private has(module: keyof typeof DES_LORE_MODULES, name: string): boolean {
        return typeof this.modules[module]?.[name] === 'function';
    }

    /** `extensionSettings.lorebook`, read fresh every time (DES replaces the object on load). */
    lorebook(): Record<string, unknown> | null {
        const settings = this.adapter().settings();
        return settings && isRecord(settings.lorebook) ? settings.lorebook : null;
    }

    view(worldNames: readonly string[], activeBooks: readonly string[]): LibraryView {
        return libraryView(this.lorebook(), worldNames, activeBooks);
    }

    workshop(): Record<string, string> {
        return workshopLinks(this.adapter().settings());
    }

    isSwitching(): boolean {
        return this.has('campaigns', 'isSwitching') && this.call('campaigns', 'isSwitching') === true;
    }

    /** Campaign switches and deletions rewrite Workshop stores: never while the Workshop is open (plan §10.8). */
    private guardWorkshop(): void {
        if (this.adapter().isWorkshopOpen()) throw new LoreStudioError('workshopOpen');
    }

    createCampaign(name: string): string {
        return String(this.call('campaigns', 'createCampaign', name, 'fa-folder', ''));
    }

    renameCampaign(id: string, name: string): void {
        this.call('campaigns', 'renameCampaign', id, name);
    }

    async deleteCampaign(id: string): Promise<boolean> {
        this.guardWorkshop();
        return (await this.call('campaigns', 'deleteCampaign', id)) === true;
    }

    setIcon(id: string, icon: string): void {
        this.call('campaigns', 'updateCampaignIcon', id, icon);
    }

    setColor(id: string, color: string): void {
        this.call('campaigns', 'updateCampaignColor', id, color);
    }

    reorder(ids: readonly string[]): void {
        this.call('campaigns', 'reorderCampaigns', [...ids]);
    }

    toggleCollapsed(id: string): void {
        this.call('campaigns', 'toggleCampaignCollapsed', id);
    }

    async setActive(id: string | null): Promise<boolean> {
        this.guardWorkshop();
        return (await this.call('campaigns', 'setActiveCampaign', id, {})) === true;
    }

    /** Files a book under a campaign (null = unfiled) and reconciles the active campaign (L-200). */
    async moveBook(book: string, toId: string | null): Promise<void> {
        const current = this.call('campaigns', 'getCampaignForBook', book) as { id?: string } | null;
        const fromId = current?.id ?? null;
        if (fromId === toId) return;
        if (toId) this.call('campaigns', 'moveBookBetweenCampaigns', fromId, toId, book);
        else if (fromId) this.call('campaigns', 'removeBookFromCampaign', fromId, book);
        await this.reconcile();
    }

    /** DES's 🌐 flag: never switched off by campaign switches or auto-link (L-205). */
    toggleGlobal(book: string): boolean {
        return this.call('campaigns', 'toggleGlobalBook', book) === true;
    }

    async setAutoLink(on: boolean): Promise<void> {
        const lorebook = this.lorebook();
        if (!lorebook) throw new LoreStudioError('desUnavailable');
        lorebook.autoLinkByName = on;
        this.call('persistence', 'saveSettings');
        if (on && this.has('autoLink', 'syncAutoLinkedLorebooks')) {
            await this.call('autoLink', 'syncAutoLinkedLorebooks', {});
        }
    }

    /** Runs a global-activation change after any campaign switch in flight (never from inside a DES task). */
    async queueBookTask<T>(task: () => Promise<T>): Promise<T> {
        if (!this.has('campaigns', 'queueBookTask')) return task();
        return (await this.call('campaigns', 'queueBookTask', task)) as T;
    }

    private async reconcile(): Promise<void> {
        const active = this.has('campaigns', 'getActiveCampaignId')
            ? this.call('campaigns', 'getActiveCampaignId')
            : null;
        if (active && this.has('campaigns', 'queueReconcile')) await this.call('campaigns', 'queueReconcile');
    }

    /** A book renamed outside DES: campaigns, global flags and journals follow (L-215). */
    async onWorldRenamed(oldName: string, newName: string): Promise<void> {
        if (!(await this.ready())) {
            this.adapter().invalidateLoreCache(oldName);
            return;
        }
        if (this.has('campaigns', 'onWorldRenamed')) this.call('campaigns', 'onWorldRenamed', oldName, newName);
        this.adapter().invalidateLoreCache(oldName);
        this.adapter().invalidateLoreCache(newName);
        await this.reconcile();
    }

    /** A book deleted outside DES: every DES reference dropped (L-216). */
    async onWorldDeleted(name: string): Promise<void> {
        if (!(await this.ready())) {
            this.adapter().invalidateLoreCache(name);
            return;
        }
        if (this.has('campaigns', 'onWorldDeleted')) this.call('campaigns', 'onWorldDeleted', name);
        this.adapter().invalidateLoreCache(name);
        await this.reconcile();
    }

    invalidate(name: string): void {
        try {
            this.adapter().invalidateLoreCache(name);
        } catch (error) {
            this.log.debug('DES cache reset failed', error);
        }
    }
}
