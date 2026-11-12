// What agents may propose to M29 «Фоны» (plan §3.19 «Декоратор», release 1.33): a background for the place the scene is
// in now, when the library had nothing that fits. The agent writes how the place looks now (tags); NAI Studio draws it
// (free only unless the agents may spend Anlas), M29 binds it to the place and sets it through its autonomy
// `backgrounds.set` (journal, undo). Available only while M29 needs one — so the agent costs nothing on other turns —
// and once per place and chat.
import { adaptersOf } from '../../adapters';
import { registerProposalReceiver } from '../../core/proposal-receivers';
import type { App, Proposal, Unsubscribe } from '../../shared/contracts';
import type { AgentsApi } from '../agents/api';
import type { BackgroundsService } from './service';
import { BACKGROUNDS_KEY } from './settings';

export const AGENT_GENERATE_KIND = 'backgrounds.agentGenerate';

interface Payload {
    placeId: string;
    placeName: string;
    tags: string;
    freeOnly: boolean;
}

export function installBackgroundsReceiver(app: App, service: BackgroundsService): Unsubscribe {
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const freeOnly = () => app.modules.api<AgentsApi>('agents')?.imagesPaid?.() !== true;
    const apply = async (raw: unknown): Promise<void> => {
        const payload = raw as Payload;
        const choice = await service.generate(payload.placeId, {
            tags: payload.tags,
            freeOnly: payload.freeOnly,
            auto: true,
        });
        if (!choice) throw new Error(t('m44.recv.background.failed', { place: payload.placeName }));
    };
    return registerProposalReceiver({
        kind: AGENT_GENERATE_KIND,
        module: BACKGROUNDS_KEY,
        labelKey: 'm44.recv.backgrounds.agentGenerate',
        describe:
            'a background picture for the place the scene is in now (named under "Places"), because the background library has none that fits. tags: how this place looks now for an artist, in English comma-separated tags — kind of place, architecture and materials, furniture and objects, light, colours, mood, its state (ruined, decorated, crowded, flooded); never people, never the time of day or the weather (they are added). One item at most.',
        schema: { type: 'object', properties: { tags: { type: 'string' } }, required: ['tags'] },
        defaultAutonomy: 'auto',
        direct: true,
        available: () => {
            if (!service.needsBackground()) return false;
            // An older NAI Studio cannot be asked «free only» and would ask about the cost: not by an agent.
            return !freeOnly() || adaptersOf(app).nai.canBackgroundFreeOnly();
        },
        toProposal: (data, context): Proposal | null => {
            const need = service.needsBackground();
            const tags = typeof data.tags === 'string' ? data.tags.trim() : '';
            if (!need || !tags) return null;
            const payload: Payload = { ...need, tags, freeOnly: freeOnly() };
            const proposal: Proposal = {
                module: BACKGROUNDS_KEY,
                kind: AGENT_GENERATE_KIND,
                title: t('m44.recv.backgroundTitle', { place: need.placeName }),
                // M29 journals the background it sets (autonomy `backgrounds.set`, undo); the file stays in the library.
                changes: [],
                payload,
                apply,
            };
            if (context.messageIndex !== undefined) proposal.sourceMessage = context.messageIndex;
            return proposal;
        },
        apply,
    });
}
