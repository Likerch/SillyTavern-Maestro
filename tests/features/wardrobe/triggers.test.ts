// «Переодевание по сообщениям» (M27 triggers): the player's message is read at generation time — what it tells is put
// on before the reply is written (the prompt line says it), what it does not tell gets a one-shot hint and the model
// after the reply; the narration of a committed reply counts too (unless its tracker already shows it); a swipe or a
// regeneration reads the player's message once, a swipe of the reply keeps the player's change, deleting the message
// takes it back, an edit reads it again. The model task (wardrobe.change) has a strict schema and stays away in
// economy mode.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    CHANGE_INJECTION,
    CHANGE_TASK,
    WARDROBE_INJECTION,
    WARDROBE_WEAR_NOW_KIND,
} from '../../../src/features/wardrobe';
import type { WardrobeService } from '../../../src/features/wardrobe';
import { message } from '../../helpers/st-mock';
import { createWardrobeEnv, passport, reply, SETTLE } from './helpers';
import type { WardrobeEnv } from './helpers';

let env: WardrobeEnv;
let service: WardrobeService;

const alex = () => env.nai.getPassport('p-alex')!;
const anna = () => env.nai.getPassport('p-anna')!;
const wearNows = () => env.journal.records.filter((record) => record.kind === WARDROBE_WEAR_NOW_KIND);
const persona = () => service.current().find((item) => item.persona);

/** The reply with Anna in the tracker, then the player's message: its index. */
function scene(text: string, appearance = 'в синих джинсах и серой толстовке'): number {
    env.mock.chat.push(reply({ characters: [{ name: 'Anna', details: { appearance } }] }));
    env.mock.chat.push(message(text, { is_user: true, name: 'Алекс' }));
    return env.mock.chat.length - 1;
}

/** The reply to the player's message arrives (DES's tracker with it). */
async function answer(text = 'Ответ.', appearance = 'в синих джинсах и серой толстовке'): Promise<number> {
    env.mock.chat.push(reply({ text, characters: [{ name: 'Anna', details: { appearance } }] }));
    const index = env.mock.chat.length - 1;
    await env.app.bus.emit('reply:ready', { messageIndex: index, type: 'normal' });
    await env.tick(50);
    return index;
}

beforeEach(async () => {
    vi.useFakeTimers();
    env = createWardrobeEnv('ru');
    env.nai.persona = [
        passport('p-alex', '', { outfits: [{ name: 'Домашнее', tags: 'casual clothes, house slippers' }] }),
    ];
    service = await env.start();
});

afterEach(() => {
    vi.useRealTimers();
});

describe('the player’s message', () => {
    it('puts on the outfit it names before the reply is written', async () => {
        const index = scene('Переодеваюсь в домашнее.');
        const injected = await env.ephemeral.generate();
        expect(alex().activeOutfit).toBe('Домашнее');
        expect(injected.get(WARDROBE_INJECTION)?.text).toContain('Алекс: домашнее');
        expect(injected.has(CHANGE_INJECTION)).toBe(false);
        expect(wearNows()).toHaveLength(1);
        expect(wearNows()[0]).toMatchObject({ sourceMessage: index, summary: 'Алекс → Домашнее' });
        // The line under the player's message.
        const strip = env.ui.strips[0]!;
        expect(strip.items(index).map((item) => item.text)).toEqual(['Алекс → Домашнее']);
        expect(strip.items(index)[0]!.actions!.map((action) => action.label)).toEqual(['Отменить', 'Другое…']);
        // A swipe or a regeneration does not read it again.
        env.mock.chat.push(reply({ text: 'Ответ' }));
        await env.ephemeral.generate({ type: 'swipe' });
        expect(wearNows()).toHaveLength(1);
    });

    it('takes garments it names and Anna by her Russian name', async () => {
        scene('Анна переодевается в бальное платье, а я жду.');
        await env.ephemeral.generate();
        expect(anna().activeOutfit).toBe('ballgown');
        expect(service.current('Anna')[0]).toMatchObject({ wording: 'бальное платье', source: 'player' });
    });

    it('hints what it cannot tell and asks the model after the reply', async () => {
        const index = scene('Я переодеваюсь, пока она отвернулась.');
        const injected = await env.ephemeral.generate();
        expect(injected.get(CHANGE_INJECTION)).toEqual({
            text: '[Clothing: Алекс is changing clothes — "переодеваюсь". Describe the new clothes and update the tracker.]',
            position: 1,
            depth: 0,
            role: 0,
            scan: false,
        });
        expect(service.pendingChanges()).toMatchObject([{ index, who: 'persona', phrase: 'переодеваюсь' }]);
        // A swipe gets the hint again.
        env.mock.chat.push(reply({ text: 'Ответ' }));
        expect((await env.ephemeral.generate({ type: 'swipe' })).has(CHANGE_INJECTION)).toBe(true);
        env.mock.chat.pop();
        const reply1 = await answer('Алекс натягивает старую пижаму и тапочки.');
        expect(env.tasks.queued.map((task) => task.kind)).toEqual([CHANGE_TASK]);
        expect(env.tasks.queued[0]!.payload).toMatchObject({ source: index, mode: 'player' });
        expect(String(env.tasks.queued[0]!.payload.excerpt)).toContain('пижаму');
        env.llm.answer = () => ({
            ok: true,
            data: { changes: [{ name: 'Алекс', wearing: 'старая пижама и тапочки', outfit: null }] },
        });
        await env.tasks.runLatest(CHANGE_TASK);
        await env.tick(50);
        expect(env.llm.requests.at(-1)).toMatchObject({ task: CHANGE_TASK, schema: { name: 'wardrobe_change' } });
        expect(persona()).toMatchObject({ wording: 'старая пижама и тапочки', source: 'model' });
        expect(alex().activeOutfit).toBeTruthy();
        expect(service.pendingChanges()).toEqual([]);
        // The model's answer belongs to the player's message: a swipe of the reply keeps it.
        expect(wearNows().at(-1)?.sourceMessage).toBe(index);
        await env.app.bus.emit('message:invalidated', { messageIndex: reply1, reason: 'swiped' });
        await env.tick(50);
        expect(persona()?.wording).toBe('старая пижама и тапочки');
    });

    it('keeps its change when the reply is swiped and takes it back when the message is deleted', async () => {
        const index = scene('Переодеваюсь в домашнее.');
        await env.ephemeral.generate();
        const replyIndex = await answer();
        await env.app.bus.emit('message:invalidated', { messageIndex: replyIndex, reason: 'swiped' });
        await env.tick(50);
        expect(alex().activeOutfit).toBe('Домашнее');
        env.mock.chat.splice(index);
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'deleted' });
        await env.tick(50);
        expect(alex().activeOutfit).toBe('');
        expect(wearNows()[0]!.undone).toBe(true);
        expect(persona()?.wording ?? '').not.toBe('Домашнее');
    });

    it('reads an edited message again', async () => {
        const index = scene('Переодеваюсь в домашнее.');
        await env.ephemeral.generate();
        env.mock.chat[index]!.mes = 'Надеваю тёплую пижаму.';
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'edited' });
        await env.tick(50);
        expect(wearNows()[0]!.undone).toBe(true);
        expect(persona()).toMatchObject({ wording: 'тёплая пижама', source: 'player' });
        expect(alex().activeOutfit).not.toBe('Домашнее');
    });

    it('writes nothing on the send path for a message without a change of clothes', async () => {
        scene('Я подхожу к окну и смотрю на дождь.');
        const uploads = () => env.mock.requests.filter((request) => request.url.includes('/api/files/upload')).length;
        const before = uploads();
        await env.ephemeral.generate();
        expect(uploads()).toBe(before);
        expect(wearNows()).toHaveLength(0);
    });

    it('does nothing while switched off, for quiet or dry generations, sheets and impersonation', async () => {
        env.slices.wardrobe!.triggers = false;
        scene('Переодеваюсь в домашнее.');
        await env.ephemeral.generate();
        expect(alex().activeOutfit).toBe('');
        env.slices.wardrobe!.triggers = true;
        await env.ephemeral.generate({ quiet: true });
        await env.ephemeral.generate({ dryRun: true });
        await env.ephemeral.generate({ sheetCommand: 'fullsheet' });
        await env.ephemeral.generate({ type: 'impersonate' });
        expect(alex().activeOutfit).toBe('');
        await env.ephemeral.generate();
        expect(alex().activeOutfit).toBe('Домашнее');
    });
});

describe('the narration of a committed reply', () => {
    it('takes a change the tracker missed; a swipe of that reply takes it back', async () => {
        await env.turn({
            characters: [{ name: 'Anna', details: { appearance: 'в синих джинсах и серой толстовке' } }],
        });
        const index = await env.turn({
            text: 'Анна переоделась в бальное платье и вышла к гостям.',
            characters: [{ name: 'Anna', details: { appearance: 'в синих джинсах и серой толстовке' } }],
        });
        expect(anna().activeOutfit).toBe('ballgown');
        expect(wearNows().at(-1)).toMatchObject({ sourceMessage: index });
        expect(env.ui.strips[0]!.items(index)[0]?.text).toBe('Anna → ballgown');
        env.mock.chat.splice(index + 1);
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'swiped' });
        await env.tick(50);
        expect(anna().activeOutfit).toBe('');
    });

    it('leaves to the tracker what it already shows, and asks the model about the rest', async () => {
        await env.turn({
            characters: [{ name: 'Anna', details: { appearance: 'в синих джинсах и серой толстовке' } }],
        });
        await env.turn({
            text: 'Анна переоделась в бальное платье.',
            characters: [{ name: 'Anna', details: { appearance: 'в белом бальном платье' } }],
        });
        expect(wearNows()).toHaveLength(0);
        const index = await env.turn({
            text: 'Анна переоделась.',
            characters: [{ name: 'Anna', details: { appearance: 'в белом бальном платье' } }],
        });
        expect(env.tasks.queued.map((task) => task.kind)).toEqual([CHANGE_TASK]);
        expect(env.tasks.queued[0]!.payload).toMatchObject({ source: index, mode: 'reply' });
        env.llm.answer = () => ({ ok: true, data: { changes: [{ name: 'Anna', wearing: null, outfit: 'ballgown' }] } });
        await env.tasks.runLatest(CHANGE_TASK);
        await env.tick(50);
        expect(wearNows().at(-1)).toMatchObject({ sourceMessage: index });
    });

    it('does not ask the model in economy mode or without a profile', async () => {
        env.core.mode = 'economy';
        await env.turn({
            text: 'Анна переоделась.',
            characters: [{ name: 'Anna', details: { appearance: 'в джинсах' } }],
        });
        env.core.mode = 'balanced';
        env.llm.availableValue = false;
        await env.turn({
            text: 'Анна переоделась.',
            characters: [{ name: 'Anna', details: { appearance: 'в джинсах' } }],
        });
        expect(env.tasks.queued).toEqual([]);
        await env.tick(SETTLE);
    });
});
