import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
    byDue,
    CALENDAR_STRINGS,
    calendarModule,
    clockAt,
    emptyCalendarDoc,
    lastCommittedIndex,
    normaliseCalendarDoc,
    readCalendarSettings,
} from '../../../src/features/calendar';
import type { CalendarDoc, StoredPromise } from '../../../src/features/calendar';
import type { StoryPromise } from '../../../src/features/calendar/api';
import { message } from '../../helpers/st-mock';
import { createCalendarEnv, fakeWorld, INTAKE, reply, SETTLE, userMessage } from './helpers';
import type { CalendarEnv } from './helpers';

let env: CalendarEnv;

beforeEach(() => {
    vi.useFakeTimers();
    env = createCalendarEnv();
    env.modules.expose(
        'world',
        fakeWorld([
            { name: 'Anna', aliases: ['Анна'] },
            { name: 'Boris', aliases: ['Борис'] },
            { name: 'Алекс', kind: 'persona' },
        ]),
    );
    env.mock.context.name1 = 'Алекс';
    env.mock.context.name2 = 'Anna';
});

afterEach(async () => {
    await env.stop();
    vi.useRealTimers();
});

const SWORD = 'Anna promised to return the sword to Boris by sunset.';
const SWORD_QUOTE = '«Верну меч к закату», — сказала Анна.';

describe('module', () => {
    it('registers the tab, the style and the API', async () => {
        await env.start();
        expect(calendarModule).toMatchObject({ id: 'M17', key: 'calendar', stage: 9, titleKey: 'm17.title' });
        expect(env.ui.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['calendar', 'm17.tab', 58]]);
        expect(env.ui.styles.has('maestro-m17')).toBe(true);
        const api = env.service();
        for (const name of ['now', 'promises', 'add', 'setStatus', 'due', 'onChange', 'intake', 'momentAt'] as const) {
            expect(typeof api[name]).toBe('function');
        }
        await env.stop();
        expect(env.ui.tabs).toEqual([]);
        expect(env.ui.styles.size).toBe(0);
        expect(env.revision.runListeners.size + env.revision.changeListeners.size).toBe(0);
    });

    it('has the same keys in both languages', () => {
        expect(Object.keys(CALENDAR_STRINGS.ru).sort()).toEqual(Object.keys(CALENDAR_STRINGS.en).sort());
        expect(Object.keys(CALENDAR_STRINGS.en).every((key) => key.startsWith('m17.'))).toBe(true);
    });

    it('repairs its settings slice', () => {
        expect(readCalendarSettings({})).toEqual({ overdueDays: 1, overdueTurns: 10 });
        expect(readCalendarSettings({ overdueDays: 99, overdueTurns: -3 })).toEqual({
            overdueDays: 30,
            overdueTurns: 0,
        });
        expect(readCalendarSettings({ overdueDays: 2.6, overdueTurns: 'x' as never })).toEqual({
            overdueDays: 3,
            overdueTurns: 10,
        });
    });
});

describe('story time', () => {
    it('follows the DES date and time of committed replies', async () => {
        const service = await env.start();
        expect(service.now()).toBeNull();
        const first = await env.turn({ date: 'Day 1', start: '10:00' });
        expect(service.now()).toEqual({ label: 'Day 1', day: 1, minutes: 600 });
        await env.turn({ date: 'Day 1', start: '18:00', end: '18:30' });
        expect(service.now()).toEqual({ label: 'Day 1', day: 1, minutes: 18 * 60 + 30 });
        expect(service.clock()).toMatchObject({ time: '18:00–18:30' });
        const third = await env.turn({ date: 'Day 2', start: '08:00' });
        expect(service.now()).toMatchObject({ day: 2, minutes: 480 });
        expect(service.momentAt(first)).toEqual({ label: 'Day 1', day: 1, minutes: 600 });
        expect(service.momentAt(third)).toMatchObject({ day: 2 });
        expect(service.momentAt(-1)).toBeNull();
    });

    it('counts days of a fantasy calendar and of a clock without a date', async () => {
        const service = await env.start();
        await env.turn({ date: '12 Зимня', start: '08:00' });
        await env.turn({ date: '12 Зимня', start: '22:00' });
        await env.turn({ date: '13 Зимня', start: '07:00' });
        expect(service.now()).toMatchObject({ label: '13 Зимня', day: 2 });
        await env.turn({ date: 'Праздник Весны', start: '12:00' });
        expect(service.now()).toMatchObject({ day: 3 });
        await env.turn({ date: 'Праздник Весны', start: '23:30' });
        await env.turn({ date: 'Праздник Весны', start: '06:00' });
        expect(service.now()).toMatchObject({ day: 3 });
    });

    it('catches up with a chat that was played before', async () => {
        env.mock.chat.push(reply({ date: 'Day 4', start: '09:00' }), userMessage());
        env.mock.chat.push(message('A picture', { extra: { nai_studio: {} } }), userMessage());
        env.mock.chat.push(reply({ date: 'Day 5', start: '09:00' }), userMessage(), reply({ date: 'Day 9' }));
        const service = await env.start();
        // The last reply is not committed yet (no user message after it).
        expect(service.now()).toMatchObject({ day: 5 });
        expect(service.momentAt(0)).toMatchObject({ day: 4 });
        expect(env.signals).toEqual([]);
    });

    it('keeps the clock across restarts and per chat', async () => {
        await env.start();
        await env.turn({ date: 'Day 6' });
        await env.stop();
        const service = await env.start();
        expect(service.now()).toMatchObject({ day: 6 });
        const chat1 = env.mock.chat;
        const changes: number[] = [];
        service.onChange(() => changes.push(1));
        await env.switchTo('chat-2', [reply({ date: 'Day 40' }), userMessage()]);
        expect(changes.length).toBeGreaterThan(0);
        expect(service.now()).toMatchObject({ day: 40 });
        await env.switchTo('chat-1', chat1);
        expect(service.now()).toMatchObject({ day: 6 });
        await env.switchTo(undefined);
        expect(service.now()).toBeNull();
        expect(service.promises()).toEqual([]);
        expect(service.due()).toEqual([]);
    });

    it('rolls back when an earlier reply is committed again or a committed one is deleted', async () => {
        const service = await env.start();
        const first = await env.turn({ date: 'Day 1' });
        await env.turn({ date: 'Day 2' });
        await env.turn({ date: 'Day 3' });
        env.mock.chat.splice(first + 2);
        env.mock.chat.push(userMessage());
        await env.app.bus.emit('turn:committed', { messageIndex: first });
        await env.tick(SETTLE);
        expect(service.now()).toMatchObject({ day: 1 });
        await env.turn({ date: 'Day 2' });
        expect(service.now()).toMatchObject({ day: 2 });
        await env.app.bus.emit('message:invalidated', { messageIndex: first + 2, reason: 'deleted' });
        await env.tick(50);
        expect(service.now()).toMatchObject({ day: 1 });
        await env.app.bus.emit('message:invalidated', { messageIndex: first, reason: 'edited' });
        await env.tick(50);
        expect(service.now()).toMatchObject({ day: 1 });
    });

    it('works only in the leader tab and catches up when it becomes the leader', async () => {
        env.leader.value = false;
        const service = await env.start();
        await env.turn({ date: 'Day 2' });
        expect(service.now()).toBeNull();
        env.revision.card(SWORD, SWORD_QUOTE, 0);
        env.revision.finish();
        await env.tick(INTAKE);
        expect(env.revision.dismissed).toEqual([]);
        env.leader.value = true;
        await env.app.bus.emit('leader:changed', { leader: true });
        await env.tick(50);
        expect(service.now()).toMatchObject({ day: 2 });
        expect(env.revision.dismissed).toEqual(['def-1']);
        await env.app.bus.emit('leader:changed', { leader: false });
    });

    it('reads nothing on the send itself', async () => {
        const service = await env.start();
        env.mock.chat.push(reply({ date: 'Day 3' }), userMessage());
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        expect(service.now()).toBeNull();
        await env.tick(SETTLE);
        expect(service.now()).toMatchObject({ day: 3 });
    });
});

describe('deferred cards', () => {
    it('turns the backlog into promises and dismisses the cards', async () => {
        const index = (env.mock.chat.push(reply({ date: 'Day 1', start: '10:00' }), userMessage()), 0);
        env.revision.card(SWORD, SWORD_QUOTE, index);
        env.revision.card('Boris learned the secret.', 'Он знает.', index, 'Boris', 'deferred.secret');
        const service = await env.start();
        expect(env.revision.dismissed).toEqual(['def-1']);
        expect(env.revision.cards.map((card) => card.target)).toEqual(['deferred.secret']);
        const [promise] = service.promises();
        expect(promise).toMatchObject({
            who: ['Anna'],
            toWhom: ['Boris'],
            what: SWORD,
            quote: SWORD_QUOTE,
            due: { label: 'by sunset', day: 1, minutes: 19 * 60 },
            status: 'open',
            sourceMessage: index,
        });
        expect(service.stored()[0]).toMatchObject({ origin: 'revision', cardId: 'def-1' });
        expect(service.due()).toEqual([]);
    });

    it('takes cards after a revision run and does not take a card twice', async () => {
        const service = await env.start();
        const index = await env.turn({ date: 'Day 1', start: '10:00' });
        const card = env.revision.card('Promised to bring the map tomorrow.', '«Принесу завтра»', index, 'Борис');
        env.revision.finish();
        await env.tick(INTAKE);
        expect(service.promises()).toMatchObject([
            { who: ['Boris'], toWhom: ['Алекс'], due: { label: 'tomorrow', day: 2 }, status: 'open' },
        ]);
        // A card that came back (its dismissal was lost) is dismissed again, not taken twice.
        env.revision.cards.push({ ...card, value: 'Promised to bring a different map.' });
        for (const listener of env.revision.changeListeners) listener();
        await env.tick(INTAKE);
        expect(service.promises()).toHaveLength(1);
        expect(env.revision.dismissed).toEqual(['def-1', 'def-1']);
    });

    it('places the deadline in the story time of its own message', async () => {
        const service = await env.start();
        const first = await env.turn({ date: 'Day 1', start: '10:00' });
        await env.turn({ date: 'Day 3', start: '10:00' });
        env.revision.card('Promised to pay Boris back by tomorrow.', 'Завтра отдам.', first);
        env.revision.card('Promised to visit the mill in a week.', 'Через неделю зайду.', first);
        env.revision.finish();
        await env.tick(INTAKE);
        const list = service.promises();
        expect(list.map((item) => [item.due?.day, item.status])).toEqual([
            [2, 'overdue'],
            [8, 'open'],
        ]);
        expect(env.signals.map((signal) => signal.kind)).toEqual(['promise.overdue']);
    });

    it('closes a known promise from an outcome statement and ignores unknown outcomes', async () => {
        const service = await env.start();
        const index = await env.turn({ date: 'Day 1', start: '10:00' });
        env.revision.card(SWORD, SWORD_QUOTE, index);
        env.revision.finish();
        await env.tick(INTAKE);
        env.revision.card('Anna kept her promise and returned the sword to Boris.', 'Вот твой меч.', index + 2);
        env.revision.card('Boris broke his oath to the king.', 'Не приду.', index + 2, 'Boris');
        env.revision.finish();
        await env.tick(INTAKE);
        expect(service.promises().map((item) => item.status)).toEqual(['done']);
        expect(env.revision.dismissed).toEqual(['def-1', 'def-2', 'def-3']);
    });

    it('accepts statements directly from the revision route', async () => {
        const service = await env.start();
        const index = await env.turn({ date: 'Day 1', start: '10:00' });
        const id = await service.intake({
            entityName: 'Анна',
            value: SWORD,
            evidence: SWORD_QUOTE,
            sourceMessage: index,
        });
        expect(id).toMatch(/^prm-/);
        const again = await service.intake({
            entityName: 'Anna',
            value: 'Anna will return the sword to Boris by sunset.',
            evidence: '',
            sourceMessage: index,
        });
        expect(again).toBe(id);
        expect(await service.intake({ entityName: 'Anna', value: '', evidence: '', sourceMessage: index })).toBeNull();
        expect(
            await service.intake({
                entityName: 'Clara',
                value: 'Clara kept her promise.',
                evidence: '',
                sourceMessage: 1,
            }),
        ).toBeNull();
        expect(service.promises()).toHaveLength(1);
        await env.switchTo(undefined);
        expect(await service.intake({ entityName: 'Anna', value: SWORD, evidence: '', sourceMessage: 0 })).toBeNull();
    });

    it('reads the addressee from the persona and defaults to the card character for the persona', async () => {
        const service = await env.start();
        await env.turn({ date: 'Day 1' });
        await service.intake({
            entityName: 'Алекс',
            value: 'Promised to find the lost cat.',
            evidence: '',
            sourceMessage: 0,
        });
        await service.intake({
            entityName: 'Boris',
            value: 'Promised {{user}} a horse.',
            evidence: '«Будет тебе конь»',
            sourceMessage: 0,
        });
        expect(service.promises().map((item) => [item.who, item.toWhom])).toEqual([
            [['Алекс'], ['Anna']],
            [['Boris'], ['Алекс']],
        ]);
    });
});

describe('statuses', () => {
    it('comes due, shows in due() for one turn, then runs late after a story day', async () => {
        const service = await env.start();
        const index = await env.turn({ date: 'Day 1', start: '10:00' });
        await service.intake({ entityName: 'Anna', value: SWORD, evidence: SWORD_QUOTE, sourceMessage: index });
        await env.turn({ date: 'Day 1', start: '15:00' });
        expect(service.due()).toEqual([]);
        await env.turn({ date: 'Day 1', start: '19:30' });
        expect(service.due()).toMatchObject([{ what: SWORD, status: 'due' }]);
        expect(env.signals).toMatchObject([
            {
                kind: 'promise.due',
                chatId: 'chat-1',
                entity: 'Anna',
                data: { what: SWORD, who: ['Anna'], source: 'calendar' },
            },
        ]);
        await env.turn({ date: 'Day 1', start: '21:00' });
        expect(service.due()).toEqual([]);
        expect(service.promises({ status: 'due' })).toHaveLength(1);
        await env.turn({ date: 'Day 2', start: '19:30' });
        expect(service.promises({ status: 'overdue' })).toHaveLength(1);
        expect(env.signals.map((signal) => signal.kind)).toEqual(['promise.due', 'promise.overdue']);
    });

    it('runs late by turns', async () => {
        env.slices.calendar = { overdueDays: 0, overdueTurns: 2 };
        const service = await env.start();
        await env.turn({ date: 'Day 1', start: '10:00' });
        await service.add({
            who: ['Anna'],
            toWhom: [],
            what: 'Feed the horse',
            quote: '',
            due: { label: 'now', day: 1 },
            sourceMessage: -1,
        });
        expect(service.due()).toHaveLength(1);
        await env.turn({ date: 'Day 1', start: '11:00' });
        expect(service.promises()[0]?.status).toBe('due');
        await env.turn({ date: 'Day 1', start: '12:00' });
        expect(service.promises()[0]?.status).toBe('overdue');
    });

    it('lets the user close, reopen and mark promises', async () => {
        const service = await env.start();
        await env.turn({ date: 'Day 3', start: '10:00' });
        const id = await service.add({
            who: ['Anna'],
            toWhom: ['Boris'],
            what: 'Return the sword',
            quote: '«Верну»',
            due: { label: 'Day 2', day: 2 },
            sourceMessage: 0,
        });
        expect(service.promises()[0]?.status).toBe('overdue');
        await service.setStatus(id, 'done');
        expect(service.promises()[0]?.status).toBe('done');
        expect(service.stored()[0]?.closedAt).toBeTypeOf('number');
        await service.setStatus(id, 'open');
        expect(service.promises()[0]?.status).toBe('overdue');
        await service.setStatus(id, 'broken');
        await service.setStatus(id, 'cancelled');
        expect(service.promises({ status: 'cancelled' })).toHaveLength(1);
        const loose = await service.add({
            who: [],
            toWhom: [],
            what: 'Someday',
            quote: '',
            due: null,
            sourceMessage: -1,
        });
        await service.setStatus(loose, 'due');
        expect(service.promises({ status: 'due' }).map((item) => item.id)).toEqual([loose]);
        await service.setStatus('missing', 'done');
        await expect(service.setStatus(id, 'lost' as never)).rejects.toThrow('unknown status');
    });

    it('rejects an empty promise and needs a chat', async () => {
        const service = await env.start();
        await expect(
            service.add({ who: [], toWhom: [], what: ' ', quote: '', due: null, sourceMessage: 0 }),
        ).rejects.toThrow('Write what was promised.');
        await env.switchTo(undefined);
        await expect(
            service.add({ who: [], toWhom: [], what: 'x', quote: '', due: null, sourceMessage: 0 }),
        ).rejects.toThrow('Open a chat first.');
        await expect(service.addManual({ who: '', toWhom: '', what: 'x', when: '', quote: '' })).rejects.toThrow(
            'Open a chat first.',
        );
        await expect(service.addManual({ who: '', toWhom: '', what: '', when: '', quote: '' })).rejects.toThrow(
            'Write what was promised.',
        );
    });

    it('adds by hand with a typed deadline', async () => {
        const service = await env.start();
        await env.turn({ date: '12 Зимня', start: '10:00' });
        await service.addManual({
            who: 'Анна, Борис',
            toWhom: 'Алекс',
            what: 'Build a raft',
            when: 'через два дня',
            quote: '',
        });
        await service.addManual({ who: 'Борис', toWhom: '', what: 'Bake bread', when: '15 Зимня', quote: 'Испеку' });
        await service.addManual({ who: '', toWhom: '', what: 'Find the bard', when: 'к празднику', quote: '' });
        await service.addManual({ who: '', toWhom: '', what: 'Sing', when: '', quote: '' });
        expect(service.stored().map((item) => [item.who, item.due, item.origin, item.sourceMessage])).toEqual([
            [['Анна', 'Борис'], { label: 'через два дня', day: 3 }, 'user', -1],
            [['Борис'], { label: '15 Зимня', day: 4 }, 'user', -1],
            [[], { label: 'к празднику', day: null }, 'user', -1],
            [[], null, 'user', -1],
        ]);
    });

    it('drops revision promises of a swiped or deleted message, keeps them on an edit', async () => {
        const service = await env.start();
        const index = await env.turn({ date: 'Day 1' });
        await service.intake({ entityName: 'Anna', value: SWORD, evidence: '', sourceMessage: index });
        await service.add({ who: ['Boris'], toWhom: [], what: 'Mine', quote: '', due: null, sourceMessage: index });
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'edited' });
        await env.tick(50);
        expect(service.promises()).toHaveLength(2);
        await env.app.bus.emit('message:invalidated', { messageIndex: index + 5, reason: 'swiped' });
        await env.tick(50);
        expect(service.promises()).toHaveLength(2);
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'swiped' });
        await env.tick(50);
        expect(service.promises().map((item) => item.what)).toEqual(['Mine']);
    });

    it('notifies listeners', async () => {
        const service = await env.start();
        const seen: number[] = [];
        const off = service.onChange(() => seen.push(1));
        await env.turn({ date: 'Day 1' });
        expect(seen.length).toBeGreaterThan(0);
        off();
        const count = seen.length;
        await env.turn({ date: 'Day 2' });
        expect(seen.length).toBe(count);
    });
});

describe('document helpers', () => {
    it('repairs a stored document', () => {
        const doc = normaliseCalendarDoc({
            clock: { label: 1 },
            history: [{ index: 1, clock: { label: 'Day 1', day: 1 } }, { index: 'x' }],
            lastIndex: 'x',
            turn: null,
            taken: ['a', 3],
            promises: [
                {
                    id: 'p',
                    what: 'w',
                    who: ['A', 3],
                    toWhom: 'B',
                    due: { label: 'x', day: 'y' },
                    status: 'lost',
                    origin: 'z',
                },
                { id: 3 },
            ],
        } as unknown as CalendarDoc);
        expect(doc).toMatchObject({
            clock: null,
            history: [{ index: 1 }],
            lastIndex: -1,
            turn: 0,
            taken: ['a'],
            promises: [
                {
                    id: 'p',
                    who: ['A'],
                    toWhom: [],
                    quote: '',
                    due: null,
                    status: 'open',
                    sourceMessage: -1,
                    origin: 'api',
                },
            ],
        });
        expect(normaliseCalendarDoc({} as CalendarDoc)).toEqual(emptyCalendarDoc());
    });

    it('finds the clock of a message', () => {
        const history = [
            { index: 2, clock: { label: 'Day 1', day: 1 } },
            { index: 6, clock: { label: 'Day 2', day: 2 } },
        ];
        expect(clockAt(history, 1)).toBeNull();
        expect(clockAt(history, 1, true)?.day).toBe(1);
        expect(clockAt(history, 5)?.day).toBe(1);
        expect(clockAt(history, 9)?.day).toBe(2);
        expect(clockAt([], 9, true)).toBeNull();
    });

    it('finds the last committed reply', () => {
        expect(lastCommittedIndex([])).toBe(-1);
        expect(lastCommittedIndex([reply(), userMessage(), reply()])).toBe(0);
        expect(lastCommittedIndex([reply(), message('sys', { is_system: true }), userMessage()])).toBe(0);
    });

    it('orders by deadline', () => {
        const item = (day: number | null, minutes?: number, createdAt = 0): StoryPromise => ({
            id: '',
            who: [],
            toWhom: [],
            what: '',
            quote: '',
            due: day === null ? null : { label: '', day, ...(minutes === undefined ? {} : { minutes }) },
            status: 'open',
            sourceMessage: 0,
            createdAt,
        });
        const list = [item(null), item(3, 600), item(3, 60), item(1), item(null, undefined, -1)];
        expect(list.sort(byDue).map((p) => [p.due?.day ?? null, p.due?.minutes ?? null])).toEqual([
            [1, null],
            [3, 60],
            [3, 600],
            [null, null],
            [null, null],
        ]);
        const stored: StoredPromise = { ...item(1), origin: 'user' };
        expect(stored.origin).toBe('user');
    });
});
