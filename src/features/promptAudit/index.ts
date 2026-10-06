// M38 «Проверка промпта» (plan-2 §2; release 1.13, second wave): conflicts between the preset and every extension that
// puts instructions into the prompt (api.ts). Entry points: the «Проверка промпта» tab of the Preset Studio (it shows
// renderReport()), /maestro-audit [dry], and the assistant's prompt_audit / prompt_audit_fix tools. Only on request —
// no background watcher (В4).
import type { I18n, MaestroModule, TargetSpec } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { AssistantApi } from '../assistant/api';
import type { PresetStudioApi } from '../presetStudio/module';
import { PROMPT_AUDIT_KEY } from './api';
import type { PromptAuditApi } from './api';
import { AuditCapturer } from './capture';
import { BATCH_TARGET, FixRouter, SETTING_TARGET } from './fixes';
import { AI_TASK, PromptAuditService, defaultPromptAuditSettings, readPromptAuditSettings } from './service';
import type { PromptAuditSettings } from './service';
import { M38_STRINGS } from './strings';
import { auditTools } from './tools';
import { M38_CSS, renderAuditReport } from './view';

export { PROMPT_AUDIT_KEY } from './api';
export type { AuditConflict, AuditReport, FixOutcome, FixPlan, PromptAuditApi } from './api';
export { AUDIT_DOC_KIND, AuditCapturer } from './capture';
export { AUDIT_JOURNAL_KINDS, BATCH_TARGET, FixRouter, SETTING_TARGET } from './fixes';
export { AI_JOB, AI_TASK, PromptAuditService, defaultPromptAuditSettings } from './service';
export type { PromptAuditSettings } from './service';
export { M38_STRINGS } from './strings';

function onOff(value: unknown, i18n: I18n): string {
    if (typeof value === 'boolean') return i18n.t(value ? 'm38.target.on' : 'm38.target.off');
    return value === null || value === undefined ? '' : String(value);
}

export const AUDIT_TARGETS: TargetSpec[] = [
    { target: SETTING_TARGET, labelKey: 'm38.target.setting', valueLabelKey: 'm38.target.value', format: onOff },
    {
        target: BATCH_TARGET,
        labelKey: 'm38.target.batch',
        format: (value, i18n) => (typeof value === 'number' ? i18n.t('m38.target.batchValue', { count: value }) : ''),
        nullable: true,
    },
];

export const promptAuditModule: MaestroModule<PromptAuditSettings> = {
    id: 'M38',
    key: PROMPT_AUDIT_KEY,
    // After the assistant (stage 13) so its tools can be registered at start.
    stage: 13,
    titleKey: 'm38.title',
    enabledByDefault: true,
    defaults: defaultPromptAuditSettings,
    i18n: M38_STRINGS,
    targets: AUDIT_TARGETS,
    init({ app, settings, log, own }) {
        readPromptAuditSettings(settings);
        const capturer = new AuditCapturer(app, log);
        capturer.install(own);
        const router = new FixRouter(app, log);
        router.registerUndo();
        const service = new PromptAuditService({
            app,
            log,
            settings,
            saveSettings: () => {
                app.settings.notify(`modules.${PROMPT_AUDIT_KEY}`);
                app.settings.save();
            },
            capturer,
            router,
        });
        service.install(own);
        const api: PromptAuditApi = {
            ready: () => service.ready(),
            capture: () => service.capture(),
            report: () => service.report(),
            check: (options) => service.check(options),
            aiEstimate: () => service.aiEstimate(),
            runAi: () => service.runAi(),
            plan: (id, scope) => service.plan(id, scope),
            fix: (id, scope) => service.fix(id, scope),
            fixMany: (ids, scope) => service.fixMany(ids, scope),
            skip: (id) => service.skip(id),
            ignore: (id) => service.ignore(id),
            restoreIgnored: () => service.restoreIgnored(),
            busy: () => service.busy(),
            dryRunAvailable: () => service.dryRunAvailable(),
            onChange: (listener) => service.onChange(listener),
            renderReport: () => renderAuditReport(app, service),
        };
        app.modules.expose(PROMPT_AUDIT_KEY, api);
        own(() => app.modules.expose(PROMPT_AUDIT_KEY, undefined));
        own(registerProfileTask(AI_TASK, 'm38.profileTask'));
        own(app.ui.style('maestro-m38', M38_CSS));

        /* /maestro-audit [dry]: the rules now, then the report in the Preset Studio */
        own(
            app.ui.addSlashCommand({
                name: 'maestro-audit',
                helpKey: 'm38.slash.help',
                args: [{ name: 'value', descriptionKey: 'm38.slash.mode', optional: true }],
                callback: async (_args, value) => {
                    const dry =
                        String(value ?? '')
                            .trim()
                            .toLowerCase() === 'dry';
                    const report = await service.check({ dry });
                    const studio = app.modules.api<PresetStudioApi>('presetStudio');
                    if (studio?.openTab) studio.openTab('audit');
                    else studio?.open();
                    if (!report) return app.i18n.t('m38.slash.none');
                    const open = report.conflicts.filter((conflict) => conflict.status !== 'skipped');
                    const high = open.filter((conflict) => conflict.severity === 'high').length;
                    return app.i18n.t('m38.slash.result', { count: open.length, high });
                },
            }),
        );

        /* the assistant's tools: registered while the assistant runs (it may be switched off and on again) */
        let assistant: AssistantApi | null = null;
        let offTools: (() => void) | null = null;
        let stopped = false;
        const syncTools = () => {
            if (stopped) return;
            const current = app.modules.api<AssistantApi>('assistant') ?? null;
            if (current === assistant) return;
            offTools?.();
            offTools = null;
            assistant = current;
            if (!current || typeof current.registerTool !== 'function') return;
            const offs = auditTools(app, service).map((tool) => current.registerTool(tool));
            offTools = () => {
                for (const off of offs) off();
            };
        };
        syncTools();
        own(
            app.settings.onChange((path) => {
                if (path.startsWith('core.modules')) setTimeout(syncTools, 0);
            }),
        );
        own(() => {
            stopped = true;
            offTools?.();
            offTools = null;
            assistant = null;
        });
    },
};
