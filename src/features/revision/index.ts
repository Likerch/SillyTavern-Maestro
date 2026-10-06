// M8 «Ревизия „сюжет → канон“ и „Входящие“» (plan M8; dev-plan 4.2): the canon follows the story for KNOWN entities.
// After enough signals, every N messages, at the end of a scene or by hand, a background task asks the cheap model
// what changed in the committed messages and routes each change to its owner store through the autonomy levels —
// chat canon, CK archive tags (through the canon), NAI passports, the chat alias map, DES (a note), the chronicle,
// the place registry; later-stage things wait as deferred cards, new things go to the living canon (M26).
// Exposed as app.modules.api<RevisionApi>('revision').
import type { MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import { RevisionRoutes, TARGETS } from './routes';
import { RevisionService } from './service';
import {
    defaultRevisionSettings,
    readRevisionSettings,
    REVISION_ID,
    REVISION_KEY,
    REVISION_LLM_TASK,
} from './settings';
import type { RevisionSettings } from './settings';
import { RevisionSources } from './sources';
import { REVISION_STRINGS } from './strings';
import { REVISION_CSS, revisionTab } from './view';

export const revisionModule: MaestroModule<RevisionSettings> = {
    id: REVISION_ID,
    key: REVISION_KEY,
    stage: 4,
    titleKey: 'm8.title',
    enabledByDefault: true,
    defaults: defaultRevisionSettings,
    i18n: REVISION_STRINGS,
    // The canon, tags, NAI tags, place states and chronicle lines are English or markup: the card shows the model's
    // Russian sentence and the quote instead, the values wait under «Подробнее» (plan-2 §3).
    targets: [
        { target: TARGETS.canon, technical: true },
        { target: TARGETS.ck, technical: true },
        { target: TARGETS.keys, technical: true },
        { target: TARGETS.passport, technical: true },
        {
            target: TARGETS.alias,
            fields: { alias: { labelKey: 'm8.field.alias' }, entity: { labelKey: 'm8.field.entity' } },
        },
        { target: TARGETS.place, technical: true },
        { target: TARGETS.note, valueLabelKey: 'm8.field.name' },
        { target: TARGETS.event, technical: true },
    ],
    init({ app, log, own }) {
        const settings = () => readRevisionSettings(app.settings.module<Partial<RevisionSettings>>(REVISION_KEY));
        const sources = new RevisionSources(app, log);
        const routes = new RevisionRoutes(app, sources, log);
        for (const off of routes.install()) own(off);
        const service = new RevisionService(app, sources, routes, settings, log);
        for (const off of service.install()) own(off);
        app.modules.expose(REVISION_KEY, service.api());

        own(registerProfileTask(REVISION_LLM_TASK, 'm8.profileTask'));
        own(app.ui.style('m8-revision', REVISION_CSS));
        own(app.ui.addTab(revisionTab(app, service)));
        own(
            app.ui.addSlashCommand({
                name: 'maestro-revise',
                helpKey: 'm8.slash.help',
                callback: async () => {
                    try {
                        await service.request('manual');
                        return app.i18n.t('m8.slash.queued');
                    } catch (error) {
                        return error instanceof Error ? error.message : String(error);
                    }
                },
            }),
        );
    },
};

export { REVISION_STRINGS } from './strings';
export { defaultRevisionSettings, REVISION_KEY } from './settings';
export type { RevisionSettings } from './settings';
export type { DeferredCard, RevisionApi, RevisionChange, RevisionRun, RevisionStatus, RevisionTarget } from './api';
