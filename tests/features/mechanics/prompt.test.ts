// M25 prompt part: the producer sets the rules injection and the flags only when mechanics take part in the scene,
// gives the facts (rolls, events) once and again to swipes of the same reply, skips quiet and sheet generations, keeps
// the block instruction out of impersonation, and respects the budget (the Architect's first).
import { afterEach, describe, expect, it } from 'vitest';
import type { FiredEvent } from '../../../src/features/mechanics/api';
import { MechanicChecks } from '../../../src/features/mechanics/checks';
import { INJECT_FACTS, INJECT_RULES } from '../../../src/features/mechanics/parts';
import {
    FACTS_KEY,
    MechanicPrompt,
    RULES_KEY,
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
        expect(`maestro_${RULES_KEY}`).toBe(INJECT_RULES);
        expect(`maestro_${FACTS_KEY}`).toBe(INJECT_FACTS);
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

describe('rules and state', () => {
    it('nothing when no mechanic has a holder in the scene', async () => {
        await start();
        ctx.state.scene = {};
        const { slots, flags } = await generate(ctx);
        expect(slots).toEqual({});
        expect(flags).toEqual({});
        expect(prompt.preview()).toMatchObject({ text: '', tokens: 0, mechanics: [], flags: [] });
    });

    it('the rules and state of the mechanics in the scene near the end, with their flags', async () => {
        await start();
        ctx.settings.depth = 3;
        ctx.state.set('magic', 'Kai', 'mana', 12);
        ctx.state.set('magic', 'Kai', 'schools', ['fire']);
        const { slots, flags } = await generate(ctx);
        expect(slots[INJECT_RULES]).toEqual({
            value: [
                '[Mechanics] Общение: Charisma helps persuade; stealth hides. | Kai: charisma 10 (1..20), stealth 40/100 | Elizabeth: charisma 10 (1..20), stealth 40/100',
                'Магия: Casting costs mana; at 0 mana no spells. | Kai: mana 12/30, schools: fire, rank: novice (1/3), element: none',
            ].join('\n'),
            position: 1,
            depth: 3,
            scan: false,
            role: 0,
        });
        expect(flags).toEqual({ maestro_mech_social: '1', maestro_mech_magic: '1' });
        expect(slots[INJECT_FACTS]).toBeUndefined();
        // Cleared after the generation.
        expect(ctx.prompts()[INJECT_RULES]?.value).toBe('');
        expect(ctx.flags()).toEqual({});
    });

    it('only mechanics on in this chat take part', async () => {
        await start();
        ctx.defs.off.add('social');
        const { slots, flags } = await generate(ctx);
        expect(slots[INJECT_RULES]?.value.startsWith('[Mechanics] Магия:')).toBe(true);
        expect(Object.keys(flags)).toEqual(['maestro_mech_magic']);
    });

    it('appends the block instruction of the tracking part', async () => {
        await start();
        ctx.tracking.instruction = 'End your reply with <mechanics>…</mechanics>.';
        const { slots } = await generate(ctx);
        expect(slots[INJECT_RULES]?.value.endsWith('\nEnd your reply with <mechanics>…</mechanics>.')).toBe(true);
        expect(ctx.tracking.calls.at(-1)).toEqual({
            defs: ['social', 'magic'],
            holders: { social: ['Kai', 'Elizabeth'], magic: ['Kai'] },
        });
    });

    it('fits the own budget, or the Architect’s when it is set', async () => {
        await start();
        ctx.settings.promptBudget = 40;
        const own = prompt.preview();
        expect(own.budgetSource).toBe('own');
        expect(own.budget).toBe(40);
        expect(own.tokens).toBeLessThanOrEqual(40);
        expect(own.cut.length).toBeGreaterThan(0);
        expect(own.flags).toEqual(['maestro_mech_social', 'maestro_mech_magic']);

        ctx.env.modules.expose('architect', { budgets: () => [{ source: 'mechanics', tokens: 2000 }] });
        const architect = prompt.preview();
        expect(architect).toMatchObject({ budget: 2000, budgetSource: 'architect', cut: [] });
        const { slots } = await generate(ctx);
        expect(slots[INJECT_RULES]?.value).toBe(architect.text);

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

    it('impersonation gets the state without the block instruction and without facts', async () => {
        await start();
        ctx.tracking.instruction = 'BLOCK FORMAT';
        await send(ctx, 'Я пытаюсь убедить стражника.');
        const { slots, flags } = await generate(ctx, { type: 'impersonate' });
        expect(slots[INJECT_RULES]?.value).not.toContain('BLOCK FORMAT');
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
