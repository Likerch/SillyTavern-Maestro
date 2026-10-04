// M12 «Контроль качества ответа» (plan M12, §8, §11, §12, §16; dev-plan stage 6): every story reply is checked on
// reply:ready before NAI Studio draws — free rules, the judge only on suspicion — and each defect kind is handled as
// set (off / auto / notify). Exposed as app.modules.api<QualityApi>('quality').
import type { MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { QualityApi } from './api';
import { JUDGE_TASK } from './judge';
import { QualityService } from './service';
import { defaultQualitySettings, QUALITY_ID, QUALITY_KEY, readQualitySettings } from './settings';
import type { QualitySettings } from './settings';
import { QUALITY_STRINGS } from './strings';
import { QUALITY_CSS, qualityTab } from './view';

export const qualityModule: MaestroModule<QualitySettings> = {
    id: QUALITY_ID,
    key: QUALITY_KEY,
    stage: 6,
    titleKey: 'm12.title',
    enabledByDefault: true,
    defaults: defaultQualitySettings,
    i18n: QUALITY_STRINGS,
    init({ app, log, own }) {
        const settings = () => readQualitySettings(app.settings.module<Partial<QualitySettings>>(QUALITY_KEY));
        const service = new QualityService(app, log, settings);
        service.install(own);
        app.modules.expose(QUALITY_KEY, service satisfies Required<QualityApi>);
        own(registerProfileTask(JUDGE_TASK, 'm12.profileTask'));
        own(app.ui.style('maestro-m12', QUALITY_CSS));
        own(app.ui.addTab(qualityTab(app, service, settings)));
    },
};

export type {
    BoundaryRule,
    Defect,
    DefectAction,
    DefectKind,
    DefectStatus,
    QualityApi,
    QualityStats,
    QualityVerdict,
} from './api';
export { DEFAULT_TIMINGS, QualityService } from './service';
export type { MedicRepairApi, QualityTimings } from './service';
export { defaultQualitySettings, DEFECT_KINDS, QUALITY_ID, QUALITY_KEY, readQualitySettings } from './settings';
export type { QualitySettings } from './settings';
export { QUALITY_STRINGS } from './strings';
export { QUALITY_TAB } from './view';
