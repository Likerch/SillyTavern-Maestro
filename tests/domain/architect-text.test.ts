import { describe, expect, it } from 'vitest';
import {
    estimateText,
    hasStoryText,
    isProtectedSegment,
    normalizeSentence,
    removeSentences,
    sentenceKey,
    sentenceKeysOf,
    splitParagraphs,
    splitRagChunks,
    splitSentenceSegments,
    trimMemoryInjection,
    trimRagInjection,
    trimToTokens,
    wordCount,
} from '../../src/domain/architect-text';

/** One token per character: makes budgets in tests readable. */
const chars = (text: string) => text.length;

describe('splitSentenceSegments', () => {
    it('keeps the exact text and splits after terminators and line breaks', () => {
        const text = 'Anna smiles. "Really?" she asks!\nNew line… and more\n\nEnd';
        const segments = splitSentenceSegments(text);
        expect(segments.join('')).toBe(text);
        expect(segments.map((segment) => segment.trim())).toEqual([
            'Anna smiles.',
            '"Really?"',
            'she asks!',
            'New line…',
            'and more',
            'End',
        ]);
    });

    it('never splits inside a tag and keeps closing quotes with the sentence', () => {
        const text = '<a title="x. y">Link</a>. Next «quote.» Done';
        const segments = splitSentenceSegments(text);
        expect(segments.join('')).toBe(text);
        expect(segments).toEqual(['<a title="x. y">Link</a>. ', 'Next «quote.» ', 'Done']);
    });

    it('does not split decimals or terminators inside words', () => {
        expect(splitSentenceSegments('Version 2.5 is here.')).toEqual(['Version 2.5 is here.']);
        expect(splitSentenceSegments('')).toEqual([]);
    });
});

describe('paragraphs, protection and keys', () => {
    it('splits paragraphs after blank lines without losing text', () => {
        const text = 'One\nstill one\n\nTwo\n \nThree';
        const parts = splitParagraphs(text);
        expect(parts.join('')).toBe(text);
        expect(parts).toHaveLength(3);
    });

    it('protects tags, headers, CK metadata and empty segments', () => {
        expect(isProtectedSegment('<context>\n')).toBe(true);
        expect(isProtectedSegment('Text with <SPECIES:ELF> inside.')).toBe(true);
        expect(isProtectedSegment('### Anna — Looks\n')).toBe(true);
        expect(isProtectedSegment('Tags: elf, mage\n')).toBe(true);
        expect(isProtectedSegment('   ')).toBe(true);
        expect(isProtectedSegment('Plain sentence. ')).toBe(false);
        expect(isProtectedSegment('a < b and c > d. ')).toBe(false);
    });

    it('normalises sentences for keys (case, ё, punctuation)', () => {
        expect(normalizeSentence('  Ёлка, ЁЖ!  ')).toBe('елка еж');
        expect(sentenceKey('Anna has a scar.')).toBe(sentenceKey('anna has a SCAR'));
        expect(sentenceKey('...')).toBe('');
        expect(wordCount('')).toBe(0);
        expect(wordCount('a b c')).toBe(3);
        expect(sentenceKeysOf('One two three. Four.', 2)).toEqual([sentenceKey('One two three.')]);
    });

    it('estimates tokens with the project-wide ratio', () => {
        expect(estimateText('')).toBe(0);
        expect(estimateText('x'.repeat(36))).toBe(10);
    });
});

describe('removeSentences', () => {
    it('removes only sentences with the given keys and keeps the rest byte for byte', () => {
        const text = 'Anna has a scar. She loves tea.\n<memo>Anna has a scar.</memo>';
        const result = removeSentences(text, new Set([sentenceKey('anna has a scar')]));
        expect(result.removed).toBe(1);
        expect(result.text).toBe('She loves tea.\n<memo>Anna has a scar.</memo>');
        expect(result.removedChars).toBe('Anna has a scar. '.length);
    });

    it('returns the input untouched when nothing matches', () => {
        const text = 'Nothing here.';
        expect(removeSentences(text, new Set())).toEqual({ text, removed: 0, removedChars: 0 });
        expect(removeSentences(text, new Set(['zzz'])).text).toBe(text);
    });

    it('tells whether story text is left', () => {
        expect(hasStoryText('<context>\n</context>')).toBe(false);
        expect(hasStoryText('### Header\n')).toBe(false);
        expect(hasStoryText('<context>\nA sentence.\n</context>')).toBe(true);
    });
});

describe('trimToTokens', () => {
    const text = 'First one. Second one. Third one. Fourth one.';

    it('leaves a text within the budget alone', () => {
        expect(trimToTokens(text, 1000, { from: 'end', unit: 'sentence', count: chars })).toEqual({
            text,
            before: text.length,
            after: text.length,
            removed: 0,
        });
    });

    it('drops whole sentences from the end or from the start', () => {
        const end = trimToTokens(text, 25, { from: 'end', unit: 'sentence', count: chars });
        expect(end.text).toBe('First one. Second one. ');
        expect(end.removed).toBe(2);
        const start = trimToTokens(text, 25, { from: 'start', unit: 'sentence', count: chars });
        expect(start.text).toBe('Third one. Fourth one.');
    });

    it('keeps protected units and the header line when asked', () => {
        const memo = '[Recent events]:\n* Old thing.\n* Newer thing.\n<end>';
        const result = trimToTokens(memo, 40, { from: 'start', unit: 'sentence', keepFirst: true, count: chars });
        expect(result.text).toBe('[Recent events]:\n* Newer thing.\n<end>');
        const tight = trimToTokens(memo, 1, { from: 'start', unit: 'sentence', keepFirst: true, count: chars });
        expect(tight.text).toBe('[Recent events]:\n<end>');
        expect(tight.after).toBeGreaterThan(1);
    });

    it('works by paragraphs and with the default estimate', () => {
        const paragraphs = 'A paragraph here.\n\nB paragraph here.\n\nC paragraph here.';
        const result = trimToTokens(paragraphs, 10, { from: 'end', unit: 'paragraph' });
        expect(result.text).toBe('A paragraph here.\n\n');
        expect(trimToTokens(paragraphs, Number.NaN, { from: 'end', unit: 'paragraph' }).removed).toBe(0);
    });

    it('confirms with a real count when unit counts are not additive', () => {
        // A counter that charges 5 extra for any text: unit sums say "fits" too early.
        const padded = (value: string) => (value ? value.length + 5 : 0);
        const result = trimToTokens('aaaa. bbbb. cccc.', 12, { from: 'end', unit: 'sentence', count: padded });
        expect(result.after).toBeLessThanOrEqual(12);
        expect(result.text).toBe('aaaa. ');
    });
});

describe('CarrotKernel RAG chunks', () => {
    const rag = [
        '### Anna — Looks\nTags: elf\nAnna is tall. She has green eyes.',
        '### Anna — Past\nAnna grew up in the north. Her father was a smith.',
        '### Bob — Looks\nBob is short.',
    ].join('\n\n');

    it('splits on blank lines before a header', () => {
        const chunks = splitRagChunks(rag);
        expect(chunks).toHaveLength(3);
        expect(chunks.join('')).toBe(rag);
        expect(splitRagChunks('no headers at all')).toEqual(['no headers at all']);
    });

    it('drops whole chunks from the end first', () => {
        const first = rag.split('\n\n')[0] as string;
        const result = trimRagInjection(rag, first.length + 2, chars);
        expect(result.text).toBe(first);
        expect(result.removed).toBe(2);
        expect(trimRagInjection(rag, 100_000, chars).text).toBe(rag);
    });

    it('trims sentences of the last chunk, keeping headers, and empties what cannot fit', () => {
        const result = trimRagInjection(rag, 45, chars);
        expect(result.text).toBe('### Anna — Looks\nTags: elf\nAnna is tall. ');
        expect(result.after).toBeLessThanOrEqual(45);
        expect(trimRagInjection(rag, 5, chars).text).toBe('');
    });
});

describe('Qvink memories', () => {
    const memories = ['Anna met Bob.', 'They went north.', 'A storm came.'];
    const injection = `[Following is a list of recent events]:\n* ${memories.join('\n* ')}\n`;

    it('removes the oldest memories and keeps the header and separators', () => {
        const result = trimMemoryInjection(injection, memories, 75, chars);
        expect(result?.text).toBe('[Following is a list of recent events]:\n* They went north.\n* A storm came.\n');
        expect(result?.removed).toBe(1);
        const two = trimMemoryInjection(injection, memories, 60, chars);
        expect(two?.text).toBe('[Following is a list of recent events]:\n* A storm came.\n');
    });

    it('drops the whole injection when even one memory does not fit', () => {
        expect(trimMemoryInjection(injection, memories, 10, chars)).toEqual({
            text: '',
            before: injection.length,
            after: 0,
            removed: 3,
        });
    });

    it('returns null when memories are not in the text, and leaves fitting text alone', () => {
        expect(trimMemoryInjection(injection, ['Missing memory.'], 10, chars)).toBeNull();
        expect(trimMemoryInjection(injection, ['  '], 10, chars)).toBeNull();
        expect(trimMemoryInjection(injection, memories, 10_000, chars)?.removed).toBe(0);
    });
});
