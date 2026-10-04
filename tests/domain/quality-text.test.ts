import { describe, expect, it } from 'vitest';
import {
    QUOTE_CHARS,
    clip,
    contextQuote,
    fenceBlocks,
    historyProse,
    isTrackerBody,
    languageName,
    lastUserProse,
    normalizeLanguage,
    prepareReply,
    recentReplies,
    splitParagraphs,
    splitSentences,
    splitSpeech,
    storyText,
    stripImageMarkers,
} from '../../src/domain/quality-text';
import type { QualityInput, QualityMessage } from '../../src/domain/quality-types';

const msg = (text: string, isUser = false): QualityMessage => ({
    index: 0,
    isUser,
    name: isUser ? 'Кай' : 'Лира',
    text,
});

describe('storyText', () => {
    it('keeps only the story', () => {
        const raw = [
            '<｜begin▁of▁sentence｜>```json',
            '{"infoBox":{"location":"Таверна"}}',
            '```',
            'Лира кивнула. Да.',
            '<think>reasoning in English</think>',
            '<details><summary>Thoughts</summary>English thoughts</details>',
            `<figure><img data-nai='{"prompt":"a > b"}'><figcaption>Cap</figcaption></figure>`,
            `<img src="/gen?prompt=x" data-iig-instruction='{"a":1}'>[IMG:GEN:{"prompt":"x"}]<!--img-prompt="x"-->`,
            'Она ушла [nai:img:abc] домой. <SPECIES:ELF> <NPC name="Лира"> https://example.com/x',
            '```python',
            'print(1)',
            '```',
            '<BunnyMoTags><Name:Лира></BunnyMoTags>',
            '<b>Конец</b>.',
        ].join('\r\n');
        expect(storyText(raw)).toBe('Лира кивнула. Да.\n\nОна ушла домой.\n\nКонец.');
    });

    it('drops a reasoning tail whose opening tag was in the prefill', () => {
        expect(storyText('thinking about it</think>\nЛира кивнула.')).toBe('Лира кивнула.');
        expect(storyText('<think>a</think> b </think> c')).toBe('b  c');
        expect(storyText(undefined as unknown as string)).toBe('');
    });

    it('strips image markers in all formats', () => {
        expect(stripImageMarkers(`A<img data-nai='{"p":"x > y"}'>B<!-- c -->C[IMG:GEN:{"p":1}]`)).toBe('ABC');
    });
});

describe('fenceBlocks', () => {
    it('finds closed, one-line and unclosed blocks with offsets and info strings', () => {
        const text = 'a\n```JSON\n{"x":1}\n```\nb ```inline``` c\n```code```\n```py\nprint(1)';
        const blocks = fenceBlocks(text);
        expect(blocks).toHaveLength(3);
        expect(blocks[0]).toMatchObject({ info: 'json', body: '{"x":1}', closed: true });
        expect(text.slice(blocks[0]!.start, blocks[0]!.end)).toBe('```JSON\n{"x":1}\n```');
        expect(blocks[1]).toMatchObject({ body: 'code', closed: true });
        expect(blocks[2]).toMatchObject({ info: 'py', body: 'print(1)', closed: false, end: text.length });
        expect(fenceBlocks('no fences')).toEqual([]);
        expect(fenceBlocks('```\r\nbody\r\n```')[0]).toMatchObject({ body: 'body', closed: true });
        expect(fenceBlocks('```')[0]).toMatchObject({ body: '', closed: false });
    });

    it('recognises tracker bodies', () => {
        expect(isTrackerBody(' {"characters": []}')).toBe(true);
        expect(isTrackerBody('{"name": "x"}')).toBe(false);
        expect(isTrackerBody('"quests": 1')).toBe(false);
    });
});

describe('units', () => {
    it('splits paragraphs and sentences after marks, closing quotes and emphasis', () => {
        expect(splitParagraphs(' a \n\n b ')).toEqual(['a', 'b']);
        expect(splitSentences('Он ушёл. «Стой!» Она ждала… *Тишина.* Конец')).toEqual([
            'Он ушёл.',
            '«Стой!»',
            'Она ждала…',
            '*Тишина.*',
            'Конец',
        ]);
    });

    it('separates narration and dialogue', () => {
        const prose = '— Кай, иди сюда, — позвала Лира. — Быстрее.\nОна сказала «нет» и "ушла".\n— Только реплика.';
        const split = splitSpeech(prose);
        expect(split.narration).toBe('позвала Лира.\nОна сказала   и  .\n');
        expect(split.dialogue).toEqual(['Кай, иди сюда,', 'Быстрее.', 'нет', 'ушла', 'Только реплика.']);
        expect(split.attributions).toEqual([{ speech: 'Кай, иди сюда,', words: 'позвала Лира.' }]);
    });
});

describe('quotes and languages', () => {
    it('clips quotes to 160 characters on one line', () => {
        expect(clip('a\n  b')).toBe('a b');
        const long = clip('x'.repeat(400));
        expect(long).toHaveLength(QUOTE_CHARS);
        expect(long.endsWith('…')).toBe(true);
        expect(contextQuote('Первое. Второе предложение тут! Третье.', 12, 5)).toBe('Второе предложение тут!');
        expect(contextQuote('без точки', 0, 3)).toBe('без точки');
    });

    it('normalises language codes and names', () => {
        expect(normalizeLanguage('ru-RU')).toBe('ru');
        expect(normalizeLanguage('Russian')).toBe('ru');
        expect(normalizeLanguage('русский')).toBe('ru');
        expect(normalizeLanguage('English')).toBe('en');
        expect(normalizeLanguage('английский')).toBe('en');
        expect(normalizeLanguage('eng')).toBe('en');
        expect(normalizeLanguage('rus')).toBe('ru');
        expect(normalizeLanguage('DE')).toBe('de');
        expect(normalizeLanguage('')).toBe('');
        expect(normalizeLanguage(undefined)).toBe('');
        expect(normalizeLanguage('12')).toBe('');
        expect(languageName('ru')).toBe('Russian');
        expect(languageName('xx')).toBe('xx');
        expect(languageName('')).toBe('the language of the chat');
    });
});

describe('prepared input and history', () => {
    it('prepares a reply once per input object', () => {
        const input = {
            reply: msg('Лира кивнула.'),
            history: [],
            userName: 'Кай',
            charName: 'Лира',
            language: 'ru',
            desTogether: false,
            boundary: [],
        } satisfies QualityInput;
        expect(prepareReply(input)).toBe(prepareReply(input));
        expect(prepareReply(input).language).toBe('ru');
        expect(prepareReply({ ...input, reply: undefined } as unknown as QualityInput).prose).toBe('');
    });

    it('picks recent replies and the last user message', () => {
        const history = [msg('Один.'), msg('Я.', true), msg('<details>x</details>'), msg('Два.'), msg('Три.')];
        expect(recentReplies(history, 2)).toEqual(['Два.', 'Три.']);
        expect(recentReplies(history, 5)).toEqual(['Один.', 'Два.', 'Три.']);
        expect(recentReplies(undefined, 3)).toEqual([]);
        expect(recentReplies([undefined as unknown as QualityMessage], 3)).toEqual([]);
        expect(lastUserProse(history)).toBe('Я.');
        expect(lastUserProse([msg('Только бот.')])).toBe('');
        expect(lastUserProse(undefined)).toBe('');
    });

    it('caches history prose with a bounded LRU', () => {
        for (let i = 0; i < 80; i++) expect(historyProse(msg(`Текст ${i}.`))).toBe(`Текст ${i}.`);
        expect(historyProse(msg('Текст 79.'))).toBe('Текст 79.');
        expect(historyProse(msg('Текст 0.'))).toBe('Текст 0.');
        expect(historyProse(undefined as unknown as QualityMessage)).toBe('');
    });
});
