import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SCENE_TASK } from '../../../src/features/director';
import { createDirectorEnv, FakeNai } from './helpers';
import type { DirectorEnv } from './helpers';

let env: DirectorEnv;

const UNSURE = 'Он выхватил меч и атаковал. Она поцеловала его, прижавшись губами к шее.';
const CALM = '— Как прошёл день? — спросила Лиза, наливая чай.\n— Неплохо, — ответил он.';

beforeEach(() => {
    vi.useFakeTimers();
    env = createDirectorEnv();
    env.des.known = ['Лиза'];
});

afterEach(async () => {
    await env.stop();
    vi.useRealTimers();
});

async function unsureTurn(): Promise<void> {
    env.start();
    await env.tick(50);
    await env.reply(UNSURE);
    await env.send('…');
}

describe('M13 director: the model for unsure scenes', () => {
    it('asks once in the background and takes its answer for the latest turn', async () => {
        env.llm.respond = () => ({ ok: true, data: { type: 'intimate', confidence: 0.92 } });
        await unsureTurn();
        expect(env.service().scene()?.by).toBe('rules');
        expect(env.tasks.queued).toHaveLength(1);
        expect(env.tasks.queued[0]).toMatchObject({ kind: SCENE_TASK, chatId: env.host.chatId() });
        expect(env.service().modelState()).toEqual({ messageIndex: 0, state: 'queued' });
        await env.runTasks();
        expect(env.llm.requests).toHaveLength(1);
        const request = env.llm.requests[0]!;
        expect(request).toMatchObject({ task: SCENE_TASK, maxTokens: 80, temperature: 0 });
        expect(request.schema?.name).toBe('director_scene');
        expect(request.messages[1]?.content).toContain('выхватил меч');
        expect(request.messages[1]?.content).toContain('<user_latest>\n…\n</user_latest>');
        expect(request.messages[0]?.content).toMatch(/hesitate between (combat and intimate|intimate and combat)/);
        expect(env.service().scene()).toMatchObject({ type: 'intimate', by: 'model', confidence: 0.92 });
        expect(env.service().modelState()).toEqual({ messageIndex: 0, state: 'answered', type: 'intimate' });
    });

    it('a malformed or failed answer keeps the rules decision', async () => {
        env.llm.respond = () => ({ ok: true, data: 'garbage', text: 'the scene is a picnic' });
        await unsureTurn();
        const before = env.service().scene();
        await env.runTasks();
        expect(env.service().scene()).toEqual(before);
        expect(env.service().modelState()?.state).toBe('failed');

        env.llm.respond = () => ({ ok: false, error: 'HTTP 500' });
        await env.reply(UNSURE);
        await env.send('…');
        await env.runTasks();
        expect(env.service().modelState()).toMatchObject({ messageIndex: 2, state: 'failed' });

        env.llm.respond = () => {
            throw new Error('network');
        };
        await env.reply(UNSURE);
        await env.send('…');
        await env.runTasks();
        expect(env.service().modelState()).toMatchObject({ messageIndex: 4, state: 'failed' });
    });

    it('a stale task (a newer turn was committed) asks nothing', async () => {
        await unsureTurn();
        await env.reply(CALM);
        await env.send('…');
        await env.runTasks();
        expect(env.llm.requests).toHaveLength(0);
        await env.tasks.runners.get(SCENE_TASK)!({ junk: true }, {} as never);
        expect(env.llm.requests).toHaveLength(0);
    });

    it('is not asked in «Экономный», when switched off, in another tab or without a profile', async () => {
        env.core.mode = 'economy';
        await unsureTurn();
        expect(env.tasks.queued).toHaveLength(0);
        env.core.mode = 'balanced';
        env.settings().model = false;
        await env.reply(UNSURE);
        await env.send('…');
        expect(env.tasks.queued).toHaveLength(0);
        env.settings().model = true;
        env.leader.value = false;
        await env.reply(UNSURE);
        await env.send('…');
        expect(env.tasks.queued).toHaveLength(0);
        env.leader.value = true;
        env.llm.available = false;
        await env.reply(UNSURE);
        await env.send('…');
        expect(env.tasks.queued).toHaveLength(0);
        env.llm.available = true;
        await env.reply(UNSURE);
        await env.send('…');
        expect(env.tasks.queued).toHaveLength(1);
    });

    it('a sure scene asks nothing', async () => {
        env.start();
        await env.tick(50);
        await env.reply(CALM);
        await env.send('…');
        expect(env.tasks.queued).toHaveLength(0);
    });
});

describe('M13 director: picture moments', () => {
    const LISA = { location: 'Таверна', characters: [{ name: 'Лиза' }] };

    async function twoTurns(
        second: Parameters<DirectorEnv['reply']>[1],
        text = CALM,
    ): Promise<Record<string, unknown>> {
        env.start();
        await env.tick(50);
        await env.reply(CALM, LISA);
        await env.send('…');
        await env.reply(text, second);
        return env.send('…');
    }

    it('a first appearance hints a picture', async () => {
        const flags = await twoTurns({ location: 'Таверна', characters: [{ name: 'Лиза' }, { name: 'Орк' }] });
        expect(flags.maestro_picture_moment).toBe('1');
        expect(env.service().pictureCues()).toEqual(['firstAppearance']);
    });

    it('a place change hints a picture', async () => {
        const flags = await twoTurns({ location: 'Тёмный лес за рекой', characters: [{ name: 'Лиза' }] });
        expect(flags.maestro_picture_moment).toBe('1');
        expect(env.service().pictureCues()).toEqual(['placeChange']);
    });

    it('a plain turn does not', async () => {
        expect((await twoTurns(LISA)).maestro_picture_moment).toBeUndefined();
    });

    it('never in «Экономный», when switched off or without NAI Studio', async () => {
        env.core.mode = 'economy';
        expect(
            (await twoTurns({ location: 'Лес', characters: [{ name: 'Орк' }] })).maestro_picture_moment,
        ).toBeUndefined();
        env.core.mode = 'balanced';
        env.settings().pictures = false;
        await env.reply(CALM, { location: 'Пещера', characters: [{ name: 'Тролль' }] });
        expect((await env.send('…')).maestro_picture_moment).toBeUndefined();
        env.settings().pictures = true;
        env.nai.present = false;
        await env.reply(CALM, { location: 'Замок', characters: [{ name: 'Король' }] });
        expect((await env.send('…')).maestro_picture_moment).toBeUndefined();
        env.nai.present = true;
        expect(env.service().flags().maestro_picture_moment).toBe('1');
    });

    it('paid pictures need a stronger moment; «Кино» is more generous', async () => {
        env.nai.settings = { anlas: { freeOnly: false }, markers: { allowPaid: true } };
        const paid = await twoTurns({ location: 'Таверна', characters: [{ name: 'Лиза' }, { name: 'Орк' }] });
        expect(paid.maestro_picture_moment).toBeUndefined();
        env.nai.settings = null;
        env.core.mode = 'cinema';
        await env.reply('Наконец дверь поддалась.', LISA);
        expect((await env.send('…')).maestro_picture_moment).toBe('1');
        expect(env.service().pictureCues()).toEqual(['climax']);
    });

    it('a sudden fight counts as a climax', async () => {
        env.core.mode = 'cinema';
        const fight =
            'Орк бросился в атаку, занося топор. Лиза уклонилась, клинок сверкнул, удар пришёлся врагу в плечо. Кровь брызнула на камни. Второй противник выхватил кинжал и напал сзади, бой закипел.';
        const flags = await twoTurns({ characters: [{ name: 'Лиза' }] }, fight);
        expect(flags.maestro_scene_combat).toBe('1');
        expect(flags.maestro_picture_moment).toBe('1');
        expect(env.service().pictureCues()).toEqual(['climax']);
    });
});

describe('M13 director: NAI Studio scene hint', () => {
    it('registers a provider with the place and the canonical names, and drops it on stop', async () => {
        const nai = new FakeNai();
        env.nai.api = nai;
        env.modules.expose('places', {
            resolve: (label: string) => (label === 'Таверна' ? { id: 'p1', name: 'Таверна «Пони»' } : undefined),
            current: () => ({ id: 'p2', name: 'Двор' }),
        });
        env.modules.expose('world', {
            resolve: (name: string) => (name === 'Лиза' ? { name: 'Elizabeth' } : undefined),
        });
        env.start();
        await env.tick(50);
        expect(nai.providers.map((provider) => [provider.id, provider.priority])).toEqual([['maestro-director', 50]]);
        await env.reply(CALM, { location: 'Таверна', characters: [{ name: 'Лиза' }, { name: 'Боб', present: false }] });
        const provider = nai.providers[0]!;
        expect(provider.describe({ messageIndex: 0, text: '' })).toEqual({
            locationId: 'p1',
            locationName: 'Таверна «Пони»',
            characters: ['Elizabeth'],
        });
        await env.reply(CALM, { location: 'Где-то', characters: [] });
        expect(provider.describe({ messageIndex: 1, text: '' })).toEqual({ locationId: 'p2', locationName: 'Двор' });
        env.mock.chat.push({ name: 'User', is_user: true, is_system: false, send_date: '', mes: '…' });
        expect(provider.describe({ messageIndex: 1, text: '' })).toEqual({ locationId: 'p2', locationName: 'Двор' });
        await env.reply(CALM, { location: 'Двор', characters: [] });
        expect(provider.describe({ messageIndex: 1, text: '' })).toEqual({ locationName: 'Где-то' });
        expect(provider.describe({ messageIndex: 99, text: '' })).toEqual({ locationId: 'p2', locationName: 'Двор' });
        expect(provider.describe(null as never)).toBeNull();
        await env.stop();
        expect(nai.offs).toBe(1);
        expect(nai.providers).toEqual([]);
    });

    it('is not registered without places and the world model, nor without the API', async () => {
        env.nai.api = new FakeNai();
        env.start();
        await env.tick(50);
        expect(env.nai.api.providers).toEqual([]);
        expect(env.service().hints.isRegistered()).toBe(false);
        await env.stop();
        env.nai.api = undefined;
        env.modules.expose('places', { resolve: () => undefined, current: () => null });
        env.start();
        await env.tick(50);
        expect(env.service().hints.isRegistered()).toBe(false);
    });

    it('registers again when NAI Studio publishes a new API', async () => {
        env.modules.expose('world', { resolve: () => undefined });
        const first = new FakeNai();
        env.nai.api = first;
        env.start();
        await env.tick(50);
        expect(first.providers).toHaveLength(1);
        const second = new FakeNai();
        env.nai.api = second;
        await env.reply(CALM);
        await env.send('…');
        expect(first.offs).toBe(1);
        expect(second.providers).toHaveLength(1);
    });
});
