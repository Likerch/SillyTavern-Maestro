// M27 «Гардероб и состояния» (plan M27, §2.1, §8; stage 10; release 1.11 plan-2 §4 «что надето сейчас»): outfits and
// states of characters and places persist and are drawn the same way. Every committed turn the clothing of each
// character of the scene (DES's clothing field, else the clothing cut out of the appearance text) is compared with the
// outfit on in the chat-level NAI passport: known outfits are put on, new ones made after two turns, undressing is
// followed; the persona has its own check and a field by hand; a short prompt line keeps the model consistent; DES
// portraits are redrawn on a change. Character states (wet, wounded, tired …) and place states (ruined, on fire,
// night, rain …) follow the tracker. Writes go through NAI Studio's API at chat scope only.
// «Переодеть сейчас» (wearNow) puts clothes on at once everywhere they show (the record, the passport and its looks,
// the DES portrait and tracker, the prompt line), with one undo; «Переодевание по сообщениям» (triggers.ts) applies a
// change the player's message or the narration says, the model reads what the text does not tell; «Переодеться» at
// the Maestro button at the message box, the line under the message, `/maestro-wear` (quick.ts).
// Exposed as app.modules.api<WardrobeApi>('wardrobe').
import type { I18n, MaestroModule, TargetSpec } from '../../shared/contracts';
import type { WardrobeApi } from './api';
import { DesFieldOffer } from './des-field';
import { DES_TRACKER_TARGET } from './des-write';
import { PersonaCheck } from './persona';
import { installPromptLine } from './prompt-line';
import { wardrobeComposerGroup, wardrobeStripProvider, wearSlashCommand } from './quick';
import { WardrobeService } from './service';
import {
    defaultWardrobeSettings,
    DES_FIELD_UNDO_TARGET,
    readWardrobeSettings,
    WARDROBE_CURRENT_TARGET,
    WARDROBE_ID,
    WARDROBE_KEY,
    WARDROBE_UNDO_TARGET,
} from './settings';
import type { WardrobeSettings } from './settings';
import { WARDROBE_STRINGS } from './strings';
import { WardrobeTriggers } from './triggers';
import { WARDROBE_CSS, wardrobeTab } from './view';

const TECHNICAL = { labelKey: 'm27.field.technical', hidden: true };

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** The outfit on: its name, or the own clothes for the clothing slot (''). */
function outfitName(value: unknown, i18n: I18n): string {
    if (typeof value !== 'string') return '';
    return value.trim() || i18n.t('m27.value.own');
}

/** A state switched on reads by its name («мокрая одежда»); switched off it is gone. */
function stateName(value: unknown, i18n: I18n): string {
    if (typeof value !== 'object' || value === null) return '';
    const state = value as { id?: unknown; enabled?: unknown };
    const id = text(state.id);
    if (!id || state.enabled === false) return '';
    const key = `m27.state.${id}`;
    const name = i18n.t(key);
    return name === key ? id : name;
}

/**
 * Wardrobe changes read as clothes and states: the outfit on, a new outfit, a look copied into the chat, a state on or
 * off. NAI tags, the tracker wordings an outfit was seen as and the DES field's prompt text are technical.
 */
export const WARDROBE_TARGETS: TargetSpec[] = [
    {
        target: WARDROBE_UNDO_TARGET,
        fields: {
            activeOutfit: { labelKey: 'm27.field.outfit', format: outfitName },
            outfit: {
                labelKey: 'm27.field.newOutfit',
                format: (value) =>
                    typeof value === 'object' && value !== null ? text((value as { name?: unknown }).name) : '',
            },
            passport: { labelKey: 'm27.field.copied', format: text },
            state: { labelKey: 'm27.field.state', format: stateName },
            tags: TECHNICAL,
            looks: TECHNICAL,
        },
    },
    {
        target: DES_FIELD_UNDO_TARGET,
        fields: {
            name: { labelKey: 'm27.field.desField', format: text },
            description: TECHNICAL,
        },
    },
    {
        // «Что надето сейчас»: the clothes in words; the rest of the record is technical.
        target: WARDROBE_CURRENT_TARGET,
        fields: {
            wording: { labelKey: 'm27.field.wearing', format: text },
            outfit: { labelKey: 'm27.field.outfit', format: outfitName },
            key: TECHNICAL,
            name: TECHNICAL,
            passportId: TECHNICAL,
            tags: TECHNICAL,
            undress: TECHNICAL,
            source: TECHNICAL,
            since: TECHNICAL,
            swipe: TECHNICAL,
            seen: TECHNICAL,
            turns: TECHNICAL,
            present: TECHNICAL,
            at: TECHNICAL,
            prior: TECHNICAL,
            applied: TECHNICAL,
            queued: TECHNICAL,
            persona: TECHNICAL,
            changedAt: TECHNICAL,
            was: TECHNICAL,
            wasUndress: TECHNICAL,
        },
    },
    {
        // DES's tracker: the field's text; the JSON of the tracker is technical.
        target: DES_TRACKER_TARGET,
        fields: {
            value: { labelKey: 'm27.field.desWording', format: text },
            thoughts: TECHNICAL,
        },
    },
];

export const wardrobeModule: MaestroModule<WardrobeSettings> = {
    id: WARDROBE_ID,
    key: WARDROBE_KEY,
    stage: 10,
    titleKey: 'm27.title',
    enabledByDefault: true,
    defaults: defaultWardrobeSettings,
    i18n: WARDROBE_STRINGS,
    targets: WARDROBE_TARGETS,
    init({ app, log, own }) {
        const settings = () => readWardrobeSettings(app.settings.module<Partial<WardrobeSettings>>(WARDROBE_KEY));
        const scoped = log.scope('wardrobe');
        const service = new WardrobeService(app, scoped, settings);
        const field = new DesFieldOffer(app, scoped);
        const persona = new PersonaCheck(app, scoped, service, settings);
        const triggers = new WardrobeTriggers(app, scoped, service, settings);
        // The narration of the reply after the tracker; the persona check every N turns only without the triggers.
        service.setTurnHook(async (index) => {
            // The hook runs inside the service's queue: the narration's changes queue up behind this turn.
            void triggers
                .afterTurn(index)
                .catch((error: unknown) => scoped.warn('wardrobe: the narration check failed', error));
            if (!settings().triggers) await persona.afterTurn(index);
        });
        service.setOpenHook(() => field.noticeOnce());
        for (const off of service.install()) own(off);
        for (const off of field.install()) own(off);
        for (const off of persona.install()) own(off);
        // Before the prompt line's producer: the line then says the clothes the player's message just changed.
        for (const off of triggers.install()) own(off);
        own(installPromptLine(app, service, settings, scoped));
        if (typeof app.ui.addComposerAction === 'function') {
            own(app.ui.addComposerAction(wardrobeComposerGroup(app, service, settings)));
        }
        if (typeof app.ui.addMessageStripProvider === 'function') {
            own(app.ui.addMessageStripProvider(wardrobeStripProvider(app, service)));
        }
        own(app.ui.addSlashCommand(wearSlashCommand(app, service)));
        app.modules.expose(WARDROBE_KEY, service satisfies Required<WardrobeApi>);
        own(app.ui.style('maestro-m27', WARDROBE_CSS));
        own(app.ui.addTab(wardrobeTab(app, service, settings, field)));
    },
};

export { WARDROBE_STRINGS } from './strings';
export {
    CHANGE_TASK,
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
    WARDROBE_CURRENT_TARGET,
    WARDROBE_UNDO_TARGET,
    WARDROBE_WEAR_KIND,
    WARDROBE_WEAR_NOW_KIND,
} from './settings';
export type { WardrobeSettings } from './settings';
export { DES_TRACKER_TARGET, DesOutfitWriter } from './des-write';
export type { DesKitLike } from './des-write';
export { CHANGE_INJECTION, CHANGE_PRODUCER, WardrobeTriggers } from './triggers';
export { WARDROBE_GROUP, wardrobeComposerGroup, wardrobeStripProvider, wearSlashCommand } from './quick';
export { isWardrobePayload, WardrobeService, wearOfDetails } from './service';
export type { PassportTarget, PlaceView, WardrobeAction, WardrobePayload, WardrobeServiceOptions } from './service';
export { DES_FIELD_ID, DES_FIELD_TEXT, DesFieldOffer, fieldFor, isOutfitField } from './des-field';
export type { DesFieldStatus } from './des-field';
export { PersonaCheck } from './persona';
export { installPromptLine, WEARING_HEADER, WEARING_MAX_TOKENS } from './prompt-line';
export { WARDROBE_CSS, WARDROBE_TAB, wardrobeTab } from './view';
export type {
    Outfit,
    OutfitIntake,
    StateChange,
    WardrobeApi,
    Wearing,
    WearNowOptions,
    WearNowResult,
    WearNowSource,
    WearNowWhat,
} from './api';
