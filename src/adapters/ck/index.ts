// CarrotKernel 1.0.0 (research/bunnymo-carrotkernel.md §2–§3). Found by its manifest (CK only works from the
// folder `third-party/CarrotKernel`); its runtime marker is the `window.CarrotKernel` object CK creates when its
// module loads. Settings: `extension_settings.CarrotKernel`.
// Never call `initializeSheetGenerator` (it would clobber DES-RU's finder) and never mark BunnyMo core or pack
// books as Character Repos (plan §10.7, research §3.2).
//
// Capabilities:
// - `ck.present` installed, enabled in ST and `window.CarrotKernel` exists;
// - `ck.repos`   at least one lorebook is marked as a Character Repo;
// - `ck.rag`     fullsheet RAG is on and its global API (`CarrotKernelFullsheetRag`) exists.
import { NeighbourBase, extensionSettingsOf, isDict, stringList } from '../base';
import type { AdapterDeps, Dict, ExtensionManifest } from '../base';

export const CK_DISPLAY_NAME = 'CarrotKernel';
export const CK_KNOWN_NAMES = ['third-party/CarrotKernel'];
export const CK_SETTINGS_KEY = 'CarrotKernel';

/** The part of `window.CarrotKernel` Maestro may use later (stage 2+); all members optional. */
export interface CarrotKernelGlobal {
    /** Re-parses the given repos; it clears the whole character map first, so pass every repo. */
    scanSelectedLorebooks?: (names: string[]) => Promise<unknown> | unknown;
    [member: string]: unknown;
}

export function isCkManifest(manifest: ExtensionManifest): boolean {
    return manifest.display_name === CK_DISPLAY_NAME;
}

function globalObject(name: string): Dict | null {
    const value = (globalThis as unknown as Dict)[name];
    return isDict(value) ? value : null;
}

export class CkAdapter extends NeighbourBase<'ck'> {
    readonly id = 'ck' as const;

    constructor(deps: AdapterDeps) {
        super(deps);
        this.capability('ck.present', () => this.present());
        this.capability('ck.repos', () => this.present() && this.repoBooks().length > 0);
        this.capability(
            'ck.rag',
            () => this.present() && this.ragEnabled() && !!globalObject('CarrotKernelFullsheetRag'),
        );
    }

    present(): boolean {
        const disabled = this.located !== null && this.deps.locator.isDisabled(this.located.name);
        return !disabled && this.kernel() !== null;
    }

    protected async connect(): Promise<boolean> {
        await this.locate(isCkManifest, CK_KNOWN_NAMES);
        return true;
    }

    /**
     * `window.CarrotKernel`, read live: CK creates it at the top level of its module, so it exists as soon as ST has
     * loaded CK. Never call sheet-generator setup through it.
     */
    kernel(): CarrotKernelGlobal | null {
        return globalObject('CarrotKernel') as CarrotKernelGlobal | null;
    }

    /** `extension_settings.CarrotKernel` (live object, read-only for Maestro). */
    settings(): Dict | null {
        return extensionSettingsOf(this.host, CK_SETTINGS_KEY);
    }

    /** CK's own master switch (on unless explicitly false). */
    enabled(): boolean {
        return this.settings()?.enabled !== false;
    }

    /** Lorebooks marked as Character Repos (archives CK scans for `<BunnymoTags>`). */
    repoBooks(): string[] {
        return stringList(this.settings()?.characterRepoBooks);
    }

    /** Lorebooks marked as Tag Libraries. */
    tagLibraries(): string[] {
        return stringList(this.settings()?.tagLibraries);
    }

    ragEnabled(): boolean {
        const rag = this.settings()?.rag;
        return isDict(rag) && rag.enabled === true;
    }
}
