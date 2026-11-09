// M44 «Агенты» (plan docs/agents-plan.md, release 1.28): own agents — an instruction, what the agent sees, when it runs,
// the model and what it does with its answer — created, edited, tested and switched on in the «Агенты» window; sets
// and default agents; card agents with consent. After the update the set «Как в 1.27» is in force: nothing changes
// until the user takes an agent or a set. Exposed as app.modules.api<AgentsApi>('agents').
import { onProposalReceiversChange, proposalReceivers } from '../../core/proposal-receivers';
import type { MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { AgentsApi } from './api';
import { AgentsChatState } from './chat-state';
import { AGENTS_PROFILE_KEY, AgentRunner } from './runner';
import { AgentRuntime } from './runtime';
import { SourceRegistry } from './sources';
import { installBuiltinRuntime } from './builtin-runtime';
import { GATE_TASK } from './gate';
import { AgentStore, BUILTIN_TARGET, DEF_TARGET } from './store';
import { AGENTS_STRINGS } from './strings';
import {
    AGENTS_CSS,
    AGENTS_GROUP,
    AGENTS_WINDOW,
    AgentsView,
    agentsListTab,
    costTab,
    logTab,
    memoryTab,
    setsTab,
    stripProvider,
    templatesTab,
    turnTab,
} from './view';

export const AGENTS_KEY = 'agents';

export interface AgentsSettings {
    version: 1;
}

export const agentsModule: MaestroModule<AgentsSettings> = {
    id: 'M44',
    key: AGENTS_KEY,
    stage: 28,
    titleKey: 'm44.title',
    enabledByDefault: true,
    defaults: () => ({ version: 1 }),
    i18n: AGENTS_STRINGS,
    targets: [
        { target: DEF_TARGET, technical: true },
        { target: 'message.text', valueLabelKey: 'm44.field.text' },
        { target: BUILTIN_TARGET, technical: true },
        { target: 'canon.agentEntry', technical: true },
        { target: 'canon.agentEdit', technical: true },
        { target: 'calendar.agentPromise', technical: true },
    ],
    init({ app, log, own }) {
        const store = new AgentStore(app, log);
        const state = new AgentsChatState(app, log);
        const sources = new SourceRegistry();
        const runner = new AgentRunner(app, log, sources, state);
        const runtime = new AgentRuntime(app, log, store, state, runner);
        const view = new AgentsView(app, store, state, runtime, runner, sources);

        app.journal.registerUndo(DEF_TARGET, async (change) => {
            const id = typeof change.ref.id === 'string' ? change.ref.id : '';
            return id ? store.undoDef(id, change.before) : false;
        });
        app.journal.registerUndo('message.text', (change) => runtime.undoText(change.ref, change.before, change.after));

        app.journal.registerUndo(BUILTIN_TARGET, async (change) => {
            const id = typeof change.ref.id === 'string' ? change.ref.id : '';
            return id ? store.undoBuiltin(id, change.before) : false;
        });

        // Inbox cards of agents' proposals outlive the page: each receiver's applier, also for receivers added later.
        const appliers = new Map<string, () => void>();
        const syncAppliers = () => {
            const kinds = new Set(proposalReceivers().map((receiver) => receiver.kind));
            for (const [kind, off] of appliers) {
                if (!kinds.has(kind)) {
                    off();
                    appliers.delete(kind);
                }
            }
            for (const receiver of proposalReceivers()) {
                if (appliers.has(receiver.kind)) continue;
                appliers.set(
                    receiver.kind,
                    app.inbox.registerApplier(receiver.kind, (payload) => receiver.apply(payload)),
                );
                if (receiver.neverAuto) app.autonomy.neverAuto(receiver.kind);
            }
        };
        syncAppliers();
        own(onProposalReceiversChange(syncAppliers));
        own(() => {
            for (const off of appliers.values()) off();
            appliers.clear();
        });

        runtime.install(own);
        own(installBuiltinRuntime(app, store, state));
        own(registerProfileTask(AGENTS_PROFILE_KEY, 'm44.profileDefault'));
        own(registerProfileTask(GATE_TASK, 'm44.profileGate'));
        own(app.ui.style('maestro-m44', AGENTS_CSS));
        const addWindow = app.ui.addWindow?.bind(app.ui);
        if (addWindow) {
            own(
                addWindow({
                    id: AGENTS_WINDOW,
                    titleKey: 'm44.title',
                    icon: 'fa-robot',
                    order: 75,
                    groups: [AGENTS_GROUP],
                    defaultDock: 'right',
                    defaultWidth: 640,
                }),
            );
        }
        for (const tab of [
            agentsListTab(view),
            turnTab(view),
            memoryTab(view),
            logTab(view),
            templatesTab(view),
            setsTab(view),
            costTab(view),
        ])
            own(app.ui.addTab(tab));
        const strip = app.ui.addMessageStripProvider?.(stripProvider(view));
        if (strip) own(strip);

        const composer = app.ui.addComposerAction?.({
            id: 'agents',
            order: 70,
            label: () => app.i18n.t('m44.composer'),
            visible: () => !app.host.isGroupChat() && Boolean(app.host.chatId()),
            items: () => [
                ...store
                    .list()
                    .filter((def) => def.trigger.phase === 'manual' || store.states().get(def.id)?.on)
                    .map((def) => ({
                        id: def.id,
                        label: def.name,
                        icon: def.icon ?? 'fa-robot',
                        run: async () => {
                            await runtime.runManual(def.id);
                        },
                    })),
                {
                    id: 'open',
                    label: app.i18n.t('m44.composer.open'),
                    icon: 'fa-robot',
                    run: () => app.ui.openWindow?.(AGENTS_WINDOW),
                },
            ],
            onChange: (listener) => store.onChange(listener),
        });
        if (composer) own(composer);

        own(
            app.ui.addSlashCommand({
                name: 'maestro-agent',
                helpKey: 'm44.slash.help',
                callback: async (_args, value) => {
                    const text = String(value ?? '').trim();
                    const fold = (s: string) => s.toLowerCase().replace(/ё/g, 'е');
                    const def = [...store.list()]
                        .sort((a, b) => b.name.length - a.name.length)
                        .find((agent) => fold(text).startsWith(fold(agent.name)));
                    if (!def) return app.i18n.t('m44.slash.notFound', { name: text });
                    const extra = text.slice(def.name.length).trim() || undefined;
                    const outcome = await runtime.runManual(def.id, { extra });
                    if (!outcome) return '';
                    return outcome.run.ok
                        ? app.i18n.t('m44.slash.done', {
                              name: def.name,
                              what: outcome.run.applied?.join(', ') || app.i18n.t('m44.job.nothing'),
                          })
                        : app.i18n.t('m44.slash.failed', {
                              name: def.name,
                              reason: app.i18n.t(`m44.error.${outcome.run.error ?? 'other'}`),
                          });
                },
            }),
        );

        own(
            app.bus.on(
                'chat:changed',
                () => void view.checkCardAgents().catch((error: unknown) => log.warn('card agents', error)),
            ),
        );
        own(() => store.flush());
        own(() => state.flush());

        const api: AgentsApi = {
            list: () => store.list(),
            get: (id) => store.get(id),
            states: () => store.states(),
            run: async (id, options) => (await runtime.runManual(id, options))?.run ?? null,
            registerSource: (source) => sources.register(source),
            onChange: (listener) => store.onChange(listener),
        };
        app.modules.expose(AGENTS_KEY, api);

        void store.load().then(async () => {
            await runtime.onChatChanged();
            await view.checkCardAgents().catch((error: unknown) => log.warn('card agents', error));
            if (!store.hintShown()) {
                app.ui.notice(app.i18n.t('m44.hint.sets'), {
                    importance: 'info',
                    action: {
                        label: app.i18n.t('m44.hint.open'),
                        run: () => app.ui.openWindow?.(AGENTS_WINDOW, { tab: 'agents-sets' }),
                    },
                });
                await store.markHintShown();
            }
        });
    },
};

export type { AgentsApi } from './api';
