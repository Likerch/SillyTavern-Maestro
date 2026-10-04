import { describe, expect, it } from 'vitest';
import { buildDirectorNote, hasUnresolvedWords, pickTwist, shorten, twistKey } from '../../src/domain/director-note';
import type { TwistSource } from '../../src/domain/director-note';

function twist(kind: TwistSource['kind'], text: string, weight: number): TwistSource {
    return { kind, text, weight, key: twistKey(kind, text) };
}

describe('director note: sources', () => {
    it('recognises open business in Russian and English', () => {
        expect(hasUnresolvedWords('Он поклялся вернуть долг до зимы.')).toBe(true);
        expect(hasUnresolvedWords('Тайна медальона так и не раскрыта.')).toBe(true);
        expect(hasUnresolvedWords('She swore revenge on the baron.')).toBe(true);
        expect(hasUnresolvedWords('Он долго смотрел в окно.')).toBe(false);
        expect(hasUnresolvedWords('They returned to the inn and slept.')).toBe(false);
    });

    it('keys twists by kind and normalised text', () => {
        expect(twistKey('quest', 'Найти  Ёлку')).toBe('quest:найти ёлку'.replace('ё', 'е'));
    });

    it('shortens on a word boundary', () => {
        expect(shorten('  short  text ')).toBe('short text');
        const long = 'слово '.repeat(60);
        const cut = shorten(long, 40);
        expect(cut.length).toBeLessThanOrEqual(41);
        expect(cut.endsWith('…')).toBe(true);
        expect(shorten('x'.repeat(50), 20)).toBe(`${'x'.repeat(20)}…`);
    });

    it('picks the heaviest fresh twist, falling back to a used one', () => {
        const quest = twist('quest', 'Найти пропавшего брата', 3);
        const thread = twist('thread', 'Долг перед гильдией', 2);
        const deadline = twist('deadline', 'Свадьба в субботу', 4);
        expect(pickTwist([])).toBeNull();
        expect(pickTwist([twist('quest', '  ', 3)])).toBeNull();
        expect(pickTwist([thread, quest, deadline])).toBe(deadline);
        expect(pickTwist([thread, quest, deadline], [deadline.key])).toBe(quest);
        expect(pickTwist([quest], [quest.key])).toBe(quest);
        expect(pickTwist([quest, twist('thread', 'Другое', 3)])).toBe(quest);
    });
});

describe('director note: text', () => {
    it('explains the stall and the twist in English, without softening, never writing for the user', () => {
        const text = buildDirectorNote({
            twist: twist('quest', 'Найти пропавшего брата', 3),
            reasons: ['samePlace', 'noEvents'],
            turns: 5,
            scene: 'dialogue',
            userName: 'Алекс',
        });
        expect(text).toContain("[Director's note: pacing]");
        expect(text).toContain('the scene has stayed in one place for 5 turns; nothing has changed for 5 turns');
        expect(text).toContain('advance the open quest "Найти пропавшего брата"');
        expect(text).toContain('do not soften, censor, summarize or cut away');
        expect(text).toContain('do not write actions, words or thoughts for Алекс');
        expect(text).not.toContain('intimate');
    });

    it('covers every source kind, nudges and intimate scenes', () => {
        const base = { reasons: [] as const, turns: 1, scene: null, userName: '' };
        expect(buildDirectorNote({ ...base, twist: twist('thread', 'Долг', 2) })).toContain(
            'bring back the unresolved thread "Долг"',
        );
        expect(buildDirectorNote({ ...base, twist: twist('deadline', 'Wedding', 4) })).toContain(
            'the promise or deadline "Wedding" comes due now',
        );
        expect(buildDirectorNote({ ...base, twist: twist('offscreen', 'Bob: left town', 2) })).toContain(
            'what happened offscreen reaches the scene: Bob: left town',
        );
        expect(buildDirectorNote({ ...base, twist: twist('mechanic', 'The poison takes effect', 2) })).toContain(
            'on your own initiative: The poison takes effect.',
        );
        const stalled = buildDirectorNote({ ...base, twist: twist('thread', 'X', 1) });
        expect(stalled).toContain('The story has stalled.');
        expect(stalled).toContain('for the user');
        const nudged = buildDirectorNote({
            ...base,
            reasons: ['loop', 'repetition'],
            nudged: true,
            scene: 'intimate',
            twist: twist('quest', 'Q', 3),
        });
        expect(nudged).toContain('The story needs a push now.');
        expect(nudged).toContain('without interrupting or cutting the current intimate scene short');
        const reasons = buildDirectorNote({ ...base, reasons: ['loop', 'repetition'], twist: twist('quest', 'Q', 3) });
        expect(reasons).toContain('the conversation keeps circling the same topic; the replies repeat themselves');
    });
});
