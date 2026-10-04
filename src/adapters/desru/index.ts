// DES-RU, our Russian add-on over DES (plan §2.2, §16). Found by its manifest; settings live in
// `extension_settings.desru` with per-module switches. Since 0.8.0 it publishes `globalThis.DESRU_API`
// (DES-RU src/maestro-api.js): Russian name declensions, DES aliases with a change event, and the functions Maestro
// may take over (while Maestro owns one, DES-RU skips it). DES-RU persists no ownership: Maestro announces what it
// owns on every start.
//
// Capabilities:
// - `desru.present`      installed, enabled in ST and loaded (its module script or settings panel is on the page);
// - `desru.names`        its names module (case forms, aliases) is on;
// - `desru.bunnymo`      its BunnyMo module (runtime fixes, language lock, normaliser) is on;
// - `desru.carrotKernel` its CarrotKernel module (Unicode finder, consistency rebuild, RAG forms) is on;
// - `desru.api`          its API version 1 is published (DES-RU 0.8.0+).
import { NeighbourBase, extensionSettingsOf, hasElement, homePageHas, isDict } from '../base';
import type { AdapterDeps, Dict, ExtensionManifest } from '../base';

export const DESRU_REPO = 'likerch/sillytavern-doom-enhancement-suite-ru';
export const DESRU_DISPLAY_NAME = "SillyTavern - Doom's Enhancement Suite - RU";
export const DESRU_KNOWN_NAMES = [
    'third-party/SillyTavern-DES-RU',
    'third-party/SillyTavern-Doom-Enhancement-Suite-RU',
];
export const DESRU_SETTINGS_KEY = 'desru';
/** Root of DES-RU's settings panel (settings.html). */
export const DESRU_PANEL = '#desru-settings';
/** The global DES-RU publishes its API under. */
export const DESRU_API_GLOBAL = 'DESRU_API';
/** The API version this adapter speaks; within a version DES-RU only adds members. */
export const DESRU_API_VERSION = 1;

export type DesRuModule = 'localization' | 'names' | 'serviceValues' | 'fixes' | 'bunnymo' | 'carrotKernel';

/**
 * Functions Maestro may take over from DES-RU (DES-RU MAESTRO_FUNCTIONS):
 * - `bunnymo.structuralPatches`: module 5 stops setting recursion flags on BunnyMo entries (excludeRecursion on the
 *   detectors and Anti-Clanker, preventRecursion on Kaomoji Library, Medicine Check, LINGUISTICS); its Russian keys,
 *   texts and archive case-form keys stay;
 * - `bunnymo.scanTags`: module 5 stops writing the scene's character tags into its scan-only prompt slot;
 * - `ck.consistencyRebuild`: module 6 stops rebuilding CarrotKernel's «Character Consistency» insert.
 */
export type DesRuFunction = 'bunnymo.structuralPatches' | 'ck.consistencyRebuild' | 'bunnymo.scanTags';

/** `globalThis.DESRU_API`, version 1 (DES-RU 0.8.0+). */
export interface DesRuApi {
    readonly version: number;
    /**
     * Every Russian case form of a name, the name itself first, with its capitalisation and ё. Search forms: some
     * coincide with another name («Александра» of «Александр»), so they must not become DES aliases. A name of several
     * words gives every combination of its word forms. Indeclinable and Latin names give only themselves.
     */
    nameForms(name: string): string[];
    /** One ST regex key (`/…/iu`, Unicode word boundaries, ё = е, any whitespace) matching every form; null for ''. */
    nameFormsKey(name: string): string | null;
    /** DES aliases as DES-RU sees them: card name → aliases (a copy; empty while DES-RU's guard blocks DES data). */
    aliases(): Record<string, string[]>;
    /**
     * Fires when DES-RU itself changed DES aliases or hidden names (added or removed an alias, hid a persona form,
     * dropped an adopted card). Changes the user makes in the DES Workshop are not reported. Returns the unsubscribe.
     */
    onNamesChanged(listener: () => void): () => void;
    /** Ids of the functions Maestro may take over. */
    functions(): string[];
    /** Exactly these functions are Maestro's from now on (replace, not add); unknown ids are skipped. */
    setMaestroOwned(ids: string[]): void;
    maestroOwned(): string[];
}

const API_METHODS = [
    'nameForms',
    'nameFormsKey',
    'aliases',
    'onNamesChanged',
    'functions',
    'setMaestroOwned',
    'maestroOwned',
] as const;

export function isDesRuManifest(manifest: ExtensionManifest): boolean {
    return homePageHas(manifest, DESRU_REPO) || manifest.display_name === DESRU_DISPLAY_NAME;
}

/** The published DES-RU API when it is version 1 with every method; undefined otherwise. */
export function readDesRuApi(value: unknown): DesRuApi | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const api = value as Record<string, unknown>;
    if (api.version !== DESRU_API_VERSION) return undefined;
    return API_METHODS.every((method) => typeof api[method] === 'function') ? (value as DesRuApi) : undefined;
}

export class DesRuAdapter extends NeighbourBase<'desru'> {
    readonly id = 'desru' as const;

    constructor(deps: AdapterDeps) {
        super(deps);
        this.capability('desru.present', () => this.present());
        this.capability('desru.names', () => this.present() && this.moduleEnabled('names'));
        this.capability('desru.bunnymo', () => this.present() && this.moduleEnabled('bunnymo'));
        this.capability('desru.carrotKernel', () => this.present() && this.moduleEnabled('carrotKernel'));
        this.capability('desru.api', () => this.present() && this.api() !== undefined);
    }

    present(): boolean {
        return this.enabledInSt() && (this.scriptUrl() !== null || hasElement(DESRU_PANEL));
    }

    protected async connect(): Promise<boolean> {
        await this.locate(isDesRuManifest, DESRU_KNOWN_NAMES);
        return true;
    }

    /** `extension_settings.desru` (live object, read-only for Maestro). */
    settings(): Dict | null {
        return extensionSettingsOf(this.host, DESRU_SETTINGS_KEY);
    }

    /** A DES-RU module switch; modules are on by default, as in DES-RU's DEFAULT_SETTINGS. */
    moduleEnabled(module: DesRuModule): boolean {
        const modules = this.settings()?.modules;
        const slice = isDict(modules) ? modules[module] : undefined;
        return !isDict(slice) || slice.enabled !== false;
    }

    /** DES-RU's API (read live: it appears when DES-RU starts and goes when it is disabled); undefined before 0.8.0. */
    api(): DesRuApi | undefined {
        return readDesRuApi((globalThis as Record<string, unknown>)[DESRU_API_GLOBAL]);
    }

    /**
     * Tells DES-RU which of its functions Maestro runs now (replaces the previous set; `[]` gives every function
     * back). Ids this DES-RU does not offer are left out. False when the API is not there or refused the call.
     */
    setMaestroOwned(ids: readonly DesRuFunction[]): boolean {
        const api = this.api();
        if (!api) return false;
        try {
            const offered = new Set(api.functions());
            api.setMaestroOwned([...new Set(ids)].filter((id) => offered.has(id)));
            return true;
        } catch (error) {
            this.log.warn('DES-RU refused setMaestroOwned', error);
            return false;
        }
    }
}
