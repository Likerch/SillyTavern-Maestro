// NAI Studio 0.9.10, our image extension (research/qvink-nai-studio.md §B). No public API yet (plan §16, stage 3):
// passports are read straight from the card field `data.extensions.nai_studio`; settings are the live
// `extension_settings.nai_studio`; the runtime marker is its generate interceptor `NAIST_ProcessTriggers`.
// Writing passports (stage 3+) must merge the field and keep passport ids (plan §10.12).
//
// Capabilities:
// - `nai.present` installed, enabled in ST and its interceptor is registered;
// - `nai.api`     NAI Studio's public API for passports and events; always false until NAI Studio ships it.
import { NeighbourBase, extensionSettingsOf, homePageHas, isDict, stringList } from '../base';
import type { AdapterDeps, Dict, ExtensionManifest } from '../base';

export const NAI_KEY = 'nai_studio';
export const NAI_INTERCEPTOR = 'NAIST_ProcessTriggers';
export const NAI_DISPLAY_NAME = 'NAI Studio';
export const NAI_REPO = 'likerch/st-nai-studio';
export const NAI_KNOWN_NAMES = ['third-party/SillyTavern-NAI-Studio', 'third-party/ST-NAI-Studio'];

export type NaiPassportKind = 'character' | 'world' | 'location' | 'scenario' | 'object';

/** NAI Studio passport (N:domain/passport.ts), the fields Maestro reads; unknown fields are kept in the copy. */
export interface NaiPassport {
    id: string;
    kind: NaiPassportKind;
    /** '' = the card (or persona) itself. */
    name: string;
    aliases: string[];
    tags: string;
    slots: Record<string, string>;
    outfits: { name: string; tags: string }[];
    activeOutfit: string;
    states: { id: string; tags: string; enabled: boolean }[];
    negative: string;
    [field: string]: unknown;
}

const KINDS: readonly NaiPassportKind[] = ['character', 'world', 'location', 'scenario', 'object'];

export function isNaiManifest(manifest: ExtensionManifest): boolean {
    return (
        manifest.display_name === NAI_DISPLAY_NAME ||
        manifest.generate_interceptor === NAI_INTERCEPTOR ||
        homePageHas(manifest, NAI_REPO)
    );
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** A typed deep copy of one stored passport; null for junk. Legacy passports without an id get 'main'. */
export function readPassport(raw: unknown): NaiPassport | null {
    if (!isDict(raw)) return null;
    const copy = structuredClone(raw) as Dict;
    const slots: Record<string, string> = {};
    if (isDict(copy.slots)) {
        for (const [slot, value] of Object.entries(copy.slots)) if (typeof value === 'string') slots[slot] = value;
    }
    const outfits = Array.isArray(copy.outfits)
        ? copy.outfits.filter(isDict).map((outfit) => ({ name: text(outfit.name), tags: text(outfit.tags) }))
        : [];
    const states = Array.isArray(copy.states)
        ? copy.states
              .filter(isDict)
              .map((state) => ({ id: text(state.id), tags: text(state.tags), enabled: state.enabled === true }))
        : [];
    const kind = KINDS.find((candidate) => candidate === copy.kind) ?? 'character';
    return {
        ...copy,
        id: text(copy.id) || 'main',
        kind,
        name: text(copy.name),
        aliases: stringList(copy.aliases),
        tags: text(copy.tags),
        slots,
        outfits,
        activeOutfit: text(copy.activeOutfit),
        states,
        negative: text(copy.negative),
    };
}

export class NaiAdapter extends NeighbourBase<'nai'> {
    readonly id = 'nai' as const;

    constructor(deps: AdapterDeps) {
        super(deps);
        this.capability('nai.present', () => this.present());
        // Flip to a real probe when NAI Studio exposes its API (plan §16, stage 3).
        this.capability('nai.api', () => false);
    }

    present(): boolean {
        const disabled = this.located !== null && this.deps.locator.isDisabled(this.located.name);
        return !disabled && typeof (globalThis as unknown as Dict)[NAI_INTERCEPTOR] === 'function';
    }

    protected async connect(): Promise<boolean> {
        await this.locate(isNaiManifest, NAI_KNOWN_NAMES);
        return true;
    }

    /** `extension_settings.nai_studio` (live object, read-only for Maestro). */
    settings(): Dict | null {
        return extensionSettingsOf(this.host, NAI_KEY);
    }

    /**
     * Passports of a card (`characters[index].data.extensions.nai_studio.passports`, or the legacy single
     * `passport` of cards saved before 0.8), as typed copies: editing them changes nothing.
     */
    passportsOf(characterIndex: number): NaiPassport[] {
        const field = this.host.ctx().characters[characterIndex]?.data?.extensions?.[NAI_KEY];
        if (!isDict(field)) return [];
        const list = Array.isArray(field.passports) ? field.passports : isDict(field.passport) ? [field.passport] : [];
        return list.map(readPassport).filter((passport): passport is NaiPassport => passport !== null);
    }
}
