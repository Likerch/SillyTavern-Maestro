import { describe, expect, it } from 'vitest';
import type { DesTrackerSnapshot } from '../../src/domain/des-tracker';
import {
    applyMessage,
    collapseHistory,
    currentStatus,
    dropPoints,
    isCommittedIndex,
    lastCommittedIndex,
    mergeByName,
    needsRepair,
    nextAssistantIndex,
    observationsFrom,
    publicPoint,
    readRelations,
    recordPoint,
    relationKey,
    sameStatus,
} from '../../src/domain/relations-history';
import type { RelationPointData, StoredRelation } from '../../src/domain/relations-history';

const a = { is_user: false };
const u = { is_user: true };
const s = { is_user: false, is_system: true };
const point = (messageIndex: number, status: string, source: RelationPointData['source'] = 'des') => ({
    messageIndex,
    status,
    source,
});
const snapshot = (characters: { name: string; relationship?: string }[]): DesTrackerSnapshot => ({
    characters: characters.map((character) => ({ ...character, details: {}, stats: [], offScene: false })),
    infoBox: { date: '3 марта', time: { start: '14:00' }, recentEvents: [], fields: {} },
    quests: null,
});

describe('commits', () => {
    it('finds the committed reply: the assistant message before the last user message', () => {
        expect(lastCommittedIndex([])).toBe(-1);
        expect(lastCommittedIndex([a, a])).toBe(-1);
        expect(lastCommittedIndex([a, u, a])).toBe(0);
        expect(lastCommittedIndex([a, u, a, s, u])).toBe(2);
        expect(lastCommittedIndex([u, s, u])).toBe(-1);
    });

    it('tells committed messages and finds the next reply', () => {
        const chat = [a, u, a, s, a];
        expect(isCommittedIndex(chat, 0)).toBe(true);
        expect(isCommittedIndex(chat, 1)).toBe(false);
        expect(isCommittedIndex(chat, 2)).toBe(false);
        expect(isCommittedIndex(chat, 9)).toBe(false);
        expect(nextAssistantIndex(chat, 0)).toBe(2);
        expect(nextAssistantIndex(chat, 2)).toBe(4);
        expect(nextAssistantIndex(chat, 4)).toBe(-1);
    });
});

describe('relation history', () => {
    it('keys pairs and compares statuses without case or extra spaces', () => {
        expect(relationKey('Лиза ', 'Алекс')).toBe(relationKey('лиза', 'АЛЕКС'));
        expect(sameStatus('Friendly', ' friendly ')).toBe(true);
        expect(sameStatus('Friendly', 'Hostile')).toBe(false);
    });

    it('collapses: sorted, one point per message and source, equal neighbours merged, junk dropped', () => {
        const history = collapseHistory([
            point(5, 'Hostile'),
            point(2, 'Friendly'),
            point(3, 'friendly'),
            point(2, 'Wary'),
            point(-1, 'Bad'),
            point(1.5, 'Bad'),
            point(4, ' '),
            null as unknown as RelationPointData,
            point(6, 'Hostile', 'user'),
        ]);
        expect(history).toEqual([point(2, 'Wary'), point(3, 'friendly'), point(5, 'Hostile')]);
    });

    it('records a point, replacing that message’s earlier one', () => {
        let history = recordPoint([], point(2, 'Friendly'));
        history = recordPoint(history, point(4, 'Friendly'));
        expect(history).toEqual([point(2, 'Friendly')]);
        history = recordPoint(history, point(4, 'Romantic'));
        history = recordPoint(history, point(4, 'Hostile'));
        expect(history).toEqual([point(2, 'Friendly'), point(4, 'Hostile')]);
        expect(currentStatus(history)).toBe('Hostile');
        expect(currentStatus([])).toBe('');
    });

    it('reads observations toward the persona from a snapshot', () => {
        const snap = snapshot([
            { name: 'Лиза', relationship: 'Friendly' },
            { name: 'Боб' },
            { name: 'Алекс', relationship: 'Self' },
        ]);
        expect(observationsFrom(null, 'Алекс')).toEqual([]);
        expect(observationsFrom(snap, ' ')).toEqual([]);
        expect(observationsFrom(snap, 'Алекс', (name) => (name === 'Лиза' ? 'Elizabeth' : name))).toEqual([
            { from: 'Elizabeth', to: 'Алекс', status: 'Friendly', storyTime: '3 марта, 14:00' },
        ]);
        const noTime = { ...snap, infoBox: null };
        expect(observationsFrom(noTime, 'Алекс', () => '')).toEqual([
            { from: 'Лиза', to: 'Алекс', status: 'Friendly' },
        ]);
    });

    it('applies messages: first status, no point while unchanged, a point on change, re-reads replace', () => {
        const obs = (status: string) => [{ from: 'Лиза', to: 'Алекс', status }];
        let relations = applyMessage([], 2, obs('Friendly'));
        relations = applyMessage(relations, 4, obs('Friendly'));
        expect(relations).toEqual([{ from: 'Лиза', to: 'Алекс', history: [point(2, 'Friendly')] }]);
        relations = applyMessage(relations, 6, [{ ...obs(' Wary ')[0]!, storyTime: 'утро' }]);
        expect(relations[0]?.history).toEqual([point(2, 'Friendly'), { ...point(6, 'Wary'), storyTime: 'утро' }]);
        relations = applyMessage(relations, 6, obs('Hostile'));
        expect(currentStatus(relations[0]!.history)).toBe('Hostile');
        relations = applyMessage(relations, 6, []);
        expect(relations[0]?.history).toEqual([point(2, 'Friendly')]);
        relations = applyMessage(relations, 2, []);
        expect(relations).toEqual([]);
    });

    it('keeps the send date of the message a point was read from, but not in the public point', () => {
        const relations = applyMessage([], 3, [{ from: 'Лиза', to: 'Алекс', status: 'Friendly' }], 'des', 'd3');
        expect(relations[0]?.history).toEqual([{ ...point(3, 'Friendly'), sent: 'd3' }]);
        expect(publicPoint(relations[0]!.history[0]!)).toEqual(point(3, 'Friendly'));
        expect(readRelations(relations)[0]?.history[0]?.sent).toBe('d3');
    });

    it('drops points of one message or from a message on', () => {
        const relations: StoredRelation[] = [
            { from: 'Лиза', to: 'Алекс', history: [point(2, 'Friendly'), point(4, 'Wary'), point(6, 'Hostile')] },
            { from: 'Боб', to: 'Алекс', history: [point(6, 'Neutral')] },
        ];
        expect(dropPoints(relations, 4, 'at')).toEqual([
            { from: 'Лиза', to: 'Алекс', history: [point(2, 'Friendly'), point(6, 'Hostile')] },
            { from: 'Боб', to: 'Алекс', history: [point(6, 'Neutral')] },
        ]);
        expect(dropPoints(relations, 4, 'from')).toEqual([
            { from: 'Лиза', to: 'Алекс', history: [point(2, 'Friendly')] },
        ]);
    });

    it('notices points that no longer sit on a reply', () => {
        const relations: StoredRelation[] = [
            { from: 'Лиза', to: 'Алекс', history: [point(2, 'Friendly'), point(3, 'Mine', 'user')] },
        ];
        expect(needsRepair(relations, (item) => item.messageIndex === 2)).toBe(false);
        expect(needsRepair(relations, () => false)).toBe(true);
    });

    it('merges relations whose names turn out to be one person', () => {
        const relations: StoredRelation[] = [
            { from: 'Лиза', to: 'Алекс', history: [point(2, 'Friendly')] },
            { from: 'Elizabeth', to: 'Алекс', history: [point(5, 'Friendly'), point(8, 'Romantic')] },
            { from: 'Боб', to: 'Алекс', history: [point(3, 'Neutral')] },
        ];
        const merged = mergeByName(relations, (name) => (name === 'Лиза' ? 'Elizabeth' : name === 'Боб' ? '' : name));
        expect(merged).toEqual([
            { from: 'Elizabeth', to: 'Алекс', history: [point(2, 'Friendly'), point(8, 'Romantic')] },
            { from: 'Боб', to: 'Алекс', history: [point(3, 'Neutral')] },
        ]);
        expect(mergeByName([{ from: 'X', to: 'Y', history: [] }], (name) => name)).toEqual([]);
    });

    it('reads stored relations defensively', () => {
        expect(readRelations('junk')).toEqual([]);
        expect(
            readRelations([
                null,
                { from: '', to: 'Алекс', history: [] },
                { from: 'Лиза', to: 'Алекс', history: 'x' },
                {
                    from: 'Лиза',
                    to: 'Алекс',
                    history: [
                        point(2, 'Friendly'),
                        { messageIndex: 3, status: 'Mine', source: 'user', storyTime: 'утро' },
                        { messageIndex: 4, status: 'Canon', source: 'canon', storyTime: '' },
                        { messageIndex: 'x', status: 'Bad' },
                        7,
                    ],
                },
            ]),
        ).toEqual([
            {
                from: 'Лиза',
                to: 'Алекс',
                history: [
                    point(2, 'Friendly'),
                    { ...point(3, 'Mine', 'user'), storyTime: 'утро' },
                    point(4, 'Canon', 'canon'),
                ],
            },
        ]);
    });
});
