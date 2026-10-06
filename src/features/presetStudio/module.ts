// M34 «Пресет-студия», stage 5: builds the data layer (store), the user's layer and the analysis from their factories
// (store.ts, layer.ts, analysis.ts — written separately, injected by index.ts so this module can be built and tested
// without them), exposes them ('presetStore', 'presetLayer', 'presetAnalysis') and the studio ('presetStudio':
// {open(identifier?)}), and adds the launcher in place of ST's Prompt Manager (optional), the pult tab and
// /maestro-preset. Chat Completion only: for Text Completion ST hides the launcher with #openai_settings and the
// studio refuses to open (plan §4.14).
import type { App, I18nParts, Logger, MaestroModule, Unsubscribe } from '../../shared/contracts';
import type { PresetAnalysisApi } from './analysis-api';
import type { PresetLayerApi } from './layer-api';
import { PM_CONTAINER_ID, PmInfo, PmLauncher } from './launcher';
import type { PresetStore } from './store-api';
import { ANALYSIS_STRINGS } from './analysis-strings';
import { LAYER_STRINGS } from './layer-strings';
import { PRESET_STORE_STRINGS } from './store';
import { M34_STRINGS } from './strings';
import { PresetStudio, defaultPresetStudioSettings, presetStudioWindow, servicesOf } from './studio';
import type { PresetStudioSettings } from './studio';
import { M34_CSS } from './styles';
import { PRESET_TARGETS, TARGET_STRINGS } from './targets';
import { presetStudioTab } from './view-tab';

export const PRESET_STUDIO_KEY = 'presetStudio';
export const PRESET_STORE_KEY = 'presetStore';
export const PRESET_LAYER_KEY = 'presetLayer';
export const PRESET_ANALYSIS_KEY = 'presetAnalysis';

/** A part as its factory returns it: the API itself, or a handle with `api`; either may have install()/dispose(). */
export type PresetPart<T> = T | { api: T; install?(): unknown; dispose?(): unknown };

/** Factories of the parts other agents write; any of them may be missing (the studio degrades). */
export interface PresetFactories {
    store?: (app: App, log: Logger) => PresetPart<PresetStore> | Promise<PresetPart<PresetStore>>;
    layer?: (
        app: App,
        log: Logger,
        store: PresetStore,
    ) => PresetPart<PresetLayerApi> | Promise<PresetPart<PresetLayerApi>>;
    analysis?: (
        app: App,
        log: Logger,
        store: PresetStore,
    ) => PresetPart<PresetAnalysisApi> | Promise<PresetPart<PresetAnalysisApi>>;
}

/** What other modules get as 'presetStudio'. */
export interface PresetStudioApi {
    open(identifier?: string): void;
}

/** Runtime handles of a started module (tests, other code in this feature). */
export interface PresetStudioRuntime {
    studio: PresetStudio;
    launcher: PmLauncher;
    pm: PmInfo;
}

let runtime: PresetStudioRuntime | null = null;

export function presetStudioRuntime(): PresetStudioRuntime | null {
    return runtime;
}

/**
 * The shell's strings and those of the parts (they exist before any part's install() runs), with the labels of the
 * journal kinds and targets (targets.ts).
 */
export const PRESET_STUDIO_STRINGS: I18nParts = {
    en: {
        ...M34_STRINGS.en,
        ...ANALYSIS_STRINGS.en,
        ...LAYER_STRINGS.en,
        ...PRESET_STORE_STRINGS.en,
        ...TARGET_STRINGS.en,
    },
    ru: {
        ...M34_STRINGS.ru,
        ...ANALYSIS_STRINGS.ru,
        ...LAYER_STRINGS.ru,
        ...PRESET_STORE_STRINGS.ru,
        ...TARGET_STRINGS.ru,
    },
};

type Own = (dispose: Unsubscribe | (() => void | Promise<void>)) => void;

/**
 * Starts a part and returns its API: `install()` (its disposer, or a list of them, is owned) and `dispose()` are
 * feature-detected; a handle's `api` is what gets exposed.
 */
function adopt<T>(part: PresetPart<T>, own: Own, log: Logger): T {
    const life = part as { api?: unknown; install?: () => unknown; dispose?: () => unknown };
    if (typeof life.install === 'function') {
        const result = life.install();
        const offs = Array.isArray(result) ? result : [result];
        for (const off of offs) if (typeof off === 'function') own(off as Unsubscribe);
    } else if (typeof life.dispose === 'function') {
        own(async () => {
            try {
                await life.dispose?.();
            } catch (error) {
                log.warn('preset part dispose failed', error);
            }
        });
    }
    return (life.api && typeof life.api === 'object' ? life.api : part) as T;
}

async function build<T>(name: string, log: Logger, make: () => T | Promise<T>): Promise<T | null> {
    try {
        return await make();
    } catch (error) {
        log.error(`preset ${name} could not start`, error);
        return null;
    }
}

/** Opens ST's «AI Response Configuration» drawer (PM lives there, P-001) when it is closed. */
function openAiDrawer(): void {
    const panel = document.getElementById('left-nav-panel');
    if (panel && !panel.classList.contains('openDrawer')) {
        document.querySelector<HTMLElement>('#ai-config-button .drawer-toggle')?.click();
    }
    document.getElementById(PM_CONTAINER_ID)?.scrollIntoView?.({ block: 'start' });
}

export function createPresetStudioModule(factories: PresetFactories): MaestroModule<PresetStudioSettings> {
    return {
        id: 'M34',
        key: PRESET_STUDIO_KEY,
        stage: 5,
        titleKey: 'm34.title',
        enabledByDefault: true,
        defaults: defaultPresetStudioSettings,
        requires: ['st.oai.promptManager', 'st.presetManager'],
        i18n: PRESET_STUDIO_STRINGS,
        targets: PRESET_TARGETS,
        async init({ app, settings, log, own }) {
            const expose = (key: string, api: unknown) => {
                app.modules.expose(key, api);
                own(() => app.modules.expose(key, undefined));
            };

            /* -------------------------------------------------------- parts */
            const storePart = factories.store ? await build('store', log, () => factories.store!(app, log)) : null;
            const store = storePart ? adopt(storePart, own, log) : null;
            if (store) {
                expose(PRESET_STORE_KEY, store);
                const layer = factories.layer
                    ? await build('layer', log, () => factories.layer!(app, log, store))
                    : null;
                if (layer) expose(PRESET_LAYER_KEY, adopt(layer, own, log));
                const analysis = factories.analysis
                    ? await build('analysis', log, () => factories.analysis!(app, log, store))
                    : null;
                if (analysis) expose(PRESET_ANALYSIS_KEY, adopt(analysis, own, log));
            } else {
                log.warn('the preset store is not available: the Preset Studio stays closed');
            }

            /* -------------------------------------------------------- studio and launcher */
            const services = servicesOf(app);
            const pm = new PmInfo(app, log);
            void pm.load();
            const saveSettings = () => {
                app.settings.notify(`modules.${PRESET_STUDIO_KEY}`);
                app.settings.save();
            };
            const ref: { launcher: PmLauncher | null } = { launcher: null };
            const showClassic = () => {
                ref.launcher?.showClassic();
                openAiDrawer();
            };
            const studio = new PresetStudio({ app, log, services, settings, saveSettings, pm, showClassic });
            const launcher = new PmLauncher({ app, log, services, pm, open: () => studio.open() });
            ref.launcher = launcher;
            runtime = { studio, launcher, pm };
            expose(PRESET_STUDIO_KEY, {
                open: (identifier?: string) => studio.open(identifier),
            } satisfies PresetStudioApi);
            own(() => {
                studio.dispose();
                if (runtime?.studio === studio) runtime = null;
            });
            own(app.ui.style('m34-preset-studio', M34_CSS));
            // Plan-2 §10: the studio is a non-modal Maestro window.
            if (typeof app.ui.addWindow === 'function') own(app.ui.addWindow(presetStudioWindow(studio)));
            // Putting PM back is part of every disable (P11, P-015).
            own(() => launcher.restore());
            if (settings.replacePromptManager) launcher.install();

            /* -------------------------------------------------------- entry points */
            own(
                app.ui.addTab(
                    presetStudioTab(app, {
                        settings,
                        open: () => studio.open(),
                        showClassic,
                        setReplace: (on) => {
                            settings.replacePromptManager = on;
                            saveSettings();
                            if (!on) {
                                launcher.restore();
                                return false;
                            }
                            return launcher.install();
                        },
                        replaceActive: () => launcher.active(),
                        setEditsToLayer: (on) => {
                            settings.editsToLayer = on;
                            saveSettings();
                            if (studio.isOpen()) studio.scheduleRefresh();
                        },
                        summary: () => (services.store() ? launcher.summary() : null),
                    }),
                ),
            );
            own(
                app.ui.addSlashCommand({
                    name: 'maestro-preset',
                    helpKey: 'm34.slash.help',
                    args: [{ name: 'value', descriptionKey: 'm34.slash.block', optional: true }],
                    callback: (_args, value) => {
                        const block = String(value ?? '').trim();
                        studio.open(block || undefined);
                        return '';
                    },
                }),
            );
        },
    };
}
