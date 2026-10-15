// @vitest-environment happy-dom
// M25 release 1.27 end to end with the real tracking, state and checks: a reply arrives with `roll: …` in its service
// block (MESSAGE_RECEIVED), the block leaves the text, the roll is made, and once the generation has ended and the
// reply is shown (either order: streamed or not) Maestro continues the same reply once; an edit that adds a roll rolls
// it but continues nothing. The block instruction of the real tracking part tells the model to stop at the roll
// (setting on) or to wait for the result next turn (off).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { MechanicChecks } from '../../../src/features/mechanics/checks';
import type { PartDeps } from '../../../src/features/mechanics/parts';
import { RollContinue } from '../../../src/features/mechanics/roll-continue';
import type { GenerationInfo } from '../../../src/shared/contracts';
import { faces } from './helpers-checks';
import { createMechanicsEnv } from './helpers-state';
import type { MechanicsEnv } from './helpers-state';

function spellDef(): MechanicDef {
    return {
        id: 'magic',
        name: 'Магия',
        summary: 'Spells.',
        rules: 'Mana fuels spells.',
        attributes: [{ id: 'mana', name: 'Мана', promptName: 'Mana', kind: 'number', min: 0, max: 100, initial: 50 }],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'spell',
                name: 'Заклинание',
                promptName: 'Spellcasting',
                dice: '1d20',
                difficulty: 12,
                triggers: [],
                effects: [{ on: 'success', changes: [], text: 'the spell takes shape' }],
            },
        ],
        tracking: 'block',
        scope: { kind: 'global' },
    };
}

const NORMAL: GenerationInfo = { type: 'normal', dryRun: false, quiet: false };
const BLOCK = '<mechanics>\nroll: Spellcasting\n</mechanics>';

let env: MechanicsEnv;
let checks: MechanicChecks;
let rolls: RollContinue;
let running: GenerationInfo | null;
let slash: string[];

beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '<textarea id="send_textarea"></textarea>';
    env = createMechanicsEnv();
    env.defs.defs = [spellDef()];
    await env.start();
    slash = [];
    (env.mock.context as unknown as Record<string, unknown>).executeSlashCommandsWithOptions = async (text: string) => {
        slash.push(text);
        return '';
    };
    running = null;
    env.app.turn.current = () => running;
    const deps: PartDeps = { app: env.app, log: env.app.log, settings: () => env.settings };
    checks = new MechanicChecks(deps, env.defs, env.state, { rng: faces(20, 15), saveMs: 0 });
    checks.install();
    await checks.ready();
    rolls = new RollContinue(deps);
    rolls.install();
    // As index.ts wires them.
    env.tracking.onRollRequests((index, swipeId, requests, info) => {
        if (checks.requested(index, swipeId, requests) > 0) rolls.rolled(index, swipeId, info.arrival);
    });
});

afterEach(() => {
    rolls.dispose();
    checks.dispose();
    env.stop();
    vi.useRealTimers();
    document.body.innerHTML = '';
});

describe('a roll in the middle of a reply, end to end', () => {
    it('the block asks, the roll is made on arrival, the same reply continues once', async () => {
        running = NORMAL;
        const index = await env.receive(
            'Алекс поднимает руки и шепчет заклинание.\n<mechanics>\nroll: Spellcasting\n</mechanics>',
        );
        expect(env.mock.chat[index]!.mes).toBe('Алекс поднимает руки и шепчет заклинание.');
        const [result] = checks.rollsOf(index);
        expect(result).toMatchObject({ by: 'model', outcome: 'success' });
        expect(result?.text).toContain('In the scene: the spell takes shape.');
        expect(rolls.continuing(index)).toBe(true);
        // Not streamed: shown, then the generation ends.
        await env.app.bus.emit('reply:ready', { messageIndex: index, type: 'normal' });
        await env.tick(5);
        expect(slash).toEqual([]);
        running = null;
        await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await env.tick(5);
        expect(slash).toEqual(['/continue']);
    });

    it('streamed: the generation ends before the reply arrives; it continues once shown', async () => {
        running = NORMAL;
        await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        running = null;
        const index = await env.receive(`Алекс шепчет.\n${BLOCK}`, [], 'swipe');
        expect(checks.rollsOf(index)).toHaveLength(1);
        await env.app.bus.emit('reply:ready', { messageIndex: index, type: 'swipe' });
        await env.tick(5);
        expect(slash).toEqual(['/continue']);
    });

    it('an edit that adds a roll rolls it but continues nothing', async () => {
        const index = await env.receive('Алекс шепчет.');
        const message = env.mock.chat[index]!;
        message.mes = `Алекс шепчет.\n${BLOCK}`;
        await env.mock.eventSource.emit('message_edited', index);
        expect(checks.rollsOf(index)).toHaveLength(1);
        expect(rolls.continuing(index)).toBe(false);
        await env.app.bus.emit('reply:ready', { messageIndex: index, type: 'normal' });
        await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await env.tick(5);
        expect(slash).toEqual([]);
    });

    it('the instruction: stop at the roll and go on in the same reply, or (off) the result next turn', () => {
        const scene = { magic: ['Алекс'] };
        expect(env.tracking.blockInstruction(env.defs.defs, scene, { checks: ['Spellcasting'] })).toContain(
            'Maestro rolls at once and this same reply then continues with the result. Checks: Spellcasting.',
        );
        env.settings.rollContinue = false;
        expect(env.tracking.blockInstruction(env.defs.defs, scene, { checks: ['Spellcasting'] })).toContain(
            'Maestro rolls and gives you the result next turn. Checks: Spellcasting.',
        );
    });
});
