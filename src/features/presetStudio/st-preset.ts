// SillyTavern access of the Preset Studio data layer (M34, stage 5) — every place the store touches ST lives here
// (research/parity-preset.md, ST 1.19 sources):
// - openai.js: the live `oai_settings` (ctx.chatCompletionSettings), `promptManager` (export let, OAI:535),
//   `openai_settings` / `openai_setting_names` (the preset cache, OAI:531-532), `settingsToUpdate` (OAI:305),
//   `getChatCompletionPreset` (OAI:4582), `getPresetApplicationPromise` (OAI:5015);
// - preset-manager.js: `getPresetManager('openai').selectPreset` (PRM:415-424) — only selection; its savePreset,
//   updatePreset and renamePreset write `{}` for openai (P-077) and are never called;
// - the `#settings_preset_openai` select (option value = cache index, text = name, OAI:4320-4336) and the drawer
//   controls ST listens to (`input` handlers, OAI:6776-7355);
// - POST /api/presets/save and /api/presets/delete (src/endpoints/presets.js) through window.fetch, i.e. through
//   Maestro's fetch gate, where the tab guard (M4) holds or vetoes saves of a stale tab;
// - POST /api/files/sanitize-filename (utils.js getSanitizedFilename) for names typed by the user.
// Live bindings: module namespaces are read on every call (ST reassigns `promptManager` and the cache arrays).
import { readKeyTable, sanitizePresetName } from '../../domain/preset-store-keys';
import type { KeyTable } from '../../domain/preset-store-keys';
import { GLOBAL_ORDER_ID, QUICK_EDIT_IDS, findOrderList } from '../../domain/preset-store-prompts';
import type { App, Logger } from '../../shared/contracts';

type Dict = Record<string, unknown>;

export type PresetStoreErrorCode =
    'unavailable' | 'not-found' | 'exists' | 'invalid' | 'busy' | 'cancelled' | 'protected' | 'http';

/** Errors of the store; `code` lets the studio pick a message (`message` is English, for logs). */
export class PresetStoreError extends Error {
    constructor(
        readonly code: PresetStoreErrorCode,
        message: string,
        readonly status?: number,
    ) {
        super(message);
        this.name = 'PresetStoreError';
    }
}

/** The part of ST's PromptManager (PromptManager.js:300-1999) the store calls; all optional for other versions. */
export interface PromptManagerLike {
    serviceSettings?: Dict | null;
    activeCharacter?: { id: number | string } | null;
    getPromptById?(identifier: string): Dict | null;
    getPromptIndexById?(identifier: string): number | null;
    getPromptOrderForCharacter?(character: unknown): Dict[];
    getPromptOrderEntry?(character: unknown, identifier: string): Dict | null;
    addPrompt?(prompt: Dict, identifier: string): void;
    appendPrompt?(prompt: Dict, character: unknown): void;
    detachPrompt?(prompt: Dict, character: unknown): void;
    removePromptOrderForCharacter?(character: unknown): void;
    addPromptOrderForCharacter?(character: unknown, order: unknown[]): void;
    saveServiceSettings?(): unknown;
    render?(afterTryGenerate?: boolean): void;
    updateQuickEdit?(identifier: string, prompt: Dict): unknown;
    tokenHandler?: { getCounts?(): Record<string, unknown> } | null;
}

/** ST's preset cache: bodies by index and name → index (deleted presets leave holes, P-068). */
export interface PresetCache {
    list: unknown[];
    names: Record<string, number>;
}

export type SensitiveChoice = 'remove' | 'keep' | 'cancel';

interface JQueryLike {
    (selector: string): {
        length: number;
        val(value: unknown): unknown;
        prop(name: string, value: unknown): unknown;
        trigger(type: string, data?: unknown): unknown;
    };
}

interface PresetManagerLike {
    selectPreset?(value: string): Promise<void> | void;
}

export const PRESET_SELECT_ID = 'settings_preset_openai';
export const SAVE_URL = '/api/presets/save';
export const DELETE_URL = '/api/presets/delete';
export const SANITIZE_URL = '/api/files/sanitize-filename';
/** PM's saveServiceSettings waits for SETTINGS_UPDATED, which never comes when the settings save fails. */
const SAVE_WAIT_MS = 10_000;
/** Selectors whose `change` ST triggers after applying connection keys (OAI:5067-5073). */
export const CONNECTION_REFRESH_SELECTORS = [
    '#chat_completion_source',
    '#openrouter_providers_chat',
    '#openrouter_quantizations_chat',
    '#nanogpt_provider',
] as const;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jquery(): JQueryLike | null {
    const candidate = (globalThis as { jQuery?: unknown }).jQuery;
    return typeof candidate === 'function' ? (candidate as JQueryLike) : null;
}

function hasDocument(): boolean {
    return typeof document !== 'undefined';
}

/** Resolves after `promise` or after `ms`, whichever comes first; never rejects. */
export function settleWithin(promise: unknown, ms: number): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        Promise.resolve(promise)
            .catch(() => undefined)
            .finally(() => {
                clearTimeout(timer);
                resolve();
            });
    });
}

export class StPreset {
    private openaiNs: Dict | null = null;
    private managerNs: Dict | null = null;
    private loading: Promise<void> | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly t: (key: string, params?: Record<string, string | number>) => string,
    ) {}

    /* ---------------------------------------------------------------- modules */

    /** Imports openai.js and preset-manager.js (guarded by capabilities); retried while they are missing. */
    ensure(): Promise<void> {
        if (this.openaiNs && this.managerNs) return Promise.resolve();
        if (!this.loading) {
            this.loading = this.importModules().finally(() => {
                this.loading = null;
            });
        }
        return this.loading;
    }

    loaded(): boolean {
        return this.openaiNs !== null;
    }

    private async importModules(): Promise<void> {
        const { caps, modules } = this.app.host;
        if (!this.openaiNs && caps.has('st.oai.promptManager')) {
            try {
                this.openaiNs = await modules.openai();
            } catch (error) {
                this.log.warn('openai.js could not be loaded', error);
            }
        }
        if (!this.managerNs && caps.has('st.presetManager')) {
            try {
                this.managerNs = await modules.presetManager();
            } catch (error) {
                this.log.warn('preset-manager.js could not be loaded', error);
            }
        }
    }

    /* ---------------------------------------------------------------- live data */

    /** ST's live `oai_settings` (the working copy of the preset). */
    oai(): Dict | null {
        const live = (this.app.host.ctx() as STContext & { chatCompletionSettings?: unknown }).chatCompletionSettings;
        if (isDict(live)) return live;
        const fromModule = this.openaiNs?.oai_settings;
        return isDict(fromModule) ? fromModule : null;
    }

    promptManager(): PromptManagerLike | null {
        const manager = this.openaiNs?.promptManager;
        return isDict(manager) ? (manager as PromptManagerLike) : null;
    }

    cache(): PresetCache | null {
        const list = this.openaiNs?.openai_settings;
        const names = this.openaiNs?.openai_setting_names;
        if (!Array.isArray(list) || !isDict(names)) return null;
        return { list, names: names as Record<string, number> };
    }

    keyTable(): KeyTable {
        return readKeyTable(this.openaiNs?.settingsToUpdate);
    }

    /** openai.js getChatCompletionPreset (all 103 keys, structuredClone), or null when it is missing. */
    presetOf(settings: Dict): Dict | null {
        const get = this.openaiNs?.getChatCompletionPreset;
        if (typeof get !== 'function') return null;
        try {
            const body: unknown = (get as (settings: Dict) => unknown)(settings);
            return isDict(body) ? body : null;
        } catch (error) {
            this.log.warn('getChatCompletionPreset failed', error);
            return null;
        }
    }

    /** The promise of the preset application in progress (OAI:5002-5017, P-064). */
    applicationPromise(): Promise<void> {
        const get = this.openaiNs?.getPresetApplicationPromise;
        if (typeof get !== 'function') return Promise.resolve();
        try {
            return Promise.resolve((get as () => unknown)()).then(
                () => undefined,
                () => undefined,
            );
        } catch {
            return Promise.resolve();
        }
    }

    /** script.js `is_send_press` (live binding): a generation is running (P-084). */
    async generating(): Promise<boolean> {
        try {
            const script = await this.app.host.modules.script();
            return script.is_send_press === true;
        } catch {
            return false;
        }
    }

    /* ---------------------------------------------------------------- the preset select */

    private select(): HTMLSelectElement | null {
        if (!hasDocument()) return null;
        const element = document.getElementById(PRESET_SELECT_ID);
        return element instanceof HTMLSelectElement ? element : null;
    }

    /** Option texts in list order (PresetManager.getAllPresets reads the same), or null without the select. */
    optionNames(): string[] | null {
        const select = this.select();
        return select ? [...select.options].map((option) => option.text) : null;
    }

    optionValue(name: string): string | null {
        const select = this.select();
        if (!select) return null;
        return [...select.options].find((option) => option.text === name)?.value ?? null;
    }

    addOption(index: number, name: string): void {
        const select = this.select();
        if (!select || [...select.options].some((option) => option.value === String(index))) return;
        const option = document.createElement('option');
        option.value = String(index);
        option.text = name;
        select.append(option);
    }

    removeOption(index: number): void {
        const select = this.select();
        if (!select) return;
        for (const option of [...select.options]) if (option.value === String(index)) option.remove();
    }

    renameOption(index: number, name: string): void {
        const select = this.select();
        if (!select) return;
        for (const option of [...select.options]) if (option.value === String(index)) option.text = name;
    }

    /**
     * Switches the preset the way ST does (P-060, P-198): PresetManager.selectPreset (jQuery `change`, then the
     * application promise), or the same by hand. OAI_PRESET_CHANGED_BEFORE/AFTER and PRESET_CHANGED fire.
     */
    async selectPreset(value: string): Promise<void> {
        const getManager = this.managerNs?.getPresetManager;
        const manager: unknown =
            typeof getManager === 'function' ? (getManager as (id: string) => unknown)('openai') : null;
        if (isDict(manager) && typeof (manager as PresetManagerLike).selectPreset === 'function') {
            await (manager as PresetManagerLike).selectPreset?.(value);
            await this.applicationPromise();
            return;
        }
        const select = this.select();
        if (!select) throw new PresetStoreError('unavailable', 'the preset list is not on the page');
        for (const option of [...select.options]) option.selected = option.value === value;
        select.value = value;
        this.trigger(`#${PRESET_SELECT_ID}`, 'change');
        await this.applicationPromise();
    }

    /* ---------------------------------------------------------------- drawer controls */

    /**
     * Sets a drawer control and fires its `input` handler, as ST does when it applies a preset (OAI:5032-5033):
     * the handler keeps ST's own state (counters, dependent controls) in step. The caller writes oai_settings after.
     */
    setControl(selector: string, value: unknown, checkbox: boolean): void {
        const jq = jquery();
        if (jq) {
            const element = jq(selector);
            if (!element.length) return;
            if (checkbox) element.prop('checked', Boolean(value));
            else element.val(value);
            element.trigger('input');
            return;
        }
        if (!hasDocument()) return;
        const element = document.querySelector(selector);
        if (!element) return;
        if (element instanceof HTMLInputElement && checkbox) {
            element.checked = Boolean(value);
        } else if (element instanceof HTMLSelectElement && element.multiple && Array.isArray(value)) {
            const wanted = value.map(String);
            for (const option of [...element.options]) option.selected = wanted.includes(option.value);
        } else if (
            element instanceof HTMLInputElement ||
            element instanceof HTMLTextAreaElement ||
            element instanceof HTMLSelectElement
        ) {
            element.value = value === null || value === undefined ? '' : String(value);
        }
        element.dispatchEvent(new Event('input', { bubbles: true }));
    }

    /** jQuery `trigger` (reaches ST's jQuery handlers, not native capture listeners), or a native event. */
    trigger(selector: string, type: string): void {
        const jq = jquery();
        if (jq) {
            jq(selector).trigger(type);
            return;
        }
        if (!hasDocument()) return;
        document.querySelector(selector)?.dispatchEvent(new Event(type, { bubbles: true }));
    }

    /* ---------------------------------------------------------------- server */

    private headers(): Record<string, string> {
        return this.app.host.ctx().getRequestHeaders();
    }

    /**
     * Writes a preset file with an explicit body (§10.4 в 3). Goes through window.fetch, so the tab guard sees it;
     * a held save waits, a vetoed one (409) throws. Returns the name the server used (sanitize-filename, P-076).
     */
    async savePresetFile(name: string, preset: Dict): Promise<string> {
        const response = await fetch(SAVE_URL, {
            method: 'POST',
            headers: this.headers(),
            body: JSON.stringify({ apiId: 'openai', name, preset }),
        });
        if (!response.ok) {
            throw new PresetStoreError('http', `preset save failed: HTTP ${response.status}`, response.status);
        }
        let data: unknown = null;
        try {
            data = await response.json();
        } catch {
            // ST always answers { name }; keep the requested name otherwise.
        }
        return isDict(data) && typeof data.name === 'string' && data.name ? data.name : name;
    }

    /** POST /api/presets/delete (404 = there was no file). */
    async deletePresetFile(name: string): Promise<'deleted' | 'missing' | 'failed'> {
        try {
            const response = await fetch(DELETE_URL, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ apiId: 'openai', name }),
            });
            if (response.ok) return 'deleted';
            return response.status === 404 ? 'missing' : 'failed';
        } catch (error) {
            this.log.warn(`preset ${name} could not be deleted`, error);
            return 'failed';
        }
    }

    /** The file name the server will use (ST's rename dialog asks the same endpoint); local rules as a fallback. */
    async sanitizeName(name: string): Promise<string> {
        try {
            const response = await fetch(SANITIZE_URL, {
                method: 'POST',
                headers: this.headers(),
                body: JSON.stringify({ fileName: name }),
            });
            if (response.ok) {
                const data: unknown = await response.json();
                if (isDict(data) && typeof data.fileName === 'string') return data.fileName;
            }
        } catch (error) {
            this.log.debug('sanitize-filename unavailable', error);
        }
        return sanitizePresetName(name);
    }

    /* ---------------------------------------------------------------- dialogs, files, events */

    /** ST's three-way question about proxy/endpoint fields on import (OAI:4785-4803). */
    async chooseSensitive(fields: readonly string[]): Promise<SensitiveChoice> {
        const ctx = this.app.host.ctx() as Partial<STContext>;
        const list = fields.map((field) => `<b>${field}</b>`).join('<br>');
        const body = `<h3>${this.t('m34.store.sensitive.title')}</h3><div>${list}</div>`;
        if (typeof ctx.callGenericPopup === 'function' && ctx.POPUP_TYPE && ctx.POPUP_RESULT) {
            const results = ctx.POPUP_RESULT;
            const result = await ctx.callGenericPopup(body, ctx.POPUP_TYPE.CONFIRM, '', {
                okButton: this.t('m34.store.sensitive.remove'),
                cancelButton: this.t('m34.store.sensitive.keep'),
                customButtons: [
                    { text: this.t('m34.store.sensitive.cancel'), result: results.CANCELLED, appendAtEnd: true },
                ],
            });
            if (result === results.AFFIRMATIVE) return 'remove';
            if (result === results.NEGATIVE) return 'keep';
            return 'cancel';
        }
        const remove = await this.app.ui.confirm(this.t('m34.store.sensitive.title'), fields.join(', '));
        return remove ? 'remove' : 'keep';
    }

    /** utils.js download (Blob + <a download>), or the same by hand. */
    async download(text: string, fileName: string): Promise<void> {
        try {
            const utils = await this.app.host.modules.utils();
            if (typeof utils.download === 'function') {
                (utils.download as (content: string, name: string, type: string) => void)(
                    text,
                    fileName,
                    'application/json',
                );
                return;
            }
        } catch (error) {
            this.log.debug('utils.download unavailable', error);
        }
        if (!hasDocument()) throw new PresetStoreError('unavailable', 'no document to download from');
        const anchor = document.createElement('a');
        anchor.href = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        anchor.download = fileName;
        anchor.click();
        URL.revokeObjectURL(anchor.href);
    }

    emit(event: string, ...args: unknown[]): Promise<void> {
        return this.app.host.events.emit(event, ...args).catch((error: unknown) => {
            this.log.warn(`${event} listeners failed`, error);
        });
    }

    /** Moves the regex extension's "already asked" mark (`AlertRegex_openai_<name>`, RXI:1696-1702). */
    moveRegexAlert(oldName: string, newName: string): void {
        const storage = (this.app.host.ctx() as Partial<STContext>).accountStorage as
            (STContext['accountStorage'] & { removeItem?(key: string): void }) | undefined;
        if (!storage || typeof storage.getItem !== 'function') return;
        const oldKey = `AlertRegex_openai_${oldName}`;
        const value = storage.getItem(oldKey);
        if (!value) return;
        storage.setItem(`AlertRegex_openai_${newName}`, value);
        storage.removeItem?.(oldKey);
    }
}

/* ------------------------------------------------------------------ Prompt Manager model */

/**
 * The prompts and the active order of the working copy, changed through Prompt Manager's own methods when it
 * exists (P-190) — so PM, slash commands and neighbours see the same objects — and directly in `oai_settings`
 * (the same data PM edits, P-004) when it does not (Chat Completion never opened this session).
 */
export class PromptModel {
    constructor(
        private readonly settings: Dict,
        private readonly pm: PromptManagerLike | null,
        private readonly log: Logger,
        private readonly saveSettings: () => void,
    ) {}

    character(): { id: number | string } {
        const active = this.pm?.activeCharacter;
        return active && (typeof active.id === 'number' || typeof active.id === 'string')
            ? active
            : { id: GLOBAL_ORDER_ID };
    }

    list(): Dict[] {
        if (!Array.isArray(this.settings.prompts)) this.settings.prompts = [];
        return this.settings.prompts as Dict[];
    }

    get(identifier: string): Dict | null {
        if (typeof this.pm?.getPromptById === 'function') return this.pm.getPromptById(identifier);
        return this.list().find((prompt) => isDict(prompt) && prompt.identifier === identifier) ?? null;
    }

    /** The live order array of the active list ([] when there is none). */
    order(): Dict[] {
        if (typeof this.pm?.getPromptOrderForCharacter === 'function') {
            return this.pm.getPromptOrderForCharacter(this.character());
        }
        const list = findOrderList(this.settings.prompt_order, this.character().id);
        return list && Array.isArray(list.order) ? (list.order as Dict[]) : [];
    }

    /** Creates the active list when it is missing (PM does it in sanitizeServiceSettings). */
    private ensureOrder(): Dict[] {
        if (findOrderList(this.settings.prompt_order, this.character().id)) return this.order();
        this.setOrder([]);
        return this.order();
    }

    entry(identifier: string): Dict | null {
        return this.order().find((item) => isDict(item) && item.identifier === identifier) ?? null;
    }

    /** PM addPrompt: `{identifier, system_prompt:false, enabled:false, marker:false, ...prompt}` (PM:988-1000). */
    add(prompt: Dict, identifier: string): void {
        if (typeof this.pm?.addPrompt === 'function') {
            this.pm.addPrompt(prompt, identifier);
            return;
        }
        this.list().push({ identifier, system_prompt: false, enabled: false, marker: false, ...prompt });
    }

    /** Puts a stored prompt object back at its old index (undo). */
    restore(prompt: Dict, index: number): void {
        const list = this.list();
        list.splice(Math.min(Math.max(0, index), list.length), 0, prompt);
    }

    remove(identifier: string): number {
        const list = this.list();
        const index = list.findIndex((prompt) => isDict(prompt) && prompt.identifier === identifier);
        if (index >= 0) list.splice(index, 1);
        return index;
    }

    /** Inserts an order entry (PM has only "unshift"; the live array is spliced like PM's own detach does). */
    insert(identifier: string, enabled: boolean, index: number): void {
        const order = this.ensureOrder();
        if (order.some((item) => isDict(item) && item.identifier === identifier)) return;
        order.splice(Math.min(Math.max(0, index), order.length), 0, { identifier, enabled });
    }

    detach(identifier: string): number {
        const order = this.order();
        const index = order.findIndex((item) => isDict(item) && item.identifier === identifier);
        if (index < 0) return -1;
        const prompt = this.get(identifier);
        if (prompt && typeof this.pm?.detachPrompt === 'function') this.pm.detachPrompt(prompt, this.character());
        else order.splice(index, 1);
        return index;
    }

    /** Replaces the active list like PM's drag-and-drop does (remove + add, PM:1929-1930). */
    setOrder(entries: readonly { identifier: string; enabled: boolean }[]): void {
        const order = entries.map((entry) => ({ identifier: entry.identifier, enabled: entry.enabled }));
        const character = this.character();
        if (
            typeof this.pm?.removePromptOrderForCharacter === 'function' &&
            typeof this.pm.addPromptOrderForCharacter === 'function'
        ) {
            this.pm.removePromptOrderForCharacter(character);
            this.pm.addPromptOrderForCharacter(character, order);
            return;
        }
        if (!Array.isArray(this.settings.prompt_order)) this.settings.prompt_order = [];
        const lists = this.settings.prompt_order as Dict[];
        const index = lists.findIndex((list) => isDict(list) && String(list.character_id) === String(character.id));
        if (index >= 0) lists.splice(index, 1);
        lists.push({ character_id: character.id, order });
    }

    /** PM's toggle drops the stale token count of the block (PM:446-448). */
    forgetCount(identifier: string): void {
        try {
            const counts = this.pm?.tokenHandler?.getCounts?.();
            if (counts && typeof counts === 'object') counts[identifier] = null;
        } catch {
            // counts are cosmetic
        }
    }

    /** Main / Auxiliary / Post-History quick-edit fields must follow the block (P-012). */
    quickEdit(identifier: string): void {
        if (!(QUICK_EDIT_IDS as readonly string[]).includes(identifier)) return;
        const prompt = this.get(identifier);
        if (!prompt || typeof this.pm?.updateQuickEdit !== 'function') return;
        try {
            this.pm.updateQuickEdit(identifier, prompt);
        } catch (error) {
            this.log.debug(`quick edit of ${identifier} not updated`, error);
        }
    }

    /** saveServiceSettings (settings.json) + render(false), like PM's own handlers; never writes the preset file. */
    persist(): Promise<void> {
        let pending: unknown;
        if (typeof this.pm?.saveServiceSettings === 'function') {
            try {
                pending = this.pm.saveServiceSettings();
            } catch (error) {
                this.log.warn('saveServiceSettings failed', error);
            }
        } else {
            this.saveSettings();
        }
        try {
            this.pm?.render?.(false);
        } catch (error) {
            this.log.debug('prompt manager render failed', error);
        }
        return settleWithin(pending, SAVE_WAIT_MS);
    }
}
