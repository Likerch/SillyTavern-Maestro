import { describe, expect, it } from 'vitest';
import { estimateText } from '../../src/domain/architect-text';
import type { DesCharacter } from '../../src/domain/des-tracker';
import {
    GOAL_CHARS,
    MIN_TAGS,
    VOICES_HEADER,
    attitudeNow,
    bondLine,
    detailGoals,
    detailState,
    fitVoices,
    mentionsName,
    presentBonds,
    presentCharacters,
    questsFor,
    relationOf,
    renderCard,
    renderVoices,
    sceneTracker,
    trimLevels,
} from '../../src/domain/voices-cards';
import type { RelationLike, VoiceInput, VoicesLevel } from '../../src/domain/voices-cards';

function reply(characters: unknown, extra: Record<string, unknown> = {}) {
    return {
        is_user: false,
        mes: 'reply',
        extra: {
            dooms_tracker_swipes: [
                {
                    characterThoughts: characters === null ? null : JSON.stringify(characters),
                    quests: null,
                    infoBox: null,
                    ...extra,
                },
            ],
        },
    };
}
const user = { is_user: true, mes: 'hi' };

function character(name: string, more: Partial<DesCharacter> = {}): DesCharacter {
    return { name, details: {}, stats: [], offScene: false, ...more };
}

describe('the scene', () => {
    it('reads the tracker of the committed reply (before the last user message)', () => {
        const chat = [reply([{ name: 'Old' }]), user, reply([{ name: 'Anna' }]), user, reply([{ name: 'Swiped' }])];
        const scene = sceneTracker(chat);
        expect(scene?.index).toBe(2);
        expect(scene?.snapshot.characters.map((item) => item.name)).toEqual(['Anna']);
    });

    it('looks back for a reply with character data, but takes an empty cast as it is', () => {
        const chat = [reply([{ name: 'Anna' }]), user, reply(null), user];
        expect(sceneTracker(chat)?.index).toBe(0);
        expect(sceneTracker([reply([]), user])?.snapshot.characters).toEqual([]);
        expect(sceneTracker(chat, 0)).toBeNull();
        expect(sceneTracker([user])).toBeNull();
        expect(sceneTracker([null, 'junk', { is_system: true }, user])).toBeNull();
    });

    it('keeps present characters once, without off-scene and hidden ones', () => {
        const list = [
            character('Anna'),
            character('anna '),
            character('Bob', { offScene: true }),
            character('Mira'),
            character(''),
        ];
        expect(presentCharacters(list, ['MIRA']).map((item) => item.name)).toEqual(['Anna']);
        expect(presentCharacters(list).map((item) => item.name)).toEqual(['Anna', 'Mira']);
    });
});

describe('goals, state and quests', () => {
    it('reads goal fields and the state from DES details', () => {
        const details = {
            appearance: 'tall',
            demeanor: 'guarded',
            current_goal: 'find the map',
            цели: 'сбежать',
            plans: ' ',
            claim_aims: 'x',
        };
        expect(detailGoals(details)).toEqual(['find the map', 'сбежать', 'x']);
        expect(detailState(details)).toBe('guarded');
        expect(detailState({ настроение: 'хмурое' })).toBe('хмурое');
        expect(detailState({ statement: 'no' })).toBeUndefined();
    });

    it('matches names with word boundaries and Russian endings', () => {
        expect(mentionsName('Escape with Anna', ['Anna'])).toBe(true);
        expect(mentionsName('Annual fair', ['Ann'])).toBe(false);
        expect(mentionsName('Hannah waits', ['Anna'])).toBe(false);
        expect(mentionsName('Встретиться с Анной', ['Анна', 'Анн'])).toBe(true);
        expect(mentionsName('Анналы истории', ['Анн'])).toBe(false);
        expect(mentionsName('Anna', ['A', ''])).toBe(false);
        expect(mentionsName('Ann and Ann-Marie', ['Ann'])).toBe(true);
    });

    it('finds open quests that name the character', () => {
        const quests = { main: 'Escape Velmora with Anna', optional: ['Pay Bob back', 'Ask Anna about the ring'] };
        expect(questsFor(quests, ['Anna'])).toEqual(['Escape Velmora with Anna', 'Ask Anna about the ring']);
        expect(questsFor({ main: null, optional: [] }, ['Anna'])).toEqual([]);
        expect(questsFor(null, ['Anna'])).toEqual([]);
    });
});

describe('attitudes', () => {
    const relation = (current: string, points: [number, string][]): RelationLike => ({
        from: 'Anna',
        to: 'Kai',
        current,
        history: points.map(([messageIndex, status]) => ({ messageIndex, status })),
    });

    it('finds a relation by names', () => {
        const list = [relation('Friend', [[1, 'Friend']])];
        expect(relationOf(list, 'anna', ' KAI')).toBe(list[0]);
        expect(relationOf(list, 'Kai', 'Anna')).toBeUndefined();
    });

    it('prefers the tracker and shows the M19 status it replaced', () => {
        expect(attitudeNow('Friend', relation('Rival', [[3, 'Rival']]), 10)).toEqual({
            status: 'Friend',
            was: 'Rival',
        });
        expect(attitudeNow(undefined, relation('Rival', [[3, 'Rival']]), 10)).toEqual({ status: 'Rival' });
        expect(attitudeNow('  ', undefined, 10)).toBeNull();
        expect(attitudeNow('Ally', undefined, 10)).toEqual({ status: 'Ally' });
    });

    it('shows a recent change only', () => {
        const changed = relation('Friend', [
            [2, 'Neutral'],
            [8, 'Friend'],
        ]);
        expect(attitudeNow('friend', changed, 12)).toEqual({ status: 'friend', was: 'Neutral' });
        expect(attitudeNow('Friend', changed, 30)).toEqual({ status: 'Friend' });
        expect(attitudeNow('Friend', changed, 30, 25)).toEqual({ status: 'Friend', was: 'Neutral' });
    });

    it('picks notable attitudes between present characters, newest change first', () => {
        const list: RelationLike[] = [
            { from: 'Anna', to: 'Kai', current: 'Friend', history: [{ messageIndex: 9, status: 'Friend' }] },
            { from: 'Anna', to: 'Bob', current: 'Rival', history: [{ messageIndex: 2, status: 'Rival' }] },
            { from: 'Bob', to: 'Anna', current: 'Crush', history: [{ messageIndex: 7, status: 'Crush' }] },
            { from: 'Bob', to: 'Mira', current: 'Wary', history: [] },
            { from: 'Mira', to: 'Bob', current: 'Fond', history: [] },
            { from: 'Bob', to: 'Bob', current: 'Self', history: [] },
            { from: 'Bob', to: 'Zed', current: 'Enemy', history: [] },
            { from: 'Mira', to: 'Anna', current: ' ', history: [] },
        ];
        const bonds = presentBonds(list, ['Anna', 'Bob', 'Mira', 'Kai'], 'Kai');
        expect(bonds).toEqual([
            { from: 'Bob', to: 'Anna', status: 'Crush' },
            { from: 'Anna', to: 'Bob', status: 'Rival' },
            { from: 'Bob', to: 'Mira', status: 'Wary' },
        ]);
        expect(presentBonds(list, ['Anna', 'Bob'], 'Kai', 1)).toHaveLength(1);
        expect(bondLine(bonds[0]!)).toBe('[Bond] Bob → Anna: Crush');
    });
});

const ANNA: VoiceInput = {
    name: 'Anna',
    entityId: 'character:anna',
    aliases: ['Annie'],
    voice: {
        ling: ['blunt', 'soft spoken', 'formal', 'curt'],
        linguistics:
            'Annie uses an archaic register. She often trails off mid-sentence. Speaks with a faint northern lilt.',
        mbti: { type: 'INFP', variant: 'H' },
    },
    state: 'guarded',
    persona: 'Kai',
    attitude: { status: 'Friend', was: 'Rival' },
    goals: ['find the map', 'quest: Escape Velmora with Anna'],
};

const FULL: VoicesLevel = { goals: true, bonds: true, prose: 220, state: true, extras: true, cards: 9 };

describe('cards', () => {
    it('renders the card line in the agreed format', () => {
        const card = renderCard(ANNA, FULL);
        expect(card?.text).toBe(
            '[Voice: Anna] Speech: blunt, soft spoken, formal, curt; an archaic register; often trails off mid-sentence; ' +
                'a faint northern lilt | MBTI: INFP-H (healthy; now: guarded) | Toward Kai: Friend (was Rival) | ' +
                'Goals: find the map; quest: Escape Velmora with Anna',
        );
        expect(card).toMatchObject({
            name: 'Anna',
            entityId: 'character:anna',
            mbti: 'INFP-H (healthy; now: guarded)',
            attitude: 'Friend (was Rival)',
            goals: 'find the map; quest: Escape Velmora with Anna',
        });
        expect(card?.tokens).toBe(estimateText(card?.text ?? ''));
    });

    it('shows the state without MBTI, later-stage fields, and nothing for an empty card', () => {
        const bare: VoiceInput = { name: 'Bob', voice: null, persona: '', state: 'tense', goals: [] };
        expect(renderCard(bare, FULL)?.text).toBe('[Voice: Bob] Now: tense');
        const extra = renderCard(
            { ...bare, attitude: { status: 'Ally' }, unknown: 'the ring was stolen', stats: 'HP 40/100' },
            FULL,
        );
        expect(extra?.text).toBe(
            '[Voice: Bob] Now: tense | Toward the user: Ally | Unaware of: the ring was stolen | Stats: HP 40/100',
        );
        expect(extra).toMatchObject({ unknown: 'the ring was stolen', stats: 'HP 40/100', speech: '' });
        expect(renderCard({ ...bare, state: undefined }, FULL)).toBeNull();
        expect(renderCard({ ...bare, unknown: 'x' }, { ...FULL, extras: false, state: false })).toBeNull();
    });

    it('cuts long goals', () => {
        const card = renderCard({ ...ANNA, goals: ['x'.repeat(400)] }, FULL);
        expect(card?.goals?.length).toBeLessThanOrEqual(GOAL_CHARS + 1);
    });

    it('renders the injection: header, cards, bonds; nothing without cards', () => {
        const bonds = [{ from: 'Anna', to: 'Bob', status: 'Rival' }];
        const rendered = renderVoices([ANNA], bonds, FULL);
        expect(rendered.text.split('\n')).toEqual([VOICES_HEADER, rendered.cards[0]?.text, '[Bond] Anna → Bob: Rival']);
        expect(renderVoices([ANNA], bonds, { ...FULL, bonds: false }).bonds).toEqual([]);
        expect(renderVoices([], bonds, FULL)).toEqual({ cards: [], bonds: [], text: '' });
        expect(renderVoices([ANNA], bonds, { ...FULL, cards: 0 }).text).toBe('');
    });
});

describe('budget', () => {
    const BOB: VoiceInput = {
        name: 'Bob',
        voice: { ling: ['gruff'], linguistics: 'He swears a lot.', mbti: { type: 'ESTP', variant: 'U' } },
        state: 'angry',
        persona: 'Kai',
        attitude: { status: 'Enemy' },
        goals: ['get paid'],
    };
    const bonds = [{ from: 'Bob', to: 'Anna', status: 'Crush' }];

    it('lists the levels from full down to no cards', () => {
        const steps = [...trimLevels({ ...FULL, cards: 2 })].map(([step]) => step);
        expect(steps).toEqual([
            null,
            'goals',
            'bonds',
            'speech',
            'speech',
            'speech',
            'state',
            'extras',
            'cards',
            'cards',
        ]);
        const last = [...trimLevels({ ...FULL, cards: 1 })].pop()?.[1];
        expect(last).toMatchObject({ goals: false, bonds: false, prose: 0, maxTags: MIN_TAGS, state: false, cards: 0 });
        expect([
            ...trimLevels({
                ...FULL,
                goals: false,
                bonds: false,
                prose: 0,
                maxTags: 2,
                state: false,
                extras: false,
                cards: 0,
            }),
        ]).toHaveLength(1);
    });

    it('keeps everything under a large budget and with no budget', () => {
        const fitted = fitVoices([ANNA, BOB], bonds, { budget: 5000 });
        expect(fitted.trimmed).toEqual([]);
        expect(fitted.bonds).toEqual(['[Bond] Bob → Anna: Crush']);
        expect(fitted.tokens).toBe(estimateText(fitted.text));
        expect(fitVoices([ANNA, BOB], bonds, { budget: 0 }).text).toBe(fitted.text);
    });

    it('drops goals first, then attitudes between characters, then shortens speech', () => {
        const full = fitVoices([ANNA, BOB], bonds, { budget: 5000 });
        const withoutGoals = renderVoices([ANNA, BOB], bonds, { ...FULL, goals: false });
        const noGoals = fitVoices([ANNA, BOB], bonds, { budget: estimateText(withoutGoals.text) });
        expect(noGoals.trimmed).toEqual(['goals']);
        expect(noGoals.text).not.toContain('Goals:');
        expect(noGoals.text).toContain('[Bond]');

        const noBondsText = renderVoices([ANNA, BOB], bonds, { ...FULL, goals: false, bonds: false }).text;
        const noBonds = fitVoices([ANNA, BOB], bonds, { budget: estimateText(noBondsText) });
        expect(noBonds.trimmed).toEqual(['goals', 'bonds']);
        expect(noBonds.bonds).toEqual([]);
        expect(noBonds.cards[0]?.speech).toBe(full.cards[0]?.speech);

        const shorter = fitVoices([ANNA, BOB], bonds, { budget: estimateText(noBondsText) - 10 });
        expect(shorter.trimmed).toEqual(['goals', 'bonds', 'speech']);
        expect(shorter.cards[0]?.speech.length).toBeLessThan(full.cards[0]?.speech.length ?? 0);
        expect(shorter.tokens).toBeLessThanOrEqual(estimateText(noBondsText) - 10);
    });

    it('then leaves out the state and drops cards from the end', () => {
        const tagsOnly = renderVoices([ANNA, BOB], [], {
            ...FULL,
            goals: false,
            bonds: false,
            prose: 0,
            maxTags: MIN_TAGS,
        });
        const noState = fitVoices([ANNA, BOB], [], { budget: estimateText(tagsOnly.text) - 3 });
        expect(noState.trimmed).toContain('state');
        expect(noState.text).not.toContain('now:');

        const one = fitVoices([ANNA, BOB], [], { budget: estimateText(`${VOICES_HEADER}\n${noState.cards[0]?.text}`) });
        expect(one.cards.map((card) => card.name)).toEqual(['Anna']);
        expect(one.dropped).toEqual(['Bob']);
        expect(one.trimmed.at(-1)).toBe('cards');

        const none = fitVoices([ANNA, BOB], [], { budget: 5 });
        expect(none).toMatchObject({ cards: [], text: '', tokens: 0, dropped: ['Anna', 'Bob'] });
    });

    it('respects the goals and bonds settings without counting them as trimming', () => {
        const fitted = fitVoices([ANNA], bonds, { budget: 5000, goals: false, bonds: false });
        expect(fitted.text).not.toContain('Goals:');
        expect(fitted.text).not.toContain('[Bond]');
        expect(fitted.trimmed).toEqual([]);
        expect(fitVoices([ANNA], bonds, { budget: 5000, count: () => 1, header: '[H]' }).text.startsWith('[H]\n')).toBe(
            true,
        );
    });
});
