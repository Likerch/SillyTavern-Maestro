import { describe, expect, it } from 'vitest';
import {
    bookSources,
    cardSources,
    chunkSources,
    clipText,
    diffSources,
    GREETING_CHARS,
    estimateChunks,
    fingerprintOf,
    greetingOfSource,
    greetingOpening,
    greetingSourceId,
    greetingText,
    sameSources,
    sourceChars,
    sourceHashes,
} from '../../src/domain/prepare-sources';
import type { CardInput, PrepareSource } from '../../src/domain/prepare-sources';

const CARD: CardInput = {
    name: 'Хроники',
    description: 'Описание мира и людей.',
    personality: '',
    scenario: 'Сценарий в таверне.',
    firstMessage: 'Дождь барабанит по ставням таверны.',
    alternateGreetings: ['Утро на рынке, шум и крики.', 'Ночь в форте, тишина.'],
    examples: '<START>\n{{user}}: Привет',
    creatorNotes: 'Заметки автора.',
    systemPrompt: 'System.',
    postHistory: '',
    depthPrompt: 'Depth.',
    greeting: 2,
};

function src(id: string, size: number, core = false, text?: string): PrepareSource {
    const body = text ?? 'x'.repeat(size);
    return { id, origin: core ? 'card' : 'book', label: id, text: body, hash: `${id}:${body.length}`, core };
}

describe('prepare sources: the card and its books', () => {
    it('reads the card fields and every greeting in full, a source each; the one shown goes with the card', () => {
        const sources = cardSources(CARD, { name: 'Кай', description: 'Наёмник.' });
        const ids = sources.map((item) => item.id);
        expect(ids).toEqual([
            'card.description',
            'card.scenario',
            'greeting:2',
            'card.examples',
            'card.notes',
            'card.system',
            'persona',
            'greeting:0',
            'greeting:1',
        ]);
        expect(sources.filter((item) => item.core).map((item) => item.id)).toEqual(ids.slice(0, 7));
        const shown = sources.find((item) => item.id === 'greeting:2')!;
        expect(shown).toMatchObject({ greeting: 2, origin: 'card', text: 'Ночь в форте, тишина.' });
        expect(shown.label).toBe('Starting scene — greeting 2 (alternate greeting 2, the one this chat opened with)');
        expect(sources.find((item) => item.id === 'greeting:0')).toMatchObject({
            greeting: 0,
            core: false,
            label: 'Starting scene — greeting 0 (the first message)',
            text: 'Дождь барабанит по ставням таверны.',
        });
        expect(sources.find((item) => item.id === 'greeting:1')?.text).toBe('Утро на рынке, шум и крики.');
        expect(sources.find((item) => item.id === 'card.system')?.text).toBe('System.\n\nDepth.');
        expect(sources.find((item) => item.id === 'persona')?.text).toBe('Name: Кай\nНаёмник.');
        expect(new Set(sources.map((item) => item.hash)).size).toBe(sources.length);
    });

    it('never shortens a greeting below the runaway cap', () => {
        const long = `${'Длинная сцена. '.repeat(700)}Конец.`;
        const sources = cardSources({ ...CARD, alternateGreetings: [long], greeting: 0 }, null);
        expect(sources.find((item) => item.id === 'greeting:1')?.text).toBe(long.trim());
        expect(GREETING_CHARS).toBeGreaterThan(long.length);
    });

    it('falls back to the first message for an unknown greeting and leaves the persona out when empty', () => {
        expect(greetingText(CARD, 9)).toBe(CARD.firstMessage);
        expect(greetingText(CARD, 1)).toBe(CARD.alternateGreetings[0]);
        const sources = cardSources({ ...CARD, greeting: 0 }, { name: ' ', description: '' });
        expect(sources.some((item) => item.id === 'persona')).toBe(false);
        const unknown = cardSources({ ...CARD, greeting: 9 }, null);
        expect(unknown.find((item) => item.core && item.greeting !== undefined)?.id).toBe('greeting:0');
    });

    it('names the greetings and shows their first words', () => {
        expect(greetingSourceId(3)).toBe('greeting:3');
        expect(greetingOfSource('greeting:12')).toBe(12);
        expect(greetingOfSource('card.description')).toBeNull();
        const opening = greetingOpening(
            '  {{char}} ждёт.\n{{user}} входит в таверну, где шумно и людно до самого утра, и садится у огня.',
            { user: 'Кай', char: 'Вера' },
        );
        expect(opening).toMatch(/^Вера ждёт\. Кай входит в таверну, где .+…$/);
        expect(opening.length).toBeLessThanOrEqual(61);
        expect(greetingOpening('{{user}} пришёл.', { user: ' ', char: '' })).toBe('… пришёл.');
    });

    it('reads enabled book entries with their keys, cut to the limit', () => {
        const sources = bookSources(
            'World',
            [
                { uid: 1, title: 'Harbor', keys: ['Harbor', 'Гавань'], content: 'A port. '.repeat(100) },
                { uid: 2, title: 'Off', keys: [], content: 'hidden', disabled: true },
                { uid: 3, title: '', keys: ['Fort'], content: '   ' },
                { uid: 4, title: '', keys: ['Fen'], content: 'Bogs.' },
            ],
            'book',
            120,
        );
        expect(sources.map((item) => item.id)).toEqual(['book:World#1', 'book:World#4']);
        expect(sources[0]!.text.startsWith('Keys: Harbor, Гавань\nA port.')).toBe(true);
        expect(sources[0]!.text.length).toBeLessThanOrEqual(121);
        expect(sources[1]!.label).toBe('World · Fen');
        expect(sources[1]!.core).toBe(false);
    });

    it('clips at a word boundary', () => {
        expect(clipText('one two three four', 15)).toBe('one two three…');
        expect(clipText('one two three four', 9)).toBe('one two t…');
        expect(clipText('short', 9)).toBe('short');
    });
});

describe('prepare sources: parts and the budget', () => {
    it('puts the card into the first part and packs the books after it', () => {
        const sources = [src('card.description', 3000, true), src('a', 1500), src('b', 1500), src('c', 1500)];
        const result = chunkSources(sources, { chunkChars: 5000, maxChunks: 5 });
        expect(result.chunks.map((chunk) => chunk.sourceIds)).toEqual([
            ['card.description', 'a'],
            ['b', 'c'],
        ]);
        expect(result.chunks[0]!.core).toBe(true);
        expect(result.chunks[0]!.chars).toBe(sourceChars(sources[0]!) + sourceChars(sources[1]!));
        expect(result.skipped).toEqual([]);
    });

    it('spreads the other greetings over parts after the card, never shortened or left out, books after them', () => {
        const greeting = (n: number, size: number): PrepareSource => ({
            ...src(`greeting:${n}`, size),
            origin: 'card',
            greeting: n,
        });
        const shown = { ...greeting(0, 2000), core: true };
        const sources = [
            src('card.description', 3000, true),
            shown,
            greeting(1, 2500),
            greeting(2, 4000),
            greeting(3, 4000),
            src('a', 1500),
            src('b', 1500),
        ];
        const result = chunkSources(sources, { chunkChars: 6000, maxChunks: 2 });
        expect(result.chunks.map((chunk) => chunk.sourceIds)).toEqual([
            ['card.description', 'greeting:0'],
            ['greeting:1'],
            ['greeting:2'],
            ['greeting:3', 'a'],
        ]);
        expect(result.chunks.map((chunk) => [chunk.core, chunk.greetings])).toEqual([
            [true, true],
            [false, true],
            [false, true],
            [false, true],
        ]);
        // Past `maxChunks` only the books are left out.
        expect(result.skipped).toEqual(['b']);
        const fitting = chunkSources(sources, { chunkChars: 24000, maxChunks: 8 });
        expect(fitting.chunks).toHaveLength(1);
        expect(fitting.chunks[0]!.sourceIds).toHaveLength(7);
    });

    it('skips what does not fit the allowed parts and reads a repeated text once', () => {
        const sources = [src('a', 1500), src('b', 1500, false), src('dup', 0, false, 'x'.repeat(1500)), src('c', 900)];
        sources[2]!.hash = sources[0]!.hash;
        const result = chunkSources(sources, { chunkChars: 1000, maxChunks: 2 });
        expect(result.duplicates).toEqual(['dup']);
        expect(result.chunks.map((chunk) => chunk.sourceIds)).toEqual([['a'], ['b']]);
        expect(result.skipped).toEqual(['c']);
    });

    it('estimates tokens and the price per part', () => {
        const small = chunkSources([src('card.description', 7000, true)], { chunkChars: 24000, maxChunks: 8 });
        const big = chunkSources([src('card.description', 7000, true), src('a', 20000), src('b', 20000)], {
            chunkChars: 24000,
            maxChunks: 8,
        });
        const one = estimateChunks(small, { overheadChars: 3500, outputTokens: 3000 });
        const three = estimateChunks(big, { overheadChars: 3500, outputTokens: 3000 });
        expect(one.chunks).toBe(1);
        expect(one.inputTokens).toBe(Math.ceil((7000 + 'card.description'.length + 12 + 3500) / 3.5));
        expect(one.outputTokens).toBe(3000);
        expect(three.chunks).toBe(3);
        expect(three.sources).toBe(3);
        expect(three.usd).toBeGreaterThan(one.usd);
        expect(one.usd).toBeGreaterThan(0);
    });
});

describe('prepare sources: fingerprints', () => {
    it('tells what changed between two readings', () => {
        const before = sourceHashes([src('a', 10), src('b', 10), src('c', 10)]);
        const after = { ...before, b: 'other', d: 'new' } as Record<string, string>;
        delete after.c;
        const diff = diffSources(before, after);
        expect(diff).toEqual({ changed: ['b'], added: ['d'], removed: ['c'] });
        expect(sameSources(diff)).toBe(false);
        expect(sameSources(diffSources(before, { ...before }))).toBe(true);
        expect(fingerprintOf(before)).toBe(fingerprintOf({ c: before.c!, b: before.b!, a: before.a! }));
        expect(fingerprintOf(before)).not.toBe(fingerprintOf(after));
    });

    it('keeps one hash per greeting: the greeting shown does not change them, a changed greeting changes only its own', () => {
        const first = sourceHashes(cardSources({ ...CARD, greeting: 0 }, null));
        const other = sourceHashes(cardSources({ ...CARD, greeting: 2 }, null));
        expect(other).toEqual(first);
        expect(fingerprintOf(other)).toBe(fingerprintOf(first));
        const edited = sourceHashes(
            cardSources({ ...CARD, alternateGreetings: ['Утро на рынке, шум.', 'Ночь в форте, тишина.'] }, null),
        );
        expect(diffSources(first, edited)).toEqual({ changed: ['greeting:1'], added: [], removed: [] });
    });
});
