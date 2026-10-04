// M19 «Граф отношений» (plan M19; dev-plan 3.4): relationship history from the DES tracker of every committed turn,
// stored per chat; the prompt part (voice cards) comes at stage 8. Exposed as app.modules.api<RelationsApi>('relations').
import type { MaestroModule } from '../../shared/contracts';
import { RELATIONS_ID, RELATIONS_KEY, RelationsService } from './service';
import { RELATIONS_STRINGS } from './strings';
import { RELATIONS_CSS, relationsTab } from './view';

export type RelationsSettings = Record<string, never>;

export const relationsModule: MaestroModule<RelationsSettings> = {
    id: RELATIONS_ID,
    key: RELATIONS_KEY,
    stage: 3,
    titleKey: 'm19.title',
    enabledByDefault: true,
    defaults: () => ({}),
    i18n: RELATIONS_STRINGS,
    init({ app, log, own }) {
        const service = new RelationsService(app, log);
        for (const off of service.install()) own(off);
        app.modules.expose(RELATIONS_KEY, service.api());
        own(app.ui.style('m19-view', RELATIONS_CSS));
        own(app.ui.addTab(relationsTab(app, service)));
        service.start();
    },
};

export { RELATIONS_STRINGS } from './strings';
export { RelationsService, emptyRelationsDoc, RELATIONS_DOC, RELATIONS_ID, RELATIONS_KEY } from './service';
export type { RelationsDoc } from './service';
export type { Relation, RelationPoint, RelationsApi } from './api';
