// M5 «Доктор», stage 1: inventory and findings, read-only (plan M5, dev-plan 1.5). Scans the lorebooks of the active
// chat and every regex script on demand; fixes are M22 rules switched on from a finding («Включить правило») or
// file edits at stage 2. BunnyMo packs never get a file fix (P13).
import type { MaestroModule } from '../../shared/contracts';
import type { DoctorApi } from './api';
import { registerRuleActions } from './rules';
import { DoctorService } from './service';
import { DOCTOR_STRINGS } from './strings';
import { DOCTOR_CSS, doctorTab } from './view';

export type DoctorSettings = Record<string, never>;

export const DOCTOR_KEY = 'doctor';

export const doctorModule: MaestroModule<DoctorSettings> = {
    id: 'M5',
    key: DOCTOR_KEY,
    stage: 1,
    titleKey: 'm5.title',
    enabledByDefault: true,
    defaults: () => ({}),
    i18n: DOCTOR_STRINGS,
    init({ app, log, own }) {
        const service = new DoctorService(app, log);
        const api: DoctorApi = service.api;
        app.modules.expose(DOCTOR_KEY, api);
        own(() => service.dispose());
        own(registerRuleActions(app));
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

export type { BookStat, DoctorApi, Finding, FindingKind, FindingSeverity, RegexInfo } from './api';
