// @vitest-environment happy-dom
import { describe, expect, it } from 'vitest';
import {
    changeView,
    diffView,
    jsonDiff,
    listDiff,
    stableStringify,
    tokenize,
    wordDiff,
} from '../../src/ui/components/diff';
import type { DiffPart } from '../../src/ui/components/diff';
import { createI18n } from '../../src/core/i18n';
import { UI_STRINGS } from '../../src/ui/views/strings';

const i18n = createI18n(() => 'ru');
i18n.register(UI_STRINGS);
const t = i18n.t.bind(i18n);

function text(parts: DiffPart[], kind: DiffPart['kind']): string[] {
    return parts.filter((part) => part.kind === kind).map((part) => part.text);
}

function rebuild(parts: DiffPart[], side: 'before' | 'after'): string {
    return parts
        .filter((part) => part.kind === 'same' || part.kind === (side === 'before' ? 'removed' : 'added'))
        .map((part) => part.text)
        .join('');
}

describe('tokenize', () => {
    it('splits words of any script, whitespace and punctuation', () => {
        expect(tokenize('Анна, hi!  x_1')).toEqual(['Анна', ',', ' ', 'hi', '!', '  ', 'x_1']);
    });
});

describe('wordDiff', () => {
    it('returns one same part for equal strings', () => {
        expect(wordDiff('same text', 'same text')).toEqual([{ kind: 'same', text: 'same text' }]);
    });

    it('marks a replaced word', () => {
        const parts = wordDiff('Anna lives in Rome', 'Anna lives in Paris');
        expect(text(parts, 'removed')).toEqual(['Rome']);
        expect(text(parts, 'added')).toEqual(['Paris']);
        expect(rebuild(parts, 'before')).toBe('Anna lives in Rome');
        expect(rebuild(parts, 'after')).toBe('Anna lives in Paris');
    });

    it('handles Cyrillic insertions in the middle', () => {
        const parts = wordDiff('Анна живёт в Риме', 'Анна давно живёт в Риме');
        expect(text(parts, 'added').join('')).toBe('давно ');
        expect(text(parts, 'removed')).toEqual([]);
    });

    it('handles empty sides', () => {
        expect(wordDiff('', 'new')).toEqual([{ kind: 'added', text: 'new' }]);
        expect(wordDiff('old', '')).toEqual([{ kind: 'removed', text: 'old' }]);
    });

    it('falls back to whole blocks when the middle is too large', () => {
        const parts = wordDiff('a b c d', 'a x y d', 1);
        expect(parts.map((part) => part.kind)).toEqual(['same', 'removed', 'added', 'same']);
        expect(rebuild(parts, 'after')).toBe('a x y d');
    });

    it('always reconstructs both sides', () => {
        const before = 'The quick brown fox jumps over the lazy dog.';
        const after = 'A quick red fox leaped over the dog, twice.';
        const parts = wordDiff(before, after);
        expect(rebuild(parts, 'before')).toBe(before);
        expect(rebuild(parts, 'after')).toBe(after);
    });
});

describe('jsonDiff', () => {
    it('diffs nested objects field by field', () => {
        const fields = jsonDiff(
            { name: 'Anna', look: { hair: 'red', eyes: 'green' }, old: 1 },
            { name: 'Anna', look: { hair: 'black', eyes: 'green' }, added: true },
        );
        expect(fields).toEqual([
            { path: 'name', kind: 'same', before: 'Anna', after: 'Anna' },
            { path: 'look.hair', kind: 'changed', before: 'red', after: 'black' },
            { path: 'look.eyes', kind: 'same', before: 'green', after: 'green' },
            { path: 'old', kind: 'removed', before: 1 },
            { path: 'added', kind: 'added', after: true },
        ]);
    });

    it('compares arrays as whole values and ignores key order', () => {
        expect(jsonDiff({ keys: ['a', 'b'] }, { keys: ['a', 'b'] })[0]?.kind).toBe('same');
        expect(jsonDiff({ keys: ['a'] }, { keys: ['a', 'b'] })[0]?.kind).toBe('changed');
        expect(stableStringify({ b: 1, a: { d: 2, c: 3 } })).toBe(stableStringify({ a: { c: 3, d: 2 }, b: 1 }));
    });
});

describe('listDiff', () => {
    it('marks removed and added items of key lists, keeping order', () => {
        expect(listDiff(['Anna', 'Анна', 'Ann'], ['Anna', 'Анна', 'Аннушка'])).toEqual([
            { kind: 'same', value: 'Anna' },
            { kind: 'same', value: 'Анна' },
            { kind: 'removed', value: 'Ann' },
            { kind: 'added', value: 'Аннушка' },
        ]);
    });
});

describe('diffView', () => {
    it('renders key lists item by item, inside objects and at the top level', () => {
        const view = diffView({ key: ['Anna', 'Анна'] }, { key: ['Anna', 'Анна', 'Аннушка'] }, t);
        expect(view.querySelector('.maestro-diff-list')?.textContent).toBe('Anna, Анна, Аннушка');
        expect(view.querySelector('ins')?.textContent).toBe('Аннушка');
        expect(view.querySelector('del')).toBeNull();
        const top = diffView(['a', 'b'], ['b'], t);
        expect(top.querySelector('del')?.textContent).toBe('a');
        expect(diffView(['a'], ['a'], t).textContent).toBe('Изменений нет.');
    });

    it('renders word diffs with ins/del', () => {
        const view = diffView('Anna lives in Rome', 'Anna lives in Paris', t);
        expect(view.querySelector('del')?.textContent).toBe('Rome');
        expect(view.querySelector('ins')?.textContent).toBe('Paris');
    });

    it('renders object diffs as rows and hides unchanged fields', () => {
        const view = diffView({ a: 'x', b: 'same', c: 1 }, { a: 'y', b: 'same', c: 2 }, t);
        const rows = [...view.children].filter((node) => node.classList.contains('maestro-diff-row'));
        expect(rows).toHaveLength(2);
        expect(view.querySelector('details summary')?.textContent).toBe('Без изменений: 1');
    });

    it('says when nothing changed', () => {
        expect(diffView('a', 'a', t).textContent).toBe('Изменений нет.');
        expect(diffView(3, 3, t).textContent).toBe('Изменений нет.');
    });

    it('shows before/after blocks for other values', () => {
        const view = diffView(1, 2, t);
        expect([...view.querySelectorAll('pre')].map((node) => node.textContent)).toEqual(['1', '2']);
    });

    it('changeView shows target and locator', () => {
        const view = changeView(
            { target: 'lorebook-entry', ref: { book: 'World', uid: 7, nested: { x: 1 } }, before: 'a', after: 'b' },
            t,
        );
        expect(view.querySelector('.maestro-change-target')?.textContent).toBe('lorebook-entry');
        expect(view.querySelector('.maestro-change-ref')?.textContent).toBe('book: World, uid: 7');
    });

    it('never injects markup from data', () => {
        const view = diffView('<b>x</b>', '<img src=x onerror=alert(1)>', t);
        expect(view.querySelector('img')).toBeNull();
        const after = [...view.querySelectorAll('.maestro-diff-text > span, .maestro-diff-text > ins')]
            .map((node) => node.textContent)
            .join('');
        expect(after).toBe('<img src=x onerror=alert(1)>');
    });
});
