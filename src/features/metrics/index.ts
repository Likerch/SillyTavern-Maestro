// M21m «Замеры» (plan §14 R3 criteria, P15, §4.11-4.12; dev-plan 4.6): measures what the first full version
// promises — added send-path latency per device, background spend against the main model, lore per turn, the
// "zero" criteria (dropped messages, assistant-role lore, stale-tab rollbacks, data losses), revision and undo
// shares, the living canon, BunnyMo sheets and pack files — and shows them as a criteria table in the pult with
// a Markdown / JSON export. Its own send-path work is a few clock reads (P15); see service.ts.
import type { MaestroModule } from '../../shared/contracts';
import type { MetricsApi } from './api';
import { METRICS_KEY, MetricsService, defaultMetricsSettings } from './service';
import type { MetricsSettings } from './service';
import { M21M_STRINGS } from './strings';
import { M21M_CSS, metricsTab } from './view';

export { METRIC_COUNTERS } from './api';
export type { MetricsApi } from './api';
export { METRICS_DOC_KIND, METRICS_KEY, MetricsService, REVISION_KINDS, defaultMetricsSettings } from './service';
export type { MetricsDeps, MetricsSettings, MetricsSnapshot } from './service';
export { METRICS_TAB } from './view';
export { M21M_STRINGS } from './strings';

export const metricsModule: MaestroModule<MetricsSettings> = {
    id: 'M21m',
    key: METRICS_KEY,
    stage: 4,
    titleKey: 'm21m.title',
    enabledByDefault: true,
    defaults: defaultMetricsSettings,
    i18n: M21M_STRINGS,
    init({ app, settings, log, own }) {
        const service = new MetricsService(app, settings, log);
        service.install(own);
        // Every Maestro listener of an ST event (lore scan, prompt assembly…) counts toward Maestro's send-path share.
        const events = app.host.events;
        if (events.setTimer) {
            events.setTimer((event, ms) => service.record(`st:${event}`, ms));
            own(() => events.setTimer?.(null));
        }
        app.modules.expose(METRICS_KEY, service satisfies MetricsApi);
        own(app.ui.style('maestro-m21m', M21M_CSS));
        own(app.ui.addTab(metricsTab(app, service)));
    },
};
