import { describe, expect, it } from 'vitest';
import {
    changeKey,
    dedupeChanges,
    looksTruncated,
    normalizeConfidence,
    parseRevisionChanges,
    readChange,
} from '../../src/domain/revision-parse';

const range = { from: 10, to: 20 };

function raw(overrides: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        class: 'known',
        entity: 'Anna',
        target: 'canon.fact',
        field: '',
        value: 'Anna now lives in Paris.',
        before: 'Anna lives in Rome.',
        evidence: '«Я теперь живу в Париже»',
        sourceMessage: 15,
        confidence: 0.9,
        ...overrides,
    };
}

describe('confidence', () => {
    it('reads fractions and percentages, falls back to 0.5', () => {
        expect(normalizeConfidence(0.7)).toBe(0.7);
        expect(normalizeConfidence(70)).toBe(0.7);
        expect(normalizeConfidence('0.4')).toBe(0.4);
        expect(normalizeConfidence(1000)).toBe(1);
        expect(normalizeConfidence(-1)).toBe(0.5);
        expect(normalizeConfidence('high')).toBe(0.5);
        expect(normalizeConfidence(undefined)).toBe(0.5);
    });
});

describe('one change', () => {
    it('reads a full item', () => {
        expect(readChange(raw(), range)).toEqual({
            class: 'known',
            entityName: 'Anna',
            target: 'canon.fact',
            value: 'Anna now lives in Paris.',
            before: 'Anna lives in Rome.',
            evidence: '«Я теперь живу в Париже»',
            sourceMessage: 15,
            confidence: 0.9,
        });
    });

    it('keeps a Russian sentence for the card only when it is Russian', () => {
        expect(readChange(raw({ russian: '  Анна теперь живёт   в Париже. ' }), range)?.russian).toBe(
            'Анна теперь живёт в Париже.',
        );
        expect(readChange(raw({ russian: 'Anna now lives in Paris.' }), range)?.russian).toBeUndefined();
        expect(readChange(raw({ russian: '' }), range)?.russian).toBeUndefined();
    });

    it('drops unusable items', () => {
        expect(readChange(null, range)).toBeNull();
        expect(readChange(raw({ target: 'lore.rewrite' }), range)).toBeNull();
        expect(readChange(raw({ entity: '' }), range)).toBeNull();
        expect(readChange(raw({ entity: 'x'.repeat(81) }), range)).toBeNull();
        expect(readChange(raw({ value: '  ' }), range)).toBeNull();
        expect(readChange(raw({ value: 'x'.repeat(801) }), range)).toBeNull();
    });

    it('normalises class, field, source message and evidence', () => {
        const change = readChange(
            raw({ class: 'weird', field: 'Hair', sourceMessage: '99', evidence: 'q'.repeat(500), before: '' }),
            range,
        )!;
        expect(change.class).toBe('known');
        expect(change.field).toBe('hair');
        expect(change.sourceMessage).toBe(20);
        expect(change.evidence.length).toBe(400);
        expect(change.before).toBeUndefined();
        expect(readChange(raw({ class: 'new', sourceMessage: '12' }), range)!).toMatchObject({
            class: 'new',
            sourceMessage: 12,
        });
        expect(readChange(raw({ sourceMessage: 'x' }), range)!.sourceMessage).toBe(20);
        expect(readChange(raw({ sourceMessage: 3 }), range)!.sourceMessage).toBe(20);
        expect(readChange(raw({ entityName: 'Boris', entity: undefined }), range)!.entityName).toBe('Boris');
        expect(readChange(raw({ field: 'x'.repeat(41) }), range)!.field).toBeUndefined();
    });
});

describe('the answer', () => {
    it('reads {changes} or a bare array, counts broken items, folds duplicates', () => {
        const result = parseRevisionChanges(
            { changes: [raw(), raw({ confidence: 0.95, value: 'Anna now lives in Paris' }), { nope: true }] },
            range,
        )!;
        expect(result.invalid).toBe(1);
        expect(result.changes).toHaveLength(1);
        expect(result.changes[0]!.confidence).toBe(0.95);
        expect(parseRevisionChanges([raw()], range)!.changes).toHaveLength(1);
        expect(parseRevisionChanges({ changes: 'none' }, range)).toBeNull();
        expect(parseRevisionChanges('text', range)).toBeNull();
    });

    it('keys changes by target, entity, field and value', () => {
        const a = readChange(raw(), range)!;
        expect(changeKey(a)).toBe(changeKey({ ...a, entityName: 'ANNA', value: 'anna now lives in paris' }));
        expect(changeKey(a)).not.toBe(changeKey({ ...a, field: 'hair' }));
        expect(dedupeChanges([a, { ...a, confidence: 0.2 }])).toEqual([a]);
    });
});

describe('cut answers', () => {
    it('tells cut JSON from complete JSON and from prose', () => {
        expect(looksTruncated('{"changes": [{"a": 1}]}')).toBe(false);
        expect(looksTruncated('{"changes": [{"a": 1}, {"b": "tex')).toBe(true);
        expect(looksTruncated('{"changes": [{"a": "x\\" }')).toBe(true);
        expect(looksTruncated('{"changes": [')).toBe(true);
        expect(looksTruncated('```json\n{"changes": []}\n```')).toBe(false);
        expect(looksTruncated('<think>{{{</think>{"changes": []}')).toBe(false);
        expect(looksTruncated('Sorry, nothing changed.')).toBe(false);
        expect(looksTruncated('{"a": "}"}')).toBe(false);
        expect(looksTruncated(undefined)).toBe(false);
    });
});
