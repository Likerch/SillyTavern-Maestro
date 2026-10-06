// M25 checks of plan-2 §6 with the real state: consequences applied when the roll happens (source 'check', undoable
// per roll), growth by use, status modifiers, advantage, opposed checks, rolls the model asks for (they belong to the
// reply: a swipe drops them; they reach the next generation), secret mechanics give the model only outcomes.
import { afterEach, describe, expect, it } from 'vitest';
import { parseRollLine } from '../../../src/domain/mechanics-block';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { MechanicChecks } from '../../../src/features/mechanics/checks';
import { MechanicPrompt } from '../../../src/features/mechanics/prompt';
import { MechanicState } from '../../../src/features/mechanics/state';
import { STATE_STRINGS } from '../../../src/features/mechanics/strings-state';
import { createChecksEnv, faces, generate, reply, send, tick } from './helpers-checks';
import type { ChecksEnv } from './helpers-checks';

function fightDef(extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'fight',
        name: 'Бой',
        summary: 'Fights.',
        rules: 'Hits hurt.',
        attributes: [
            { id: 'hp', name: 'Здоровье', promptName: 'HP', kind: 'number', min: 0, max: 30, initial: 20 },
            { id: 'mana', name: 'Мана', promptName: 'Mana', kind: 'number', min: 0, max: 100, initial: 50 },
            {
                id: 'attack',
                name: 'Атака',
                promptName: 'Attack',
                kind: 'number',
                min: 0,
                max: 10,
                initial: 2,
                growth: { perUse: 0.5, cap: 4 },
            },
            { id: 'agility', name: 'Ловкость', promptName: 'Agility', kind: 'number', min: 0, max: 10, initial: 1 },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'attack',
                name: 'Атака',
                promptName: 'Attack',
                dice: '1d20+@attack',
                difficulty: 12,
                triggers: ['атак'],
                effects: [
                    { on: 'success', changes: [{ who: 'target', attr: 'hp', op: 'sub', value: '@roll.margin + 1' }] },
                    { on: 'any', changes: [{ who: 'actor', attr: 'mana', op: 'sub', value: 10 }] },
                    { on: 'fumble', changes: [], text: 'the blade slips' },
                ],
            },
            {
                id: 'defense',
                name: 'Защита',
                promptName: 'Defense',
                dice: '1d20+@agility',
                difficulty: 12,
                triggers: [],
            },
        ],
        tracking: 'block',
        scope: { kind: 'global' },
        statuses: [],
        ...extra,
    };
}

function trapDef(): MechanicDef {
    return {
        id: 'traps',
        name: 'Ловушки',
        summary: '',
        rules: '',
        attributes: [{ id: 'alarm', name: 'Тревога', promptName: 'Alarm', kind: 'number', min: 0, max: 10 }],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'sneak',
                name: 'Красться',
                promptName: 'Sneak',
                dice: '1d20',
                difficulty: 12,
                triggers: ['крадусь'],
                effects: [
                    {
                        on: 'failure',
                        changes: [{ who: 'actor', attr: 'alarm', op: 'add', value: 3 }],
                        text: 'the guards raise the alarm',
                    },
                ],
            },
        ],
        tracking: 'manual',
        scope: { kind: 'global' },
        visibility: { preset: 'secret' },
    };
}

let ctx: ChecksEnv;
let state: MechanicState;
let checks: MechanicChecks;

async function start(rng: () => number, defs: MechanicDef[] = [fightDef()]): Promise<void> {
    ctx = createChecksEnv({ defs });
    ctx.env.app.i18n.register(STATE_STRINGS);
    state = new MechanicState(ctx.deps, ctx.defs, () => 0.5);
    state.install();
    await state.load();
    checks = new MechanicChecks(ctx.deps, ctx.defs, state, { rng, saveMs: 0 });
    checks.install();
    await checks.ready();
}

afterEach(() => {
    checks?.dispose();
    state?.dispose();
});

describe('consequences of a roll', () => {
    it('apply at once, name the changes in the fact, and are taken back per roll', async () => {
        await start(faces(20, 15));
        await send(ctx, 'Я атакую.');
        await tick(10);
        const [result] = checks.checks(1);
        expect(result).toMatchObject({ by: 'auto', total: 17, target: 12, outcome: 'success' });
        // No other side in the scene: only the actor's own cost applies.
        expect(result?.text).toBe(
            'Attack check (Kai): rolled 15 + 2 = 17 vs 12 — success. Consequences: Kai: Mana -10.',
        );
        expect(result?.consequences).toEqual(['Kai: Mana -10']);
        expect(state.value('fight', 'Kai', 'mana')).toBe(40);
        // Growth by use: the attack skill grew on success.
        expect(state.value('fight', 'Kai', 'attack')).toBe(2.5);
        expect(result?.changes).toHaveLength(2);
        expect(state.history(5).every((change) => change.rollId === result?.id && change.source === 'check')).toBe(
            true,
        );
        expect(checks.rollsOf(result!.messageIndex).map((item) => item.id)).toEqual([result?.id]);

        expect(await checks.undoRoll(result!.id)).toBe(true);
        await tick(10);
        expect(state.value('fight', 'Kai', 'mana')).toBe(50);
        expect(state.value('fight', 'Kai', 'attack')).toBe(2);
        expect(checks.checks(1)[0]?.undone).toBe(true);
        expect(await checks.undoRoll(result!.id)).toBe(false);
        expect(ctx.env.journal.records.some((record) => record.kind === 'mechanics.undoRoll')).toBe(true);
    });

    it('statuses add their modifiers to the roll', async () => {
        await start(faces(20, 10));
        await state.applyOps([
            {
                kind: 'status',
                op: 'add',
                mechanicId: 'fight',
                holder: 'Kai',
                status: { name: 'Ослаблен', modifiers: { checks: -2, attack: -1 } },
                source: 'user',
                messageIndex: -1,
            },
        ]);
        const result = await checks.roll('fight', 'attack', 'Kai');
        // attack 2 - 1 (status on the attribute) and -2 on every check.
        expect(result).toMatchObject({ modifier: -1, total: 9, outcome: 'failure' });
    });

    it('opposed checks by hand take the other side’s roll and hit the target', async () => {
        await start(faces(20, 18, 5, 4));
        const result = await checks.roll('fight', 'attack', 'Kai', {
            mode: 'adv',
            vs: { holder: 'Guard', checkId: 'defense' },
        });
        expect(result).toMatchObject({
            mode: 'adv',
            other: 7,
            outcome: 'success',
            vs: { holder: 'Guard', checkId: 'defense', total: 5 },
        });
        expect(result.text).toBe(
            'Attack (Kai) vs Defense (Guard): 20 vs 5 — success. Consequences: Guard: HP -16; Kai: Mana -10.',
        );
        await tick(10);
        expect(state.value('fight', 'Guard', 'hp')).toBe(4);
    });

    it('a secret mechanic gives the model only its outcome; the roll is hidden from the player', async () => {
        await start(faces(20, 3), [trapDef()]);
        await send(ctx, 'Я крадусь мимо поста.');
        await tick(10);
        const [result] = checks.checks(1);
        expect(result).toMatchObject({ outcome: 'failure', hidden: true, text: 'Sneak: the guards raise the alarm.' });
        expect(state.value('traps', 'Kai', 'alarm')).toBe(3);
    });
});

describe('rolls the model asks for', () => {
    it('are rolled for the reply, survive the user’s next message, reach the next generation, go with a swipe', async () => {
        await start(faces(20, 16, 3));
        const prompt = new MechanicPrompt(ctx.deps, ctx.defs, state, ctx.tracking, checks);
        prompt.install();
        ctx.env.mock.chat.push(reply('Стражник замахивается.'));
        const index = ctx.env.mock.chat.length - 1;
        checks.requested(index, 0, [
            parseRollLine('roll: Attack Kai vs Guard.Defense')!,
            parseRollLine('roll: Dance')!,
        ]);
        await tick(10);
        const [result] = checks.rollsOf(index);
        expect(result).toMatchObject({ by: 'model', holder: 'Kai', vs: { holder: 'Guard' }, outcome: 'success' });
        expect(state.value('fight', 'Guard', 'hp')).toBe(5);
        // The user answers: the roll is still pending and goes into the next generation.
        await send(ctx, 'Дальше.');
        expect(checks.pendingChecks().map((item) => item.id)).toEqual([result!.id]);
        const { slots } = await generate(ctx);
        expect(slots.maestro_mechanics_facts?.value).toContain('Attack (Kai) vs Defense (Guard): 18 vs 4 — success.');
        expect(checks.pendingChecks()).toEqual([]);
        prompt.dispose();
    });

    it('are dropped when the reply is swiped, with their consequences', async () => {
        await start(faces(20, 16, 3));
        ctx.env.mock.chat.push(reply('Удар!'));
        const index = ctx.env.mock.chat.length - 1;
        checks.requested(index, 0, [parseRollLine('roll: Attack Kai vs Guard.Defense')!]);
        await tick(10);
        expect(state.value('fight', 'Guard', 'hp')).toBe(5);
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'swiped' });
        await tick(10);
        expect(checks.rollsOf(index)).toEqual([]);
        expect(state.value('fight', 'Guard', 'hp')).toBe(20);
    });

    it('stop when the setting is off, and at most three per reply', async () => {
        await start(faces(20, 10, 10, 10, 10, 10, 10, 10, 10));
        ctx.settings.modelRolls = false;
        checks.requested(0, 0, [parseRollLine('roll: Attack')!]);
        expect(checks.checks()).toEqual([]);
        ctx.settings.modelRolls = true;
        const many = Array.from({ length: 5 }, () => parseRollLine('roll: Defense Kai')!);
        checks.requested(0, 0, many);
        expect(checks.rollsOf(0)).toHaveLength(3);
        expect(checks.checkNames()).toEqual(['Attack', 'Defense']);
    });
});

describe('the roll in the journal', () => {
    it('carries its consequences: undoing the record takes them back', async () => {
        await start(faces(20, 15));
        await send(ctx, 'Я атакую.');
        await tick(10);
        expect(state.value('fight', 'Kai', 'mana')).toBe(40);
        const record = ctx.env.journal.records.find((item) => item.kind === 'mechanics.check')!;
        expect(record.changes).toEqual([
            {
                target: 'mechanics.batch',
                ref: { chatId: expect.any(String), rollId: checks.checks(1)[0]!.id },
                before: { count: 2 },
                after: null,
            },
        ]);
        expect(await ctx.env.journal.undo(record.id)).toBe(true);
        expect(state.value('fight', 'Kai', 'mana')).toBe(50);
        expect(state.value('fight', 'Kai', 'attack')).toBe(2);
    });

    it('a roll without consequences has nothing to undo', async () => {
        await start(faces(20, 15));
        await checks.roll('fight', 'defense', 'Kai');
        await tick(10);
        expect(ctx.env.journal.records.find((item) => item.kind === 'mechanics.check')?.changes).toEqual([]);
    });
});

describe('hidden rolls', () => {
    it('get no badge and a journal line without the result', async () => {
        await start(faces(20, 3), [trapDef()]);
        await send(ctx, 'Я крадусь мимо поста.');
        await tick(10);
        expect(ctx.badges).toEqual([]);
        const record = ctx.env.journal.records.find((item) => item.kind === 'mechanics.check');
        expect(record?.summary).toBe('A hidden roll (its result stays out of sight)');
    });
});
