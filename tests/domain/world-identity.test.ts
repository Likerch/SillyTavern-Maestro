import { describe, expect, it } from 'vitest';
import { assembleWorld, entityById, resolveName } from '../../src/domain/world-identity';
import type { WorldRecord, WorldSource } from '../../src/domain/world-identity';
import { pairKey } from '../../src/domain/world-names';

const card = (name: string, avatar = `${name}.png`): WorldRecord => ({
    kind: 'character',
    name,
    source: { kind: 'card', ref: avatar, label: name, avatar },
    rank: 1,
});
const roster = (name: string, present?: boolean): WorldRecord => {
    const record: WorldRecord = {
        kind: 'character',
        name,
        source: { kind: 'des.character', ref: name, label: name },
        rank: 5,
    };
    if (present !== undefined) record.present = present;
    return record;
};
const passport = (name: string, aliases: string[], id = `p-${name}`): WorldRecord => ({
    kind: 'character',
    name,
    aliases,
    source: { kind: 'nai.passport', ref: id, label: name, passportId: id },
    rank: 4,
});
const persona = (name: string): WorldRecord => ({
    kind: 'persona',
    name,
    source: { kind: 'persona', ref: name, label: name },
    rank: 1,
});
const entry = (kind: WorldRecord['kind'], name: string, aliases: string[] = [], uid = 1): WorldRecord => ({
    kind,
    name,
    aliases,
    source: { kind: 'lore.entry', ref: `Book#${uid}`, label: name, world: 'Book', uid },
    rank: 2,
});
const forms: Record<string, string[]> = {
    Лиза: ['Лиза', 'Лизы', 'Лизе', 'Лизу', 'Лизой'],
    Анна: ['Анна', 'Анны', 'Анне', 'Анну', 'Анной'],
};

describe('assembleWorld: merging', () => {
    it('merges the same name across sources, card name first, presence from the roster', () => {
        const build = assembleWorld({
            records: [roster('elizabeth', true), card('Elizabeth'), passport('ELIZABETH', ['Liz'])],
        });
        expect(build.entities).toHaveLength(1);
        const [entity] = build.entities;
        expect(entity?.id).toBe('character:elizabeth');
        expect(entity?.name).toBe('Elizabeth');
        expect(entity?.aliases).toEqual(['Liz']);
        expect(entity?.present).toBe(true);
        expect(entity?.sources.map((source) => source.kind)).toEqual(['des.character', 'card', 'nai.passport']);
        expect(resolveName(build, 'liz')?.id).toBe('character:elizabeth');
    });

    it('makes a DES roster name equal to the persona the persona', () => {
        const build = assembleWorld({ records: [roster('Алекс', false), persona('Алекс')] });
        expect(build.entities).toHaveLength(1);
        expect(build.entities[0]?.kind).toBe('persona');
        expect(build.entities[0]?.present).toBe(false);
    });

    it('joins names of a DES alias group, the DES canonical name wins', () => {
        const build = assembleWorld({
            records: [roster('Лиза', true), card('Elizabeth Blackwood'), roster('Боб')],
            aliasGroups: [{ Elizabeth: ['Лиза', 'Elizabeth Blackwood'] }, { Чужой: ['Никто'] }],
            forms: (name) => forms[name] ?? [],
        });
        expect(build.entities.map((entity) => entity.name)).toEqual(['Боб', 'Elizabeth']);
        const elizabeth = build.entities[1]!;
        expect(elizabeth.id).toBe('character:elizabeth');
        expect(elizabeth.aliases).toEqual(['Лиза', 'Elizabeth Blackwood']);
        expect(elizabeth.forms).toEqual(['Лизы', 'Лизе', 'Лизу', 'Лизой']);
        expect(elizabeth.sources.some((source) => source.kind === 'des.alias' && source.ref === 'Elizabeth')).toBe(
            true,
        );
        expect(resolveName(build, 'лизой')?.id).toBe('character:elizabeth');
        expect(resolveName(build, 'Никто')).toBeUndefined();
    });

    it('never guesses a Russian form of an English name', () => {
        const build = assembleWorld({ records: [card('Elizabeth'), roster('Элизабет')] });
        expect(build.entities).toHaveLength(2);
        expect(build.candidates).toEqual([]);
    });

    it('glues a record to the one entity named by its alias', () => {
        const build = assembleWorld({ records: [passport('Elizabeth Blackwood', ['Лиза']), roster('Лиза', true)] });
        expect(build.entities).toHaveLength(1);
        expect(build.entities[0]?.name).toBe('Elizabeth Blackwood');
        expect(build.entities[0]?.present).toBe(true);
        expect(build.redirects.get('character:лиза')).toBe('character:elizabeth blackwood');
        expect(entityById(build, 'character:лиза')?.name).toBe('Elizabeth Blackwood');
    });

    it('keeps the place registry id and joins a typed place entry of the same name', () => {
        const place: WorldRecord = {
            kind: 'place',
            id: 'place:p1',
            name: 'Таверна',
            aliases: ['Трактир'],
            forms: ['Таверне', 'Таверну'],
            source: { kind: 'place', ref: 'p1', label: 'Таверна' },
            rank: 1,
        };
        const build = assembleWorld({ records: [entry('place', 'таверна', ['Пивная']), place] });
        expect(build.entities).toHaveLength(1);
        expect(build.entities[0]?.id).toBe('place:p1');
        expect(build.entities[0]?.forms).toEqual(['Таверне', 'Таверну']);
        expect(resolveName(build, 'Пивная', 'place')?.id).toBe('place:p1');
        expect(resolveName(build, 'Пивная', 'character')).toBeUndefined();
    });

    it('joins records of one fixed id and chains of merges', () => {
        const place = (name: string, rank: number, id = 'place:p1'): WorldRecord => ({
            kind: 'place',
            id,
            name,
            source: { kind: 'place', ref: `${id}#${name}`, label: name },
            rank,
        });
        const places = assembleWorld({
            records: [place('Old name', 3), place('New name', 1), place('Other', 1, 'place:p2')],
        });
        expect(places.entities.map((entity) => [entity.id, entity.name])).toEqual([
            ['place:p1', 'New name'],
            ['place:p2', 'Other'],
        ]);
        const chain = assembleWorld({
            records: [card('Elizabeth'), roster('Лиза'), passport('Лиза', []), roster('лиза')],
            aliasGroups: [{ Elizabeth: ['Лиза'] }],
        });
        expect(chain.entities).toHaveLength(1);
        expect(chain.entities[0]?.sources).toHaveLength(5);
    });

    // Before plan-2 §9 an archive of a repo that is not active joined whenever one of its names was known (here «Liz»
    // through a DES alias group): exactly how a namesake of another story slipped in. Now only the card's own joins.
    it('drops records without names; repo archives join only when they are the card’s', () => {
        const archive = (name: string): WorldRecord => ({
            kind: 'character',
            name,
            source: { kind: 'ck.archive', ref: `Repo#${name}`, label: name, scope: 'global', key: `ck:Repo#${name}` },
            rank: 3,
        });
        const build = assembleWorld({
            records: [card('Elizabeth'), roster('  '), archive('Странник'), archive('Liz'), archive('Elizabeth')],
            aliasGroups: [{ Elizabeth: ['Liz'] }],
            ofCard: (name) => name.trim().toLowerCase() === 'elizabeth',
        });
        expect(build.entities.map((entity) => entity.name)).toEqual(['Elizabeth']);
        expect(build.entities[0]?.sources.filter((source) => source.kind === 'ck.archive')).toHaveLength(1);
        // «Liz» is Elizabeth here (DES alias): her repo archive waits for the question under her name.
        expect(build.foreign.map((group) => [group.key, group.entity ?? null, group.local])).toEqual([
            ['being\u0000elizabeth', 'character:elizabeth', true],
            ['being\u0000странник', null, false],
        ]);
    });
});

describe('assembleWorld: decisions', () => {
    it('applies chat aliases: the alias resolves, and a record with that name joins the target', () => {
        const build = assembleWorld({
            records: [card('Elizabeth'), roster('Рыжая'), roster('Боб')],
            decisions: {
                aliases: { Рыжая: 'character:elizabeth', Ghost: 'character:none' },
                merged: {},
                separated: [],
            },
        });
        expect(build.entities.map((entity) => entity.id)).toEqual(['character:боб', 'character:elizabeth']);
        const elizabeth = entityById(build, 'character:elizabeth')!;
        expect(elizabeth.aliases).toContain('Рыжая');
        expect(elizabeth.sources.some((source) => source.kind === 'chat.alias')).toBe(true);
        expect(resolveName(build, 'рыжая')?.id).toBe('character:elizabeth');
    });

    it('a chat alias without a record still names the target', () => {
        const build = assembleWorld({
            records: [roster('Лиза')],
            decisions: { aliases: { Лизок: 'character:лиза' }, merged: {}, separated: [] },
        });
        expect(resolveName(build, 'Лизок')?.id).toBe('character:лиза');
    });

    it('applies merges and keeps the kept id even when the merged side has a stronger name', () => {
        const build = assembleWorld({
            records: [roster('Лиз'), card('Elizabeth')],
            decisions: { aliases: {}, merged: { 'character:elizabeth': 'character:лиз', bad: 'x' }, separated: [] },
        });
        expect(build.entities).toHaveLength(1);
        expect(build.entities[0]?.id).toBe('character:лиз');
        expect(build.entities[0]?.name).toBe('Elizabeth');
        expect(entityById(build, 'character:elizabeth')?.id).toBe('character:лиз');
    });

    it('separated pairs neither glue nor become candidates', () => {
        const records = [passport('Elizabeth Blackwood', ['Лиза']), roster('Лиза')];
        const separated = [pairKey('character:elizabeth blackwood', 'character:лиза')];
        const build = assembleWorld({ records, decisions: { aliases: {}, merged: {}, separated } });
        expect(build.entities).toHaveLength(2);
        expect(build.candidates).toEqual([]);
    });
});

describe('assembleWorld: merge candidates', () => {
    it('proposes a short first name for the one full name it starts', () => {
        const build = assembleWorld({ records: [roster('Анна'), card('Анна Петрова')] });
        expect(build.entities).toHaveLength(2);
        expect(build.candidates).toEqual([
            { a: 'character:анна петрова', b: 'character:анна', reason: 'firstName', score: 0.7, name: 'Анна' },
        ]);
    });

    it('lowers the score when a first name starts several full names', () => {
        const build = assembleWorld({ records: [roster('Анна'), card('Анна Петрова'), passport('Анна Смирнова', [])] });
        expect(build.candidates.map((candidate) => [candidate.a, candidate.score])).toEqual([
            ['character:анна петрова', 0.4],
            ['character:анна смирнова', 0.4],
        ]);
    });

    it('an alias claimed by several does not glue: the owner gets a candidate per claimant', () => {
        const build = assembleWorld({
            records: [roster('Ли'), passport('Лиана', ['Ли']), entry('character', 'Лилия', ['Ли'])],
        });
        expect(build.entities).toHaveLength(3);
        expect(build.candidates.map((candidate) => candidate.reason)).toEqual(['sharedAlias', 'sharedAlias']);
        expect(build.candidates.every((candidate) => candidate.b === 'character:ли')).toBe(true);
        expect(resolveName(build, 'Ли')?.id).toBe('character:ли');
    });

    it('two entities of one kind sharing an alias nobody owns are a candidate; other kinds are not', () => {
        const build = assembleWorld({
            records: [
                passport('Lyra', ['Ly']),
                passport('Lysander', ['Ly']),
                entry('item', 'Lyre', ['Ly'], 5),
                entry('place', 'Lymouth', ['Ly'], 6),
            ],
        });
        expect(build.candidates).toEqual([
            { a: 'character:lyra', b: 'character:lysander', reason: 'sharedName', score: 0.6, name: 'Ly' },
        ]);
        expect(resolveName(build, 'Ly')).toBeUndefined();
        expect(resolveName(build, 'Ly', 'item')?.id).toBe('item:lyre');
    });

    it('two cards are never glued by an alias', () => {
        const other = passport('', ['Энни']);
        other.name = 'Анна Петрова';
        other.source = { kind: 'card', ref: 'anna-p.png', label: 'Анна Петрова' };
        const build = assembleWorld({ records: [card('Энни'), other] });
        expect(build.entities).toHaveLength(2);
        expect(build.candidates.map((candidate) => candidate.reason)).toEqual(['anchors']);
    });
});

describe('assembleWorld: attach, index and ids', () => {
    const source = (uid: number): WorldSource => ({
        kind: 'lore.entry',
        ref: `Book#${uid}`,
        label: `#${uid}`,
        world: 'Book',
        uid,
    });

    it('attaches untyped entries to the one entity they name', () => {
        const build = assembleWorld({
            records: [card('Elizabeth'), roster('Боб'), entry('item', 'Боб')],
            attach: [
                { names: ['elizabeth'], source: source(10) },
                { names: ['Elizabeth'], source: source(10) },
                { names: ['Боб'], source: source(11) },
                { names: ['Никто'], source: source(12) },
            ],
        });
        const elizabeth = entityById(build, 'character:elizabeth')!;
        expect(elizabeth.sources.filter((item) => item.ref === 'Book#10')).toHaveLength(1);
        expect(build.entities.some((entity) => entity.sources.some((item) => item.ref === 'Book#11'))).toBe(false);
    });

    it('resolves names before aliases before forms, people first between kinds', () => {
        const build = assembleWorld({
            records: [roster('Роза'), entry('item', 'Роза'), passport('Анна', ['Нюра']), roster('Нюра Иванова')],
            forms: (name) => forms[name] ?? [],
        });
        expect(resolveName(build, 'Роза')?.kind).toBe('character');
        expect(resolveName(build, 'Роза', 'item')?.kind).toBe('item');
        expect(resolveName(build, 'Анной')?.name).toBe('Анна');
        expect(resolveName(build, '')).toBeUndefined();
        expect(resolveName(build, 'Никто')).toBeUndefined();
        const twoPeople = assembleWorld({
            records: [roster('Роза'), persona('Роза Мира'), entry('item', 'Роза')],
            decisions: { aliases: { Роза: 'persona:роза мира' }, merged: {}, separated: [] },
        });
        expect(resolveName(twoPeople, 'Роза')).toBeDefined();
    });

    it('sorts by kind then name and keeps ids unique', () => {
        const odd: WorldRecord = {
            kind: 'place',
            id: 'character:bob',
            name: 'Bob’s Inn',
            source: { kind: 'place', ref: 'p9', label: 'Bob’s Inn' },
            rank: 1,
        };
        const build = assembleWorld({ records: [odd, card('Bob'), persona('Я сам'), entry('faction', 'Орден')] });
        expect(build.entities.map((entity) => entity.kind)).toEqual(['persona', 'character', 'place', 'faction']);
        expect(new Set(build.entities.map((entity) => entity.id)).size).toBe(4);
        expect(build.entities.find((entity) => entity.kind === 'character')?.id).toBe('character:bob~2');
    });
});
