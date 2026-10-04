import { describe, expect, it } from 'vitest';
import {
    archiveNameOf,
    buildTagDictionary,
    checkTags,
    closest,
    editDistance,
    entriesWithUid,
    entryKind,
    entryTags,
    formatTag,
    isPlaceholderName,
    isPlaceholderValue,
    parseTagKey,
    tagVocabulary,
    templateCategories,
} from '../../src/domain/bunnymo-mode-tags';
import type { Dictionary, DictionaryInput, UidEntry } from '../../src/domain/bunnymo-mode-tags';
import {
    ARCHIVES,
    BSM,
    CORE,
    COT,
    DERE,
    MBTI_V1,
    MBTI_V2,
    SPECIES,
    SPECIES_A,
    archiveEntries,
    bsmEntries,
    coreEntries,
    cotEntries,
    dereEntries,
    mbtiV1,
    mbtiV2,
    speciesEntries,
    speciesSplitEntries,
} from '../features/bunnymoMode/fixtures';
import type { Dict } from '../features/bunnymoMode/fixtures';

const uidEntries = (entries: Dict[]): UidEntry[] => entries.map((entry) => ({ uid: Number(entry.uid), entry }));

function input(): DictionaryInput {
    return {
        books: [
            { name: CORE, core: true, entries: uidEntries(coreEntries()) },
            { name: MBTI_V2, core: false, entries: uidEntries(mbtiV2()) },
            { name: MBTI_V1, core: false, entries: uidEntries(mbtiV1()) },
            { name: DERE, core: false, entries: uidEntries(dereEntries()) },
            { name: SPECIES, core: false, entries: uidEntries(speciesEntries()) },
            { name: SPECIES_A, core: false, entries: uidEntries(speciesSplitEntries()) },
            { name: BSM, core: false, entries: uidEntries(bsmEntries()) },
            { name: COT, core: false, entries: uidEntries(cotEntries()) },
        ],
        archives: [{ name: ARCHIVES, entries: uidEntries(archiveEntries()) }],
        builtAt: 42,
        infoCategories: templateCategories(uidEntries(coreEntries())),
    };
}

function tagOf(dictionary: Dictionary, tag: string) {
    const found = dictionary.tags.find((item) => item.tag === tag);
    if (!found) throw new Error(`no tag ${tag}`);
    return found;
}

describe('parseTagKey', () => {
    it('reads category tags, bare MBTI archetypes and flags', () => {
        expect(parseTagKey('<SPECIES:ELF>')).toEqual({ tag: '<SPECIES:ELF>', category: 'SPECIES', value: 'ELF' });
        expect(parseTagKey(' <ling: horny> ')).toEqual({ tag: '<LING:HORNY>', category: 'LING', value: 'HORNY' });
        expect(parseTagKey('<enfj-u>')).toEqual({ tag: '<ENFJ-U>', category: 'MBTI', value: 'ENFJ-U' });
        expect(parseTagKey('<DEPRESSION>')).toEqual({ tag: '<DEPRESSION>', category: 'DEPRESSION', value: null });
    });

    it('rejects keys that are not tags', () => {
        expect(parseTagKey('dere explanation')).toBeNull();
        expect(parseTagKey('<ATTACHMENT:')).toBeNull();
        expect(parseTagKey('/^/')).toBeNull();
        expect(parseTagKey('<X: >')).toBeNull();
    });
});

describe('entries and kinds', () => {
    it('lists entries with their uid (from the field or the map key) and skips junk', () => {
        const entries = entriesWithUid({
            entries: { 3: { content: 'a' }, 4: { uid: 9 }, 5: 'junk', x: { content: 'b' } },
        });
        expect(entries.map((item) => item.uid)).toEqual([3, 9]);
        expect(entriesWithUid(null)).toEqual([]);
    });

    it('takes every tag key once, from primary and secondary keys', () => {
        const tags = entryTags({ key: ['<ELF>', '<ELF>', 'plain', 7], keysecondary: ['<SPECIES:ELF>'] });
        expect(tags.map((tag) => tag.tag)).toEqual(['<ELF>', '<SPECIES:ELF>']);
    });

    it('tells pulling entries from informational ones', () => {
        const [guide, header, kuudere] = dereEntries();
        expect(entryKind(guide!, false)).toBe('info');
        expect(entryKind(header!, false)).toBe('info');
        expect(entryKind(kuudere!, false)).toBe('pull');
        expect(entryKind(kuudere!, true)).toBe('info');
        expect(entryKind({ ...kuudere!, constant: true }, false)).toBe('info');
    });

    it('reads template categories from the core and archive names', () => {
        const categories = templateCategories(uidEntries(coreEntries()));
        expect(categories.has('ATTACHMENT')).toBe(true);
        expect(categories.has('DECISION')).toBe(true);
        expect(categories.has('BUNNYMOTAGS')).toBe(false);
        const [atsu, mira, tavern] = archiveEntries();
        expect(archiveNameOf(atsu!)).toBe('Atsu_Ibn_Oba_Al-Masri');
        expect(archiveNameOf(mira!)).toBe('Мира');
        expect(archiveNameOf(tavern!)).toBe('The Tavern');
        expect(archiveNameOf({ key: [' Key '] })).toBe('Key');
        expect(archiveNameOf({})).toBe('');
    });
});

describe('buildTagDictionary', () => {
    const dictionary = buildTagDictionary(input());

    it('collects every tag with the entries it pulls', () => {
        expect(dictionary.builtAt).toBe(42);
        const kuudere = tagOf(dictionary, '<DERE:KUUDERE>');
        expect(kuudere.category).toBe('DERE');
        expect(kuudere.value).toBe('KUUDERE');
        expect(kuudere.entries).toEqual([
            {
                book: DERE,
                uid: 14,
                kind: 'pull',
                comment: '❄️😐 Kuudere — The Ice Mage',
                chars: dereEntries()[2]!.content!.toString().length,
            },
        ]);
        expect(tagOf(dictionary, '<SECTION_HEADER>').entries[0]?.kind).toBe('info');
        expect(tagOf(dictionary, '<DERE_SYSTEM>').entries[0]).toMatchObject({ book: CORE, kind: 'info' });
        // Disabled entries pull nothing.
        expect(
            dictionary.tags.some((tag) => tag.entries.some((entry) => entry.uid === 44 && entry.book === CORE)),
        ).toBe(false);
    });

    it('flags MBTI v1/V2 version conflicts and identical copies', () => {
        const cynic = tagOf(dictionary, '<INTJ-U>');
        expect(cynic.category).toBe('MBTI');
        expect(cynic.entries.map((entry) => entry.book).sort()).toEqual([MBTI_V1, MBTI_V2].sort());
        expect(cynic.conflict).toBe(true);
        expect(cynic.duplicate).toBe(false);
        const logistician = tagOf(dictionary, '<ISTJ-H>');
        expect(logistician.conflict).toBe(false);
        expect(logistician.duplicate).toBe(true);
        const elf = tagOf(dictionary, '<SPECIES:ELF>');
        expect(elf.duplicate).toBe(true);
        expect(elf.conflict).toBe(false);
    });

    it('leaves the BSM-5 + CoT Lenses pairing out of conflicts', () => {
        const depression = tagOf(dictionary, '<DEPRESSION>');
        expect(depression.entries).toHaveLength(2);
        expect(depression.conflict).toBe(false);
        expect(depression.duplicate).toBe(false);
    });

    it('records the archives using a tag, orphans and informational tags', () => {
        const elf = tagOf(dictionary, '<SPECIES:ELF>');
        expect(elf.usedBy).toEqual([{ book: ARCHIVES, uid: 1, name: 'Мира' }]);
        expect(tagOf(dictionary, '<DERE:KUUDERE>').usedBy.map((use) => use.name)).toEqual(['Мира']);
        expect(tagOf(dictionary, '<INTJ-U>').usedBy.map((use) => use.name)).toEqual(['Мира']);
        // Trigger-bearing categories without a loaded pack.
        const stoic = tagOf(dictionary, '<TRAIT:STOIC>');
        expect(stoic.entries).toEqual([]);
        expect(stoic.orphan).toBe(true);
        expect(tagOf(dictionary, '<GENRE:FANTASY>').orphan).toBe(true);
        expect(tagOf(dictionary, '<DERE:SADODERE>').orphan).toBe(true);
        expect(tagOf(dictionary, '<ENTJ-U>').orphan).toBe(false);
        // Informational categories need no pack.
        expect(tagOf(dictionary, '<ATTACHMENT:SECURE>').orphan).toBe(false);
        // Core templates are not archives.
        expect(dictionary.tags.some((tag) => tag.tag === '<DECISION:BLANK>')).toBe(false);
    });

    it('summarises categories', () => {
        const byId = new Map(dictionary.categories.map((category) => [category.id, category]));
        expect(byId.get('MBTI')).toMatchObject({ info: false, flag: false });
        expect(byId.get('ATTACHMENT')).toMatchObject({ info: true, flag: false });
        expect(byId.get('DEPRESSION')).toMatchObject({ info: false, flag: true, tags: 1 });
        expect(byId.get('SECTION_HEADER')).toMatchObject({ info: true, flag: true });
        const total = dictionary.categories.reduce((sum, category) => sum + category.tags, 0);
        expect(total).toBe(dictionary.tags.length);
    });

    it('sorts by category and tag, and ignores disabled archives', () => {
        const sorted = [...dictionary.tags].sort((a, b) =>
            a.category === b.category ? (a.tag < b.tag ? -1 : 1) : a.category < b.category ? -1 : 1,
        );
        expect(dictionary.tags.map((tag) => tag.tag)).toEqual(sorted.map((tag) => tag.tag));
        const off = buildTagDictionary({
            books: [],
            archives: [
                { name: 'A', entries: uidEntries(archiveEntries().map((entry) => ({ ...entry, disable: true }))) },
            ],
            builtAt: 0,
        });
        expect(off.tags).toEqual([]);
    });
});

describe('tag checks', () => {
    const dictionary = buildTagDictionary(input());
    const vocabulary = tagVocabulary(dictionary, templateCategories(uidEntries(coreEntries())));
    const check = (tags: string[]) => checkTags(tags, vocabulary);

    it('accepts loaded pack values, flags, informational tags and names', () => {
        const results = check([
            '<SPECIES:ELF>',
            '<Dere:Kuudere>',
            'INTJ-U',
            '<ELF>',
            '<ATTACHMENT:SECURE>',
            '<Name:Мира>',
            'SPECIES:HUMAN',
        ]);
        expect(results.every((result) => result.ok)).toBe(true);
        expect(results[1]?.tag).toBe('<DERE:KUUDERE>');
        expect(results[2]?.tag).toBe('<INTJ-U>');
        expect(results[6]?.tag).toBe('<SPECIES:HUMAN>');
    });

    it('rejects malformed tags with a repair suggestion', () => {
        expect(check(['<SKINCOLOR,FAIR>'])[0]).toEqual({
            tag: '<SKINCOLOR,FAIR>',
            ok: false,
            reason: 'malformed',
            suggestions: ['<SKINCOLOR:FAIR>'],
        });
        expect(check(['<TRAIT:STOIC (mostly)>'])[0]).toMatchObject({
            reason: 'malformed',
            suggestions: ['<TRAIT:STOIC>'],
        });
        expect(check(['<TRAIT:>'])[0]?.reason).toBe('malformed');
        expect(check(['<1BAD:X>'])[0]).toEqual({ tag: '<1BAD:X>', ok: false, reason: 'malformed' });
        expect(check(['< SPECIES:ELF>'])[0]?.reason).toBe('malformed');
        expect(check(['<(x):()>'])[0]).toEqual({ tag: '<(x):()>', ok: false, reason: 'malformed' });
        expect(check(['<ENTJ>'])[0]).toMatchObject({ reason: 'malformed', suggestions: ['<ENTJ-H>', '<ENTJ-U>'] });
    });

    it('rejects Russian, placeholders and transition markup', () => {
        expect(check(['<ВИД:ЭЛЬФ>'])[0]?.reason).toBe('cyrillic');
        expect(check(['<SPECIES:ЭЛЬФ>'])[0]?.reason).toBe('cyrillic');
        expect(check(['<GENRE:BLANK>'])[0]?.reason).toBe('placeholder');
        expect(check(['<XXXX-U/H>'])[0]?.reason).toBe('placeholder');
        expect(check(['<XXXX-U>'])[0]?.reason).toBe('placeholder');
        expect(check(['<Name:NAME>'])[0]).toEqual({ tag: '<Name:NAME>', ok: false, reason: 'placeholder' });
        expect(check(['<TRAIT:STOIC → WARM>'])[0]?.reason).toBe('transitional');
        expect(check(['<TRAIT:STOIC at 40%>'])[0]?.reason).toBe('transitional');
        expect(check(['<TRAIT:STOIC_FADING>'])[0]?.ok).toBe(false);
    });

    it('reports repeats and a second MBTI archetype', () => {
        const results = check(['<SPECIES:ELF>', '<species:elf>', '<INTJ-U>', '<ENTJ-U>']);
        expect(results.map((result) => result.reason)).toEqual([undefined, 'duplicate', undefined, 'duplicate']);
    });

    it('suggests values and categories by edit distance', () => {
        expect(check(['<DERE:KUDERE>'])[0]).toEqual({
            tag: '<DERE:KUDERE>',
            ok: false,
            reason: 'unknownValue',
            suggestions: ['<DERE:KUUDERE>'],
        });
        expect(check(['<SPECEIS:ELF>'])[0]).toMatchObject({
            reason: 'unknownCategory',
            suggestions: ['<SPECIES:ELF>'],
        });
        expect(check(['<WIBBLE:ZZZ>'])[0]).toEqual({ tag: '<WIBBLE:ZZZ>', ok: false, reason: 'unknownCategory' });
        // The value exists under another category.
        expect(check(['<SPECIES:TSUNDERE>'])[0]?.suggestions).toContain('<DERE:TSUNDERE>');
        expect(check(['<DEPRESION>'])[0]).toMatchObject({ reason: 'unknownValue', suggestions: ['<DEPRESSION>'] });
        expect(check(['<QQQQQQQQQQ>'])[0]).toEqual({ tag: '<QQQQQQQQQQ>', ok: false, reason: 'unknownValue' });
        expect(check(['<HUMAN:QQQQQQQQQQ>'])[0]).toEqual({
            tag: '<HUMAN:QQQQQQQQQQ>',
            ok: false,
            reason: 'unknownCategory',
        });
        expect(check(['<SPECIES:QQQQQQQQ>'])[0]).toEqual({
            tag: '<SPECIES:QQQQQQQQ>',
            ok: false,
            reason: 'unknownValue',
        });
    });

    it('warns about trigger categories whose pack is not loaded', () => {
        expect(check(['<TRAIT:STOIC>'])[0]).toEqual({ tag: '<TRAIT:STOIC>', ok: false, reason: 'noPack' });
        expect(check(['<GENRE:FANTASY>'])[0]?.reason).toBe('noPack');
    });
});

describe('helpers', () => {
    it('measures edit distance', () => {
        expect(editDistance('', 'abc')).toBe(3);
        expect(editDistance('abc', '')).toBe(3);
        expect(editDistance('kitten', 'sitting')).toBe(3);
        expect(editDistance('same', 'same')).toBe(0);
    });

    it('finds the closest candidates, containment included', () => {
        expect(closest('KAMI', ['KAMIDERE', 'KUUDERE', 'KAMI'])).toEqual(['KAMIDERE']);
        expect(closest('TSUNDRE', ['TSUNDERE', 'KUUDERE', 'YANDERE', 'DANDERE'], 2)).toEqual(['TSUNDERE']);
        expect(closest('KUDERE', ['KUUDERE', 'DANDERE', 'KUDERU'], 2)).toEqual(['KUDERU', 'KUUDERE']);
        expect(closest('AB', ['ABCDEFG'])).toEqual([]);
    });

    it('decides placeholders like the archive parser', () => {
        expect(isPlaceholderValue('BLANK')).toBe(true);
        expect(isPlaceholderValue('NEW')).toBe(true);
        expect(isPlaceholderValue('NONE')).toBe(false);
        expect(isPlaceholderValue('OLD')).toBe(false);
        expect(isPlaceholderValue('')).toBe(false);
        expect(isPlaceholderValue('a<b')).toBe(false);
        expect(isPlaceholderName('NAME HERE')).toBe(true);
        expect(isPlaceholderName('Мира')).toBe(false);
        expect(isPlaceholderName('')).toBe(true);
    });

    it('formats tags', () => {
        expect(formatTag('SPECIES', 'ELF')).toBe('<SPECIES:ELF>');
        expect(formatTag('MBTI', 'intj-u')).toBe('<INTJ-U>');
        expect(formatTag('DEPRESSION', null)).toBe('<DEPRESSION>');
    });
});
