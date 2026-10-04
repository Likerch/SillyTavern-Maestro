import { describe, expect, it } from 'vitest';
import {
    COMPARE_SCHEMA,
    buildCompareMessages,
    buildCompareSnippets,
    estimateCompare,
    parseCompareResult,
} from '../../src/domain/dossier-compare';

const sources = [
    { store: 'lorebook entry', label: 'Lyra', text: 'Lyra has long silver hair and green eyes.' },
    { store: 'empty', label: 'x', text: '   ' },
    { store: 'NAI image passport (tags)', label: 'Lyra', text: '1girl, elf, short black hair' },
    { store: 'scene tracker', label: 'Лира', text: 'appearance: короткие чёрные волосы' },
];

describe('snippets and messages', () => {
    it('numbers non-empty sources and shares the character budget', () => {
        const snippets = buildCompareSnippets(sources, 6000);
        expect(snippets.map((snippet) => snippet.id)).toEqual(['S1', 'S2', 'S3']);
        expect(snippets[1]?.store).toBe('NAI image passport (tags)');
        const long = buildCompareSnippets([{ store: 'a', label: 'a', text: 'word '.repeat(400) }], 1000);
        expect(long[0]!.text.length).toBeLessThanOrEqual(1001);
        expect(buildCompareSnippets([{ store: 'a', label: 'a', text: ' ' }], 1000)).toEqual([]);
        const tight = buildCompareSnippets(
            [
                { store: 'a', label: 'a', text: 'x'.repeat(500) },
                { store: 'b', label: 'b', text: 'y'.repeat(500) },
            ],
            100,
        );
        expect(tight[0]!.text.length).toBeGreaterThanOrEqual(300);
    });

    it('builds English instructions and the stored texts', () => {
        const snippets = buildCompareSnippets(sources, 6000);
        const [system, user] = buildCompareMessages('Лира', ['Лира', 'Lyra', ' '], snippets);
        expect(system?.role).toBe('system');
        expect(system?.content).toContain('contradictions');
        expect(user?.content).toContain('Entity: Лира (also known as: Lyra)');
        expect(user?.content).toContain('[S3] scene tracker: Лира\nappearance: короткие чёрные волосы');
        expect(buildCompareMessages('Lyra', [], snippets)[1]?.content.startsWith('Entity: Lyra\n')).toBe(true);
        expect(COMPARE_SCHEMA.required).toEqual(['findings']);
    });

    it('estimates tokens and cost', () => {
        const estimate = estimateCompare(buildCompareSnippets(sources, 6000));
        expect(estimate.input).toBeGreaterThan(450);
        expect(estimate.output).toBe(600);
        expect(estimate.usd).toBeGreaterThan(0);
    });
});

describe('parseCompareResult', () => {
    const ids = ['S1', 'S2', 'S3'];

    it('reads findings from parsed JSON, JSON text and a bare list', () => {
        const finding = {
            kind: 'appearance',
            a: 'S1',
            b: 'S2',
            quoteA: 'long silver hair',
            quoteB: 'short black hair',
            summary: 'Hair differs',
        };
        expect(parseCompareResult({ findings: [finding] }, ids)).toEqual([finding]);
        expect(parseCompareResult(JSON.stringify({ findings: [finding] }), ids)).toEqual([finding]);
        expect(parseCompareResult([{ ...finding, kind: 'descriptionMismatch', a: '3', b: 's1' }], ids)).toEqual([
            { ...finding, kind: 'description', a: 'S3', b: 'S1' },
        ]);
        expect(parseCompareResult({ findings: [] }, ids)).toEqual([]);
    });

    it('returns null for malformed answers', () => {
        expect(parseCompareResult('not json', ids)).toBeNull();
        expect(parseCompareResult({ findings: 'none' }, ids)).toBeNull();
        expect(parseCompareResult(null, ids)).toBeNull();
        expect(parseCompareResult(42, ids)).toBeNull();
    });

    it('drops items it cannot tie to the snippets, duplicates and extras', () => {
        const ok = { kind: 'appearance', a: 'S1', b: 'S2', summary: 'x' };
        const list = [
            ok,
            { ...ok },
            { ...ok, b: 'S1' },
            { ...ok, a: 'S9' },
            { ...ok, a: 5 },
            { ...ok, kind: 'mood' },
            { ...ok, kind: 7 },
            'junk',
            null,
        ];
        const parsed = parseCompareResult({ findings: list }, ids);
        expect(parsed).toEqual([{ kind: 'appearance', a: 'S1', b: 'S2', quoteA: '', quoteB: '', summary: 'x' }]);
        const many = Array.from({ length: 20 }, (_, index) => ({ ...ok, summary: `s${index}` }));
        expect(parseCompareResult({ findings: many }, ids)).toHaveLength(12);
    });

    it('shortens long quotes', () => {
        const parsed = parseCompareResult(
            [{ kind: 'appearance', a: 'S1', b: 'S2', quoteA: 'word '.repeat(100), quoteB: 'b', summary: 's' }],
            ids,
        );
        expect(parsed?.[0]?.quoteA.length).toBeLessThanOrEqual(161);
    });
});
