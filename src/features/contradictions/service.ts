// M26c «Проверка противоречий»: the shared service behind ContradictionsApi (M26 п.5, plan §4.13, §9, P4, P15).
// quick() runs the rules only (src/domain/contradictions-rules.ts) and is safe after every reply. check() runs the
// rules and, when they are not sure and a background profile exists, asks the cheap model through the background
// queue (task 'contradictions.check': leader tab only, never during a generation, deduplicated by the input hash; the
// core caps the daily background spend and records the cost). The caller awaits the task's answer; without a
// profile, in another tab or on failure the rule result comes back with askedAi false. A caller that itself runs
// inside a background task (the revision, the living canon) gets the inline path: one direct, time-bounded request
// (waiting for a queued task from inside a task would never end: the queue runs one task at a time).
import {
    buildCheckMessages,
    buildCheckPayload,
    CHECK_SCHEMA,
    mergeFindings,
    parseCheckAnswer,
} from '../../domain/contradictions-ai';
import type { AiFinding, CheckPayload, ContradictionItem } from '../../domain/contradictions-ai';
import { analyseContradictions } from '../../domain/contradictions-rules';
import type { RuleInput } from '../../domain/contradictions-rules';
import type { App, LlmRequest, Logger, Unsubscribe } from '../../shared/contracts';
import type { CheckOptions, Contradiction, ContradictionInput, ContradictionResult, ContradictionsApi } from './api';

export const CONTRADICTIONS_KEY = 'contradictions';
export const CONTRADICTIONS_ID = 'M26c';
export const CHECK_TASK = 'contradictions.check';
/** The caller stops waiting after this long (the task may still run; its answer is then dropped). */
const WAIT_MS = 4 * 60_000;
const TASK_TTL_MS = 10 * 60_000;
const MAX_TOKENS = 900;
/** Default bound of an inline check: under the 30 s the revision gives check() as a whole. */
const INLINE_TIMEOUT_MS = 25_000;

// The domain's item is exactly the API's Contradiction (src/domain cannot import feature types).
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const sameShape: Exact<Contradiction, ContradictionItem> = true;
void sameShape;

interface AiOutcome {
    ok: boolean;
    findings: AiFinding[];
    labels: string[];
    costUsd: number;
    error?: string;
}

interface Waiter {
    resolve(outcome: AiOutcome): void;
    timer: ReturnType<typeof setTimeout>;
}

function failed(error: string, costUsd = 0): AiOutcome {
    return { ok: false, findings: [], labels: [], costUsd, error };
}

/** The input with junk removed (non-strings, empty texts). */
export function sanitizeInput(input: ContradictionInput): RuleInput {
    const statement = typeof input?.statement === 'string' ? input.statement : '';
    const entities = Array.isArray(input?.entities)
        ? input.entities.filter((name): name is string => typeof name === 'string' && !!name.trim())
        : [];
    const against = Array.isArray(input?.against)
        ? input.against
              .filter((item) => item && typeof item.text === 'string' && item.text.trim())
              .map((item) => ({ label: typeof item.label === 'string' ? item.label : '', text: item.text }))
        : [];
    return { statement, entities, against };
}

function readPayload(value: Record<string, unknown>): CheckPayload | null {
    if (typeof value.key !== 'string' || typeof value.statement !== 'string' || !Array.isArray(value.against)) {
        return null;
    }
    const against = value.against.filter(
        (item): item is { label: string; text: string } =>
            typeof item === 'object' &&
            item !== null &&
            typeof (item as { label?: unknown }).label === 'string' &&
            typeof (item as { text?: unknown }).text === 'string',
    );
    if (!against.length) return null;
    const strings = (list: unknown) =>
        Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
    return {
        key: value.key,
        statement: value.statement,
        entities: strings(value.entities),
        against,
        hints: strings(value.hints),
    };
}

export class ContradictionsService implements ContradictionsApi {
    private readonly waiters = new Map<string, Waiter[]>();
    private readonly inflight = new Map<string, Promise<AiOutcome>>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    install(): Unsubscribe[] {
        return [this.app.tasks.register(CHECK_TASK, (payload) => this.run(payload)), () => this.dispose()];
    }

    private dispose(): void {
        this.disposed = true;
        for (const key of [...this.waiters.keys()]) this.settle(key, failed('disabled'));
    }

    quick(input: ContradictionInput): Contradiction[] {
        return analyseContradictions(sanitizeInput(input)).hits;
    }

    async check(input: ContradictionInput, options: CheckOptions = {}): Promise<ContradictionResult> {
        const clean = sanitizeInput(input);
        const { hits, suspicious } = analyseContradictions(clean);
        const rules = (extra: Partial<ContradictionResult> = {}): ContradictionResult => ({
            clean: hits.length === 0,
            askedAi: false,
            contradictions: hits,
            costUsd: 0,
            ...extra,
        });
        if (!suspicious) return rules();
        const skipped = this.blocker();
        if (skipped) return rules({ skipped });
        const payload = buildCheckPayload(clean, hits);
        if (!payload.against.length) return rules();
        const inline = options?.inline === true || this.insideTask();
        const outcome = inline ? await this.askInline(payload, options ?? {}) : await this.ask(payload);
        if (!outcome.ok) return rules({ costUsd: outcome.costUsd, error: outcome.error ?? 'failed' });
        const merged = mergeFindings(hits, outcome.findings, outcome.labels);
        return { clean: merged.length === 0, askedAi: true, contradictions: merged, costUsd: outcome.costUsd };
    }

    /** Why the model cannot be asked from this tab now (undefined when it can). */
    private blocker(): ContradictionResult['skipped'] {
        const { app } = this;
        if (this.disposed || !app.host.chatId()) return 'noChat';
        if (app.host.isGroupChat()) return 'group';
        if (!app.leader.isLeader()) return 'notLeader';
        try {
            if (!app.llm.available(CHECK_TASK)) return 'noProfile';
            if (app.cost.backgroundCapReached()) return 'cap';
        } catch (error) {
            this.log.debug('background model state is not readable', error);
            return 'noProfile';
        }
        return undefined;
    }

    /**
     * A background task of this chat is running (the queue runs one at a time): the caller is most likely that task
     * (M8 'revision.run', M26 'living.extract'), and a queued check would wait for it forever.
     */
    private insideTask(): boolean {
        try {
            const chatId = this.app.host.chatId();
            return this.app.tasks
                .list()
                .some(
                    (task) =>
                        task.state === 'running' && task.kind !== CHECK_TASK && (task.chatId ?? chatId) === chatId,
                );
        } catch {
            return false;
        }
    }

    /** Queued path. One request per input hash: a second check of the same input shares the answer. */
    private ask(payload: CheckPayload): Promise<AiOutcome> {
        const running = this.inflight.get(payload.key);
        if (running) return running;
        const request = this.enqueueAndWait(payload).finally(() => this.inflight.delete(payload.key));
        this.inflight.set(payload.key, request);
        return request;
    }

    /** Inline path: one direct request bounded by `timeoutMs`; the same input in flight shares the answer. */
    private askInline(payload: CheckPayload, options: CheckOptions): Promise<AiOutcome> {
        const key = `inline:${payload.key}`;
        const running = this.inflight.get(key);
        if (running) return running;
        const controller = new AbortController();
        const outer = options.signal;
        const abort = () => controller.abort();
        if (outer?.aborted) controller.abort();
        outer?.addEventListener('abort', abort, { once: true });
        const limit =
            typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : INLINE_TIMEOUT_MS;
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
        }, limit);
        const request = this.request(payload, controller.signal)
            .then((outcome) => (timedOut && !outcome.ok ? failed('timeout', outcome.costUsd) : outcome))
            .finally(() => {
                clearTimeout(timer);
                outer?.removeEventListener('abort', abort);
                this.inflight.delete(key);
            });
        this.inflight.set(key, request);
        return request;
    }

    private async enqueueAndWait(payload: CheckPayload): Promise<AiOutcome> {
        const done = new Promise<AiOutcome>((resolve) => {
            const timer = setTimeout(() => this.settle(payload.key, failed('timeout')), WAIT_MS);
            const list = this.waiters.get(payload.key) ?? [];
            list.push({ resolve, timer });
            this.waiters.set(payload.key, list);
        });
        try {
            await this.app.tasks.enqueue({
                kind: CHECK_TASK,
                dedupeKey: payload.key,
                payload: payload as unknown as Record<string, unknown>,
                ttlMs: TASK_TTL_MS,
                priority: 1,
            });
            this.app.tasks.kick();
        } catch (error) {
            this.log.warn('contradiction check could not be queued', error);
            this.settle(payload.key, failed('enqueue'));
        }
        return done;
    }

    private settle(key: string, outcome: AiOutcome): void {
        const list = this.waiters.get(key);
        if (!list) return;
        this.waiters.delete(key);
        for (const waiter of list) {
            clearTimeout(waiter.timer);
            waiter.resolve(outcome);
        }
    }

    /**
     * One model request (the client adds a single retry without json_schema when the answer is not valid JSON).
     * Never throws.
     */
    private async request(payload: CheckPayload, signal?: AbortSignal): Promise<AiOutcome> {
        const labels = payload.against.map((item) => item.label);
        const request: LlmRequest = {
            task: CHECK_TASK,
            messages: buildCheckMessages(payload),
            maxTokens: MAX_TOKENS,
            temperature: 0,
            schema: { name: 'contradictions_check', schema: CHECK_SCHEMA },
        };
        if (signal) request.signal = signal;
        if (signal?.aborted) return failed('aborted');
        let response;
        try {
            response = await this.app.llm.request<unknown>(request);
        } catch (error) {
            this.log.warn('contradiction check request failed', error);
            if (signal?.aborted) return failed('aborted');
            return failed(error instanceof Error ? error.message : String(error));
        }
        const costUsd = response.costUsd ?? 0;
        if (!response.ok) {
            if (signal?.aborted) return failed('aborted', costUsd);
            return failed(response.refusal ? 'refusal' : (response.error ?? 'failed'), costUsd);
        }
        const findings = parseCheckAnswer(response.data ?? response.text, payload.against.length);
        if (!findings) {
            this.log.debug('contradiction check: the answer is not the expected JSON');
            return failed('parse', costUsd);
        }
        return { ok: true, findings, labels, costUsd };
    }

    /** Task runner: never throws (a bad answer is not worth the queue's retries; transport retries are the client's). */
    private async run(raw: Record<string, unknown>): Promise<void> {
        const payload = readPayload(raw);
        if (!payload) {
            if (typeof raw.key === 'string') this.settle(raw.key, failed('payload'));
            return;
        }
        this.settle(payload.key, await this.request(payload));
    }
}
