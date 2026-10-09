import { describe, expect, it } from 'vitest';
import { splitWho } from '../../src/domain/wardrobe-change';
import {
    CHANGE_SCHEMA,
    CHANGE_SCHEMA_NAME,
    changeMessages,
    parseChangeAnswer,
} from '../../src/domain/wardrobe-change-model';

describe('the model’s part of changes of clothes', () => {
    it('asks about the listed people with their outfits and what the text said', () => {
        const [system, user] = changeMessages({
            people: [
                { name: 'Алекс', persona: true, outfits: ['Домашнее'], current: 'серый плащ' },
                { name: 'Вера', outfits: [], current: '' },
            ],
            said: ['Алекс: переодеваюсь'],
            excerpt: 'x'.repeat(5000) + 'конец',
        });
        expect(CHANGE_SCHEMA_NAME).toBe('wardrobe_change');
        expect(CHANGE_SCHEMA.required).toEqual(['changes']);
        expect(system!.content).toContain('JSON only');
        expect(user!.content).toContain(
            "- Алекс (the user's character); wore before: серый плащ; known outfits: Домашнее",
        );
        expect(user!.content).toContain('- Вера');
        expect(user!.content).toContain('- Алекс: переодеваюсь');
        expect(user!.content.endsWith('конец')).toBe(true);
        expect(user!.content.length).toBeLessThan(4000);
    });

    it('reads the answer and drops junk', () => {
        expect(
            parseChangeAnswer({
                changes: [
                    { name: 'Алекс', wearing: 'пижама', outfit: null },
                    { name: 'Вера', wearing: null, outfit: 'Домашнее' },
                    { name: 'Кай', wearing: 'none', outfit: null },
                    { name: '', wearing: 'плащ', outfit: null },
                    'junk',
                ],
            }),
        ).toEqual([
            { name: 'Алекс', wearing: 'пижама', outfit: null },
            { name: 'Вера', wearing: null, outfit: 'Домашнее' },
        ]);
        expect(parseChangeAnswer('{"changes":[{"name":"Вера","wearing":"халат","outfit":null}]}')).toHaveLength(1);
        expect(parseChangeAnswer('not json')).toEqual([]);
        expect(parseChangeAnswer({ changes: 'x' })).toEqual([]);
        expect(parseChangeAnswer(null)).toEqual([]);
    });
});

describe('splitWho', () => {
    const people = [
        { who: 'persona', names: ['я', 'me', 'Алекс'] },
        { who: 'Офелия Грей', names: ['Офелия Грей', 'Офелия'] },
        { who: 'Кай', names: ['Кай'] },
    ];

    it('takes the longest name at the start, a quoted one too', () => {
        expect(splitWho('Офелия Грей вечернее платье', people)).toEqual({
            who: 'Офелия Грей',
            rest: 'вечернее платье',
        });
        expect(splitWho('Офелия домашнее', people)).toEqual({ who: 'Офелия Грей', rest: 'домашнее' });
        expect(splitWho('я серый плащ и сапоги', people)).toEqual({ who: 'persona', rest: 'серый плащ и сапоги' });
        expect(splitWho('«Офелия Грей» пижама', people)).toEqual({ who: 'Офелия Грей', rest: 'пижама' });
        expect(splitWho('Кай:', people)).toEqual({ who: 'Кай', rest: '' });
        expect(splitWho('Незнакомка платье', people)).toBeNull();
    });
});
