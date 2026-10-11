import { describe, expect, it } from 'vitest';
import { DEPARTURE_LOOKBACK, departedCharacters } from '../../src/domain/scene-departures';
import type { DepartureCandidate } from '../../src/domain/scene-departures';

const VERA: DepartureCandidate = { name: 'Вера', names: ['Vera'], forms: ['Вера', 'Веры', 'Вере', 'Веру', 'Верой'] };
const MARTIN: DepartureCandidate = {
    name: 'Мартин',
    names: [],
    forms: ['Мартин', 'Мартина', 'Мартину', 'Мартином', 'Мартине'],
};
const ANNA: DepartureCandidate = { name: 'Anna', names: [], forms: [] };
const MARK: DepartureCandidate = { name: 'Mark', names: [], forms: [] };
const CAST = [VERA, MARTIN];

const reply = (mes: string) => ({ mes, is_user: false, name: 'Рассказчик' });
const user = (mes: string) => ({ mes, is_user: true, name: 'Кай' });

/** The chat as it is while the next reply is generated: the player's message last. */
function departed(messages: string[], cast = CAST, player = 'Дальше.'): string[] {
    return departedCharacters([...messages.map(reply), user(player)], cast);
}

describe('departedCharacters: leaving', () => {
    it('an exit verb next to the name in the nominative', () => {
        expect(departed(['Вера кивнула и вышла из комнаты.'])).toEqual(['Вера']);
        expect(departed(['Мартин ушёл, не попрощавшись.'])).toEqual(['Мартин']);
        expect(departed(['— Пока, — бросила Вера и покинула таверну.'])).toEqual(['Вера']);
        expect(departed(['Ушла и Вера.'])).toEqual(['Вера']);
    });

    it('the verb belongs to the subject whose gender agrees, not to a name in another case', () => {
        expect(departed(['Мартин вышел, оставив Веру одну у окна.'])).toEqual(['Мартин']);
        expect(departed(['Вера смотрела, как Мартин скрылся за поворотом.'])).toEqual(['Мартин']);
        expect(departed(['Мартин смотрел, как Вера удалилась.'])).toEqual(['Вера']);
    });

    it('a relative clause, a pronoun after a sentence about them, a door that closed behind them', () => {
        expect(departed(['Мартин проводил взглядом Веру, которая направилась к выходу.'])).toEqual(['Вера']);
        expect(departed(['Вера поставила чашку. Она вышла, не сказав ни слова.'])).toEqual(['Вера']);
        expect(departed(['Вера встала. Дверь за ней тихо закрылась.'])).toEqual(['Вера']);
        expect(departed(['За Верой захлопнулась дверь.'])).toEqual(['Вера']);
    });

    it('a plural verb takes everyone named in the nominative', () => {
        expect(departed(['Вера и Мартин ушли вместе.']).sort()).toEqual(['Вера', 'Мартин']);
    });

    it('English: exit phrases and the nearest name', () => {
        const cast = [ANNA, MARK];
        expect(departed(['Anna left the room without a word.'], cast)).toEqual(['Anna']);
        expect(departed(['Anna watched as Mark walked out.'], cast)).toEqual(['Mark']);
        expect(departed(['The door closed behind Mark.'], cast)).toEqual(['Mark']);
        expect(departed(['Anna left the cup on the shelf.'], cast)).toEqual([]);
    });

    it('steps forward, comes out to someone, «выходит, что…» and «направилась к столу» are no exits', () => {
        expect(departed(['Вера вышла вперёд.'])).toEqual([]);
        expect(departed(['Вера вышла к гостям.'])).toEqual([]);
        expect(departed(['Выходит, Вера была права.'])).toEqual([]);
        expect(departed(['Вера направилась к столу.'])).toEqual([]);
        expect(departed(['Улыбка исчезла с лица Веры.'])).toEqual([]);
        expect(departed(['«Мартин ушёл», — сказала Вера.'])).toEqual([]);
    });
});

describe('departedCharacters: coming back', () => {
    it('a later reply where they act or speak brings them back', () => {
        expect(departed(['Вера вышла.', 'Через минуту Вера вернулась с подносом.'])).toEqual([]);
        expect(departed(['Вера вышла. Вскоре Вера вернулась.'])).toEqual([]);
    });

    it('a mention in another case, after a preposition or inside speech does not', () => {
        expect(departed(['Вера вышла.', 'Мартин посмотрел на дверь, думая о Вере.'])).toEqual(['Вера']);
        expect(departed(['Вера вышла.', '«Вера скоро вернётся», — сказал Мартин.'])).toEqual(['Вера']);
        expect(departed(['Вера вышла.', 'Мартин налил себе вина.'])).toEqual(['Вера']);
    });

    it('the player brings them by naming them, not by asking about them', () => {
        expect(departed(['Вера вышла.'], CAST, 'Я догоняю Веру.')).toEqual([]);
        expect(departed(['Вера вышла.'], CAST, 'Где Вера?')).toEqual(['Вера']);
        expect(departed(['Вера вышла.'], CAST, 'Вера уходит, а я остаюсь.')).toEqual(['Вера']);
    });

    it('the newest reply decides when it shows them leaving again', () => {
        expect(departed(['Вера вышла.', 'Вера вернулась.', 'Вера снова ушла.'])).toEqual(['Вера']);
    });
});

describe('departedCharacters: what is read', () => {
    it('only committed replies count: a reply after the last player message (a swipe) does not', () => {
        const chat = [reply('Вера налила чай.'), user('Дальше.'), reply('Вера вышла.')];
        expect(departedCharacters(chat, CAST)).toEqual([]);
        expect(departedCharacters([...chat, { is_user: true }], CAST)).toEqual(['Вера']);
    });

    it('the tracker JSON and the offscreen block are not narration', () => {
        const tracker = '```json\n{"characters":[{"name":"Вера"}]}\n```\n';
        expect(departed([`${tracker}Мартин налил чай.\n<offscreen>Вера вышла из дома.</offscreen>`])).toEqual([]);
        expect(departed([`${tracker}Вера вышла.\n<offscreen>Мартин уехал в город.</offscreen>`])).toEqual(['Вера']);
    });

    it('looks back at most DEPARTURE_LOOKBACK replies; system messages and an empty chat are skipped', () => {
        const filler = Array.from({ length: DEPARTURE_LOOKBACK }, () => 'Мартин налил чай.');
        expect(departed(['Вера вышла.', ...filler])).toEqual([]);
        expect(departed(['Вера вышла.', ...filler.slice(1)])).toEqual(['Вера']);
        expect(departedCharacters([{ mes: 'Вера вышла.', is_system: true }, user('x')], CAST)).toEqual([]);
        expect(departedCharacters([], CAST)).toEqual([]);
        expect(departedCharacters([reply('Вера вышла.')], CAST)).toEqual([]);
        expect(departedCharacters([reply('Вера вышла.'), user('x')], [])).toEqual([]);
    });

    it('without case forms a Russian name is matched by its stem', () => {
        const bare: DepartureCandidate = { name: 'Мира', names: [], forms: [] };
        expect(departed(['Кай проводил взглядом Миру, которая ушла прочь.'], [bare])).toEqual(['Мира']);
        expect(departed(['Мира ушла.'], [bare])).toEqual(['Мира']);
    });
});
