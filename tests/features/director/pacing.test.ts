import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NOTE_INJECTION } from '../../../src/features/director';
import { createDirectorEnv, FAST, trackerMessage } from './helpers';
import type { DirectorEnv, TrackerParts } from './helpers';

let env: DirectorEnv;

const KEY = `maestro_${NOTE_INJECTION}`;
const TAVERN: TrackerParts = {
    location: 'Таверна «Пони»',
    characters: [{ name: 'Лиза' }],
    quests: { main: 'Найти брата', optional: ['Вернуть долг гильдии'] },
};
const TALK = [
    '— Ещё эля? — спросила Лиза, протирая стойку.',
    '— Может быть, — ответил он и посмотрел в окно.',
    '— Говорят, дождь будет до утра, — заметила она.',
    '— Пусть льёт, нам некуда спешить, — сказал он тихо.',
    '— Тогда я принесу сыра, — улыбнулась Лиза.',
    '— Ты всегда знаешь, что мне нужно, — ответил он.',
    '— Работа такая, — пожала плечами она.',
    '— Ещё по кружке? — спросила Лиза снова.',
    '— Почему бы и нет, — согласился он.',
    '— Вечер обещает быть долгим, — вздохнула она.',
    '— Мне нравится этот камин, — сказал он.',
    '— Его сложил мой отец, — ответила Лиза.',
];

let turn = 0;

/** One quiet turn in the same place: the reply arrives, the user answers neutrally. Returns the flags. */
async function quietTurn(user = 'Киваю и делаю глоток.'): Promise<Record<string, unknown>> {
    await env.reply(TALK[turn++ % TALK.length]!, TAVERN);
    return env.send(user, { end: false });
}

function note(): string | undefined {
    const prompt = env.prompts.get(KEY);
    return prompt?.value || undefined;
}

beforeEach(() => {
    vi.useFakeTimers();
    turn = 0;
    env = createDirectorEnv();
    env.des.known = ['Лиза'];
});

afterEach(async () => {
    await env.stop();
    vi.useRealTimers();
});

async function started(): Promise<void> {
    env.start();
    await env.tick(50);
}

describe('M14 pacing: stall and the director note', () => {
    it('writes a one-shot note from an open quest after N quiet turns in one place', async () => {
        await started();
        for (let i = 0; i < 4; i++) {
            await quietTurn();
            expect(note()).toBeUndefined();
            await env.end();
        }
        expect(env.service().stall().turns).toBe(4);
        await quietTurn();
        const text = note();
        expect(text).toContain('Вернуть долг гильдии');
        expect(text).toContain('the scene has stayed in one place for 5 turns; nothing has changed for 5 turns');
        expect(text).toContain('do not write actions, words or thoughts for User');
        expect(env.prompts.get(KEY)).toMatchObject({ position: 1, depth: 0, role: 0 });
        expect(env.service().stall().reasons).toEqual(['samePlace', 'noEvents']);
        const notes = env.service().notes();
        expect(notes).toHaveLength(1);
        expect(notes[0]).toMatchObject({
            source: 'quest',
            detail: 'Вернуть долг гильдии',
            messageIndex: env.mock.chat.length,
            reasons: ['samePlace', 'noEvents'],
        });
        expect(env.service().pending()).toBeNull();
        await env.end();
        expect(note()).toBeUndefined();
    });

    it('the reply that got the note gets it again on a swipe, continue or regeneration', async () => {
        await started();
        for (let i = 0; i < 5; i++) {
            await quietTurn();
            await env.end();
        }
        const written = env.service().notes()[0]!;
        env.mock.chat.push(trackerMessage('Дверь распахнулась.', TAVERN));
        await env.generate('swipe', { end: false });
        expect(note()).toBe(written.text);
        await env.end();
        await env.generate('continue', { end: false });
        expect(note()).toBe(written.text);
        await env.end();
        await env.generate('impersonate', { end: false });
        expect(note()).toBeUndefined();
        await env.end();
        await env.send('Оборачиваюсь.', { end: false });
        expect(note()).toBeUndefined();
    });

    it('steering is judged as before when the message also sets the scene', async () => {
        await started();
        for (let i = 0; i < 4; i++) {
            await quietTurn();
            await env.end();
        }
        const flags = await quietTurn('Давай нападём на бандитов, я выхватываю меч!');
        expect(flags.maestro_scene_combat).toBe('1');
        expect(note()).toBeUndefined();
        expect(env.service().suppressed()?.reason).toBe('plot');
    });

    it('stays silent when the user steers in his last message', async () => {
        await started();
        for (let i = 0; i < 4; i++) {
            await quietTurn();
            await env.end();
        }
        await quietTurn('Давай поднимемся наверх и посмотрим, кто там шумит.');
        expect(note()).toBeUndefined();
        expect(env.service().suppressed()).toMatchObject({ reason: 'plot', messageIndex: env.mock.chat.length });
        expect(env.service().notes()).toEqual([]);
        await env.end();
        await quietTurn('((ООС: пусть войдёт стража))');
        expect(note()).toBeUndefined();
        expect(env.service().suppressed()?.reason).toBe('ooc');
        await env.end();
        // A clear move without plot words: the user drives the scene himself.
        await quietTurn('Я выхватываю меч и бросаюсь на бандитов!');
        expect(note()).toBeUndefined();
        expect(env.service().suppressed()?.reason).toBe('action');
    });

    it('keeps the frequency limit: every 6 turns in «Сбалансированный»', async () => {
        await started();
        const written: number[] = [];
        for (let i = 0; i < 12; i++) {
            await quietTurn();
            if (note()) written.push(i);
            await env.end();
        }
        expect(written).toEqual([4, 10]);
    });

    it('writes more often in «Кино» and never by itself in «Экономный»', async () => {
        env.core.mode = 'cinema';
        await started();
        const written: number[] = [];
        for (let i = 0; i < 9; i++) {
            await quietTurn();
            if (note()) written.push(i);
            await env.end();
        }
        expect(written).toEqual([4, 8]);

        env.core.mode = 'economy';
        for (let i = 0; i < 8; i++) {
            await quietTurn();
            expect(note()).toBeUndefined();
            await env.end();
        }
    });

    it('the frequency per mode comes from the settings', async () => {
        env.settings().every.balanced = 0;
        env.settings().stallTurns = 2;
        await started();
        for (let i = 0; i < 5; i++) {
            await quietTurn();
            expect(note()).toBeUndefined();
            await env.end();
        }
        env.settings().every.balanced = 1;
        await quietTurn();
        expect(note()).toContain('for 6 turns');
    });

    it('events in the window (place, characters) are no stall', async () => {
        await started();
        const places = ['Таверна «Пони»', 'Рынок у ворот', 'Старый мост', 'Лес у дороги', 'Пещера троллей'];
        for (const location of places) {
            await env.reply(TALK[turn++]!, { ...TAVERN, location });
            await env.send('Иду дальше.', { end: false });
            expect(note()).toBeUndefined();
            await env.end();
        }
        expect(env.service().stall()).toEqual({ turns: 0, reasons: [] });
    });

    it('an intimate scene in one place is no stall', async () => {
        await started();
        for (let i = 0; i < 6; i++) {
            await env.reply('Он целовал её губы, лаская бедра, и она тихо стонала на постели.', TAVERN);
            await env.send('Обнимаю её.', { end: false });
            expect(note()).toBeUndefined();
            await env.end();
        }
        expect(env.service().stall().reasons).toContain('noEvents');
    });

    it('repetition reported by the quality check is a stall reason', async () => {
        env.modules.expose('quality', {
            verdict: () => ({ defects: [{ kind: 'repetition', confidence: 1, by: 'rule' }] }),
        });
        await started();
        for (let i = 0; i < 4; i++) {
            await quietTurn();
            await env.end();
        }
        expect(env.service().stall().reasons).toContain('repetition');
    });

    it('a late signal of the committed turn breaks the stall and drops the prepared note', async () => {
        await started();
        for (let i = 0; i < 4; i++) {
            await quietTurn();
            await env.end();
        }
        // The fifth reply arrives without reply:ready: it is read after the generation, its note waits.
        env.mock.chat.push(trackerMessage(TALK[turn++]!, TAVERN));
        const index = env.mock.chat.length - 1;
        await env.send('Молчу.', { end: false });
        expect(note()).toBeUndefined();
        await env.end();
        expect(env.service().pending()).toMatchObject({ source: 'quest' });
        await env.app.bus.emit('signal', {
            kind: 'location.changed',
            chatId: env.host.chatId(),
            messageIndex: index,
            at: Date.now(),
        });
        expect(env.service().pending()).toBeNull();
        expect(env.service().stall().reasons).not.toContain('noEvents');
        // Signals of other chats or kinds are ignored.
        await env.app.bus.emit('signal', { kind: 'fact.new', chatId: env.host.chatId(), messageIndex: index, at: 0 });
        await env.app.bus.emit('signal', { kind: 'quest.added', chatId: 'other', messageIndex: index, at: 0 });
    });

    it('a time skip signal makes the committed turn a time skip', async () => {
        await started();
        await quietTurn();
        await env.end();
        await quietTurn();
        await env.end();
        const index = env.mock.chat.length - 2;
        expect(env.service().scene()?.type).toBe('dialogue');
        await env.app.bus.emit('signal', {
            kind: 'time.skipped',
            chatId: env.host.chatId(),
            messageIndex: index,
            at: 0,
        });
        expect(env.service().scene()).toMatchObject({ type: 'timeskip', messageIndex: index });
        expect((await env.generate('swipe')).maestro_scene_timeskip).toBe('1');
    });

    it('signals of a turn that is not applied yet are kept for it', async () => {
        await started();
        await quietTurn();
        await env.end();
        env.mock.chat.push(trackerMessage(TALK[turn++]!, TAVERN));
        const index = env.mock.chat.length - 1;
        await env.app.bus.emit('signal', {
            kind: 'quest.added',
            chatId: env.host.chatId(),
            messageIndex: index,
            at: 0,
        });
        await env.send('…');
        await env.tick(FAST.lateMs + 20);
        expect(env.service().stall().turns).toBe(0);
    });
});

describe('M14 pacing: «Встряхнуть»', () => {
    const fact = {
        name: 'Медальон',
        quote: 'Медальон принадлежал пропавшему наследнику',
        text: 'The medallion belongs to the lost heir',
        status: 'provisional',
        sourceMessage: 0,
        keys: [],
        survivedTurns: 3,
    };

    it('prepares a note now regardless of the frequency, from an unresolved thread', async () => {
        env.core.mode = 'economy';
        env.modules.expose('livingCanon', { provisional: () => [fact, { ...fact, sourceMessage: 99 }] });
        await started();
        for (let i = 0; i < 4; i++) {
            await env.reply(TALK[turn++]!, { location: 'Таверна' });
            await env.send('…');
        }
        const pending = await env.service().nudge();
        expect(pending).toMatchObject({
            source: 'thread',
            detail: 'The medallion belongs to the lost heir',
            nudged: true,
        });
        expect(pending?.text).toContain('The story needs a push now.');
        expect(env.service().pending()).toEqual(pending);
        await env.reply(TALK[turn++]!, { location: 'Таверна' });
        await env.send('Смотрю на огонь.', { end: false });
        expect(note()).toBe(pending?.text);
        expect(env.service().notes()[0]).toMatchObject({ nudged: true, source: 'thread' });
    });

    it('a nudge still respects the user steering', async () => {
        await started();
        await quietTurn();
        await env.end();
        expect(await env.service().nudge()).not.toBeNull();
        await env.reply(TALK[turn++]!, TAVERN);
        await env.send('Пусть войдёт капитан стражи.', { end: false });
        expect(note()).toBeUndefined();
        expect(env.service().suppressed()?.reason).toBe('plot');
    });

    it('returns null when there is nothing to build a twist from', async () => {
        await started();
        expect(await env.service().nudge()).toBeNull();
        await env.reply('Тишина.', { location: 'Поле' });
        await env.send('…');
        expect(await env.service().nudge()).toBeNull();
    });

    it('takes twists from every source, the heaviest first, not repeating the last one', async () => {
        env.qvink.present = true;
        env.qvink.memories.set(0, { memory: 'Лиза поклялась отомстить барону.', include: 'long', remember: false });
        env.qvink.memories.set(2, { memory: 'Они пообедали.', include: 'long', remember: true });
        env.modules.expose('chronicle', {
            chapters: async () => [
                { uid: 1, title: 'Тайна старого маяка', from: 0, to: 4, keys: [], secondary: [], chars: 10 },
                { uid: 2, title: 'Ужин', from: 5, to: 8, keys: [], secondary: [], chars: 10 },
            ],
        });
        env.modules.expose('calendar', {
            due: () => [{ who: ['Лиза'], what: 'Pay the guild debt' }],
            promises: () => [{ who: [], what: 'Return the stolen ring' }],
        });
        env.modules.expose('offscreen', {
            events: () => [
                { character: 'Барон', text: 'He hired assassins.', status: 'saved', messageIndex: 0 },
                { character: 'Шут', text: 'Rejected.', status: 'rejected', messageIndex: 0 },
            ],
        });
        env.modules.expose('mechanics', { twists: () => ['The poison takes effect', { text: '' }, null] });
        env.modules.expose('livingCanon', {
            provisional: () => {
                throw new Error('broken');
            },
        });
        await started();
        await quietTurn();
        await env.end();
        const first = await env.service().nudge();
        expect(first).toMatchObject({ source: 'deadline', detail: 'Лиза: Pay the guild debt' });
        await quietTurn('Хм.');
        await env.end();
        const second = await env.service().nudge();
        expect(second).toMatchObject({ source: 'deadline', detail: 'Return the stolen ring' });
        await quietTurn('Хм.');
        await env.end();
        const third = await env.service().nudge();
        expect(third).toMatchObject({ source: 'quest', detail: 'Вернуть долг гильдии' });
        await quietTurn('Хм.');
        await env.end();
        const fourth = await env.service().nudge();
        expect(fourth).toMatchObject({ source: 'offscreen', detail: 'Барон: He hired assassins.' });
    });
});
