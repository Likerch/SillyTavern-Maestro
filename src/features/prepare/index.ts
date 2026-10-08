// M37 «Подготовить к игре», release 1.15 (plan-2 §7): in a new chat Maestro reads the card, its books, the persona and
// the DES campaign with the background model and proposes what the story needs before the first move — characters,
// the world, places, factions, items, traditions, time, promises, secrets, every starting scene of the card (the shown
// greeting's one is active and follows the greeting swipe until the player writes), mechanics and direction;
// the chosen items are written through the modules' APIs, each as one part with its own undo, «для чата» or «для
// персонажа» (reused by the card's next new chats). Maestro offers it by itself in a line under the greeting
// (offer.ts); the window «Подготовка к игре» (window.ts: what will be read and the price, the run, the review with
// choices, edits and scopes, the result with undo, «Готово к игре») — a window of its own, or the pult tab without
// windows; `/maestro-prepare`. Exposed as app.modules.api<PrepareApi>('prepare').
import type { App, MaestroModule, SlashCommandSpec } from '../../shared/contracts';
import type { PrepareApi } from './api';
import { PrepareUi } from './controller';
import { PrepareOffer } from './offer';
import { PrepareService } from './service';
import { PREPARE_ID, PREPARE_KEY, defaultPrepareSettings, readPrepareSettings } from './settings';
import type { PrepareSettings } from './settings';
import { PREPARE_STRINGS, PREPARE_TARGETS } from './strings';
import { planLines } from './view';
import { PREPARE_CSS, registerPrepareView } from './window';

export const PREPARE_COMMAND = 'maestro-prepare';

function slashCommand(app: App, service: PrepareService, ui: PrepareUi): SlashCommandSpec {
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
                    const lines = status.lines.length ? status.lines : [t('m37.view.ready')];
                    return say([...(status.scenes ? [status.scenes.line] : []), ...lines].join('\n'));
                }
                if (service.state().stage === 'running') return say(t('m37.slash.running'));
                if (command !== 'again' && service.plan()) return listPlan();
                const eligibility = service.eligibility();
                if (!eligibility.ok && !(command === 'again' && eligibility.reason === 'started')) {
                    return say(t(`m37.view.notNew.${eligibility.reason ?? 'noChat'}`), 'warn');
                }
                // Without a word the window opens first: what will be read and what it costs (plan-2 §7 п. 2).
                if (command !== 'again' && command !== 'start') {
                    ui.open();
                    return t('m37.slash.opened');
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
        const api = service.api();
        app.modules.expose(PREPARE_KEY, api satisfies PrepareApi);
        const ui = new PrepareUi(app, { ...api, watch: () => service.watch() }, settings);
        service.setOpener(() => ui.open());
        own(app.ui.style('maestro-m37', PREPARE_CSS));
        own(registerPrepareView(ui));
        // The offer under the greeting; a shell without the strip gets the quiet notice only.
        const offer = new PrepareOffer(ui);
        const offStrip = app.ui.addMessageStripProvider?.(offer.provider());
        if (offStrip) own(offStrip);
        for (const off of offer.install()) own(off);
        own(app.ui.addSlashCommand(slashCommand(app, service, ui)));
        void service.load().catch((error: unknown) => log.debug('prepare: the plan did not load', error));
    },
};

export { PREPARE_STRINGS, PREPARE_TARGETS } from './strings';
export { PrepareService } from './service';
export { PrepareUi, PREPARE_WINDOW } from './controller';
export type { PrepareEngine } from './controller';
export { PrepareOffer, PREPARE_STRIP } from './offer';
export { PREPARE_ID, PREPARE_KEY, defaultPrepareSettings, readPrepareSettings } from './settings';
export type { PrepareSettings } from './settings';
export type * from './api';
