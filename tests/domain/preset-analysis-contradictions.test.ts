import { describe, expect, it } from 'vitest';
import { findContradictions, instructionFacets } from '../../src/domain/preset-analysis-contradictions';

const block = (identifier: string, text: string) => ({ identifier, text });

describe('instructionFacets', () => {
    it('splits clauses and tells requirements from prohibitions', () => {
        const facets = instructionFacets('Write in third person, not in first person. Use past tense.');
        expect(facets.pov.get('third')).toEqual({ required: true, forbidden: false });
        expect(facets.pov.get('first')).toEqual({ required: false, forbidden: true });
        expect(facets.tense.get('past')).toEqual({ required: true, forbidden: false });
    });

    it('reads Russian wording', () => {
        const facets = instructionFacets(
            'Пиши от третьего лица; никогда не пиши от первого лица. Отвечай только на русском языке.',
        );
        expect(facets.pov.get('third')?.required).toBe(true);
        expect(facets.pov.get('first')?.forbidden).toBe(true);
        expect(facets.language.get('ru')?.required).toBe(true);
    });

    it('extracts length limits; "no more than" is a limit, not a prohibition', () => {
        expect(instructionFacets('Keep replies to no more than 300 words.').lengths).toEqual([
            { unit: 'words', min: 0, max: 300 },
        ]);
        expect(instructionFacets('Write 2-4 paragraphs').lengths).toEqual([{ unit: 'paragraphs', min: 2, max: 4 }]);
        expect(instructionFacets('Ответ от 3 до 5 абзацев, минимум 200 слов').lengths).toEqual([
            { unit: 'paragraphs', min: 3, max: 5 },
            { unit: 'words', min: 200, max: Number.POSITIVE_INFINITY },
        ]);
        expect(instructionFacets('Exactly 3 sentences, up to 400 tokens').lengths).toEqual([
            { unit: 'sentences', min: 3, max: 3 },
            { unit: 'tokens', min: 0, max: 400 },
        ]);
        expect(instructionFacets('Do not write 500 words').lengths).toEqual([]);
    });

    it('ignores conditional sections', () => {
        const facets = instructionFacets('{{if .maestro_ru}}Отвечай на русском{{else}}Respond in English{{/if}}');
        expect(facets.language.size).toBe(0);
    });
});

describe('findContradictions', () => {
    it('finds different required values of one topic between two blocks', () => {
        const hits = findContradictions([
            block('rules', 'Write in third person.'),
            block('style', 'Narrate in first person.'),
            block('other', 'Be vivid.'),
        ]);
        expect(hits).toEqual([{ topic: 'pov', a: 'rules', b: 'style', left: 'third', right: 'first' }]);
    });

    it('finds a requirement against a prohibition, in both directions', () => {
        expect(findContradictions([block('a', 'Use present tense.'), block('b', 'Never use present tense.')])).toEqual([
            { topic: 'tense', a: 'a', b: 'b', left: 'present', right: '!present' },
        ]);
        expect(findContradictions([block('a', 'Never use present tense.'), block('b', 'Use present tense.')])).toEqual([
            { topic: 'tense', a: 'a', b: 'b', left: '!present', right: 'present' },
        ]);
    });

    it('finds language and length conflicts, and none for agreeing blocks', () => {
        const hits = findContradictions([
            block('lang', 'Always respond in English.'),
            block('ru', 'Отвечай на русском.'),
            block('short', 'Up to 150 words.'),
            block('long', 'At least 400 words.'),
        ]);
        expect(hits).toEqual([
            { topic: 'language', a: 'lang', b: 'ru', left: 'en', right: 'ru' },
            { topic: 'length', a: 'short', b: 'long', left: '≤150 words', right: '≥400 words' },
        ]);
        expect(
            findContradictions([
                block('a', 'Write in third person.'),
                block('b', 'Stay in third person, never first person.'),
            ]),
        ).toEqual([]);
        expect(findContradictions([block('a', '2-3 paragraphs'), block('b', '3-4 paragraphs')])).toEqual([]);
        expect(findContradictions([block('a', '2 paragraphs'), block('b', '4 paragraphs')])[0]).toMatchObject({
            left: '2 paragraphs',
            right: '4 paragraphs',
        });
        expect(findContradictions([block('a', '100 words'), block('b', '3 paragraphs')])).toEqual([]);
        expect(findContradictions([block('a', 'English only.'), block('b', 'only in Russian')])[0]).toMatchObject({
            left: 'en',
            right: 'ru',
        });
    });

    it('does not treat a block that names several values as a clear instruction', () => {
        expect(
            findContradictions([
                block('a', 'Mix first person and third person freely.'),
                block('b', 'Write in first person.'),
            ]),
        ).toEqual([]);
    });
});
