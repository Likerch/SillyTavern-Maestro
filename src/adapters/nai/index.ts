// NAI Studio, our image extension (research/qvink-nai-studio.md §B). Card passports can be read straight from
// the card field `data.extensions.nai_studio`; settings are the live `extension_settings.nai_studio`; the runtime
// marker is its generate interceptor `NAIST_ProcessTriggers`. Since 0.10.0 it publishes
// `globalThis.NAI_STUDIO_API` (plan §16, stage 3; NAI src/integration/public-api.ts): passports as the current
// chat sees them (chat-level overrides in `chat_metadata.nai_studio.passports`), writes into the card or the chat,
// outfits and states, the events "passportsSaved" / "imageReady" and scene providers. Writes go through the API
// only (it merges the card field and keeps passport ids, plan §10.12).
//
// Capabilities:
// - `nai.present` installed, enabled in ST and its interceptor is registered;
// - `nai.api`     NAI Studio's public API version 1 is published (NAI Studio 0.10.0+) while it is present.
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

/** The global NAI Studio publishes its API under. */
export const NAI_API_GLOBAL = 'NAI_STUDIO_API';
/** The API version this adapter speaks; within a version NAI Studio only adds members. */
export const NAI_API_VERSION = 1;

/** Which passports `passports()` lists; flags add up, none lists everything of the current chat. */
export interface NaiPassportScope {
    /** One card by its avatar file (`Alice.png`; the extension may be left out). */
    avatar?: string;
    /** The current persona's passport. */
    persona?: boolean;
    /** Passports that exist only in the current chat. */
    chat?: boolean;
}

/** Where a passport lives when its id alone does not say (a new passport, ids shared by legacy cards). */
export interface NaiPassportTarget {
    avatar?: string;
    persona?: boolean;
}

/** `card`: the card (or the persona settings); `chat`: the current chat only, kept over the card. */
export type NaiSaveScope = 'card' | 'chat';

/** What a scene provider says about the scene of a message; each field is optional. */
export interface NaiSceneHint {
    /** Stable place id (a Maestro place): NAI Studio's location continuity binds to `place:<id>`. */
    locationId?: string;
    locationName?: string;
    /** Setting tags, comma-separated (replace the DES tracker's tags). */
    tags?: string;
    /** Names of the characters present (the automatic scene uses them when the text names nobody). */
    characters?: string[];
}

export interface NaiSceneHintContext {
    /** The message the picture is about (a marker's reply, or the last message). */
    messageIndex: number;
    /** Its text as written. */
    text: string;
}

export interface NaiSceneProvider {
    id: string;
    /** Higher answers first; the first answer wins each field on its own. NAI Studio waits 3 s at most. */
    priority: number;
    describe(context: NaiSceneHintContext): Promise<NaiSceneHint | null> | NaiSceneHint | null;
}

export interface NaiPassportsSavedDetail {
    ids: string[];
    scope: NaiSaveScope;
    /** Card avatar of a card save. */
    avatar?: string;
    /** The persona passport was saved. */
    persona?: boolean;
}

export type NaiImageReadyKind = 'message' | 'inline' | 'marker' | 'swipe' | 'tool';

export interface NaiImageReadyDetail {
    messageIndex: number;
    kind: NaiImageReadyKind;
    /** Passports drawn in the picture. */
    passportIds: string[];
}

export interface NaiStudioEvents {
    passportsSaved: NaiPassportsSavedDetail;
    imageReady: NaiImageReadyDetail;
}

export type NaiStudioEvent = keyof NaiStudioEvents;

/** `globalThis.NAI_STUDIO_API`, version 1 (NAI Studio 0.10.0+). Rejections carry `NAI Studio API: …` messages. */
export interface NaiStudioApi {
    readonly version: number;
    /** Passports as the current chat sees them (chat overrides applied), as copies. */
    passports(scope?: NaiPassportScope): NaiPassport[];
    /** One passport of the current chat (its cards, the persona, the chat's own) by id; null when absent. */
    getPassport(id: string): NaiPassport | null;
    /**
     * `card`: replaces the passport with that id in the card (or the persona) or adds it; a new passport in a group
     * needs `target.avatar`. `chat`: over a card or persona passport only the differing fields are kept (none left
     * drops the override); otherwise it becomes a passport of the chat itself. No id: NAI Studio makes one.
     */
    savePassport(passport: NaiPassport, scope: NaiSaveScope, target?: NaiPassportTarget): Promise<void>;
    /** Active outfit by name ('' = the clothing slot); `chat` by default; an unknown outfit rejects. */
    setOutfit(passportId: string, outfit: string, scope?: NaiSaveScope): Promise<void>;
    /** Switches a state (an unknown one is added when switched on); `chat` by default. */
    setState(passportId: string, stateId: string, enabled: boolean, scope?: NaiSaveScope): Promise<void>;
    /** Drops the chat's override (the card value comes back) and a chat-only passport with that id. */
    clearChatOverride(passportId: string): Promise<void>;
    on<K extends NaiStudioEvent>(event: K, listener: (detail: NaiStudioEvents[K]) => void): () => void;
    registerSceneProvider(provider: NaiSceneProvider): () => void;
}

const API_METHODS = [
    'passports',
    'getPassport',
    'savePassport',
    'setOutfit',
    'setState',
    'clearChatOverride',
    'on',
    'registerSceneProvider',
] as const;

/** The published NAI Studio API when it is version 1 with every method; undefined otherwise. */
export function readNaiApi(value: unknown): NaiStudioApi | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const api = value as Record<string, unknown>;
    if (api.version !== NAI_API_VERSION) return undefined;
    return API_METHODS.every((method) => typeof api[method] === 'function') ? (value as NaiStudioApi) : undefined;
}

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
        this.capability('nai.api', () => this.present() && this.api() !== undefined);
    }

    present(): boolean {
        const disabled = this.located !== null && this.deps.locator.isDisabled(this.located.name);
        return !disabled && typeof (globalThis as unknown as Dict)[NAI_INTERCEPTOR] === 'function';
    }

    protected async connect(): Promise<boolean> {
        await this.locate(isNaiManifest, NAI_KNOWN_NAMES);
        return true;
    }

    /** NAI Studio's API (read live); undefined before 0.10.0, while it is disabled or not loaded yet. */
    api(): NaiStudioApi | undefined {
        return readNaiApi((globalThis as Record<string, unknown>)[NAI_API_GLOBAL]);
    }

    /**
     * Passports of the current chat as NAI Studio resolves them (chat overrides applied): its cards, the persona and
     * the chat's own; `scope` narrows like `NaiStudioApi.passports`. Typed copies; [] without the API.
     */
    chatPassports(scope?: NaiPassportScope): NaiPassport[] {
        const api = this.api();
        if (!api) return [];
        try {
            const list = api.passports(scope);
            return Array.isArray(list)
                ? list.map(readPassport).filter((passport): passport is NaiPassport => passport !== null)
                : [];
        } catch (error) {
            this.log.warn('NAI_STUDIO_API.passports failed', error);
            return [];
        }
    }

    /** Subscribes through the API; without it nothing is subscribed and the returned unsubscription does nothing. */
    on<K extends NaiStudioEvent>(event: K, listener: (detail: NaiStudioEvents[K]) => void): () => void {
        const api = this.api();
        if (!api) return () => {};
        return api.on(event, listener);
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
