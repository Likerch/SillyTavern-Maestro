// M16 «Закулисье» (plan M16, §8, §11, §12, P14–P16; stage 9): the world lives while the user does not look. Every N
// committed turns (15 in «Сбалансированный», 10 and at scene ends in «Кино», never in «Экономный») a short background
// request asks what up to three important absent characters did meanwhile; the events go to the chat canon (Inbox
// for conflicts and drastic turns), and present characters may mention a rumour. Exposed as
// app.modules.api<OffscreenApi>('offscreen').
import type { MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { OffscreenApi } from './api';
import { OffscreenService } from './service';
import {
    defaultOffscreenSettings,
    OFFSCREEN_ID,
    OFFSCREEN_KEY,
    OFFSCREEN_LLM_TASK,
    readOffscreenSettings,
} from './settings';
import type { OffscreenSettings } from './settings';
import { OFFSCREEN_STRINGS } from './strings';
import { OFFSCREEN_CSS, offscreenTab } from './view';

export const offscreenModule: MaestroModule<OffscreenSettings> = {
    id: OFFSCREEN_ID,
    key: OFFSCREEN_KEY,
    stage: 9,
    titleKey: 'm16.title',
    enabledByDefault: true,
    defaults: defaultOffscreenSettings,
    i18n: OFFSCREEN_STRINGS,
    init({ app, log, own }) {
        const settings = () => readOffscreenSettings(app.settings.module<Partial<OffscreenSettings>>(OFFSCREEN_KEY));
        const service = new OffscreenService(app, log, settings);
        service.install(own);
        app.modules.expose(OFFSCREEN_KEY, service satisfies Required<OffscreenApi>);
        own(registerProfileTask(OFFSCREEN_LLM_TASK, 'm16.profileTask'));
        own(app.ui.style('maestro-m16', OFFSCREEN_CSS));
        own(app.ui.addTab(offscreenTab(app, service, settings)));
    },
};

export type { OffscreenApi, OffscreenCandidate, OffscreenEvent } from './api';
export { DEFAULT_TIMINGS, isOffscreenPayload, OffscreenService, RUMOUR_PREFIX } from './service';
export type { OffscreenPayload, OffscreenStatus, OffscreenTimings } from './service';
export {
    defaultOffscreenSettings,
    OFFSCREEN_ID,
    OFFSCREEN_KEY,
    OFFSCREEN_KIND,
    OFFSCREEN_ORIGIN,
    OFFSCREEN_TASK,
    readOffscreenSettings,
} from './settings';
export type { OffscreenSettings } from './settings';
export { OFFSCREEN_STRINGS } from './strings';
export { OFFSCREEN_CSS, offscreenTab } from './view';
