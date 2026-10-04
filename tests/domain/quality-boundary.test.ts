import { describe, expect, it } from 'vitest';
import {
    BOTH_PREFIX,
    BOUNDARY_DEFECT,
    BOUNDARY_SUSPICION,
    DEFAULT_BOUNDARY_RULES,
    boundaryInstruction,
    compileBoundaryPattern,
    matchBoundary,
    type BoundaryUnit,
} from '../../src/domain/quality-boundary';
import { splitParagraphs, splitSentences } from '../../src/domain/quality-text';

function units(text: string): BoundaryUnit[] {
    return splitParagraphs(text).map((paragraph) => ({ paragraph, sentences: splitSentences(paragraph) }));
}

function single(pattern: string): RegExp {
    const matcher = compileBoundaryPattern(pattern);
    if (matcher?.type !== 'single') throw new Error('not a single pattern');
    return matcher.re;
}

describe('compileBoundaryPattern', () => {
    it('reads plain words with a left word boundary, any ending, any spacing and ё = е', () => {
        const re = single('школьниц');
        expect(re.test('Школьница шла домой.')).toBe(true);
        expect(re.test('Нешкольница.')).toBe(false);
        expect(single('ночная  смена').test('ночная\nсмена')).toBe(true);
        expect(single('ещё').test('Еще раз.')).toBe(true);
        expect(single('a+b').test('aab')).toBe(true);
    });

    it('reads regex sources and /slashed/ regexes with flags iu, falling back to plain words when invalid', () => {
        expect(single('кров(ь|и)').test('КРОВИ')).toBe(true);
        expect(single('/gore\\b/').test('Gore.')).toBe(true);
        const broken = single('(unclosed');
        expect(broken.test('an (unclosed bracket')).toBe(true);
        expect(broken.source).toContain('\\(unclosed');
    });

    it('reads both: combinations and rejects incomplete ones', () => {
        const matcher = compileBoundaryPattern(`${BOTH_PREFIX}кров&&нож`);
        expect(matcher?.type).toBe('both');
        expect(compileBoundaryPattern('both:кровь')).toBeNull();
        expect(compileBoundaryPattern('both:&&нож')).toBeNull();
        expect(compileBoundaryPattern('   ')).toBeNull();
        expect(compileBoundaryPattern('BOTH:a&&b')?.type).toBe('both');
    });

    it('caches compiled patterns', () => {
        expect(compileBoundaryPattern('кэш')).toBe(compileBoundaryPattern('кэш'));
        expect(compileBoundaryPattern(undefined as unknown as string)).toBeNull();
    });
});

describe('matchBoundary', () => {
    const rule = (patterns: string[]) => [{ id: 'gore', patterns }];

    it('one hit is a suspicion, two different hits a defect', () => {
        expect(matchBoundary(rule(['кишк', 'расчленен']), units('Кишки на полу.'))).toEqual([
            { id: 'gore', score: 1, confidence: BOUNDARY_SUSPICION, quote: 'Кишки на полу.' },
        ]);
        const two = matchBoundary(rule(['кишк', 'расчленен']), units('Кишки на полу.\nРасчленение было долгим.'));
        expect(two[0]).toMatchObject({ score: 2, confidence: BOUNDARY_DEFECT, quote: 'Кишки на полу.' });
        const words = matchBoundary(rule(['кишк\\p{L}*']), units('Кишки. Кишка.'));
        expect(words[0]).toMatchObject({ confidence: BOUNDARY_DEFECT });
        const same = matchBoundary(rule(['кишк']), units('Кишки.\nКишки.'));
        expect(same[0]).toMatchObject({ confidence: BOUNDARY_SUSPICION });
    });

    it('a both: pattern in one sentence is two hits, in one paragraph one', () => {
        const pattern = [`${BOTH_PREFIX}кров&&нож`];
        expect(matchBoundary(rule(pattern), units('Нож был в крови.'))[0]).toMatchObject({ score: 2 });
        expect(matchBoundary(rule(pattern), units('Нож блеснул. Кровь капала.'))[0]).toMatchObject({
            score: 1,
            quote: 'Нож блеснул. Кровь капала.',
        });
        expect(matchBoundary(rule(pattern), units('Нож блеснул.\nКровь капала.'))).toEqual([]);
    });

    it('skips empty, broken and missing rules', () => {
        const rules = [
            { id: 'empty', patterns: [] },
            { id: 'broken', patterns: ['both:x'] },
            null,
            { id: 'nolist', patterns: 'x' },
        ] as unknown as { id: string; patterns: string[] }[];
        expect(matchBoundary(rules, units('x x x'))).toEqual([]);
        expect(matchBoundary(undefined as unknown as [], units('x'))).toEqual([]);
    });
});

describe('default rule', () => {
    it('is the minors rule, enabled, with a both: pattern', () => {
        expect(DEFAULT_BOUNDARY_RULES).toHaveLength(1);
        const [rule] = DEFAULT_BOUNDARY_RULES;
        expect(rule).toMatchObject({
            id: 'minors',
            title: 'Несовершеннолетние в сексуальном контексте',
            enabled: true,
        });
        expect(rule!.patterns[0]!.startsWith(BOTH_PREFIX)).toBe(true);
        for (const pattern of rule!.patterns) expect(compileBoundaryPattern(pattern)).not.toBeNull();
    });

    it('matches Russian and English minors in a sexual context', () => {
        const hit = (text: string) => matchBoundary(DEFAULT_BOUNDARY_RULES, units(text))[0]?.confidence;
        expect(hit('Подросток и минет в одной фразе.')).toBe(BOUNDARY_DEFECT);
        expect(hit('Ему было 13 лет, он мастурбировал.')).toBe(BOUNDARY_DEFECT);
        expect(hit('A preteen girl, nsfw scene.')).toBe(BOUNDARY_DEFECT);
        expect(hit('She was twelve-year-old and aroused.')).toBe(BOUNDARY_DEFECT);
        expect(hit('A child was molested.')).toBe(BOUNDARY_DEFECT);
        expect(hit('Шотакон.')).toBe(BOUNDARY_SUSPICION);
    });

    it('does not match adults, ages above 17 or innocent words', () => {
        const none = (text: string) => expect(matchBoundary(DEFAULT_BOUNDARY_RULES, units(text))).toEqual([]);
        none('Ей было 18 лет, и они занимались сексом.');
        none('The 21-year-old woman had sex with him.');
        none('Трах! Дверь захлопнулась, ребёнок проснулся.');
        none('He cocked his head at the kid.');
        none('A minor injury, nothing sexual.');
        none('Minors details aside, the sex was good.');
        expect(matchBoundary(DEFAULT_BOUNDARY_RULES, units('He had sex with a minor.'))).toHaveLength(1);
        none('Лолита кончила работу и улыбнулась ребёнку.');
    });

    it('has an English instruction per rule', () => {
        expect(boundaryInstruction('minors')).toContain('every character in a sexual context must be an adult');
        expect(boundaryInstruction('gore')).toBe(
            'Rewrite the reply so that it stays within the content boundary "gore".',
        );
    });
});
