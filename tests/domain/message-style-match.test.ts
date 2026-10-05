import { describe, expect, it } from 'vitest';
import { makeStyle, presetRules } from '../../src/domain/message-style';
import type { ApplyTo, MatchKind, StyleRule } from '../../src/domain/message-style';
import {
    MASK_EXCLUDED,
    bracketPairs,
    codeSpanRanges,
    crosses,
    customPairs,
    dashSpeech,
    desTrackerRange,
    emphasisPairs,
    fenceRanges,
    findMatches,
    guillemetPairs,
    innermost,
    lineRanges,
    maskOf,
    mergeRanges,
    narrationRanges,
    paragraphRanges,
    parenPairs,
    quotePairs,
    segmentText,
    selectLayer1,
    textExclusions,
    underscorePairs,
} from '../../src/domain/message-style-match';
import type { Pair, TextRange } from '../../src/domain/message-style-match';

function rule(id: string, kind: MatchKind, extra: Partial<StyleRule> = {}): StyleRule {
    return { id, name: '', enabled: true, match: { kind }, applyTo: 'all', style: makeStyle(), ...extra };
}

const free = (text: string) => new Uint8Array(text.length);
const slices = (text: string, pairs: readonly TextRange[]) => pairs.map((pair) => text.slice(pair.start, pair.end));
const found = (text: string, rules: StyleRule[], scope?: 'user' | 'char') =>
    findMatches(text, rules, scope ? { scope } : {}).map((match) => [match.kind, text.slice(match.start, match.end)]);

describe('lines and paragraphs', () => {
    it('splits lines and blank-line paragraphs', () => {
        expect(slices('a\nb\n\nc', lineRanges('a\nb\n\nc'))).toEqual(['a', 'b', '', 'c']);
        expect(slices('a\nb\n \t\nc\n', paragraphRanges('a\nb\n \t\nc\n'))).toEqual(['a\nb', 'c']);
        expect(paragraphRanges('\n\n')).toEqual([]);
    });
});

describe('exclusions', () => {
    it('finds fenced blocks, closed or not', () => {
        const text = 'a\n```js\n"x"\n```\nb\n~~~\n"y"';
        const ranges = fenceRanges(text);
        expect(slices(text, ranges)).toEqual(['```js\n"x"\n```', '~~~\n"y"']);
        expect(fenceRanges('no fences')).toEqual([]);
        // A shorter or different fence does not close.
        expect(slices('````\n```\nx', fenceRanges('````\n```\nx'))).toEqual(['````\n```\nx']);
    });

    it('pairs inline code runs of the same length within a paragraph', () => {
        const text = 'a `x` b ``y ` z`` c ` d\n\ne`';
        expect(slices(text, codeSpanRanges(text))).toEqual(['`x`', '``y ` z``']);
        expect(codeSpanRanges('plain')).toEqual([]);
    });

    it('merges overlapping ranges', () => {
        expect(
            mergeRanges([
                { start: 5, end: 8 },
                { start: 0, end: 2 },
                { start: 1, end: 6 },
                { start: 9, end: 9 },
            ]),
        ).toEqual([{ start: 0, end: 8 }]);
    });

    it('finds the DES tracker JSON that opens a reply', () => {
        const fenced = '```json\n{"infoBox": {"location": "Таверна"}}\n```\n"Привет", — сказала она.';
        expect(fenced.slice(0, desTrackerRange(fenced)!.end)).toContain('```\n');
        const bare = '{"characters": [{"name": "Мира", "thoughts": "Хм"}]}\n"Да."';
        expect(bare.slice(0, desTrackerRange(bare)!.end).trim()).toBe(
            '{"characters": [{"name": "Мира", "thoughts": "Хм"}]}',
        );
        expect(desTrackerRange('{"foo": 1} "x"')).toBeNull();
    });

    it('covers HTML tags and attributes, comments, hidden elements, NAI markers and URLs', () => {
        const text =
            '<div title="say &quot;hi&quot; (now)">a</div><!-- "c" --><style>q{}</style> [nai:img:abc] [IMG:GEN:{"p":"x"}] https://x.y/a_b_(c). <SPECIES:ELF>';
        const ranges = textExclusions(text).ranges;
        const mask = maskOf(text.length, ranges);
        const visible = [...text].filter((_, index) => mask[index] === 0).join('');
        expect(visible).toBe('a   . ');
        const wrapped = '(https://x.y/a) x';
        const wrappedMask = maskOf(wrapped.length, textExclusions(wrapped).ranges);
        expect([...wrapped].filter((_, index) => wrappedMask[index] === 0).join('')).toBe('() x');
    });
});

describe('quotes', () => {
    it('pairs straight and curly quotes on one line, skipping empty ones', () => {
        const text = '"Да," — он. “Нет” ""\n"не\nзакрыто"';
        expect(slices(text, quotePairs(text, free(text)))).toEqual(['"Да,"', '“Нет”']);
    });

    it('keeps a straight quote inside a curly one as content and vice versa', () => {
        const text = '“a "b" c” "d “e” f"';
        expect(slices(text, quotePairs(text, free(text)))).toEqual(['“a "b" c”', '"d “e” f"']);
    });

    it('nests guillemets and recovers inner pairs of an unbalanced outer one', () => {
        const text = '«а «б» в» и «г «д» е';
        expect(slices(text, guillemetPairs(text, free(text)))).toEqual(['«а «б» в»', '«д»']);
        expect(guillemetPairs('без ёлочек', free('без ёлочек'))).toEqual([]);
    });
});

describe('dash dialogue', () => {
    const speech = (text: string) => slices(text, dashSpeech(text, free(text)));

    it('takes a line that opens with a dash and toggles at the author’s words', () => {
        expect(speech('— Привет, — сказал он. — Как дела?')).toEqual(['— Привет', '— Как дела?']);
        expect(speech('— Привет, — сказал он, — как дела?')).toEqual(['— Привет', '— как дела?']);
        expect(speech('— Я не… — Он замолчал.')).toEqual(['— Я не…']);
        expect(speech('— Да?! — крикнул он.')).toEqual(['— Да?!']);
        expect(speech('– Короткое тире тоже.')).toEqual(['– Короткое тире тоже.']);
    });

    it('keeps a dash inside a sentence as text', () => {
        expect(speech('Москва — столица России.')).toEqual([]);
        expect(speech('— Подожди — я сейчас.')).toEqual(['— Подожди — я сейчас.']);
        expect(speech('Он помолчал, — и ушёл.')).toEqual([]);
    });

    it('starts speech after a sentence end or a colon in narration', () => {
        expect(speech('Он кивнул. — Да.')).toEqual(['— Да.']);
        expect(speech('Она сказала: — Иди.')).toEqual(['— Иди.']);
        expect(speech('«Стой!» — Нет, — ответил он.')).toEqual(['— Нет']);
    });

    it('needs a space after the dash and works line by line', () => {
        expect(speech('—Привет\n  — Второй.\n> — В цитате.')).toEqual(['— Второй.', '— В цитате.']);
        expect(speech('Текст —')).toEqual([]);
    });

    it('ignores dashes in excluded text', () => {
        const text = '<span title="Он. — да">x</span> `Он. — да`';
        const mask = maskOf(text.length, textExclusions(text).ranges);
        expect(slices(text, dashSpeech(text, mask))).toEqual([]);
        // A tag before the dash does not hide the line start.
        const tagged = '<b>— Да.</b>';
        const taggedMask = maskOf(tagged.length, textExclusions(tagged).ranges);
        expect(slices(tagged, dashSpeech(tagged, taggedMask))).toEqual(['— Да.</b>']);
    });
});

describe('asides', () => {
    it('keeps the outermost parentheses and skips smileys and empty ones', () => {
        const text = '(а (б) в) :) () ( незакрыто (г)';
        expect(slices(text, parenPairs(text, free(text)))).toEqual(['(а (б) в)', '(г)']);
        expect(parenPairs('none', free('none'))).toEqual([]);
    });

    it('skips Markdown links in brackets', () => {
        const text = '[пометка] [ссылка](http://x) [a [b] c]';
        expect(slices(text, bracketPairs(text, free(text)))).toEqual(['[пометка]', '[a [b] c]']);
    });

    it('stays inside a paragraph', () => {
        const text = '(начало\n\nконец)';
        expect(parenPairs(text, free(text))).toEqual([]);
    });
});

describe('emphasis', () => {
    const em = (text: string) => {
        const pairs = emphasisPairs(text, free(text));
        return { em: slices(text, pairs.em), strong: slices(text, pairs.strong) };
    };

    it('pairs single and double asterisks, nested both ways', () => {
        expect(em('*мысль* и **акцент**')).toEqual({ em: ['*мысль*'], strong: ['**акцент**'] });
        expect(em('*а **б** в*')).toEqual({ em: ['*а **б** в*'], strong: ['**б**'] });
        expect(em('***оба***')).toEqual({ em: ['***оба***'], strong: ['**оба**'] });
    });

    it('leaves unbalanced and spaced asterisks alone', () => {
        expect(em('**а* б')).toEqual({ em: ['*а*'], strong: [] });
        expect(em('2 * 3 * 4')).toEqual({ em: [], strong: [] });
        expect(em('* пункт\n***')).toEqual({ em: [], strong: [] });
        expect(em('*а\n\nб*')).toEqual({ em: [], strong: [] });
        expect(em('без')).toEqual({ em: [], strong: [] });
    });

    it('pairs underscores at word edges only', () => {
        const text = '_тихо_ snake_case_name __u__ _a _b_';
        expect(slices(text, underscorePairs(text, free(text)))).toEqual(['_тихо_', '_a _b_']);
        expect(underscorePairs('none', free('none'))).toEqual([]);
    });
});

describe('custom rules', () => {
    it('finds regex matches outside excluded text and skips empty ones', () => {
        const text = 'Ура! `Ура!` ура';
        const mask = maskOf(text.length, textExclusions(text).ranges);
        expect(slices(text, customPairs(text, mask, /ура!?/giu))).toEqual(['Ура!', 'ура']);
        expect(customPairs('aaa', free('aaa'), /x*/)).toEqual([]);
        expect(customPairs('aaa', free('aaa'), /a/, 2)).toHaveLength(2);
    });
});

describe('selection', () => {
    it('merges sources by start; ties go to the earlier source', () => {
        const pair = (start: number, end: number): Pair => ({ start, end, open: 1, close: 1 });
        const selected = selectLayer1([
            { ruleId: 'a', kind: 'parentheses', pairs: [pair(0, 5), pair(10, 12)] },
            { ruleId: 'b', kind: 'brackets', pairs: [pair(0, 3), pair(4, 8), pair(11, 14)] },
        ]);
        expect(selected.map((item) => [item.ruleId, item.start, item.end])).toEqual([
            ['a', 0, 5],
            ['a', 10, 12],
        ]);
    });

    it('maps positions to the innermost range and detects crossing', () => {
        const ranges = [
            { start: 0, end: 10 },
            { start: 2, end: 4 },
            { start: 12, end: 14 },
        ];
        const inner = innermost(15, ranges);
        expect([...inner]).toEqual([0, 0, 1, 1, 0, 0, 0, 0, 0, 0, -1, -1, 2, 2, -1]);
        expect(crosses({ start: 3, end: 6 }, inner)).toBe(true);
        expect(crosses({ start: 0, end: 14 }, inner)).toBe(true);
        expect(crosses({ start: 5, end: 9 }, inner)).toBe(false);
        expect(innermost(3, [])).toEqual(new Int32Array([-1, -1, -1]));
    });
});

describe('findMatches', () => {
    const all = [
        rule('n', 'narration'),
        rule('dq', 'doubleQuotes'),
        rule('gq', 'guillemets'),
        rule('dash', 'dashDialogue'),
        rule('em', 'asterisk'),
        rule('st', 'doubleAsterisk'),
        rule('us', 'underscore'),
        rule('pa', 'parentheses'),
        rule('br', 'brackets'),
        rule('bt', 'backticks'),
    ];

    it('finds every kind', () => {
        const text = '"Да" «Нет» *мысль* **акцент** _тихо_ (ремарка) [пометка] `код`\n— Реплика.';
        expect(found(text, all)).toEqual([
            ['doubleQuotes', '"Да"'],
            ['guillemets', '«Нет»'],
            ['asterisk', '*мысль*'],
            ['doubleAsterisk', '**акцент**'],
            ['underscore', '_тихо_'],
            ['parentheses', '(ремарка)'],
            ['brackets', '[пометка]'],
            ['backticks', '`код`'],
            ['dashDialogue', '— Реплика.'],
        ]);
    });

    it('nests emphasis in dialogue and dialogue in emphasis', () => {
        expect(found('"Он *тихо* сказал"', all)).toEqual([
            ['doubleQuotes', '"Он *тихо* сказал"'],
            ['asterisk', '*тихо*'],
        ]);
        expect(found('*"Ненавижу это", подумала она*', all)).toEqual([
            ['asterisk', '*"Ненавижу это", подумала она*'],
            ['doubleQuotes', '"Ненавижу это"'],
        ]);
    });

    it('drops emphasis that crosses dialogue, and underscores that cross asterisks', () => {
        expect(found('*он сказал "да* ладно"', all)).toEqual([['doubleQuotes', '"да* ладно"']]);
        expect(found('*а _б* в_', all)).toEqual([['asterisk', '*а _б*']]);
    });

    it('takes the earliest outer match; nested quotes inside dash speech are part of it', () => {
        expect(found('— Ты читал «Войну и мир»? — спросил он.', all)).toEqual([
            ['dashDialogue', '— Ты читал «Войну и мир»?'],
        ]);
        expect(found('"Он (тихо) сказал"', all)).toEqual([['doubleQuotes', '"Он (тихо) сказал"']]);
    });

    it('never matches inside HTML, code, the DES block, NAI markers or URLs', () => {
        const text =
            '```json\n{"infoBox": {"location": "Дом"}}\n```\n<span title="a (b) *c*">x</span> `"код"` [nai:img:abc] https://a.b/_x_(y) "Ок"';
        expect(found(text, all)).toEqual([
            ['backticks', '`"код"`'],
            ['doubleQuotes', '"Ок"'],
        ]);
    });

    it('applies only enabled rules of the scope; the first rule of a kind marks it', () => {
        const rules = [
            rule('u', 'doubleQuotes', { applyTo: 'user' as ApplyTo }),
            rule('c', 'doubleQuotes', { applyTo: 'char' as ApplyTo }),
            rule('off', 'asterisk', { enabled: false }),
        ];
        expect(findMatches('"а" *б*', rules, { scope: 'user' }).map((item) => item.ruleId)).toEqual(['u']);
        expect(findMatches('"а" *б*', rules, { scope: 'char' }).map((item) => item.ruleId)).toEqual(['c']);
        expect(findMatches('"а"', rules).map((item) => item.ruleId)).toEqual(['u']);
        expect(findMatches('', rules)).toEqual([]);
        expect(findMatches('"а"', [])).toEqual([]);
    });

    it('runs custom rules in priority order with the built-in ones', () => {
        const custom = rule('c1', 'custom', { match: { kind: 'custom', pattern: '~[^~]+~' } });
        const broken = rule('c2', 'custom', { match: { kind: 'custom', pattern: '(' } });
        expect(found('~шёпот~ (а)', [broken, custom, rule('pa', 'parentheses')])).toEqual([
            ['custom', '~шёпот~'],
            ['parentheses', '(а)'],
        ]);
    });

    it('works on the presets', () => {
        const text = '*Опять*, — подумала Мира. "Ты вовремя", — бросила она.\n— Прости, — он сел.';
        expect(found(text, presetRules('classic'), 'char')).toEqual([
            ['asterisk', '*Опять*'],
            ['doubleQuotes', '"Ты вовремя"'],
        ]);
        expect(found(text, presetRules('book'), 'char').map((item) => item[0])).toEqual([
            'asterisk',
            'doubleQuotes',
            'dashDialogue',
        ]);
    });

    it('stays linear on long texts', () => {
        const chunk = '— Реплика, — сказал он. "Да" «Нет» *мысль* (а [б]) `x` https://x.y\n';
        const text = chunk.repeat(4000);
        const started = Date.now();
        const matches = findMatches(text, all);
        expect(matches.length).toBeGreaterThan(20000);
        expect(Date.now() - started).toBeLessThan(3000);
        const unbalanced = '(« [ * _ '.repeat(20000);
        expect(findMatches(unbalanced, all)).toEqual([]);
        expect(Date.now() - started).toBeLessThan(5000);
    });
});

describe('narration', () => {
    it('is what no match covers, without excluded or blank parts', () => {
        const text = 'Шёл дождь. "Да" `код` и всё.';
        const { matches, narration } = segmentText(text, [rule('n', 'narration'), rule('q', 'doubleQuotes')]);
        expect(matches).toHaveLength(1);
        expect(narration!.ruleId).toBe('n');
        expect(slices(text, narration!.ranges)).toEqual(['Шёл дождь. ', ' ', ' и всё.'].filter((part) => part.trim()));
    });

    it('is null without a narration rule and empty for an empty text', () => {
        expect(segmentText('a', [rule('q', 'doubleQuotes')]).narration).toBeNull();
        expect(narrationRanges('', [])).toEqual([]);
        const mask = maskOf(3, [{ start: 0, end: 3 }]);
        expect(mask[0]).toBe(MASK_EXCLUDED);
    });
});
