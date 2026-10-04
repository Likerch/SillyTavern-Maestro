// SillyTavern World Info access for the Lore Studio (M23). Context functions first (public API), world-info.js for
// what the context lacks (global selection, delete, import, originalData mirror, character bindings), and the
// classic panel's own elements where ST's handlers live, so ST's DOM, `globalSelect`, saves and events stay
// consistent (research/parity-lore.md sweeping rules 1–4, L-020, L-039…L-049, §5).
import { avatarKey } from '../../domain/lore-studio-books';
import type { CharLoreItem } from '../../domain/lore-studio-books';
import { cloneJson, isRecord, stringList } from '../../domain/lore-studio-entries';
import type { LoreBook } from '../../domain/lore-studio-entries';
import { WI_SETTINGS, patchEmits, readWiSettings, settingSpec } from '../../domain/lore-studio-settings';
import type { WiSettingsValues } from '../../domain/lore-studio-settings';
import type { App, Logger } from '../../shared/contracts';

export type Namespace = Record<string, unknown>;
type Fn = (...args: unknown[]) => unknown;

/** Context members of ST 1.19 that global.d.ts does not declare. */
interface CtxExtras {
    menuType?: string;
    writeExtensionField?: (characterId: number | string, key: string, value: unknown) => Promise<void>;
}

function fn(namespace: Namespace | null | undefined, name: string): Fn | null {
    const value = namespace?.[name];
    return typeof value === 'function' ? (value as Fn) : null;
}

function missing(name: string): never {
    throw new Error(`${name} is not available`);
}

/** Thrown for user-facing refusals; `code` maps to `m23.error.<code>`. */
export class LoreStudioError extends Error {
    constructor(
        readonly code: string,
        readonly params: Record<string, string | number> = {},
    ) {
        super(code);
        this.name = 'LoreStudioError';
    }
}

export interface CurrentCharacter {
    id: number;
    name: string;
    avatar: string;
    primary: string | null;
}

export class StLore {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private ctx(): STContext & CtxExtras {
        return this.app.host.ctx() as STContext & CtxExtras;
    }

    async module(): Promise<Namespace | null> {
        try {
            return await this.app.host.modules.worldInfo();
        } catch (error) {
            this.log.warn('world-info.js is not available', error);
            return null;
        }
    }

    private async optional(path: string): Promise<Namespace | null> {
        try {
            return await this.app.host.modules.load(path);
        } catch (error) {
            this.log.debug(`${path} is not available`, error);
            return null;
        }
    }

    /* ---------------------------------------------------------------- books */

    /** Book names as ST lists them (`world_names`, file names without extension). */
    names(): string[] {
        const list = this.ctx().getWorldInfoNames?.();
        return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
    }

    /** A deep copy: `loadWorldInfo` hands out the cache object itself on its first fetch (WI:2052-2056). */
    async load(name: string): Promise<LoreBook | null> {
        const ctx = this.ctx();
        const data =
            typeof ctx.loadWorldInfo === 'function'
                ? await ctx.loadWorldInfo(name)
                : await (fn(await this.module(), 'loadWorldInfo') ?? missing('loadWorldInfo'))(name);
        if (!isRecord(data)) return null;
        const copy = cloneJson(data) as LoreBook;
        if (!isRecord(copy.entries)) copy.entries = {};
        return copy;
    }

    /** Immediate save only (sweeping rule 1): the shared 1 s debounce loses books saved within a second. */
    async save(name: string, data: LoreBook): Promise<void> {
        const ctx = this.ctx();
        if (typeof ctx.saveWorldInfo === 'function') {
            await ctx.saveWorldInfo(name, data, true);
            return;
        }
        const save = fn(await this.module(), 'saveWorldInfo');
        if (!save) throw new Error('saveWorldInfo is not available');
        await save(name, data, true);
    }

    /** The classic editor keeps its own copy of the open book: reload it after our write (L-164). */
    reloadEditor(name: string): void {
        try {
            this.ctx().reloadWorldInfoEditor?.(name);
        } catch (error) {
            this.log.debug('reloadWorldInfoEditor failed', error);
        }
    }

    /** Rebuilds `world_names` and the classic selects after create/delete/rename/import (sweeping rule 4). */
    async updateList(): Promise<void> {
        const ctx = this.ctx();
        if (typeof ctx.updateWorldInfoList === 'function') {
            await ctx.updateWorldInfoList();
            return;
        }
        await fn(await this.module(), 'updateWorldInfoList')?.();
    }

    /** Drops a book from ST's cache (import over an existing book leaves the old copy cached, L-029). */
    async dropCache(name: string): Promise<void> {
        const cache = (await this.module())?.worldInfoCache as { delete?: (key: string) => unknown } | undefined;
        if (cache && typeof cache.delete === 'function') cache.delete(name);
    }

    /** ST's `deleteWorldInfo` (cache, global list, open character and persona links); POST fallback. */
    async deleteBook(name: string): Promise<boolean> {
        const remove = fn(await this.module(), 'deleteWorldInfo');
        if (remove) return (await remove(name)) === true;
        const response = await fetch('/api/worldinfo/delete', {
            method: 'POST',
            headers: this.ctx().getRequestHeaders(),
            body: JSON.stringify({ name }),
        });
        if (!response.ok) return false;
        await this.dropCache(name);
        await this.updateList();
        return true;
    }

    /**
     * ST's own import (all five formats, overwrite question, toasts). Returns the imported book name, or '' when
     * ST did not import (cancelled overwrite or invalid file).
     */
    async importFile(file: File): Promise<string> {
        const importer = fn(await this.module(), 'importWorldInfo');
        if (!importer) throw new LoreStudioError('unavailable');
        const before = new Set(this.names());
        const result = await importer(file);
        if (result === false) return '';
        const after = this.names();
        const stem = file.name.includes('.') ? file.name.slice(0, file.name.lastIndexOf('.')) : file.name;
        const added = after.find((name) => !before.has(name));
        const name = added ?? (after.includes(stem) ? stem : '');
        if (name) await this.dropCache(name);
        return name;
    }

    /** `download` of ST utils (same as the classic Export button), else a temporary link. */
    async download(text: string, fileName: string): Promise<void> {
        const utils = await this.optional('/scripts/utils.js');
        const download = fn(utils, 'download');
        if (download) {
            download(text, fileName, 'application/json');
            return;
        }
        const url = URL.createObjectURL(new Blob([text], { type: 'application/json' }));
        const link = document.createElement('a');
        link.href = url;
        link.download = fileName;
        document.body.appendChild(link);
        link.click();
        link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
    }

    /** Server-side name sanitizing (`/api/files/sanitize-filename`) through ST utils, if available. */
    async sanitize(name: string): Promise<string | null> {
        const sanitize = fn(await this.optional('/scripts/utils.js'), 'getSanitizedFilename');
        if (!sanitize) return null;
        try {
            const result = await sanitize(name);
            return typeof result === 'string' ? result : null;
        } catch (error) {
            this.log.debug('sanitize-filename failed', error);
            return null;
        }
    }

    /** `setWIOriginalDataValue` / `deleteWIOriginalDataValue` / `originalWIDataKeyMap` when exported. */
    async mirrorFunctions(): Promise<{
        set: Fn | null;
        remove: Fn | null;
        keyMap: Record<string, string> | null;
    }> {
        const wi = await this.module();
        const keyMap = wi?.originalWIDataKeyMap;
        return {
            set: fn(wi, 'setWIOriginalDataValue'),
            remove: fn(wi, 'deleteWIOriginalDataValue'),
            keyMap: isRecord(keyMap) ? (keyMap as Record<string, string>) : null,
        };
    }

    /* ---------------------------------------------------------------- global selection */

    /** `selected_world_info` read through the module namespace (a live `export let`, never cached). */
    async globalBooks(): Promise<string[]> {
        return [...stringList((await this.module())?.selected_world_info)];
    }

    /**
     * Sets the global selection through ST's own handler (L-020, L-203): the options of `#world_info` are marked
     * and a `change` event runs ST's `onWorldInfoChange('__notSlashCommand__')`, which rebuilds the selection from
     * the DOM, syncs `globalSelect`, saves and emits WORLDINFO_SETTINGS_UPDATED; select2 repaints on the same
     * event. Without the classic panel: `updateWorldInfoSettings({}, list)` and the event by hand.
     */
    async setGlobalBooks(next: readonly string[]): Promise<void> {
        const wanted = [...new Set(next)];
        const select = document.getElementById('world_info');
        if (select instanceof HTMLSelectElement && this.names().length > 0) {
            const options = () => [...select.options].filter((option) => option.value !== '');
            const missing = wanted.some((name) => !options().some((option) => option.text === name));
            if (missing || options().length !== this.names().length) await this.updateList();
            for (const option of options()) option.selected = wanted.includes(option.text);
            select.dispatchEvent(new Event('change', { bubbles: true }));
            return;
        }
        const wi = await this.module();
        const update = fn(wi, 'updateWorldInfoSettings');
        if (!update) throw new LoreStudioError('unavailable');
        update({}, [...wanted]);
        await this.emitSettingsUpdated();
    }

    private async emitSettingsUpdated(): Promise<void> {
        const name = this.app.host.events.name('WORLDINFO_SETTINGS_UPDATED');
        if (name) await this.app.host.events.emit(name);
    }

    /* ---------------------------------------------------------------- global settings */

    async settings(): Promise<WiSettingsValues> {
        const wi = await this.module();
        const getter = fn(wi, 'getWorldInfoSettings');
        const source = getter ? getter() : wi;
        return readWiSettings(isRecord(source) ? source : null);
    }

    /**
     * Applies a normalized patch through the classic panel's elements and the event ST listens to on each (so the
     * value, its counter, the save and WORLDINFO_SETTINGS_UPDATED all happen as in ST; DES sends the wrong event
     * for four checkboxes — we do not, L-228). Keys without an element go through `updateWorldInfoSettings`.
     */
    async applySettings(patch: WiSettingsValues): Promise<void> {
        const fallback: WiSettingsValues = {};
        for (const spec of WI_SETTINGS) {
            if (!(spec.key in patch)) continue;
            const value = patch[spec.key] as number | boolean;
            const element = document.getElementById(spec.element);
            if (element instanceof HTMLInputElement || element instanceof HTMLSelectElement) {
                if (element instanceof HTMLInputElement && element.type === 'checkbox')
                    element.checked = value === true;
                else element.value = String(Number(value));
                element.dispatchEvent(new Event(spec.event, { bubbles: true }));
            } else {
                fallback[spec.key] = value;
            }
        }
        const keys = Object.keys(fallback).filter((key) => settingSpec(key));
        if (!keys.length) return;
        const update = fn(await this.module(), 'updateWorldInfoSettings');
        if (!update) throw new LoreStudioError('unavailable');
        update({ ...fallback });
        if (patchEmits(fallback)) await this.emitSettingsUpdated();
    }

    /* ---------------------------------------------------------------- character, chat, persona */

    /** The character of a one-on-one chat (group chats have no single character binding). */
    currentCharacter(): CurrentCharacter | null {
        const ctx = this.ctx();
        if (ctx.groupId) return null;
        const id = ctx.characterId === undefined || ctx.characterId === null ? NaN : Number(ctx.characterId);
        const character = Number.isInteger(id) ? ctx.characters?.[id] : undefined;
        if (!character) return null;
        const world = character.data?.extensions?.world;
        return {
            id,
            name: character.name,
            avatar: character.avatar,
            primary: typeof world === 'string' && world ? world : null,
        };
    }

    async charLore(): Promise<CharLoreItem[]> {
        const settings = (await this.module())?.world_info;
        const list = isRecord(settings) && Array.isArray(settings.charLore) ? settings.charLore : [];
        return list
            .filter(isRecord)
            .map((item) => ({ name: String(item.name ?? ''), extraBooks: stringList(item.extraBooks) }));
    }

    /** Additional books of a character through `charSetAuxWorlds` (saves with ST's WI settings wrapper). */
    async setExtraBooks(avatar: string, books: readonly string[]): Promise<void> {
        const wi = await this.module();
        const setter = fn(wi, 'charSetAuxWorlds');
        if (setter) {
            setter(avatarKey(avatar), [...books]);
            return;
        }
        await this.writeCharLore((list) => {
            const key = avatarKey(avatar);
            const index = list.findIndex((item) => item.name === key);
            if (!books.length) {
                if (index >= 0) list.splice(index, 1);
            } else if (index < 0) list.push({ name: key, extraBooks: [...books] });
            else list[index] = { name: key, extraBooks: [...books] };
        });
    }

    /** Edits `world_info.charLore` in place (the live object) and saves settings. */
    async writeCharLore(edit: (list: CharLoreItem[]) => void): Promise<void> {
        const settings = (await this.module())?.world_info;
        if (!isRecord(settings)) throw new LoreStudioError('unavailable');
        const list = Array.isArray(settings.charLore) ? (settings.charLore as CharLoreItem[]) : [];
        edit(list);
        settings.charLore = list;
        this.ctx().saveSettingsDebounced();
    }

    /**
     * Primary book of a character (`data.extensions.world`). The character open in ST's form goes through ST's
     * `charUpdatePrimaryWorld` (the form's hidden field would otherwise overwrite our value on its next save,
     * L-039); any other character through `writeExtensionField` (merge-attributes).
     */
    async setPrimaryBook(characterId: number, name: string | null): Promise<void> {
        const ctx = this.ctx();
        const wi = await this.module();
        const isOpen = Number(ctx.characterId) === characterId && ctx.menuType !== 'create';
        const update = fn(wi, 'charUpdatePrimaryWorld');
        if (isOpen && update && document.getElementById('character_world')) {
            await update(name ?? '');
        } else if (typeof ctx.writeExtensionField === 'function') {
            await ctx.writeExtensionField(characterId, 'world', name ?? '');
            if (isOpen) fn(wi, 'setWorldInfoButtonClass')?.(characterId, !!name);
        } else {
            throw new LoreStudioError('unavailable');
        }
    }

    chatBook(): string | null {
        const value = this.ctx().chatMetadata?.world_info;
        return typeof value === 'string' && value ? value : null;
    }

    /** `chat_metadata.world_info` + saveMetadata + the button highlight (L-047, L-048). */
    async setChatBook(name: string | null): Promise<void> {
        const ctx = this.ctx();
        if (!ctx.getCurrentChatId()) throw new LoreStudioError('noChat');
        if (name) ctx.chatMetadata.world_info = name;
        else delete ctx.chatMetadata.world_info;
        await ctx.saveMetadata();
        for (const button of document.querySelectorAll('.chat_lorebook_button')) {
            button.classList.toggle('world_set', !!name);
        }
    }

    personaBook(): string | null {
        const value = this.ctx().powerUserSettings?.persona_description_lorebook;
        return typeof value === 'string' && value ? value : null;
    }

    /** Persona descriptors: avatar → { name, lorebook }. */
    personas(): Record<string, { name?: string; lorebook?: string | null }> {
        const power = this.ctx().powerUserSettings ?? {};
        const names = isRecord(power.personas) ? power.personas : {};
        const descriptors = isRecord(power.persona_descriptions) ? power.persona_descriptions : {};
        const result: Record<string, { name?: string; lorebook?: string | null }> = {};
        for (const [avatar, descriptor] of Object.entries(descriptors)) {
            if (!isRecord(descriptor)) continue;
            const name = names[avatar];
            result[avatar] = {
                name: typeof name === 'string' ? name : undefined,
                lorebook: typeof descriptor.lorebook === 'string' ? descriptor.lorebook : null,
            };
        }
        return result;
    }

    /** Persona book exactly as ST's persona popup writes it (PERS:1270-1312). */
    async setPersonaBook(name: string | null): Promise<void> {
        const ctx = this.ctx();
        const power = ctx.powerUserSettings;
        const personas = await this.optional('/scripts/personas.js');
        const avatar = typeof personas?.user_avatar === 'string' ? personas.user_avatar : '';
        const names = isRecord(power?.personas) ? power.personas : {};
        if (!power || !avatar || !names[avatar]) throw new LoreStudioError('personaName');
        power.persona_description_lorebook = name ?? '';
        const descriptor = fn(personas, 'getOrCreatePersonaDescriptor')?.();
        if (isRecord(descriptor)) descriptor.lorebook = name ?? '';
        else if (isRecord(power.persona_descriptions) && isRecord(power.persona_descriptions[avatar])) {
            (power.persona_descriptions[avatar] as Record<string, unknown>).lorebook = name ?? '';
        }
        document.getElementById('persona_lore_button')?.classList.toggle('world_set', !!name);
        ctx.saveSettingsDebounced();
        const event = this.app.host.events.name('PERSONA_UPDATED');
        if (event) await this.app.host.events.emit(event, avatar);
    }

    /** Persona links of a renamed book, other personas included (WI:4243-4265). */
    renamePersonaLinks(oldName: string, newName: string): number {
        const power = this.ctx().powerUserSettings;
        if (!power) return 0;
        let changed = 0;
        if (power.persona_description_lorebook === oldName) {
            power.persona_description_lorebook = newName;
            changed++;
        }
        const descriptors = isRecord(power.persona_descriptions) ? power.persona_descriptions : {};
        for (const descriptor of Object.values(descriptors)) {
            if (isRecord(descriptor) && descriptor.lorebook === oldName) {
                descriptor.lorebook = newName;
                changed++;
            }
        }
        if (changed) this.ctx().saveSettingsDebounced();
        return changed;
    }

    /** The card's embedded book (`data.character_book`) of a character, if any. */
    characterBook(characterId: number): Record<string, unknown> | null {
        const character = this.ctx().characters?.[characterId] as unknown as
            { data?: { character_book?: unknown } } | undefined;
        const book = character?.data?.character_book;
        return isRecord(book) ? book : null;
    }

    /** ST's `convertCharacterBook` (context, L-044): card book → World Info data with `originalData`. */
    convertCharacterBook(book: Record<string, unknown>): LoreBook {
        const convert = (this.ctx() as unknown as { convertCharacterBook?: (value: unknown) => unknown })
            .convertCharacterBook;
        if (typeof convert !== 'function') throw new LoreStudioError('unavailable');
        const data = convert(book);
        if (!isRecord(data) || !isRecord(data.entries)) throw new LoreStudioError('unavailable');
        return cloneJson(data) as LoreBook;
    }

    /** Characters and their primary books. */
    characters(): { id: number; name: string; avatar: string; world: string | null }[] {
        return (this.ctx().characters ?? []).map((character, id) => {
            const world = character?.data?.extensions?.world;
            return {
                id,
                name: character?.name ?? '',
                avatar: character?.avatar ?? '',
                world: typeof world === 'string' && world ? world : null,
            };
        });
    }
}
