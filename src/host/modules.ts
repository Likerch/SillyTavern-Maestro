// SillyTavern modules that getContext() does not expose, imported at runtime by URL. The URL is built at
// runtime and marked @vite-ignore, so the bundle never resolves ST paths at build time. ST serves every
// module once per page: importing it again returns the same live instance ST itself uses.
// Every use must be guarded by a capability (src/host/caps.ts) so another ST version degrades instead of crashing.
import type { HostModules, Logger } from '../shared/contracts';

export type ModuleNamespace = Record<string, unknown>;
export type ModuleImporter = (url: string) => Promise<ModuleNamespace>;

/** Module paths, relative to the ST web root (public/). */
export const ST_MODULE_PATHS = {
    worldInfo: '/scripts/world-info.js',
    script: '/script.js',
    openai: '/scripts/openai.js',
    presetManager: '/scripts/preset-manager.js',
    chats: '/scripts/chats.js',
    regexEngine: '/scripts/extensions/regex/engine.js',
    utils: '/scripts/utils.js',
} as const;

/** personas.js (M41 «Персона для персонажа»): loaded through `load()`, HostModules keeps its methods. */
export const ST_PERSONAS_PATH = '/scripts/personas.js';

export interface HostModulesImpl extends HostModules {
    /** Absolute URL a path resolves to (diagnostics). */
    url(path: string): string;
}

const importByUrl: ModuleImporter = async (url) => (await import(/* @vite-ignore */ url)) as ModuleNamespace;

function pageOrigin(): string {
    return window.location.origin;
}

/**
 * @param importer replaced in tests; the default is a native dynamic import.
 * @param origin page origin (window.location.origin).
 */
export function createHostModules(
    log: Logger,
    importer: ModuleImporter = importByUrl,
    origin: () => string = pageOrigin,
): HostModulesImpl {
    const cache = new Map<string, Promise<ModuleNamespace>>();

    function url(path: string): string {
        const base = origin();
        const normalized = path.startsWith('/') ? path : path.startsWith('scripts/') ? `/${path}` : `/scripts/${path}`;
        const resolved = new URL(normalized, base);
        if (resolved.origin !== new URL(base).origin)
            throw new Error(`refusing to import a module from another origin: ${path}`);
        return resolved.href;
    }

    function load(path: string): Promise<ModuleNamespace> {
        let href: string;
        try {
            href = url(path);
        } catch (error) {
            return Promise.reject(error instanceof Error ? error : new Error(String(error)));
        }
        const cached = cache.get(href);
        if (cached) return cached;
        const pending = importer(href).catch((error: unknown) => {
            // Forget failures so a later call can retry (ST may still be loading, or the file moved).
            cache.delete(href);
            log.warn(`could not import ST module ${path}`, error);
            throw error;
        });
        cache.set(href, pending);
        return pending;
    }

    return {
        worldInfo: () => load(ST_MODULE_PATHS.worldInfo),
        script: () => load(ST_MODULE_PATHS.script),
        openai: () => load(ST_MODULE_PATHS.openai),
        presetManager: () => load(ST_MODULE_PATHS.presetManager),
        chats: () => load(ST_MODULE_PATHS.chats),
        regexEngine: () => load(ST_MODULE_PATHS.regexEngine),
        utils: () => load(ST_MODULE_PATHS.utils),
        load,
        url,
    };
}
