// NAI Studio, our image extension (research/qvink-nai-studio.md §B). Card passports can be read straight from
// the card field `data.extensions.nai_studio`; settings are the live `extension_settings.nai_studio`; the runtime
// marker is its generate interceptor `NAIST_ProcessTriggers`. Since 0.10.0 it publishes
// `globalThis.NAI_STUDIO_API` (plan §16, stage 3; NAI src/integration/public-api.ts): passports as the current
// chat sees them (chat-level overrides in `chat_metadata.nai_studio.passports`), writes into the card or the chat,
// outfits and states, the events "passportsSaved" / "imageReady" and scene providers. Writes go through the API
// only (it merges the card field and keeps passport ids, plan §10.12). NAI Studio 0.11.0 adds quality gates to the
// same version 1 (plan §16, stage 6): its automatic drawings for a reply wait for Maestro's verdict on it.
// NAI Studio 0.12.0 adds (plan §16, stage 10; M28/M29): passport providers — the passports of lore entries of
// a scene join its scene images and markers after the card/persona/chat passports —, its passport generator
// for one entry, and backgrounds of places uploaded into ST's backgrounds library (never set by NAI Studio).
//
// Capabilities:
// - `nai.present`      installed, enabled in ST and its interceptor is registered;
// - `nai.api`          NAI Studio's public API version 1 is published (NAI Studio 0.10.0+) while it is present;
// - `nai.qualityGate`  that API takes quality gates (`registerQualityGate`, NAI Studio 0.11.0+);
// - `nai.lorePassports` it takes passport providers (`registerPassportProvider`, NAI Studio 0.12.0+);
// - `nai.passportGen`  it writes a passport from a description (`generatePassport`, NAI Studio 0.12.0+);
// - `nai.backgrounds`  it draws backgrounds of places (`generateBackground`, NAI Studio 0.12.0+).
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
    /** `looks` (NAI Studio 0.12.1): DES tracker wordings known to mean the outfit; NAI Studio draws it for them. */
    outfits: { name: string; tags: string; looks?: string[] }[];
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

/** What `NaiRequestFailedDetail.request` names: a `generatePassport` or a `generateBackground` call. */
export type NaiRequestKind = 'passport' | 'background';

/**
 * NAI Studio 0.12.0+: a `generatePassport` / `generateBackground` call resolved null. `code` is NAI Studio's error
 * code (`free-only-blocked`: free-only mode refused to spend Anlas; `aborted`: the user declined the cost; …),
 * `message` the text the user saw.
 */
export interface NaiRequestFailedDetail {
    request: NaiRequestKind;
    /** The passport's or the place's name. */
    name: string;
    code: string;
    message: string;
}

export interface NaiStudioEvents {
    passportsSaved: NaiPassportsSavedDetail;
    imageReady: NaiImageReadyDetail;
    /** NAI Studio 0.12.0+; subscribing on an older one does nothing (see NaiAdapter.on). */
    requestFailed: NaiRequestFailedDetail;
}

/**
 * A passport provider as NAI Studio 0.12.0 calls it (N:features/scene/passport-providers.ts): the passports of the
 * scene of a message (Maestro: lore entries activated or mentioned there). NAI Studio adds them after the passports
 * of the cards, the persona and the chat (those win by name or alias), waits 3 s at most and skips a provider that
 * throws; a passport without an id gets `<provider id>:<kind>:<name>`.
 */
export interface NaiPassportProvider {
    id: string;
    /** Higher first: its passport wins a name another provider also gives. 0 when absent. */
    priority?: number;
    passports(context: NaiSceneHintContext): Promise<NaiPassport[]> | NaiPassport[];
}

/** Kinds NAI Studio's generator writes a single passport for. */
export type NaiPassportGenKind = 'character' | 'location' | 'object' | 'world';

/** `generatePassport` input (NAI Studio 0.12.0+). */
export interface NaiPassportGenInput {
    name: string;
    kind: NaiPassportGenKind;
    /** The text describing it (a lore entry); macros like {{char}} are substituted by NAI Studio. */
    description: string;
    /** Language of the story (`ru`): the name as it spells it goes to the aliases. */
    language?: string;
}

/** `generateBackground` input (NAI Studio 0.12.0+). */
export interface NaiBackgroundInput {
    locationName: string;
    /** Extra tags (the state of the place). */
    tags?: string;
    /** A location (or world) passport of the chat or of a passport provider. */
    passportId?: string;
    /** As a tracker writes it (`evening`, `19:40`, Russian words too). */
    timeOfDay?: string;
    /** As a tracker writes it (`rain`, Russian words too). */
    weather?: string;
    /** A saved NAI Studio style by name, else style tags. */
    style?: string;
}

/** A background NAI Studio stored in ST's backgrounds library (`maestro-<slug>-<timestamp>.png`). */
export interface NaiBackgroundResult {
    file: string;
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
    /** NAI Studio 0.12.0+ (absent before). Registers a passport provider; returns the unregistration. */
    registerPassportProvider?(provider: NaiPassportProvider): () => void;
    /**
     * NAI Studio 0.12.0+. Its passport generator for one entry through its language backend; nothing is saved. A full
     * passport (new id, the given name) or null (a `requestFailed` event says why). Invalid input rejects.
     */
    generatePassport?(input: NaiPassportGenInput): Promise<NaiPassport | null>;
    /**
     * NAI Studio 0.12.0+. One background without people (16:9, ~1 MP) through its pipeline and Anlas guards, uploaded
     * into ST's backgrounds library (POST /api/backgrounds/upload); never set. The stored file name, or null (a toast
     * and a `requestFailed` event say why; a declined cost confirmation is `aborted`).
     */
    generateBackground?(input: NaiBackgroundInput): Promise<NaiBackgroundResult | null>;
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
 * later within version 1 (`registerQualityGate`, 0.11.0; `registerPassportProvider`, `generatePassport`,
 * `generateBackground`, 0.12.0) are optional: check them before use.
 */
export function readNaiApi(value: unknown): NaiStudioApi | undefined {
    if (typeof value !== 'object' || value === null) return undefined;
    const api = value as Record<string, unknown>;
    if (api.version !== NAI_API_VERSION) return undefined;
    return API_METHODS.every((method) => typeof api[method] === 'function') ? (value as NaiStudioApi) : undefined;
}

/* ---- Release 1.11, wardrobe: DES portrait redraw ---- */

/** NAI Studio 0.14.0's portrait redraw (brief contract), read off the API object without widening NaiStudioApi. */
interface NaiPortraitApi {
    requestDesPortrait(name: string, options?: { reason?: string }): Promise<boolean>;
}

/** The API when it can redraw a DES portrait: the method, and 'requestDesPortrait' in `features` when it lists them. */
function portraitApi(api: NaiStudioApi | undefined): NaiPortraitApi | null {
    if (!api) return null;
    const value = api as unknown as Record<string, unknown>;
    if (typeof value.requestDesPortrait !== 'function') return null;
    const features = value.features;
    if (Array.isArray(features) && !features.includes('requestDesPortrait')) return null;
    return value as unknown as NaiPortraitApi;
}

/* ---- end of the wardrobe block ---- */

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
        ? copy.outfits.filter(isDict).map((outfit) => {
              const looks = stringList(outfit.looks);
              return { name: text(outfit.name), tags: text(outfit.tags), ...(looks.length ? { looks } : {}) };
          })
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
        this.capability(
            'nai.lorePassports',
            () => this.present() && typeof this.api()?.registerPassportProvider === 'function',
        );
        this.capability('nai.passportGen', () => this.present() && typeof this.api()?.generatePassport === 'function');
        this.capability(
            'nai.backgrounds',
            () => this.present() && typeof this.api()?.generateBackground === 'function',
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

    /**
     * Subscribes through the API; without it — or for an event this NAI Studio does not have yet (`requestFailed`
     * before 0.12.0) — nothing is subscribed and the returned unsubscription does nothing.
     */
    on<K extends NaiStudioEvent>(event: K, listener: (detail: NaiStudioEvents[K]) => void): () => void {
        const api = this.api();
        if (!api) return () => {};
        try {
            return api.on(event, listener);
        } catch (error) {
            this.log.warn(`NAI_STUDIO_API.on("${event}") failed`, error);
            return () => {};
        }
    }

    /**
     * Registers a passport provider with NAI Studio (0.12.0+): the passports of lore entries of a scene join its scene
     * images and markers after the card/persona/chat passports (those win by name or alias); a provider with the same
     * id replaces the previous one. Returns the unregistration; without the API member (older NAI Studio, disabled,
     * not loaded) or when NAI Studio refuses it, nothing is registered and the returned function does nothing. NAI
     * Studio drops its registrations when it is disabled: register again when `nai.lorePassports` comes back.
     */
    registerPassportProvider(provider: NaiPassportProvider): () => void {
        const api = this.api();
        if (typeof api?.registerPassportProvider !== 'function') return () => {};
        let off: () => void;
        try {
            const result = api.registerPassportProvider(provider);
            off = typeof result === 'function' ? result : () => {};
        } catch (error) {
            this.log.warn('NAI_STUDIO_API.registerPassportProvider failed', error);
            return () => {};
        }
        return () => {
            try {
                off();
            } catch (error) {
                this.log.warn('passport provider unregistration failed', error);
            }
        };
    }

    /**
     * NAI Studio's passport generator (0.12.0+) for one person, place, item or the world from its text, through the
     * language backend chosen in NAI Studio; nothing is saved. A typed copy of the passport (new id, the given name),
     * or null: without the API member, when generation failed (NAI Studio emits `requestFailed`) or rejected input.
     */
    async generatePassport(input: NaiPassportGenInput): Promise<NaiPassport | null> {
        const api = this.api();
        if (typeof api?.generatePassport !== 'function') return null;
        try {
            return readPassport(await api.generatePassport(input));
        } catch (error) {
            this.log.warn('NAI_STUDIO_API.generatePassport failed', error);
            return null;
        }
    }

    /**
     * One background for a place drawn by NAI Studio (0.12.0+) and uploaded into ST's backgrounds library; NAI Studio
     * never sets it — the caller does. `{ file }` with the stored file name, or null: without the API member, when NAI
     * Studio refused (free-only mode would have to spend Anlas, the user declined the cost; it shows a toast and emits
     * `requestFailed`), when it failed, or for rejected input.
     */
    async generateBackground(input: NaiBackgroundInput): Promise<NaiBackgroundResult | null> {
        const api = this.api();
        if (typeof api?.generateBackground !== 'function') return null;
        try {
            const result: unknown = await api.generateBackground(input);
            const file = isDict(result) && typeof result.file === 'string' ? result.file.trim() : '';
            return file ? { file } : null;
        } catch (error) {
            this.log.warn('NAI_STUDIO_API.generateBackground failed', error);
            return null;
        }
    }

    /* ---- Release 1.11, wardrobe: DES portrait redraw (NAI Studio 0.14.0, feature 'requestDesPortrait') ---- */

    /** NAI Studio's DES portrait redraw is there (feature-detected: the method, and `features` when it is listed). */
    canRequestDesPortrait(): boolean {
        return portraitApi(this.api()) !== null;
    }

    /**
     * Asks NAI Studio (0.14.0+) to queue a redraw of the DES portrait of `name` now (the wardrobe: the outfit changed).
     * True when queued; false without the feature, for an empty name or when NAI Studio refused or failed.
     */
    async requestDesPortrait(name: string, options: { reason?: string } = {}): Promise<boolean> {
        const api = portraitApi(this.api());
        if (!api || !name.trim()) return false;
        try {
            return (await api.requestDesPortrait(name.trim(), options)) === true;
        } catch (error) {
            this.log.warn('NAI_STUDIO_API.requestDesPortrait failed', error);
            return false;
        }
    }

    /* ---- end of the wardrobe block ---- */

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
