// «Переодеть сейчас» (M27 wearNow): the clothes change everywhere at once — the record of «что надето сейчас» (newer
// than a tracker that still says the old clothes), the chat-level passport (outfit on, the words as its look, a new
// outfit for new clothes), the DES portrait, DES's tracker (the clothing field or the appearance with clothes; the
// prompt slot rebuilt during a generation; never while the Workshop is open), the prompt line — and one journal record
// takes it all back.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { desSwipeRecord, parseDesCharacters } from '../../../src/domain/des-tracker';
import {
    DES_TRACKER_TARGET,
    WARDROBE_CURRENT_TARGET,
    WARDROBE_INJECTION,
    WARDROBE_UNDO_TARGET,
    WARDROBE_WEAR_NOW_KIND,
} from '../../../src/features/wardrobe';
import type { DesKitLike } from '../../../src/features/wardrobe';
import { createWardrobeEnv } from './helpers';
import type { WardrobeEnv } from './helpers';

let env: WardrobeEnv;

const anna = () => env.nai.getPassport('p-anna')!;
const lastJournal = () => env.journal.records.at(-1)!;
const annaDetails = (index: number) =>
    parseDesCharacters(desSwipeRecord(env.mock.chat[index])?.characterThoughts).find((item) => item.name === 'Anna')
        ?.details;

function fakeKit(example = '{"characters":[]}') {
    const kit = {
        replaceCharacters: vi.fn(() => ({ last: true, committed: true })),
        render: vi.fn(),
        save: vi.fn(async () => {}),
        trackerExample: vi.fn(() => example),
    };
    return kit;
}

beforeEach(() => {
    vi.useFakeTimers();
    env = createWardrobeEnv('ru');
});

afterEach(() => {
    vi.useRealTimers();
});

describe('«Переодеть сейчас» for a character', () => {
    it('puts the outfit on everywhere and one undo takes it all back', async () => {
        const service = await env.start();
        const index = await env.turn({
            characters: [{ name: 'Anna', details: { appearance: 'эльфийка, в синих джинсах и серой толстовке' } }],
        });
        expect(service.current('Anna')[0]?.wording).toBe('в синих джинсах и серой толстовке');
        const before = desSwipeRecord(env.mock.chat[index])?.characterThoughts;
        const records = env.journal.records.length;

        const done = await service.wearNow('Anna', { outfit: 'ballgown' });
        expect(done).toMatchObject({ who: 'Anna', outfit: 'ballgown', wording: 'ballgown', des: true });
        expect(anna().activeOutfit).toBe('ballgown');
        // The outfit's own name is no new wording of it.
        expect(anna().outfits.find((item) => item.name === 'ballgown')?.looks).toBeUndefined();
        expect(service.current('Anna')[0]).toMatchObject({ wording: 'ballgown', outfit: 'ballgown', source: 'user' });
        expect((await service.loadDoc()).current['p-anna']).toMatchObject({
            changedAt: env.mock.chat.length - 1,
            was: 'в синих джинсах и серой толстовке',
        });
        expect(env.portraits).toEqual(['Anna']);
        // DES's tracker had no clothing field: the clothes in the appearance were replaced, the rest stays.
        expect(annaDetails(index)?.appearance).toBe('эльфийка, ballgown');
        expect(env.journal.records).toHaveLength(records + 1);
        expect(lastJournal()).toMatchObject({
            module: 'M27',
            kind: WARDROBE_WEAR_NOW_KIND,
            summary: 'Anna → ballgown',
        });
        expect(lastJournal().sourceMessage).toBeUndefined();
        expect(lastJournal().changes.map((change) => change.target)).toEqual([
            WARDROBE_CURRENT_TARGET,
            WARDROBE_UNDO_TARGET,
            DES_TRACKER_TARGET,
        ]);

        expect(await env.journal.undo(lastJournal().id)).toBe(true);
        expect(anna().activeOutfit).toBe('');
        expect(service.current('Anna')[0]?.wording).toBe('в синих джинсах и серой толстовке');
        expect(desSwipeRecord(env.mock.chat[index])?.characterThoughts).toBe(before);
    });

    it('makes a new outfit for new clothes and keeps the words as its look', async () => {
        env.slices.wardrobe = { desWrite: false };
        const service = await env.start();
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'в синих джинсах' } }] });
        const done = await service.wearNow('Anna', { wording: 'красное вечернее платье' }, 'user');
        const active = anna().activeOutfit;
        expect(active).toBeTruthy();
        expect(active).not.toBe('ballgown');
        expect(done?.outfit).toBe(active);
        expect(anna().outfits.find((item) => item.name === active)?.looks).toEqual(['красное вечернее платье']);
        expect(lastJournal().changes.map((change) => change.target)).toEqual([
            WARDROBE_CURRENT_TARGET,
            WARDROBE_UNDO_TARGET,
        ]);
        await env.journal.undo(lastJournal().id);
        expect(anna().outfits.some((item) => item.name === active)).toBe(false);
    });

    it('is newer than the tracker: the prompt line says it, a stale tracker does not undo it', async () => {
        env.slices.wardrobe = { desWrite: false };
        const service = await env.start();
        const first = await env.turn({
            characters: [{ name: 'Anna', details: { appearance: 'в синих джинсах и серой толстовке' } }],
        });
        const player = first + 1;
        await service.wearNow('Anna', { wording: 'шёлковый халат' }, 'player', player);
        const line = (await env.ephemeral.generate()).get(WARDROBE_INJECTION)?.text ?? '';
        expect(line).toContain('Anna: шёлковый халат');
        expect(line).not.toContain('джинсах');
        // The next reply's tracker still repeats the jeans: stale, the change stays.
        await env.turn({
            characters: [{ name: 'Anna', details: { appearance: 'в синих джинсах и серой толстовке' } }],
        });
        expect(service.current('Anna')[0]?.wording).toBe('шёлковый халат');
        // Other clothes later are news again.
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'в чёрном пальто' } }] });
        expect(service.current('Anna')[0]?.wording).toBe('в чёрном пальто');
    });

    it('takes the persona into its passport, with no DES tracker and no portrait', async () => {
        const service = await env.start();
        await env.turn({ characters: [{ name: 'Anna', details: { appearance: 'в синих джинсах' } }] });
        const done = await service.wearNow('persona', { wording: 'Серый дорожный плащ и сапоги' });
        expect(done?.who).toBe('Алекс');
        expect(env.nai.getPassport('p-alex')!.activeOutfit).toBe('Дорожный плащ');
        expect(service.current().find((item) => item.persona)).toMatchObject({
            wording: 'Серый дорожный плащ и сапоги',
        });
        expect(lastJournal().changes.map((change) => change.target)).not.toContain(DES_TRACKER_TARGET);
        expect(env.portraits).toEqual([]);
        // The persona's name works the same.
        await service.wearNow('Алекс', { undress: 'towel' });
        expect(env.nai.getPassport('p-alex')!.activeOutfit).toBe('В полотенце');
    });

    it('throws by hand for a missing outfit or no chat, and gives null from a message', async () => {
        const service = await env.start();
        await expect(service.wearNow('Anna', { outfit: 'кимоно' })).rejects.toThrow('Наряда «кимоно» нет.');
        expect(await service.wearNow('Anna', { outfit: 'кимоно' }, 'player', 1)).toBeNull();
        expect(await service.wearNow('Anna', {}, 'user')).toBeNull();
    });
});

describe('DES’s tracker', () => {
    it('writes the clothing field through DES’s kit and rebuilds the prompt slot during a generation', async () => {
        env.des.fields.push({ id: 'outfit', name: 'Outfit', enabled: true, description: 'clothes' });
        const service = await env.start();
        const kit = fakeKit('{"characters":"new"}');
        service.desWriter.setKitLoader(async () => kit as unknown as DesKitLike);
        const index = await env.turn({
            characters: [{ name: 'Anna', details: { appearance: 'эльфийка', outfit: 'синие джинсы' } }],
        });
        (env.mock.context as unknown as { extensionPrompts: Record<string, unknown> }).extensionPrompts = {
            'dooms-tracker-example': { value: '```json\nold\n```\n', position: 1, depth: 2, scan: false, role: 2 },
        };
        const before = desSwipeRecord(env.mock.chat[index])?.characterThoughts as string;
        await service.wearNow('Anna', { wording: 'шёлковое платье' }, 'player', index + 1, { generating: true });
        expect(annaDetails(index)).toEqual({ appearance: 'эльфийка', outfit: 'шёлковое платье' });
        const after = desSwipeRecord(env.mock.chat[index])?.characterThoughts as string;
        expect(kit.replaceCharacters).toHaveBeenCalledWith(before, after);
        expect(kit.render).toHaveBeenCalledWith({ characterThoughts: after }, index);
        expect(kit.save).toHaveBeenCalled();
        const slots = (env.mock.context as unknown as { extensionPrompts: Record<string, { value: string }> })
            .extensionPrompts;
        expect(slots['dooms-tracker-example']!.value).toBe('```json\n{"characters":"new"}\n```\n');
        // The record of a player's message carries it as its source.
        expect(lastJournal().sourceMessage).toBe(index + 1);
        await env.journal.undo(lastJournal().id);
        expect(desSwipeRecord(env.mock.chat[index])?.characterThoughts).toBe(before);
        expect(kit.replaceCharacters).toHaveBeenLastCalledWith(after, before);
    });

    it('waits for the Workshop, skips an appearance without clothes and follows the setting', async () => {
        const service = await env.start();
        const index = await env.turn({
            characters: [
                { name: 'Anna', details: { appearance: 'в синих джинсах' } },
                { name: 'Boris', details: { appearance: 'высокий, рыжий' } },
            ],
        });
        env.des.workshop = true;
        await service.wearNow('Anna', { wording: 'кожаная куртка' });
        expect(lastJournal().changes.map((change) => change.target)).not.toContain(DES_TRACKER_TARGET);
        expect(annaDetails(index)?.appearance).toBe('в синих джинсах');
        env.des.workshop = false;
        await service.wearNow('Boris', { wording: 'кольчуга' });
        expect(lastJournal().changes.map((change) => change.target)).not.toContain(DES_TRACKER_TARGET);
        env.slices.wardrobe!.desWrite = false;
        await service.wearNow('Anna', { wording: 'шуба' });
        expect(annaDetails(index)?.appearance).toBe('в синих джинсах');
        env.slices.wardrobe!.desWrite = true;
        await service.wearNow('Anna', { wording: 'шуба' });
        expect(annaDetails(index)?.appearance).toBe('шуба');
    });
});
