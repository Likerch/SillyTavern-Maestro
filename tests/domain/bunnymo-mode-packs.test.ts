import { describe, expect, it } from 'vitest';
import {
    bookSignatures,
    compareVersions,
    coreVersionOf,
    diffPackEntries,
    entrySignature,
    isOffBySelection,
    packEdition,
    packFamily,
    packTitle,
    parseWorldFile,
    readPackSelection,
    samePackSelection,
    suppressBooks,
    worldsOf,
} from '../../src/domain/bunnymo-mode-packs';
import type { UidEntry } from '../../src/domain/bunnymo-mode-tags';
import type { EntryListsLike } from '../../src/domain/canon-inject';
import {
    CORE,
    CORE_OLD,
    DERE,
    MBTI_V1,
    MBTI_V2,
    SPECIES,
    SPECIES_A,
    bsmEntries,
    coreEntries,
    cotEntries,
    dereEntries,
    mbtiV1,
    mbtiV2,
    oldCoreEntries,
    speciesEntries,
    speciesSplitEntries,
} from '../features/bunnymoMode/fixtures';
import type { Dict } from '../features/bunnymoMode/fixtures';

const uidEntries = (entries: Dict[]): UidEntry[] => entries.map((entry) => ({ uid: Number(entry.uid), entry }));

function copies(world: string, entries: Dict[]): Dict[] {
    return entries.map((entry) => {
        const { uid, ...rest } = entry;
        for (const value of Object.values(rest)) if (Array.isArray(value)) Object.freeze(value);
        return { uid, world, ...rest };
    });
}

function lists(): EntryListsLike {
    return {
        globalLore: [...copies(CORE, coreEntries()), ...copies(MBTI_V2, mbtiV2()), ...copies(MBTI_V1, mbtiV1())],
        characterLore: copies(DERE, dereEntries()),
        chatLore: copies('Chat book', [{ uid: 1, key: ['x'], content: 'chat' }]),
        personaLore: copies(SPECIES, speciesEntries()),
    };
}

describe('per-chat selection', () => {
    it('reads stored selections and falls back to every pack', () => {
        expect(readPackSelection(undefined)).toEqual({ mode: 'all' });
        expect(readPackSelection('only')).toEqual({ mode: 'all' });
        expect(readPackSelection({ mode: 'only' })).toEqual({ mode: 'all' });
        expect(readPackSelection({ mode: 'all', books: ['x'] })).toEqual({ mode: 'all' });
        expect(readPackSelection({ mode: 'only', books: ['b', 'a', 'b', 3, ''] })).toEqual({
            mode: 'only',
            books: ['a', 'b'],
        });
    });

    it('compares selections', () => {
        expect(samePackSelection({ mode: 'all' }, { mode: 'all' })).toBe(true);
        expect(samePackSelection({ mode: 'all' }, { mode: 'only', books: [] })).toBe(false);
        expect(samePackSelection({ mode: 'only', books: ['a'] }, { mode: 'only', books: ['a'] })).toBe(true);
        expect(samePackSelection({ mode: 'only', books: ['a'] }, { mode: 'only', books: ['b'] })).toBe(false);
        expect(samePackSelection({ mode: 'only', books: ['a'] }, { mode: 'only', books: ['a', 'b'] })).toBe(false);
        expect(isOffBySelection({ mode: 'all' }, 'a')).toBe(false);
        expect(isOffBySelection({ mode: 'only', books: ['a'] }, 'a')).toBe(false);
        expect(isOffBySelection({ mode: 'only', books: ['a'] }, 'b')).toBe(true);
    });

    it('splices dropped books out of every list, idempotently, without touching entries', () => {
        const scan = lists();
        const entryObjects = Object.values(scan).flat();
        const snapshot = JSON.stringify(entryObjects);
        const drop = new Set([MBTI_V1, SPECIES]);
        const asked: string[] = [];
        const removed = suppressBooks(scan, (world) => {
            asked.push(world);
            return drop.has(world);
        });
        expect([...removed]).toEqual([
            [MBTI_V1, 5],
            [SPECIES, 3],
        ]);
        // Each world is decided once.
        expect(new Set(asked).size).toBe(asked.length);
        expect(worldsOf(scan)).toEqual([CORE, MBTI_V2, DERE, 'Chat book']);
        expect(scan.personaLore).toEqual([]);
        // The entry objects (and their frozen arrays) are untouched.
        expect(JSON.stringify(entryObjects)).toBe(snapshot);
        expect(suppressBooks(scan, (world) => drop.has(world)).size).toBe(0);
    });

    it('skips list items without a world', () => {
        const scan: EntryListsLike = { globalLore: [{ uid: 1 }], characterLore: [], chatLore: [], personaLore: [] };
        expect(suppressBooks(scan, () => true).size).toBe(0);
        expect(scan.globalLore).toHaveLength(1);
        expect(worldsOf(scan)).toEqual([]);
    });
});

describe('what a pack is', () => {
    it('recognises pack families by content', () => {
        expect(packFamily(uidEntries(mbtiV2()))).toBe('MBTI');
        expect(packFamily(uidEntries(dereEntries()))).toBe('Dere');
        expect(packFamily(uidEntries(speciesEntries()))).toBe('Species');
        expect(packFamily(uidEntries(bsmEntries()))).toBe('BSM-5');
        expect(packFamily(uidEntries(cotEntries()))).toBe('BSM-5 CoT Lenses');
        const lenses = [
            { comment: '🍵Cozy Filter Start', content: '<BunnymoTags:Cozy>' },
            { comment: '🍵Cozy Filter End', content: '</BunnymoTags:Cozy>' },
        ];
        expect(packFamily(uidEntries(lenses.map((entry, uid) => ({ uid, ...entry }))))).toBe('Tell Tail Lenses');
        expect(packFamily([])).toBeNull();
    });

    it('cleans pack titles and reads versions', () => {
        expect(packTitle(MBTI_V2)).toEqual({ name: 'BunnMBTI-Pack', version: '2' });
        expect(packTitle('---LINGUISTICS.bny.json')).toEqual({ name: 'LINGUISTICS.bny' });
        expect(packTitle('--CarrotCast V1.0')).toEqual({ name: 'CarrotCast', version: '1.0' });
        expect(packTitle('---')).toEqual({ name: '---' });
    });

    it('tells split editions from shared files', () => {
        const species = bookSignatures(uidEntries(speciesEntries()));
        const split = bookSignatures(uidEntries(speciesSplitEntries()));
        expect(packEdition(SPECIES_A, split, [{ book: SPECIES, signatures: species }])).toBe('split');
        expect(packEdition(SPECIES, species, [{ book: SPECIES_A, signatures: split }])).toBe('shared');
        expect(packEdition('The Diplomats (Seperated)', new Set(['x']), [])).toBe('split');
        expect(packEdition('Empty', new Set(), [])).toBe('shared');
        // A subset of a larger loaded pack.
        const big = new Set([...species, 'extra-1', 'extra-2']);
        expect(
            packEdition('Copy', species, [
                { book: 'Copy', signatures: species },
                { book: 'Big', signatures: big },
            ]),
        ).toBe('split');
        expect(packEdition('Small', new Set(['z']), [{ book: 'Big', signatures: big }])).toBe('shared');
    });

    it('signs entries by keys and text', () => {
        expect(entrySignature({ key: ['<ELF>'], content: 'a  b' })).toBe(
            entrySignature({ key: ['<elf>'], content: 'a b' }),
        );
        expect(entrySignature({ content: 'x' })).toBeNull();
        expect(bookSignatures(uidEntries([{ uid: 1, key: ['<A>'], content: 'x', disable: true }])).size).toBe(0);
    });
});

describe('core version', () => {
    it('detects V3.0 by its HawThorne links and Medicine Check', () => {
        expect(coreVersionOf(CORE, uidEntries(coreEntries()))).toEqual({ named: '3.0', detected: '3.0' });
    });

    it('detects older cores by the sheets and filters they lack', () => {
        expect(coreVersionOf(CORE_OLD, uidEntries(oldCoreEntries()))).toEqual({ named: '2.8', detected: '2.7' });
        const v29 = [...oldCoreEntries(), { uid: 7, key: ['!physheet'], comment: '💪PHYSICAL SHEET 💪' }];
        expect(coreVersionOf('BunnyMo', uidEntries(v29)).detected).toBe('2.9');
        const v21 = [{ uid: 1, key: 7, comment: '🔮 AUTO-TRIGGER: ANTI CLANKER ALPHA' }];
        expect(coreVersionOf('BunnyMo', uidEntries(v21))).toEqual({ named: null, detected: '2.1' });
        expect(coreVersionOf('BunnyMo', []).detected).toBe('2.0');
    });

    it('compares versions numerically', () => {
        expect(compareVersions('2.10', '2.9')).toBeGreaterThan(0);
        expect(compareVersions('3.0', '3')).toBe(0);
        expect(compareVersions('2.7', '3.0')).toBeLessThan(0);
    });
});

describe('diff with a pack file', () => {
    it('parses ST world files (object or array entries)', () => {
        expect(parseWorldFile('not json')).toBeNull();
        expect(parseWorldFile('42')).toBeNull();
        expect(parseWorldFile('{"name":"x"}')).toBeNull();
        expect(parseWorldFile(JSON.stringify({ entries: { 5: { key: ['a'] } } }))?.[0]?.uid).toBe(5);
        const list = parseWorldFile(JSON.stringify({ entries: [{ uid: 7, key: ['a'] }, { key: ['b'] }, 'junk'] }));
        expect(list?.map((item) => item.uid)).toEqual([7, 1]);
    });

    it('reports added, removed and changed entries by keys and title', () => {
        const before = uidEntries(mbtiV1());
        const after = uidEntries([
            ...mbtiV2(),
            { uid: 40, key: ['<ESFP-H>'], comment: 'ESFP (Healthy) - The Entertainer', content: 'New.' },
        ]);
        const diff = diffPackEntries(before, after);
        expect(diff.added).toEqual([{ key: '<ESFP-H>', comment: 'ESFP (Healthy) - The Entertainer' }]);
        expect(diff.removed).toEqual([]);
        // Titles changed (The Schemer → The Cynic, The Tyrant → The Controlling Perfectionist): matched by keys.
        expect(diff.changed.map((item) => item.comment)).toEqual([
            'INTJ (Healthy) - The Architect',
            'INTJ (Unhealthy) - The Cynic',
            'ENTJ (Unhealthy) - The Controlling Perfectionist',
        ]);
        expect(diff.changed[1]?.before).toContain('TYWIN LANNISTER');
        expect(diff.changed[1]?.after).toContain('SEVERUS SNAPE');
    });

    it('matches by title when the keys changed and shows the keys', () => {
        const before = uidEntries([{ uid: 1, key: ['<DWARF>'], comment: 'Dwarf', content: 'Same.' }]);
        const after = uidEntries([{ uid: 1, key: ['<DWARF>', '<BEARD>'], comment: 'Dwarf', content: 'Same.' }]);
        const diff = diffPackEntries(before, after);
        expect(diff.changed).toEqual([
            { key: '<DWARF>', comment: 'Dwarf', before: '<DWARF>\n\nSame.', after: '<DWARF>, <BEARD>\n\nSame.' },
        ]);
    });

    it('reports entries only in the book and leaves identical ones out', () => {
        const same = { uid: 1, key: ['<A>'], comment: 'A', content: 'x' };
        const gone = { uid: 2, key: [], comment: '', content: 'untitled' };
        const diff = diffPackEntries(uidEntries([same, gone]), uidEntries([{ ...same, content: '  x ' }]));
        expect(diff).toEqual({ added: [], removed: [{ key: '', comment: '' }], changed: [] });
    });
});
