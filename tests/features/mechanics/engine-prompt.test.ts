// M25 prompt of plan-2 §6–6.А with the real state: values as visibility allows (words for «book», nothing for secret
// attributes), numbers with modifiers, the mention line, the conditions and inventories of the holders in the scene,
// the fight's turn order, and the checks the model may ask for in the block instruction.
import { afterEach, describe, expect, it } from 'vitest';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { MechanicChecks } from '../../../src/features/mechanics/checks';
import { INJECT_RULES } from '../../../src/features/mechanics/parts';
import { MechanicPrompt } from '../../../src/features/mechanics/prompt';
import { MechanicState } from '../../../src/features/mechanics/state';
import { createChecksEnv, faces, generate } from './helpers-checks';
import type { ChecksEnv } from './helpers-checks';

function heroDef(): MechanicDef {
    return {
        id: 'hero',
        name: 'Герой',
        promptName: 'Hero',
        summary: '',
        rules: 'Be brave.',
        attributes: [
            { id: 'hp', name: 'Здоровье', promptName: 'HP', kind: 'number', min: 0, max: 20, initial: 20 },
            {
                id: 'trust',
                name: 'Доверие',
                promptName: 'Trust',
                kind: 'number',
                min: 0,
                max: 100,
                initial: 15,
                visibility: { preset: 'book' },
            },
            {
                id: 'doom',
                name: 'Рок',
                promptName: 'Doom',
                kind: 'number',
                initial: 3,
                visibility: { preset: 'secret' },
            },
            { id: 'might', name: 'Мощь', promptName: 'Might', kind: 'number', formula: '@hp / 2' },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [{ id: 'brave', name: 'Отвага', promptName: 'Bravery', dice: '1d20', difficulty: 10, triggers: [] }],
        tracking: 'block',
        scope: { kind: 'global' },
        statuses: [],
        inventory: {},
        combat: {},
    };
}

function secretDef(): MechanicDef {
    return {
        ...heroDef(),
        id: 'plot',
        name: 'Сюжет',
        promptName: 'Plot',
        attributes: [{ id: 'clock', name: 'Часы', promptName: 'Clock', kind: 'number', initial: 1 }],
        checks: [{ id: 'omen', name: 'Знамение', promptName: 'Omen', dice: '1d6', difficulty: null, triggers: [] }],
        visibility: { preset: 'secret' },
        statuses: [],
        inventory: undefined,
        combat: undefined,
    };
}

let ctx: ChecksEnv;
let state: MechanicState;
let checks: MechanicChecks;
let prompt: MechanicPrompt;

async function start(): Promise<void> {
    ctx = createChecksEnv({ defs: [heroDef(), secretDef()] });
    ctx.env.mock.context.name2 = 'Mira';
    state = new MechanicState(ctx.deps, ctx.defs, () => 0.5);
    state.install();
    await state.load();
    checks = new MechanicChecks(ctx.deps, ctx.defs, state, { rng: faces(20, 10), saveMs: 0 });
    checks.install();
    await checks.ready();
    prompt = new MechanicPrompt(ctx.deps, ctx.defs, state, ctx.tracking, checks);
    prompt.install();
}

afterEach(() => {
    prompt?.dispose();
    checks?.dispose();
    state?.dispose();
});

describe('the rules block of plan-2 §6', () => {
    it('honours visibility, adds conditions, inventories and the fight, lists the checks the model may ask for', async () => {
        await start();
        ctx.tracking.instruction = '[Mechanics block] fake';
        await state.applyOps([
            {
                kind: 'status',
                op: 'add',
                mechanicId: 'hero',
                holder: 'Kai',
                status: { name: 'Ранен', promptName: 'wounded', duration: { turns: 2 }, modifiers: { hp: -4 } },
                source: 'user',
                messageIndex: -1,
            },
            {
                kind: 'status',
                op: 'add',
                mechanicId: 'plot',
                holder: 'Kai',
                status: { name: 'Проклят', promptName: 'cursed' },
                source: 'user',
                messageIndex: -1,
            },
            {
                kind: 'item',
                op: 'give',
                mechanicId: 'hero',
                holder: 'Kai',
                item: { name: 'rope' },
                qty: 2,
                source: 'user',
                messageIndex: -1,
            },
            {
                kind: 'combat',
                op: 'set',
                mechanicId: 'hero',
                next: {
                    active: true,
                    round: 2,
                    order: [
                        { holder: 'Kai', init: 14 },
                        { holder: 'Bandit', init: 9, enemy: true },
                    ],
                    current: 0,
                    mechanicId: 'hero',
                    startedAt: 0,
                    by: 'user',
                },
                source: 'user',
                messageIndex: -1,
            },
        ]);
        const { slots } = await generate(ctx);
        const text = slots[INJECT_RULES]?.value ?? '';
        expect(text.split('\n')).toEqual([
            '[Mechanics] Hero: Be brave. Changes: trust in words only, never as numbers. | Mira: hp 20/20, trust 15/100, might 10 | Kai: hp 16/20, trust 15/100, might 8 | Bandit: hp 20/20, trust 15/100, might 10',
            '[Conditions] Kai: wounded (2 turns left)',
            '[Inventory] Kai: rope x2',
            '[Combat] Round 2. Turn order: Kai 14, Bandit 9 (enemy). Now acting: Kai. Keep the fight to this order; one round per reply.',
            '[Mechanics block] fake',
        ]);
        // The secret mechanic: neither its values nor its status nor its checks reach the model.
        expect(text).not.toContain('Plot');
        expect(text).not.toContain('cursed');
        expect(text).not.toContain('Doom');
        expect(checks.checkNames()).toEqual(['Bravery']);
        expect(prompt.preview().text).toBe(text);
    });

    it('without model rolls the instruction is asked for without checks', async () => {
        await start();
        ctx.settings.modelRolls = false;
        await generate(ctx);
        expect(ctx.tracking.calls.at(-1)?.defs).toEqual(['hero', 'plot']);
    });
});

describe('facts of plan-2 §6', () => {
    it('the end of a secret mechanic’s status is not told; a visible one is', async () => {
        await start();
        await state.applyOps([
            {
                kind: 'status',
                op: 'add',
                mechanicId: 'plot',
                holder: 'Kai',
                status: { name: 'Doomed' },
                source: 'user',
                messageIndex: -1,
            },
            {
                kind: 'status',
                op: 'add',
                mechanicId: 'hero',
                holder: 'Kai',
                status: { name: 'Dazed' },
                source: 'user',
                messageIndex: -1,
            },
        ]);
        await state.applyOps([
            {
                kind: 'status',
                op: 'remove',
                mechanicId: 'plot',
                holder: 'Kai',
                ref: 'doomed',
                expired: true,
                source: 'time',
                messageIndex: 0,
            },
            {
                kind: 'status',
                op: 'remove',
                mechanicId: 'hero',
                holder: 'Kai',
                ref: 'dazed',
                expired: true,
                source: 'time',
                messageIndex: 0,
            },
        ]);
        expect(state.pendingEvents()).toHaveLength(2);
        const { slots } = await generate(ctx);
        const facts = slots.maestro_mechanics_facts?.value ?? '';
        expect(facts).toContain('Kai is no longer Dazed.');
        expect(facts).not.toContain('Doomed');
        expect(prompt.preview().facts).toBe('');
        expect(state.pendingEvents()).toEqual([]);
    });
});
