// M25 check detection in the user's message: RU/EN trigger stems, Russian endings, negations, questions, OOC and
// quoted speech, speech checks (quoted lines and questions count), the acting holder, the strongest match, two
// different checks in different clauses, the difficulty from words or an explicit number, and the named target.
import { describe, expect, it } from 'vitest';
import {
    detectCheck,
    detectChecks,
    difficultyLevel,
    difficultyWord,
    explicitDifficulty,
    namedHolders,
    namedTarget,
    normalizeWord,
    stemOf,
    storyPart,
    tokenize,
    triggerStems,
} from '../../src/domain/mechanics-checks';
import type { ActorNames, CheckTrigger } from '../../src/domain/mechanics-checks';

const PERSUASION: CheckTrigger = {
    mechanicId: 'social',
    checkId: 'persuasion',
    triggers: ['убедить', 'уговор', 'persuade', 'convince'],
};
const STEALTH: CheckTrigger = { mechanicId: 'social', checkId: 'stealth', triggers: ['крад', 'скрытн', 'sneak'] };
const LOCKS: CheckTrigger = { mechanicId: 'thief', checkId: 'locks', triggers: ['взлом', 'pick lock'] };
const CHECKS = [PERSUASION, STEALTH, LOCKS];

const ACTORS: ActorNames[] = [
    { holder: 'Kai', names: ['Kai', 'Кай'] },
    { holder: 'Elizabeth', names: ['Elizabeth', 'Элизабет', 'Лиз'] },
];

function detect(text: string, actors: ActorNames[] = ACTORS) {
    return detectCheck(text, CHECKS, actors);
}

describe('text', () => {
    it('normalizes words and tokens', () => {
        expect(normalizeWord('Ёлка’s')).toBe("елка's");
        expect(tokenize('Я — не пытаюсь, don’t try!')).toEqual(['я', 'не', 'пытаюсь', "don't", 'try']);
    });

    it('drops OOC, brackets, macros, comments and quoted speech from the story part', () => {
        const text = [
            'Я жду. (OOC: убеди его) [note: убеди] ((убеди)) {{random::убеди}} <!-- убеди -->',
            'OOC: убеди его',
            '// убеди',
            '"Убеди меня", говорит он. «Убеди», — шепчет она. “Persuade me”. „Убеди“',
        ].join('\n');
        const story = storyPart(text);
        expect(story.toLowerCase()).not.toMatch(/убед|persuad/);
        expect(story).toContain('Я жду.');
        expect(storyPart('(a (nested (deep) убеди) b) ok')).toBe('  ok');
    });

    it('reads an explicit difficulty anywhere', () => {
        expect(explicitDifficulty('(DC 18) я пытаюсь')).toBe(18);
        expect(explicitDifficulty('сложность: 12')).toBe(12);
        expect(explicitDifficulty('Сл 9')).toBe(9);
        expect(explicitDifficulty('difficulty=25')).toBe(25);
        expect(explicitDifficulty('декабрь 12')).toBeNull();
        expect(explicitDifficulty('dc 1234')).toBeNull();
    });
});

describe('stems', () => {
    it('cut Russian and English endings once', () => {
        expect(stemOf('убедить')).toBe('убед');
        expect(stemOf('уговорить')).toBe('уговор');
        expect(stemOf('Красться')).toBe('красть');
        expect(stemOf('скрытность')).toBe('скрытн');
        expect(stemOf('убед')).toBe('убед');
        expect(stemOf('persuade')).toBe('persuad');
        expect(stemOf('hide')).toBe('hid');
        expect(stemOf('sneaking')).toBe('sneak');
        expect(stemOf('lie')).toBe('lie');
        expect(stemOf('бег')).toBe('бег');
    });

    it('give the written form and the stem form of a trigger', () => {
        expect(triggerStems('убедить')).toEqual([['убедить'], ['убед']]);
        expect(triggerStems('Pick lock')).toEqual([['pick', 'lock']]);
        expect(triggerStems('  ')).toEqual([]);
    });
});

describe('detection', () => {
    it('finds a Russian trigger with any ending', () => {
        expect(detect('Я пытаюсь убедить стражника пропустить нас.')).toMatchObject({
            mechanicId: 'social',
            checkId: 'persuasion',
            trigger: 'убедить',
            holder: null,
            level: null,
            difficulty: null,
        });
        expect(detect('Убеждаю... нет, уговариваю его.')).toBeNull();
        expect(detect('Он убедил меня.')?.checkId).toBe('persuasion');
        expect(detect('Я уговорил его.')?.checkId).toBe('persuasion');
        expect(detect('Тихо крадусь вдоль стены.')?.checkId).toBe('stealth');
    });

    it('finds English triggers and multi-word triggers', () => {
        expect(detect('I try to convince the guard.')?.trigger).toBe('convince');
        expect(detect('Kai is persuading the merchant')?.checkId).toBe('persuasion');
        expect(detect('I pick locks for a living, so I pick the lock.')?.checkId).toBe('locks');
        expect(detect('I picked a flower.')).toBeNull();
    });

    it('matches at word starts only', () => {
        expect(detect('Он был неубедителен.')).toBeNull();
        expect(detect('Переубедить его.')).toBeNull();
    });

    it('skips negated attempts', () => {
        expect(detect('Я не пытаюсь убедить его.')).toBeNull();
        expect(detect('Не уговорю его, и ладно.')).toBeNull();
        expect(detect("I don't try to persuade him.")).toBeNull();
        expect(detect('I never sneak.')).toBeNull();
        expect(detect('Уговорить его я не стану.')).toBeNull();
        expect(detect('Убедил его не делать этого.')?.checkId).toBe('persuasion');
        // A negation in another clause does not count.
        expect(detect('Не теряя времени, пытаюсь убедить его.')?.checkId).toBe('persuasion');
    });

    it('skips questions, OOC and quoted speech', () => {
        expect(detect('Может, убедить его?')).toBeNull();
        expect(detect('(OOC: попробуй его убедить) Я молчу.')).toBeNull();
        expect(detect('"Ты меня не убедишь", — говорит он. Я молчу.')).toBeNull();
        expect(detect('Can I sneak past? I sneak past.')?.checkId).toBe('stealth');
    });

    it('returns null for nothing to look at', () => {
        expect(detectCheck('', CHECKS)).toBeNull();
        expect(detectCheck('Я убеждаю', [])).toBeNull();
        expect(detectCheck('...!!!', CHECKS)).toBeNull();
        expect(detectCheck('ok', [{ mechanicId: 'm', checkId: 'c', triggers: ['', '  '] }])).toBeNull();
    });

    it('short triggers match whole words only', () => {
        const short: CheckTrigger = { mechanicId: 'm', checkId: 'hit', triggers: ['ад'] };
        expect(detectCheck('Иду в ад.', [short])?.checkId).toBe('hit');
        expect(detectCheck('Адам пришёл.', [short])).toBeNull();
    });
});

describe('the strongest match', () => {
    it('an attempt word near the trigger wins', () => {
        const found = detect('Я крадусь к воротам, а потом пытаюсь убедить стражника.');
        expect(found?.checkId).toBe('persuasion');
        expect(found?.score).toBeGreaterThan(2);
    });

    it('a longer trigger weighs more; repeated calls add a little; a tie goes to the earliest', () => {
        expect(detect('I sneak. I persuade.')?.checkId).toBe('persuasion');
        const pair: CheckTrigger[] = [
            { mechanicId: 'm', checkId: 'alpha', triggers: ['alpha'] },
            { mechanicId: 'm', checkId: 'bravo', triggers: ['bravo'] },
        ];
        expect(detectCheck('I bravo. I alpha.', pair)?.checkId).toBe('bravo');
        expect(detectCheck('I bravo. I alpha. I alpha again.', pair)?.checkId).toBe('alpha');
    });

    it('only one check per message', () => {
        const found = detect('Пытаюсь убедить его и пытаюсь взломать замок.');
        expect(found?.checkId).toBe('persuasion');
    });
});

describe('speech checks', () => {
    const SPEECH: CheckTrigger = { ...PERSUASION, speech: true };
    const INTIMIDATION: CheckTrigger = {
        mechanicId: 'social',
        checkId: 'intimidation',
        triggers: ['запуг', 'угрож', 'threaten'],
        speech: true,
    };

    it('match inside quoted speech, where other checks never look', () => {
        expect(detectCheck('«Я пытаюсь тебя убедить, послушай», — говорю я.', [PERSUASION])).toBeNull();
        expect(detectCheck('«Я пытаюсь тебя убедить, послушай», — говорю я.', [SPEECH])).toMatchObject({
            checkId: 'persuasion',
            trigger: 'убедить',
        });
        expect(detectCheck('"I am trying to convince you", I say.', [SPEECH])?.checkId).toBe('persuasion');
        expect(detectCheck('“Не смей мне угрожать”, — рычит он.', [INTIMIDATION])).toBeNull();
    });

    it('are not stopped by a question, still by a negation', () => {
        expect(detect('Может, уговорить его?')).toBeNull();
        expect(detectCheck('Может, уговорить его?', [SPEECH])?.checkId).toBe('persuasion');
        expect(detectCheck('«А если я начну угрожать?»', [INTIMIDATION])?.checkId).toBe('intimidation');
        expect(detectCheck('«Ты ведь не станешь мне угрожать?»', [INTIMIDATION])).toBeNull();
        expect(detectCheck('Я не пытаюсь его уговорить?', [SPEECH])).toBeNull();
    });

    it('a narration match keeps working for a speech check', () => {
        expect(detectCheck('Элизабет пытается убедить стражника.', [SPEECH], ACTORS)).toMatchObject({
            holder: 'Elizabeth',
        });
    });
});

describe('two checks in one message', () => {
    it('different checks matched in different clauses, strongest first', () => {
        const found = detectChecks('Я крадусь к воротам, а потом пытаюсь убедить стражника.', CHECKS, ACTORS, 2);
        expect(found.map((item) => item.checkId)).toEqual(['persuasion', 'stealth']);
        expect(detectChecks('Пытаюсь убедить его и пытаюсь взломать замок.', CHECKS, [], 2)).toHaveLength(2);
        expect(detectChecks('I sneak in. Then I pick locks.', CHECKS, [], 2).map((item) => item.checkId)).toEqual([
            'locks',
            'stealth',
        ]);
    });

    it('never the same check twice, never one clause, never above the limit', () => {
        expect(detectChecks('Я крадусь, крадусь и снова крадусь.', CHECKS, [], 2)).toHaveLength(1);
        expect(detectChecks('Я крадусь уговаривая стражу.', CHECKS, [], 2)).toHaveLength(1);
        expect(detectChecks('Я крадусь, а потом пытаюсь убедить стражника.', CHECKS, [], 1)).toHaveLength(1);
        const three = detectChecks('Крадусь к двери. Пытаюсь убедить стражника. Взломать замок.', CHECKS, [], 2);
        expect(three).toHaveLength(2);
        expect(detectChecks('Я жду.', CHECKS, [], 2)).toEqual([]);
    });

    it('each with its own actor, difficulty and place in the message', () => {
        const text = 'Элизабет тихо крадусь мимо. Я пытаюсь убедить стражника, это трудно.';
        const [first, second] = detectChecks(text, CHECKS, ACTORS, 2);
        expect(first).toMatchObject({ checkId: 'persuasion', holder: null, level: 'hard' });
        expect(second).toMatchObject({ checkId: 'stealth', holder: 'Elizabeth', level: null });
        expect(text.slice(first!.at, first!.end)).toBe('убедить');
        expect(text.slice(second!.at, second!.end)).toBe('крадусь');
    });
});

describe('the named target', () => {
    const PEOPLE: ActorNames[] = [
        { holder: 'Стражник', names: [] },
        { holder: 'Bandit', names: ['Бандит'] },
        { holder: 'Elizabeth', names: ['Элизабет', 'Лиз'] },
    ];
    const at = (text: string, word: string) => text.indexOf(word);

    it('a name or a case form near the match', () => {
        const text = 'Я бью стражника мечом.';
        expect(namedTarget(text, at(text, 'бью'), PEOPLE)).toBe('Стражник');
        const russian = 'Я атакую бандита.';
        expect(namedTarget(russian, at(russian, 'атакую'), PEOPLE)).toBe('Bandit');
        const english = 'I attack the bandits.';
        expect(namedTarget(english, at(english, 'attack'), PEOPLE)).toBe('Bandit');
        const alias = 'Пытаюсь убедить Лиз.';
        expect(namedTarget(alias, at(alias, 'убедить'), PEOPLE)).toBe('Elizabeth');
    });

    it('the nearest after the match in its sentence, else before, else anywhere; quoted speech counts', () => {
        const text = 'Бандит смеётся. Я бью стражника, а Лиз смотрит.';
        expect(namedTarget(text, at(text, 'бью'), PEOPLE)).toBe('Стражник');
        const before = 'Стражнику я говорю: прочь! Я бью.';
        expect(namedTarget(before, at(before, 'бью'), PEOPLE)).toBe('Стражник');
        const inSentence = 'Бандит рядом. Элизабет я пытаюсь убедить.';
        expect(namedTarget(inSentence, at(inSentence, 'убедить'), PEOPLE)).toBe('Elizabeth');
        const vocative = '«Стражник, пропусти меня, прошу», — уговариваю я.';
        expect(namedTarget(vocative, at(vocative, 'уговариваю'), PEOPLE)).toBe('Стражник');
    });

    it('lists every named holder once, those of the sentence of the match marked near', () => {
        const text = 'Бандит смеётся. Я бью стражника, а Лиз смотрит на бандита.';
        expect(namedHolders(text, at(text, 'бью'), PEOPLE)).toEqual([
            { holder: 'Стражник', near: true },
            { holder: 'Elizabeth', near: true },
            { holder: 'Bandit', near: true },
        ]);
        const elsewhere = 'Бандит смеётся. Я бью.';
        expect(namedHolders(elsewhere, at(elsewhere, 'бью'), PEOPLE)).toEqual([{ holder: 'Bandit', near: false }]);
    });

    it('nobody named: null; short names need an exact word or a world form', () => {
        expect(namedTarget('Я бью изо всех сил.', 2, PEOPLE)).toBeNull();
        expect(namedTarget('Я бью.', 2, [])).toBeNull();
        expect(namedTarget('Я бью Кая.', 2, [{ holder: 'Kai', names: ['Кай'] }])).toBeNull();
        expect(namedTarget('Я бью Кая.', 2, [{ holder: 'Kai', names: ['Кай', 'Кая'] }])).toBe('Kai');
        expect(namedTarget('(OOC: бандит) Я бью.', 13, PEOPLE)).toBeNull();
    });
});

describe('the actor', () => {
    it('a holder named at the start of the clause acts', () => {
        expect(detect('Элизабет пытается убедить стражника.')?.holder).toBe('Elizabeth');
        expect(detect('Elizabeth tries to persuade the guard.')?.holder).toBe('Elizabeth');
        expect(detect('А Лиз пытается уговорить его.')?.holder).toBe('Elizabeth');
        expect(detect('Кай пытается убедить её.')?.holder).toBe('Kai');
    });

    it('otherwise the persona (null)', () => {
        expect(detect('Я пытаюсь убедить Элизабет.')?.holder).toBeNull();
        expect(detect('Пока Элизабет отвлекает стражу, я пытаюсь убедить его.')?.holder).toBeNull();
        expect(detect('Элизабет кивает. Я пытаюсь убедить его.')?.holder).toBeNull();
        expect(detectCheck('Элизабет пытается убедить его.', CHECKS)?.holder).toBeNull();
    });

    it('a shared first name decides nothing, the full name does', () => {
        const actors: ActorNames[] = [
            { holder: 'Anna Lee', names: [] },
            { holder: 'Anna Smith', names: [] },
        ];
        expect(detect('Anna tries to persuade him.', actors)?.holder).toBeNull();
        expect(detect('Anna Lee tries to persuade him.', actors)?.holder).toBe('Anna Lee');
        expect(detect('Anna Smith tries to persuade him.', actors)?.holder).toBe('Anna Smith');
        expect(detect('Anna tries to persuade him.', [actors[0] as ActorNames])?.holder).toBe('Anna Lee');
    });
});

describe('difficulty', () => {
    it('from words in the sentence of the match', () => {
        expect(detect('Пытаюсь убедить его, это трудно.')?.level).toBe('hard');
        expect(detect('Я легко убедил его.')?.level).toBe('easy');
        expect(detect('Это очень сложно, но я пытаюсь убедить его.')?.level).toBe('veryHard');
        expect(detect('I try to persuade him, which is very hard.')?.level).toBe('veryHard');
        expect(detect('Это трудно. Я пытаюсь убедить его.')?.level).toBeNull();
        expect(detect('Пытаюсь убедить его, это не трудно.')?.level).toBe('easy');
        expect(detect('I try to persuade him, not easy.')?.level).toBe('hard');
    });

    it('an explicit number wins and is read from OOC too', () => {
        const found = detect('(DC 18) Пытаюсь убедить стражу, это трудно.');
        expect(found).toMatchObject({ difficulty: 18, level: 'hard' });
    });

    it('levels of token lists and single words', () => {
        expect(difficultyLevel(tokenize('почти невозможно'))).toBe('veryHard');
        expect(difficultyLevel(tokenize('несложно'))).toBe('easy');
        expect(difficultyLevel(tokenize('нелегко'))).toBe('hard');
        expect(difficultyLevel(tokenize('challenging task'))).toBe('hard');
        expect(difficultyLevel(tokenize('I simply walk'))).toBeNull();
        expect(difficultyLevel(tokenize('тяжёлый меч'))).toBeNull();
        expect(difficultyWord('трудно')).toBe('hard');
        expect(difficultyWord('very-hard')).toBe('veryHard');
        expect(difficultyWord('veryhard')).toBe('veryHard');
        expect(difficultyWord('очень трудно')).toBe('veryHard');
        expect(difficultyWord('Normal')).toBe('normal');
        expect(difficultyWord('средне')).toBe('normal');
        expect(difficultyWord('easy')).toBe('easy');
        expect(difficultyWord('Kai')).toBeNull();
        expect(difficultyWord('')).toBeNull();
    });
});
