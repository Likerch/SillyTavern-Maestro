// M1 «Журнал лора» (plan M1, dev-plan 1.1): which lore really goes into the prompt and why.
import type { ActivationRow, LoreRecordRow } from '../../domain/lore-scan';
import type { MaestroModule } from '../../shared/contracts';
import type { LoreActivation, LoreJournalApi, TurnLoreRecord } from './api';
import { LoreJournal } from './journal';
import type { LoreJournalSettings } from './journal';
import { M1_STRINGS } from './strings';
import { M1_CSS, turnTab } from './view';

export { LoreJournal, LORE_DOC_KIND, estimateTokens } from './journal';
export type { LoreJournalSettings } from './journal';
export { M1_STRINGS } from './strings';
export { TURN_TAB } from './view';

// The domain rows and the public API types must stay interchangeable.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
const _activation: Same<ActivationRow, LoreActivation> = true;
const _record: Same<LoreRecordRow, TurnLoreRecord> = true;
void _activation;
void _record;

export const loreJournalModule: MaestroModule<LoreJournalSettings> = {
    id: 'M1',
    key: 'loreJournal',
    stage: 1,
    titleKey: 'm1.title',
    enabledByDefault: true,
    defaults: () => ({ keepTurns: 200 }),
    requires: ['st.events.scanDone', 'st.events.entriesLoaded'],
    i18n: M1_STRINGS,
    init({ app, settings, log, own }) {
        const journal = new LoreJournal(app, settings, log);
        journal.install(own);
        app.modules.expose('loreJournal', journal satisfies LoreJournalApi);
        own(app.ui.style('maestro-m1', M1_CSS));
        own(app.ui.addTab(turnTab(app, journal, settings)));
    },
};
