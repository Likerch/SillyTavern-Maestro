import { describe, expect, it } from 'vitest';
import {
    explainLoreEntry,
    LORE_REASON_TEXT,
    otherCaseForm,
    russianStem,
    scanWindow,
    secondaryPasses,
} from '../../src/domain/assistant-explain-lore';
import type { LoreExplainInput } from '../../src/domain/assistant-explain-lore';

const GLOBALS = { caseSensitive: false, matchWholeWords: false };

function input(messages: string[], patch: Partial<LoreExplainInput> = {}): LoreExplainInput {
    return { messages, depth: 2, globals: GLOBALS, ...patch };
}

const codes = (result: { reasons: { code: string }[] }) => result.reasons.map((reason) => reason.code);

describe('helpers', () => {
    it('cuts the scan window at the depth', () => {
        expect(scanWindow(['a', 'b', 'c'], 2)).toEqual({ window: 'b\nc', older: ['a'] });
        expect(scanWindow(['a'], 5)).toEqual({ window: 'a', older: [] });
        expect(scanWindow(['a', 'b'], 0)).toEqual({ window: '', older: ['a', 'b'] });
    });

    it('stems one-word Russian keys only', () => {
        expect(russianStem('Анна')).toBe('анн');
        expect(russianStem('Мария')).toBe('мари');
        expect(russianStem('Ёлка')).toBe('елк');
        expect(russianStem('Anna')).toBeNull();
        expect(russianStem('/анн[аы]/i')).toBeNull();
        expect(russianStem('Аня')).toBeNull();
        expect(russianStem('Анна Петровна')).toBeNull();
    });

    it('finds another case form of a key in the text', () => {
        expect(otherCaseForm('Анна', 'Он позвал Анну к себе.')).toBe('анну');
        expect(otherCaseForm('Анна', 'Анна пришла.')).toBeNull();
        expect(otherCaseForm('Anna', 'Annas')).toBeNull();
        expect(otherCaseForm('Анна', 'аннотация')).toBeNull();
    });

    it('evaluates the four secondary logics', () => {
        const base = { selective: true, keysecondary: ['лес', 'ночь'] };
        expect(secondaryPasses({ ...base, selectiveLogic: 0 }, 'в лесу', GLOBALS)).toBe(true);
        expect(secondaryPasses({ ...base, selectiveLogic: 0 }, 'днём', GLOBALS)).toBe(false);
        expect(secondaryPasses({ ...base, selectiveLogic: 3 }, 'лес ночь', GLOBALS)).toBe(true);
        expect(secondaryPasses({ ...base, selectiveLogic: 3 }, 'лес', GLOBALS)).toBe(false);
        expect(secondaryPasses({ ...base, selectiveLogic: 1 }, 'лес', GLOBALS)).toBe(true);
        expect(secondaryPasses({ ...base, selectiveLogic: 1 }, 'лес ночь', GLOBALS)).toBe(false);
        expect(secondaryPasses({ ...base, selectiveLogic: 2 }, 'днём', GLOBALS)).toBe(true);
        expect(secondaryPasses({ ...base, selectiveLogic: 2 }, 'ночь', GLOBALS)).toBe(false);
        expect(secondaryPasses({ selective: false, keysecondary: ['x'] }, '', GLOBALS)).toBe(true);
        expect(
            secondaryPasses({ ...base, caseSensitive: true, matchWholeWords: true, selectiveLogic: 0 }, 'Лес', GLOBALS),
        ).toBe(false);
    });
});

describe('explainLoreEntry', () => {
    it('reports a fired entry with its key, and a cut one', () => {
        const entry = { key: ['Анна'] };
        const fired = explainLoreEntry(entry, input(['Анна пришла'], { activation: {} }));
        expect(fired.fired).toBe(true);
        expect(fired.reasons).toEqual([{ code: 'fired', detail: 'Анна' }]);
        expect(fired.matchedKey).toBe('Анна');
        const constant = explainLoreEntry({ constant: true }, input([], { activation: {} }));
        expect(constant.reasons).toEqual([{ code: 'fired' }]);
        const cut = explainLoreEntry(entry, input(['Анна'], { activation: { cut: true, cutBy: 'budget' } }));
        expect(cut.reasons).toEqual([{ code: 'cut', detail: 'budget' }]);
        expect(explainLoreEntry(entry, input([], { activation: { cut: true } })).reasons[0]!.detail).toBe('other');
    });

    it('finds the key said earlier than the scan depth', () => {
        const result = explainLoreEntry({ key: ['сестра'] }, input(['У неё есть сестра', 'Привет', 'Как дела']));
        expect(result.fired).toBe(false);
        expect(result.reasons).toEqual([{ code: 'beyondDepth', detail: 'сестра · 3 > 2' }]);
    });

    it('uses the entry scan depth over the global one', () => {
        const result = explainLoreEntry(
            { key: ['сестра'], scanDepth: 5 },
            input(['сестра', 'a', 'b'], { activation: null }),
        );
        expect(codes(result)).toEqual(['keyMatched']);
    });

    it('finds another Russian case form than the key', () => {
        const result = explainLoreEntry({ key: ['Анна'] }, input(['Она обняла Анну']));
        expect(result.reasons).toEqual([{ code: 'otherCaseForm', detail: 'Анна ≠ анну' }]);
    });

    it('reports no key in the scan window and no keys at all', () => {
        expect(explainLoreEntry({ key: ['дракон', 'змей'] }, input(['тишина'])).reasons).toEqual([
            { code: 'noKeyInScan', detail: 'дракон, змей' },
        ]);
        expect(codes(explainLoreEntry({ key: [] }, input(['x'])))).toEqual(['noKeys']);
        const many = explainLoreEntry({ key: ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'] }, input(['zzz']));
        expect(many.reasons[0]!.detail).toBe('a1, a2, a3, a4, a5, …');
    });

    it('reports failed secondary keys and a match that still did not fire', () => {
        const entry = { key: ['Анна'], selective: true, keysecondary: ['лес'], selectiveLogic: 3 };
        expect(explainLoreEntry(entry, input(['Анна дома'])).reasons).toEqual([
            { code: 'secondaryFailed', detail: 'AND ALL: лес' },
        ]);
        const plain = { key: ['Анна'], selective: true, keysecondary: ['лес'] };
        expect(explainLoreEntry(plain, input(['Анна дома'])).reasons[0]!.detail).toBe('AND ANY: лес');
        const odd = { key: ['Анна'], selective: true, keysecondary: ['лес'], selectiveLogic: 9 };
        expect(explainLoreEntry(odd, input(['Анна дома'])).reasons[0]!.detail).toBe('9: лес');
        expect(codes(explainLoreEntry({ key: ['Анна'] }, input(['Анна дома'])))).toEqual(['keyMatched']);
    });

    it('lists the blocking fields of the entry', () => {
        const entry = {
            key: ['Анна'],
            disable: true,
            triggers: ['continue'],
            characterFilter: { names: ['Kai'], tags: ['elf'], isExclude: true },
            useProbability: true,
            probability: 40,
            delay: 10,
            cooldown: 3,
            sticky: 2,
            group: ' family ',
            delayUntilRecursion: 1,
            vectorized: true,
        };
        const result = explainLoreEntry(entry, input(['Анна']));
        expect(result.reasons).toEqual([
            { code: 'disabled' },
            { code: 'triggers', detail: 'continue' },
            { code: 'characterFilter', detail: 'except: Kai, elf' },
            { code: 'probability', detail: '40%' },
            { code: 'delay', detail: '10' },
            { code: 'cooldown', detail: '3' },
            { code: 'sticky', detail: '2' },
            { code: 'group', detail: 'family' },
            { code: 'recursionOnly' },
            { code: 'vectorized' },
            { code: 'keyMatched', detail: 'Анна' },
        ]);
        const only = explainLoreEntry({ key: ['x'], characterFilter: { names: ['Kai'] } }, input([]));
        expect(only.reasons[0]).toEqual({ code: 'characterFilter', detail: 'only: Kai' });
        expect(codes(explainLoreEntry({ key: ['x'], characterFilter: { names: [] } }, input([])))).toEqual([
            'noKeyInScan',
        ]);
        expect(codes(explainLoreEntry({ key: ['x'], useProbability: false, probability: 10 }, input([])))).toEqual([
            'noKeyInScan',
        ]);
    });

    it('stops at a constant entry', () => {
        expect(codes(explainLoreEntry({ constant: true, key: ['x'] }, input(['x'])))).toEqual(['constant']);
    });

    it('has a text for every reason in both languages', () => {
        expect(Object.keys(LORE_REASON_TEXT.ru)).toEqual(Object.keys(LORE_REASON_TEXT.en));
    });
});
