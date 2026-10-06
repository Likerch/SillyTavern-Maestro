// Localization through Lorebook Localizer as a user job (plan-2 §8): Russian keys for a whole book (studio header)
// or one entry (the entry form). The job keeps running when the studio closes; its state lives in core/jobs.ts,
// so every view (book header, entry form, Tasks tab, top-bar ring) draws the same thing and a second click cannot
// start the same job again.
//
// Localizer 0.3.0 lists `features`: with 'progress' the job counts entries, with 'cancel' it can be stopped (the
// Localizer interrupts the batch in flight, saves finished batches and resolves with `cancelled`), with 'timeout' a
// batch without an answer in time is a failed attempt, with 'busy' we know it waits for its own dialog. An older
// Localizer gets the plain call and the job shows an indeterminate bar with the elapsed time.
// Its progress `total` is not stable: queued it counts the asked entries, running only those sent to the model
// (entries with nothing to translate drop out), so the strip always shows the latest total and results use the
// result counts.
import { adaptersOf } from '../../adapters';
import { localizerFeatures } from '../../adapters/localizer';
import type {
    LocalizeEntriesOptions,
    LocalizeEntriesResult,
    LocalizeFailure,
    LocalizeProgress,
    LocalizerApi,
    LocalizerFeature,
} from '../../adapters/localizer';
import { pluralForm } from '../../domain/offscreen-plan';
import type { App, UserJobHandle, UserJobs } from '../../shared/contracts';
import { LOCALIZE_STRINGS } from './localize-strings';

/** Batch timeout when the Localizer's own «request timeout» setting is off or unknown: a job must never hang. */
export const LOCALIZE_BATCH_TIMEOUT_MS = 90_000;
const TICK_MS = 1000;
/** Failed entries named in the details of a result. */
export const DETAIL_LIMIT = 8;

export type LocalizeScope = 'book' | 'entry';
export type LocalizeReason =
    | LocalizeFailure['reason']
    | 'allFailed'
    | 'protected'
    | 'notFound'
    | 'language'
    | 'profile'
    | 'connection'
    | 'other';

/** `UserJobInfo.data` of a localization job (JSON). */
export interface LocalizeJobData {
    kind: 'localize';
    scope: LocalizeScope;
    book: string;
    /** Entries asked for (what «Retry» runs again). */
    uids: number[];
    /** The Localizer reports progress and can be stopped (0.3+). */
    live: boolean;
    total: number;
    processed?: number;
    added?: number;
    entries?: number;
    failures?: number;
    /** Entries that failed, with their reason (0.3+); what «Retry the failed ones» runs. */
    failed?: LocalizeFailure[];
    /** Titles of the failed entries (details). */
    titles?: Record<string, string>;
    reason?: LocalizeReason;
    /** The Localizer's own error text (details only). */
    message?: string;
    /** Batch timeout in seconds (the «did not answer within N s» text). */
    timeoutSeconds?: number;
}

export function bookJobKey(book: string): string {
    return `localize:${book}`;
}

export function entryJobKey(book: string, uid: number): string {
    return `localize-entry:${uid}:${book}`;
}

/** The job data when `data` belongs to a localization job. */
export function localizeData(data: Record<string, unknown> | undefined): LocalizeJobData | null {
    if (!data || data.kind !== 'localize' || typeof data.book !== 'string' || !Array.isArray(data.uids)) return null;
    return data as unknown as LocalizeJobData;
}

export interface LocalizeRequest {
    app: App;
    jobs: UserJobs;
    api: LocalizerApi;
    scope: LocalizeScope;
    book: string;
    uids: number[];
    /** Entry titles by uid (job title of an entry, details of failures). */
    titles?: Record<number, string>;
    /** True while a view shows this job (no notice at its end then). */
    visible?: () => boolean;
    /** Opens the studio where the job lives (notice action, Tasks tab). */
    open?: () => void;
    /** After the Localizer is done with the book (written or failed): drop caches and redraw. Runs before the result. */
    afterRun?: (book: string) => Promise<void> | void;
}

type T = (key: string, params?: Record<string, string | number>) => string;

const registered = new WeakSet<object>();

function translator(app: App): T {
    // The entry form can run before the module registered M23's strings (tests, a form opened elsewhere).
    if (!registered.has(app.i18n)) {
        registered.add(app.i18n);
        app.i18n.register(LOCALIZE_STRINGS);
    }
    return (key, params) => app.i18n.t(key, params);
}

function plural(app: App, t: T, key: string, count: number, params: Record<string, string | number> = {}): string {
    return t(`${key}.${pluralForm(count, app.i18n.locale())}`, { count, ...params });
}

function number(value: unknown): number {
    return typeof value === 'number' && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
}

function elapsedText(ms: number): string {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    const minutes = Math.floor(seconds / 60);
    return `${minutes}:${String(seconds % 60).padStart(2, '0')}`;
}

function errorMessage(error: unknown): string {
    if (error instanceof Error) return error.message;
    return typeof error === 'string' ? error : String(error);
}

function isAbort(error: unknown): boolean {
    return error instanceof Error && (error.name === 'AbortError' || /\babort/i.test(error.message));
}

/** A rejection of localizeEntries in words of the story (its English message goes to the details). */
export function classifyError(error: unknown): LocalizeReason {
    const message = errorMessage(error);
    if (/bunny/i.test(message)) return 'protected';
    if (/time(d)?\s*out|timeout/i.test(message)) return 'timeout';
    if (/not found/i.test(message)) return 'notFound';
    if (/language/i.test(message)) return 'language';
    if (/profile/i.test(message)) return 'profile';
    if (/connection|offline|network/i.test(message)) return 'connection';
    return 'other';
}

function validFailures(value: unknown, uids: number[]): LocalizeFailure[] {
    if (!Array.isArray(value)) return [];
    const asked = new Set(uids);
    const seen = new Set<number>();
    const list: LocalizeFailure[] = [];
    for (const item of value) {
        if (!item || typeof item !== 'object') continue;
        const uid = Number((item as { uid?: unknown }).uid);
        const raw = (item as { reason?: unknown }).reason;
        if (!Number.isInteger(uid) || seen.has(uid) || (asked.size && !asked.has(uid))) continue;
        seen.add(uid);
        list.push({ uid, reason: raw === 'timeout' || raw === 'invalid' ? raw : 'error' });
    }
    return list;
}

/** Human text of one reason. */
export function reasonText(app: App, reason: LocalizeReason, timeoutSeconds?: number): string {
    const t = translator(app);
    return t(`m23.job.reason.${reason}`, {
        seconds: timeoutSeconds ?? Math.round(LOCALIZE_BATCH_TIMEOUT_MS / 1000),
    });
}

/**
 * The batch timeout to pass: the user's own Localizer setting (`requestTimeout`, seconds) when it is on, else 90 s
 * — passed explicitly so the «did not answer within N s» text names the real limit.
 */
export function localizerTimeoutMs(app: App): number {
    try {
        const seconds = Number(adaptersOf(app).localizer?.settings?.()?.requestTimeout);
        if (Number.isFinite(seconds) && seconds > 0) return Math.round(seconds * 1000);
    } catch {
        // no adapter or settings: the default below
    }
    return LOCALIZE_BATCH_TIMEOUT_MS;
}

/** The job's title: «Русские ключи для книги «World»» / «… для записи «Anna»». */
export function localizeTitle(app: App, scope: LocalizeScope, book: string, entry?: string): string {
    const t = translator(app);
    return scope === 'book' ? t('m23.job.titleBook', { book }) : t('m23.job.titleEntry', { entry: entry ?? book });
}

/**
 * Starts the job and returns its handle at once (the work goes on in the background); null when the same job is
 * still running — the caller then just shows its state.
 */
export function startLocalizeJob(request: LocalizeRequest): UserJobHandle | null {
    const { app, jobs, api, scope, book, uids } = request;
    const t = translator(app);
    const features = localizerFeatures(api);
    const first = uids[0] ?? 0;
    const key = scope === 'book' ? bookJobKey(book) : entryJobKey(book, first);
    const handle = jobs.start({
        key,
        title: localizeTitle(app, scope, book, request.titles?.[first]),
        module: 'loreStudio',
        cancellable: features.has('cancel'),
        visible: request.visible,
        open: request.open ? { label: t('m23.job.open'), run: request.open } : undefined,
    });
    if (!handle) return null;
    void runLocalize(request, handle, features).catch((error: unknown) => {
        app.log.error('localization job failed unexpectedly', error);
        handle.fail(t('m23.job.error', { reason: reasonText(app, 'other') }));
    });
    return handle;
}

async function runLocalize(
    request: LocalizeRequest,
    handle: UserJobHandle,
    features: Set<LocalizerFeature>,
): Promise<void> {
    const { app, api, scope, book, uids } = request;
    const t = translator(app);
    const live = features.has('progress');
    const startedAt = Date.now();
    let total = uids.length;
    let processed = 0;
    let phase: LocalizeProgress['phase'] = 'running';

    const timeoutMs = features.has('timeout') ? localizerTimeoutMs(app) : LOCALIZE_BATCH_TIMEOUT_MS;
    const timeoutSeconds = Math.round(timeoutMs / 1000);
    const data: LocalizeJobData = { kind: 'localize', scope, book, uids: [...uids], live, total, timeoutSeconds };
    handle.data({ ...data });

    const progressText = () =>
        t('m23.job.progress', { progress: plural(app, t, 'm23.job.ofEntries', total, { done: processed, total }) });
    /** Counted progress for a book with Localizer 0.3; otherwise the time it has been running. */
    const counted = live && scope === 'book';
    const showRunning = () => {
        if (counted) {
            handle.phase('running', progressText());
            handle.progress(processed, total);
            return;
        }
        const elapsed = elapsedText(Date.now() - startedAt);
        handle.phase('running', t(scope === 'book' ? 'm23.job.working' : 'm23.job.workingEntry', { elapsed }));
    };

    let queuedNow = false;
    if (features.has('busy')) {
        try {
            queuedNow = api.busy?.().running === true;
        } catch (error) {
            app.log.debug('localizer busy() failed', error);
        }
    }
    if (queuedNow) {
        phase = 'queued';
        handle.phase('queued', t('m23.job.queued'));
    } else showRunning();

    const ticker = counted
        ? null
        : setInterval(() => {
              if (phase === 'running') showRunning();
          }, TICK_MS);

    const onProgress = (progress: LocalizeProgress) => {
        if (!progress || typeof progress !== 'object') return;
        if (number(progress.total) > 0) total = number(progress.total);
        processed = Math.min(number(progress.done), total);
        phase = progress.phase === 'queued' || progress.phase === 'saving' ? progress.phase : 'running';
        if (phase === 'queued') handle.phase('queued', t('m23.job.queued'));
        else if (phase === 'saving') {
            handle.phase('saving', t('m23.job.saving'));
            if (counted) handle.progress(processed, total);
        } else showRunning();
    };

    const options: LocalizeEntriesOptions = {};
    if (live) options.onProgress = onProgress;
    if (features.has('cancel')) options.signal = handle.signal;
    if (features.has('timeout')) options.batchTimeoutMs = timeoutMs;

    let result: LocalizeEntriesResult | undefined;
    let failure: unknown = null;
    try {
        // An older Localizer gets exactly the call it knows.
        result = Object.keys(options).length
            ? await api.localizeEntries(book, uids, options)
            : await api.localizeEntries(book, uids);
    } catch (error) {
        failure = error;
    } finally {
        if (ticker !== null) clearInterval(ticker);
    }

    try {
        await request.afterRun?.(book);
    } catch (error) {
        app.log.warn('reload after localization failed', error);
    }

    const notice = (text: string) =>
        t('m23.job.notice', { title: localizeTitle(app, scope, book, request.titles?.[uids[0] ?? 0]), result: text });
    const titlesOf = (failed: LocalizeFailure[]) => {
        const titles: Record<string, string> = {};
        for (const item of failed.slice(0, DETAIL_LIMIT)) {
            const title = request.titles?.[item.uid];
            if (title) titles[String(item.uid)] = title;
        }
        return titles;
    };

    if (failure !== null) {
        if (handle.signal.aborted && isAbort(failure)) {
            const summary = cancelledText(app, t, scope, processed, total, 0);
            handle.finish(summary, { cancelled: true, data: { processed }, notice: notice(summary) });
            return;
        }
        app.log.warn('Lorebook Localizer failed', failure);
        const reason = classifyError(failure);
        const text = t('m23.job.error', { reason: reasonText(app, reason, timeoutSeconds) });
        handle.fail(text, { data: { reason, message: errorMessage(failure), processed }, notice: notice(text) });
        return;
    }

    const added = number(result?.added);
    const entries = number(result?.entries);
    const failures = number(result?.failures);
    const failed = validFailures(result?.failed, uids);
    processed = Math.min(total, Math.max(processed, entries + failures));
    const outcome = { processed, added, entries, failures, failed, titles: titlesOf(failed) };

    if (result?.cancelled === true || handle.signal.aborted) {
        const summary = cancelledText(app, t, scope, processed, total, added);
        handle.finish(summary, { cancelled: true, data: outcome, notice: notice(summary) });
        return;
    }
    // Nothing came out and something failed: an error, not a «done» with zero keys.
    if (added === 0 && entries === 0 && failures > 0) {
        const reasons = new Set(failed.map((item) => item.reason));
        const only = reasons.size === 1 && failed.length >= failures ? [...reasons][0] : undefined;
        const reason: LocalizeReason = only ?? 'allFailed';
        const text = t('m23.job.error', { reason: reasonText(app, reason, timeoutSeconds) });
        handle.fail(text, { data: { ...outcome, reason }, notice: notice(text) });
        return;
    }
    const summary = doneText(app, t, scope, added, entries, failures);
    handle.finish(summary, { warn: failures > 0, data: outcome, notice: notice(summary) });
}

function cancelledText(app: App, t: T, scope: LocalizeScope, processed: number, total: number, added: number): string {
    if (scope === 'entry') return t('m23.job.cancelledEntry');
    const progress = plural(app, t, 'm23.job.ofEntries', total, { done: processed, total });
    const text = plural(app, t, 'm23.job.cancelled', processed, { progress });
    return added > 0 ? `${text}; ${plural(app, t, 'm23.job.keys', added)}` : text;
}

function doneText(app: App, t: T, scope: LocalizeScope, added: number, entries: number, failures: number): string {
    if (added === 0 && failures === 0) return t('m23.job.doneNothing');
    const keys = plural(app, t, 'm23.job.keys', added);
    const text =
        scope === 'entry'
            ? t('m23.job.doneEntry', { keys })
            : t('m23.job.done', { keys, entries: plural(app, t, 'm23.job.entries', entries) });
    return failures > 0 ? `${text}; ${plural(app, t, 'm23.job.failures', failures)}` : text;
}
