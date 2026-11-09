// M45 «Мизансцена» (plan docs/agents-plan.md §3.16, release 1.32): poses and positions of the scene, filled by the agent
// «Мизансцена» (M44) through the receiver `staging.set`; the prompt line «кто где и как»; a panel to see and edit it.
// Without the agent the module stays empty. Exposed as app.modules.api<StagingApi>('staging').
import type { MaestroModule } from '../../shared/contracts';
import { defaultStagingSettings, STAGING_TARGET, StagingService } from './service';
import type { StagingSettings } from './service';
import { STAGING_STRINGS } from './strings';
import { STAGING_CSS, stagingTab } from './view';

export const STAGING_KEY = 'staging';

export const stagingModule: MaestroModule<StagingSettings> = {
    id: 'M45',
    key: STAGING_KEY,
    stage: 32,
    titleKey: 'm45.title',
    enabledByDefault: true,
    defaults: defaultStagingSettings,
    i18n: STAGING_STRINGS,
    targets: [{ target: STAGING_TARGET, technical: true }],
    init({ app, log, own }) {
        const settings = (): StagingSettings => ({
            ...defaultStagingSettings(),
            ...app.settings.module<Partial<StagingSettings>>(STAGING_KEY),
        });
        const service = new StagingService(app, log.scope('staging'), settings);
        for (const off of service.install()) own(off);
        app.modules.expose(STAGING_KEY, service);
        own(() => app.modules.expose(STAGING_KEY, undefined));
        own(app.ui.style('maestro-m45', STAGING_CSS));
        own(app.ui.addTab(stagingTab(app, service, settings)));
    },
};
