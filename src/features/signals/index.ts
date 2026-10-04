// S4 «Сигналы», stage 4 (plan §4.4, §5 phase 1 and «Отмена», P14, P15, M8 «Сигналы»; dev-plan 4.1): when the user
// sends a message the reply before it is final, and its DES tracker, Qvink memory, DES aliases and new names are
// compared with the turn before — without AI, in an idle slot after the send — into signals on app.bus ('signal')
// and batches for the revision (M8), the living canon (M26) and the chronicle (M9). Noise suppression: free text from
// DES counts after two turns in a row; same-kind signals of one entity fold. Stored per chat with exact rollback on
// swipe, edit and delete. Exposed as app.modules.api<SignalsApi>('signals').
import type { MaestroModule } from '../../shared/contracts';
import type { SignalsApi } from './api';
import { SIGNALS_ID, SIGNALS_KEY, SignalsService, defaultSignalsSettings, readSignalsSettings } from './service';
import type { SignalsSettings } from './service';
import { SIGNALS_STRINGS } from './strings';
import { SIGNALS_CSS, signalsTab } from './view';

export const signalsModule: MaestroModule<SignalsSettings> = {
    id: SIGNALS_ID,
    key: SIGNALS_KEY,
    stage: 4,
    titleKey: 's4.title',
    enabledByDefault: true,
    defaults: defaultSignalsSettings,
    i18n: SIGNALS_STRINGS,
    init({ app, log, own }) {
        const settings = () => readSignalsSettings(app.settings.module<Partial<SignalsSettings>>(SIGNALS_KEY));
        const service = new SignalsService(app, log.scope('signals'), settings);
        for (const off of service.install()) own(off);
        own(() => service.dispose());
        app.modules.expose(SIGNALS_KEY, service satisfies SignalsApi);
        own(app.ui.style('s4-signals', SIGNALS_CSS));
        own(app.ui.addTab(signalsTab(app, service)));
    },
};

export { SIGNALS_STRINGS } from './strings';
export { SIGNALS_DOC, SignalsService, defaultSignalsSettings, readSignalsSettings } from './service';
export type { SignalsSettings } from './service';
export { describeSignal } from './view';
export type { SignalBatch, SignalKind, SignalsApi } from './api';
