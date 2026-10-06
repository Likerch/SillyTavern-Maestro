// How a localization job looks in the Lore Studio (plan-2 §8): a status strip under the book header (text,
// progress bar, «Stop», results with «Retry the failed ones» / «Retry» / «Hide» and details), and a compact
// inline status next to the entry form's «Russian keys» button. Both are drawn from the job state only.
import { button, el, icon } from '../../ui/components/dom';
import { progressBar } from '../../ui/components/progress';
import type { App, UserJobInfo } from '../../shared/contracts';
import { DETAIL_LIMIT, localizeData, reasonText } from './localize-job';

export interface JobViewActions {
    stop(): void;
    /** Runs the job again for these entries. */
    retry(uids: number[]): void;
    dismiss(): void;
}

function statusIcon(job: UserJobInfo): HTMLElement {
    if (job.state === 'active') return icon('fa-spinner', 'fa-spin maestro-m23-job-icon');
    if (job.state === 'failed') return icon('fa-triangle-exclamation', 'maestro-m23-job-icon');
    if (job.state === 'cancelled') return icon('fa-circle-stop', 'maestro-m23-job-icon');
    return icon(job.warn ? 'fa-circle-exclamation' : 'fa-circle-check', 'maestro-m23-job-icon');
}

/** The one line of text: the running label, «stopping…», the result or the error. */
export function jobText(app: App, job: UserJobInfo): string {
    if (job.state === 'failed') return job.error ?? '';
    if (job.state !== 'active') return job.summary ?? '';
    if (job.cancelRequested) return app.i18n.t('m23.job.stopping');
    return job.label ?? '';
}

function stateClass(job: UserJobInfo): string {
    if (job.state === 'active') return 'maestro-m23-job-active';
    if (job.state === 'failed') return 'maestro-m23-job-failed';
    if (job.state === 'cancelled') return 'maestro-m23-job-cancelled';
    return job.warn ? 'maestro-m23-job-warn' : 'maestro-m23-job-done';
}

function details(app: App, job: UserJobInfo): HTMLElement | null {
    const t = app.i18n.t.bind(app.i18n);
    const data = localizeData(job.data);
    if (!data || job.state === 'active') return null;
    const lines: string[] = [];
    const failed = data.failed ?? [];
    for (const item of failed.slice(0, DETAIL_LIMIT)) {
        const entry = data.titles?.[String(item.uid)] ?? `#${item.uid}`;
        lines.push(t('m23.job.detail.entry', { entry, reason: reasonText(app, item.reason, data.timeoutSeconds) }));
    }
    if (failed.length > DETAIL_LIMIT) lines.push(t('m23.job.detail.more', { count: failed.length - DETAIL_LIMIT }));
    if (data.message) lines.push(t('m23.job.detail.message', { message: data.message }));
    if (!lines.length) return null;
    lines.push(t('m23.job.detail.book', { book: data.book }));
    return el('details', { class: 'maestro-m23-job-details' }, [
        el('summary', { text: t('m23.job.details') }),
        el(
            'ul',
            {},
            lines.map((line) => el('li', { text: line })),
        ),
    ]);
}

function buttons(app: App, job: UserJobInfo, actions: JobViewActions, compact: boolean): HTMLElement[] {
    const t = app.i18n.t.bind(app.i18n);
    const data = localizeData(job.data);
    const list: HTMLElement[] = [];
    if (job.state === 'active') {
        if (job.cancellable && !job.cancelRequested)
            list.push(
                button({
                    label: t('m23.job.stop'),
                    icon: 'fa-stop',
                    kind: compact ? 'ghost' : 'danger',
                    className: 'maestro-m23-job-stop',
                    onClick: () => actions.stop(),
                }),
            );
        return list;
    }
    const failedUids = (data?.failed ?? []).map((item) => item.uid);
    if (job.state === 'done' && failedUids.length)
        list.push(
            button({
                label: t('m23.job.retryFailed'),
                icon: 'fa-rotate-right',
                className: 'maestro-m23-job-retry',
                onClick: () => actions.retry(failedUids),
            }),
        );
    if (job.state === 'failed' && data?.uids.length && data.reason !== 'protected')
        list.push(
            button({
                label: t('m23.job.retry'),
                icon: 'fa-rotate-right',
                className: 'maestro-m23-job-retry',
                onClick: () => actions.retry(data.uids),
            }),
        );
    if (!compact)
        list.push(
            button({
                label: t('m23.job.hide'),
                kind: 'ghost',
                className: 'maestro-m23-job-hide',
                onClick: () => actions.dismiss(),
            }),
        );
    return list;
}

/** Status strip of a book's localization (book header of the studio). */
export function renderJobStrip(app: App, job: UserJobInfo, actions: JobViewActions): HTMLElement {
    const text = jobText(app, job);
    const data = localizeData(job.data);
    const active = job.state === 'active';
    return el(
        'div',
        {
            class: ['maestro-m23-job', stateClass(job)],
            data: { key: job.key, state: job.state },
            attrs: { role: 'status', 'aria-live': 'polite' },
        },
        [
            el('div', { class: 'maestro-m23-job-line' }, [
                statusIcon(job),
                el('span', { class: 'maestro-m23-job-text', text }),
                el('div', { class: 'maestro-m23-job-actions' }, buttons(app, job, actions, false)),
            ]),
            active && job.phase !== 'queued' ? progressBar(job.done, job.total, text) : null,
            active && data && !data.live
                ? el('div', { class: 'maestro-m23-job-hint', text: app.i18n.t('m23.job.oldLocalizer') })
                : null,
            details(app, job),
        ],
    );
}

/** Compact status next to the entry form's «Russian keys» button. */
export function renderJobInline(app: App, job: UserJobInfo, actions: JobViewActions): HTMLElement {
    return el(
        'span',
        {
            class: ['maestro-m23-job-inline', stateClass(job)],
            data: { key: job.key, state: job.state },
            attrs: { role: 'status', 'aria-live': 'polite' },
        },
        [
            statusIcon(job),
            el('span', { class: 'maestro-m23-job-text', text: jobText(app, job) }),
            ...buttons(app, job, actions, true),
        ],
    );
}
