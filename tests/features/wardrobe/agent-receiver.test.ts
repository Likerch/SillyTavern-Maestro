// «Костюмер» (release 1.32): the wardrobe receiver turns an agent's item into wearNow (a known outfit or words) and
// skips what is already worn; the agents' text lists who wears what with known outfits.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { proposalReceiver, resetProposalReceivers } from '../../../src/core/proposal-receivers';
import { installWardrobeReceiver, wardrobeText } from '../../../src/features/wardrobe/agent-receiver';
import type { WardrobeService } from '../../../src/features/wardrobe/service';
import type { App } from '../../../src/shared/contracts';
import { createTestI18n } from '../../helpers/core-host';

afterEach(() => resetProposalReceivers());

function service() {
    const wearNow = vi.fn(async () => null);
    const fake = {
        current: () => [
            {
                key: 'persona',
                name: 'Кай',
                persona: true,
                wording: 'кожаная куртка',
                outfit: 'Дорожный',
                tags: '',
                undress: '',
                passportId: '',
            },
            {
                key: 'Мира',
                name: 'Мира',
                persona: false,
                wording: 'зелёное платье',
                outfit: null,
                tags: '',
                undress: '',
                passportId: '',
            },
        ],
        outfitNames: () => ({ persona: ['Дорожный', 'Парадный'], Мира: ['Бальное'] }),
        wearNow,
    };
    return { fake: fake as unknown as WardrobeService, wearNow };
}

describe('wardrobe receiver', () => {
    it('writes a change through wearNow, persona by key; skips what is already worn', async () => {
        const { fake, wearNow } = service();
        installWardrobeReceiver({ i18n: createTestI18n('ru') } as unknown as App, fake);
        const receiver = proposalReceiver('wardrobe.agentWear')!;
        expect(receiver.direct).toBe(true);
        const outfit = await receiver.toProposal(
            { who: 'кай', outfit: 'Парадный' },
            { agentName: 'A', messageIndex: 3 },
        );
        expect(outfit?.changes).toEqual([]);
        await outfit!.apply(outfit!.payload);
        expect(wearNow).toHaveBeenCalledWith('persona', { outfit: 'Парадный' }, 'model', 3, {
            sourceMessage: 3,
            stripIndex: 3,
        });
        const words = await receiver.toProposal({ who: 'Мира', wording: 'ночная сорочка' }, { agentName: 'A' });
        await words!.apply(words!.payload);
        expect(wearNow).toHaveBeenLastCalledWith('Мира', { wording: 'ночная сорочка' }, 'model', undefined, {});
        expect(await receiver.toProposal({ who: 'Кай', outfit: 'Дорожный' }, { agentName: 'A' })).toBeNull();
        expect(await receiver.toProposal({ who: 'Мира', wording: 'Зелёное платье' }, { agentName: 'A' })).toBeNull();
        expect(await receiver.toProposal({ who: 'Мира' }, { agentName: 'A' })).toBeNull();
    });

    it('lists who wears what with known outfits', () => {
        expect(wardrobeText(service().fake)).toBe(
            "- Кай (the player's character): кожаная куртка [outfit: Дорожный]; known outfits: Дорожный, Парадный\n- Мира: зелёное платье; known outfits: Бальное",
        );
    });
});
