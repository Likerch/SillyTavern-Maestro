import { describe, expect, it } from 'vitest';
import {
    buildMentionMatcher,
    entityIdOf,
    findMentions,
    findNeedle,
    isWorldKind,
    kindFamily,
    kindOrder,
    looksLikeName,
    mentionNeedles,
    nameList,
    normalizeName,
    pairKey,
    splitAliases,
    splitPairKey,
    wordsOf,
} from '../../src/domain/world-names';

describe('world names', () => {
    it('normalises NFC, case, ё and spaces', () => {
        expect(normalizeName('  Пётр   Ильич ')).toBe('петр ильич');
        expect(normalizeName('Ёж')).toBe('еж');
        expect(normalizeName('ELIZABETH\tBlackwood')).toBe('elizabeth blackwood');
        expect(normalizeName('')).toBe('');
    });

    it('builds ids and pair keys', () => {
        expect(entityIdOf('character', ' Лёша ')).toBe('character:леша');
        expect(pairKey('b', 'a')).toBe(pairKey('a', 'b'));
        expect(splitPairKey(pairKey('x', 'y'))).toEqual(['x', 'y']);
        expect(splitPairKey('junk')).toBeNull();
        expect(wordsOf('анна  петрова')).toEqual(['анна', 'петрова']);
    });

    it('knows kinds, their order and families', () => {
        expect(isWorldKind('place')).toBe(true);
        expect(isWorldKind('rule')).toBe(false);
        expect(isWorldKind(3)).toBe(false);
        expect(kindOrder('persona')).toBeLessThan(kindOrder('character'));
        expect(kindOrder('character')).toBeLessThan(kindOrder('place'));
        expect(kindOrder('unknown')).toBeGreaterThan(kindOrder('mechanic'));
        expect(kindFamily('persona')).toBe('being');
        expect(kindFamily('character')).toBe('being');
        expect(kindFamily('place')).toBe('place');
    });

    it('tells name-like keys from regexes, macros, tags and commands', () => {
        expect(looksLikeName('Лиза')).toBe(true);
        expect(looksLikeName('Elizabeth Blackwood')).toBe(true);
        expect(looksLikeName('/лиз/iu')).toBe(false);
        expect(looksLikeName('{{char}}')).toBe(false);
        expect(looksLikeName('<SPECIES:ELF>')).toBe(false);
        expect(looksLikeName('!fullsheet')).toBe(false);
        expect(looksLikeName('a')).toBe(false);
        expect(looksLikeName('one two three four five')).toBe(false);
        expect(looksLikeName('12345')).toBe(false);
        expect(looksLikeName('x'.repeat(61))).toBe(false);
        expect(looksLikeName('line\nbreak')).toBe(false);
        expect(looksLikeName(42)).toBe(false);
    });

    it('lists names once, keeping the first spelling', () => {
        expect(nameList([' Лиза ', 'лиза', 'Лизa', '/x/', 7, 'Liz'])).toEqual(['Лиза', 'Лизa', 'Liz']);
        expect(splitAliases('Лиз, Лиза; Liz\nЛизонька')).toEqual(['Лиз', 'Лиза', 'Liz', 'Лизонька']);
        expect(splitAliases(undefined)).toEqual([]);
    });
});

describe('mention needles', () => {
    it('gives Cyrillic names a short tail, Latin names none, and stems when asked', () => {
        const needles = mentionNeedles(['Маша', 'Ann', 'Анна Петрова', 'Я'], [], true);
        expect(needles).toContainEqual({ needle: 'маша', tail: 2 });
        expect(needles).toContainEqual({ needle: 'маш', tail: 3 });
        expect(needles).toContainEqual({ needle: 'ann', tail: 0 });
        expect(needles).toContainEqual({ needle: 'анна петрова', tail: 2 });
        expect(needles.some((item) => item.needle === 'я')).toBe(false);
        expect(needles.some((item) => item.needle === 'анна петров')).toBe(false);
    });

    it('adds forms and keeps the widest tail for duplicates', () => {
        const needles = mentionNeedles(['Лиза', 'лиза'], ['Лизой', '', 7 as unknown as string], false);
        expect(needles).toEqual([
            { needle: 'лиза', tail: 2 },
            { needle: 'лизой', tail: 2 },
        ]);
        const merged = mentionNeedles(['Маш', 'Маша'], [], true);
        expect(merged.find((item) => item.needle === 'маш')?.tail).toBe(3);
    });

    it('finds a needle after a boundary with a limited tail', () => {
        expect(findNeedle('с машей', 'маш', 3)).toBe(2);
        expect(findNeedle('ромашка', 'маш', 3)).toBe(-1);
        expect(findNeedle('машенька', 'маш', 3)).toBe(-1);
        expect(findNeedle('annual ann', 'ann', 0)).toBe(7);
        expect(findNeedle('annual', 'ann', 0)).toBe(-1);
        expect(findNeedle('text', '', 0)).toBe(-1);
    });

    it('matches entities in order of first mention', () => {
        const matcher = buildMentionMatcher([
            { id: 'a', needles: mentionNeedles(['Лиза'], ['Лизой', 'Лизе'], false) },
            { id: 'b', needles: mentionNeedles(['Ann'], [], false) },
            { id: 'c', needles: mentionNeedles(['Маша'], [], true) },
            { id: 'empty', needles: [] },
        ]);
        expect(matcher.rows).toHaveLength(3);
        expect(findMentions(matcher, 'Ann пришла к Лизе. ЛИЗОЙ все восхищались')).toEqual(['b', 'a']);
        expect(findMentions(matcher, 'Ромашка и Annual report')).toEqual([]);
        expect(findMentions(matcher, 'Говорили с Машей, потом с Ann')).toEqual(['c', 'b']);
        expect(findMentions(matcher, 'Лёша, Лиза')).toEqual(['a']);
        expect(findMentions(matcher, '')).toEqual([]);
        expect(findMentions(buildMentionMatcher([]), 'Лиза')).toEqual([]);
    });
});
