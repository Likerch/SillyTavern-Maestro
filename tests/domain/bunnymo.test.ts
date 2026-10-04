import { describe, expect, it } from 'vitest';
import {
    BUNNYMO_SHEET_COMMANDS,
    archiveNameWords,
    archiveTags,
    archiveWorlds,
    classifyWorlds,
    entryKeys,
    isBunnyMoCoreEntry,
    isCharacterArchive,
    packVocabulary,
} from '../../src/domain/bunnymo';
import type { BunnyMoEntryLike } from '../../src/domain/bunnymo';

const sheetEntries = (world: string): BunnyMoEntryLike[] =>
    ['!fullsheet', '!quicksheet', '!tagsheet'].map((key) => ({ world, key: [key], comment: 'sheet' }));

const wrapped = (world: string, count: number): BunnyMoEntryLike[] =>
    Array.from({ length: count }, (_, i) => ({
        world,
        key: [],
        comment: `Lens ${i}`,
        content: `<BunnymoTags:Lens ${i}>\ntext\n</BunnymoTags:Lens ${i}>`,
    }));

describe('entryKeys', () => {
    it('joins primary and secondary keys, trims and drops empty and junk', () => {
        expect(entryKeys({ key: [' a ', '', 'b'], keysecondary: ['c', 5] })).toEqual(['a', 'b', 'c', '5']);
        expect(entryKeys({ key: 'not an array' })).toEqual([]);
        expect(entryKeys(null)).toEqual([]);
        expect(entryKeys(undefined)).toEqual([]);
    });
});

describe('isBunnyMoCoreEntry', () => {
    it('recognises sheet commands in keys, case-insensitively', () => {
        for (const command of BUNNYMO_SHEET_COMMANDS)
            expect(isBunnyMoCoreEntry({ key: [command.toUpperCase()] })).toBe(true);
        expect(isBunnyMoCoreEntry({ key: ['x'], keysecondary: ['!physheet'] })).toBe(true);
    });

    it('recognises core entry titles', () => {
        for (const comment of [
            '◕‿◕ Master - Kaomoji Library',
            '🔮 AUTO-TRIGGER: Jealousy Detection System',
            'AUTO-FILTRATION: LINGUISTICS',
            '🔮 AUTO-TRIGGER: ANTI CLANKER ALPHA',
            'Anti-Clanker Theta',
            'HawThorne Link: Dere',
        ]) {
            expect(isBunnyMoCoreEntry({ comment })).toBe(true);
        }
    });

    it('does not take the entry wrapper or ordinary entries for the core', () => {
        expect(
            isBunnyMoCoreEntry({ comment: 'Tavern', key: ['tavern'], content: '<BunnymoTags:X>y</BunnymoTags:X>' }),
        ).toBe(false);
        expect(isBunnyMoCoreEntry({})).toBe(false);
    });
});

describe('classifyWorlds', () => {
    it('classifies books by content and packs by tag keys', () => {
        const entries: BunnyMoEntryLike[] = [
            ...sheetEntries('Мой BunnyMo'),
            ...['<SPECIES:ELF>', '<SPECIES:ORC>', '<DEPRESSION>'].map((key) => ({
                world: 'Пак',
                key: [key, key.toLowerCase()],
            })),
            { world: 'Лор', key: ['таверна'] },
            { world: 'Лор', key: ['замок'] },
            { world: 'Лор', key: ['<SPECIES:ELF>'] },
        ];
        const { core, packs } = classifyWorlds(entries);
        expect([...core]).toEqual(['Мой BunnyMo']);
        expect([...packs]).toEqual(['Пак']);
    });

    it('counts wrapped entries as a pack, not as the core', () => {
        const { core, packs } = classifyWorlds([
            ...sheetEntries('BunnyMo'),
            ...wrapped('Линзы', 4),
            ...wrapped('Мало', 2),
        ]);
        expect([...core]).toEqual(['BunnyMo']);
        expect([...packs]).toEqual(['Линзы']);
    });

    it('needs 60 % tagged keyed entries for a pack', () => {
        const tagged = ['<A:1>', '<B:2>', '<C:3>'].map((key) => ({ world: 'Mixed', key: [key] }));
        const plain = ['x', 'y', 'z'].map((key) => ({ world: 'Mixed', key: [key] }));
        expect(classifyWorlds([...tagged, ...plain]).packs.size).toBe(0);
        expect(classifyWorlds([...tagged, ...plain.slice(0, 2)]).packs.has('Mixed')).toBe(true);
    });

    it('ignores entries without a world', () => {
        const { core, packs } = classifyWorlds([{ key: ['!fullsheet'] }, { world: '', key: ['!tagsheet'] }]);
        expect(core.size + packs.size).toBe(0);
    });
});

describe('packVocabulary', () => {
    it('collects KEY → values from keys in upper case', () => {
        const vocabulary = packVocabulary([
            { key: ['<SPECIES:ELF>', '<species:orc>'] },
            { key: ['<LING: HORNY >'], keysecondary: ['<DEPRESSION>', 'plain', '/re/i'] },
        ]);
        expect([...(vocabulary.get('SPECIES') ?? [])]).toEqual(['ELF', 'ORC']);
        expect([...(vocabulary.get('LING') ?? [])]).toEqual(['HORNY']);
        expect(vocabulary.has('DEPRESSION')).toBe(false);
    });
});

describe('archiveTags and isCharacterArchive', () => {
    it('reads the name and tags of the BunnymoTags block', () => {
        const entry = { content: '<BunnymoTags><Name:Аня>, <SPECIES:HUMAN>, <DERE:KUUDERE></BunnymoTags>' };
        expect(archiveTags(entry)).toEqual({ name: 'Аня', tags: ['<SPECIES:HUMAN>', '<DERE:KUUDERE>'] });
        expect(isCharacterArchive({ ...entry, key: ['Аня'] })).toBe(true);
    });

    it('keeps the MBTI archetype and upper-cases tag keys', () => {
        const entry = {
            content:
                '<BunnymoTags><Name:Флоренс>, <PERSONALITY><Dere:Deredere>, <esfp-h>, </PERSONALITY> <ESFP-H></BunnymoTags>',
        };
        expect(archiveTags(entry)).toEqual({ name: 'Флоренс', tags: ['<DERE:Deredere>', '<ESFP-H>'] });
    });

    it('drops template placeholders but keeps NONE and OLD', () => {
        const tags = archiveTags({
            content:
                '<BunnymoTags><Name:Аня>, <GENRE:BLANK>, <Dere:NEW>, <ATTACHMENT:TARGET>, <LING:NONE>, <LING:OLD></BunnymoTags>',
        });
        expect(tags.tags).toEqual(['<LING:NONE>', '<LING:OLD>']);
    });

    it('rejects sheet templates, placeholder names and empty blocks', () => {
        const template = (key: string, name: string): BunnyMoEntryLike => ({
            comment: '👤FULL CHARACTER SHEET FORMAT 👤',
            key: [key],
            content: `<BunnymoTags><Name:${name}>, <GENRE:BLANK>, <GENRE:ROMANCE></BunnymoTags>`,
        });
        expect(isCharacterArchive(template('!fullsheet', 'NAME'))).toBe(false);
        expect(isCharacterArchive(template('!updatesheet', 'Real'))).toBe(false);
        expect(
            isCharacterArchive({
                key: ['NAME HERE'],
                content: '<BunnymoTags><Name:NAME>, <GENRE:BLANK></BunnymoTags>',
            }),
        ).toBe(false);
        expect(isCharacterArchive({ key: ['x'], content: '<BunnymoTags><GENDER:VALUE></BunnymoTags>' })).toBe(false);
        expect(isCharacterArchive({ key: ['x'], content: '<BunnymoTags></BunnymoTags>' })).toBe(false);
        expect(isCharacterArchive({ key: ['x'], content: 'no block' })).toBe(false);
        expect(archiveTags({ content: 42 })).toEqual({ name: null, tags: [] });
    });

    it('accepts a block with tags but no name, and a name without tags', () => {
        expect(isCharacterArchive({ content: '<BunnymoTags><SPECIES:ELF></BunnymoTags>' })).toBe(true);
        expect(isCharacterArchive({ content: '<BunnymoTags><Name:Аня></BunnymoTags>' })).toBe(true);
    });
});

describe('archiveNameWords', () => {
    it('collects name words and plain Cyrillic keys, skipping regex keys and placeholders', () => {
        const words = archiveNameWords([
            {
                key: ['Иван Петров', '/петров/i', 'Ivan'],
                content: '<BunnymoTags><Name:Иван_Петров>, <SPECIES:HUMAN></BunnymoTags>',
            },
            { key: ['Мария'], content: '<BunnymoTags><Name:Мария Петрова>, <SPECIES:HUMAN></BunnymoTags>' },
            { key: ['Ёлка'], content: '<BunnymoTags><Name:NAME>, <SPECIES:HUMAN></BunnymoTags>' },
        ]);
        expect([...words].sort()).toEqual(['елка', 'иван', 'мария', 'петров', 'петрова']);
    });
});

describe('archiveWorlds', () => {
    it('lists books that hold at least one archive', () => {
        const worlds = archiveWorlds([
            { world: 'Архив', content: '<BunnymoTags><Name:Аня>, <SPECIES:HUMAN></BunnymoTags>' },
            { world: 'Архив', content: '<BunnymoTags><Name:Боря></BunnymoTags>' },
            {
                world: 'BunnyMo',
                key: ['!fullsheet'],
                content: '<BunnymoTags><Name:Real>, <GENRE:ROMANCE></BunnymoTags>',
            },
            { world: 'Лор', content: 'plain' },
            { content: '<BunnymoTags><Name:Без книги></BunnymoTags>' },
        ]);
        expect([...worlds]).toEqual(['Архив']);
    });
});
