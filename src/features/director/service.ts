// M13 «Режиссёр сцены» and M14 «Темп и повороты»: the service behind DirectorApi.
//
// Turn cycle (plan §5, P14, P15, P16):
// - reply:ready → after a short pause a draft of the reply is read (observe.ts): scene type by rules, place, who is
//   present, own diff against the committed turn before, topic, repetition, picture cues, language, twist sources;
// - turn:committed (the user sent the next message) → the draft is applied in O(1) on the send path: the scene memory
//   goes through the hysteresis, the pacing window gets the turn, a stall may prepare a director's note; a reply that
//   changed since its draft (or has none) is read after the generation instead and applies from the next one;
// - the ephemeral producer (inside the generate interceptor) sets the one-shot flags `maestro_*` for that generation
//   and writes the prepared note (in-chat depth 0, system) unless the user steered in his message (M14 п.4); swipes,
//   continues and regenerations of the reply that got the note get it again;
// - when the rules hesitate, one small background task 'director.scene' asks the cheap model (leader tab, not in
//   «Экономный»); its answer re-decides the latest turn;
// - signals of the committed turn (bus 'signal') arrive later: they count as events; time.skipped re-classifies.
// State per chat in the document 'director' (leader writes). Nothing here softens a scene (plan §11).
import { adaptersOf } from '../../adapters';
import { DIRECTOR_FLAGS, buildDirectorFlags, pictureBudget, pictureMoment } from '../../domain/director-flags';
import type { PictureCue } from '../../domain/director-flags';
import { buildDirectorNote, pickTwist, twistKey } from '../../domain/director-note';
import type { TwistSource } from '../../domain/director-note';
import { detectStall, noteAllowed, steeringReason } from '../../domain/director-pacing';
import type { StallReason } from '../../domain/director-pacing';
import {
    SCENE_KINDS,
    SCENE_SCHEMA,
    buildSceneMessages,
    classifyScene,
    combineScene,
    emptySceneMemory,
    parseSceneAnswer,
    stepScene,
    userCue,
} from '../../domain/director-scene';
import type { CombinedVerdict, SceneKind, SceneMemory, SceneObservation, UserCue } from '../../domain/director-scene';
import { detectSheetCommand } from '../../domain/sheets';
import { cleanForAnalysis } from '../../domain/text-clean';
import type { App, GenerationInfo, Logger, Signal, Unsubscribe } from '../../shared/contracts';
import type { DirectorApi, DirectorNote, SceneState, SceneType, StallState, SuppressedNote } from './api';
import { SceneHints } from './nai';
import { computeDraft, lastCommittedIndex, repetitionByQuality, stampOf } from './observe';
import type { Draft } from './observe';
import type { DirectorMode, DirectorSettings } from './settings';
import {
    DIRECTOR_DOC,
    NOTES_KEPT,
    SEEN_KEPT,
    TURNS_KEPT,
    emptyDirectorDoc,
    isSceneKind,
    readDirectorDoc,
} from './store';
import type { DirectorDoc } from './store';
import { freshMark } from '../../domain/turn-mark';

export const SCENE_TASK = 'director.scene';
export const NOTE_INJECTION = 'director';
const PRODUCER = 'director';
const SCENE_MAX_TOKENS = 80;
const TASK_TTL_MS = 3 * 60_000;

// The domain's scene kinds are exactly the API's scene types (src/domain cannot import feature types).
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const sameKinds: Exact<SceneType, SceneKind> = true;
void sameKinds;

/** Signal kinds that mean «something happened» for pacing (M14 п.1). */
const EVENT_SIGNALS = new Set([
    'location.changed',
    'quest.added',
    'quest.removed',
    'relationship.changed',
    'character.appeared',
    'character.left',
    'time.skipped',
    'scene.ended',
]);

export interface DirectorTimings {
    /** Pause after reply:ready before the draft is read (DES, DES-RU, NAI markers and quality finish first). */
    draftMs: number;
    /** Pause before a commit without a usable draft is read (after the generation ends). */
    lateMs: number;
    saveMs: number;
}

export const DEFAULT_TIMINGS: DirectorTimings = { draftMs: 700, lateMs: 400, saveMs: 300 };

export interface ModelState {
    messageIndex: number;
    state: 'queued' | 'answered' | 'failed';
    type?: SceneType;
}

type PendingNote = DirectorNote & { chatId: string };

/** The user's message that committed a turn, read for its scene cue (P15: one short message, rules only). */
interface CommitCue {
    cue: UserCue;
    text: string;
}

interface LastCommit {
    index: number;
    before: SceneMemory;
    draft: Draft;
    cue: CommitCue | null;
}

const USER_EXCERPT_CHARS = 600;

function cloneMemory(memory: SceneMemory): SceneMemory {
    return {
        current: memory.current ? { ...memory.current } : null,
        candidate: memory.candidate ? { ...memory.candidate } : null,
    };
}

function publicNote(note: DirectorNote): DirectorNote {
    const copy: DirectorNote & { chatId?: string } = { ...note };
    delete copy.chatId;
    if (note.reasons) copy.reasons = [...note.reasons];
    return copy;
}

export class DirectorService implements Required<DirectorApi> {
    private doc: DirectorDoc | null = null;
    private docChat: string | null = null;
    private generation = 0;
    private readonly drafts = new Map<number, Draft>();
    private lastCommit: LastCommit | null = null;
    private pendingNote: PendingNote | null = null;
    private lastInjected: { chatId: string; forIndex: number; text: string } | null = null;
    private suppressedNote: SuppressedNote | null = null;
    private stallState: StallState = { turns: 0, reasons: [] };
    private model: ModelState | null = null;
    /** Commits without a usable draft, read after the generation. */
    private readonly late = new Set<number>();
    /** Event signals that arrived for a turn before it was applied. */
    private readonly earlySignals = new Map<number, number>();
    private readonly listeners = new Set<() => void>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private draftTimer: ReturnType<typeof setTimeout> | null = null;
    private lateTimer: ReturnType<typeof setTimeout> | null = null;
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;
    readonly hints: SceneHints;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => DirectorSettings,
        private readonly timings: DirectorTimings = DEFAULT_TIMINGS,
    ) {
        this.hints = new SceneHints(app, log);
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(own: (dispose: Unsubscribe | (() => void | Promise<void>)) => void): void {
        const { app } = this;
        own(app.ephemeral.addProducer(PRODUCER, (gen) => this.produce(gen)));
        own(app.tasks.register(SCENE_TASK, (payload) => this.runModel(payload)));
        own(app.bus.on('chat:changed', () => void this.open()));
        own(app.bus.on('reply:ready', ({ messageIndex }) => this.scheduleDraft(messageIndex)));
        own(app.bus.on('turn:committed', ({ messageIndex }) => this.commit(messageIndex)));
        own(app.bus.on('message:invalidated', ({ messageIndex, reason }) => this.invalidate(messageIndex, reason)));
        own(app.bus.on('signal', (signal) => this.onSignal(signal)));
        own(app.bus.on('generation:ended', () => this.scheduleLate()));
        own(app.leader.onChange((leader) => leader && this.saveSoon()));
        own(() => this.dispose());
        void this.open();
    }

    private dispose(): void {
        if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
            void this.save();
        }
        this.disposed = true;
        this.generation++;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        if (this.draftTimer !== null) clearTimeout(this.draftTimer);
        if (this.lateTimer !== null) clearTimeout(this.lateTimer);
        this.draftTimer = null;
        this.lateTimer = null;
        this.hints.dispose();
        this.listeners.clear();
    }

    private later(job: () => void | Promise<void>, ms = 0): void {
        if (this.disposed) return;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (this.disposed) return;
            Promise.resolve()
                .then(job)
                .catch((error: unknown) => this.log.error('director job failed', error));
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
                this.log.error('director listener failed', error);
            }
        }
    }

    private mode(): DirectorMode {
        const mode = this.app.settings.core().mode;
        return mode === 'economy' || mode === 'cinema' ? mode : 'balanced';
    }

    /** The document of the chat that is open now (null while loading or without a chat). */
    private current(): DirectorDoc | null {
        const chatId = this.app.host.chatId();
        return this.doc && chatId && this.docChat === chatId ? this.doc : null;
    }

    /* ---------------------------------------------------------------- chat open */

    private async open(): Promise<void> {
        const generation = ++this.generation;
        this.doc = null;
        this.docChat = null;
        this.drafts.clear();
        this.late.clear();
        this.earlySignals.clear();
        this.lastCommit = null;
        this.pendingNote = null;
        this.lastInjected = null;
        this.suppressedNote = null;
        this.model = null;
        this.stallState = { turns: 0, reasons: [] };
        this.changed();
        const chatId = this.app.host.chatId();
        if (!chatId || this.disposed) return;
        let raw: Record<string, unknown>;
        try {
            raw = await this.app.chat.get<Record<string, unknown>>(
                DIRECTOR_DOC,
                () => emptyDirectorDoc() as unknown as Record<string, unknown>,
            );
        } catch (error) {
            this.log.warn('director document could not be read', error);
            raw = emptyDirectorDoc() as unknown as Record<string, unknown>;
        }
        if (generation !== this.generation || this.disposed) return;
        const doc = readDirectorDoc(raw);
        const fresh = doc.lastCommitted < 0 && !doc.memory.current;
        if (fresh && !doc.seen.length) doc.seen = this.rosterKeys();
        this.doc = doc;
        this.docChat = chatId;
        const stall = detectStall(doc.turns, this.settings().stallTurns);
        this.stallState = { turns: stall.turns, reasons: stall.reasons };
        this.hints.sync();
        this.changed();
        if (fresh) this.later(() => this.bootstrap(generation));
    }

    /** Names DES already knows in this chat: a director switched on mid-story sees no «first appearances». */
    private rosterKeys(): string[] {
        try {
            return adaptersOf(this.app)
                .des.knownCharacters()
                .map((name) => name.normalize('NFC').toLowerCase().replace(/ё/g, 'е').replace(/\s+/g, ' ').trim())
                .filter(Boolean)
                .slice(-SEEN_KEPT);
        } catch {
            return [];
        }
    }

    /** A chat the director has not seen: the scene of the last committed reply, without notes or pictures. */
    private async bootstrap(generation: number): Promise<void> {
        const doc = this.current();
        if (!doc || generation !== this.generation || doc.lastCommitted >= 0) return;
        const index = lastCommittedIndex(this.app.host.ctx().chat ?? []);
        if (index < 0) return;
        const draft = await computeDraft(this.app, index, this.draftContext(doc), this.log);
        if (generation !== this.generation || this.current() !== doc || doc.lastCommitted >= 0) return;
        this.apply(draft, { quiet: true, cue: this.cueAfter(index) });
    }

    /* ---------------------------------------------------------------- drafts */

    private draftContext(doc: DirectorDoc): { seen: ReadonlySet<string>; lastPlace: string | null } {
        return { seen: new Set(doc.seen), lastPlace: doc.lastPlace };
    }

    /** The doc's commit mark, reset when it points past the end of the chat (messages deleted while unseen). */
    private committedMark(doc: DirectorDoc): number {
        const mark = freshMark(doc.lastCommitted, this.app.host.ctx().chat?.length ?? 0);
        if (mark !== doc.lastCommitted) doc.lastCommitted = mark;
        return mark;
    }

    private scheduleDraft(index: number): void {
        const doc = this.current();
        if (!doc || index <= this.committedMark(doc)) return;
        const chat = this.app.host.ctx().chat ?? [];
        const message = chat[index];
        if (!message || message.is_user || index !== chat.length - 1) return;
        if (this.draftTimer !== null) clearTimeout(this.draftTimer);
        const generation = this.generation;
        this.draftTimer = setTimeout(() => {
            this.draftTimer = null;
            void this.makeDraft(index, generation).catch((error: unknown) =>
                this.log.error('director draft failed', error),
            );
        }, this.timings.draftMs);
    }

    private async makeDraft(index: number, generation: number): Promise<void> {
        const doc = this.current();
        if (!doc || generation !== this.generation || index <= doc.lastCommitted) return;
        const draft = await computeDraft(this.app, index, this.draftContext(doc), this.log);
        if (generation !== this.generation || this.disposed || index <= doc.lastCommitted) return;
        for (const key of [...this.drafts.keys()]) if (key !== index) this.drafts.delete(key);
        this.drafts.set(index, draft);
    }

    /* ---------------------------------------------------------------- commit (send path: O(1)) */

    private commit(index: number): void {
        const doc = this.current();
        if (!doc) return;
        if (index <= this.committedMark(doc)) return;
        const draft = this.drafts.get(index);
        const message = this.app.host.ctx().chat?.[index];
        this.drafts.delete(index);
        if (draft && draft.stamp === stampOf(message)) {
            this.apply(draft, { cue: this.cueAfter(index) });
        } else {
            this.late.add(index);
            this.scheduleLate();
        }
        this.hints.sync();
    }

    /** Reads commits without a usable draft once no generation runs (they apply from the next generation on). */
    private scheduleLate(): void {
        if (!this.late.size || this.disposed) return;
        if (this.lateTimer !== null) clearTimeout(this.lateTimer);
        const generation = this.generation;
        this.lateTimer = setTimeout(() => {
            this.lateTimer = null;
            if (this.app.turn.current()) return; // generation:ended calls again
            void this.readLate(generation).catch((error: unknown) =>
                this.log.error('director late read failed', error),
            );
        }, this.timings.lateMs);
    }

    private async readLate(generation: number): Promise<void> {
        for (const index of [...this.late].sort((a, b) => a - b)) {
            this.late.delete(index);
            const doc = this.current();
            if (!doc || generation !== this.generation) return;
            if (index <= doc.lastCommitted) continue;
            const draft = await computeDraft(this.app, index, this.draftContext(doc), this.log);
            if (generation !== this.generation || this.current() !== doc || index <= doc.lastCommitted) return;
            this.apply(draft, { cue: this.cueAfter(index) });
        }
    }

    /**
     * The scene cue of the user's message that committed the reply at `index` (the first user message after it). Runs
     * on the send path: one message, cleaned and read by the rule dictionaries, well under a millisecond (P15).
     */
    private cueAfter(index: number): CommitCue | null {
        const chat = this.app.host.ctx().chat ?? [];
        for (let i = index + 1; i < chat.length; i++) {
            const message = chat[i];
            if (!message || message.is_system) continue;
            if (!message.is_user || detectSheetCommand(message.mes)) return null;
            const text = cleanForAnalysis(message);
            return text ? { cue: userCue(text), text: text.slice(0, USER_EXCERPT_CHARS) } : null;
        }
        return null;
    }

    private observation(verdict: CombinedVerdict, messageIndex: number): SceneObservation {
        const observation: SceneObservation = {
            type: verdict.type,
            confidence: verdict.confidence,
            by: 'rules',
            messageIndex,
        };
        if (verdict.byUser) observation.fromUserMessage = true;
        return observation;
    }

    /**
     * One committed turn. `quiet` (a chat opened for the first time): the scene only, no pacing record, note, picture
     * or model.
     */
    private apply(draft: Draft, options: { quiet?: boolean; cue?: CommitCue | null } = {}): void {
        const doc = this.doc;
        if (!doc) return;
        const settings = this.settings();
        if (draft.skip) {
            doc.lastCommitted = draft.index;
            this.changed();
            this.saveSoon();
            return;
        }
        const previousType = this.effectiveType();
        const before = cloneMemory(doc.memory);
        const cue = options.cue ?? null;
        // The user's own move often sets the scene of the reply about to be written: his message weighs in.
        const verdict = combineScene(draft.verdict, cue?.cue, settings.userWeight);
        doc.memory = stepScene(doc.memory, this.observation(verdict, draft.index));
        this.lastCommit = { index: draft.index, before, draft, cue };
        if (doc.override) doc.overrideHeld++;
        doc.explicitHits = verdict.explicit;
        if (draft.language) doc.language = draft.language;
        const seen = new Set(doc.seen);
        for (const key of draft.presentKeys) seen.add(key);
        doc.seen = [...seen].slice(-SEEN_KEPT);
        if (draft.placeKey) doc.lastPlace = draft.placeKey;
        doc.lastCommitted = draft.index;

        if (options.quiet) {
            doc.picture = null;
        } else {
            const type = this.effectiveType();
            const cues: PictureCue[] = [...draft.cues];
            let climax = draft.climax;
            if (type !== previousType && previousType !== null && (type === 'combat' || type === 'intimate')) climax++;
            if (climax > 0 && !cues.includes('climax')) cues.push('climax');
            const picture =
                settings.pictures && pictureMoment({ cues, climax, mode: this.mode(), budget: this.budget() });
            doc.picture = picture ? { messageIndex: draft.index, cues } : null;

            doc.turns.push({
                index: draft.index,
                place: draft.placeKey,
                events: draft.events + (this.earlySignals.get(draft.index) ?? 0),
                known: draft.known || this.earlySignals.has(draft.index),
                repetition: draft.repetition || repetitionByQuality(this.app, draft.index),
                topic: draft.topic,
            });
            this.earlySignals.delete(draft.index);
            if (doc.turns.length > TURNS_KEPT) doc.turns.splice(0, doc.turns.length - TURNS_KEPT);
            doc.turnsSinceNote++;
            this.pace(draft.sources);
            if (verdict.unsure && this.modelAllowed()) {
                this.later(() => this.enqueueModel(draft, verdict, cue?.text ?? ''));
            }
        }
        this.changed();
        this.saveSoon();
    }

    /** Stall detection after a committed turn; may prepare a note for the next generation. */
    private pace(sources: readonly TwistSource[]): void {
        const doc = this.doc;
        if (!doc) return;
        const settings = this.settings();
        const stall = detectStall(doc.turns, settings.stallTurns);
        this.stallState = { turns: stall.turns, reasons: stall.reasons };
        if (this.pendingNote && !this.pendingNote.nudged && !stall.stalled) this.pendingNote = null;
        if (!stall.stalled || this.pendingNote) return;
        if (!noteAllowed(settings.every[this.mode()], doc.turnsSinceNote)) return;
        // An intimate scene that «stays in one place» is no stall: the director never cuts it short (plan §11).
        if (this.effectiveType() === 'intimate') return;
        const note = this.makeNote(sources, stall.reasons, stall.turns, false);
        if (note) this.pendingNote = note;
    }

    private makeNote(
        sources: readonly TwistSource[],
        reasons: readonly StallReason[],
        turns: number,
        nudged: boolean,
    ): PendingNote | null {
        const doc = this.doc;
        const chatId = this.docChat;
        if (!doc || !chatId) return null;
        const recent = doc.notes.slice(-3).map((note) => twistKey(note.source, note.detail ?? ''));
        const twist = pickTwist(sources, recent);
        if (!twist) return null;
        const text = buildDirectorNote({
            twist,
            reasons,
            turns: Math.max(turns, this.settings().stallTurns),
            scene: this.effectiveType(),
            userName: (this.app.host.ctx().name1 ?? '').trim(),
            nudged,
        });
        const note: PendingNote = {
            chatId,
            at: Date.now(),
            messageIndex: doc.lastCommitted,
            text,
            source: twist.kind,
            detail: twist.text,
            reasons: nudged ? [] : [...reasons],
        };
        if (nudged) note.nudged = true;
        return note;
    }

    private budget(): ReturnType<typeof pictureBudget> {
        try {
            return pictureBudget(adaptersOf(this.app).nai.settings());
        } catch {
            return 'unknown';
        }
    }

    private naiPresent(): boolean {
        try {
            return adaptersOf(this.app).nai.present();
        } catch {
            return false;
        }
    }

    /* ---------------------------------------------------------------- the model for unsure scenes */

    private modelAllowed(): boolean {
        const { app } = this;
        if (!this.settings().model || this.mode() === 'economy' || !app.leader.isLeader()) return false;
        try {
            return app.llm.available(SCENE_TASK) && !app.cost.backgroundCapReached();
        } catch {
            return false;
        }
    }

    private async enqueueModel(draft: Draft, verdict: CombinedVerdict, nextUserText: string): Promise<void> {
        const chatId = this.docChat;
        if (!chatId || !this.modelAllowed() || this.lastCommit?.index !== draft.index) return;
        const payload: Record<string, unknown> = {
            chatId,
            messageIndex: draft.index,
            stamp: draft.stamp,
            text: draft.excerpt,
            userText: draft.userExcerpt,
            nextUserText,
            location: draft.locationLabel ?? '',
            present: draft.present,
            candidates: [verdict.type, verdict.second],
        };
        try {
            await this.app.tasks.enqueue({
                kind: SCENE_TASK,
                dedupeKey: `${SCENE_TASK}:${chatId}`,
                payload,
                chatId,
                ttlMs: TASK_TTL_MS,
                priority: 2,
            });
            this.model = { messageIndex: draft.index, state: 'queued' };
            this.changed();
            this.app.tasks.kick();
        } catch (error) {
            this.log.warn('scene check could not be queued', error);
        }
    }

    /** Task runner: one small request; never throws (a bad answer keeps the rules' decision). */
    private async runModel(payload: Record<string, unknown>): Promise<void> {
        const index = typeof payload.messageIndex === 'number' ? payload.messageIndex : -1;
        const chatId = typeof payload.chatId === 'string' ? payload.chatId : '';
        const fresh = () =>
            !this.disposed &&
            chatId === this.app.host.chatId() &&
            this.lastCommit?.index === index &&
            this.lastCommit.draft.stamp === payload.stamp;
        if (!fresh()) return;
        const strings = (value: unknown) =>
            Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
        const candidates = strings(payload.candidates).filter(isSceneKind);
        const messages = buildSceneMessages({
            text: typeof payload.text === 'string' ? payload.text : '',
            userText: typeof payload.userText === 'string' ? payload.userText : '',
            nextUserText: typeof payload.nextUserText === 'string' ? payload.nextUserText : '',
            location: typeof payload.location === 'string' ? payload.location : '',
            present: strings(payload.present),
            candidates: candidates.length ? candidates : [...SCENE_KINDS].slice(0, 2),
        });
        let answer: { type: SceneKind; confidence: number } | null = null;
        try {
            const response = await this.app.llm.request<unknown>({
                task: SCENE_TASK,
                messages,
                maxTokens: SCENE_MAX_TOKENS,
                temperature: 0,
                schema: { name: 'director_scene', schema: SCENE_SCHEMA },
            });
            answer = response.ok ? parseSceneAnswer(response.data ?? response.text) : null;
            if (!response.ok) this.log.debug('scene check failed', response.error);
        } catch (error) {
            this.log.debug('scene check request failed', error);
        }
        if (!fresh()) return;
        if (!answer) {
            this.model = { messageIndex: index, state: 'failed' };
            this.changed();
            return;
        }
        this.model = { messageIndex: index, state: 'answered', type: answer.type };
        this.redecide(index, { ...answer, by: 'model', messageIndex: index });
    }

    /** The latest committed turn decided again (the model's answer, a late time skip). */
    private redecide(index: number, observation: SceneObservation): void {
        const commit = this.lastCommit;
        const doc = this.doc;
        if (!commit || !doc || commit.index !== index) return;
        doc.memory = stepScene(commit.before, observation);
        this.changed();
        this.saveSoon();
    }

    modelState(): ModelState | null {
        return this.model ? { ...this.model } : null;
    }

    /* ---------------------------------------------------------------- signals and invalidation */

    private onSignal(signal: Signal): void {
        const doc = this.current();
        if (!doc || signal.chatId !== this.docChat || typeof signal.messageIndex !== 'number') return;
        if (!EVENT_SIGNALS.has(signal.kind)) return;
        const index = signal.messageIndex;
        const record = doc.turns.find((turn) => turn.index === index);
        if (record) {
            record.events++;
            record.known = true;
        } else if (index > doc.lastCommitted) {
            this.earlySignals.set(index, (this.earlySignals.get(index) ?? 0) + 1);
            return;
        } else {
            return;
        }
        const commit = this.lastCommit;
        if (signal.kind === 'time.skipped' && commit?.index === index && !commit.draft.input.timeSkipped) {
            const input = { ...commit.draft.input, timeSkipped: true };
            const verdict = classifyScene(input);
            commit.draft = { ...commit.draft, input, verdict };
            const combined = combineScene(verdict, commit.cue?.cue, this.settings().userWeight);
            this.redecide(index, this.observation(combined, index));
        }
        const stall = detectStall(doc.turns, this.settings().stallTurns);
        this.stallState = { turns: stall.turns, reasons: stall.reasons };
        if (this.pendingNote && !this.pendingNote.nudged && !stall.stalled) this.pendingNote = null;
        this.changed();
        this.saveSoon();
    }

    private invalidate(index: number, reason: 'swiped' | 'deleted' | 'edited'): void {
        for (const key of [...this.drafts.keys()]) if (key >= index) this.drafts.delete(key);
        const doc = this.current();
        if (!doc) return;
        if (index > doc.lastCommitted) {
            // The reply not yet committed changed: read it again (a swipe brings its own reply:ready).
            if (reason === 'edited') this.scheduleDraft(index);
            return;
        }
        const commit = this.lastCommit;
        if (commit && commit.index >= index) {
            doc.memory = commit.before;
            this.lastCommit = null;
        }
        doc.turns = doc.turns.filter((turn) => turn.index < index);
        doc.lastCommitted = Math.min(doc.lastCommitted, index - 1);
        if (reason !== 'deleted') {
            const chat = this.app.host.ctx().chat ?? [];
            if (lastCommittedIndex(chat) === index) {
                this.late.add(index);
                this.scheduleLate();
            }
        }
        const stall = detectStall(doc.turns, this.settings().stallTurns);
        this.stallState = { turns: stall.turns, reasons: stall.reasons };
        this.changed();
        this.saveSoon();
    }

    /* ---------------------------------------------------------------- the generation (send path) */

    private produce(gen: GenerationInfo): void {
        if (gen.quiet || gen.dryRun || gen.sheetCommand) return;
        const doc = this.current();
        const chatId = this.docChat;
        if (!doc || !chatId) return;
        for (const [name, value] of Object.entries(this.flags())) this.app.ephemeral.setFlag(name, value);
        const chat = this.app.host.ctx().chat ?? [];
        const type = gen.type || 'normal';
        if (type === 'normal') {
            this.writeNote(doc, chatId, chat);
            return;
        }
        if (type === 'swipe' || type === 'continue' || type === 'regenerate') {
            const forIndex = type === 'regenerate' ? chat.length : chat.length - 1;
            const last = this.lastInjected;
            if (last && last.chatId === chatId && last.forIndex === forIndex) this.inject(last.text);
        }
    }

    private writeNote(doc: DirectorDoc, chatId: string, chat: readonly STChatMessage[]): void {
        const note = this.pendingNote;
        if (!note) return;
        if (note.chatId !== chatId) {
            this.pendingNote = null;
            return;
        }
        const forIndex = chat.length;
        const last = chat[chat.length - 1];
        const userText = last?.is_user ? cleanForAnalysis(last) : '';
        // A clear move of the user (an attack, a kiss, a time skip) is steering too (M14 п.4).
        const reason = userText ? (steeringReason(userText) ?? (userCue(userText).strong ? 'action' : null)) : null;
        this.pendingNote = null;
        if (reason) {
            this.suppressedNote = { at: Date.now(), messageIndex: forIndex, reason };
            this.changed();
            return;
        }
        this.inject(note.text);
        const written = publicNote({ ...note, at: Date.now(), messageIndex: forIndex });
        doc.notes.push(written);
        if (doc.notes.length > NOTES_KEPT) doc.notes.splice(0, doc.notes.length - NOTES_KEPT);
        doc.turnsSinceNote = 0;
        this.lastInjected = { chatId, forIndex, text: note.text };
        this.changed();
        this.saveSoon();
    }

    private inject(text: string): void {
        // P16: one-shot, at the very end of the chat history, as a system message; cleared after the generation.
        this.app.ephemeral.setInjection(NOTE_INJECTION, { text, position: 1, depth: 0, role: 0, scan: false });
    }

    /* ---------------------------------------------------------------- persistence */

    private saveSoon(): void {
        if (this.disposed || !this.app.leader.isLeader()) return;
        if (this.saveTimer !== null) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.save().catch((error: unknown) => this.log.warn('director document was not saved', error));
        }, this.timings.saveMs);
    }

    private async save(): Promise<void> {
        const doc = this.doc;
        const chatId = this.docChat;
        if (!doc || !chatId || chatId !== this.app.host.chatId() || !this.app.leader.isLeader()) return;
        if (await this.app.chat.put(DIRECTOR_DOC, doc)) return;
        // Another tab wrote first: this tab's state wins (the director's state is per turn; one retry).
        const generation = this.generation;
        const fresh = readDirectorDoc(
            await this.app.chat.get<Record<string, unknown>>(
                DIRECTOR_DOC,
                () => emptyDirectorDoc() as unknown as Record<string, unknown>,
            ),
        );
        if (generation !== this.generation || this.doc !== doc) return;
        Object.assign(fresh, { ...doc });
        this.doc = fresh;
        await this.app.chat.put(DIRECTOR_DOC, fresh);
    }

    /* ---------------------------------------------------------------- DirectorApi */

    private effectiveType(): SceneKind | null {
        const doc = this.doc;
        if (!doc) return null;
        return doc.override ?? doc.memory.current?.type ?? null;
    }

    scene(): SceneState | null {
        const doc = this.current();
        if (!doc) return null;
        const current = doc.memory.current;
        if (doc.override) {
            return {
                type: doc.override,
                confidence: 1,
                messageIndex: current?.messageIndex ?? doc.lastCommitted,
                by: 'user',
                held: doc.overrideHeld,
            };
        }
        return current ? { ...current } : null;
    }

    async setScene(type: SceneType | null): Promise<void> {
        const doc = this.current();
        if (!doc) return;
        if (type !== null && !isSceneKind(type)) throw new Error(`unknown scene type: ${String(type)}`);
        if (doc.override === type) return;
        doc.override = type;
        doc.overrideHeld = 0;
        this.changed();
        this.saveSoon();
    }

    override(): SceneType | null {
        return this.current()?.override ?? null;
    }

    candidate(): { type: SceneType; confidence: number } | null {
        const candidate = this.current()?.memory.candidate;
        return candidate ? { type: candidate.type, confidence: candidate.confidence } : null;
    }

    stall(): StallState {
        return { turns: this.stallState.turns, reasons: [...this.stallState.reasons] };
    }

    notes(): DirectorNote[] {
        return (this.current()?.notes ?? []).map(publicNote);
    }

    pending(): DirectorNote | null {
        const note = this.pendingNote;
        return note && note.chatId === this.app.host.chatId() ? publicNote(note) : null;
    }

    suppressed(): SuppressedNote | null {
        return this.current() && this.suppressedNote ? { ...this.suppressedNote } : null;
    }

    async nudge(): Promise<DirectorNote | null> {
        const doc = this.current();
        if (!doc) return null;
        const generation = this.generation;
        const chat = this.app.host.ctx().chat ?? [];
        const index = doc.lastCommitted >= 0 ? doc.lastCommitted : lastCommittedIndex(chat);
        let sources: TwistSource[] = [];
        if (index >= 0) {
            const draft = await computeDraft(this.app, index, this.draftContext(doc), this.log);
            sources = draft.sources;
        }
        if (generation !== this.generation || this.current() !== doc) return null;
        const note = this.makeNote(sources, this.stallState.reasons, this.stallState.turns, true);
        if (!note) return null;
        this.pendingNote = note;
        this.suppressedNote = null;
        this.changed();
        return publicNote(note);
    }

    flags(): Record<string, string> {
        const doc = this.current();
        if (!doc) return {};
        const scene = this.effectiveType();
        const settings = this.settings();
        const picture = !!doc.picture && settings.pictures && this.mode() !== 'economy' && this.naiPresent();
        return buildDirectorFlags({
            scene,
            explicit: scene === 'intimate' || doc.explicitHits >= 2,
            language: doc.language,
            picture,
        });
    }

    /** Every flag the director may set (copies of DIRECTOR_FLAGS), for the Preset Studio's conditional blocks. */
    catalogue(): { name: string; titleKey: string; descriptionKey: string }[] {
        return DIRECTOR_FLAGS.map((flag) => ({ ...flag }));
    }

    /** Picture cues of the last committed turn (pult). */
    pictureCues(): PictureCue[] {
        return [...(this.current()?.picture?.cues ?? [])];
    }

    /** The memory without the override (tests, pult). */
    memory(): SceneMemory {
        return cloneMemory(this.current()?.memory ?? emptySceneMemory());
    }
}
