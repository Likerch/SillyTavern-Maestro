// Shared plumbing of the neighbour adapters: finding an installed extension (internal name, manifest, its own
// module script on the page), the ST-level "disabled" check, safe capability probes and an idempotent, retryable
// ready(). Adapters are read-only in stage 0: nothing here writes to a neighbour's state.
import type { Host, Logger, NeighbourAdapter } from '../shared/contracts';

export type AdapterId = NeighbourAdapter['id'];
export type ModuleNamespace = Record<string, unknown>;
export type Dict = Record<string, unknown>;

/** Test seams; production code uses the defaults. */
export interface AdapterOptions {
    /**
     * Imports an ES module by absolute URL. The default is a native dynamic import: the same URL as the
     * neighbour's own import gives the same module instance, so live `export let` bindings are shared.
     */
    importModule?: (url: string) => Promise<ModuleNamespace>;
    /** Used for manifest.json only when this ST has no `getExtensionManifest` in its context. */
    fetch?: (url: string, init?: RequestInit) => Promise<Response>;
}

/** The manifest fields adapters look at (ST's `manifest.json`). */
export interface ExtensionManifest {
    display_name?: string;
    version?: string;
    js?: string;
    homePage?: string;
    generate_interceptor?: string;
}

export interface LocatedExtension {
    /** ST's internal name, `third-party/<folder>`: the key of `extension_settings.disabledExtensions`. */
    name: string;
    manifest: ExtensionManifest;
}

/** Context members of ST 1.19 that global.d.ts does not declare (public/scripts/st-context.js). */
export interface StContextExtras {
    getExtensionManifest?: (name: string) => unknown;
    getWorldInfoNames?: () => string[];
    loadWorldInfo?: (name: string) => Promise<unknown>;
    chatCompletionSettings?: unknown;
}

export interface AdapterDeps {
    host: Host;
    log: Logger;
    locator: ExtensionLocator;
    importModule: (url: string) => Promise<ModuleNamespace>;
}

export function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** The page document, or null outside a browser (unit tests in the node environment). */
export function pageDocument(): Document | null {
    return typeof document === 'undefined' ? null : document;
}

/** True when an element matching `selector` is on the page. */
export function hasElement(selector: string): boolean {
    try {
        return !!pageDocument()?.querySelector(selector);
    } catch {
        return false;
    }
}

export function extras(host: Host): StContextExtras {
    return host.ctx() as unknown as StContextExtras;
}

/** `extension_settings[key]` when it is an object. */
export function extensionSettingsOf(host: Host, key: string): Dict | null {
    const value = host.ctx().extensionSettings[key];
    return isDict(value) ? value : null;
}

function toManifest(value: unknown): ExtensionManifest | null {
    if (!isDict(value)) return null;
    const manifest: ExtensionManifest = {};
    for (const key of ['display_name', 'version', 'js', 'homePage', 'generate_interceptor'] as const) {
        const field = value[key];
        if (typeof field === 'string') manifest[key] = field;
    }
    return manifest;
}

const EXTENSION_PATH_RE = /\/scripts\/extensions\/(third-party\/[^/]+)\//;

/** Absolute URL of a script element's `src`, resolved against the document (null when unparseable). */
function scriptHref(script: Element, doc: Document): string | null {
    const raw = script.getAttribute('src');
    if (!raw) return null;
    try {
        return new URL(raw, doc.baseURI || 'http://localhost/').href;
    } catch {
        return null;
    }
}

function decodedPath(href: string): string {
    try {
        return decodeURIComponent(new URL(href).pathname);
    } catch {
        return '';
    }
}

/**
 * Finds installed extensions. Names come from ST's `extensionNames` (scripts/extensions.js), from the module
 * scripts ST put on the page, and from known folder names; manifests from ST's own manifest cache
 * (`getExtensionManifest`, the JSON ST fetched from `/scripts/extensions/<name>/manifest.json` at start, i.e. the
 * version actually running) and, on an ST without it, from that URL directly. Everything is fetched once.
 * Global and per-user installs both live under `/scripts/extensions/third-party/<folder>/`, so one lookup fits both.
 */
export class ExtensionLocator {
    private namesPromise: Promise<string[]> | null = null;
    private readonly manifests = new Map<string, Promise<ExtensionManifest | null>>();

    constructor(
        private readonly host: Host,
        private readonly log: Logger,
        private readonly fetchManifest: (url: string, init?: RequestInit) => Promise<Response>,
    ) {}

    /** Internal names of every extension ST knows about, plus third-party scripts found on the page. */
    names(): Promise<string[]> {
        this.namesPromise ??= this.loadNames();
        return this.namesPromise;
    }

    manifest(name: string): Promise<ExtensionManifest | null> {
        let cached = this.manifests.get(name);
        if (!cached) {
            cached = this.loadManifest(name);
            this.manifests.set(name, cached);
        }
        return cached;
    }

    /** First third-party extension whose manifest matches; `known` folder names are tried after ST's list. */
    async find(
        match: (manifest: ExtensionManifest) => boolean,
        known: readonly string[],
    ): Promise<LocatedExtension | null> {
        const names = (await this.names()).filter((name) => name.startsWith('third-party/'));
        const candidates = [...names, ...known.filter((name) => !names.includes(name))];
        for (const name of candidates) {
            const manifest = await this.manifest(name);
            if (manifest && match(manifest)) return { name, manifest };
        }
        return null;
    }

    /** ST keeps extensions switched off in its Extensions panel in `extension_settings.disabledExtensions`. */
    isDisabled(name: string): boolean {
        const list = this.host.ctx().extensionSettings.disabledExtensions;
        return Array.isArray(list) && list.includes(name);
    }

    /**
     * The extension's own module script on the page (ST inserts `<script type="module"
     * src="/scripts/extensions/<name>/<js>">` only for enabled extensions). Its URL is the base for importing the
     * extension's modules. Null when ST has not loaded it.
     */
    scriptOf(located: LocatedExtension): string | null {
        const doc = pageDocument();
        if (!doc) return null;
        const suffix = `/scripts/extensions/${located.name}/${located.manifest.js || 'index.js'}`;
        for (const script of doc.querySelectorAll('script[type="module"][src]')) {
            const href = scriptHref(script, doc);
            if (href && decodedPath(href).endsWith(suffix)) return href;
        }
        return null;
    }

    private async loadNames(): Promise<string[]> {
        const names = new Set<string>();
        try {
            const module = await this.host.modules.load('extensions.js');
            for (const name of stringList(module.extensionNames)) names.add(name);
        } catch (error) {
            this.log.debug('ST extension list is not available; using page scripts and known folders', error);
        }
        const doc = pageDocument();
        for (const script of doc?.querySelectorAll('script[type="module"][src]') ?? []) {
            const href = doc ? scriptHref(script, doc) : null;
            const match = href ? EXTENSION_PATH_RE.exec(decodedPath(href)) : null;
            if (match?.[1]) names.add(match[1]);
        }
        return [...names];
    }

    private async loadManifest(name: string): Promise<ExtensionManifest | null> {
        const lookup = extras(this.host).getExtensionManifest;
        if (typeof lookup === 'function') {
            try {
                // ST drops extensions without a loadable manifest, so null here means "not installed".
                return toManifest(lookup(name));
            } catch (error) {
                this.log.debug(`getExtensionManifest(${name}) failed`, error);
            }
        }
        try {
            const path = name.split('/').map(encodeURIComponent).join('/');
            const response = await this.fetchManifest(`/scripts/extensions/${path}/manifest.json`, {
                cache: 'no-store',
            });
            return response.ok ? toManifest(await response.json()) : null;
        } catch {
            return null;
        }
    }
}

/**
 * Base of the adapters. Subclasses register their capabilities in the constructor and implement `connect()`
 * (one attempt; resolves `true` when there is nothing left to retry: connected, not installed, or disabled).
 */
export abstract class NeighbourBase<Id extends AdapterId> implements NeighbourAdapter {
    abstract readonly id: Id;
    protected located: LocatedExtension | null = null;
    private readonly probes = new Map<string, () => boolean>();
    private settled = false;
    private pending: Promise<void> | null = null;

    protected constructor(protected readonly deps: AdapterDeps) {}

    protected get host(): Host {
        return this.deps.host;
    }

    protected get log(): Logger {
        return this.deps.log;
    }

    abstract present(): boolean;

    /** Version from the neighbour's manifest; undefined until ready() located it. */
    version(): string | undefined {
        return this.located?.manifest.version;
    }

    /** ST's internal name of the neighbour (`third-party/<folder>`), when located. */
    extensionName(): string | undefined {
        return this.located?.name;
    }

    /** Capability ids whose probes pass right now. */
    capabilities(): string[] {
        return [...this.probes].filter(([, probe]) => probe()).map(([id]) => id);
    }

    /** Every capability id this adapter can report, available or not. */
    capabilityIds(): string[] {
        return [...this.probes.keys()];
    }

    ready(): Promise<void> {
        if (this.settled) return Promise.resolve();
        this.pending ??= this.connect()
            .then(
                (settled) => {
                    this.settled = settled;
                },
                (error: unknown) => {
                    this.log.warn('connection failed', error);
                },
            )
            .finally(() => {
                this.pending = null;
            });
        return this.pending;
    }

    protected abstract connect(): Promise<boolean>;

    /**
     * Registers a capability in `host.caps` and in this adapter's list. Probes never throw. `refresh` runs before
     * the probe when Capabilities refreshes (for data that has to be loaded first).
     */
    protected capability(id: string, probe: () => boolean, detail?: string, refresh?: () => Promise<void>): void {
        const safe = (): boolean => {
            try {
                return probe();
            } catch (error) {
                this.log.debug(`probe ${id} failed`, error);
                return false;
            }
        };
        this.probes.set(id, safe);
        const hostProbe = refresh
            ? async (): Promise<boolean> => {
                  try {
                      await refresh();
                  } catch (error) {
                      this.log.debug(`refresh for ${id} failed`, error);
                  }
                  return safe();
              }
            : safe;
        this.host.caps.register(id, hostProbe, detail);
    }

    /** Located, and not switched off in ST's Extensions panel. */
    protected enabledInSt(): boolean {
        return this.located !== null && !this.deps.locator.isDisabled(this.located.name);
    }

    /** Locates the neighbour by manifest; logs what was found. */
    protected async locate(match: (manifest: ExtensionManifest) => boolean, known: readonly string[]): Promise<void> {
        this.located ??= await this.deps.locator.find(match, known);
        if (this.located) {
            const state = this.deps.locator.isDisabled(this.located.name) ? 'disabled in ST' : 'enabled';
            this.log.debug(`${this.located.name} ${this.located.manifest.version ?? '?'} (${state})`);
        }
    }

    /** The neighbour's module script URL (live: ST adds it while loading extensions). */
    protected scriptUrl(): string | null {
        return this.located ? this.deps.locator.scriptOf(this.located) : null;
    }
}

/** Case-insensitive "homePage contains". */
export function homePageHas(manifest: ExtensionManifest, fragment: string): boolean {
    return (manifest.homePage ?? '').toLowerCase().includes(fragment.toLowerCase());
}
