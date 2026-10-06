// Jobs the user started himself (plan-2 §8): localizing a book, Russian keys of an entry. They are not background
// tasks (src/core/tasks.ts): they run at once in this tab, are never stored (a reload ends them with the page),
// report progress, may be stopped and are keyed so a second click cannot start the same job twice. A finished job
// stays visible for a while (its result, «retry failed»), then disappears. When nobody shows the job at the moment
// it ends (the window where it started is closed), its result goes out once as a notice — urgent only on failure.
import type {
    Logger,
    Ui,
    Unsubscribe,
    UserJobHandle,
    UserJobInfo,
    UserJobPhase,
    UserJobs,
    UserJobSpec,
} from '../shared/contracts';

export interface UserJobsDeps {
    log: Logger;
    /** Where results of jobs nobody watches go (ui.notice); without it they are only kept in the list. */
    notice?: Ui['notice'];
    now?: () => number;
}

export interface UserJobsOptions {
    /** How long a finished job stays in the list. */
    retentionMs?: number;
}

export type UserJobsService = UserJobs & {
    /** Stops every active job and forgets everything (Maestro shutdown). */
    dispose(): void;
};

/** Finished jobs stay ~10 minutes (plan-2 §8: the studio shows the result when reopened). */
export const JOB_RETENTION_MS = 10 * 60_000;

interface JobRecord {
    spec: UserJobSpec;
    info: UserJobInfo;
    controller: AbortController;
    timer: ReturnType<typeof setTimeout> | null;
}

const STATE_ORDER: Record<UserJobInfo['state'], number> = { active: 0, failed: 1, done: 2, cancelled: 3 };

function copy(info: UserJobInfo): UserJobInfo {
    return { ...info, data: info.data ? structuredClone(info.data) : undefined };
}

function count(value: number): number {
    return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

export function createUserJobs(deps: UserJobsDeps, options: UserJobsOptions = {}): UserJobsService {
    const { log } = deps;
    const now = deps.now ?? (() => Date.now());
    const retentionMs = options.retentionMs ?? JOB_RETENTION_MS;
    const records = new Map<string, JobRecord>();
    const listeners = new Set<(job: UserJobInfo | undefined, key: string) => void>();

    const emit = (key: string): void => {
        const info = records.get(key)?.info;
        for (const listener of [...listeners]) {
            try {
                listener(info ? copy(info) : undefined, key);
            } catch (error) {
                log.error('user job listener failed', error);
            }
        }
    };

    const remove = (key: string): void => {
        const record = records.get(key);
        if (!record) return;
        if (record.timer !== null) clearTimeout(record.timer);
        records.delete(key);
        emit(key);
    };

    const isVisible = (spec: UserJobSpec): boolean => {
        try {
            return spec.visible?.() === true;
        } catch (error) {
            log.debug('user job visibility check failed', error);
            return false;
        }
    };

    const report = (record: JobRecord, text: string): void => {
        const { info, spec } = record;
        if (!deps.notice || info.state === 'cancelled' || isVisible(spec)) return;
        try {
            const failed = info.state === 'failed';
            deps.notice(text, {
                urgent: failed,
                level: failed ? 'error' : info.warn ? 'warn' : 'info',
                action: spec.open,
            });
        } catch (error) {
            log.warn('user job notice failed', error);
        }
    };

    const handleOf = (record: JobRecord): UserJobHandle => {
        const { info } = record;
        /** Only the current, still active record may change (a late callback of a replaced job is ignored). */
        const live = () => records.get(info.key) === record && info.state === 'active';
        const touched = () => {
            info.updatedAt = now();
            emit(info.key);
        };
        const complete = (
            state: 'done' | 'failed' | 'cancelled',
            text: string,
            extra: { data?: Record<string, unknown>; warn?: boolean; notice?: string },
        ) => {
            if (!live()) return;
            info.state = state;
            info.finishedAt = now();
            info.updatedAt = info.finishedAt;
            if (state === 'failed') info.error = text;
            else info.summary = text;
            if (extra.warn) info.warn = true;
            if (extra.data) info.data = { ...(info.data ?? {}), ...structuredClone(extra.data) };
            delete info.label;
            record.timer = setTimeout(() => {
                if (records.get(info.key) === record) remove(info.key);
            }, retentionMs);
            emit(info.key);
            report(record, extra.notice ?? `${info.title}: ${text}`);
        };
        return {
            key: info.key,
            signal: record.controller.signal,
            progress(done, total, label) {
                if (!live()) return;
                info.total = count(total);
                info.done = Math.min(count(done), info.total);
                if (label !== undefined) info.label = label;
                touched();
            },
            phase(phase: UserJobPhase, label?: string) {
                if (!live()) return;
                info.phase = phase;
                if (label !== undefined) info.label = label;
                touched();
            },
            data(patch) {
                if (!live()) return;
                info.data = { ...(info.data ?? {}), ...structuredClone(patch) };
                touched();
            },
            finish(summary, extra = {}) {
                complete(extra.cancelled ? 'cancelled' : 'done', summary, extra);
            },
            fail(error, extra = {}) {
                complete('failed', error, extra);
            },
        };
    };

    return {
        start(spec: UserJobSpec): UserJobHandle | null {
            const existing = records.get(spec.key);
            if (existing?.info.state === 'active') return null;
            if (existing?.timer) clearTimeout(existing.timer);
            const at = now();
            const record: JobRecord = {
                spec,
                controller: new AbortController(),
                timer: null,
                info: {
                    key: spec.key,
                    title: spec.title,
                    module: spec.module,
                    state: 'active',
                    phase: 'running',
                    cancellable: spec.cancellable === true,
                    cancelRequested: false,
                    openable: spec.open !== undefined,
                    startedAt: at,
                    updatedAt: at,
                },
            };
            records.set(spec.key, record);
            emit(spec.key);
            return handleOf(record);
        },

        get(key: string): UserJobInfo | undefined {
            const record = records.get(key);
            return record ? copy(record.info) : undefined;
        },

        list(): UserJobInfo[] {
            return [...records.values()]
                .map((record) => copy(record.info))
                .sort(
                    (a, b) =>
                        (a.state === 'active' ? 0 : 1) - (b.state === 'active' ? 0 : 1) ||
                        (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt) ||
                        STATE_ORDER[a.state] - STATE_ORDER[b.state],
                );
        },

        cancel(key: string): boolean {
            const record = records.get(key);
            if (!record || record.info.state !== 'active' || !record.info.cancellable) return false;
            if (record.info.cancelRequested) return true;
            record.info.cancelRequested = true;
            record.info.updatedAt = now();
            record.controller.abort();
            emit(key);
            return true;
        },

        dismiss(key: string): void {
            const record = records.get(key);
            if (!record || record.info.state === 'active') return;
            remove(key);
        },

        open(key: string): boolean {
            const open = records.get(key)?.spec.open;
            if (!open) return false;
            try {
                open.run();
            } catch (error) {
                log.warn('user job open failed', error);
            }
            return true;
        },

        on(listener): Unsubscribe {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        dispose(): void {
            for (const record of records.values()) {
                if (record.timer !== null) clearTimeout(record.timer);
                if (record.info.state === 'active') record.controller.abort();
            }
            records.clear();
            listeners.clear();
        },
    };
}
