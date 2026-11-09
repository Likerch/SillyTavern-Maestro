// M16 «Закулисье» (plan M16, §8, §11, §12, P14–P16; stage 9): the world lives while the user does not look. Every N
// committed turns (15 in «Сбалансированный», 10 and at scene ends in «Кино», never in «Экономный») a short background
// request asks what up to three important absent characters did meanwhile; the events go to the chat canon (Inbox
// for conflicts and drastic turns), and present characters may mention a rumour. Exposed as
// app.modules.api<OffscreenApi>('offscreen').
import { registerBuiltInAgent } from '../../core/builtin-agents';
import { offscreenInstructions } from '../../domain/offscreen-prompt';
import type { MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { OffscreenApi } from './api';
import { OffscreenService } from './service';
import {
    defaultOffscreenSettings,
    OFFSCREEN_ID,
    OFFSCREEN_KEY,
    OFFSCREEN_LLM_TASK,
    OFFSCREEN_TARGET,
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
    // The value is the canon entry text in English: the card's description tells the event in story words.
    targets: [{ target: OFFSCREEN_TARGET, technical: true }],
    init({ app, log, own }) {
        const settings = () => readOffscreenSettings(app.settings.module<Partial<OffscreenSettings>>(OFFSCREEN_KEY));
        const service = new OffscreenService(app, log, settings);
        service.install(own);
        app.modules.expose(OFFSCREEN_KEY, service satisfies Required<OffscreenApi>);
        own(registerProfileTask(OFFSCREEN_LLM_TASK, 'm16.profileTask'));
        own(
            registerBuiltInAgent({
                id: OFFSCREEN_LLM_TASK,
                module: 'offscreen',
                group: 'world',
                icon: 'fa-masks-theater',
                defaultInstructions: () => [offscreenInstructions()],
                defaults: { maxTokens: 900, temperature: 0.8 },
                knobs: [
                    {
                        path: 'every.balanced',
                        labelKey: 'm44.bi.offscreen.knob.every.balanced',
                        kind: 'number',
                        min: 0,
                        max: 100,
                        step: 1,
                    },
                    {
                        path: 'every.cinema',
                        labelKey: 'm44.bi.offscreen.knob.every.cinema',
                        kind: 'number',
                        min: 0,
                        max: 100,
                        step: 1,
                    },
                    { path: 'sceneEnd.cinema', labelKey: 'm44.bi.offscreen.knob.sceneEnd.cinema', kind: 'toggle' },
                    {
                        path: 'maxCharacters',
                        labelKey: 'm44.bi.offscreen.knob.maxCharacters',
                        kind: 'number',
                        min: 1,
                        max: 3,
                        step: 1,
                    },
                    {
                        path: 'minAbsentTurns',
                        labelKey: 'm44.bi.offscreen.knob.minAbsentTurns',
                        kind: 'number',
                        min: 1,
                        max: 100,
                        step: 1,
                    },
                    { path: 'rumours', labelKey: 'm44.bi.offscreen.knob.rumours', kind: 'toggle' },
                ],
                switch: 'module',
            }),
        );
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
