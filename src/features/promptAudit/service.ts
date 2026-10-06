// M38 «Проверка промпта»: the report over a capture (api.ts). The rules layer runs on the user's request (the button,
// /maestro-audit, the assistant); the AI layer after the user saw its estimate, as a user job with progress and «Stop»
// (app.jobs); fixes through the router (fixes.ts). The report lives in the chat document next to the capture, so it is
// there after a reload; «Не считать конфликтом» is remembered in the module's settings (fingerprints, capped).
import { createUserJobs } from '../../core/jobs';
import { stableHash } from '../../domain/hash';
import {
    AI_MAX_TOKENS,
    AI_SCHEMA,
    AI_SCHEMA_NAME,
    buildAiRequest,
    estimateAi,
    parseAiAnswer,
} from '../../domain/prompt-audit-ai';
import type { AiConflict, AiEstimate } from '../../domain/prompt-audit-ai';
import { patchCapture } from '../../domain/prompt-audit-fix';
import { itemsByRef } from '../../domain/prompt-audit-map';
import type { AuditCapture } from '../../domain/prompt-audit-map';
import { auditRules, fingerprintOf, shortQuote, sortHits } from '../../domain/prompt-audit-rules';
import type { FixScope, RuleHit } from '../../domain/prompt-audit-rules';
import type { App, Logger, Unsubscribe, UserJobs } from '../../shared/contracts';
import type { PresetAnalysisApi, PresetFinding } from '../presetStudio/analysis-api';
import type { AuditBusy, AuditConflict, AuditReport, FixOutcome, FixPlan, PromptAuditApi } from './api';
import type { AuditCapturer } from './capture';
import type { FixRouter } from './fixes';
import { FixError } from './fixes';
import { riskText, topicTitle, whyText } from './labels';

/** LLM task of the AI check (its own profile row; empty = the background profile). */
export const AI_TASK = 'promptAudit.ai';
/** User job of the AI check. */
export const AI_JOB = 'promptAudit.ai';
/** Fingerprints remembered by «Не считать конфликтом». */
export const IGNORE_CAP = 300;
/** Conflicts kept in one report. */
const REPORT_CAP = 80;
/** Preset Studio findings the report shows (blocks that never go out, empty messages, strict-type mismatches). */
const UNUSED_FINDINGS = new Set(['neverIncluded', 'typeMismatch', 'emptyMessage']);

export interface PromptAuditSettings {
    /** Fingerprints of conflicts the user said are not conflicts. */
    ignored: string[];
}

export function defaultPromptAuditSettings(): PromptAuditSettings {
    return { ignored: [] };
}

/** The live slice, repaired in place. */
export function readPromptAuditSettings(settings: PromptAuditSettings): PromptAuditSettings {
    if (!Array.isArray(settings.ignored)) settings.ignored = [];
    settings.ignored = settings.ignored.filter((item) => typeof item === 'string').slice(-IGNORE_CAP);
    return settings;
}

const fallbackJobs = new WeakMap<object, UserJobs>();

/** The user jobs service (a bare App of an older stand gets a private one). */
function userJobs(app: App): UserJobs {
    if (app.jobs) return app.jobs;
    let jobs = fallbackJobs.get(app);
    if (!jobs) {
        jobs = createUserJobs({ log: app.log, notice: (text, options) => app.ui?.notice?.(text, options) });
        fallbackJobs.set(app, jobs);
    }
    return jobs;
}

export interface ServiceDeps {
    app: App;
    log: Logger;
    settings: PromptAuditSettings;
    saveSettings(): void;
    capturer: AuditCapturer;
    router: FixRouter;
}

export class PromptAuditService implements Omit<PromptAuditApi, 'renderReport'> {
    private readonly app: App;
    private readonly listeners = new Set<() => void>();
    private state: AuditBusy | null = null;

    constructor(private readonly deps: ServiceDeps) {
        this.app = deps.app;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    install(own: (dispose: Unsubscribe) => void): void {
        own(this.deps.capturer.onChange(() => this.emit()));
        own(userJobs(this.app).on((_job, key) => key === AI_JOB && this.emit()));
        own(() => this.listeners.clear());
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.deps.log.error('prompt audit listener failed', error);
            }
        }
    }

    jobs(): UserJobs {
        return userJobs(this.app);
    }

    ready(): Promise<void> {
        return this.deps.capturer.ensureLoaded();
    }

    busy(): AuditBusy | null {
        if (this.state) return this.state;
        return this.jobs().get(AI_JOB)?.state === 'active' ? 'ai' : null;
    }

    dryRunAvailable(): boolean {
        return !this.state && this.deps.capturer.dryRunAvailable();
    }

    capture(): AuditCapture | null {
        const doc = this.deps.capturer.doc();
        if (!doc) return null;
        if (doc.report?.source === 'dry' && doc.dry) return doc.dry;
        return doc.turn ?? doc.dry;
    }

    report(): AuditReport | null {
        return this.deps.capturer.doc()?.report ?? null;
    }

    private async run<T>(busy: AuditBusy, job: () => Promise<T>): Promise<T> {
        this.state = busy;
        this.emit();
        try {
            return await job();
        } finally {
            this.state = null;
            this.emit();
        }
    }

    /* ---------------------------------------------------------------- the rules */

    async check(options: { dry?: boolean } = {}): Promise<AuditReport | null> {
        await this.ready();
        if (this.state) return this.report();
        return this.run(options.dry ? 'dry' : 'check', async () => {
            let capture: AuditCapture | null;
            if (options.dry) {
                capture = await this.deps.capturer.dryRun();
                if (!capture) {
                    this.app.ui.notice(this.t('m38.dry.failed'), { urgent: true, level: 'warn' });
                    capture = this.deps.capturer.doc()?.turn ?? null;
                }
            } else capture = this.deps.capturer.doc()?.turn ?? this.deps.capturer.doc()?.dry ?? null;
            if (!capture) return null;
            return this.checkCapture(capture);
        });
    }

    /** The rules over a capture; the AI conflicts of the same capture stay. */
    private async checkCapture(capture: AuditCapture): Promise<AuditReport> {
        const hits = auditRules(capture);
        const conflicts = hits.map((hit) => this.conflictOf(hit, 'rules', capture));
        conflicts.push(...(await this.presetFindings(capture)));
        const previous = this.report();
        const same = previous && previous.captureAt === capture.at && previous.source === capture.source;
        if (same) conflicts.push(...previous.conflicts.filter((conflict) => conflict.source === 'ai'));
        const report = this.reportOf(capture, conflicts, same ? previous.ai : undefined, same ? previous : null);
        await this.save(report);
        return report;
    }

    private reportOf(
        capture: AuditCapture,
        conflicts: AuditConflict[],
        ai: AuditReport['ai'],
        previous: AuditReport | null,
    ): AuditReport {
        const ignored = new Set(readPromptAuditSettings(this.deps.settings).ignored);
        const seen = new Set<string>();
        const statuses = new Map((previous?.conflicts ?? []).map((conflict) => [conflict.id, conflict.status]));
        const kept: AuditConflict[] = [];
        let hidden = 0;
        for (const conflict of sortHits(conflicts)) {
            if (seen.has(conflict.id)) continue;
            seen.add(conflict.id);
            if (ignored.has(conflict.fingerprint)) {
                hidden++;
                continue;
            }
            const status = statuses.get(conflict.id);
            if (status === 'skipped') conflict.status = status;
            kept.push(conflict);
        }
        const report: AuditReport = {
            at: Date.now(),
            captureAt: capture.at,
            source: capture.source,
            conflicts: kept.slice(0, REPORT_CAP),
            hidden,
        };
        if (ai) report.ai = ai;
        return report;
    }

    private conflictOf(hit: RuleHit, source: 'rules' | 'ai', capture: AuditCapture): AuditConflict {
        const fingerprint = fingerprintOf(hit);
        const conflict: AuditConflict = {
            id: `c${stableHash(`${source}|${fingerprint}`)}`,
            fingerprint,
            source,
            topic: hit.topic,
            severity: hit.severity,
            a: hit.a,
            title: topicTitle(this.app, hit),
            why: source === 'ai' ? (hit as AiConflict).why : whyText(this.app, hit, capture),
        };
        if (hit.b) conflict.b = hit.b;
        if (hit.also?.length) conflict.also = hit.also;
        const risk = source === 'ai' ? (hit as AiConflict).risk : riskText(this.app, hit, capture);
        if (risk) conflict.risk = risk;
        if (hit.fix) conflict.fix = hit.fix;
        return conflict;
    }

    /** Blocks the Preset Studio says never go out (only for the preset the capture used). */
    private async presetFindings(capture: AuditCapture): Promise<AuditConflict[]> {
        const analysis = this.app.modules.api<PresetAnalysisApi>('presetAnalysis');
        if (!analysis || capture.source !== 'turn') return [];
        let findings: PresetFinding[];
        try {
            findings = await analysis.findings();
        } catch (error) {
            this.deps.log.debug('preset analysis findings', error);
            return [];
        }
        const refs = new Set(capture.items.map((item) => item.ref));
        const result: AuditConflict[] = [];
        for (const finding of findings) {
            if (!UNUSED_FINDINGS.has(finding.kind) || !finding.identifier) continue;
            const ref = `preset:${finding.identifier}`;
            if (!refs.has(ref)) continue;
            const hit: RuleHit = {
                topic: 'unused',
                severity: 'low',
                a: { ref, quote: shortQuote(finding.text) },
                values: { a: finding.kind },
            };
            const conflict = this.conflictOf(hit, 'rules', capture);
            conflict.why = finding.text;
            result.push(conflict);
        }
        return result;
    }

    private async save(report: AuditReport, capture?: AuditCapture): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        await this.deps.capturer.update(chatId, (doc) => {
            doc.report = report;
            if (capture?.source === 'dry') doc.dry = capture;
            else if (capture) doc.turn = capture;
        });
        this.emit();
    }

    /* ---------------------------------------------------------------- the AI */

    aiEstimate(): AiEstimate | null {
        const capture = this.capture();
        if (!capture || !capture.items.length) return null;
        return estimateAi(buildAiRequest(capture, this.app.i18n.locale()).chars, AI_MAX_TOKENS);
    }

    async runAi(): Promise<AuditReport | null> {
        await this.ready();
        const capture = this.capture();
        if (!capture) return null;
        if (!this.app.llm.available(AI_TASK)) {
            this.app.ui.notice(this.t('m38.ai.noProfile'), { urgent: true, level: 'warn' });
            return this.report();
        }
        // The request goes through the background profile and counts toward its daily cap (the client refuses it).
        if (this.app.cost.backgroundCapReached()) {
            this.app.ui.notice(this.t('m38.ai.cap'), { urgent: true, level: 'warn' });
            return this.report();
        }
        const job = this.jobs().start({
            key: AI_JOB,
            title: this.t('m38.ai.job'),
            module: 'promptAudit',
            cancellable: true,
        });
        if (!job) return this.report();
        const request = buildAiRequest(capture, this.app.i18n.locale());
        job.phase('running', this.t('m38.ai.phase.asking', { count: capture.items.length }));
        let result;
        try {
            result = await this.app.llm.request<unknown>({
                task: AI_TASK,
                messages: [
                    { role: 'system', content: request.system },
                    { role: 'user', content: request.user },
                ],
                maxTokens: AI_MAX_TOKENS,
                temperature: 0,
                schema: { name: AI_SCHEMA_NAME, schema: AI_SCHEMA },
                signal: job.signal,
            });
        } catch (error) {
            result = { ok: false, error: error instanceof Error ? error.message : String(error) };
        }
        if (job.signal.aborted) {
            job.finish(this.t('m38.ai.stopped'), { cancelled: true });
            return this.report();
        }
        const items = itemsByRef(capture);
        const parsed = result.ok ? parseAiAnswer(result.data ?? result.text, request.ids, items) : null;
        if (!parsed) {
            const error = result.ok ? this.t('m38.ai.badAnswer') : (result.error ?? this.t('m38.ai.failed'));
            job.fail(error, { notice: this.t('m38.ai.failedNotice') });
            await this.saveAi(capture, [], { at: Date.now(), count: 0, error });
            return this.report();
        }
        job.phase('saving');
        const conflicts = parsed.map((hit) => this.conflictOf(hit, 'ai', capture));
        const ai: NonNullable<AuditReport['ai']> = { at: Date.now(), count: conflicts.length };
        if (result.costUsd !== undefined) ai.costUsd = result.costUsd;
        const report = await this.saveAi(capture, conflicts, ai);
        job.finish(conflicts.length ? this.t('m38.ai.found', { count: conflicts.length }) : this.t('m38.ai.none'), {
            notice: conflicts.length ? this.t('m38.ai.found', { count: conflicts.length }) : this.t('m38.ai.none'),
        });
        return report;
    }

    /** Replaces the AI conflicts of the report made from this capture (a report of another capture is replaced). */
    private async saveAi(
        capture: AuditCapture,
        conflicts: AuditConflict[],
        ai: NonNullable<AuditReport['ai']>,
    ): Promise<AuditReport> {
        const previous = this.report();
        const same = previous && previous.captureAt === capture.at && previous.source === capture.source;
        const rules = same ? previous.conflicts.filter((conflict) => conflict.source === 'rules') : [];
        const report = this.reportOf(capture, [...rules, ...conflicts], ai, same ? previous : null);
        await this.save(report);
        return report;
    }

    /* ---------------------------------------------------------------- fixes */

    private conflict(id: string): AuditConflict | undefined {
        return this.report()?.conflicts.find((conflict) => conflict.id === id);
    }

    plan(id: string, scope?: FixScope): FixPlan | null {
        const conflict = this.conflict(id);
        return conflict ? this.deps.router.plan(conflict, this.capture(), scope) : null;
    }

    async fix(id: string, scope: FixScope = 'global'): Promise<FixOutcome> {
        const outcome = await this.run('fix', () => this.fixOne(id, scope));
        this.app.ui.notice(outcome.message, { urgent: true, level: outcome.ok ? 'info' : 'warn' });
        return outcome;
    }

    private async fixOne(id: string, scope: FixScope): Promise<FixOutcome> {
        const conflict = this.conflict(id);
        if (!conflict?.fix) return { id, ok: false, message: this.t('m38.fix.none') };
        if (conflict.status === 'fixed') return { id, ok: false, message: this.t('m38.fix.already') };
        const capture = this.capture();
        try {
            const message = await this.deps.router.apply(conflict, capture, scope);
            const report = this.report();
            const stored = report?.conflicts.find((item) => item.id === id);
            if (report && stored) {
                stored.status = 'fixed';
                if (capture) patchCapture(capture, conflict.fix);
                await this.save(report, capture ?? undefined);
            }
            return { id, ok: true, message };
        } catch (error) {
            if (!(error instanceof FixError)) this.deps.log.warn('prompt audit fix failed', error);
            const message = error instanceof Error ? error.message : String(error);
            return {
                id,
                ok: false,
                message: error instanceof FixError ? message : this.t('m38.fix.failed', { error: message }),
            };
        }
    }

    async fixMany(ids: readonly string[], scope: FixScope = 'global'): Promise<FixOutcome[]> {
        const outcomes = await this.run('fix', async () => {
            const before = this.deps.router.journalIds();
            const results: FixOutcome[] = [];
            for (const id of ids) results.push(await this.fixOne(id, scope));
            const fresh = [...this.deps.router.journalIds()].filter((id) => !before.has(id));
            const done = results.filter((outcome) => outcome.ok).length;
            if (fresh.length > 1) await this.deps.router.recordBatch(fresh, done);
            return results;
        });
        const done = outcomes.filter((outcome) => outcome.ok).length;
        const failed = outcomes.filter((outcome) => !outcome.ok);
        const text = failed.length
            ? this.t('m38.fix.batchPartial', {
                  done,
                  failed: failed.length,
                  reasons: failed.map((outcome) => outcome.message).join(' '),
              })
            : done === 1
              ? (outcomes[0]?.message ?? '')
              : this.t('m38.fix.batchDone', { count: done });
        this.app.ui.notice(text, { urgent: true, level: failed.length ? 'warn' : 'info' });
        return outcomes;
    }

    skip(id: string): void {
        const report = this.report();
        const conflict = report?.conflicts.find((item) => item.id === id);
        if (!report || !conflict) return;
        conflict.status = 'skipped';
        void this.save(report);
    }

    ignore(id: string): void {
        const report = this.report();
        const conflict = report?.conflicts.find((item) => item.id === id);
        if (!report || !conflict) return;
        const settings = readPromptAuditSettings(this.deps.settings);
        if (!settings.ignored.includes(conflict.fingerprint)) settings.ignored.push(conflict.fingerprint);
        settings.ignored = settings.ignored.slice(-IGNORE_CAP);
        this.deps.saveSettings();
        report.conflicts = report.conflicts.filter((item) => item.id !== id);
        report.hidden += 1;
        void this.save(report);
    }

    restoreIgnored(): void {
        const settings = readPromptAuditSettings(this.deps.settings);
        settings.ignored = [];
        this.deps.saveSettings();
        const capture = this.capture();
        if (capture && !this.state) void this.run('check', () => this.checkCapture(capture));
        else this.emit();
    }
}
