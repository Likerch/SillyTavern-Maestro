import { describe, expect, it } from 'vitest';
import { findDuplicateFacts } from '../../src/domain/architect-dupes';
import { sentenceKey } from '../../src/domain/architect-text';

const SCAR = 'Anna has an old scar across her left cheek from the war.';

describe('findDuplicateFacts', () => {
    it('finds the same sentence in lore and in a Qvink memory', () => {
        const groups = findDuplicateFacts([
            { owner: 'lore', ref: 'World#1', group: 'lore:World', text: `Anna is a mage. ${SCAR} She likes tea.` },
            { owner: 'qvink', ref: 'qvink_memory_short', text: `[Recent events]:\n* ${SCAR}\n* They left.` },
        ]);
        expect(groups).toHaveLength(1);
        const group = groups[0]!;
        expect(group.text).toBe(SCAR);
        expect(group.members.map((member) => member.ref)).toEqual(['World#1', 'qvink_memory_short']);
        expect(group.keys).toContain(sentenceKey(SCAR));
        expect(group.id).toMatch(/^d[0-9a-z]+$/);
        expect(group.members[0]!.tokens).toBeGreaterThan(0);
    });

    it('matches small rewordings by shingles but not different facts', () => {
        const reworded = 'Anna has an old scar across her left cheek from the long war.';
        const groups = findDuplicateFacts([
            { owner: 'canon', ref: 'Canon#4', text: SCAR },
            { owner: 'ck', ref: 'carrotkernel_rag', text: `### Anna — Looks\n${reworded}` },
            {
                owner: 'des',
                ref: 'dooms-tracker-context',
                text: 'Bob has a wooden leg since the shipwreck near the coast.',
            },
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.members.map((member) => member.owner)).toEqual(['canon', 'ck']);
        expect(groups[0]!.keys).toHaveLength(2);
    });

    it('ignores repeats inside one group, short sentences and protected lines', () => {
        const groups = findDuplicateFacts([
            { owner: 'lore', ref: 'World#1', group: 'lore:World', text: SCAR },
            { owner: 'lore', ref: 'World#2', group: 'lore:World', text: SCAR },
            { owner: 'qvink', ref: 'q', text: 'Anna has a scar.' },
            { owner: 'des', ref: 'd', text: '<context>Anna has a scar.</context>' },
            { owner: 'ck', ref: 'c', text: '' },
        ]);
        expect(groups).toEqual([]);
    });

    it('treats two books as two sources and keeps one member per source', () => {
        const groups = findDuplicateFacts([
            { owner: 'lore', ref: 'World#1', group: 'lore:World', text: `${SCAR} ${SCAR}` },
            { owner: 'lore', ref: 'Npc#9', group: 'lore:Npc', text: SCAR },
        ]);
        expect(groups).toHaveLength(1);
        expect(groups[0]!.members).toHaveLength(2);
    });

    it('orders by weight and respects the limit', () => {
        const long = 'The northern fortress has seven towers and a deep moat filled with black water and eels.';
        const groups = findDuplicateFacts(
            [
                { owner: 'lore', ref: 'W#1', group: 'lore:W', text: `${SCAR} ${long}` },
                { owner: 'qvink', ref: 'q', text: `${SCAR} ${long}` },
            ],
            { limit: 1 },
        );
        expect(groups).toHaveLength(1);
        expect(groups[0]!.text).toBe(long);
    });

    it('joins chains of similar sentences into one fact', () => {
        // S2 ~ S1, S3 ~ S0 and S3 ~ S2, while S0 and S1/S2 are unrelated: one group of four sources.
        const groups = findDuplicateFacts(
            [
                { owner: 'a', ref: 'a', text: 'w1 w2 w3 w4 w5 w6 w7 w8 x1 x2' },
                { owner: 'b', ref: 'b', text: 'y1 y2 y3 y4 y5 y6 z1 z2 z3 z4' },
                { owner: 'c', ref: 'c', text: 'y1 y2 y3 y4 y5 y6 w5 w6 w7 w8' },
                { owner: 'd', ref: 'd', text: 'w1 w2 w3 w4 w5 w6 w7 w8 y1 y2 y3 y4 y5 y6' },
            ],
            { threshold: 0.3 },
        );
        expect(groups).toHaveLength(1);
        expect(groups[0]!.members.map((member) => member.ref)).toEqual(['a', 'b', 'c', 'd']);
    });

    it('ignores boilerplate shingles shared by many sentences', () => {
        const sources = Array.from({ length: 80 }, (_, index) => ({
            owner: `o${index}`,
            ref: `r${index}`,
            text: `the quick brown fox number ${index} jumps over item ${index * 7} today`,
        }));
        expect(findDuplicateFacts(sources)).toEqual([]);
    });
});
