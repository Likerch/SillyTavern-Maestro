// @vitest-environment happy-dom
// M25 release 1.27, a roll in the middle of a reply: the model stops at `roll: …`, the checks part rolls it as the reply
// arrives, and once the reply's generation has ended and the reply is shown (in either order: ST ends a streamed
// generation before MESSAGE_RECEIVED, a non-streamed one after it) Maestro sends `/continue` once — the continue
// generation gets the results as facts and marks them delivered. Never a second time for the same variant, never with
// text in the send box, while a generation runs, for a stopped generation, for an edit, or with the setting off (the
// results then wait for the next generation, and the debug log says why); `continuing(index)` holds until the continue
// ends.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseRollLine } from '../../../src/domain/mechanics-block';
import { MechanicChecks } from '../../../src/features/mechanics/checks';
import { MechanicPrompt } from '../../../src/features/mechanics/prompt';
import { RollContinue } from '../../../src/features/mechanics/roll-continue';
import type { GenerationInfo } from '../../../src/shared/contracts';
import { createChecksEnv, faces, generate, NORMAL, reply, send, tick } from './helpers-checks';
import type { ChecksEnv } from './helpers-checks';

let ctx: ChecksEnv;
let checks: MechanicChecks;
let prompt: MechanicPrompt;
let rolls: RollContinue;
/** What Maestro's turn pipeline sees running. */
let running: GenerationInfo | null = null;

const FACT = 'Persuasion check (Kai): rolled 14 vs 15 — failure.';
const CONTINUE: GenerationInfo = { type: 'continue', dryRun: false, quiet: false };

beforeEach(async () => {
    document.body.innerHTML = '<textarea id="send_textarea"></textarea>';
    ctx = createChecksEnv();
    ctx.state.scene = { social: ['Kai', 'Guard'] };
    running = null;
    ctx.env.app.turn.current = () => running;
    checks = new MechanicChecks(ctx.deps, ctx.defs, ctx.state, { rng: faces(20, 14, 18, 7), saveMs: 0 });
    checks.install();
    await checks.ready();
    prompt = new MechanicPrompt(ctx.deps, ctx.defs, ctx.state, ctx.tracking, checks);
    prompt.install();
    rolls = new RollContinue(ctx.deps, { startWaitMs: 200, planTtlMs: 300 });
    rolls.install();
});

afterEach(() => {
    rolls.dispose();
    prompt.dispose();
    checks.dispose();
    document.body.innerHTML = '';
});

/** The block's roll requests are rolled (tracking → checks.requested → rollContinue.rolled, as index.ts wires them). */
function blockRolls(index: number, lines: string[], arrival: string | null = 'normal'): void {
    const requests = lines.map((line) => parseRollLine(line)!);
    if (checks.requested(index, 0, requests) > 0) rolls.rolled(index, 0, arrival ?? undefined);
}

async function ended(type = 'normal', stopped = false): Promise<void> {
    running = null;
    ctx.ephemeral.clearAll();
    await ctx.env.app.bus.emit('generation:ended', { type, stopped });
}

/**
 * A reply arrives the way ST brings it: its generation runs; streamed, the generation ends first (hideStopButton), then
 * MESSAGE_RECEIVED (the block's rolls) and the render (reply:ready); not streamed, the end comes last.
 */
async function arrive(text: string, lines: string[], options: { streamed?: boolean } = {}): Promise<number> {
    running = NORMAL;
    await ctx.ephemeral.run(NORMAL);
    ctx.env.mock.chat.push(reply(text));
    const index = ctx.env.mock.chat.length - 1;
    if (options.streamed) await ended();
    blockRolls(index, lines);
    await ctx.env.app.bus.emit('reply:ready', { messageIndex: index, type: 'normal' });
    if (!options.streamed) await ended();
    await tick(5);
    return index;
}

/** The /continue generation: it begins, gets its facts, and ends. */
async function continued(): Promise<string> {
    running = CONTINUE;
    await ctx.env.app.bus.emit('generation:before', CONTINUE);
    const { slots } = await generate(ctx, { type: 'continue' }, { skip: true });
    await ended('continue');
    await tick(5);
    return slots.maestro_mechanics_facts?.value ?? '';
}

function debugLines(): string[] {
    return ctx.env.logLines.filter((line) => line.level === 'debug').map((line) => String(line.args[0]));
}

describe('a roll in the middle of a reply', () => {
    it('continues the same reply once; the continue generation gets the result and marks it delivered', async () => {
        await send(ctx, 'Я подхожу к стражнику.');
        const index = await arrive('Стражник хмурится.', ['roll: Persuasion Kai']);
        expect(ctx.env.slash).toEqual(['/continue']);
        expect(rolls.continuing(index)).toBe(true);
        expect(checks.pendingChecks().map((result) => result.text)).toEqual([expect.stringContaining(FACT)]);

        const facts = await continued();
        expect(facts).toContain(FACT);
        expect(checks.pendingChecks()).toEqual([]);
        expect(rolls.continuing(index)).toBe(false);
    });

    it('a swipe of the continued reply does not hear its old variant’s roll again (the user’s still)', async () => {
        await send(ctx, 'Я пытаюсь убедить стражника.');
        const index = await arrive('Стражник хмурится.', ['roll: Persuasion Kai']);
        const facts = await continued();
        expect(facts).toContain(FACT);
        expect(facts).toContain('Persuasion check (Kai): rolled 18 vs 15 — success.');
        ctx.env.mock.chat[index]!.swipe_id = 1;
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'swiped' });
        const { slots } = await generate(ctx, { type: 'swipe' });
        expect(slots.maestro_mechanics_facts?.value).toContain(FACT);
        expect(slots.maestro_mechanics_facts?.value).not.toContain('rolled 18');
    });

    it('a streamed reply (its generation ends before it arrives) waits until it is shown', async () => {
        running = NORMAL;
        ctx.env.mock.chat.push(reply('Стражник хмурится.'));
        const index = ctx.env.mock.chat.length - 1;
        await ended();
        blockRolls(index, ['roll: Persuasion Kai']);
        await tick(5);
        expect(ctx.env.slash).toEqual([]);
        expect(rolls.continuing(index)).toBe(true);
        await ctx.env.app.bus.emit('reply:ready', { messageIndex: index, type: 'normal' });
        await tick(5);
        expect(ctx.env.slash).toEqual(['/continue']);
    });

    it('a continuation that asks for more rolls is not continued again: they wait for the next generation', async () => {
        await send(ctx, 'Я подхожу к стражнику.');
        const index = await arrive('Стражник хмурится.', ['roll: Persuasion Kai'], { streamed: true });
        running = CONTINUE;
        await ctx.env.app.bus.emit('generation:before', CONTINUE);
        await ctx.ephemeral.run(CONTINUE);
        await ended('continue');
        // The continuation's own block asks again (rolled as it arrives).
        blockRolls(index, ['roll: Persuasion Kai'], 'continue');
        await ctx.env.app.bus.emit('reply:ready', { messageIndex: index, type: 'continue' });
        await tick(5);
        expect(ctx.env.slash).toEqual(['/continue']);
        expect(rolls.continuing(index)).toBe(false);
        expect(debugLines().some((line) => line.includes('continued once already'))).toBe(true);
        // The second roll reaches the next generation (the user's next message).
        expect(checks.pendingChecks()).toHaveLength(1);
        await send(ctx, 'Дальше.');
        const { slots } = await generate(ctx);
        expect(slots.maestro_mechanics_facts?.value).toContain('Persuasion check (Kai): rolled 18 vs 15 — success.');
    });

    it('not with text in the send box: the result waits for the next generation', async () => {
        (document.querySelector('#send_textarea') as HTMLTextAreaElement).value = 'Я ещё пишу…';
        await send(ctx, 'Я подхожу к стражнику.');
        const index = await arrive('Стражник хмурится.', ['roll: Persuasion Kai']);
        expect(ctx.env.slash).toEqual([]);
        expect(rolls.continuing(index)).toBe(false);
        expect(debugLines()).toContain(
            `mechanics: reply #${index} is not continued (the send box is not empty); the roll results go to the next generation`,
        );
        expect(checks.pendingChecks()).toHaveLength(1);
        await send(ctx, 'Дальше.');
        const { slots } = await generate(ctx);
        expect(slots.maestro_mechanics_facts?.value).toContain(FACT);
    });

    it('not while a generation runs, not for a stopped one, not for another variant', async () => {
        await send(ctx, 'Я подхожу к стражнику.');
        // Something else started generating before the continue could go.
        let busy = true;
        ctx.env.app.bus.on('reply:ready', () => {
            if (busy) running = NORMAL;
        });
        await arrive('Стражник хмурится.', ['roll: Persuasion Kai'], { streamed: true });
        busy = false;
        running = null;
        expect(ctx.env.slash).toEqual([]);
        expect(debugLines().some((line) => line.includes('(a generation runs)'))).toBe(true);

        // Stopped by the user: ST ends the generation, then says it stopped, then the partial reply arrives.
        running = NORMAL;
        ctx.env.mock.chat.push(reply('Стражник мол…'));
        const stopped = ctx.env.mock.chat.length - 1;
        await ended();
        await ended('normal', true);
        blockRolls(stopped, ['roll: Persuasion Kai']);
        await ctx.env.app.bus.emit('reply:ready', { messageIndex: stopped, type: 'normal' });
        await tick(5);
        expect(ctx.env.slash).toEqual([]);
        expect(rolls.continuing(stopped)).toBe(false);
        expect(debugLines().some((line) => line.includes('(its generation was stopped)'))).toBe(true);

        // The plan is for variant 0; variant 1 is shown when it is time.
        running = NORMAL;
        await ctx.env.app.bus.emit('generation:before', NORMAL);
        ctx.env.mock.chat.push(reply('Стражник зевает.'));
        const index = ctx.env.mock.chat.length - 1;
        blockRolls(index, ['roll: Persuasion Kai']);
        ctx.env.mock.chat[index]!.swipe_id = 1;
        await ctx.env.app.bus.emit('reply:ready', { messageIndex: index, type: 'normal' });
        await ended();
        await tick(5);
        expect(ctx.env.slash).toEqual([]);
        expect(debugLines().some((line) => line.includes('(another variant of it is shown)'))).toBe(true);
    });

    it('only for a reply arriving now (an edit rolls but does not continue), and only with the setting on', async () => {
        ctx.env.mock.chat.push(reply('Стражник хмурится.'));
        const edited = ctx.env.mock.chat.length - 1;
        // An edit: no arrival.
        blockRolls(edited, ['roll: Persuasion Kai'], null);
        expect(checks.rollsOf(edited)).toHaveLength(1);
        expect(rolls.continuing(edited)).toBe(false);
        await ctx.env.app.bus.emit('reply:ready', { messageIndex: edited, type: 'normal' });
        await ended();
        await tick(5);
        expect(ctx.env.slash).toEqual([]);

        ctx.settings.rollContinue = false;
        await arrive('Стражник молчит.', ['roll: Persuasion Kai']);
        expect(ctx.env.slash).toEqual([]);
        ctx.settings.rollContinue = true;
        ctx.settings.modelRolls = false;
        await arrive('Стражник ждёт.', ['roll: Persuasion Kai']);
        expect(ctx.env.slash).toEqual([]);
    });

    it('a /continue that never starts lets the reply go; a deleted reply generated anew may continue again', async () => {
        await send(ctx, 'Я подхожу к стражнику.');
        const index = await arrive('Стражник хмурится.', ['roll: Persuasion Kai']);
        expect(rolls.continuing(index)).toBe(true);
        await tick(250);
        expect(rolls.continuing(index)).toBe(false);
        expect(debugLines()).toContain(`mechanics: the /continue of reply #${index} never started`);

        ctx.env.mock.chat.splice(index, 1);
        await ctx.env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'deleted' });
        await arrive('Стражник снова хмурится.', ['roll: Persuasion Kai']);
        expect(ctx.env.slash).toEqual(['/continue', '/continue']);
    });

    it('a plan whose reply is never shown goes stale; a chat change drops the plan', async () => {
        running = NORMAL;
        ctx.env.mock.chat.push(reply('Стражник хмурится.'));
        const index = ctx.env.mock.chat.length - 1;
        blockRolls(index, ['roll: Persuasion Kai']);
        await ended();
        expect(rolls.continuing(index)).toBe(true);
        await tick(350);
        expect(rolls.continuing(index)).toBe(false);
        expect(debugLines().some((line) => line.includes('(it was never shown)'))).toBe(true);

        running = NORMAL;
        blockRolls(index, ['roll: Persuasion Kai']);
        expect(rolls.continuing(index)).toBe(true);
        await ctx.env.app.bus.emit('chat:changed', { chatId: 'other' });
        expect(rolls.continuing(index)).toBe(false);
        await ctx.env.app.bus.emit('reply:ready', { messageIndex: index, type: 'normal' });
        await ended();
        await tick(5);
        expect(ctx.env.slash).toEqual([]);
    });
});
