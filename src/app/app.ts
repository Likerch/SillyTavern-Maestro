// Builds the App: host, core services, adapters, UI and modules. The only place that knows every layer.
import { createAdapters } from '../adapters';
import { createAutonomy } from '../core/autonomy';
import { createBus } from '../core/bus';
import { createChatStore } from '../core/chat-store';
import { createCostMeter } from '../core/cost';
import { createEphemeral } from '../core/ephemeral';
import { createFileStore } from '../core/files';
import { createI18n, hostLocale } from '../core/i18n';
import { createInbox } from '../core/inbox';
import { createJournal } from '../core/journal';
import { createLabels } from '../core/labels';
import { createLeader } from '../core/leader';
import { createLlmClient } from '../core/llm';
import { ConsoleLogger, createLogger } from '../core/logger';
import { Settings } from '../core/settings';
import { CORE_STRINGS } from '../core/strings';
import { createTaskQueue } from '../core/tasks';
import { TurnPipeline } from '../core/turn';
import { createHost } from '../host';
import type { App } from '../shared/contracts';
import { createUi } from '../ui';
import { Modules } from './module-manager';
import { installDataActions } from './data-actions';
import { MODULES } from './registry';

export interface Runtime {
    app: App;
    turn: TurnPipeline;
    settings: Settings;
    modules: Modules;
    stop(): Promise<void>;
}

export async function startMaestro(): Promise<Runtime> {
    const log = createLogger();
    const host = createHost(log.scope('host'));
    const settings = new Settings(
        () => host.ctx().extensionSettings,
        () => host.ctx().saveSettingsDebounced(),
        log.scope('settings'),
    );
    ConsoleLogger.setLevel(settings.core().debug ? 'debug' : 'info');

    const i18n = createI18n(() => {
        const choice = settings.core().uiLanguage;
        if (choice === 'ru' || choice === 'en') return choice;
        return hostLocale(() => host.ctx().getCurrentLocale?.());
    });
    i18n.register(CORE_STRINGS);

    const bus = createBus(log.scope('bus'));
    const files = createFileStore(host, log.scope('files'));
    const chat = createChatStore(host, files, log.scope('chat'));
    const leader = createLeader(host, files, bus, log.scope('leader'));
    const cost = createCostMeter({ host, settings, files, bus, log: log.scope('cost') });
    const llm = createLlmClient({ host, settings, cost, log: log.scope('llm') });
    const journal = createJournal({ host, chat, log: log.scope('journal') });
    const autonomy = createAutonomy({ settings, journal, files, log: log.scope('autonomy') });
    const inbox = createInbox({ chat, journal, autonomy, bus, log: log.scope('inbox') });
    const ephemeral = createEphemeral({ host, log: log.scope('ephemeral') });
    const turn = new TurnPipeline(host, bus, ephemeral, log.scope('turn'));
    const tasks = createTaskQueue({
        host,
        chat,
        files,
        leader,
        bus,
        log: log.scope('tasks'),
        isIdle: () => turn.current() === null,
    });
    const ui = createUi({ host, i18n, settings, log: log.scope('ui') });
    autonomy.bind({ inbox, ui, i18n });

    const labels = createLabels();
    const adapters = createAdapters(host, log.scope('adapters'));
    const modules = new Modules(settings, log.scope('modules'));

    const app: App = {
        host,
        turn,
        log,
        i18n,
        settings,
        files,
        chat,
        leader,
        tasks,
        llm,
        cost,
        journal,
        autonomy,
        inbox,
        ephemeral,
        bus,
        ui,
        adapters,
        modules,
    };

    modules.register(MODULES, (module) => {
        if (module.i18n) i18n.register(module.i18n);
        // Labels of journal targets stay registered while the module is off: its old records still read well.
        if (module.targets) labels.register(module.targets);
    });

    host.install();
    await Promise.all(
        Object.values(adapters).map((adapter) =>
            adapter.ready().catch((error: unknown) => log.warn(`adapter ${adapter.id} not ready`, error)),
        ),
    );
    await host.caps.refresh();
    turn.install();
    leader.start();
    tasks.start();
    cost.install();
    ui.mount();
    ui.registerCoreViews({
        inbox,
        journal,
        autonomy,
        cost,
        modules,
        settings,
        caps: host.caps,
        tasks,
        i18n,
        labels,
    });
    const offDataActions = installDataActions(app);
    await modules.startAll(app);
    ui.runFirstRunWizardIfNeeded();

    // DES and others finish loading their settings after Maestro activates: probe again once ST is ready.
    const appReady = host.events.name('APP_READY');
    const offAppReady = appReady
        ? host.events.on(appReady, () => {
              void host.caps.refresh();
          })
        : () => {};

    return {
        app,
        turn,
        settings,
        modules,
        async stop() {
            offAppReady();
            for (const off of offDataActions) off();
            await modules.stopAll();
            ui.dispose();
            cost.dispose();
            tasks.stop();
            leader.stop();
            turn.dispose();
            await autonomy.flush();
            autonomy.dispose();
            inbox.dispose();
            chat.dispose();
            host.dispose();
        },
    };
}
