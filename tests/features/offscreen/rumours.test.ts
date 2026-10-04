import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { RUMOUR_PREFIX } from '../../../src/features/offscreen';
import type { OffscreenService } from '../../../src/features/offscreen';
import {
    answer,
    createOffscreenEnv,
    event,
    place,
    relation,
    seedMira,
    seedScene,
    trackerMessage,
    userMessage,
} from './helpers';
import type { OffscreenEnv, TrackerParts } from './helpers';

let env: OffscreenEnv;

const TAVERN: TrackerParts = { location: 'Таверна', present: ['Лиза'] };
const ALONE: TrackerParts = { location: 'Таверна', present: [] };
const RUMOUR = 'They say the herbalist got rich overnight.';
const NOTE = `${RUMOUR_PREFIX} ${RUMOUR}`;

beforeEach(() => {
    vi.useFakeTimers();
    env = createOffscreenEnv();
    seedScene(env);
    seedMira(env);
    env.places.places.push(place({ id: 'tavern', name: 'Таверна' }));
    for (let i = 0; i < 6; i++) env.mock.chat.push(trackerMessage(`Таверна ${i}`, TAVERN), userMessage(`Ход ${i}`));
    env.mock.chat.push(trackerMessage('Черновик', TAVERN));
});

afterEach(async () => {
    await env.stop();
    vi.useRealTimers();
});

/** Starts the module and saves one event of Mira with a rumour. */
async function withEvent(fields: Record<string, unknown> = {}): Promise<OffscreenService> {
    env.llm.script = [answer(event({ location: 'Таверна', ...fields }))];
    const service = await env.start();
    await service.execute('manual', ['Mira']);
    expect(service.events()[0]?.status).toBe('saved');
    return service;
}

const rumourOf = (prompts: Map<string, { value: string }> | undefined) => prompts?.get('maestro_offscreen');

describe('rumours', () => {
    it('one turn after the event a present character at the same place may mention it, once', async () => {
        const service = await withEvent();
        await env.send('Что нового?');
        expect(rumourOf(env.injected.at(-1))).toEqual({ value: NOTE, position: 1, depth: 1, role: 0 });
        // One-shot: cleared after the generation (P8).
        expect(env.prompts.has('maestro_offscreen')).toBe(false);
        expect(service.events()[0]?.rumourUsed).toBe(true);
        for (let i = 0; i < 6; i++) {
            await env.reply(`Ответ ${i}`, TAVERN);
            await env.send(`Ход ${i}`);
            expect(rumourOf(env.injected.at(-1))).toBeUndefined();
        }
    });

    it('a swipe or a regeneration of that reply gets the same note; a later swipe does not', async () => {
        await withEvent();
        await env.send('Что нового?');
        await env.reply('Ответ', TAVERN);
        expect(rumourOf(await env.generate('swipe'))?.value).toBe(NOTE);
        env.mock.chat.pop();
        expect(rumourOf(await env.generate('regenerate'))?.value).toBe(NOTE);
        await env.reply('Ответ', TAVERN);
        await env.send('Дальше');
        await env.reply('Ответ 2', TAVERN);
        expect(rumourOf(await env.generate('swipe'))).toBeUndefined();
        expect(rumourOf(await env.generate('quiet'))).toBeUndefined();
    });

    it('comes up one turn in three: nobody to hear it now, someone three turns later', async () => {
        const service = await withEvent();
        env.mock.chat.splice(-1, 1, trackerMessage('Пусто', ALONE));
        await env.app.bus.emit('reply:ready', { messageIndex: env.mock.chat.length - 1, type: 'normal' });
        await env.tick(50);
        await env.send('…');
        expect(rumourOf(env.injected.at(-1))).toBeUndefined();
        await env.reply('Ответ 1', TAVERN);
        await env.send('…');
        await env.reply('Ответ 2', TAVERN);
        await env.send('…');
        expect(rumourOf(env.injected.at(-1))).toBeUndefined();
        await env.reply('Ответ 3', TAVERN);
        await env.send('…');
        expect(rumourOf(env.injected.at(-1))?.value).toBe(NOTE);
        expect(service.events()[0]?.rumourUsed).toBe(true);
    });

    it('elsewhere it travels only along a relationship', async () => {
        await withEvent({ location: 'Столица' });
        await env.send('…');
        expect(rumourOf(env.injected.at(-1))).toBeUndefined();
        await env.stop();
        env.relations.list.push(relation('Лиза', 'Mira', 'Подруги'));
        env.llm.script = [answer(event({ location: 'Столица' }))];
        await env.reply('Ответ', TAVERN);
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        expect(service.rumourScene()).toMatchObject({
            presentKeys: ['лиза'],
            placeKey: 'place:tavern',
            related: ['mira'],
        });
        await env.send('…');
        expect(rumourOf(env.injected.at(-1))?.value).toBe(NOTE);
    });

    it('not when rumours are off, not in «Экономный»', async () => {
        env.settings().rumours = false;
        await withEvent();
        await env.send('…');
        expect(rumourOf(env.injected.at(-1))).toBeUndefined();
        env.settings().rumours = true;
        env.core.mode = 'economy';
        await env.reply('Ответ', TAVERN);
        await env.send('…');
        expect(rumourOf(env.injected.at(-1))).toBeUndefined();
    });

    it('not for an event that waits in the Inbox', async () => {
        env.llm.script = [answer(event({ location: 'Таверна', drastic: true }))];
        const service = await env.start();
        await service.execute('manual', ['Mira']);
        expect(service.events()[0]?.status).toBe('inbox');
        await env.send('…');
        expect(rumourOf(env.injected.at(-1))).toBeUndefined();
    });

    it('a returning character makes the rumour moot', async () => {
        await withEvent();
        env.mock.chat.splice(
            -1,
            1,
            trackerMessage('Мира вернулась', { location: 'Таверна', present: ['Лиза', 'Mira'] }),
        );
        await env.app.bus.emit('reply:ready', { messageIndex: env.mock.chat.length - 1, type: 'normal' });
        await env.tick(50);
        await env.send('…');
        expect(rumourOf(env.injected.at(-1))).toBeUndefined();
    });
});
