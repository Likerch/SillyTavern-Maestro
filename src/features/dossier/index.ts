// M7 «Досье» (plan M7 п. 1–6, dev-plan 3.2): one page per entity with everything the stack knows — lore with the
// chat canon on top, CK archive and BunnyMo tags, NAI passports, DES, Russian forms, Qvink memories, CK RAG, the last
// BunnyMo sheet, the place registry and the persona — with structural checks by rules, an AI comparison of appearance
// and descriptions on demand, «Разнести», and «Оформить» for a new NPC or place (stage 10, style-up.ts) with
// «В книгу карточки» for its canon entries. Reads the world model (WorldModelApi) when it is on; works for the card
// character, the persona, DES's roster and places without it. Exposed as app.modules.api<DossierApi>('dossier').
import { adaptersOf } from '../../adapters';
import type { MaestroModule, TargetSpec } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import {
    ALIAS_TARGET,
    CANON_TARGET,
    DossierActions,
    ENTRY_TARGET,
    NOTE_TARGET,
    PASSPORT_TARGET,
    PLACE_TARGET,
} from './actions';
import type { DossierApi } from './api';
import { DossierCompare } from './compare';
import { DossierOpener } from './opener';
import { DossierService } from './service';
import { DOSSIER_ID, DOSSIER_KEY, defaultDossierSettings, readDossierSettings } from './settings';
import type { DossierSettings } from './settings';
import { DossierSources } from './sources';
import { DOSSIER_STRINGS } from './strings';
import { DossierStyleUp, STYLE_UP_PART_TARGET, STYLE_UP_TARGET, STYLE_UP_TASK } from './style-up';
import { DOSSIER_CSS, dossierTab } from './view';

const KEYS = { labelKey: 'm7.field.keys', hidden: true };

/**
 * How the dossier's journal changes read (plan-2 §3; labels `target.dossier-*`). Keys (names and case-form regexes),
 * entry texts (English canon), NAI tags and ids stay under «Подробнее» — the card title already says what changes in
 * words; names of passports, places and chat nicknames are shown.
 */
export const DOSSIER_TARGETS: TargetSpec[] = [
    // Keys added right in a lore book: { key } before and after.
    { target: ENTRY_TARGET, fields: { key: KEYS } },
    // The chat canon's override of a lore entry or a canon addition: { key?, content? }.
    { target: CANON_TARGET, fields: { key: KEYS, content: { labelKey: 'm7.field.text', hidden: true } } },
    // A passport patch of this chat: other names are read as they are, slots are NAI tags.
    {
        target: PASSPORT_TARGET,
        fields: {
            aliases: { labelKey: 'm7.field.otherNames' },
            slots: { labelKey: 'm7.field.looks', hidden: true },
        },
    },
    // The place registry: { name?, aliases? }.
    {
        target: PLACE_TARGET,
        fields: { name: { labelKey: 'm7.field.placeName' }, aliases: { labelKey: 'm7.field.placeAliases' } },
    },
    // A chat nickname: { alias, entity (id), name }.
    {
        target: ALIAS_TARGET,
        fields: {
            alias: { labelKey: 'm7.field.nickname' },
            name: { labelKey: 'm7.field.means' },
            entity: { labelKey: 'm7.field.id', hidden: true },
        },
    },
    // A DES reminder (its text is the card's description) or the place entry made by a fix (a place id).
    { target: NOTE_TARGET, technical: true },
    // «Оформить»: every part's content (canon text, CK markup, NAI tags); the card lists the parts in words.
    { target: STYLE_UP_TARGET, technical: true },
    { target: STYLE_UP_PART_TARGET, technical: true },
];

export const dossierModule: MaestroModule<DossierSettings> = {
    id: DOSSIER_ID,
    key: DOSSIER_KEY,
    stage: 3,
    titleKey: 'm7.title',
    enabledByDefault: true,
    defaults: defaultDossierSettings,
    i18n: DOSSIER_STRINGS,
    targets: DOSSIER_TARGETS,
    init({ app, log, own }) {
        const settings = () => readDossierSettings(app.settings.module<Partial<DossierSettings>>(DOSSIER_KEY));
        const sources = new DossierSources(app, settings, log);
        const actions = new DossierActions(app, sources, log);
        for (const off of actions.install()) own(off);
        const compare = new DossierCompare(app, sources, settings, log);
        for (const off of compare.install()) own(off);
        const styleUp = new DossierStyleUp(app, sources, log);
        for (const off of styleUp.install()) own(off);
        own(registerProfileTask(STYLE_UP_TASK, 'm7.styleUp.profileTask'));
        const service = new DossierService(app, sources, actions, compare, styleUp);
        own(compare.onResult((entityId) => service.emit(entityId)));
        own(styleUp.onResult((entityId) => service.emit(entityId)));
        // A passport saved in NAI Studio (card or chat) changes what the open dossier shows. Best effort: without
        // NAI Studio's API at start nothing is subscribed.
        try {
            own(adaptersOf(app).nai.on('passportsSaved', () => service.emit(service.currentId())));
        } catch (error) {
            log.debug('NAI Studio events are not available', error);
        }
        const opener = new DossierOpener(app, log);

        const api: DossierApi = {
            build: (entityId) => service.build(entityId),
            check: (entityId) => service.check(entityId),
            compareWithAi: (entityId) => service.compareWithAi(entityId),
            spread: (edit) => service.spread(edit),
            open: (entityId) => service.open(entityId),
            onChange: (listener) => service.onChange(listener),
        };
        app.modules.expose(DOSSIER_KEY, api);

        own(app.ui.style('m7-dossier', DOSSIER_CSS));
        own(app.ui.addTab(dossierTab(app, service, opener)));
        own(
            app.ui.addSlashCommand({
                name: 'maestro-dossier',
                helpKey: 'm7.slash.help',
                args: [{ name: 'value', descriptionKey: 'm7.slash.name', optional: true }],
                callback: (_args, value) => {
                    const name = String(value ?? '').trim();
                    if (!name) {
                        service.openByName('');
                        return '';
                    }
                    return service.openByName(name) ? '' : app.i18n.t('m7.slash.notFound', { name });
                },
            }),
        );
    },
};

export { DOSSIER_STRINGS } from './strings';
export { defaultDossierSettings } from './settings';
export type { DossierSettings } from './settings';
export type { Dossier, DossierApi, DossierFinding, DossierSection, SpreadEdit } from './api';
export type {
    PartOutcome,
    PromotePayload,
    StyleUpChoice,
    StyleUpHint,
    StyleUpInfo,
    StyleUpPart,
    StyleUpPayload,
    StyleUpPlan,
    StyleUpResult,
} from './style-up';
