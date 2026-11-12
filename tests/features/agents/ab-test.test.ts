// Release 1.33 «Сравнение вслепую»: replies the main model illustrated, the illustrator's marker for each from a test
// run, both drawn again by the same NAI Studio path free only, shown in random order; the tally and its verdict.
import { describe, expect, it } from 'vitest';
import { abVerdict, buildPairs, candidateReplies, summarize } from '../../../src/features/agents/ab-test';
import type { AbPair } from '../../../src/features/agents/ab-test';
import type { AgentRunner } from '../../../src/features/agents/runner';
import { stagingPoses } from '../../../src/domain/staging';
import type { AgentDef } from '../../../src/domain/agents/types';
import type { App } from '../../../src/shared/contracts';
import { createTestLogger } from '../../helpers/core-host';

function setup() {
    const chat = [
        { is_user: false, mes: 'A' },
        { is_user: true, mes: 'B' },
        { is_user: false, mes: 'C' },
        { is_user: false, mes: 'D' },
    ];
    const markers: Record<number, unknown[]> = {
        0: [{ imageId: 'a', marker: { prompt: 'main zero' }, status: 'done' }],
        2: [{ imageId: 'c', marker: { prompt: 'main two' }, status: 'done' }],
        // The illustrator's own marker is not the main model's: not a candidate.
        3: [{ imageId: 'd', marker: { prompt: 'by the illustrator' }, status: 'done', by: 'illustrator' }],
    };
    const drawn: Record<string, unknown>[] = [];
    const app = {
        host: { ctx: () => ({ chat }) },
        adapters: {
            nai: {
                messageMarkers: (index: number) => markers[index] ?? [],
                drawPicture: async (input: { marker: { prompt: string } }) => {
                    drawn.push(input);
                    return { ok: true, path: `user/images/${input.marker.prompt.replace(/ /g, '_')}.png` };
                },
            },
        },
    } as unknown as App;
    const runs: number[] = [];
    const runner = {
        run: async (request: { focusIndex: number; test: boolean }) => {
            runs.push(request.focusIndex);
            expect(request.test).toBe(true);
            // The illustrator draws nothing for reply 0.
            const items =
                request.focusIndex === 0
                    ? []
                    : [{ kind: 'nai.illustrate', why: '', data: { marker: { prompt: 'agent two' } } }];
            return { run: { ok: true }, output: { type: 'proposals', items } };
        },
    } as unknown as AgentRunner;
    return { app, runner, drawn, runs };
}

describe('blind comparison', () => {
    it('pairs of the same reply drawn by the same path, free only, in random order', async () => {
        const { app, runner, drawn, runs } = setup();
        expect(candidateReplies(app).map((c) => c.index)).toEqual([2, 0]);
        const progress: string[] = [];
        const { pairs, failures } = await buildPairs(app, createTestLogger(), runner, { id: 'ill' } as AgentDef, {
            signal: new AbortController().signal,
            onProgress: (p) => progress.push(`${p.done}/${p.total}`),
            random: () => 0.2,
        });
        expect(runs).toEqual([2, 0]);
        expect(progress).toEqual(['0/2', '1/2', '2/2']);
        expect(pairs).toEqual([
            {
                messageIndex: 2,
                main: { path: 'user/images/main_two.png', prompt: 'main two' },
                agent: { path: 'user/images/agent_two.png', prompt: 'agent two' },
                agentLeft: true,
            },
        ]);
        expect(drawn.every((input) => input.freeOnly === true)).toBe(true);
        // Reply 0: the illustrator proposed no picture.
        expect(failures).toEqual(['no-picture']);
    });

    it('the tally and the verdict', () => {
        const pair = (choice: AbPair['choice']): AbPair => ({
            messageIndex: 1,
            main: { path: 'm', prompt: 'm' },
            agent: { path: 'a', prompt: 'a' },
            agentLeft: false,
            ...(choice ? { choice } : {}),
        });
        const summary = summarize([pair('agent'), pair('main'), pair('same'), pair('agent'), pair(undefined)], 'I', 5);
        expect(summary).toEqual({ at: 5, agentName: 'I', total: 4, agent: 2, main: 1, same: 1 });
        expect(abVerdict(summary)).toBe('agent');
        expect(abVerdict({ agent: 1, main: 1 })).toBe('tie');
        expect(abVerdict({ agent: 0, main: 2 })).toBe('main');
    });
});

describe('staging poses for NAI Studio', () => {
    it('pose, place, what is held, what is visible; people without any are left out', () => {
        expect(
            stagingPoses([
                { name: 'Мира', pose: 'сидит', where: 'у камина', holding: 'кружку', state: 'мокрая' },
                { name: 'Кай', near: 'рядом с Мирой' },
                { name: 'Вера', where: 'в дверях' },
            ]),
        ).toEqual([
            { name: 'Мира', pose: 'сидит у камина, holding кружку, мокрая' },
            { name: 'Вера', pose: 'в дверях' },
        ]);
    });
});
