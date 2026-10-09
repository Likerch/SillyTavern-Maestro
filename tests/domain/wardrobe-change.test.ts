import { describe, expect, it } from 'vitest';
import {
    detectOutfitChange,
    finalChanges,
    maskSpeech,
    matchOutfitName,
    mentionsChange,
    nominative,
    withoutGarments,
} from '../../src/domain/wardrobe-change';
import type { ChangeOptions, OutfitChange } from '../../src/domain/wardrobe-change';
import { mentionsClothing } from '../../src/domain/wardrobe-wear';

const CAST = [{ name: 'Вера' }, { name: 'Офелия' }, { name: 'Кай' }];
const OUTFITS = {
    persona: ['Домашнее', 'Вечернее платье'],
    Вера: ['Домашняя одежда', 'Пижама'],
    Офелия: ['Домашнее'],
};

function player(text: string, options: ChangeOptions = {}): OutfitChange[] {
    return detectOutfitChange(text, CAST, { persona: 'Алекс', outfits: OUTFITS, ...options });
}

function narration(text: string, options: ChangeOptions = {}): OutfitChange[] {
    return detectOutfitChange(text, CAST, {
        persona: 'Алекс',
        outfits: OUTFITS,
        speaker: 'narrator',
        narrator: 'Вера',
        ...options,
    });
}

/** who / kind / outfit of each change, compact. */
const short = (changes: OutfitChange[]) =>
    changes.map((change) => [change.who, change.kind, change.outfitName ?? change.garments.join(' | ')].join(' · '));

describe('the player’s message', () => {
    it('reads the first person as the persona and names the outfit «в домашнее»', () => {
        expect(player('Переодеваюсь в домашнее.')).toEqual([
            {
                who: 'persona',
                kind: 'change',
                phrase: 'Переодеваюсь в домашнее.',
                garments: [],
                into: 'домашнее',
                outfitName: 'Домашнее',
            },
        ]);
        expect(short(player('Я переодеваюсь в домашнее и иду на кухню.'))).toEqual(['persona · change · Домашнее']);
        expect(short(player('Я переоденусь в домашнее.'))).toEqual(['persona · change · Домашнее']);
        expect(short(player('Пошла переодеться в вечернее платье.'))).toEqual(['persona · change · Вечернее платье']);
        expect(short(player('Ё-моё, переодеваюсь в домашнее'))).toEqual(['persona · change · Домашнее']);
    });

    it('takes garments as written, back in the nominative, and drops the first person without a subject', () => {
        expect(short(player('Переоделся в пижаму и лёг.'))).toEqual(['persona · change · пижама']);
        expect(short(player('*Снимаю куртку и вешаю её на крючок.*'))).toEqual(['persona · remove · куртка']);
        expect(short(player('Сняла с себя всё.'))).toEqual(['persona · undress · ']);
        expect(player('Я надела красную юбку и белую блузку.')[0]?.garments).toEqual(['красная юбка и белая блузка']);
        expect(short(player('Алекс накинул кожаную куртку.'))).toEqual(['persona · change · кожаная куртка']);
    });

    it('knows who else changes: a name in the clause, «ты» for the one character present', () => {
        expect(short(player('Я смотрю, как Вера переодевается.'))).toEqual(['Вера · change · ']);
        expect(short(player('Вера смотрит, как я переодеваюсь в домашнее.'))).toEqual(['persona · change · Домашнее']);
        expect(short(detectOutfitChange('Ты снимаешь плащ.', [{ name: 'Вера' }], { persona: 'Алекс' }))).toEqual([
            'Вера · remove · плащ',
        ]);
        expect(short(player('Ты снимаешь плащ.'))).toEqual(['? · remove · плащ']);
    });

    it('leaves out wishes, conditions, orders, questions, negations and speech', () => {
        for (const text of [
            'Хочу переодеться.',
            'Надо бы переодеться.',
            'Мне нужно переодеться в сухое.',
            'Переоденься!',
            'Сними куртку, тут жарко.',
            'Надень платье.',
            'Раздевайся.',
            '— Переоденься, — говорю я Вере.',
            '"Я переоденусь", — говорю я и выхожу.',
            '«Сейчас переоденусь», — отвечаю.',
            'Вера предлагает мне переодеться.',
            'Если переоденусь, опоздаю.',
            'Я бы переоделась, но некогда.',
            'Переоделась бы, да лень.',
            'Ты переоделась?',
            'Может, переодеться?',
            'Я не переодеваюсь.',
            'Так и не переоделась.',
            'Я собираюсь переодеться.',
            'Давай переоденемся.',
        ]) {
            expect(player(text), text).toEqual([]);
        }
    });

    it('does not take idioms and minor things for a change of clothes', () => {
        for (const text of [
            'Снимаю очки и тру глаза.',
            'Сняла кольцо.',
            'Я снял квартиру в центре.',
            'Сняла с себя ответственность.',
            'Снимаю напряжение.',
            'Надела маску безразличия.',
            'Надеваю шляпу.',
            'Скинула туфли.',
            'Одела ребёнка.',
            'Сменила тему.',
            'Надеюсь, ты не против.',
            'Обернулась к двери.',
            'Осталась дома.',
        ]) {
            expect(player(text), text).toEqual([]);
        }
    });
});

describe('the narration of a reply', () => {
    it('names who by name, case forms and the sentence before', () => {
        expect(short(narration('Вера переоделась в домашнее.'))).toEqual(['Вера · change · Домашняя одежда']);
        expect(short(narration('Офелия вошла. Она переоделась в домашнее.'))).toEqual(['Офелия · change · Домашнее']);
        expect(short(narration('Офелия вошла. Переоделась в домашнее.'))).toEqual(['Офелия · change · Домашнее']);
        expect(short(narration('Переодевшись в пижаму, Вера легла спать.'))).toEqual(['Вера · change · Пижама']);
        expect(short(narration('Вера сняла с Офелии плащ.'))).toEqual(['Офелия · remove · плащ']);
        expect(short(narration('Он натянул свитер.'))).toEqual(['Кай · change · свитер']);
        // Two women present: «она» alone does not tell.
        expect(short(narration('Она сняла плащ и повесила его на крючок.'))).toEqual(['? · remove · плащ']);
        expect(
            short(narration('Анна стянула свитер.', { outfits: {} }).map((change) => ({ ...change, who: change.who }))),
        ).toEqual(['? · remove · свитер']);
    });

    it('takes the second person for the persona and the first person for the narrator', () => {
        expect(short(narration('Ты снимаешь куртку.'))).toEqual(['persona · remove · куртка']);
        expect(short(narration('Я переоделась в домашнее.'))).toEqual(['Вера · change · Домашняя одежда']);
        expect(short(narration('Вера надела на тебя плащ.'))).toEqual(['persona · change · плащ']);
        expect(short(narration('Алекс снял куртку.'))).toEqual(['persona · remove · куртка']);
    });

    it('reads undressing and how far', () => {
        expect(narration('Вера разделась до белья.')[0]).toMatchObject({ kind: 'undress', undress: 'underwear' });
        expect(narration('Офелия разделась и нырнула в озеро.')[0]).toMatchObject({
            who: 'Офелия',
            kind: 'undress',
            undress: 'naked',
        });
        expect(narration('Вера обернулась полотенцем.')[0]).toMatchObject({ kind: 'undress', undress: 'towel' });
        expect(narration('Вера осталась в одном белье.')[0]).toMatchObject({ kind: 'undress', undress: 'underwear' });
        expect(narration('Кай разделся до пояса.')[0]).toMatchObject({ who: 'Кай', undress: 'partial' });
        expect(narration('Кай оделся.')[0]).toMatchObject({ who: 'Кай', kind: 'dress', garments: [] });
    });

    it('keeps the list of things taken off and stops at the next action', () => {
        expect(narration('Офелия сняла плащ, шарф и перчатки, оставшись в лёгком платье.')).toEqual([
            {
                who: 'Офелия',
                kind: 'remove',
                phrase: 'сняла плащ, шарф и перчатки',
                garments: ['плащ', 'шарф и перчатки'],
                into: '',
            },
        ]);
        expect(short(narration('Вера стянула с себя мокрое платье.'))).toEqual(['Вера · remove · мокрое платье']);
        expect(short(narration('Вера сменила платье на джинсы.'))).toEqual(['Вера · change · джинсы']);
        expect(short(narration('Вера сменила одежду.'))).toEqual(['Вера · change · ']);
    });

    it('does not take the future, wishes or speech in the narration', () => {
        for (const text of [
            'Вера переоденется позже.',
            'Вера не стала переодеваться.',
            'Вера так и не переоделась.',
            'Если она переоденется, мы опоздаем.',
            'Вера переоделась бы, но не успела.',
            '«Я переоденусь», — сказала Вера.',
            '— Переоденься, — бросила Вера. — Мы опаздываем.',
            'Вера хотела переодеться.',
            'Кай снял очки.',
            'Кай снял квартиру в центре.',
            'Вера надела маску безразличия.',
            'Он снялся в кино.',
            'Вера скинула туфли.',
        ]) {
            expect(narration(text), text).toEqual([]);
        }
    });

    it('takes the action of a dash dialogue line, not its speech', () => {
        expect(short(narration('— Подожди, — сказала Вера и сняла плащ.'))).toEqual(['Вера · remove · плащ']);
    });
});

describe('English', () => {
    const cast = [{ name: 'Ophelia' }, { name: 'Kai' }];
    const en = (text: string, speaker: 'player' | 'narrator' = 'narrator') =>
        short(detectOutfitChange(text, cast, { persona: 'Alex', speaker, outfits: { persona: ['Pajamas'] } }));

    it('reads changes, removals, dressing and undressing', () => {
        expect(en('I change into my pajamas.', 'player')).toEqual(['persona · change · Pajamas']);
        expect(en('I went upstairs to change into something warm.', 'player')).toEqual(['persona · change · ']);
        expect(en('She slips into a silk robe.')).toEqual(['Ophelia · change · silk robe']);
        expect(en('Ophelia took off her cloak.')).toEqual(['Ophelia · remove · cloak']);
        expect(en('Kai pulled his sweater on.')).toEqual(['Kai · change · sweater']);
        expect(en('He got dressed.')).toEqual(['Kai · dress · ']);
        expect(en('You undress slowly.')).toEqual(['persona · undress · ']);
        expect(
            detectOutfitChange('Ophelia stripped down to her underwear.', cast, { speaker: 'narrator' })[0],
        ).toMatchObject({ who: 'Ophelia', kind: 'undress', undress: 'underwear' });
    });

    it('leaves out orders, states, wishes, negations and the future of the narration', () => {
        for (const text of [
            'Take off your coat!',
            'Change into something dry.',
            'She is dressed in a red gown.',
            "She doesn't want to change.",
            'Ophelia wants to change into her robe.',
            'She will change into the dress later.',
            'Kai never took off his armor.',
            'He took off his glasses.',
            'The plane took off.',
            'Did she change into the dress?',
            '"I will change," she said.',
        ]) {
            expect(en(text), text).toEqual([]);
        }
    });
});

describe('helpers', () => {
    it('maskSpeech blanks quotes and dash dialogue but keeps the length', () => {
        const text = '— Я переоденусь, — сказала она. — Жди.\n«Сниму плащ», — подумал Кай. Он снял "это".';
        const masked = maskSpeech(text);
        expect(masked).toHaveLength(text.length);
        expect(masked).not.toContain('переоденусь');
        expect(masked).not.toContain('Жди');
        expect(masked).toContain('сказала она');
        expect(masked).not.toContain('Сниму');
        expect(masked).toContain('подумал Кай. Он снял');
    });

    it('matchOutfitName finds the outfit a phrase names, or none when unclear', () => {
        expect(matchOutfitName('домашнее', ['Домашнее', 'Вечернее платье'])).toBe('Домашнее');
        expect(matchOutfitName('домашнее', ['Домашняя одежда'])).toBe('Домашняя одежда');
        expect(matchOutfitName('вечернее платье', ['Вечернее', 'Платье'])).toBeNull();
        expect(matchOutfitName('вечернее платье', ['Вечернее платье', 'Платье'])).toBe('Вечернее платье');
        expect(matchOutfitName('домашнее', ['Домашнее платье', 'Домашняя пижама'])).toBeNull();
        expect(matchOutfitName('пижаму', ['Пижама', 'Халат'])).toBe('Пижама');
        expect(matchOutfitName('something warm', ['Pajamas'])).toBeNull();
        expect(matchOutfitName('', ['Пижама'])).toBeNull();
    });

    it('nominative turns accusative clothes back', () => {
        expect(nominative('красную юбку и белую блузку')).toBe('красная юбка и белая блузка');
        expect(nominative('синюю мантию')).toBe('синяя мантия');
        expect(nominative('плащ и сапоги')).toBe('плащ и сапоги');
        expect(nominative('silk robe')).toBe('silk robe');
    });

    it('finalChanges keeps the last change per person and merges removals', () => {
        const changes = player('Сняла платье и надела пижаму. Сняла носки.');
        expect(short(finalChanges(changes))).toEqual(['persona · change · пижама']);
        const removals = finalChanges(narration('Вера сняла плащ. Вера сняла свитер. Кай оделся.'));
        expect(short(removals)).toEqual(['Вера · remove · плащ | свитер', 'Кай · dress · ']);
    });

    it('withoutGarments takes the removed things out of a wording', () => {
        expect(withoutGarments('серый плащ, белое платье и сапоги', ['плащ'])).toBe('белое платье, сапоги');
        expect(withoutGarments('серый плащ', ['плащ'])).toBeNull();
        expect(withoutGarments('белое платье', ['плащ'])).toBeNull();
        expect(withoutGarments('белое платье', ['квартиру'])).toBeNull();
    });

    it('mentionsChange and mentionsClothing open the gate for «переодеваюсь в домашнее»', () => {
        expect(mentionsChange('переодеваюсь в домашнее')).toBe(true);
        expect(mentionsChange('She slips into a robe')).toBe(true);
        expect(mentionsChange('Погода хорошая')).toBe(false);
        expect(mentionsClothing('переодеваюсь в домашнее')).toBe(true);
        expect(mentionsClothing('Снял куртку')).toBe(true);
        expect(mentionsClothing('Надежда умирает последней')).toBe(false);
    });
});
