// M26c «Проверка противоречий», stage 4 (M26 п.5; dev-plan 4.3): a shared service — rules first (names, numbers,
// dates, explicit negations, English and Russian), the cheap background model only on suspicion. Used by the living
// canon (M26), the revision (M8) and later the quality check (M12). No UI of its own: the profile for its background
// task is chosen in Settings. Exposed as app.modules.api<ContradictionsApi>('contradictions').
import type { MaestroModule } from '../../shared/contracts';
import { registerProfileTask } from '../../ui';
import type { ContradictionsApi } from './api';
import { CHECK_TASK, CONTRADICTIONS_ID, CONTRADICTIONS_KEY, ContradictionsService } from './service';
import { CONTRADICTIONS_STRINGS } from './strings';

export const contradictionsModule: MaestroModule = {
    id: CONTRADICTIONS_ID,
    key: CONTRADICTIONS_KEY,
    stage: 4,
    titleKey: 'm26c.title',
    enabledByDefault: true,
    defaults: () => ({}),
    i18n: CONTRADICTIONS_STRINGS,
    init({ app, log, own }) {
        const service = new ContradictionsService(app, log.scope('contradictions'));
        for (const off of service.install()) own(off);
        const api: ContradictionsApi = {
            quick: (input) => service.quick(input),
            check: (input, options) => service.check(input, options),
        };
        app.modules.expose(CONTRADICTIONS_KEY, api);
        own(registerProfileTask(CHECK_TASK, 'm26c.profileTask'));
    },
};

export { CONTRADICTIONS_STRINGS } from './strings';
export { CHECK_TASK, ContradictionsService, sanitizeInput } from './service';
export type { CheckOptions, Contradiction, ContradictionInput, ContradictionResult, ContradictionsApi } from './api';
