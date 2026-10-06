// M36 «Промпты соседей» (plan-2 §2 п. 5, «Области действия» п. 3; release 1.13): the registry of the instruction texts
// other extensions put into the prompt (api.ts), with global edits through the neighbours' own save paths and
// Maestro's copies for a card or a chat applied at generation time (service.ts). The «Промпты соседей» tab of the
// Preset Studio shows it; the assistant and the prompt audit of the second wave use the same API.
import type { I18n, MaestroModule, TargetSpec } from '../../shared/contracts';
import { NEIGHBOUR_PROMPTS_KEY } from './api';
import { COPY_TARGET, GLOBAL_TARGET, NeighbourPromptsService } from './service';
import { NEIGHBOUR_STRINGS } from './strings';

export { NEIGHBOUR_PROMPTS_KEY } from './api';
export type { NeighbourPrompt, NeighbourPromptsApi, NeighbourScope } from './api';
export { NeighbourPromptsService } from './service';

/** A neighbour's text in a journal card: the text itself, '' = the neighbour's built-in text, null = no copy. */
function textValue(value: unknown, i18n: I18n): string {
    if (value === null || value === undefined) return i18n.t('m36.target.none');
    if (typeof value !== 'string') return '';
    return value === '' ? i18n.t('m36.target.builtin') : value;
}

export const NEIGHBOUR_TARGETS: TargetSpec[] = [
    { target: GLOBAL_TARGET, valueLabelKey: 'm36.target.text', format: textValue },
    { target: COPY_TARGET, valueLabelKey: 'm36.target.text', nullable: true, format: textValue },
];

export const neighbourPromptsModule: MaestroModule<Record<string, never>> = {
    id: 'M36',
    key: NEIGHBOUR_PROMPTS_KEY,
    stage: 5,
    titleKey: 'm36.title',
    enabledByDefault: true,
    defaults: () => ({}),
    i18n: NEIGHBOUR_STRINGS,
    targets: NEIGHBOUR_TARGETS,
    init({ app, log, own }) {
        const service = new NeighbourPromptsService(app, log);
        service.install(own);
        app.modules.expose(NEIGHBOUR_PROMPTS_KEY, service);
        own(() => app.modules.expose(NEIGHBOUR_PROMPTS_KEY, undefined));
    },
};
