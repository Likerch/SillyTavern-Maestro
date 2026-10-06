// M7 «Модель мира» (plan §4.2, M7; dev-plan 3.1): entities of the chat's world glued from every store of the stack by
// identity resolution, with merge candidates in the Inbox, the chat alias map and stage-3 structured facts. Exposed
// as app.modules.api<WorldModelApi>('world'); the dossier (M7), places (M24) and relations (M19) read it.
import type { I18n, MaestroModule, TargetSpec } from '../../shared/contracts';
import { EXCLUDE_TARGET, IDENTITY_TARGET } from './identity';
import { ALIAS_TARGET, MERGE_TARGET, SEPARATE_TARGET, WORLD_ID, WORLD_KEY, WorldModel } from './model';
import { registerWorldMigrations, WorldStore } from './store';
import { WORLD_STRINGS } from './strings';
import { WORLD_CSS, worldTab } from './view';

export type WorldSettings = Record<string, never>;

/** The running model: journal rows name characters and places instead of showing their ids. */
let active: WorldModel | null = null;

/** An entity id ('character:офелия') as its name; the bare name when the model does not know it now. */
function entityName(value: unknown): string {
    if (typeof value !== 'string' || !value) return '';
    return active?.get(value)?.name || value.slice(value.indexOf(':') + 1);
}

/**
 * World changes read by names: what a nickname means, which name another one was merged into, whether the card's look
 * is used here. A «these are different» mark and the namesake answer say everything in their summary (their values are
 * entity ids and store keys).
 */
export const WORLD_TARGETS: TargetSpec[] = [
    { target: ALIAS_TARGET, valueLabelKey: 'm7w.field.alias', format: entityName },
    { target: MERGE_TARGET, valueLabelKey: 'm7w.field.merged', format: entityName },
    { target: SEPARATE_TARGET, technical: true },
    { target: IDENTITY_TARGET, technical: true },
    {
        target: EXCLUDE_TARGET,
        valueLabelKey: 'm7w.field.cardLook',
        format: (value: unknown, i18n: I18n) =>
            typeof value === 'boolean' ? i18n.t(value ? 'm7w.value.notUsed' : 'm7w.value.used') : '',
    },
];

export const worldModule: MaestroModule<WorldSettings> = {
    id: WORLD_ID,
    key: WORLD_KEY,
    stage: 3,
    titleKey: 'm7w.title',
    enabledByDefault: true,
    defaults: () => ({}),
    i18n: WORLD_STRINGS,
    targets: WORLD_TARGETS,
    init({ app, log, own }) {
        registerWorldMigrations(app.chat);
        const store = new WorldStore(app, log);
        const model = new WorldModel(app, store, log);
        for (const off of model.install()) own(off);
        active = model;
        own(() => {
            if (active === model) active = null;
        });
        app.modules.expose(WORLD_KEY, model.api());
        own(app.ui.style('m7w-view', WORLD_CSS));
        own(app.ui.addTab(worldTab(app, model)));
        model.start();
    },
};

export { WORLD_STRINGS } from './strings';
export {
    ALIAS_KIND,
    ALIAS_TARGET,
    WorldModel,
    committedIndex,
    MERGE_KIND,
    MERGE_TARGET,
    SEPARATE_KIND,
    SEPARATE_TARGET,
    WORLD_ID,
    WORLD_KEY,
} from './model';
export { WorldStore, emptyWorldDoc, WORLD_SCHEMA } from './store';
export { APART_KIND, EXCLUDE_TARGET, IDENTITY_TARGET, SAME_AS_KIND } from './identity';
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
