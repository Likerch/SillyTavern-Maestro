// Jobs the user started (core/jobs.ts) as seen outside their own window: a section of the Tasks tab with progress
// and «Stop», and the status text the top-bar tooltip uses.
import type { I18n, UserJobInfo, UserJobs } from '../../shared/contracts';
import { button, el } from '../components/dom';
import { progressBar } from '../components/progress';
import { formatTime } from './format';

/** One line about the job: the owner's own label while it runs, its result when finished. */
export function jobStatus(job: UserJobInfo, i18n: I18n): string {
    const t = i18n.t.bind(i18n);
    if (job.state === 'failed') return job.error ?? '';
    if (job.state !== 'active') return job.summary ?? '';
    if (job.cancelRequested) return t('ui.jobs.stopping');
    if (job.label) return job.label;
    if (job.phase === 'queued') return t('ui.jobs.queued');
    if (job.phase === 'saving') return t('ui.jobs.saving');
    if (job.total) return t('ui.jobs.progress', { done: job.done ?? 0, total: job.total });
    return t('ui.jobs.running');
}

/** Share of the work done (0…1); null when the job does not count its work or waits. */
export function jobFraction(job: UserJobInfo): number | null {
    if (job.state !== 'active' || job.phase === 'queued' || !job.total) return null;
    return Math.max(0, Math.min(1, (job.done ?? 0) / job.total));
}

export function renderJobs(jobs: UserJobs, i18n: I18n, onChange: () => void): HTMLElement {
    const t = i18n.t.bind(i18n);
    const list = jobs.list();
    if (!list.length) return el('div', { class: 'maestro-empty maestro-jobs-empty', text: t('ui.jobs.empty') });
    return el(
        'div',
        { class: 'maestro-jobs', attrs: { role: 'list' } },
        list.map((job) => {
            const active = job.state === 'active';
            const status = jobStatus(job, i18n);
            return el(
                'div',
                {
                    class: ['maestro-job', `maestro-job-${job.state}`, !active && job.warn ? 'maestro-job-warn' : null],
                    data: { key: job.key },
                    attrs: { role: 'listitem' },
                },
                [
                    el('div', { class: 'maestro-job-head' }, [
                        el('span', { class: 'maestro-job-title', text: job.title }),
                        el('span', {
                            class: 'maestro-muted',
                            text: t('ui.jobs.started', { time: formatTime(job.startedAt, i18n) }),
                        }),
                    ]),
                    el('div', { class: 'maestro-job-status', text: status, attrs: { 'aria-live': 'polite' } }),
                    active && job.phase !== 'queued' ? progressBar(job.done, job.total, status) : null,
                    el('div', { class: 'maestro-row' }, [
                        active && job.cancellable && !job.cancelRequested
                            ? button({
                                  label: t('ui.jobs.stop'),
                                  icon: 'fa-stop',
                                  kind: 'danger',
                                  onClick: () => {
                                      jobs.cancel(job.key);
                                      onChange();
                                  },
                              })
                            : null,
                        job.openable
                            ? button({
                                  label: t('ui.jobs.open'),
                                  icon: 'fa-up-right-from-square',
                                  onClick: () => {
                                      jobs.open(job.key);
                                  },
                              })
                            : null,
                        !active
                            ? button({
                                  label: t('ui.jobs.hide'),
                                  kind: 'ghost',
                                  onClick: () => {
                                      jobs.dismiss(job.key);
                                      onChange();
                                  },
                              })
                            : null,
                    ]),
                ],
            );
        }),
    );
}
