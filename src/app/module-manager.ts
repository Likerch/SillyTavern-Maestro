import type { App, Logger, MaestroModule, ModuleManager, Unsubscribe } from '../shared/contracts';
import type { Settings } from '../core/settings';

interface Entry {
    module: MaestroModule;
    running: boolean;
    disposers: (Unsubscribe | (() => void | Promise<void>))[];
}

/**
 * Starts and stops plan modules. Everything a module registers through `own()` is released on disable,
 * so a disabled module leaves no trace (P11).
 */
export class Modules implements ModuleManager {
    private readonly entries = new Map<string, Entry>();
    private readonly apis = new Map<string, unknown>();
    private app: App | null = null;

    constructor(
        private readonly settings: Settings,
        private readonly log: Logger,
    ) {}

    register(modules: MaestroModule[], registerStrings: (module: MaestroModule) => void): void {
        for (const module of modules) {
            if (this.entries.has(module.key)) throw new Error(`duplicate module key ${module.key}`);
            this.entries.set(module.key, { module, running: false, disposers: [] });
            this.settings.registerModule(module.key, module.defaults as () => object, module.enabledByDefault);
            registerStrings(module);
        }
    }

    /** Starts every enabled module whose capabilities are present, in stage order. */
    async startAll(app: App): Promise<void> {
        this.app = app;
        const ordered = [...this.entries.values()].sort((a, b) => a.module.stage - b.module.stage);
        for (const entry of ordered) {
            if (this.settings.isModuleEnabled(entry.module.key)) await this.start(entry);
        }
    }

    async stopAll(): Promise<void> {
        const ordered = [...this.entries.values()].sort((a, b) => b.module.stage - a.module.stage);
        for (const entry of ordered) await this.stop(entry);
    }

    list(): { module: MaestroModule; enabled: boolean; running: boolean; missing: string[] }[] {
        return [...this.entries.values()].map((entry) => ({
            module: entry.module,
            enabled: this.settings.isModuleEnabled(entry.module.key),
            running: entry.running,
            missing: this.missing(entry.module),
        }));
    }

    async enable(key: string): Promise<void> {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.settings.setModuleEnabled(key, true);
        await this.start(entry);
    }

    async disable(key: string): Promise<void> {
        const entry = this.entries.get(key);
        if (!entry) return;
        this.settings.setModuleEnabled(key, false);
        await this.stop(entry);
    }

    api<T>(key: string): T | undefined {
        return this.apis.get(key) as T | undefined;
    }

    expose(key: string, api: unknown): void {
        this.apis.set(key, api);
    }

    private missing(module: MaestroModule): string[] {
        if (!this.app) return [];
        return (module.requires ?? []).filter((id) => !this.app?.host.caps.has(id));
    }

    private async start(entry: Entry): Promise<void> {
        const app = this.app;
        if (!app || entry.running) return;
        const missing = this.missing(entry.module);
        if (missing.length) {
            this.log.warn(`module ${entry.module.key} not started, missing: ${missing.join(', ')}`);
            return;
        }
        const log = this.log.scope(entry.module.id);
        try {
            await entry.module.init({
                app,
                settings: this.settings.module(entry.module.key),
                log,
                own: (dispose) => entry.disposers.push(dispose),
            });
            entry.running = true;
            log.debug('started');
        } catch (error) {
            log.error('init failed', error);
            await this.release(entry);
        }
    }

    private async stop(entry: Entry): Promise<void> {
        if (!entry.running) return;
        try {
            await entry.module.dispose?.();
        } catch (error) {
            this.log.error(`dispose of ${entry.module.key} failed`, error);
        }
        await this.release(entry);
        this.apis.delete(entry.module.key);
        entry.running = false;
    }

    private async release(entry: Entry): Promise<void> {
        for (const dispose of entry.disposers.splice(0).reverse()) {
            try {
                await dispose();
            } catch (error) {
                this.log.error(`release in ${entry.module.key} failed`, error);
            }
        }
    }
}
