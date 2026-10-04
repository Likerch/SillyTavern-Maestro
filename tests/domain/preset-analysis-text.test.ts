import { describe, expect, it } from 'vitest';
import {
    DUPLICATE_THRESHOLDS,
    emptyMessageIssue,
    hasIfMacro,
    heavyBlocks,
    isOverlapping,
    overlap,
    sameText,
    shingleSet,
    stripConditionals,
} from '../../src/domain/preset-analysis-text';

describe('conditional macros', () => {
    it('detects {{if}} and {{#if}}', () => {
        expect(hasIfMacro('{{if .maestro_x}}a{{/if}}')).toBe(true);
        expect(hasIfMacro('{{ #if .x }}a{{/if}}')).toBe(true);
        expect(hasIfMacro('{{char}} is {{iffy}}')).toBe(false);
    });

    it('strips conditional sections, nested ones, else branches and the short form', () => {
        expect(stripConditionals('A {{if .x}}B{{else}}C{{/if}} D')).toBe('A  D');
        expect(stripConditionals('{{if .a}}x{{if .b}}y{{/if}}z{{/if}}tail')).toBe('tail');
        expect(stripConditionals('Hi {{if::.x::text with {{char}}}} there')).toBe('Hi  there');
        // With a space it is one argument: a scoped opener, here never closed.
        expect(stripConditionals('Hi {{if .x::text}} there')).toBe('Hi ');
        expect(stripConditionals('{{char}} {{if .x}}{{user}}{{/if}}!')).toBe('{{char}} !');
        expect(stripConditionals('no macros')).toBe('no macros');
        expect(stripConditionals('broken {{if .x')).toBe('broken {{if .x');
        expect(stripConditionals('{{if .x}}open {{unclosed')).toBe('');
        expect(stripConditionals('stray {{/if}} end')).toBe('stray  end');
    });

    it('reports messages that would be whitespace only', () => {
        expect(emptyMessageIssue('')).toBeNull();
        expect(emptyMessageIssue(' \n ')).toBe('whitespace');
        expect(emptyMessageIssue('text')).toBeNull();
        expect(emptyMessageIssue('{{if .x}}text{{/if}}')).toBeNull();
        expect(emptyMessageIssue('\n{{if .x}}text{{/if}}\n')).toBe('outsideIf');
        expect(emptyMessageIssue('Intro {{if .x}}text{{/if}}')).toBeNull();
    });
});

describe('overlap', () => {
    it('builds word shingles without macros; short texts give one shingle or none', () => {
        expect([...shingleSet('one two three four five six')]).toEqual([
            'one two three four five',
            'two three four five six',
        ]);
        expect([...shingleSet('Пиши от {{char}} третьего лица')]).toEqual(['пиши от третьего лица']);
        expect(shingleSet('two words').size).toBe(0);
        expect(shingleSet('a b c d e f', 3).size).toBe(4);
    });

    it('measures containment against the smaller text and applies the thresholds', () => {
        const a = shingleSet('the tracker must be updated after every reply in json format');
        const b = shingleSet('note: the tracker must be updated after every reply in json format, always');
        const value = overlap(a, b);
        expect(value.shared).toBe(a.size);
        expect(value.containment).toBe(1);
        expect(isOverlapping(value)).toBe(true);
        expect(overlap(new Set(), b)).toEqual({ shared: 0, containment: 0 });
        expect(isOverlapping({ shared: 3, containment: 1 })).toBe(false);
        expect(isOverlapping({ shared: 15, containment: 0.1 })).toBe(true);
        expect(isOverlapping({ shared: 5, containment: 0.4 }, DUPLICATE_THRESHOLDS)).toBe(false);
    });

    it('compares normalised texts', () => {
        expect(sameText('Ёлка  растёт', 'елка растет')).toBe(true);
        expect(sameText('', '')).toBe(false);
        expect(sameText('a', 'b')).toBe(false);
    });
});

describe('heavyBlocks', () => {
    it('returns the heaviest blocks above both thresholds, sorted and limited', () => {
        const blocks = [
            { identifier: 'a', tokens: 3000 },
            { identifier: 'b', tokens: 1200 },
            { identifier: 'c', tokens: 900 },
            { identifier: 'd', tokens: 450 },
            { identifier: 'e', tokens: 100 },
        ];
        const heavy = heavyBlocks(blocks, { minTokens: 400, minShare: 0.1, limit: 2 });
        expect(heavy.map((item) => item.identifier)).toEqual(['a', 'b']);
        expect(heavy[0]!.share).toBeCloseTo(3000 / 5650);
        expect(heavyBlocks(blocks).map((item) => item.identifier)).toEqual(['a', 'b', 'c']);
        expect(heavyBlocks([{ identifier: 'x', tokens: 0 }])).toEqual([]);
        expect(heavyBlocks([])).toEqual([]);
    });
});
