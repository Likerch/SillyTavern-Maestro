// M27 «Гардероб и состояния» (plan M27, §2.1, §8; stage 10): outfits and states of characters and places persist and
// are drawn the same way. New outfits in the DES tracker (after the two-turn rule of the signals) and the revision's
// outfit statements become named outfits of the chat-level NAI passport and are recognised when they come back;
// character states (wet, wounded, tired …) and place states (ruined, on fire, night, rain …) follow the tracker.
// Writes go through NAI Studio's API at chat scope only. Exposed as app.modules.api<WardrobeApi>('wardrobe').
import type { MaestroModule } from '../../shared/contracts';
import type { WardrobeApi } from './api';
import { WardrobeService } from './service';
import { defaultWardrobeSettings, readWardrobeSettings, WARDROBE_ID, WARDROBE_KEY } from './settings';
import type { WardrobeSettings } from './settings';
import { WARDROBE_STRINGS } from './strings';
import { WARDROBE_CSS, wardrobeTab } from './view';

export const wardrobeModule: MaestroModule<WardrobeSettings> = {
    id: WARDROBE_ID,
    key: WARDROBE_KEY,
    stage: 10,
    titleKey: 'm27.title',
    enabledByDefault: true,
    defaults: defaultWardrobeSettings,
    i18n: WARDROBE_STRINGS,
    init({ app, log, own }) {
        const settings = () => readWardrobeSettings(app.settings.module<Partial<WardrobeSettings>>(WARDROBE_KEY));
        const service = new WardrobeService(app, log.scope('wardrobe'), settings);
        for (const off of service.install()) own(off);
        app.modules.expose(WARDROBE_KEY, service satisfies Required<WardrobeApi>);
        own(app.ui.style('maestro-m27', WARDROBE_CSS));
        own(app.ui.addTab(wardrobeTab(app, service, settings)));
    },
};

export { WARDROBE_STRINGS } from './strings';
export {
    defaultWardrobeSettings,
    readWardrobeSettings,
    WARDROBE_DOC,
    WARDROBE_ID,
    WARDROBE_KEY,
    WARDROBE_KINDS,
    WARDROBE_UNDO_TARGET,
    WARDROBE_WEAR_KIND,
} from './settings';
export type { WardrobeSettings } from './settings';
export { isWardrobePayload, WardrobeService } from './service';
export type { PassportTarget, PlaceView, WardrobeAction, WardrobePayload, WardrobeServiceOptions } from './service';
export { WARDROBE_CSS, WARDROBE_TAB, wardrobeTab } from './view';
export type { Outfit, OutfitIntake, StateChange, WardrobeApi } from './api';
