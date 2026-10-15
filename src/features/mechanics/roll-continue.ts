// M25 «Механики», a roll in the middle of a reply (release 1.27, settings.rollContinue, on by default): the model stops
// its reply at a risky moment with `roll: …` in its service block; the checks part rolls it as the reply arrives
// (tracking → checks.requested), and this part makes the SAME reply go on with the result instead of waiting a whole
// turn for the user's next message:
// - a plan is made only for a reply that is arriving (the tracking read its block on MESSAGE_RECEIVED and says so):
//   an edit or a re-read of an older reply never continues anything by itself; nor does a generation the user stopped;
// - the continue goes once the reply's generation has ended (not stopped) AND the reply has been shown (`reply:ready`,
//   after the neighbours' render work) — in either order: ST 1.19 ends a streamed generation (GENERATION_ENDED from
//   hideStopButton) before MESSAGE_RECEIVED, a non-streamed one after it. On the next tick Maestro sends `/continue` —
//   only while the reply is the last message and still the same variant, no generation runs (Maestro's turn pipeline)
//   and the send box is empty (a /continue would clear what the user typed: the quality check's guard, whose StActions
//   it uses). The continue generation gets the rolls as facts (prompt.ts: pending results are given to the next
//   generation of any type, and marked delivered when it ends);
// - at most one automatic continue per reply variant (chat|index|swipe): a continuation that asks for more rolls gets
//   them rolled, and they reach the next generation as before;
// - `continuing(index)` is true from the plan until the continue generation ends (MechanicsApi.continuing): the quality
//   check then leaves the cut-off reply alone instead of continuing it too;
// - when it cannot start (the send box holds text, a generation runs, another variant is shown, ST cannot /continue)
//   the results simply wait for the next generation, as before 1.27, and the debug log says why.
import type { GenerationInfo, Unsubscribe } from '../../shared/contracts';
import { StActions, swipeIdOf } from '../quality/actions';
import type { PartDeps } from './parts';

/** How long the /continue may take to start (ST's command waits for the generation lock) before it counts as lost. */
const START_WAIT_MS = 20_000;
/** A plan whose reply never ended or never showed is dropped after this long. */
const PLAN_TTL_MS = 60_000;

interface Plan {
    chatId: string;
    index: number;
    swipeId: number;
    /** The reply's generation has ended (not stopped). */
    ended: boolean;
    /** The reply has been shown (reply:ready). */
    shown: boolean;
}

interface Running {
    chatId: string;
    index: number;
    swipeId: number;
    /** The continue generation has begun (generation:before of type 'continue'). */
    started: boolean;
}

export interface RollContinueOptions {
    startWaitMs?: number;
    planTtlMs?: number;
}

function keyOf(item: Pick<Plan, 'chatId' | 'index' | 'swipeId'>): string {
    return `${item.chatId}|${item.index}|${item.swipeId}`;
}

export class RollContinue {
    private plan: Plan | null = null;
    private running: Running | null = null;
    /** The user stopped the latest generation (a reply arriving from it is not continued). */
    private stopped = false;
    private planTimer: ReturnType<typeof setTimeout> | null = null;
    private startTimer: ReturnType<typeof setTimeout> | null = null;
    private attemptTimer: ReturnType<typeof setTimeout> | null = null;
    /** Reply variants continued once already (`chat|index|swipe`). */
    private readonly done = new Set<string>();
    private readonly offs: Unsubscribe[] = [];
    private readonly actions: StActions;
    private readonly startWaitMs: number;
    private readonly planTtlMs: number;
    private disposed = false;

    constructor(
        private readonly deps: PartDeps,
        options: RollContinueOptions = {},
    ) {
        this.actions = new StActions(deps.app, deps.log, { pollMs: 50, idleMs: 0 });
        this.startWaitMs = options.startWaitMs ?? START_WAIT_MS;
        this.planTtlMs = options.planTtlMs ?? PLAN_TTL_MS;
    }

    install(): void {
        const { bus } = this.deps.app;
        this.offs.push(
            bus.on('generation:before', ({ type, quiet }) => this.onBefore(type, quiet)),
            bus.on('generation:ended', ({ type, stopped }) => this.onEnded(type, stopped)),
            bus.on('reply:ready', ({ messageIndex }) => this.onShown(messageIndex)),
            bus.on('message:invalidated', ({ messageIndex, reason }) => this.onInvalidated(messageIndex, reason)),
            bus.on('chat:changed', () => this.reset()),
        );
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.reset();
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.log.debug('roll continue: release failed', error);
            }
        }
    }

    private skip(index: number, why: string): void {
        this.deps.log.debug(
            `mechanics: reply #${index} is not continued (${why}); the roll results go to the next generation`,
        );
    }

    /** The generation Maestro's turn pipeline sees running (undefined when it cannot tell: counts as running). */
    private generation(): GenerationInfo | null | undefined {
        try {
            return this.deps.app.turn.current();
        } catch {
            return undefined;
        }
    }

    /**
     * The checks part rolled what reply `index` (variant `swipeId`) asked for; `arrival`: the reply is arriving now
     * (its MESSAGE_RECEIVED type). One /continue is planned.
     */
    rolled(index: number, swipeId: number, arrival?: string): void {
        const settings = this.deps.settings();
        if (this.disposed || settings.rollContinue === false || !settings.modelRolls) return;
        const chatId = this.deps.app.host.chatId();
        if (!chatId || !Number.isInteger(index) || index < 0) return;
        const plan: Plan = { chatId, index, swipeId, ended: false, shown: false };
        if (this.done.has(keyOf(plan))) return this.skip(index, 'it was continued once already');
        if (!arrival) return this.skip(index, 'it is not a reply arriving now');
        if (this.stopped) return this.skip(index, 'its generation was stopped');
        // A streamed reply arrives after its generation ended; a non-streamed one before.
        plan.ended = this.generation() === null;
        this.dropPlan();
        this.plan = plan;
        this.planTimer = setTimeout(() => {
            this.planTimer = null;
            if (this.plan !== plan) return;
            this.plan = null;
            this.skip(index, plan.ended ? 'it was never shown' : 'its generation never ended');
        }, this.planTtlMs);
    }

    /** Maestro continues this reply itself: planned, or the continue runs (MechanicsApi.continuing). */
    continuing(index: number): boolean {
        if (this.disposed) return false;
        const chatId = this.deps.app.host.chatId();
        return [this.plan, this.running].some((item) => !!item && item.chatId === chatId && item.index === index);
    }

    private onBefore(type: string, quiet: boolean): void {
        if (quiet) return;
        this.stopped = false;
        if (this.running && !this.running.started && type === 'continue') {
            this.running.started = true;
            this.clearStartTimer();
        }
    }

    private onEnded(type: string, stopped: boolean): void {
        if (this.disposed) return;
        if (this.running?.started && type === 'continue') this.endRunning();
        if (stopped) this.stopped = true;
        const plan = this.plan;
        if (!plan || plan.ended) return;
        if (stopped) {
            this.dropPlan();
            return this.skip(plan.index, 'its generation was stopped');
        }
        plan.ended = true;
        this.ready(plan);
    }

    private onShown(index: number): void {
        const plan = this.plan;
        if (this.disposed || !plan || plan.index !== index || plan.shown) return;
        plan.shown = true;
        this.ready(plan);
    }

    /** Ended and shown: the attempt on the next tick (the other listeners of the moment go first). */
    private ready(plan: Plan): void {
        if (!plan.ended || !plan.shown) return;
        if (this.attemptTimer !== null) clearTimeout(this.attemptTimer);
        this.attemptTimer = setTimeout(() => {
            this.attemptTimer = null;
            if (this.plan !== plan) return;
            this.dropPlan();
            this.attempt(plan);
        }, 0);
    }

    /** Sends `/continue` for the planned reply when everything allows it; else the results wait (debug log says why). */
    private attempt(plan: Plan): void {
        const { app } = this.deps;
        if (this.disposed) return;
        if (app.host.chatId() !== plan.chatId) return this.skip(plan.index, 'the chat changed');
        const message = app.host.ctx().chat?.[plan.index];
        if (!message || message.is_user || !this.actions.isLast(plan.index)) {
            return this.skip(plan.index, 'it is not the last message');
        }
        if (swipeIdOf(message) !== plan.swipeId) return this.skip(plan.index, 'another variant of it is shown');
        if (this.generation() !== null) return this.skip(plan.index, 'a generation runs');
        if (!this.actions.sendBoxEmpty()) return this.skip(plan.index, 'the send box is not empty');
        if (!this.actions.canContinue()) return this.skip(plan.index, 'this SillyTavern cannot /continue');
        const key = keyOf(plan);
        if (this.done.has(key)) return this.skip(plan.index, 'it was continued once already');
        this.done.add(key);
        this.running = { chatId: plan.chatId, index: plan.index, swipeId: plan.swipeId, started: false };
        this.clearStartTimer();
        this.startTimer = setTimeout(() => {
            this.startTimer = null;
            if (this.running && !this.running.started && keyOf(this.running) === key) {
                this.running = null;
                this.deps.log.debug(`mechanics: the /continue of reply #${plan.index} never started`);
            }
        }, this.startWaitMs);
        void this.actions
            .continueLast(plan.index)
            .then((ok) => {
                if (ok) {
                    this.deps.log.debug(`mechanics: reply #${plan.index} continues with its roll results`);
                    return;
                }
                if (this.running && keyOf(this.running) === key) this.endRunning();
                this.done.delete(key);
                this.skip(plan.index, '/continue did not start');
            })
            .catch((error: unknown) => this.deps.log.warn('mechanics: /continue failed', error));
    }

    private dropPlan(): void {
        this.plan = null;
        if (this.planTimer !== null) clearTimeout(this.planTimer);
        this.planTimer = null;
    }

    private endRunning(): void {
        this.running = null;
        this.clearStartTimer();
    }

    private clearStartTimer(): void {
        if (this.startTimer !== null) clearTimeout(this.startTimer);
        this.startTimer = null;
    }

    /** A swipe, an edit or a deletion of the planned reply (or before it) drops the plan; deleted replies forget it. */
    private onInvalidated(index: number, reason: 'swiped' | 'deleted' | 'edited'): void {
        if (!Number.isInteger(index) || index < 0) return;
        if (this.plan && this.plan.index >= index) {
            const dropped = this.plan;
            this.dropPlan();
            this.skip(dropped.index, `it was ${reason}`);
        }
        if (reason !== 'deleted') return;
        // MESSAGE_DELETED gives the new length: a reply generated again at that index is a new one.
        for (const key of [...this.done]) {
            const at = Number(key.split('|').at(-2));
            if (Number.isFinite(at) && at >= index) this.done.delete(key);
        }
    }

    private reset(): void {
        this.dropPlan();
        this.endRunning();
        this.stopped = false;
        if (this.attemptTimer !== null) clearTimeout(this.attemptTimer);
        this.attemptTimer = null;
        this.done.clear();
    }
}
