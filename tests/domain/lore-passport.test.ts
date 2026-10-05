import { describe, expect, it } from 'vitest';
import {
    PASSPORT_SLOTS,
    cleanTags,
    dedupeScene,
    entryDisplayName,
    fixPassport,
    hasErrors,
    isEnglishTag,
    isExplicitAnatomy,
    isFixable,
    isPassportEmpty,
    isPassportKind,
    isUserMade,
    joinTags,
    makePassportRecord,
    normalizePassport,
    passportKindOf,
    passportOfEntry,
    passportTagLine,
    readPassportRecord,
    scenePassportId,
    splitTags,
    toNaiShape,
    validatePassport,
    withPassport,
    withSidecarPassport,
} from '../../src/domain/lore-passport';

describe('lore passports: kinds', () => {
    it('maps entry types and entity kinds to NAI kinds', () => {
        expect(passportKindOf('character')).toBe('character');
        expect(passportKindOf('persona')).toBe('character');
        expect(passportKindOf('creature')).toBe('character');
        expect(passportKindOf('npc')).toBe('character');
        expect(passportKindOf('place')).toBe('location');
        expect(passportKindOf('location')).toBe('location');
        expect(passportKindOf('item')).toBe('object');
        expect(passportKindOf('object')).toBe('object');
        for (const type of ['faction', 'event', 'tradition', 'world']) expect(passportKindOf(type)).toBe('world');
        expect(passportKindOf('scenario')).toBe('scenario');
        for (const type of ['rule', 'mechanic', 'chapter', 'note', 'secret', undefined, 3]) {
            expect(passportKindOf(type)).toBeNull();
        }
        expect(isPassportKind('location')).toBe(true);
        expect(isPassportKind('place')).toBe(false);
    });
});

describe('lore passports: tags', () => {
    it('splits, joins and cleans tags like NAI Studio', () => {
        expect(splitTags(' a, b,\nA , ,c ')).toEqual(['a', 'b', 'c']);
        expect(joinTags('a, b', '', 'B, c')).toBe('a, b, c');
        expect(cleanTags('Silver_Hair,  Long   Hair, silver hair')).toBe('silver hair, long hair');
    });

    it('recognises English tags and explicit anatomy', () => {
        expect(isEnglishTag('1girl, (blue eyes:1.2)')).toBe(true);
        expect(isEnglishTag('башня')).toBe(false);
        expect(isEnglishTag('pokémon')).toBe(false);
        expect(isExplicitAnatomy('nipples')).toBe(true);
        expect(isExplicitAnatomy('pubic hair')).toBe(true);
        expect(isExplicitAnatomy('hair')).toBe(false);
        expect(isExplicitAnatomy('penistone')).toBe(false);
    });
});

describe('lore passports: shape', () => {
    it('normalises a passport, keeping unknown fields', () => {
        const passport = normalizePassport({
            kind: 'bogus',
            name: '  Anna ',
            aliases: 'Анна, anna, , Аня',
            slots: { hair: 'red hair', custom: 'x', bad: 3 },
            nsfw: { enabled: true, tags: 'nipples' },
            outfits: [{ name: 'Dress', tags: 'dress' }, { name: '', tags: 'x' }, 'junk'],
            activeOutfit: 'Dress',
            states: [{ id: 'wet', tags: 'wet', enabled: true }, { tags: 'no id' }],
            negative: 5,
            extra: { keep: true },
        })!;
        expect(passport.kind).toBe('character');
        expect(passport.name).toBe('Anna');
        expect(passport.aliases).toEqual(['Анна', 'Аня']);
        expect(Object.keys(passport.slots as object)).toEqual([...PASSPORT_SLOTS, 'custom']);
        expect(passport.nsfw).toEqual({ enabled: true, tags: 'nipples' });
        expect(passport.outfits).toEqual([{ name: 'Dress', tags: 'dress' }]);
        expect(passport.activeOutfit).toBe('Dress');
        expect(passport.states).toEqual([{ id: 'wet', tags: 'wet', enabled: true }]);
        expect(passport.negative).toBe('');
        expect(passport.extra).toEqual({ keep: true });
        expect(normalizePassport(null)).toBeNull();
        expect(normalizePassport([])).toBeNull();
        const fallback = normalizePassport({ aliases: ['X'], activeOutfit: 'gone' }, { kind: 'object', name: 'Ring' })!;
        expect(fallback).toMatchObject({ kind: 'object', name: 'Ring', aliases: ['X'], activeOutfit: '' });
        expect(normalizePassport({})!.name).toBe('');
    });

    it('reads records, bare passports and junk', () => {
        const record = readPassportRecord({
            passport: { kind: 'object', name: 'Ring', tags: 'ring' },
            generatedBy: 'model',
            updatedAt: 5,
            contentHash: 'h1',
        });
        expect(record).toMatchObject({ generatedBy: 'model', updatedAt: 5, contentHash: 'h1' });
        expect(record!.passport.tags).toBe('ring');
        const odd = readPassportRecord({ passport: { name: 'X' }, generatedBy: 'robot', updatedAt: 'no' })!;
        expect(odd.generatedBy).toBeUndefined();
        expect(odd.updatedAt).toBe(0);
        const bare = readPassportRecord({ kind: 'location', tags: 'tower' })!;
        expect(bare).toMatchObject({ updatedAt: 0, passport: { kind: 'location', tags: 'tower' } });
        expect(isUserMade(bare)).toBe(true);
        expect(readPassportRecord({ id: 'p1' })).toBeNull();
        expect(readPassportRecord('x')).toBeNull();
    });

    it('makes records and tells who made them', () => {
        const record = makePassportRecord({ kind: 'object', name: 'Ring' }, 'nai', 'h', 7);
        expect(record).toMatchObject({ generatedBy: 'nai', contentHash: 'h', updatedAt: 7 });
        expect(makePassportRecord({}, 'user', undefined, 1).contentHash).toBeUndefined();
        expect(isUserMade(record)).toBe(false);
        expect(isUserMade({ generatedBy: 'user' })).toBe(true);
        expect(isUserMade(null)).toBe(false);
    });

    it('sets and removes the record in extensions.maestro, keeping other keys', () => {
        const record = makePassportRecord({ kind: 'object', name: 'Ring' }, 'user', 'h', 1);
        const extensions = { other: 1, maestro: { kind: 'override', status: 'active' } };
        const next = withPassport(extensions, record)!;
        expect(next.other).toBe(1);
        expect(next.maestro).toMatchObject({ kind: 'override', passport: { generatedBy: 'user' } });
        expect(extensions.maestro).not.toHaveProperty('passport');
        expect(passportOfEntry({ extensions: next })!.passport.name).toBe('Ring');
        expect(withPassport(next, null)).toEqual(extensions);
        expect(withPassport(undefined, null)).toBeUndefined();
        expect(withPassport({ maestro: { passport: {} } }, null)).toEqual({});
        expect(withPassport({ maestro: {} }, null)).toEqual({ maestro: {} });
        expect(withPassport(undefined, record)).toEqual({ maestro: { passport: record } });
        expect(passportOfEntry({})).toBeNull();
        expect(passportOfEntry(null)).toBeNull();
    });

    it('sets and removes the record in a sidecar record', () => {
        const record = makePassportRecord({ name: 'Ring' }, 'user', 'h', 1);
        expect(withSidecarPassport({ type: 'item' }, record)).toEqual({ type: 'item', passport: record });
        expect(withSidecarPassport({ type: 'item', passport: record }, null)).toEqual({ type: 'item' });
        expect(withSidecarPassport({ passport: record }, null)).toBeUndefined();
        expect(withSidecarPassport(undefined, record)).toEqual({ passport: record });
    });
});

describe('lore passports: validation', () => {
    it('reports non-English, upper case, underscores, anatomy and empty passports', () => {
        const passport = normalizePassport({
            kind: 'character',
            tags: 'Stray',
            slots: { body: 'slim, Nipples', hair: 'silver_hair', base: 'девушка' },
            outfits: [{ name: 'Night', tags: 'pussy' }],
            states: [{ id: 'wet', tags: 'Wet' }],
            nsfw: { enabled: false, tags: 'nipples' },
            negative: 'penis',
        })!;
        const issues = validatePassport(passport);
        const codes = issues.map((issue) => `${issue.field}:${issue.code}:${issue.tag}`);
        expect(codes).toEqual([
            'tags:upperCase:Stray',
            'slots.base:notEnglish:девушка',
            'slots.hair:underscore:silver_hair',
            'slots.body:upperCase:Nipples',
            'slots.body:anatomy:Nipples',
            'outfits.0:anatomy:pussy',
            'states.0:upperCase:Wet',
        ]);
        expect(hasErrors(issues)).toBe(true);
        expect(issues.filter(isFixable)).toHaveLength(6);
        expect(validatePassport(normalizePassport({ kind: 'location' })!)).toEqual([
            { field: '', code: 'empty', level: 'warn' },
        ]);
        expect(hasErrors([{ field: '', code: 'empty', level: 'warn' }])).toBe(false);
    });

    it('fixes case, underscores and moves anatomy into the NSFW layer', () => {
        const fixed = fixPassport({
            kind: 'character',
            tags: 'Pussy, Tall',
            slots: { body: 'Slim, nipples', hair: 'silver_hair' },
            outfits: [{ name: 'Night', tags: 'Penis, robe' }],
            states: [{ id: 'wet', tags: 'Wet_Hair', enabled: true }],
            nsfw: { enabled: true, tags: 'Areola' },
            negative: 'Bad_Hands',
        });
        expect(fixed.tags).toBe('tall');
        expect((fixed.slots as Record<string, string>).body).toBe('slim');
        expect((fixed.slots as Record<string, string>).hair).toBe('silver hair');
        expect(fixed.outfits).toEqual([{ name: 'Night', tags: 'robe' }]);
        expect(fixed.states).toEqual([{ id: 'wet', tags: 'wet hair', enabled: true }]);
        expect(fixed.nsfw).toEqual({ enabled: true, tags: 'areola, pussy, nipples, penis' });
        expect(fixed.negative).toBe('bad hands');
        expect(hasErrors(validatePassport(fixed))).toBe(false);
        expect(fixPassport(null as never)).toBeDefined();
    });

    it('knows an empty passport', () => {
        expect(isPassportEmpty(null)).toBe(true);
        expect(isPassportEmpty({ kind: 'location', tags: ' ' })).toBe(true);
        expect(isPassportEmpty({ kind: 'location', tags: 'tower' })).toBe(false);
        expect(isPassportEmpty({ kind: 'character' })).toBe(true);
        expect(isPassportEmpty({ kind: 'character', slots: { hair: 'red hair' } })).toBe(false);
        expect(isPassportEmpty({ kind: 'character', outfits: [{ name: 'a', tags: 'b' }] })).toBe(false);
        expect(isPassportEmpty({ kind: 'character', nsfw: { tags: 'x' } })).toBe(false);
    });
});

describe('lore passports: lists and NAI Studio', () => {
    it('makes one tag line for lists', () => {
        expect(passportTagLine({ kind: 'character', slots: { base: '1girl', hair: 'red hair', style: 'ink' } })).toBe(
            '1girl, red hair, ink',
        );
        expect(passportTagLine({ kind: 'location', tags: 'tower, tower, night' })).toBe('tower, night');
        expect(passportTagLine({ kind: 'location', tags: 'a'.repeat(50) }, 10)).toBe(`${'a'.repeat(9)}…`);
        expect(passportTagLine({ kind: 'character' })).toBe('');
    });

    it('shapes a passport for NAI Studio with a stable id', () => {
        expect(scenePassportId('World', 3)).toBe('maestro:World#3');
        const shaped = toNaiShape('World', 3, 'Anna', { kind: 'character', slots: { hair: 'red hair' }, extra: 1 });
        expect(shaped).toMatchObject({
            id: 'maestro:World#3',
            kind: 'character',
            name: 'Anna',
            aliases: [],
            tags: '',
            outfits: [],
            activeOutfit: '',
            states: [],
            negative: '',
            extra: 1,
        });
        expect(shaped.slots.hair).toBe('red hair');
        expect(toNaiShape('W', 1, 'Ring', 'junk' as never)).toMatchObject({ name: 'Ring', kind: 'character' });
    });

    it('keeps one passport per thing in a scene', () => {
        const items = [
            { key: 'A#1', name: 'Anna', kind: 'character', aliases: ['Аня'] },
            { key: 'A#1', name: 'Anna', kind: 'character' },
            { key: 'B#1', name: 'anna', kind: 'character' },
            { key: 'C#1', name: 'Аня', kind: 'character' },
            { key: 'D#1', name: 'Anna', kind: 'location' },
            { key: 'E#1', name: '', kind: 'object' },
            { key: 'F#1', name: 'Ring', kind: 'object' },
        ];
        expect(dedupeScene(items, 10).map((item) => item.key)).toEqual(['A#1', 'D#1', 'E#1', 'F#1']);
        expect(dedupeScene(items, 2).map((item) => item.key)).toEqual(['A#1', 'D#1']);
    });

    it('names an entry by its type, comment, key or uid', () => {
        expect(entryDisplayName({ comment: 'Anna' }, ' Anna Petrova ')).toBe('Anna Petrova');
        expect(entryDisplayName({ comment: 'Anna\nmore' })).toBe('Anna');
        expect(entryDisplayName({ comment: ' ', key: ['', 'tower'] })).toBe('tower');
        expect(entryDisplayName({ uid: 4 })).toBe('#4');
        expect(entryDisplayName({})).toBe('#?');
    });
});
