// Data layer of the Preset Studio (M34, stage 5): a model over ST's Prompt Manager and Chat Completion presets.
// Rules (research/parity-preset.md §10.2–10.4): ST keeps two copies of a preset (the working copy in settings and the
// file) with no "dirty" flag — every preset switch silently drops unsaved edits, so the store tracks the draft; saves
// always pass an explicit body to /api/presets/save, merge unknown keys from the cached body and update ST's cache
// and <option> list by hand; never PresetManager.savePreset(name) without a body, updatePreset(), renamePreset() or
// event.savePreset(...) for openai. Prompt edits go through Prompt Manager's own methods, then saveServiceSettings +
// render. Exposed as app.modules.api<PresetStore>('presetStore').
import type { Unsubscribe } from '../../shared/contracts';

/** One prompt block of Prompt Manager (`prompts[]` item), unknown fields kept. */
export interface PresetPrompt {
    identifier: string;
    name: string;
    role?: 'system' | 'user' | 'assistant';
    content?: string;
    system_prompt?: boolean;
    marker?: boolean;
    /** 0 = relative (in order), 1 = in-chat at depth. */
    injection_position?: 0 | 1;
    injection_depth?: number;
    injection_order?: number;
    injection_trigger?: string[];
    forbid_overrides?: boolean;
    [field: string]: unknown;
}

/** Order entry of the active character list (`prompt_order[].order[]`). */
export interface PresetOrderItem {
    identifier: string;
    enabled: boolean;
}

/** A Chat Completion preset body as stored in the file (preset keys, not oai_settings keys). */
export type PresetBody = Record<string, unknown> & {
    prompts?: PresetPrompt[];
    prompt_order?: { character_id: number; order: PresetOrderItem[] }[];
};

export interface PresetVersion {
    id: string;
    at: number;
    /** 'user' (studio), 'layer', 'import', 'st' (saved outside Maestro), 'draft' (unsaved edits snapped before a switch), 'migration'. */
    by: string;
    summary: string;
    body: PresetBody;
}

export interface PresetDraftState {
    /** The working copy differs from the saved file. */
    dirty: boolean;
    /** Prompt identifiers and body keys that differ. */
    changedPrompts: string[];
    changedKeys: string[];
}

export interface PresetStore {
    /** Chat Completion preset names in ST's list order. */
    names(): string[];
    current(): string;
    /** The working copy (what generation uses now), as a preset body. */
    working(): PresetBody;
    /** The saved body of a preset (ST's cache, refreshed by the store). */
    saved(name: string): PresetBody | null;
    draft(): PresetDraftState;
    /** The active prompt list (resolved order for the current character list) with the prompt objects. */
    prompts(): { item: PresetOrderItem; prompt: PresetPrompt | null }[];
    /** Prompt edits through Prompt Manager (saveServiceSettings + render); never writes the preset file. */
    updatePrompt(identifier: string, patch: Partial<PresetPrompt>): Promise<void>;
    addPrompt(prompt: Omit<PresetPrompt, 'identifier'> & { identifier?: string }, after?: string): Promise<string>;
    removePrompt(identifier: string): Promise<void>;
    /** PM «Remove» (P-026): the block leaves the active order and stays in the preset. */
    detachPrompt?(identifier: string): Promise<void>;
    setEnabled(identifiers: string[], enabled: boolean): Promise<void>;
    reorder(identifiers: string[]): Promise<void>;
    /** Body keys (temperature, max_tokens, …) of the working copy, by preset key. */
    setKeys(patch: Record<string, unknown>): Promise<void>;
    /** Explicit-body save of the working copy into `name` (default current), cache + list updated, version written. */
    save(name?: string, summary?: string, by?: string): Promise<void>;
    saveAs(name: string): Promise<string>;
    rename(oldName: string, newName: string): Promise<void>;
    remove(name: string): Promise<void>;
    /** Switches the preset through ST (warns about the draft first — the caller decides). */
    select(name: string): Promise<void>;
    importFile(file: File): Promise<string>;
    exportPreset(name: string, options?: { withSensitive?: boolean; withConnection?: boolean }): Promise<void>;
    versions(name: string): Promise<PresetVersion[]>;
    restoreVersion(name: string, versionId: string): Promise<void>;
    onChange(listener: (reason: 'prompts' | 'keys' | 'preset' | 'list') => void): Unsubscribe;
    ready?(): Promise<void>;
    whenIdle?(): Promise<void>;
    checkOutsideSave?(): Promise<void>;
}
