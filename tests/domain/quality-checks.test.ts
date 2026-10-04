import { describe, expect, it } from 'vitest';
import {
    DEFAULT_BOUNDARY_RULES,
    FREE_CHECKS,
    checkBoundary,
    checkJunk,
    checkLanguage,
    checkMissingTracker,
    checkRefusal,
    checkRepetition,
    checkTruncated,
    checkUserSpeech,
    runFreeChecks,
} from '../../src/domain/quality-checks';
import { JUDGE_THRESHOLD } from '../../src/domain/quality-types';
import type { QualityInput, QualityMessage } from '../../src/domain/quality-types';

const TRACKER =
    '```json\n{"quests":{"main":"Найти брод"},"infoBox":{"location":"Таверна"},"characters":[{"name":"Лира","thoughts":"Надо спешить"}]}\n```\n';
const MARKER = `<figure><img data-nai='{"prompt":"a girl with a map in a tavern, warm light","caption":"Map at dusk"}'><figcaption>Map at dusk</figcaption></figure>`;
const BUNNY = '<BunnyMoTags><Name:Лира>, <SPECIES:ELF>, <PERSONALITY:CALM></BunnyMoTags>';

const RU_OK = `Лира подняла глаза от карты и улыбнулась.
— Кай, иди сюда, — позвала она. — Смотри, здесь отмечен старый брод.
${MARKER}
Ветер трепал край пергамента, и где-то за холмом лаяли собаки. Она провела пальцем по линии реки, задержалась у развилки и нахмурилась.
— Если мы выйдем на рассвете, к вечеру будем у моста, — добавила она тише. Её «deadline» был близко, а Mr. Grey ждал в Riverside.`;

const EN_OK = `Lira looked up from the map and smiled.
"Kai, come here," she called. "Look, the old ford is marked right here."
The wind tugged at the parchment while somewhere beyond the hill dogs were barking. She traced the river with her finger and frowned at the fork.
"If we leave at dawn, we'll reach the bridge by nightfall," she added quietly.`;

function msg(text: string, isUser = false, name = isUser ? 'Кай' : 'Лира'): QualityMessage {
    return { index: 0, isUser, name, text };
}

function ru(text: string, extra: Partial<QualityInput> = {}): QualityInput {
    return {
        reply: { index: 9, isUser: false, name: 'Лира', text },
        history: [],
        userName: 'Кай',
        charName: 'Лира',
        language: 'ru',
        desTogether: false,
        boundary: [],
        ...extra,
    };
}

function en(text: string, extra: Partial<QualityInput> = {}): QualityInput {
    return ru(text, { userName: 'Kai', charName: 'Lira', language: 'en', ...extra });
}

const byOf = (defects: { by: string }[]) => defects.map((defect) => defect.by);

describe('normal replies', () => {
    it('a Russian reply with a DES tracker, NAI marker, BunnyMo tags, English names and a quoted word is clean', () => {
        const text = `${TRACKER}${RU_OK}\n${BUNNY}`;
        expect(runFreeChecks(ru(text, { desTogether: true, boundary: [...DEFAULT_BOUNDARY_RULES] }))).toEqual([]);
    });

    it('an English reply with an NPC calling the user by name is clean', () => {
        expect(runFreeChecks(en(EN_OK, { boundary: [...DEFAULT_BOUNDARY_RULES] }))).toEqual([]);
    });

    it('a short reply ending with an ellipsis is clean', () => {
        expect(runFreeChecks(ru('— Ну…'))).toEqual([]);
        expect(runFreeChecks(ru('Лира молчала…'))).toEqual([]);
    });

    it('sheets and missing replies are never checked', () => {
        const sheet = ru('<｜begin▁of▁sentence｜>Kai says: "I can not continue this roleplay"', { isSheet: true });
        expect(runFreeChecks(sheet)).toEqual([]);
        for (const check of Object.values(FREE_CHECKS)) expect(check(sheet)).toEqual([]);
        expect(runFreeChecks(undefined as unknown as QualityInput)).toEqual([]);
        expect(checkLanguage({ ...ru(''), reply: undefined } as unknown as QualityInput)).toEqual([]);
    });
});

describe('checkLanguage', () => {
    it('flags a Russian reply written fully in English', () => {
        const [defect] = checkLanguage(ru(EN_OK));
        expect(defect).toMatchObject({ kind: 'language', confidence: 0.95, by: 'language:script' });
        expect(defect!.fix).toEqual({
            kind: 'swipe',
            instruction:
                'Rewrite the reply fully in Russian: narration, dialogue and thoughts; keep only names and tags as they are.',
        });
        expect(defect!.quote.length).toBeLessThanOrEqual(160);
    });

    it('flags an English slip inside Russian prose, more confidently for several slips', () => {
        const one = checkLanguage(ru(`${RU_OK}\nShe looked at him and smiled, waiting for an answer.`));
        expect(one).toHaveLength(1);
        expect(one[0]).toMatchObject({ by: 'language:mixed', confidence: 0.7 });
        expect(one[0]!.quote).toBe('She looked at him and smiled, waiting for an answer');
        const short = checkLanguage(ru(`${RU_OK}\nShe looked at him then.`));
        expect(short[0]).toMatchObject({ by: 'language:mixed', confidence: 0.55 });
        const two = checkLanguage(
            ru(`${RU_OK}\nShe looked at him and smiled.\nОна вздохнула.\nWe should go before the guards come back.`),
        );
        expect(two[0]).toMatchObject({ by: 'language:mixed', confidence: 0.85 });
    });

    it('ignores names, capitalised titles, short quotes, glosses and service blocks', () => {
        const text = [
            'Лира открыла «Book of Shadows» и прочла заклинание (англ. fire bolt).',
            'Kai Lira Mister Grey Riverside — все они ждали у ворот.',
            '<details><summary>Thoughts</summary>She thinks about the long road ahead and the danger of it all.</details>',
            '```\nsome english text that is not a tracker at all here\n```',
            'Она кивнула и пошла к двери.',
        ].join('\n');
        expect(checkLanguage(ru(text, { history: [msg('x', false, 'Mister Grey')] }))).toEqual([]);
    });

    it('flags Chinese characters in a Russian reply', () => {
        const [defect] = checkLanguage(ru('Лира улыбнулась и сказала, что это 非常 важно для неё.'));
        expect(defect).toMatchObject({ by: 'language:foreign-chars', confidence: 0.85 });
        expect(defect!.fix?.instruction).toContain('Russian only');
        expect(checkLanguage(ru('Лира написала знак 火 на стене.'))[0]).toMatchObject({ confidence: 0.6 });
    });

    it('flags Russian in an English chat and accepts Cyrillic names there', () => {
        const [defect] = checkLanguage(en(`${EN_OK}\nОна посмотрела на него и тихо вздохнула, ожидая ответа.`));
        expect(defect).toMatchObject({ by: 'language:mixed' });
        expect(defect!.fix?.instruction).toContain('fully in English');
        expect(checkLanguage(en(`${EN_OK}\nКай nodded.`, { userName: 'Кай' }))).toEqual([]);
    });

    it('reports Russian calques and clichés with low confidence', () => {
        const one = checkLanguage(ru('Это делает смысл, подумала Лира и пошла к двери.'));
        expect(one).toHaveLength(1);
        expect(one[0]).toMatchObject({ kind: 'language', by: 'language:calque', confidence: 0.3 });
        expect(one[0]!.confidence).toBeLessThan(JUDGE_THRESHOLD);
        const three = checkLanguage(
            ru(
                'Мурашки побежали по её спине. Голос был чуть громче шёпота. Губы изогнулись в ухмылке, и она отвернулась.',
            ),
        );
        expect(three[0]).toMatchObject({ by: 'language:cliche', confidence: 0.65 });
        expect(three[0]!.fix?.instruction).toContain('natural, idiomatic Russian');
        const two = checkLanguage(ru('О мой бог! Звучит как план, сказала Лира.'));
        expect(two[0]).toMatchObject({ by: 'language:calque', confidence: 0.5 });
    });

    it('reports English clichés in English chats only', () => {
        const text = 'A shiver ran down her spine. Her voice was barely above a whisper as she spoke.';
        expect(checkLanguage(en(text))[0]).toMatchObject({ by: 'language:cliche', confidence: 0.5 });
        expect(checkLanguage(en(EN_OK))).toEqual([]);
    });

    it('flags a reply of short English sentences as a whole, and ignores replies without words', () => {
        const [defect] = checkLanguage(ru('Okay. Fine, fine. I see. Let us go. Not now (…).'));
        expect(defect).toMatchObject({
            by: 'language:script',
            quote: 'Okay. Fine, fine. I see. Let us go. Not now (…).',
        });
        expect(checkLanguage(ru('123 — 456!'))).toEqual([]);
    });

    it('skips script checks for languages it cannot judge and empty prose', () => {
        expect(checkLanguage(ru(EN_OK, { language: 'ja' }))).toEqual([]);
        expect(checkLanguage(ru(EN_OK, { language: '' }))).toEqual([]);
        expect(checkLanguage(ru(TRACKER))).toEqual([]);
        expect(checkLanguage(ru(EN_OK, { language: 'Russian' }))[0]).toMatchObject({ by: 'language:script' });
    });
});

describe('checkUserSpeech', () => {
    it('does not flag NPCs addressing the user or quoting «ты говоришь» in their lines', () => {
        expect(checkUserSpeech(ru(RU_OK))).toEqual([]);
        expect(checkUserSpeech(ru('— Ты говоришь глупости, Кай, — сказала Лира и отвернулась.'))).toEqual([]);
        expect(checkUserSpeech(ru('Лира посмотрела на Кая и улыбнулась. — Кай? — позвала она.'))).toEqual([]);
        expect(checkUserSpeech(en(EN_OK))).toEqual([]);
    });

    it('flags Russian speech attributed to the user', () => {
        const [defect] = checkUserSpeech(ru('Лира кивнула.\n— Хорошо, — ответил Кай. — Пойдём.'));
        expect(defect).toMatchObject({ kind: 'userSpeech', confidence: 0.9, by: 'userSpeech:attributed' });
        expect(defect!.quote).toBe('— Хорошо, — ответил Кай.');
        expect(defect!.fix).toEqual({
            kind: 'swipe',
            instruction: "Do not write {{user}}'s words, thoughts or actions; stop where {{user}} would act or speak.",
        });
        const named = checkUserSpeech(ru('— Хорошо, — Кай тихо прошептал.'));
        expect(named[0]).toMatchObject({ by: 'userSpeech:attributed' });
        const twice = checkUserSpeech(ru('— Да, — сказал Кай.\n— Нет, — возразил Кай.'));
        expect(twice[0]).toMatchObject({ confidence: 0.95 });
        const quoted = checkUserSpeech(ru('«Я иду», — сказал Кай, не оборачиваясь.'));
        expect(quoted[0]).toMatchObject({ by: 'userSpeech:attributed' });
    });

    it('flags script lines and «Name said:» lines', () => {
        expect(checkUserSpeech(ru('Лира ждала.\nКай: Пойдём отсюда.'))[0]).toMatchObject({
            by: 'userSpeech:script',
            confidence: 0.95,
        });
        expect(checkUserSpeech(ru('Лира ждала.\n**Кай:** Пойдём.'))[0]).toMatchObject({ by: 'userSpeech:script' });
        expect(checkUserSpeech(ru('Кай сказал: «Пойдём отсюда».'))[0]).toMatchObject({ confidence: 0.9 });
        expect(checkUserSpeech(en('Kai said: "Let\'s go."'))[0]).toMatchObject({ confidence: 0.9 });
        const mixed = checkUserSpeech(ru('— Да, — сказал Кай. Кай улыбнулся и взял её за руку.'));
        expect(mixed[0]).toMatchObject({ by: 'userSpeech:attributed', confidence: 0.95 });
    });

    it('flags English attributed speech in both word orders', () => {
        expect(checkUserSpeech(en('"Fine," Kai said, and turned away.'))[0]).toMatchObject({
            by: 'userSpeech:attributed',
            confidence: 0.9,
        });
        expect(checkUserSpeech(en('"Fine," said Kai.'))[0]).toMatchObject({ by: 'userSpeech:attributed' });
    });

    it('rates narration lines by verb: speech higher than actions, repeated actions higher', () => {
        const action = checkUserSpeech(ru('Лира ждала. Кай улыбнулся и взял её за руку.'));
        expect(action[0]).toMatchObject({ by: 'userSpeech:action', confidence: 0.5 });
        const actions = checkUserSpeech(
            ru('Кай кивнул. Лира ждала. Кай медленно встал. Кай подошёл к окну.\nЛира промолчала.'),
        );
        expect(actions[0]).toMatchObject({ by: 'userSpeech:action', confidence: 0.8 });
        const twoActions = checkUserSpeech(ru('Кай кивнул. Лира ждала. Кай встал.'));
        expect(twoActions[0]).toMatchObject({ confidence: 0.65 });
        const speech = checkUserSpeech(ru('Кай ответил, что согласен, и Лира вздохнула.'));
        expect(speech[0]).toMatchObject({ by: 'userSpeech:line', confidence: 0.75 });
        const speeches = checkUserSpeech(ru('Кай ответил, что согласен. Кай спросил, когда выходить.'));
        expect(speeches[0]).toMatchObject({ by: 'userSpeech:line', confidence: 0.85 });
        expect(checkUserSpeech(en('Kai nods and takes her hand.'))[0]).toMatchObject({ by: 'userSpeech:action' });
        expect(checkUserSpeech(ru('Кай и Лира подошли к двери.'))).toEqual([]);
    });

    it('flags «ты/you» narration that decides the user’s actions, not perception', () => {
        const two = checkUserSpeech(ru('Ты киваешь и берёшь её за руку. Ветер стихает. Ты говоришь, что согласен.'));
        expect(two[0]).toMatchObject({ by: 'userSpeech:you', confidence: 0.8 });
        expect(checkUserSpeech(en('You nod and take her hand.'))[0]).toMatchObject({
            by: 'userSpeech:you',
            confidence: 0.6,
        });
        const three = checkUserSpeech(en('You nod. You slowly reach for the key. Then you whisper her name.'));
        expect(three[0]).toMatchObject({ confidence: 0.9 });
        expect(checkUserSpeech(en('You see a door. You hear footsteps behind it.'))).toEqual([]);
    });

    it('rates echoes of the user’s own words low', () => {
        const history = [msg('— Я согласен, — говорю я и улыбаюсь.', true)];
        const [defect] = checkUserSpeech(ru('— Я согласен, — сказал Кай. Лира улыбнулась в ответ.', { history }));
        expect(defect).toMatchObject({ by: 'userSpeech:echo', confidence: 0.45 });
    });

    it('notices first-person narration in the user’s voice', () => {
        const history = [
            msg('Лира открыла дверь и вошла в зал.'),
            msg('Я подхожу к окну и смотрю вниз.', true),
            msg('Лира проследила за его взглядом и кивнула.'),
            msg('Я жду, что она скажет.', true),
        ];
        const [defect] = checkUserSpeech(ru('Я открываю дверь. Я вижу пустой коридор.', { history }));
        expect(defect).toMatchObject({ by: 'userSpeech:first-person', confidence: 0.55 });
        const ownVoice = [msg('Я улыбаюсь.'), msg('Я жду.', true), msg('Я молчу.')];
        expect(checkUserSpeech(ru('Я открываю дверь. Я вижу пустой коридор.', { history: ownVoice }))).toEqual([]);
    });

    it('keeps working when many user names come and go', () => {
        for (let i = 0; i < 40; i++) checkUserSpeech(ru('— Да, — сказал Кай.', { userName: `Гость${i}` }));
        expect(checkUserSpeech(ru('— Да, — сказал Кай.'))[0]).toMatchObject({ by: 'userSpeech:attributed' });
    });

    it('skips name patterns without a usable user name', () => {
        expect(checkUserSpeech(ru('— Да, — сказал Кай.', { userName: '' }))).toEqual([]);
        expect(checkUserSpeech(ru('— Да, — сказал Кай.', { userName: 'Кай', charName: 'Кай' }))).toEqual([]);
        const full = checkUserSpeech(ru('— Да, — сказал Кай.', { userName: 'Кай Ли' }));
        expect(full[0]).toMatchObject({ by: 'userSpeech:attributed' });
        expect(checkUserSpeech(ru(TRACKER))).toEqual([]);
    });
});

describe('checkRefusal', () => {
    it('flags refusals in the assistant voice, English and Russian', () => {
        const [en1] = checkRefusal(
            en("I'm sorry, but I can't continue this roleplay because it goes against the content policy."),
        );
        expect(en1).toMatchObject({ kind: 'refusal', confidence: 0.95 });
        expect(en1!.fix?.instruction).toContain('Stay in character');
        const [ru1] = checkRefusal(ru('Я не могу продолжить эту сцену, так как она нарушает правила.'));
        expect(ru1).toMatchObject({ kind: 'refusal', by: 'refusal:cant-continue-ru', confidence: 0.9 });
        expect(checkRefusal(en('As an AI language model, I must decline.'))[0]).toMatchObject({
            by: 'refusal:as-an-ai',
        });
        expect(checkRefusal(ru('Как ИИ, я не могу этого описать.'))[0]).toMatchObject({ by: 'refusal:as-an-ai-ru' });
    });

    it('keeps in-character refusals low or silent', () => {
        expect(checkRefusal(ru('— Я не могу продолжать, — прошептала она и закрыла лицо руками.'))).toEqual([]);
        const inDialogue = checkRefusal(ru('— Я не могу продолжить эту историю, — сказал старый писатель.'));
        expect(inDialogue[0]!.confidence).toBeLessThan(JUDGE_THRESHOLD);
        expect(checkRefusal(ru(RU_OK))).toEqual([]);
        expect(checkRefusal(en(EN_OK))).toEqual([]);
    });

    it('flags out-of-character notes', () => {
        expect(checkRefusal(en(`${EN_OK}\n(OOC: Let me know if you'd like me to continue.)`))[0]).toMatchObject({
            kind: 'refusal',
            confidence: 0.95,
        });
        expect(checkRefusal(ru(`${RU_OK}\n[OOC: дальше решай сам]`))[0]).toMatchObject({ by: 'refusal:ooc' });
        expect(checkRefusal(ru(`${RU_OK}\n(Примечание: сцена сокращена.)`))[0]).toMatchObject({ by: 'refusal:note' });
    });

    it('flags moralising and fiction disclaimers', () => {
        const defects = checkRefusal(ru(`${RU_OK}\nПримечание: это вымышленная история, в реальной жизни так нельзя.`));
        expect(defects.map((defect) => defect.kind).sort()).toEqual(['moralizing', 'refusal']);
        const moral = defects.find((defect) => defect.kind === 'moralizing')!;
        expect(moral.confidence).toBe(0.9);
        expect(moral.fix?.instruction).toContain('without moralizing');
        const lecture = checkRefusal(en("It's important to remember that consent is key."));
        expect(lecture[0]).toMatchObject({ kind: 'moralizing', by: 'moralizing:consent-lecture' });
    });

    it('flags consent questions only when they repeat', () => {
        const once = '— Ты уверен? — тихо спросила Лира, коснувшись его плеча.';
        expect(checkRefusal(ru(once))).toEqual([]);
        const twice = '— Ты уверен? — спросила Лира. — Тебе нормально? Скажи, если захочешь остановиться.';
        expect(checkRefusal(ru(twice))[0]).toMatchObject({
            kind: 'moralizing',
            by: 'moralizing:consent',
            confidence: 0.9,
        });
        const history = [
            msg('— Ты уверен? — спросила она.'),
            msg('Да.', true),
            msg('— Тебе нормально? — спросила она.'),
        ];
        expect(checkRefusal(ru(once, { history }))[0]).toMatchObject({ by: 'moralizing:consent', confidence: 0.8 });
        const earlierOnce = [msg('— Ты уверен? — спросила она.'), msg('Да.', true)];
        expect(checkRefusal(ru(once, { history: earlierOnce }))[0]).toMatchObject({ confidence: 0.55 });
        expect(checkRefusal(en('"Are you sure?" she asked. "Is this okay?"'))[0]).toMatchObject({ confidence: 0.8 });
    });

    it('flags fade to black and blurred scenes', () => {
        expect(checkRefusal(en(`${EN_OK}\nThe scene fades to black.`))[0]).toMatchObject({
            kind: 'softening',
            by: 'softening:fade-to-black',
            confidence: 0.9,
        });
        expect(checkRefusal(ru('Она погасила свечу. Сцена затемняется.'))[0]).toMatchObject({ kind: 'softening' });
        expect(checkRefusal(ru('Что было дальше — история умалчивает.'))[0]).toMatchObject({
            by: 'softening:left-unsaid-ru',
        });
        const blur = checkRefusal(ru('Остаток ночи слился в одно размытое пятно.'));
        expect(blur[0]).toMatchObject({ by: 'softening:blur', confidence: 0.6 });
    });

    it('leaves story uses of policy, warning, real-life and screen words alone or low', () => {
        expect(checkRefusal(en("She skimmed the lab's safety guidelines and sighed."))).toEqual([]);
        expect(checkRefusal(ru('Он изучил правила использования артефакта и нахмурился.'))).toEqual([]);
        expect(checkRefusal(ru('На двери висела табличка.\nПредупреждение: не входить!'))).toEqual([]);
        expect(checkRefusal(ru('Экран погас, и в комнате стало темно. Экран гаснет.'))).toEqual([]);
        expect(checkRefusal(ru('Стоит помнить, что в этих лесах водятся волки.'))).toEqual([]);
        expect(checkRefusal(ru('— Тебе хорошо? Тебе приятно? — шептала она.'))).toEqual([]);
        const isekai = checkRefusal(ru('В реальной жизни он был программистом, а здесь стал магом.'));
        expect(isekai[0]).toMatchObject({ kind: 'moralizing', confidence: 0.6 });
        expect(checkRefusal(ru('Она погасила свечу.\n*Затемнение.*\nУтро.'))[0]).toMatchObject({
            by: 'softening:fade-to-black-ru',
        });
    });

    it('has nothing to say about a reply without prose', () => {
        expect(checkRefusal(ru(TRACKER))).toEqual([]);
    });

    it('raises the confidence when two different rules of a kind agree', () => {
        const text = 'The scene fades to black. What happened next is between them.';
        expect(checkRefusal(en(text))[0]).toMatchObject({ kind: 'softening', confidence: 0.95 });
    });
});

describe('checkRepetition', () => {
    const earlier = [
        'Лира подняла глаза от карты и улыбнулась. Ветер трепал край пергамента, и где-то за холмом лаяли собаки. Она провела пальцем по линии реки.',
        'Лира подняла глаза от карты и нахмурилась. Дорога шла через лес, и никто не знал, что ждёт их у моста. Кай молчал.',
    ];

    it('flags a reply that repeats an earlier one', () => {
        const history = [msg(earlier[0]!), msg('Я жду.', true)];
        const [defect] = checkRepetition(ru(earlier[0]!, { history }));
        expect(defect).toMatchObject({ kind: 'repetition', by: 'repetition:overlap', confidence: 0.95 });
        expect(defect!.fix?.instruction).toContain('new wording');
    });

    it('flags repeated sentences and the same opening', () => {
        const history = earlier.map((text) => msg(text));
        const reply =
            'Лира подняла глаза от карты и задумалась о брате. Ветер трепал край пергамента, и где-то за холмом лаяли собаки. Потом она встала и вышла во двор, где ждали лошади.';
        const [defect] = checkRepetition(ru(reply, { history }));
        expect(defect!.kind).toBe('repetition');
        expect(defect!.confidence).toBeGreaterThanOrEqual(0.8);
        const opening = checkRepetition(
            ru('Лира подняла глаза от карты и увидела незнакомца. Он стоял в дверях, сжимая в руке письмо с печатью.', {
                history,
            }),
        );
        expect(opening[0]).toMatchObject({ by: 'repetition:opening', confidence: 0.8 });
    });

    it('rates a single repeated sentence in a long reply low', () => {
        const history = [
            msg('Совсем другой текст про лес. Ветер трепал край пергамента, и где-то за холмом лаяли собаки.'),
        ];
        const reply = [
            'Кай вошёл в таверну, стряхивая снег с плаща и оглядывая полутёмный зал, где пахло дымом и кислым пивом.',
            'Ветер трепал край пергамента, и где-то за холмом лаяли собаки.',
            'Хозяин кивнул ему и налил вина без лишних слов, а потом вернулся к своим счетам и тихо выругался.',
            'У дальнего стола трое наёмников спорили о цене за голову разбойника, которого никто из них не видел.',
            'Старая кошка спала у очага, и огонь бросал на стены длинные дрожащие тени.',
        ].join(' ');
        const [defect] = checkRepetition(ru(reply, { history }));
        expect(defect!.confidence).toBeLessThan(JUDGE_THRESHOLD);
    });

    it('rates repeated sentences by count and length', () => {
        const sentences = [
            'Ветер трепал край пергамента, и где-то за холмом лаяли собаки.',
            'Старая кошка спала у очага, и огонь бросал на стены тени.',
            'Хозяин налил вина без лишних слов и вернулся к своим счетам.',
        ];
        const filler = [
            'Кай вошёл в таверну, стряхивая снег с плаща и оглядывая полутёмный зал, где пахло дымом и кислым пивом.',
            'У дальнего стола трое наёмников спорили о цене за голову разбойника, которого никто из них не видел.',
            'За окном медленно гасли огни, и улица пустела, пока в переулке не затихли последние шаги прохожих.',
            'Где-то наверху скрипнула половица, и музыкант у камина на мгновение перестал играть свою грустную песню.',
            'Девушка у стойки пересчитала монеты, вздохнула и положила их обратно в потёртый кожаный кошель.',
        ];
        const history = [msg(`Начало. ${sentences.join(' ')}`)];
        const two = checkRepetition(
            ru([filler[0], sentences[0], filler[1], sentences[1], ...filler.slice(2)].join(' '), { history }),
        );
        expect(two[0]).toMatchObject({ by: 'repetition:sentences', confidence: 0.7 });
        const three = checkRepetition(ru([...filler, ...sentences, ...filler].join(' '), { history }));
        expect(three[0]).toMatchObject({ by: 'repetition:sentences' });
        expect(three[0]!.confidence).toBeGreaterThanOrEqual(0.85);
        const shortHistory = [msg('Начало. Она молча кивнула ему в ответ.')];
        const short = checkRepetition(
            ru([filler[0], 'Она молча кивнула ему в ответ.', ...filler.slice(1)].join(' '), { history: shortHistory }),
        );
        expect(short[0]).toMatchObject({ by: 'repetition:sentences', confidence: 0.35 });
    });

    it('accepts fresh replies, short replies and empty histories', () => {
        const history = earlier.map((text) => msg(text));
        expect(
            checkRepetition(ru(RU_OK.replace('Лира подняла глаза от карты', 'Кай'), { history: [msg('Иное.')] })),
        ).toEqual([]);
        expect(checkRepetition(ru('Лира кивнула.', { history }))).toEqual([]);
        expect(checkRepetition(ru(RU_OK))).toEqual([]);
        expect(checkRepetition(ru(RU_OK, { history: [msg(RU_OK, true)] }))).toEqual([]);
    });
});

describe('checkTruncated', () => {
    it('trusts the finish reason', () => {
        const [defect] = checkTruncated(ru(RU_OK, { finishReason: 'length' }));
        expect(defect).toMatchObject({ kind: 'truncated', confidence: 0.95, by: 'truncated:length' });
        expect(defect!.fix).toEqual({
            kind: 'continue',
            instruction: 'Continue the reply exactly from where it stopped; do not repeat what is already written.',
        });
        expect(checkTruncated(ru(RU_OK, { finishReason: 'MAX_TOKENS' }))[0]).toMatchObject({ confidence: 0.95 });
        expect(checkTruncated(ru(RU_OK, { finishReason: 'stop' }))).toEqual([]);
    });

    it('flags prose that ends mid-sentence', () => {
        const long = 'Лира подошла к окну и долго смотрела на заснеженную улицу, потом взяла его за';
        expect(checkTruncated(ru(long))[0]).toMatchObject({ by: 'truncated:open-end', confidence: 0.9 });
        expect(checkTruncated(ru(`${RU_OK}\nОна обернулась,`))[0]).toMatchObject({ confidence: 0.9 });
        const letter = `${RU_OK}\nОна обернулась к двери и замерла в ожидании ответа`;
        expect(checkTruncated(ru(letter))[0]).toMatchObject({ confidence: 0.8 });
        expect(checkTruncated(ru('Лира обернулась'))[0]).toMatchObject({ confidence: 0.5 });
        expect(checkTruncated(en('She turned to the door and waited for the'))[0]).toMatchObject({ confidence: 0.9 });
    });

    it('ignores trailing trackers, markers and tags, and accepts every proper ending', () => {
        expect(checkTruncated(ru(`${TRACKER}${RU_OK}\n${MARKER}\n[nai:img:abc123]`))).toEqual([]);
        for (const ending of ['.', '!', '?', '…', '»', '"', '*', ')', ' —', ' 🙂', ' ♥']) {
            expect(checkTruncated(ru(`Лира кивнула и ушла${ending}`))).toEqual([]);
        }
        expect(checkTruncated(ru('Что дальше?\n1. Пойти в лес\n2. Остаться в таверне'))).toEqual([]);
        expect(checkTruncated(ru('Лира запела. ♪'))).toEqual([]);
        expect(checkTruncated(ru('Лира кивнула.\n📍 Таверна | 🕐 Вечер'))).toEqual([]);
        expect(checkTruncated(ru('Лира кивнула.\nВремя: поздний вечер'))).toEqual([]);
        expect(
            checkTruncated(ru(`${RU_OK}\nОна обернулась к двери и замерла в ожидании\nМесто: таверна`))[0],
        ).toMatchObject({
            confidence: 0.8,
        });
        expect(checkTruncated(ru(''))).toEqual([]);
        expect(checkTruncated(ru(TRACKER))).toEqual([]);
    });

    it('flags an unclosed fence or tag at the end of the stored text', () => {
        expect(checkTruncated(ru(`${RU_OK}\n<img data-nai='{"prompt":"a girl`))[0]).toMatchObject({
            by: 'truncated:unclosed',
            confidence: 0.9,
        });
        expect(checkTruncated(ru('```json\n{"quests":{"main":"Найти'))[0]).toMatchObject({ by: 'truncated:unclosed' });
    });
});

describe('checkJunk', () => {
    it('cleans a leaked DeepSeek token and keeps every other byte', () => {
        const text = `${TRACKER}<｜end▁of▁sentence｜>\n${RU_OK}`;
        const [defect] = checkJunk(ru(text));
        expect(defect).toMatchObject({ kind: 'junk', confidence: 0.95, by: 'junk:token' });
        expect(defect!.quote).toBe('<｜end▁of▁sentence｜>');
        expect(defect!.fix).toEqual({ kind: 'clean', cleaned: `${TRACKER}${RU_OK}` });
    });

    it('swipes a reply that is mostly code (the prefill bug)', () => {
        const text = '<｜begin▁of▁sentence｜>import numpy as np\nx = np.zeros(3)\nfor i in range(3):\n    print(i)\n';
        const [defect] = checkJunk(ru(text));
        expect(defect).toMatchObject({ kind: 'junk', confidence: 0.95, by: 'junk:code-unfenced+token' });
        expect(defect!.fix?.kind).toBe('swipe');
    });

    it('swipes when nothing but junk is left', () => {
        const [defect] = checkJunk(ru('```python\nimport os\nprint(os.name)\n```'));
        expect(defect).toMatchObject({ by: 'junk:code' });
        expect(defect!.fix?.kind).toBe('swipe');
    });

    it('reports prose in a fence without touching it', () => {
        const text = `${RU_OK}\n\`\`\`\nДорогой Кай, я жду тебя у моста.\n\`\`\``;
        const defects = checkJunk(ru(text));
        expect(defects).toEqual([
            {
                kind: 'junk',
                confidence: 0.5,
                quote: expect.stringContaining('Дорогой Кай') as string,
                by: 'junk:fence-text',
            },
        ]);
    });

    it('does not report trackers, markers, details, fonts, BunnyMo tags or strikethrough', () => {
        const text = `${TRACKER}${RU_OK}\n<details><summary>Мысли</summary>Она боится.</details>\n<font color="#ff0000">— Стой!</font>\n<s>старое</s> новое.\n${BUNNY}\n\`\`\`sim\n{"hp": 10}\n\`\`\``;
        expect(checkJunk(ru(text))).toEqual([]);
        expect(checkJunk(ru(''))).toEqual([]);
    });
});

describe('checkMissingTracker', () => {
    it('needs DES together mode', () => {
        expect(checkMissingTracker(ru(RU_OK))).toEqual([]);
        expect(checkMissingTracker(ru('', { desTogether: true }))).toEqual([]);
    });

    it('accepts a tracker at the start, after junk tokens too, fenced or not', () => {
        expect(checkMissingTracker(ru(`${TRACKER}${RU_OK}`, { desTogether: true }))).toEqual([]);
        expect(checkMissingTracker(ru(`<｜begin▁of▁sentence｜>\n${TRACKER}${RU_OK}`, { desTogether: true }))).toEqual(
            [],
        );
        expect(checkMissingTracker(ru(`{"infoBox":{"location":"Таверна"}}\n${RU_OK}`, { desTogether: true }))).toEqual(
            [],
        );
    });

    it('asks for a repair when the tracker is missing, broken or misplaced', () => {
        const [absent] = checkMissingTracker(ru(RU_OK, { desTogether: true }));
        expect(absent).toMatchObject({ kind: 'missingTracker', confidence: 0.95, by: 'missingTracker:absent' });
        expect(absent!.fix).toEqual({ kind: 'repairTracker' });
        const broken = checkMissingTracker(ru('```json\n{"quests":{"main":"Найти брод"}', { desTogether: true }));
        expect(broken[0]).toMatchObject({ by: 'missingTracker:broken', confidence: 0.9 });
        const elsewhere = checkMissingTracker(ru(`${RU_OK}\n${TRACKER}`, { desTogether: true }));
        expect(elsewhere[0]).toMatchObject({ by: 'missingTracker:position', confidence: 0.5 });
        const markerOnly = checkMissingTracker(ru(MARKER, { desTogether: true }));
        expect(markerOnly[0]!.quote).toContain('<figure>');
    });
});

describe('checkBoundary with the default rule', () => {
    const rules = [...DEFAULT_BOUNDARY_RULES];

    it('is a defect when a minor and a sexual context meet in one sentence', () => {
        const [defect] = checkBoundary(ru('Он раздел школьницу и занялся с ней сексом.', { boundary: rules }));
        expect(defect).toMatchObject({ kind: 'boundary', by: 'minors', confidence: 0.85 });
        expect(defect!.fix?.instruction).toContain('no sexual content involving minors');
        expect(checkBoundary(en('He had sex with the 15-year-old girl.', { boundary: rules }))[0]).toMatchObject({
            confidence: 0.85,
        });
        expect(checkBoundary(ru('Двенадцатилетняя девочка, оргазм.', { boundary: rules }))[0]).toMatchObject({
            confidence: 0.85,
        });
        expect(checkBoundary(ru('Ей было всего 14 лет, когда он её изнасиловал.', { boundary: rules }))).toHaveLength(
            1,
        );
    });

    it('is a suspicion when they meet in one paragraph only', () => {
        const text = 'Ребёнок спал в соседней комнате. Они занимались сексом до утра.';
        expect(checkBoundary(ru(text, { boundary: rules }))[0]).toMatchObject({ confidence: 0.5 });
    });

    it('ignores an age or a sexual scene alone, and adult endearments', () => {
        const none = (text: string) => expect(checkBoundary(ru(text, { boundary: rules }))).toEqual([]);
        none('Школьница бежала по улице с рюкзаком, ей было 12 лет.');
        none('Они занимались сексом до утра, и он кончил с громким стоном.');
        none('Ребёнок спал в соседней комнате.\nОни занимались сексом до утра.');
        none('— Хорошая девочка, — прошептал он, и она застонала от оргазма.');
        none('Двенадцать лет назад они впервые занялись любовью.');
        none('Он, член семьи и отец ребёнка, кончил читать сказку.');
        expect(
            checkBoundary(en('The sex of the child was unknown. The child is a minor detail.', { boundary: rules })),
        ).toEqual([]);
    });

    it('checks image marker prompts too', () => {
        const marker = `<img data-nai='{"prompt":"loli, nude, sex, bed"}'>`;
        const [defect] = checkBoundary(ru(`${RU_OK}\n${marker}`, { boundary: rules }));
        expect(defect).toMatchObject({ by: 'minors', confidence: 0.85 });
    });

    it('reads the legacy marker formats too', () => {
        const legacy = `${RU_OK}\n[IMG:GEN:{"prompt":"loli, sex"}]`;
        expect(checkBoundary(ru(legacy, { boundary: rules }))[0]).toMatchObject({ confidence: 0.85 });
        const comment = `${RU_OK}\n<!--img-prompt="schoolgirl, nsfw"-->`;
        expect(checkBoundary(ru(comment, { boundary: rules }))[0]).toMatchObject({ confidence: 0.85 });
        const double = `${RU_OK}\n<img data-nai="{&quot;prompt&quot;:&quot;child, lewd&quot;}">`;
        expect(checkBoundary(ru(double, { boundary: rules }))[0]).toMatchObject({ confidence: 0.85 });
    });

    it('treats an unambiguous word as a suspicion', () => {
        expect(checkBoundary(en('A lolicon artbook lay on the desk.', { boundary: rules }))[0]).toMatchObject({
            confidence: 0.5,
        });
    });

    it('does nothing without rules', () => {
        expect(checkBoundary(ru('Он раздел школьницу и занялся с ней сексом.'))).toEqual([]);
        expect(checkBoundary(ru('', { boundary: rules }))).toEqual([]);
        expect(checkBoundary(ru('Текст.', { boundary: undefined as unknown as [] }))).toEqual([]);
    });
});

describe('runFreeChecks', () => {
    it('merges the checks, sorted by confidence then kind', () => {
        const text = `<｜begin▁of▁sentence｜>Лира кивнула.\n— Да, — сказал Кай. — Пойдём.\nShe looked at him and smiled softly, waiting for the answer`;
        const defects = runFreeChecks(ru(text, { desTogether: true }));
        expect(defects.map((defect) => defect.kind)).toEqual([
            'junk',
            'missingTracker',
            'language',
            'userSpeech',
            'truncated',
        ]);
        const confidences = defects.map((defect) => defect.confidence);
        expect([...confidences].sort((a, b) => b - a)).toEqual(confidences);
        for (const defect of defects) {
            expect(defect.quote.length).toBeLessThanOrEqual(160);
            expect(defect.confidence).toBeGreaterThanOrEqual(0);
            expect(defect.confidence).toBeLessThanOrEqual(1);
        }
    });

    it('keeps one defect per kind and rule and survives a broken input', () => {
        // A history that is not a list breaks the language check (names of the speakers): the others still run.
        const input = ru(`${RU_OK}\nShe looked at him and smiled, waiting for an answer`, {
            history: {} as unknown as QualityMessage[],
        });
        expect(() => checkLanguage(input)).toThrow();
        const defects = runFreeChecks(input);
        expect(byOf(defects)).toContain('truncated:open-end');
        expect(defects.some((defect) => defect.kind === 'language')).toBe(false);
        expect(new Set(byOf(defects)).size).toBe(defects.length);
    });
});

describe('performance', () => {
    it('each check stays fast on a 4 000-character reply', () => {
        let body = '';
        let i = 0;
        while (body.length < 4000) {
            body += `— Ты слышишь, Кай? — спросила Лира в ${i} раз. Ветер трепал край пергамента, а где-то за холмом лаяли собаки. Она провела пальцем по линии реки и нахмурилась.\n`;
            i++;
        }
        const text = `${TRACKER}${body}${MARKER}\nКонец.`;
        const history = Array.from({ length: 10 }, (_, n) => msg(n % 2 ? 'Я жду.' : body.slice(n * 100), n % 2 === 1));
        const timings: Record<string, number> = {};
        for (const [name, check] of Object.entries(FREE_CHECKS)) {
            const runs: number[] = [];
            for (let run = 0; run < 15; run++) {
                const input = ru(`${text} ${run}`, {
                    history,
                    desTogether: true,
                    boundary: [...DEFAULT_BOUNDARY_RULES],
                });
                const start = performance.now();
                check(input);
                runs.push(performance.now() - start);
            }
            runs.sort((a, b) => a - b);
            timings[name] = runs[Math.floor(runs.length / 2)]!;
        }
        for (const [, median] of Object.entries(timings)) expect(median).toBeLessThan(25);
        expect(text.length).toBeGreaterThanOrEqual(4000);
    });
});
