import { describe, expect, it } from 'vitest';
import { matchesSchema } from '../../src/core/llm';
import {
    CONTENT_LIMIT,
    GENERATED_SLOTS,
    PASSPORT_SCHEMA,
    contentLanguage,
    estimatePassportCost,
    extractJson,
    parseGeneratedPassport,
    passportGenMessages,
} from '../../src/domain/lore-passport-gen';

const EMPTY_SLOTS = Object.fromEntries(GENERATED_SLOTS.map((slot) => [slot, '']));

describe('lore passport generation: prompt and schema', () => {
    it('builds English messages with the kind, type, keys and the clipped text', () => {
        const messages = passportGenMessages({
            name: 'Anna',
            kind: 'character',
            typeLabel: 'Character',
            keys: ['Anna', ' ', 'Анна'],
            content: 'x'.repeat(CONTENT_LIMIT + 10),
        });
        expect(messages[0]!.role).toBe('system');
        expect(messages[0]!.content).toContain('Danbooru');
        expect(messages[0]!.content).toContain('No explicit anatomy');
        const user = messages[1]!.content;
        expect(user).toContain('Name: Anna');
        expect(user).toContain('Entry type: Character');
        expect(user).toContain('Kind to write: character');
        expect(user).toContain('Keywords: Anna, Анна');
        expect(user).toContain('…');
        const free = passportGenMessages({ name: 'X', kind: 'scenario', content: 'text' })[1]!.content;
        expect(free).toContain('Kind: choose the one that fits.');
        expect(free).not.toContain('Keywords');
        expect(passportGenMessages({ name: 'X', kind: null, content: 'text' })[1]!.content).toContain('choose');
    });

    it('has a strict schema the client can check answers against', () => {
        const answer = { kind: 'object', name: 'Ring', aliases: [], tags: 'ring', slots: EMPTY_SLOTS, negative: '' };
        expect(matchesSchema(answer, PASSPORT_SCHEMA)).toBe(true);
        expect(matchesSchema({ ...answer, kind: 'scenario' }, PASSPORT_SCHEMA)).toBe(false);
        expect(matchesSchema({ name: 'Ring' }, PASSPORT_SCHEMA)).toBe(false);
        expect(GENERATED_SLOTS).not.toContain('style');
    });
});

describe('lore passport generation: answers', () => {
    it('extracts JSON from text', () => {
        expect(extractJson('{"a":1}')).toEqual({ a: 1 });
        expect(extractJson('Sure!\n```json\n{"a": 2}\n```')).toEqual({ a: 2 });
        expect(extractJson('here: {"a": 3} done')).toEqual({ a: 3 });
        expect(extractJson('no json')).toBeNull();
        expect(extractJson('{broken')).toBeNull();
        expect(extractJson('x {"a": } y')).toBeNull();
    });

    it('cleans a character: lower case, spaces, no style or non-English tags, anatomy to the NSFW layer', () => {
        const passport = parseGeneratedPassport(
            {
                kind: 'character',
                name: 'Anna',
                aliases: ['Анна', 'Anna'],
                tags: 'Freckles',
                slots: {
                    ...EMPTY_SLOTS,
                    base: '1girl, Elf',
                    hair: 'silver_hair, pastel colors',
                    body: 'slim, nipples, стройная',
                },
                negative: 'Bad_Anatomy',
            },
            { name: 'Anna', kind: null },
        )!;
        expect(passport.kind).toBe('character');
        expect(passport.aliases).toEqual(['Анна']);
        expect(passport.tags).toBe('');
        const slots = passport.slots as Record<string, string>;
        expect(slots.base).toBe('1girl, elf, freckles');
        expect(slots.hair).toBe('silver hair');
        expect(slots.body).toBe('slim');
        expect(slots.style).toBe('');
        expect(passport.nsfw).toEqual({ enabled: false, tags: 'nipples' });
        expect(passport.negative).toBe('bad anatomy');
    });

    it('moves slot tags of other kinds into the tags and keeps the given kind', () => {
        const passport = parseGeneratedPassport(
            { kind: 'character', name: '', tags: 'Tower', slots: { base: 'white walls' } },
            { name: 'Silver Tower', kind: 'location' },
        )!;
        expect(passport).toMatchObject({ kind: 'location', name: 'Silver Tower', tags: 'tower, white walls' });
        expect(Object.values(passport.slots as object).every((value) => value === '')).toBe(true);
    });

    it('reads flat answers, wrapped answers and text; falls back to «world»', () => {
        expect(
            parseGeneratedPassport({ name: 'Anna', hair: 'red hair' }, { name: 'A', kind: 'character' }),
        ).toMatchObject({ slots: { hair: 'red hair' } });
        expect(parseGeneratedPassport({ passport: { tags: 'castle' } }, { name: 'Keep', kind: null })).toMatchObject({
            kind: 'world',
            name: 'Keep',
            tags: 'castle',
        });
        expect(
            parseGeneratedPassport(
                { passports: [{ kind: 'object', name: 'Ring', tags: 'ring' }] },
                { name: 'R', kind: null },
            ),
        ).toMatchObject({ kind: 'object', name: 'Ring' });
        expect(parseGeneratedPassport([{ kind: 'object', tags: 'ring' }], { name: 'R', kind: null })).toMatchObject({
            name: 'R',
        });
        expect(
            parseGeneratedPassport('{"kind":"location","tags":"cave, dark"}', { name: 'C', kind: null }),
        ).toMatchObject({ kind: 'location', tags: 'cave, dark' });
        expect(
            parseGeneratedPassport(
                { kind: 'object', name: 'R', aliases: 'Колечко, R', tags: ['ring', 3] },
                { name: 'R', kind: null },
            ),
        ).toMatchObject({ aliases: ['Колечко'], tags: 'ring' });
    });

    it('returns null when there is nothing to draw', () => {
        expect(parseGeneratedPassport('not json', { name: 'X', kind: null })).toBeNull();
        expect(parseGeneratedPassport(null, { name: 'X', kind: null })).toBeNull();
        expect(parseGeneratedPassport([], { name: 'X', kind: null })).toBeNull();
        expect(parseGeneratedPassport({ passports: ['x'] }, { name: 'X', kind: null })).toBeNull();
        expect(
            parseGeneratedPassport({ kind: 'location', tags: 'башня, masterpiece' }, { name: 'X', kind: null }),
        ).toBeNull();
        // Anatomy alone is not a look.
        expect(
            parseGeneratedPassport({ kind: 'character', slots: { body: 'nipples' } }, { name: 'X', kind: null }),
        ).toBeNull();
    });
});

describe('lore passport generation: helpers', () => {
    it('detects the language and estimates the cost', () => {
        expect(contentLanguage('Анна живёт в башне.')).toBe('ru');
        expect(contentLanguage('Anna lives in a tower.')).toBe('en');
        const one = estimatePassportCost([400]);
        expect(one.tokens).toBe(100 + 700 + 350);
        expect(one.usd).toBeGreaterThan(0);
        expect(estimatePassportCost([CONTENT_LIMIT * 10, -5]).tokens).toBe(CONTENT_LIMIT / 4 + 2 * 1050);
        expect(estimatePassportCost([])).toEqual({ tokens: 0, usd: 0 });
    });
});
