// M25 «Механики: статы, магия, правила» (plan M25, §2.1, §8; stage 11): the user's own game systems without lore
// tricks. Three parts are built side by side and wired here (parts.ts): definitions in Maestro books with the
// constructor, the state per chat with its three tracking modes, and the checks with the prompt injection and the
// widgets. Every part's listeners are owned, so switching the module off leaves nothing behind (P11).
// Exposed as app.modules.api<MechanicsApi>('mechanics').
import type { MaestroModule } from '../../shared/contracts';
import type { MechanicsApi } from './api';
import { MechanicChecks } from './checks';
import { MechanicDefinitions } from './definitions';
import { MECHANICS_ID, MECHANICS_KEY } from './parts';
import type { MechanicsSettings, PartDeps } from './parts';
import { MechanicPrompt } from './prompt';
import { MechanicsService } from './service';
import { defaultMechanicsSettings, readMechanicsSettings } from './settings';
import { MechanicState } from './state';
import { MECHANICS_STRINGS } from './strings';
import { MechanicTracking } from './tracking';
import { mechanicsTab } from './view';
import { MECHANICS_DEF_CSS } from './view-constructor';
import { MechanicStrip } from './widgets';

export const mechanicsModule: MaestroModule<MechanicsSettings> = {
    id: MECHANICS_ID,
    key: MECHANICS_KEY,
    stage: 11,
    titleKey: 'm25.title',
    enabledByDefault: true,
    defaults: defaultMechanicsSettings,
    i18n: MECHANICS_STRINGS,
    init({ app, log, own }) {
        const settings = () => readMechanicsSettings(app.settings.module<Partial<MechanicsSettings>>(MECHANICS_KEY));
        const deps: PartDeps = { app, log: log.scope('mechanics'), settings };

        const defs = new MechanicDefinitions(deps);
        own(() => defs.dispose());
        defs.install();

        const state = new MechanicState(deps, defs);
        own(() => state.dispose());
        state.install();

        const tracking = new MechanicTracking(deps, defs, state);
        own(() => tracking.dispose());
        tracking.install();

        const checks = new MechanicChecks(deps, defs, state);
        own(() => checks.dispose());
        checks.install();

        const prompt = new MechanicPrompt(deps, defs, state, tracking, checks);
        own(() => prompt.dispose());
        prompt.install();

        const strip = new MechanicStrip(deps, defs, state);
        own(() => strip.dispose());
        strip.install();

        app.modules.expose(MECHANICS_KEY, new MechanicsService(defs, state, checks, deps) satisfies MechanicsApi);
        own(app.ui.style('maestro-m25-defs', MECHANICS_DEF_CSS));
        own(app.ui.addTab(mechanicsTab(deps, defs, state, checks, tracking)));
    },
};

export { DEF_STRINGS, MECHANICS_STRINGS } from './strings';
export { defaultMechanicsSettings, readMechanicsSettings } from './settings';
export { MechanicDefinitions, MECHANICS_DEF_TARGET, MECHANICS_OFF_POINTER, scopeContextOf } from './definitions';
export { MechanicsService } from './service';
export { MECHANICS_TAB, mechanicsTab } from './view';
export { constructorSection, MECHANICS_DEF_CSS } from './view-constructor';
export { settingsSection } from './view-constructor-settings';
export { DEFAULT_MECHANICS_BOOK, DEFAULT_MECHANICS_SETTINGS, MECHANICS_ID, MECHANICS_KEY } from './parts';
export type { MechanicsSettings } from './parts';
export type * from './api';
