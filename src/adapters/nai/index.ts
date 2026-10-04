// NAI Studio, our image extension (research/qvink-nai-studio.md §B). Card passports can be read straight from
// the card field `data.extensions.nai_studio`; settings are the live `extension_settings.nai_studio`; the runtime
// marker is its generate interceptor `NAIST_ProcessTriggers`. Since 0.10.0 it publishes
// `globalThis.NAI_STUDIO_API` (plan §16, stage 3; NAI src/integration/public-api.ts): passports as the current
// chat sees them (chat-level overrides in `chat_metadata.nai_studio.passports`), writes into the card or the chat,
// outfits and states, the events "passportsSaved" / "imageReady" and scene providers. Writes go through the API
// only (it merges the card field and keeps passport ids, plan §10.12). NAI Studio 0.11.0 adds quality gates to the
// same version 1 (plan §16, stage 6): its automatic drawings for a reply wait for Maestro's verdict on it.
//
// Capabilities:
// - `nai.present`     installed, enabled in ST and its interceptor is registered;
// - `nai.api`         NAI Studio's public API version 1 is published (NAI Studio 0.10.0+) while it is present;
// - `nai.qualityGate` that API takes quality gates (`registerQualityGate`, NAI Studio 0.11.0+).
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

/** What NAI Studio asks a quality gate about: one assistant reply, the swipe its drawings are for. */
export interface NaiQualityGateDetail {
    messageIndex: number;
    swipeId: number;
}

/**
 * A quality gate as NAI Studio calls it (N:features/quality/quality-gate.ts): false = the reply is being redone,
 * draw nothing for that swipe; true = draw. A gate that throws counts as true.
 */
export type NaiQualityGate = (detail: NaiQualityGateDetail) => Promise<boolean> | boolean;

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
    /**
     * NAI Studio 0.11.0+ (absent in 0.10.0, same version 1). Before NAI Studio draws on its own for an assistant
     * reply — image markers (also those found while it streams), automatic illustrations and generation, DES
     * portraits — it awaits every gate in parallel once the reply is complete, once per reply swipe, at most
     * `quality.gateTimeoutMs` (20 s) from the end of the reply. Any false: nothing is drawn for that swipe (marker
     * placeholders stay for "Try again" or a new swipe); all true or no answer in time: drawn as before. A swipe
     * swiped away or deleted while waiting is not drawn. Manual generation never waits. Returns the unregistration.
     */
    registerQualityGate?(gate: NaiQualityGate): () => void;
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

/**
 * The published NAI Studio API when it is version 1 with every method of 0.10.0; undefined otherwise. Members added
 * later within version 1 (`registerQualityGate`, 0.11.0) are optional: check them before use.
 */
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
    /** The unregistration of the gate set by setQualityGate(), while it is registered. */
    private qualityGateOff: (() => void) | null = null;

    constructor(deps: AdapterDeps) {
        super(deps);
        this.capability('nai.present', () => this.present());
        this.capability('nai.api', () => this.present() && this.api() !== undefined);
        this.capability(
            'nai.qualityGate',
            () => this.present() && typeof this.api()?.registerQualityGate === 'function',
        );
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

    /**
     * Makes `gate` NAI Studio's quality gate for Maestro (NAI Studio 0.11.0+): its automatic drawings for a reply
     * wait for `gate(messageIndex)` — false means the reply is redone and nothing is drawn for its current swipe.
     * One gate at a time: a new one replaces the previous. Returns the unregistration; without the API member (older
     * NAI Studio, disabled, not loaded) nothing is registered and the returned function does nothing. NAI Studio
     * drops its registrations when it is disabled: set the gate again when `nai.qualityGate` comes back.
     */
    setQualityGate(gate: (messageIndex: number) => Promise<boolean>): () => void {
        this.qualityGateOff?.();
        this.qualityGateOff = null;
        const api = this.api();
        if (typeof api?.registerQualityGate !== 'function') return () => {};
        let off: () => void;
        try {
            const result = api.registerQualityGate((detail) => gate(detail.messageIndex));
            off = typeof result === 'function' ? result : () => {};
        } catch (error) {
            this.log.warn('NAI_STUDIO_API.registerQualityGate failed', error);
            return () => {};
        }
        const unregister = () => {
            if (this.qualityGateOff === unregister) this.qualityGateOff = null;
            try {
                off();
            } catch (error) {
                this.log.warn('quality gate unregistration failed', error);
            }
        };
        this.qualityGateOff = unregister;
        return unregister;
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
