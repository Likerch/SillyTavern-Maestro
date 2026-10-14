import type { App, Logger, MaestroModule, ModuleManager, Unsubscribe } from '../shared/contracts';
import type { Settings } from '../core/settings';

type Disposer = Unsubscribe | (() => void | Promise<void>);

/** A module's `whileSuspended` part while it runs. */
interface HeldPart {
    disposers: Disposer[];
    /** API keys it exposed while starting; dropped when it is released. */
    exposed: Set<string>;
}

interface Entry {
    module: MaestroModule;
    running: boolean;
    disposers: Disposer[];
    /** API keys the module exposed while starting (besides its own key); dropped when it stops. */
    exposed: Set<string>;
    /** Its `whileSuspended` part, while the pause holds the module off; never together with `running`. */
    held: HeldPart | null;
}

/**
 * Starts and stops plan modules. Everything a module registers through `own()` is released on disable,
 * so a disabled module leaves no trace (P11).
 */
export class Modules implements ModuleManager {
    private readonly entries = new Map<string, Entry>();
    private readonly apis = new Map<string, unknown>();
    private app: App | null = null;
    private starting: Entry | null = null;
    /** The `whileSuspended` part being started (its exposures are collected like a module's). */
    private holding: HeldPart | null = null;
    /**
     * startAll() is running: held parts wait for its end (in a service chat opened at page load the pause comes while
     * the modules start, and a held part must find the kept modules it builds on running).
     */
    private booting = false;
    /**
     * «Мастерская» (M42): while set, only these modules run; the others stay off without their switch changing and
     * start again on resume(). null = no pause.
     */
    private keep: ReadonlySet<string> | null = null;
    /** Enabled modules the pause stopped or kept from starting (resume() starts them). */
    private readonly held = new Set<string>();

    constructor(
        private readonly settings: Settings,
        private readonly log: Logger,
    ) {}

    register(modules: MaestroModule[], registerStrings: (module: MaestroModule) => void): void {
        for (const module of modules) {
            if (this.entries.has(module.key)) throw new Error(`duplicate module key ${module.key}`);
            this.entries.set(module.key, { module, running: false, disposers: [], exposed: new Set(), held: null });
            this.settings.registerModule(module.key, module.defaults as () => object, module.enabledByDefault);
            registerStrings(module);
        }
    }

    /** Starts every enabled module whose capabilities are present, in stage order. */
    async startAll(app: App): Promise<void> {
        this.app = app;
        const ordered = [...this.entries.values()].sort((a, b) => a.module.stage - b.module.stage);
        this.booting = true;
        try {
            for (const entry of ordered) {
                if (this.settings.isModuleEnabled(entry.module.key)) await this.start(entry);
            }
        } finally {
            this.booting = false;
        }
        await this.startHeldParts();
    }

    async stopAll(): Promise<void> {
        // Maestro stops: nothing is held for a resume() any more (the workshop's own stop must not start modules).
        this.keep = null;
        this.held.clear();
        const ordered = [...this.entries.values()].sort((a, b) => b.module.stage - a.module.stage);
        for (const entry of ordered) {
            await this.stopHeld(entry);
            await this.stop(entry);
        }
    }

    list(): { module: MaestroModule; enabled: boolean; running: boolean; missing: string[]; suspended?: boolean }[] {
        return [...this.entries.values()].map((entry) => ({
            module: entry.module,
            enabled: this.settings.isModuleEnabled(entry.module.key),
            running: entry.running,
            missing: this.missing(entry.module),
            ...(this.held.has(entry.module.key) ? { suspended: true } : {}),
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
        this.held.delete(key);
        await this.stopHeld(entry);
        await this.stop(entry);
    }

    async suspend(keep: readonly string[]): Promise<void> {
        this.keep = new Set(keep);
        // Reverse stage order, as stopAll(): a module stops before the ones it was built on.
        const ordered = [...this.entries.values()].sort((a, b) => b.module.stage - a.module.stage);
        for (const entry of ordered) {
            if (this.keep.has(entry.module.key)) continue;
            if (entry.running) {
                await this.stop(entry);
                this.held.add(entry.module.key);
            } else if (this.settings.isModuleEnabled(entry.module.key)) {
                this.held.add(entry.module.key);
            }
        }
        // After every stop, in stage order: a held part never sees a module that is about to stop.
        if (!this.booting) await this.startHeldParts();
    }

    async resume(): Promise<void> {
        if (!this.keep) return;
        this.keep = null;
        const ordered = [...this.entries.values()].sort((a, b) => a.module.stage - b.module.stage);
        for (const entry of ordered) {
            if (!this.held.delete(entry.module.key)) continue;
            // Released first: the module starts afresh and reads its data again (what the part wrote meanwhile too).
            await this.stopHeld(entry);
            if (this.settings.isModuleEnabled(entry.module.key)) await this.start(entry);
        }
        this.held.clear();
    }

    isSuspended(): boolean {
        return this.keep !== null;
    }

    api<T>(key: string): T | undefined {
        return this.apis.get(key) as T | undefined;
    }

    expose(key: string, api: unknown): void {
        if (api === undefined) {
            this.apis.delete(key);
            return;
        }
        this.apis.set(key, api);
        this.starting?.exposed.add(key);
        this.holding?.exposed.add(key);
    }

    private missing(module: MaestroModule): string[] {
        if (!this.app) return [];
        return (module.requires ?? []).filter((id) => !this.app?.host.caps.has(id));
    }

    private async start(entry: Entry): Promise<void> {
        const app = this.app;
        if (!app || entry.running) return;
        if (this.keep && !this.keep.has(entry.module.key)) {
            // Paused by «Мастерская»: it starts on resume(); its `whileSuspended` part runs meanwhile.
            this.held.add(entry.module.key);
            if (!this.booting) await this.startHeld(entry);
            return;
        }
        const missing = this.missing(entry.module);
        if (missing.length) {
            this.log.warn(`module ${entry.module.key} not started, missing: ${missing.join(', ')}`);
            return;
        }
        const log = this.log.scope(entry.module.id);
        this.starting = entry;
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
            this.unexpose(entry);
        } finally {
            if (this.starting === entry) this.starting = null;
        }
    }

    private unexpose(entry: Entry): void {
        this.apis.delete(entry.module.key);
        for (const key of entry.exposed) this.apis.delete(key);
        entry.exposed.clear();
    }

    private async stop(entry: Entry): Promise<void> {
        if (!entry.running) return;
        try {
            await entry.module.dispose?.();
        } catch (error) {
            this.log.error(`dispose of ${entry.module.key} failed`, error);
        }
        await this.release(entry);
        this.unexpose(entry);
        entry.running = false;
    }

    private async release(entry: Entry): Promise<void> {
        await this.runDisposers(entry.module.key, entry.disposers);
    }

    private async runDisposers(key: string, disposers: Disposer[]): Promise<void> {
        for (const dispose of disposers.splice(0).reverse()) {
            try {
                await dispose();
            } catch (error) {
                this.log.error(`release in ${key} failed`, error);
            }
        }
    }

    /** Starts the parts of the held modules that keep running during the pause, in stage order. */
    private async startHeldParts(): Promise<void> {
        if (!this.keep) return;
        const ordered = [...this.entries.values()].sort((a, b) => a.module.stage - b.module.stage);
        for (const entry of ordered) if (this.held.has(entry.module.key)) await this.startHeld(entry);
    }

    private async startHeld(entry: Entry): Promise<void> {
        const app = this.app;
        const part = entry.module.whileSuspended;
        if (!app || !part || entry.held || entry.running || !this.keep) return;
        if (!this.held.has(entry.module.key) || !this.settings.isModuleEnabled(entry.module.key)) return;
        if (this.missing(entry.module).length) return;
        const held: HeldPart = { disposers: [], exposed: new Set() };
        entry.held = held;
        const log = this.log.scope(entry.module.id);
        this.holding = held;
        try {
            await part.call(entry.module, {
                app,
                settings: this.settings.module(entry.module.key),
                log,
                own: (dispose) => held.disposers.push(dispose),
            });
            log.debug('kept while suspended');
        } catch (error) {
            log.error('the part kept while suspended failed', error);
            await this.stopHeld(entry);
        } finally {
            if (this.holding === held) this.holding = null;
        }
    }

    private async stopHeld(entry: Entry): Promise<void> {
        const held = entry.held;
        if (!held) return;
        entry.held = null;
        await this.runDisposers(entry.module.key, held.disposers);
        for (const key of held.exposed) this.apis.delete(key);
        held.exposed.clear();
    }
}
