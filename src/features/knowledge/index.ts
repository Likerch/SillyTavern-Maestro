// M18 «Кто что знает», stage 9 (plan M18, M15 п. 1, M8 «Маршрутизация»): characters know what happened in scenes they
// were in (DES cast of each committed turn) without AI; secrets come from the revision; the voice cards of present
// characters say what they do not know when the topic came up. Experimental: off by default until checked live.
// Exposed as app.modules.api<KnowledgeApi>('knowledge').
import type { MaestroModule } from '../../shared/contracts';
import type { KnowledgeApi } from './api';
import { KnowledgeService } from './service';
import { KNOWLEDGE_ID, KNOWLEDGE_KEY, defaultKnowledgeSettings, readKnowledgeSettings } from './settings';
import type { KnowledgeSettings } from './settings';
import { KNOWLEDGE_STRINGS, KNOWLEDGE_TARGETS } from './strings';
import { KNOWLEDGE_CSS, knowledgeTab } from './view';

export const knowledgeModule: MaestroModule<KnowledgeSettings> = {
    id: KNOWLEDGE_ID,
    key: KNOWLEDGE_KEY,
    stage: 9,
    titleKey: 'm18.title',
    enabledByDefault: false,
    defaults: defaultKnowledgeSettings,
    i18n: KNOWLEDGE_STRINGS,
    targets: KNOWLEDGE_TARGETS,
    init({ app, log, own }) {
        const settings = () => readKnowledgeSettings(app.settings.module<Partial<KnowledgeSettings>>(KNOWLEDGE_KEY));
        const service = new KnowledgeService(app, log, settings);
        for (const off of service.install()) own(off);
        app.modules.expose(KNOWLEDGE_KEY, service.api() satisfies KnowledgeApi);
        own(app.ui.style('maestro-m18', KNOWLEDGE_CSS));
        own(app.ui.addTab(knowledgeTab(app, service)));
    },
};

export { KNOWLEDGE_STRINGS, KNOWLEDGE_TARGETS } from './strings';
export { KnowledgeService } from './service';
export { KNOWLEDGE_ID, KNOWLEDGE_KEY, defaultKnowledgeSettings, readKnowledgeSettings } from './settings';
export type { KnowledgeSettings } from './settings';
export { KNOWLEDGE_TAB } from './settings';
export type * from './api';
