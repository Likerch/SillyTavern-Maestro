// M38 «Проверка промпта» for the assistant (M33): «проверь промпт на конфликты» from the assistant's chat. The read tool
// returns the last report (or runs the rules over the last turn / a test assembly); the write tool proposes one fix
// as a before/after card the user confirms (one card per fix: the batch format of the assistant's preset tools is not
// on this base). Advice-only fixes come back as an error sentence the assistant relays.
import type { FixScope } from '../../domain/prompt-audit-rules';
import type { App } from '../../shared/contracts';
import type { ToolSpec } from '../assistant/api';
import type { AuditConflict, AuditReport } from './api';
import { refLabel } from './labels';
import type { PromptAuditService } from './service';

const MODES = ['last', 'check', 'dry'] as const;
type Mode = (typeof MODES)[number];
const SCOPES: readonly FixScope[] = ['global', 'character', 'chat'];

function conflictData(app: App, service: PromptAuditService, conflict: AuditConflict): Record<string, unknown> {
    const capture = service.capture();
    const side = (ref: string, quote: string) => ({ owner: refLabel(app, capture, ref), quote });
    const plan = conflict.status === 'fixed' ? null : service.plan(conflict.id);
    const data: Record<string, unknown> = {
        id: conflict.id,
        severity: conflict.severity,
        title: conflict.title,
        found_by: conflict.source,
        a: side(conflict.a.ref, conflict.a.quote),
        why: conflict.why,
    };
    if (conflict.b) data.b = side(conflict.b.ref, conflict.b.quote);
    if (conflict.also?.length) data.also = conflict.also.map((item) => refLabel(app, capture, item.ref));
    if (conflict.risk) data.risk_on_model = conflict.risk;
    if (conflict.status) data.status = conflict.status;
    if (plan) {
        data.fix = {
            target: plan.target,
            kind: plan.kind,
            before: plan.before,
            after: plan.after,
            scopes: plan.scopes,
            ...(plan.advice ? { advice_only: plan.advice } : {}),
            ...(plan.warning ? { warning: plan.warning } : {}),
            ...(plan.reason ? { why_this_side: plan.reason } : {}),
        };
    }
    return data;
}

function reportData(app: App, service: PromptAuditService, report: AuditReport): Record<string, unknown> {
    const capture = service.capture();
    return {
        checked: report.source === 'dry' ? 'test assembly' : 'last turn',
        at: new Date(report.captureAt).toISOString(),
        preset: capture?.preset ?? null,
        model: capture?.connection?.model ?? null,
        instructions: capture?.items.length ?? 0,
        hidden_as_not_conflict: report.hidden,
        ai_checked: !!report.ai && !report.ai.error,
        conflicts: report.conflicts
            .filter((conflict) => conflict.status !== 'skipped')
            .map((conflict) => conflictData(app, service, conflict)),
    };
}

export function auditTools(app: App, service: PromptAuditService): ToolSpec[] {
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const read: ToolSpec = {
        name: 'prompt_audit',
        kind: 'read',
        description:
            'Checks the instructions of the role-play prompt for conflicts: the preset blocks, the character card, the ' +
            "author's note, every extension (DES tracker, NAI Studio picture rules, Qvink, DES-RU, CarrotKernel, " +
            'BunnyMo instructions) and Maestro itself. mode "last" (default) returns the last report or checks the ' +
            'last real turn; "check" checks the last turn again; "dry" assembles the prompt now without sending it ' +
            "and checks that. Each conflict has both quotes with owners, why it matters, the risk on the user's " +
            'model and a ready fix (target, before/after, the scopes it can be written to, or advice_only). Use ' +
            'prompt_audit_fix to propose a fix; never invent fixes for read-only owners.',
        parameters: {
            type: 'object',
            properties: { mode: { type: 'string', enum: [...MODES] } },
            additionalProperties: false,
        },
        run: async (args) => {
            const mode: Mode = MODES.includes(args.mode as Mode) ? (args.mode as Mode) : 'last';
            await service.ready();
            let report = mode === 'last' ? service.report() : null;
            if (!report) report = await service.check({ dry: mode === 'dry' });
            if (!report)
                return {
                    data: { available: false, reason: t('m38.tool.noCapture') },
                    summary: t('m38.tool.noCapture'),
                };
            const open = report.conflicts.filter((conflict) => conflict.status !== 'skipped');
            const high = open.filter((conflict) => conflict.severity === 'high').length;
            return {
                data: reportData(app, service, report),
                untrusted: true,
                summary: t('m38.slash.result', { count: open.length, high }),
            };
        },
    };
    const write: ToolSpec = {
        name: 'prompt_audit_fix',
        kind: 'write',
        description:
            'Proposes the ready fix of one conflict from prompt_audit (by its id) as a before/after card the user ' +
            'confirms. scope: global (default; everywhere), character (only this character) or chat (only this ' +
            "chat) — one of the fix's scopes. One call per conflict.",
        parameters: {
            type: 'object',
            properties: {
                conflict: { type: 'string', description: 'The conflict id from prompt_audit.' },
                scope: { type: 'string', enum: [...SCOPES] },
            },
            required: ['conflict'],
            additionalProperties: false,
        },
        plan: async (args) => {
            await service.ready();
            const id = typeof args.conflict === 'string' ? args.conflict.trim() : '';
            const scope: FixScope = SCOPES.includes(args.scope as FixScope) ? (args.scope as FixScope) : 'global';
            const conflict = service.report()?.conflicts.find((item) => item.id === id);
            const plan = conflict ? service.plan(id, scope) : null;
            if (!conflict || !plan) throw new Error(t('m38.tool.noConflict'));
            if (plan.advice) throw new Error(plan.advice);
            if (!plan.scopes.includes(scope)) {
                throw new Error(
                    t('m38.tool.scope', { scopes: plan.scopes.map((value) => t(`m38.scope.${value}`)).join(', ') }),
                );
            }
            return {
                summary: t('m38.tool.summary', { title: conflict.title, target: plan.target }),
                target: `${plan.target} · ${t(`m38.scope.${scope}`)}`,
                before: plan.before,
                after: plan.after,
                async apply() {
                    const outcome = await service.fix(id, scope);
                    if (!outcome.ok) throw new Error(outcome.message);
                    return { result: { fixed: true, message: outcome.message } };
                },
            };
        },
    };
    return [read, write];
}
