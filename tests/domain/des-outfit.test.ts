import { describe, expect, it } from 'vitest';
import { desFieldKey, replaceClothing, setDesOutfit } from '../../src/domain/des-outfit';
import { staleObservation } from '../../src/domain/wardrobe-current';
import type { WearRecord } from '../../src/domain/wardrobe-current';

const thoughts = (characters: unknown[]) => JSON.stringify(characters);

describe('desFieldKey', () => {
    it('is DES’s snake_case key, a Cyrillic name its own key', () => {
        expect(desFieldKey('Outfit')).toBe('outfit');
        expect(desFieldKey('Current Clothes (what they wear)')).toBe('current_clothes');
        expect(desFieldKey('Одежда')).toBe('Одежда');
    });
});

describe('replaceClothing', () => {
    it('puts the new clothes where the old ones were and keeps hair, eyes and body', () => {
        expect(
            replaceClothing('Высокая, рыжие волосы, в синем плаще и сапогах, зелёные глаза', 'домашнее платье'),
        ).toBe('Высокая, рыжие волосы, домашнее платье, зелёные глаза');
        expect(replaceClothing('Носит белую блузку. Глаза серые. Чёрная юбка.', 'пижама')).toBe('пижама. Глаза серые.');
        expect(replaceClothing('Высокий, рыжий', 'кольчуга')).toBeNull();
        expect(replaceClothing('в плаще', '  ')).toBeNull();
    });
});

describe('setDesOutfit', () => {
    it('writes the clothing field the tracker has, keeping the shape and the others', () => {
        const raw = thoughts([
            { name: 'Вера', details: { appearance: 'рыжая', outfit: 'плащ' }, thoughts: { content: '…' } },
            { name: 'Кай', details: { appearance: 'высокий' } },
        ]);
        const edit = setDesOutfit(raw, ['Вера'], 'домашнее платье', null)!;
        expect(edit).toMatchObject({ key: 'outfit', field: 'outfit', before: 'плащ', after: 'домашнее платье' });
        const data = JSON.parse(edit.thoughts) as { name: string; details: Record<string, string> }[];
        expect(data[0]!.details).toEqual({ appearance: 'рыжая', outfit: 'домашнее платье' });
        expect(data[1]!.details).toEqual({ appearance: 'высокий' });
        // `{characters}` and `{value}` wrappers stay.
        const wrapped = setDesOutfit(
            JSON.stringify({ characters: [{ name: 'Vera', details: { Одежда: { value: 'плащ' } } }] }),
            ['vera'],
            'пижама',
            null,
        )!;
        expect(JSON.parse(wrapped.thoughts)).toEqual({
            characters: [{ name: 'Vera', details: { Одежда: { value: 'пижама' } } }],
        });
    });

    it('adds the configured clothing field, else uses an appearance that holds clothes', () => {
        const raw = thoughts([{ name: 'Вера', details: { Внешность: 'рыжая, в синем плаще' } }]);
        const added = setDesOutfit(raw, 'Вера', 'пижама', [
            { name: 'Внешность', enabled: true },
            { name: 'Одежда', enabled: true },
        ])!;
        expect(added).toMatchObject({ key: 'Одежда', field: 'outfit', before: '' });
        const replaced = setDesOutfit(raw, 'Вера', 'пижама', [{ name: 'Одежда', enabled: false }])!;
        expect(replaced).toMatchObject({ key: 'Внешность', field: 'appearance', after: 'рыжая, пижама' });
    });

    it('writes nothing for someone else, a tracker without clothes, the same clothes or junk', () => {
        const raw = thoughts([{ name: 'Вера', details: { appearance: 'рыжая', outfit: 'плащ' } }]);
        expect(setDesOutfit(raw, 'Кай', 'плащ', null)).toBeNull();
        expect(setDesOutfit(raw, 'Вера', 'плащ', null)).toBeNull();
        expect(
            setDesOutfit(thoughts([{ name: 'Вера', details: { appearance: 'рыжая' } }]), 'Вера', 'плащ', null),
        ).toBeNull();
        expect(setDesOutfit('not json', 'Вера', 'плащ', null)).toBeNull();
        expect(setDesOutfit(raw, 'Вера', '', null)).toBeNull();
    });
});

describe('staleObservation', () => {
    const record = (extra: Partial<WearRecord>): WearRecord => ({
        key: 'p',
        name: 'Вера',
        passportId: 'p',
        wording: 'шёлковый халат',
        tags: '',
        undress: '',
        source: 'player',
        outfit: null,
        since: 5,
        swipe: 0,
        seen: 5,
        turns: 1,
        present: true,
        at: 0,
        ...extra,
    });

    it('keeps a change from a tracker that is older or still says the clothes from before', () => {
        const changed = record({ changedAt: 5, was: 'синие джинсы' });
        const jeans = { wording: 'синие джинсы', undress: '' as const };
        expect(staleObservation(changed, jeans, 4)).toBe(true);
        expect(staleObservation(changed, jeans, 6)).toBe(true);
        expect(staleObservation(changed, jeans, 12)).toBe(false);
        expect(staleObservation(changed, { wording: 'чёрное пальто', undress: '' }, 6)).toBe(false);
        expect(staleObservation(changed, { wording: 'шёлковый халат', undress: '' }, 5)).toBe(false);
        expect(staleObservation(record({}), jeans, 6)).toBe(false);
    });
});
