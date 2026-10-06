// M33 «Ассистент Maestro» (plan M33, §4.13, §7): a conversation in the pult, apart from the role-play, through its
// own connection profile (task kind 'assistant'; empty = the background profile). Its own tool loop (service.ts),
// never ST's tool calling. Reads through tools; every change is a before/after card the user confirms; Maestro's
// module settings only through the allowlist (safety.ts), journaled with undo; rate-limited per chat.
import type { MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { AssistantApi } from './api';
import { registerSettingUndo, createSettingsAccess } from './safety';
import { AssistantService } from './service';
import { ASSISTANT_KEY, ASSISTANT_TASK, defaultAssistantSettings, readAssistantSettings } from './settings';
import type { AssistantSettings } from './settings';
import { M33_STRINGS } from './strings';
import { ASSISTANT_TARGETS } from './targets';
import { builtinTools } from './tools';
import { ASSISTANT_SECTION_ORDER, M33_CSS, assistantTab, renderAssistantSettings } from './view';

export type {
    AssistantApi,
    AssistantMessage,
    SettingsAccess,
    ToolCallRecord,
    ToolCallStatus,
    ToolContext,
    ToolFactory,
    ToolKind,
    ToolOutput,
    ToolSpec,
    WritePlan,
} from './api';
export { ASSISTANT_KEY, ASSISTANT_TASK, defaultAssistantSettings, readAssistantSettings } from './settings';
export type { AssistantSettings } from './settings';
export { AssistantService, MAX_ROUNDS, MAX_WRITES } from './service';
export { createSettingsAccess, registerSettingUndo, SETTING_KIND, SETTING_TARGET } from './safety';
export { buildSystemPrompt } from './prompt';
export { ASSISTANT_TAB } from './view';
export { M33_STRINGS } from './strings';
export { ASSISTANT_TARGETS } from './targets';

export const assistantModule: MaestroModule<AssistantSettings> = {
    id: 'M33',
    key: ASSISTANT_KEY,
    stage: 13,
    titleKey: 'm33.title',
    enabledByDefault: true,
    defaults: defaultAssistantSettings,
    i18n: M33_STRINGS,
    targets: ASSISTANT_TARGETS,
    init({ app, settings, log, own }) {
        const access = createSettingsAccess(app);
        registerSettingUndo(app);
        const service = new AssistantService({ app, log, settings: () => readAssistantSettings(settings), access });
        own(service.start());
        try {
            for (const tool of builtinTools(app, log)) own(service.registerTool(tool));
        } catch (error) {
            log.error('assistant: built-in tools failed to load', error);
        }
        app.modules.expose(ASSISTANT_KEY, service satisfies AssistantApi);
        own(registerProfileTask(ASSISTANT_TASK, 'm33.profileTask'));
        own(app.ui.style('maestro-m33', M33_CSS));
        own(app.ui.addTab(assistantTab(app, service)));
        if (typeof app.ui.addSettingsSection === 'function') {
            own(
                app.ui.addSettingsSection({
                    id: ASSISTANT_KEY,
                    titleKey: 'm33.settings.title',
                    order: ASSISTANT_SECTION_ORDER,
                    render: (container) => renderAssistantSettings(container, app, settings),
                }),
            );
        }
    },
};
