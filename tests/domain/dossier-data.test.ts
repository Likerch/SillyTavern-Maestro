import { describe, expect, it } from 'vitest';
import {
    archiveProse,
    findLastSheet,
    mbtiOf,
    overridePassport,
    passportFields,
    passportTagLine,
    pickMemories,
    ragCollectionsFor,
    readSheetMark,
    summarizeArchive,
    tagGroups,
    truncate,
} from '../../src/domain/dossier-data';
import type { PassportLike, SheetMessageLike } from '../../src/domain/dossier-data';

function passport(overrides: Partial<PassportLike> = {}): PassportLike {
    return {
        id: 'p1',
        kind: 'character',
        name: 'Lyra',
        aliases: ['Лира'],
        tags: '',
        slots: { base: '1girl, elf', hair: 'long silver hair', eyes: 'green eyes', clothing: 'cloak' },
        outfits: [{ name: 'gown', tags: 'ballgown' }],
        activeOutfit: '',
        states: [
            { id: 'wet', tags: 'wet hair', enabled: true },
            { id: 'crying', tags: 'tears', enabled: false },
        ],
        negative: 'short hair',
        ...overrides,
    };
}

describe('truncate', () => {
    it('cuts at a word boundary when one is near', () => {
        expect(truncate('  short  ', 20)).toBe('short');
        expect(truncate('one two three four five', 15)).toBe('one two three…');
        expect(truncate('one two three four five', 12)).toBe('one two thre…');
        expect(truncate('abcdefghijklmnop', 5)).toBe('abcde…');
        expect(truncate('anything', 0)).toBe('anything');
    });
});

describe('passports', () => {
    it('renders tags in NAI order with the active outfit and enabled states', () => {
        expect(passportTagLine(passport())).toBe('1girl, elf, long silver hair, green eyes, cloak, wet hair');
        expect(passportTagLine(passport({ activeOutfit: 'gown' }))).toContain('ballgown');
        expect(passportTagLine(passport({ activeOutfit: 'gown' }))).not.toContain('cloak');
        expect(passportTagLine(passport({ kind: 'location', tags: ' tavern, indoors ' }))).toBe('tavern, indoors');
    });

    it('lists fields without empty values, unknown slots included', () => {
        const fields = passportFields(passport({ slots: { hair: 'red hair', extra: 'tail' } }));
        expect(fields).toMatchObject({
            id: 'p1',
            kind: 'character',
            name: 'Lyra',
            aliases: 'Лира',
            'slot.hair': 'red hair',
            'slot.extra': 'tail',
            outfits: 'gown: ballgown',
            states: 'wet',
            negative: 'short hair',
        });
        expect(fields.tags).toBeUndefined();
        expect(fields.activeOutfit).toBeUndefined();
    });

    it('applies a chat-level override on top of the card passport', () => {
        const base = passport();
        expect(overridePassport(base, null)).toEqual({ passport: base, overridden: [] });
        const { passport: merged, overridden } = overridePassport(base, {
            slots: { hair: 'short black hair', eyes: 'green eyes', junk: 5 },
            activeOutfit: 'gown',
            aliases: ['Ly', 3],
            outfits: [{ name: 'armor', tags: 'plate armor' }, 'x'],
            states: [{ id: 'hurt', tags: 'bandages', enabled: true }],
            negative: 'short hair',
        });
        expect(merged.slots.hair).toBe('short black hair');
        expect(merged.slots.eyes).toBe('green eyes');
        expect(merged.aliases).toEqual(['Ly']);
        expect(merged.outfits).toEqual([{ name: 'armor', tags: 'plate armor' }]);
        expect(merged.states).toEqual([{ id: 'hurt', tags: 'bandages', enabled: true }]);
        expect(overridden).toEqual(['slot.hair', 'activeOutfit', 'aliases', 'outfits', 'states']);
        expect(base.slots.hair).toBe('long silver hair');
    });
});

describe('archives', () => {
    it('reads MBTI in both spellings', () => {
        expect(mbtiOf(['<SPECIES:ELF>', '<ESFP-H>'])).toEqual({ type: 'ESFP', variant: 'H' });
        expect(mbtiOf(['<MBTI:intj-u>'])).toEqual({ type: 'INTJ', variant: 'U' });
        expect(mbtiOf(['<MBTI:ENFP>'])).toEqual({ type: 'ENFP', variant: null });
        expect(mbtiOf(['<GENRE:FANTASY>'])).toBeNull();
    });

    it('groups tags by category', () => {
        expect(
            tagGroups(['<SPECIES:ELF>', '<SPECIES:HUMAN>', '<SPECIES:ELF>', '<ESFP-H>', '<SHY>', '<EMPTY:>', 'junk']),
        ).toEqual({ SPECIES: 'ELF, HUMAN', MBTI: 'ESFP-H', OTHER: 'SHY' });
    });

    it('keeps the prose outside tag blocks and summarises the archive', () => {
        const content =
            '<BunnymoTags><Name:Lyra_Silver>, <SPECIES:ELF>, <INFP-U></BunnymoTags>\n\n\n<Linguistics>Soft</Linguistics>';
        expect(archiveProse(content)).toBe('<Linguistics>Soft</Linguistics>');
        expect(archiveProse(undefined)).toBe('');
        const summary = summarizeArchive({ content });
        expect(summary.name).toBe('Lyra_Silver');
        expect(summary.tags).toEqual(['<SPECIES:ELF>', '<INFP-U>']);
        expect(summary.mbti).toEqual({ type: 'INFP', variant: 'U' });
        expect(summary.groups).toEqual({ SPECIES: 'ELF', MBTI: 'INFP-U' });
    });
});

describe('memories', () => {
    it('keeps every long-term memory and the last N others', () => {
        const list = [
            { index: 5, text: 'e', longTerm: false },
            { index: 1, text: 'a', longTerm: true },
            { index: 3, text: 'c', longTerm: false },
            { index: 4, text: ' ', longTerm: true },
            { index: 2, text: 'b', longTerm: false },
        ];
        expect(pickMemories(list, 2).map((item) => item.index)).toEqual([1, 3, 5]);
        expect(pickMemories(list, 0).map((item) => item.index)).toEqual([1]);
    });
});

describe('sheets', () => {
    it('reads the M31 mark', () => {
        expect(readSheetMark({ maestro: { sheet: { command: 'fullsheet', target: 'Lyra', part: 'reply' } } })).toEqual({
            command: 'fullsheet',
            target: 'Lyra',
            part: 'reply',
        });
        expect(readSheetMark({ maestro: { sheet: { command: 'tagsheet' } } })).toEqual({
            command: 'tagsheet',
            target: '',
            part: 'reply',
        });
        expect(readSheetMark({ maestro: {} })).toBeNull();
        expect(readSheetMark(null)).toBeNull();
    });

    const tagged = (name: string) => `## SECTION 1/2\ntext\n<BunnymoTags><Name:${name}>, <SPECIES:ELF></BunnymoTags>`;
    const messages: SheetMessageLike[] = [
        { index: 1, text: tagged('Lyra'), isUser: false, mark: null },
        { index: 2, text: 'tagsheet', isUser: false, mark: { command: 'tagsheet', target: 'Lyra', part: 'reply' } },
        {
            index: 3,
            text: '!fullsheet Lyra',
            isUser: true,
            mark: { command: 'fullsheet', target: 'Lyra', part: 'command' },
        },
        {
            index: 4,
            text: '```json\n{"infoBox": {}}\n```\nfull sheet',
            isUser: false,
            mark: { command: 'fullsheet', target: 'Lyra', part: 'reply' },
        },
        { index: 6, text: tagged('Mara'), isUser: false, mark: null },
    ];

    it('prefers the newest marked fullsheet, then any marked sheet, then a tag block', () => {
        expect(findLastSheet(messages, ['Лира', 'Lyra'])).toMatchObject({ index: 4, command: 'fullsheet' });
        expect(findLastSheet(messages, ['Lyra'])?.text).not.toContain('infoBox');
        expect(
            findLastSheet(
                messages.filter((item) => item.index !== 4),
                ['Lyra'],
            ),
        ).toMatchObject({
            index: 2,
            command: 'tagsheet',
        });
        expect(
            findLastSheet(
                messages.filter((item) => item.mark === null),
                ['Mara'],
            ),
        ).toMatchObject({
            index: 6,
            command: null,
        });
        expect(findLastSheet(messages, ['Nobody'])).toBeNull();
    });
});

describe('RAG', () => {
    it('lists the collections of a character with their triggers', () => {
        const rag = {
            collectionMetadata: {
                carrotkernel_char_lyra: { characterName: 'Lyra', keywords: ['lyra', '', 3], alwaysActive: false },
                carrotkernel_char_lyra_chat_1: { characterName: 'LYRA', alwaysActive: true },
                carrotkernel_char_mara: { characterName: 'Mara', keywords: ['mara'] },
                broken: 'x',
            },
        };
        expect(ragCollectionsFor(rag, ['Lyra'])).toEqual([
            { id: 'carrotkernel_char_lyra', keywords: ['lyra'], alwaysActive: false },
            { id: 'carrotkernel_char_lyra_chat_1', keywords: [], alwaysActive: true },
        ]);
        expect(ragCollectionsFor({}, ['Lyra'])).toEqual([]);
        expect(ragCollectionsFor(null, ['Lyra'])).toEqual([]);
    });
});
