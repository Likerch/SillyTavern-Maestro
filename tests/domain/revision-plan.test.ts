import { describe, expect, it } from 'vitest';
import {
    committedEnd,
    decideTrigger,
    deferredStage,
    pushCapped,
    revisionRange,
    sameDeferred,
} from '../../src/domain/revision-plan';

const settings = { signalThreshold: 3, everyMessages: 10, sceneEnd: true };

describe('triggers', () => {
    it('scene end first, then signals, then the interval', () => {
        expect(decideTrigger({ pending: 5, messagesSince: 20, sceneEnded: true }, settings)).toBe('sceneEnd');
        expect(decideTrigger({ pending: 3, messagesSince: 20, sceneEnded: false }, settings)).toBe('signals');
        expect(decideTrigger({ pending: 2, messagesSince: 10, sceneEnded: false }, settings)).toBe('interval');
        expect(decideTrigger({ pending: 2, messagesSince: 9, sceneEnded: false }, settings)).toBeNull();
    });

    it('a scene end with nothing new does not start a run; switched-off triggers never do', () => {
        expect(decideTrigger({ pending: 0, messagesSince: 0, sceneEnded: true }, settings)).toBeNull();
        const off = { signalThreshold: 0, everyMessages: 0, sceneEnd: false };
        expect(decideTrigger({ pending: 9, messagesSince: 99, sceneEnded: true }, off)).toBeNull();
    });
});

describe('committed range', () => {
    it('ends at the last user message (later replies are drafts)', () => {
        const chat = [
            { is_user: false },
            { is_user: true },
            { is_user: false },
            { is_user: true, is_system: true },
            { is_user: false },
        ];
        expect(committedEnd(chat)).toBe(1);
        expect(committedEnd([{ is_user: false }])).toBe(-1);
        expect(committedEnd([])).toBe(-1);
    });

    it('reads after the last revision, at most N messages back', () => {
        expect(revisionRange(-1, 30, 24)).toEqual({ from: 7, to: 30 });
        expect(revisionRange(20, 30, 24)).toEqual({ from: 21, to: 30 });
        expect(revisionRange(30, 30, 24)).toBeNull();
        expect(revisionRange(-1, -1, 24)).toBeNull();
        expect(revisionRange(-1, 3, 0)).toEqual({ from: 3, to: 3 });
    });
});

describe('bookkeeping', () => {
    it('knows the stage of deferred targets', () => {
        expect(deferredStage('deferred.outfit')).toBe(10);
        expect(deferredStage('deferred.promise')).toBe(9);
        expect(deferredStage('deferred.secret')).toBe(9);
    });

    it('caps lists, dropping the oldest', () => {
        expect(pushCapped([1, 2, 3], 4, 3)).toEqual([2, 3, 4]);
        expect(pushCapped([1], 2, -1)).toEqual([1, 2]);
    });

    it('recognises the same deferred card', () => {
        const a = { target: 'deferred.promise', entityName: 'Anna', value: 'Anna promised to return by dawn.' };
        expect(sameDeferred(a, { ...a, entityName: 'ANNA', value: 'anna promised to return by dawn' })).toBe(true);
        expect(sameDeferred(a, { ...a, target: 'deferred.secret' })).toBe(false);
    });
});
