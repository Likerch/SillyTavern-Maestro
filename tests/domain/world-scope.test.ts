import { describe, expect, it } from 'vitest';
import { assembleWorld, entityById, resolveName } from '../../src/domain/world-identity';
import type { WorldRecord } from '../../src/domain/world-identity';
import {
    archiveSourceKey,
    cardNameMatcher,
    cardPassportIdOfKey,
    cardTexts,
    entrySourceKey,
    entryTexts,
    localBookNames,
    passportSourceKey,
    workshopSourceKey,
} from '../../src/domain/world-scope';

const card = (name: string): WorldRecord => ({
    kind: 'character',
    name,
    source: { kind: 'card', ref: `${name}.png`, label: name, avatar: `${name}.png`, scope: 'card' },
    rank: 1,
});
const chatRoster = (name: string): WorldRecord => ({
    kind: 'character',
    name,
    source: { kind: 'des.character', ref: name, label: name, scope: 'chat' },
    rank: 5,
    present: true,
});
const archive = (name: string, book = 'Repo', aliases: string[] = []): WorldRecord => ({
    kind: 'character',
    name,
    aliases,
    source: {
        kind: 'ck.archive',
        ref: `${book}#${name}`,
        label: name,
        world: book,
        uid: 1,
        scope: 'global',
        key: archiveSourceKey(book, name),
    },
    rank: 3,
});
const cardPassport = (name: string, id: string): WorldRecord => ({
    kind: 'character',
    name,
    source: {
        kind: 'nai.passport',
        ref: `Elizabeth.png#${id}`,
        label: name,
        passportId: id,
        avatar: 'Elizabeth.png',
        scope: 'card',
        key: passportSourceKey('Elizabeth.png', id),
    },
    rank: 4,
});
const globalEntry = (kind: WorldRecord['kind'], name: string, uid: number): WorldRecord => ({
    kind,
    name,
    source: {
        kind: 'lore.entry',
        ref: `World#${uid}`,
        label: name,
        world: 'World',
        uid,
        scope: 'global',
        key: entrySourceKey('World', uid),
    },
    rank: 2,
});
const workshop = (name: string): WorldRecord => ({
    kind: 'character',
    name,
    source: { kind: 'des.workshop', ref: name, label: name, scope: 'global', key: workshopSourceKey(name) },
    rank: 6,
    passive: true,
});
const keysOf = (build: ReturnType<typeof assembleWorld>, id: string): string[] =>
    entityById(build, id)?.sources.map((source) => source.key ?? source.kind) ?? [];
const decisions = (bound: string[], apart: string[]) => ({ aliases: {}, merged: {}, separated: [], bound, apart });

describe('world-scope helpers', () => {
    it('make stable source keys and read card passport ids back', () => {
        expect(entrySourceKey('Book', 3)).toBe('lore:Book#3');
        expect(archiveSourceKey('Repo', ' Офёлия ')).toBe('ck:Repo#офелия');
        expect(passportSourceKey('Elizabeth.png', 'npc1')).toBe('nai:Elizabeth.png#npc1');
        expect(workshopSourceKey('ОФЕЛИЯ')).toBe('des:офелия');
        expect(cardPassportIdOfKey('nai:Elizabeth.png#npc1')).toBe('npc1');
        expect(cardPassportIdOfKey('nai:persona#pp')).toBeNull();
        expect(cardPassportIdOfKey('nai:chat#c1')).toBeNull();
        expect(cardPassportIdOfKey('ck:Repo#x')).toBeNull();
        expect(cardPassportIdOfKey('nai:broken')).toBeNull();
    });

    it('collect the card text: fields, V2 copies, greetings and the embedded book', () => {
        const texts = cardTexts({
            name: 'Elizabeth',
            description: 'Хозяйка таверны.',
            first_mes: 'Привет!',
            data: {
                alternate_greetings: ['Офелия машет рукой.', 7],
                character_book: { entries: [{ keys: ['Бран'], content: 'Брат Элизабет.', comment: '' }, 'junk'] },
            },
        });
        expect(texts).toEqual(['Хозяйка таверны.', 'Привет!', 'Офелия машет рукой.', 'Бран', 'Брат Элизабет.']);
        expect(cardTexts(null)).toEqual([]);
        expect(entryTexts({ key: ['Офелия'], keysecondary: [], comment: 'NPC', content: 'Text' })).toEqual([
            'Офелия',
            'NPC',
            'Text',
        ]);
        expect(entryTexts('x')).toEqual([]);
    });

    it('tell the card’s names: own names, text with case endings (forms or stems)', () => {
        const match = cardNameMatcher({
            names: ['Elizabeth', 'Алекс'],
            texts: ['Elizabeth живёт с сестрой Офелией.', 'Annual fair.'],
        });
        expect(match('elizabeth')).toBe(true);
        expect(match('Алекс')).toBe(true);
        expect(match('Офелия')).toBe(true);
        expect(match('Ann')).toBe(false);
        expect(match('Мара')).toBe(false);
        expect(match('')).toBe(false);
        const withForms = cardNameMatcher({
            names: [],
            texts: ['Говорили о Маше.'],
            forms: (name) => (name === 'Маша' ? ['Маша', 'Маши', 'Маше'] : []),
        });
        expect(withForms('Маша')).toBe(true);
        expect(withForms('Маша')).toBe(true);
    });

    it('find the chat’s own books', () => {
        const local = localBookNames({
            chatBook: 'Chat lore',
            cards: [
                { avatar: 'Elizabeth.png', data: { extensions: { world: 'Elizabeth book' } } },
                { avatar: 'Bob.png', data: {} },
                'junk',
            ],
            charLore: [
                { name: 'Bob', extraBooks: ['Bob extra', 'Chat lore'] },
                { name: 'Other', extraBooks: ['X'] },
            ],
        });
        expect(local).toEqual({ chat: ['Chat lore'], card: ['Elizabeth book', 'Bob extra'] });
        expect(localBookNames({ cards: [] })).toEqual({ chat: [], card: [] });
    });
});

describe('assembleWorld: scopes (plan-2 §9)', () => {
    it('a namesake of another story stays out: one Офелия here, the other one waits for the question', () => {
        const build = assembleWorld({
            records: [card('Elizabeth'), chatRoster('Офелия'), archive('Офелия'), cardPassport('Офелия', 'npc1')],
        });
        expect(build.entities.map((entity) => entity.id)).toEqual(['character:офелия', 'character:elizabeth']);
        expect(keysOf(build, 'character:офелия')).toEqual(['des.character']);
        expect(build.foreign).toHaveLength(1);
        expect(build.foreign[0]).toMatchObject({
            key: 'being\u0000офелия',
            name: 'Офелия',
            local: true,
            entity: 'character:офелия',
            names: ['Офелия'],
            apart: [],
        });
        expect(build.foreign[0]?.pending.map((source) => source.key)).toEqual([
            'ck:Repo#офелия',
            'nai:Elizabeth.png#npc1',
        ]);
    });

    it('a person nobody of this chat names does not become an entity either', () => {
        const build = assembleWorld({ records: [card('Elizabeth'), archive('Странник')] });
        expect(build.entities.map((entity) => entity.name)).toEqual(['Elizabeth']);
        expect(build.foreign).toMatchObject([{ key: 'being\u0000странник', local: false, name: 'Странник' }]);
        expect(build.foreign[0]?.entity).toBeUndefined();
        expect(resolveName(build, 'Странник')).toBeUndefined();
    });

    it('a namesake answering to a name of this chat by an alias asks under that name', () => {
        const build = assembleWorld({ records: [chatRoster('Фея'), archive('Офелия Грей', 'Repo', ['Фея'])] });
        expect(build.foreign).toMatchObject([
            { key: 'being\u0000фея', name: 'Фея', local: true, names: ['Офелия Грей'] },
        ]);
    });

    it('records of the card join without a question (its name or its text)', () => {
        const ofCard = (name: string) => ['elizabeth', 'офелия'].includes(name.trim().toLowerCase());
        const build = assembleWorld({
            records: [card('Elizabeth'), chatRoster('Офелия'), archive('Офелия'), archive('Elizabeth', 'Repo2')],
            ofCard,
        });
        expect(build.foreign).toEqual([]);
        expect(keysOf(build, 'character:офелия')).toEqual(['des.character', 'ck:Repo#офелия']);
        expect(keysOf(build, 'character:elizabeth')).toEqual(['card', 'ck:Repo2#elizabeth']);
    });

    it('«Тот же» binds; «Другой» keeps out even what is of the card and splits records of one name', () => {
        const records = [chatRoster('Офелия'), archive('Офелия'), cardPassport('Офелия', 'npc1')];
        const same = assembleWorld({ records, decisions: decisions(['ck:Repo#офелия'], []) });
        expect(keysOf(same, 'character:офелия')).toEqual(['des.character', 'ck:Repo#офелия']);
        expect(same.foreign[0]?.pending.map((source) => source.key)).toEqual(['nai:Elizabeth.png#npc1']);
        const apart = assembleWorld({
            records,
            ofCard: () => true,
            decisions: decisions([], ['ck:Repo#офелия', 'nai:Elizabeth.png#npc1']),
        });
        expect(apart.entities).toHaveLength(1);
        expect(keysOf(apart, 'character:офелия')).toEqual(['des.character']);
        expect(apart.foreign[0]?.pending).toEqual([]);
        expect(apart.foreign[0]?.apart.map((source) => source.key)).toEqual([
            'ck:Repo#офелия',
            'nai:Elizabeth.png#npc1',
        ]);
    });

    it('things of the wider stores join unless this chat already uses the name', () => {
        const place: WorldRecord = {
            kind: 'place',
            id: 'place:p1',
            name: 'Таверна',
            source: { kind: 'place', ref: 'p1', label: 'Таверна', scope: 'chat' },
            rank: 1,
        };
        const build = assembleWorld({
            records: [place, globalEntry('place', 'Таверна', 1), globalEntry('faction', 'Орден', 2)],
        });
        expect(build.entities.map((entity) => entity.id)).toEqual(['place:p1', 'faction:орден']);
        expect(keysOf(build, 'place:p1')).toEqual(['place']);
        expect(build.foreign).toMatchObject([{ key: 'place\u0000таверна', local: true, entity: 'place:p1' }]);
    });

    it('DES Workshop data never asks: it joins the person of this chat unless a question about the name is open', () => {
        const quiet = assembleWorld({ records: [chatRoster('Офелия'), workshop('Офелия'), workshop('Никто')] });
        expect(keysOf(quiet, 'character:офелия')).toEqual(['des.character', 'des:офелия']);
        expect(quiet.entities).toHaveLength(1);
        expect(quiet.foreign).toEqual([]);
        const open = assembleWorld({ records: [chatRoster('Офелия'), workshop('Офелия'), archive('Офелия')] });
        expect(keysOf(open, 'character:офелия')).toEqual(['des.character']);
        expect(open.foreign[0]?.pending.map((source) => source.key)).toEqual(['ck:Repo#офелия', 'des:офелия']);
    });

    it('untyped entries of the wider stores follow the same rule', () => {
        const entrySource = (uid: number, scope: 'chat' | 'global') => ({
            kind: 'lore.entry' as const,
            ref: `World#${uid}`,
            label: `#${uid}`,
            world: 'World',
            uid,
            scope,
            key: entrySourceKey('World', uid),
        });
        const records = [chatRoster('Офелия'), archive('Странник')];
        const attach = [
            { names: ['Офелия'], source: entrySource(1, 'global') },
            { names: ['Офелия'], source: entrySource(2, 'chat') },
            { names: ['Странник'], source: entrySource(3, 'global') },
            { names: ['Никто'], source: entrySource(4, 'global') },
        ];
        const build = assembleWorld({ records, attach });
        expect(keysOf(build, 'character:офелия')).toEqual(['des.character', 'lore:World#2']);
        expect(build.foreign.map((group) => [group.key, group.pending.map((source) => source.key)])).toEqual([
            ['being\u0000офелия', ['lore:World#1']],
            ['being\u0000странник', ['ck:Repo#странник', 'lore:World#3']],
        ]);
        const bound = assembleWorld({
            records,
            attach,
            decisions: decisions(['lore:World#1'], ['lore:World#3']),
        });
        expect(keysOf(bound, 'character:офелия')).toEqual(['des.character', 'lore:World#1', 'lore:World#2']);
        const stranger = bound.foreign.find((group) => group.key === 'being\u0000странник');
        expect(stranger?.apart.map((source) => source.key)).toEqual(['lore:World#3']);
    });

    it('records without a scope are this chat’s (stage-3 callers keep their behaviour)', () => {
        const plain = (kind: 'des.character' | 'nai.passport'): WorldRecord => ({
            kind: 'character',
            name: 'Лиза',
            source: { kind, ref: `${kind}#Лиза`, label: 'Лиза' },
        });
        const build = assembleWorld({ records: [plain('des.character'), plain('nai.passport')] });
        expect(build.entities).toHaveLength(1);
        expect(build.foreign).toEqual([]);
    });
});
