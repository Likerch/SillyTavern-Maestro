// M25 checks of release 1.27 with the real state: a check that requires something of the roller (mana for a spell)
// rolls no dice without it — auto rolls, rolls by hand (the notice says why) and the model's alike; status modifiers
// count; the fact says the attempt fails, as much as the model may know. Every fact ends with what the outcome means
// for the scene (the author's texts, else a line by outcome, «barely» when close); the block instruction lists only the
// checks of mechanics in the scene.
import { afterEach, describe, expect, it } from 'vitest';
import { parseRollLine } from '../../../src/domain/mechanics-block';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { MechanicChecks } from '../../../src/features/mechanics/checks';
import { MechanicPrompt } from '../../../src/features/mechanics/prompt';
import { MechanicState } from '../../../src/features/mechanics/state';
import { STATE_STRINGS } from '../../../src/features/mechanics/strings-state';
import { createChecksEnv, faces, generate, reply, send, socialDef, tick } from './helpers-checks';
import type { ChecksEnv } from './helpers-checks';

function spellDef(extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'magic',
        name: 'Магия',
        summary: 'Spells.',
        rules: 'Mana fuels spells.',
        attributes: [
            { id: 'mana', name: 'Мана', promptName: 'Mana', kind: 'number', min: 0, max: 100, initial: 50 },
            { id: 'arcana', name: 'Искусство', promptName: 'Arcana', kind: 'number', min: 0, max: 10, initial: 2 },
            { id: 'xp', name: 'Опыт', promptName: 'Experience', kind: 'number', min: 0, initial: 0 },
            { id: 'level', name: 'Уровень', promptName: 'Level', kind: 'number', min: 1, initial: 1 },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'spell',
                name: 'Заклинание',
                promptName: 'Spellcasting',
                dice: '1d20+@arcana',
                difficulty: 12,
                triggers: ['колдую'],
                requires: [{ attr: 'mana', min: 5, note: 'a spell costs at least 5 mana' }],
                effects: [
                    {
                        on: 'success',
                        changes: [{ who: 'actor', attr: 'mana', op: 'sub', value: 10 }],
                        text: 'the spell takes shape',
                    },
                    { on: 'failure', changes: [{ who: 'actor', attr: 'mana', op: 'sub', value: 5 }] },
                    { on: 'any', changes: [], text: 'the air smells of ozone' },
                ],
            },
            {
                id: 'focus',
                name: 'Сосредоточение',
                promptName: 'Focus',
                dice: '1d20',
                difficulty: 12,
                triggers: [],
            },
        ],
        tracking: 'manual',
        scope: { kind: 'global' },
        statuses: [],
        progression: { xp: 'xp', level: 'level', thresholds: [100], awards: { success: 10, failure: 3 } },
        ...extra,
    };
}

let ctx: ChecksEnv;
let state: MechanicState;
let checks: MechanicChecks;
let dice = 0;

async function start(rng: () => number, defs: MechanicDef[] = [spellDef()]): Promise<void> {
    ctx = createChecksEnv({ defs });
    ctx.env.app.i18n.register(STATE_STRINGS);
    state = new MechanicState(ctx.deps, ctx.defs, () => 0.5);
    state.install();
    await state.load();
    dice = 0;
    checks = new MechanicChecks(ctx.deps, ctx.defs, state, {
        rng: () => {
            dice++;
            return rng();
        },
        saveMs: 0,
    });
    checks.install();
    await checks.ready();
}

async function setMana(value: number): Promise<void> {
    await state.apply([
        { mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value, source: 'user', messageIndex: -1 },
    ]);
}

const BLOCKED =
    'Spellcasting (Kai): not possible — mana 3, needs 5 (a spell costs at least 5 mana). The attempt fails; narrate it, there is no roll.';

afterEach(() => {
    checks?.dispose();
    state?.dispose();
});

describe('a check the roller lacks the means for', () => {
    it('an auto roll: no dice, outcome none, the fact says the attempt fails; nothing is spent or gained', async () => {
        await start(faces(20, 15));
        const prompt = new MechanicPrompt(ctx.deps, ctx.defs, state, ctx.tracking, checks);
        prompt.install();
        await setMana(3);
        await send(ctx, 'Я колдую огненный шар.');
        await tick(10);
        const [result] = checks.checks(1);
        expect(result).toMatchObject({
            by: 'auto',
            checkId: 'spell',
            outcome: 'none',
            rolls: [],
            total: 0,
            target: null,
            blocked: { attr: 'mana', have: 3, need: 5 },
            text: BLOCKED,
        });
        expect(result).not.toHaveProperty('consequences');
        expect(dice).toBe(0);
        expect(state.value('magic', 'Kai', 'mana')).toBe(3);
        expect(state.value('magic', 'Kai', 'xp')).toBe(0);
        // The journal line says why.
        expect(ctx.env.journal.records.find((record) => record.kind === 'mechanics.check')?.summary).toBe(
            'Roll: Заклинание (Kai): not possible — Мана 3, needs 5',
        );
        // The model hears it with the next generation.
        const { slots } = await generate(ctx);
        expect(slots.maestro_mechanics_facts?.value).toContain(BLOCKED);
        prompt.dispose();
    });

    it('by hand: the notice says why instead of a roll; status modifiers count toward the minimum', async () => {
        await start(faces(20, 15, 15));
        await setMana(3);
        const blocked = await checks.roll('magic', 'spell', 'Kai');
        expect(blocked).toMatchObject({ by: 'user', outcome: 'none', blocked: { attr: 'mana', have: 3, need: 5 } });
        const command = ctx.slashes.find((spec) => spec.name === 'maestro-roll')!;
        await command.callback({}, 'Заклинание');
        expect(ctx.notices.at(-1)).toEqual({
            text: 'No roll: Заклинание (Kai): not possible — Мана 3, needs 5',
            urgent: true,
        });
        expect(dice).toBe(0);
        await state.applyOps([
            {
                kind: 'status',
                op: 'add',
                mechanicId: 'magic',
                holder: 'Kai',
                status: { name: 'Прилив', modifiers: { mana: 2 } },
                source: 'user',
                messageIndex: -1,
            },
        ]);
        const rolled = await checks.roll('magic', 'spell', 'Kai');
        expect(rolled).not.toHaveProperty('blocked');
        expect(rolled).toMatchObject({ rolls: [15], total: 17, outcome: 'success' });
    });

    it('a roll the model asks for is blocked the same way (aimed at someone: said so)', async () => {
        await start(faces(20, 15));
        await setMana(3);
        ctx.env.mock.chat.push(reply('Кай поднимает руки.'));
        const index = ctx.env.mock.chat.length - 1;
        expect(checks.requested(index, 0, [parseRollLine('roll: Spellcasting Kai vs Guard.Focus')!])).toBe(1);
        const [result] = checks.rollsOf(index);
        expect(result).toMatchObject({
            by: 'model',
            against: 'Guard',
            outcome: 'none',
            blocked: { attr: 'mana', have: 3, need: 5 },
            text: 'Spellcasting (Kai) against Guard: not possible — mana 3, needs 5 (a spell costs at least 5 mana). The attempt fails; narrate it, there is no roll.',
        });
        expect(result).not.toHaveProperty('vs');
        expect(dice).toBe(0);
    });

    it('tells the model only what it may know of the attribute: words, or nothing for a secret mechanic', async () => {
        const words = spellDef();
        words.attributes[0]!.visibility = { prompt: 'words' };
        await start(faces(20, 15), [words]);
        await setMana(3);
        expect((await checks.roll('magic', 'spell', 'Kai')).text).toBe(
            'Spellcasting (Kai): not possible — not enough mana (a spell costs at least 5 mana). The attempt fails; narrate it, there is no roll.',
        );
        checks.dispose();
        state.dispose();
        await start(faces(20, 15), [spellDef({ visibility: { preset: 'secret' } })]);
        await setMana(3);
        const secret = await checks.roll('magic', 'spell', 'Kai');
        expect(secret).toMatchObject({
            hidden: true,
            text: 'Spellcasting (Kai): not possible now. The attempt fails; narrate it, there is no roll.',
        });
    });

    it('enough of it, or a value that cannot be read: the roll goes ahead', async () => {
        const unknown = spellDef();
        unknown.checks[0]!.requires = [{ attr: 'stamina', min: 5 }];
        await start(faces(20, 15), [unknown]);
        expect(await checks.roll('magic', 'spell', 'Kai')).not.toHaveProperty('blocked');
        checks.dispose();
        state.dispose();
        await start(faces(20, 15));
        await setMana(5);
        expect(await checks.roll('magic', 'spell', 'Kai')).not.toHaveProperty('blocked');
    });
});

describe('what an outcome means for the scene', () => {
    it('the author’s outcome text (and the any-outcome one) close the fact; changes stay apart', async () => {
        await start(faces(20, 15));
        const result = await checks.roll('magic', 'spell', 'Kai');
        expect(result.text).toBe(
            'Spellcasting check (Kai): rolled 15 + 2 = 17 vs 12 — success. Consequences: Kai: Mana -10; Kai: Experience +10. In the scene: the spell takes shape; the air smells of ozone.',
        );
        expect(result.consequences).toEqual(['Kai: Mana -10', 'Kai: Experience +10']);
        expect(result).not.toHaveProperty('barely');
    });

    it('a line by outcome when the author wrote none; «barely» when the roll was close', async () => {
        await start(faces(20, 10, 9, 20));
        // 10 + 2 = 12 vs 12: made it by nothing.
        const barely = await checks.roll('magic', 'spell', 'Kai');
        expect(barely).toMatchObject({ outcome: 'success', barely: true });
        expect(barely.text).toContain('In the scene: barely — the spell takes shape; the air smells of ozone.');
        // 9 + 2 = 11 vs 12: the failure has no text of its own.
        const failed = await checks.roll('magic', 'spell', 'Kai');
        expect(failed.text).toBe(
            'Spellcasting check (Kai): rolled 9 + 2 = 11 vs 12 — failure. Consequences: Kai: Mana -5; Kai: Experience +3. In the scene: it barely fails — it nearly works; show what goes wrong and what it costs; the air smells of ozone.',
        );
        // A natural 20 with only a success text: that text, and brilliantly.
        const critical = await checks.roll('magic', 'spell', 'Kai');
        expect(critical.outcome).toBe('critical');
        expect(critical.text).toContain(
            'In the scene: the spell takes shape, and brilliantly, with an extra benefit; the air smells of ozone.',
        );
        expect(critical).not.toHaveProperty('barely');
    });

    it('a plain check: the generic line; no target, no meaning', async () => {
        await start(faces(20, 3, 9));
        expect((await checks.roll('magic', 'focus', 'Kai')).text).toBe(
            'Focus check (Kai): rolled 3 vs 12 — failure. Consequences: Kai: Experience +3. In the scene: it does not work — show what goes wrong and what it costs.',
        );
        checks.dispose();
        state.dispose();
        const luck = spellDef();
        luck.checks[1]!.difficulty = null;
        await start(faces(20, 9), [luck]);
        expect((await checks.roll('magic', 'focus', 'Kai')).text).toBe('Focus check (Kai): rolled 9.');
    });
});

describe('the checks the model may ask for', () => {
    it('are those of mechanics with a holder in the scene', async () => {
        ctx = createChecksEnv({ defs: [socialDef(), spellDef()] });
        checks = new MechanicChecks(ctx.deps, ctx.defs, ctx.state, { rng: faces(20), saveMs: 0 });
        checks.install();
        await checks.ready();
        expect(checks.checkNames()).toEqual([]);
        ctx.state.scene = { magic: ['Kai'] };
        expect(checks.checkNames()).toEqual(['Spellcasting', 'Focus']);
        ctx.state.scene = { magic: ['Kai'], social: ['Guard'] };
        expect(checks.checkNames()).toEqual(['Persuasion', 'Stealth', 'Spellcasting', 'Focus']);
    });
});
