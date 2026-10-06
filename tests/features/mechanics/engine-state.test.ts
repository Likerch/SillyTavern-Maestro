// M25 state and tracking of plan-2 §6 with the ST mock: the block's statuses, items, roll requests and fight lines;
// the committed turn (the story clock from DES, time rules, statuses ticking, rollback with the reply); the user's
// character's DES stats through the background parse; statuses and items of the background parse; reset and undo;
// what the player may see of a reply's changes; factions only when named; the events emitter.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MechanicDef, MechanicsEvent } from '../../../src/features/mechanics/api';
import { CHANGE_KIND, EXTRACT_TASK } from '../../../src/features/mechanics/tracking';
import { createMechanicsEnv, healthDef, magicDef, reputationDef, userMessage } from './helpers-state';
import type { MechanicsEnv } from './helpers-state';
import { message } from '../../helpers/st-mock';

let env: MechanicsEnv;

beforeEach(async () => {
    vi.useFakeTimers();
    env = createMechanicsEnv();
});

afterEach(() => {
    env.stop();
    vi.useRealTimers();
});

/** A reply with a DES tracker carrying the cast and the story date and time. */
function timedReply(
    text: string,
    date: string,
    start: string,
    end: string,
    cast: { name: string }[] = [{ name: 'Kai' }],
) {
    return message(text, {
        name: 'Kai',
        swipe_id: 0,
        swipes: [text],
        swipe_info: [{ extra: {} }],
        extra: {
            dooms_tracker_swipes: [
                {
                    quests: null,
                    infoBox: JSON.stringify({ date: { value: date }, time: { start, end } }),
                    characterThoughts: JSON.stringify(cast),
                },
            ],
        },
    });
}

async function commitTimed(text: string, date: string, start: string, end: string): Promise<number> {
    env.mock.chat.push(timedReply(text, date, start, end));
    const index = env.mock.chat.length - 1;
    await env.commit(index);
    return index;
}

function keeper(extra: Partial<MechanicDef> = {}): MechanicDef {
    return magicDef({
        statuses: [{ id: 'poisoned', name: 'Отравлен', promptName: 'poisoned', modifiers: { checks: -2 } }],
        inventory: {},
        ...extra,
    });
}

describe('the service block of plan-2 §6', () => {
    it('statuses and items apply at the commit; roll requests go out on arrival; fight lines at the commit', async () => {
        env.defs.defs = [keeper()];
        await env.start();
        const rolls: unknown[] = [];
        const fights: unknown[] = [];
        env.tracking.onRollRequests((index, swipeId, list) =>
            rolls.push({ index, swipeId, heads: list.map((item) => item.head) }),
        );
        env.tracking.onCombatLines((index, lines) => {
            fights.push({ index, actions: lines.map((line) => line.action) });
        });
        const text = [
            'Кай закрывает рану.',
            '<mechanics>',
            'Кай.status += Отравлен (3 хода) # укус',
            'Кай.items += верёвка x2',
            'Кай.equip += верёвка',
            'Кай.status -= blessed',
            'roll: Spell Kai',
            'combat: start Бандит',
            '</mechanics>',
        ].join('\n');
        const index = await env.receive(text, [{ name: 'Kai' }]);
        expect(rolls).toEqual([{ index, swipeId: 0, heads: ['Spell Kai'] }]);
        expect(env.mock.chat[index]?.mes).toBe('Кай закрывает рану.');
        await env.commit(index);
        const statuses = env.state.statuses('Kai');
        expect(statuses[0]?.statuses[0]).toMatchObject({
            name: 'Отравлен',
            promptName: 'poisoned',
            remaining: { turns: 3 },
            modifiers: { checks: -2 },
            source: 'block',
            since: index,
        });
        expect(env.state.items('Kai')[0]?.items).toEqual([
            expect.objectContaining({ name: 'верёвка', qty: 2, equipped: 'hand' }),
        ]);
        expect(fights).toEqual([{ index, actions: ['start'] }]);
        const changes = env.state.changesOf(index);
        expect(changes.map((change) => change.kind)).toEqual(['status', 'item', 'item']);
        // The swipe of that reply takes them back.
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'deleted' });
        await env.tick(20);
        expect(env.state.statuses()).toEqual([]);
        expect(env.state.items()).toEqual([]);
    });

    it('a duration phrase is placed in story time by the calendar', async () => {
        env.defs.defs = [keeper()];
        await env.start();
        await commitTimed('Утро.', 'Day 1', '08:00', '09:00');
        const index = await env.receive('<mechanics>\nКай.status += Благословение (до заката)\n</mechanics>', [
            { name: 'Kai' },
        ]);
        await env.commit(index);
        const blessed = env.state.statuses('Kai')[0]?.statuses[0];
        expect(blessed?.until).toEqual(expect.objectContaining({ day: 1 }));
        expect(blessed?.remaining).toBeNull();
    });
});

describe('the committed turn', () => {
    it('moves the story clock, runs time rules, ticks statuses; a deleted reply takes it all back', async () => {
        env.defs.defs = [
            keeper({
                time: [
                    { attr: 'mana', amount: 5, per: 'hour' },
                    { attr: 'mana', amount: -1, per: 'turn' },
                ],
            }),
        ];
        await env.start();
        const first = await commitTimed('Утро.', 'Day 1', '08:00', '09:00');
        expect(env.state.clock()).toEqual({ day: 1, minutes: 540, label: 'Day 1' });
        await env.state.applyOps([
            {
                kind: 'status',
                op: 'add',
                mechanicId: 'magic',
                holder: 'Kai',
                status: { name: 'poisoned', duration: { turns: 2 } },
                source: 'user',
                messageIndex: -1,
            },
        ]);
        const second = await commitTimed('Полдень.', 'Day 1', '11:30', '12:00');
        expect(env.state.clock()).toMatchObject({ day: 1, minutes: 720 });
        // 3 hour boundaries crossed (9 → 12): +15; one turn: -1 (the first turn had no time step yet: -1 too).
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(50 - 1 + 15 - 1);
        expect(env.state.statuses('Kai')[0]?.statuses[0]?.remaining).toEqual({ turns: 1 });
        const changes = env.state.changesOf(second);
        expect(changes.every((change) => change.source === 'time')).toBe(true);
        // Processed once.
        await env.app.bus.emit('turn:committed', { messageIndex: second });
        await env.tick(600);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(63);
        // The reply goes: its time, clock and tick go with it.
        await env.app.bus.emit('message:invalidated', { messageIndex: second, reason: 'deleted' });
        await env.tick(20);
        expect(env.state.clock()).toMatchObject({ minutes: 540 });
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(49);
        expect(env.state.statuses('Kai')[0]?.statuses[0]?.remaining).toEqual({ turns: 2 });
        expect(first).toBeLessThan(second);
    });

    it('statuses run out and tell the model', async () => {
        env.defs.defs = [keeper()];
        await env.start();
        await env.state.applyOps([
            {
                kind: 'status',
                op: 'add',
                mechanicId: 'magic',
                holder: 'Kai',
                status: { name: 'stunned', duration: { turns: 1 } },
                source: 'user',
                messageIndex: -1,
            },
        ]);
        await commitTimed('Удар.', 'Day 1', '08:00', '08:10');
        expect(env.state.statuses()).toEqual([]);
        expect(env.state.pendingEvents().map((event) => event.text)).toEqual(['Kai is no longer stunned.']);
    });

    it('only the leader processes a turn', async () => {
        env.defs.defs = [keeper({ time: [{ attr: 'mana', amount: -1, per: 'turn' }] })];
        await env.start();
        env.leader.value = false;
        await commitTimed('Утро.', 'Day 1', '08:00', '09:00');
        expect(env.state.clock()).toBeNull();
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(50);
    });
});

describe('the user’s character and DES', () => {
    it('his DES-stat attributes go to the background parse (DES never lists him)', async () => {
        const health = { ...healthDef(), holders: { kind: 'characters' as const, includePersona: true } };
        env.defs.defs = [health];
        env.des.stats().enabled = true;
        env.des.stats().customStats = [{ id: 'health', name: 'Health', enabled: true }];
        await env.start();
        const index = await env.receive('Алекса ранили.', [{ name: 'Kai', stats: { Health: 80 } } as never]);
        await env.commit(index);
        expect(env.tasks.queued).toHaveLength(1);
        env.llm.responses.push({
            ok: true,
            data: {
                changes: [
                    { holder: 'Алекс', attribute: 'Health', value: '', delta: -20, reason: 'ранили' },
                    { holder: 'Kai', attribute: 'Health', value: '', delta: -5, reason: '' },
                ],
            },
        });
        await env.tasks.runLatest(EXTRACT_TASK);
        const request = env.llm.requests[0]!;
        expect(request.messages[1]?.content).toContain('Алекс: Health 100; Stamina 10');
        expect(request.messages[1]?.content).toContain('Kai: Stamina 10');
        expect(env.state.value('health', 'Алекс', 'hp')).toBe(80);
        // Kai's health comes from DES, never from the parse.
        expect(env.state.value('health', 'Kai', 'hp')).toBe(80);
    });

    it('with the block fallback the instruction lists his attributes', async () => {
        const health = { ...healthDef(), holders: { kind: 'characters' as const, includePersona: true } };
        env.defs.defs = [health];
        env.settings.personaFallback = 'block';
        await env.start();
        const text = env.tracking.blockInstruction([health], { health: ['Kai', 'Алекс'] });
        expect(text).toContain('Holders: Алекс\n- Health: number 0-100');
        const index = await env.receive('<mechanics>\nАлекс.Health: -30\nKai.Health: -30\n</mechanics>', [
            { name: 'Kai' },
        ]);
        await env.commit(index);
        expect(env.state.value('health', 'Алекс', 'hp')).toBe(70);
        expect(env.state.value('health', 'Kai', 'hp')).toBe(100);
    });
});

describe('the background parse of statuses and items', () => {
    it('proposes them with the values and applies them through autonomy (undoable)', async () => {
        env.defs.defs = [keeper({ tracking: 'background' })];
        await env.start();
        const index = await env.receive('Кай находит верёвку и чувствует слабость.', [{ name: 'Kai' }]);
        await env.commit(index);
        env.llm.responses.push({
            ok: true,
            data: {
                changes: [],
                statuses: [{ holder: 'Kai', name: 'poisoned', add: true, duration: '2 turns', reason: 'слабость' }],
                items: [{ holder: 'Kai', name: 'rope', qty: 1, reason: 'находит' }],
            },
        });
        await env.tasks.runLatest(EXTRACT_TASK);
        const request = env.llm.requests[0]!;
        const schema = request.schema?.schema as { required: string[] };
        expect(schema.required).toEqual(['changes', 'statuses', 'items']);
        const proposal = env.autonomy.proposals.find((item) => item.kind === CHANGE_KIND)!;
        expect(proposal.description).toBe('Kai: now poisoned\nKai: + rope ×1');
        expect(env.state.statuses('Kai')[0]?.statuses[0]).toMatchObject({ name: 'Отравлен', remaining: { turns: 2 } });
        expect(env.state.items('Kai')[0]?.items[0]).toMatchObject({ name: 'rope', qty: 1 });
    });
});

describe('reset, undo and visibility of changes', () => {
    it('a reset is one journal record whose undo brings everything back', async () => {
        env.defs.defs = [keeper()];
        await env.start();
        await env.state.apply([
            { mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: 5, source: 'user', messageIndex: -1 },
        ]);
        await env.state.applyOps([
            {
                kind: 'item',
                op: 'give',
                mechanicId: 'magic',
                holder: 'Kai',
                item: { name: 'rope' },
                source: 'user',
                messageIndex: -1,
            },
        ]);
        expect(await env.state.reset({ mechanicId: 'magic' })).toBe(2);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(50);
        expect(env.state.items()).toEqual([]);
        const record = env.journal.records.find((item) => item.kind === 'mechanics.reset')!;
        expect(record.summary).toBe('Mechanics back to the start: Магия (changes: 2)');
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(5);
        expect(env.state.items('Kai')[0]?.items).toHaveLength(1);
        expect(await env.state.reset({ holder: 'Nobody' })).toBe(0);
    });

    it('undoChange takes one change back and journals it; a gone one is refused', async () => {
        env.defs.defs = [keeper()];
        await env.start();
        const [change] = await env.state.apply([
            { mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: 7, source: 'user', messageIndex: -1 },
        ]);
        const events: MechanicsEvent[] = [];
        env.state.onEvent((event) => events.push(event));
        expect(await env.state.undoChange(change!.id)).toBe(true);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(50);
        expect(events.map((event) => event.type)).toEqual(['undone']);
        expect(env.journal.records.some((record) => record.kind === 'mechanics.undo')).toBe(true);
        expect(await env.state.undoChange(change!.id)).toBe(false);
    });

    it('changesOf with a place drops what the player may not see (hidden until revealed, secret)', async () => {
        const def = magicDef({
            attributes: [
                { ...magicDef().attributes[0]!, visibility: { preset: 'hidden' } },
                { id: 'doom', name: 'Рок', promptName: 'Doom', kind: 'number', visibility: { preset: 'secret' } },
                { id: 'luck', name: 'Удача', promptName: 'Luck', kind: 'number' },
            ],
            statuses: [],
        });
        env.defs.defs = [def];
        await env.start();
        const index = await env.receive('<mechanics>\nKai.Mana: -5\nKai.Luck: +1\nKai.status += Hex\n</mechanics>', [
            { name: 'Kai' },
        ]);
        await env.commit(index);
        await env.state.applyOps([
            { mechanicId: 'magic', holder: 'Kai', attribute: 'doom', value: 3, source: 'event', messageIndex: index },
        ]);
        expect(env.state.changesOf(index).map((change) => change.attribute)).toEqual([
            'mana',
            'luck',
            'status',
            'doom',
        ]);
        expect(env.state.changesOf(index, { place: 'strip' }).map((change) => change.attribute)).toEqual([
            'luck',
            'status',
        ]);
        await env.state.applyOps([
            { kind: 'reveal', mechanicId: 'magic', holder: 'Kai', attribute: 'mana', source: 'user', messageIndex: -1 },
        ]);
        expect(env.state.isRevealed('magic', 'Kai', 'mana')).toBe(true);
        expect(env.state.changesOf(index, { place: 'strip' }).map((change) => change.attribute)).toEqual([
            'mana',
            'luck',
            'status',
        ]);
        expect(env.state.changesOf(index, { place: 'hud' }).map((change) => change.attribute)).toEqual([
            'luck',
            'status',
        ]);
    });

    it('derived values and numbers with modifiers; a check bonus from statuses and items', async () => {
        const def = magicDef({
            attributes: [
                ...magicDef().attributes,
                { id: 'power', name: 'Сила', promptName: 'Power', kind: 'number', formula: '@mana / 10' },
            ],
            statuses: [],
            inventory: {},
        });
        env.defs.defs = [def];
        await env.start();
        await env.state.applyOps([
            {
                kind: 'status',
                op: 'add',
                mechanicId: 'magic',
                holder: 'Kai',
                status: { name: 'Focus', modifiers: { mana: 10, checks: 1 } },
                source: 'user',
                messageIndex: -1,
            },
            {
                kind: 'item',
                op: 'give',
                mechanicId: 'magic',
                holder: 'Kai',
                item: { name: 'Ring', equipped: 'hand', modifiers: { 'check:spell': 2 } },
                source: 'user',
                messageIndex: -1,
            },
        ]);
        expect(env.state.value('magic', 'Kai', 'power')).toBe(6);
        expect(env.state.numberOf('magic', 'Kai', 'mana')).toBe(60);
        expect(env.state.checkBonus(def, 'spell', 'Kai')).toBe(3);
        expect(env.state.derived('magic', 'Kai').map((value) => [value.attribute, value.base, value.value])).toEqual([
            ['mana', 50, 60],
            ['power', 6, 6],
        ]);
        expect(env.state.state('Kai').find((item) => item.mechanicId === 'magic')?.values.power).toBe(6);
        expect(env.state.derived('nope', 'Kai')).toEqual([]);
    });
});

describe('who is in the scene', () => {
    it('factions only when named in the last messages; the world when its words come up', async () => {
        env.defs.defs = [
            { ...reputationDef(), pinned: false },
            magicDef({ id: 'realm', holders: { kind: 'world' }, keys: ['королевство'] }),
        ];
        await env.start();
        const rep = env.defs.defs[0]!;
        const realm = env.defs.defs[1]!;
        env.mock.chat.push(userMessage('Иду на рынок.'));
        expect(env.state.holdersInScene(rep)).toEqual([]);
        expect(env.state.holdersInScene(realm)).toEqual([]);
        env.mock.chat.push(userMessage('Говорю с людьми Guild о делах королевства.'));
        expect(env.state.holdersInScene(rep)).toEqual(['Guild']);
        expect(env.state.holdersInScene(realm)).toEqual(['world']);
        env.settings.relevance = 1;
        env.mock.chat.push(userMessage('Ухожу.'));
        expect(env.state.holdersInScene(rep)).toEqual([]);
    });

    it('a changed faction stays for a few turns; the fight’s enemies join character mechanics', async () => {
        env.defs.defs = [{ ...reputationDef(), pinned: false }, keeper({ combat: {} })];
        await env.start();
        const index = await env.receive('Тихо.', [{ name: 'Kai' }]);
        await env.commit(index);
        await env.state.apply([
            {
                mechanicId: 'rep',
                holder: 'Crown',
                attribute: 'standing',
                value: 'liked',
                source: 'event',
                messageIndex: index,
            },
        ]);
        expect(env.state.holdersInScene(env.defs.defs[0]!)).toEqual(['Crown']);
        await env.state.applyOps([
            {
                kind: 'combat',
                op: 'set',
                mechanicId: 'magic',
                next: {
                    active: true,
                    round: 1,
                    order: [
                        { holder: 'Bandit', init: 3, enemy: true },
                        { holder: 'Wolf', init: 2, enemy: true, out: true },
                    ],
                    current: 0,
                    mechanicId: 'magic',
                    startedAt: 0,
                    by: 'user',
                },
                source: 'user',
                messageIndex: -1,
            },
        ]);
        expect(env.state.holdersInScene(env.defs.defs[1]!)).toEqual(['Kai', 'Алекс', 'Bandit']);
        expect(env.state.combat()?.round).toBe(1);
    });
});

describe('what the player may not see', () => {
    it('background changes of hidden values go in silently; visible ones through the card', async () => {
        const def = magicDef({
            tracking: 'background',
            attributes: [
                { ...magicDef().attributes[0]!, visibility: { preset: 'hidden' } },
                { id: 'luck', name: 'Удача', promptName: 'Luck', kind: 'number' },
            ],
            statuses: undefined,
        });
        env.defs.defs = [
            def,
            {
                ...magicDef({
                    id: 'curse',
                    name: 'Проклятие',
                    tracking: 'background',
                    statuses: [],
                    visibility: { preset: 'hidden' },
                }),
            },
        ];
        await env.start();
        const index = await env.receive('Кай колдует.', [{ name: 'Kai' }]);
        await env.commit(index);
        env.llm.responses.push({
            ok: true,
            data: {
                changes: [
                    { holder: 'Kai', attribute: 'Mana', value: '', delta: -10, reason: '' },
                    { holder: 'Kai', attribute: 'Luck', value: '', delta: 1, reason: '' },
                ],
                statuses: [{ holder: 'Kai', name: 'hexed', add: true, duration: '', reason: '' }],
            },
        });
        await env.tasks.runLatest(EXTRACT_TASK);
        const proposal = env.autonomy.proposals.find((item) => item.kind === CHANGE_KIND)!;
        expect(proposal.description).toBe('Kai · Удача: 0 → 1');
        expect(proposal.changes).toHaveLength(1);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(40);
        expect(env.state.statuses('Kai')[0]?.statuses[0]?.name).toBe('hexed');
    });

    it('everything hidden: no card at all', async () => {
        env.defs.defs = [magicDef({ tracking: 'background', visibility: { preset: 'hidden' } })];
        await env.start();
        const index = await env.receive('Тишина.', [{ name: 'Kai' }]);
        await env.commit(index);
        env.llm.responses.push({
            ok: true,
            data: { changes: [{ holder: 'Kai', attribute: 'Mana', value: '', delta: -5, reason: '' }] },
        });
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.autonomy.proposals).toEqual([]);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(45);
    });
});
