// M25 «Механики: статы, магия, правила» (plan M25, §2.1, §8; stage 11): the user's own game systems without lore
// tricks. Three parts are built side by side and wired here (parts.ts): definitions in Maestro books with the
// constructor, the state per chat with its three tracking modes, and the checks with the prompt injection and the
// widgets. Every part's listeners are owned, so switching the module off leaves nothing behind (P11).
// Exposed as app.modules.api<MechanicsApi>('mechanics'), the definitions alone also as
// app.modules.api<MechanicDefinitionsApi>('mechanicsDefinitions'). A service chat (M42) pauses the module but keeps
// the definitions (`whileSuspended`, release 1.24.1): they have nothing to do with the open chat, and Officina publishes
// mechanics from its co-author chat through MAESTRO_API.mechanics. Release 1.27: a roll the model asks for is rolled
// as the reply arrives and the same reply goes on with its result (roll-continue.ts).
import type { App, Logger, MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { MechanicDefinitionsApi, MechanicsApi } from './api';
import { MechanicChecks, secureRng } from './checks';
import { MechanicCombat } from './combat';
import { MechanicDefinitions, MECHANICS_DEF_TARGET } from './definitions';
import { MechanicDefinitionsService } from './definitions-service';
import { MECHANICS_DEFS_KEY, MECHANICS_ID, MECHANICS_KEY } from './parts';
import type { MechanicsSettings, PartDeps } from './parts';
import { MechanicPrompt } from './prompt';
import { MechanicsService } from './service';
import { defaultMechanicsSettings, readMechanicsSettings } from './settings';
import { BATCH_UNDO_TARGET, MechanicState, VALUE_UNDO_TARGET } from './state';
import { MechanicsHud } from './hud';
import { MechanicsNarrator } from './narrator';
import { MechanicsPlayStrip } from './play-strip';
import { RollContinue } from './roll-continue';
import { MECHANICS_STRINGS } from './strings';
import { DES_STATS_UNDO_TARGET, EXTRACT_TASK, MechanicTracking } from './tracking';
import { MechanicTranslator } from './translate';
import { mechanicsBuildTab, mechanicsLogTab, mechanicsTab } from './view';
import { MECHANICS_DEF_CSS } from './view-constructor';
import { HEALTH_CSS } from './view-health';
import { PLAY_CSS } from './view-play';
import { VALUES_CSS } from './view-values';
import { MechanicStrip } from './widgets';

/** How long the definitions kept in a service chat wait for a write in flight when the story chat opens. */
export const HELD_WRITES_WAIT_MS = 3000;

function partDeps(app: App, log: Logger): PartDeps {
    const settings = () => readMechanicsSettings(app.settings.module<Partial<MechanicsSettings>>(MECHANICS_KEY));
    return { app, log: log.scope('mechanics'), settings };
}

/** Resolves when `done` does or after `ms`, whichever is first (the timer never outlives it). */
async function bounded(done: Promise<void>, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        await Promise.race([done, new Promise<void>((resolve) => (timer = setTimeout(resolve, ms)))]);
    } finally {
        clearTimeout(timer);
    }
}

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
        const deps = partDeps(app, log);

        const defs = new MechanicDefinitions(deps);
        own(() => defs.dispose());
        defs.install();

        const state = new MechanicState(deps, defs);
        own(() => state.dispose());
        state.install();

        const tracking = new MechanicTracking(deps, defs, state);
        own(() => tracking.dispose());
        tracking.install();
        // Its own line in «Профили»: the background parse of replies may go to a cheaper model than the default.
        own(registerProfileTask(EXTRACT_TASK, 'm25.profileTask'));

        const checks = new MechanicChecks(deps, defs, state);
        own(() => checks.dispose());
        checks.install();
        // Release 1.27: the reply that asked for a roll goes on with its result (one automatic /continue).
        const rollContinue = new RollContinue(deps);
        own(() => rollContinue.dispose());
        rollContinue.install();
        // Rolls the model asks for in its service block: rolled as soon as the reply arrives.
        own(
            tracking.onRollRequests((index, swipeId, rolls, info) => {
                if (checks.requested(index, swipeId, rolls) > 0) rollContinue.rolled(index, swipeId, info.arrival);
            }),
        );

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

        const api = new MechanicsService(defs, state, checks, deps, {
            prompt,
            combat,
            tracking,
            rollContinue,
        }) satisfies MechanicsApi;
        app.modules.expose(MECHANICS_KEY, api);
        app.modules.expose(MECHANICS_DEFS_KEY, api satisfies MechanicDefinitionsApi);

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
        own(app.ui.style('maestro-m25-health', HEALTH_CSS));
        own(app.ui.addTab(mechanicsTab(deps, defs, state, checks, api, tracking)));
        own(app.ui.addTab(mechanicsLogTab(deps, api)));
        own(app.ui.addTab(mechanicsBuildTab(deps, defs, tracking, api, translator)));
    },
    // A service chat: only the definitions, as a part of their own (the Maestro books, the journal undo of an entry);
    // no prompt, no reply or message listeners, no HUD, tabs or state. Its writes are journaled like the module's, and
    // the module, starting again in a story chat, reads the books afresh (a write still in flight lands first).
    whileSuspended({ app, log, own }) {
        const defs = new MechanicDefinitions(partDeps(app, log));
        own(async () => {
            await bounded(defs.idle(), HELD_WRITES_WAIT_MS);
            defs.dispose();
        });
        defs.install();
        app.modules.expose(
            MECHANICS_DEFS_KEY,
            new MechanicDefinitionsService(defs, app) satisfies MechanicDefinitionsApi,
        );
    },
};

export { DEF_STRINGS, MECHANICS_STRINGS } from './strings';
export { defaultMechanicsSettings, readMechanicsSettings } from './settings';
export { MechanicDefinitions, MECHANICS_DEF_TARGET, MECHANICS_OFF_POINTER, scopeContextOf } from './definitions';
export { MechanicsService } from './service';
export { MechanicDefinitionsService } from './definitions-service';
export { MechanicCombat, COMBAT_KIND } from './combat';
export { MECHANICS_BUILD_TAB, MECHANICS_LOG_TAB, MECHANICS_TAB, mechanicsTab } from './view';
export { MechanicsHud } from './hud';
export { MechanicsNarrator } from './narrator';
export { MechanicsPlayStrip } from './play-strip';
export { MechanicTranslator, TRANSLATE_TASK } from './translate';
export { constructorSection, MECHANICS_DEF_CSS } from './view-constructor';
export { settingsSection } from './view-constructor-settings';
export {
    DEFAULT_MECHANICS_BOOK,
    DEFAULT_MECHANICS_SETTINGS,
    MECHANICS_DEFS_KEY,
    MECHANICS_ID,
    MECHANICS_KEY,
} from './parts';
export type { MechanicsSettings } from './parts';
export type * from './api';
