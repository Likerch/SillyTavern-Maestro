// M7 «Досье» (plan M7 п. 1–5, dev-plan 3.2): one page per entity with everything the stack knows — lore with the
// chat canon on top, CK archive and BunnyMo tags, NAI passports, DES, Russian forms, Qvink memories, CK RAG, the last
// BunnyMo sheet, the place registry and the persona — with structural checks by rules, an AI comparison of appearance
// and descriptions on demand, and «Разнести». Reads the world model (WorldModelApi) when it is on; works for the card
// character, the persona, DES's roster and places without it. Exposed as app.modules.api<DossierApi>('dossier').
import { adaptersOf } from '../../adapters';
import type { MaestroModule } from '../../shared/contracts';
import { DossierActions } from './actions';
import type { DossierApi } from './api';
import { DossierCompare } from './compare';
import { DossierOpener } from './opener';
import { DossierService } from './service';
import { DOSSIER_ID, DOSSIER_KEY, defaultDossierSettings, readDossierSettings } from './settings';
import type { DossierSettings } from './settings';
import { DossierSources } from './sources';
import { DOSSIER_STRINGS } from './strings';
import { DOSSIER_CSS, dossierTab } from './view';

export const dossierModule: MaestroModule<DossierSettings> = {
    id: DOSSIER_ID,
    key: DOSSIER_KEY,
    stage: 3,
    titleKey: 'm7.title',
    enabledByDefault: true,
    defaults: defaultDossierSettings,
    i18n: DOSSIER_STRINGS,
    init({ app, log, own }) {
        const settings = () => readDossierSettings(app.settings.module<Partial<DossierSettings>>(DOSSIER_KEY));
        const sources = new DossierSources(app, settings, log);
        const actions = new DossierActions(app, sources, log);
        for (const off of actions.install()) own(off);
        const compare = new DossierCompare(app, sources, settings, log);
        for (const off of compare.install()) own(off);
        const service = new DossierService(app, sources, actions, compare);
        own(compare.onResult((entityId) => service.emit(entityId)));
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
