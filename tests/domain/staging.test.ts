import { describe, expect, it } from 'vitest';
import {
    describeEntry,
    mergeStaging,
    sanitizeEntries,
    sanitizeEntry,
    STAGING_LINE_MAX,
    stagingLine,
} from '../../src/domain/staging';

describe('staging', () => {
    it('sanitises entries: a name is required, fields are short single lines, names are unique', () => {
        expect(sanitizeEntry({ pose: 'sits' })).toBeNull();
        expect(sanitizeEntry({ name: ' Мира ', pose: ' сидит\n у окна ', holding: 5 })).toEqual({
            name: 'Мира',
            pose: 'сидит у окна',
        });
        expect(sanitizeEntries([{ name: 'Мира' }, { name: 'мира' }, 'x', { name: 'Кай' }])).toEqual([
            { name: 'Мира' },
            { name: 'Кай' },
        ]);
        expect(sanitizeEntries('x')).toEqual([]);
    });

    it('merges changes over the previous record; a left-out field stays; gone names leave', () => {
        const previous = [
            { name: 'Мира', pose: 'стоит', where: 'у окна', holding: 'кубок' },
            { name: 'Кай', pose: 'сидит' },
        ];
        const next = mergeStaging(
            previous,
            [
                { name: 'мира', pose: 'сидит' },
                { name: 'Вера', where: 'в дверях' },
            ],
            ['Кай'],
        );
        expect(next).toEqual([
            { name: 'Мира', pose: 'сидит', where: 'у окна', holding: 'кубок' },
            { name: 'Вера', where: 'в дверях' },
        ]);
        expect(previous[0]?.pose).toBe('стоит');
        const cleared = mergeStaging(next, sanitizeEntries([{ name: 'Мира', holding: '' }]));
        expect(cleared[0]?.holding).toBe('кубок');
    });

    it('describes an entry and makes a capped prompt line', () => {
        expect(
            describeEntry({ name: 'Мира', pose: 'sits', where: 'at the table', holding: 'a cup', near: 'next to Kai' }),
        ).toBe('Мира: sits at the table; holding a cup; next to Kai');
        expect(describeEntry({ name: 'Кай' })).toBe('Кай');
        expect(stagingLine([])).toBe('');
        expect(stagingLine([{ name: 'Мира', pose: 'sits' }])).toBe('[Staging now — keep it consistent: Мира: sits]');
        const long = stagingLine(
            Array.from({ length: 12 }, (_, i) => ({
                name: `Name${i}`,
                pose: 'standing very still',
                where: 'by the far wall',
            })),
        );
        expect(long.length).toBeLessThanOrEqual(STAGING_LINE_MAX);
        expect(long.endsWith('…]')).toBe(true);
    });
});
