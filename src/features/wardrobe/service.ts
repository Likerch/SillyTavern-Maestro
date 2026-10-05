// Wardrobe service (plan M27, §2.1, §8 «Наряды и состояния в паспортах уровня чата — Само», P14, P15):
// - outfits: the signals service's 'appearance.changed' (aspect 'outfit', already past the two-turn rule) and the
//   revision's 'deferred.outfit' statements (parked cards since stage 4 and the direct route intakeOutfit()) are
//   matched against the character's passport outfits (wordings seen before, concepts) → the known outfit is put on, or
//   a new named outfit (English tags from the wording) is added to the chat-level passport and put on;
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
import { committedIndices } from '../../domain/places-registry';
import { fieldAspect } from '../../domain/signals-diff';
import { textsDiffer } from '../../domain/signals-tokens';
import {
    dropOutfit,
    emptyWardrobeDoc,
    findOutfit,
    knowsWording,
    markUndone,
    normalizeWardrobeDoc,
    noteOutfit,
    pushHistory,
    recentHistory,
    KEEP_TAKEN,
} from '../../domain/wardrobe-doc';
import type { HistoryEntry, HistoryKind, OutfitOrigin, WardrobeDoc } from '../../domain/wardrobe-doc';
import { addedLooks, outfitWithLooks, withLook, withoutLooks } from '../../domain/wardrobe-looks';
import { matchOutfit, outfitScore } from '../../domain/wardrobe-match';
import type { OutfitLike } from '../../domain/wardrobe-match';
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
import { cleanOutfitText, outfitFromStatement, outfitName, outfitTagList } from '../../domain/wardrobe-tags';
import { normalizeName } from '../../domain/world-names';
import type { App, Decision, JournalChange, Logger, Proposal, Signal, Unsubscribe } from '../../shared/contracts';
import type { Place, PlacesApi } from '../places/api';
import type { DeferredCard, RevisionApi } from '../revision/api';
import type { Entity, EntitySource, WorldModelApi } from '../world/api';
import type { Outfit, OutfitIntake, StateChange, WardrobeApi } from './api';
import { WARDROBE_DOC, WARDROBE_ID, WARDROBE_KINDS, WARDROBE_UNDO_TARGET, WARDROBE_WEAR_KIND } from './settings';
import type { WardrobeSettings } from './settings';

export type WardrobeAction = 'outfit.create' | 'outfit.wear' | 'state' | 'place';

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

/** Two committed turns describe the same outfit (the signals' appearance threshold). */
const SAME_OUTFIT = 0.5;

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
        const appliers = Object.values(WARDROBE_KINDS).map((kind) => inbox.registerApplier(kind, apply, valid));
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
        this.emitChange();
        void this.open();
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
                    if (!outfit.name) continue;
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
        const wanted = String(outfit ?? '').trim();
        const found = wanted ? passport.outfits.find((item) => sameName(item.name, wanted)) : undefined;
        if (wanted && !found) throw new Error(this.t('m27.error.noOutfit', { name: wanted }));
        const name = found?.name ?? '';
        const before = passport.activeOutfit;
        if (sameName(before, name)) return;
        await api.setOutfit(passport.id, name, 'chat');
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
        return this.enqueue(() => this.intake(statement));
    }

    private async intake(statement: OutfitIntake): Promise<string | null> {
        if (!this.app.host.chatId() || !this.settings().outfits || this.app.host.isGroupChat()) return null;
        if (!statement || typeof statement.value !== 'string') return null;
        const text = outfitFromStatement(statement.value);
        if (!text) return null;
        return this.takeOutfit({
            name: typeof statement.entityName === 'string' ? statement.entityName : '',
            text,
            messageIndex: Number.isInteger(statement.sourceMessage) ? statement.sourceMessage : -1,
            origin: 'revision',
        });
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
            if (generation === this.generation) await this.takeOutfit(input);
        }).catch((error: unknown) => this.log.warn('wardrobe outfit failed', error));
    }

    /** Outfits of a passport to match against: named ones (most recently seen first), then the clothing slot. */
    private candidates(target: PassportTarget, doc: WardrobeDoc): OutfitLike[] {
        const named = target.passport.outfits
            .filter((outfit) => outfit.name)
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

    /** One outfit wording for a character: recognised and put on, or created; the outfit name, null when not taken. */
    private async takeOutfit(input: OutfitInput): Promise<string | null> {
        const wording = cleanOutfitText(input.text);
        if (!wording) return null;
        const target = this.resolveCharacter(input.name, input.entityId);
        if (!target) {
            this.log.debug(`wardrobe: no NAI passport for «${input.name}»`);
            return null;
        }
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
                if (input.origin === 'des' && match.name) await this.rememberLook(target, match.name, wording);
                this.emitChange();
                return match.name;
            }
            const payload = this.payload('outfit.wear', target, input, { name: match.name, wording });
            const matched = match.name
                ? passport.outfits.find((outfit) => sameName(outfit.name, match.name))
                : undefined;
            const looks = matched && input.origin === 'des' ? withLook(matched.looks, wording) : null;
            const title = match.name
                ? this.t('m27.proposal.wear', { name: target.name, outfit: match.name })
                : this.t('m27.proposal.clothing', { name: target.name });
            const tags = match.name
                ? (passport.outfits.find((outfit) => sameName(outfit.name, match.name))?.tags ?? '')
                : (passport.slots.clothing ?? '');
            const decision = await this.propose(WARDROBE_KINDS.outfit, payload, title, this.outfitBody(tags, wording), [
                this.outfitChange(
                    payload,
                    passport.activeOutfit,
                    match.name,
                    undefined,
                    looks ? { before: matched?.looks ?? [], after: looks } : undefined,
                ),
            ]);
            return taken(decision) ? match.name : null;
        }
        const tags = outfitTagList(wording);
        if (!tags.length) {
            this.log.debug(`wardrobe: no garment recognised in «${wording}»`);
            return null;
        }
        const name = outfitName(
            tags,
            passport.outfits.map((outfit) => outfit.name),
        );
        const tagText = tags.map((item) => item.tag).join(', ');
        const payload = this.payload('outfit.create', target, input, {
            name,
            tags: tagText,
            wording,
            activate: !stale,
        });
        const decision = await this.propose(
            WARDROBE_KINDS.outfit,
            payload,
            this.t('m27.proposal.create', { name: target.name, outfit: name }),
            this.outfitBody(tagText, wording),
            [this.outfitChange(payload, passport.activeOutfit, stale ? passport.activeOutfit : name, tagText)],
        );
        return taken(decision) ? name : null;
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

    private outfitBody(tags: string, wording: string): string {
        return this.t('m27.proposal.body.outfit', { tags: tags || '—', text: wording });
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
        return !!this.app.host.chatId() && !!this.naiApi() && this.passportOf(payload.passportId) !== null;
    }

    /* ---------------------------------------------------------------- applying */

    /** Writes a proposal into the passport (chat scope) and remembers it. */
    async apply(payload: WardrobePayload): Promise<void> {
        const api = this.naiApi();
        if (!api) throw new Error(this.t('m27.error.noNai'));
        const passport = this.passportOf(payload.passportId);
        if (!passport) throw new Error(this.t('m27.error.gone'));
        const owner = payload.owner ?? undefined;
        const name = payload.name ?? '';
        // The DES wording goes into the outfit's `looks` (a revision statement is Maestro's sentence, not DES's).
        const look = payload.origin === 'des' && payload.wording ? payload.wording : '';
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
                if (outfit && looks) {
                    // One save: the outfit put on and its new wording.
                    await api.savePassport(
                        { ...passport, outfits: withLooks(outfit, looks), activeOutfit: outfit.name },
                        'chat',
                        owner,
                    );
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
                const worn =
                    name && added.length ? passport.outfits.find((outfit) => sameName(outfit.name, name)) : undefined;
                const looks = worn ? withoutLooks(worn.looks, added) : null;
                if (worn && looks && looks.length !== (worn.looks ?? []).length) {
                    await api.savePassport(
                        {
                            ...passport,
                            outfits: passport.outfits.map((item) =>
                                item === worn ? outfitWithLooks(item, looks) : item,
                            ),
                            activeOutfit: putBack ? restore : passport.activeOutfit,
                        },
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
        if (index <= doc.lastIndex) return;
        const snapshot = this.tracker(index);
        await this.mutate((fresh) => {
            fresh.lastIndex = Math.max(fresh.lastIndex, index);
            return true;
        });
        if (!snapshot || generation !== this.generation) return;
        if (settings.outfits) await this.characterOutfits(snapshot, index);
        if (settings.states && generation === this.generation) await this.characterStates(snapshot, index);
        if (settings.places && generation === this.generation) await this.sceneStates(snapshot, index);
        this.emitChange();
    }

    /**
     * Outfits the signals never report: a character who enters the scene already dressed, or whose tracker gets an
     * outfit field mid-chat (the signals take a first value as the baseline). Same wording two committed turns in a
     * row, and no outfit of the passport was seen with it → the usual outfit path.
     */
    private async characterOutfits(snapshot: DesTrackerSnapshot, index: number): Promise<void> {
        const earlier = committedIndices(this.chat()).filter((item) => item < index);
        const previous = this.tracker(earlier[earlier.length - 1] ?? -1);
        if (!previous) return;
        const seen = new Set<string>();
        for (const character of snapshot.characters) {
            if (character.offScene) continue;
            const text = outfitTextOf(character.details);
            if (!text) continue;
            const before = previous.characters.find((item) => sameName(item.name, character.name));
            const last = before ? outfitTextOf(before.details) : '';
            if (!last || textsDiffer(last, text, SAME_OUTFIT)) continue;
            const target = this.resolveCharacter(character.name);
            if (!target || seen.has(target.passportId)) continue;
            seen.add(target.passportId);
            if (knowsWording(await this.loadDoc(), target.passportId, text)) continue;
            await this.takeOutfit({ name: character.name, text, messageIndex: index, origin: 'des' });
        }
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
                if (doc.lastIndex < index) return NO_WRITE;
                doc.lastIndex = index - 1;
                return true;
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
                const name = await this.intake({
                    entityName: card.entityName,
                    value: card.value,
                    evidence: card.evidence,
                    sourceMessage: card.sourceMessage,
                });
                if (name === null) continue;
                done = true;
                await this.mutate((fresh) => {
                    if (fresh.taken.includes(card.id)) return NO_WRITE;
                    fresh.taken.push(card.id);
                    if (fresh.taken.length > KEEP_TAKEN) fresh.taken.splice(0, fresh.taken.length - KEEP_TAKEN);
                    return true;
                });
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
