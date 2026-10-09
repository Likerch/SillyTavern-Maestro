// M20 with Dramatis (release 1.17): the budget source 'dramatis' measures Dramatis's cast block (`dramatis_cast`) and
// reports it over its budget, but never shortens it — the block belongs to Dramatis, which fits it itself.
import { afterEach, describe, expect, it } from 'vitest';
import { BUDGET_SLOTS, SELF_FITTING } from '../../../src/features/architect/prompt';
import { architectSettings, runTurn, setPrompts, startArchitect, trackerReply, userMessage } from './helpers';
import type { ArchitectTestApp } from './helpers';

let app: ArchitectTestApp;

afterEach(async () => {
    await app?.stop();
});

const CAST = `[Cast]\n${'Ilva — counting the takings; toward Kai: hostile, takes his coin. '.repeat(6).trim()}`;

describe('M20 with Dramatis', () => {
    it('knows the cast block as a measured, never shortened source', () => {
        expect(BUDGET_SLOTS.dramatis).toBe('dramatis_cast');
        expect(SELF_FITTING.has('dramatis')).toBe(true);
    });

    it('measures the block against its budget and leaves the prompt as Dramatis made it', async () => {
        app = await startArchitect({
            world: [{ id: 'character:ilva', kind: 'character', name: 'Ilva', roster: true, present: true }],
        });
        app.env.mock.chat = [userMessage('Hi.'), trackerReply('Ilva looks up.', ['Ilva']), userMessage('A room?')];
        architectSettings(app).budgets.dramatis = 20;
        setPrompts(app, { dramatis_cast: { value: CAST, position: 1, depth: 1 } });
        const messages = [
            { role: 'system', content: 'Main prompt.' },
            { role: 'system', content: CAST },
            { role: 'user', content: 'A room?' },
        ];
        await runTurn(app, { books: [], chatText: '', messages });
        expect(messages[1]?.content).toBe(CAST);
        const row = app.api.lastReport()!.budgets.find((item) => item.source === 'dramatis')!;
        expect(row.status).toBe('over');
        expect(row.cut).toBe(0);
        expect(row.used).toBeGreaterThan(20);

        architectSettings(app).budgets.dramatis = 0;
        await runTurn(app, { books: [], chatText: '', messages });
        expect(app.api.lastReport()!.budgets.find((item) => item.source === 'dramatis')?.status).toBe('off');
    });
});
