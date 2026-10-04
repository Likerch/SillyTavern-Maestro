// M34 п. 7 — generation scenarios (engine). Other modules register scenarios through the 'scenarios' API
// (api.ts); the engine does the event plumbing described in engine.ts. Stage 5 (п. 7, п. 9): per-scenario
// parameters (builtins.ts registry, settings `scenarioParams`) and the built-in «impersonate» and «continue»
// scenarios, off until the user switches them on.
import type { ScenarioParamValues } from '../../domain/scenario-builtins';
import type { MaestroModule } from '../../shared/contracts';
import type { SheetsApi } from '../sheets/api';
import { CONTINUE_SCENARIO, IMPERSONATE_SCENARIO, ScenarioRegistry, builtinScenario } from './builtins';
import { ScenarioEngine } from './engine';
import type { ScenariosApi } from './api';
import { SCENARIO_STRINGS } from './strings';

export interface ScenariosSettings {
    /** The user's parameters per scenario id (merged over the scenario's defaults). */
    scenarioParams: Record<string, ScenarioParamValues>;
}

export const SCENARIOS_KEY = 'scenarios';

export const scenariosModule: MaestroModule<ScenariosSettings> = {
    id: 'M34s',
    key: SCENARIOS_KEY,
    stage: 1,
    titleKey: 'scn.title',
    enabledByDefault: true,
    defaults: () => ({ scenarioParams: {} }),
    requires: ['st.events.ccPromptReady', 'st.events.ccSettingsReady', 'st.chatCompletion'],
    i18n: SCENARIO_STRINGS,

    init({ app, settings, log, own }) {
        const engine = new ScenarioEngine({
            host: app.host,
            log,
            onFailure: (id) => app.ui.notice(app.i18n.t('scn.failed', { id }), { level: 'warn' }),
        });
        const on = (key: string, handler: (...args: unknown[]) => unknown, last = false): void => {
            const name = app.host.events.name(key);
            if (!name) {
                log.warn(`ST event ${key} is missing`);
                return;
            }
            own(app.host.events.on(name, handler, last ? { order: 'last' } : undefined));
        };

        own(app.bus.on('generation:before', (info) => engine.onGenerationBefore(info)));
        own(app.bus.on('generation:ended', () => engine.onGenerationEnded()));
        own(app.bus.on('reply:ready', (payload) => engine.onReplyReady(payload)));
        own(app.bus.on('chat:changed', () => engine.reset()));

        // 'last' everywhere: our prompt and parameters must be what leaves, and WI filtering sees the final lists.
        on('CHAT_COMPLETION_PROMPT_READY', (data) => engine.onPromptReady(data), true);
        on('GENERATE_AFTER_DATA', (data, dryRun) => engine.onAfterData(data, dryRun), true);
        on('CHAT_COMPLETION_SETTINGS_READY', (data) => engine.onSettingsReady(data), true);
        on('WORLDINFO_ENTRIES_LOADED', (payload) => engine.onEntriesLoaded(payload), true);

        const registry = new ScenarioRegistry(settings, () => {
            app.settings.notify(`modules.${SCENARIOS_KEY}.scenarioParams`);
            app.settings.save();
        });
        const builtinDeps = {
            host: app.host,
            log,
            params: (id: string) => registry.params(id),
            isSheetMessage: (index: number) => app.modules.api<SheetsApi>('sheets')?.isSheetMessage(index) === true,
        };
        // Registered first: the sheet scenario only takes normal/regenerate/swipe, so the matches never overlap.
        own(engine.register(builtinScenario(IMPERSONATE_SCENARIO, builtinDeps)));
        own(engine.register(builtinScenario(CONTINUE_SCENARIO, builtinDeps)));

        const api: ScenariosApi = {
            register: (scenario) => engine.register(scenario),
            active: () => engine.active(),
            list: () => registry.list(),
            params: (id) => registry.params(id),
            setParams: (id, values) => registry.setParams(id, values),
            describe: (descriptor) => registry.describe(descriptor),
        };
        app.modules.expose(SCENARIOS_KEY, api);
        own(() => engine.reset());
    },
};
