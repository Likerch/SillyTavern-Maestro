// M20 «Архитектор промпта», stage 7 (plan M20 п. 1, 3, 4, 6, 7; P15, P16, §4.11): budgets per source (total lore
// across books after M22's caps, CK RAG, Qvink short-term memory, DES's optional context block; voices, mechanics
// and the director keep their value for later stages), presence and place (damping absent/far, pinning present and
// the current place), repeated facts across sources (report, then one source by consent), the provider cache and
// the order of Maestro's changing injections, and the before/after of every rule per turn. Book caps and recursion
// limits stay M22's rule 'book.cap' (п. 2); scan-only glosses stay M6's (п. 5).
// The lore part runs as M22 rules (RulesApi.register); the rest listens to CHAT_COMPLETION_PROMPT_READY (last),
// WORLD_INFO_ACTIVATED and the fetch gate. Exposed as app.modules.api<ArchitectApi>('architect').
import type { MaestroModule } from '../../shared/contracts';
import type { InspectorApi } from '../inspector/api';
import type { ArchitectApi } from './api';
import { ArchitectService } from './service';
import { ARCHITECT_ID, ARCHITECT_KEY, defaultArchitectSettings } from './settings';
import type { ArchitectSettings } from './settings';
import { ARCHITECT_STRINGS } from './strings';
import { ARCHITECT_CSS, architectTab, inspectorSection } from './view';

export const architectModule: MaestroModule<ArchitectSettings> = {
    id: ARCHITECT_ID,
    key: ARCHITECT_KEY,
    stage: 7,
    titleKey: 'm20.title',
    enabledByDefault: true,
    defaults: defaultArchitectSettings,
    i18n: ARCHITECT_STRINGS,
    init({ app, log, own }) {
        const service = new ArchitectService(app, log);
        service.install(own);
        app.modules.expose(ARCHITECT_KEY, service.api() satisfies ArchitectApi);
        own(app.ui.style('maestro-m20', ARCHITECT_CSS));
        own(app.ui.addTab(architectTab(app, service)));
        const inspector = app.modules.api<InspectorApi>('inspector');
        if (typeof inspector?.addSection === 'function') {
            own(
                inspector.addSection({
                    id: ARCHITECT_KEY,
                    order: 30,
                    render: (record) => inspectorSection(app, service, record),
                }),
            );
        }
    },
};

export { ARCHITECT_STRINGS } from './strings';
export { ArchitectService, CONSENT_KIND, CONSENT_TARGET } from './service';
export { ARCHITECT_ID, ARCHITECT_KEY, defaultArchitectSettings, readArchitectSettings } from './settings';
export type { ArchitectSettings } from './settings';
export { ARCHITECT_RULE_IDS, DAMP_RULE_ID, DEDUP_RULE_ID, LORE_BUDGET_RULE_ID, PIN_RULE_ID } from './lore';
export { ARCHITECT_TAB } from './view';
export type * from './api';
