// Doom's Enhancement Suite 2.6.0 (research/des.md). Found by its manifest; its ES modules are imported from the
// URL of DES's own module script, exactly like DES-RU and NAI Studio do, so we get DES's live module instances.
// `export let` values (extensionSettings, lastGeneratedData, …) are reassigned by DES on chat load: always read
// them through the module namespace, never cache them.
//
// Capabilities:
// - `des.present`  DES is installed, enabled in ST and its module script is on the page;
// - `des.state`    core/state.js imported with `extensionSettings` (live settings, roster, aliases);
// - `des.enabled`  DES's own on/off switch is on (`extensionSettings.enabled`);
// - `des.together` tracker generation mode is `together` (JSON at the start of the main reply);
// - `des.lore`     the Lore Library API module (lorebookAPI.js) is loaded, so its cache can be reset.
import { desSwipeRecord, parseDesTracker } from '../../domain/des-tracker';
import type { DesTrackerSnapshot } from '../../domain/des-tracker';
import { NeighbourBase, hasElement, homePageHas, isDict, stringList } from '../base';
import type { AdapterDeps, Dict, ExtensionManifest, ModuleNamespace } from '../base';

export const DES_REPO = 'dangerdaza/dooms-enhancement-suite';
export const DES_DISPLAY_NAME = "Doom's Enhancement Suite";
export const DES_KNOWN_NAMES = ['third-party/Dooms-Enhancement-Suite'] as const;
export const DES_VERIFIED_VERSIONS = ['2.6.0'] as const;

/** DES modules relative to its script; `required` exports are checked by type. */
export const DES_MODULES = {
    state: { path: 'src/core/state.js', required: { extensionSettings: 'object' } },
    persistence: { path: 'src/core/persistence.js', required: { saveSettings: 'function', saveChatData: 'function' } },
    // Statically reachable from DES only through lazy modules; its top level just creates a cache Map, so importing
    // it early is harmless and gives the instance the Lore Library will use.
    lorebookApi: { path: 'src/systems/lorebook/lorebookAPI.js', required: { invalidateWICache: 'function' } },
    // Statically imported by DES's index.js (same instance): DES's built-in prompt texts and the assembled tracker
    // block, for the neighbour prompts registry (M36). Optional: everything else works without it.
    promptBuilder: {
        path: 'src/systems/generation/promptBuilder.js',
        required: { getAssembledTrackerPrompt: 'function' },
    },
} as const;

/**
 * DES prompt overrides (state.js; '' = DES's built-in text): the whole tracker block (sent verbatim when set, it
 * outranks the instruction setting), the tracker instructions inside it and the continuation after it, the immersive
 * HTML, dialogue colouring, context instructions and narrator prompts. DES's «Customize Prompts» editor writes the
 * same keys and saves with persistence.js saveSettings.
 */
export const DES_PROMPT_KEYS = [
    'customTrackerPrompt',
    'customTrackerInstructionsPrompt',
    'customTrackerContinuationPrompt',
    'customHtmlPrompt',
    'customDialogueColoringPrompt',
    'customContextInstructionsPrompt',
    'customNarratorPrompt',
] as const;
export type DesPromptKey = (typeof DES_PROMPT_KEYS)[number];

/** promptBuilder.js exports with DES's built-in text of a prompt key (the tracker texts have none exported). */
const DES_PROMPT_DEFAULTS: Partial<Record<DesPromptKey, string>> = {
    customHtmlPrompt: 'DEFAULT_HTML_PROMPT',
    customDialogueColoringPrompt: 'DEFAULT_DIALOGUE_COLORING_PROMPT',
    customContextInstructionsPrompt: 'DEFAULT_CONTEXT_INSTRUCTIONS_PROMPT',
    customNarratorPrompt: 'DEFAULT_NARRATOR_PROMPT',
};

export const DES_KEYS = {
    chatMetadata: 'dooms_tracker',
    swipeData: 'dooms_tracker_swipes',
    updateCompleteEvent: 'dooms_tracker_update_complete',
} as const;

export const DES_SELECTORS = {
    /** DES's drawer toggle in the Extensions panel: present once DES has loaded its settings. */
    drawerToggle: '#rpg-extension-enabled',
    /** While open, the Workshop overwrites aliases, injection, appearance and relationship on save (research §8.10). */
    workshopOpen: '#character-workshop-popup.is-open',
} as const;

export type DesGenerationMode = 'together' | 'separate' | 'external';

/** One per-character field of DES's tracker (trackerConfig.presentCharacters.customFields). */
export interface DesCharacterField {
    id: string;
    name: string;
    enabled: boolean;
    description: string;
}

export function isDesManifest(manifest: ExtensionManifest): boolean {
    return homePageHas(manifest, DES_REPO) || manifest.display_name === DES_DISPLAY_NAME;
}

function hasExports(namespace: ModuleNamespace, required: Record<string, string>): boolean {
    return Object.entries(required).every(
        ([name, type]) => typeof namespace[name] === type && namespace[name] !== null,
    );
}

export class DesAdapter extends NeighbourBase<'des'> {
    readonly id = 'des' as const;
    private modules: Partial<Record<keyof typeof DES_MODULES, ModuleNamespace>> = {};

    constructor(deps: AdapterDeps) {
        super(deps);
        this.capability('des.present', () => this.present());
        this.capability('des.state', () => this.present() && !!this.modules.state);
        this.capability('des.enabled', () => this.present() && this.enabled());
        this.capability('des.together', () => this.present() && this.generationMode() === 'together');
        this.capability('des.lore', () => this.present() && !!this.modules.lorebookApi);
    }

    present(): boolean {
        return this.enabledInSt() && (this.scriptUrl() !== null || hasElement(DES_SELECTORS.drawerToggle));
    }

    /** True when the installed version is one Maestro was checked against. */
    verified(): boolean {
        const version = this.version();
        return version !== undefined && (DES_VERIFIED_VERSIONS as readonly string[]).includes(version);
    }

    protected async connect(): Promise<boolean> {
        await this.locate(isDesManifest, DES_KNOWN_NAMES);
        if (!this.located || !this.enabledInSt()) return true;
        const script = this.scriptUrl();
        if (!script) return false; // ST has not put DES on the page yet: retry on the next ready()
        for (const [key, spec] of Object.entries(DES_MODULES) as [
            keyof typeof DES_MODULES,
            (typeof DES_MODULES)[keyof typeof DES_MODULES],
        ][]) {
            if (this.modules[key]) continue;
            try {
                const namespace = await this.deps.importModule(new URL(spec.path, script).href);
                if (hasExports(namespace, spec.required)) this.modules[key] = namespace;
                else this.log.warn(`${spec.path} lacks ${Object.keys(spec.required).join(', ')}`);
            } catch (error) {
                this.log.warn(`${spec.path} did not load`, error);
            }
        }
        return true;
    }

    /**
     * DES's live settings object (state.js), or the saved blob `extension_settings[<name>]` when state.js is not
     * imported. Read-only for Maestro in stage 0.
     */
    settings(): Dict | null {
        const live = this.modules.state?.extensionSettings;
        if (isDict(live)) return live;
        const saved = this.located ? this.host.ctx().extensionSettings[this.located.name] : undefined;
        return isDict(saved) ? saved : null;
    }

    /** DES's own switch (on unless explicitly false). */
    enabled(): boolean {
        return this.settings()?.enabled !== false;
    }

    generationMode(): DesGenerationMode {
        const mode = this.settings()?.generationMode;
        return mode === 'separate' || mode === 'external' ? mode : 'together';
    }

    /**
     * Parsed tracker of a chat message for its current swipe: `extra.dooms_tracker_swipes[swipe_id]`, falling back
     * to `swipe_info[swipe_id].extra…` like DES does. Null for user messages, out-of-range indexes and messages
     * without tracker data. The result is a fresh object, never shared with DES.
     */
    trackerFor(messageIndex: number): DesTrackerSnapshot | null {
        const message = this.host.ctx().chat[messageIndex];
        const record = desSwipeRecord(message);
        return record ? parseDesTracker(record) : null;
    }

    /**
     * Names in this chat's DES roster (`chat_metadata.dooms_tracker.knownCharacters`; DES forces per-chat roster
     * tracking). Includes absent and hidden characters; see `removedCharacters()`.
     */
    knownCharacters(): string[] {
        const roster = this.chatState()?.knownCharacters;
        return isDict(roster) ? Object.keys(roster) : [];
    }

    /** Names hidden from "Present Characters" in this chat (DES compares them case-insensitively). */
    removedCharacters(): string[] {
        return stringList(this.chatState()?.removedCharacters);
    }

    /** Canonical aliases `{card name: [aliases]}` (global DES setting), as a copy. */
    aliases(): Record<string, string[]> {
        const map = this.settings()?.characterAliases;
        const copy: Record<string, string[]> = {};
        if (!isDict(map)) return copy;
        for (const [canonical, list] of Object.entries(map)) {
            if (Array.isArray(list)) copy[canonical] = list.map(String);
        }
        return copy;
    }

    /**
     * Replaces DES's per-character stats (`trackerConfig.presentCharacters.characterStats.customStats`; DES 2.6
     * state.js:229, asked for in jsonPromptHelpers.js buildCharactersJSONInstruction) with `next` — callers merge,
     * keeping the user's own stats — and, with `options.enable`, sets the feature switch `characterStats.enabled`.
     * Writes DES's live settings object (state.js) and mirrors the stats into the active tracker preset (DES loads a
     * preset's trackerConfig over the live one on character switch, persistence.js autoSwitchPresetForEntity), then
     * persists like DES: its own `saveSettings()` (persistence.js:544), else `extension_settings[name] = live` and
     * `saveSettingsDebounced()`. Fields DES keeps on a stat besides id/name/enabled stay. False when DES or its
     * live state is not available. Callers check `isWorkshopOpen()` first (plan §10.8).
     */
    setCharacterStats(
        next: { id: string; name: string; enabled: boolean }[],
        options: { enable?: boolean } = {},
    ): boolean {
        const live = this.modules.state?.extensionSettings;
        if (!this.present() || !isDict(live)) return false;
        const tracker = isDict(live.trackerConfig) ? live.trackerConfig : (live.trackerConfig = {});
        const present = isDict(tracker.presentCharacters)
            ? tracker.presentCharacters
            : (tracker.presentCharacters = {});
        const previous = isDict(present.characterStats) ? present.characterStats : {};
        const before = Array.isArray(previous.customStats) ? previous.customStats.filter(isDict) : [];
        const customStats = next
            .filter((stat) => stat && typeof stat.name === 'string' && stat.name.trim())
            .map((stat) => {
                const id = String(stat.id ?? '').trim() || stat.name.trim();
                const kept = before.find((item) => item.id === id) ?? {};
                return { ...kept, id, name: stat.name.trim(), enabled: stat.enabled !== false };
            });
        const stats: Dict = {
            ...previous,
            enabled: options.enable ?? previous.enabled === true,
            customStats,
        };
        present.characterStats = stats;
        const manager = isDict(live.presetManager) ? live.presetManager : null;
        const activeId = typeof manager?.activePresetId === 'string' ? manager.activePresetId : null;
        const presets = isDict(manager?.presets) ? manager.presets : null;
        const preset = activeId && presets && isDict(presets[activeId]) ? presets[activeId] : null;
        if (preset && isDict(preset.trackerConfig)) {
            const presetChars = isDict(preset.trackerConfig.presentCharacters)
                ? preset.trackerConfig.presentCharacters
                : (preset.trackerConfig.presentCharacters = {});
            presetChars.characterStats = JSON.parse(JSON.stringify(stats)) as Dict;
        }
        this.persistSettings(live);
        return true;
    }

    /**
     * The per-character fields DES asks the model for (`trackerConfig.presentCharacters.customFields`, DES 2.6
     * state.js:216; DES's default is `appearance` and `demeanor`). The detail key of a field in the tracker JSON is
     * `toSnakeCase(name)` (jsonPromptHelpers.js buildCharactersJSONInstruction), the name itself for Cyrillic names
     * when DES-RU restores them. Copies; null when DES or its live state is not available.
     */
    characterFields(): DesCharacterField[] | null {
        const live = this.modules.state?.extensionSettings;
        if (!this.present() || !isDict(live)) return null;
        const tracker = isDict(live.trackerConfig) ? live.trackerConfig : {};
        const present = isDict(tracker.presentCharacters) ? tracker.presentCharacters : {};
        const fields = Array.isArray(present.customFields) ? present.customFields.filter(isDict) : [];
        return fields.map((field) => ({
            id: typeof field.id === 'string' ? field.id : '',
            name: typeof field.name === 'string' ? field.name : '',
            enabled: field.enabled !== false,
            description: typeof field.description === 'string' ? field.description : '',
        }));
    }

    /**
     * Adds a per-character field to DES's live tracker config (or switches on a field with the same id), mirrors it
     * into the active tracker preset (DES loads a preset's trackerConfig over the live one on character switch,
     * persistence.js loadPreset) and saves like DES. `before` is the field as it was (null: it was added). Null when
     * DES or its live state is not available. Callers check `isWorkshopOpen()` first (plan §10.8).
     */
    addCharacterField(field: {
        id: string;
        name: string;
        description: string;
    }): { before: Record<string, unknown> | null } | null {
        const live = this.modules.state?.extensionSettings;
        if (!this.present() || !isDict(live) || !field.id.trim() || !field.name.trim()) return null;
        const change = (config: Dict): Record<string, unknown> | null => {
            const present = isDict(config.presentCharacters)
                ? config.presentCharacters
                : (config.presentCharacters = {});
            const list = Array.isArray(present.customFields) ? present.customFields : (present.customFields = []);
            const existing = list.find((item): item is Dict => isDict(item) && item.id === field.id);
            if (existing) {
                const before = JSON.parse(JSON.stringify(existing)) as Record<string, unknown>;
                existing.enabled = true;
                return before;
            }
            list.push({
                id: field.id,
                name: field.name,
                enabled: true,
                description: field.description,
                persistInHistory: false,
            });
            return null;
        };
        const tracker = isDict(live.trackerConfig) ? live.trackerConfig : (live.trackerConfig = {});
        const before = change(tracker);
        const preset = this.activePreset(live);
        if (preset && isDict(preset.trackerConfig)) change(preset.trackerConfig);
        this.persistSettings(live);
        return { before };
    }

    /**
     * Takes back `addCharacterField`: the field with this id goes from the live config and the active preset, or gets
     * back its old state when `before` is given. False when DES or its live state is not available.
     */
    removeCharacterField(id: string, before: Record<string, unknown> | null = null): boolean {
        const live = this.modules.state?.extensionSettings;
        if (!this.present() || !isDict(live)) return false;
        const change = (config: unknown) => {
            if (!isDict(config) || !isDict(config.presentCharacters)) return;
            const present = config.presentCharacters;
            if (!Array.isArray(present.customFields)) return;
            const index = present.customFields.findIndex((item) => isDict(item) && item.id === id);
            if (index < 0) return;
            if (before) present.customFields[index] = JSON.parse(JSON.stringify(before)) as Dict;
            else present.customFields.splice(index, 1);
        };
        change(live.trackerConfig);
        const preset = this.activePreset(live);
        if (preset) change(preset.trackerConfig);
        this.persistSettings(live);
        return true;
    }

    /** A DES prompt override as DES holds it now ('' = DES's built-in text); null without DES's live settings. */
    promptOverride(key: DesPromptKey): string | null {
        const live = this.modules.state?.extensionSettings;
        if (!this.present() || !isDict(live)) return null;
        const value = live[key];
        return typeof value === 'string' ? value : '';
    }

    /**
     * DES's built-in text of a prompt key, when DES exports it: the four plain prompts, and for the whole tracker
     * block the block DES generates from its tracker settings (getAssembledTrackerPrompt, `{generatedOnly}`). The
     * tracker instructions and continuation have no exported default (null).
     */
    promptBuiltin(key: DesPromptKey): string | null {
        const builder = this.modules.promptBuilder;
        if (!builder) return null;
        if (key === 'customTrackerPrompt') {
            try {
                const text = (builder.getAssembledTrackerPrompt as (options: { generatedOnly: boolean }) => unknown)({
                    generatedOnly: true,
                });
                return typeof text === 'string' ? text : null;
            } catch (error) {
                this.log.debug('DES tracker prompt could not be assembled', error);
                return null;
            }
        }
        const name = DES_PROMPT_DEFAULTS[key];
        const value = name ? builder[name] : undefined;
        return typeof value === 'string' ? value : null;
    }

    /**
     * Writes a DES prompt override into DES's live settings and saves like DES's prompt editor does ('' = back to
     * DES's built-in text). False when DES or its live state is not available. Callers check `isWorkshopOpen()`
     * first (plan §10.8).
     */
    setPromptOverride(key: DesPromptKey, text: string): boolean {
        const live = this.modules.state?.extensionSettings;
        if (!this.present() || !isDict(live) || !(DES_PROMPT_KEYS as readonly string[]).includes(key)) return false;
        live[key] = text;
        this.persistSettings(live);
        return true;
    }

    private activePreset(live: Dict): Dict | null {
        const manager = isDict(live.presetManager) ? live.presetManager : null;
        const activeId = typeof manager?.activePresetId === 'string' ? manager.activePresetId : null;
        const presets = isDict(manager?.presets) ? manager.presets : null;
        return activeId && presets && isDict(presets[activeId]) ? presets[activeId] : null;
    }

    /** Saves DES's live settings the way DES does (persistence.js saveSettings), with ST's own save as fallback. */
    private persistSettings(live: Dict): void {
        const save = this.modules.persistence?.saveSettings;
        if (typeof save === 'function') {
            try {
                (save as () => void)();
                return;
            } catch (error) {
                this.log.warn('DES saveSettings failed; saving through SillyTavern', error);
            }
        }
        if (!this.located) return;
        const ctx = this.host.ctx();
        ctx.extensionSettings[this.located.name] = live;
        ctx.saveSettingsDebounced();
    }

    /** The Workshop is open: Maestro must not write DES stores until it closes (plan §10.8). */
    isWorkshopOpen(): boolean {
        return hasElement(DES_SELECTORS.workshopOpen);
    }

    /**
     * Drops one book from the Lore Library cache after Maestro saved it (DES ignores WORLDINFO_UPDATED and would
     * otherwise save its stale copy over ours). No-op when the module is not loaded.
     */
    invalidateLoreCache(bookName: string): void {
        const invalidate = this.modules.lorebookApi?.invalidateWICache;
        if (typeof invalidate !== 'function') return;
        try {
            (invalidate as (name: string) => void)(bookName);
        } catch (error) {
            this.log.warn('Lore Library cache reset failed', error);
        }
    }

    private chatState(): Dict | null {
        const state = this.host.ctx().chatMetadata[DES_KEYS.chatMetadata];
        return isDict(state) ? state : null;
    }
}
