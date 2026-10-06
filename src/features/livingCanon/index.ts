// M26 «Живой канон: новое, выдуманное ИИ» (plan M26, §8; dev-plan 4.4): names the model invents become provisional
// chat canon after the turn is committed (cheap search on every reply, batch extraction every N messages) and are
// confirmed only by the rules of plan M26 п. 4. Exposed as app.modules.api<LivingCanonApi>('livingCanon').
import { formatEnum } from '../../core/labels';
import type { MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { LivingCanonApi } from './api';
import { defaultLivingSettings, EXTRACT_TASK, FACT_TARGET, LIVING_ID, LIVING_KEY, LivingCanonService } from './service';
import type { LivingCanonSettings } from './service';
import { LIVING_STRINGS } from './strings';
import { LIVING_CSS, livingTab } from './view';

function count(value: unknown, fallback: number, max: number): number {
    return typeof value === 'number' && Number.isFinite(value) && value >= 0
        ? Math.min(max, Math.floor(value))
        : fallback;
}

/** The settings slice, repaired in place (it is the live object the pult edits). */
export function readLivingSettings(slice: Partial<LivingCanonSettings>): LivingCanonSettings {
    const defaults = defaultLivingSettings();
    slice.maxPerTurn = count(slice.maxPerTurn, defaults.maxPerTurn, 10);
    slice.surviveTurns = count(slice.surviveTurns, defaults.surviveTurns, 100);
    slice.extractEvery = count(slice.extractEvery, defaults.extractEvery, 200);
    return slice as LivingCanonSettings;
}

export const livingCanonModule: MaestroModule<LivingCanonSettings> = {
    id: LIVING_ID,
    key: LIVING_KEY,
    stage: 4,
    titleKey: 'm26.title',
    enabledByDefault: true,
    defaults: defaultLivingSettings,
    i18n: LIVING_STRINGS,
    targets: [
        {
            target: FACT_TARGET,
            fields: {
                name: { labelKey: 'm26.field.name' },
                type: { labelKey: 'm26.field.type', format: formatEnum('m26.type.') },
                russian: { labelKey: 'm26.field.russian' },
                // The quote is the card's evidence line; keys and ids are technical.
                quote: { labelKey: 'm26.field.name', hidden: true },
                keys: { labelKey: 'm26.field.name', hidden: true },
            },
        },
    ],
    init({ app, log, own }) {
        const settings = () => readLivingSettings(app.settings.module<Partial<LivingCanonSettings>>(LIVING_KEY));
        const service = new LivingCanonService(app, log.scope('living'), settings);
        for (const off of service.install()) own(off);
        own(() => service.dispose());
        app.modules.expose(LIVING_KEY, service satisfies Required<LivingCanonApi>);
        own(registerProfileTask(EXTRACT_TASK, 'm26.profileTask'));
        own(app.ui.style('m26-living', LIVING_CSS));
        own(app.ui.addTab(livingTab(app, service, settings)));
    },
};

export { LIVING_STRINGS } from './strings';
export {
    defaultLivingSettings,
    DISPUTED_KIND,
    EXTRACT_TASK,
    FACT_KIND,
    FACT_TARGET,
    LIVING_ID,
    LIVING_KEY,
    LivingCanonService,
} from './service';
export type { CandidatePayload, DisputedPayload, LivingCanonSettings } from './service';
export type { ConfirmReason, LivingCanonApi, LivingFact, LivingProposal } from './api';
