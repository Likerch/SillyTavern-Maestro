import { describe, expect, it } from 'vitest';
import type { DesCharacter, DesInfoBox } from '../../src/domain/des-tracker';
import { canonFact, desFacts, storyTimeOf } from '../../src/domain/world-facts';

const info = (fields: Partial<DesInfoBox>): DesInfoBox => ({ recentEvents: [], fields: {}, ...fields });

describe('world facts', () => {
    it('formats in-story time from the DES info box', () => {
        expect(storyTimeOf(null)).toBeUndefined();
        expect(storyTimeOf(info({}))).toBeUndefined();
        expect(storyTimeOf(info({ date: '3 марта' }))).toBe('3 марта');
        expect(storyTimeOf(info({ date: '3 марта', time: { start: '14:00' } }))).toBe('3 марта, 14:00');
        expect(storyTimeOf(info({ date: '3 марта', time: { start: '14:00', end: '15:00' } }))).toBe(
            '3 марта, 14:00–15:00',
        );
        expect(storyTimeOf(info({ time: { start: '14:00', end: '14:00' } }))).toBe('14:00');
        expect(storyTimeOf(info({ time: { end: '15:00' } }))).toBe('15:00');
        expect(storyTimeOf(info({ date: '  ' }))).toBeUndefined();
    });

    it('turns DES relationship and appearance fields into provisional facts', () => {
        const character: DesCharacter = {
            name: 'Лиза',
            details: { appearance: 'red hair', внешность: ' рыжая ', demeanor: 'calm', outfit: ' ' },
            relationship: 'Friendly',
            stats: [],
            offScene: false,
        };
        const facts = desFacts('character:elizabeth', character, 12, '3 марта');
        expect(facts.map((fact) => fact.text)).toEqual([
            'relationship: Friendly',
            'appearance: red hair',
            'внешность: рыжая',
        ]);
        expect(facts[0]).toMatchObject({
            entity: 'character:elizabeth',
            status: 'provisional',
            messageIndex: 12,
            storyTime: '3 марта',
            source: { kind: 'des.character', messageIndex: 12, label: 'Лиза' },
        });
        const bare = desFacts('x', { ...character, relationship: undefined, details: {} }, 1);
        expect(bare).toEqual([]);
        expect(desFacts('x', { ...character, details: {} }, 2)[0]?.storyTime).toBeUndefined();
    });

    it('turns canon items into facts with their status', () => {
        const item = (status: string, content: unknown, comment?: string) => ({
            uid: 4,
            meta: { status },
            entry: { content, comment },
        });
        expect(canonFact('e', item('active', ' Lives in the tower. ', 'Tower'), 'Canon')).toMatchObject({
            text: 'Lives in the tower.',
            status: 'active',
            confidence: 0.9,
            source: { kind: 'canon.entry', ref: 'Canon#4', label: 'Tower', world: 'Canon', uid: 4 },
        });
        expect(canonFact('e', item('archived', 'Old.'), 'Canon')).toMatchObject({ status: 'stale', confidence: 0.3 });
        expect(canonFact('e', item('provisional', 'New.'), 'Canon')).toMatchObject({
            status: 'provisional',
            source: { label: '#4' },
        });
        expect(canonFact('e', item('weird', 'X.'), 'Canon')?.confidence).toBe(0.5);
        expect(canonFact('e', item('active', ''), 'Canon')).toBeNull();
        expect(canonFact('e', item('active', 7), 'Canon')).toBeNull();
    });
});
