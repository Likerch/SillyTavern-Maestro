// Lorebook Localizer, our key translator (plan §16). Settings: `extension_settings.lorebookLocalizer`;
// every entry it touched carries a provenance marker in `entry.extensions.lorebook_localizer`
// (LL src/entries.js): which source keys it translated and which keys it appended, per language.
// Since 0.2.0 it publishes `globalThis.LOREBOOK_LOCALIZER_API` (LL src/api.js): its pure key builders, headless
// localization of chosen entries, and the BunnyMo protection check (BunnyMo books and packs are never localized).
//
// Capabilities:
// - `localizer.present` installed, enabled in ST and loaded (its module script, button or settings exist);
// - `localizer.api`     its API version 1 is published (Localizer 0.2.0+).
import { NeighbourBase, extensionSettingsOf, hasElement, homePageHas, isDict, stringList } from '../base';
import type { AdapterDeps, Dict, ExtensionManifest } from '../base';

export const LOCALIZER_SETTINGS_KEY = 'lorebookLocalizer';
export const LOCALIZER_MARKER_KEY = 'lorebook_localizer';
export const LOCALIZER_DISPLAY_NAME = 'Lorebook Localizer';
export const LOCALIZER_REPO = 'likerch/sillytavern-lorebooklocalizer';
export const LOCALIZER_KNOWN_NAMES = ['third-party/SillyTavern-LorebookLocalizer'];
/** The button LL adds to the World Info panel. */
export const LOCALIZER_BUTTON = '#lorebook_localizer_button';
/** The global the Localizer publishes its API under. */
export const LOCALIZER_API_GLOBAL = 'LOREBOOK_LOCALIZER_API';
/** The API version this adapter speaks; within a version the Localizer only adds members. */
export const LOCALIZER_API_VERSION = 1;

export interface LocalizeEntriesOptions {
    /** Target language id from the Localizer's list (`ru`, `uk`, `de`, …); default: the one chosen in its dialog. */
    language?: string;
    /** Connection Manager profile id, `''` for the current connection; default: the one chosen in its dialog. */
    profileId?: string;
}

export interface LocalizeEntriesResult {
    /** Keys added. */
    added: number;
    /** Entries that got keys. */
    entries: number;
    /** Entries the model did not translate (errors, missing or unusable replies). */
    failures: number;
}

/** `globalThis.LOREBOOK_LOCALIZER_API`, version 1 (Lorebook Localizer 0.2.0+). */
export interface LocalizerApi {
    readonly version: number;
    /** One ST regex key (`/…/iu`) matching every form (Unicode word boundaries unless `boundaries: false`); null without forms. */
    buildKeyRegex(forms: string[], options?: { boundaries?: boolean }): string | null;
    /** Every form as its own plain key (cleaned). */
    buildPlainKeys(forms: string[]): string[];
    /** Forms normalised, deduplicated (case and ё/е) and capped at 60. */
    cleanForms(forms: string[]): string[];
    /**
     * The dialog's pipeline without UI and without a backup: collect the keys of these entries, translate, build
     * keys, write the book. The user's dialog options apply. Rejects for BunnyMo books, unknown books or languages,
     * unusable profiles and without a connection. Jobs (dialog and API) run one at a time.
     */
    localizeEntries(book: string, uids: number[], options?: LocalizeEntriesOptions): Promise<LocalizeEntriesResult>;
    /** BunnyMo's own lorebook or one of its packs (recognised by content): never localized. */
    isProtectedBook(book: string): Promise<boolean>;
}

const API_METHODS = ['buildKeyRegex', 'buildPlainKeys', 'cleanForms', 'localizeEntries', 'isProtectedBook'] as const;

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

/** The published Localizer API when it is version 1 with every method; undefined otherwise. */
export function readLocalizerApi(value: unknown): LocalizerApi | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const api = value as Record<string, unknown>;
    if (api.version !== LOCALIZER_API_VERSION) return undefined;
    return API_METHODS.every((method) => typeof api[method] === 'function') ? (value as LocalizerApi) : undefined;
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
        this.capability('localizer.api', () => this.present() && this.api() !== undefined);
    }

    present(): boolean {
        if (!this.enabledInSt()) return false;
        return this.scriptUrl() !== null || hasElement(LOCALIZER_BUTTON) || this.settings() !== null;
    }

    protected async connect(): Promise<boolean> {
        await this.locate(isLocalizerManifest, LOCALIZER_KNOWN_NAMES);
        return true;
    }

    /** The Localizer's API (read live); undefined before 0.2.0 or when it is not loaded. */
    api(): LocalizerApi | undefined {
        return readLocalizerApi((globalThis as Record<string, unknown>)[LOCALIZER_API_GLOBAL]);
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
