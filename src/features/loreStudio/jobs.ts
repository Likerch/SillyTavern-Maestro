// Access to the user jobs service (core/jobs.ts) for the Lore Studio. The App carries it (`app.jobs`); a bare App
// (older test stands, a host that built no service) gets one private service per App so the studio still works.
import { createUserJobs } from '../../core/jobs';
import type { App, Unsubscribe, UserJobs } from '../../shared/contracts';

const fallbacks = new WeakMap<object, UserJobs>();

export function userJobs(app: App): UserJobs {
    if (app.jobs) return app.jobs;
    let jobs = fallbacks.get(app);
    if (!jobs) {
        jobs = createUserJobs({
            log: app.log,
            notice: (text, options) => app.ui?.notice?.(text, options),
        });
        fallbacks.set(app, jobs);
    }
    return jobs;
}

/** Views showing a job right now (the entry form's inline status): a job nobody watches reports its end. */
const watchers = new Map<string, number>();

export function watchJob(key: string): Unsubscribe {
    watchers.set(key, (watchers.get(key) ?? 0) + 1);
    let done = false;
    return () => {
        if (done) return;
        done = true;
        const left = (watchers.get(key) ?? 1) - 1;
        if (left > 0) watchers.set(key, left);
        else watchers.delete(key);
    };
}

export function isJobWatched(key: string): boolean {
    return (watchers.get(key) ?? 0) > 0;
}
