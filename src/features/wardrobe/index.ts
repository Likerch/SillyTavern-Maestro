// M27 «Гардероб и состояния» (plan M27, §2.1, §8; stage 10; release 1.11 plan-2 §4 «что надето сейчас»): outfits and
// states of characters and places persist and are drawn the same way. Every committed turn the clothing of each
// character of the scene (DES's clothing field, else the clothing cut out of the appearance text) is compared with the
// outfit on in the chat-level NAI passport: known outfits are put on, new ones made after two turns, undressing is
// followed; the persona has its own check and a field by hand; a short prompt line keeps the model consistent; DES
// portraits are redrawn on a change. Character states (wet, wounded, tired …) and place states (ruined, on fire,
// night, rain …) follow the tracker. Writes go through NAI Studio's API at chat scope only.
// Exposed as app.modules.api<WardrobeApi>('wardrobe').
import type { MaestroModule } from '../../shared/contracts';
import type { WardrobeApi } from './api';
import { DesFieldOffer } from './des-field';
import { PersonaCheck } from './persona';
import { installPromptLine } from './prompt-line';
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
        const scoped = log.scope('wardrobe');
        const service = new WardrobeService(app, scoped, settings);
        const field = new DesFieldOffer(app, scoped);
        const persona = new PersonaCheck(app, scoped, service, settings);
        service.setTurnHook((index) => persona.afterTurn(index));
        service.setOpenHook(() => field.noticeOnce());
        for (const off of service.install()) own(off);
        for (const off of field.install()) own(off);
        for (const off of persona.install()) own(off);
        own(installPromptLine(app, service, settings, scoped));
        app.modules.expose(WARDROBE_KEY, service satisfies Required<WardrobeApi>);
        own(app.ui.style('maestro-m27', WARDROBE_CSS));
        own(app.ui.addTab(wardrobeTab(app, service, settings, field)));
    },
};

export { WARDROBE_STRINGS } from './strings';
export {
    defaultWardrobeSettings,
    DES_FIELD_UNDO_TARGET,
    PERSONA_KEY,
    PERSONA_TASK,
    readWardrobeSettings,
    WARDROBE_DOC,
    WARDROBE_ID,
    WARDROBE_INJECTION,
    WARDROBE_KEY,
    WARDROBE_KINDS,
    WARDROBE_UNDO_TARGET,
    WARDROBE_WEAR_KIND,
} from './settings';
export type { WardrobeSettings } from './settings';
export { isWardrobePayload, WardrobeService, wearOfDetails } from './service';
export type { PassportTarget, PlaceView, WardrobeAction, WardrobePayload, WardrobeServiceOptions } from './service';
export { DES_FIELD_ID, DES_FIELD_TEXT, DesFieldOffer, fieldFor, isOutfitField } from './des-field';
export type { DesFieldStatus } from './des-field';
export { PersonaCheck } from './persona';
export { installPromptLine, WEARING_HEADER, WEARING_MAX_TOKENS } from './prompt-line';
export { WARDROBE_CSS, WARDROBE_TAB, wardrobeTab } from './view';
export type { Outfit, OutfitIntake, StateChange, WardrobeApi, Wearing } from './api';
