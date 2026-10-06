// M25 «Механики», the state part (plan M25 п. 4, 7; plan-2 §6; §2.1 «Механики: состояние — файл чата»; §4.10; P9,
// P14):
// - the values of every holder per mechanic, statuses and items per holder, revealed hidden attributes, the fight and
//   the story clock live in the chat document 'mechanics' (a Maestro file per chat) with the change log, the event
//   latches and the fired events (pending until the prompt part gives them to the model once). Writes are
//   read-modify-write on a fresh copy with the chat store's version check (other tabs);
// - apply() / applyOps(): holders are resolved per mechanic (persona, canonical character names through the world
//   model, named lists, factions, 'world', the fight's enemies), values validated and clamped by the domain,
//   threshold events fire with their actions and chains (bus signal 'mechanic.threshold'); the user's own edits are
//   journaled with an undo (target 'mechanics.value'; a reset as one batch, target 'mechanics.batch');
// - tracked changes (DES stats, the service block, the background parse, events, time) are written by the leader tab
//   only; the user's edits and checks from any tab. Group chats keep one state per chat like solo chats;
// - a committed reply's turn (processTurn, leader, once): the story clock follows DES's date and time
//   (domain/calendar-time), statuses tick and expire, time rules regenerate / decay, a fight goes to its next round;
// - holders in the scene: present characters (DES tracker, else the card / group), the persona, the fight's enemies;
//   factions and world mechanics only when named in the last messages (or the DES scene), changed lately, or pinned;
// - a swiped or deleted reply takes back every change from that message on (and the clock); an edit of the latest
//   committed reply takes back that reply's tracked changes (tracking derives them again), an edit of an older one
//   keeps them (plan §5 «Отмена»: confirmed things are not touched).
import { adaptersOf } from '../../adapters';
import { advanceClock } from '../../domain/calendar-time';
import { desSwipeRecord, parseDesCharacters } from '../../domain/des-tracker';
import type { DesCharacter } from '../../domain/des-tracker';
import { initialValueOf } from '../../domain/mechanics-defs';
import type { StatusSpec } from '../../domain/mechanics-defs';
import {
    applyOps,
    capStateDoc,
    checkModifierIds,
    emptyStateDoc,
    findAttribute,
    findChange,
    formatValue,
    initialValues,
    isRevealed,
    itemsOf,
    nameKey,
    normalizeStateDoc,
    publicChange,
    publicEvent,
    resetOps,
    resolveHolder,
    revertChange,
    rollbackFrom,
    rollbackMessage,
    rollbackWhere,
    statusesOf,
    storedHolderKey,
    TRACKED_SOURCES,
    valueReader,
    WORLD_HOLDER,
} from '../../domain/mechanics-state';
import type {
    ChangeRef,
    ClockRecord,
    HolderContext,
    LoggedChange,
    MechanicsStateDoc,
    OpInput,
    StoredEvent,
} from '../../domain/mechanics-state';
import { modifierSum } from '../../domain/mechanics-status';
import { turnOps } from '../../domain/mechanics-turn';
import { resolveVisibility, shownIn } from '../../domain/mechanics-visibility';
import { committedIndices } from '../../domain/places-registry';
import type { App, JournalChange, Unsubscribe } from '../../shared/contracts';
import type { DirectorApi } from '../director/api';
import type {
    AttributeValue,
    ChangeSource,
    CombatState,
    DerivedValue,
    FiredEvent,
    HolderState,
    ItemState,
    MechanicDef,
    MechanicsClock,
    MechanicsEvent,
    StateChange,
    StatusState,
    VisibilityPlace,
} from './api';
import { MECHANICS_ID } from './parts';
import type { ApplyOpsOptions, ChangeInput, DefinitionsPart, PartDeps, StateOp, StatePart } from './parts';
import { holderContextOf, isDict, personaOf, swipeIdOf, worldOf } from './state-holders';

export const STATE_DOC_KIND = 'mechanics';
export const VALUE_UNDO_TARGET = 'mechanics.value';
/** Journal target of changes made as one batch (a reset): ref {chatId, batch}. */
export const BATCH_UNDO_TARGET = 'mechanics.batch';
/** Journal kind of the user's own edits. */
export const SET_KIND = 'mechanics.set';
export const STATUS_KIND = 'mechanics.status';
export const ITEM_KIND = 'mechanics.item';
export const REVEAL_KIND = 'mechanics.reveal';
export const RESET_KIND = 'mechanics.reset';
export const UNDO_KIND = 'mechanics.undo';
export const THRESHOLD_SIGNAL = 'mechanic.threshold';

const PUT_ATTEMPTS = 3;
/** How far back the scene looks for the last DES tracker. */
const SCENE_LOOKBACK = 30;
/** Sources any tab may write (the user's own actions). */
const FREE_SOURCES: ReadonlySet<ChangeSource> = new Set(['user', 'check']);
/** Committed turns a changed faction or world mechanic stays relevant. */
const RECENT_TURNS = 3;

interface Mutation<R> {
    changed: boolean;
    result: R;
}

interface SceneCache {
    message: STChatMessage;
    swipeId: number;
    raw: unknown;
    characters: DesCharacter[];
}

interface MentionCache {
    key: string;
    text: string;
}

function copyValue(value: AttributeValue): AttributeValue {
    return Array.isArray(value) ? [...value] : value;
}

function unique(names: readonly string[]): string[] {
    const out: string[] = [];
    for (const name of names) {
        const trimmed = name.trim();
        if (trimmed && !out.some((item) => nameKey(item) === nameKey(trimmed))) out.push(trimmed);
    }
    return out;
}

/** A random number in [0, 1) from the platform's cryptographic source (Math.random where it is missing). */
function secureRng(): number {
    try {
        const buffer = new Uint32Array(1);
        globalThis.crypto.getRandomValues(buffer);
        return (buffer[0] as number) / 4294967296;
    } catch {
        return Math.random();
    }
}

/** Lower-case text with letters and digits only, spaces between: for name lookups. */
function plainText(text: string): string {
    return ` ${nameKey(text)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()} `;
}

/** The words of a name cut to stems (Russian case endings), for a mention in any case. */
function nameStems(name: string): string[] {
    return plainText(name)
        .trim()
        .split(' ')
        .filter((word) => word.length >= 3)
        .map((word) => (/[а-я]/.test(word) && word.length >= 6 ? word.slice(0, -2) : word));
}

export class MechanicState implements StatePart {
    private doc: MechanicsStateDoc | null = null;
    private docChat: string | null = null;
    private loading: { chatId: string; promise: Promise<MechanicsStateDoc | null> } | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private readonly listeners = new Set<() => void>();
    private readonly eventListeners = new Set<(event: MechanicsEvent) => void>();
    private readonly offs: Unsubscribe[] = [];
    /** Events this tab gave to the model before the write landed. */
    private readonly delivered = new Set<string>();
    private scene: SceneCache | null = null;
    private mentions: MentionCache | null = null;
    private seq = 0;
    private disposed = false;

    constructor(
        private readonly deps: PartDeps,
        private readonly defs: DefinitionsPart,
        private readonly rng: () => number = secureRng,
    ) {}

    private get app(): App {
        return this.deps.app;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(): void {
        const { bus, journal } = this.app;
        // Journal records outlive the module: undo keeps working when it is off.
        journal.registerUndo(VALUE_UNDO_TARGET, (change) => this.undo(change));
        journal.registerUndo(BATCH_UNDO_TARGET, (change) => this.undoBatch(change));
        this.offs.push(
            bus.on('chat:changed', () => this.onChatChanged()),
            bus.on('message:invalidated', ({ messageIndex, reason }) => this.onInvalidated(messageIndex, reason)),
            this.defs.onChange(() => this.emit()),
        );
        void this.load();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.log.debug('mechanics state: unsubscribe failed', error);
            }
        }
        this.listeners.clear();
        this.eventListeners.clear();
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    onEvent(listener: (event: MechanicsEvent) => void): Unsubscribe {
        this.eventListeners.add(listener);
        return () => this.eventListeners.delete(listener);
    }

    emitEvent(event: MechanicsEvent): void {
        for (const listener of [...this.eventListeners]) {
            try {
                listener(event);
            } catch (error) {
                this.deps.log.error('mechanics event listener failed', error);
            }
        }
    }

    /** Resolves when every write queued so far has finished (tracking waits for rollbacks before re-deriving). */
    settled(): Promise<void> {
        return this.chain.then(
            () => undefined,
            () => undefined,
        );
    }

    private onChatChanged(): void {
        this.doc = null;
        this.docChat = null;
        this.loading = null;
        this.scene = null;
        this.mentions = null;
        this.delivered.clear();
        this.emit();
        void this.load();
    }

    /* ---------------------------------------------------------------- the document */

    private peek(): MechanicsStateDoc | null {
        const chatId = this.app.host.chatId();
        if (!chatId) return null;
        if (chatId !== this.docChat || !this.doc) {
            void this.load();
            return null;
        }
        return this.doc;
    }

    /** The open chat's document, or an empty one while it loads. */
    private view(): MechanicsStateDoc {
        return this.peek() ?? emptyStateDoc();
    }

    /** Loads the open chat's document (cached until the chat changes). */
    load(): Promise<MechanicsStateDoc | null> {
        const chatId = this.app.host.chatId();
        if (!chatId || this.disposed) return Promise.resolve(null);
        if (this.docChat === chatId && this.doc) return Promise.resolve(this.doc);
        if (this.loading?.chatId === chatId) return this.loading.promise;
        const promise = this.app.chat
            .get<object>(STATE_DOC_KIND, emptyStateDoc)
            .then((raw) => {
                if (this.app.host.chatId() !== chatId) return null;
                if (this.docChat !== chatId || !this.doc) {
                    this.doc = normalizeStateDoc(structuredClone(raw));
                    this.docChat = chatId;
                    this.emit();
                }
                return this.doc;
            })
            .catch((error: unknown) => {
                this.deps.log.warn('mechanics: the state of this chat could not be loaded', error);
                return null;
            })
            .finally(() => {
                if (this.loading?.promise === promise) this.loading = null;
            });
        this.loading = { chatId, promise };
        return promise;
    }

    /** Read-modify-write on a fresh copy, serialised; undefined when there is no chat or saving failed. */
    private mutate<R>(change: (doc: MechanicsStateDoc) => Mutation<R>): Promise<R | undefined> {
        const job = async (): Promise<R | undefined> => {
            const chatId = this.app.host.chatId();
            if (!chatId) return undefined;
            for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
                const live = await this.app.chat.get<object>(STATE_DOC_KIND, emptyStateDoc);
                if (this.app.host.chatId() !== chatId) return undefined;
                const doc = normalizeStateDoc(structuredClone(live));
                const outcome = change(doc);
                if (!outcome.changed) {
                    this.adopt(chatId, doc);
                    return outcome.result;
                }
                if (this.app.host.chatId() !== chatId) return undefined;
                if (await this.app.chat.put(STATE_DOC_KIND, doc)) {
                    this.adopt(chatId, doc);
                    return outcome.result;
                }
                this.deps.log.info('mechanics: the state was changed in another tab; retrying on the fresh copy');
            }
            this.deps.log.error('mechanics: the state could not be saved');
            return undefined;
        };
        const next = this.chain.then(job, job);
        this.chain = next.catch(() => undefined);
        return next;
    }

    private adopt(chatId: string, doc: MechanicsStateDoc): void {
        if (this.app.host.chatId() !== chatId) return;
        this.doc = doc;
        this.docChat = chatId;
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.deps.log.error('mechanics state listener failed', error);
            }
        }
    }

    private newId(): string {
        return `mch-${Date.now().toString(36)}-${(++this.seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
    }

    private getDef = (id: string): MechanicDef | null => {
        try {
            return this.defs.get(id);
        } catch {
            return null;
        }
    };

    private activeDefs(): MechanicDef[] {
        try {
            return this.defs.active();
        } catch (error) {
            this.deps.log.debug('mechanics: definitions are not readable', error);
            return [];
        }
    }

    private holderContext(doc?: MechanicsStateDoc | null): HolderContext {
        const context = holderContextOf(this.app);
        const combat = (doc ?? this.peek())?.combat;
        if (combat?.active) context.extra = combat.order.map((item) => item.holder);
        return context;
    }

    /* ---------------------------------------------------------------- reading */

    state(holder?: string): HolderState[] {
        if (!this.app.host.chatId()) return [];
        const doc = this.peek();
        const reader = doc ? valueReader(doc, this.getDef) : null;
        const wanted = holder === undefined ? null : nameKey(holder);
        const out: HolderState[] = [];
        const seen = new Set<string>();
        const withDerived = (def: MechanicDef | null, name: string, values: Record<string, AttributeValue>) => {
            for (const attr of def?.attributes ?? []) {
                if (!attr.formula) continue;
                const value = reader?.raw(def?.id ?? '', name, attr.id);
                if (value !== null && value !== undefined) values[attr.id] = value;
            }
            return values;
        };
        for (const [mechanicId, holders] of Object.entries(doc?.holders ?? {})) {
            const def = this.getDef(mechanicId);
            for (const [name, stored] of Object.entries(holders)) {
                if (wanted !== null && nameKey(name) !== wanted) continue;
                seen.add(`${mechanicId}|${nameKey(name)}`);
                const values: Record<string, AttributeValue> = def ? initialValues(def) : {};
                for (const [attribute, value] of Object.entries(stored.values)) values[attribute] = copyValue(value);
                out.push({
                    mechanicId,
                    holder: name,
                    values: withDerived(def, name, values),
                    updatedAt: stored.updatedAt,
                });
            }
        }
        // Holders in the scene that never changed yet: their initial values.
        for (const def of this.activeDefs()) {
            for (const name of this.holdersInScene(def)) {
                const key = `${def.id}|${nameKey(name)}`;
                if ((wanted !== null && nameKey(name) !== wanted) || seen.has(key)) continue;
                seen.add(key);
                out.push({
                    mechanicId: def.id,
                    holder: name,
                    values: withDerived(def, name, initialValues(def)),
                    updatedAt: -1,
                });
            }
        }
        return out;
    }

    private storedKey(doc: MechanicsStateDoc, def: MechanicDef | null, mechanicId: string, holder: string): string {
        let key = storedHolderKey(doc, mechanicId, holder);
        if (!key && def) {
            const resolved = resolveHolder(def, holder, this.holderContext(doc));
            if (resolved) key = storedHolderKey(doc, mechanicId, resolved) ?? resolved;
        }
        return key ?? holder;
    }

    value(mechanicId: string, holder: string, attribute: string): AttributeValue | null {
        const def = this.getDef(mechanicId);
        const attr = def ? findAttribute(def, attribute) : null;
        const doc = this.peek();
        if (doc && attr?.formula) {
            return valueReader(doc, this.getDef).raw(mechanicId, this.storedKey(doc, def, mechanicId, holder), attr.id);
        }
        if (doc) {
            const key = this.storedKey(doc, def, mechanicId, holder);
            const stored = doc.holders[mechanicId]?.[key]?.values[attr?.id ?? attribute];
            if (stored !== undefined) return copyValue(stored);
        }
        return attr ? initialValueOf(attr) : null;
    }

    numberOf(mechanicId: string, holder: string, attribute: string): number | null {
        const doc = this.view();
        const def = this.getDef(mechanicId);
        return valueReader(doc, this.getDef).number(
            mechanicId,
            this.storedKey(doc, def, mechanicId, holder),
            attribute,
        );
    }

    checkBonus(def: MechanicDef, checkId: string, holder: string): number {
        const doc = this.view();
        return modifierSum(statusesOf(doc, holder), itemsOf(doc, holder), checkModifierIds(def, checkId)).total;
    }

    derived(mechanicId: string, holder: string): DerivedValue[] {
        const def = this.getDef(mechanicId);
        if (!def) return [];
        const doc = this.view();
        const key = this.storedKey(doc, def, mechanicId, holder);
        const reader = valueReader(doc, this.getDef);
        const out: DerivedValue[] = [];
        for (const attr of def.attributes) {
            if (attr.kind !== 'number') continue;
            const breakdown = reader.breakdown(def.id, key, attr.id);
            if (!breakdown) continue;
            const value: DerivedValue = {
                mechanicId: def.id,
                holder: key,
                attribute: attr.id,
                base: breakdown.base,
                value: breakdown.value,
                parts: breakdown.parts,
            };
            if (attr.formula) value.formula = attr.formula;
            if (breakdown.missing) value.missing = breakdown.missing;
            out.push(value);
        }
        return out;
    }

    statuses(holder?: string): { holder: string; statuses: StatusState[] }[] {
        const doc = this.view();
        return Object.entries(doc.statuses)
            .filter(([name]) => holder === undefined || nameKey(name) === nameKey(holder))
            .map(([name, list]) => ({ holder: name, statuses: structuredClone(list) as StatusState[] }));
    }

    items(holder?: string): { holder: string; items: ItemState[] }[] {
        const doc = this.view();
        return Object.entries(doc.items)
            .filter(([name]) => holder === undefined || nameKey(name) === nameKey(holder))
            .map(([name, list]) => ({ holder: name, items: structuredClone(list) as ItemState[] }));
    }

    combat(): CombatState | null {
        const combat = this.peek()?.combat;
        return combat ? (structuredClone(combat) as CombatState) : null;
    }

    clock(): MechanicsClock | null {
        const clock = this.peek()?.clock;
        if (!clock) return null;
        const out: MechanicsClock = { day: clock.day, label: clock.label };
        if (clock.minutes !== undefined) out.minutes = clock.minutes;
        return out;
    }

    isRevealed(mechanicId: string, holder: string, attribute: string): boolean {
        return isRevealed(this.view(), mechanicId, holder, attribute);
    }

    history(limit = 50): StateChange[] {
        const log = this.peek()?.log ?? [];
        return log
            .slice(-Math.max(0, limit))
            .reverse()
            .map((change) => publicChange(change) as StateChange);
    }

    /** Whether the player may see a change in a place (hidden-unrevealed and secret attributes never). */
    private changeShown(doc: MechanicsStateDoc, change: LoggedChange, place: VisibilityPlace): boolean {
        const def = this.getDef(change.mechanicId);
        switch (change.kind) {
            case 'combat':
            case 'reveal':
                return true;
            case 'status':
            case 'item': {
                // Statuses and items show even in «book» (as icons and words); never those of hidden or secret ones.
                const owner = this.getDef(change.status?.mechanicId ?? change.mechanicId);
                if (!owner) return true;
                const preset = resolveVisibility(owner).preset;
                return preset !== 'secret' && preset !== 'hidden';
            }
            default: {
                const attr = def ? findAttribute(def, change.attribute) : null;
                if (!def || !attr) return false;
                const revealed = isRevealed(doc, def.id, change.holder, attr.id);
                return shownIn(resolveVisibility(def, attr), place, revealed);
            }
        }
    }

    changesOf(messageIndex: number, options: { place?: VisibilityPlace } = {}): StateChange[] {
        const doc = this.peek();
        if (!doc) return [];
        return doc.log
            .filter((change) => change.messageIndex === messageIndex)
            .filter((change) => !options.place || this.changeShown(doc, change, options.place))
            .map((change) => publicChange(change) as StateChange);
    }

    events(limit = 20): FiredEvent[] {
        const fired = this.peek()?.fired ?? [];
        return fired
            .slice(-Math.max(0, limit))
            .reverse()
            .map((event) => publicEvent(event));
    }

    pendingEvents(): FiredEvent[] {
        return (this.peek()?.fired ?? [])
            .filter((event) => !event.delivered && !this.delivered.has(event.id))
            .map((event) => publicEvent(event));
    }

    async markEventsDelivered(events: FiredEvent[]): Promise<void> {
        const doc = this.peek();
        if (!doc || !events.length) return;
        const same = (stored: StoredEvent, event: FiredEvent) =>
            stored.mechanicId === event.mechanicId &&
            stored.eventId === event.eventId &&
            stored.attribute === event.attribute &&
            stored.at === event.at &&
            stored.messageIndex === event.messageIndex &&
            nameKey(stored.holder) === nameKey(event.holder);
        const ids = doc.fired.filter((stored) => events.some((event) => same(stored, event))).map((item) => item.id);
        if (!ids.length) return;
        for (const id of ids) this.delivered.add(id);
        await this.mutate((fresh) => {
            let changed = false;
            for (const event of fresh.fired) {
                if (ids.includes(event.id) && !event.delivered) {
                    event.delivered = true;
                    changed = true;
                }
            }
            return { changed, result: undefined };
        });
    }

    /* ---------------------------------------------------------------- the scene */

    /** Present characters of the last DES tracker (not off-scene, canonical names); null without one. */
    private trackerCharacters(): string[] | null {
        let des: { present(): boolean } | undefined;
        try {
            des = adaptersOf(this.app).des;
        } catch {
            des = undefined;
        }
        if (!des || !safe(() => des.present(), false)) return null;
        const chat = this.app.host.ctx().chat;
        for (let i = chat.length - 1; i >= 0 && i >= chat.length - SCENE_LOOKBACK; i--) {
            const message = chat[i];
            if (!message || message.is_user || message.is_system) continue;
            const record = desSwipeRecord(message);
            if (!record) continue;
            const swipeId = swipeIdOf(message);
            const cached = this.scene;
            let characters: DesCharacter[];
            if (
                cached &&
                cached.message === message &&
                cached.swipeId === swipeId &&
                cached.raw === record.characterThoughts
            ) {
                characters = cached.characters;
            } else {
                characters = parseDesCharacters(record.characterThoughts);
                this.scene = { message, swipeId, raw: record.characterThoughts, characters };
            }
            return characters.filter((character) => !character.offScene).map((character) => character.name);
        }
        return null;
    }

    /** Without a DES tracker: the card's character, or the group's members. */
    private fallbackCharacters(): string[] {
        const ctx = this.app.host.ctx();
        if (this.app.host.isGroupChat()) {
            const group = (ctx.groups ?? []).find((item) => item.id === ctx.groupId);
            return (group?.members ?? [])
                .map((avatar) => ctx.characters.find((character) => character.avatar === avatar)?.name ?? '')
                .filter(Boolean);
        }
        return ctx.name2 ? [ctx.name2] : [];
    }

    private presentCharacters(): string[] {
        const names = this.trackerCharacters() ?? this.fallbackCharacters();
        const world = worldOf(this.app);
        return unique(
            names.map((name) => {
                try {
                    return world?.resolve(name, 'character')?.name ?? name;
                } catch {
                    return name;
                }
            }),
        );
    }

    /** The last messages (and DES's scene fields) as plain text, cached per chat length and last text. */
    private recentText(): string {
        const chat = this.app.host.ctx().chat ?? [];
        const window = Math.max(1, this.deps.settings().relevance ?? 4);
        const last = chat[chat.length - 1];
        const key = `${this.app.host.chatId() ?? ''}|${chat.length}|${typeof last?.mes === 'string' ? last.mes.length : 0}|${swipeIdOf(last)}|${window}`;
        if (this.mentions?.key === key) return this.mentions.text;
        const parts: string[] = [];
        for (let i = Math.max(0, chat.length - window); i < chat.length; i++) {
            const message = chat[i];
            if (!message || message.is_system || typeof message.mes !== 'string') continue;
            parts.push(message.mes);
            const record = desSwipeRecord(message);
            if (record?.infoBox && typeof record.infoBox === 'string') parts.push(record.infoBox);
        }
        const text = plainText(parts.join(' ').slice(-20000));
        this.mentions = { key, text };
        return text;
    }

    /** A name (or its forms from the world model) occurs in the last messages. */
    private mentioned(name: string): boolean {
        const text = this.recentText();
        const candidates = [name];
        try {
            const entity = worldOf(this.app)?.resolve(name);
            if (entity) candidates.push(entity.name, ...entity.aliases, ...entity.forms);
        } catch {
            // the name alone
        }
        return candidates.some((candidate) => {
            const stems = nameStems(candidate);
            return stems.length > 0 && stems.every((stem) => text.includes(` ${stem}`));
        });
    }

    /** The holder changed in the last few committed turns (its consequences may still matter). */
    private recentlyChanged(def: MechanicDef, holder: string): boolean {
        const doc = this.peek();
        if (!doc) return false;
        const committed = committedIndices(this.app.host.ctx().chat ?? []);
        const floor = committed[Math.max(0, committed.length - RECENT_TURNS)] ?? 0;
        const key = storedHolderKey(doc, def.id, holder);
        const updated = key ? (doc.holders[def.id]?.[key]?.updatedAt ?? -1) : -1;
        return updated >= floor && updated >= 0;
    }

    holdersInScene(def: MechanicDef): string[] {
        const persona = personaOf(this.app);
        const context = holderContextOf(this.app);
        const isPersona = (name: string) => !!persona && nameKey(name) === nameKey(persona);
        switch (def.holders.kind) {
            case 'persona':
                return persona ? [persona] : [];
            case 'world': {
                if (def.pinned || this.recentlyChanged(def, WORLD_HOLDER)) return [WORLD_HOLDER];
                const words = [def.name, def.promptName ?? '', ...(def.keys ?? [])].filter((word) => word.trim());
                return words.some((word) => this.mentioned(word)) ? [WORLD_HOLDER] : [];
            }
            case 'factions':
                return unique(
                    def.holders.names.filter(
                        (name) => def.pinned || this.mentioned(name) || this.recentlyChanged(def, name),
                    ),
                );
            case 'characters': {
                const out = this.presentCharacters().filter((name) => !isPersona(name));
                if (def.holders.includePersona && persona) out.push(persona);
                return unique([...out, ...this.fighters(def)]);
            }
            case 'named': {
                const present = [...this.presentCharacters(), ...(persona ? [persona] : [])];
                return unique(
                    def.holders.names.filter((name) => {
                        let canonical = name;
                        try {
                            canonical = context.canonical?.(name) ?? name;
                        } catch {
                            canonical = name;
                        }
                        return present.some(
                            (item) => nameKey(item) === nameKey(name) || nameKey(item) === nameKey(canonical),
                        );
                    }),
                );
            }
        }
    }

    /** Combatants of a fight this character mechanic runs (or any fight, for mechanics with combat stats). */
    private fighters(def: MechanicDef): string[] {
        const combat = this.peek()?.combat;
        if (!combat?.active) return [];
        if (combat.mechanicId !== def.id && !def.combat) return [];
        const persona = personaOf(this.app);
        return combat.order
            .filter(
                (item) =>
                    !item.out &&
                    (def.holders.kind !== 'characters' ||
                        def.holders.includePersona ||
                        nameKey(item.holder) !== nameKey(persona)),
            )
            .map((item) => item.holder);
    }

    /* ---------------------------------------------------------------- applying */

    async apply(changes: ChangeInput[]): Promise<StateChange[]> {
        return this.applyOps(changes);
    }

    /** The holder an operation names, resolved for its mechanic; null when it has no such holder. */
    private resolveOp(op: StateOp, context: HolderContext): StateOp | null {
        if (op.kind === 'clock' || (op.kind === 'combat' && op.op === 'set')) return op;
        const def = this.getDef(op.mechanicId);
        if (op.kind === undefined || op.kind === 'value') {
            if (!def) return op;
            const holder = resolveHolder(def, op.holder, context);
            return holder ? { ...op, holder } : null;
        }
        if (op.kind === 'reveal' && op.holder === '*') return op;
        if (!def) return op.holder.trim() ? op : null;
        const holder = resolveHolder(def, op.holder, context);
        return holder ? ({ ...op, holder } as StateOp) : null;
    }

    async applyOps(ops: StateOp[], options: ApplyOpsOptions = {}): Promise<StateChange[]> {
        if (this.disposed || !ops.length) return [];
        const byUser = ops.every((op) => op.source === 'user');
        const chatId = this.app.host.chatId();
        if (!chatId) {
            if (byUser) throw new Error(this.t('m25.state.error.noChat'));
            return [];
        }
        const leader = safe(() => this.app.leader.isLeader(), false);
        const context = this.holderContext();
        const accepted: OpInput[] = [];
        const rejected: { input: OpInput; reason: string }[] = [];
        for (const op of ops) {
            if (!leader && !FREE_SOURCES.has(op.source)) {
                rejected.push({ input: op, reason: 'leader' });
                continue;
            }
            if (op.kind !== 'clock' && !(op.kind === 'combat' && op.op === 'set') && !this.getDef(op.mechanicId)) {
                if (op.kind === undefined || op.kind === 'value' || op.kind === 'reveal') {
                    rejected.push({ input: op, reason: 'mechanic' });
                    continue;
                }
            }
            const resolved = this.resolveOp(op, context);
            if (!resolved) {
                rejected.push({ input: op, reason: 'holder' });
                continue;
            }
            accepted.push(resolved);
        }
        const result = accepted.length
            ? await this.mutate((doc) => {
                  const outcome = applyOps(doc, accepted, {
                      getDef: this.getDef,
                      now: Date.now(),
                      newId: () => this.newId(),
                      holders: this.holderContext(doc),
                      catalogue: this.catalogue(),
                      rng: this.rng,
                      clock: doc.clock,
                  });
                  capStateDoc(doc);
                  const changed = outcome.applied.length > 0 || accepted.some((op) => op.kind === 'clock');
                  return { changed, result: outcome };
              })
            : undefined;
        if (result) rejected.push(...result.rejected);
        if (rejected.length) {
            this.deps.log.debug(
                `mechanics: ${rejected.length} changes rejected`,
                rejected.map((item) => `${'holder' in item.input ? item.input.holder : ''}: ${item.reason}`),
            );
        }
        const applied = (result?.applied ?? []).map((change) => publicChange(change) as StateChange);
        if (applied.length) {
            for (const event of result?.fired ?? []) this.signal(event, chatId);
            // The user's own changes always; others (a fight the director started) when asked.
            const journaled =
                options.journal === true
                    ? applied
                    : options.journal === false
                      ? []
                      : applied.filter((c) => c.source === 'user');
            if (journaled.length) await this.journalUser(journaled, chatId, options.kind);
            this.emit();
            const index = applied[0]?.messageIndex ?? -1;
            this.emitEvent({ type: 'changes', changes: applied, messageIndex: index });
            for (const event of result?.fired ?? []) this.emitEvent({ type: 'event', event: publicEvent(event) });
            if (applied.some((change) => change.kind === 'combat'))
                this.emitEvent({ type: 'combat', combat: this.combat() });
        }
        if (byUser && !applied.length && !result?.unchanged.length && rejected.length) {
            const reason = rejected[0]?.reason ?? 'value';
            const known = ['mechanic', 'attribute', 'holder', 'leader'].includes(reason) ? reason : 'value';
            throw new Error(this.t('m25.state.error.rejected', { reason: this.t(`m25.state.reject.${known}`) }));
        }
        return applied;
    }

    /** Statuses of every active mechanic: a status named in a block finds its duration and modifiers there. */
    private catalogue(): StatusSpec[] {
        return this.activeDefs().flatMap((def) => def.statuses ?? []);
    }

    private signal(event: StoredEvent, chatId: string): void {
        void this.app.bus
            .emit('signal', {
                kind: THRESHOLD_SIGNAL,
                chatId,
                ...(event.messageIndex >= 0 ? { messageIndex: event.messageIndex } : {}),
                entity: event.holder,
                data: {
                    mechanicId: event.mechanicId,
                    holder: event.holder,
                    attribute: event.attribute,
                    eventId: event.eventId,
                    text: event.text,
                },
                at: event.at,
            })
            .catch((error: unknown) => this.deps.log.warn('mechanics: threshold signal failed', error));
    }

    /** Display name of a holder ('world' is translated). */
    holderLabel(holder: string): string {
        return holder === WORLD_HOLDER ? this.t('m25.state.holder.world') : holder;
    }

    private changeLine(change: StateChange): string {
        const def = this.getDef(change.mechanicId);
        const holder = this.holderLabel(change.holder);
        switch (change.kind) {
            case 'status':
                return change.to === ''
                    ? this.t('m25.state.journal.statusOff', {
                          holder,
                          status: change.status?.name ?? String(change.from),
                      })
                    : this.t('m25.state.journal.statusOn', {
                          holder,
                          status: change.status?.name ?? String(change.to),
                      });
            case 'item':
                return this.t('m25.state.journal.item', {
                    holder,
                    item: change.item?.name ?? '',
                    from: formatValue(change.from),
                    to: formatValue(change.to),
                });
            case 'reveal':
                return this.t('m25.state.journal.reveal', {
                    holder,
                    attribute: (def ? findAttribute(def, change.attribute)?.name : undefined) ?? change.attribute,
                });
            case 'combat':
                return this.t('m25.state.journal.combat', {
                    from: formatValue(change.from),
                    to: formatValue(change.to),
                });
            default: {
                const attr = def ? findAttribute(def, change.attribute) : null;
                return this.t('m25.state.journal.set', {
                    holder,
                    attribute: attr?.name ?? change.attribute,
                    value: formatValue(change.to),
                });
            }
        }
    }

    private async journalUser(changes: StateChange[], chatId: string, kind?: string): Promise<void> {
        if (!changes.length) return;
        const first = changes[0] as StateChange;
        const summary =
            changes.length === 1
                ? this.changeLine(first)
                : this.t('m25.state.journal.setMany', { count: changes.length });
        const journalKind =
            kind ??
            (first.kind === 'status'
                ? STATUS_KIND
                : first.kind === 'item'
                  ? ITEM_KIND
                  : first.kind === 'reveal'
                    ? REVEAL_KIND
                    : SET_KIND);
        try {
            await this.app.journal.record({
                module: MECHANICS_ID,
                kind: journalKind,
                summary,
                changes: changes.map((change): JournalChange => ({
                    target: VALUE_UNDO_TARGET,
                    ref: {
                        chatId,
                        changeId: change.id,
                        mechanicId: change.mechanicId,
                        holder: change.holder,
                        attribute: change.attribute,
                    },
                    before: change.from,
                    after: change.to,
                })),
            });
        } catch (error) {
            this.deps.log.error('mechanics: a value was changed but not journaled', error);
        }
    }

    /* ---------------------------------------------------------------- the turn: clock, statuses, time, fight */

    /** DES's date and time of a committed reply (null without one). */
    private observedTime(index: number): { date?: string; start?: string; end?: string } | null {
        try {
            const des = adaptersOf(this.app).des as unknown as {
                present(): boolean;
                trackerFor?(
                    index: number,
                ): { infoBox?: { date?: string; time?: { start?: string; end?: string } } | null } | null;
            };
            if (!des?.present() || typeof des.trackerFor !== 'function') return null;
            const box = des.trackerFor(index)?.infoBox;
            if (!box) return null;
            const observed: { date?: string; start?: string; end?: string } = {};
            if (box.date) observed.date = box.date;
            if (box.time?.start) observed.start = box.time.start;
            if (box.time?.end) observed.end = box.time.end;
            return observed;
        } catch (error) {
            this.deps.log.debug('mechanics: the DES time is not readable', error);
            return null;
        }
    }

    private restScene(): boolean {
        try {
            return this.app.modules.api<DirectorApi>('director')?.scene()?.type === 'timeskip';
        } catch {
            return false;
        }
    }

    async processTurn(index: number): Promise<void> {
        if (this.disposed || !Number.isInteger(index) || index < 0) return;
        if (!this.app.host.chatId() || !safe(() => this.app.leader.isLeader(), false)) return;
        const defs = this.activeDefs();
        const observed = this.observedTime(index);
        const restScene = this.restScene();
        const result = await this.mutate((doc) => {
            if (doc.lastTurn >= index) return { changed: false, result: null };
            const step = observed ? advanceClock(doc.clock, observed) : null;
            const clock: ClockRecord | null = step ? (step.clock as ClockRecord) : null;
            const { ops } = turnOps(
                doc,
                {
                    index,
                    clock,
                    defs,
                    holdersOf: (def) => (def.time?.length ? this.holdersInScene(def) : []),
                    restScene,
                    rng: this.rng,
                },
                this.getDef,
            );
            // Nothing moves (no clock, no statuses, no rules, no fight): no write on every turn.
            const moved = clock !== null && JSON.stringify(clock) !== JSON.stringify(doc.clock);
            if (ops.length <= 1 && !moved) return { changed: false, result: null };
            const outcome = applyOps(doc, ops, {
                getDef: this.getDef,
                now: Date.now(),
                newId: () => this.newId(),
                holders: this.holderContext(doc),
                catalogue: this.catalogue(),
                rng: this.rng,
                clock: doc.clock,
            });
            capStateDoc(doc);
            return { changed: true, result: outcome };
        });
        if (!result) return;
        const chatId = this.app.host.chatId();
        for (const event of result.fired) if (chatId) this.signal(event, chatId);
        this.emit();
        const applied = result.applied.map((change) => publicChange(change) as StateChange);
        if (applied.length) this.emitEvent({ type: 'changes', changes: applied, messageIndex: index });
        for (const event of result.fired) this.emitEvent({ type: 'event', event: publicEvent(event) });
        if (applied.some((change) => change.kind === 'combat'))
            this.emitEvent({ type: 'combat', combat: this.combat() });
    }

    /* ---------------------------------------------------------------- undo, reset and rollback */

    /** Journal undo of a change (the user's edit, or a background change applied through autonomy). */
    private async undo(change: JournalChange): Promise<boolean> {
        const ref = isDict(change.ref) ? change.ref : {};
        const chatId = this.app.host.chatId();
        if (!chatId || (typeof ref.chatId === 'string' && ref.chatId !== chatId)) return false;
        const locator: ChangeRef = {};
        if (typeof ref.changeId === 'string') locator.changeId = ref.changeId;
        if (typeof ref.mechanicId === 'string') locator.mechanicId = ref.mechanicId;
        if (typeof ref.holder === 'string') locator.holder = ref.holder;
        if (typeof ref.attribute === 'string') locator.attribute = ref.attribute;
        if (typeof ref.messageIndex === 'number') locator.messageIndex = ref.messageIndex;
        if (typeof ref.source === 'string') locator.source = ref.source as ChangeSource;
        if (!locator.changeId && !locator.mechanicId) return false;
        const outcome = await this.mutate((doc) => {
            const entry = findChange(doc, locator);
            // Already gone (its message was swiped or deleted): nothing is left to undo.
            if (!entry) return { changed: false, result: 'gone' as const };
            const done = revertChange(doc, entry, this.getDef);
            return { changed: done, result: done ? ('done' as const) : ('kept' as const) };
        });
        if (outcome === 'done') this.emit();
        return outcome === 'done' || outcome === 'gone';
    }

    /** Journal undo of a batch (a reset): every change of it, newest first. */
    private async undoBatch(change: JournalChange): Promise<boolean> {
        const ref = isDict(change.ref) ? change.ref : {};
        const chatId = this.app.host.chatId();
        if (!chatId || (typeof ref.chatId === 'string' && ref.chatId !== chatId)) return false;
        // A batch (a reset) or the consequences of one roll.
        const batch = typeof ref.batch === 'string' ? ref.batch : '';
        const rollId = typeof ref.rollId === 'string' ? ref.rollId : '';
        if (!batch && !rollId) return false;
        const removed = await this.mutate((doc) => {
            const out = rollbackWhere(
                doc,
                (item) => (batch ? item.batch === batch : item.rollId === rollId),
                this.getDef,
            );
            return { changed: out.length > 0, result: out };
        });
        if (removed?.length) {
            this.emit();
            this.emitEvent({ type: 'undone', changes: removed.map((item) => publicChange(item) as StateChange) });
        }
        return true;
    }

    async undoChange(changeId: string): Promise<boolean> {
        if (!this.app.host.chatId()) return false;
        const outcome = await this.mutate((doc) => {
            const entry = findChange(doc, { changeId });
            if (!entry) return { changed: false, result: null };
            const before = publicChange(entry) as StateChange;
            const done = revertChange(doc, entry, this.getDef);
            return { changed: done, result: done ? before : null };
        });
        if (!outcome) return false;
        this.emit();
        this.emitEvent({ type: 'undone', changes: [outcome] });
        try {
            await this.app.journal.record({
                module: MECHANICS_ID,
                kind: UNDO_KIND,
                summary: this.t('m25.state.journal.undone', { line: this.changeLine(outcome) }),
                changes: [],
            });
        } catch (error) {
            this.deps.log.warn('mechanics: the undo was not journaled', error);
        }
        return true;
    }

    async undoWhere(
        match: (change: StateChange) => boolean,
        journal?: { kind: string; summary: string },
    ): Promise<StateChange[]> {
        if (!this.app.host.chatId()) return [];
        const removed = await this.mutate((doc) => {
            const out = rollbackWhere(doc, (item) => match(publicChange(item) as StateChange), this.getDef);
            return { changed: out.length > 0, result: out };
        });
        const changes = (removed ?? []).map((item) => publicChange(item) as StateChange);
        if (!changes.length) return [];
        this.emit();
        this.emitEvent({ type: 'undone', changes });
        if (journal) {
            try {
                await this.app.journal.record({ module: MECHANICS_ID, ...journal, changes: [] });
            } catch (error) {
                this.deps.log.warn('mechanics: the undo was not journaled', error);
            }
        }
        return changes;
    }

    async reset(target: { mechanicId?: string; holder?: string }): Promise<number> {
        const chatId = this.app.host.chatId();
        if (!chatId) throw new Error(this.t('m25.state.error.noChat'));
        const batch = `reset-${this.newId()}`;
        const result = await this.mutate((doc) => {
            const ops = resetOps(doc, this.getDef, target, { source: 'user', messageIndex: -1, batch });
            const outcome = applyOps(doc, ops, {
                getDef: this.getDef,
                now: Date.now(),
                newId: () => this.newId(),
                holders: this.holderContext(doc),
                catalogue: this.catalogue(),
            });
            capStateDoc(doc);
            return { changed: outcome.applied.length > 0, result: outcome };
        });
        const applied = result?.applied ?? [];
        if (!applied.length) return 0;
        this.emit();
        this.emitEvent({
            type: 'changes',
            changes: applied.map((change) => publicChange(change) as StateChange),
            messageIndex: -1,
        });
        const def = target.mechanicId ? this.getDef(target.mechanicId) : null;
        const what = def?.name ?? (target.holder ? this.holderLabel(target.holder) : this.t('m25.state.reset.all'));
        try {
            await this.app.journal.record({
                module: MECHANICS_ID,
                kind: RESET_KIND,
                summary: this.t('m25.state.journal.reset', { what, count: applied.length }),
                changes: [
                    {
                        target: BATCH_UNDO_TARGET,
                        ref: { chatId, batch, ...(target.mechanicId ? { mechanicId: target.mechanicId } : {}) },
                        before: { count: applied.length },
                        after: null,
                    },
                ],
            });
        } catch (error) {
            this.deps.log.error('mechanics: the reset was not journaled', error);
        }
        return applied.length;
    }

    /** The edited message is the latest committed reply (or a later, uncommitted one). */
    private reopens(index: number): boolean {
        const committed = committedIndices(this.app.host.ctx().chat);
        const last = committed[committed.length - 1];
        return last === undefined || index >= last;
    }

    private onInvalidated(index: number, reason: 'swiped' | 'deleted' | 'edited'): void {
        if (this.disposed || !Number.isInteger(index) || index < 0) return;
        if (!this.app.host.chatId() || !safe(() => this.app.leader.isLeader(), false)) return;
        if (reason === 'edited' && !this.reopens(index)) return;
        void this.mutate((doc) => {
            const lastTurn = doc.lastTurn;
            const removed =
                reason === 'edited'
                    ? rollbackMessage(doc, index, TRACKED_SOURCES, this.getDef)
                    : rollbackFrom(doc, index, this.getDef);
            return { changed: removed.length > 0 || doc.lastTurn !== lastTurn, result: removed };
        })
            .then((removed) => {
                if (!removed?.length) return;
                this.deps.log.debug(`mechanics: ${removed.length} changes of message #${index} taken back (${reason})`);
                this.emit();
                this.emitEvent({ type: 'undone', changes: removed.map((item) => publicChange(item) as StateChange) });
            })
            .catch((error: unknown) => this.deps.log.warn('mechanics: rollback failed', error));
    }
}

function safe<T>(run: () => T, fallback: T): T {
    try {
        return run();
    } catch {
        return fallback;
    }
}
