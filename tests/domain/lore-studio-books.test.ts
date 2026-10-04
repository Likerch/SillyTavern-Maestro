import { describe, expect, it } from 'vitest';
import {
    SECTION_ORDER,
    avatarKey,
    bookLinks,
    fallbackRole,
    findSameName,
    foldName,
    freeBookName,
    groupBooks,
    isReadOnlyRole,
    linkCount,
    removeFromCharLore,
    renameInCharLore,
    sameName,
    sanitizeBookName,
    sectionOf,
    sectionOfRole,
} from '../../src/domain/lore-studio-books';
import type { LinkState, StudioRole } from '../../src/domain/lore-studio-books';

describe('sections', () => {
    it('maps every role to a section', () => {
        const roles: StudioRole[] = [
            'bunnymo.core',
            'bunnymo.pack',
            'ck.archive',
            'world',
            'card',
            'npc',
            'canon',
            'maestro',
            'chat',
            'persona',
            'backup',
            'unknown',
        ];
        expect(roles.map(sectionOfRole)).toEqual([
            'system',
            'system',
            'characters',
            'world',
            'card',
            'characters',
            'maestro',
            'maestro',
            'world',
            'world',
            'backup',
            'world',
        ]);
    });

    it('puts this chat’s bindings first, then the character’s books', () => {
        const context = { chatBook: 'Chat', personaBook: 'Me', canonBook: 'Canon', characterBooks: ['Card', 'Pack'] };
        expect(sectionOf('Chat', 'world', context)).toBe('chat');
        expect(sectionOf('Me', 'persona', context)).toBe('chat');
        expect(sectionOf('Canon', 'canon', context)).toBe('chat');
        expect(sectionOf('Card', 'world', context)).toBe('card');
        expect(sectionOf('Pack', 'bunnymo.pack', context)).toBe('system');
        expect(sectionOf('Old', 'backup', { chatBook: 'Old' })).toBe('backup');
        expect(sectionOf('Other', 'ck.archive', {})).toBe('characters');
    });

    it('groups books in section order and drops empty sections', () => {
        const roles: Record<string, StudioRole> = { A: 'backup', B: 'world', C: 'bunnymo.core', D: 'world' };
        const sections = groupBooks(['A', 'B', 'C', 'D', 'E'], (book) => roles[book] ?? 'unknown', { chatBook: 'E' });
        expect(sections).toEqual([
            { id: 'chat', books: ['E'] },
            { id: 'world', books: ['B', 'D'] },
            { id: 'system', books: ['C'] },
            { id: 'backup', books: ['A'] },
        ]);
        expect(SECTION_ORDER[0]).toBe('chat');
    });

    it('guesses roles without M35', () => {
        const hints = {
            bunnyCore: ['Core'],
            bunnyPacks: ['MBTI'],
            ckArchives: ['Repo'],
            canonBooks: ['Canon'],
            cardBooks: ['Card'],
            rosterNames: ['Anna'],
        };
        expect(fallbackRole('Core', hints)).toBe('bunnymo.core');
        expect(fallbackRole('MBTI', hints)).toBe('bunnymo.pack');
        expect(fallbackRole('World (backup 2024-01-01)', hints)).toBe('backup');
        expect(fallbackRole('x.carrot_backup', hints)).toBe('backup');
        expect(fallbackRole('Canon', hints)).toBe('canon');
        expect(fallbackRole('Maestro · канон · 1234')).toBe('canon');
        expect(fallbackRole('Repo', hints)).toBe('ck.archive');
        expect(fallbackRole('Card', hints)).toBe('card');
        expect(fallbackRole('Anna', hints)).toBe('npc');
        expect(fallbackRole('Plain')).toBe('world');
        expect(isReadOnlyRole('bunnymo.pack')).toBe(true);
        expect(isReadOnlyRole('ck.archive')).toBe(false);
    });
});

describe('names', () => {
    it('compares ignoring case and accents', () => {
        expect(foldName('Éclair')).toBe('eclair');
        expect(sameName('Café', 'cafe')).toBe(true);
        expect(sameName('Мир', 'мир')).toBe(true);
        expect(findSameName('ROME', ['Paris', 'rome'])).toBe('rome');
        expect(findSameName('Lyon', ['Paris'])).toBeUndefined();
    });

    it('sanitizes like the server', () => {
        expect(sanitizeBookName('a/b?c<d>e\\f:g*h|i"j')).toBe('abcdefghij');
        expect(sanitizeBookName('name\u0001\u0085')).toBe('name');
        expect(sanitizeBookName('..')).toBe('');
        expect(sanitizeBookName('CON')).toBe('');
        expect(sanitizeBookName('com1.txt')).toBe('');
        expect(sanitizeBookName('World. ')).toBe('World');
        expect(sanitizeBookName('Мир Анны')).toBe('Мир Анны');
        const long = 'я'.repeat(200);
        expect(new TextEncoder().encode(sanitizeBookName(long)).length).toBeLessThanOrEqual(255);
    });

    it('finds a free numbered name', () => {
        expect(freeBookName('World', ['World (1)'])).toBe('World (2)');
        expect(freeBookName('World (4)', [])).toBe('World (1)');
        expect(freeBookName('World (4)', [], false)).toBe('World (4) (1)');
    });
});

describe('links', () => {
    const state: LinkState = {
        global: ['Lore'],
        charLore: [
            { name: 'anna', extraBooks: ['Lore', 'Other'] },
            { name: 'ghost', extraBooks: ['Lore'] },
        ],
        characters: [
            { name: 'Anna', avatar: 'anna', world: 'Lore' },
            { name: 'Bob', avatar: 'bob', world: null },
        ],
        personaBook: 'Lore',
        personas: {
            'me.png': { name: 'Me', lorebook: 'Lore' },
            'x.png': { lorebook: 'Lore' },
            'y.png': { lorebook: null },
        },
        chatBook: 'Lore',
        campaigns: [{ id: 'c1', name: 'Saga', books: ['Lore'] }],
        workshop: { Florence: 'Lore', Bob: 'Other' },
    };

    it('lists every link of a book', () => {
        const links = bookLinks(state, 'Lore');
        expect(links).toEqual({
            global: true,
            primaryOf: ['Anna'],
            extraOf: ['Anna', 'ghost'],
            personas: ['Me', 'x.png'],
            currentPersona: true,
            chat: true,
            campaigns: ['Saga'],
            workshop: ['Florence'],
        });
        expect(linkCount(links)).toBe(9);
        const none = bookLinks({ global: [], charLore: [], characters: [], personas: {} }, 'Nothing');
        expect(linkCount(none)).toBe(0);
        expect(linkCount({ ...none, currentPersona: true })).toBe(1);
    });

    it('renames and removes books in charLore', () => {
        const renamed = renameInCharLore(state.charLore, 'Lore', 'Saga');
        expect(renamed.changed).toBe(2);
        expect(renamed.charLore[0]?.extraBooks).toEqual(['Other', 'Saga']);
        expect(state.charLore[0]?.extraBooks).toEqual(['Lore', 'Other']);
        expect(
            renameInCharLore([{ name: 'a', extraBooks: ['Lore', 'Saga'] }], 'Lore', 'Saga').charLore[0]?.extraBooks,
        ).toEqual(['Saga']);
        expect(removeFromCharLore(state.charLore, 'Lore')).toEqual([{ name: 'anna', extraBooks: ['Other'] }]);
        expect(avatarKey('anna.png')).toBe('anna');
        expect(avatarKey('anna')).toBe('anna');
    });
});
