// What agents may write into the wardrobe (plan §3.16 «Костюмер», release 1.32): who changed clothes in a reply — a
// known outfit by name, or the clothes in words. A tracker: applied at once through wearNow (the same path as the
// change-of-clothes model: passport outfit, DES's clothing field, the strip line, one journal record with undo), so
// the agents' runtime journals nothing of its own. Also the text agents read: who wears what, with known outfits.
import { registerProposalReceiver } from '../../core/proposal-receivers';
import type { App, Proposal, Unsubscribe } from '../../shared/contracts';
import type { WardrobeService } from './service';
import { PERSONA_KEY } from './settings';

export const WARDROBE_WEAR_KIND = 'wardrobe.agentWear';

function fold(text: string): string {
    return text.trim().toLowerCase().replace(/ё/g, 'е');
}

/** «Who wears what» with each person's known outfits, for agents (plan §3.4 «Гардероб»). */
export function wardrobeText(service: WardrobeService): string {
    const outfits = service.outfitNames();
    return service
        .current()
        .map((item) => {
            const known = outfits[item.persona ? PERSONA_KEY : item.name] ?? [];
            const who = item.persona ? `${item.name} (the player's character)` : item.name;
            const wearing = item.wording || 'unknown';
            const outfit = item.outfit ? ` [outfit: ${item.outfit}]` : '';
            return `- ${who}: ${wearing}${outfit}${known.length ? `; known outfits: ${known.join(', ')}` : ''}`;
        })
        .join('\n');
}

export function installWardrobeReceiver(app: App, service: WardrobeService): Unsubscribe[] {
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const apply = async (raw: unknown): Promise<void> => {
        const payload = raw as { who: string; outfit?: string; wording?: string; messageIndex?: number };
        const what = payload.outfit ? { outfit: payload.outfit } : { wording: payload.wording ?? '' };
        const index = payload.messageIndex;
        await service.wearNow(
            payload.who,
            what,
            'model',
            index,
            index !== undefined ? { sourceMessage: index, stripIndex: index } : {},
        );
    };
    return [
        registerProposalReceiver({
            kind: WARDROBE_WEAR_KIND,
            module: 'wardrobe',
            labelKey: 'm44.recv.wardrobe.agentWear',
            describe:
                "what someone wears NOW when the reply changed it (dressed, undressed, changed, took something off). who: the person's name exactly as in the wardrobe list (the player's character by their name); outfit: the name of one of their known outfits when the clothes are that outfit; otherwise wording: the clothes as the story says them, in the story's language (garments, footwear, accessories; or naked, in a towel, in underwear). Only people whose clothes the reply changed.",
            schema: {
                type: 'object',
                properties: { who: { type: 'string' }, outfit: { type: 'string' }, wording: { type: 'string' } },
                required: ['who'],
            },
            defaultAutonomy: 'auto',
            direct: true,
            toProposal: (data, context): Proposal | null => {
                const name = typeof data.who === 'string' ? data.who.trim() : '';
                const outfit = typeof data.outfit === 'string' ? data.outfit.trim() : '';
                const wording = typeof data.wording === 'string' ? data.wording.trim() : '';
                if (!name || (!outfit && !wording)) return null;
                const person = service.current().find((item) => fold(item.name) === fold(name));
                const who = person?.persona ? PERSONA_KEY : (person?.name ?? name);
                if (
                    person &&
                    ((outfit && person.outfit === outfit) || (!outfit && fold(person.wording) === fold(wording)))
                )
                    return null;
                const payload: { who: string; outfit?: string; wording?: string; messageIndex?: number } = { who };
                if (outfit) payload.outfit = outfit;
                else payload.wording = wording;
                if (context.messageIndex !== undefined) payload.messageIndex = context.messageIndex;
                const proposal: Proposal = {
                    module: 'wardrobe',
                    kind: WARDROBE_WEAR_KIND,
                    title: t('m44.recv.wearTitle', { name: person?.name ?? name, what: outfit || wording }),
                    // wearNow journals the change itself (with undo): nothing more to record here.
                    changes: [],
                    payload,
                    apply,
                };
                if (context.messageIndex !== undefined) proposal.sourceMessage = context.messageIndex;
                return proposal;
            },
            apply,
        }),
    ];
}
