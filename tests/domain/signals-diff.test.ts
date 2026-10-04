import { describe, expect, it } from 'vitest';
import type { DesCharacter, DesTrackerSnapshot } from '../../src/domain/des-tracker';
import {
    compareLocations,
    emptyBaseline,
    fieldAspect,
    foldSignals,
    foldKey,
    observe,
    relationshipChanged,
    rollbackTrace,
    sameQuest,
    step,
} from '../../src/domain/signals-diff';
import type {
    MemoryObservation,
    Observation,
    RawSignal,
    SignalsBaseline,
    StepInput,
} from '../../src/domain/signals-diff';
import { findNameCandidates } from '../../src/domain/signals-names';

interface CharSpec {
    name: string;
    rel?: string;
    appearance?: string;
    outfit?: string;
    present?: boolean;
}

interface SnapSpec {
    chars?: CharSpec[];
    location?: string;
    date?: string;
    start?: string;
    end?: string;
    main?: string | null;
    optional?: string[];
    noQuests?: boolean;
}

function snapshot(spec: SnapSpec): DesTrackerSnapshot {
    const characters: DesCharacter[] = (spec.chars ?? []).map((char) => {
        const details: Record<string, string> = { demeanor: 'calm' };
        if (char.appearance) details.appearance = char.appearance;
        if (char.outfit) details.outfit = char.outfit;
        const character: DesCharacter = { name: char.name, details, stats: [], offScene: char.present === false };
        if (char.rel) character.relationship = char.rel;
        return character;
    });
    const infoBox =
        spec.location || spec.date || spec.start
            ? {
                  recentEvents: [],
                  fields: {},
                  ...(spec.location ? { location: spec.location } : {}),
                  ...(spec.date ? { date: spec.date } : {}),
                  ...(spec.start || spec.end
                      ? {
                            time: {
                                ...(spec.start ? { start: spec.start } : {}),
                                ...(spec.end ? { end: spec.end } : {}),
                            },
                        }
                      : {}),
              }
            : null;
    const quests = spec.noQuests ? null : { main: spec.main ?? null, optional: spec.optional ?? [] };
    return { characters, infoBox, quests };
}

const obs = (spec: SnapSpec): Observation => observe(snapshot(spec)) as Observation;
const OPTIONS = { timeSkipHours: 6, appearanceThreshold: 0.5 };

/** Runs a sequence of turns; returns the signals of each turn. */
function run(
    turns: (SnapSpec | null)[],
    baseline: SignalsBaseline = emptyBaseline(),
    extra: (index: number) => Partial<StepInput> = () => ({}),
): RawSignal[][] {
    let previous: Observation | null = null;
    return turns.map((spec, index) => {
        const current = spec ? obs(spec) : null;
        const result = step(baseline, { current, previous, options: OPTIONS, ...extra(index) });
        if (current) previous = current;
        return result.signals;
    });
}

const kinds = (signals: RawSignal[]) => signals.map((signal) => signal.kind);

describe('observe', () => {
    it('reduces a snapshot to what signals compare', () => {
        const observation = observe(
            snapshot({
                chars: [
                    { name: 'Аня', rel: 'Friendly', appearance: 'red hair', present: true },
                    { name: 'Anna', present: false },
                    { name: '  ' },
                ],
                location: 'Tavern',
                date: 'Day 1',
                start: '18:00',
                end: '19:00',
                main: 'Find the amulet',
                optional: ['Pay the debt'],
            }),
            (name) => (name === 'Аня' ? 'Anna' : name),
        );
        expect(observation).toEqual({
            chars: [{ key: 'anna', name: 'Anna', rel: 'Friendly', fields: { appearance: 'red hair' }, present: true }],
            location: 'Tavern',
            date: 'Day 1',
            start: '18:00',
            end: '19:00',
            quests: [
                { title: 'Find the amulet', main: true },
                { title: 'Pay the debt', main: false },
            ],
        });
        expect(observe(null)).toBeNull();
        expect(observe({ characters: [], infoBox: null, quests: null })).toBeNull();
        expect(observe(snapshot({ noQuests: true, location: 'Unknown' }))).toEqual({
            chars: [],
            location: null,
            quests: null,
        });
        expect(observe(snapshot({ main: null }))?.quests).toEqual([]);
    });

    it('knows appearance and outfit fields in English and Russian', () => {
        expect(fieldAspect('appearance')).toBe('appearance');
        expect(fieldAspect('hair_color')).toBe('appearance');
        expect(fieldAspect('внешность')).toBe('appearance');
        expect(fieldAspect('current_outfit')).toBe('outfit');
        expect(fieldAspect('одежда')).toBe('outfit');
        expect(fieldAspect('demeanor')).toBeNull();
    });
});

describe('comparisons', () => {
    it('compares relationship statuses by word sets', () => {
        expect(relationshipChanged('Friendly', 'very friendly.')).toBe(false);
        expect(relationshipChanged('Friendly', 'Hostile')).toBe(true);
        expect(relationshipChanged('?!', '…')).toBe(true);
    });

    it('compares locations', () => {
        expect(compareLocations('The Tavern', 'tavern')).toBe('same');
        expect(compareLocations('Main Hall, Rusty Anchor Tavern', 'Rusty Anchor Tavern')).toBe('same');
        expect(compareLocations('Rusty Anchor Tavern', 'Rusty Anchor Tavern, Kitchen')).toBe('refined');
        expect(compareLocations('Tavern, Kitchen', 'Tavern, Main Hall')).toBe('different');
        expect(compareLocations('Old Mill Road near the river', 'Old Mill Road by the river')).toBe('same');
    });

    it('compares quests', () => {
        expect(sameQuest('Find the amulet', 'find the AMULET')).toBe(true);
        expect(sameQuest('Find the lost amulet', 'Find the amulet')).toBe(true);
        expect(sameQuest('Find the lost amulet of the queen', 'Find amulet')).toBe(true);
        expect(sameQuest('Escape the city', 'Find the amulet')).toBe(false);
    });
});

describe('step: characters', () => {
    it('sets baselines silently, then reports relationship changes at once', () => {
        const signals = run([
            { chars: [{ name: 'Anna', rel: 'Neutral' }] },
            { chars: [{ name: 'Anna', rel: 'neutral' }] },
            { chars: [{ name: 'Anna', rel: 'Friendly' }] },
            { chars: [{ name: 'Anna' }] },
        ]);
        expect(signals[0]).toEqual([]);
        expect(kinds(signals[1]!)).toEqual(['character.appeared']);
        expect(signals[2]).toEqual([
            {
                kind: 'relationship.changed',
                subject: { type: 'character', name: 'Anna' },
                data: { name: 'Anna', from: 'Neutral', to: 'Friendly' },
            },
        ]);
        expect(signals[3]).toEqual([]);
    });

    it('reports an appearance or outfit change only when it holds two turns', () => {
        const signals = run([
            { chars: [{ name: 'Anna', outfit: 'red dress, silver necklace' }] },
            { chars: [{ name: 'Anna', outfit: 'a red dress and a silver necklace' }] },
            { chars: [{ name: 'Anna', outfit: 'leather armor, sword belt' }] },
            { chars: [{ name: 'Anna', outfit: 'red dress, silver necklace' }] },
            { chars: [{ name: 'Anna', outfit: 'leather armor, sword belt' }] },
            { chars: [{ name: 'Anna', outfit: 'leather armour and a sword belt' }] },
        ]);
        const changes = signals.map((list) => list.filter((signal) => signal.kind === 'appearance.changed'));
        expect(changes.slice(0, 5).flat()).toEqual([]);
        expect(changes[5]).toEqual([
            {
                kind: 'appearance.changed',
                subject: { type: 'character', name: 'Anna' },
                data: {
                    name: 'Anna',
                    changes: [
                        {
                            field: 'outfit',
                            aspect: 'outfit',
                            from: 'red dress, silver necklace',
                            to: 'leather armour and a sword belt',
                            added: ['leather', 'armour', 'sword', 'belt'],
                            removed: ['red', 'dress', 'silver', 'necklace'],
                        },
                    ],
                },
            },
        ]);
    });

    it('reports characters appearing and leaving after two turns', () => {
        const signals = run([
            { chars: [{ name: 'Anna' }] },
            { chars: [{ name: 'Anna' }] },
            { chars: [{ name: 'Anna' }, { name: 'Bob' }] },
            { chars: [{ name: 'Anna' }, { name: 'Bob' }] },
            { chars: [{ name: 'Anna' }, { name: 'Bob', present: false }] },
            { chars: [{ name: 'Anna' }] },
            { chars: [{ name: 'Anna' }, { name: 'Bob' }] },
            { chars: [{ name: 'Anna' }, { name: 'Bob' }] },
        ]);
        expect(signals[1]).toEqual([
            {
                kind: 'character.appeared',
                subject: { type: 'character', name: 'Anna' },
                data: { name: 'Anna', first: true },
            },
        ]);
        expect(signals[2]).toEqual([]);
        expect(signals[3]?.map((signal) => signal.data)).toEqual([{ name: 'Bob', first: true }]);
        expect(signals[4]).toEqual([]);
        expect(signals[5]).toEqual([
            { kind: 'character.left', subject: { type: 'character', name: 'Bob' }, data: { name: 'Bob' } },
        ]);
        expect(signals[6]).toEqual([]);
        expect(signals[7]?.map((signal) => signal.data)).toEqual([{ name: 'Bob', first: false }]);
    });

    it('needs a previous tracker for two-turn rules', () => {
        const baseline = emptyBaseline();
        step(baseline, {
            current: obs({ chars: [{ name: 'Anna', outfit: 'dress' }] }),
            previous: null,
            options: OPTIONS,
        });
        const result = step(baseline, {
            current: obs({ chars: [{ name: 'Anna', outfit: 'plate armor helmet' }] }),
            previous: null,
            options: OPTIONS,
        });
        expect(result.signals).toEqual([]);
    });
});

describe('step: places, time and quests', () => {
    it('reports a DES location change after two turns, then a scene end', () => {
        const signals = run([
            { location: 'Rusty Anchor Tavern, Main Hall' },
            { location: 'Rusty Anchor Tavern' },
            { location: 'Rusty Anchor Tavern, Kitchen' },
            { location: 'Old Forest' },
            { location: 'Rusty Anchor Tavern, Kitchen' },
            { location: 'Old Forest, clearing' },
            { location: 'The old forest clearing' },
            {},
        ]);
        expect(signals.slice(0, 6).flat()).toEqual([]);
        expect(signals[6]).toEqual([
            {
                kind: 'location.changed',
                subject: { type: 'place', name: 'The old forest clearing' },
                data: { from: 'Rusty Anchor Tavern, Main Hall', to: 'The old forest clearing', via: 'des' },
            },
            { kind: 'scene.ended', data: { reasons: ['location'] } },
        ]);
        expect(signals[7]).toEqual([]);
    });

    it('takes place changes from the registry when it is on', () => {
        const baseline = emptyBaseline();
        const entered = { id: 'p-2', name: 'Kitchen', previousId: 'p-1', previousName: 'Main Hall' };
        const signals = run(
            [{ location: 'Main Hall' }, { location: 'Kitchen' }, { location: 'Kitchen' }, null],
            baseline,
            (index) => ({ registry: { entered: index === 1 || index === 3 ? entered : null } }),
        );
        expect(signals[0]).toEqual([]);
        expect(signals[1]).toEqual([
            {
                kind: 'location.changed',
                subject: { type: 'place', name: 'Kitchen', id: 'p-2' },
                data: { from: 'Main Hall', to: 'Kitchen', placeId: 'p-2', previousPlaceId: 'p-1', via: 'places' },
            },
            { kind: 'scene.ended', data: { reasons: ['location'] } },
        ]);
        // The DES rule is off; the same place again is no change.
        expect(signals[2]).toEqual([]);
        expect(signals[3]).toEqual([]);
        expect(baseline.placeId).toBe('p-2');
        const fresh = emptyBaseline();
        step(fresh, {
            current: null,
            previous: null,
            registry: { entered: { id: 'p-9', name: 'Dock', previousId: null, previousName: null } },
            options: OPTIONS,
        });
        expect(fresh).toMatchObject({ location: 'Dock', placeId: 'p-9' });
    });

    it('reports time skips and keeps the last date', () => {
        const signals = run([
            { date: 'Day 1', start: '08:00', end: '09:00' },
            { start: '10:00' },
            { date: 'Day 1', start: '20:00' },
            { date: 'Day 3' },
            { start: '07:00' },
        ]);
        expect(signals[0]).toEqual([]);
        expect(signals[1]).toEqual([]);
        expect(signals[2]).toEqual([
            {
                kind: 'time.skipped',
                data: {
                    dateChanged: false,
                    fromDate: 'Day 1',
                    toDate: 'Day 1',
                    fromTime: '10:00',
                    toTime: '20:00',
                    hours: 10,
                },
            },
            { kind: 'scene.ended', data: { reasons: ['time'] } },
        ]);
        expect(signals[3]).toEqual([
            {
                kind: 'time.skipped',
                data: { dateChanged: true, fromDate: 'Day 1', toDate: 'Day 3', fromTime: '20:00', hours: 48 },
            },
            { kind: 'scene.ended', data: { reasons: ['time'] } },
        ]);
        expect(signals[4]).toEqual([]);
    });

    it('reports both reasons in one scene end', () => {
        const signals = run([
            { location: 'Tavern', date: 'Day 1' },
            { location: 'Forest', date: 'Day 1' },
            { location: 'Forest', date: 'Day 2' },
        ]);
        expect(signals[2]?.at(-1)).toEqual({ kind: 'scene.ended', data: { reasons: ['location', 'time'] } });
    });

    it('reports quests added and removed after two turns, rewordings ignored', () => {
        const signals = run([
            { main: 'Find the amulet' },
            { main: 'Find the lost amulet', optional: ['Pay the debt to Hale'] },
            { main: 'Find the amulet', optional: ['Pay Hale the debt'] },
            { main: 'Find the amulet' },
            { main: null, noQuests: true },
            { main: 'Find the amulet' },
            { main: 'Escape the city' },
            { main: 'Escape the burning city' },
        ]);
        expect(signals[0]).toEqual([]);
        expect(signals[1]).toEqual([]);
        expect(signals[2]).toEqual([
            {
                kind: 'quest.added',
                subject: { type: 'quest', name: 'Pay Hale the debt' },
                data: { title: 'Pay Hale the debt', main: false },
            },
        ]);
        expect(signals[3]).toEqual([]);
        expect(signals[4]).toEqual([]);
        expect(signals[5]).toEqual([
            {
                kind: 'quest.removed',
                subject: { type: 'quest', name: 'Pay Hale the debt' },
                data: { title: 'Pay Hale the debt', main: false },
            },
        ]);
        expect(signals[6]).toEqual([]);
        expect(kinds(signals[7]!)).toEqual(['quest.added', 'quest.removed']);
        expect(signals[7]?.map((signal) => signal.data)).toEqual([
            { title: 'Escape the burning city', main: true },
            { title: 'Find the amulet', main: true },
        ]);
    });
});

describe('step: aliases, memories and names', () => {
    it('reports new DES aliases after the first look', () => {
        const baseline = emptyBaseline();
        const go = (aliases: Record<string, string[]>) =>
            step(baseline, { current: null, previous: null, aliases, options: OPTIONS }).signals;
        expect(go({ Anna: ['Аня'] })).toEqual([]);
        expect(go({ Anna: ['Аня', 'Анечка', 'анечка', 'Anna', ' '], Bob: ['Бобби'] })).toEqual([
            {
                kind: 'alias.added',
                subject: { type: 'character', name: 'Anna' },
                data: { name: 'Anna', aliases: ['Анечка'] },
            },
            {
                kind: 'alias.added',
                subject: { type: 'character', name: 'Bob' },
                data: { name: 'Bob', aliases: ['Бобби'] },
            },
        ]);
        expect(go({ Anna: ['Аня'] })).toEqual([]);
        expect(baseline.aliases).toEqual({ Anna: ['аня'] });
        expect(go({ Anna: ['Аня', 'Анечка'] })).toHaveLength(1);
    });

    it('reports new Qvink memories and long-term flags', () => {
        const baseline = emptyBaseline();
        const memory = (index: number, text: string, remember = false): MemoryObservation => ({
            index,
            stamp: `d${index}|0`,
            text,
            remember,
        });
        const go = (memories: MemoryObservation[]) =>
            step(baseline, { current: null, previous: null, memories, options: OPTIONS }).signals;
        expect(go([memory(1, 'Old memory')])).toEqual([]);
        expect(go([memory(1, 'Old memory'), memory(2, ''), memory(3, 'Anna found the diary.', true)])).toEqual([
            { kind: 'memory.added', data: { items: [{ index: 3, text: 'Anna found the diary.' }] } },
            { kind: 'memory.long', data: { items: [{ index: 3, text: 'Anna found the diary.' }] } },
        ]);
        expect(go([memory(1, 'Old memory', true), memory(2, 'x'.repeat(400))])).toEqual([
            { kind: 'memory.added', data: { items: [{ index: 2, text: `${'x'.repeat(299)}…` }] } },
            { kind: 'memory.long', data: { items: [{ index: 1, text: 'Old memory' }] } },
        ]);
        expect(go([memory(1, 'Old memory', true)])).toEqual([]);
    });

    it('forgets memories outside the window when the cache grows', () => {
        const baseline = emptyBaseline();
        baseline.memories = Object.fromEntries(Array.from({ length: 250 }, (_, i) => [`old${i}`, 1]));
        step(baseline, {
            current: null,
            previous: null,
            memories: [{ index: 300, stamp: 'n', text: 'new', remember: false }],
            options: OPTIONS,
        });
        expect(baseline.memories).toEqual({ n: 1 });
    });

    it('reports new names after two turns (quoted ones at once), once', () => {
        const baseline = emptyBaseline();
        const go = (current: string, previous: string, known: string[] = []) =>
            step(baseline, {
                current: null,
                previous: null,
                names: {
                    current: findNameCandidates(current),
                    previous: findNameCandidates(previous),
                    known: (key) => known.includes(key),
                },
                options: OPTIONS,
            }).signals;
        expect(go('they met Marcus by the gate', '')).toEqual([]);
        expect(go('then Marcus spoke of the inn «Ржавый якорь»', 'they met Marcus by the gate')).toEqual([
            { kind: 'name.new', data: { name: 'Ржавый якорь', quoted: true } },
            { kind: 'name.new', data: { name: 'Marcus', quoted: false } },
        ]);
        expect(go('and Marcus left', 'then Marcus spoke')).toEqual([]);
        expect(go('and Anna left', 'and Anna came', ['anna'])).toEqual([]);
    });

    it('keeps the list of reported names bounded', () => {
        const baseline = emptyBaseline();
        baseline.names = Object.fromEntries(Array.from({ length: 600 }, (_, i) => [`n${i}`, 1]));
        step(baseline, {
            current: null,
            previous: null,
            names: { current: [], previous: [], known: () => false },
            options: OPTIONS,
        });
        expect(Object.keys(baseline.names)).toHaveLength(500);
        expect(baseline.names.n599).toBe(1);
    });
});

describe('rollback', () => {
    it('undoes a step exactly', () => {
        const baseline = emptyBaseline();
        let previous: Observation | null = null;
        const turns: SnapSpec[] = [
            {
                chars: [{ name: 'Anna', rel: 'Neutral', outfit: 'dress' }],
                location: 'Tavern',
                date: 'Day 1',
                main: 'A quest',
            },
            {
                chars: [{ name: 'Anna', rel: 'Neutral', outfit: 'dress' }],
                location: 'Tavern',
                date: 'Day 1',
                main: 'A quest',
            },
        ];
        for (const spec of turns) {
            const current = obs(spec);
            step(baseline, { current, previous, aliases: { Anna: ['Аня'] }, memories: [], options: OPTIONS });
            previous = current;
        }
        const before = JSON.parse(JSON.stringify(baseline)) as SignalsBaseline;
        const current = obs({
            chars: [{ name: 'Anna', rel: 'Hostile', outfit: 'plate armor helmet' }, { name: 'Bob' }],
            location: 'Forest',
            date: 'Day 4',
            main: 'Another quest',
        });
        const result = step(baseline, {
            current,
            previous,
            aliases: { Anna: ['Аня', 'Анечка'], Bob: ['Бобби'] },
            memories: [{ index: 1, stamp: 's', text: 'memory', remember: true }],
            names: { current: findNameCandidates('the inn «Якорь»'), previous: [], known: () => false },
            options: OPTIONS,
        });
        expect(kinds(result.signals)).toEqual([
            'relationship.changed',
            'time.skipped',
            'scene.ended',
            'alias.added',
            'alias.added',
            'memory.added',
            'memory.long',
            'name.new',
        ]);
        rollbackTrace(baseline, JSON.parse(JSON.stringify(result.trace)) as typeof result.trace);
        expect(baseline).toEqual(before);
    });

    it('restores a whole map and repairs missing parts', () => {
        const baseline = emptyBaseline();
        const first = step(baseline, { current: null, previous: null, aliases: { Anna: [] }, options: OPTIONS });
        expect(baseline.aliases).toEqual({ Anna: [] });
        rollbackTrace(baseline, first.trace);
        expect(baseline.aliases).toBeUndefined();
        const broken = { chars: undefined, names: undefined } as unknown as SignalsBaseline;
        rollbackTrace(broken, [
            { k: 'memories', s: 'x', b: 1 },
            { k: 'aliases', s: 'y' },
        ]);
        expect(broken).toEqual({ chars: {}, names: {}, memories: { x: 1 } });
    });
});

describe('fold', () => {
    it('folds same-kind signals of one subject and counts them', () => {
        const input: RawSignal[] = [
            {
                kind: 'appearance.changed',
                subject: { type: 'character', name: 'Anna' },
                data: { name: 'Anna', changes: [{ field: 'hair' }] },
            },
            {
                kind: 'appearance.changed',
                subject: { type: 'character', name: 'anna' },
                data: { name: 'Anna', changes: [{ field: 'outfit' }, { field: 'hair' }] },
            },
            { kind: 'location.changed', subject: { type: 'place', name: 'A', id: 'p1' }, data: { from: 'X', to: 'A' } },
            {
                kind: 'location.changed',
                subject: { type: 'place', name: 'B', id: 'p1' },
                data: { from: 'A', to: 'B', extra: 1 },
            },
            { kind: 'name.new', data: { name: 'Marcus' } },
            { kind: 'name.new', data: { name: 'Hale' } },
            { kind: 'appearance.changed', subject: { type: 'character', name: 'Bob' }, data: { name: 'Bob' } },
        ];
        const { signals, folded } = foldSignals(input);
        expect(folded).toBe(2);
        expect(signals).toHaveLength(5);
        expect(signals[0]?.data).toEqual({
            name: 'Anna',
            changes: [{ field: 'hair' }, { field: 'outfit' }],
            folded: 1,
        });
        expect(signals[1]?.data).toEqual({ from: 'X', to: 'B', extra: 1, folded: 1 });
        expect(input[0]?.data.folded).toBeUndefined();
        expect(foldKey({ kind: 'name.new', data: {} })).toBe('name.new||');
    });
});
