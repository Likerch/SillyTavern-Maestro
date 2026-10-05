// M29 «Фоны» → SillyTavern 1.19 (public/scripts/backgrounds.js). The CHAT background, never the global one:
// - a chat's own background is `chat_metadata.custom_background` (BG_METADATA_KEY), a CSS value such as
//   `url("backgrounds/<encodeURIComponent(file)>")` for a library file (generateUrlParameter(bg, false));
// - ST shows it by setting `#bg1`'s background-image; on CHAT_CHANGED its onChatChanged() paints
//   `chat_metadata.custom_background || background_settings.url`;
// - locking a chat background (onLockBackgroundClick → saveBackgroundMetadata) is exactly: metadata value, `#bg1`
//   paint, saveMetadataDebounced(). Unlocking (onUnlockBackgroundClick → removeBackgroundMetadata) deletes the key and
//   paints `background_settings.url`. Maestro does the same and nothing more: no `/bg` (it changes
//   background_settings and settings.json), no setBackground(), no saveSettingsDebounced(), no FORCE_SET_BACKGROUND
//   (it also appends to the chat's uploaded-backgrounds list `chat_backgrounds`).
// ST emits no event when the chat background changes, so changes are noticed on `#bg1` (a MutationObserver on its
// style) and on CHAT_CHANGED / FORCE_SET_BACKGROUND by the service.
// The library is read like ST does: POST /api/backgrounds/all ({images: [{filename, isAnimated}]}) and
// /api/backgrounds/folders ({folders: [{id, name}], imageFolderMap: {file: [folderId]}}); thumbnails from
// getThumbnailUrl('bg', file).
import type { LibraryFile } from '../../domain/backgrounds-score';
import { cssUrlPath, libraryFileOf } from '../../domain/backgrounds-state';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';

export const CHAT_BG_KEY = 'custom_background';
export const BG_LAYER_ID = 'bg1';
/** ST module with the live `background_settings` (read only: the global background shown when the chat has none). */
export const BACKGROUNDS_MODULE = 'backgrounds.js';
/** Capability: backgrounds.js loads and exposes `background_settings`. */
export const CAP_ST_BACKGROUNDS = 'st.backgrounds';
export const LIST_URL = '/api/backgrounds/all';
export const FOLDERS_URL = '/api/backgrounds/folders';

type MetadataSaver = { saveMetadataDebounced?: () => void };

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export class ChatBackground {
    /** The global background value last seen on `#bg1` while the chat had none of its own. */
    private lastGlobal: string | null = null;
    /** What this door last painted for a chat background (as the layer reports it back). */
    private painted: string | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /** The chat's own background value; '' while the chat shows the global background. */
    live(): string {
        const value = this.app.host.ctx().chatMetadata?.[CHAT_BG_KEY];
        return typeof value === 'string' ? value : '';
    }

    /** Sets the CHAT background (ST's chat lock path): chat metadata, the `#bg1` layer, a metadata save. */
    set(value: string): void {
        const ctx = this.app.host.ctx();
        ctx.chatMetadata[CHAT_BG_KEY] = value;
        this.paintChat(value);
        this.saveMetadata();
    }

    /** Removes the chat's own background (ST's unlock path): the global background shows again. */
    async clear(): Promise<void> {
        const ctx = this.app.host.ctx();
        delete ctx.chatMetadata[CHAT_BG_KEY];
        this.saveMetadata();
        const global = await this.globalUrl();
        // Something may have set a chat background meanwhile: paint only while the chat still has none.
        if (this.live() === '') this.paint(global ?? '');
    }

    /** The global background value (read only): backgrounds.js `background_settings.url`, else the last one seen. */
    async globalUrl(): Promise<string | null> {
        try {
            const module = await this.app.host.modules.load(BACKGROUNDS_MODULE);
            const settings = module.background_settings;
            if (isDict(settings) && typeof settings.url === 'string' && settings.url) return settings.url;
        } catch (error) {
            this.log.debug('backgrounds.js is not available', error);
        }
        return this.lastGlobal;
    }

    /** Probe of CAP_ST_BACKGROUNDS. */
    async probe(): Promise<boolean> {
        try {
            const module = await this.app.host.modules.load(BACKGROUNDS_MODULE);
            return isDict(module.background_settings);
        } catch {
            return false;
        }
    }

    /** Calls `listener` whenever the background layer is repainted (ST's lock, unlock, select; other extensions). */
    observe(listener: () => void): Unsubscribe {
        const layer = typeof document === 'undefined' ? null : document.getElementById(BG_LAYER_ID);
        if (!layer || typeof MutationObserver !== 'function') return () => {};
        const remember = () => {
            const value = layer.style.backgroundImage;
            // Mutation records arrive later: a chat background just cleared may still be on the layer.
            if (this.live() === '' && value && value !== this.painted) this.lastGlobal = value;
        };
        remember();
        const observer = new MutationObserver(() => {
            remember();
            listener();
        });
        observer.observe(layer, { attributes: true, attributeFilter: ['style'] });
        return () => observer.disconnect();
    }

    /** ST's thumbnail URL of a library file. */
    thumbnail(file: string): string {
        const ctx = this.app.host.ctx();
        if (typeof ctx.getThumbnailUrl === 'function') return ctx.getThumbnailUrl('bg', file);
        return `/thumbnail?type=bg&file=${encodeURIComponent(file)}`;
    }

    /** An image source for a chat background value: the library thumbnail, else the value's own path. */
    preview(value: string): string | null {
        const file = libraryFileOf(value);
        if (file) return this.thumbnail(file);
        const path = cssUrlPath(value);
        return path && !/^\s*javascript:/i.test(path) ? path : null;
    }

    /** The backgrounds library with folder names; null when ST did not answer. */
    async list(): Promise<LibraryFile[] | null> {
        const headers = this.app.host.ctx().getRequestHeaders();
        let images: unknown;
        try {
            const response = await fetch(LIST_URL, { method: 'POST', headers, body: JSON.stringify({}) });
            if (!response.ok) {
                this.log.warn(`background list: HTTP ${response.status}`);
                return null;
            }
            images = ((await response.json()) as Record<string, unknown> | null)?.images;
        } catch (error) {
            this.log.warn('background list failed', error);
            return null;
        }
        if (!Array.isArray(images)) return null;
        const files = images
            .map((image) => (typeof image === 'string' ? image : isDict(image) ? image.filename : undefined))
            .filter((file): file is string => typeof file === 'string' && !!file);
        const folders = await this.folders();
        return files.map((file) => ({ file, folders: folders.get(file) ?? [] }));
    }

    /** File → folder names (ST 1.19 background folders); empty when ST has none or does not answer. */
    private async folders(): Promise<Map<string, string[]>> {
        const out = new Map<string, string[]>();
        try {
            const response = await fetch(FOLDERS_URL, {
                method: 'POST',
                headers: this.app.host.ctx().getRequestHeaders(),
                body: JSON.stringify({}),
            });
            if (!response.ok) return out;
            const data = (await response.json()) as Record<string, unknown> | null;
            const names = new Map<string, string>();
            if (Array.isArray(data?.folders)) {
                for (const folder of data.folders) {
                    if (isDict(folder) && typeof folder.id === 'string' && typeof folder.name === 'string') {
                        names.set(folder.id, folder.name);
                    }
                }
            }
            if (isDict(data?.imageFolderMap)) {
                for (const [file, ids] of Object.entries(data.imageFolderMap)) {
                    if (!Array.isArray(ids)) continue;
                    const list = ids.map((id) => names.get(String(id))).filter((name): name is string => !!name);
                    if (list.length) out.set(file, list);
                }
            }
        } catch (error) {
            this.log.debug('background folders are not available', error);
        }
        return out;
    }

    private paint(value: string): void {
        const layer = typeof document === 'undefined' ? null : document.getElementById(BG_LAYER_ID);
        if (!layer) return;
        if (value) layer.style.setProperty('background-image', value);
        else layer.style.removeProperty('background-image');
    }

    private paintChat(value: string): void {
        this.paint(value);
        const layer = typeof document === 'undefined' ? null : document.getElementById(BG_LAYER_ID);
        this.painted = layer ? layer.style.backgroundImage : value;
    }

    private saveMetadata(): void {
        const ctx = this.app.host.ctx() as STContext & MetadataSaver;
        try {
            // ST's own chat background path uses the debounced save (extensions.js saveMetadataDebounced).
            if (typeof ctx.saveMetadataDebounced === 'function') ctx.saveMetadataDebounced();
            else void ctx.saveMetadata().catch((error: unknown) => this.log.warn('saveMetadata failed', error));
        } catch (error) {
            this.log.warn('chat metadata save failed', error);
        }
    }
}
