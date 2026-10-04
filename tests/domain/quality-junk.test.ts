import { describe, expect, it } from 'vitest';
import { cleanJunk, codeLines, findJunk, removeSpans } from '../../src/domain/quality-junk';

const TRACKER = '```json\n{"quests":{"main":"Найти брод"},"characters":[{"name":"Лира"}]}\n```\n';
const MARKER = `<figure><img data-nai='{"prompt":"a > b, tavern","caption":"Таверна"}'><figcaption>Таверна</figcaption></figure>`;

const rules = (text: string) => findJunk(text).map((hit) => hit.rule);

describe('cleanJunk', () => {
    it('removes exactly the junk and keeps every other byte', () => {
        const story = `Лира кивнула.\n${MARKER}\n— Пойдём, — сказала она.\n<details><summary>Мысли</summary>Страшно.</details>`;
        const text = `${TRACKER}<｜end▁of▁sentence｜>\n${story}<|im_end|>`;
        expect(cleanJunk(text).cleaned).toBe(`${TRACKER}${story}`);
    });

    it('keeps CRLF line breaks of the untouched lines', () => {
        const text = 'Первая строка.\r\n<|eot_id|>\r\nВторая строка.\r\nТретья.';
        expect(cleanJunk(text).cleaned).toBe('Первая строка.\r\nВторая строка.\r\nТретья.');
    });

    it('takes the whitespace after a leading token and the line break before a trailing line', () => {
        expect(cleanJunk('<｜begin▁of▁sentence｜>  \n\nИстория.').cleaned).toBe('История.');
        expect(cleanJunk('История.\n</s>').cleaned).toBe('История.');
        expect(cleanJunk('История.\r\n[/INST]').cleaned).toBe('История.');
        expect(cleanJunk('Слово<|eot_id|>слово.').cleaned).toBe('Словослово.');
    });

    it('leaves a clean reply alone', () => {
        const text = `${TRACKER}Лира <s>улыбнулась</s> усмехнулась.\n<font color="#aa0000">— Стой!</font>`;
        expect(cleanJunk(text)).toEqual({ cleaned: text, hits: [] });
        expect(cleanJunk(undefined as unknown as string)).toEqual({ cleaned: '', hits: [] });
    });
});

describe('findJunk', () => {
    it('finds chat-template tokens of several families', () => {
        expect(rules('<|start_header_id|>assistant<|end_header_id|>\n\nТекст.')).toContain('token');
        expect(cleanJunk('<|start_header_id|>assistant<|end_header_id|>\n\nТекст.').cleaned).toBe('Текст.');
        expect(cleanJunk('<|im_start|>assistant\nТекст.').cleaned).toBe('Текст.');
        expect(cleanJunk('<start_of_turn>model\nТекст.<end_of_turn>').cleaned).toBe('Текст.');
        expect(cleanJunk('[INST] Текст. <<SYS>>').cleaned).toBe('Текст. ');
        expect(cleanJunk('<s>Текст.').cleaned).toBe('Текст.');
        expect(rules('<s>зачёркнуто</s> Текст.')).toEqual([]);
    });

    it('finds document-level HTML and tool calls but not story markup', () => {
        const page = '<!DOCTYPE html><html><head><title>x</title></head><body>Текст.</body></html>';
        expect(cleanJunk(page).cleaned).toBe('Текст.');
        expect(cleanJunk('Текст.<script>alert(1)</script> Ещё.').cleaned).toBe('Текст. Ещё.');
        expect(cleanJunk('<meta charset="utf-8">Текст.').cleaned).toBe('Текст.');
        expect(rules('Текст.\n<tool_call>{"name":"GenerateImage"}</tool_call>')).toEqual(['tool']);
        expect(rules(`Текст <b>жирный</b> и <i>курсив</i>, <span style="color:red">цвет</span>.\n${MARKER}`)).toEqual(
            [],
        );
    });

    it('finds prompt echoes', () => {
        expect(cleanJunk('[System note: stay in character]\nТекст.').cleaned).toBe('Текст.');
        expect(cleanJunk('Текст.\n### Instruction:\nЕщё.').cleaned).toBe('Текст.\nЕщё.');
        expect(cleanJunk('[Start a new chat]\nТекст.').cleaned).toBe('Текст.');
        expect(cleanJunk('<START>\nТекст.').cleaned).toBe('Текст.');
        expect(cleanJunk('Текст.</output_format>').cleaned).toBe('Текст.');
        expect(rules('[System Note: x')).toEqual(['echo']);
    });

    it('classifies fenced blocks: tracker and data are normal, code is junk, prose is reported', () => {
        expect(rules(`${TRACKER}Текст.`)).toEqual([]);
        expect(rules('Текст.\n```sim\n{"hp": 10,\n "mood": "calm"}\n```')).toEqual([]);
        expect(rules('Текст.\n```\nHP: 10\nНастроение: спокойна\n```')).toEqual([]);
        expect(rules('Текст.\n```\n\n```')).toEqual([]);
        expect(rules('Текст.\n```js\nalert(1)\n```')).toEqual(['code']);
        expect(rules('Текст.\n```\nconst a = 1;\nif (a) {\n  run();\n}\n```')).toEqual(['code']);
        const prose = findJunk('Текст.\n```\nДорогой Кай, жду у моста.\n```');
        expect(prose).toMatchObject([{ rule: 'fence-text', removable: false, confidence: 0.5 }]);
        const unclosed = cleanJunk('Текст.\n```python\nimport os\nprint(1)');
        expect(unclosed.cleaned).toBe('Текст.');
        expect(rules('Текст.\n```\nПисьмо без конца')).toEqual([]);
    });

    it('returns hits in text order', () => {
        const hits = findJunk('<|eot_id|>A <script>x</script> B </s>');
        expect(hits.map((hit) => hit.start)).toEqual([...hits.map((hit) => hit.start)].sort((a, b) => a - b));
    });
});

describe('removeSpans', () => {
    it('merges overlapping spans and ignores spans already covered', () => {
        const text = 'abcdef';
        expect(
            removeSpans(text, [
                { start: 1, end: 3 },
                { start: 2, end: 4 },
                { start: 2, end: 3 },
            ]),
        ).toBe('aef');
        expect(removeSpans(text, [])).toBe(text);
    });

    it('drops the line break of a span that fills a whole line', () => {
        expect(removeSpans('a\nJUNK\nb', [{ start: 2, end: 6 }])).toBe('a\nb');
        expect(removeSpans('a\r\nJUNK', [{ start: 3, end: 7 }])).toBe('a');
        expect(removeSpans('a\nJUNK', [{ start: 2, end: 6 }])).toBe('a');
    });
});

describe('codeLines', () => {
    it('counts code lines and skips Russian prose with code-like punctuation', () => {
        expect(codeLines('const a = 1;\nprint(a)\nПросто текст.')).toEqual({ code: 2, total: 3 });
        expect(codeLines('Она сказала: «Иди сюда» и улыбнулась;\n\n')).toEqual({ code: 0, total: 1 });
    });
});
