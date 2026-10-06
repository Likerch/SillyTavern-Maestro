// M37 «Подготовить к игре», release 1.15 (plan-2 §7): in a new chat Maestro reads the card, its books, the persona and
// the DES campaign with the background model and proposes what the story needs before the first move — characters,
// the world, places, factions, items, traditions, time, promises, secrets, the starting scene, mechanics and direction;
// the chosen items are written through the modules' APIs, each as one part with its own undo, «для чата» or «для
// персонажа» (reused by the card's next new chats). The offer under the greeting and the preparation window come in the
// next wave; here: the engine (PrepareApi), a pult tab and `/maestro-prepare`.
// Exposed as app.modules.api<PrepareApi>('prepare').
import type { App, MaestroModule, SlashCommandSpec } from '../../shared/contracts';
import type { PrepareApi } from './api';
import { PrepareService } from './service';
import { PREPARE_ID, PREPARE_KEY, defaultPrepareSettings, readPrepareSettings } from './settings';
import type { PrepareSettings } from './settings';
import { PREPARE_STRINGS, PREPARE_TARGETS } from './strings';
import { PREPARE_CSS, planLines, prepareTab } from './view';

export const PREPARE_COMMAND = 'maestro-prepare';

function slashCommand(app: App, service: PrepareService): SlashCommandSpec {
    const t = app.i18n.t.bind(app.i18n);
    const listPlan = (): string => {
        const plan = service.plan();
        if (!plan || !plan.items.length) return t('m37.slash.empty');
        return planLines(app, service, plan).join('\n');
    };
    return {
        name: PREPARE_COMMAND,
        helpKey: 'm37.slash.help',
        args: [{ name: 'value', descriptionKey: 'm37.slash.value', optional: true }],
        callback: async (_args, value) => {
            const command = String(value ?? '')
                .trim()
                .toLowerCase();
            const say = (text: string, level: 'info' | 'warn' = 'info'): string => {
                app.ui.notice(text, { urgent: true, level });
                return text;
            };
            try {
                await service.load();
                if (command === 'apply' || command === 'saved') {
                    const summary = command === 'apply' ? await service.apply('all') : await service.applySaved();
                    const lines = [...summary.done, ...summary.failed, ...summary.skipped].map((line) => line.text);
                    return say([...lines, ...summary.proposals].join('\n') || t('m37.skip.nothing'));
                }
                if (command === 'status') {
                    const status = await service.status();
                    return say(status.lines.join('\n') || t('m37.view.ready'));
                }
                if (service.state().stage === 'running') return say(t('m37.slash.running'));
                if (command !== 'again' && service.plan()) return listPlan();
                const eligibility = service.eligibility();
                if (!eligibility.ok && !(command === 'again' && eligibility.reason === 'started')) {
                    return say(t(`m37.view.notNew.${eligibility.reason ?? 'noChat'}`), 'warn');
                }
                const key = await service.start({ force: command === 'again' });
                if (!key) return say(t('m37.slash.running'));
                await service.whenDone();
                return listPlan();
            } catch (error) {
                return say(error instanceof Error ? error.message : String(error), 'warn');
            }
        },
    };
}

export const prepareModule: MaestroModule<PrepareSettings> = {
    id: PREPARE_ID,
    key: PREPARE_KEY,
    stage: 15,
    titleKey: 'm37.title',
    enabledByDefault: true,
    defaults: defaultPrepareSettings,
    i18n: PREPARE_STRINGS,
    targets: PREPARE_TARGETS,
    init({ app, log, own }) {
        const settings = () => readPrepareSettings(app.settings.module<Partial<PrepareSettings>>(PREPARE_KEY));
        const service = new PrepareService(app, log, settings);
        for (const off of service.install()) own(off);
        app.modules.expose(PREPARE_KEY, service.api() satisfies PrepareApi);
        own(app.ui.style('maestro-m37', PREPARE_CSS));
        own(app.ui.addTab(prepareTab(app, service)));
        own(app.ui.addSlashCommand(slashCommand(app, service)));
        void service.load().catch((error: unknown) => log.debug('prepare: the plan did not load', error));
    },
};

export { PREPARE_STRINGS, PREPARE_TARGETS } from './strings';
export { PrepareService } from './service';
export { PREPARE_ID, PREPARE_KEY, defaultPrepareSettings, readPrepareSettings } from './settings';
export type { PrepareSettings } from './settings';
export type * from './api';
