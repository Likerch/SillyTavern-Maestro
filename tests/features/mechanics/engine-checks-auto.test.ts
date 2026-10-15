// M25 auto checks of release 1.26 with the real state: a check aimed at someone gets its target (a holder named in the
// message, else the enemy of the fight, else nobody) and its target consequences hit them; speech checks roll on
// quoted lines and questions; two different checks in one message (never the same one twice); experience by the
// outcome with level ups, taken back with the roll.
import { afterEach, describe, expect, it } from 'vitest';
import type { CombatState, MechanicDef } from '../../../src/features/mechanics/api';
import { AUTO_CHECKS_MAX, MechanicChecks } from '../../../src/features/mechanics/checks';
import { MechanicState } from '../../../src/features/mechanics/state';
import { STATE_STRINGS } from '../../../src/features/mechanics/strings-state';
import { createChecksEnv, faces, send, tick } from './helpers-checks';
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
            { id: 'attack', name: 'Атака', promptName: 'Attack', kind: 'number', min: 0, max: 10, initial: 2 },
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
                ],
            },
        ],
        tracking: 'block',
        scope: { kind: 'global' },
        ...extra,
    };
}

/** A fighting mechanic whose attack has no target consequences of its own. */
function brawlDef(): MechanicDef {
    return {
        id: 'brawl',
        name: 'Драка',
        summary: '',
        rules: 'Punches.',
        attributes: [{ id: 'grit', name: 'Стойкость', promptName: 'Grit', kind: 'number', min: 0, initial: 5 }],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            { id: 'punch', name: 'Удар', promptName: 'Strike', dice: '1d20', difficulty: 10, triggers: ['бью'] },
            { id: 'dodge', name: 'Уклон', promptName: 'Dodge', dice: '1d20', difficulty: 10, triggers: ['уклоня'] },
        ],
        tracking: 'block',
        scope: { kind: 'global' },
        combat: {},
    };
}

function sneakDef(): MechanicDef {
    return {
        id: 'sneak',
        name: 'Скрытность',
        summary: '',
        rules: 'Sneaking.',
        attributes: [{ id: 'stealth', name: 'Скрытность', promptName: 'Stealth', kind: 'number', min: 0, initial: 1 }],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'sneak',
                name: 'Красться',
                promptName: 'Sneak',
                dice: '1d20+@stealth',
                difficulty: 10,
                triggers: ['крад'],
            },
        ],
        tracking: 'block',
        scope: { kind: 'global' },
    };
}

function talkDef(speech = true, extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'talk',
        name: 'Разговор',
        summary: '',
        rules: 'Talking.',
        attributes: [
            { id: 'persuasion', name: 'Убеждение', promptName: 'Persuasion', kind: 'number', min: 0, initial: 2 },
            { id: 'xp', name: 'Опыт', promptName: 'Experience', kind: 'number', min: 0, initial: 0 },
            { id: 'level', name: 'Уровень', promptName: 'Level', kind: 'number', min: 1, initial: 1 },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'persuasion',
                name: 'Убеждение',
                promptName: 'Persuasion',
                dice: '1d20+@persuasion',
                difficulty: 12,
                triggers: ['убед', 'уговор'],
                ...(speech ? { speech: true } : {}),
            },
        ],
        tracking: 'manual',
        scope: { kind: 'global' },
        ...extra,
    };
}

let ctx: ChecksEnv;
let state: MechanicState;
let checks: MechanicChecks;

async function start(rng: () => number, defs: MechanicDef[] = [fightDef()], present = 'Стражник'): Promise<void> {
    ctx = createChecksEnv({ defs });
    ctx.env.app.i18n.register(STATE_STRINGS);
    ctx.env.mock.context.name2 = present;
    state = new MechanicState(ctx.deps, ctx.defs, () => 0.5);
    state.install();
    await state.load();
    checks = new MechanicChecks(ctx.deps, ctx.defs, state, { rng, saveMs: 0 });
    checks.install();
    await checks.ready();
}

async function fight(order: CombatState['order'], current = 0, mechanicId = 'fight'): Promise<void> {
    await state.applyOps([
        {
            kind: 'combat',
            op: 'set',
            mechanicId,
            next: { active: true, round: 1, order, current, mechanicId, startedAt: 0, by: 'user' },
            source: 'user',
            messageIndex: -1,
        },
    ]);
}

afterEach(() => {
    checks?.dispose();
    state?.dispose();
});

describe('the target of an auto roll', () => {
    it('is the holder named in the message (a case form): the attack hurts them, the fact and lines say so', async () => {
        await start(faces(20, 15));
        await send(ctx, 'Я атакую стражника.');
        await tick(10);
        const [result] = checks.checks(1);
        expect(result).toMatchObject({ holder: 'Kai', against: 'Стражник', outcome: 'success' });
        expect(result?.text).toBe(
            'Attack check (Kai) against Стражник: rolled 15 + 2 = 17 vs 12 — success. Consequences: Стражник: HP -6; Kai: Mana -10.',
        );
        expect(state.value('fight', 'Стражник', 'hp')).toBe(14);
        expect(state.value('fight', 'Kai', 'mana')).toBe(40);
        const journal = ctx.env.journal.records.find((record) => record.kind === 'mechanics.check');
        expect(journal?.summary).toBe('Roll: Атака (Kai → Стражник): 17 vs 12 — success');
        // Stored and read back with the log.
        expect(checks.rollsOf(result!.messageIndex)[0]?.against).toBe('Стражник');
        // Taken back with the roll.
        expect(await checks.undoRoll(result!.id)).toBe(true);
        await tick(10);
        expect(state.value('fight', 'Стражник', 'hp')).toBe(20);
    });

    it('in a fight without a name: the current enemy, else the first one still standing', async () => {
        await start(faces(20, 15, 15), [fightDef()], 'Char');
        await fight([
            { holder: 'Kai', init: 15 },
            { holder: 'Wolf', init: 12, enemy: true, out: true },
            { holder: 'Bandit', init: 10, enemy: true },
            { holder: 'Raider', init: 8, enemy: true },
        ]);
        await send(ctx, 'Я атакую!');
        await tick(10);
        expect(checks.checks(1)[0]).toMatchObject({ against: 'Bandit', outcome: 'success' });
        expect(state.value('fight', 'Bandit', 'hp')).toBe(14);

        await fight(
            [
                { holder: 'Kai', init: 15 },
                { holder: 'Bandit', init: 10, enemy: true },
                { holder: 'Raider', init: 8, enemy: true },
            ],
            2,
        );
        await send(ctx, 'Снова атакую.');
        await tick(10);
        expect(checks.checks(1)[0]?.against).toBe('Raider');
        expect(state.value('fight', 'Raider', 'hp')).toBe(14);
    });

    it('in a fight a companion named in another sentence is spared; a named enemy is chosen', async () => {
        await start(faces(20, 15, 15, 15), [fightDef()], 'Мира');
        const order = [
            { holder: 'Kai', init: 15 },
            { holder: 'Мира', init: 14 },
            { holder: 'Bandit', init: 10, enemy: true },
            { holder: 'Райдер', init: 8, enemy: true },
        ];
        await fight(order);
        // A short name is found by the world's case forms.
        const mira = { name: 'Мира', aliases: [], forms: ['Миру', 'Миры', 'Мирой'] };
        ctx.env.modules.expose('world', {
            resolve: (name: string) => ([mira.name, ...mira.forms].includes(name) ? mira : undefined),
        });
        await send(ctx, 'Мира рядом. Я атакую!');
        expect(checks.checks(1)[0]?.against).toBe('Bandit');
        await send(ctx, 'Райдер скалится. Я атакую!');
        expect(checks.checks(1)[0]?.against).toBe('Райдер');
        // Named in the sentence of the attack, she is the target after all.
        await send(ctx, 'Я атакую Миру.');
        expect(checks.checks(1)[0]?.against).toBe('Мира');
    });

    it('outside a fight a holder named in another sentence is the target', async () => {
        await start(faces(20, 15));
        await send(ctx, 'Стражник преграждает путь. Я атакую!');
        expect(checks.checks(1)[0]?.against).toBe('Стражник');
    });

    it('an enemy who attacks aims at the other side', async () => {
        await start(faces(20, 15), [fightDef()], 'Char');
        await fight([
            { holder: 'Bandit', init: 15, enemy: true },
            { holder: 'Kai', init: 10 },
        ]);
        await send(ctx, 'Bandit атакует.');
        await tick(10);
        expect(checks.checks(1)[0]).toMatchObject({ holder: 'Bandit', against: 'Kai' });
        expect(state.value('fight', 'Kai', 'hp')).toBe(14);
    });

    it('nobody named and no fight: no target, its consequences are skipped', async () => {
        await start(faces(20, 15), [fightDef()], 'Char');
        await send(ctx, 'Я атакую.');
        await tick(10);
        const [result] = checks.checks(1);
        expect(result).not.toHaveProperty('against');
        expect(result?.text).toBe(
            'Attack check (Kai): rolled 15 + 2 = 17 vs 12 — success. Consequences: Kai: Mana -10.',
        );
        expect(state.value('fight', 'Char', 'hp')).toBe(20);
    });

    it('an attack of a fighting mechanic is aimed even without target consequences; other checks are not', async () => {
        await start(faces(20, 15, 15), [brawlDef()], 'Char');
        await fight(
            [
                { holder: 'Kai', init: 15 },
                { holder: 'Bandit', init: 10, enemy: true },
            ],
            0,
            'brawl',
        );
        await send(ctx, 'Я бью.');
        expect(checks.checks(1)[0]).toMatchObject({
            checkId: 'punch',
            against: 'Bandit',
            text: 'Strike check (Kai) against Bandit: rolled 15 vs 10 — success.',
        });
        await send(ctx, 'Я уклоняюсь.');
        expect(checks.checks(1)[0]?.checkId).toBe('dodge');
        expect(checks.checks(1)[0]).not.toHaveProperty('against');
    });

    it('rolls by hand and opposed checks keep their own sides', async () => {
        await start(faces(20, 15, 5));
        const result = await checks.roll('fight', 'attack', 'Kai', { vs: { holder: 'Guard' } });
        expect(result).not.toHaveProperty('against');
        expect(result.vs?.holder).toBe('Guard');
    });
});

describe('two checks in one message', () => {
    it('different checks in different clauses roll both; the same one never twice', async () => {
        expect(AUTO_CHECKS_MAX).toBe(2);
        await start(faces(20, 15, 15, 15, 15), [fightDef(), sneakDef()]);
        const index = await send(ctx, 'Я крадусь к посту, а потом атакую стражника.');
        await tick(10);
        const rolls = checks.rollsOf(index);
        expect(rolls.map((roll) => [roll.checkId, roll.holder, roll.against ?? null])).toEqual([
            ['sneak', 'Kai', null],
            ['attack', 'Kai', 'Стражник'],
        ]);
        expect(state.value('fight', 'Стражник', 'hp')).toBe(14);

        const again = await send(ctx, 'Я атакую, атакую и снова атакую.');
        expect(checks.rollsOf(again)).toHaveLength(1);
        const oneClause = await send(ctx, 'Я крадусь атакуя.');
        expect(checks.rollsOf(oneClause)).toHaveLength(1);
    });

    it('never in group chats', async () => {
        await start(faces(20, 15, 15), [fightDef(), sneakDef()]);
        ctx.env.host.group = true;
        const index = await send(ctx, 'Я крадусь, а потом атакую стражника.');
        expect(checks.rollsOf(index)).toEqual([]);
    });

    it('an edit keeps the roll still called for and takes back the other', async () => {
        await start(faces(20, 15, 15, 15), [fightDef(), sneakDef()]);
        const index = await send(ctx, 'Я крадусь, а потом атакую стражника.');
        await tick(10);
        const [sneak] = checks.rollsOf(index);
        expect(state.value('fight', 'Стражник', 'hp')).toBe(14);
        ctx.env.mock.chat[index]!.mes = 'Я крадусь мимо.';
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'edited' });
        await tick(10);
        expect(checks.rollsOf(index).map((roll) => roll.id)).toEqual([sneak!.id]);
        expect(state.value('fight', 'Стражник', 'hp')).toBe(20);
    });
});

describe('speech checks', () => {
    it('roll on a quoted line and on a question', async () => {
        await start(faces(20, 15, 15), [talkDef()]);
        const quoted = await send(ctx, '«Позволь мне тебя убедить», — говорю я.');
        expect(checks.rollsOf(quoted)[0]).toMatchObject({ checkId: 'persuasion', holder: 'Kai' });
        const question = await send(ctx, 'Может, уговорю его?');
        expect(checks.rollsOf(question)).toHaveLength(1);
    });

    it('other checks do not', async () => {
        await start(faces(20, 15, 15), [talkDef(false)]);
        expect(checks.rollsOf(await send(ctx, '«Позволь мне тебя убедить», — говорю я.'))).toEqual([]);
        expect(checks.rollsOf(await send(ctx, 'Может, уговорю его?'))).toEqual([]);
    });
});

describe('experience', () => {
    const progression = {
        xp: 'xp',
        level: 'level',
        thresholds: [10, 30],
        awards: { success: 10, failure: 3 },
    };

    it('the roller gains the award of the outcome, levels up, and the roll takes both back', async () => {
        await start(faces(20, 15, 3), [talkDef(true, { progression })]);
        const index = await send(ctx, 'Я пытаюсь убедить его.');
        await tick(10);
        const [result] = checks.rollsOf(index);
        expect(result).toMatchObject({ outcome: 'success' });
        expect(result?.consequences).toEqual(['Kai: Experience +10']);
        expect(result?.text).toBe(
            'Persuasion check (Kai): rolled 15 + 2 = 17 vs 12 — success. Consequences: Kai: Experience +10.',
        );
        expect(state.value('talk', 'Kai', 'xp')).toBe(10);
        expect(state.value('talk', 'Kai', 'level')).toBe(2);
        const changes = state.history(10).filter((change) => change.rollId === result?.id);
        expect(changes.map((change) => [change.attribute, change.source])).toEqual(
            expect.arrayContaining([
                ['xp', 'check'],
                ['level', 'event'],
            ]),
        );

        expect(await checks.undoRoll(result!.id)).toBe(true);
        await tick(10);
        expect(state.value('talk', 'Kai', 'xp')).toBe(0);
        expect(state.value('talk', 'Kai', 'level')).toBe(1);

        // A failure is worth less (a critical without its own award would count as a success).
        await send(ctx, 'Я снова пытаюсь убедить его.');
        await tick(10);
        expect(checks.checks(1)[0]?.outcome).toBe('failure');
        expect(state.value('talk', 'Kai', 'xp')).toBe(3);
        expect(state.value('talk', 'Kai', 'level')).toBe(1);
    });

    it('an NPC rolling by hand gains it too; a mechanic without awards gives none', async () => {
        await start(faces(20, 15, 15), [talkDef(true, { progression })]);
        await checks.roll('talk', 'persuasion', 'Guard');
        await tick(10);
        expect(state.value('talk', 'Guard', 'xp')).toBe(10);

        ctx.defs.defs = [talkDef(true, { progression: { xp: 'xp', level: 'level', thresholds: [10] } })];
        await checks.roll('talk', 'persuasion', 'Kai');
        await tick(10);
        expect(state.value('talk', 'Kai', 'xp')).toBe(0);
    });

    it('nobody outside the mechanic’s holders gains it', async () => {
        await start(faces(20, 15), [talkDef(true, { progression, holders: { kind: 'persona' } })]);
        const result = await checks.roll('talk', 'persuasion', 'Guard');
        await tick(10);
        expect(result.outcome).toBe('success');
        expect(result).not.toHaveProperty('consequences');
        expect(state.value('talk', 'Guard', 'xp')).toBe(0);
    });
});
