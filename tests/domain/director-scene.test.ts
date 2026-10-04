import { describe, expect, it } from 'vitest';
import { parseDesTracker } from '../../src/domain/des-tracker';
import type { DesTrackerSnapshot } from '../../src/domain/des-tracker';
import {
    SCENE_KINDS,
    SCENE_SCHEMA,
    SWITCH_CONFIDENCE,
    buildSceneMessages,
    combineScene,
    userCue,
    classifyScene,
    confidenceOf,
    emptySceneMemory,
    explicitHits,
    lexiconHits,
    parseSceneAnswer,
    presentNames,
    sceneWords,
    speechShare,
    stepScene,
    tensionLevel,
    timeSkipHits,
    trackerTension,
} from '../../src/domain/director-scene';
import type { SceneKind, SceneMemory, SceneVerdict } from '../../src/domain/director-scene';

function tracker(parts: {
    info?: Record<string, unknown>;
    characters?: unknown[];
    quests?: unknown;
}): DesTrackerSnapshot {
    return parseDesTracker({
        infoBox: parts.info ? JSON.stringify(parts.info) : null,
        characterThoughts: parts.characters ? JSON.stringify(parts.characters) : null,
        quests: parts.quests ? JSON.stringify(parts.quests) : null,
    });
}

const TEXTS: Record<SceneKind, { ru: string; en: string }> = {
    combat: {
        ru: 'Орк бросился в атаку, занося топор. Лиза уклонилась, клинок сверкнул, и удар пришёлся врагу в плечо. Кровь брызнула на камни. Второй противник выхватил кинжал.',
        en: 'The bandit lunged with his sword. Mark dodged, drew his dagger and struck back; blood sprayed across the alley as the second enemy raised a pistol.',
    },
    intimate: {
        ru: 'Он притянул её к себе и поцеловал, медленно, глубоко. Её губы были горячими, пальцы скользнули по бедру, и она тихо застонала, когда он опустил её на постель, лаская её плечи.',
        en: 'She kissed him slowly, her lips trailing down his neck as he pulled her onto the bed, both of them breathless, her caress growing bolder with passion.',
    },
    exploration: {
        ru: 'Тропа петляла между холмами, уходя в густой лес. К вечеру путники добрались до заброшенной пещеры у реки, а на горизонте темнели горы.',
        en: 'They followed the old trail through the forest until the road vanished; beyond the ridge lay the ruins of an abandoned fortress and the mouth of a cave.',
    },
    timeskip: {
        ru: 'Спустя три дня отряд вернулся в город. Наутро улицы были пусты.',
        en: 'Three days later, the caravan reached the capital. The next morning the streets were empty.',
    },
    social: {
        ru: 'Бал в королевском дворце был в разгаре: музыка гремела, гости в шелках кланялись герцогу, а дамы приседали в реверансе, поднимая бокалы.',
        en: 'The ballroom glittered; the duke greeted each guest while the musicians played and the crowd of nobles raised their glasses for a toast.',
    },
    drama: {
        ru: '— Ты предал меня! — закричала она, и слёзы хлынули из глаз. — Я ненавижу тебя!\nОн молчал, не в силах вынести её гнев и обиду.',
        en: '"You betrayed me!" she screamed, tears streaming down her face. "I hate you!" He stood there, furious, unable to argue.',
    },
    dialogue: {
        ru: '— Как прошёл день? — спросила Лиза, наливая чай.\n— Неплохо, — ответил он. — Завтра поеду к сестре, она давно звала.',
        en: '"How was your day?" she asked, pouring tea.\n"Not bad," he said. "I am visiting my sister tomorrow, she has been asking for ages."',
    },
};

describe('director scene: dictionaries', () => {
    it('normalises words (lower case, ё → е)', () => {
        expect(sceneWords('Ёлка, ЛЕС и Road!')).toEqual(['елка', 'лес', 'и', 'road']);
    });

    it('counts dictionary hits with capped repeats and explicit words', () => {
        const hits = lexiconHits('меч меч меч меч меч');
        expect(hits.scores.combat).toBe(3);
        expect(hits.words).toBe(5);
        const light = lexiconHits('угроза');
        expect(light.scores.combat).toBe(0.5);
        expect(explicitHits('Она была голая, соски напряглись, оргазм накрыл её.')).toBe(3);
        expect(explicitHits('A naked blade gleamed')).toBe(1);
        expect(explicitHits('Обнажённый клинок?')).toBe(1);
        expect(explicitHits('Мечта о море')).toBe(0);
        expect(lexiconHits('мечта').scores.combat).toBe(0);
    });

    it('finds time-skip phrases in Russian and English', () => {
        expect(timeSkipHits('Спустя неделю они вернулись.')).toBe(1);
        expect(timeSkipHits('Прошло два дня. На следующее утро...')).toBe(2);
        expect(timeSkipHits('Weeks later, the next morning came.')).toBe(2);
        expect(timeSkipHits('Next morning, they left.')).toBe(1);
        expect(timeSkipHits('Прошлой ночью было тихо.')).toBe(0);
    });

    it('measures the share of direct speech', () => {
        expect(speechShare('')).toBe(0);
        expect(speechShare('Он молча шёл.')).toBe(0);
        expect(speechShare('«Привет», — сказал он.')).toBeGreaterThan(0.3);
        expect(speechShare('— Привет!\n— И тебе.')).toBe(1);
        expect(speechShare('"Hello there," he said.')).toBeGreaterThan(0.4);
    });
});

describe('director scene: tracker cues', () => {
    it('reads tension levels from numbers and words', () => {
        expect(tensionLevel('8/10')).toBe(2);
        expect(tensionLevel('5/10')).toBe(1);
        expect(tensionLevel('2/10')).toBe(0);
        expect(tensionLevel('85%')).toBe(2);
        expect(tensionLevel('7')).toBe(2);
        expect(tensionLevel('High')).toBe(2);
        expect(tensionLevel('Средняя')).toBe(1);
        expect(tensionLevel('спокойно')).toBe(0);
        expect(tensionLevel('0/0')).toBe(0);
    });

    it('takes the highest tension field and the present characters', () => {
        const snapshot = tracker({
            info: { location: 'Лес', tension: 'Low', doomTension: '9/10', mood: 'tense' },
            characters: [{ name: 'Лиза' }, { name: 'Боб', present: false }],
        });
        expect(trackerTension(snapshot)).toBe(2);
        expect(trackerTension(null)).toBe(0);
        expect(presentNames(snapshot)).toEqual(['Лиза']);
        expect(presentNames(undefined)).toEqual([]);
    });
});

describe('director scene: classification', () => {
    for (const kind of SCENE_KINDS) {
        for (const language of ['ru', 'en'] as const) {
            it(`${kind} (${language})`, () => {
                const verdict = classifyScene({ text: TEXTS[kind][language] });
                expect(verdict.type, JSON.stringify(verdict.scores)).toBe(kind);
                expect(verdict.confidence).toBeGreaterThan(0.4);
            });
        }
    }

    it('a time jump in the tracker makes a time skip, a location change helps exploration', () => {
        const verdict = classifyScene({ text: 'Они снова сидели у костра.', timeSkipped: true });
        expect(verdict.type).toBe('timeskip');
        expect(verdict.confidence).toBeGreaterThanOrEqual(0.9);
        const moved = classifyScene({ text: 'Он огляделся.', locationChanged: true });
        expect(moved.scores.exploration).toBeGreaterThan(1);
    });

    it('the tracker adds tension, recent events, location kind, a crowd and the outfit', () => {
        const base = { text: 'Он кивнул.' };
        const tense = classifyScene({ ...base, tracker: tracker({ info: { tension: 'High' } }) });
        expect(tense.scores.combat).toBeGreaterThanOrEqual(1.2);
        const medium = classifyScene({ ...base, tracker: tracker({ info: { tension: 'medium' } }) });
        expect(medium.scores.combat).toBeCloseTo(0.4);
        const events = classifyScene({
            ...base,
            tracker: tracker({ info: { recentEvents: ['Засада у моста', 'Бандит ранен'] } }),
        });
        expect(events.scores.combat).toBeGreaterThan(0.5);
        const crowd = classifyScene({
            ...base,
            tracker: tracker({
                info: { location: 'Тронный зал' },
                characters: [{ name: 'A' }, { name: 'B' }, { name: 'C' }, { name: 'D' }],
            }),
        });
        expect(crowd.type).toBe('social');
        const three = classifyScene({
            ...base,
            tracker: tracker({ characters: [{ name: 'A' }, { name: 'B' }, { name: 'C' }] }),
        });
        expect(three.scores.social).toBeCloseTo(0.8);
        const nude = classifyScene({
            ...base,
            tracker: tracker({ characters: [{ name: 'A', details: { outfit: 'naked' } }] }),
        });
        expect(nude.explicit).toBe(1);
        expect(nude.scores.intimate).toBeGreaterThanOrEqual(1.5);
    });

    it('the user message weighs less than the reply', () => {
        const verdict = classifyScene({ text: 'Он кивнул.', userText: 'Я выхватываю меч и атакую врага!' });
        expect(verdict.scores.combat).toBeGreaterThan(0);
        expect(verdict.scores.combat).toBeLessThanOrEqual(1.5);
    });

    it('explicit words make an explicit intimate scene', () => {
        const verdict = classifyScene({
            text: 'Она была совершенно голая; его пальцы сжали её соски, и она застонала от оргазма.',
        });
        expect(verdict.type).toBe('intimate');
        expect(verdict.explicit).toBe(3);
        expect(verdict.confidence).toBeGreaterThanOrEqual(0.9);
    });

    it('reports a close race as unsure', () => {
        const verdict = classifyScene({
            text: 'Он выхватил меч и атаковал. Она поцеловала его, прижавшись губами к шее.',
        });
        expect(verdict.unsure).toBe(true);
        expect([verdict.type, verdict.second].sort()).toEqual(['combat', 'intimate']);
        expect(classifyScene({ text: TEXTS.combat.en }).unsure).toBe(false);
    });

    it('confidence grows with the margin', () => {
        expect(confidenceOf(6, 0)).toBeGreaterThan(0.85);
        expect(confidenceOf(3, 2.5)).toBeLessThan(0.5);
        expect(confidenceOf(0, 0)).toBe(0.5);
        expect(confidenceOf(100, 0)).toBe(0.98);
    });
});

describe('director scene: hysteresis', () => {
    const observe = (memory: SceneMemory, type: SceneKind, confidence: number, messageIndex: number) =>
        stepScene(memory, { type, confidence, by: 'rules', messageIndex });

    it('the first decision is taken at once and the same type holds', () => {
        let memory = observe(emptySceneMemory(), 'dialogue', 0.6, 1);
        expect(memory.current).toEqual({ type: 'dialogue', confidence: 0.6, messageIndex: 1, by: 'rules', held: 1 });
        memory = observe(memory, 'dialogue', 0.7, 3);
        expect(memory.current?.held).toBe(2);
        expect(memory.current?.messageIndex).toBe(3);
    });

    it('another type needs two wins in a row, or high confidence', () => {
        let memory = observe(emptySceneMemory(), 'dialogue', 0.6, 1);
        memory = observe(memory, 'combat', 0.7, 3);
        expect(memory.current?.type).toBe('dialogue');
        expect(memory.current?.held).toBe(2);
        expect(memory.candidate).toEqual({ type: 'combat', confidence: 0.7, messageIndex: 3 });
        memory = observe(memory, 'combat', 0.6, 5);
        expect(memory.current?.type).toBe('combat');
        expect(memory.current?.held).toBe(1);
        expect(memory.candidate).toBeNull();
        memory = observe(memory, 'drama', SWITCH_CONFIDENCE, 7);
        expect(memory.current?.type).toBe('drama');
    });

    it('a different candidate in between resets the race', () => {
        let memory = observe(emptySceneMemory(), 'dialogue', 0.6, 1);
        memory = observe(memory, 'combat', 0.7, 3);
        memory = observe(memory, 'drama', 0.7, 5);
        expect(memory.current?.type).toBe('dialogue');
        expect(memory.candidate?.type).toBe('drama');
        memory = observe(memory, 'dialogue', 0.7, 7);
        expect(memory.candidate).toBeNull();
        expect(memory.current?.held).toBe(4);
    });

    it('does not change the memory it got', () => {
        const memory = observe(emptySceneMemory(), 'dialogue', 0.6, 1);
        const copy = structuredClone(memory);
        observe(memory, 'combat', 0.9, 3);
        expect(memory).toEqual(copy);
    });
});

describe('director scene: the model', () => {
    it('builds a prompt with the types, the candidates and the texts as data', () => {
        const messages = buildSceneMessages({
            text: 'Reply text',
            userText: 'User text',
            location: 'Forest',
            present: ['Liza', 'Bob'],
            candidates: ['combat', 'drama'],
        });
        expect(messages).toHaveLength(2);
        expect(messages[0]?.content).toContain('combat and drama');
        expect(messages[0]?.content).toContain('dark or explicit');
        for (const kind of SCENE_KINDS) expect(messages[0]?.content).toContain(`- ${kind}:`);
        expect(messages[1]?.content).toContain('<location>Forest</location>');
        expect(messages[1]?.content).toContain('<present>Liza, Bob</present>');
        expect(messages[1]?.content).toContain('<user_message>\nUser text\n</user_message>');
        expect(messages[1]?.content).toContain('<reply>\nReply text\n</reply>');
        const bare = buildSceneMessages({ text: 'T', candidates: ['dialogue', 'social'] });
        expect(bare[1]?.content).toBe('<reply>\nT\n</reply>');
        expect((SCENE_SCHEMA.properties as Record<string, { enum?: string[] }>).type?.enum).toEqual([...SCENE_KINDS]);
    });

    it('parses objects, JSON text and aliases; rejects junk', () => {
        expect(parseSceneAnswer({ type: 'combat', confidence: 0.9 })).toEqual({ type: 'combat', confidence: 0.9 });
        expect(parseSceneAnswer('```json\n{"type": "Fight", "confidence": 80}\n```')).toEqual({
            type: 'combat',
            confidence: 0.8,
        });
        expect(parseSceneAnswer({ type: 'time skip' })).toEqual({ type: 'timeskip', confidence: 0.7 });
        expect(parseSceneAnswer({ type: 'romance', confidence: '0.6' })).toEqual({ type: 'intimate', confidence: 0.6 });
        expect(parseSceneAnswer({ type: 'drama', confidence: -3 })).toEqual({ type: 'drama', confidence: 0 });
        expect(parseSceneAnswer({ type: 'drama', confidence: 500 })).toEqual({ type: 'drama', confidence: 1 });
        expect(parseSceneAnswer('not json')).toBeNull();
        expect(parseSceneAnswer('{broken')).toBeNull();
        expect(parseSceneAnswer('{"type": oops}')).toBeNull();
        expect(parseSceneAnswer({ type: 'picnic' })).toBeNull();
        expect(parseSceneAnswer({ confidence: 1 })).toBeNull();
        expect(parseSceneAnswer(null)).toBeNull();
        expect(parseSceneAnswer(['combat'])).toBeNull();
    });
});

describe('director scene: the user message that commits the turn', () => {
    it.each([
        ['Я выхватываю меч и бросаюсь на бандитов!', 'combat'],
        ['Бой продолжается, я отбиваю удар.', 'combat'],
        ['Атакую его, пока он не опомнился.', 'combat'],
        ['I draw my sword and charge at the bandits!', 'combat'],
        ['The fight continues; I parry and strike back.', 'combat'],
        ['Целую её и медленно раздеваю.', 'intimate'],
        ['I kiss her and slowly undress her.', 'intimate'],
        ['Она голая.', 'intimate'],
        ['Прошло три дня.', 'timeskip'],
        ['The next morning, we leave the inn.', 'timeskip'],
    ])('%s is a strong %s cue', (text, type) => {
        const cue = userCue(text);
        expect(cue).toMatchObject({ type, strong: true });
        expect(cue.confidence).toBeGreaterThanOrEqual(0.85);
        expect(cue.scores.dialogue).toBe(0);
    });

    it('weak cues and no cues', () => {
        expect(userCue('Обнимаю её за плечи.')).toMatchObject({ type: 'intimate', strong: false });
        expect(userCue('Бросаюсь на кровать и смеюсь.')).toMatchObject({ type: 'intimate', strong: false });
        expect(userCue('Хорошо, согласен.')).toMatchObject({ type: null, strong: false, confidence: 0 });
        expect(userCue('')).toMatchObject({ type: null, strong: false });
    });

    const CALM = '— Как прошёл день? — спросила Лиза, наливая чай.\n— Неплохо, — ответил он.';
    const FIGHT =
        'Орк бросился в атаку, занося топор. Лиза уклонилась, клинок сверкнул, удар пришёлся врагу в плечо. Кровь брызнула на камни. Второй противник выхватил кинжал и напал сзади, бой закипел.';

    it('a strong cue sets the type over a calm reply', () => {
        const reply = classifyScene({ text: CALM });
        expect(reply.type).toBe('dialogue');
        const combined = combineScene(reply, userCue('Я выхватываю меч и бросаюсь на бандитов!'), 0.6);
        expect(combined).toMatchObject({ type: 'combat', second: 'dialogue', unsure: false, byUser: true });
        expect(combined.confidence).toBeGreaterThanOrEqual(0.85);
        const same = combineScene(classifyScene({ text: FIGHT }), userCue('Бой продолжается, я отбиваю удар.'), 0.6);
        expect(same).toMatchObject({ type: 'combat', byUser: true });
        expect(same.second).not.toBe('combat');
    });

    it('a weak cue never overrides a clear reading of the reply, but tips a close race', () => {
        const fight = combineScene(classifyScene({ text: FIGHT }), userCue('Обнимаю её за плечи.'), 0.6);
        expect(fight).toMatchObject({ type: 'combat', byUser: false });
        const close: SceneVerdict = {
            type: 'dialogue',
            confidence: 0.5,
            second: 'drama',
            scores: { dialogue: 1.6, combat: 0, intimate: 0, exploration: 0, timeskip: 0, social: 0, drama: 1.2 },
            unsure: false,
            explicit: 1,
        };
        const tipped = combineScene(close, userCue('Кричу на него.'), 0.6);
        expect(tipped).toMatchObject({ type: 'drama', byUser: true });
        expect(close.scores.drama).toBe(1.2);
        expect(combineScene(close, userCue('Она голая.'), 0.6).explicit).toBe(2);
    });

    it('weight 0 or no cue keeps the reply reading', () => {
        const reply = classifyScene({ text: CALM });
        const strong = userCue('Я выхватываю меч!');
        expect(combineScene(reply, strong, 0)).toEqual({ ...reply, byUser: false });
        expect(combineScene(reply, null, 0.6)).toEqual({ ...reply, byUser: false });
        expect(combineScene(reply, userCue('Хорошо.'), 0.6)).toEqual({ ...reply, byUser: false });
    });

    it('the hysteresis keeps where the decision came from', () => {
        let memory = stepScene(emptySceneMemory(), {
            type: 'combat',
            confidence: 0.9,
            by: 'rules',
            messageIndex: 1,
            fromUserMessage: true,
        });
        expect(memory.current?.fromUserMessage).toBe(true);
        memory = stepScene(memory, { type: 'combat', confidence: 0.6, by: 'rules', messageIndex: 3 });
        expect(memory.current).toEqual({ type: 'combat', confidence: 0.6, messageIndex: 3, by: 'rules', held: 2 });
    });

    it('the model sees the user message the scene type is for', () => {
        const messages = buildSceneMessages({
            text: 'R',
            nextUserText: 'Я атакую',
            candidates: ['combat', 'dialogue'],
        });
        expect(messages[0]?.content).toContain("The user's latest message is given too");
        expect(messages[1]?.content).toContain('<user_latest>\nЯ атакую\n</user_latest>');
    });
});
