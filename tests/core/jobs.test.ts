import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JOB_RETENTION_MS, createUserJobs } from '../../src/core/jobs';
import type { UserJobsService } from '../../src/core/jobs';
import type { Ui, UserJobInfo } from '../../src/shared/contracts';

const silent = { debug() {}, info() {}, warn() {}, error() {}, scope: () => silent };

let notice: ReturnType<typeof vi.fn<Ui['notice']>>;
let jobs: UserJobsService;
let events: { key: string; job: UserJobInfo | undefined }[];

beforeEach(() => {
    vi.useFakeTimers();
    notice = vi.fn<Ui['notice']>();
    jobs = createUserJobs({ log: silent, notice });
    events = [];
    jobs.on((job, key) => events.push({ key, job }));
});

afterEach(() => {
    jobs.dispose();
    vi.useRealTimers();
});

describe('user jobs', () => {
    it('runs one job per key and replaces a finished one', () => {
        const first = jobs.start({ key: 'localize:World', title: 'Keys' });
        expect(first).not.toBeNull();
        expect(jobs.start({ key: 'localize:World', title: 'Keys again' })).toBeNull();
        expect(jobs.start({ key: 'localize:Other', title: 'Other' })).not.toBeNull();
        first!.finish('Done');
        const second = jobs.start({ key: 'localize:World', title: 'Keys again' });
        expect(second).not.toBeNull();
        expect(jobs.get('localize:World')).toMatchObject({ state: 'active', title: 'Keys again' });
        // The first handle belongs to a replaced job: its late calls change nothing.
        first!.progress(5, 10, 'stale');
        first!.fail('stale');
        expect(jobs.get('localize:World')).toMatchObject({ state: 'active' });
        expect(jobs.get('localize:World')?.label).toBeUndefined();
    });

    it('reports phases and progress with clamped counters', () => {
        const job = jobs.start({ key: 'k', title: 'T' })!;
        expect(jobs.get('k')).toMatchObject({ state: 'active', phase: 'running', cancellable: false });
        job.phase('queued', 'Waiting');
        expect(jobs.get('k')).toMatchObject({ phase: 'queued', label: 'Waiting' });
        job.phase('running');
        job.progress(34, 120, 'Localizing: 34 of 120');
        expect(jobs.get('k')).toMatchObject({ phase: 'running', done: 34, total: 120, label: 'Localizing: 34 of 120' });
        job.progress(500, 80);
        expect(jobs.get('k')).toMatchObject({ done: 80, total: 80 });
        job.data({ live: true });
        job.data({ total: 80 });
        expect(jobs.get('k')?.data).toEqual({ live: true, total: 80 });
        expect(events.filter((event) => event.key === 'k').length).toBeGreaterThanOrEqual(6);
        // Copies: callers cannot change the job.
        jobs.get('k')!.data!.live = false;
        expect(jobs.get('k')?.data?.live).toBe(true);
    });

    it('cancels through the signal only cancellable active jobs', () => {
        const plain = jobs.start({ key: 'plain', title: 'P' })!;
        expect(jobs.cancel('plain')).toBe(false);
        expect(plain.signal.aborted).toBe(false);
        const job = jobs.start({ key: 'k', title: 'T', cancellable: true })!;
        expect(jobs.cancel('k')).toBe(true);
        expect(job.signal.aborted).toBe(true);
        expect(jobs.get('k')).toMatchObject({ state: 'active', cancelRequested: true });
        job.finish('Stopped: 40 of 120', { cancelled: true, data: { processed: 40 } });
        expect(jobs.get('k')).toMatchObject({ state: 'cancelled', summary: 'Stopped: 40 of 120' });
        expect(jobs.get('k')?.data).toEqual({ processed: 40 });
        expect(jobs.cancel('k')).toBe(false);
        expect(jobs.cancel('missing')).toBe(false);
    });

    it('keeps finished jobs for ten minutes; Hide forgets them at once', () => {
        jobs.start({ key: 'a', title: 'A' })!.finish('Done A');
        jobs.start({ key: 'b', title: 'B' })!.fail('Error B');
        const running = jobs.start({ key: 'c', title: 'C' })!;
        jobs.dismiss('c');
        expect(jobs.get('c')).toBeDefined();
        expect(jobs.list().map((job) => job.key)).toEqual(['c', 'b', 'a']);
        jobs.dismiss('a');
        expect(jobs.get('a')).toBeUndefined();
        expect(events.at(-1)).toEqual({ key: 'a', job: undefined });
        vi.advanceTimersByTime(JOB_RETENTION_MS - 1);
        expect(jobs.get('b')).toBeDefined();
        vi.advanceTimersByTime(1);
        expect(jobs.get('b')).toBeUndefined();
        expect(jobs.get('c')).toMatchObject({ state: 'active' });
        running.finish('Done C', { warn: true });
        expect(jobs.get('c')).toMatchObject({ state: 'done', warn: true });
        expect(jobs.get('c')?.label).toBeUndefined();
    });

    it('a replaced job is not removed by the timer of the old one', () => {
        jobs.start({ key: 'k', title: 'T' })!.finish('Old');
        vi.advanceTimersByTime(JOB_RETENTION_MS / 2);
        jobs.start({ key: 'k', title: 'T' })!.finish('New');
        vi.advanceTimersByTime(JOB_RETENTION_MS / 2 + 1);
        expect(jobs.get('k')?.summary).toBe('New');
    });

    it('reports the end of a job nobody watches once; urgent only on failure', () => {
        let visible = true;
        const open = { label: 'Open', run: vi.fn() };
        jobs.start({ key: 'seen', title: 'Seen', visible: () => visible })!.finish('Done');
        expect(notice).not.toHaveBeenCalled();
        visible = false;
        jobs.start({ key: 'done', title: 'Keys', visible: () => visible, open })!.finish('Done: 3 keys');
        expect(notice).toHaveBeenLastCalledWith('Keys: Done: 3 keys', { urgent: false, level: 'info', action: open });
        jobs.start({ key: 'warn', title: 'Keys' })!.finish('Done', { warn: true, notice: 'Custom text' });
        expect(notice).toHaveBeenLastCalledWith('Custom text', { urgent: false, level: 'warn', action: undefined });
        jobs.start({ key: 'failed', title: 'Keys', visible: () => visible })!.fail('Error: no connection');
        expect(notice).toHaveBeenLastCalledWith('Keys: Error: no connection', {
            urgent: true,
            level: 'error',
            action: undefined,
        });
        jobs.start({ key: 'stopped', title: 'Keys', cancellable: true })!.finish('Stopped', { cancelled: true });
        expect(notice).toHaveBeenCalledTimes(3);
        expect(jobs.get('done')?.openable).toBe(true);
        expect(jobs.open('done')).toBe(true);
        expect(open.run).toHaveBeenCalledTimes(1);
        expect(jobs.open('failed')).toBe(false);
    });

    it('survives a failing listener and a throwing visibility check', () => {
        jobs.on(() => {
            throw new Error('boom');
        });
        const job = jobs.start({
            key: 'k',
            title: 'T',
            visible: () => {
                throw new Error('gone');
            },
        })!;
        job.progress(1, 2);
        job.finish('Done');
        expect(jobs.get('k')?.state).toBe('done');
        expect(notice).toHaveBeenCalledTimes(1);
    });

    it('dispose stops active jobs and forgets everything', () => {
        const job = jobs.start({ key: 'k', title: 'T', cancellable: true })!;
        jobs.dispose();
        expect(job.signal.aborted).toBe(true);
        expect(jobs.list()).toEqual([]);
        job.finish('late');
        expect(jobs.get('k')).toBeUndefined();
    });
});
