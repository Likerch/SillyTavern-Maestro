import { describe, expect, it } from 'vitest';
import type { AttributeDef, MechanicDef } from '../../src/domain/mechanics-defs';
import {
    applyChanges,
    capStateDoc,
    currentValue,
    editsToChanges,
    emptyStateDoc,
    evaluateEvent,
    eventCondition,
    eventKey,
    fillEventText,
    findAttribute,
    findChange,
    formatValue,
    initialValues,
    nameKey,
    nextValue,
    normalizeStateDoc,
    normalizeValue,
    previewChange,
    publicChange,
    publicEvent,
    resolveHolder,
    revertChange,
    rollbackFrom,
    rollbackMessage,
    storedHolderKey,
    toNumber,
    valuesEqual,
} from '../../src/domain/mechanics-state';
import type { ChangeInputData, MechanicsStateDoc } from '../../src/domain/mechanics-state';

const health: AttributeDef = {
    id: 'health',
    name: 'Здоровье',
    promptName: 'Health',
    kind: 'number',
    min: 0,
    max: 100,
    initial: 100,
    events: [{ id: 'low', when: { op: '<=', value: 20 }, text: '{holder} is barely standing ({value} {attribute}).' }],
};
const mood: AttributeDef = {
    id: 'mood',
    name: 'Отношение',
    promptName: 'Attitude',
    kind: 'scale',
    levels: ['hostile', 'cold', 'neutral', 'warm', 'loyal'],
    initial: 'neutral',
    events: [{ id: 'warm', when: { op: '>=', value: 'warm' }, text: '{holder} likes you.', once: false }],
};
const school: AttributeDef = {
    id: 'school',
    name: 'Школы',
    promptName: 'Schools',
    kind: 'list',
    options: ['fire', 'water', 'air'],
    multi: true,
    events: [{ id: 'fire', when: { op: 'changed', value: 'fire' }, text: '{holder} learns fire.' }],
};
const element: AttributeDef = {
    id: 'element',
    name: 'Стихия',
    promptName: 'Element',
    kind: 'list',
    options: ['fire', 'ice'],
};
const note: AttributeDef = { id: 'note', name: 'Заметка', promptName: 'Note', kind: 'text' };

function def(extra: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'magic',
        name: 'Магия',
        summary: 'Magic',
        rules: 'Spells cost mana.',
        attributes: [health, mood, school, element, note],
        holders: { kind: 'characters', includePersona: true },
        checks: [],
        tracking: 'block',
        scope: { kind: 'global' },
        ...extra,
    };
}

const MAGIC = def();
let seq = 0;
const options = (defs: MechanicDef[] = [MAGIC]) => ({
    getDef: (id: string) => defs.find((item) => item.id === id) ?? null,
    now: 1000,
    newId: () => `id${++seq}`,
});

function change(
    attribute: string,
    value: ChangeInputData['value'],
    extra: Partial<ChangeInputData> = {},
): ChangeInputData {
    return { mechanicId: 'magic', holder: 'Kai', attribute, value, source: 'block', messageIndex: 3, ...extra };
}

/** A delta change. */
function d(attribute: string, value: number, extra: Partial<ChangeInputData> = {}): ChangeInputData {
    return change(attribute, value, { delta: true, ...extra });
}

function apply(doc: MechanicsStateDoc, ...inputs: ChangeInputData[]) {
    return applyChanges(doc, inputs, options());
}

describe('values', () => {
    it('reads numbers from numbers and strings', () => {
        expect(toNumber(5)).toBe(5);
        expect(toNumber(Number.NaN)).toBeNull();
        expect(toNumber('−5')).toBe(-5);
        expect(toNumber(' 1 000 ')).toBe(1000);
        expect(toNumber('12,5')).toBe(12.5);
        expect(toNumber('+3')).toBe(3);
        expect(toNumber('abc')).toBeNull();
        expect(toNumber(null)).toBeNull();
    });

    it('validates and clamps numbers', () => {
        expect(normalizeValue(health, 150)).toEqual({ ok: true, value: 100, clamped: true });
        expect(normalizeValue(health, '-5')).toEqual({ ok: true, value: 0, clamped: true });
        expect(normalizeValue(health, '42')).toEqual({ ok: true, value: 42, clamped: false });
        expect(normalizeValue(health, 'lots')).toEqual({ ok: false, reason: 'number' });
        expect(normalizeValue({ ...health, min: undefined, max: undefined }, 0.1 + 0.2)).toMatchObject({ value: 0.3 });
    });

    it('validates scale levels by label or index', () => {
        expect(normalizeValue(mood, 'WARM')).toEqual({ ok: true, value: 'warm', clamped: false });
        expect(normalizeValue(mood, 1)).toEqual({ ok: true, value: 'cold', clamped: false });
        expect(normalizeValue(mood, '9')).toEqual({ ok: true, value: 'loyal', clamped: true });
        expect(normalizeValue(mood, -2)).toEqual({ ok: true, value: 'hostile', clamped: true });
        expect(normalizeValue(mood, 'angry')).toEqual({ ok: false, reason: 'level' });
        expect(normalizeValue({ ...mood, levels: [] }, 'warm')).toEqual({ ok: false, reason: 'levels' });
    });

    it('validates list options (multi and single, case-insensitive, canonical)', () => {
        expect(normalizeValue(school, 'Fire, WATER')).toEqual({ ok: true, value: ['fire', 'water'], clamped: false });
        expect(normalizeValue(school, ['fire', 'fire', 'lava'])).toEqual({ ok: true, value: ['fire'], clamped: true });
        expect(normalizeValue(school, 'lava')).toEqual({ ok: false, reason: 'option' });
        expect(normalizeValue(school, '')).toEqual({ ok: true, value: [], clamped: false });
        expect(normalizeValue(school, 3)).toEqual({ ok: false, reason: 'option' });
        expect(normalizeValue(school, { a: 1 })).toEqual({ ok: false, reason: 'list' });
        expect(normalizeValue(element, ['fire', 'ice'])).toEqual({ ok: true, value: ['ice'], clamped: true });
        expect(normalizeValue({ ...element, options: [] }, '«anything»')).toMatchObject({ value: ['anything'] });
    });

    it('validates texts', () => {
        expect(normalizeValue(note, '  tired   and  hungry ')).toEqual({
            ok: true,
            value: 'tired and hungry',
            clamped: false,
        });
        expect(normalizeValue(note, 7)).toMatchObject({ value: '7' });
        expect(normalizeValue(note, 'x'.repeat(600))).toMatchObject({ clamped: true });
        expect(normalizeValue(note, ['a'])).toEqual({ ok: false, reason: 'text' });
    });

    it('applies deltas: numbers add, scales step, lists add, texts refuse', () => {
        expect(nextValue(health, 50, -70, true)).toEqual({ ok: true, value: 0, clamped: true });
        expect(nextValue(health, null, -10, true)).toMatchObject({ value: 90 });
        expect(nextValue(health, 50, 'x', true)).toEqual({ ok: false, reason: 'number' });
        expect(nextValue(mood, 'neutral', 1, true)).toMatchObject({ value: 'warm' });
        expect(nextValue(mood, null, -5, true)).toMatchObject({ value: 'hostile' });
        expect(nextValue(mood, 'neutral', 0.5, true)).toEqual({ ok: false, reason: 'level' });
        expect(nextValue(school, ['fire'], 'air', true)).toMatchObject({ value: ['fire', 'air'] });
        expect(nextValue(element, ['fire'], 'ice', true)).toMatchObject({ value: ['ice'] });
        expect(nextValue(note, 'a', 'b', true)).toEqual({ ok: false, reason: 'delta' });
    });

    it('finds attributes by id, prompt name or display name', () => {
        expect(findAttribute(MAGIC, 'HEALTH')?.id).toBe('health');
        expect(findAttribute(MAGIC, 'attitude')?.id).toBe('mood');
        expect(findAttribute(MAGIC, 'здоровье')?.id).toBe('health');
        expect(findAttribute(MAGIC, '')).toBeNull();
        expect(findAttribute(MAGIC, 'luck')).toBeNull();
    });

    it('compares and formats values', () => {
        expect(valuesEqual(['a', 'b'], ['b', 'a'])).toBe(true);
        expect(valuesEqual(['a'], 'a')).toBe(false);
        expect(valuesEqual(['a'], ['b'])).toBe(false);
        expect(valuesEqual(3, 3)).toBe(true);
        expect(formatValue(['a', 'b'])).toBe('a, b');
        expect(formatValue(null)).toBe('');
        expect(formatValue(4)).toBe('4');
        expect(nameKey(' Ёлка_Big-Tree ')).toBe('елка big tree');
        expect(initialValues(MAGIC)).toEqual({ health: 100, mood: 'neutral', school: [], element: [], note: '' });
        expect(
            previewChange(health, 40, {
                mechanicId: 'magic',
                holder: 'Kai',
                attribute: 'health',
                value: 5,
                delta: true,
            }),
        ).toBe(45);
        expect(
            previewChange(health, null, { mechanicId: 'magic', holder: 'Kai', attribute: 'health', value: 'x' }),
        ).toBeNull();
    });
});

describe('holders', () => {
    const context = {
        persona: 'Алекс',
        canonical: (name: string) => ({ кай: 'Kai', kai: 'Kai', алекс: 'Алекс' })[name.toLowerCase()],
    };

    it('resolves characters to canonical names; the persona only when included', () => {
        expect(resolveHolder(MAGIC, ' «Кай» ', context)).toBe('Kai');
        expect(resolveHolder(MAGIC, 'Mira', context)).toBe('Mira');
        expect(resolveHolder(MAGIC, '{{user}}', context)).toBe('Алекс');
        expect(resolveHolder(def({ holders: { kind: 'characters' } }), 'Алекс', context)).toBeNull();
        expect(resolveHolder(MAGIC, '  ', context)).toBeNull();
        const throwing = {
            persona: 'P',
            canonical: () => {
                throw new Error('boom');
            },
        };
        expect(resolveHolder(MAGIC, 'Kai', throwing)).toBe('Kai');
    });

    it('resolves the persona, named lists, factions and the world', () => {
        expect(resolveHolder(def({ holders: { kind: 'persona' } }), 'user', context)).toBe('Алекс');
        expect(resolveHolder(def({ holders: { kind: 'persona' } }), 'Kai', context)).toBeNull();
        expect(resolveHolder(def({ holders: { kind: 'persona' } }), 'player', { persona: '' })).toBe('User');
        const named = def({ holders: { kind: 'named', names: ['Kai', 'Алекс'] } });
        expect(resolveHolder(named, 'кай', context)).toBe('Kai');
        expect(resolveHolder(named, 'you', context)).toBe('Алекс');
        expect(resolveHolder(named, 'Mira', context)).toBeNull();
        const factions = def({ holders: { kind: 'factions', names: ['Thieves Guild', 'Crown'] } });
        expect(resolveHolder(factions, 'thieves guild', context)).toBe('Thieves Guild');
        expect(resolveHolder(factions, 'Elves', context)).toBeNull();
        const world = def({ holders: { kind: 'world' } });
        expect(resolveHolder(world, 'Мир', context)).toBe('world');
        expect(resolveHolder(world, 'magic', context)).toBe('world');
        expect(resolveHolder(world, 'Kai', context)).toBeNull();
    });

    it('matches stored holders case-insensitively', () => {
        const doc = emptyStateDoc();
        apply(doc, d('health', -10));
        expect(storedHolderKey(doc, 'magic', 'KAI')).toBe('Kai');
        expect(storedHolderKey(doc, 'magic', 'Mira')).toBeNull();
        expect(storedHolderKey(doc, 'other', 'Kai')).toBeNull();
        expect(currentValue(doc, MAGIC, 'kai', health)).toBe(90);
        expect(currentValue(doc, MAGIC, 'Mira', health)).toBe(100);
    });
});

describe('applyChanges', () => {
    it('creates a holder with initial values and logs the change', () => {
        const doc = emptyStateDoc();
        const result = apply(doc, d('Health', -30, { reason: '  hit   by a troll ' }));
        expect(result.applied).toHaveLength(1);
        expect(result.applied[0]).toMatchObject({
            holder: 'Kai',
            attribute: 'health',
            from: 100,
            to: 70,
            created: true,
            reason: 'hit by a troll',
            prevUpdatedAt: -1,
        });
        expect(doc.holders.magic?.Kai).toEqual({
            values: { health: 70, mood: 'neutral', school: [], element: [], note: '' },
            updatedAt: 3,
        });
        expect(publicChange(result.applied[0]!)).not.toHaveProperty('created');
    });

    it('rejects unknown mechanics, attributes, holders and bad values; skips unchanged', () => {
        const doc = emptyStateDoc();
        const result = apply(
            doc,
            change('health', 1, { mechanicId: 'nope' }),
            change('luck', 1),
            change('health', 1, { holder: ' ' }),
            change('health', 'many'),
            change('health', 100),
        );
        expect(result.rejected.map((item) => item.reason)).toEqual(['mechanic', 'attribute', 'holder', 'number']);
        expect(result.unchanged).toHaveLength(1);
        expect(doc.holders).toEqual({});
        expect(doc.log).toEqual([]);
    });

    it('keeps user edits at updatedAt and long reasons short', () => {
        const doc = emptyStateDoc();
        apply(doc, change('health', 50, { source: 'user', messageIndex: -1, reason: 'r'.repeat(300) }));
        expect(doc.holders.magic?.Kai?.updatedAt).toBe(-1);
        expect(doc.log[0]?.reason?.length).toBe(200);
    });

    it('fires a once-event once and re-arms it when the condition turns false', () => {
        const doc = emptyStateDoc();
        const first = apply(doc, d('health', -85));
        expect(first.fired.map((event) => event.text)).toEqual(['Kai is barely standing (15 Health).']);
        expect(doc.latched[eventKey('magic', 'Kai', 'health', 'low')]).toBe(true);
        expect(apply(doc, d('health', -5)).fired).toEqual([]);
        expect(apply(doc, d('health', 50)).fired).toEqual([]);
        expect(doc.latched[eventKey('magic', 'Kai', 'health', 'low')]).toBeUndefined();
        expect(apply(doc, change('health', 10)).fired).toHaveLength(1);
        expect(doc.fired).toHaveLength(2);
        expect(publicEvent(doc.fired[0]!)).toEqual({
            mechanicId: 'magic',
            holder: 'Kai',
            attribute: 'health',
            eventId: 'low',
            text: 'Kai is barely standing (15 Health).',
            messageIndex: 3,
            at: 1000,
        });
    });

    it('fires non-once events every time and changed-events on their value', () => {
        const doc = emptyStateDoc();
        expect(apply(doc, change('mood', 'warm')).fired).toHaveLength(1);
        expect(apply(doc, change('mood', 'loyal')).fired).toHaveLength(1);
        expect(apply(doc, change('school', 'air')).fired).toHaveLength(0);
        expect(apply(doc, change('school', 'air, fire')).fired.map((event) => event.eventId)).toEqual(['fire']);
    });
});

describe('events', () => {
    it('evaluates conditions for every kind', () => {
        expect(eventCondition(health, { op: '>=', value: '50' }, 60)).toBe(true);
        expect(eventCondition(health, { op: '=', value: 60 }, 60)).toBe(true);
        expect(eventCondition(health, { op: '<=' }, 60)).toBe(false);
        expect(eventCondition(health, { op: '<=', value: 'x' }, 60)).toBe(false);
        expect(eventCondition(health, { op: 'changed', value: 60 }, 60)).toBe(true);
        expect(eventCondition(mood, { op: '<=', value: 1 }, 'cold')).toBe(true);
        expect(eventCondition(mood, { op: '<=', value: 'nope' }, 'cold')).toBe(false);
        expect(eventCondition(mood, { op: 'changed', value: 'Cold' }, 'cold')).toBe(true);
        expect(eventCondition(school, { op: '>=', value: 2 }, ['fire', 'air'])).toBe(true);
        expect(eventCondition(school, { op: '=', value: 'air' }, ['fire', 'air'])).toBe(true);
        expect(eventCondition(school, { op: '<=', value: 'air' }, ['air'])).toBe(false);
        expect(eventCondition(school, { op: 'changed' }, [])).toBe(true);
        expect(eventCondition(school, { op: 'changed', value: 'air' }, 'air')).toBe(false);
        expect(eventCondition(note, { op: '=', value: 'Tired' }, 'tired')).toBe(true);
        expect(eventCondition(note, { op: '>=', value: 'a' }, 'b')).toBe(false);
    });

    it('latches and fills texts', () => {
        const once = { id: 'e', when: { op: '<=' as const, value: 10 }, text: '' };
        expect(evaluateEvent(health, once, 5, false)).toEqual({ fire: true, latch: true });
        expect(evaluateEvent(health, once, 5, true)).toEqual({ fire: false, latch: true });
        expect(evaluateEvent(health, once, 50, true)).toEqual({ fire: false, latch: false });
        expect(evaluateEvent(health, { ...once, when: { op: 'changed' } }, 50, true)).toEqual({ fire: true });
        expect(fillEventText('{HOLDER}: {value}', 'Kai', ['a', 'b'])).toBe('Kai: a, b');
    });
});

describe('rollback', () => {
    it('takes a swiped message back exactly: values, holder, latches, events', () => {
        const doc = emptyStateDoc();
        apply(doc, d('health', -10, { messageIndex: 1 }));
        apply(doc, d('health', -75, { messageIndex: 5 }), change('mood', 'cold', { holder: 'Mira', messageIndex: 5 }));
        expect(doc.fired).toHaveLength(1);
        const removed = rollbackFrom(doc, 5);
        expect(removed).toHaveLength(2);
        expect(doc.holders.magic?.Kai?.values.health).toBe(90);
        expect(doc.holders.magic?.Kai?.updatedAt).toBe(1);
        expect(doc.holders.magic?.Mira).toBeUndefined();
        expect(doc.latched).toEqual({});
        expect(doc.fired).toEqual([]);
        expect(rollbackFrom(doc, 1)).toHaveLength(1);
        expect(doc.holders).toEqual({});
    });

    it('keeps user edits and reverts a change followed by one as a difference', () => {
        const doc = emptyStateDoc();
        apply(doc, d('health', -20, { messageIndex: 5 }));
        apply(doc, change('health', 50, { source: 'user', messageIndex: -1 }));
        apply(doc, change('school', 'fire', { delta: true, messageIndex: 5 }));
        apply(doc, change('school', 'air', { delta: true, source: 'user', messageIndex: -1 }));
        apply(doc, change('mood', 1, { delta: true, messageIndex: 5 }));
        apply(doc, change('mood', 1, { delta: true, source: 'user', messageIndex: -1 }));
        apply(doc, change('note', 'tired', { messageIndex: 5 }));
        apply(doc, change('note', 'ok', { source: 'user', messageIndex: -1 }));
        rollbackFrom(doc, 5, options().getDef);
        const values = doc.holders.magic?.Kai?.values;
        expect(values?.health).toBe(70);
        expect(values?.school).toEqual(['air']);
        expect(values?.mood).toBe('warm');
        expect(values?.note).toBe('ok');
        expect(doc.log.every((item) => item.source === 'user')).toBe(true);
    });

    it('rolls one message back by source (an edit)', () => {
        const doc = emptyStateDoc();
        apply(doc, d('health', -10, { messageIndex: 5 }), d('health', -5, { messageIndex: 5, source: 'check' }));
        apply(doc, d('health', -1, { messageIndex: 7 }));
        expect(rollbackMessage(doc, 5).map((item) => item.source)).toEqual(['block']);
        expect(doc.holders.magic?.Kai?.values.health).toBe(94);
        expect(doc.log.map((item) => item.messageIndex)).toEqual([5, 7]);
    });

    it('reverts single changes for the journal', () => {
        const doc = emptyStateDoc();
        apply(doc, change('health', 40, { source: 'user', messageIndex: -1 }));
        const edit = doc.log[0]!;
        apply(doc, d('health', -10, { messageIndex: 8 }));
        expect(revertChange(doc, edit, options().getDef)).toBe(true);
        expect(doc.holders.magic?.Kai?.values.health).toBe(90);
        expect(revertChange(doc, edit)).toBe(false);
        apply(doc, change('note', 'a', { source: 'user', messageIndex: -1 }));
        const text = doc.log[doc.log.length - 1]!;
        apply(doc, change('note', 'b', { messageIndex: 9 }));
        expect(revertChange(doc, text, options().getDef)).toBe(false);
        expect(doc.log).toContain(text);
        const last = doc.log[doc.log.length - 1]!;
        expect(revertChange(doc, last)).toBe(true);
        expect(doc.holders.magic?.Kai?.values.note).toBe('a');
    });

    it('finds changes by id or by locator', () => {
        const doc = emptyStateDoc();
        apply(doc, d('health', -10, { messageIndex: 2, source: 'background' }));
        apply(doc, d('health', -10, { messageIndex: 2, source: 'block' }));
        const [first, second] = doc.log;
        expect(findChange(doc, { changeId: first!.id })).toBe(first);
        expect(findChange(doc, { changeId: 'nope' })).toBeNull();
        expect(findChange(doc, { mechanicId: 'magic', holder: 'kai', attribute: 'health', messageIndex: 2 })).toBe(
            second,
        );
        expect(findChange(doc, { mechanicId: 'magic', source: 'background' })).toBe(first);
        expect(findChange(doc, { mechanicId: 'other' })).toBeNull();
        expect(findChange(doc, { mechanicId: 'magic', attribute: 'mood' })).toBeNull();
        expect(findChange(doc, { mechanicId: 'magic', holder: 'Mira' })).toBeNull();
        expect(findChange(doc, { mechanicId: 'magic', messageIndex: 4 })).toBeNull();
    });
});

describe('the document', () => {
    it('repairs stored data', () => {
        const doc = normalizeStateDoc({
            holders: {
                magic: { Kai: { values: { health: 5, bad: { x: 1 }, list: ['a', 1] }, updatedAt: 'x' }, broken: 1 },
                empty: {},
                junk: 'x',
            },
            log: [
                {
                    id: 'c1',
                    mechanicId: 'magic',
                    holder: 'Kai',
                    attribute: 'health',
                    from: 9,
                    to: 5,
                    source: 'block',
                    messageIndex: 2.7,
                    at: 1,
                    reason: 'r',
                    latch: { k: true, j: 'x' },
                    created: true,
                    prevUpdatedAt: 1,
                },
                { id: 'c2', mechanicId: 'magic', holder: 'Kai', attribute: 'health', to: 5, source: 'alien' },
                { id: 'c3', mechanicId: 'magic', holder: 'Kai', attribute: 'health', to: 5, source: 'user', latch: {} },
                'junk',
            ],
            latched: { a: true, b: false },
            fired: [
                {
                    id: 'e',
                    changeId: 'c1',
                    mechanicId: 'magic',
                    holder: 'Kai',
                    attribute: 'health',
                    eventId: 'x',
                    text: 't',
                    delivered: true,
                },
                { id: 'e2' },
                3,
            ],
        });
        expect(doc.holders).toEqual({ magic: { Kai: { values: { health: 5 }, updatedAt: -1 } } });
        expect(doc.log.map((item) => item.id)).toEqual(['c1', 'c3']);
        expect(doc.log[0]).toMatchObject({ messageIndex: 2, latch: { k: true }, created: true, reason: 'r', from: 9 });
        expect(doc.log[1]).toMatchObject({ from: null, messageIndex: -1, at: 0 });
        expect(doc.log[1]).not.toHaveProperty('latch');
        expect(doc.latched).toEqual({ a: true });
        expect(doc.fired).toEqual([expect.objectContaining({ id: 'e', delivered: true, messageIndex: -1 })]);
        expect(normalizeStateDoc(null)).toEqual(emptyStateDoc());
    });

    it('caps the log and the events', () => {
        const doc = emptyStateDoc();
        for (let i = 0; i < 6; i++) apply(doc, d('health', -1, { messageIndex: i }));
        doc.fired.push(...doc.fired, ...doc.fired);
        capStateDoc(doc, { log: 3, fired: 1 });
        expect(doc.log.map((item) => item.messageIndex)).toEqual([3, 4, 5]);
        expect(doc.fired).toHaveLength(0);
        capStateDoc(doc);
        expect(doc.log).toHaveLength(3);
    });
});

describe('editsToChanges', () => {
    const values: Record<string, ReturnType<typeof currentValue>> = { health: 40, school: ['fire'], mood: 'neutral' };
    const valueOf = (_m: string, _h: string, attribute: string) => values[attribute] ?? null;
    const getDef = options().getDef;

    it('keeps number and scale deltas, makes list edits and factors absolute from the running value', () => {
        const { changes, rejected } = editsToChanges(
            [
                { mechanicId: 'magic', holder: 'Kai', attribute: 'Health', op: 'add', value: -10, reason: 'hit' },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'health', op: 'mul', value: 2 },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'school', op: 'add', value: 'air' },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'school', op: 'sub', value: 'Fire' },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'mood', op: 'add', value: 1 },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'mood', op: 'add', value: 'loyal' },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'mood', op: 'sub', value: 2 },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'element', op: 'add', value: 'ice' },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'health', op: 'sub', value: 5 },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'note', op: 'set', value: 'hungry' },
            ],
            getDef,
            valueOf,
        );
        expect(rejected).toEqual([]);
        expect(changes).toEqual([
            { mechanicId: 'magic', holder: 'Kai', attribute: 'health', value: -10, delta: true, reason: 'hit' },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'health', value: 60 },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'school', value: ['fire', 'air'] },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'school', value: ['air'] },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'mood', value: 1, delta: true },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'mood', value: 'loyal' },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'mood', value: -2, delta: true },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'element', value: ['ice'] },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'health', value: -5, delta: true },
            { mechanicId: 'magic', holder: 'Kai', attribute: 'note', value: 'hungry' },
        ]);
    });

    it('rejects what cannot apply', () => {
        const { changes, rejected } = editsToChanges(
            [
                { mechanicId: 'nope', holder: 'Kai', attribute: 'health', op: 'set', value: 1 },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'luck', op: 'set', value: 1 },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'note', op: 'add', value: 'x' },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'note', op: 'sub', value: 'x' },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'note', op: 'mul', value: 2 },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'health', op: 'set', value: 'lots' },
                { mechanicId: 'magic', holder: 'Kai', attribute: 'health', op: 'add', value: 'lots' },
            ],
            getDef,
            () => null,
        );
        expect(changes).toEqual([]);
        expect(rejected.map((item) => item.reason)).toEqual([
            'mechanic',
            'attribute',
            'op',
            'op',
            'op',
            'number',
            'op',
        ]);
    });
});
