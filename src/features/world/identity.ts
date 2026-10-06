// Identity across stories (plan-2 §9 «Офелия из другого чата»): card and global records answering to a name of this chat
// are someone else's until the card or the user says otherwise (domain/world-identity.ts scopes). This desk asks.
// - A name this chat uses (a record of the chat has it, or a message names it) with a namesake's sources waiting gets one
//   Inbox card (kind 'world.sameAs', «Входящие» by default, never automatic) listing in plain words what the other one
//   brings; «Тот же» binds those sources to the chat, «Другой» keeps them out for good (a card passport is switched off
//   in this chat through NAI Studio 0.14+). Until the answer nothing of them is used. A badge on the message where the
//   name first appears leads to the Inbox.
// - The dossier changes the decision later («Это тот же» / «Это другой персонаж»); every decision is journaled and
//   undone (an undone answer is asked again).
// Messages are read for names off the send path (the world model rebuilds after the generation): each message once,
// into a word index (domain/world-names.ts WordIndex) the names are looked up in.
import { adaptersOf } from '../../adapters';
import { stableHash } from '../../domain/hash';
import type { WorldBuild, WorldForeign, WorldSource } from '../../domain/world-identity';
import { isLocalSource, sourceKeyOf } from '../../domain/world-identity';
import {
    buildMentionMatcher,
    findMentions,
    kindFamily,
    mentionNeedles,
    normalizeName,
    WordIndex,
} from '../../domain/world-names';
import { cardPassportIdOfKey } from '../../domain/world-scope';
import type { App, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { Entity, EntityIdentity, EntitySource } from './api';
import { putAsked, putIdentity } from './store';
import type { WorldDoc, WorldStore } from './store';

export const SAME_AS_KIND = 'world.sameAs';
export const IDENTITY_TARGET = 'world-identity';
export const EXCLUDE_TARGET = 'world-nai-excluded';
/** New questions per build (the rest wait for the next build). */
const MAX_NEW_QUESTIONS = 3;
/** How long a switch Maestro asked NAI Studio for waits for its `passportExcludedChanged` echo. */
const ECHO_MS = 5000;

/** What the world model gives the desk. */
export interface IdentityHost {
    moduleId: string;
    build(): WorldBuild;
    /** Rebuild after a decision (synchronous, over the loaded lorebooks). */
    rebuild(): void;
    forms(name: string): string[];
    /** DES-RU forms are not available: single Cyrillic names also match by stem. */
    stems(): boolean;
    ofCard(name: string): boolean;
    /** Bumped on chat change. */
    generation(): number;
}

export interface SameAsPayload {
    group: string;
    name: string;
    /** Groups the card in the Inbox by the person. */
    entityName: string;
    kind: string;
    keys: string[];
    /** Where the name first appears in this chat (the badge's message), -1 if unknown. */
    messageIndex: number;
}

type Decision = 'same' | 'apart';

interface Present {
    group: WorldForeign;
    first: number;
}

/** A source rebuilt from its decision key alone (the store no longer shows it). */
export function sourceOfKey(key: string): WorldSource {
    const at = key.lastIndexOf('#');
    const colon = key.indexOf(':');
    const prefix = colon > 0 ? key.slice(0, colon) : '';
    const owner = at > colon ? key.slice(colon + 1, at) : '';
    const tail = at > colon ? key.slice(at + 1) : key.slice(colon + 1);
    switch (prefix) {
        case 'nai': {
            const source: WorldSource = { kind: 'nai.passport', ref: `${owner}#${tail}`, label: tail, key };
            source.passportId = tail;
            if (owner !== 'persona' && owner !== 'chat') {
                source.avatar = owner;
                source.scope = 'card';
            }
            return source;
        }
        case 'ck':
            return { kind: 'ck.archive', ref: `${owner}#${tail}`, label: tail, world: owner, key, scope: 'global' };
        case 'lore':
            return {
                kind: 'lore.entry',
                ref: `${owner}#${tail}`,
                label: `#${tail}`,
                world: owner,
                uid: Number(tail),
                key,
                scope: 'global',
            };
        case 'des':
            return { kind: 'des.workshop', ref: tail, label: tail, key, scope: 'global' };
        default:
            return { kind: 'lore.entry', ref: key, label: key, key, scope: 'global' };
    }
}

function payloadOf(value: unknown): SameAsPayload | null {
    if (!value || typeof value !== 'object') return null;
    const raw = value as Record<string, unknown>;
    if (typeof raw.group !== 'string' || !raw.group || !Array.isArray(raw.keys)) return null;
    const keys = raw.keys.filter((key): key is string => typeof key === 'string' && !!key);
    if (!keys.length) return null;
    const name = typeof raw.name === 'string' ? raw.name : '';
    return {
        group: raw.group,
        name,
        entityName: name,
        kind: typeof raw.kind === 'string' ? raw.kind : 'character',
        keys,
        messageIndex: typeof raw.messageIndex === 'number' ? raw.messageIndex : -1,
    };
}

/** 'being' | 'place' | 'other': the noun of the question («тот же персонаж», «то же место», «то же самое»). */
function nounOf(kind: string): 'being' | 'place' | 'other' {
    const family = kindFamily(kind);
    return family === 'being' ? 'being' : family === 'place' ? 'place' : 'other';
}

/** Order of the stores in texts: the sheet, the book, the passport, DES. */
const SOURCE_ORDER: Record<string, number> = { 'ck.archive': 0, 'lore.entry': 1, 'nai.passport': 2, 'des.workshop': 3 };

function ordered(sources: readonly WorldSource[]): WorldSource[] {
    return [...sources].sort((a, b) => (SOURCE_ORDER[a.kind] ?? 9) - (SOURCE_ORDER[b.kind] ?? 9));
}

export class IdentityDesk {
    /** The chat's words and where each first appears. */
    private words = new WordIndex();
    /** Per foreign group: the first message naming it, for which needles, at which word-index version. */
    private readonly ledger = new Map<string, { sig: string; first: number; version: number }>();
    private readonly badges = new Map<string, { index: number; off: Unsubscribe }>();
    private asking = false;
    private disposed = false;
    /** Passport switches Maestro asked for: their `passportExcludedChanged` events are echoes, not the user's. */
    private readonly switching = new Map<string, boolean>();

    constructor(
        private readonly app: App,
        private readonly store: WorldStore,
        private readonly log: Logger,
        private readonly host: IdentityHost,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    install(): Unsubscribe[] {
        this.app.autonomy.neverAuto(SAME_AS_KIND);
        this.app.journal.registerUndo(IDENTITY_TARGET, (change) => this.undoIdentity(change));
        this.app.journal.registerUndo(EXCLUDE_TARGET, (change) => this.undoExclusion(change));
        const off = this.app.inbox.registerApplier(
            SAME_AS_KIND,
            (payload) => this.applyCard(payload),
            async (payload) => this.cardValid(payload),
            async (payload) => this.rejectCard(payload),
        );
        return [off, () => this.dispose()];
    }

    private dispose(): void {
        this.disposed = true;
        this.clearBadges();
    }

    /** Chat switch: messages and badges belong to the old chat. */
    reset(): void {
        this.words = new WordIndex();
        this.ledger.clear();
        this.clearBadges();
    }

    /**
     * A message changed. A swipe adds its new text (the old swipe's words may stay: a name is at worst found early);
     * an edit or a deletion reads the chat again.
     */
    forgetMentions(messageIndex: number, reason: string): void {
        if (reason === 'swiped') {
            this.words.size = Math.min(this.words.size, Math.max(0, messageIndex));
            for (const [key, entry] of [...this.ledger]) if (entry.first >= messageIndex) this.ledger.delete(key);
            return;
        }
        this.words = new WordIndex();
        this.ledger.clear();
    }

    /* ---------------------------------------------------------------- after a build */

    /** Called after every build; questions only once the lorebooks are read (their sources join the same card). */
    afterBuild(loreReady: boolean): void {
        if (this.disposed || !this.app.host.chatId()) {
            this.clearBadges();
            return;
        }
        let present: Present[];
        try {
            present = this.present();
        } catch (error) {
            this.log.warn('names of the chat could not be read', error);
            return;
        }
        this.syncBadges(present);
        if (loreReady) void this.ask(present);
    }

    /** Waiting groups whose name this chat uses (a record of the chat, or a message names it). */
    private present(): Present[] {
        const waiting = this.host.build().foreign.filter((group) => group.pending.length > 0);
        if (!waiting.length) return [];
        const first = this.firstMentions(waiting);
        return waiting
            .map((group) => ({ group, first: first.get(group.key) ?? -1 }))
            .filter((item) => item.group.local || item.first >= 0);
    }

    /** First message naming each group (its name, the namesake's names and their case forms), -1 if none. */
    private firstMentions(groups: readonly WorldForeign[]): Map<string, number> {
        const chat = this.app.host.ctx().chat ?? [];
        if (this.words.size > chat.length) this.words = new WordIndex();
        for (let index = this.words.size; index < chat.length; index++) {
            const text = chat[index]?.mes;
            if (typeof text === 'string' && text) this.words.add(index, text);
        }
        this.words.size = chat.length;
        const stems = this.host.stems();
        const out = new Map<string, number>();
        for (const group of groups) {
            const names = [...new Set([group.name, ...group.names].filter((name) => normalizeName(name)))];
            const needles = mentionNeedles(
                names,
                names.flatMap((name) => this.host.forms(name)),
                stems,
            );
            const sig = needles
                .map((needle) => `${needle.needle}/${needle.tail}`)
                .sort()
                .join('|');
            const known = this.ledger.get(group.key);
            if (known?.sig === sig && (known.first >= 0 || known.version === this.words.version)) {
                out.set(group.key, known.first);
                continue;
            }
            let first = -1;
            for (const needle of needles) {
                const at = this.words.firstOf(needle) ?? this.scan(needle, chat);
                if (at >= 0 && (first < 0 || at < first)) first = at;
            }
            this.ledger.set(group.key, { sig, first, version: this.words.version });
            out.set(group.key, first);
        }
        return out;
    }

    /** A needle of several words: the messages from where all its words have appeared are read. */
    private scan(needle: { needle: string; tail: number }, chat: readonly STChatMessage[]): number {
        const from = this.words.wordsAt(needle);
        if (from < 0) return -1;
        const matcher = buildMentionMatcher([{ id: 'needle', needles: [needle] }]);
        for (let index = from; index < chat.length; index++) {
            const text = chat[index]?.mes;
            if (typeof text === 'string' && findMentions(matcher, text).length) return index;
        }
        return -1;
    }

    /* ---------------------------------------------------------------- the question */

    /** Group keys of the questions still in the Inbox. */
    private openQuestions(): Set<string> {
        const open = new Set<string>();
        for (const card of this.app.inbox.list()) {
            if (card.kind !== SAME_AS_KIND) continue;
            const payload = payloadOf(card.payload);
            if (payload) open.add(payload.group);
        }
        return open;
    }

    /** Leader only: one question per name with sources not asked about yet (at most MAX_NEW_QUESTIONS per build). */
    private async ask(present: readonly Present[]): Promise<void> {
        if (this.asking || !present.length || !this.app.leader.isLeader()) return;
        this.asking = true;
        const startedIn = this.host.generation();
        try {
            const doc = await this.store.load();
            if (startedIn !== this.host.generation()) return;
            const open = this.openQuestions();
            const fresh = present
                .filter(({ group }) => {
                    if (open.has(group.key)) return false;
                    const asked = new Set(doc.asked[group.key] ?? []);
                    return group.pending.some((source) => !asked.has(sourceKeyOf(source)));
                })
                .slice(0, MAX_NEW_QUESTIONS);
            if (!fresh.length) return;
            const marked = await this.store.mutate((next) => {
                let dirty = false;
                for (const { group } of fresh) {
                    dirty = putAsked(next, group.key, ordered(group.pending).map(sourceKeyOf), true) || dirty;
                }
                return dirty;
            });
            if (!marked || startedIn !== this.host.generation()) return;
            for (const item of fresh) {
                const proposal = this.proposal(item.group, item.first);
                try {
                    const decision = await this.app.autonomy.decide(proposal, 'inbox');
                    // «Спрашивать» answered «нет» in the modal: the same as «Другой».
                    if (decision === 'rejected') await this.rejectCard(proposal.payload);
                } catch (error) {
                    this.log.warn('identity question failed', error);
                }
            }
            this.syncBadges(this.present());
        } finally {
            this.asking = false;
        }
    }

    private proposal(group: WorldForeign, first: number): Proposal<SameAsPayload> {
        const noun = nounOf(group.kind);
        const sources = ordered(group.pending);
        const same = this.t(`m7w.sameAs.same.${noun}`);
        const other = this.t(`m7w.sameAs.other.${noun}`);
        const payload: SameAsPayload = {
            group: group.key,
            name: group.name,
            entityName: group.name,
            kind: group.kind,
            keys: sources.map(sourceKeyOf),
            messageIndex: first,
        };
        return {
            module: this.host.moduleId,
            kind: SAME_AS_KIND,
            title: this.t(`m7w.sameAs.title.${noun}`, { name: group.name, where: this.where(sources) }),
            description: this.t('m7w.sameAs.body', {
                name: group.name,
                list: this.brings(sources),
                same,
                other,
            }),
            changes: [this.change(payload, 'same', {}, sources)],
            payload,
            acceptLabel: same,
            rejectLabel: other,
            apply: (value) => this.applyCard(value),
            stillValid: async () => this.cardValid(payload),
        };
    }

    /** «в «Архиве персонажей»» — the most telling store of the namesake. */
    private where(sources: readonly WorldSource[]): string {
        const source = ordered(sources)[0];
        switch (source?.kind) {
            case 'ck.archive':
                return this.t('m7w.where.archive', { book: source.world ?? source.label });
            case 'lore.entry':
                return this.t('m7w.where.entry', { book: source.world ?? source.label });
            case 'nai.passport':
                return this.t('m7w.where.passport', { card: this.cardName(source.avatar) });
            case 'des.workshop':
                return this.t('m7w.where.workshop');
            default:
                return this.t('m7w.where.other');
        }
    }

    /** What the namesake brings, in story words, one item per store. */
    private brings(sources: readonly WorldSource[]): string {
        const items = ordered(sources).map((source) => {
            switch (source.kind) {
                case 'ck.archive':
                    return this.t('m7w.brings.archive', { book: source.world ?? source.label });
                case 'lore.entry':
                    return this.t('m7w.brings.entry', { entry: source.label, book: source.world ?? '' });
                case 'nai.passport':
                    return this.t('m7w.brings.passport', { card: this.cardName(source.avatar) });
                case 'des.workshop':
                    return this.t('m7w.brings.workshop');
                default:
                    return source.label;
            }
        });
        return [...new Set(items)].join('; ');
    }

    /** Technical details of the sources (the card's secondary part): books, entry numbers, passport ids. */
    private details(sources: readonly WorldSource[]): string {
        return ordered(sources)
            .map((source) => {
                switch (source.kind) {
                    case 'ck.archive':
                        return this.t('m7w.detail.archive', { book: source.world ?? '', name: source.label });
                    case 'lore.entry':
                        return this.t('m7w.detail.entry', { book: source.world ?? '', uid: source.uid ?? '?' });
                    case 'nai.passport':
                        return this.t('m7w.detail.passport', {
                            id: source.passportId ?? source.ref,
                            card: source.avatar ?? '',
                        });
                    case 'des.workshop':
                        return this.t('m7w.detail.workshop', { name: source.label });
                    default:
                        return `${source.kind}: ${source.ref}`;
                }
            })
            .join('; ');
    }

    private cardName(avatar: string | undefined): string {
        if (!avatar) return '';
        const card = (this.app.host.ctx().characters ?? []).find((character) => character?.avatar === avatar);
        return card?.name ?? avatar.replace(/\.[^/.]+$/, '');
    }

    /** The journal change of a decision: keys and their previous decisions in `ref`, the details as `after`. */
    private change(
        payload: Pick<SameAsPayload, 'group' | 'name' | 'keys'>,
        decision: Decision,
        previous: Record<string, Decision | null>,
        sources: readonly WorldSource[],
    ): JournalChange {
        return {
            target: IDENTITY_TARGET,
            ref: { group: payload.group, name: payload.name, keys: [...payload.keys], decision, previous },
            before: null,
            after: this.details(sources),
        };
    }

    /** A question can still be answered while one of its sources waits. */
    private async cardValid(value: unknown): Promise<boolean> {
        const payload = payloadOf(value);
        if (!payload) return false;
        const doc = await this.store.load();
        return payload.keys.some((key) => !doc.bound.includes(key) && !doc.apart.includes(key));
    }

    /** «Тот же» from the Inbox (the Inbox journals the card): the keys still waiting are bound. */
    private async applyCard(value: unknown): Promise<void> {
        const payload = payloadOf(value);
        if (!payload) throw new Error(this.t('m7w.error.noIdentity'));
        await this.store.load();
        await this.store.mutate((doc) => {
            const waiting = payload.keys.filter((key) => !doc.apart.includes(key));
            const bound = putIdentity(doc, waiting, 'same');
            return putAsked(doc, payload.group, payload.keys, true) || bound;
        });
        this.host.rebuild();
    }

    /** «Другой» from the Inbox: declared another one's, card passports switched off here; journaled with undo. */
    private async rejectCard(value: unknown): Promise<void> {
        const payload = payloadOf(value);
        if (!payload) return;
        const sources = this.sourcesOf(payload.group, payload.keys);
        await this.decide(payload, 'apart', sources);
    }

    /* ---------------------------------------------------------------- decisions (Inbox «Другой», dossier) */

    /** The sources of a group by key (the build's copy; a key the build no longer knows stays a bare key). */
    private sourcesOf(group: string, keys: readonly string[]): WorldSource[] {
        const known = new Map<string, WorldSource>();
        const build = this.host.build();
        for (const item of build.foreign) {
            for (const source of [...item.pending, ...item.apart]) known.set(sourceKeyOf(source), source);
        }
        for (const entity of build.entities)
            for (const source of entity.sources) known.set(sourceKeyOf(source), source);
        return keys.map((key) => known.get(key) ?? sourceOfKey(key));
    }

    /**
     * Keys declared another one's under this group that the build no longer shows (NAI Studio hides a card passport
     * switched off in this chat): still the entity's decision, still undoable from the dossier.
     */
    private hiddenApart(entity: Entity): WorldSource[] {
        const doc = this.store.current();
        const shown = new Set(
            this.groupsOf(entity).flatMap((group) => [...group.pending, ...group.apart].map(sourceKeyOf)),
        );
        return (doc.asked[this.groupKey(entity)] ?? [])
            .filter((key) => doc.apart.includes(key) && !shown.has(key))
            .map(sourceOfKey);
    }

    /**
     * Records a decision for these keys: the document, NAI Studio's per-chat switch of card passports, one journal
     * record (the decision first, the switches after it, so undo turns them back before the decision).
     */
    private async decide(
        payload: Pick<SameAsPayload, 'group' | 'name' | 'keys'>,
        decision: Decision,
        sources: readonly WorldSource[],
    ): Promise<void> {
        await this.store.load();
        const previous: Record<string, Decision | null> = {};
        const changed = await this.store.mutate((doc) => {
            for (const key of payload.keys) previous[key] = this.decisionOf(doc, key);
            const put = putIdentity(doc, payload.keys, decision);
            return putAsked(doc, payload.group, payload.keys, true) || put;
        });
        if (!changed) return;
        const switches = await this.switchPassports(payload.keys, decision === 'apart', previous);
        this.host.rebuild();
        const where = this.where(sources);
        await this.app.journal.record({
            module: this.host.moduleId,
            kind: decision === 'same' ? SAME_AS_KIND : 'world.apart',
            summary: this.t(decision === 'same' ? 'm7w.journal.same' : 'm7w.journal.apart', {
                name: payload.name,
                where,
            }),
            changes: [this.change(payload, decision, previous, sources), ...switches],
        });
    }

    private decisionOf(doc: WorldDoc, key: string): Decision | null {
        return doc.bound.includes(key) ? 'same' : doc.apart.includes(key) ? 'apart' : null;
    }

    /**
     * «Другой» switches the card passports among the keys off in this chat; «Тот же» switches back those a «Другой»
     * switched off. Returns the journal changes of what NAI Studio did (nothing without NAI Studio 0.14+).
     */
    private async switchPassports(
        keys: readonly string[],
        exclude: boolean,
        previous: Record<string, Decision | null>,
    ): Promise<JournalChange[]> {
        const nai = adaptersOf(this.app).nai;
        if (typeof nai?.canExcludePassports !== 'function' || !nai.canExcludePassports()) return [];
        const changes: JournalChange[] = [];
        for (const key of keys) {
            const id = cardPassportIdOfKey(key);
            if (!id) continue;
            if (!exclude && previous[key] !== 'apart') continue;
            const before = nai.isPassportExcluded(id) ?? !exclude;
            if (before === exclude) continue;
            if (await this.switchPassport(id, exclude)) {
                changes.push({ target: EXCLUDE_TARGET, ref: { id, key }, before, after: exclude });
            }
        }
        return changes;
    }

    /** One switch through NAI Studio, its echo event expected (not mirrored back as the user's own answer). */
    private async switchPassport(id: string, excluded: boolean): Promise<boolean> {
        const nai = adaptersOf(this.app).nai;
        if (typeof nai?.setPassportExcluded !== 'function') return false;
        this.switching.set(id, excluded);
        setTimeout(() => {
            if (this.switching.get(id) === excluded) this.switching.delete(id);
        }, ECHO_MS);
        const done = await nai.setPassportExcluded(id, excluded);
        if (!done && this.switching.get(id) === excluded) this.switching.delete(id);
        return done;
    }

    /**
     * NAI Studio's own buttons («Не использовать в этом чате» / «Вернуть в этот чат», NAI Studio 0.14+) answer about a
     * card passport too: switched off → declared another one's here; switched back on after that → the same. Echoes of
     * Maestro's own switches are skipped. Not journaled: the user acted in NAI Studio.
     */
    async mirrorExclusion(detail: unknown): Promise<void> {
        if (!detail || typeof detail !== 'object' || this.disposed) return;
        const { id, excluded } = detail as Record<string, unknown>;
        if (typeof id !== 'string' || !id || typeof excluded !== 'boolean') return;
        if (this.switching.get(id) === excluded) {
            this.switching.delete(id);
            return;
        }
        if (!this.app.host.chatId()) return;
        const doc = await this.store.load();
        const build = this.host.build();
        const groups = new Map<string, string>();
        for (const group of build.foreign) {
            for (const source of [...group.pending, ...group.apart]) groups.set(sourceKeyOf(source), group.key);
        }
        const known = [
            ...groups.keys(),
            ...build.entities.flatMap((entity) =>
                entity.sources.filter((source) => !isLocalSource(source)).map(sourceKeyOf),
            ),
            ...doc.bound,
            ...doc.apart,
        ];
        const keys = [...new Set(known)].filter((key) => cardPassportIdOfKey(key) === id);
        const wanted = excluded
            ? keys.filter((key) => !doc.apart.includes(key))
            : keys.filter((key) => doc.apart.includes(key));
        if (!wanted.length) return;
        const changed = await this.store.mutate((next) => {
            let dirty = putIdentity(next, wanted, excluded ? 'apart' : 'same');
            for (const key of wanted) {
                const group = groups.get(key);
                if (group) dirty = putAsked(next, group, [key], true) || dirty;
            }
            return dirty;
        });
        if (changed) this.host.rebuild();
    }

    private async undoIdentity(change: JournalChange): Promise<boolean> {
        const group = typeof change.ref.group === 'string' ? change.ref.group : '';
        const keys = Array.isArray(change.ref.keys)
            ? change.ref.keys.filter((key): key is string => typeof key === 'string')
            : [];
        if (!group || !keys.length) return false;
        const raw = change.ref.previous;
        const previous = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
        await this.store.load();
        await this.store.mutate((doc) => {
            let dirty = false;
            const again: string[] = [];
            for (const key of keys) {
                const before = previous[key] === 'same' || previous[key] === 'apart' ? previous[key] : null;
                dirty = putIdentity(doc, [key], before as Decision | null) || dirty;
                if (before === null) again.push(key);
            }
            // Back to waiting: the question is asked again.
            return putAsked(doc, group, again, false) || dirty;
        });
        this.host.rebuild();
        return true;
    }

    private async undoExclusion(change: JournalChange): Promise<boolean> {
        const id = typeof change.ref.id === 'string' ? change.ref.id : '';
        if (!id || typeof change.before !== 'boolean') return false;
        if (!(await this.switchPassport(id, change.before))) {
            // NAI Studio is gone: its switch stays as it is; the decision itself is still undone.
            this.log.warn(`NAI Studio could not switch passport ${id} back`);
        }
        return true;
    }

    /* ---------------------------------------------------------------- the dossier */

    private groupsOf(entity: Entity): WorldForeign[] {
        const names = new Set([entity.name, ...entity.aliases].map(normalizeName).filter(Boolean));
        return this.host.build().foreign.filter((group) => {
            if (group.entity) return group.entity === entity.id;
            const cut = group.key.indexOf('\u0000');
            return group.key.slice(0, cut) === kindFamily(entity.kind) && names.has(group.key.slice(cut + 1));
        });
    }

    identity(entity: Entity): EntityIdentity {
        const groups = this.groupsOf(entity);
        return {
            ofCard: [entity.name, ...entity.aliases].some((name) => this.host.ofCard(name)),
            shared: entity.sources.filter((source) => !isLocalSource(source)).map((source) => ({ ...source })),
            pending: ordered(groups.flatMap((group) => group.pending)).map((source) => ({ ...source }) as EntitySource),
            apart: ordered([...groups.flatMap((group) => group.apart), ...this.hiddenApart(entity)]).map(
                (source) => ({ ...source }) as EntitySource,
            ),
        };
    }

    /** The group key the entity's decisions are remembered under. */
    private groupKey(entity: Entity): string {
        return this.groupsOf(entity)[0]?.key ?? `${kindFamily(entity.kind)}\u0000${normalizeName(entity.name)}`;
    }

    /** «Это тот же»: the keys (default: every waiting and declared-another source of the name) join. */
    async sameAs(entity: Entity, keys?: readonly string[]): Promise<void> {
        const groups = this.groupsOf(entity);
        const wanted = keys?.length
            ? [...keys]
            : ordered([
                  ...groups.flatMap((group) => [...group.pending, ...group.apart]),
                  ...this.hiddenApart(entity),
              ]).map(sourceKeyOf);
        if (!wanted.length) throw new Error(this.t('m7w.error.noIdentity'));
        const payload = { group: this.groupKey(entity), name: entity.name, keys: [...new Set(wanted)] };
        await this.decide(payload, 'same', this.sourcesOf(payload.group, payload.keys));
    }

    /** «Это другой персонаж»: the keys (default: every card/global source used and waiting) stay out here. */
    async different(entity: Entity, keys?: readonly string[]): Promise<void> {
        const identity = this.identity(entity);
        const wanted = keys?.length ? [...keys] : ordered([...identity.shared, ...identity.pending]).map(sourceKeyOf);
        if (!wanted.length) throw new Error(this.t('m7w.error.noIdentity'));
        const payload = { group: this.groupKey(entity), name: entity.name, keys: [...new Set(wanted)] };
        await this.decide(payload, 'apart', this.sourcesOf(payload.group, payload.keys));
    }

    /** Binds keys without a question or a journal record (sources Maestro made for this chat). */
    async bind(entity: Entity, keys: readonly string[]): Promise<void> {
        const wanted = keys.filter(Boolean);
        if (!wanted.length) return;
        await this.store.load();
        const group = this.groupKey(entity);
        const changed = await this.store.mutate((doc) => {
            const put = putIdentity(doc, wanted, 'same');
            return putAsked(doc, group, wanted, true) || put;
        });
        if (changed) this.host.rebuild();
    }

    /** `${book}#${uid}` of lore entries and archives not used here. */
    foreignRefs(): string[] {
        const refs = new Set<string>();
        for (const group of this.host.build().foreign) {
            for (const source of [...group.pending, ...group.apart]) {
                if (source.world && typeof source.uid === 'number') refs.add(`${source.world}#${source.uid}`);
            }
        }
        return [...refs];
    }

    /* ---------------------------------------------------------------- badges */

    /** A badge on the message where a name with an open question first appears; gone once answered. */
    private syncBadges(present: readonly Present[]): void {
        if (this.disposed) return;
        const doc = this.store.current();
        const wanted = new Map<string, Present>();
        for (const item of present) {
            const asked = new Set(doc.asked[item.group.key] ?? []);
            if (item.first < 0 || !item.group.pending.some((source) => asked.has(sourceKeyOf(source)))) continue;
            wanted.set(item.group.key, item);
        }
        for (const [key, badge] of [...this.badges]) {
            if (wanted.get(key)?.first === badge.index) continue;
            this.badges.delete(key);
            this.unbadge(badge.off);
        }
        for (const [key, item] of wanted) {
            if (this.badges.has(key)) continue;
            try {
                const off = this.app.ui.messageBadge(item.first, {
                    id: `maestro-m7w-same-${stableHash(key)}`,
                    text: this.t(`m7w.sameAs.badge.${nounOf(item.group.kind)}`, { name: item.group.name }),
                    action: { label: this.t('m7w.sameAs.answer'), run: () => this.app.ui.openPult('inbox') },
                });
                this.badges.set(key, { index: item.first, off });
            } catch (error) {
                this.log.debug('identity badge failed', error);
            }
        }
    }

    private unbadge(off: Unsubscribe): void {
        try {
            off();
        } catch {
            // the badge left with its message
        }
    }

    private clearBadges(): void {
        for (const badge of this.badges.values()) this.unbadge(badge.off);
        this.badges.clear();
    }
}
