// Release 1.26, tracking that keeps up: 'auto' routes each attribute (DES stats for the characters' numbers DES
// keeps, else the service block the model always writes), the background parse catches a missing or unreadable block,
// DES stats count as changes, the parse reads the player's action, story time moves the clock without DES, «until
// sunset» without a clock lasts some turns, «Пересчитать», messages deleted from the middle, a tab that becomes the
// leader, and health for the safety net.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import type { ChecksPart } from '../../../src/features/mechanics/parts';
import { MechanicsService } from '../../../src/features/mechanics/service';
import {
    CHANGE_KIND,
    EXTRACT_TASK,
    readBlockRecord,
    UNTIL_FALLBACK_TURNS,
} from '../../../src/features/mechanics/tracking';
import { createMechanicsEnv, healthDef, magicDef, SETTLE, userMessage } from './helpers-state';
import type { MechanicsEnv } from './helpers-state';

let env: MechanicsEnv;

/** Vitals of everyone in the scene, tracked automatically (the 1.26 default). */
function vitalsDef(extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'vitals',
        name: 'Жизнь',
        summary: 'Health, mana and mood',
        rules: 'Wounds lower health; spells cost mana.',
        attributes: [
            { id: 'hp', name: 'Здоровье', promptName: 'Health', kind: 'number', min: 0, max: 100, initial: 100 },
            { id: 'mana', name: 'Мана', promptName: 'Mana', kind: 'number', min: 0, max: 100, initial: 50 },
            { id: 'mood', name: 'Настрой', promptName: 'Mood', kind: 'scale', levels: ['low', 'calm', 'high'] },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [],
        tracking: 'auto',
        scope: { kind: 'global' },
        statuses: [],
        ...extra,
    };
}

/** DES keeps «Health» as a character stat. */
function desKeepsHealth(): void {
    env.des.stats().enabled = true;
    env.des.stats().customStats[0]!.enabled = true;
}

beforeEach(async () => {
    vi.useFakeTimers();
    env = createMechanicsEnv();
    env.defs.defs = [vitalsDef()];
    await env.start();
});

afterEach(() => {
    env.stop();
    vi.useRealTimers();
});

const STORY = 'Кай поднял руку, и пламя вспыхнуло.';

async function shown(index: number, type = 'normal'): Promise<void> {
    await env.app.bus.emit('reply:ready', { messageIndex: index, type });
    await env.tick(SETTLE);
}

/** A user message, then a reply that is shown; the reply's index. */
async function turn(text: string, cast: { name: string; stats?: Record<string, number> }[] = [{ name: 'Kai' }]) {
    env.mock.chat.push(userMessage());
    const index = await env.receive(text, cast);
    await shown(index);
    return index;
}

describe("'auto' routing", () => {
    it('applies block lines of auto attributes for every holder while DES keeps none of them', async () => {
        await turn(`${STORY}\n<mechanics>\nKai.Health: -10\nАлекс.Mana: -5\nKai.Mood = high\n</mechanics>`);
        expect(env.state.value('vitals', 'Kai', 'hp')).toBe(90);
        expect(env.state.value('vitals', 'Алекс', 'mana')).toBe(45);
        expect(env.state.value('vitals', 'Kai', 'mood')).toBe('high');
        expect(env.state.history().every((change) => change.source === 'block')).toBe(true);
        // A block is there: no background parse.
        expect(env.tasks.queued).toEqual([]);
    });

    it("takes the characters' numbers DES keeps from DES, the user's character's from the block", async () => {
        desKeepsHealth();
        await turn(`${STORY}\n<mechanics>\nKai.Health: -10\nАлекс.Health: -7\n</mechanics>`, [
            { name: 'Kai', stats: { Health: 70 } },
        ]);
        expect(env.state.value('vitals', 'Kai', 'hp')).toBe(70);
        expect(env.state.value('vitals', 'Алекс', 'hp')).toBe(93);
        expect(env.state.history().map((change) => [change.holder, change.source])).toEqual(
            expect.arrayContaining([
                ['Kai', 'desStats'],
                ['Алекс', 'block'],
            ]),
        );
        expect(env.state.history()).toHaveLength(2);
        // The instruction leaves Health out for the characters and keeps it for the user's character.
        const text = env.tracking.blockInstruction([vitalsDef()], { vitals: ['Kai', 'Алекс'] });
        const [all, mine] = text.split('Holders: ').slice(1);
        expect(all).not.toContain('Health');
        expect(all).toContain('Mana');
        expect(mine).toBe('Алекс\n- Health: number 0-100');
        expect(text).toContain('when nothing changed, write <mechanics>none</mechanics>');
        expect(env.tracking.desStatsStatus(vitalsDef())).toEqual([
            { attribute: 'hp', inDes: true },
            { attribute: 'mana', inDes: false },
        ]);
    });

    it('offers to make the numbers of an auto mechanic DES stats', async () => {
        expect(await env.tracking.enableDesStats(vitalsDef())).toBe(true);
        expect(env.des.stats().customStats.map((stat) => [stat.name, stat.enabled])).toEqual([
            ['Health', true],
            ['Arousal', true],
            ['Mana', true],
        ]);
    });
});

describe('the «nothing changed» block and the safety net', () => {
    it('a none block is the reply’s block: nothing changes, no background parse', async () => {
        const index = await turn(`${STORY}\n<mechanics>none</mechanics>`);
        expect(env.mock.chat[index]!.mes).toBe(STORY);
        expect(readBlockRecord(env.mock.chat[index])).toMatchObject({ none: true, items: [] });
        expect(env.state.history()).toEqual([]);
        expect(env.tasks.queued).toEqual([]);
    });

    it('a reply without a block goes to the background parse for its auto attributes, with the action', async () => {
        env.mock.chat.push(userMessage('Я бью Кая мечом.'));
        const index = await env.receive(STORY, [{ name: 'Kai' }]);
        await shown(index);
        expect(env.tasks.queued).toEqual([
            expect.objectContaining({ kind: EXTRACT_TASK, payload: { messageIndex: index, swipeId: 0 } }),
        ]);
        env.llm.responses.push({
            ok: true,
            data: {
                changes: [
                    { holder: 'Kai', attribute: 'Health', value: '', delta: -15, reason: 'Клинок задел Кая' },
                    { holder: 'Kai', attribute: 'Mood', value: 'low', delta: null, reason: '' },
                ],
                statuses: [],
            },
        });
        await env.tasks.runLatest(EXTRACT_TASK);
        const request = env.llm.requests[0]!;
        expect(request.maxTokens).toBe(1200);
        expect(request.messages[1]?.content).toContain('<action>\nЯ бью Кая мечом.\n</action>');
        expect(request.messages[1]?.content).toContain(
            'The player\'s character is Алекс: "you", "ты" and "вы" in the action and in the narration mean Алекс.',
        );
        expect(request.messages[1]?.content).toContain('Kai: Health 100; Mana 50; Mood');
        expect(env.state.value('vitals', 'Kai', 'hp')).toBe(85);
        expect(env.state.value('vitals', 'Kai', 'mood')).toBe('low');
        expect(env.autonomy.proposals.map((proposal) => proposal.kind)).toEqual([CHANGE_KIND]);
    });

    it('an unreadable block goes to the background parse too', async () => {
        const index = await turn(`${STORY}\n<mechanics>\nthe mana fades away\n</mechanics>`);
        expect(readBlockRecord(env.mock.chat[index])?.dropped).toBe(1);
        expect(env.tasks.queued).toHaveLength(1);
    });

    it('explicit block tracking keeps its old ways: no block, no parse', async () => {
        env.defs.defs = [magicDef()];
        await turn(STORY);
        expect(env.tasks.queued).toEqual([]);
    });

    it('sends the rules in full (up to 2000 characters)', async () => {
        const rules = `${'A sword wound costs 10 to 20 health; a spell costs 5 to 40 mana. '.repeat(20)}THE END`;
        env.defs.defs = [vitalsDef({ rules })];
        await turn(STORY);
        env.llm.responses.push({ ok: true, data: { changes: [], statuses: [] } });
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(rules.length).toBeGreaterThan(1000);
        expect(env.llm.requests[0]?.messages[1]?.content).toContain('THE END');
    });
});

describe('DES stats as changes', () => {
    beforeEach(() => {
        env.defs.defs = [healthDef()];
        desKeepsHealth();
    });

    it("adds DES's difference to Maestro's value, so Maestro's own changes stay", async () => {
        const first = await turn(STORY, [{ name: 'Kai', stats: { Health: 70 } }]);
        // First sight: set.
        expect(env.state.value('health', 'Kai', 'hp')).toBe(70);
        // Maestro takes 20 (a roll's cost) — DES does not know.
        await env.state.apply([
            {
                mechanicId: 'health',
                holder: 'Kai',
                attribute: 'hp',
                value: -20,
                delta: true,
                source: 'check',
                messageIndex: first,
            },
        ]);
        expect(env.state.value('health', 'Kai', 'hp')).toBe(50);
        const second = await turn(STORY, [{ name: 'Кай', stats: { Health: 65 } }]);
        expect(env.state.value('health', 'Kai', 'hp')).toBe(45);
        expect(env.state.changesOf(second).map((change) => [change.source, change.from, change.to])).toEqual([
            ['desStats', 50, 45],
        ]);
        // The same value again: no change at all.
        const third = await turn(STORY, [{ name: 'Kai', stats: { Health: 65 } }]);
        expect(env.state.changesOf(third)).toEqual([]);
        expect(env.state.value('health', 'Kai', 'hp')).toBe(45);
    });

    it('looks back past a reply where the character was away', async () => {
        await turn(STORY, [{ name: 'Kai', stats: { Health: 70 } }]);
        await turn(STORY, [{ name: 'Mira', stats: { Health: 90 } }]);
        await turn(STORY, [{ name: 'Kai', stats: { Health: 60 } }]);
        expect(env.state.value('health', 'Kai', 'hp')).toBe(60);
        expect(env.state.value('health', 'Mira', 'hp')).toBe(90);
        expect(env.state.history().filter((change) => change.holder === 'Kai')).toHaveLength(2);
    });
});

describe('story time without DES', () => {
    const survival = (extra: Partial<MechanicDef> = {}) =>
        vitalsDef({
            attributes: [
                { id: 'hunger', name: 'Голод', promptName: 'Hunger', kind: 'number', min: 0, max: 100, initial: 0 },
            ],
            holders: { kind: 'characters' },
            time: [{ attr: 'hunger', amount: 2, per: 'hour' }],
            ...extra,
        });

    it("asks for the block's time line and moves the clock and the hour rules by it", async () => {
        env.defs.defs = [survival()];
        expect(env.tracking.blockInstruction([survival()], { vitals: ['Kai'] })).toContain(
            'Story time: add time: +30m (or +3h, +2d)',
        );
        const index = await turn(`${STORY}\n<mechanics>\ntime: +3h\n</mechanics>`);
        expect(env.state.clock()).toEqual({ day: 1, minutes: 180, label: '', relative: true });
        expect(env.state.value('vitals', 'Kai', 'hunger')).toBe(6);
        expect(env.state.changesOf(index).map((change) => change.source)).toEqual(['time']);
        // A second reply moves on from there.
        await turn(`${STORY}\n<mechanics>\ntime: +30m\n</mechanics>`);
        expect(env.state.clock()).toMatchObject({ day: 1, minutes: 210 });
        expect(env.state.value('vitals', 'Kai', 'hunger')).toBe(6);
    });

    it("DES's time comes first and then the block's time line is not asked for", async () => {
        env.defs.defs = [survival()];
        env.mock.chat.push(userMessage());
        const index = await env.receive(`${STORY}\n<mechanics>\ntime: +3h\n</mechanics>`, [{ name: 'Kai' }]);
        const record = (env.mock.chat[index]!.extra as Record<string, { infoBox: unknown }[]>)
            .dooms_tracker_swipes![0]!;
        record.infoBox = JSON.stringify({ date: 'Day 2', time: { start: '10:00', end: '10:30' } });
        await shown(index);
        expect(env.state.clock()).toMatchObject({ day: 2, minutes: 630 });
        expect(env.state.clock()?.relative).toBeUndefined();
        expect(env.tracking.blockInstruction([survival()], { vitals: ['Kai'] })).not.toContain('Story time');
    });

    it('takes the elapsed time from the background parse when there is no block', async () => {
        env.defs.defs = [survival()];
        const index = await turn('Они шли до вечера.');
        env.llm.responses.push({ ok: true, data: { changes: [], statuses: [], elapsed: 120 } });
        await env.tasks.runLatest(EXTRACT_TASK);
        const schema = env.llm.requests[0]?.schema?.schema as { required: string[] };
        expect(schema.required).toContain('elapsed');
        expect(env.llm.requests[0]?.messages[0]?.content).toContain('"elapsed"');
        expect(env.state.clock()).toEqual({ day: 1, minutes: 120, label: '', relative: true });
        expect(env.state.value('vitals', 'Kai', 'hunger')).toBe(4);
        // Once: the same answer again does not move the clock twice.
        env.llm.responses.push({ ok: true, data: { changes: [], statuses: [], elapsed: 120 } });
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.state.clock()?.minutes).toBe(120);
        expect(env.state.changesOf(index).filter((change) => change.source === 'time')).toHaveLength(1);
    });

    it('does not ask for the time when nothing in the scene needs a clock', async () => {
        await turn(STORY);
        env.llm.responses.push({ ok: true, data: { changes: [], statuses: [] } });
        await env.tasks.runLatest(EXTRACT_TASK);
        const schema = env.llm.requests[0]?.schema?.schema as { required: string[] };
        expect(schema.required).not.toContain('elapsed');
        expect(env.tracking.blockInstruction([vitalsDef()], { vitals: ['Kai'] })).not.toContain('Story time');
    });

    it('a duration «until sunset» without a real clock lasts some turns instead of forever', async () => {
        await turn(`${STORY}\n<mechanics>\nKai.status += Blessed (until sunset)\n</mechanics>`);
        const status = env.state.statuses('Kai')[0]?.statuses[0];
        expect(status?.name).toBe('Blessed');
        expect(status?.remaining).toEqual({ turns: UNTIL_FALLBACK_TURNS });
        expect(UNTIL_FALLBACK_TURNS).toBe(8);
    });
});

describe('«Пересчитать»', () => {
    it("hands a block reply's auto attributes to the background parse, once", async () => {
        const index = await turn(`${STORY}\n<mechanics>\nKai.Mana: -10\n</mechanics>`);
        expect(env.state.value('vitals', 'Kai', 'mana')).toBe(40);
        expect(await env.tracking.recount(index)).toBe(true);
        expect(readBlockRecord(env.mock.chat[index])?.recounted).toBe(true);
        // The block's line no longer counts; the parse reads the reply afresh.
        expect(env.state.value('vitals', 'Kai', 'mana')).toBe(50);
        expect(env.tasks.queued).toHaveLength(1);
        env.llm.responses.push({
            ok: true,
            data: { changes: [{ holder: 'Kai', attribute: 'Mana', value: '', delta: -15, reason: '' }], statuses: [] },
        });
        await env.tasks.runLatest(EXTRACT_TASK);
        expect(env.state.value('vitals', 'Kai', 'mana')).toBe(35);
        // The answer and the commit after it count nothing twice.
        await env.commit(index);
        expect(env.state.value('vitals', 'Kai', 'mana')).toBe(35);
        expect(env.state.changesOf(index).map((change) => change.source)).toEqual(['background']);
        // Again: the parse runs again (its dedupe cleared).
        expect(await env.tracking.recount(index)).toBe(true);
        expect(env.state.value('vitals', 'Kai', 'mana')).toBe(50);
        expect(env.tasks.queued).toHaveLength(2);
    });

    it('is MechanicsApi.retrack (false without the tracking part)', async () => {
        const index = await turn(`${STORY}
<mechanics>
Kai.Mana: -10
</mechanics>`);
        const checks = {} as ChecksPart;
        const api = new MechanicsService(env.defs, env.state, checks, { app: env.app }, { tracking: env.tracking });
        expect(await api.retrack(index)).toBe(true);
        expect(await new MechanicsService(env.defs, env.state, checks).retrack(index)).toBe(false);
    });

    it('reads the block again when the parse cannot run', async () => {
        env.llm.availableFlag = false;
        const index = await turn(`${STORY}\n<mechanics>\nKai.Mana: -10\n</mechanics>`);
        expect(await env.tracking.recount(index)).toBe(true);
        expect(readBlockRecord(env.mock.chat[index])?.recounted).toBeUndefined();
        expect(env.state.value('vitals', 'Kai', 'mana')).toBe(40);
        expect(env.state.history()).toHaveLength(1);
    });

    it('runs the parse again for a reply without a block, and refuses what it cannot recount', async () => {
        const index = await turn(STORY);
        expect(env.tasks.queued).toHaveLength(1);
        expect(await env.tracking.recount(index)).toBe(true);
        expect(env.tasks.queued).toHaveLength(2);
        expect(await env.tracking.recount(index - 1)).toBe(false);
        expect(await env.tracking.recount(99)).toBe(false);
        env.leader.value = false;
        expect(await env.tracking.recount(index)).toBe(false);
    });

    it('keeps the story time of an older reply that later turns stand on', async () => {
        env.defs.defs = [
            vitalsDef({
                attributes: [
                    { id: 'hunger', name: 'Голод', promptName: 'Hunger', kind: 'number', min: 0, max: 100, initial: 0 },
                ],
                holders: { kind: 'characters' },
                time: [{ attr: 'hunger', amount: 1, per: 'hour' }],
            }),
        ];
        env.llm.availableFlag = false;
        const first = await turn(`${STORY}\n<mechanics>\nKai.Hunger: +10\ntime: +2h\n</mechanics>`);
        await turn(`${STORY}\n<mechanics>\ntime: +1h\n</mechanics>`);
        expect(env.state.value('vitals', 'Kai', 'hunger')).toBe(13);
        expect(await env.tracking.recount(first)).toBe(true);
        expect(env.state.value('vitals', 'Kai', 'hunger')).toBe(13);
        expect(env.state.clock()).toMatchObject({ minutes: 180 });
    });
});

describe('messages deleted from the middle', () => {
    it("takes back the deleted reply's changes and moves the later ones down", async () => {
        env.defs.defs = [magicDef()];
        const first = await turn(`${STORY}\n<mechanics>\nKai.mana: -10\n</mechanics>`);
        const second = await turn(`${STORY}\n<mechanics>\nKai.mana: -5\n</mechanics>`);
        const third = await turn(`${STORY}\n<mechanics>\nKai.mana: -1\n</mechanics>`);
        expect([first, second, third]).toEqual([1, 3, 5]);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(34);
        env.mock.chat.splice(2, 2);
        await env.app.bus.emit('message:invalidated', {
            messageIndex: env.mock.chat.length,
            reason: 'deleted',
            removedAt: 2,
            removed: 2,
        });
        await env.tick(50);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(39);
        expect(env.state.changesOf(1).map((change) => change.to)).toEqual([40]);
        // The third reply's change is message 3's now (its logged from → to as it happened).
        expect(env.state.changesOf(3).map((change) => [change.from, change.to])).toEqual([[35, 34]]);
        expect(env.state.changesOf(5)).toEqual([]);
    });

    it('without a range the old meaning stands (everything from the index on)', async () => {
        env.defs.defs = [magicDef()];
        await turn(`${STORY}\n<mechanics>\nKai.mana: -10\n</mechanics>`);
        await turn(`${STORY}\n<mechanics>\nKai.mana: -5\n</mechanics>`);
        env.mock.chat.splice(2, 2);
        await env.app.bus.emit('message:invalidated', { messageIndex: 2, reason: 'deleted' });
        await env.tick(50);
        expect(env.state.value('magic', 'Kai', 'mana')).toBe(40);
    });
});

describe('a tab that becomes the leader', () => {
    it('reads the latest reply it could not read before', async () => {
        env.leader.value = false;
        await turn(`${STORY}\n<mechanics>\nKai.Mana: -10\n</mechanics>`);
        expect(env.state.history()).toEqual([]);
        env.setLeader(true);
        await env.tick(SETTLE);
        expect(env.state.value('vitals', 'Kai', 'mana')).toBe(40);
        // Losing the lead reads nothing; becoming the leader again reads nothing twice.
        env.setLeader(false);
        env.setLeader(true);
        await env.tick(SETTLE);
        expect(env.state.history()).toHaveLength(1);
    });
});

describe('health of the safety net', () => {
    it('is a note, not a warning, when the background parse is only the safety net', async () => {
        await env.receive(STORY, [{ name: 'Kai' }]);
        env.llm.availableFlag = false;
        const [problem] = env.tracking.health();
        expect(problem).toMatchObject({ code: 'noProfile', level: 'info', mechanics: ['vitals'] });
        expect(problem?.text).toContain('when the model leaves out its service block');
        env.llm.availableFlag = true;
        env.settings.background = false;
        expect(env.tracking.health()).toEqual([expect.objectContaining({ code: 'backgroundOff', level: 'info' })]);
    });

    it('stays a warning when a mechanic relies on the background parse alone', async () => {
        env.defs.defs = [vitalsDef(), magicDef({ tracking: 'background' })];
        await env.receive(STORY, [{ name: 'Kai' }]);
        env.llm.availableFlag = false;
        expect(env.tracking.health()).toEqual([
            expect.objectContaining({ code: 'noProfile', level: 'warn', mechanics: ['magic', 'vitals'] }),
        ]);
        expect(env.tracking.health()[0]?.text).toContain('Магия');
        expect(env.tracking.health()[0]?.text).not.toContain('Жизнь');
    });
});
