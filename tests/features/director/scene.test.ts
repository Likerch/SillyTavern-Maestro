import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { directorModule } from '../../../src/features/director';
import type { DirectorApi } from '../../../src/features/director';
import { switchChat } from '../../helpers/core-host';
import { createDirectorEnv, FAST, trackerMessage, userMessage } from './helpers';
import type { DirectorEnv } from './helpers';

let env: DirectorEnv;

const CALM = '— Как прошёл день? — спросила Лиза, наливая чай.\n— Неплохо, — ответил он.';
const MILD_COMBAT = 'Он положил руку на меч и прислушался: где-то рядом враг.';
const HARD_COMBAT =
    'Орк бросился в атаку, занося топор. Лиза уклонилась, клинок сверкнул, удар пришёлся врагу в плечо. Кровь брызнула на камни. Второй противник выхватил кинжал и напал сзади, бой закипел.';
const EXPLICIT = 'Она была совершенно голая; его пальцы сжали её соски, и она застонала от оргазма, целуя его.';

beforeEach(() => {
    vi.useFakeTimers();
    env = createDirectorEnv();
});

afterEach(async () => {
    await env.stop();
    vi.useRealTimers();
});

async function started(): Promise<void> {
    env.start();
    await env.tick(50);
}

describe('M13 director: flags for the next generation', () => {
    it('sets the scene, length and language flags from the committed reply, and clears them after', async () => {
        env.des.known = ['Лиза'];
        await started();
        await env.reply(HARD_COMBAT);
        const flags = await env.send('Я отступаю к стене.', { end: false });
        expect(flags).toEqual({ maestro_scene_combat: '1', maestro_reply_short: '1', maestro_lang_ru: '1' });
        expect(env.service().flags()).toEqual(flags);
        expect(env.service().scene()).toMatchObject({ type: 'combat', messageIndex: 0, by: 'rules', held: 1 });
        await env.end();
        expect(env.variables()).toEqual({});
    });

    it('an uncommitted reply changes nothing (P14): its type applies only after the user answers', async () => {
        await started();
        await env.reply(CALM);
        await env.send('Хорошо.');
        expect(env.service().scene()?.type).toBe('dialogue');
        await env.reply(HARD_COMBAT);
        const swipe = await env.generate('swipe');
        expect(swipe.maestro_scene_dialogue).toBe('1');
        const flags = await env.send('Бежим!');
        expect(flags.maestro_scene_combat).toBe('1');
    });

    it('quiet, dry and sheet generations get no flags', async () => {
        await started();
        await env.reply(HARD_COMBAT);
        await env.send('…');
        expect(await env.generate('quiet')).toEqual({});
        env.mock.chat.push(userMessage('!fullsheet Лиза'));
        expect(await env.generate('normal')).toEqual({});
    });

    it('marks explicit scenes', async () => {
        await started();
        await env.reply(EXPLICIT);
        const flags = await env.send('…');
        expect(flags).toMatchObject({ maestro_scene_intimate: '1', maestro_explicit: '1', maestro_reply_long: '1' });
    });

    it('detects English chats', async () => {
        await started();
        await env.reply('"How was your day?" she asked, pouring tea. "Not bad," he said, smiling at her warmly.');
        const flags = await env.send('I nod and sip the tea quietly.');
        expect(flags.maestro_lang_en).toBe('1');
        expect(flags.maestro_scene_dialogue).toBe('1');
    });
});

describe('M13 director: hysteresis and override', () => {
    it('a mild new type must win twice; a strong one switches at once', async () => {
        await started();
        await env.reply(CALM);
        await env.send('…');
        await env.reply(MILD_COMBAT);
        await env.send('…');
        expect(env.service().scene()).toMatchObject({ type: 'dialogue', held: 2 });
        expect(env.service().candidate()).toMatchObject({ type: 'combat' });
        await env.reply(MILD_COMBAT);
        await env.send('…');
        expect(env.service().scene()).toMatchObject({ type: 'combat', held: 1 });
        await env.reply(EXPLICIT);
        await env.send('…');
        expect(env.service().scene()?.type).toBe('intimate');
    });

    it('the override holds until cleared and is kept per chat', async () => {
        await started();
        await env.reply(CALM);
        await env.send('…');
        await env.service().setScene('drama');
        await env.reply(HARD_COMBAT);
        const flags = await env.send('…');
        expect(flags).toMatchObject({ maestro_scene_drama: '1', maestro_reply_medium: '1' });
        expect(flags.maestro_scene_combat).toBeUndefined();
        expect(env.service().scene()).toMatchObject({ type: 'drama', by: 'user', confidence: 1, held: 1 });
        expect(env.service().override()).toBe('drama');
        await env.tick(FAST.saveMs + 10);

        const chat = env.mock.chat;
        env.mock.chat = [];
        await switchChat(env.mock, 'other', {});
        await env.tick(50);
        expect(env.service().scene()).toBeNull();
        env.mock.chat = chat;
        await switchChat(env.mock, 'Лиза - 2026-10-05@12h00m00s', {});
        await env.tick(50);
        expect(env.service().override()).toBe('drama');
        await env.service().setScene(null);
        expect(env.service().scene()?.type).toBe('combat');
        await expect(env.service().setScene('picnic' as never)).rejects.toThrow('unknown scene type');
    });

    it('a swiped reply is read again before it is committed', async () => {
        await started();
        await env.reply(HARD_COMBAT);
        const index = env.mock.chat.length - 1;
        env.mock.chat[index] = trackerMessage(CALM);
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'swiped' });
        await env.app.bus.emit('reply:ready', { messageIndex: index, type: 'swipe' });
        await env.tick(FAST.draftMs + 20);
        const flags = await env.send('…');
        expect(flags.maestro_scene_dialogue).toBe('1');
    });

    it('a reply committed without a draft is read after the generation, for the next one', async () => {
        await started();
        env.mock.chat.push(trackerMessage(HARD_COMBAT));
        const first = await env.send('…', { end: false });
        expect(first.maestro_scene_combat).toBeUndefined();
        await env.end();
        expect(env.service().scene()?.type).toBe('combat');
        expect(await env.generate('swipe')).toMatchObject({ maestro_scene_combat: '1' });
    });

    it('an edited reply (changed after its draft) is read again', async () => {
        await started();
        await env.reply(CALM);
        env.mock.chat[0]!.mes = HARD_COMBAT;
        await env.send('…');
        expect(env.service().scene()?.type).toBe('combat');
    });

    it('a chat seen for the first time starts from its last committed reply, without pictures', async () => {
        env.nai.api = undefined;
        env.mock.chat.push(trackerMessage(HARD_COMBAT, { characters: [{ name: 'Орк' }] }), userMessage('…'));
        await started();
        await env.tick(50);
        expect(env.service().scene()).toMatchObject({ type: 'combat', messageIndex: 0 });
        expect(env.service().flags().maestro_picture_moment).toBeUndefined();
        expect(env.service().stall()).toEqual({ turns: 0, reasons: [] });
    });

    it('deleting the committed reply rolls the decision back', async () => {
        await started();
        await env.reply(CALM);
        await env.send('…');
        await env.reply(HARD_COMBAT);
        await env.send('…');
        expect(env.service().scene()?.type).toBe('combat');
        env.mock.chat.splice(2);
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'deleted' });
        expect(env.service().scene()?.type).toBe('dialogue');
    });
});

describe('M13 director: the user message that commits the turn', () => {
    it('a strong Russian cue switches the scene for the very next generation (bench case)', async () => {
        await started();
        await env.reply(CALM);
        await env.send('Хорошо.');
        expect(env.service().scene()?.type).toBe('dialogue');
        await env.reply(CALM);
        const flags = await env.send('Я выхватываю меч и бросаюсь на бандитов!');
        expect(flags).toMatchObject({ maestro_scene_combat: '1', maestro_reply_short: '1' });
        expect(env.service().scene()).toMatchObject({ type: 'combat', by: 'rules', fromUserMessage: true, held: 1 });
        expect(env.service().scene()!.confidence).toBeGreaterThanOrEqual(0.85);
        await env.reply(CALM);
        const next = await env.send('Бой продолжается, я отбиваю удар.');
        expect(next.maestro_scene_combat).toBe('1');
        expect(env.service().scene()).toMatchObject({ type: 'combat', held: 2, fromUserMessage: true });
    });

    it('English cues: an attack, then a time skip', async () => {
        await started();
        await env.reply('"How was your day?" she asked, pouring tea. "Not bad," he said.');
        const attack = await env.send('I draw my sword and attack the bandits!');
        expect(attack.maestro_scene_combat).toBe('1');
        await env.reply('"Careful!" she said, stepping back.');
        const skip = await env.send('The next morning, we leave the village.');
        expect(skip.maestro_scene_timeskip).toBe('1');
        expect(env.service().scene()).toMatchObject({ type: 'timeskip', fromUserMessage: true });
    });

    it('a kiss sets an intimate scene, explicit words in the message count for the explicit flag', async () => {
        await started();
        await env.reply(CALM);
        expect((await env.send('Целую её.')).maestro_scene_intimate).toBe('1');
        await env.reply(CALM);
        const explicit = await env.send('Она уже голая, и я снимаю с неё последнее.');
        expect(explicit).toMatchObject({ maestro_scene_intimate: '1', maestro_explicit: '1' });
    });

    it('a weak cue does not override a strong reading of the reply', async () => {
        await started();
        await env.reply(HARD_COMBAT);
        const flags = await env.send('Обнимаю её за плечи.');
        expect(flags.maestro_scene_combat).toBe('1');
        expect(env.service().scene()?.fromUserMessage).toBeUndefined();
    });

    it('weight 0 ignores the message; a sheet command is never a cue', async () => {
        env.settings().userWeight = 0;
        await started();
        await env.reply(CALM);
        expect((await env.send('Я выхватываю меч и атакую!')).maestro_scene_dialogue).toBe('1');
        env.settings().userWeight = 0.6;
        await env.reply(CALM);
        await env.send('!fullsheet Лиза атакую');
        expect(env.service().scene()).toMatchObject({ type: 'dialogue' });
    });

    it('a reply committed without a draft takes the cue too (from the next generation)', async () => {
        await started();
        await env.reply(CALM);
        await env.send('…');
        env.mock.chat.push(trackerMessage(CALM));
        await env.send('Атакую его!', { end: false });
        await env.end();
        expect(env.service().scene()).toMatchObject({ type: 'combat', fromUserMessage: true });
    });
});

describe('M13 director: module', () => {
    it('registers its tab, style, producer and API and releases them', async () => {
        const disposers: (() => void | Promise<void>)[] = [];
        await directorModule.init({
            app: env.app,
            settings: env.settings(),
            log: env.app.log,
            own: (dispose) => disposers.push(dispose),
        });
        expect(env.modules.api<DirectorApi>('director')).toBeDefined();
        expect(env.ui.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['director', 'm13.tab', 55]]);
        expect(env.ui.styles.has('maestro-m13')).toBe(true);
        expect(env.tasks.runners.has('director.scene')).toBe(true);
        for (const dispose of disposers.reverse()) await dispose();
        expect(env.ui.tabs).toEqual([]);
        expect(env.tasks.runners.size).toBe(0);
        await env.reply(HARD_COMBAT);
        expect(await env.send('…')).toEqual({});
        expect(directorModule).toMatchObject({ id: 'M13', key: 'director', stage: 8, enabledByDefault: true });
    });
});
