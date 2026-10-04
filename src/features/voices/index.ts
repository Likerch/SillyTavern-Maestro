// M15 «Голоса персонажей», stage 8 (plan M15, M19 п. 3, §2.2, §16): a compact card for every present character near
// the end of the prompt, and CarrotKernel's quiet mode while the cards go out. Off by default: the cards replace CK's
// «Character Consistency» insert, so the user turns them on. Exposed as app.modules.api<VoicesApi>('voices').
import type { MaestroModule } from '../../shared/contracts';
import type { VoicesApi } from './api';
import { VoicesService } from './service';
import { VOICES_ID, VOICES_KEY, defaultVoicesSettings } from './settings';
import type { VoicesSettings } from './settings';
import { VOICES_STRINGS } from './strings';
import { VOICES_CSS, voicesTab } from './view';

export const voicesModule: MaestroModule<VoicesSettings> = {
    id: VOICES_ID,
    key: VOICES_KEY,
    stage: 8,
    titleKey: 'm15.title',
    enabledByDefault: false,
    defaults: defaultVoicesSettings,
    i18n: VOICES_STRINGS,
    init({ app, log, own }) {
        const service = new VoicesService(app, log);
        service.install(own);
        app.modules.expose(VOICES_KEY, service.api() satisfies VoicesApi);
        own(app.ui.style('maestro-m15', VOICES_CSS));
        own(app.ui.addTab(voicesTab(app, service)));
    },
};

export { VOICES_STRINGS } from './strings';
export { CK_FUNCTION, VOICES_INJECTION, VoicesService } from './service';
export { VOICES_ID, VOICES_KEY, defaultVoicesSettings, readVoicesSettings } from './settings';
export type { VoicesSettings } from './settings';
export { VOICES_TAB } from './view';
export type * from './api';
