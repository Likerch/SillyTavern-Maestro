// M21 «Казначей» (plan M21, stage 7 «полностью»): on top of the core cost meter (stage 0: actual OpenRouter cost
// through the fetch gate, background cap, overall daily limit) — spend per turn, session and day by source (main,
// user regenerations, M12's auto-swipes, Qvink, Maestro's tasks, NAI Studio's LLM calls and its Anlas), the pult tab
// «Расходы» and the «Экономный» switch when the daily limit says so (never blocking the main generation).
import { formatEnum } from '../../core/labels';
import type { MaestroModule } from '../../shared/contracts';
import type { TreasurerApi } from './api';
import { MODE_TARGET, TREASURER_ID, TREASURER_KEY, TreasurerService, defaultTreasurerSettings } from './service';
import type { TreasurerSettings } from './service';
import { M21_STRINGS } from './strings';
import { M21_CSS, treasurerTab } from './view';

export type { SpendLine, SpendSource, SpendSummary, TreasurerApi, TurnSpend } from './api';
export {
    AUTO_DAYS_FILE_KIND,
    ECONOMY_KIND,
    MODE_TARGET,
    TREASURER_DOC_KIND,
    TREASURER_ID,
    TREASURER_KEY,
    TreasurerService,
    defaultTreasurerSettings,
} from './service';
export type { TreasurerDeps, TreasurerSettings } from './service';
export { M21_CSS, TREASURER_TAB, treasurerTab } from './view';
export { M21_STRINGS } from './strings';

export const treasurerModule: MaestroModule<TreasurerSettings> = {
    id: TREASURER_ID,
    key: TREASURER_KEY,
    stage: 7,
    titleKey: 'm21.title',
    enabledByDefault: true,
    defaults: defaultTreasurerSettings,
    i18n: M21_STRINGS,
    // The mode switch reads «Режим Maestro: Сбалансированный → Экономный».
    targets: [{ target: MODE_TARGET, format: formatEnum('m21.mode.') }],
    init({ app, settings, log, own }) {
        const service = new TreasurerService(app, settings, log);
        service.install(own);
        app.modules.expose(TREASURER_KEY, service satisfies TreasurerApi);
        own(app.ui.style('maestro-m21', M21_CSS));
        own(app.ui.addTab(treasurerTab(app, service)));
    },
};
