import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costFileName } from '../../../src/core/cost';
import { dayKey } from '../../../src/domain/treasurer-spend';
import type { TreasurerDoc } from '../../../src/domain/treasurer-spend';
import { MODE_TARGET, TREASURER_DOC_KIND, treasurerModule } from '../../../src/features/treasurer';
import type {
    SpendLine,
    SpendSource,
    TreasurerApi,
    TreasurerService,
    TreasurerSettings,
    TurnSpend,
} from '../../../src/features/treasurer';
import { changeChat } from '../../helpers/lore-app';
import { chatMessage, createTreasurerStand, userMessage, wait } from './treasurer-app';
import type { TreasurerStand } from './treasurer-app';

const DAY = 24 * 60 * 60 * 1000;

let env: TreasurerStand;
let service: TreasurerService;
let settings: TreasurerSettings;
let stop: () => void;

const chat = () => env.stand.mock.chat;
const step = (ms = 1000) => {
    env.wall.value += ms;
};
const line = (lines: readonly SpendLine[] | undefined, source: SpendSource) =>
    lines?.find((item) => item.source === source);
const turnAt = (index: number): TurnSpend | undefined => service.turns().find((turn) => turn.messageIndex === index);
const usdOf = (index: number, source: SpendSource) => line(turnAt(index)?.lines, source)?.usd ?? 0;
const round = (value: number) => Math.round(value * 1e6) / 1e6;

async function start(): Promise<void> {
    env = createTreasurerStand();
    chat().push(chatMessage('Greeting'));
    ({ service, settings, stop } = env.makeService());
    await wait();
}

/** The user writes, the main model answers (entry recorded before or after reply:ready). */
async function normalTurn(usd = 0.01, options: { entryAfterReply?: boolean; during?: () => void } = {}) {
    chat().push(userMessage('…'));
    step();
    await env.begin('normal');
    step();
    const entry = () => env.record({ source: 'main', task: 'normal', usd, tokens: { prompt: 1000, completion: 200 } });
    if (!options.entryAfterReply) entry();
    options.during?.();
    step();
    const index = chat().length;
    await env.reply(index, chatMessage(`Reply ${index}`));
    await env.ended();
    if (options.entryAfterReply) entry();
    service.process();
    return index;
}

/** A redo of the last reply (swipe, regenerate or continue). */
async function redo(index: number, type: string, usd: number) {
    await env.begin(type);
    step();
    env.record({ source: 'main', task: type, usd, tokens: { prompt: 1000, completion: 200 } });
    step();
    await env.reply(index);
    await env.ended();
    service.process();
}

beforeEach(start);
afterEach(() => stop());

describe('M21 turn attribution', () => {
    it('books the main generation on its reply, whichever comes first', async () => {
        const first = await normalTurn(0.01);
        const second = await normalTurn(0.02, { entryAfterReply: true });
        expect([first, second]).toEqual([2, 4]);
        expect(usdOf(2, 'main')).toBe(0.01);
        expect(usdOf(4, 'main')).toBe(0.02);
        expect(line(turnAt(4)?.lines, 'main')).toMatchObject({
            requests: 1,
            tokens: { prompt: 1000, completion: 200 },
            estimated: false,
        });
        expect(service.turns().map((turn) => turn.messageIndex)).toEqual([2, 4]);
        expect(service.turns(1).map((turn) => turn.messageIndex)).toEqual([4]);
    });

    it('tells user regenerations, auto-swipes and continues apart', async () => {
        const index = await normalTurn(0.01);
        await redo(index, 'swipe', 0.02);
        await redo(index, 'regenerate', 0.04);
        service.noteAutoSwipe();
        await redo(index, 'swipe', 0.03);
        await redo(index, 'continue', 0.005);
        expect(round(usdOf(index, 'main'))).toBe(0.015);
        expect(round(usdOf(index, 'regeneration'))).toBe(0.06);
        expect(usdOf(index, 'autoSwipe')).toBe(0.03);
        expect(line(turnAt(index)?.lines, 'regeneration')?.requests).toBe(2);
    });

    it("falls back to M12's verdicts to recognise an auto-swipe", async () => {
        const index = await normalTurn();
        env.verdict(index, 'swiped');
        await redo(index, 'swipe', 0.03);
        expect(usdOf(index, 'autoSwipe')).toBe(0.03);

        // The swipe was refused or queued: the next swipe is the user's.
        env.verdict(index, 'swiped');
        env.verdict(index, 'notified');
        await redo(index, 'swipe', 0.02);
        expect(usdOf(index, 'regeneration')).toBe(0.02);

        // A note that waited too long is dropped; a quiet generation does not consume it.
        service.noteAutoSwipe();
        step(3 * 60_000);
        await env.begin('quiet', true);
        await redo(index, 'swipe', 0.01);
        expect(round(usdOf(index, 'regeneration'))).toBe(0.03);
        expect(usdOf(index, 'autoSwipe')).toBe(0.03);
    });

    it('puts background spend into the turn during which it ran', async () => {
        const first = await normalTurn();
        // Between turns: the latest reply.
        env.record({ source: 'qvink', usd: 0.002 });
        const second = await normalTurn(0.01, {
            during: () => {
                env.record({ source: 'maestro', task: 'revision', usd: 0.003 });
                env.record({ source: 'nai', usd: 0.001 });
            },
        });
        // After the reply, before the next turn: still the second turn.
        step();
        env.record({ source: 'maestro', task: 'living.extract', usd: 0.004, estimated: true });
        env.record({ source: 'other', usd: 0.0005 });
        env.record({ source: 'main', task: 'quiet', usd: 0.0007 });
        service.process();
        expect(usdOf(first, 'qvink')).toBe(0.002);
        expect(round(usdOf(second, 'maestro'))).toBe(0.007);
        expect(line(turnAt(second)?.lines, 'maestro')?.estimated).toBe(true);
        expect(usdOf(second, 'nai')).toBe(0.001);
        expect(round(usdOf(second, 'other'))).toBe(0.0012);
        // Other chats' entries are not this chat's turns.
        env.record({ source: 'qvink', usd: 1, chatId: 'elsewhere' });
        service.process();
        expect(usdOf(second, 'qvink')).toBe(0);
    });

    it('books a generation without a reply (impersonate, stopped) on the current turn after the grace', async () => {
        const index = await normalTurn();
        await env.begin('impersonate');
        step(10);
        env.record({ source: 'main', task: 'impersonate', usd: 0.006 });
        await env.ended();
        service.process();
        expect(usdOf(index, 'main')).toBe(0.01);
        // The settle timer runs a little after the grace (100 ms here).
        step(500);
        await wait(250);
        expect(round(usdOf(index, 'main'))).toBe(0.016);
    });

    it('takes new meter entries shortly after the meter changes', async () => {
        stop();
        ({ service, stop } = env.makeService({ ingestDelayMs: 5 }));
        await wait();
        env.record({ source: 'qvink', usd: 0.002 });
        env.record({ source: 'qvink', usd: 0.003 });
        expect(service.summary('session').totalUsd).toBe(0);
        await wait(30);
        expect(line(service.summary('session').lines, 'qvink')).toMatchObject({ usd: 0.005, requests: 2 });
        expect(usdOf(0, 'qvink')).toBe(0.005);
    });

    it('saves the turns per chat, replays unsaved changes over another tab’s copy, keeps chats apart', async () => {
        const index = await normalTurn(0.01);
        await service.flush();
        let doc = env.stand.chat.doc<TreasurerDoc>('chat-1', TREASURER_DOC_KIND)!;
        expect(doc.turns.map((turn) => turn.messageIndex)).toEqual([index]);

        // Another tab wrote a newer copy: what this tab saved plus a turn of its own.
        const other = structuredClone(doc);
        other.turns.unshift({
            messageIndex: 0,
            at: 1,
            last: 1,
            lines: { qvink: { ...doc.turns[0]!.lines.main!, usd: 0.5 } },
        });
        env.record({ source: 'qvink', usd: 0.002 });
        service.process();
        env.stand.chat.docs.set(`chat-1\u0000${TREASURER_DOC_KIND}`, other);
        env.stand.chat.conflicts = 1;
        await service.flush();
        doc = env.stand.chat.doc<TreasurerDoc>('chat-1', TREASURER_DOC_KIND)!;
        expect(doc).toBe(other);
        expect(doc.turns.map((turn) => turn.messageIndex)).toEqual([0, index]);
        expect(doc.turns[1]!.lines.qvink?.usd).toBe(0.002);

        // A generation waiting for its reply when the chat changes stays in the old chat.
        chat().push(userMessage('…'));
        await env.begin('normal');
        env.record({ source: 'main', task: 'normal', usd: 0.05 });
        env.stand.mock.chat = [chatMessage('Hello from chat 2')];
        await changeChat(env.stand, 'chat-2');
        await wait();
        await service.flush();
        expect(
            round(env.stand.chat.doc<TreasurerDoc>('chat-1', TREASURER_DOC_KIND)!.turns[1]!.lines.main?.usd ?? 0),
        ).toBe(0.06);
        expect(service.turns()).toEqual([]);
        await normalTurn(0.07);
        expect(service.turns().map((turn) => turn.messageIndex)).toEqual([2]);
    });
});

describe('M21 NAI Anlas', () => {
    const created = (offset: number) => new Date(env.wall.value + offset).toISOString();
    const inlineImage = (id: string, cost: number, at: string, swipes = 1) => ({
        id,
        blobKey: '',
        meta: {},
        swipes: Array.from({ length: swipes }, (_, seed) => ({
            blobKey: `b${seed}`,
            filePath: '',
            mime: 'image/png',
            meta: { cost, createdAt: at, seed, model: 'nai-diffusion-4-5-full', transport: 'plugin' },
        })),
        activeSwipe: 0,
        display: {},
        marker: { params: {}, status: 'done' },
    });
    const post = (cost: number, correlationId: string, isUser = false) =>
        chatMessage('a forest road', {
            is_user: isUser,
            send_date: new Date(env.wall.value).toISOString(),
            extra: {
                media: [
                    {
                        url: `/user/images/${correlationId}.png`,
                        type: 'image',
                        title: 'a forest road',
                        nai_studio: { model: 'm', prompt: 'p', transport: 'plugin', cost, correlationId },
                    } as STMediaAttachment,
                ],
                media_display: 'gallery',
                nai_studio: { model: 'm', seed: 1, mode: 0, transport: 'plugin', cost },
            },
        });
    const anlasOf = (index: number) => line(turnAt(index)?.lines, 'nai')?.anlas ?? 0;

    it('adds inline pictures NAI Studio reports, once per generation batch', async () => {
        const index = await normalTurn();
        step();
        chat()[index]!.extra = { nai_images: [inlineImage('img-aaaaaa', 12, created(0), 2)] };
        env.imageReady(index, 'marker');
        env.imageReady(index, 'marker');
        expect(env.recent.filter((entry) => entry.anlas !== undefined).map((entry) => entry.anlas)).toEqual([12]);
        expect(anlasOf(index)).toBe(12);
        await service.flush();
        expect(env.stand.chat.doc<TreasurerDoc>('chat-1', TREASURER_DOC_KIND)!.anlasKeys).toEqual([
            `inline|img-aaaaaa|${created(0)}`,
        ]);

        // After a reload the same picture is history: counted keys survive, older pictures are not new.
        stop();
        chat()[index]!.extra = {
            nai_images: [inlineImage('img-aaaaaa', 12, created(0), 2), inlineImage('img-old000', 5, created(-DAY))],
        };
        step();
        ({ service, stop } = env.makeService());
        await wait();
        expect(env.recent.filter((entry) => entry.anlas !== undefined)).toHaveLength(1);
        expect(anlasOf(index)).toBe(12);
    });

    it('routes the Anlas the core counted for a late picture post to the turn it illustrates', async () => {
        const index = await normalTurn();
        // The next turn is generating when NAI Studio posts the picture for the previous reply.
        chat().push(userMessage('…'));
        await env.begin('normal');
        step();
        const postIndex = chat().length;
        chat().push(post(20, 'batch-1'));
        // The core meter counts the post in its own reply:ready listener, which runs first.
        env.record({ source: 'nai', usd: 0, anlas: 20 });
        await env.reply(postIndex);
        env.imageReady(postIndex, 'message');
        env.record({ source: 'main', task: 'normal', usd: 0.01 });
        const next = chat().length;
        await env.reply(next, chatMessage('Next reply'));
        await env.ended();
        service.process();
        expect(anlasOf(index)).toBe(20);
        expect(anlasOf(next)).toBe(0);
        expect(env.recent.filter((entry) => entry.anlas !== undefined)).toHaveLength(1);

        // An image overswipe appends a batch without a render: the treasurer adds it.
        step();
        const media = chat()[postIndex]!.extra!.media!;
        media.push({
            ...media[0]!,
            url: '/user/images/batch-2.png',
            nai_studio: { cost: 6, correlationId: 'batch-2' },
        } as STMediaAttachment);
        env.imageReady(postIndex, 'swipe');
        expect(anlasOf(index)).toBe(26);
        expect(env.recent.filter((entry) => entry.anlas !== undefined).map((entry) => entry.anlas)).toEqual([20, 6]);
    });

    it('adds a picture NAI Studio posted as the user (no reply:ready, the core misses it)', async () => {
        const index = await normalTurn();
        const postIndex = chat().length;
        chat().push(post(9, 'user-batch', true));
        env.imageReady(postIndex, 'message');
        expect(anlasOf(index)).toBe(9);
    });

    it('finds new inline pictures after the next reply when NAI Studio sends no events', async () => {
        stop();
        env.naiApi.value = undefined;
        ({ service, stop } = env.makeService());
        await wait();
        const index = await normalTurn();
        step();
        chat()[index]!.extra = { nai_images: [inlineImage('img-bbbbbb', 7, created(0))] };
        const next = await normalTurn();
        expect(anlasOf(index)).toBe(7);
        expect(anlasOf(next)).toBe(0);
    });
});

describe('M21 summaries', () => {
    it('answers for the last turn, the session and today', async () => {
        expect(service.summary('turn')).toMatchObject({ period: 'turn', totalUsd: 0, lines: [] });
        const index = await normalTurn(0.01);
        await redo(index, 'swipe', 0.02);
        service.noteAutoSwipe();
        await redo(index, 'swipe', 0.03);
        env.record({ source: 'nai', usd: 0, anlas: 15 });
        service.process();

        const turn = service.summary('turn');
        expect(round(turn.totalUsd)).toBe(0.06);
        expect(turn.totalAnlas).toBe(15);
        expect(turn.lines.map((item) => item.source)).toEqual(['main', 'regeneration', 'autoSwipe', 'nai']);
        expect(turn.from).toBeLessThanOrEqual(turn.to);

        const session = service.summary('session');
        expect(round(session.totalUsd)).toBe(0.06);
        expect(session.from).toBe(service.sessionStart());

        // Entries of an earlier page session today count for the day only.
        env.recent.unshift({
            source: 'main',
            task: 'normal',
            usd: 0.5,
            at: env.wall.value - 60 * 60_000,
            chatId: 'chat-1',
        });
        const day = service.summary('day');
        expect(round(day.totalUsd)).toBe(0.56);
        expect(round(line(day.lines, 'main')?.usd ?? 0)).toBe(0.51);
        expect(round(line(day.lines, 'regeneration')?.usd ?? 0)).toBe(0.02);
        expect(line(day.lines, 'autoSwipe')).toMatchObject({ usd: 0.03, requests: 1 });
        expect(day.totalAnlas).toBe(15);

        // A new chat starts a new session.
        env.stand.mock.chat = [chatMessage('Hi')];
        await changeChat(env.stand, 'chat-2');
        expect(service.summary('session')).toMatchObject({ totalUsd: 0, lines: [] });
        expect(round(service.summary('day').totalUsd)).toBe(0.56);
    });

    it('builds day history from the core meter’s day files and its own auto-swipe notes', async () => {
        const today = dayKey(env.wall.value);
        const yesterday = dayKey(env.wall.value - DAY);
        const before = dayKey(env.wall.value - 2 * DAY);
        env.files.set(costFileName(yesterday), {
            version: 1,
            date: yesterday,
            totalUsd: 1.2,
            bySource: { main: 1, maestro: 0.2 },
            byTask: { normal: 0.6, swipe: 0.4, revision: 0.2 },
            anlas: 40,
            recent: [],
        });
        env.files.set(costFileName(before), { date: 'mismatch', totalUsd: 9 });
        env.files.set(env.app.files.fileName('treasurer-days'), {
            version: 1,
            days: { [yesterday]: { usd: 0.1, requests: 1, prompt: 0, completion: 0 } },
        });
        stop();
        ({ service, stop } = env.makeService());
        await wait();

        const index = await normalTurn(0.01);
        service.noteAutoSwipe();
        await redo(index, 'swipe', 0.02);

        const days = await service.days(3);
        expect(days.map((day) => day.totalUsd)).toEqual([0, 1.2, 0.03]);
        expect(days[0]!.lines).toEqual([]);
        expect(round(line(days[1]!.lines, 'regeneration')?.usd ?? 0)).toBe(0.3);
        expect(line(days[1]!.lines, 'autoSwipe')?.usd).toBe(0.1);
        expect(days[1]!.totalAnlas).toBe(40);
        expect(line(days[2]!.lines, 'autoSwipe')?.usd).toBe(0.02);
        expect((await service.days()).length).toBe(14);
        expect((await service.days(500)).length).toBe(60);

        await service.flush();
        expect(env.files.get(env.app.files.fileName('treasurer-days'))).toMatchObject({
            days: { [yesterday]: { usd: 0.1 }, [today]: { usd: 0.02, requests: 1 } },
        });
    });
});

describe('M21 daily limit', () => {
    const fire = (action: 'warn' | 'economy' | 'stopBackground') => {
        for (const listener of [...env.limitListeners]) listener({ usd: 2.1, limit: 2, action });
    };

    it('switches to «Экономный» once a day, journals it and puts the mode back', async () => {
        fire('economy');
        expect(env.core.mode).toBe('economy');
        expect(env.settingsNotified).toContain('core.mode');
        expect(settings).toMatchObject({ limitDate: dayKey(env.wall.value), modeBeforeLimit: 'balanced' });
        expect(env.notices).toHaveLength(1);
        expect(env.notices[0]!.text).toBe(
            'The daily limit is reached ($2.10 of $2.00): I switched Maestro to Economy until tomorrow.',
        );
        expect(env.notices[0]!.options).toMatchObject({ urgent: true, level: 'warn' });
        await wait();
        expect(env.journal[0]).toMatchObject({
            module: 'M21',
            changes: [{ target: MODE_TARGET, before: 'balanced', after: 'economy' }],
        });

        // The meter fires again after a reload: nothing happens twice the same day.
        env.core.mode = 'cinema';
        fire('economy');
        expect(env.core.mode).toBe('cinema');
        expect(env.notices).toHaveLength(1);

        // The notice button only restores while «Экономный» is still on.
        env.notices[0]!.options!.action!.run();
        expect(env.core.mode).toBe('cinema');
        expect(settings.modeBeforeLimit).toBe('');
    });

    it('undoes the switch from the journal and restores the mode the next day', async () => {
        fire('economy');
        expect(
            await env.undo.get(MODE_TARGET)!(
                env.journal[0]?.changes[0] ?? { target: MODE_TARGET, ref: {}, before: 'balanced', after: 'economy' },
            ),
        ).toBe(true);
        expect(env.core.mode).toBe('balanced');
        expect(
            await env.undo.get(MODE_TARGET)!({ target: MODE_TARGET, ref: {}, before: 'weird', after: 'economy' }),
        ).toBe(false);

        // Next day: the mode the limit replaced comes back.
        settings.limitDate = '';
        step(DAY);
        fire('economy');
        expect(env.core.mode).toBe('economy');
        step(DAY);
        await env.ended();
        expect(env.core.mode).toBe('balanced');
        expect(env.notices.at(-1)?.text).toBe('A new day: I put the mode back to Balanced.');
        expect(settings.modeBeforeLimit).toBe('');
    });

    it('warns or reports stopped background work, never touching the mode', () => {
        fire('warn');
        expect(env.notices[0]!.text).toBe("Today's spend reached the daily limit: $2.10 of $2.00.");
        settings.limitDate = '';
        fire('stopBackground');
        expect(env.notices[1]!.text).toContain('I stopped my background tasks until tomorrow');
        settings.limitDate = '';
        env.core.mode = 'economy';
        fire('economy');
        expect(env.notices[2]!.text).toContain('Economy is already on');
        expect(settings.modeBeforeLimit).toBe('');
        expect(env.core.mode).toBe('economy');
    });
});

describe('M21 module', () => {
    it('exposes the API, a tab and a stylesheet, and leaves nothing behind', async () => {
        stop();
        const before = env.costListeners.size;
        const started = await env.stand.start(treasurerModule);
        const api = env.app.modules.api<TreasurerApi>('treasurer');
        expect(typeof api?.summary).toBe('function');
        expect(typeof api?.noteAutoSwipe).toBe('function');
        expect(env.stand.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['treasurer', 'm21.tab', 54]]);
        expect(env.stand.styles.has('maestro-m21')).toBe(true);
        expect(treasurerModule).toMatchObject({ id: 'M21', key: 'treasurer', stage: 7 });
        await started.stop();
        expect(env.stand.tabs).toEqual([]);
        expect(env.stand.styles.size).toBe(0);
        expect(env.costListeners.size).toBe(before);
        expect(env.limitListeners.size).toBe(0);
        expect(env.naiListeners.size).toBe(0);
        expect(env.verdictListeners.size).toBe(0);
        stop = () => {};
    });
});
