import { describe, expect, it } from 'vitest';
import {
    LOOP_AVERAGE,
    detectStall,
    isRepetitive,
    noteAllowed,
    repeatedNgrams,
    steeringReason,
    topicWords,
} from '../../src/domain/director-pacing';
import type { TurnRecord } from '../../src/domain/director-pacing';

function turn(index: number, patch: Partial<TurnRecord> = {}): TurnRecord {
    return { index, place: 'place:tavern', events: 0, known: true, repetition: false, topic: [], ...patch };
}

function quiet(count: number, patch: Partial<TurnRecord> = {}): TurnRecord[] {
    return Array.from({ length: count }, (_, i) => turn(i * 2, patch));
}

describe('director pacing: stall detection', () => {
    it('needs a full window', () => {
        expect(detectStall(quiet(3), 4)).toEqual({ turns: 3, reasons: [], stalled: false });
        expect(detectStall([], 4)).toEqual({ turns: 0, reasons: [], stalled: false });
    });

    it('same place and nothing happening for N turns is a stall', () => {
        const result = detectStall(quiet(4), 4);
        expect(result.reasons).toEqual(['samePlace', 'noEvents']);
        expect(result.stalled).toBe(true);
        expect(result.turns).toBe(4);
    });

    it('an event in the window breaks it; turns count from the last event', () => {
        const records = [...quiet(4)];
        records[2] = turn(4, { events: 1 });
        const result = detectStall(records, 4);
        expect(result.reasons).toEqual(['samePlace']);
        expect(result.stalled).toBe(false);
        expect(result.turns).toBe(1);
    });

    it('unknown places or unobserved turns give no reason', () => {
        expect(detectStall(quiet(4, { place: null }), 4).reasons).toEqual(['noEvents']);
        const unobserved = detectStall(quiet(4, { known: false }), 4);
        expect(unobserved.reasons).toEqual(['samePlace']);
        expect(unobserved.turns).toBe(4);
        expect(detectStall(quiet(4, { place: null }), 4).stalled).toBe(false);
    });

    it('repetition in two turns of the window', () => {
        const records = quiet(4, { place: null, known: false });
        records[1] = { ...records[1]!, repetition: true };
        expect(detectStall(records, 4).reasons).toEqual([]);
        records[3] = { ...records[3]!, repetition: true };
        expect(detectStall(records, 4).reasons).toEqual(['repetition']);
    });

    it('a conversation circling one topic; with repetition it is a stall on its own', () => {
        const topic = ['меч', 'кузнец', 'цена', 'сталь', 'заказ'];
        const records = quiet(4, { place: null, known: false, topic });
        expect(detectStall(records, 4).reasons).toEqual(['loop']);
        expect(detectStall(records, 4).stalled).toBe(false);
        records[2] = { ...records[2]!, repetition: true };
        records[3] = { ...records[3]!, repetition: true };
        expect(detectStall(records, 4)).toMatchObject({ reasons: ['repetition', 'loop'], stalled: true });
        const drifting = quiet(4, { place: null, known: false });
        drifting.forEach((record, i) => (record.topic = [`a${i}`, `b${i}`, 'общий']));
        expect(detectStall(drifting, 4).reasons).toEqual([]);
        expect(LOOP_AVERAGE).toBeGreaterThan(0);
    });

    it('treats N below 2 as 2', () => {
        expect(detectStall(quiet(2), 1).stalled).toBe(true);
    });
});

describe('director pacing: topic and repetition', () => {
    it('takes frequent content stems without names, filler and stop words', () => {
        const text =
            'Лиза снова спросила про меч. Кузнец назвал цену за меч, Лиза покачала головой: цена за меч слишком высока.';
        const topic = topicWords(text, 3);
        expect(topic[0]).toBe('меч');
        expect(topic).toContain('цен');
        expect(topic).not.toContain('лиз');
        expect(topicWords('Мария ждала. Потом Мария ушла к Мартину.', 10, ['Мартин'])).toEqual(['ждал', 'ушл']);
        expect(topicWords('The sword, the sword and the price.', 2)).toEqual(['sword', 'price']);
        expect(topicWords('ab 1234 the you', 5)).toEqual([]);
        expect(topicWords('сказал сказала глаза', 5)).toEqual([]);
        expect(topicWords('текст', 0)).toEqual([]);
    });

    it('counts repeated word 4-grams', () => {
        const earlier = ['Her eyes sparkled with mischief as she leaned closer to him.'];
        expect(repeatedNgrams('Her eyes sparkled with mischief again.', earlier)).toEqual({ repeated: 2, total: 3 });
        expect(repeatedNgrams('Too short', earlier)).toEqual({ repeated: 0, total: 0 });
        expect(isRepetitive('Her eyes sparkled with mischief as she leaned closer, smiling.', earlier)).toBe(true);
        expect(isRepetitive('A completely different reply about the weather and the road ahead.', earlier)).toBe(false);
        const long = Array.from({ length: 30 }, (_, i) => `word${i}`).join(' ');
        expect(isRepetitive(`${long} and more unique words here to dilute it all`, [long])).toBe(true);
    });
});

describe('director pacing: frequency', () => {
    it('allows a note only when notes are on and enough turns passed', () => {
        expect(noteAllowed(0, 100)).toBe(false);
        expect(noteAllowed(6, 5)).toBe(false);
        expect(noteAllowed(6, 6)).toBe(true);
        expect(noteAllowed(4, 4)).toBe(true);
    });
});

describe('director pacing: the user steers', () => {
    it.each([
        ['((пусть она уйдёт))', 'ooc'],
        ['[OOC: make it rain]', 'ooc'],
        ['(OOC пропусти вечер)', 'ooc'],
        ['ooc: speed up', 'ooc'],
        ['Вне роли: ускорь сюжет', 'ooc'],
        ['[Сцена переносится в порт на рассвете]', 'ooc'],
        ['Напиши постельную сцену подробно.', 'request'],
        ['Describe the fight scene in detail.', 'request'],
        ['Давай пойдём в таверну.', 'plot'],
        ['Пусть стражник нас заметит.', 'plot'],
        ["Let's go to the market.", 'plot'],
        ['Suddenly, a dragon lands in the square.', 'plot'],
        ['Вдруг в дверь постучали.', 'plot'],
        ['На следующий день мы выехали.', 'plot'],
        ['I want you to make her angry.', 'plot'],
    ])('%s → %s', (text, reason) => {
        expect(steeringReason(text)).toBe(reason);
    });

    it('a long message describing events steers', () => {
        const sentence = 'Я медленно обхожу комнату и осматриваю каждый угол, касаясь старых полок рукой. ';
        expect(steeringReason(sentence.repeat(10))).toBe('long');
        expect(steeringReason(`${'а'.repeat(800)}`)).toBeNull();
    });

    it('an ordinary in-character line does not', () => {
        expect(steeringReason('— Как дела? — спрашиваю я.')).toBeNull();
        expect(steeringReason('*kisses her hand* Good evening, my lady.')).toBeNull();
        expect(steeringReason('')).toBeNull();
        expect(steeringReason(undefined)).toBeNull();
        expect(steeringReason('[ok]')).toBeNull();
    });
});
