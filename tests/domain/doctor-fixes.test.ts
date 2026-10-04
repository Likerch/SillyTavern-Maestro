import { describe, expect, it, vi } from 'vitest';
import {
    commitPatches,
    enabledEntriesOf,
    entryHas,
    entryKeyOf,
    hasArchives,
    isBookData,
    isBunnyMoBook,
    patchBookData,
    planArchiveDepthFix,
    planCyrillicFix,
    planLocalizerFix,
    planRoleFix,
    planScanDepthFix,
    repairBraces,
    stableStringify,
} from '../../src/domain/doctor-fixes';
import type { BookData, BookIo, EntryPatch } from '../../src/domain/doctor-fixes';
import { LEFT_BOUNDARY } from '../../src/domain/rules-keys';

const archive = (name: string, extra: Record<string, unknown> = {}) => ({
    key: [name],
    comment: `${name} Character Archive`,
    content: `<BunnymoTags><Name:${name}>, <SPECIES:ELF></BunnymoTags>`,
    position: 4,
    role: 2,
    scanDepth: 1,
    ...extra,
});

function book(...entries: Record<string, unknown>[]): BookData {
    return { entries: Object.fromEntries(entries.map((entry, index) => [String(index), { uid: index, ...entry }])) };
}

describe('values and lookups', () => {
    it('compares values with sorted keys and null for absent', () => {
        expect(stableStringify({ b: 1, a: [1, { d: 2, c: undefined }] })).toBe('{"a":[1,{"d":2}],"b":1}');
        expect(stableStringify(undefined)).toBe('null');
        expect(entryHas({ scanDepth: null }, { scanDepth: undefined })).toBe(true);
        expect(entryHas({ key: ['a', 'b'] }, { key: ['b', 'a'] })).toBe(false);
        expect(isBookData({ entries: {} })).toBe(true);
        expect(isBookData({ entries: [] })).toBe(false);
    });

    it('finds entries by stored key or by uid field and lists enabled ones', () => {
        const data: BookData = {
            entries: { '0': { uid: 0 }, x: { uid: 7 }, '2': { uid: 2, disable: true }, bad: 'x' as never },
        };
        expect(entryKeyOf(data, 0)).toBe('0');
        expect(entryKeyOf(data, 7)).toBe('x');
        expect(entryKeyOf(data, 9)).toBeNull();
        expect(enabledEntriesOf(data).map((item) => item.uid)).toEqual([0, 7]);
    });
});

describe('patchBookData', () => {
    const patch: EntryPatch = { uid: 1, before: { scanDepth: 1 }, after: { scanDepth: null } };

    it('applies and reverts without touching the input', () => {
        const data = book({ key: ['a'] }, { key: ['b'], scanDepth: 1 });
        const snapshot = JSON.stringify(data);
        const applied = patchBookData(data, [patch]);
        expect(applied.ok).toBe(true);
        expect(applied.data?.entries['1']).toEqual({ uid: 1, key: ['b'], scanDepth: null });
        expect(JSON.stringify(data)).toBe(snapshot);
        const reverted = patchBookData(applied.data!, [patch], 'revert');
        expect(reverted.data?.entries['1']?.scanDepth).toBe(1);
        // A field set to undefined is removed.
        const removed = patchBookData(data, [{ uid: 0, before: { key: ['a'] }, after: { key: undefined } }]);
        expect(removed.data?.entries['0']).toEqual({ uid: 0 });
    });

    it('refuses everything when an entry is missing or changed', () => {
        const data = book({ key: ['a'] }, { key: ['b'], scanDepth: 2 });
        expect(patchBookData(data, [patch])).toEqual({ ok: false, reason: 'stale', uids: [1] });
        expect(patchBookData(data, [{ ...patch, uid: 5 }])).toEqual({ ok: false, reason: 'missing', uids: [5] });
    });
});

describe('commitPatches', () => {
    function io(data: BookData | null): BookIo & { saved: BookData[] } {
        const saved: BookData[] = [];
        return {
            saved,
            load: vi.fn(async () => (data ? structuredClone(data) : null)),
            save: vi.fn(async (_book: string, next: BookData) => {
                saved.push(next);
            }),
        };
    }

    it('loads, checks and saves once', async () => {
        const store = io(book({ scanDepth: 1 }));
        const result = await commitPatches(store, 'B', [
            { uid: 0, before: { scanDepth: 1 }, after: { scanDepth: null } },
        ]);
        expect(result).toEqual({ ok: true, uids: [0] });
        expect(store.saved[0]?.entries['0']?.scanDepth).toBeNull();
    });

    it('stops at a missing book, the guard and stale entries', async () => {
        const patch = { uid: 0, before: { scanDepth: 1 }, after: { scanDepth: null } };
        expect(await commitPatches(io(null), 'B', [patch])).toMatchObject({ ok: false, reason: 'missing' });
        const guarded = io(book({ scanDepth: 1 }));
        expect(await commitPatches(guarded, 'B', [patch], { guard: () => false })).toMatchObject({
            ok: false,
            reason: 'protected',
        });
        expect(guarded.saved).toEqual([]);
        expect(await commitPatches(io(book({ scanDepth: 3 })), 'B', [patch])).toMatchObject({ reason: 'stale' });
    });
});

describe('book facts', () => {
    it('tells BunnyMo books and archive books by content', () => {
        const pack = book(
            { key: ['<SPECIES:ELF>'], content: 'elf' },
            { key: ['<SPECIES:ORC>'], content: 'orc' },
            { key: ['<SPECIES:HUMAN>'], content: 'human' },
        );
        expect(isBunnyMoBook('Species', pack)).toBe(true);
        expect(isBunnyMoBook('Archive', book(archive('Анна')))).toBe(false);
        expect(hasArchives(book(archive('Анна')))).toBe(true);
        expect(hasArchives(pack)).toBe(false);
    });
});

describe('planners', () => {
    it('turns the assistant role at depth into system only', () => {
        expect(planRoleFix(3, { position: 4, role: 2 })).toEqual({ uid: 3, before: { role: 2 }, after: { role: 0 } });
        expect(planRoleFix(3, { position: 4, role: 1 })).toBeNull();
        expect(planRoleFix(3, { position: 1, role: 2 })).toBeNull();
        expect(planRoleFix(3, { position: 4, role: null })).toBeNull();
    });

    it('moves scan depth 1 to the global setting', () => {
        expect(planScanDepthFix(1, { scanDepth: 1 })).toEqual({
            uid: 1,
            before: { scanDepth: 1 },
            after: { scanDepth: null },
        });
        expect(planScanDepthFix(1, { scanDepth: '1' })?.before).toEqual({ scanDepth: '1' });
        expect(planScanDepthFix(1, { scanDepth: null })).toBeNull();
        expect(planScanDepthFix(1, { scanDepth: 2 })).toBeNull();
    });

    it('repairs brace keys of Localizer, removes other broken ones and keeps the marker in step', () => {
        expect(repairBraces('/И\\{1\\}ван/i')).toBe('/И[{]1[}]ван/i');
        expect(repairBraces('/(\\{/i')).toBeNull();
        const marker = {
            version: 1,
            languages: {
                ru: {
                    language: 'Russian',
                    sources: ['Florence'],
                    added: { key: ['/Фло\\-ренс/iu', '/И\\{1\\}ван/i', '/ок/iu'], keysecondary: ['/x/zz'] },
                },
                de: 'junk',
            },
        };
        const entry = {
            key: ['Florence', '/Фло\\-ренс/iu', '/И\\{1\\}ван/i', '/ок/iu'],
            keysecondary: ['/x/zz', 'y'],
            extensions: { other: true, lorebook_localizer: marker },
        };
        const patch = planLocalizerFix(4, entry)!;
        expect(patch.after.key).toEqual(['Florence', '/И[{]1[}]ван/i', '/ок/iu']);
        expect(patch.after.keysecondary).toEqual(['y']);
        const after = patch.after.extensions as Record<string, Record<string, Record<string, unknown>>>;
        expect(after.other).toBe(true);
        expect(after.lorebook_localizer?.languages).toEqual({
            ru: {
                language: 'Russian',
                sources: ['Florence'],
                added: { key: ['/И[{]1[}]ван/i', '/ок/iu'], keysecondary: [] },
            },
            de: 'junk',
        });
        expect(patch.before.extensions).toBe(entry.extensions);
        expect(planLocalizerFix(4, { key: ['/ок/iu'] })).toBeNull();
        expect(
            planLocalizerFix(4, {
                key: ['/ок/iu'],
                extensions: { lorebook_localizer: { languages: { ru: { added: { key: ['/ок/iu'] } } } } },
            }),
        ).toBeNull();
    });

    it('converts Cyrillic keys of entries with effective whole words', () => {
        const globals = { caseSensitive: false, wholeWords: false };
        expect(planCyrillicFix(0, { key: ['Аня', 'Anna'], matchWholeWords: true }, globals)).toEqual({
            uid: 0,
            before: { key: ['Аня', 'Anna'] },
            after: { key: [`/${LEFT_BOUNDARY}Аня/iu`, 'Anna'] },
        });
        expect(planCyrillicFix(0, { key: ['Аня'] }, globals)).toBeNull();
        expect(
            planCyrillicFix(0, { key: ['Аня'], keysecondary: ['лес'] }, { caseSensitive: true, wholeWords: true }),
        ).toEqual({
            uid: 0,
            before: { key: ['Аня'], keysecondary: ['лес'] },
            after: { key: [`/${LEFT_BOUNDARY}Аня/u`], keysecondary: [`/${LEFT_BOUNDARY}лес/u`] },
        });
        expect(planCyrillicFix(0, { key: ['Аня'], matchWholeWords: true, disable: true }, globals)).toBeNull();
    });

    it('fixes CK archive depth and adds case forms after the plain keys when DES-RU is there', () => {
        const raw = archive('Анна', { key: ['Анна', 'Anna', 'Анна Петрова', '/x/'] });
        expect(planArchiveDepthFix(2, raw)).toEqual({ uid: 2, before: { scanDepth: 1 }, after: { scanDepth: null } });
        const forms = vi.fn((name: string) =>
            name === 'Анна' ? '/анна|анны/iu' : name.includes(' ') ? '/ап/iu' : null,
        );
        expect(planArchiveDepthFix(2, raw, forms)).toEqual({
            uid: 2,
            before: { scanDepth: 1, key: ['Анна', 'Anna', 'Анна Петрова', '/x/'] },
            after: { scanDepth: null, key: ['Анна', 'Anna', 'Анна Петрова', '/x/', '/анна|анны/iu', '/ап/iu'] },
        });
        expect(forms).not.toHaveBeenCalledWith('Anna');
        const failing = () => {
            throw new Error('no forms');
        };
        expect(planArchiveDepthFix(2, raw, failing)?.after).toEqual({ scanDepth: null });
        expect(planArchiveDepthFix(2, { ...raw, scanDepth: null }, forms)).toBeNull();
    });
});
