// M43 «Сцена и вокруг» (release 1.23): the world and the characters away from the scene live their lives, but the reply
// is about the scene. The model narrates only the characters present and writes what happens elsewhere after the scene
// as one `<offscreen>…</offscreen>` block, shown folded under the reply («Вокруг»); old blocks leave the prompt; who the
// narration shows leaving is out of Maestro's cast from the next turn. A story module: paused in workshop chats.
// Exposed as app.modules.api<SceneSplitApi>('sceneSplit') and MAESTRO_API.sceneSplit.
import type { MaestroModule } from '../../shared/contracts';
import type { SceneSplitApi } from './api';
import { SceneSplitService } from './service';
import { SCENE_SPLIT_ID, SCENE_SPLIT_KEY, defaultSceneSplitSettings, readSceneSplitSettings } from './settings';
import type { SceneSplitSettings } from './settings';
import { SCENE_SPLIT_STRINGS } from './strings';
import { SCENE_SPLIT_CSS, SCENE_SPLIT_SECTION_ORDER, renderSceneSplitSettings } from './view';

export const sceneSplitModule: MaestroModule<SceneSplitSettings> = {
    id: SCENE_SPLIT_ID,
    key: SCENE_SPLIT_KEY,
    stage: 15,
    titleKey: 'm43.title',
    enabledByDefault: true,
    defaults: defaultSceneSplitSettings,
    i18n: SCENE_SPLIT_STRINGS,
    init({ app, log, own }) {
        const settings = () =>
            readSceneSplitSettings(app.settings.module<Partial<SceneSplitSettings>>(SCENE_SPLIT_KEY));
        const service = new SceneSplitService(app, log, settings);
        service.install(own);
        app.modules.expose(SCENE_SPLIT_KEY, service satisfies SceneSplitApi);
        own(app.ui.style('maestro-m43', SCENE_SPLIT_CSS));
        if (typeof app.ui.addSettingsSection === 'function') {
            own(
                app.ui.addSettingsSection({
                    id: SCENE_SPLIT_KEY,
                    titleKey: 'm43.settings.title',
                    order: SCENE_SPLIT_SECTION_ORDER,
                    render: (container) => renderSceneSplitSettings(app, settings, () => service.hooked(), container),
                }),
            );
        }
    },
};

export type { SceneSplitApi } from './api';
export { AroundDisplay, MARK_ORDER, REFRESH_MS, WRAP_ORDER } from './display';
export { PromptCleaner } from './prompt';
export { SceneSplitService } from './service';
export {
    KEEP_MAX,
    LABEL_MAX,
    SCENE_SPLIT_ID,
    SCENE_SPLIT_INJECTION,
    SCENE_SPLIT_KEY,
    defaultSceneSplitSettings,
    readSceneSplitSettings,
} from './settings';
export type { SceneSplitSettings } from './settings';
export { SCENE_SPLIT_STRINGS } from './strings';
export { SCENE_SPLIT_CSS, SCENE_SPLIT_SECTION_ORDER, renderSceneSplitSettings } from './view';
