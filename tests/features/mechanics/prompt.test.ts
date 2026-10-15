// M25 prompt part (release 1.27): the producer sets two injections and the flags only when mechanics take part in the
// scene — the rules (`<game_rules>`, in the prompt after the main prompt, or right before the state) and the state
// (`<game_state>`, in the chat at the state depth) — orders the mechanics by importance, adds DES's tracker line, gives
// the facts (rolls, events) once and again to swipes of the same reply right after the state, skips quiet and sheet
// generations, keeps the block instruction out of impersonation, and respects the budget (the Architect's first).
import { afterEach, describe, expect, it } from 'vitest';
import { RULES_FRAME } from '../../../src/domain/mechanics-prompt';
import type { FiredEvent, StateChange } from '../../../src/features/mechanics/api';
import { MechanicChecks } from '../../../src/features/mechanics/checks';
import { INJECT_FACTS, INJECT_RULES, INJECT_STATE } from '../../../src/features/mechanics/parts';
import {
    FACTS_KEY,
    MechanicPrompt,
    RULES_KEY,
    STATE_KEY,
    joinBlocks,
    mechanicFlag,
    mechanicFlags,
} from '../../../src/features/mechanics/prompt';
import { changeChat, createChecksEnv, faces, generate, magicDef, reply, send, socialDef, tick } from './helpers-checks';
import type { ChecksEnv } from './helpers-checks';

let ctx: ChecksEnv;
let checks: MechanicChecks;
let prompt: MechanicPrompt;

afterEach(() => {
    prompt?.dispose();
    checks?.dispose();
});

async function start(rng: () => number = faces(20, 14, 9, 17, 3, 5, 6, 7, 8, 10, 11, 12)): Promise<void> {
    ctx = createChecksEnv();
    ctx.state.scene = { social: ['Kai', 'Elizabeth'], magic: ['Kai'] };
    checks = new MechanicChecks(ctx.deps, ctx.defs, ctx.state, { rng, saveMs: 0 });
    checks.install();
    await checks.ready();
    prompt = new MechanicPrompt(ctx.deps, ctx.defs, ctx.state, ctx.tracking, checks);
    prompt.install();
}

const PERSUASION_FACT = 'Persuasion check (Kai): rolled 14 vs 15 — failure.';

function event(text: string): FiredEvent {
    return { mechanicId: 'magic', holder: 'Kai', attribute: 'mana', eventId: 'empty', text, messageIndex: 2, at: 7 };
}

describe('keys and flags', () => {
    it('give the extension prompt slots of the contract', () => {
        expect(`maestro_${STATE_KEY}`).toBe(INJECT_STATE);
        expect(INJECT_STATE).toBe('maestro_mechanics');
        expect(`maestro_${RULES_KEY}`).toBe(INJECT_RULES);
        expect(INJECT_RULES).toBe('maestro_mechanics_rules');
        expect(`maestro_${FACTS_KEY}`).toBe(INJECT_FACTS);
        // ST joins the slots of one depth and role in key order: the facts come right after the state.
        expect([INJECT_FACTS, INJECT_STATE].sort()).toEqual([INJECT_STATE, INJECT_FACTS]);
    });

    it('lists one flag per mechanic for the Preset Studio', () => {
        const odd = { ...magicDef(), id: 'my-magic', name: '' };
        expect(mechanicFlags([socialDef(), magicDef(), magicDef(), odd])).toEqual([
            { flag: 'maestro_mech_social', label: 'Общение' },
            { flag: 'maestro_mech_magic', label: 'Магия' },
            { flag: 'maestro_mech_my_magic', label: 'my-magic' },
        ]);
        expect(mechanicFlag('a.b')).toBe('maestro_mech_a_b');
    });
});

const RULES = [
    '<game_rules>',
    RULES_FRAME.top,
    '',
    '## Общение',
    'Charisma helps persuade; stealth hides.',
    '',
    '## Магия',
    'Casting costs mana; at 0 mana no spells.',
    '</game_rules>',
].join('\n');

const STATE = [
    '<game_state>',
    "Kai (the user's character)",
    '- Общение: charisma 10 (1..20, moderate), stealth 40/100 (low)',
    '- Магия: mana 12/30 (low), schools: fire, rank: novice (1/3), element: none',
    'Elizabeth',
    '- Общение: charisma 10 (1..20, moderate), stealth 40/100 (low)',
    'Write this reply in line with these values.',
    '</game_state>',
].join('\n');

describe('rules and state', () => {
    it('nothing when no mechanic has a holder in the scene', async () => {
        await start();
        ctx.state.scene = {};
        const { slots, flags } = await generate(ctx);
        expect(slots).toEqual({});
        expect(flags).toEqual({});
        expect(prompt.preview()).toMatchObject({ text: '', rules: '', state: '', tokens: 0, mechanics: [], flags: [] });
    });

    it('the rules at the top of the prompt, the state in the chat at its depth, with their flags', async () => {
        await start();
        ctx.settings.stateDepth = 3;
        ctx.state.set('magic', 'Kai', 'mana', 12);
        ctx.state.set('magic', 'Kai', 'schools', ['fire']);
        const { slots, flags } = await generate(ctx);
        expect(slots[INJECT_RULES]).toEqual({ value: RULES, position: 0, depth: 0, scan: false, role: 0 });
        expect(slots[INJECT_STATE]).toEqual({ value: STATE, position: 1, depth: 3, scan: false, role: 0 });
        expect(flags).toEqual({ maestro_mech_social: '1', maestro_mech_magic: '1' });
        expect(slots[INJECT_FACTS]).toBeUndefined();
        expect(prompt.preview()).toMatchObject({
            text: joinBlocks(RULES, STATE),
            rules: RULES,
            state: STATE,
            placement: { rules: 'top', stateDepth: 3 },
        });
        // Cleared after the generation.
        expect(ctx.prompts()[INJECT_RULES]?.value).toBe('');
        expect(ctx.prompts()[INJECT_STATE]?.value).toBe('');
        expect(ctx.flags()).toEqual({});
    });

    it('rules next to the state: one slot, the rules right before the values', async () => {
        await start();
        ctx.settings.rulesPlace = 'end';
        ctx.state.set('magic', 'Kai', 'mana', 12);
        ctx.state.set('magic', 'Kai', 'schools', ['fire']);
        const { slots } = await generate(ctx);
        expect(slots[INJECT_RULES]).toBeUndefined();
        const rules = RULES.replace(RULES_FRAME.top, RULES_FRAME.end);
        expect(slots[INJECT_STATE]).toEqual({
            value: `${rules}\n${STATE}`,
            position: 1,
            depth: 0,
            scan: false,
            role: 0,
        });
        expect(prompt.preview().placement).toEqual({ rules: 'end', stateDepth: 0 });
    });

    it('only mechanics on in this chat take part', async () => {
        await start();
        ctx.defs.off.add('social');
        const { slots, flags } = await generate(ctx);
        expect(slots[INJECT_RULES]?.value).toContain('## Магия');
        expect(slots[INJECT_RULES]?.value).not.toContain('Общение');
        expect(Object.keys(flags)).toEqual(['maestro_mech_magic']);
    });

    it('ends the state with the block instruction of the tracking part (the rules stay stable)', async () => {
        await start();
        ctx.tracking.instruction = 'End your reply with <mechanics>…</mechanics>.';
        const { slots } = await generate(ctx);
        expect(
            slots[INJECT_STATE]?.value.endsWith('</game_state>\nEnd your reply with <mechanics>…</mechanics>.'),
        ).toBe(true);
        expect(slots[INJECT_RULES]?.value).not.toContain('<mechanics>');
        expect(ctx.tracking.calls.at(-1)).toEqual({
            defs: ['social', 'magic'],
            holders: { social: ['Kai', 'Elizabeth'], magic: ['Kai'] },
        });
    });

    it('the state names a lasting event while it holds, every generation', async () => {
        await start();
        ctx.state.set('magic', 'Kai', 'mana', 0);
        for (let i = 0; i < 2; i++) {
            const { slots } = await generate(ctx);
            expect(slots[INJECT_STATE]?.value).toContain('- Магия: mana 0/30 (none left),');
            expect(slots[INJECT_STATE]?.value).toContain('- now: Kai is out of mana.');
        }
        ctx.state.set('magic', 'Kai', 'mana', 3);
        expect(prompt.preview().state).not.toContain('now:');
    });

    it('orders the mechanics: facts of this generation, changed lately, named by the user, the rest', async () => {
        await start();
        const order = () => {
            const state = prompt.preview().state;
            return state.indexOf('- Магия') < state.indexOf('- Общение') ? 'magic' : 'social';
        };
        expect(order()).toBe('social');
        // Named in the user's latest message (an attribute's name, any case).
        await send(ctx, 'Собираю всю ману, что осталась.');
        expect(order()).toBe('magic');
        // Changed in the last two turns.
        await send(ctx, 'Дальше.');
        const change: StateChange = {
            id: 'c1',
            mechanicId: 'social',
            holder: 'Kai',
            attribute: 'stealth',
            from: 40,
            to: 30,
            source: 'block',
            messageIndex: ctx.env.mock.chat.length - 1,
            at: 1,
        };
        ctx.state.changes = [change];
        expect(order()).toBe('social');
        await send(ctx, 'Ещё раз.');
        await send(ctx, 'И ещё.');
        expect(order()).toBe('social');
        await send(ctx, 'Колдую с последней маной.');
        // An old change no longer counts; the name does.
        expect(order()).toBe('magic');
        // A fact of this generation wins.
        ctx.state.pending = [
            {
                mechanicId: 'social',
                holder: 'Kai',
                attribute: 'stealth',
                eventId: 'x',
                text: 'Kai is seen.',
                messageIndex: 1,
                at: 1,
            },
        ];
        expect(order()).toBe('social');
        // The rules keep their own order whatever the importance.
        const rules = prompt.preview().rules;
        expect(rules.indexOf('## Общение')).toBeLessThan(rules.indexOf('## Магия'));
    });

    it('adds DES’s tracker line for the stats DES keeps for the characters of the scene', async () => {
        await start();
        Object.assign(ctx.tracking, {
            desTracked: (def: { id: string }) =>
                def.id === 'social'
                    ? [
                          { attribute: 'charisma', stat: 'Charisma' },
                          { attribute: 'stealth', stat: 'Скрытность' },
                      ]
                    : [{ attribute: 'mana', stat: 'Mana' }],
        });
        const state = prompt.preview().state;
        expect(state).toContain(
            '\nTracker stats: Charisma, Скрытность in your tracker JSON are these same values — start from the numbers above and change them only by what happens in this reply.\nWrite this reply in line with these values.',
        );
        // Magic has only the user's character in the scene: DES does not track him.
        expect(state).not.toContain('Mana in your tracker');
    });

    it('fits the own budget, or the Architect’s when it is set', async () => {
        await start();
        ctx.settings.promptBudget = 40;
        const own = prompt.preview();
        expect(own.budgetSource).toBe('own');
        expect(own.budget).toBe(40);
        expect(own.tokens).toBeLessThanOrEqual(40);
        expect(own.cut[0]).toMatchObject({ kind: 'rules' });
        expect(own.flags).toEqual(['maestro_mech_social', 'maestro_mech_magic']);

        ctx.env.modules.expose('architect', { budgets: () => [{ source: 'mechanics', tokens: 2000 }] });
        const architect = prompt.preview();
        expect(architect).toMatchObject({ budget: 2000, budgetSource: 'architect', cut: [] });
        const { slots } = await generate(ctx);
        expect(joinBlocks(slots[INJECT_RULES]?.value ?? '', slots[INJECT_STATE]?.value ?? '')).toBe(architect.text);

        ctx.env.modules.expose('architect', { budgets: () => [{ source: 'mechanics', tokens: 0 }] });
        expect(prompt.preview().budgetSource).toBe('own');
        ctx.env.modules.expose('architect', {
            budgets: () => {
                throw new Error('off');
            },
        });
        expect(prompt.preview().budget).toBe(40);
        ctx.settings.promptBudget = 0;
        expect(prompt.preview()).toMatchObject({ budget: 0, cut: [] });
    });

    it('survives parts that throw', async () => {
        await start();
        ctx.state.holdersInScene = () => {
            throw new Error('no scene');
        };
        const { slots } = await generate(ctx);
        expect(slots).toEqual({});
    });
});

describe('facts', () => {
    it('a roll goes into the next generation once, at depth 0', async () => {
        await start();
        await send(ctx, 'Я пытаюсь убедить стражника.');
        const first = await generate(ctx);
        expect(first.slots[INJECT_FACTS]).toEqual({
            value: `[Mechanics results — already decided; narrate them as given, do not change them]\n- ${PERSUASION_FACT}`,
            position: 1,
            depth: 0,
            scan: false,
            role: 0,
        });
        expect(checks.pendingChecks()).toEqual([]);
        // Same depth and role as the state (stateDepth 0): ST merges them in one message, the facts after the state.
        expect(first.slots[INJECT_STATE]).toMatchObject({ position: 1, depth: 0, role: 0 });
        ctx.env.mock.chat.push(reply());
        await send(ctx, 'Дальше.');
        const next = await generate(ctx);
        expect(next.slots[INJECT_FACTS]).toBeUndefined();
    });

    it('swipes, regenerations and continues of the same reply get it again — never a new roll', async () => {
        await start();
        await send(ctx, 'Я пытаюсь убедить стражника.');
        await generate(ctx);
        ctx.env.mock.chat.push(reply());
        const swipe = await generate(ctx, { type: 'swipe' });
        expect(swipe.slots[INJECT_FACTS]?.value).toContain(PERSUASION_FACT);
        const more = await generate(ctx, { type: 'continue' });
        expect(more.slots[INJECT_FACTS]?.value).toContain(PERSUASION_FACT);
        ctx.env.mock.chat.pop();
        const regenerated = await generate(ctx, { type: 'regenerate' });
        expect(regenerated.slots[INJECT_FACTS]?.value).toContain(PERSUASION_FACT);
        expect(checks.checks()).toHaveLength(1);
    });

    it('a roll made between the reply and its swipe joins the repeated facts', async () => {
        await start();
        await send(ctx, 'Я пытаюсь убедить стражника.');
        await generate(ctx);
        ctx.env.mock.chat.push(reply());
        const manual = await checks.roll('social', 'persuasion', 'Elizabeth');
        const swipe = await generate(ctx, { type: 'swipe' });
        expect(swipe.slots[INJECT_FACTS]?.value).toContain(PERSUASION_FACT);
        expect(swipe.slots[INJECT_FACTS]?.value).toContain(manual.text);
        const again = await generate(ctx, { type: 'swipe' });
        expect(again.slots[INJECT_FACTS]?.value.split('\n')).toHaveLength(3);
    });

    it('a roll edited away is not repeated', async () => {
        await start();
        const index = await send(ctx, 'Я пытаюсь убедить стражника.');
        await generate(ctx);
        ctx.env.mock.chat[index]!.mes = 'Я жду.';
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'edited' });
        ctx.env.mock.chat.push(reply());
        const swipe = await generate(ctx, { type: 'swipe' });
        expect(swipe.slots[INJECT_FACTS]).toBeUndefined();
    });

    it('a stopped generation leaves them pending for the next one', async () => {
        await start();
        await send(ctx, 'Я пытаюсь убедить стражника.');
        await generate(ctx, {}, { stopped: true });
        expect(checks.pendingChecks()).toHaveLength(1);
        const regenerated = await generate(ctx, { type: 'regenerate' });
        expect(regenerated.slots[INJECT_FACTS]?.value).toContain(PERSUASION_FACT);
        expect(checks.pendingChecks()).toEqual([]);
    });

    it('fired events go out once and are marked delivered', async () => {
        await start();
        const fired = event('Kai is out of mana.');
        ctx.state.pending = [fired];
        const first = await generate(ctx);
        expect(first.slots[INJECT_FACTS]?.value).toContain('- Kai is out of mana.');
        await tick();
        expect(ctx.state.delivered).toEqual([[fired]]);
        expect(ctx.state.pending).toEqual([]);
        ctx.env.mock.chat.push(reply());
        const swipe = await generate(ctx, { type: 'swipe' });
        expect(swipe.slots[INJECT_FACTS]?.value).toContain('- Kai is out of mana.');
        expect(ctx.state.delivered).toHaveLength(1);
    });

    it('at most eight facts, the newest', async () => {
        await start();
        for (let i = 0; i < 10; i++) await checks.roll('social', 'persuasion', 'Kai', { difficulty: i + 1 });
        const { slots } = await generate(ctx);
        const lines = slots[INJECT_FACTS]?.value.split('\n') ?? [];
        expect(lines).toHaveLength(9);
        expect(lines.at(-1)).toContain('vs 10');
        expect(checks.pendingChecks()).toEqual([]);
        expect(prompt.preview().facts).toBe('');
    });

    it('a chat change forgets what was delivered', async () => {
        await start();
        await send(ctx, 'Я пытаюсь убедить стражника.');
        await generate(ctx);
        await changeChat(ctx, 'chat-1', [...ctx.env.mock.chat, reply()]);
        const swipe = await generate(ctx, { type: 'swipe' });
        expect(swipe.slots[INJECT_FACTS]).toBeUndefined();
    });
});

describe('generations left alone', () => {
    it('quiet, dry, sheet and chat-less generations get nothing and deliver nothing', async () => {
        await start();
        await send(ctx, 'Я пытаюсь убедить стражника.');
        expect((await generate(ctx, { type: 'quiet', quiet: true })).slots).toEqual({});
        expect((await generate(ctx, { dryRun: true })).slots).toEqual({});
        expect((await generate(ctx, { sheetCommand: 'fullsheet' })).slots).toEqual({});
        expect(checks.pendingChecks()).toHaveLength(1);
        await changeChat(ctx, undefined);
        expect((await generate(ctx)).slots).toEqual({});
    });

    it('impersonation gets the rules without the block instruction, the state, and no facts', async () => {
        await start();
        ctx.tracking.instruction = 'BLOCK FORMAT';
        await send(ctx, 'Я пытаюсь убедить стражника.');
        const { slots, flags } = await generate(ctx, { type: 'impersonate' });
        expect(slots[INJECT_RULES]?.value).toContain('## Общение');
        expect(slots[INJECT_RULES]?.value).not.toContain('BLOCK FORMAT');
        expect(slots[INJECT_STATE]?.value).toContain('<game_state>');
        expect(slots[INJECT_FACTS]).toBeUndefined();
        expect(Object.keys(flags)).toHaveLength(2);
        expect(checks.pendingChecks()).toHaveLength(1);
    });

    it('nothing once disposed', async () => {
        await start();
        prompt.dispose();
        prompt.dispose();
        expect((await generate(ctx)).slots).toEqual({});
    });
});
