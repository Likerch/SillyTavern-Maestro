// M44 «Агенты» (plan docs/agents-plan.md, release 1.28): own agents — an instruction, what the agent sees, when it runs,
// the model and what it does with its answer — created, edited, tested and switched on in the «Агенты» window; sets
// and default agents; card agents with consent. After the update the set «Как в 1.27» is in force: nothing changes
// until the user takes an agent or a set. Exposed as app.modules.api<AgentsApi>('agents').
import { adaptersOf } from '../../adapters';
import { storyLanguage } from '../../core/language';
import { onProposalReceiversChange, proposalReceivers } from '../../core/proposal-receivers';
import type { MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { AgentsApi } from './api';
import { AgentsChatState } from './chat-state';
import { AGENTS_PROFILE_KEY, AgentRunner } from './runner';
import { AgentRuntime } from './runtime';
import { SourceRegistry } from './sources';
import { builtInAgent } from '../../core/builtin-agents';
import { capabilitiesOf, sanitizeAgent } from '../../domain/agents/def';
import { agentFromTemplate, templateById } from '../../domain/agents/templates';
import { installBuiltinRuntime, ownChannelInstruction, reportedRun } from './builtin-runtime';
import { GATE_TASK } from './gate';
import { GROUP_MEMBERS_SOURCE, SPEAKER_KIND, installGroupHost } from './group-host';
import {
    CARD_AVATAR_TARGET,
    CHAT_PASSPORT_TARGET,
    ILLUSTRATE_KIND,
    IllustratorRegistration,
    installImageReceivers,
} from './image-receivers';
import { IMAGES_CSS, imagesTab } from './view-images';
import type { AgentsImageSettings } from './view-images';
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

export interface AgentsSettings extends AgentsImageSettings {
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
        { target: CHAT_PASSPORT_TARGET, technical: true },
        { target: CARD_AVATAR_TARGET, technical: true },
    ],
    init({ app, log, own }) {
        const store = new AgentStore(app, log);
        const state = new AgentsChatState(app, log);
        const sources = new SourceRegistry();
        own(sources.register(GROUP_MEMBERS_SOURCE));
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

        // Release 1.34: «Ведущий группы» — in a group chat with the reply order «Вручную» it picks who answers.
        for (const off of installGroupHost(app, log.scope('group'), {
            hosts: () =>
                store
                    .activeAgents()
                    .filter(
                        ({ def }) =>
                            def.result.type === 'proposals' && def.result.options.receivers.includes(SPEAKER_KIND),
                    )
                    .map(({ def }) => ({ id: def.id })),
            run: async (id, index) => {
                const def = store.get(id);
                if (!def) return;
                await runtime.runAgent(def, store.states().get(id), 'manual', 'group', { focusIndex: index });
            },
        }))
            own(off);

        // Release 1.33: pictures by agents through NAI Studio 0.16.
        const imageSettings = (): AgentsImageSettings => app.settings.module<AgentsSettings>(AGENTS_KEY);
        const saveImageSettings = (patch: Partial<AgentsImageSettings>) => {
            Object.assign(app.settings.module<AgentsSettings>(AGENTS_KEY), patch);
            app.settings.notify(`modules.${AGENTS_KEY}.images`);
            app.settings.save();
        };
        for (const off of installImageReceivers(app, log.scope('images'), {
            paid: () => imageSettings().imagesPaid === true,
            language: () => storyLanguage(app),
        }))
            own(off);
        // A passport the portraitist wrote into the chat: NAI Studio drops it (same chat only).
        app.journal.registerUndo(CHAT_PASSPORT_TARGET, async (change) => {
            const id = typeof change.ref.id === 'string' ? change.ref.id : '';
            if (!id || change.ref.chatId !== app.host.chatId()) return false;
            const api = adaptersOf(app).nai.api();
            if (!api) return false;
            await api.clearChatOverride(id);
            return true;
        });
        // Maestro is NAI Studio's illustrator exactly while an illustrator agent is on in this chat.
        const illustrator = new IllustratorRegistration(app, log.scope('illustrator'), () =>
            store
                .activeAgents()
                .some(
                    ({ def }) =>
                        def.result.type === 'proposals' && def.result.options.receivers.includes(ILLUSTRATE_KIND),
                ),
        );
        const syncIllustrator = () => illustrator.sync();
        own(store.onChange(syncIllustrator));
        own(app.bus.on('chat:changed', syncIllustrator));
        own(app.bus.on('reply:ready', syncIllustrator));
        own(() => illustrator.dispose());

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
        own(app.ui.style('maestro-m44', `${AGENTS_CSS}\n${IMAGES_CSS}`));
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
            imagesTab({
                app,
                log: log.scope('images'),
                store,
                runner,
                settings: imageSettings,
                save: saveImageSettings,
                group: AGENTS_GROUP,
                syncIllustrator,
            }),
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
            imagesPaid: () => imageSettings().imagesPaid === true,
            builtinInstruction: (id, defaultText) => ownChannelInstruction(store, id, defaultText),
            reportBuiltinRun: (id, report) => {
                const spec = builtInAgent(id);
                if (spec) state.addRun(reportedRun(app, spec, report));
            },
            save: async (raw, summary) => {
                const def = sanitizeAgent(raw, Date.now());
                if (!def) return null;
                await store.save(
                    def,
                    summary ??
                        app.i18n.t(store.get(def.id) ? 'm44.journal.changed' : 'm44.journal.created', {
                            name: def.name,
                        }),
                );
                return def.id;
            },
            fromTemplate: (templateId) => {
                const template = templateById(templateId);
                if (!template) return undefined;
                const name = view.templateName(templateId);
                return agentFromTemplate(template, name, view.newId(name), Date.now(), capabilitiesOf);
            },
            setState: (scope, id, patch) => store.setAgentState(scope, id, patch),
            sets: () => store.sets(),
            saveSet: (set) => store.saveSet(set),
            applySet: (scope, setId) =>
                store.applySet(
                    scope,
                    setId,
                    (templateId) => view.templateName(templateId),
                    (name) => view.newId(name),
                ),
            test: async (id, options = {}) => {
                const def = store.get(id);
                if (!def) return null;
                const outcome = await runner.run({
                    def,
                    state: store.states().get(id),
                    phase: 'manual',
                    reason: 'test',
                    test: true,
                    ...(options.messageIndex !== undefined ? { focusIndex: options.messageIndex } : {}),
                });
                return outcome.output ? { run: outcome.run, output: outcome.output } : { run: outcome.run };
            },
            onRun: (listener) => state.onRun(listener),
            builtinOverride: (id) => store.builtinOverride(id),
            setBuiltinOverride: (id, override, summary) => store.setBuiltinOverride(id, override, summary),
        };
        app.modules.expose(AGENTS_KEY, api);

        void store.load().then(async () => {
            syncIllustrator();
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
