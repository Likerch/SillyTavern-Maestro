import { describe, expect, it } from 'vitest';
import {
    checkMechanic,
    mechanicView,
    mergeMechanic,
    scopeChoice,
    scopeOf,
    withMechanicId,
} from '../../src/domain/assistant-write-mechanic';

const BASE = {
    id: 'magic',
    name: 'Magic',
    summary: 'Spells.',
    rules: 'Casting costs mana.',
    book: 'Maestro Mechanics',
    uid: 4,
    attributes: [
        { id: 'mana', name: 'Mana', promptName: 'Mana', kind: 'number', min: 0, max: 100 },
        { id: 'schools', name: 'Schools', promptName: 'Schools', kind: 'list', options: ['fire'] },
    ],
    checks: [{ id: 'cast', name: 'Cast', promptName: 'Cast', dice: '1d20', difficulty: 10, triggers: ['cast'] }],
    holders: { kind: 'characters' },
    tracking: 'block',
    scope: { kind: 'global' },
};

describe('mergeMechanic', () => {
    it('replaces top-level fields and merges attributes and checks by id', () => {
        const merged = mergeMechanic(BASE, {
            rules: 'New rules.',
            book: 'Other',
            uid: 9,
            updatedAt: 1,
            attributes: [
                { id: 'mana', max: 50 },
                { id: 'schools', remove: true },
                { id: 'focus', name: 'Focus', promptName: 'Focus', kind: 'number' },
                { id: 'ghost', remove: true },
                'junk',
            ],
            checks: [{ id: 'cast', difficulty: 12 }],
            holders: undefined,
        });
        expect(merged.rules).toBe('New rules.');
        expect(merged.book).toBe('Maestro Mechanics');
        expect(merged.uid).toBe(4);
        expect(merged.updatedAt).toBeUndefined();
        expect(merged.attributes).toEqual([
            { id: 'mana', name: 'Mana', promptName: 'Mana', kind: 'number', min: 0, max: 50 },
            { id: 'focus', name: 'Focus', promptName: 'Focus', kind: 'number' },
            'junk',
        ]);
        expect(merged.checks).toEqual([{ ...BASE.checks[0], difficulty: 12 }]);
        expect(merged.holders).toEqual({ kind: 'characters' });
        expect(BASE.attributes).toHaveLength(2);
    });

    it('starts a list when the base has none and keeps a non-list value as given', () => {
        expect(mergeMechanic({}, { checks: [{ id: 'a', name: 'A' }] }).checks).toEqual([{ id: 'a', name: 'A' }]);
        expect(mergeMechanic(BASE, { attributes: 'none' }).attributes).toBe('none');
    });
});

describe('withMechanicId', () => {
    it('keeps a given id, else makes a readable unique one from the name', () => {
        expect(withMechanicId({ id: ' luck ' }, []).id).toBe('luck');
        expect(withMechanicId({ name: 'Магия' }, ['magiya']).id).toBe('magiya_2');
        expect(withMechanicId({}, []).id).toBe('mechanic');
    });
});

describe('scopes', () => {
    const context = { avatars: ['kai.png'], chatId: 'c1' };

    it('maps a choice to a scope when possible here', () => {
        expect(scopeOf('global', context)).toEqual({ kind: 'global' });
        expect(scopeOf('chat', context)).toEqual({ kind: 'chat', chatId: 'c1' });
        expect(scopeOf('card', context)).toEqual({ kind: 'card', avatar: 'kai.png' });
        expect(scopeOf('chat', { avatars: [], chatId: null })).toBeNull();
        expect(scopeOf('card', { avatars: ['a.png', 'b.png'], chatId: 'c1' })).toBeNull();
        expect(scopeChoice({ kind: 'card', avatar: 'x' })).toBe('card');
    });
});

describe('checkMechanic and mechanicView', () => {
    it('normalises and splits issues into errors and warnings', () => {
        const ok = checkMechanic(BASE);
        expect(ok?.errors).toEqual([]);
        const bad = checkMechanic({
            ...BASE,
            rules: '',
            summary: '',
            attributes: [{ ...BASE.attributes[0], min: 9, max: 1 }],
        });
        expect(bad?.errors.map((issue) => issue.code)).toEqual(['bounds']);
        expect(bad?.warnings.map((issue) => issue.code)).toEqual(['noRules']);
        expect(checkMechanic({ name: 'no id' })).toBeNull();
    });

    it('shows a definition in short', () => {
        const checked = checkMechanic({ ...BASE, rules: 'r'.repeat(700), summary: 's'.repeat(400) })!;
        const view = mechanicView(checked.def);
        expect(view).toMatchObject({
            id: 'magic',
            name: 'Magic',
            holders: 'every character',
            scope: 'global',
            tracking: 'block',
            attributes: ['Mana (mana): number 0–100', 'Schools (schools): one of fire'],
            checks: ['Cast (cast): 1d20 vs 10'],
        });
        expect((view.rules as string).length).toBe(600);
        expect((view.summary as string).endsWith('…')).toBe(true);
        const bare = mechanicView(checkMechanic({ id: 'x', name: 'X', rules: '', summary: '' })!.def);
        expect('rules' in bare || 'summary' in bare).toBe(false);
    });
});
