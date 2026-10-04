import { describe, expect, it } from 'vitest';
import {
    ROLE_IDS,
    bookFingerprint,
    contentFacts,
    detectRole,
    emptyRegistry,
    emptyRoleContext,
    isBackupBookName,
    isCanonBookName,
    isMaestroBookName,
    isRoleId,
    mergeRegistry,
    packInfo,
    readRegistry,
    roleTraits,
    sameRecord,
} from '../../src/domain/roles-detect';
import type { ContentFacts, RoleContext, RoleRecord } from '../../src/domain/roles-detect';

function bookOf(entries: Record<string, unknown>[], extensions?: Record<string, unknown>) {
    return {
        entries: Object.fromEntries(entries.map((entry, uid) => [String(uid), { uid, ...entry }])),
        ...(extensions ? { extensions } : {}),
    };
}

const core = bookOf([
    { key: ['!fullsheet'], content: 'Sheet.' },
    { key: ['!quicksheet'], content: 'Sheet.' },
    { comment: 'Master - Rules', key: ['rules'], content: 'Rules.' },
    { key: ['x'], content: 'Other.' },
]);
const pack = bookOf([
    { key: ['<SPECIES:ELF>'], content: 'Elves.' },
    { key: ['<SPECIES:ORC>'], content: 'Orcs.' },
    { key: ['<SPECIES:HUMAN>'], content: 'Humans.' },
]);
const archive = (name: string) => ({
    key: [name],
    content: `<BunnymoTags><Name:${name}><GENRE:FANTASY></BunnymoTags>`,
});
const archives = bookOf([archive('Alice'), archive('Bob'), { key: ['tavern'], content: 'A tavern.' }]);
const world = bookOf([
    { key: ['castle'], content: 'A castle.' },
    archive('Carol'),
    { key: ['road'], content: 'A road.' },
]);

function context(fields: Partial<RoleContext> = {}): RoleContext {
    return { ...emptyRoleContext(), ...fields };
}

describe('names', () => {
    it('recognise canon, Maestro and backup books', () => {
        expect(isCanonBookName('Maestro · канон · abc12345')).toBe(true);
        expect(isMaestroBookName('Maestro · канон · abc12345')).toBe(false);
        expect(isMaestroBookName('Maestro · места')).toBe(true);
        expect(isBackupBookName('World (backup 2026-10-04 12-00)')).toBe(true);
        expect(isBackupBookName('Repo.carrot_backup')).toBe(true);
        expect(isBackupBookName('Backup plans')).toBe(false);
        expect(isRoleId('world')).toBe(true);
        expect(isRoleId('nope')).toBe(false);
        expect(ROLE_IDS).toHaveLength(12);
    });
});

describe('contentFacts and bookFingerprint', () => {
    it('classify BunnyMo core, packs and archives', () => {
        expect(contentFacts('Core', core)).toMatchObject({ bunnymo: 'core', entries: 4 });
        expect(contentFacts('Pack', pack)).toMatchObject({ bunnymo: 'pack', archives: 0 });
        expect(contentFacts('Repo', archives)).toMatchObject({ bunnymo: null, archives: 2, entries: 3 });
        expect(contentFacts('Maestro', bookOf([], { maestro: { role: 'maestro' } })).maestroRole).toBe('maestro');
        expect(contentFacts('Empty', null)).toEqual({ bunnymo: null, archives: 0, entries: 0, maestroRole: null });
    });

    it('skips disabled archives', () => {
        const disabled = bookOf([
            { ...archive('Alice'), disable: true },
            { key: ['x'], content: 'x' },
        ]);
        expect(contentFacts('Repo', disabled).archives).toBe(0);
    });

    it('fingerprint content, not settings', () => {
        const a = bookFingerprint(world);
        const reordered = { entries: { ...world.entries, '0': { ...world.entries['0'], order: 5 } } };
        expect(bookFingerprint(reordered)).toBe(a);
        const edited = { entries: { ...world.entries, '0': { ...world.entries['0'], content: 'A ruin.' } } };
        expect(bookFingerprint(edited)).not.toBe(a);
        expect(bookFingerprint({ ...world, extensions: { maestro: { role: 'maestro' } } })).not.toBe(a);
        expect(bookFingerprint(null)).toMatch(/^0:/);
        expect(bookFingerprint({ entries: { '1': 'junk', '10': { content: 'x' }, '2': { content: 'y' } } })).toMatch(
            /^2:/,
        );
    });
});

describe('detectRole', () => {
    const facts = (fields: Partial<ContentFacts> = {}): ContentFacts => ({
        bunnymo: null,
        archives: 0,
        entries: 10,
        maestroRole: null,
        ...fields,
    });

    it('applies the documented order', () => {
        expect(detectRole('Maestro · канон · x', facts({ bunnymo: 'core' }), context())).toBe('canon');
        expect(detectRole('Any', facts({ maestroRole: 'canon' }), context())).toBe('canon');
        expect(detectRole('Maestro · места', facts(), context())).toBe('maestro');
        expect(detectRole('Any', facts({ maestroRole: 'maestro' }), context())).toBe('maestro');
        expect(detectRole('Species (backup 1)', facts({ bunnymo: 'pack' }), context())).toBe('backup');
        expect(detectRole('Core', facts({ bunnymo: 'core' }), context({ cardBooks: new Set(['Core']) }))).toBe(
            'bunnymo.core',
        );
        expect(detectRole('Pack', facts({ bunnymo: 'pack' }), context())).toBe('bunnymo.pack');
        expect(detectRole('Repo', facts(), context({ ckRepos: new Set(['Repo']) }))).toBe('ck.archive');
        expect(detectRole('Repo', facts({ archives: 5, entries: 8 }), context())).toBe('ck.archive');
        expect(detectRole('World', facts({ archives: 1, entries: 8 }), context())).toBe('world');
        expect(detectRole('Card', facts(), context({ cardBooks: new Set(['Card']), chatBook: 'Card' }))).toBe('card');
        expect(detectRole('Chat', facts(), context({ chatBook: 'Chat', personaBooks: new Set(['Chat']) }))).toBe(
            'chat',
        );
        expect(detectRole('Me', facts(), context({ personaBooks: new Set(['Me']) }))).toBe('persona');
        expect(detectRole(' Alice ', facts(), context({ npcNames: new Set(['alice']) }))).toBe('npc');
        expect(detectRole('World', facts(), context())).toBe('world');
        expect(detectRole('Unreadable', null, context())).toBe('unknown');
        expect(detectRole('Maestro · места', null, context())).toBe('maestro');
    });

    it('keeps a chat or NPC role while the content is the same and the book is not global', () => {
        const previous = { role: 'chat' as const, source: 'auto' as const, fingerprint: 'f1' };
        expect(detectRole('Old chat', facts(), context(), previous, 'f1')).toBe('chat');
        expect(detectRole('Old chat', facts(), context(), previous, 'f2')).toBe('world');
        expect(detectRole('Old chat', facts(), context({ globalBooks: new Set(['Old chat']) }), previous, 'f1')).toBe(
            'world',
        );
        expect(detectRole('Old chat', facts(), context(), previous)).toBe('world');
        expect(detectRole('Old', facts(), context(), { ...previous, role: 'npc' }, 'f1')).toBe('npc');
        expect(detectRole('Old', facts(), context(), { ...previous, role: 'card' }, 'f1')).toBe('world');
        expect(detectRole('Old', facts(), context(), { ...previous, source: 'user' }, 'f1')).toBe('world');
    });
});

describe('traits and packs', () => {
    it('make BunnyMo read-only and never localisable', () => {
        expect(roleTraits('bunnymo.core')).toEqual({ readOnly: true, localizable: false });
        expect(roleTraits('bunnymo.pack')).toEqual({ readOnly: true, localizable: false });
        expect(roleTraits('backup')).toEqual({ readOnly: false, localizable: false });
        expect(roleTraits('canon')).toEqual({ readOnly: false, localizable: true });
    });

    it('read pack names and versions', () => {
        expect(packInfo('MBTI V2')).toEqual({ name: 'MBTI', version: '2' });
        expect(packInfo('BUNNYMO V3.0')).toEqual({ name: 'BUNNYMO', version: '3.0' });
        expect(packInfo('Species')).toEqual({ name: 'Species' });
        expect(packInfo('Pack 1.2')).toEqual({ name: 'Pack 1.2', version: '1.2' });
    });
});

describe('registry', () => {
    const record = (fields: Partial<RoleRecord> = {}): RoleRecord => ({
        role: 'world',
        source: 'auto',
        fingerprint: 'f',
        at: 1,
        ...fields,
    });

    it('reads stored records and drops junk', () => {
        const registry = readRegistry({
            books: {
                World: {
                    role: 'world',
                    source: 'auto',
                    fingerprint: 'f',
                    at: 3,
                    facts: { bunnymo: 'x', archives: -1 },
                },
                Pack: { role: 'bunnymo.pack', source: 'user', pack: { name: 'Pack', version: '2' } },
                Bad: { role: 'nope' },
                '': { role: 'world' },
                Junk: 'x',
                NoVersion: { role: 'bunnymo.pack', pack: { name: 'P', version: 3 } },
            },
        });
        expect(Object.keys(registry.books).sort()).toEqual(['NoVersion', 'Pack', 'World']);
        expect(registry.books.World?.facts).toEqual({ bunnymo: null, archives: 0, entries: 0, maestroRole: null });
        expect(registry.books.Pack).toMatchObject({ source: 'user', fingerprint: '', at: 0, pack: { version: '2' } });
        expect(registry.books.NoVersion?.pack).toEqual({ name: 'P' });
        expect(readRegistry(null)).toEqual(emptyRegistry());
    });

    it('merges another tab’s registry with this tab’s changes', () => {
        const stored = { schema: 1 as const, books: { A: record(), B: record({ role: 'card' }), C: record() } };
        const local = { schema: 1 as const, books: { A: record({ role: 'npc', source: 'user' }) } };
        const merged = mergeRegistry(stored, local, new Set(['A', 'C']));
        expect(merged.books.A?.role).toBe('npc');
        expect(merged.books.B?.role).toBe('card');
        expect(merged.books.C).toBeUndefined();
    });

    it('compares what the API reports', () => {
        expect(sameRecord(record(), record({ at: 9 }))).toBe(true);
        expect(sameRecord(record(), record({ role: 'card' }))).toBe(false);
        expect(sameRecord(record({ pack: { name: 'P' } }), record({ pack: { name: 'P', version: '2' } }))).toBe(false);
        expect(sameRecord(undefined, undefined)).toBe(true);
        expect(sameRecord(record(), undefined)).toBe(false);
    });
});
