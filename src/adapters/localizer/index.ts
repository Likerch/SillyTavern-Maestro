// Lorebook Localizer 0.1.0, our key translator (plan §16). Settings: `extension_settings.lorebookLocalizer`;
// every entry it touched carries a provenance marker in `entry.extensions.lorebook_localizer`
// (LL src/entries.js): which source keys it translated and which keys it appended, per language.
//
// Capabilities:
// - `localizer.present` installed, enabled in ST and loaded (its module script, button or settings exist).
import { NeighbourBase, extensionSettingsOf, hasElement, homePageHas, isDict, stringList } from '../base';
import type { AdapterDeps, Dict, ExtensionManifest } from '../base';

export const LOCALIZER_SETTINGS_KEY = 'lorebookLocalizer';
export const LOCALIZER_MARKER_KEY = 'lorebook_localizer';
export const LOCALIZER_DISPLAY_NAME = 'Lorebook Localizer';
export const LOCALIZER_REPO = 'likerch/sillytavern-lorebooklocalizer';
export const LOCALIZER_KNOWN_NAMES = ['third-party/SillyTavern-LorebookLocalizer'];
/** The button LL adds to the World Info panel. */
export const LOCALIZER_BUTTON = '#lorebook_localizer_button';

export interface LocalizerLanguageState {
    /** Human-readable language name. */
    language: string;
    /** Original keys already translated. */
    sources: string[];
    /** Keys the Localizer appended, per entry field. */
    added: { key: string[]; keysecondary: string[] };
}

export interface LocalizerMarker {
    version: number;
    /** By language id (`ru`, …). */
    languages: Record<string, LocalizerLanguageState>;
}

export function isLocalizerManifest(manifest: ExtensionManifest): boolean {
    return manifest.display_name === LOCALIZER_DISPLAY_NAME || homePageHas(manifest, LOCALIZER_REPO);
}

/** Reads the Localizer marker of a World Info entry as a typed copy; null when the entry has none. */
export function readLocalizerMarker(entry: unknown): LocalizerMarker | null {
    const extensions = isDict(entry) ? entry.extensions : undefined;
    const marker = isDict(extensions) ? extensions[LOCALIZER_MARKER_KEY] : undefined;
    if (!isDict(marker)) return null;
    const languages: Record<string, LocalizerLanguageState> = {};
    if (isDict(marker.languages)) {
        for (const [id, state] of Object.entries(marker.languages)) {
            if (!isDict(state)) continue;
            const added = isDict(state.added) ? state.added : {};
            languages[id] = {
                language: typeof state.language === 'string' ? state.language : id,
                sources: stringList(state.sources),
                added: { key: stringList(added.key), keysecondary: stringList(added.keysecondary) },
            };
        }
    }
    return { version: typeof marker.version === 'number' ? marker.version : 0, languages };
}

export class LocalizerAdapter extends NeighbourBase<'localizer'> {
    readonly id = 'localizer' as const;

    constructor(deps: AdapterDeps) {
        super(deps);
        this.capability('localizer.present', () => this.present());
    }

    present(): boolean {
        if (!this.enabledInSt()) return false;
        return this.scriptUrl() !== null || hasElement(LOCALIZER_BUTTON) || this.settings() !== null;
    }

    protected async connect(): Promise<boolean> {
        await this.locate(isLocalizerManifest, LOCALIZER_KNOWN_NAMES);
        return true;
    }

    /** `extension_settings.lorebookLocalizer` (live object, read-only for Maestro). */
    settings(): Dict | null {
        return extensionSettingsOf(this.host, LOCALIZER_SETTINGS_KEY);
    }

    /** The Localizer's provenance marker of a World Info entry (keys it translated and added); null if none. */
    markerOf(entry: unknown): LocalizerMarker | null {
        return readLocalizerMarker(entry);
    }

    /** Every key the Localizer appended to an entry, over all languages (Maestro must not treat them as the author's). */
    addedKeysOf(entry: unknown): Set<string> {
        const keys = new Set<string>();
        for (const state of Object.values(this.markerOf(entry)?.languages ?? {})) {
            for (const key of [...state.added.key, ...state.added.keysecondary]) keys.add(key);
        }
        return keys;
    }
}
