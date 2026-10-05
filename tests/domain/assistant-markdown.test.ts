import { describe, expect, it } from 'vitest';
import { parseInline, parseMarkdown } from '../../src/domain/assistant-markdown';

describe('assistant-markdown: inline', () => {
    it('reads code spans literally', () => {
        expect(parseInline('use `pacing.*every*` now')).toEqual([
            { kind: 'text', text: 'use ' },
            { kind: 'code', text: 'pacing.*every*' },
            { kind: 'text', text: ' now' },
        ]);
        expect(parseInline('``a ` b``')).toEqual([{ kind: 'code', text: 'a ` b' }]);
        expect(parseInline('open ` only')).toEqual([{ kind: 'text', text: 'open ` only' }]);
    });

    it('reads bold and italic, but leaves snake_case alone', () => {
        expect(parseInline('**b** and __c__, *i* and _j_')).toEqual([
            { kind: 'bold', text: 'b' },
            { kind: 'text', text: ' and ' },
            { kind: 'bold', text: 'c' },
            { kind: 'text', text: ', ' },
            { kind: 'italic', text: 'i' },
            { kind: 'text', text: ' and ' },
            { kind: 'italic', text: 'j' },
        ]);
        expect(parseInline('call get_settings_now and 2 * 3 * 4')).toEqual([
            { kind: 'text', text: 'call get_settings_now and 2 * 3 * 4' },
        ]);
        expect(parseInline('<b>html</b>')).toEqual([{ kind: 'text', text: '<b>html</b>' }]);
    });
});

describe('assistant-markdown: blocks', () => {
    it('paragraphs with line breaks, headings as bold lines, rules dropped', () => {
        expect(parseMarkdown('# Title #\none\ntwo\n\n---\nthree')).toEqual([
            { kind: 'paragraph', lines: [[{ kind: 'bold', text: 'Title' }]] },
            {
                kind: 'paragraph',
                lines: [[{ kind: 'text', text: 'one' }], [{ kind: 'text', text: 'two' }]],
            },
            { kind: 'paragraph', lines: [[{ kind: 'text', text: 'three' }]] },
        ]);
        expect(parseMarkdown('')).toEqual([]);
    });

    it('lists: bullets, ordered with a start, continuation lines, switching kinds', () => {
        expect(parseMarkdown('intro\n- a\n  more\n* b\n3. c\n4) d\nafter')).toEqual([
            { kind: 'paragraph', lines: [[{ kind: 'text', text: 'intro' }]] },
            {
                kind: 'list',
                ordered: false,
                start: 1,
                items: [[{ kind: 'text', text: 'a more' }], [{ kind: 'text', text: 'b' }]],
            },
            {
                kind: 'list',
                ordered: true,
                start: 3,
                items: [[{ kind: 'text', text: 'c' }], [{ kind: 'text', text: 'd' }]],
            },
            { kind: 'paragraph', lines: [[{ kind: 'text', text: 'after' }]] },
        ]);
    });

    it('code blocks keep their text, an unclosed fence runs to the end', () => {
        expect(parseMarkdown('```regex\n<b>(.*)</b>\n  indented\n```\ntext\r\n~~~\nopen')).toEqual([
            { kind: 'code', lang: 'regex', text: '<b>(.*)</b>\n  indented' },
            { kind: 'paragraph', lines: [[{ kind: 'text', text: 'text' }]] },
            { kind: 'code', lang: '', text: 'open' },
        ]);
    });
});
