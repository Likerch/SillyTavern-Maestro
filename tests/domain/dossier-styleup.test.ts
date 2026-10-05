import { describe, expect, it } from 'vitest';
import {
    ARCHIVE_BOOK_NAME,
    STYLE_UP_PARTS,
    archiveBookChoice,
    archiveKnownText,
    characterFields,
    freeId,
    passportDescription,
    placeFields,
    promotedFields,
    styleUpGaps,
    styleUpKeys,
    typedContent,
} from '../../src/domain/dossier-styleup';
import type { CharacterKnowledge } from '../../src/domain/dossier-styleup';

function knowledge(fields: Partial<CharacterKnowledge> = {}): CharacterKnowledge {
    return {
        name: 'Мира',
        aliases: ['Мира', 'Mira', 'Лисица'],
        details: {
            appearance: 'серебряные волосы',
            outfit: 'плащ',
            demeanor: 'спокойная',
            thoughts: 'где же он?',
            goal: 'найти брата',
            occupation: 'травница',
            age: '24',
            voice: 'хриплый голос',
            homeland: 'северный лес',
            empty: '  ',
        },
        portraitPrompt: 'silver hair, green eyes',
        workshopDescription: 'Мира — травница из леса.',
        cardDescription: undefined,
        relationship: { with: 'Алекс', value: 'Дружба' },
        quotes: ['q1', 'q2', 'q3', 'q4', 'q1'],
        facts: ['Мира ищет брата.'],
        ...fields,
    };
}

describe('missing stores', () => {
    it('lists what a character lacks while its owner is on', () => {
        expect(STYLE_UP_PARTS).toEqual(['canon', 'archive', 'passport', 'placeEntry', 'lorePassport']);
        expect(styleUpGaps({ kind: 'character', canonOn: true, archiveOn: true, naiOn: true })).toEqual({
            kind: 'character',
            missing: ['canon', 'archive', 'passport'],
        });
        expect(
            styleUpGaps({
                kind: 'character',
                canonOn: true,
                archiveOn: false,
                naiOn: true,
                hasEntry: true,
                hasPassport: false,
            }),
        ).toEqual({ kind: 'character', missing: ['passport'] });
        expect(
            styleUpGaps({
                kind: 'character',
                canonOn: false,
                archiveOn: true,
                naiOn: false,
                hasArchive: true,
            }),
        ).toBeNull();
    });

    it('lists what a place lacks and ignores other kinds', () => {
        const base = { canonOn: true, archiveOn: true, naiOn: true, placesOn: true, lorePassportsOn: true };
        expect(styleUpGaps({ ...base, kind: 'place' })).toEqual({
            kind: 'place',
            missing: ['placeEntry', 'lorePassport'],
        });
        expect(styleUpGaps({ ...base, kind: 'place', hasPlaceEntry: true })).toEqual({
            kind: 'place',
            missing: ['lorePassport'],
        });
        expect(styleUpGaps({ ...base, kind: 'place', canonOn: false, lorePassportsOn: false })).toBeNull();
        expect(styleUpGaps({ ...base, kind: 'place', hasPlaceEntry: true, hasPlacePassport: true })).toBeNull();
        expect(styleUpGaps({ ...base, kind: 'persona' })).toBeNull();
    });
});

describe('the canon entry', () => {
    it('fills the character fields from the tracker, the Workshop, quotes and facts', () => {
        const fields = characterFields(knowledge());
        expect(fields).toEqual({
            name: 'Мира',
            aliases: 'Mira, Лисица',
            appearance: 'серебряные волосы\nплащ\nsilver hair, green eyes',
            personality: 'спокойная',
            goals: 'найти брата',
            role: 'травница',
            age: '24',
            speech: 'хриплый голос',
            relationships: 'Алекс: Дружба',
            background: 'Мира — травница из леса.\nhomeland: северный лес\nМира ищет брата.\nq1\nq2\nq3',
        });
        const content = typedContent('character', fields);
        expect(content.split('\n')[0]).toBe('Character: Мира');
        expect(content).toContain('Aliases: Mira, Лисица');
        expect(content).toContain('Background:\nМира — травница из леса.');
    });

    it('drops empty fields and repeats', () => {
        const fields = characterFields(
            knowledge({
                aliases: [],
                details: { appearance: 'red hair', look: 'red hair' },
                portraitPrompt: 'red hair',
                workshopDescription: undefined,
                relationship: null,
                quotes: [],
                facts: [],
            }),
        );
        expect(fields).toEqual({ name: 'Мира', appearance: 'red hair' });
    });

    it('leaves the relationship to the relations module and skips facts that repeat a field', () => {
        const base = {
            aliases: [],
            details: { appearance: 'чёрная коса', relationship: 'Friend' },
            portraitPrompt: undefined,
            workshopDescription: undefined,
            quotes: [],
            facts: ['appearance: Чёрная коса', 'Вера служит в гильдии.'],
        };
        expect(characterFields(knowledge(base))).toEqual({
            name: 'Мира',
            appearance: 'чёрная коса',
            relationships: 'Алекс: Дружба',
            background: 'Вера служит в гильдии.',
        });
        expect(characterFields(knowledge({ ...base, relationship: null })).relationships).toBe('relationship: Friend');
    });

    it('fills the place fields from the registry', () => {
        const fields = placeFields({
            name: 'Таверна',
            aliases: ['Таверна', 'Кабак'],
            path: ['Порт-Ройал', ' ', 'Нижний город'],
            background: 'Old tavern by the docks.',
            state: { light: 'night', damage: '' },
            people: ['Мира', 'Алекс', 'Мира'],
            quotes: ['пахнет ромом'],
            facts: ['Owned by Jack.'],
        });
        expect(fields).toEqual({
            name: 'Таверна',
            aliases: 'Кабак',
            location: 'Порт-Ройал › Нижний город',
            description: 'Old tavern by the docks.',
            atmosphere: 'light: night',
            inhabitants: 'Мира, Алекс',
            features: 'Owned by Jack.\nпахнет ромом',
        });
        expect(typedContent('place', fields).split('\n')[0]).toBe('Place: Таверна');
        expect(
            placeFields({ name: 'Лес', aliases: [], path: [], state: {}, people: [], quotes: [], facts: [] }),
        ).toEqual({ name: 'Лес' });
    });

    it('keys the entry by the name, aliases and Russian forms once each', () => {
        expect(styleUpKeys('Мира', ['Mira', 'Мира'], ['Мира', 'Миры', '/мир/iu'])).toEqual([
            'Мира',
            'Mira',
            'Миры',
            '/мир/iu',
        ]);
    });
});

describe('texts for the models', () => {
    it('collects what the archive model should know and cuts it', () => {
        const text = archiveKnownText(knowledge({ cardDescription: 'Card text.' }), {
            lore: ['Lore line.', ''],
            memories: ['Мира спасла Алекса.'],
            passportTags: 'silver hair',
        });
        expect(text).toContain('Scene tracker appearance: серебряные волосы');
        expect(text).toContain('Portrait prompt: silver hair, green eyes');
        expect(text).toContain('Description: Мира — травница из леса.');
        expect(text).toContain('Card description: Card text.');
        expect(text).toContain('Relationship with Алекс: Дружба');
        expect(text).toContain('Image tags: silver hair');
        expect(text).toContain('Lore: Lore line.');
        expect(text).toContain('Fact: Мира ищет брата.');
        expect(text).toContain('Story quote: q4');
        expect(text).toContain('Memory: Мира спасла Алекса.');
        const short = archiveKnownText(knowledge({ relationship: null }), {}, 40);
        expect(short).toHaveLength(40);
        expect(short.endsWith('…')).toBe(true);
    });

    it('gives NAI Studio an appearance-first description', () => {
        const text = passportDescription(knowledge());
        expect(text.split('\n')[0]).toBe('Appearance: серебряные волосы\nплащ\nsilver hair, green eyes'.split('\n')[0]);
        expect(text).toContain('Age: 24');
        expect(text).toContain('Role: травница');
        expect(text).toContain('Personality: спокойная');
        expect(text).toContain('Background:');
        expect(passportDescription(knowledge(), 20)).toHaveLength(20);
        expect(
            passportDescription(
                knowledge({
                    details: {},
                    portraitPrompt: undefined,
                    workshopDescription: undefined,
                    quotes: [],
                    facts: [],
                }),
            ),
        ).toBe('');
    });
});

describe('the archive book', () => {
    it('prefers CK repositories, then books with the role, never BunnyMo or missing books', () => {
        const choice = archiveBookChoice([
            { book: 'Other', repo: false, role: false, protected: false, exists: true },
            { book: 'Roles', repo: false, role: true, protected: false, exists: true },
            { book: 'Pack', repo: true, role: false, protected: true, exists: true },
            { book: 'Repo B', repo: true, role: false, protected: false, exists: true },
            { book: 'Repo A', repo: true, role: true, protected: false, exists: true },
            { book: 'Gone', repo: true, role: false, protected: false, exists: false },
            { book: ' ', repo: true, role: false, protected: false, exists: true },
        ]);
        expect(choice).toEqual({ books: ['Repo A', 'Repo B', 'Roles', 'Other'], create: null });
    });

    it('offers to create «Maestro · архив» when nothing can take the archive', () => {
        expect(archiveBookChoice([{ book: 'Pack', repo: true, role: false, protected: true, exists: true }])).toEqual({
            books: [],
            create: ARCHIVE_BOOK_NAME,
        });
        expect(archiveBookChoice([], 'Mine')).toEqual({ books: [], create: 'Mine' });
    });
});

describe('ids and promotion', () => {
    it('finds a free id', () => {
        const taken = new Set(['p', 'p-2']);
        expect(freeId('q', (id) => taken.has(id))).toBe('q');
        expect(freeId('p', (id) => taken.has(id))).toBe('p-3');
    });

    it('copies the WI fields of a canon entry, without the canon marker', () => {
        const entry = {
            uid: 4,
            world: 'Canon',
            key: ['Мира'],
            keysecondary: [],
            comment: 'Мира',
            content: 'Character: Мира',
            order: 100,
            position: 0,
            disable: true,
            sticky: undefined,
            extensions: { maestro: { kind: 'addition' } },
        };
        const fields = promotedFields(entry);
        expect(fields).toEqual({
            key: ['Мира'],
            keysecondary: [],
            comment: 'Мира',
            content: 'Character: Мира',
            order: 100,
            position: 0,
            disable: false,
        });
        (fields.key as string[]).push('x');
        expect(entry.key).toEqual(['Мира']);
    });
});
