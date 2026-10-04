// DES-RU 0.7.0, our Russian add-on over DES (plan §2.2, §16). Found by its manifest; settings live in
// `extension_settings.desru` with per-module switches, which Maestro reads to split work with it (who applies
// which BunnyMo runtime fix, who rebuilds the CK consistency slot).
//
// Capabilities:
// - `desru.present`      installed, enabled in ST and loaded (its module script or settings panel is on the page);
// - `desru.names`        its names module (case forms, aliases) is on;
// - `desru.bunnymo`      its BunnyMo module (runtime fixes, language lock, normaliser) is on;
// - `desru.carrotKernel` its CarrotKernel module (Unicode finder, consistency rebuild, RAG forms) is on.
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

export type DesRuModule = 'localization' | 'names' | 'serviceValues' | 'fixes' | 'bunnymo' | 'carrotKernel';

export function isDesRuManifest(manifest: ExtensionManifest): boolean {
    return homePageHas(manifest, DESRU_REPO) || manifest.display_name === DESRU_DISPLAY_NAME;
}

export class DesRuAdapter extends NeighbourBase<'desru'> {
    readonly id = 'desru' as const;

    constructor(deps: AdapterDeps) {
        super(deps);
        this.capability('desru.present', () => this.present());
        this.capability('desru.names', () => this.present() && this.moduleEnabled('names'));
        this.capability('desru.bunnymo', () => this.present() && this.moduleEnabled('bunnymo'));
        this.capability('desru.carrotKernel', () => this.present() && this.moduleEnabled('carrotKernel'));
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
}
