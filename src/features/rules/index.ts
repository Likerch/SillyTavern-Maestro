// M22 «Правила» — on-the-fly fixes and compatibility (plan M22; dev-plan 1.6–1.8, 1.11). Stage 1: the engine, the
// pult tab and nine built-in rules; later stages add rules through RulesApi.register().
import type { MaestroModule } from '../../shared/contracts';
import type { RulesSettings } from './api';
import { builtinRules, registerQvinkHandlers } from './builtin';
import { RULES_KEY, RulesEngine, defaultRulesSettings } from './engine';
import { RULES_STRINGS } from './strings';
import { RULES_VIEW_CSS, rulesTab } from './view';

export const rulesModule: MaestroModule<RulesSettings> = {
    id: 'M22',
    key: RULES_KEY,
    stage: 1,
    titleKey: 'm22.title',
    enabledByDefault: true,
    defaults: defaultRulesSettings,
    i18n: RULES_STRINGS,
    init({ app, log, own }) {
        const engine = new RulesEngine(app, log);
        own(() => engine.dispose());
        for (const off of engine.install()) own(off);
        const env = engine.env();
        for (const off of registerQvinkHandlers(env)) own(off);
        for (const rule of builtinRules(env)) own(engine.register(rule));
        app.modules.expose(RULES_KEY, engine.api());
        own(app.ui.style('m22-view', RULES_VIEW_CSS));
        own(app.ui.addTab(rulesTab(engine, app)));
        engine.sync();
    },
};

export type { RulesApi, RulesSettings } from './api';
