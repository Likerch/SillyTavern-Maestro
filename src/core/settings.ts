import { STORY_LANGUAGES } from '../domain/story-language';
import type { StoryLanguageChoice } from '../domain/story-language';
import type { ChatNoticesLevel, CoreSettings, Logger, SettingsService, Unsubscribe } from '../shared/contracts';

export const SETTINGS_KEY = 'maestro';
export const CORE_SCHEMA_VERSION = 1;
/** What the strip under chat messages shows (plan-2 §5): everything, what waits for a decision, nothing. */
export const CHAT_NOTICES: readonly ChatNoticesLevel[] = ['all', 'pending', 'none'];

export function defaultCoreSettings(): CoreSettings {
    return {
        schemaVersion: CORE_SCHEMA_VERSION,
        mode: 'balanced',
        debug: false,
        uiLanguage: 'auto',
        profiles: {},
        backgroundDailyCapUsd: 0,
        dailyLimit: { enabled: false, usd: 0, action: 'warn' },
        autonomy: {},
        modules: {},
        firstRunDone: false,
        notifyLevel: 'all',
        showTechnical: false,
        chatNotices: 'all',
        storyLanguage: 'auto',
        composerButton: true,
    };
}

interface StoredRoot {
    core?: Partial<CoreSettings>;
    modules?: Record<string, Record<string, unknown>>;
}

interface ModuleDefaults {
    defaults: () => object;
    enabledByDefault: boolean;
}

/** Fills missing keys from defaults without overwriting stored values (shallow per object level). */
export function fillDefaults<T extends object>(stored: unknown, defaults: T): T {
    if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return structuredClone(defaults);
    const result = structuredClone(defaults) as Record<string, unknown>;
    for (const [key, value] of Object.entries(stored as Record<string, unknown>)) {
        const base = result[key];
        if (
            base &&
            typeof base === 'object' &&
            !Array.isArray(base) &&
            value &&
            typeof value === 'object' &&
            !Array.isArray(value)
        ) {
            result[key] = fillDefaults(value, base as object);
        } else {
            result[key] = value;
        }
    }
    return result as T;
}

/**
 * Settings live in extensionSettings.maestro = { core, modules: { [key]: slice } }. The object stays the
 * same reference so ST's own save picks up every change.
 */
export class Settings implements SettingsService {
    private readonly moduleDefaults = new Map<string, ModuleDefaults>();
    private readonly listeners = new Set<(path: string) => void>();
    private root: { core: CoreSettings; modules: Record<string, Record<string, unknown>> };

    constructor(
        private readonly getStore: () => Record<string, unknown>,
        private readonly persist: () => void,
        private readonly log: Logger,
    ) {
        this.root = this.load();
    }

    /** Re-reads extensionSettings (ST may replace the object after a settings reload). */
    reload(): void {
        this.root = this.load();
    }

    registerModule(key: string, defaults: () => object, enabledByDefault: boolean): void {
        this.moduleDefaults.set(key, { defaults, enabledByDefault });
        const stored = this.root.modules[key];
        this.root.modules[key] = fillDefaults(stored, defaults()) as Record<string, unknown>;
    }

    core(): CoreSettings {
        return this.root.core;
    }

    module<T extends object>(key: string): T {
        let slice = this.root.modules[key];
        if (!slice) {
            const entry = this.moduleDefaults.get(key);
            slice = (entry ? entry.defaults() : {}) as Record<string, unknown>;
            this.root.modules[key] = slice;
        }
        return slice as T;
    }

    isModuleEnabled(key: string): boolean {
        const explicit = this.root.core.modules[key];
        if (typeof explicit === 'boolean') return explicit;
        return this.moduleDefaults.get(key)?.enabledByDefault ?? false;
    }

    setModuleEnabled(key: string, enabled: boolean): void {
        this.root.core.modules[key] = enabled;
        this.save();
        this.notify(`core.modules.${key}`);
    }

    save(): void {
        this.persist();
    }

    onChange(listener: (path: string) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    notify(path: string): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(path);
            } catch (error) {
                this.log.error('settings listener failed', error);
            }
        }
    }

    /** Lifecycle `clean`: drop everything Maestro stored in settings. */
    reset(): void {
        const store = this.getStore();
        delete store[SETTINGS_KEY];
        this.root = this.load();
        this.save();
    }

    private load(): { core: CoreSettings; modules: Record<string, Record<string, unknown>> } {
        const store = this.getStore();
        const raw = (store[SETTINGS_KEY] ?? {}) as StoredRoot;
        const core = migrateCore(fillDefaults(raw.core, defaultCoreSettings()));
        const modules = raw.modules && typeof raw.modules === 'object' ? raw.modules : {};
        const root = { core, modules };
        store[SETTINGS_KEY] = root;
        return root;
    }
}

/** Core settings migrations: add steps as `if (settings.schemaVersion === n) { …; settings.schemaVersion = n + 1; }`. */
export function migrateCore(settings: CoreSettings): CoreSettings {
    if (!settings.schemaVersion || settings.schemaVersion < 1) settings.schemaVersion = 1;
    if (!(['all', 'important', 'urgent'] as const).includes(settings.notifyLevel)) settings.notifyLevel = 'all';
    if (typeof settings.showTechnical !== 'boolean') settings.showTechnical = false;
    if (!CHAT_NOTICES.includes(settings.chatNotices as ChatNoticesLevel)) settings.chatNotices = 'all';
    if (!STORY_LANGUAGES.includes(settings.storyLanguage as StoryLanguageChoice)) settings.storyLanguage = 'auto';
    if (typeof settings.composerButton !== 'boolean') settings.composerButton = true;
    return settings;
}
