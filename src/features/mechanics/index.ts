// M25 «Механики: статы, магия, правила» (plan M25, §2.1, §8; stage 11): the user's own game systems without lore
// tricks. Three parts are built side by side and wired here (parts.ts): definitions in Maestro books with the
// constructor, the state per chat with its three tracking modes, and the checks with the prompt injection and the
// widgets. Every part's listeners are owned, so switching the module off leaves nothing behind (P11).
// Exposed as app.modules.api<MechanicsApi>('mechanics').
import type { MaestroModule } from '../../shared/contracts';
import type { MechanicsApi } from './api';
import { MechanicChecks, secureRng } from './checks';
import { MechanicCombat } from './combat';
import { MechanicDefinitions, MECHANICS_DEF_TARGET } from './definitions';
import { MECHANICS_ID, MECHANICS_KEY } from './parts';
import type { MechanicsSettings, PartDeps } from './parts';
import { MechanicPrompt } from './prompt';
import { MechanicsService } from './service';
import { defaultMechanicsSettings, readMechanicsSettings } from './settings';
import { BATCH_UNDO_TARGET, MechanicState, VALUE_UNDO_TARGET } from './state';
import { MechanicsHud } from './hud';
import { MechanicsNarrator } from './narrator';
import { MechanicsPlayStrip } from './play-strip';
import { MECHANICS_STRINGS } from './strings';
import { DES_STATS_UNDO_TARGET, MechanicTracking } from './tracking';
import { MechanicTranslator } from './translate';
import { mechanicsBuildTab, mechanicsLogTab, mechanicsTab } from './view';
import { MECHANICS_DEF_CSS } from './view-constructor';
import { PLAY_CSS } from './view-play';
import { VALUES_CSS } from './view-values';
import { MechanicStrip } from './widgets';

export const mechanicsModule: MaestroModule<MechanicsSettings> = {
    id: MECHANICS_ID,
    key: MECHANICS_KEY,
    stage: 11,
    titleKey: 'm25.title',
    enabledByDefault: true,
    defaults: defaultMechanicsSettings,
    i18n: MECHANICS_STRINGS,
    targets: [
        // A definition is stored as a lore entry: its name reads in words, the English rules stay under «Подробнее».
        { target: MECHANICS_DEF_TARGET, fields: { comment: { labelKey: 'm25.def.field.name' } } },
        { target: VALUE_UNDO_TARGET },
        // A reset or another batch of changes: its count reads in words, the batch id stays technical.
        { target: BATCH_UNDO_TARGET, fields: { count: { labelKey: 'm25.state.field.count' } } },
        // DES's whole stats list (ids, prompt names): technical.
        { target: DES_STATS_UNDO_TARGET, technical: true },
    ],
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
        // Rolls the model asks for in its service block: rolled as soon as the reply arrives.
        own(tracking.onRollRequests((index, swipeId, rolls) => checks.requested(index, swipeId, rolls)));

        const combat = new MechanicCombat(deps, defs, state, secureRng);
        own(() => combat.dispose());
        combat.install();
        // Fight lines of a committed reply's block.
        own(tracking.onCombatLines((index, lines) => combat.handleLines(index, lines)));

        const prompt = new MechanicPrompt(deps, defs, state, tracking, checks);
        own(() => prompt.dispose());
        prompt.install();

        const strip = new MechanicStrip(deps, defs, state);
        own(() => strip.dispose());
        strip.install();

        const api = new MechanicsService(defs, state, checks, deps, { prompt, combat }) satisfies MechanicsApi;
        app.modules.expose(MECHANICS_KEY, api);

        // plan-2 §6.А: under the replies (change lines, roll cards, events, the status block), the HUD, narrator
        // messages, and the English for the model of what the user writes in his language.
        const play = new MechanicsPlayStrip(deps, api);
        own(() => play.dispose());
        play.install();

        const hud = new MechanicsHud(deps, api);
        own(() => hud.dispose());
        hud.install();

        const narrator = new MechanicsNarrator(deps, api);
        own(() => narrator.dispose());
        narrator.install();

        const translator = new MechanicTranslator(deps, defs);
        own(() => translator.dispose());
        translator.install();

        own(app.ui.style('maestro-m25-defs', MECHANICS_DEF_CSS));
        own(app.ui.style('maestro-m25-values', VALUES_CSS));
        own(app.ui.style('maestro-m25-play', PLAY_CSS));
        own(app.ui.addTab(mechanicsTab(deps, defs, state, checks, api)));
        own(app.ui.addTab(mechanicsLogTab(deps, api)));
        own(app.ui.addTab(mechanicsBuildTab(deps, defs, tracking, api, translator)));
    },
};

export { DEF_STRINGS, MECHANICS_STRINGS } from './strings';
export { defaultMechanicsSettings, readMechanicsSettings } from './settings';
export { MechanicDefinitions, MECHANICS_DEF_TARGET, MECHANICS_OFF_POINTER, scopeContextOf } from './definitions';
export { MechanicsService } from './service';
export { MechanicCombat, COMBAT_KIND } from './combat';
export { MECHANICS_BUILD_TAB, MECHANICS_LOG_TAB, MECHANICS_TAB, mechanicsTab } from './view';
export { MechanicsHud } from './hud';
export { MechanicsNarrator } from './narrator';
export { MechanicsPlayStrip } from './play-strip';
export { MechanicTranslator, TRANSLATE_TASK } from './translate';
export { constructorSection, MECHANICS_DEF_CSS } from './view-constructor';
export { settingsSection } from './view-constructor-settings';
export { DEFAULT_MECHANICS_BOOK, DEFAULT_MECHANICS_SETTINGS, MECHANICS_ID, MECHANICS_KEY } from './parts';
export type { MechanicsSettings } from './parts';
export type * from './api';
