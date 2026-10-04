import { describe, expect, it } from 'vitest';
import {
    findVersionConflicts,
    hasNsfwKey,
    isCarrotCastEntry,
    losersOf,
    packContentSignature,
    packGroupId,
    packKeySignature,
} from '../../src/domain/rules-packs';
import type { PackEntryLike } from '../../src/domain/rules-packs';

let uid = 0;
const e = (world: string, fields: Partial<PackEntryLike> = {}): PackEntryLike => ({
    world,
    uid: uid++,
    key: ['<X>'],
    content: 'text',
    ...fields,
});
const packs =
    (...books: string[]) =>
    (world: string) =>
        books.includes(world);

describe('signatures', () => {
    it('normalises pack keys and skips constants and keyless entries', () => {
        expect(packKeySignature({ key: ['<LING: HORNY>', ' <ling:horny>', 'b'] })).toBe('["<LING:HORNY>","B"]');
        expect(packKeySignature({ key: ['/Re/i'] })).toBe('["/Re/i"]');
        expect(packKeySignature({ key: ['<X>'], constant: true })).toBeNull();
        expect(packKeySignature({ key: [' ', 3] })).toBeNull();
        expect(packKeySignature({ key: 'nope' })).toBeNull();
        expect(packContentSignature(' a \n b ')).toBe('a b');
        expect(packContentSignature(5)).toBe('');
        expect(packGroupId(['b', 'a', 'b'])).toBe(packGroupId(['a', 'b']));
    });
});

describe('findVersionConflicts', () => {
    const v1 = 'MBTI v1 (Retired)';
    const v2 = 'MBTI V2';

    it('groups key sets with different text across pack books and offers the newest book', () => {
        const entries = [
            e(v1, { key: ['<INTJ-H>'], content: 'Mastermind' }),
            e(v1, { key: ['<INTJ-U>'], content: 'The Schemer' }),
            e(v1, { key: ['<ENTP-U>'], content: 'Old debater' }),
            e(v2, { key: ['<INTJ-H>'], content: ' Mastermind ' }),
            e(v2, { key: ['<intj-u>'], content: 'The Cynic' }),
            e(v2, { key: ['<ENTP-U>'], content: 'New debater' }),
            e('Flora', { key: ['<INTJ-U>'], content: 'Not a pack' }),
        ];
        const groups = findVersionConflicts(entries, packs(v1, v2));
        expect(groups).toHaveLength(1);
        const group = groups[0]!;
        expect(group).toMatchObject({ books: [v1, v2], newest: v2, count: 2, sample: ['<INTJ-U>', '<ENTP-U>'] });
        expect(group.id).toBe(packGroupId([v2, v1]));
        expect(group.entries.map((entry) => entry.content)).toEqual([
            'The Schemer',
            'The Cynic',
            'Old debater',
            'New debater',
        ]);
        expect(losersOf(group, v2).map((entry) => entry.world)).toEqual([v1, v1]);
        expect(losersOf(group, v1).map((entry) => entry.world)).toEqual([v2, v2]);
        expect(losersOf(group, '')).toEqual([]);
        expect(losersOf(group, 'Renamed')).toEqual([]);
    });

    it('skips the intended CoT Lenses pairing, constants, disabled and empty entries, and single books', () => {
        const entries = [
            e('BSM-5', { key: ['<BSM:PTSD>'], content: 'Diagnosis' }),
            e('CoT Lenses', { key: ['<BSM:PTSD>'], content: 'Lens', comment: 'CoT LENS — PTSD' }),
            e('BSM-5', { key: ['<BSM:MDD>'], content: 'Diagnosis' }),
            e('CoT Lenses', { key: ['<BSM:MDD>'], content: 'Lens', comment: '💊 CoT LENS — DEPRESSION' }),
            e('A', { key: ['<R>'], content: 'read me A', constant: true }),
            e('B', { key: ['<R>'], content: 'read me B', constant: true }),
            e('A', { key: ['<D>'], content: 'one', disable: true }),
            e('B', { key: ['<D>'], content: 'two' }),
            e('A', { key: ['<E>'], content: '   ' }),
            e('B', { key: ['<E>'], content: 'x' }),
            e('A', { key: ['<S>'], content: 'one' }),
            e('A', { key: ['<S>'], content: 'two' }),
        ];
        expect(findVersionConflicts(entries, packs('BSM-5', 'CoT Lenses', 'A', 'B'))).toEqual([]);
    });

    it('makes one group per set of books and picks the newest by version, then by size', () => {
        const entries = [
            e('Pack 1.0', { key: ['<A>'], content: 'a1' }),
            e('Pack 1.2', { key: ['<A>'], content: 'a2' }),
            e('Pack 1.0', { key: ['<B>'], content: 'b1' }),
            e('Pack 1.2', { key: ['<B>'], content: 'b2' }),
            e('Lite', { key: ['<L>'], content: 'short' }),
            e('Full', { key: ['<L>'], content: 'long' }),
            e('Full', { key: ['<M>'], content: 'more' }),
        ];
        const groups = findVersionConflicts(entries, () => true);
        expect(groups.map((group) => [group.books, group.newest, group.count])).toEqual([
            [['Pack 1.0', 'Pack 1.2'], 'Pack 1.2', 2],
            [['Lite', 'Full'], 'Full', 1],
        ]);
    });
});

describe('<NSFW> and CarrotCast', () => {
    it('finds the bare <NSFW> key only', () => {
        expect(hasNsfwKey(['<GENRE:EROTIC>', ' <nsfw> '])).toBe(true);
        expect(hasNsfwKey(['<GENRE:NSFW>'])).toBe(false);
        expect(hasNsfwKey('<NSFW>')).toBe(false);
    });

    it('recognises CarrotCast entries by book name or the BunnyFlix header', () => {
        expect(isCarrotCastEntry({ world: '--CarrotCastLimited' })).toBe(true);
        expect(isCarrotCastEntry({ book: 'Carrot Cast V1.0' })).toBe(true);
        expect(isCarrotCastEntry({ world: 'Genres', content: '# 🔥 **BunnyFlix Premium**' })).toBe(true);
        expect(isCarrotCastEntry({ world: 'Genres', content: `${'x'.repeat(700)} BunnyFlix` })).toBe(false);
        expect(isCarrotCastEntry({ world: 'Species', content: 'Elf' })).toBe(false);
    });
});
