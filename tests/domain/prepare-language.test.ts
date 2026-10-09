// «Язык истории» in the pure parts of M37: a plan read for a Russian story (Russian names, the original spelling in
// `english`, Russian outfits; secrets and promises with their Russian lines) — titles in the player's language, canon
// texts that name other items in English, the wardrobe statement of a Russian outfit, and no duplicates when a Russian
// plan meets what an English one (or an older Maestro) made before.
import { describe, expect, it } from 'vitest';
import {
    canonDraftOf,
    englishNames,
    outfitStatement,
    startNames,
    startNoteDraft,
} from '../../src/domain/prepare-apply';
import { emptySnapshot, markExisting, mergeItems, reusePlan } from '../../src/domain/prepare-merge';
import { emptyData, itemIdOf, itemTitle, playerText } from '../../src/domain/prepare-plan';
import type { AnyPrepareItem, PrepareDataMap, PrepareItem, PrepareKind } from '../../src/domain/prepare-plan';
import { russianOutfitName } from '../../src/domain/wardrobe-names';
import { outfitFromStatement, outfitTagList } from '../../src/domain/wardrobe-tags';

function item<K extends PrepareKind>(
    kind: K,
    data: Partial<PrepareDataMap[K]>,
    extra: Partial<AnyPrepareItem> = {},
): AnyPrepareItem {
    const full = { ...emptyData(kind), ...data } as PrepareDataMap[K];
    return {
        id: itemIdOf(kind, full),
        kind,
        data: full,
        russian: '',
        sources: [],
        scope: 'chat',
        ...extra,
    } as AnyPrepareItem;
}

/** A Russian story's plan of an English card. */
const ophelia = item('character', {
    name: 'Офелия',
    english: 'Ophelia',
    forms: ['Офелии', 'Офелию'],
    relations: [{ to: 'Томас', relation: 'Her older brother.' }],
    outfit: 'тёмно-зелёный плащ',
});
const thomas = item('character', { name: 'Томас', english: 'Thomas', forms: ['Томаса'] });
const reaches = item('place', { name: 'Вельмарские пределы', english: 'Velmar Reaches' });
const tavern = item('place', {
    name: 'Таверна «Солёный якорь»',
    english: 'Salt Anchor Tavern',
    forms: ['Солёный якорь'],
    parent: 'Вельмарские пределы',
});
const winter = item('tradition', { name: 'Долгая зима', english: 'The Long Winter' });
const house = item('faction', { name: 'Дом Арден', english: 'House Arden', leader: 'Офелия' });
const secret = item(
    'secret',
    { text: 'Ophelia knows more about the missing cargo than she says.', about: 'Офелия', knownBy: ['Офелия'] },
    { russian: 'Офелия знает о пропавшем грузе больше, чем говорит.' },
);
const promise = item(
    'promise',
    { who: ['Томас'], toWhom: ['Кай'], what: 'Thomas will pay the debt by spring.' },
    { russian: 'Томас вернёт долг к весне.' },
);
const plan = [ophelia, thomas, reaches, tavern, winter, house, secret, promise];

describe('a Russian story: titles in the player language', () => {
    it("shows a secret's and a promise's Russian line, the English text otherwise", () => {
        expect(itemTitle(promise, 'ru')).toBe('Томас вернёт долг к весне.');
        expect(itemTitle(promise, 'en')).toBe('Thomas will pay the debt by spring.');
        expect(itemTitle(promise)).toBe('Thomas will pay the debt by spring.');
        expect(itemTitle(secret, 'ru')).toBe('Офелия');
        const nameless = item('secret', { text: 'A hidden door.' }, { russian: 'Потайная дверь.' });
        expect(itemTitle(nameless, 'ru')).toBe('Потайная дверь.');
        expect(playerText(secret as PrepareItem<'secret'>, 'ru')).toBe(secret.russian);
        // A text the user wrote in Russian stays; no Russian line: the text.
        const edited = item('promise', { what: 'Вернёт долг.' }, { russian: 'Другое.' });
        expect(playerText(edited as PrepareItem<'promise'>, 'ru')).toBe('Вернёт долг.');
        const bare = item('promise', { what: 'Pays.' });
        expect(playerText(bare as PrepareItem<'promise'>, 'ru')).toBe('Pays.');
        expect(itemTitle(tavern, 'ru')).toBe('Таверна «Солёный якорь»');
    });
});

describe('a Russian story: the canon stays English', () => {
    const en = englishNames(plan);

    it('maps the plan names (name, English name, forms) to English, people first for people, places for places', () => {
        expect(en('Офелия')).toBe('Ophelia');
        expect(en('офелию')).toBe('Ophelia');
        expect(en('Ophelia')).toBe('Ophelia');
        expect(en('Солёный якорь', 'place')).toBe('Salt Anchor Tavern');
        expect(en('Кай')).toBe('Кай');
        expect(en('{{user}}')).toBe('{{user}}');
        // The same name as a place and a person: the field says which.
        const twin = englishNames([
            item('place', { name: 'Вера', english: 'Faith Hall' }),
            item('character', { name: 'Вера', english: 'Vera' }),
        ]);
        expect(twin('Вера')).toBe('Vera');
        expect(twin('Вера', 'place')).toBe('Faith Hall');
    });

    it('writes English titles and English names of other items; the Russian names are keys and aliases', () => {
        const character = canonDraftOf(ophelia, { english: en })!;
        expect(character.title).toBe('Ophelia');
        expect(character.fields.aliases).toBe('Офелия');
        expect(character.fields.relationships).toBe('Thomas: Her older brother.');
        expect(character.keys).toEqual(['Офелия', 'Ophelia', 'Офелии', 'Офелию']);
        const place = canonDraftOf(tavern, { english: en })!;
        expect(place.title).toBe('Salt Anchor Tavern');
        expect(place.fields.location).toBe('Velmar Reaches');
        expect(canonDraftOf(house, { english: en })!.fields.leader).toBe('Ophelia');
        expect(canonDraftOf(winter, { english: en })!.title).toBe('The Long Winter');
        // Without the mapping (an English story): as given.
        expect(canonDraftOf(house)!.fields.leader).toBe('Офелия');
    });

    it('names the place and the cast of the start note in English, the Russian place stays a key', () => {
        const scene = {
            ...emptyData('scene'),
            place: 'Таверна «Солёный якорь»',
            present: ['Офелия', 'Томас'],
            situation: 'Ophelia waits.',
        };
        const names = startNames(scene, en)!;
        expect(names).toEqual({ place: 'Salt Anchor Tavern', present: ['Ophelia', 'Thomas'] });
        const note = startNoteDraft(scene, names)!;
        expect(note.content).toContain('Where: Salt Anchor Tavern');
        expect(note.content).toContain('Present: Ophelia, Thomas');
        expect(note.keys).toEqual(
            expect.arrayContaining(['начало истории', 'Таверна «Солёный якорь»', 'Salt Anchor Tavern']),
        );
        // Names that are their own English: nothing to keep.
        expect(startNames({ ...scene, place: 'Fort', present: ['Kai'] }, en)).toBeNull();
        expect(startNoteDraft(scene)!.content).toContain('Where: Таверна «Солёный якорь»');
    });
});

describe('a Russian story: the starting outfit for the wardrobe', () => {
    it('is a Russian statement the wardrobe parser reads back to the wording', () => {
        const statement = outfitStatement({ name: 'Офелия', english: 'Ophelia', wearing: 'тёмно-зелёный плащ' });
        expect(statement).toBe('Офелия носит: тёмно-зелёный плащ');
        expect(outfitFromStatement(statement)).toBe('тёмно-зелёный плащ');
        expect(
            outfitFromStatement(
                outfitStatement({ name: 'Вера', english: '', wearing: 'стёганая куртка портовой стражи' }),
            ),
        ).toBe('стёганая куртка портовой стражи');
        // An English wording keeps today's sentence.
        const english = outfitStatement({ name: 'Вера', english: 'Vera', wearing: 'a quilted watch jacket' });
        expect(english).toBe('Vera wears a quilted watch jacket');
        expect(outfitFromStatement(english)).toBe('a quilted watch jacket');
    });

    it('gives NAI tags and a Russian outfit name from the Russian wording', () => {
        const tags = outfitTagList('тёмно-зелёный плащ и высокие сапоги');
        expect(tags.map((tag) => tag.tag)).toEqual(expect.arrayContaining(['boots']));
        expect(tags.some((tag) => tag.tag.endsWith('cloak'))).toBe(true);
        expect(russianOutfitName(tags, 'тёмно-зелёный плащ и высокие сапоги')).toBe('Зелёный плащ');
        const jacket = outfitTagList('стёганая куртка портовой стражи');
        expect(jacket.map((tag) => tag.tag)).toEqual(['jacket']);
        expect(russianOutfitName(jacket, 'стёганая куртка портовой стражи')).toBe('Куртка');
    });

    it('reads the other Russian ways to say it, and still refuses a removal', () => {
        expect(outfitFromStatement('Офелия одета в тёмно-зелёный плащ')).toBe('тёмно-зелёный плащ');
        expect(outfitFromStatement('Теперь надела белое платье')).toBe('белое платье');
        expect(outfitFromStatement('Одежда — кожаная куртка')).toBe('кожаная куртка');
        expect(outfitFromStatement('Офелия сняла плащ')).toBeNull();
    });
});

describe('a Russian story meets what English names made before: no duplicates', () => {
    /** What an older (English) preparation of the chat left: canon entries, places, passports, a secret and a promise. */
    const snapshot = {
        ...emptySnapshot(),
        canon: [
            { uid: 1, type: 'character', title: 'Ophelia', keys: ['Ophelia'], content: 'Character: Ophelia' },
            { uid: 2, type: 'tradition', title: 'The Long Winter', keys: ['The Long Winter'], content: '' },
            { uid: 3, type: 'faction', title: 'House Arden', keys: ['House Arden'], content: '' },
        ],
        places: [
            { id: 'p1', name: 'Velmar Reaches', aliases: [], forms: [] },
            { id: 'p2', name: 'Salt Anchor Tavern', aliases: [], forms: [] },
        ],
        passports: [{ id: 'nai-1', name: 'Ophelia', aliases: [] }],
        promises: ['Thomas will pay the debt by spring.'],
        secrets: ['Офелия знает о пропавшем грузе больше, чем говорит.', 'Ophelia knows more about the missing cargo.'],
    };

    it('marks every Russian-named item as existing by its English name', () => {
        const marked = markExisting(plan, snapshot);
        const byId = new Map(marked.map((row) => [row.id, row]));
        expect(byId.get(ophelia.id)).toMatchObject({
            exists: { where: 'canon', ref: 1 },
            links: { canonUid: 1, passportId: 'nai-1' },
        });
        expect(byId.get(reaches.id)).toMatchObject({ exists: { where: 'places', ref: 'p1' } });
        expect(byId.get(tavern.id)?.links).toMatchObject({ placeId: 'p2' });
        expect(byId.get(winter.id)?.exists?.ref).toBe(2);
        expect(byId.get(house.id)?.exists?.ref).toBe(3);
        // Secrets and promises: by the English text or by the Russian line the chat stores.
        expect(byId.get(promise.id)?.exists?.where).toBe('calendar');
        expect(byId.get(secret.id)?.exists?.where).toBe('knowledge');
        expect(byId.get(thomas.id)?.exists).toBeUndefined();
    });

    it('keeps the ids of the English plan and merges an old English item into the Russian one', () => {
        const old = item('character', { name: 'Ophelia', english: 'Ophelia', appearance: 'Red hair.' });
        expect(old.id).toBe(ophelia.id);
        const merged = mergeItems([[ophelia], [old]]);
        expect(merged).toHaveLength(1);
        expect(merged[0]!.data).toMatchObject({ name: 'Офелия', english: 'Ophelia', appearance: 'Red hair.' });
        expect((merged[0]!.data as { forms: string[] }).forms).not.toContain('Ophelia');
        const oldPlace = item('place', { name: 'Velmar Reaches', english: 'Velmar Reaches' });
        expect(mergeItems([[reaches, oldPlace]])).toHaveLength(1);
        // A saved analysis with English names: unchanged items are kept as they are (the feature reads them again
        // when the language differs, see the service).
        expect(reusePlan([old], { changed: [], added: [], removed: [] }, []).kept).toHaveLength(1);
    });
});
