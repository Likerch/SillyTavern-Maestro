// M5 «Доктор» (plan M5, dev-plan 1.5, 2.5): inventory and findings, and the treatment. Scans the lorebooks of the active
// chat and every regex script on demand; fixes are M22 rules switched on from a finding («Включить правило»), file
// fixes of the user's books («Исправить в файле», asked, journaled) and regex actions. BunnyMo packs never get a
// file fix (P13).
import { formatPlain } from '../../core/labels';
import type { I18n, MaestroModule, TargetSpec } from '../../shared/contracts';
import type { DoctorApi } from './api';
import { LORE_ENTRY_TARGET } from './files';
import { registerFileFixes } from './fixes';
import { REGEX_TARGET, registerRegexFixes } from './regex-fix';
import { RULE_TARGET, registerRuleActions } from './rules';
import { DoctorService } from './service';
import { DOCTOR_STRINGS } from './strings';
import { DOCTOR_CSS, doctorTab } from './view';

export type DoctorSettings = Record<string, never>;

export const DOCTOR_KEY = 'doctor';

/** ST's World Info role (0 system, 1 user, 2 assistant) by its name. */
function formatRole(value: unknown, i18n: I18n): string {
    return typeof value === 'number' ? i18n.t(`m5.role.${value}`) : formatPlain(value, i18n);
}

/** Regex `disabled` flag → «работает» / «выключен». */
function formatRegexState(value: unknown, i18n: I18n): string {
    return typeof value === 'boolean' ? i18n.t(value ? 'm5.value.regexOff' : 'm5.value.regexOn') : '';
}

/** Rule switch → «включено» / «выключено». */
function formatRuleSwitch(value: unknown, i18n: I18n): string {
    return typeof value === 'boolean' ? i18n.t(value ? 'm5.value.ruleOn' : 'm5.value.ruleOff') : '';
}

/**
 * Journal targets of the doctor. 'lore-entry' is shared with M22 (its archive fixes): it is described here only.
 * Fields not listed — keys, the Localizer marker, regex patterns — are technical and stay under «Подробнее».
 */
export const DOCTOR_TARGETS: TargetSpec[] = [
    {
        target: LORE_ENTRY_TARGET,
        fields: {
            role: { labelKey: 'm5.field.role', format: formatRole },
            // null (the global depth) reads as the own depth removed.
            // null = the global scan depth of SillyTavern (the fix for character sheets).
            scanDepth: {
                labelKey: 'm5.field.scanDepth',
                nullable: true,
                format: (value, i18n) => (value === null ? i18n.t('m5.value.globalDepth') : formatPlain(value, i18n)),
            },
        },
    },
    {
        target: REGEX_TARGET,
        fields: {
            scriptName: { labelKey: 'm5.field.regexName' },
            disabled: { labelKey: 'm5.field.regexState', format: formatRegexState },
        },
    },
    { target: RULE_TARGET, format: formatRuleSwitch },
];

export const doctorModule: MaestroModule<DoctorSettings> = {
    id: 'M5',
    key: DOCTOR_KEY,
    stage: 1,
    titleKey: 'm5.title',
    enabledByDefault: true,
    defaults: () => ({}),
    i18n: DOCTOR_STRINGS,
    targets: DOCTOR_TARGETS,
    init({ app, log, own }) {
        const service = new DoctorService(app, log);
        const api: DoctorApi = service.api;
        app.modules.expose(DOCTOR_KEY, api);
        own(() => service.dispose());
        own(registerRuleActions(app));
        own(registerFileFixes(app));
        for (const off of registerRegexFixes(app)) own(off);
        own(app.ui.style('m5-doctor', DOCTOR_CSS));
        const tab = doctorTab(app, service);
        own(app.ui.addTab(tab));
        // Findings describe one chat: after a chat switch they are stale until the next scan (no automatic rescan:
        // a scan reads every active book, P15).
        const chatChanged = app.host.events.name('CHAT_CHANGED');
        if (chatChanged) own(app.host.events.on(chatChanged, () => service.markStale()));
        // The tab badge counts errors; refresh the shell only when that number changes (refresh re-renders).
        let badge = 0;
        own(
            service.onChange(() => {
                const next = tab.badge?.() ?? 0;
                if (next === badge) return;
                badge = next;
                app.ui.refresh();
            }),
        );
    },
};

export type { BookStat, DoctorApi, Finding, FindingKind, FindingSeverity, RegexAction, RegexInfo } from './api';
