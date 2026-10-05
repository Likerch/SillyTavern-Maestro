// M29 «Фоны» (plan M29, §2.1, §8, §12; stage 10): the chat background follows the place — the place's bound
// background (with variants by time of day and weather from DES), else the best match from ST's background library;
// when nothing fits, «Сгенерировать фон» in NAI Studio by the user's button. Only the CHAT background is set (ST's chat
// lock path), never the global one or `/bg`; a chat background Maestro did not set is the user's and stays.
// Exposed as app.modules.api<BackgroundsApi>('backgrounds').
import type { MaestroModule } from '../../shared/contracts';
import type { BackgroundsApi } from './api';
import { BackgroundsService } from './service';
import { BACKGROUNDS_ID, BACKGROUNDS_KEY, defaultBackgroundsSettings, readBackgroundsSettings } from './settings';
import type { BackgroundsSettings } from './settings';
import { BACKGROUNDS_STRINGS } from './strings';
import { BACKGROUNDS_CSS, backgroundsTab } from './view';

export const backgroundsModule: MaestroModule<BackgroundsSettings> = {
    id: BACKGROUNDS_ID,
    key: BACKGROUNDS_KEY,
    stage: 10,
    titleKey: 'm29.title',
    enabledByDefault: true,
    defaults: defaultBackgroundsSettings,
    i18n: BACKGROUNDS_STRINGS,
    init({ app, log, own }) {
        const settings = () =>
            readBackgroundsSettings(app.settings.module<Partial<BackgroundsSettings>>(BACKGROUNDS_KEY));
        const service = new BackgroundsService(app, log.scope('backgrounds'), settings);
        for (const off of service.install()) own(off);
        own(() => service.dispose());
        app.modules.expose(BACKGROUNDS_KEY, service satisfies Required<BackgroundsApi>);
        own(app.ui.style('maestro-m29', BACKGROUNDS_CSS));
        own(app.ui.addTab(backgroundsTab(app, service, settings)));
    },
};

export { BACKGROUNDS_STRINGS } from './strings';
export {
    BACKGROUNDS_ID,
    BACKGROUNDS_KEY,
    CHAT_BG_TARGET,
    GENERATE_KIND,
    PICK_KIND,
    POINTER,
    SET_KIND,
    defaultBackgroundsSettings,
    readBackgroundsSettings,
} from './settings';
export type { BackgroundsSettings } from './settings';
export { BOUND_SCORE, BackgroundsService, readSetPayload } from './service';
export type { BackgroundsState, Budget, GenerateBackgroundInput, Owner, SetPayload } from './service';
export { CAP_ST_BACKGROUNDS, CHAT_BG_KEY, ChatBackground } from './st-background';
export { BACKGROUNDS_CSS, BACKGROUNDS_TAB, backgroundsTab } from './view';
export type { BackgroundChoice, BackgroundsApi } from './api';
