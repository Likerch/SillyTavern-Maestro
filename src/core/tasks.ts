// Background task queue (plan §4.5). Stored in one global file so it survives reloads and phone sleep; every
// task carries its chat id and runs only in the leader tab of that chat, while that chat is open, when no
// generation is running and the module allows it (canRun: Qvink queue, cost cap). One task at a time.
// Every change is read-modify-write on the file, so tabs that enqueue at the same time rarely lose a task.
import type {
    Bus,
    ChatStore,
    FileStore,
    Host,
    Leader,
    Logger,
    TaskInfo,
    TaskQueue,
    TaskRunner,
    TaskSpec,
    Unsubscribe,
} from '../shared/contracts';
import { currentTabId, readFresh } from './files';

export interface TaskQueueDeps {
    host: Host;
    chat: ChatStore;
    files: FileStore;
    leader: Leader;
    bus: Bus;
    log: Logger;
    isIdle: () => boolean;
    canRun?: (kind: string) => boolean;
}

export interface TaskQueueOptions {
    pollMs?: number;
    /** Pause before each retry; a task runs at most `retryDelaysMs.length + 1` times. */
    retryDelaysMs?: number[];
    /** A runner that does not settle within this time counts as failed. */
    runTimeoutMs?: number;
    historyLimit?: number;
}

export type TaskQueueService = TaskQueue & {
    start(): void;
    stop(): void;
    /** Resolves when no pump or runner is active (tests, shutdown). */
    idle(): Promise<void>;
};

interface StoredTask extends TaskInfo {
    updatedAt: number;
    /** Earliest time of the next attempt (retry backoff). */
    notBefore?: number;
    startedAt?: number;
    finishedAt?: number;
    /** Tab that claimed the running task. */
    runningBy?: string;
}

interface TaskFile {
    schema: 1;
    version: number;
    tasks: StoredTask[];
    history: StoredTask[];
}

const FILE_KIND = 'tasks';
const POLL_MS = 5_000;
const RETRY_DELAYS_MS = [2_000, 10_000, 30_000];
const RUN_TIMEOUT_MS = 5 * 60_000;
const HISTORY_LIMIT = 50;
/** A task left 'running' longer than this (tab closed mid-run) goes back to the queue. */
const RUNNING_STALE_MS = 10 * 60_000;
/** Pending tasks older than this expire even without a ttl (their chat may never be opened again). */
const MAX_PENDING_AGE_MS = 14 * 24 * 60 * 60_000;
const MAX_TASKS = 500;
/** With an empty queue the leader re-reads the file this often (tasks enqueued by other tabs). */
const IDLE_REFRESH_MS = 30_000;

function emptyFile(): TaskFile {
    return { schema: 1, version: 0, tasks: [], history: [] };
}

function normalise(raw: unknown): TaskFile {
    if (!raw || typeof raw !== 'object') return emptyFile();
    const file = raw as Partial<TaskFile>;
    return {
        schema: 1,
        version: typeof file.version === 'number' ? file.version : 0,
        tasks: Array.isArray(file.tasks) ? file.tasks.filter(isTask) : [],
        history: Array.isArray(file.history) ? file.history.filter(isTask) : [],
    };
}

function isTask(value: unknown): value is StoredTask {
    if (!value || typeof value !== 'object') return false;
    const task = value as Partial<StoredTask>;
    return typeof task.id === 'string' && typeof task.kind === 'string' && typeof task.state === 'string';
}

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : JSON.stringify(error);
}

function newId(): string {
    return `task-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function createTaskQueue(deps: TaskQueueDeps, options: TaskQueueOptions = {}): TaskQueueService {
    const { host, files, leader, bus, log } = deps;
    const pollMs = options.pollMs ?? POLL_MS;
    const retryDelays = options.retryDelaysMs ?? RETRY_DELAYS_MS;
    const runTimeoutMs = options.runTimeoutMs ?? RUN_TIMEOUT_MS;
    const historyLimit = options.historyLimit ?? HISTORY_LIMIT;
    const fileName = files.fileName(FILE_KIND);
    const tabId = currentTabId();
    const runners = new Map<string, TaskRunner>();
    const unsubscribers: Unsubscribe[] = [];

    let state: TaskFile = emptyFile();
    let lastRead = 0;
    let loaded: Promise<void> | null = null;
    let chain: Promise<unknown> = Promise.resolve();
    let started = false;
    let pumping: Promise<void> | null = null;
    let running: Promise<void> | null = null;
    let pollTimer: ReturnType<typeof setInterval> | null = null;
    let kickTimer: ReturnType<typeof setTimeout> | null = null;
    const retryTimers = new Set<ReturnType<typeof setTimeout>>();

    /** Serialised read-modify-write of the queue file; writes only when `changed`. */
    const mutate = <R>(change: (file: TaskFile, now: number) => { changed: boolean; result: R }): Promise<R> => {
        const job = async () => {
            const file = normalise(await readFresh<unknown>(files, fileName));
            lastRead = Date.now();
            const { changed, result } = change(file, Date.now());
            if (changed) {
                file.version++;
                await files.write(fileName, file);
            }
            state = file;
            return result;
        };
        const next = chain.then(job, job);
        chain = next.catch(() => undefined);
        return next;
    };

    const ensureLoaded = (): Promise<void> => {
        loaded ??= mutate(() => ({ changed: false, result: undefined })).catch((error: unknown) => {
            loaded = null;
            log.warn('could not load the task queue', error);
        });
        return loaded;
    };

    const toHistory = (file: TaskFile, task: StoredTask, stateName: 'done' | 'failed' | 'expired', now: number) => {
        const index = file.tasks.indexOf(task);
        if (index >= 0) file.tasks.splice(index, 1);
        task.state = stateName;
        task.finishedAt = now;
        task.updatedAt = now;
        delete task.runningBy;
        delete task.notBefore;
        file.history.push(task);
        if (file.history.length > historyLimit) file.history.splice(0, file.history.length - historyLimit);
    };

    /** Expires stale pending tasks and requeues tasks orphaned while running. */
    const housekeeping = (file: TaskFile, now: number): boolean => {
        let changed = false;
        for (const task of [...file.tasks]) {
            if (task.state === 'pending') {
                const ttlGone = task.ttlMs !== undefined && task.attempts === 0 && now - task.createdAt > task.ttlMs;
                if (ttlGone || now - task.createdAt > MAX_PENDING_AGE_MS) {
                    toHistory(file, task, 'expired', now);
                    changed = true;
                }
            } else if (task.state === 'running' && now - (task.startedAt ?? task.updatedAt) > RUNNING_STALE_MS) {
                log.warn(`task ${task.kind} was left running; requeued`);
                if (task.attempts > retryDelays.length) {
                    task.error = 'interrupted';
                    toHistory(file, task, 'failed', now);
                } else {
                    task.state = 'pending';
                    task.updatedAt = now;
                    delete task.runningBy;
                }
                changed = true;
            }
        }
        if (file.tasks.length > MAX_TASKS) {
            const overflow = file.tasks
                .filter((task) => task.state === 'pending')
                .sort((a, b) => (a.priority ?? 0) - (b.priority ?? 0) || a.createdAt - b.createdAt)
                .slice(0, file.tasks.length - MAX_TASKS);
            for (const task of overflow) {
                task.error = 'queue overflow';
                toHistory(file, task, 'expired', now);
            }
            changed ||= overflow.length > 0;
        }
        return changed;
    };

    const pick = (file: TaskFile, chatId: string, now: number): StoredTask | undefined => {
        return file.tasks
            .filter(
                (task) =>
                    task.state === 'pending' &&
                    task.chatId === chatId &&
                    runners.has(task.kind) &&
                    (task.notBefore ?? 0) <= now &&
                    (deps.canRun?.(task.kind) ?? true),
            )
            .sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.createdAt - b.createdAt)[0];
    };

    const withTimeout = <T>(promise: Promise<T>, ms: number): Promise<T> =>
        new Promise<T>((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
            promise.then(
                (value) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                (error: unknown) => {
                    clearTimeout(timer);
                    reject(error instanceof Error ? error : new Error(errorText(error)));
                },
            );
        });

    const scheduleRetry = (ms: number) => {
        const timer = setTimeout(() => {
            retryTimers.delete(timer);
            kick();
        }, ms);
        retryTimers.add(timer);
    };

    const execute = async (task: StoredTask): Promise<void> => {
        const runner = runners.get(task.kind);
        if (!runner) {
            // Unregistered between claim and start (module disabled): back to the queue, attempt not counted.
            await mutate((file, now) => {
                const live = file.tasks.find((item) => item.id === task.id);
                if (!live) return { changed: false, result: undefined };
                live.state = 'pending';
                live.attempts = Math.max(0, live.attempts - 1);
                live.updatedAt = now;
                delete live.runningBy;
                return { changed: true, result: undefined };
            });
            return;
        }
        const info: TaskInfo = structuredClone({
            id: task.id,
            kind: task.kind,
            dedupeKey: task.dedupeKey,
            payload: task.payload,
            chatId: task.chatId,
            priority: task.priority,
            ttlMs: task.ttlMs,
            state: 'running',
            attempts: task.attempts,
            createdAt: task.createdAt,
        });
        try {
            await withTimeout(
                Promise.resolve().then(() => runner(structuredClone(task.payload), info)),
                runTimeoutMs,
            );
            await mutate((file, now) => {
                const live = file.tasks.find((item) => item.id === task.id);
                if (!live) return { changed: false, result: undefined };
                delete live.error;
                toHistory(file, live, 'done', now);
                return { changed: true, result: undefined };
            });
            log.debug(`task ${task.kind} done`);
        } catch (error) {
            const message = errorText(error);
            log.warn(`task ${task.kind} failed (attempt ${task.attempts})`, error);
            const retryIn = await mutate<number | null>((file, now) => {
                const live = file.tasks.find((item) => item.id === task.id);
                if (!live) return { changed: false, result: null };
                live.error = message;
                if (live.attempts > retryDelays.length) {
                    toHistory(file, live, 'failed', now);
                    return { changed: true, result: null };
                }
                const wait = retryDelays[live.attempts - 1] ?? retryDelays[retryDelays.length - 1] ?? 0;
                live.state = 'pending';
                live.notBefore = now + wait;
                live.updatedAt = now;
                delete live.runningBy;
                return { changed: true, result: wait };
            });
            if (retryIn !== null) scheduleRetry(retryIn);
        }
    };

    const pumpOnce = async (): Promise<void> => {
        if (!started || running) return;
        await ensureLoaded();
        if (!leader.isLeader() || !deps.isIdle()) return;
        const chatId = host.isGroupChat() ? null : host.chatId();
        if (!chatId) return;
        // Nothing known to do for this chat: avoid a request on every poll, but still look for tasks other tabs
        // enqueued (and expire other chats' tasks) now and then.
        const relevant = state.tasks.some((task) => task.chatId === chatId || task.state === 'running');
        if (!relevant && Date.now() - lastRead < IDLE_REFRESH_MS) return;
        const claimed = await mutate<StoredTask | null>((file, now) => {
            const changed = housekeeping(file, now);
            const task = pick(file, chatId, now);
            if (!task) return { changed, result: null };
            task.state = 'running';
            task.attempts++;
            task.startedAt = now;
            task.updatedAt = now;
            task.runningBy = tabId;
            return { changed: true, result: structuredClone(task) };
        });
        if (!claimed) return;
        running = execute(claimed)
            .catch((error: unknown) => log.error(`task ${claimed.kind} bookkeeping failed`, error))
            .finally(() => {
                running = null;
                kick();
            });
    };

    const pump = (): Promise<void> => {
        pumping ??= pumpOnce()
            .catch((error: unknown) => log.warn('task queue pump failed', error))
            .finally(() => {
                pumping = null;
            });
        return pumping;
    };

    function kick(): void {
        if (!started || kickTimer !== null) return;
        kickTimer = setTimeout(() => {
            kickTimer = null;
            void pump();
        }, 0);
    }

    return {
        register(kind: string, runner: TaskRunner): Unsubscribe {
            if (runners.has(kind)) log.warn(`task runner ${kind} replaced`);
            runners.set(kind, runner);
            kick();
            return () => {
                if (runners.get(kind) === runner) runners.delete(kind);
            };
        },

        async enqueue(spec: TaskSpec): Promise<string> {
            const chatId = spec.chatId ?? host.chatId();
            if (!chatId) throw new Error(`cannot enqueue ${spec.kind}: no chat`);
            // Stored as JSON: functions and undefined values disappear exactly as they would after a reload.
            const payload = JSON.parse(JSON.stringify(spec.payload ?? {})) as Record<string, unknown>;
            const id = await mutate((file, now) => {
                if (spec.dedupeKey !== undefined) {
                    const existing = file.tasks.find(
                        (task) =>
                            task.state === 'pending' &&
                            task.kind === spec.kind &&
                            task.chatId === chatId &&
                            task.dedupeKey === spec.dedupeKey,
                    );
                    if (existing) {
                        existing.payload = payload;
                        existing.priority = spec.priority ?? 0;
                        existing.ttlMs = spec.ttlMs;
                        existing.createdAt = now;
                        existing.updatedAt = now;
                        existing.attempts = 0;
                        delete existing.error;
                        delete existing.notBefore;
                        return { changed: true, result: existing.id };
                    }
                }
                const task: StoredTask = {
                    id: newId(),
                    kind: spec.kind,
                    dedupeKey: spec.dedupeKey,
                    payload,
                    chatId,
                    priority: spec.priority ?? 0,
                    ttlMs: spec.ttlMs,
                    state: 'pending',
                    attempts: 0,
                    createdAt: now,
                    updatedAt: now,
                };
                file.tasks.push(task);
                housekeeping(file, now);
                return { changed: true, result: task.id };
            });
            kick();
            return id;
        },

        list(): TaskInfo[] {
            return structuredClone([...state.tasks, ...state.history]);
        },

        kick,

        start(): void {
            if (started) return;
            started = true;
            unsubscribers.push(
                bus.on('generation:ended', () => kick()),
                bus.on('leader:changed', () => kick()),
                bus.on('chat:changed', () => kick()),
            );
            pollTimer = setInterval(() => kick(), pollMs);
            void ensureLoaded().then(() => kick());
        },

        stop(): void {
            started = false;
            if (pollTimer !== null) clearInterval(pollTimer);
            pollTimer = null;
            if (kickTimer !== null) clearTimeout(kickTimer);
            kickTimer = null;
            for (const timer of retryTimers) clearTimeout(timer);
            retryTimers.clear();
            for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
        },

        async idle(): Promise<void> {
            while (pumping || running) {
                await pumping;
                await running;
            }
        },
    };
}
