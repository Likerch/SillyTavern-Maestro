// M20 with the mechanics of release 1.27: the budget source 'mechanics' measures both of its slots (the state
// `maestro_mechanics` and the rules `maestro_mechanics_rules`) and never shortens them; the P16 order check leaves the
// rules at the top of the prompt alone (stable by design) while it still reports other changing injections there.
import { afterEach, describe, expect, it } from 'vitest';
import { STABLE_SLOTS } from '../../../src/domain/architect-cache';
import { BUDGET_SLOTS, EXTRA_SLOTS, SELF_FITTING } from '../../../src/features/architect/prompt';
import { architectSettings, runTurn, setPrompts, startArchitect, userMessage } from './helpers';
import type { ArchitectTestApp } from './helpers';

let app: ArchitectTestApp;

afterEach(async () => {
    await app?.stop();
});

const RULES = `<game_rules>\n${'## Magic\nCasting a spell costs mana: a minor spell 5–10, a strong one 20–40.\n'.repeat(4)}</game_rules>`;
const STATE =
    '<game_state>\nKai\n- Magic: mana 0/100 (none left)\n- now: Kai has no mana left and cannot cast.\n</game_state>';
const NO_BOOKS = { books: [], chatText: '' };

describe('M20 with the mechanics blocks', () => {
    it('knows both slots of the mechanics as a measured, never shortened source', () => {
        expect(BUDGET_SLOTS.mechanics).toBe('maestro_mechanics');
        expect(EXTRA_SLOTS.mechanics).toEqual(['maestro_mechanics_rules']);
        expect(SELF_FITTING.has('mechanics')).toBe(true);
        expect(STABLE_SLOTS.has('maestro_mechanics_rules')).toBe(true);
    });

    it('measures the rules and the state together and leaves the prompt as the mechanics made it', async () => {
        app = await startArchitect();
        app.env.mock.chat = [userMessage('I cast.')];
        setPrompts(app, {
            maestro_mechanics_rules: { value: RULES, position: 0 },
            maestro_mechanics: { value: STATE, position: 1, depth: 0 },
        });
        const messages = [
            { role: 'system', content: 'Main prompt.' },
            { role: 'system', content: RULES },
            { role: 'user', content: 'I cast.' },
            { role: 'system', content: STATE },
        ];
        architectSettings(app).budgets.mechanics = 2000;
        await runTurn(app, { ...NO_BOOKS, messages });
        const ok = app.api.lastReport()!.budgets.find((item) => item.source === 'mechanics')!;
        expect(ok.status).toBe('ok');
        const both = ok.used;

        setPrompts(app, { maestro_mechanics: { value: STATE, position: 1, depth: 0 } });
        await runTurn(app, { ...NO_BOOKS, messages });
        const stateOnly = app.api.lastReport()!.budgets.find((item) => item.source === 'mechanics')!.used;
        expect(both).toBeGreaterThan(stateOnly);

        setPrompts(app, {
            maestro_mechanics_rules: { value: RULES, position: 0 },
            maestro_mechanics: { value: STATE, position: 1, depth: 0 },
        });
        architectSettings(app).budgets.mechanics = 20;
        await runTurn(app, { ...NO_BOOKS, messages });
        const over = app.api.lastReport()!.budgets.find((item) => item.source === 'mechanics')!;
        expect(over).toMatchObject({ status: 'over', cut: 0, used: both });
        expect(messages[1]?.content).toBe(RULES);
        expect(messages[3]?.content).toBe(STATE);

        // The rules alone (the state empty this turn) still count.
        setPrompts(app, { maestro_mechanics_rules: { value: RULES, position: 0 } });
        await runTurn(app, { ...NO_BOOKS, messages });
        expect(app.api.lastReport()!.budgets.find((item) => item.source === 'mechanics')?.status).toBe('over');
    });

    it('the P16 check does not report the rules at the top; another changing head injection it does', async () => {
        app = await startArchitect();
        app.env.mock.chat = [userMessage('I cast.')];
        setPrompts(app, {
            maestro_mechanics_rules: { value: RULES, position: 0 },
            maestro_head: { value: 'Volatile head.', position: 0 },
        });
        const messages = [
            { role: 'system', content: 'Main prompt.' },
            { role: 'system', content: RULES },
            { role: 'system', content: 'Volatile head.' },
            { role: 'user', content: 'I cast.' },
        ];
        await runTurn(app, { ...NO_BOOKS, messages });
        const order = app.api.lastReport()?.order ?? [];
        expect(order.map((item) => item.key)).toEqual(['maestro_head']);
    });
});
