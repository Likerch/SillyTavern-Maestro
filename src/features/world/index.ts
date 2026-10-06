// M7 «Модель мира» (plan §4.2, M7; dev-plan 3.1): entities of the chat's world glued from every store of the stack by
// identity resolution, with merge candidates in the Inbox, the chat alias map and stage-3 structured facts. Exposed
// as app.modules.api<WorldModelApi>('world'); the dossier (M7), places (M24) and relations (M19) read it.
import type { MaestroModule } from '../../shared/contracts';
import { WORLD_ID, WORLD_KEY, WorldModel } from './model';
import { registerWorldMigrations, WorldStore } from './store';
import { WORLD_STRINGS } from './strings';
import { WORLD_CSS, worldTab } from './view';

export type WorldSettings = Record<string, never>;

export const worldModule: MaestroModule<WorldSettings> = {
    id: WORLD_ID,
    key: WORLD_KEY,
    stage: 3,
    titleKey: 'm7w.title',
    enabledByDefault: true,
    defaults: () => ({}),
    i18n: WORLD_STRINGS,
    init({ app, log, own }) {
        registerWorldMigrations(app.chat);
        const store = new WorldStore(app, log);
        const model = new WorldModel(app, store, log);
        for (const off of model.install()) own(off);
        app.modules.expose(WORLD_KEY, model.api());
        own(app.ui.style('m7w-view', WORLD_CSS));
        own(app.ui.addTab(worldTab(app, model)));
        model.start();
    },
};

export { WORLD_STRINGS } from './strings';
export { WorldModel, committedIndex, MERGE_KIND, WORLD_ID, WORLD_KEY } from './model';
export { WorldStore, emptyWorldDoc, WORLD_SCHEMA } from './store';
export { SAME_AS_KIND } from './identity';
export type { WorldDoc } from './store';
export type {
    Entity,
    EntityIdentity,
    EntityKind,
    EntitySource,
    Fact,
    MergeCandidate,
    SourceScope,
    WorldModelApi,
} from './api';
