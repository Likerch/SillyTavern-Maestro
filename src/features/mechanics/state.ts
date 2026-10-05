// M25 «Механики», the state part (plan M25 п. 4, 7; §2.1 «Механики: состояние — файл чата»; §4.10; P9, P14):
// - the values of every holder per mechanic live in the chat document 'mechanics' (a Maestro file per chat) with the
//   change log, the event latches and the fired threshold events (pending until the prompt part gives them to the
//   model once). Writes are read-modify-write on a fresh copy with the chat store's version check (other tabs);
// - apply(): holders are resolved per mechanic (persona, canonical character names through the world model, named
//   lists, factions, 'world'), values validated and clamped by the domain, threshold events fire (bus signal
//   'mechanic.threshold'); the user's own edits are journaled with an undo (target 'mechanics.value');
// - tracked changes (DES stats, the service block, the background parse, events) are written by the leader tab only;
//   the user's edits and checks from any tab. Group chats keep one state per chat like solo chats;
// - a swiped or deleted reply takes back every change from that message on; an edit of the latest committed reply
//   takes back that reply's tracked changes (tracking derives them again), an edit of an older one keeps them
//   (plan §5 «Отмена»: confirmed things are not touched).
import { adaptersOf } from '../../adapters';
import { desSwipeRecord, parseDesCharacters } from '../../domain/des-tracker';
import type { DesCharacter } from '../../domain/des-tracker';
import { initialValueOf } from '../../domain/mechanics-defs';
import {
    applyChanges,
    capStateDoc,
    emptyStateDoc,
    findAttribute,
    findChange,
    formatValue,
    initialValues,
    nameKey,
    normalizeStateDoc,
    publicChange,
    publicEvent,
    resolveHolder,
    revertChange,
    rollbackFrom,
    rollbackMessage,
    storedHolderKey,
    TRACKED_SOURCES,
    WORLD_HOLDER,
} from '../../domain/mechanics-state';
import type { ChangeInputData, ChangeRef, MechanicsStateDoc, StoredEvent } from '../../domain/mechanics-state';
import { committedIndices } from '../../domain/places-registry';
import type { App, JournalChange, Unsubscribe } from '../../shared/contracts';
import type { AttributeValue, ChangeSource, FiredEvent, HolderState, MechanicDef, StateChange } from './api';
import { MECHANICS_ID } from './parts';
import type { ChangeInput, DefinitionsPart, PartDeps, StatePart } from './parts';
import { holderContextOf, isDict, personaOf, swipeIdOf, worldOf } from './state-holders';

export const STATE_DOC_KIND = 'mechanics';
export const VALUE_UNDO_TARGET = 'mechanics.value';
/** Journal kind of the user's own edits. */
export const SET_KIND = 'mechanics.set';
export const THRESHOLD_SIGNAL = 'mechanic.threshold';

const PUT_ATTEMPTS = 3;
/** How far back the scene looks for the last DES tracker. */
const SCENE_LOOKBACK = 30;
/** Sources any tab may write (the user's own actions). */
const FREE_SOURCES: ReadonlySet<ChangeSource> = new Set(['user', 'check']);

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

export class MechanicState implements StatePart {
    private doc: MechanicsStateDoc | null = null;
    private docChat: string | null = null;
    private loading: { chatId: string; promise: Promise<MechanicsStateDoc | null> } | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private readonly listeners = new Set<() => void>();
    private readonly offs: Unsubscribe[] = [];
    /** Events this tab gave to the model before the write landed. */
    private readonly delivered = new Set<string>();
    private scene: SceneCache | null = null;
    private seq = 0;
    private disposed = false;

    constructor(
        private readonly deps: PartDeps,
        private readonly defs: DefinitionsPart,
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
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
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

    /* ---------------------------------------------------------------- reading */

    state(holder?: string): HolderState[] {
        if (!this.app.host.chatId()) return [];
        const doc = this.peek();
        const wanted = holder === undefined ? null : nameKey(holder);
        const out: HolderState[] = [];
        const seen = new Set<string>();
        for (const [mechanicId, holders] of Object.entries(doc?.holders ?? {})) {
            const def = this.getDef(mechanicId);
            for (const [name, stored] of Object.entries(holders)) {
                if (wanted !== null && nameKey(name) !== wanted) continue;
                seen.add(`${mechanicId}|${nameKey(name)}`);
                const values: Record<string, AttributeValue> = def ? initialValues(def) : {};
                for (const [attribute, value] of Object.entries(stored.values)) values[attribute] = copyValue(value);
                out.push({ mechanicId, holder: name, values, updatedAt: stored.updatedAt });
            }
        }
        // Holders in the scene that never changed yet: their initial values.
        for (const def of this.activeDefs()) {
            for (const name of this.holdersInScene(def)) {
                const key = `${def.id}|${nameKey(name)}`;
                if ((wanted !== null && nameKey(name) !== wanted) || seen.has(key)) continue;
                seen.add(key);
                out.push({ mechanicId: def.id, holder: name, values: initialValues(def), updatedAt: -1 });
            }
        }
        return out;
    }

    value(mechanicId: string, holder: string, attribute: string): AttributeValue | null {
        const def = this.getDef(mechanicId);
        const attr = def ? findAttribute(def, attribute) : null;
        const doc = this.peek();
        if (doc) {
            let key = storedHolderKey(doc, mechanicId, holder);
            if (!key && def) {
                const resolved = resolveHolder(def, holder, holderContextOf(this.app));
                if (resolved) key = storedHolderKey(doc, mechanicId, resolved);
            }
            const stored = key ? doc.holders[mechanicId]?.[key]?.values[attr?.id ?? attribute] : undefined;
            if (stored !== undefined) return copyValue(stored);
        }
        return attr ? initialValueOf(attr) : null;
    }

    history(limit = 50): StateChange[] {
        const log = this.peek()?.log ?? [];
        return log
            .slice(-Math.max(0, limit))
            .reverse()
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

    holdersInScene(def: MechanicDef): string[] {
        const persona = personaOf(this.app);
        const context = holderContextOf(this.app);
        const isPersona = (name: string) => !!persona && nameKey(name) === nameKey(persona);
        switch (def.holders.kind) {
            case 'persona':
                return persona ? [persona] : [];
            case 'world':
                return [WORLD_HOLDER];
            case 'factions':
                return unique(def.holders.names);
            case 'characters': {
                const out = this.presentCharacters().filter((name) => !isPersona(name));
                if (def.holders.includePersona && persona) out.push(persona);
                return unique(out);
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

    /* ---------------------------------------------------------------- applying */

    async apply(changes: ChangeInput[]): Promise<StateChange[]> {
        if (this.disposed || !changes.length) return [];
        const byUser = changes.every((change) => change.source === 'user');
        const chatId = this.app.host.chatId();
        if (!chatId) {
            if (byUser) throw new Error(this.t('m25.state.error.noChat'));
            return [];
        }
        const leader = safe(() => this.app.leader.isLeader(), false);
        const context = holderContextOf(this.app);
        const accepted: ChangeInputData[] = [];
        const rejected: { input: ChangeInput; reason: string }[] = [];
        for (const change of changes) {
            if (!leader && !FREE_SOURCES.has(change.source)) {
                rejected.push({ input: change, reason: 'leader' });
                continue;
            }
            const def = this.getDef(change.mechanicId);
            if (!def) {
                rejected.push({ input: change, reason: 'mechanic' });
                continue;
            }
            const holder = resolveHolder(def, change.holder, context);
            if (!holder) {
                rejected.push({ input: change, reason: 'holder' });
                continue;
            }
            const input: ChangeInputData = { ...change, holder };
            accepted.push(input);
        }
        const result = accepted.length
            ? await this.mutate((doc) => {
                  const outcome = applyChanges(doc, accepted, {
                      getDef: this.getDef,
                      now: Date.now(),
                      newId: () => this.newId(),
                  });
                  capStateDoc(doc);
                  return { changed: outcome.applied.length > 0, result: outcome };
              })
            : undefined;
        if (result) rejected.push(...result.rejected);
        if (rejected.length) {
            this.deps.log.debug(
                `mechanics: ${rejected.length} changes rejected`,
                rejected.map((item) => `${item.input.holder}.${item.input.attribute}: ${item.reason}`),
            );
        }
        const applied = result?.applied ?? [];
        if (applied.length) {
            for (const event of result?.fired ?? []) this.signal(event, chatId);
            await this.journalUser(
                applied.filter((change) => change.source === 'user'),
                chatId,
            );
            this.emit();
        }
        if (byUser && !applied.length && !result?.unchanged.length && rejected.length) {
            const reason = rejected[0]?.reason ?? 'value';
            const known = ['mechanic', 'attribute', 'holder', 'leader'].includes(reason) ? reason : 'value';
            throw new Error(this.t('m25.state.error.rejected', { reason: this.t(`m25.state.reject.${known}`) }));
        }
        return applied.map((change) => publicChange(change) as StateChange);
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

    private async journalUser(changes: StateChange[], chatId: string): Promise<void> {
        if (!changes.length) return;
        const first = changes[0] as StateChange;
        const def = this.getDef(first.mechanicId);
        const attr = def ? findAttribute(def, first.attribute) : null;
        const summary =
            changes.length === 1
                ? this.t('m25.state.journal.set', {
                      holder: this.holderLabel(first.holder),
                      attribute: attr?.name ?? first.attribute,
                      value: formatValue(first.to),
                  })
                : this.t('m25.state.journal.setMany', { count: changes.length });
        try {
            await this.app.journal.record({
                module: MECHANICS_ID,
                kind: SET_KIND,
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

    /* ---------------------------------------------------------------- undo and rollback */

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
            const removed =
                reason === 'edited'
                    ? rollbackMessage(doc, index, TRACKED_SOURCES, this.getDef)
                    : rollbackFrom(doc, index, this.getDef);
            return { changed: removed.length > 0, result: removed };
        })
            .then((removed) => {
                if (!removed?.length) return;
                this.deps.log.debug(`mechanics: ${removed.length} changes of message #${index} taken back (${reason})`);
                this.emit();
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
