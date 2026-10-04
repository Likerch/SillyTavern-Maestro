import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { OFFSCREEN_TASK } from '../../../src/features/offscreen';
import { CHAT_ID, createOffscreenEnv, seedMira, seedScene, trackerMessage, userMessage } from './helpers';
import type { OffscreenEnv } from './helpers';

let env: OffscreenEnv;

beforeEach(() => {
    vi.useFakeTimers();
    env = createOffscreenEnv();
    seedScene(env);
    seedMira(env);
});

afterEach(async () => {
    await env.stop();
    vi.useRealTimers();
});

const runs = () => env.tasks.queued.filter((task) => task.kind === OFFSCREEN_TASK);
const signal = (kind: string) =>
    env.app.bus.emit('signal', { kind, chatId: CHAT_ID, messageIndex: env.mock.chat.length - 2, at: Date.now() });

describe('the cadence', () => {
    it('«Сбалансированный»: a run every 15 committed turns, for the absent important characters', async () => {
        const service = await env.start();
        expect(service.nextIn()).toBe(15);
        await env.turns(14);
        expect(runs()).toHaveLength(0);
        expect(service.nextIn()).toBe(1);
        await env.turns(1);
        expect(runs()).toHaveLength(1);
        expect(runs()[0]).toMatchObject({
            kind: 'offscreen.run',
            dedupeKey: 'offscreen',
            chatId: CHAT_ID,
            payload: { reason: 'interval', characters: ['Mira'], chatId: CHAT_ID },
        });
        expect(service.nextIn()).toBe(15);
    });

    it('«Кино»: every 10 turns and at a scene end (not right after a run)', async () => {
        env.core.mode = 'cinema';
        const service = await env.start();
        expect(service.nextIn()).toBe(10);
        await env.turns(4);
        await signal('scene.ended');
        await env.tick(100);
        expect(runs().map((task) => task.payload.reason)).toEqual(['sceneEnd']);
        expect(service.nextIn()).toBe(10);
        await env.runTasks();
        await env.turns(2);
        await signal('scene.ended');
        await env.tick(100);
        expect(runs()).toHaveLength(0);
        await env.turns(8);
        expect(runs().map((task) => task.payload.reason)).toEqual(['interval']);
    });

    it('a scene end does nothing in «Сбалансированный» by default; the setting turns it on', async () => {
        const service = await env.start();
        await env.turns(4);
        await signal('scene.ended');
        await env.tick(100);
        expect(runs()).toHaveLength(0);
        env.settings().sceneEnd.balanced = true;
        await signal('scene.ended');
        await env.tick(100);
        expect(runs().map((task) => task.payload.reason)).toEqual(['sceneEnd']);
        expect(service.nextIn()).toBe(15);
    });

    it('«Экономный»: never by itself', async () => {
        env.core.mode = 'economy';
        const service = await env.start();
        await env.turns(40);
        await signal('scene.ended');
        await env.tick(100);
        expect(runs()).toHaveLength(0);
        expect(service.nextIn()).toBeNull();
    });

    it('the setting overrides N; 0 switches automatic runs off', async () => {
        env.settings().every.balanced = 3;
        const service = await env.start();
        await env.turns(3);
        expect(runs()).toHaveLength(1);
        env.tasks.queued.length = 0;
        env.settings().every.balanced = 0;
        await env.turns(30);
        expect(runs()).toHaveLength(0);
        expect(service.nextIn()).toBeNull();
    });
});

describe('the counter', () => {
    it('counts each committed reply once, survives a reload and starts from the history of an older chat', async () => {
        env.mock.chat.push(
            trackerMessage('Старый ответ 1', { present: ['Лиза', 'Mira'] }),
            userMessage('…'),
            trackerMessage('Старый ответ 2'),
            userMessage('…'),
            trackerMessage('Новый ответ'),
        );
        const service = await env.start();
        // Two committed replies: the counter starts at 2 and the first run comes N turns later.
        expect(service.nextIn()).toBe(15);
        expect(service.candidates()).toEqual([{ name: 'Mira', absent: 1, preferred: false }]);
        await env.send('Ход');
        await env.app.bus.emit('turn:committed', { messageIndex: 4 });
        await env.tick(100);
        expect(service.nextIn()).toBe(14);
        await env.stop();
        const again = await env.start();
        expect(again.nextIn()).toBe(14);
    });

    it('a deleted committed message lets the turn count again', async () => {
        const service = await env.start();
        await env.turns(3);
        expect(service.nextIn()).toBe(12);
        await env.app.bus.emit('message:invalidated', { messageIndex: 4, reason: 'deleted' });
        env.mock.chat.splice(4);
        await env.turns(1);
        expect(service.nextIn()).toBe(11);
    });
});

describe('when a run may start', () => {
    it('only in the leader tab', async () => {
        env.settings().every.balanced = 2;
        env.leader.value = false;
        await env.start();
        await env.turns(4);
        expect(runs()).toHaveLength(0);
        env.leader.value = true;
        await env.app.bus.emit('leader:changed', { leader: true });
        await env.tick(100);
        expect(runs()).toHaveLength(1);
    });

    it('never during a generation: it waits for the end', async () => {
        env.settings().every.balanced = 1;
        await env.start();
        await env.reply('Ответ');
        await env.send('Ход', { end: false });
        await env.tick(100);
        expect(runs()).toHaveLength(0);
        await env.end();
        await env.tick(100);
        expect(runs()).toHaveLength(1);
    });

    it('not over the background cap, without a profile or without the chat canon', async () => {
        env.settings().every.balanced = 1;
        env.capped.value = true;
        await env.start();
        await env.turns(2);
        expect(runs()).toHaveLength(0);
        env.capped.value = false;
        env.llm.available = false;
        await env.turns(1);
        expect(runs()).toHaveLength(0);
        env.llm.available = true;
        env.modules.apis.delete('canon');
        await env.turns(1);
        expect(runs()).toHaveLength(0);
        env.modules.expose('canon', env.canon);
        await env.turns(1);
        expect(runs()).toHaveLength(1);
    });

    it('one pending run per chat; nobody to visit is recorded as a run without events', async () => {
        env.settings().every.balanced = 1;
        const service = await env.start();
        await env.turns(3);
        expect(runs()).toHaveLength(1);
        env.tasks.queued.length = 0;
        env.world.list = env.world.list.filter((item) => item.name !== 'Mira');
        env.des.known = ['Лиза'];
        await env.turns(1);
        expect(runs()).toHaveLength(0);
        expect(service.status().lastRun).toMatchObject({ reason: 'interval', characters: [], error: 'noCandidates' });
    });

    it('not in a group chat', async () => {
        env.settings().every.balanced = 1;
        env.host.group = true;
        const service = await env.start();
        await env.turns(3);
        expect(runs()).toHaveLength(0);
        expect(service.nextIn()).toBeNull();
    });
});
