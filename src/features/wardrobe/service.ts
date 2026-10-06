// Wardrobe service (plan M27, §2.1, §8 «Наряды и состояния в паспортах уровня чата — Само», P14, P15; plan-2 §4):
// - «что надето сейчас» (release 1.11): every committed turn, for each character of the DES scene, the clothing — the
//   clothing field (Maestro's «Одежда»), else the clothes cut out of the appearance text (wardrobe-wear.ts) — goes
//   into a per-chat record (wardrobe-current.ts) and is reconciled with the passport: a known outfit is put on at
//   once, a new one is made once the same clothing held two turns (a Russian name in a Russian UI), undressing puts on
//   the built-in outfits, a missed turn heals on the next; a character known only from the lore gets a chat copy of
//   its lore passport; without any passport the record stays Maestro's. The persona has the same record (by hand, or
//   the background check in persona.ts). A change Maestro made for a clothing is not fought when the user changes it;
//   a swiped or deleted reply takes its record change back;
// - outfits also from the signals service's 'appearance.changed' (aspect 'outfit', already past the two-turn rule;
//   skipped when the per-turn record has that clothing) and the revision's 'deferred.outfit' statements (parked cards
//   since stage 4 and the direct route intakeOutfit(); cards that never can be taken are dismissed with the reason)
//   are matched against the character's passport outfits (wordings seen before, concepts) → the known outfit is put
//   on, or a new named outfit (English tags from the wording) is added to the chat-level passport and put on;
// - NAI Studio 0.14 redraws the DES portrait of a character whose outfit Maestro changed (setting, once per turn);
// - character states: the committed reply's DES details (wet, wounded, tired, drunk …) switch passport states on; a
//   state Maestro switched on goes off when its wording has been missing for two committed turns;
// - place states: the committed reply's DES scene (and the place registry's lasting state) → the location passport of
//   the current place: a state entry plus its tags (NAI draws a location from its tags); transient ones go off when
//   the scene leaves the place or the wording is gone for two turns;
// - every write goes through NAI Studio's API at chat scope (never the card) via app.autonomy (kinds wardrobe.*,
//   default 'auto') and is journaled with an undo that restores the touched fields; background work only in the
//   leader tab, never on the send path (a settle delay after turn:committed), asleep in group chats;
// - Maestro's memory (the outfit library with the wordings, history, state bookkeeping) is the chat document
//   'wardrobe'; the DES wordings an outfit was created or recognised from also go into the outfit's `looks` in the
//   passport (NAI Studio 0.12.1 draws the outfit, not the tracker look, when the tracker says one of them).
import { adaptersOf } from '../../adapters';
import { readPassport } from '../../adapters/nai';
import type { NaiPassport, NaiPassportTarget, NaiStudioApi } from '../../adapters/nai';
import type { DesTrackerSnapshot } from '../../domain/des-tracker';
import { normalizePassport } from '../../domain/lore-passport';
import { committedIndices } from '../../domain/places-registry';
import { fieldAspect } from '../../domain/signals-diff';
import { observeWear, revertWear, sameWearing } from '../../domain/wardrobe-current';
import type { WearObservation, WearRecord } from '../../domain/wardrobe-current';
import {
    dropOutfit,
    emptyWardrobeDoc,
    findOutfit,
    markUndone,
    normalizeWardrobeDoc,
    noteOutfit,
    pushDropped,
    pushHistory,
    recentHistory,
    KEEP_TAKEN,
} from '../../domain/wardrobe-doc';
import type { DroppedCard, HistoryEntry, HistoryKind, OutfitOrigin, WardrobeDoc } from '../../domain/wardrobe-doc';
import { addedLooks, outfitWithLooks, withLook, withoutLooks } from '../../domain/wardrobe-looks';
import { matchOutfit, outfitScore } from '../../domain/wardrobe-match';
import type { OutfitLike } from '../../domain/wardrobe-match';
import {
    isOwnClothes,
    newOutfitName,
    ownClothesName,
    undressOfOutfit,
    undressOutfitName,
    UNDRESS_TAGS,
} from '../../domain/wardrobe-names';
import { clothingOf, UNDRESS_OUTFITS } from '../../domain/wardrobe-wear';
import type { UndressKind } from '../../domain/wardrobe-wear';
import {
    addTags,
    CHARACTER_STATE_RULES,
    detectStates,
    findPassportState,
    missingTags,
    PLACE_STATE_RULES,
    removeTags,
    stateRule,
    stepTracked,
    timeOfDayState,
} from '../../domain/wardrobe-states';
import type { StateRule, TrackedState } from '../../domain/wardrobe-states';
import { cleanOutfitText, outfitFromStatement, outfitTagList, outfitTags } from '../../domain/wardrobe-tags';
import { normalizeName } from '../../domain/world-names';
import type { App, Decision, JournalChange, Logger, Proposal, Signal, Unsubscribe } from '../../shared/contracts';
import type { LorePassportsApi } from '../lorePassports/api';
import type { Place, PlacesApi } from '../places/api';
import type { DeferredCard, RevisionApi } from '../revision/api';
import type { Entity, EntitySource, WorldModelApi } from '../world/api';
import type { Outfit, OutfitIntake, StateChange, WardrobeApi, Wearing } from './api';
import {
    PERSONA_KEY,
    WARDROBE_DOC,
    WARDROBE_ID,
    WARDROBE_KINDS,
    WARDROBE_UNDO_TARGET,
    WARDROBE_WEAR_KIND,
} from './settings';
import type { WardrobeSettings } from './settings';
import { freshMark } from '../../domain/turn-mark';

export type WardrobeAction = 'outfit.create' | 'outfit.wear' | 'state' | 'place' | 'passport.copy';

/** JSON payload of a wardrobe proposal (Inbox cards outlive the page). */
export interface WardrobePayload {
    m27: 1;
    /** Operation id: history entries and the journal change (`ref.op`) carry it. */
    op: string;
    action: WardrobeAction;
    passportId: string;
    owner: NaiPassportTarget | null;
    /** Character or place name. */
    subject: string;
    messageIndex: number;
    origin: OutfitOrigin;
    /** Outfit name ('' = the clothing slot). */
    name?: string;
    /** Tags of a new outfit or state. */
    tags?: string;
    /** DES wording (or revision statement) the outfit was seen as. */
    wording?: string;
    /** A new outfit is put on as well. */
    activate?: boolean;
    /** State rule id (wet, night …). */
    rule?: string;
    /** Passport state id written. */
    stateId?: string;
    enabled?: boolean;
    placeId?: string;
    /** Place state switched off: the tags Maestro had added. */
    added?: string[];
    /**
     * The tracker wording that goes into the outfit's `looks` ('' none). Absent on cards of 1.10: then a DES wording
     * (`origin` 'des') is the look, as before.
     */
    look?: string;
    /** «Что надето сейчас» record the change is for (its applied outfit is noted). */
    record?: string;
    /** DES name whose portrait NAI Studio redraws when the outfit on actually changes. */
    portrait?: string;
    /** 'passport.copy': the lore passport copied into the chat. */
    copy?: Record<string, unknown>;
}

export function isWardrobePayload(value: unknown): value is WardrobePayload {
    if (typeof value !== 'object' || value === null) return false;
    const payload = value as Partial<WardrobePayload>;
    return payload.m27 === 1 && typeof payload.op === 'string' && typeof payload.passportId === 'string';
}

/** A passport of a character or place with where it lives. */
export interface PassportTarget {
    passportId: string;
    owner: NaiPassportTarget | null;
    /** Character (or place) name as Maestro shows it. */
    name: string;
    passport: NaiPassport;
}

/** A place with its location passport (pult). */
export interface PlaceView {
    place: Place;
    target: PassportTarget | null;
    /** Rule ids Maestro keeps on (not suppressed). */
    states: string[];
}

interface OutfitInput {
    name: string;
    entityId?: string;
    text: string;
    from?: string;
    messageIndex: number;
    origin: OutfitOrigin;
}

/** What the clothing of a record means for the passport. */
type Plan =
    | { kind: 'wear'; name: string }
    | { kind: 'create'; name: string; tags: string; undress?: UndressKind }
    /** Dressing again after undressing, the new outfit not made yet: the own clothes meanwhile. */
    | { kind: 'interim' }
    /** New clothing on its first turn. */
    | { kind: 'wait' }
    /** No garment is known: nothing to put on. */
    | { kind: 'none' };

/** What an outfit statement came to: the outfit name, or null — with the reason when it never can be taken. */
interface Taken {
    name: string | null;
    reason?: DroppedCard['reason'];
}

/** A revision statement about taking clothes off (outfitFromStatement refuses those). */
const REMOVAL_HINT_RE =
    /\b(?:off|removed?|removes|removing|undress\w*|strip\w*|no\s+longer)\b|(?<!\p{L})(?:снял|разде)/iu;

interface ObserveOptions {
    /** A new outfit is made at once (by hand, the persona check), not after two turns. */
    immediate: boolean;
    origin: OutfitOrigin;
    /** DES name whose portrait is redrawn when the outfit on changes ('' none). */
    portrait: string;
    /** By hand: applied and journaled at once, not through autonomy. */
    direct?: boolean;
    persona?: boolean;
}

interface CarryOptions extends ObserveOptions {
    index: number;
}

export interface WardrobeServiceOptions {
    /** Pause between the send (turn:committed) and reading the committed reply: keeps it off the send path. */
    settleMs?: number;
    /** Debounce of the deferred-card intake after a revision run or change. */
    intakeMs?: number;
}

const SETTLE_MS = 500;
const INTAKE_MS = 300;
const PUT_ATTEMPTS = 3;
const NO_WRITE = Symbol('no-write');
/** The previous outfit wording is remembered for the worn outfit only when it fits it at least this much. */
const PREVIOUS_FIT = 0.3;

function newOp(): string {
    return `wrd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The outfit fields of a DES character (outfit, clothing, attire…) as one wording. */
function outfitTextOf(details: Record<string, string>): string {
    return Object.entries(details)
        .filter(([field, value]) => fieldAspect(field) === 'outfit' && value.trim())
        .map(([, value]) => value.trim())
        .join('. ');
}

/** The appearance fields of a DES character (appearance, «Внешность», looks…) as one text. */
function appearanceTextOf(details: Record<string, string>): string {
    return Object.entries(details)
        .filter(([field, value]) => fieldAspect(field) === 'appearance' && value.trim())
        .map(([, value]) => value.trim())
        .join('. ');
}

/**
 * What a DES character wears per its tracker: the outfit field (Maestro's «Одежда» / "Outfit") when there is one,
 * else the clothing cut out of the appearance text. Null when neither says anything about clothes.
 */
export function wearOfDetails(name: string, details: Record<string, string>): WearObservation | null {
    const field = cleanOutfitText(outfitTextOf(details));
    if (field) {
        const undress = clothingOf(field)?.undress?.kind ?? '';
        return { name, wording: field, tags: outfitTags(field), undress, source: 'field' };
    }
    const found = clothingOf(appearanceTextOf(details));
    if (!found?.text) return null;
    return {
        name,
        wording: found.text,
        tags: outfitTags(found.text),
        undress: found.undress?.kind ?? '',
        source: 'appearance',
    };
}

/** At least one tag names something worn (a wording of mood or looks is no outfit). */
function hasGarment(tags: readonly { garment: boolean }[]): boolean {
    return tags.some((item) => item.garment);
}

/** Document key of a character without a passport. */
function nameKey(name: string): string {
    return `name:${normalizeName(name)}`;
}

/** `queued` while a lore passport copy waits in the Inbox (outfits cannot be named so). */
const COPY_PENDING = '#copy';

function sameName(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function taken(decision: Decision): boolean {
    return decision === 'applied' || decision === 'queued' || decision === 'notified';
}

function ownerOf(source: EntitySource): NaiPassportTarget | null {
    if (source.ref.startsWith('persona#')) return { persona: true };
    return source.avatar ? { avatar: source.avatar } : null;
}

/** A state entry of a passport as JSON (journal before/after). */
function stateCopy(state: { id: string; tags: string; enabled: boolean } | null | undefined) {
    return state ? { id: state.id, tags: state.tags, enabled: state.enabled } : null;
}

export class WardrobeService implements Required<WardrobeApi> {
    private doc: WardrobeDoc | null = null;
    private docChat: string | null = null;
    private loading: Promise<WardrobeDoc> | null = null;
    private readonly listeners = new Set<() => void>();
    private queue: Promise<unknown> = Promise.resolve();
    private turnTimer: ReturnType<typeof setTimeout> | null = null;
    private intakeTimer: ReturnType<typeof setTimeout> | null = null;
    private pendingTurn: number | null = null;
    private revision: { api: RevisionApi; off: Unsubscribe[] } | null = null;
    private places: { api: PlacesApi; off: Unsubscribe } | null = null;
    private naiOff: { api: NaiStudioApi; off: () => void } | null = null;
    /** Portraits asked for: `${message}:${passport}` (once per character per turn). */
    private readonly portraitDone = new Set<string>();
    private turnHook: ((index: number) => Promise<void>) | null = null;
    private openHook: (() => void) | null = null;
    /** Bumped on chat change: work of the previous chat stops. */
    private generation = 0;
    private disposed = false;
    private readonly settleMs: number;
    private readonly intakeMs: number;
    private readonly t: App['i18n']['t'];

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => WardrobeSettings,
        options: WardrobeServiceOptions = {},
    ) {
        this.settleMs = options.settleMs ?? SETTLE_MS;
        this.intakeMs = options.intakeMs ?? INTAKE_MS;
        this.t = app.i18n.t.bind(app.i18n);
    }

    /* ---------------------------------------------------------------- lifecycle */

    /** Bus listeners, neighbours' events and Inbox appliers (owned); the journal undo handler stays registered. */
    install(): Unsubscribe[] {
        const { bus, inbox, journal } = this.app;
        // Journal records outlive the module: undo keeps working when it is off.
        journal.registerUndo(WARDROBE_UNDO_TARGET, (change) => this.undo(change));
        const apply = async (payload: unknown) => {
            if (!isWardrobePayload(payload)) throw new Error('bad wardrobe card');
            await this.apply(payload);
        };
        const valid = async (payload: unknown) => isWardrobePayload(payload) && this.valid(payload);
        const kinds = [WARDROBE_KINDS.outfit, WARDROBE_KINDS.state, WARDROBE_KINDS.place];
        const appliers = kinds.map((kind) => inbox.registerApplier(kind, apply, valid));
        this.watchNeighbours();
        void this.open();
        return [
            ...appliers,
            bus.on('signal', (signal) => this.onSignal(signal)),
            bus.on('turn:committed', ({ messageIndex }) => this.onCommitted(messageIndex)),
            bus.on('chat:changed', () => this.onChatChanged()),
            bus.on('leader:changed', ({ leader }) => {
                if (leader) void this.open();
            }),
            bus.on('message:invalidated', ({ messageIndex, reason }) => this.onInvalidated(messageIndex, reason)),
            () => this.dispose(),
        ];
    }

    private dispose(): void {
        this.disposed = true;
        this.generation++;
        if (this.turnTimer !== null) clearTimeout(this.turnTimer);
        if (this.intakeTimer !== null) clearTimeout(this.intakeTimer);
        this.turnTimer = null;
        this.intakeTimer = null;
        for (const off of this.revision?.off ?? []) off();
        this.revision = null;
        this.places?.off();
        this.places = null;
        this.naiOff?.off();
        this.naiOff = null;
        this.turnHook = null;
        this.openHook = null;
        this.listeners.clear();
    }

    /** Background writes: leader tab, a chat open, not a group chat. */
    private writable(): boolean {
        return !this.disposed && !!this.app.host.chatId() && this.app.leader.isLeader() && !this.app.host.isGroupChat();
    }

    private async open(): Promise<void> {
        const generation = this.generation;
        try {
            await this.loadDoc();
        } catch (error) {
            this.log.warn('wardrobe document could not be loaded', error);
            return;
        }
        if (generation !== this.generation || !this.writable()) return;
        this.watchNeighbours();
        try {
            this.openHook?.();
        } catch (error) {
            this.log.debug('wardrobe open hook failed', error);
        }
        await this.enqueue(() => this.takeDeferred(generation));
    }

    private onChatChanged(): void {
        this.generation++;
        if (this.turnTimer !== null) clearTimeout(this.turnTimer);
        this.turnTimer = null;
        this.pendingTurn = null;
        this.doc = null;
        this.docChat = null;
        this.loading = null;
        this.portraitDone.clear();
        this.emitChange();
        void this.open();
    }

    /** UI language of new outfit names. */
    private locale(): 'ru' | 'en' {
        try {
            return this.app.i18n.locale() === 'ru' ? 'ru' : 'en';
        } catch {
            return 'en';
        }
    }

    private lorePassports(): LorePassportsApi | undefined {
        try {
            return this.app.modules.api<LorePassportsApi>('lorePassports');
        } catch {
            return undefined;
        }
    }

    /* ---------------------------------------------------------------- neighbours */

    private world(): WorldModelApi | undefined {
        try {
            return this.app.modules.api<WorldModelApi>('world');
        } catch {
            return undefined;
        }
    }

    private placesApi(): PlacesApi | undefined {
        try {
            return this.app.modules.api<PlacesApi>('places');
        } catch {
            return undefined;
        }
    }

    private revisionApi(): RevisionApi | undefined {
        try {
            return this.app.modules.api<RevisionApi>('revision');
        } catch {
            return undefined;
        }
    }

    /** NAI Studio's API (0.10.0+), read live. */
    naiApi(): NaiStudioApi | undefined {
        try {
            return adaptersOf(this.app).nai.api();
        } catch {
            return undefined;
        }
    }

    /** Subscribes to the revision, the place registry and NAI Studio (again when one was switched off and on). */
    private watchNeighbours(): void {
        if (this.disposed) return;
        const revision = this.revisionApi() ?? null;
        if (revision !== (this.revision?.api ?? null)) {
            for (const off of this.revision?.off ?? []) off();
            this.revision = null;
            if (revision) {
                const off: Unsubscribe[] = [];
                try {
                    off.push(revision.onRun(() => this.scheduleIntake()));
                    if (typeof revision.onChange === 'function')
                        off.push(revision.onChange(() => this.scheduleIntake()));
                } catch (error) {
                    this.log.debug('revision events are not available', error);
                }
                this.revision = { api: revision, off };
            }
        }
        const places = this.placesApi() ?? null;
        if (places !== (this.places?.api ?? null)) {
            this.places?.off();
            this.places = null;
            if (places && typeof places.onEnter === 'function') {
                try {
                    this.places = {
                        api: places,
                        off: places.onEnter((place, previous) => this.onEnter(place, previous)),
                    };
                } catch (error) {
                    this.log.debug('place registry events are not available', error);
                }
            }
        }
        const nai = this.naiApi() ?? null;
        if (nai !== (this.naiOff?.api ?? null)) {
            this.naiOff?.off();
            this.naiOff = null;
            if (nai) {
                try {
                    this.naiOff = { api: nai, off: nai.on('passportsSaved', () => this.emitChange()) };
                } catch (error) {
                    this.log.debug('NAI Studio events are not available', error);
                }
            }
        }
    }

    private chat(): readonly STChatMessage[] {
        try {
            return this.app.host.ctx().chat ?? [];
        } catch {
            return [];
        }
    }

    private lastCommitted(): number {
        const list = committedIndices(this.chat());
        return list[list.length - 1] ?? -1;
    }

    private tracker(index: number): DesTrackerSnapshot | null {
        if (index < 0) return null;
        try {
            return adaptersOf(this.app).des.trackerFor(index);
        } catch (error) {
            this.log.debug('DES tracker is not readable', error);
            return null;
        }
    }

    /* ---------------------------------------------------------------- passports */

    private passportOf(id: string): NaiPassport | null {
        try {
            return readPassport(this.naiApi()?.getPassport(id) ?? null);
        } catch (error) {
            this.log.debug('NAI passport is not readable', error);
            return null;
        }
    }

    /** Passports of the current chat with their owners: the card's, the persona's, the chat's own. */
    chatPassports(): { passport: NaiPassport; owner: NaiPassportTarget | null; name: string }[] {
        if (!this.naiApi()) return [];
        const nai = adaptersOf(this.app).nai;
        const ctx = this.app.host.ctx();
        const out: { passport: NaiPassport; owner: NaiPassportTarget | null; name: string }[] = [];
        const id = ctx.characterId;
        const card = id !== undefined && id !== null && id !== '' ? ctx.characters?.[Number(id)] : undefined;
        if (card?.avatar) {
            for (const passport of nai.chatPassports({ avatar: card.avatar })) {
                out.push({ passport, owner: { avatar: card.avatar }, name: passport.name || card.name });
            }
        }
        for (const passport of nai.chatPassports({ persona: true })) {
            out.push({ passport, owner: { persona: true }, name: passport.name || ctx.name1 });
        }
        for (const passport of nai.chatPassports({ chat: true })) {
            if (passport.name) out.push({ passport, owner: null, name: passport.name });
        }
        return out.filter((item) => item.name);
    }

    private ownerById(passportId: string): NaiPassportTarget | null {
        return this.chatPassports().find((item) => item.passport.id === passportId)?.owner ?? null;
    }

    /** A character's passport: through the world model (aliases, case forms), then by passport names and aliases. */
    resolveCharacter(name: string, entityId?: string): PassportTarget | null {
        if (!this.naiApi()) return null;
        const world = this.world();
        let entity: Entity | undefined;
        try {
            if (entityId) entity = world?.get(entityId);
            if (!entity && name.includes(':')) entity = world?.get(name);
            entity ??= world?.resolve(name, 'character') ?? world?.resolve(name, 'persona');
        } catch (error) {
            this.log.debug('world model resolve failed', error);
        }
        const source = entity?.sources.find((item) => item.kind === 'nai.passport' && item.passportId);
        if (entity && source?.passportId) {
            const passport = this.passportOf(source.passportId);
            if (passport?.kind === 'character') {
                return { passportId: passport.id, owner: ownerOf(source), name: entity.name, passport };
            }
        }
        const keys = new Set([name, ...(entity ? [entity.name, ...entity.aliases] : [])].map(normalizeName));
        keys.delete('');
        for (const item of this.chatPassports()) {
            if (item.passport.kind !== 'character') continue;
            const names = [item.name, item.passport.name, ...item.passport.aliases].map(normalizeName);
            if (names.some((key) => keys.has(key))) {
                return {
                    passportId: item.passport.id,
                    owner: item.owner,
                    name: entity?.name ?? item.name,
                    passport: item.passport,
                };
            }
        }
        return null;
    }

    /** A place's location passport: the one bound to it, else a location passport named like it. */
    resolvePlace(place: Place): PassportTarget | null {
        if (!this.naiApi()) return null;
        if (place.passportId) {
            const passport = this.passportOf(place.passportId);
            if (passport)
                return { passportId: passport.id, owner: this.ownerById(passport.id), name: place.name, passport };
        }
        const keys = new Set([place.name, ...place.aliases, ...place.forms].map(normalizeName));
        keys.delete('');
        for (const item of this.chatPassports()) {
            if (item.passport.kind !== 'location') continue;
            const names = [item.passport.name, ...item.passport.aliases].map(normalizeName);
            if (names.some((key) => keys.has(key))) {
                return { passportId: item.passport.id, owner: item.owner, name: place.name, passport: item.passport };
            }
        }
        return null;
    }

    /* ---------------------------------------------------------------- public API */

    outfits(character?: string): Outfit[] {
        const doc = this.cached() ?? emptyWardrobeDoc();
        const targets: { passportId: string; name: string; passport: NaiPassport | null }[] = [];
        if (character?.trim()) {
            const target = this.resolveCharacter(character.trim());
            if (target) targets.push({ passportId: target.passportId, name: target.name, passport: target.passport });
            else {
                const key = normalizeName(character);
                for (const record of doc.outfits) {
                    if (normalizeName(record.character) !== key) continue;
                    if (!targets.some((item) => item.passportId === record.passportId)) {
                        targets.push({ passportId: record.passportId, name: record.character, passport: null });
                    }
                }
            }
        } else {
            for (const item of this.chatPassports()) {
                if (item.passport.kind === 'character') {
                    targets.push({ passportId: item.passport.id, name: item.name, passport: item.passport });
                }
            }
            for (const record of doc.outfits) {
                if (!targets.some((item) => item.passportId === record.passportId)) {
                    targets.push({ passportId: record.passportId, name: record.character, passport: null });
                }
            }
        }
        const out: Outfit[] = [];
        for (const target of targets) {
            // undefined: no NAI Studio API (the library from memory); null: the passport is gone.
            const passport = target.passport ?? (this.naiApi() ? this.passportOf(target.passportId) : undefined);
            if (passport) {
                for (const outfit of passport.outfits) {
                    // The clothing slot's stand-in is the own clothes, not an outfit of the library.
                    if (!outfit.name || isOwnClothes(outfit.name)) continue;
                    const record = findOutfit(doc, target.passportId, outfit.name);
                    out.push({
                        passportId: target.passportId,
                        character: target.name,
                        name: outfit.name,
                        tags: outfit.tags,
                        seenAs: [...(record?.seenAs ?? [])],
                        firstSeen: record?.firstSeen ?? 0,
                        lastSeen: record?.lastSeen ?? 0,
                        active: sameName(passport.activeOutfit, outfit.name),
                    });
                }
            } else if (passport === undefined) {
                // Without NAI Studio's API: what Maestro remembers.
                for (const record of doc.outfits) {
                    if (record.passportId !== target.passportId || !record.name) continue;
                    out.push({
                        passportId: record.passportId,
                        character: record.character || target.name,
                        name: record.name,
                        tags: record.tags,
                        seenAs: [...record.seenAs],
                        firstSeen: record.firstSeen,
                        lastSeen: record.lastSeen,
                        active: false,
                    });
                }
            }
        }
        return out.sort((a, b) => b.lastSeen - a.lastSeen || b.firstSeen - a.firstSeen);
    }

    changes(limit = 20): StateChange[] {
        const doc = this.cached();
        if (!doc) return [];
        return recentHistory(doc, { kind: 'state', limit }).map((entry) => ({
            kind: entry.kind === 'place' ? 'place' : 'character',
            subject: entry.subject,
            state: entry.state,
            enabled: entry.enabled,
            messageIndex: entry.messageIndex,
            at: entry.at,
        }));
    }

    /** History for the pult, newest first. */
    history(
        filter: { kind?: HistoryKind | 'state'; passportId?: string; placeId?: string; limit?: number } = {},
    ): HistoryEntry[] {
        const doc = this.cached();
        return doc ? recentHistory(doc, filter).map((entry) => ({ ...entry })) : [];
    }

    placeStates(placeId: string): string[] {
        const tracked = this.cached()?.places[placeId] ?? {};
        return Object.entries(tracked)
            .filter(([, entry]) => !entry.suppressed)
            .map(([id]) => id);
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    async wear(passportId: string, outfit: string): Promise<void> {
        if (!this.app.host.chatId()) throw new Error(this.t('m27.error.noChat'));
        const api = this.naiApi();
        if (!api) throw new Error(this.t('m27.error.noNai'));
        const passport = this.passportOf(passportId);
        if (!passport) throw new Error(this.t('m27.error.gone'));
        const asked = String(outfit ?? '').trim();
        // The clothing slot's stand-in is the own clothes.
        const wanted = isOwnClothes(asked) ? '' : asked;
        const found = wanted ? passport.outfits.find((item) => sameName(item.name, wanted)) : undefined;
        if (wanted && !found) throw new Error(this.t('m27.error.noOutfit', { name: wanted }));
        const name = found?.name ?? '';
        const before = passport.activeOutfit;
        // What the character wears now is this outfit: its wording is learnt, so the next turns agree.
        const record = await this.learn(passport.id, name);
        if (sameName(before, name)) {
            this.emitChange();
            return;
        }
        await api.setOutfit(passport.id, name, 'chat');
        if (record && !record.persona) this.redrawPortrait(record.name, passport.id, this.lastCommitted());
        const subject = this.characterName(passport);
        const payload: WardrobePayload = {
            m27: 1,
            op: newOp(),
            action: 'outfit.wear',
            passportId: passport.id,
            owner: null,
            subject,
            name,
            messageIndex: -1,
            origin: 'user',
        };
        await this.record(payload);
        try {
            await this.app.journal.record({
                module: WARDROBE_ID,
                kind: WARDROBE_WEAR_KIND,
                summary: this.t('m27.journal.wear', { name: subject, outfit: name || this.t('m27.clothing') }),
                changes: [this.outfitChange(payload, before, name)],
            });
        } catch (error) {
            this.log.error('outfit put on but not journaled', error);
        }
        this.emitChange();
    }

    /** The revision's direct route: queued behind the wardrobe's own work. */
    intakeOutfit(statement: OutfitIntake): Promise<string | null> {
        return this.enqueue(async () => (await this.intake(statement)).name);
    }

    /** A revision statement taken in: the outfit name, or why it never can be (null reason: maybe later). */
    private async intake(statement: OutfitIntake): Promise<Taken> {
        if (!this.app.host.chatId() || !this.settings().outfits || this.app.host.isGroupChat()) return { name: null };
        if (!statement || typeof statement.value !== 'string') return { name: null, reason: 'noGarment' };
        const clean = cleanOutfitText(statement.value);
        const text = clean ? outfitFromStatement(clean) : null;
        if (!text) return { name: null, reason: clean && REMOVAL_HINT_RE.test(clean) ? 'removal' : 'noGarment' };
        return this.takeOutfit({
            name: typeof statement.entityName === 'string' ? statement.entityName : '',
            text,
            messageIndex: Number.isInteger(statement.sourceMessage) ? statement.sourceMessage : -1,
            origin: 'revision',
        });
    }

    /** The world model knows a person by this name (then the missing part is the passport). */
    private knows(name: string): boolean {
        try {
            const world = this.world();
            return !!(world?.resolve(name, 'character') ?? world?.resolve(name, 'persona'));
        } catch {
            return false;
        }
    }

    /** The character name of a passport as the pult shows it. */
    characterName(passport: NaiPassport): string {
        return (
            this.chatPassports().find((item) => item.passport.id === passport.id)?.name || passport.name || passport.id
        );
    }

    /** The current place with its location passport and the states Maestro keeps on it. */
    currentPlace(): PlaceView | null {
        let place: Place | null = null;
        try {
            place = this.placesApi()?.current() ?? null;
        } catch (error) {
            this.log.debug('places are not readable', error);
        }
        if (!place) return null;
        return { place, target: this.resolvePlace(place), states: this.placeStates(place.id) };
    }

    /** Characters in the committed scene (DES tracker) with passports; all the chat's character passports otherwise. */
    presentCharacters(): { targets: PassportTarget[]; present: boolean } {
        const snapshot = this.tracker(this.lastAssistant());
        const targets: PassportTarget[] = [];
        for (const character of snapshot?.characters ?? []) {
            if (character.offScene) continue;
            const target = this.resolveCharacter(character.name);
            if (target && !targets.some((item) => item.passportId === target.passportId)) targets.push(target);
        }
        if (targets.length) return { targets, present: true };
        for (const item of this.chatPassports()) {
            if (item.passport.kind !== 'character') continue;
            targets.push({ passportId: item.passport.id, owner: item.owner, name: item.name, passport: item.passport });
        }
        return { targets, present: false };
    }

    private lastAssistant(): number {
        const chat = this.chat();
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (message && !message.is_user && !message.is_system) return i;
        }
        return -1;
    }

    /** The journal record of an operation that can still be undone (pult links). */
    journalRecordOf(op: string): string | null {
        try {
            const record = this.app.journal
                .list({ module: WARDROBE_ID })
                .find((item) => !item.undone && item.changes.some((change) => change.ref?.op === op));
            return record?.id ?? null;
        } catch {
            return null;
        }
    }

    /* ---------------------------------------------------------------- outfits */

    private onSignal(signal: Signal): void {
        if (signal.kind !== 'appearance.changed' || !this.settings().outfits) return;
        if (signal.chatId !== this.app.host.chatId() || !this.writable()) return;
        const data = isDict(signal.data) ? signal.data : {};
        const changes = (Array.isArray(data.changes) ? data.changes : []).filter(
            (change): change is Record<string, unknown> =>
                isDict(change) && change.aspect === 'outfit' && typeof change.to === 'string',
        );
        if (!changes.length) return;
        const name = typeof data.name === 'string' && data.name ? data.name : (signal.entity ?? '');
        const input: OutfitInput = {
            name,
            text: changes.map((change) => String(change.to)).join('. '),
            messageIndex: typeof signal.messageIndex === 'number' ? signal.messageIndex : -1,
            origin: 'des',
        };
        if (signal.entity) input.entityId = signal.entity;
        if (typeof changes[0]?.from === 'string') input.from = changes[0].from;
        const generation = this.generation;
        void this.enqueue(async () => {
            if (generation !== this.generation || (await this.recordCovers(input))) return;
            await this.takeOutfit(input);
        }).catch((error: unknown) => this.log.warn('wardrobe outfit failed', error));
    }

    /** The committed turns already follow this clothing (the per-turn record has it): the signal adds nothing. */
    private async recordCovers(input: OutfitInput): Promise<boolean> {
        const target = this.resolveCharacter(input.name, input.entityId);
        if (!target) return false;
        const record = (await this.loadDoc()).current[target.passportId];
        const wording = cleanOutfitText(input.text);
        return !!record && !!wording && sameWearing(record, { wording, undress: record.undress });
    }

    /** Outfits of a passport to match against: named ones (most recently seen first), then the clothing slot. */
    private candidates(target: PassportTarget, doc: WardrobeDoc): OutfitLike[] {
        // Undressing and the own clothes' stand-in are not matched by words (undressing has its own lexicon).
        const named = target.passport.outfits
            .filter((outfit) => outfit.name && !undressOfOutfit(outfit.name) && !isOwnClothes(outfit.name))
            .map((outfit) => {
                const record = findOutfit(doc, target.passportId, outfit.name);
                return {
                    name: outfit.name,
                    tags: outfit.tags,
                    seenAs: record?.seenAs ?? [],
                    at: record?.lastSeen ?? 0,
                };
            })
            .sort((a, b) => b.at - a.at);
        const clothing = findOutfit(doc, target.passportId, '');
        return [...named, { name: '', tags: target.passport.slots.clothing ?? '', seenAs: clothing?.seenAs ?? [] }];
    }

    /**
     * One outfit wording for a character: recognised and put on, or created; the outfit name, null when not taken (with
     * the reason when it never can be).
     */
    private async takeOutfit(input: OutfitInput): Promise<Taken> {
        const wording = cleanOutfitText(input.text);
        if (!wording) return { name: null, reason: 'noGarment' };
        const target = this.resolveCharacter(input.name, input.entityId);
        if (!target) {
            this.log.debug(`wardrobe: no NAI passport for «${input.name}»`);
            return { name: null, reason: this.knows(input.name) ? 'noPassport' : 'unknown' };
        }
        // A DES wording (the outfit field) is a look of the outfit; a revision statement is Maestro's sentence.
        const look = input.origin === 'des' ? wording : '';
        const { passport, passportId } = target;
        if (input.from && input.origin === 'des') await this.rememberPrevious(target, input.from);
        const doc = await this.loadDoc();
        const newest = doc.lastOutfit[passportId] ?? -1;
        const stale = input.messageIndex >= 0 && input.messageIndex < newest;
        const match = matchOutfit(wording, this.candidates(target, doc));
        if (match) {
            if (sameName(match.name, passport.activeOutfit) || stale) {
                await this.mutate((fresh) => {
                    noteOutfit(fresh, {
                        passportId,
                        character: target.name,
                        name: match.name,
                        wording,
                        messageIndex: input.messageIndex,
                        origin: input.origin,
                        at: Date.now(),
                    });
                    if (!stale && input.messageIndex >= 0) {
                        fresh.lastOutfit[passportId] = Math.max(fresh.lastOutfit[passportId] ?? -1, input.messageIndex);
                    }
                    return true;
                });
                if (look && match.name) await this.rememberLook(target, match.name, look);
                this.emitChange();
                return { name: match.name };
            }
            const payload = this.payload('outfit.wear', target, input, { name: match.name, wording, look });
            const text = this.wearText(target, { wording } as WearRecord, match.name);
            const decision = await this.propose(WARDROBE_KINDS.outfit, payload, text.title, text.body, [
                this.outfitChange(
                    payload,
                    passport.activeOutfit,
                    match.name,
                    undefined,
                    this.wearLooks(passport, match.name, look),
                ),
            ]);
            return { name: taken(decision) ? match.name : null };
        }
        const tags = outfitTagList(wording);
        if (!hasGarment(tags)) {
            this.log.debug(`wardrobe: no garment recognised in «${wording}»`);
            return { name: null, reason: 'noGarment' };
        }
        const name = newOutfitName(
            this.locale(),
            tags,
            wording,
            passport.outfits.map((outfit) => outfit.name),
        );
        const tagText = tags.map((item) => item.tag).join(', ');
        const payload = this.payload('outfit.create', target, input, {
            name,
            tags: tagText,
            wording,
            look,
            activate: !stale,
        });
        const text = this.createText(target, { wording } as WearRecord, { name, tags: tagText });
        const decision = await this.propose(WARDROBE_KINDS.outfit, payload, text.title, text.body, [
            this.outfitChange(payload, passport.activeOutfit, stale ? passport.activeOutfit : name, tagText),
        ]);
        return { name: taken(decision) ? name : null };
    }

    /**
     * The first outfit change of a chat tells what was worn before: that wording is remembered for the outfit that was
     * on (or the clothing slot), so the old clothes are recognised when they come back.
     */
    private async rememberPrevious(target: PassportTarget, from: string): Promise<void> {
        const wording = cleanOutfitText(from);
        if (!wording) return;
        const active = target.passport.activeOutfit;
        const doc = await this.loadDoc();
        const record = findOutfit(doc, target.passportId, active);
        if (record?.seenAs.length) return;
        const tags = active
            ? (target.passport.outfits.find((outfit) => sameName(outfit.name, active))?.tags ?? '')
            : (target.passport.slots.clothing ?? '');
        if (tags.trim() && outfitScore(wording, { name: active, tags }).score < PREVIOUS_FIT) return;
        await this.mutate((fresh) => {
            const existing = findOutfit(fresh, target.passportId, active);
            if (existing?.seenAs.length) return NO_WRITE;
            noteOutfit(fresh, {
                passportId: target.passportId,
                character: target.name,
                name: active,
                wording,
                messageIndex: -1,
                origin: 'des',
                at: existing?.lastSeen ?? 0,
            });
            return true;
        });
    }

    /** The autonomy level of outfits lets changes through by themselves (the wording of a worn outfit is one). */
    private looksAllowed(): boolean {
        try {
            const level = this.app.autonomy.level(WARDROBE_KINDS.outfit, 'auto');
            return level === 'auto' || level === 'notify';
        } catch {
            return false;
        }
    }

    /**
     * A DES wording of an outfit that is on already (or of older news): added to the outfit's `looks` in the chat-level
     * passport with one save, so NAI Studio draws the outfit for it. Nothing when it is known there already.
     */
    private async rememberLook(target: PassportTarget, name: string, wording: string): Promise<void> {
        const api = this.naiApi();
        if (!api || !this.looksAllowed()) return;
        const passport = this.passportOf(target.passportId);
        const outfit = passport?.outfits.find((item) => sameName(item.name, name));
        const looks = outfit ? withLook(outfit.looks, wording) : null;
        if (!passport || !outfit || !looks) return;
        try {
            await api.savePassport(
                {
                    ...passport,
                    outfits: passport.outfits.map((item) => (item === outfit ? outfitWithLooks(item, looks) : item)),
                },
                'chat',
                target.owner ?? undefined,
            );
        } catch (error) {
            this.log.warn('outfit wording was not saved in the passport', error);
        }
    }

    private outfitChange(
        payload: WardrobePayload,
        before: string,
        after: string,
        tags?: string,
        looks?: { before: readonly string[]; after: readonly string[] },
    ): JournalChange {
        const ref: Record<string, unknown> = {
            op: payload.op,
            action: payload.action,
            passportId: payload.passportId,
            owner: payload.owner,
            name: payload.name ?? '',
            subject: payload.subject,
        };
        const beforeValue: Record<string, unknown> = { activeOutfit: before };
        const afterValue: Record<string, unknown> = { activeOutfit: after };
        if (payload.action === 'outfit.create') afterValue.outfit = { name: payload.name ?? '', tags: tags ?? '' };
        if (looks) {
            // The worn outfit's DES wordings: undo takes back the ones this change added.
            beforeValue.looks = [...looks.before];
            afterValue.looks = [...looks.after];
        }
        return { target: WARDROBE_UNDO_TARGET, ref, before: beforeValue, after: afterValue };
    }

    private payload(
        action: WardrobeAction,
        target: PassportTarget,
        input: { messageIndex: number; origin: OutfitOrigin },
        extra: Partial<WardrobePayload>,
    ): WardrobePayload {
        return {
            m27: 1,
            op: newOp(),
            action,
            passportId: target.passportId,
            owner: target.owner,
            subject: target.name,
            messageIndex: input.messageIndex,
            origin: input.origin,
            ...extra,
        };
    }

    private async propose(
        kind: string,
        payload: WardrobePayload,
        title: string,
        description: string,
        changes: JournalChange[],
    ): Promise<Decision> {
        const proposal: Proposal<WardrobePayload> = {
            module: WARDROBE_ID,
            kind,
            title,
            description,
            changes,
            payload,
            apply: (value) => this.apply(isWardrobePayload(value) ? value : payload),
            stillValid: async () => this.valid(payload),
        };
        if (payload.messageIndex >= 0) proposal.sourceMessage = payload.messageIndex;
        try {
            return await this.app.autonomy.decide(proposal, 'auto');
        } catch (error) {
            this.log.warn(`${kind}: decision failed`, error);
            return 'skipped';
        }
    }

    private valid(payload: WardrobePayload): boolean {
        if (!this.app.host.chatId() || !this.naiApi()) return false;
        // A lore passport is copied only while the chat has none with that id.
        if (payload.action === 'passport.copy') return this.passportOf(payload.passportId) === null;
        return this.passportOf(payload.passportId) !== null;
    }

    /* ---------------------------------------------------------------- applying */

    /** Writes a proposal into the passport (chat scope) and remembers it. */
    async apply(payload: WardrobePayload): Promise<void> {
        const api = this.naiApi();
        if (!api) throw new Error(this.t('m27.error.noNai'));
        if (payload.action === 'passport.copy') {
            const copy = readPassport(payload.copy);
            if (!copy) throw new Error(this.t('m27.error.gone'));
            // A passport of the chat itself (no card, no persona): NAI Studio keeps it in this chat only.
            await api.savePassport({ ...copy, id: payload.passportId }, 'chat');
            await this.record(payload);
            this.emitChange();
            return;
        }
        const passport = this.passportOf(payload.passportId);
        if (!passport) throw new Error(this.t('m27.error.gone'));
        const owner = payload.owner ?? undefined;
        const name = payload.name ?? '';
        // The tracker wording goes into the outfit's `looks` (a revision statement is Maestro's sentence, not DES's).
        // Cards of 1.10 have no `look`: their DES wording was the outfit field's.
        const look =
            payload.look !== undefined
                ? payload.look
                : payload.origin === 'des' && payload.wording
                  ? payload.wording
                  : '';
        const before = passport.activeOutfit;
        const withLooks = (outfit: NaiPassport['outfits'][number], looks: readonly string[]) =>
            passport.outfits.map((item) => (item === outfit ? outfitWithLooks(item, looks) : item));
        switch (payload.action) {
            case 'outfit.create': {
                const existing = passport.outfits.find((outfit) => sameName(outfit.name, name));
                const looks = look ? withLook(existing?.looks, look) : null;
                if (!existing) {
                    const created: NaiPassport['outfits'][number] = { name, tags: payload.tags ?? '' };
                    const edited: NaiPassport = {
                        ...passport,
                        outfits: [...passport.outfits, outfitWithLooks(created, looks ?? [])],
                    };
                    if (payload.activate) edited.activeOutfit = name;
                    await api.savePassport(edited, 'chat', owner);
                } else if (looks) {
                    const edited: NaiPassport = { ...passport, outfits: withLooks(existing, looks) };
                    if (payload.activate) edited.activeOutfit = existing.name;
                    await api.savePassport(edited, 'chat', owner);
                } else if (payload.activate && !sameName(passport.activeOutfit, existing.name)) {
                    await api.setOutfit(passport.id, existing.name, 'chat');
                }
                break;
            }
            case 'outfit.wear': {
                const outfit = name ? passport.outfits.find((item) => sameName(item.name, name)) : undefined;
                if (name && !outfit) throw new Error(this.t('m27.error.noOutfit', { name }));
                const looks = outfit && look ? withLook(outfit.looks, look) : null;
                // The own clothes said in other words: the wording goes to the slot's stand-in outfit.
                const slot = !outfit && look && this.slotLooks(passport) ? this.withSlotLook(passport, look) : null;
                if (outfit && looks) {
                    // One save: the outfit put on and its new wording.
                    await api.savePassport(
                        { ...passport, outfits: withLooks(outfit, looks), activeOutfit: outfit.name },
                        'chat',
                        owner,
                    );
                } else if (slot) {
                    await api.savePassport({ ...slot, activeOutfit: '' }, 'chat', owner);
                } else if (!sameName(passport.activeOutfit, outfit?.name ?? '')) {
                    await api.setOutfit(passport.id, outfit?.name ?? '', 'chat');
                }
                break;
            }
            case 'state':
                await this.applyState(api, passport, payload, owner);
                break;
            case 'place':
                await this.applyPlace(api, passport, payload, owner);
                break;
        }
        await this.record(payload);
        const switched =
            (payload.action === 'outfit.wear' || (payload.action === 'outfit.create' && payload.activate)) &&
            !sameName(before, name);
        if (switched && payload.portrait)
            this.redrawPortrait(payload.portrait, payload.passportId, payload.messageIndex);
        this.emitChange();
    }

    private async applyState(
        api: NaiStudioApi,
        passport: NaiPassport,
        payload: WardrobePayload,
        owner: NaiPassportTarget | undefined,
    ): Promise<void> {
        const stateId = payload.stateId ?? payload.rule ?? '';
        const enabled = payload.enabled === true;
        const existing =
            passport.states.find((state) => state.id === stateId) ??
            passport.states.find((state) => sameName(state.id, stateId));
        if (existing) {
            if (existing.enabled !== enabled) await api.setState(passport.id, existing.id, enabled, 'chat');
            return;
        }
        if (!enabled) return;
        await api.savePassport(
            {
                ...passport,
                states: [...passport.states, { id: stateId, tags: payload.tags || stateId, enabled: true }],
            },
            'chat',
            owner,
        );
    }

    /** A location passport: the state entry plus its tags in `tags` (NAI Studio draws a location from its tags). */
    private async applyPlace(
        api: NaiStudioApi,
        passport: NaiPassport,
        payload: WardrobePayload,
        owner: NaiPassportTarget | undefined,
    ): Promise<void> {
        const stateId = payload.stateId ?? payload.rule ?? '';
        const enabled = payload.enabled === true;
        const states = passport.states.map((state) => ({ ...state }));
        const existing = states.find((state) => sameName(state.id, stateId));
        let tags: string;
        if (enabled) {
            const added = missingTags(passport.tags, payload.tags ?? '');
            payload.added = added;
            tags = addTags(passport.tags, added);
            if (existing) existing.enabled = true;
            else states.push({ id: stateId, tags: payload.tags ?? stateId, enabled: true });
        } else {
            tags = removeTags(passport.tags, payload.added ?? []);
            if (existing) existing.enabled = false;
        }
        if (tags === passport.tags && JSON.stringify(states) === JSON.stringify(passport.states)) return;
        await api.savePassport({ ...passport, tags, states }, 'chat', owner);
    }

    /** The document side of an applied change: library, bookkeeping, history. */
    private async record(payload: WardrobePayload): Promise<void> {
        const at = Date.now();
        const lastCommitted = payload.origin === 'user' ? this.lastCommitted() : -1;
        await this.mutate((doc) => {
            if (payload.action === 'passport.copy') {
                // The record kept under the name moves to the new passport.
                const record = payload.record ? doc.current[payload.record] : undefined;
                if (record) {
                    delete doc.current[record.key];
                    record.key = payload.passportId;
                    record.passportId = payload.passportId;
                    delete record.queued;
                    doc.current[payload.passportId] = record;
                }
                return true;
            }
            const current = payload.record ? doc.current[payload.record] : undefined;
            if (current && (payload.action === 'outfit.wear' || payload.action === 'outfit.create')) {
                // The clothing of the record is this outfit now, and Maestro put it on.
                current.outfit = payload.name ?? '';
                if (payload.action === 'outfit.wear' || payload.activate) current.applied = payload.name ?? '';
                delete current.queued;
            }
            const entry: HistoryEntry = {
                op: payload.op,
                kind: payload.action === 'state' ? 'character' : payload.action === 'place' ? 'place' : 'outfit',
                subject: payload.subject,
                passportId: payload.passportId,
                state:
                    payload.action === 'state' || payload.action === 'place'
                        ? (payload.rule ?? '')
                        : (payload.name ?? ''),
                enabled: payload.action === 'outfit.create' ? payload.activate === true : payload.enabled !== false,
                messageIndex: payload.messageIndex,
                at,
                origin: payload.origin,
            };
            switch (payload.action) {
                case 'outfit.create':
                case 'outfit.wear': {
                    noteOutfit(doc, {
                        passportId: payload.passportId,
                        character: payload.subject,
                        name: payload.name ?? '',
                        ...(payload.tags ? { tags: payload.tags } : {}),
                        ...(payload.wording ? { wording: payload.wording } : {}),
                        messageIndex: payload.messageIndex,
                        origin: payload.origin,
                        at,
                        created: payload.action === 'outfit.create',
                    });
                    if (payload.action === 'outfit.create') entry.created = true;
                    const index = Math.max(payload.messageIndex, lastCommitted);
                    const switched = payload.action === 'outfit.wear' || payload.activate === true;
                    if (switched && index >= 0) {
                        doc.lastOutfit[payload.passportId] = Math.max(doc.lastOutfit[payload.passportId] ?? -1, index);
                    }
                    break;
                }
                case 'state': {
                    const rule = payload.rule ?? '';
                    const tracked = (doc.chars[payload.passportId] ??= {});
                    if (payload.enabled) {
                        tracked[rule] = { since: payload.messageIndex, missing: 0, stateId: payload.stateId ?? rule };
                    } else delete tracked[rule];
                    if (!Object.keys(tracked).length) delete doc.chars[payload.passportId];
                    break;
                }
                case 'place': {
                    const placeId = payload.placeId ?? '';
                    entry.placeId = placeId;
                    const rule = payload.rule ?? '';
                    const tracked = (doc.places[placeId] ??= {});
                    if (payload.enabled) {
                        const state: TrackedState = {
                            since: payload.messageIndex,
                            missing: 0,
                            stateId: payload.stateId ?? rule,
                            passportId: payload.passportId,
                        };
                        if (payload.added?.length) state.added = [...payload.added];
                        tracked[rule] = state;
                    } else delete tracked[rule];
                    if (!Object.keys(tracked).length) delete doc.places[placeId];
                    break;
                }
            }
            pushHistory(doc, entry);
            return true;
        });
    }

    /* ---------------------------------------------------------------- undo */

    /** Restores the fields a change touched (other later edits of the passport stay). */
    async undo(change: JournalChange): Promise<boolean> {
        const ref = change.ref;
        const passportId = typeof ref.passportId === 'string' ? ref.passportId : '';
        const action = ref.action as WardrobeAction | undefined;
        const api = this.naiApi();
        if (!passportId || !action || !api) return false;
        const passport = this.passportOf(passportId);
        if (!passport) return false;
        if (action === 'passport.copy') {
            // The copy is a passport of the chat itself: dropping the chat's override removes it.
            await api.clearChatOverride(passportId);
            await this.forget(change);
            this.emitChange();
            return true;
        }
        const owner = isDict(ref.owner) ? (ref.owner as NaiPassportTarget) : undefined;
        const before = isDict(change.before) ? change.before : {};
        const after = isDict(change.after) ? change.after : {};
        const name = typeof ref.name === 'string' ? ref.name : '';
        const previous = typeof before.activeOutfit === 'string' ? before.activeOutfit : '';
        switch (action) {
            case 'outfit.create': {
                const outfits = passport.outfits.filter((outfit) => !sameName(outfit.name, name));
                const restore = outfits.some((outfit) => sameName(outfit.name, previous)) ? previous : '';
                const activeOutfit = sameName(passport.activeOutfit, name) ? restore : passport.activeOutfit;
                await api.savePassport({ ...passport, outfits, activeOutfit }, 'chat', owner);
                break;
            }
            case 'outfit.wear': {
                const now = typeof after.activeOutfit === 'string' ? after.activeOutfit : name;
                const putBack = sameName(passport.activeOutfit, now);
                const restore = passport.outfits.find((outfit) => sameName(outfit.name, previous))?.name ?? '';
                // The DES wordings this change added to the worn outfit go too (others added later stay).
                const added = addedLooks(strings(before.looks), strings(after.looks));
                // The own clothes' wordings live on the slot's stand-in outfit.
                const worn = !added.length
                    ? undefined
                    : name
                      ? passport.outfits.find((outfit) => sameName(outfit.name, name))
                      : passport.outfits.find((outfit) => isOwnClothes(outfit.name));
                const looks = worn ? withoutLooks(worn.looks, added) : null;
                if (worn && looks && looks.length !== (worn.looks ?? []).length) {
                    // A stand-in left without wordings goes (it only carried them).
                    const outfits =
                        !name && !looks.length
                            ? passport.outfits.filter((item) => item !== worn)
                            : passport.outfits.map((item) => (item === worn ? outfitWithLooks(item, looks) : item));
                    await api.savePassport(
                        { ...passport, outfits, activeOutfit: putBack ? restore : passport.activeOutfit },
                        'chat',
                        owner,
                    );
                } else if (putBack) {
                    await api.setOutfit(passportId, restore, 'chat');
                }
                break;
            }
            case 'state':
            case 'place': {
                const stateId = typeof ref.stateId === 'string' ? ref.stateId : '';
                const was = isDict(before.state) ? before.state : null;
                let states = passport.states.map((state) => ({ ...state }));
                if (!was) states = states.filter((state) => !sameName(state.id, stateId));
                else {
                    const state = states.find((item) => sameName(item.id, stateId));
                    if (state) state.enabled = was.enabled === true;
                    else states.push({ id: stateId, tags: String(was.tags ?? stateId), enabled: was.enabled === true });
                }
                let tags = passport.tags;
                if (action === 'place' && typeof before.tags === 'string' && typeof after.tags === 'string') {
                    const split = (text: string) =>
                        text
                            .split(',')
                            .map((tag) => tag.trim())
                            .filter(Boolean);
                    const old = new Set(split(before.tags).map((tag) => tag.toLowerCase()));
                    const changed = new Set(split(after.tags).map((tag) => tag.toLowerCase()));
                    tags = removeTags(
                        tags,
                        split(after.tags).filter((tag) => !old.has(tag.toLowerCase())),
                    );
                    tags = addTags(
                        tags,
                        split(before.tags).filter((tag) => !changed.has(tag.toLowerCase())),
                    );
                }
                await api.savePassport({ ...passport, tags, states }, 'chat', owner);
                break;
            }
            default:
                return false;
        }
        await this.forget(change);
        this.emitChange();
        return true;
    }

    /** The document side of an undo: history marked, the outfit or the state bookkeeping adjusted. */
    private async forget(change: JournalChange): Promise<void> {
        const ref = change.ref;
        const op = typeof ref.op === 'string' ? ref.op : '';
        const passportId = String(ref.passportId ?? '');
        const after = isDict(change.after) ? change.after : {};
        const afterState = isDict(after.state) ? after.state : null;
        try {
            await this.mutate((doc) => {
                if (op) markUndone(doc, op);
                switch (ref.action) {
                    case 'outfit.create':
                        dropOutfit(doc, passportId, String(ref.name ?? ''));
                        break;
                    case 'passport.copy': {
                        // Without the copy the character is the record kept under the name again.
                        const record = doc.current[passportId];
                        if (record) {
                            delete doc.current[passportId];
                            record.key = nameKey(record.name);
                            record.passportId = '';
                            delete record.applied;
                            delete record.queued;
                            doc.current[record.key] = record;
                        }
                        break;
                    }
                    case 'state':
                    case 'place': {
                        const rule = String(ref.rule ?? '');
                        const owner = ref.action === 'state' ? passportId : String(ref.placeId ?? '');
                        const map = ref.action === 'state' ? doc.chars : doc.places;
                        const tracked = map[owner];
                        // An undone «on» stays off while its wording lasts; an undone «off» is the user's again.
                        if (afterState?.enabled === true) {
                            const entry = tracked?.[rule];
                            if (entry) {
                                entry.suppressed = true;
                                entry.missing = 0;
                            } else {
                                (map[owner] ??= {})[rule] = {
                                    since: -1,
                                    missing: 0,
                                    stateId: String(ref.stateId ?? rule),
                                    suppressed: true,
                                    ...(ref.action === 'place' ? { passportId } : {}),
                                };
                            }
                        } else if (tracked) {
                            delete tracked[rule];
                            if (!Object.keys(tracked).length) delete map[owner];
                        }
                        break;
                    }
                }
                return true;
            });
        } catch (error) {
            this.log.warn('wardrobe document was not updated after an undo', error);
        }
    }

    /* ---------------------------------------------------------------- committed turns: states */

    private onCommitted(index: number): void {
        if (this.disposed || !Number.isInteger(index) || index < 0) return;
        this.pendingTurn = index;
        if (this.turnTimer !== null) clearTimeout(this.turnTimer);
        const generation = this.generation;
        this.turnTimer = setTimeout(() => {
            this.turnTimer = null;
            const pending = this.pendingTurn;
            this.pendingTurn = null;
            if (pending === null || generation !== this.generation) return;
            this.watchNeighbours();
            void this.enqueue(() => this.readTurn(pending, generation)).catch((error: unknown) =>
                this.log.error('wardrobe turn failed', error),
            );
        }, this.settleMs);
    }

    /** States of one committed reply (leader only; each turn once). */
    private async readTurn(index: number, generation: number): Promise<void> {
        if (generation !== this.generation || !this.writable()) return;
        const settings = this.settings();
        if (!settings.states && !settings.places && !settings.outfits) return;
        const doc = await this.loadDoc();
        // A mark past the end of the chat (messages deleted while unseen) would block every new turn.
        if (index <= freshMark(doc.lastIndex, this.chat().length)) return;
        const snapshot = this.tracker(index);
        await this.mutate((fresh) => {
            fresh.lastIndex = Math.max(freshMark(fresh.lastIndex, this.chat().length), index);
            return true;
        });
        if (snapshot && generation === this.generation) {
            if (settings.outfits) await this.reconcileTurn(snapshot, index, generation);
            if (settings.states && generation === this.generation) await this.characterStates(snapshot, index);
            if (settings.places && generation === this.generation) await this.sceneStates(snapshot, index);
        }
        // The user's character is not in DES's tracker: its own check (persona.ts), with or without tracker data.
        if (this.turnHook && settings.outfits && generation === this.generation) {
            try {
                await this.turnHook(index);
            } catch (error) {
                this.log.warn('wardrobe turn hook failed', error);
            }
        }
        this.emitChange();
    }

    /* ---------------------------------------------------------------- what everyone wears now */

    /**
     * Every committed turn: what each character of the scene wears per the tracker is compared with the outfit on in
     * the passport — a known outfit is put on, a new one is made once the same clothing held two turns, undressing
     * puts on the built-in outfits; a turn that was missed (a failed write, a skipped signal) heals on the next one.
     */
    private async reconcileTurn(snapshot: DesTrackerSnapshot, index: number, generation: number): Promise<void> {
        const swipe = Number(this.chat()[index]?.swipe_id ?? 0) || 0;
        const seen = new Set<string>();
        const portraits = this.settings().redrawPortrait;
        for (const character of snapshot.characters) {
            if (generation !== this.generation) return;
            if (character.offScene) continue;
            const target = this.resolveCharacter(character.name);
            const key = target ? target.passportId : nameKey(character.name);
            if (seen.has(key)) continue;
            seen.add(key);
            const observation = wearOfDetails(character.name, character.details);
            if (!observation) continue;
            await this.observeOne(
                target,
                key,
                observation,
                { index, swipe },
                {
                    immediate: false,
                    origin: 'des',
                    portrait: portraits ? character.name : '',
                },
            );
        }
        // Who left the scene: their record stays, the prompt line leaves them out.
        await this.mutate((doc) => {
            let changed = false;
            for (const record of Object.values(doc.current)) {
                if (record.persona) continue;
                const present = seen.has(record.key);
                if (record.present !== present) {
                    record.present = present;
                    changed = true;
                }
            }
            return changed ? true : NO_WRITE;
        });
    }

    /** One observation of one character (or the persona): the record, then the passport. */
    private async observeOne(
        target: PassportTarget | null,
        key: string,
        observation: WearObservation,
        at: { index: number; swipe: number },
        options: ObserveOptions,
    ): Promise<void> {
        const updated = await this.mutate((doc) => {
            let previous = doc.current[key];
            if (!previous && target) {
                // A character who got a passport since: the record kept under the name moves to it.
                const byName = doc.current[nameKey(observation.name)];
                if (byName) {
                    previous = byName;
                    delete doc.current[byName.key];
                }
            }
            const place = {
                key,
                passportId: target?.passportId ?? '',
                index: at.index,
                swipe: at.swipe,
                now: Date.now(),
            };
            const next = observeWear(previous, observation, options.persona ? { ...place, persona: true } : place);
            doc.current[key] = next;
            return next;
        });
        if (!updated) return;
        let record: WearRecord = updated;
        let current = target;
        if (!current && !options.persona && this.wouldWrite(record, options.immediate)) {
            // A character known only from the lore: the passport is copied into the chat on the first outfit.
            current = await this.copyLorePassport(observation.name, at.index, record);
            if (!current) return;
            record = (await this.loadDoc()).current[current.passportId] ?? record;
        }
        if (!current) return;
        const plan = this.decide(current, record, options.immediate, await this.loadDoc());
        await this.carryOut(current, record, plan, { ...options, index: at.index });
    }

    /** The clothing would change a passport now (undressing, a new outfit after two turns, an answer by hand). */
    private wouldWrite(record: WearRecord, immediate: boolean): boolean {
        if (record.undress && UNDRESS_OUTFITS.includes(record.undress)) return true;
        return (immediate || record.turns >= 2) && hasGarment(outfitTagList(record.wording));
    }

    /** Which outfit the clothing of a record is. */
    private decide(target: PassportTarget, record: WearRecord, immediate: boolean, doc: WardrobeDoc): Plan {
        const passport = target.passport;
        if (record.undress && UNDRESS_OUTFITS.includes(record.undress)) {
            const kind = record.undress;
            const existing = passport.outfits.find((outfit) => undressOfOutfit(outfit.name) === kind);
            if (existing) return { kind: 'wear', name: existing.name };
            return {
                kind: 'create',
                name: undressOutfitName(kind, this.locale()),
                tags: UNDRESS_TAGS[kind] ?? 'nude',
                undress: kind,
            };
        }
        // The clothing has its outfit already (put on for it, or chosen by hand): no new matching while it stays.
        if (record.outfit !== null && record.applied !== undefined && sameName(record.outfit, record.applied)) {
            return { kind: 'wear', name: record.outfit };
        }
        const match = matchOutfit(record.wording, this.candidates(target, doc));
        if (match) return { kind: 'wear', name: match.name };
        const tags = outfitTagList(record.wording);
        if (!hasGarment(tags)) return { kind: 'none' };
        if (immediate || record.turns >= 2) {
            const taken = passport.outfits.map((outfit) => outfit.name);
            const name = newOutfitName(this.locale(), tags, record.wording, taken);
            return { kind: 'create', name, tags: tags.map((item) => item.tag).join(', ') };
        }
        // Dressing again after undressing: the own clothes while the new outfit waits for its second turn.
        if (undressOfOutfit(passport.activeOutfit)) return { kind: 'interim' };
        return { kind: 'wait' };
    }

    /** The plan into the passport: noted, proposed (autonomy) or, by hand, applied and journaled. */
    private async carryOut(
        target: PassportTarget,
        record: WearRecord,
        plan: Plan,
        options: CarryOptions,
    ): Promise<void> {
        if (plan.kind === 'wait' || plan.kind === 'none') return;
        const passport = target.passport;
        const active = passport.activeOutfit;
        const interim = plan.kind === 'interim';
        // The own clothes while a new outfit waits are no outfit of this clothing: the record stays «new», and the
        // library and the looks do not learn the wording for them.
        const look = record.source === 'field' && !interim ? record.wording : '';
        const input = { messageIndex: options.index, origin: options.origin };
        const extra: Partial<WardrobePayload> = interim
            ? { look }
            : { wording: record.wording, look, record: record.key };
        if (options.portrait) extra.portrait = options.portrait;
        if (plan.kind === 'wear' || plan.kind === 'interim') {
            const name = plan.kind === 'wear' ? plan.name : '';
            if (plan.kind === 'wear') await this.markOutfit(record.key, name);
            if (sameName(active, name)) {
                await this.noteSeen(target, name, record, options, look);
                return;
            }
            // Put on by Maestro for this clothing before and changed since by hand: left as the user wants it (unless
            // the user says it now, by hand).
            if (!options.direct && record.applied !== undefined && sameName(record.applied, name)) return;
            if (!options.direct && record.queued !== undefined && sameName(record.queued, name)) return;
            const payload = this.payload('outfit.wear', target, input, { ...extra, name });
            const change = this.outfitChange(payload, active, name, undefined, this.wearLooks(passport, name, look));
            const text = this.wearText(target, record, name);
            await this.settle(record.key, name, payload, text.title, text.body, [change], options.direct === true);
            return;
        }
        if (!options.direct && record.queued !== undefined && sameName(record.queued, plan.name)) return;
        const payload = this.payload('outfit.create', target, input, {
            ...extra,
            name: plan.name,
            tags: plan.tags,
            activate: true,
        });
        const change = this.outfitChange(payload, active, plan.name, plan.tags);
        const text = this.createText(target, record, plan);
        await this.settle(record.key, plan.name, payload, text.title, text.body, [change], options.direct === true);
    }

    /** A proposal through autonomy (or applied at once by hand), and what the record keeps of the outcome. */
    private async settle(
        key: string,
        name: string,
        payload: WardrobePayload,
        title: string,
        body: string,
        changes: JournalChange[],
        direct: boolean,
    ): Promise<void> {
        if (direct) {
            await this.apply(payload);
            try {
                await this.app.journal.record({
                    module: WARDROBE_ID,
                    kind: WARDROBE_WEAR_KIND,
                    summary: title,
                    changes,
                });
            } catch (error) {
                this.log.error('outfit changed but not journaled', error);
            }
            return;
        }
        const decision = await this.propose(WARDROBE_KINDS.outfit, payload, title, body, changes);
        // Waiting in the Inbox, as a notice, or refused: not proposed again while the clothing stays.
        if (decision === 'queued' || decision === 'notified' || decision === 'rejected') {
            await this.mutate((doc) => {
                const record = doc.current[key];
                if (!record) return NO_WRITE;
                record.queued = name;
                return true;
            });
        }
    }

    /** The record's outfit, as decided (it may still wait for the passport write). */
    private async markOutfit(key: string, name: string): Promise<void> {
        await this.mutate((doc) => {
            const record = doc.current[key];
            if (!record || record.outfit === name) return NO_WRITE;
            record.outfit = name;
            return true;
        });
    }

    /** The outfit is on already: its wording is remembered (library, `looks`) and the record agrees. */
    private async noteSeen(
        target: PassportTarget,
        name: string,
        record: WearRecord,
        options: CarryOptions,
        look: string,
    ): Promise<void> {
        await this.mutate((doc) => {
            noteOutfit(doc, {
                passportId: target.passportId,
                character: target.name,
                name,
                wording: record.wording,
                messageIndex: options.index,
                origin: options.origin,
                at: Date.now(),
            });
            const fresh = doc.current[record.key];
            if (fresh) {
                fresh.outfit = name;
                fresh.applied = name;
                delete fresh.queued;
            }
            if (options.index >= 0) {
                doc.lastOutfit[target.passportId] = Math.max(doc.lastOutfit[target.passportId] ?? -1, options.index);
            }
            return true;
        });
        if (!look) return;
        if (name) await this.rememberLook(target, name, look);
        else await this.rememberSlotLook(target, look);
    }

    /**
     * The `looks` a wear adds (journal before/after): of the outfit put on, or of the slot's stand-in for the own
     * clothes. Undefined when nothing is added.
     */
    private wearLooks(
        passport: NaiPassport,
        name: string,
        look: string,
    ): { before: readonly string[]; after: readonly string[] } | undefined {
        if (!look) return undefined;
        const carrier = name
            ? passport.outfits.find((outfit) => sameName(outfit.name, name))
            : passport.outfits.find((outfit) => isOwnClothes(outfit.name));
        if ((name && !carrier) || (!name && !this.slotLooks(passport))) return undefined;
        const after = withLook(carrier?.looks, look);
        return after ? { before: carrier?.looks ?? [], after } : undefined;
    }

    /** The clothing slot has tags to stand in for (its stand-in outfit carries the tracker wordings). */
    private slotLooks(passport: NaiPassport): boolean {
        return !!passport.slots.clothing?.trim();
    }

    /**
     * The own clothes (clothing slot) said in other words: the wording goes to the slot's stand-in outfit (same tags as
     * the slot), so NAI Studio draws the own clothes for it instead of the tracker text. One save.
     */
    private async rememberSlotLook(target: PassportTarget, look: string): Promise<void> {
        const api = this.naiApi();
        if (!api || !this.looksAllowed()) return;
        const passport = this.passportOf(target.passportId);
        if (!passport || !this.slotLooks(passport)) return;
        const edited = this.withSlotLook(passport, look);
        if (!edited) return;
        try {
            await api.savePassport(edited, 'chat', target.owner ?? undefined);
        } catch (error) {
            this.log.warn('own clothes wording was not saved in the passport', error);
        }
    }

    /** The passport with the wording on the slot's stand-in (made when missing, tags kept equal to the slot). */
    private withSlotLook(passport: NaiPassport, look: string): NaiPassport | null {
        const slot = passport.slots.clothing ?? '';
        const carrier = passport.outfits.find((outfit) => isOwnClothes(outfit.name));
        const looks = withLook(carrier?.looks, look);
        if (!looks && carrier?.tags === slot) return null;
        const next: NaiPassport['outfits'][number] = {
            name: carrier?.name ?? ownClothesName(this.locale()),
            tags: slot,
        };
        const outfit = outfitWithLooks(next, looks ?? carrier?.looks ?? []);
        const outfits = carrier
            ? passport.outfits.map((item) => (item === carrier ? outfit : item))
            : [...passport.outfits, outfit];
        return { ...passport, outfits };
    }

    private wearText(target: PassportTarget, record: WearRecord, name: string): { title: string; body: string } {
        const who = target.name;
        const text = record.wording;
        const undress = undressOfOutfit(name);
        if (undress) {
            return {
                title: this.t(`m27.proposal.undress.${undress}`, { name: who }),
                body: this.t('m27.proposal.body.undress', { name: who, text, outfit: name }),
            };
        }
        if (!name) {
            return {
                title: this.t('m27.proposal.clothing', { name: who }),
                body: this.t('m27.proposal.body.clothing', { name: who, text }),
            };
        }
        const tags = target.passport.outfits.find((outfit) => sameName(outfit.name, name))?.tags ?? '';
        return {
            title: this.t('m27.proposal.wear', { name: who, outfit: name }),
            body: this.t('m27.proposal.body.wear', { name: who, text, outfit: name, tags: tags || '—' }),
        };
    }

    private createText(
        target: PassportTarget,
        record: WearRecord,
        plan: { name: string; tags: string; undress?: UndressKind },
    ): { title: string; body: string } {
        const who = target.name;
        if (plan.undress) {
            return {
                title: this.t(`m27.proposal.undress.${plan.undress}`, { name: who }),
                body: this.t('m27.proposal.body.undress', { name: who, text: record.wording, outfit: plan.name }),
            };
        }
        return {
            title: this.t('m27.proposal.create', { name: who, outfit: plan.name }),
            body: this.t('m27.proposal.body.create', {
                name: who,
                text: record.wording,
                outfit: plan.name,
                tags: plan.tags || '—',
            }),
        };
    }

    /** NAI Studio redraws the DES portrait of a character whose outfit changed (setting; once per turn). */
    private redrawPortrait(name: string, passportId: string, messageIndex: number): void {
        if (!name.trim() || !this.settings().redrawPortrait) return;
        const key = `${messageIndex}:${passportId}`;
        if (this.portraitDone.has(key)) return;
        this.portraitDone.add(key);
        let nai: { requestDesPortrait?: (name: string, options?: { reason?: string }) => Promise<boolean> };
        try {
            nai = adaptersOf(this.app).nai;
        } catch {
            return;
        }
        if (typeof nai.requestDesPortrait !== 'function') return;
        nai.requestDesPortrait(name, { reason: 'outfit' }).catch((error: unknown) =>
            this.log.debug('portrait redraw was not requested', error),
        );
    }

    /** The persona's passport in this chat (NAI Studio persona passport), if any. */
    personaTarget(): PassportTarget | null {
        if (!this.naiApi()) return null;
        const found = this.chatPassports().find(
            (item) => item.owner?.persona === true && item.passport.kind === 'character',
        );
        if (!found) return null;
        return { passportId: found.passport.id, owner: { persona: true }, name: found.name, passport: found.passport };
    }

    /**
     * What the user's character wears now (by hand in the Wardrobe tab, or the background check's answer): the persona
     * record and, when the persona has a passport, its outfit. False when the text says nothing.
     */
    setPersonaWearing(text: string, source: 'user' | 'model' = 'user', messageIndex?: number): Promise<boolean> {
        return this.enqueue(async () => {
            const clean = cleanOutfitText(text);
            if (!clean || !this.app.host.chatId() || this.app.host.isGroupChat()) return false;
            const name = this.app.host.ctx().name1 || 'User';
            const observation: WearObservation = {
                name,
                wording: clean,
                tags: outfitTags(clean),
                undress: clothingOf(clean)?.undress?.kind ?? '',
                source,
            };
            const index = messageIndex ?? this.lastCommitted();
            const target = this.settings().outfits || source === 'user' ? this.personaTarget() : null;
            await this.observeOne(
                target,
                PERSONA_KEY,
                observation,
                { index, swipe: 0 },
                {
                    immediate: true,
                    origin: source === 'user' ? 'user' : 'des',
                    portrait: '',
                    direct: source === 'user',
                    persona: true,
                },
            );
            this.emitChange();
            return true;
        });
    }

    /** «Что надето сейчас» of this chat: the scene first, then who left it, the persona last. */
    current(character?: string): Wearing[] {
        const doc = this.cached();
        if (!doc) return [];
        let records = Object.values(doc.current);
        if (character?.trim()) {
            const key = normalizeName(character);
            const target = this.resolveCharacter(character.trim());
            const persona = normalizeName(this.app.host.ctx().name1 ?? '') === key;
            records = records.filter(
                (record) =>
                    (target && record.passportId === target.passportId) ||
                    normalizeName(record.name) === key ||
                    (persona && record.persona === true),
            );
        }
        const rank = (record: WearRecord) => (record.persona ? 2 : record.present ? 0 : 1);
        return records
            .sort((a, b) => rank(a) - rank(b) || b.seen - a.seen)
            .map((record) => {
                const item: Wearing = {
                    key: record.key,
                    name: record.name,
                    persona: record.persona === true,
                    passportId: record.passportId,
                    wording: record.wording,
                    tags: record.tags,
                    undress: record.undress,
                    outfit: record.outfit,
                    since: record.since,
                    seen: record.seen,
                    turns: record.turns,
                    present: record.present,
                    source: record.source,
                };
                if (record.queued !== undefined && record.queued !== COPY_PENDING) item.queued = record.queued;
                return item;
            });
    }

    /** «Надеть другое»: the outfit of a record's character is chosen by hand (and its wording learnt). */
    async wearOther(key: string, outfit: string): Promise<void> {
        const record = (await this.loadDoc()).current[key];
        if (!record?.passportId) throw new Error(this.t('m27.error.noPassport'));
        await this.wear(record.passportId, outfit);
    }

    /** «Это новый наряд»: the clothing of a record becomes a new outfit now and is put on. Its name. */
    markNew(key: string): Promise<string> {
        return this.enqueue(async () => {
            if (!this.app.host.chatId()) throw new Error(this.t('m27.error.noChat'));
            if (!this.naiApi()) throw new Error(this.t('m27.error.noNai'));
            const record = (await this.loadDoc()).current[key];
            if (!record?.passportId) throw new Error(this.t('m27.error.noPassport'));
            const passport = this.passportOf(record.passportId);
            if (!passport) throw new Error(this.t('m27.error.gone'));
            const tags = outfitTagList(record.wording);
            if (!hasGarment(tags)) throw new Error(this.t('m27.error.noGarment'));
            const target: PassportTarget = {
                passportId: passport.id,
                owner: record.persona ? { persona: true } : this.ownerById(passport.id),
                name: record.name || this.characterName(passport),
                passport,
            };
            const name = newOutfitName(
                this.locale(),
                tags,
                record.wording,
                passport.outfits.map((outfit) => outfit.name),
            );
            const plan = { kind: 'create' as const, name, tags: tags.map((item) => item.tag).join(', ') };
            await this.carryOut(target, { ...record, queued: undefined } as WearRecord, plan, {
                index: this.lastCommitted(),
                origin: 'user',
                immediate: true,
                portrait: record.persona || !this.settings().redrawPortrait ? '' : record.name,
                direct: true,
            });
            // The wording is this outfit from now on (it may have looked like another one before).
            await this.mutate((doc) => {
                noteOutfit(doc, {
                    passportId: passport.id,
                    character: target.name,
                    name,
                    wording: record.wording,
                    messageIndex: record.seen,
                    origin: 'user',
                    at: Date.now(),
                });
                return true;
            });
            this.emitChange();
            return name;
        });
    }

    /** What the user chose by hand for a passport: the record (if any) agrees and its wording means this outfit. */
    private async learn(passportId: string, name: string): Promise<WearRecord | null> {
        const result = await this.mutate((doc) => {
            const record = Object.values(doc.current).find((item) => item.passportId === passportId);
            if (!record) return NO_WRITE;
            record.outfit = name;
            record.applied = name;
            delete record.queued;
            if (record.wording && !record.undress) {
                noteOutfit(doc, {
                    passportId,
                    character: record.name,
                    name,
                    wording: record.wording,
                    messageIndex: record.seen,
                    origin: 'user',
                    at: Date.now(),
                });
            }
            return { ...record };
        });
        return result ?? null;
    }

    /** The prompt line's people: the scene of the last committed reply (its tracker, else the records) and the persona. */
    promptEntries(): { name: string; wording: string }[] {
        const doc = this.cached();
        const out: { name: string; wording: string }[] = [];
        const snapshot = this.tracker(this.lastCommitted());
        const records = doc ? Object.values(doc.current) : [];
        const recordOf = (name: string) => {
            const key = normalizeName(name);
            return records.find((record) => !record.persona && normalizeName(record.name) === key);
        };
        if (snapshot?.characters.length) {
            const seen = new Set<string>();
            for (const character of snapshot.characters) {
                const key = normalizeName(character.name);
                if (character.offScene || seen.has(key)) continue;
                seen.add(key);
                const wording =
                    wearOfDetails(character.name, character.details)?.wording || recordOf(character.name)?.wording;
                if (wording) out.push({ name: character.name, wording });
            }
        } else {
            for (const record of records) if (record.present && !record.persona && record.wording) out.push(record);
        }
        const persona = doc?.current[PERSONA_KEY];
        if (persona?.wording) out.push({ name: persona.name || this.app.host.ctx().name1, wording: persona.wording });
        return out.map(({ name, wording }) => ({ name, wording }));
    }

    /** The persona check's last committed message (-1: never). */
    async personaCheckIndex(): Promise<number> {
        return (await this.loadDoc()).personaCheck;
    }

    async setPersonaCheckIndex(index: number): Promise<void> {
        await this.mutate((doc) => {
            if (doc.personaCheck === index) return NO_WRITE;
            doc.personaCheck = index;
            return true;
        });
    }

    /** Revision outfit cards dismissed because they never can be taken (newest first). */
    droppedCards(): DroppedCard[] {
        return [...(this.cached()?.dropped ?? [])].reverse();
    }

    /** Runs after every committed turn the wardrobe read (the persona check). */
    setTurnHook(hook: ((index: number) => Promise<void>) | null): void {
        this.turnHook = hook;
    }

    /** Runs when a chat is open in the leader tab (the DES field notice). */
    setOpenHook(hook: (() => void) | null): void {
        this.openHook = hook;
    }

    /* ---------------------------------------------------------------- lore passports */

    /**
     * NAI Studio 0.14 hides a passport excluded in this chat (another story's character with this name): such a
     * character counts as having none, but its lore passport must not bring it back either.
     */
    private excludedHere(name: string): boolean {
        const api = this.naiApi() as unknown as
            { isPassportExcluded?: (id: string) => boolean; passports: (scope?: unknown) => unknown } | undefined;
        if (typeof api?.isPassportExcluded !== 'function') return false;
        let list: unknown;
        try {
            list = api.passports({ includeExcluded: true });
        } catch {
            return false;
        }
        const key = normalizeName(name);
        for (const raw of Array.isArray(list) ? list : []) {
            const passport = readPassport(raw);
            if (!passport) continue;
            const names = [passport.name, ...passport.aliases].map(normalizeName);
            if (names.includes(key) && api.isPassportExcluded(passport.id)) return true;
        }
        return false;
    }

    /** A lore passport (M28) of a character without a passport in this chat: its entries, else the scene's. */
    private async findLorePassport(name: string): Promise<Record<string, unknown> | null> {
        const lore = this.lorePassports();
        if (!lore) return null;
        let entity: Entity | undefined;
        try {
            entity = this.world()?.resolve(name, 'character');
        } catch (error) {
            this.log.debug('world model resolve failed', error);
        }
        const isCharacter = (passport: Record<string, unknown>) => !passport.kind || passport.kind === 'character';
        for (const source of entity?.sources ?? []) {
            if (source.kind !== 'lore.entry' && source.kind !== 'canon.entry') continue;
            if (!source.world || typeof source.uid !== 'number') continue;
            try {
                const found = await lore.get(source.world, source.uid);
                if (found?.passport && isCharacter(found.passport)) return found.passport;
            } catch (error) {
                this.log.debug('lore passport is not readable', error);
            }
        }
        const keys = new Set([name, ...(entity ? [entity.name, ...entity.aliases] : [])].map(normalizeName));
        keys.delete('');
        try {
            for (const item of lore.forScene()) {
                const aliases = Array.isArray(item.passport.aliases) ? item.passport.aliases.map(String) : [];
                const names = [item.name, ...aliases].map(normalizeName);
                if (isCharacter(item.passport) && names.some((key) => keys.has(key))) return item.passport;
            }
        } catch (error) {
            this.log.debug('scene lore passports are not readable', error);
        }
        return null;
    }

    /** The lore passport copied into the chat (journaled, undo removes it); the new target when it is there now. */
    private async copyLorePassport(name: string, index: number, record: WearRecord): Promise<PassportTarget | null> {
        if (!this.naiApi() || record.queued === COPY_PENDING || this.excludedHere(name)) return null;
        const found = await this.findLorePassport(name);
        const normalized = found ? normalizePassport(found, { kind: 'character', name }) : null;
        if (!normalized) return null;
        const slug =
            normalizeName(name)
                .replace(/[^\p{L}\p{N}]+/gu, '-')
                .slice(0, 24) || 'npc';
        const id = `maestro-${slug}-${Date.now().toString(36)}`;
        const copy = readPassport({ ...normalized, id, name: String(normalized.name || name) });
        if (!copy) return null;
        const payload: WardrobePayload = {
            m27: 1,
            op: newOp(),
            action: 'passport.copy',
            passportId: id,
            owner: null,
            subject: copy.name,
            messageIndex: index,
            origin: 'des',
            record: record.key,
            copy: copy as unknown as Record<string, unknown>,
        };
        const decision = await this.propose(
            WARDROBE_KINDS.outfit,
            payload,
            this.t('m27.proposal.copy', { name: copy.name }),
            this.t('m27.proposal.body.copy', { name: copy.name }),
            [
                {
                    target: WARDROBE_UNDO_TARGET,
                    ref: { op: payload.op, action: 'passport.copy', passportId: id, subject: copy.name },
                    before: null,
                    after: { passport: copy.name },
                },
            ],
        );
        if (decision === 'applied') {
            const passport = this.passportOf(id) ?? copy;
            return { passportId: id, owner: null, name: copy.name, passport };
        }
        if (decision === 'queued' || decision === 'notified' || decision === 'rejected') {
            await this.mutate((doc) => {
                const fresh = doc.current[record.key];
                if (!fresh) return NO_WRITE;
                fresh.queued = COPY_PENDING;
                return true;
            });
        }
        return null;
    }

    private async characterStates(snapshot: DesTrackerSnapshot, index: number): Promise<void> {
        const seen = new Set<string>();
        for (const character of snapshot.characters) {
            if (character.offScene) continue;
            const target = this.resolveCharacter(character.name);
            if (!target || seen.has(target.passportId)) continue;
            seen.add(target.passportId);
            const detected = detectStates(Object.values(character.details).join('. '), CHARACTER_STATE_RULES);
            await this.stepSubject(target, detected, index, 'state', null);
        }
    }

    /** The scene's place: its DES wording (and the registry's lasting state) → the location passport. */
    private async sceneStates(snapshot: DesTrackerSnapshot, index: number): Promise<void> {
        const info = snapshot.infoBox;
        const places = this.placesApi();
        if (!info || !places) return;
        let place: Place | null | undefined;
        try {
            place = (info.location ? places.resolve(info.location) : undefined) ?? places.current();
        } catch (error) {
            this.log.debug('places are not readable', error);
            return;
        }
        if (!place) return;
        const target = this.resolvePlace(place);
        if (!target) return;
        const scene = [info.location, info.weather?.forecast, info.time?.start, info.time?.end, info.date]
            .concat(Object.values(info.fields))
            .filter(Boolean)
            .join('. ');
        const lasting = [...info.recentEvents, ...Object.values(place.state ?? {})].join('. ');
        const detected = detectStates(scene, PLACE_STATE_RULES);
        const longRules = PLACE_STATE_RULES.filter((item) => item.lasting || item.id === 'burning');
        for (const id of detectStates(lasting, longRules)) if (!detected.includes(id)) detected.push(id);
        const clock = timeOfDayState(info.time?.end ?? info.time?.start);
        if (clock && !detected.some((id) => stateRule(id, PLACE_STATE_RULES)?.group === 'time')) detected.push(clock);
        await this.stepSubject(target, detected, index, 'place', place);
    }

    /** Two-turn bookkeeping of one passport (character) or place, then the proposals. */
    private async stepSubject(
        target: PassportTarget,
        detected: string[],
        index: number,
        action: 'state' | 'place',
        place: Place | null,
    ): Promise<void> {
        const rules = action === 'state' ? CHARACTER_STATE_RULES : PLACE_STATE_RULES;
        const key = action === 'state' ? target.passportId : (place?.id ?? '');
        const passport = target.passport;
        const alreadyOn = (id: string) => {
            const item = stateRule(id, rules);
            if (!item) return true;
            const state = findPassportState(passport.states, item);
            if (state?.enabled) return true;
            // A location whose own tags already say it (the card's «night»): not Maestro's to add or take away.
            const primary = (state?.tags || item.tags).split(',')[0] ?? '';
            return action === 'place' && !missingTags(passport.tags, primary).length;
        };
        const step = await this.mutate((doc) => {
            const map = action === 'state' ? doc.chars : doc.places;
            const tracked = (map[key] ??= {});
            const result = stepTracked(tracked, detected, { rules, alreadyOn });
            const off = result.off.map((id) => ({ id, entry: { ...(tracked[id] as TrackedState) } }));
            for (const id of result.forgotten) delete tracked[id];
            if (!Object.keys(tracked).length) delete map[key];
            return { on: result.on, off };
        });
        if (!step) return;
        for (const id of step.on) {
            const item = stateRule(id, rules);
            if (item) await this.switchOn(target, item, index, action, place);
        }
        for (const { id, entry } of step.off) {
            const item = stateRule(id, rules);
            if (item) await this.switchOff(target, item, entry, index, action, place);
        }
    }

    private stateTitle(id: string): string {
        const key = `m27.state.${id}`;
        const text = this.t(key);
        return text === key ? id : text;
    }

    private async switchOn(
        target: PassportTarget,
        item: StateRule,
        index: number,
        action: 'state' | 'place',
        place: Place | null,
    ): Promise<void> {
        const passport = target.passport;
        const existing = findPassportState(passport.states, item);
        const stateId = existing?.id ?? item.id;
        const tags = existing?.tags || item.tags;
        const payload = this.payload(
            action,
            target,
            { messageIndex: index, origin: 'des' },
            {
                rule: item.id,
                stateId,
                tags,
                enabled: true,
            },
        );
        const state = this.stateTitle(item.id);
        let title: string;
        const changes: JournalChange[] = [];
        const ref = {
            op: payload.op,
            action,
            passportId: target.passportId,
            owner: target.owner,
            rule: item.id,
            stateId,
        };
        if (action === 'place' && place) {
            payload.placeId = place.id;
            payload.subject = place.name;
            title = this.t('m27.proposal.placeOn', { place: place.name, state });
            changes.push({
                target: WARDROBE_UNDO_TARGET,
                ref: { ...ref, placeId: place.id, subject: place.name },
                before: { tags: passport.tags, state: stateCopy(existing) },
                after: {
                    tags: addTags(passport.tags, missingTags(passport.tags, tags)),
                    state: { id: stateId, tags, enabled: true },
                },
            });
        } else {
            title = this.t('m27.proposal.stateOn', { name: target.name, state });
            changes.push({
                target: WARDROBE_UNDO_TARGET,
                ref: { ...ref, subject: target.name },
                before: { state: stateCopy(existing) },
                after: { state: { id: stateId, tags, enabled: true } },
            });
        }
        const kind = action === 'state' ? WARDROBE_KINDS.state : WARDROBE_KINDS.place;
        const decision = await this.propose(kind, payload, title, this.t('m27.proposal.body.state', { tags }), changes);
        if (decision === 'queued' || decision === 'notified') await this.track(action, target, payload, place);
    }

    private async switchOff(
        target: PassportTarget,
        item: StateRule,
        entry: TrackedState,
        index: number,
        action: 'state' | 'place',
        place: Place | null,
    ): Promise<void> {
        const passport = target.passport;
        const existing = passport.states.find((state) => sameName(state.id, entry.stateId));
        const tagsLeft =
            action === 'place' && (entry.added ?? []).some((tag) => missingTags(passport.tags, tag).length === 0);
        if (!existing?.enabled && !tagsLeft) {
            // Already off (by hand, or a proposal never accepted): only Maestro's note goes.
            await this.untrack(action, action === 'state' ? target.passportId : (place?.id ?? ''), item.id);
            return;
        }
        const payload = this.payload(
            action,
            target,
            { messageIndex: index, origin: 'des' },
            {
                rule: item.id,
                stateId: entry.stateId,
                tags: existing?.tags ?? item.tags,
                enabled: false,
            },
        );
        const state = this.stateTitle(item.id);
        const ref = {
            op: payload.op,
            action,
            passportId: target.passportId,
            owner: target.owner,
            rule: item.id,
            stateId: entry.stateId,
        };
        let title: string;
        let change: JournalChange;
        if (action === 'place' && place) {
            payload.placeId = place.id;
            payload.subject = place.name;
            payload.added = [...(entry.added ?? [])];
            title = this.t('m27.proposal.placeOff', { place: place.name, state });
            change = {
                target: WARDROBE_UNDO_TARGET,
                ref: { ...ref, placeId: place.id, subject: place.name },
                before: { tags: passport.tags, state: stateCopy(existing) },
                after: {
                    tags: removeTags(passport.tags, payload.added),
                    state: existing ? { ...stateCopy(existing), enabled: false } : null,
                },
            };
        } else {
            title = this.t('m27.proposal.stateOff', { name: target.name, state });
            change = {
                target: WARDROBE_UNDO_TARGET,
                ref: { ...ref, subject: target.name },
                before: { state: stateCopy(existing) },
                after: { state: existing ? { ...stateCopy(existing), enabled: false } : null },
            };
        }
        const kind = action === 'state' ? WARDROBE_KINDS.state : WARDROBE_KINDS.place;
        const decision = await this.propose(
            kind,
            payload,
            title,
            this.t('m27.proposal.body.state', { tags: payload.tags ?? '' }),
            [change],
        );
        if (decision !== 'applied') {
            await this.untrack(action, action === 'state' ? target.passportId : (place?.id ?? ''), item.id);
        }
    }

    /** A proposal waits in the Inbox (or as a notice): noted so it is not proposed again every turn. */
    private async track(
        action: 'state' | 'place',
        target: PassportTarget,
        payload: WardrobePayload,
        place: Place | null,
    ) {
        const key = action === 'state' ? target.passportId : (place?.id ?? '');
        await this.mutate((doc) => {
            const map = action === 'state' ? doc.chars : doc.places;
            const entry: TrackedState = {
                since: payload.messageIndex,
                missing: 0,
                stateId: payload.stateId ?? payload.rule ?? '',
            };
            if (action === 'place') entry.passportId = target.passportId;
            (map[key] ??= {})[payload.rule ?? ''] = entry;
            return true;
        });
    }

    /** Forgets Maestro's note about a state (`key`: passport id of a character, place id of a place). */
    private async untrack(action: 'state' | 'place', key: string, rule: string) {
        await this.mutate((doc) => {
            const map = action === 'state' ? doc.chars : doc.places;
            const tracked = map[key];
            if (!tracked?.[rule]) return NO_WRITE;
            delete tracked[rule];
            if (!Object.keys(tracked).length) delete map[key];
            return true;
        });
    }

    /** The scene left a place: its transient states (night, rain, fire …) go off; lasting ones stay. */
    private onEnter(place: Place | null, previous: Place | null): void {
        if (!previous || previous.id === place?.id || !this.settings().places || !this.writable()) return;
        const generation = this.generation;
        void this.enqueue(async () => {
            if (generation !== this.generation || !this.writable()) return;
            const doc = await this.loadDoc();
            const tracked = doc.places[previous.id];
            if (!tracked) return;
            const target = this.resolvePlace(previous);
            const index = this.lastCommitted();
            for (const [id, entry] of Object.entries(tracked)) {
                const item = stateRule(id, PLACE_STATE_RULES);
                if (!item || item.lasting) continue;
                if (!target || entry.suppressed) {
                    await this.untrack('place', previous.id, id);
                    continue;
                }
                await this.switchOff(target, item, { ...entry }, index, 'place', previous);
            }
            this.emitChange();
        }).catch((error: unknown) => this.log.warn('wardrobe place change failed', error));
    }

    /* ---------------------------------------------------------------- invalidation */

    /** A swiped or deleted committed reply takes what Maestro derived from it (P14); an edit keeps it. */
    private onInvalidated(index: number, reason: 'swiped' | 'deleted' | 'edited'): void {
        if (reason === 'edited' || !this.writable()) return;
        const generation = this.generation;
        void this.enqueue(async () => {
            if (generation !== this.generation) return;
            await this.mutate((doc) => {
                let changed = false;
                if (doc.lastIndex >= index) {
                    doc.lastIndex = index - 1;
                    changed = true;
                }
                // «Что надето сейчас» goes back to what it was before that reply (a hand edit stays).
                for (const [key, record] of Object.entries(doc.current)) {
                    if (record.source === 'user') continue;
                    const back = revertWear(record, index);
                    if (back === record) continue;
                    changed = true;
                    delete doc.current[key];
                    if (back) doc.current[back.key] = back;
                }
                for (const done of [...this.portraitDone]) {
                    if (Number(done.split(':')[0]) >= index) this.portraitDone.delete(done);
                }
                if (doc.personaCheck >= index) {
                    doc.personaCheck = index - 1;
                    changed = true;
                }
                return changed ? true : NO_WRITE;
            });
            let records: { id: string }[] = [];
            try {
                records = this.app.journal
                    .list({ module: WARDROBE_ID })
                    .filter((record) => record.sourceMessage === index && !record.undone);
            } catch (error) {
                this.log.debug('journal is not readable', error);
            }
            for (const record of records) {
                try {
                    await this.app.journal.undo(record.id);
                } catch (error) {
                    this.log.warn('wardrobe change was not undone', error);
                }
            }
            this.emitChange();
        }).catch((error: unknown) => this.log.warn('wardrobe invalidation failed', error));
    }

    /* ---------------------------------------------------------------- deferred outfit cards */

    private scheduleIntake(): void {
        if (this.disposed) return;
        if (this.intakeTimer !== null) clearTimeout(this.intakeTimer);
        const generation = this.generation;
        this.intakeTimer = setTimeout(() => {
            this.intakeTimer = null;
            void this.enqueue(() => this.takeDeferred(generation)).catch((error: unknown) =>
                this.log.warn('wardrobe intake failed', error),
            );
        }, this.intakeMs);
    }

    /** The revision's parked 'deferred.outfit' cards (oldest first; leader only), then dismissed there. */
    private async takeDeferred(generation: number): Promise<void> {
        if (generation !== this.generation || !this.writable() || !this.settings().outfits) return;
        const revision = this.revisionApi();
        if (!revision) return;
        let cards: DeferredCard[];
        try {
            cards = revision
                .deferred()
                .filter((card) => card.target === 'deferred.outfit')
                .sort((a, b) => a.sourceMessage - b.sourceMessage || a.at - b.at);
        } catch (error) {
            this.log.debug('deferred cards are not readable', error);
            return;
        }
        if (!cards.length) return;
        for (const card of cards) {
            if (generation !== this.generation) return;
            const doc = await this.loadDoc();
            let done = doc.taken.includes(card.id);
            if (!done) {
                const result = await this.intake({
                    entityName: card.entityName,
                    value: card.value,
                    evidence: card.evidence,
                    sourceMessage: card.sourceMessage,
                });
                // Refused or switched off: kept for later. A card that never can be taken goes, with the reason.
                if (result.name === null && !result.reason) continue;
                done = true;
                const reason = result.name === null ? result.reason : undefined;
                await this.mutate((fresh) => {
                    if (fresh.taken.includes(card.id)) return NO_WRITE;
                    fresh.taken.push(card.id);
                    if (fresh.taken.length > KEEP_TAKEN) fresh.taken.splice(0, fresh.taken.length - KEEP_TAKEN);
                    if (reason) {
                        pushDropped(fresh, {
                            id: card.id,
                            entityName: card.entityName,
                            value: card.value,
                            reason,
                            sourceMessage: card.sourceMessage,
                            at: Date.now(),
                        });
                    }
                    return true;
                });
                if (reason) this.log.info(`revision outfit card dropped (${reason}): ${card.entityName}`);
            }
            if (done && typeof revision.dismissDeferred === 'function') {
                try {
                    await revision.dismissDeferred(card.id);
                } catch (error) {
                    this.log.warn('deferred outfit card was not dismissed', error);
                }
            }
        }
        this.emitChange();
    }

    /* ---------------------------------------------------------------- the chat document */

    private cached(): WardrobeDoc | null {
        const chatId = this.app.host.chatId();
        if (!chatId) return null;
        if (this.docChat !== chatId || !this.doc) {
            void this.loadDoc().catch(() => undefined);
            return null;
        }
        return this.doc;
    }

    async loadDoc(): Promise<WardrobeDoc> {
        const chatId = this.app.host.chatId();
        if (!chatId) return emptyWardrobeDoc();
        if (this.docChat === chatId && this.doc) return this.doc;
        if (this.loading && this.docChat === chatId) return this.loading;
        this.docChat = chatId;
        const loading = this.app.chat
            .get<WardrobeDoc>(WARDROBE_DOC, emptyWardrobeDoc)
            .then((doc) => {
                const ready = normalizeWardrobeDoc(doc);
                if (this.app.host.chatId() === chatId && this.docChat === chatId) {
                    this.doc = ready;
                    this.emitChange();
                }
                return ready;
            })
            .finally(() => {
                if (this.loading === loading) this.loading = null;
            });
        this.loading = loading;
        return loading;
    }

    /** Compare-and-swap write: re-read, change, put; a newer version from another tab is re-read and changed again. */
    private async mutate<R>(change: (doc: WardrobeDoc) => R | typeof NO_WRITE): Promise<R | undefined> {
        const chatId = this.app.host.chatId();
        if (!chatId) return undefined;
        for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
            const doc = normalizeWardrobeDoc(await this.app.chat.get<WardrobeDoc>(WARDROBE_DOC, emptyWardrobeDoc));
            if (this.app.host.chatId() !== chatId) return undefined;
            const result = change(doc);
            if (result === NO_WRITE) {
                this.adopt(doc, chatId);
                return undefined;
            }
            if (await this.app.chat.put(WARDROBE_DOC, doc)) {
                this.adopt(doc, chatId);
                return result;
            }
        }
        this.log.warn(`wardrobe document could not be saved after ${PUT_ATTEMPTS} attempts`);
        return undefined;
    }

    private adopt(doc: WardrobeDoc, chatId: string): void {
        if (this.app.host.chatId() !== chatId) return;
        this.doc = doc;
        this.docChat = chatId;
    }

    private enqueue<R>(job: () => Promise<R>): Promise<R> {
        const next = this.queue.then(job, job);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private emitChange(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('wardrobe listener failed', error);
            }
        }
    }
}
