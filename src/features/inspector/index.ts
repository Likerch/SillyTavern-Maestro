// M2 «Инспектор хода» (plan M2, dev-plan 1.2): what the prompt of every real turn is made of.
import type { MaestroModule } from '../../shared/contracts';
import type { InspectorApi } from './api';
import { Inspector } from './inspector';
import type { InspectorSettings } from './inspector';
import { M2_STRINGS } from './strings';
import { M2_CSS, promptTab } from './view';

export { Inspector, INSPECTOR_DOC_KIND } from './inspector';
export type { InspectorSettings, InspectorTurnDetails, PromptCapture } from './inspector';
export { M2_STRINGS } from './strings';
export { PROMPT_TAB } from './view';

export const inspectorModule: MaestroModule<InspectorSettings> = {
    id: 'M2',
    key: 'inspector',
    stage: 1,
    titleKey: 'm2.title',
    enabledByDefault: true,
    defaults: () => ({ keepTurns: 100 }),
    requires: ['st.events.ccPromptReady'],
    i18n: M2_STRINGS,
    init({ app, settings, log, own }) {
        const inspector = new Inspector(app, settings, log);
        inspector.install(own);
        app.modules.expose('inspector', inspector satisfies InspectorApi);
        own(app.ui.style('maestro-m2', M2_CSS));
        own(app.ui.addTab(promptTab(app, inspector, settings)));
    },
};
