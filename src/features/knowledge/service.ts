// M18 «Кто что знает» (plan M18, M15 п. 1, M8 «Маршрутизация»: «Секрет, знание → M18», P14, P15):
// - scene knowledge without AI: when a reply is committed, its notable events — the signals batch of that turn
//   (quests, relationship changes, moves, characters who came or went, revealed names and aliases) and, cheaply, the
//   reply's sentences with a key event word that name someone — become short English facts known by the DES cast of
//   that turn (canonical names) and the persona. The batch comes a moment after the send (signals run in an idle
//   slot); without it the turn is read after a short wait. Nothing runs on the send path; leader tab only;
// - secrets: the revision's 'deferred.secret' cards (the backlog of stages 4–8 too) are taken in and dismissed, or the
//   revision hands a secret over directly (intakeSecret). Knowers come from the statement («X knows», «Y does not
//   know») or the cast of the source turn;
// - unknownFor(): facts whose topic came up in the recent text that the character does not know (secrets first, at
//   most three) — the voice cards (M15) show them as «Unaware of: …»;
// - the user marks who knows from the pult: journaled with undo. The store is capped (oldest scene facts go first).
import { adaptersOf } from '../../adapters';
import { formatClip } from '../../core/labels';
import {
    addDrafts,
    capFacts,
    dropForMessage,
    eventsFromReply,
    eventsFromSignals,
    nameTopics,
    setKnown,
} from '../../domain/knowledge-facts';
import type {
    FactDraft,
    KnowledgeDocData,
    KnowledgeFactData,
    NameInfo,
    NameLookup,
} from '../../domain/knowledge-facts';
import { castAt, factsOnTopic, MAX_UNKNOWN, unknownAmong } from '../../domain/knowledge-match';
import { parseSecretKnowers, secretKnownBy, secretTopics } from '../../domain/knowledge-secrets';
import { isCommittedIndex } from '../../domain/relations-history';
import { cleanForAnalysis } from '../../domain/text-clean';
import { sceneTracker, presentCharacters } from '../../domain/voices-cards';
import { nameList, normalizeName } from '../../domain/world-names';
import type { App, JournalChange, Logger, Signal, Unsubscribe } from '../../shared/contracts';
import type { DeferredCard, RevisionApi } from '../revision/api';
import type { SignalBatch, SignalsApi } from '../signals/api';
import type { Entity, WorldModelApi } from '../world/api';
import type { KnowledgeApi, KnowledgeFact, SecretIntake } from './api';
import { KNOWLEDGE_ID, KNOWN_TARGET, SECRET_TARGET } from './settings';
import type { KnowledgeSettings } from './settings';
import { KnowledgeStore } from './store';

// The domain's fact is exactly the API's (src/domain cannot import feature types).
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const sameFact: Exact<KnowledgeFact, KnowledgeFactData> = true;
void sameFact;

export interface KnowledgeServiceOptions {
    /** How long a committed turn waits for its signals batch before it is read without one. */
    batchWaitMs?: number;
    /** Pause before a turn is read when the signals service is off (keeps it off the send path). */
    settleMs?: number;
}

const BATCH_WAIT_MS = 3_000;
const SETTLE_MS = 400;
/** Names offered to the reply reader and the secret parser at most. */
const MAX_NAMES = 300;
const PEOPLE: readonly string[] = ['character', 'persona'];
/** Chat words quoted in a journal line at most. */
const QUOTE_CLIP = formatClip(100);

function newId(): string {
    return `kf-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function copy(fact: KnowledgeFactData): KnowledgeFact {
    return { ...fact, topics: [...fact.topics], knownBy: [...fact.knownBy] };
}

export class KnowledgeService {
    readonly store: KnowledgeStore;
    private readonly listeners = new Set<() => void>();
    private readonly waiting = new Map<number, ReturnType<typeof setTimeout>>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private signals: { api: SignalsApi; off: Unsubscribe | null } | null = null;
    private revision: { api: RevisionApi; offs: Unsubscribe[] } | null = null;
    private onTopic: { text: string; doc: KnowledgeDocData; facts: KnowledgeFactData[] } | null = null;
    private intaking: Promise<void> | null = null;
    private intakeAgain = false;
    private disposed = false;
    private readonly batchWaitMs: number;
    private readonly settleMs: number;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => KnowledgeSettings,
        options: KnowledgeServiceOptions = {},
    ) {
        this.store = new KnowledgeStore(app, log);
        this.batchWaitMs = options.batchWaitMs ?? BATCH_WAIT_MS;
        this.settleMs = options.settleMs ?? SETTLE_MS;
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(): Unsubscribe[] {
        const { bus, journal } = this.app;
        // Permanent: journal records outlive the module.
        journal.registerUndo(KNOWN_TARGET, (change) => this.undoKnown(change));
        journal.registerUndo(SECRET_TARGET, (change) => this.undoSecret(change));
        const offs: Unsubscribe[] = [
            this.store.onChange(() => this.emit()),
            bus.on('turn:committed', ({ messageIndex }) => this.onCommitted(messageIndex)),
            bus.on('message:invalidated', ({ messageIndex, reason }) => this.onInvalidated(messageIndex, reason)),
            bus.on('chat:changed', () => this.onChatChanged()),
            bus.on('leader:changed', ({ leader }) => {
                if (leader) this.scheduleIntake();
            }),
            () => this.dispose(),
        ];
        this.follow();
        void this.store.load();
        this.scheduleIntake();
        return offs;
    }

    private dispose(): void {
        this.disposed = true;
        for (const timer of [...this.timers, ...this.waiting.values()]) clearTimeout(timer);
        this.timers.clear();
        this.waiting.clear();
        this.signals?.off?.();
        this.signals = null;
        for (const off of this.revision?.offs ?? []) off();
        this.revision = null;
        this.listeners.clear();
    }

    private later(task: () => unknown, ms: number): ReturnType<typeof setTimeout> | null {
        if (this.disposed) return null;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (this.disposed) return;
            void Promise.resolve()
                .then(task)
                .catch((error: unknown) => this.log.warn('knowledge background step failed', error));
        }, ms);
        this.timers.add(timer);
        return timer;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        this.onTopic = null;
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('knowledge listener failed', error);
            }
        }
    }

    private onChatChanged(): void {
        for (const timer of this.waiting.values()) clearTimeout(timer);
        this.waiting.clear();
        this.store.reset();
        this.follow();
        void this.store.load();
        this.scheduleIntake();
    }

    /** Re-binds to the signals service and the revision (a restarted module gives a new API object). */
    follow(): void {
        if (this.disposed) return;
        const signals = this.app.modules.api<SignalsApi>('signals');
        if (signals !== this.signals?.api) {
            this.signals?.off?.();
            this.signals = null;
            if (signals) {
                let off: Unsubscribe | null = null;
                try {
                    off = signals.onBatch((batch) => this.onBatch(batch));
                } catch (error) {
                    this.log.debug('cannot follow the signals', error);
                }
                this.signals = { api: signals, off };
            }
        }
        const revision = this.app.modules.api<RevisionApi>('revision');
        if (revision !== this.revision?.api) {
            for (const off of this.revision?.offs ?? []) off();
            this.revision = null;
            if (revision) {
                const offs: Unsubscribe[] = [];
                try {
                    offs.push(revision.onRun(() => this.scheduleIntake()));
                    if (typeof revision.onChange === 'function')
                        offs.push(revision.onChange(() => this.scheduleIntake()));
                } catch (error) {
                    this.log.debug('cannot follow the revision', error);
                }
                this.revision = { api: revision, offs };
            }
        }
    }

    /* ---------------------------------------------------------------- names */

    private world(): WorldModelApi | undefined {
        return this.app.modules.api<WorldModelApi>('world');
    }

    private resolve(name: string, kind?: Parameters<WorldModelApi['resolve']>[1]): Entity | undefined {
        const world = this.world();
        if (!world || !name.trim()) return undefined;
        try {
            return kind ? world.resolve(name, kind) : (world.resolve(name, 'character') ?? world.resolve(name));
        } catch {
            return undefined;
        }
    }

    /** A DES or chat name → the world model's canonical name (the name itself when the world does not know it). */
    canonical(name: string): string {
        return this.resolve(name)?.name ?? name.trim();
    }

    /** The persona's canonical name ('' without one). */
    persona(): string {
        const name = (this.app.host.ctx().name1 ?? '').trim();
        if (!name) return '';
        return this.resolve(name, 'persona')?.name ?? name;
    }

    private lookup: NameLookup = (name) => {
        const entity = this.resolve(name);
        return entity ? { name: entity.name, aliases: entity.aliases, forms: entity.forms } : null;
    };

    /** People the story can name: the world's characters and persona, plus the given names (the cast). */
    private people(extra: readonly string[]): NameInfo[] {
        const out = new Map<string, NameInfo>();
        try {
            for (const entity of this.world()?.entities() ?? []) {
                if (!PEOPLE.includes(entity.kind)) continue;
                out.set(normalizeName(entity.name), {
                    name: entity.name,
                    aliases: entity.aliases,
                    forms: entity.forms,
                });
                if (out.size >= MAX_NAMES) break;
            }
        } catch (error) {
            this.log.debug('world entities are not available', error);
        }
        for (const name of extra) {
            const key = normalizeName(name);
            if (key && !out.has(key)) out.set(key, this.lookup(name) ?? { name });
        }
        return [...out.values()];
    }

    private hidden(): string[] {
        try {
            const des = adaptersOf(this.app).des as { removedCharacters?: () => string[] } | undefined;
            return typeof des?.removedCharacters === 'function' ? des.removedCharacters() : [];
        } catch {
            return [];
        }
    }

    /** The DES cast at a reply (canonical names). */
    castOf(index: number): string[] {
        const names = castAt((this.app.host.ctx().chat ?? []) as unknown[], index, this.hidden()) ?? [];
        return nameList(names.map((name) => this.canonical(name)));
    }

    /** Characters in the scene now (the committed reply's tracker), the persona left out. */
    castNow(): string[] {
        const tracker = this.app.host.chatId() ? sceneTracker((this.app.host.ctx().chat ?? []) as unknown[]) : null;
        const self = normalizeName(this.persona());
        const names = presentCharacters(tracker?.snapshot.characters ?? [], this.hidden()).map((item) =>
            this.canonical(item.name),
        );
        return nameList(names).filter((name) => normalizeName(name) !== self);
    }

    /** Characters the pult offers «знает» toggles for: the scene now, then everyone among the knowers (no persona). */
    roster(): string[] {
        const self = normalizeName(this.persona());
        const others = nameList((this.store.peek()?.facts ?? []).flatMap((fact) => fact.knownBy)).sort((a, b) =>
            a.localeCompare(b),
        );
        return nameList([...this.castNow(), ...others]).filter((name) => normalizeName(name) !== self);
    }

    private personaNames(persona: string): string[] {
        const own = (this.app.host.ctx().name1 ?? '').trim();
        return nameList([...(persona ? nameTopics(persona, this.lookup) : []), own]);
    }

    /* ---------------------------------------------------------------- scene knowledge */

    private isLeader(): boolean {
        try {
            return this.app.leader.isLeader();
        } catch {
            return true;
        }
    }

    private onCommitted(index: number): void {
        if (this.disposed || !Number.isInteger(index) || index < 0) return;
        this.follow();
        if (!this.isLeader()) return;
        const previous = this.waiting.get(index);
        if (previous !== undefined) clearTimeout(previous);
        const wait = this.signals ? this.batchWaitMs : this.settleMs;
        const timer = this.later(() => {
            this.waiting.delete(index);
            return this.readTurn(index, this.pendingSignals(index), true);
        }, wait);
        if (timer) this.waiting.set(index, timer);
    }

    /** A signals batch: the turn is read now (a late batch only adds its signals). */
    private onBatch(batch: SignalBatch): void {
        if (this.disposed || !this.isLeader()) return;
        const timer = this.waiting.get(batch.messageIndex);
        if (timer !== undefined) {
            clearTimeout(timer);
            this.timers.delete(timer);
            this.waiting.delete(batch.messageIndex);
        }
        void this.readTurn(batch.messageIndex, batch.signals, batch.late !== true).catch((error: unknown) =>
            this.log.warn('a turn could not be read for knowledge', error),
        );
    }

    private pendingSignals(index: number): Signal[] {
        try {
            return (this.signals?.api.pending() ?? []).filter((signal) => signal.messageIndex === index);
        } catch {
            return [];
        }
    }

    /** Facts of one committed reply: its signals and (unless only late signals came) its sentences. */
    async readTurn(index: number, signals: readonly Signal[], reply: boolean): Promise<number> {
        if (this.disposed || !this.app.host.chatId()) return 0;
        const message = (this.app.host.ctx().chat ?? [])[index] as STChatMessage | undefined;
        if (!message || message.is_user || message.is_system) return 0;
        const persona = this.persona();
        const cast = this.castOf(index);
        const options = { persona, personaNames: this.personaNames(persona), lookup: this.lookup };
        const drafts: FactDraft[] = eventsFromSignals(signals, options);
        if (reply && this.settings().replyEvents) {
            const text = cleanForAnalysis(message);
            if (text) drafts.push(...eventsFromReply(text, { ...options, names: this.people([...cast, persona]) }));
        }
        if (!drafts.length) return 0;
        const knownBy = nameList([...cast, persona]);
        const added = await this.store.mutate((doc) => {
            const list = addDrafts(doc, drafts, {
                knownBy,
                sourceMessage: index,
                at: Date.now(),
                newId,
                max: this.settings().maxFacts,
            });
            return { changed: list.length > 0, result: list.length };
        });
        return added ?? 0;
    }

    private onInvalidated(index: number, reason: 'swiped' | 'deleted' | 'edited'): void {
        if (this.disposed || !Number.isInteger(index)) return;
        for (const [at, timer] of [...this.waiting]) {
            if (at === index || (reason === 'deleted' && at >= index)) {
                clearTimeout(timer);
                this.timers.delete(timer);
                this.waiting.delete(at);
            }
        }
        if (!this.app.host.chatId()) return;
        void this.store
            .mutate((doc) => {
                const dropped = dropForMessage(doc, index, reason);
                return { changed: dropped > 0, result: dropped };
            })
            .then(() => {
                // The message is still answered (an older reply was swiped or edited): it is read again.
                const chat = (this.app.host.ctx().chat ?? []) as STChatMessage[];
                if (reason !== 'deleted' && this.isLeader() && isCommittedIndex(chat, index)) {
                    this.later(() => this.readTurn(index, this.pendingSignals(index), true), this.settleMs);
                }
            })
            .catch((error: unknown) => this.log.warn('knowledge of an invalidated message was not dropped', error));
    }

    /* ---------------------------------------------------------------- secrets */

    /** Takes the revision's secret cards in (the backlog too) and dismisses them; leader tab only, one pass at a time. */
    scheduleIntake(): void {
        this.later(() => this.intake(), 0);
    }

    intake(): Promise<void> {
        if (this.intaking) {
            this.intakeAgain = true;
            return this.intaking;
        }
        const run = async () => {
            do {
                this.intakeAgain = false;
                await this.intakeOnce();
            } while (this.intakeAgain && !this.disposed);
        };
        const promise = run().finally(() => {
            if (this.intaking === promise) this.intaking = null;
        });
        this.intaking = promise;
        return promise;
    }

    private async intakeOnce(): Promise<void> {
        this.follow();
        const revision = this.revision?.api;
        if (this.disposed || !revision || !this.app.host.chatId() || !this.isLeader()) return;
        let cards: DeferredCard[];
        try {
            cards = revision.deferred().filter((card) => card.target === 'deferred.secret');
        } catch (error) {
            this.log.debug('deferred cards are not readable', error);
            return;
        }
        for (const card of cards) {
            if (this.disposed) return;
            try {
                const id = await this.intakeSecret(card);
                if (id === null) continue;
                await revision.dismissDeferred?.(card.id);
            } catch (error) {
                this.log.warn('a secret card could not be taken in', error);
            }
        }
    }

    /** A secret from the revision: who knows it, its topics, then addSecret. Null without a chat or a statement. */
    async intakeSecret(secret: SecretIntake): Promise<string | null> {
        const text = (secret.value ?? '').trim();
        if (!this.app.host.chatId() || !text) return null;
        const persona = this.persona();
        const cast = nameList([...this.castOf(secret.sourceMessage), persona]);
        const people = this.people(cast);
        const subjectEntity = this.resolve(secret.entityName ?? '');
        let subject: string | undefined;
        if (subjectEntity && PEOPLE.includes(subjectEntity.kind)) subject = subjectEntity.name;
        else if (!subjectEntity) {
            subject = cast.find((name) => normalizeName(name) === normalizeName(secret.entityName ?? ''));
        }
        const knownBy = secretKnownBy(parseSecretKnowers(text, people), subject ? { cast, subject } : { cast });
        const topics = secretTopics(text, secret.evidence ?? '', {
            names: people,
            ...(subject ? { subject } : {}),
            persona: this.personaNames(persona),
            lookup: this.lookup,
        });
        const fact: Omit<KnowledgeFact, 'id' | 'at' | 'secret'> = {
            text,
            topics,
            knownBy,
            sourceMessage: Number.isInteger(secret.sourceMessage) ? secret.sourceMessage : -1,
        };
        const quote = (secret.evidence ?? '').trim();
        if (quote) fact.quote = quote;
        return this.addSecret(fact);
    }

    /** Adds a secret (the same statement again only adds knowers and topics); journaled with undo when new. */
    async addSecret(input: Omit<KnowledgeFact, 'id' | 'at' | 'secret'>): Promise<string> {
        const t = this.app.i18n.t.bind(this.app.i18n);
        if (!this.app.host.chatId()) throw new Error(t('m18.error.noChat'));
        const text = (input.text ?? '').trim();
        if (!text) throw new Error(t('m18.error.empty'));
        const knownBy = nameList(Array.isArray(input.knownBy) ? input.knownBy : []);
        const topics = Array.isArray(input.topics) ? input.topics.filter((item) => typeof item === 'string') : [];
        const outcome = await this.store.mutate((doc) => {
            const existing = doc.facts.find((fact) => fact.secret && normalizeName(fact.text) === normalizeName(text));
            if (existing) {
                const before = existing.knownBy.length + existing.topics.length;
                existing.knownBy = nameList([...existing.knownBy, ...knownBy]);
                existing.topics = [...new Set([...existing.topics, ...topics])];
                const changed = existing.knownBy.length + existing.topics.length !== before;
                return { changed, result: { fact: existing, created: false } };
            }
            const fact: KnowledgeFactData = {
                id: newId(),
                text,
                topics,
                knownBy,
                secret: true,
                sourceMessage: Number.isInteger(input.sourceMessage) ? input.sourceMessage : -1,
                at: Date.now(),
            };
            if (input.quote?.trim()) fact.quote = input.quote.trim();
            doc.facts.push(fact);
            doc.facts = capFacts(doc.facts, this.settings().maxFacts);
            return { changed: true, result: { fact, created: true } };
        });
        if (!outcome) throw new Error(t('m18.error.notSaved'));
        if (outcome.created) {
            await this.journal({
                kind: 'knowledge.secret',
                summary: t('m18.journal.secret', { text: this.words(outcome.fact) }),
                changes: [
                    {
                        target: SECRET_TARGET,
                        ref: { factId: outcome.fact.id },
                        before: null,
                        after: copy(outcome.fact),
                    },
                ],
                sourceMessage: outcome.fact.sourceMessage,
            });
        }
        return outcome.fact.id;
    }

    /* ---------------------------------------------------------------- who knows */

    markKnown(factId: string, character: string): Promise<void> {
        return this.setKnown(factId, character, true);
    }

    markUnknown(factId: string, character: string): Promise<void> {
        return this.setKnown(factId, character, false);
    }

    private async setKnown(factId: string, character: string, known: boolean): Promise<void> {
        const t = this.app.i18n.t.bind(this.app.i18n);
        const name = this.canonical(character);
        if (!name) throw new Error(t('m18.error.noName'));
        if (!this.app.host.chatId()) throw new Error(t('m18.error.noChat'));
        const outcome = await this.store.mutate((doc) => {
            const fact = doc.facts.find((item) => item.id === factId);
            if (!fact) return { changed: false, result: null };
            const changed = setKnown(fact, name, known);
            return { changed, result: { words: this.words(fact), changed } };
        });
        if (outcome === null) throw new Error(t('m18.error.noFact'));
        if (outcome === undefined) throw new Error(t('m18.error.notSaved'));
        if (!outcome.changed) return;
        await this.journal({
            kind: 'knowledge.known',
            summary: t(known ? 'm18.journal.known' : 'm18.journal.unknown', { name, fact: outcome.words }),
            changes: [{ target: KNOWN_TARGET, ref: { factId, character: name }, before: !known, after: known }],
        });
    }

    /** A fact in a journal line: the chat's own words when there are some (the statement is English), cut short. */
    private words(fact: { text: string; quote?: string }): string {
        const quote = fact.quote?.trim();
        if (!quote) return fact.text;
        return this.app.i18n.t('m18.journal.quote', { text: QUOTE_CLIP(quote, this.app.i18n) });
    }

    private async journal(action: { kind: string; summary: string; changes: JournalChange[]; sourceMessage?: number }) {
        try {
            await this.app.journal.record({ module: KNOWLEDGE_ID, ...action });
        } catch (error) {
            this.log.warn('knowledge change was not journaled', error);
        }
    }

    private async undoKnown(change: JournalChange): Promise<boolean> {
        const { factId, character } = change.ref;
        if (typeof factId !== 'string' || typeof character !== 'string' || !this.app.host.chatId()) return false;
        const done = await this.store.mutate((doc) => {
            const fact = doc.facts.find((item) => item.id === factId);
            return { changed: !!fact && setKnown(fact, character, change.before === true), result: true };
        });
        return done === true;
    }

    private async undoSecret(change: JournalChange): Promise<boolean> {
        const factId = change.ref.factId;
        if (typeof factId !== 'string' || !this.app.host.chatId()) return false;
        const done = await this.store.mutate((doc) => {
            const before = doc.facts.length;
            doc.facts = doc.facts.filter((fact) => fact.id !== factId);
            return { changed: doc.facts.length !== before, result: true };
        });
        return done === true;
    }

    /* ---------------------------------------------------------------- reading */

    facts(): KnowledgeFact[] {
        const doc = this.store.peek();
        if (!doc) {
            void this.store.load();
            return [];
        }
        return doc.facts.map(copy);
    }

    /** Facts whose topic came up in the recent text that the character does not know (secrets first, at most 3). */
    unknownFor(character: string, recentText: string): KnowledgeFact[] {
        const doc = this.store.peek();
        if (!doc) {
            void this.store.load();
            return [];
        }
        if (!character.trim() || !recentText.trim() || !doc.facts.length) return [];
        if (this.onTopic?.doc !== doc || this.onTopic.text !== recentText) {
            this.onTopic = { text: recentText, doc, facts: factsOnTopic(doc.facts, recentText) };
        }
        const entity = this.resolve(character);
        const aliases = entity ? [entity.name, ...entity.aliases] : [];
        return unknownAmong(this.onTopic.facts, doc.facts, character, { aliases, max: MAX_UNKNOWN }).map(copy);
    }

    api(): KnowledgeApi {
        return {
            facts: () => this.facts(),
            unknownFor: (character, recentText) => this.unknownFor(character, recentText),
            markKnown: (factId, character) => this.markKnown(factId, character),
            addSecret: (fact) => this.addSecret(fact),
            onChange: (listener) => this.onChange(listener),
            intakeSecret: (secret) => this.intakeSecret(secret),
            markUnknown: (factId, character) => this.markUnknown(factId, character),
        };
    }
}
