// M16 «Закулисье»: the service behind OffscreenApi (plan M16, §8, §11, §12, P14–P16).
//
// Turn cycle:
// - turn:committed (the user sent the next message) → O(1) on the send path: the chat's committed-turn counter moves;
//   a moment later (off the send path) the committed reply's DES tracker records who was seen where and when, and the
//   trigger is checked;
// - the trigger: every N committed turns per mode (15 in «Сбалансированный», 10 in «Кино», settings override), and at a
//   scene end in «Кино» (bus signal 'scene.ended'); never in «Экономный»; leader tab only; never during a generation;
//   under the background cost cap. A run is a background task 'offscreen.run' (one pending per chat) for up to three
//   important absent characters picked by importance and time away (cooldown per character);
// - the run asks the cheap model (strict schema, fenced untrusted data) what each one did meanwhile in story time,
//   checks every event against the character's canon, lore, earlier events and quests (the shared contradiction
//   service, inline), and routes it: a conflict or a drastic event (death, prison, removal, a radical change — the
//   model's flag or the rules) always goes to the Inbox; otherwise autonomy kind 'offscreen.event' (default «Само»).
//   Saved events are chat canon additions (type 'event', origin 'backstage'), journaled with undo;
// - rumours: the ephemeral producer may add one note near the end of the prompt (P16), every third turn after a saved
//   event, only when a present character could know (same place, or a relationship with the event's character).
// State per chat in the document 'offscreen' (the leader writes). Nothing here softens the story (§11).
import { tPlural } from '../../core/labels';
import { uniqueStrings } from '../../domain/canon-keys';
import {
    MAX_TEXT_CHARS,
    cleanEventText,
    offscreenComment,
    offscreenContent,
    offscreenKeys,
    parseOffscreenAnswer,
} from '../../domain/offscreen-parse';
import type { ParsedOffscreen } from '../../domain/offscreen-parse';
import {
    cadenceOf,
    committedReplies,
    decideRun,
    lastCommittedReply,
    lastStoryReply,
    pickCandidates,
    pickRumour,
    pushCapped,
    rankCandidates,
    turnsUntil,
} from '../../domain/offscreen-plan';
import type { OffscreenMode, RankedCandidate, RunReason } from '../../domain/offscreen-plan';
import { buildOffscreenMessages, cut, offscreenSchema } from '../../domain/offscreen-prompt';
import type { OffscreenInput } from '../../domain/offscreen-prompt';
import { normalizeName } from '../../domain/world-names';
import type { App, GenerationInfo, JournalChange, Logger, Proposal, Signal, Unsubscribe } from '../../shared/contracts';
import type { CanonMeta } from '../canon/api';
import type { Contradiction } from '../contradictions/api';
import type { OffscreenApi, OffscreenCandidate, OffscreenEvent } from './api';
import {
    MAX_CHARACTERS,
    OFFSCREEN_DEDUPE,
    OFFSCREEN_DOC,
    OFFSCREEN_ID,
    OFFSCREEN_INJECTION,
    OFFSCREEN_KIND,
    OFFSCREEN_LLM_TASK,
    OFFSCREEN_ORIGIN,
    OFFSCREEN_TARGET,
    OFFSCREEN_TASK,
} from './settings';
import type { OffscreenSettings } from './settings';
import type { CharacterBrief, SceneInfo } from './sources';
import { OffscreenSources } from './sources';
import { EVENTS_KEPT, RUNS_KEPT, emptyOffscreenDoc, publicEvent, readOffscreenDoc, trimSeen } from './store';
import type { OffscreenDoc, OffscreenRun, StoredEvent } from './store';

export interface OffscreenTimings {
    /** Pause after a commit or a scene end before the turn is read and the trigger checked (off the send path). */
    settleMs: number;
    /** Pause after reply:ready before the new reply's scene is read (rumours of the next generation). */
    sceneMs: number;
    saveMs: number;
}

export const DEFAULT_TIMINGS: OffscreenTimings = { settleMs: 1500, sceneMs: 700, saveMs: 300 };

/** The note a rumour becomes (one-shot, in-chat, system, near the end: P16). */
export const RUMOUR_PREFIX = 'Rumor the characters may have heard:';

const PRODUCER = 'offscreen';
const MAX_TOKENS = 900;
const TEMPERATURE = 0.8;
const TASK_TTL_MS = 30 * 60_000;
const CHECK_TIMEOUT_MS = 20_000;
/** Committed replies read for last sightings when the module first sees a chat. */
const BOOTSTRAP_SCAN = 300;
/** Offscreen canon items kept active per character; older ones are archived (they return when mentioned). */
const KEEP_ACTIVE = 2;
/** Cooldown when the mode has no cadence (manual runs in «Экономный»). */
const DEFAULT_COOLDOWN = 15;
const EVENTS_DEFAULT = 20;
const PICKER_MAX = 10;
const AGAINST_CHARS = 1500;

const REASONS: readonly RunReason[] = ['interval', 'sceneEnd', 'manual'];

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function newId(): string {
    return `off-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Inbox payload of an event (JSON: cards outlive the page). `entityName`/`value`/`editable` follow the Inbox view. */
export interface OffscreenPayload {
    m16: 1;
    eventId: string;
    chatId: string;
    /** The character (the Inbox groups by it). */
    entityName: string;
    /** The event text (the user may edit it before accepting). */
    value: string;
    editable: true;
    storyTime?: string;
    location?: string;
    keys: string[];
    messageIndex: number;
    drastic: boolean;
    conflict?: string;
}

export function isOffscreenPayload(value: unknown): value is OffscreenPayload {
    return (
        isDict(value) &&
        value.m16 === 1 &&
        typeof value.eventId === 'string' &&
        typeof value.entityName === 'string' &&
        typeof value.value === 'string' &&
        Array.isArray(value.keys)
    );
}

interface Snapshot {
    chatId: string;
    index: number;
    presentKeys: string[];
    placeKey: string | null;
    related: Set<string>;
}

interface Answer {
    events: ParsedOffscreen[];
    costUsd: number;
    error?: string;
}

interface Conflict {
    lines: string[];
    unchecked: boolean;
    costUsd: number;
}

export interface OffscreenStatus {
    mode: OffscreenMode;
    /** A run of this chat is waiting or running. */
    queued: boolean;
    lastRun: OffscreenRun | null;
}

export class OffscreenService implements Required<OffscreenApi> {
    readonly sources: OffscreenSources;
    private doc: OffscreenDoc | null = null;
    private docChat: string | null = null;
    private loading: Promise<void> | null = null;
    private generation = 0;
    private pendingCommits: { index: number; turn: number }[] = [];
    private sceneEnded = false;
    /** A trigger fired during a generation: re-checked when it ends. */
    private wanted = false;
    private snapshot: Snapshot | null = null;
    private lastInjected: { chatId: string; forIndex: number; text: string } | null = null;
    private readonly listeners = new Set<() => void>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private settleTimer: ReturnType<typeof setTimeout> | null = null;
    private sceneTimer: ReturnType<typeof setTimeout> | null = null;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => OffscreenSettings,
        private readonly timings: OffscreenTimings = DEFAULT_TIMINGS,
        sources?: OffscreenSources,
    ) {
        this.sources = sources ?? new OffscreenSources(app, log);
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(own: (dispose: Unsubscribe | (() => void | Promise<void>)) => void): void {
        const { app } = this;
        own(app.tasks.register(OFFSCREEN_TASK, (payload) => this.runTask(payload)));
        own(app.ephemeral.addProducer(PRODUCER, (gen) => this.produce(gen)));
        own(
            app.inbox.registerApplier(
                OFFSCREEN_KIND,
                (payload) => this.applyCard(payload),
                async (payload) => isOffscreenPayload(payload) && this.cardValid(payload),
                (payload) => this.cardRejected(payload),
            ),
        );
        // Permanent: journal records outlive the module (undo then still removes the canon item).
        app.journal.registerUndo(OFFSCREEN_TARGET, (change) => this.undo(change));
        own(app.bus.on('chat:changed', () => void this.open()));
        own(app.bus.on('turn:committed', ({ messageIndex }) => this.commit(messageIndex)));
        own(app.bus.on('reply:ready', ({ messageIndex }) => this.scheduleScene(messageIndex)));
        own(app.bus.on('signal', (signal) => this.onSignal(signal)));
        own(
            app.bus.on('generation:ended', () => {
                if (!this.wanted) return;
                this.wanted = false;
                this.scheduleSettle();
            }),
        );
        own(app.bus.on('message:invalidated', ({ messageIndex, reason }) => this.invalidate(messageIndex, reason)));
        own(
            app.bus.on('leader:changed', ({ leader }) => {
                if (!leader) return;
                this.saveSoon();
                this.scheduleSettle();
                void this.dropForeignEvents();
            }),
        );
        own(() => this.dispose());
        void this.open();
    }

    private dispose(): void {
        if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
            void this.save().catch(() => undefined);
        }
        this.disposed = true;
        this.generation++;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        if (this.settleTimer !== null) clearTimeout(this.settleTimer);
        if (this.sceneTimer !== null) clearTimeout(this.sceneTimer);
        this.settleTimer = null;
        this.sceneTimer = null;
        this.listeners.clear();
    }

    private later(job: () => void | Promise<void>, ms = 0): void {
        if (this.disposed) return;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (this.disposed) return;
            Promise.resolve()
                .then(job)
                .catch((error: unknown) => this.log.error('offscreen job failed', error));
        }, ms);
        this.timers.add(timer);
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private changed(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('offscreen listener failed', error);
            }
        }
    }

    mode(): OffscreenMode {
        const mode = this.app.settings.core().mode;
        return mode === 'economy' || mode === 'cinema' ? mode : 'balanced';
    }

    /** The document of the chat that is open now (null while loading or without a chat). */
    private current(): OffscreenDoc | null {
        const chatId = this.app.host.chatId();
        return this.doc && chatId && this.docChat === chatId ? this.doc : null;
    }

    /** The current chat's document once it is loaded (null without a chat). */
    async ready(): Promise<OffscreenDoc | null> {
        if (!this.current() && this.loading) await this.loading;
        return this.current();
    }

    /* ---------------------------------------------------------------- chat open */

    private open(): Promise<void> {
        const generation = ++this.generation;
        this.doc = null;
        this.docChat = null;
        this.pendingCommits = [];
        this.sceneEnded = false;
        this.wanted = false;
        this.snapshot = null;
        this.lastInjected = null;
        this.changed();
        const loading = this.load(generation);
        this.loading = loading;
        void loading.finally(() => {
            if (this.loading === loading) this.loading = null;
        });
        return loading;
    }

    private async load(generation: number): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId || this.disposed) return;
        let raw: Record<string, unknown>;
        try {
            raw = await this.app.chat.get<Record<string, unknown>>(
                OFFSCREEN_DOC,
                () => emptyOffscreenDoc() as unknown as Record<string, unknown>,
            );
        } catch (error) {
            this.log.warn('offscreen document could not be read', error);
            raw = emptyOffscreenDoc() as unknown as Record<string, unknown>;
        }
        if (generation !== this.generation || this.disposed) return;
        this.doc = readOffscreenDoc(raw);
        this.docChat = chatId;
        this.bootstrap(this.doc);
        void this.dropForeignEvents();
        // The newest reply is the one the next send commits: its scene is where a rumour would be heard.
        this.snapshot = this.makeSnapshot(chatId, lastStoryReply(this.sources.chat()));
        this.changed();
    }

    /**
     * Before 1.10.3 a character known only to global stores (a shared CK character repository, a global lorebook) could
     * get offscreen events in every chat. Once per chat, the leader takes such saved events back: the canon item is
     * removed (journaled by the canon, undoable) and the event is marked rejected. Characters this chat knows stay.
     */
    private async dropForeignEvents(): Promise<void> {
        const doc = this.doc;
        const chatId = this.docChat;
        if (!doc || !chatId || doc.localChecked || this.disposed || !this.app.leader.isLeader()) return;
        const local = new Map(this.sources.candidateInputs(doc, null).map((input) => [input.key, input.local]));
        const foreign = doc.events.filter(
            (event) => event.status === 'saved' && local.get(event.characterKey) === false,
        );
        const canon = this.sources.canon();
        if (foreign.length && !canon) return; // try again when the canon is on
        const names: string[] = [];
        for (const event of foreign) {
            if (chatId !== this.app.host.chatId()) return;
            try {
                if (event.canonUid !== undefined) await canon!.remove(event.canonUid);
            } catch (error) {
                this.log.warn(`offscreen: event of ${event.character} could not be taken out of the canon`, error);
                return;
            }
            delete event.canonUid;
            event.status = 'rejected';
            names.push(event.character);
        }
        doc.localChecked = true;
        this.saveSoon();
        if (names.length) {
            const unique = uniqueStrings(names);
            const list = unique.join(', ');
            this.log.info(`offscreen: took back events of characters from outside this chat: ${list}`);
            const key = unique.length === 1 ? 'm16.foreignRemoved.one' : 'm16.foreignRemoved';
            this.app.ui.notice(this.t(key, { names: list }));
            this.changed();
        }
    }

    /**
     * A chat the module has not seen: the counter starts at the number of committed replies (the first automatic run
     * comes N turns later), and the last sightings are read from the latest committed DES trackers.
     */
    private bootstrap(doc: OffscreenDoc): void {
        if (doc.bootstrapped) return;
        const replies = committedReplies(this.sources.chat());
        if (doc.turns === 0 && doc.lastCommitted < 0) {
            doc.turns = replies.length;
            doc.lastRunTurn = doc.turns;
            doc.lastCommitted = replies[replies.length - 1] ?? -1;
        }
        const recent = replies.slice(-BOOTSTRAP_SCAN).reverse();
        recent.forEach((index, depth) => {
            const scene = this.sources.scene(index);
            for (const character of scene?.present ?? []) {
                if (doc.seen[character.key]) continue;
                doc.seen[character.key] = this.sighting(character.name, Math.max(0, doc.turns - depth), scene!);
            }
        });
        trimSeen(doc.seen);
        doc.bootstrapped = true;
        this.saveSoon();
    }

    private sighting(name: string, turn: number, scene: SceneInfo): OffscreenDoc['seen'][string] {
        const record: OffscreenDoc['seen'][string] = { name, turn, index: scene.index };
        if (scene.place) record.place = scene.place;
        if (scene.storyTime) record.time = scene.storyTime;
        return record;
    }

    /* ---------------------------------------------------------------- commit (send path: O(1)) */

    private commit(index: number): void {
        const doc = this.current();
        if (!doc || index <= doc.lastCommitted) return;
        doc.turns += 1;
        doc.lastCommitted = index;
        this.pendingCommits.push({ index, turn: doc.turns });
        this.scheduleSettle();
    }

    private scheduleSettle(): void {
        if (this.disposed || this.settleTimer !== null) return;
        this.settleTimer = setTimeout(() => {
            this.settleTimer = null;
            void this.settle().catch((error: unknown) => this.log.warn('offscreen turn check failed', error));
        }, this.timings.settleMs);
    }

    /** The committed turns read (who was seen where), the rumour scene refreshed, the trigger checked. */
    private async settle(): Promise<void> {
        const doc = this.current();
        const chatId = this.docChat;
        if (!doc || !chatId) return;
        const commits = this.pendingCommits.splice(0);
        for (const { index, turn } of commits) {
            const scene = this.sources.scene(index);
            for (const character of scene?.present ?? []) {
                const before = doc.seen[character.key];
                if (!before || before.turn <= turn)
                    doc.seen[character.key] = this.sighting(character.name, turn, scene!);
            }
        }
        if (commits.length) {
            trimSeen(doc.seen);
            this.saveSoon();
            const last = commits[commits.length - 1]!.index;
            if (!this.snapshot || this.snapshot.index < last) this.snapshot = this.makeSnapshot(chatId, last);
        }
        await this.evaluate();
        this.changed();
    }

    /* ---------------------------------------------------------------- scenes for rumours */

    private scheduleScene(index: number): void {
        const chat = this.sources.chat();
        const message = chat[index];
        if (!message || message.is_user || index !== chat.length - 1) return;
        if (this.sceneTimer !== null) clearTimeout(this.sceneTimer);
        const generation = this.generation;
        this.sceneTimer = setTimeout(() => {
            this.sceneTimer = null;
            const chatId = this.docChat;
            if (generation !== this.generation || !chatId || this.disposed) return;
            this.snapshot = this.makeSnapshot(chatId, index);
        }, this.timings.sceneMs);
    }

    private makeSnapshot(chatId: string, index: number): Snapshot | null {
        if (index < 0) return null;
        const scene = this.sources.scene(index);
        const present = scene?.present ?? [];
        return {
            chatId,
            index,
            presentKeys: present.map((item) => item.key),
            placeKey: scene?.placeKey ?? null,
            related: this.sources.relatedTo(present),
        };
    }

    /* ---------------------------------------------------------------- the generation (send path) */

    private produce(gen: GenerationInfo): void {
        if (gen.quiet || gen.dryRun || gen.sheetCommand) return;
        const doc = this.current();
        const chatId = this.docChat;
        if (!doc || !chatId || !this.settings().rumours || this.mode() === 'economy') return;
        const chat = this.sources.chat();
        const type = gen.type || 'normal';
        if (type === 'swipe' || type === 'continue' || type === 'regenerate') {
            // The reply that got the rumour is generated again: it gets the same note.
            const forIndex = type === 'regenerate' ? chat.length : chat.length - 1;
            const last = this.lastInjected;
            if (last && last.chatId === chatId && last.forIndex === forIndex) this.inject(last.text);
            return;
        }
        if (type !== 'normal') return;
        const scene = this.snapshot;
        if (!scene || scene.chatId !== chatId) return;
        const event = pickRumour(doc.events, scene, doc.turns);
        if (!event?.rumour) return;
        const text = `${RUMOUR_PREFIX} ${event.rumour.trim()}`;
        this.inject(text);
        event.rumourUsed = true;
        this.lastInjected = { chatId, forIndex: chat.length, text };
        this.saveSoon();
        this.changed();
    }

    private inject(text: string): void {
        // P16: one-shot, near the end of the chat history (before the last message), as a system note.
        this.app.ephemeral.setInjection(OFFSCREEN_INJECTION, { text, position: 1, depth: 1, role: 0, scan: false });
    }

    /* ---------------------------------------------------------------- triggers */

    private onSignal(signal: Signal): void {
        if (signal.kind !== 'scene.ended') return;
        if (signal.chatId !== null && signal.chatId !== this.app.host.chatId()) return;
        this.sceneEnded = true;
        this.scheduleSettle();
    }

    private queued(): boolean {
        const chatId = this.app.host.chatId();
        try {
            return this.app.tasks
                .list()
                .some(
                    (task) =>
                        task.kind === OFFSCREEN_TASK &&
                        task.chatId === chatId &&
                        (task.state === 'pending' || task.state === 'running'),
                );
        } catch {
            return false;
        }
    }

    /** Checks the cadence and queues a run when one is due (leader only; after a generation, never during it). */
    async evaluate(): Promise<RunReason | null> {
        const { host, leader } = this.app;
        const doc = this.current();
        if (this.disposed || !doc || host.isGroupChat() || !leader.isLeader()) return null;
        if (this.queued()) return null;
        const settings = this.settings();
        const reason = decideRun(
            { mode: this.mode(), turnsSince: doc.turns - doc.lastRunTurn, sceneEnded: this.sceneEnded },
            settings,
        );
        if (!reason) {
            this.sceneEnded = false;
            return null;
        }
        if (this.app.turn.current()) {
            this.wanted = true;
            return null;
        }
        if (this.app.cost.backgroundCapReached() || !this.app.llm.available(OFFSCREEN_LLM_TASK)) {
            this.log.debug(`offscreen run due (${reason}) but the background model is not available`);
            return null;
        }
        if (!this.sources.canon()) {
            this.log.debug('offscreen run due but the chat canon is off');
            return null;
        }
        const picked = this.pick(doc, settings.maxCharacters);
        doc.lastRunTurn = doc.turns;
        this.sceneEnded = false;
        if (!picked.length) {
            this.recordRun(doc, {
                at: Date.now(),
                reason,
                characters: [],
                events: 0,
                costUsd: 0,
                error: 'noCandidates',
            });
            this.saveSoon();
            this.changed();
            return null;
        }
        this.saveSoon();
        await this.enqueue(
            reason,
            picked.map((candidate) => candidate.name),
        );
        return reason;
    }

    private cooldown(): number {
        return cadenceOf(this.mode(), this.settings()) ?? DEFAULT_COOLDOWN;
    }

    private scene(): SceneInfo | null {
        return this.sources.scene(lastCommittedReply(this.sources.chat()));
    }

    private pick(doc: OffscreenDoc, max: number): RankedCandidate[] {
        const inputs = this.sources.candidateInputs(doc, this.scene());
        return pickCandidates(inputs, {
            now: doc.turns,
            minAbsent: this.settings().minAbsentTurns,
            cooldown: this.cooldown(),
            max: Math.min(MAX_CHARACTERS, max),
        });
    }

    private async enqueue(reason: RunReason, names: string[]): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        await this.app.tasks.enqueue({
            kind: OFFSCREEN_TASK,
            dedupeKey: OFFSCREEN_DEDUPE,
            payload: { reason, characters: names, chatId },
            chatId,
            ttlMs: TASK_TTL_MS,
        });
        this.app.tasks.kick();
        this.changed();
    }

    /* ---------------------------------------------------------------- the run */

    /** Task runner: never throws (a bad answer is not worth the queue's retries; transport retries are the client's). */
    private async runTask(payload: Record<string, unknown>): Promise<void> {
        try {
            const chatId = str(payload.chatId);
            if (chatId && chatId !== this.app.host.chatId()) return;
            const reason = REASONS.find((item) => item === payload.reason) ?? 'manual';
            await this.execute(reason, strings(payload.characters));
        } catch (error) {
            this.log.error('offscreen run failed', error);
        }
    }

    /** One run for the given characters (re-checked: still absent, not the persona). Null without a chat. */
    async execute(reason: RunReason, names: readonly string[]): Promise<OffscreenRun | null> {
        const { host } = this.app;
        const chatId = host.chatId();
        if (!chatId || host.isGroupChat()) return null;
        const doc = await this.ready();
        if (!doc) return null;
        const generation = this.generation;
        const run: OffscreenRun = { at: Date.now(), reason, characters: [], events: 0, costUsd: 0 };
        const finish = (error?: string): OffscreenRun => {
            if (error) run.error = error;
            if (generation === this.generation && this.current() === doc) {
                this.recordRun(doc, run);
                this.saveSoon();
                this.changed();
            }
            return run;
        };

        const index = lastCommittedReply(this.sources.chat());
        const scene = this.sources.scene(index);
        const present = new Set([...(scene?.present.map((item) => item.key) ?? []), ...this.sources.presentInWorld()]);
        const persona = normalizeName(this.sources.persona());
        run.characters = uniqueStrings(names.map((name) => this.sources.canonical(name)))
            .filter((name) => {
                const key = normalizeName(name);
                return !!key && key !== persona && !present.has(key);
            })
            .slice(0, MAX_CHARACTERS);
        if (!run.characters.length) return finish('noCandidates');
        if (!this.sources.canon()) return finish('noCanon');
        if (this.app.cost.backgroundCapReached()) return finish('cap');
        if (!this.app.llm.available(OFFSCREEN_LLM_TASK)) return finish('noProfile');

        const briefs = await Promise.all(run.characters.map((name) => this.sources.brief(name, doc, scene)));
        const input: OffscreenInput = {
            persona: this.sources.persona(),
            summary: await this.sources.summary(index >= 0 ? index : this.sources.chat().length - 1),
            characters: briefs.map((item) => item.brief),
        };
        if (scene?.storyTime) input.storyTime = scene.storyTime;
        const sceneName = this.sources.placeName(scene?.place);
        if (sceneName) input.scene = sceneName;

        const answer = await this.ask(input, briefs);
        run.costUsd += answer.costUsd;
        if (answer.error) return finish(answer.error);
        for (const parsed of answer.events) {
            if (generation !== this.generation || this.current() !== doc) {
                this.log.warn('chat changed during an offscreen run; the rest of the run was dropped');
                return run;
            }
            const brief = briefs.find((item) => item.brief.name === parsed.character);
            if (!brief) continue;
            const event = this.makeEvent(doc, parsed, scene, index);
            pushCapped(doc.events, event, EVENTS_KEPT);
            run.events++;
            run.costUsd += await this.route(event, brief, chatId);
        }
        return finish();
    }

    /** Asks the model; one more try when the answer could not be read. */
    private async ask(input: OffscreenInput, briefs: readonly CharacterBrief[]): Promise<Answer> {
        const names = input.characters.map((item) => item.name);
        const aliases: Record<string, string[]> = {};
        for (const item of briefs) aliases[item.brief.name] = [...item.brief.aliases, ...(item.entity?.forms ?? [])];
        const messages = buildOffscreenMessages(input);
        let costUsd = 0;
        for (let attempt = 0; attempt < 2; attempt++) {
            const result = await this.app.llm.request<unknown>({
                task: OFFSCREEN_LLM_TASK,
                messages,
                maxTokens: MAX_TOKENS,
                temperature: TEMPERATURE,
                schema: offscreenSchema(names),
            });
            costUsd += result.costUsd ?? 0;
            if (result.ok) {
                const parsed = parseOffscreenAnswer(result.data ?? result.text, names, aliases);
                if (parsed?.events.length) return { events: parsed.events, costUsd };
                if (parsed && attempt > 0) return { events: [], costUsd, error: 'empty' };
            } else if (result.refusal) {
                return { events: [], costUsd, error: 'refusal' };
            } else if (result.error !== 'parse') {
                return { events: [], costUsd, error: result.error ?? 'failed' };
            }
        }
        return { events: [], costUsd, error: 'parse' };
    }

    private makeEvent(doc: OffscreenDoc, parsed: ParsedOffscreen, scene: SceneInfo | null, index: number): StoredEvent {
        const characterKey = normalizeName(parsed.character);
        const event: StoredEvent = {
            id: newId(),
            character: parsed.character,
            characterKey,
            text: parsed.text,
            messageIndex: index >= 0 ? index : doc.lastCommitted,
            status: 'inbox',
            at: Date.now(),
            turn: doc.turns,
        };
        if (scene?.storyTime) event.storyTime = scene.storyTime;
        if (parsed.location) event.location = parsed.location;
        if (parsed.rumour) event.rumour = parsed.rumour;
        if (parsed.drastic) event.drastic = true;
        event.placeKey =
            this.sources.placeKey(parsed.location) ?? this.sources.placeKey(doc.seen[characterKey]?.place) ?? null;
        return event;
    }

    /** Checks an event and routes it: Inbox on a conflict or a drastic event, else autonomy. Returns the check cost. */
    private async route(event: StoredEvent, brief: CharacterBrief, chatId: string): Promise<number> {
        const keys = offscreenKeys(event.character, await this.sources.keyForms(event.character, brief.entity));
        const conflict = await this.conflicts(event, brief);
        if (conflict.lines.length) event.conflict = conflict.lines.join('; ');
        const payload: OffscreenPayload = {
            m16: 1,
            eventId: event.id,
            chatId,
            entityName: event.character,
            value: event.text,
            editable: true,
            keys,
            messageIndex: event.messageIndex,
            drastic: event.drastic === true,
        };
        if (event.storyTime) payload.storyTime = event.storyTime;
        if (event.location) payload.location = event.location;
        if (event.conflict) payload.conflict = event.conflict;
        const proposal = this.proposal(payload, conflict.unchecked);
        try {
            // Never kill, imprison or remove a character, nor contradict the canon, without the user (plan M16 п.5).
            if (event.drastic || conflict.lines.length || conflict.unchecked) {
                await this.app.inbox.add(proposal as Proposal);
                event.status = 'inbox';
            } else {
                const decision = await this.app.autonomy.decide(proposal, 'auto');
                if (decision === 'queued' || decision === 'notified') event.status = 'inbox';
                else if (decision !== 'applied') event.status = 'rejected';
            }
        } catch (error) {
            this.log.warn('offscreen: routing an event failed', error);
            event.status = 'rejected';
        }
        return conflict.costUsd;
    }

    /**
     * The card in story words: what the character did (the model writes events in English, as they go to the canon),
     * where they are now, why it waits for the user and what accepting does. The canon keys go to «Подробнее»; the
     * canon text itself is the change (a technical target).
     */
    private proposal(payload: OffscreenPayload, unchecked: boolean): Proposal<OffscreenPayload> {
        const content = offscreenContent(payload.value, payload.storyTime, payload.location);
        const name = payload.entityName;
        const lines = [
            this.t(payload.storyTime ? 'm16.card.body.time' : 'm16.card.body', {
                time: payload.storyTime ?? '',
                text: payload.value,
            }),
        ];
        if (payload.location) lines.push(this.t('m16.card.location', { place: payload.location }));
        if (payload.drastic) lines.push(this.t('m16.card.drastic'));
        if (payload.conflict) lines.push(this.t('m16.card.conflict', { list: payload.conflict }));
        else if (unchecked) lines.push(this.t('m16.card.unchecked'));
        lines.push(this.t('m16.card.ask', { name }));
        let title = 'm16.card.title';
        if (payload.drastic) title = 'm16.card.title.drastic';
        else if (payload.conflict || unchecked) title = 'm16.card.title.conflict';
        const change: JournalChange = {
            target: OFFSCREEN_TARGET,
            ref: { eventId: payload.eventId, chatId: payload.chatId },
            before: null,
            after: content,
        };
        return {
            module: OFFSCREEN_ID,
            kind: OFFSCREEN_KIND,
            title: this.t(title, { name }),
            description: lines.join('\n'),
            details: this.t('m16.card.keys', { keys: strings(payload.keys).join(', ') }),
            appliedNotice: {
                text: this.t('m16.applied', { name }),
                group: 'm16.applied',
                groupText: (count) => tPlural(this.app.i18n, 'm16.appliedMany', count),
            },
            changes: [change],
            payload,
            sourceMessage: payload.messageIndex >= 0 ? payload.messageIndex : undefined,
            apply: (value) => this.applyPayload(isOffscreenPayload(value) ? value : payload),
            stillValid: () => this.cardValid(payload),
        };
    }

    /**
     * Contradictions with the character's canon, lore, earlier events and quests (the shared M26 service, inline: this
     * runs inside a background task). A failed check means «unchecked», which keeps the event in the Inbox.
     */
    private async conflicts(event: StoredEvent, brief: CharacterBrief): Promise<Conflict> {
        const none: Conflict = { lines: [], unchecked: false, costUsd: 0 };
        const service = this.sources.contradictions();
        const against = brief.against
            .filter((item) => item.text.trim())
            .map((item) => ({ label: item.label, text: cut(item.text, AGAINST_CHARS) }));
        if (!service || !against.length) return none;
        const format = (list: readonly Contradiction[]) =>
            list.slice(0, 3).map((item) => `${item.label}: «${item.conflicting}»`);
        try {
            const result = await service.check(
                { statement: event.text, entities: [event.character], against },
                { inline: true, timeoutMs: CHECK_TIMEOUT_MS },
            );
            if (result.clean) return { ...none, costUsd: result.costUsd };
            const lines = format(result.contradictions);
            return { lines, unchecked: !lines.length, costUsd: result.costUsd };
        } catch (error) {
            this.log.warn('offscreen: contradiction check failed', error);
            return { lines: [], unchecked: true, costUsd: 0 };
        }
    }

    private recordRun(doc: OffscreenDoc, run: OffscreenRun): void {
        pushCapped(doc.runs, { ...run, characters: [...run.characters] }, RUNS_KEPT);
    }

    /* ---------------------------------------------------------------- applying, Inbox, undo */

    private findEvent(id: string): StoredEvent | undefined {
        return this.current()?.events.find((event) => event.id === id);
    }

    /** Writes the event into the chat canon (canon.put journals the entry itself). */
    private async applyPayload(payload: OffscreenPayload): Promise<void> {
        const canon = this.sources.canon();
        if (!canon) throw new Error(this.t('m16.error.noCanon'));
        const text = cleanEventText(payload.value, 6, MAX_TEXT_CHARS * 2);
        if (!text) throw new Error(this.t('m16.error.empty'));
        const meta: Omit<CanonMeta, 'createdAt' | 'updatedAt'> = {
            kind: 'addition',
            status: 'active',
            origin: OFFSCREEN_ORIGIN,
            type: 'event',
        };
        if (payload.messageIndex >= 0) meta.sourceMessage = payload.messageIndex;
        const uid = await canon.put({
            entry: {
                key: offscreenKeys(payload.entityName, strings(payload.keys)),
                keysecondary: [],
                comment: offscreenComment(payload.entityName),
                content: offscreenContent(text, payload.storyTime, payload.location),
            },
            meta,
        });
        const event = this.findEvent(payload.eventId);
        if (event) {
            event.status = 'saved';
            event.canonUid = uid;
            event.text = text;
        }
        await this.archiveOlder(payload.entityName, uid);
        this.saveSoon();
        this.changed();
    }

    /** Only the newest offscreen items of a character stay active; older ones return only when mentioned. */
    private async archiveOlder(name: string, keep: number): Promise<void> {
        const canon = this.sources.canon();
        if (!canon) return;
        try {
            const comment = offscreenComment(name);
            const items = (await canon.list({ origin: OFFSCREEN_ORIGIN, status: 'active' }))
                .filter((item) => item.uid !== keep && item.meta.kind === 'addition' && item.entry.comment === comment)
                .sort((a, b) => b.meta.createdAt - a.meta.createdAt);
            for (const item of items.slice(KEEP_ACTIVE - 1)) await canon.setStatus(item.uid, 'archived');
        } catch (error) {
            this.log.debug('older offscreen items were not archived', error);
        }
    }

    private async applyCard(payload: unknown): Promise<void> {
        if (!isOffscreenPayload(payload)) throw new Error('bad offscreen card');
        await this.applyPayload(payload);
    }

    private async cardValid(payload: OffscreenPayload): Promise<boolean> {
        if (!this.sources.canon() || payload.chatId !== this.app.host.chatId()) return false;
        return this.findEvent(payload.eventId)?.status !== 'saved';
    }

    private async cardRejected(payload: unknown): Promise<void> {
        if (!isOffscreenPayload(payload)) return;
        const event = this.findEvent(payload.eventId);
        if (!event || event.status === 'saved') return;
        event.status = 'rejected';
        this.saveSoon();
        this.changed();
    }

    private async undo(change: JournalChange): Promise<boolean> {
        const canon = this.sources.canon();
        if (!canon) return false;
        const eventId = str(change.ref.eventId);
        const event = eventId ? this.findEvent(eventId) : undefined;
        let uid = event?.canonUid;
        if (uid === undefined && typeof change.after === 'string' && change.after) {
            const items = await canon.list({ origin: OFFSCREEN_ORIGIN });
            uid = items.find((item) => item.entry.content === change.after)?.uid;
        }
        if (uid !== undefined) await canon.remove(uid);
        if (event) {
            event.status = 'rejected';
            delete event.canonUid;
            this.saveSoon();
            this.changed();
        }
        return true;
    }

    /** Swiped, deleted or edited messages: Inbox cards of that message are gone (core drops them), counts follow. */
    private invalidate(index: number, reason: 'swiped' | 'deleted' | 'edited'): void {
        const doc = this.current();
        if (!doc) return;
        let dirty = false;
        for (const event of doc.events) {
            if (event.status === 'inbox' && event.messageIndex === index) {
                event.status = 'rejected';
                dirty = true;
            }
        }
        if (reason === 'deleted' && index <= doc.lastCommitted) {
            doc.lastCommitted = index - 1;
            dirty = true;
        }
        if (this.snapshot && this.snapshot.index >= index) this.snapshot = null;
        if (this.lastInjected && this.lastInjected.forIndex > index) this.lastInjected = null;
        if (!dirty) return;
        this.saveSoon();
        this.changed();
    }

    /* ---------------------------------------------------------------- persistence */

    private saveSoon(): void {
        if (this.disposed || !this.app.leader.isLeader()) return;
        if (this.saveTimer !== null) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.save().catch((error: unknown) => this.log.warn('offscreen document was not saved', error));
        }, this.timings.saveMs);
    }

    private async save(): Promise<void> {
        const doc = this.doc;
        const chatId = this.docChat;
        if (!doc || !chatId || chatId !== this.app.host.chatId() || !this.app.leader.isLeader()) return;
        if (await this.app.chat.put(OFFSCREEN_DOC, doc)) return;
        // Another tab wrote first: the store now knows its version, and the leader's state wins (one retry). The same
        // object is written again: a run in progress holds it.
        if (this.doc !== doc || this.disposed) return;
        await this.app.chat.put(OFFSCREEN_DOC, doc);
    }

    /* ---------------------------------------------------------------- OffscreenApi */

    events(limit = EVENTS_DEFAULT): OffscreenEvent[] {
        const doc = this.current();
        if (!doc) return [];
        const count = Math.max(0, Math.floor(limit));
        return [...doc.events].reverse().slice(0, count).map(publicEvent);
    }

    nextIn(): number | null {
        const doc = this.current();
        if (!doc || this.app.host.isGroupChat()) return null;
        return turnsUntil(this.mode(), this.settings(), doc.turns - doc.lastRunTurn);
    }

    async runNow(characters?: string[]): Promise<void> {
        const { host } = this.app;
        if (!host.chatId()) throw new Error(this.t('m16.error.noChat'));
        if (host.isGroupChat()) throw new Error(this.t('m16.error.group'));
        if (!this.sources.canon()) throw new Error(this.t('m16.error.noCanon'));
        const doc = await this.ready();
        if (!doc) throw new Error(this.t('m16.error.noChat'));
        let names: string[];
        if (characters?.length) {
            const persona = normalizeName(this.sources.persona());
            names = uniqueStrings(characters.map((name) => this.sources.canonical(name))).filter(
                (name) => normalizeName(name) !== persona,
            );
        } else {
            names = this.pick(doc, this.settings().maxCharacters).map((candidate) => candidate.name);
        }
        if (!names.length) throw new Error(this.t('m16.error.noCandidates'));
        // A run by hand also restarts the count to the next automatic one.
        doc.lastRunTurn = doc.turns;
        this.saveSoon();
        await this.enqueue('manual', names.slice(0, MAX_CHARACTERS));
    }

    candidates(): OffscreenCandidate[] {
        const doc = this.current();
        if (!doc) return [];
        const inputs = this.sources.candidateInputs(doc, this.scene());
        const settings = this.settings();
        const preferred = new Set(
            pickCandidates(inputs, {
                now: doc.turns,
                minAbsent: settings.minAbsentTurns,
                cooldown: this.cooldown(),
                max: settings.maxCharacters,
            }).map((candidate) => candidate.key),
        );
        return rankCandidates(inputs, { now: doc.turns, minAbsent: 0, cooldown: 0, max: PICKER_MAX })
            .slice(0, PICKER_MAX)
            .map((candidate) => ({
                name: candidate.name,
                absent: candidate.lastSeenTurn === null ? null : candidate.absence,
                preferred: preferred.has(candidate.key),
            }));
    }

    /** For the pult: the mode, whether a run waits, the last run. */
    status(): OffscreenStatus {
        const doc = this.current();
        const runs = doc?.runs ?? [];
        const last = runs[runs.length - 1];
        return {
            mode: this.mode(),
            queued: this.queued(),
            lastRun: last ? { ...last, characters: [...last.characters] } : null,
        };
    }

    /** The rumour scene prepared for the next generation (tests, pult). */
    rumourScene(): { index: number; presentKeys: string[]; placeKey: string | null; related: string[] } | null {
        const scene = this.snapshot;
        return scene
            ? {
                  index: scene.index,
                  presentKeys: [...scene.presentKeys],
                  placeKey: scene.placeKey,
                  related: [...scene.related],
              }
            : null;
    }
}
