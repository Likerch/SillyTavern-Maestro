import { describe, expect, it } from 'vitest';
import {
    SUGGESTED_RECURSION_STEPS,
    analyzeGraph,
    buildRecursionGraph,
    findRecursionIssues,
} from '../../src/domain/doctor-recursion';
import { entry } from '../helpers/doctor-entries';

const on = { recursive: true, caseSensitive: false, wholeWords: false, maxSteps: 0 };

function edges(entries: ReturnType<typeof entry>[], settings = on): string[] {
    const graph = buildRecursionGraph(entries, settings);
    return graph.out.flatMap((targets, from) =>
        targets.map((to) => `${graph.nodes[from]?.comment}->${graph.nodes[to]?.comment}`),
    );
}

describe('buildRecursionGraph', () => {
    it('links an entry to the entries whose keys appear in its content', () => {
        const entries = [
            entry('W', { comment: 'A', key: ['alpha'], content: 'Mentions Beta and GAMMA.' }),
            entry('W', { comment: 'B', key: ['beta'], content: 'Back to alpha.' }),
            entry('W', { comment: 'C', key: ['gamma'], content: 'Nothing.' }),
            entry('W', { comment: 'D', key: ['delta'], content: 'alpha', preventRecursion: true }),
            entry('W', { comment: 'E', key: ['epsilon'], content: 'x', excludeRecursion: true }),
            entry('W', { comment: 'F', key: ['phi'], content: 'epsilon beta', disable: true }),
            entry('W', { comment: 'G', key: ['zeta'], content: 'always', constant: true }),
            entry('W', { comment: 'H', key: ['{{char}}', ' '], content: 'zeta' }),
        ];
        expect(edges(entries).sort()).toEqual(['A->B', 'A->C', 'B->A']);
        expect(edges(entries, { ...on, recursive: false })).toEqual([]);
    });

    it('matches like ST: whole words, case, regex keys, one link per pair', () => {
        const entries = [
            entry('W', { comment: 'A', key: ['elf'], content: 'nothing' }),
            entry('W', { comment: 'B', key: ['kb'], content: 'An elf. Another elf.' }),
            entry('W', { comment: 'F', key: ['kf'], content: 'herself and himself' }),
            entry('W', { comment: 'C', key: ['Ivan'], caseSensitive: true, content: 'nothing' }),
            entry('W', { comment: 'G', key: ['kg'], content: 'ivan only' }),
            entry('W', { comment: 'H', key: ['kh'], content: 'Ivan here' }),
            entry('W', { comment: 'D', key: ['/ив[ае]н/i'], content: 'nothing' }),
            entry('W', { comment: 'E', key: ['ke'], content: 'ИВАН пришёл' }),
        ];
        expect(edges(entries, { ...on, wholeWords: true }).sort()).toEqual(['B->A', 'E->D', 'H->C']);
        // Without whole words "elf" also fires inside "herself".
        expect(edges(entries).sort()).toEqual(['B->A', 'E->D', 'F->A', 'H->C']);
    });

    it('checks anchored regex keys entry by entry and skips keys that occur nowhere', () => {
        const entries = [
            entry('W', { comment: 'A', key: ['ka'], content: 'Intro text' }),
            entry('W', { comment: 'B', key: ['kb'], content: 'Anna came' }),
            entry('W', { comment: 'C', key: ['/^anna/i'], content: 'x' }),
            entry('W', { comment: 'D', key: ['/zzz/', 'qqqq', 'An'], content: 'y' }),
        ];
        expect(edges(entries).sort()).toEqual(['B->C', 'B->D']);
        expect(edges(entries, { ...on, caseSensitive: true }).sort()).toEqual(['B->C', 'B->D']);
    });

    it('handles text whose lower case changes length', () => {
        const entries = [
            entry('W', { comment: 'A', key: ['beta'], content: 'İstanbul beta' }),
            entry('W', { comment: 'B', key: ['stanbul'], content: 'x' }),
            entry('W', { comment: 'C', key: ['gamma'], matchWholeWords: true, content: 'beta' }),
        ];
        expect(edges(entries).sort()).toEqual(['A->B', 'C->A']);
        expect(edges(entries, { ...on, wholeWords: true })).toContain('C->A');
    });
});

describe('analyzeGraph', () => {
    it('measures depth, reach and the longest path', () => {
        const entries = [
            entry('W', { comment: 'A', key: ['a'], content: 'b' }),
            entry('W', { comment: 'B', key: ['b'], content: 'c' }),
            entry('W', { comment: 'C', key: ['c'], content: 'xx' }),
        ];
        const graph = buildRecursionGraph(entries, on);
        const stats = analyzeGraph(graph);
        expect(stats.get(0)).toEqual({ out: 1, depth: 2, reach: 2, reachChars: 3, path: [0, 1, 2] });
        expect(stats.get(2)).toMatchObject({ depth: 0, reach: 0, path: [2] });
        expect(analyzeGraph(graph, [1]).size).toBe(1);
    });
});

describe('findRecursionIssues', () => {
    const chain = (book: string, length: number) =>
        Array.from({ length }, (_, i) =>
            entry(book, {
                comment: `${book}${i}`,
                key: [`${book.toLowerCase()}key${i}`],
                content: `${book.toLowerCase()}key${i + 1}`,
            }),
        );

    it('reports long chains per book, vacuums and the missing step limit', () => {
        const hub = entry('Hub', {
            comment: 'Hub',
            key: ['hub'],
            content: 'n1 n2 n3 n4 n5 n6',
        });
        const leaves = Array.from({ length: 6 }, (_, i) =>
            entry('Hub', { comment: `N${i + 1}`, key: [`n${i + 1}`], content: 'leaf' }),
        );
        const report = findRecursionIssues([...chain('Flora', 7), hub, ...leaves], on);
        expect(report.maxDepth).toBe(6);
        const kinds = report.issues.map((issue) => [issue.kind, issue.messageKey, issue.severity]);
        expect(kinds).toEqual([
            ['recursion.chain', 'm5.f.recursionChain', 'warn'],
            ['recursion.vacuum', 'm5.f.recursionVacuum', 'warn'],
            ['recursion.chain', 'm5.f.recursionNoLimit', 'warn'],
        ]);
        expect(report.issues[0]?.params).toMatchObject({ book: 'Flora', depth: 6, links: 6 });
        expect(String(report.issues[0]?.params?.path)).toBe('Flora0 → Flora1 → Flora2 → Flora3 → Flora4 → … → Flora6');
        expect(report.issues[1]?.params).toMatchObject({ entry: 'Hub', count: 6, reach: 6 });
        expect(report.issues.every((issue) => issue.fixRule === 'book.cap')).toBe(true);
        expect(report.issues[2]?.params?.suggested).toBe(SUGGESTED_RECURSION_STEPS);
        const flora = report.books.find((book) => book.book === 'Flora');
        expect(flora).toMatchObject({ entries: 7, maxDepth: 6, vacuums: 0, links: 6 });
    });

    it('keeps short chains as notes and respects a sane step limit', () => {
        const report = findRecursionIssues(chain('Small', 4), { ...on, maxSteps: 3 });
        expect(report.issues.map((issue) => [issue.messageKey, issue.severity])).toEqual([
            ['m5.f.recursionChain', 'info'],
        ]);
        const high = findRecursionIssues(chain('Small', 4), { ...on, maxSteps: 10 });
        expect(high.issues.map((issue) => issue.messageKey)).toContain('m5.f.recursionHighLimit');
        expect(findRecursionIssues(chain('Tiny', 2), on).issues).toEqual([]);
    });

    it('still gives book sizes without recursion and caps the analysed starts', () => {
        const entries = [...chain('Big', 5), entry('Big', { constant: true, content: 'const', key: [] })];
        const off = findRecursionIssues(entries, { ...on, recursive: false });
        expect(off.issues).toEqual([]);
        expect(off.books[0]).toMatchObject({ book: 'Big', entries: 6, constantChars: 5, maxDepth: 0, links: 0 });
        const capped = findRecursionIssues(entries, on, { maxStarts: 2, chainThreshold: 1, vacuumThreshold: 1 });
        expect(capped.books[0]?.maxDepth).toBeGreaterThan(0);
    });
});
