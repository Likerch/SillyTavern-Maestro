import { describe, expect, it } from 'vitest';
import {
    buildCompactRepairPrompt,
    desFieldKey,
    emptyKeyFieldNames,
    hasEmptyDetailKeys,
    hasFencedJson,
    hasRawNaiMarker,
    sameTrackerRecord,
    trackerMissing,
} from '../../src/domain/medic-des';

describe('DES field keys', () => {
    it('ports toFieldKey', () => {
        expect(desFieldKey('Status Effects')).toBe('status_effects');
        expect(desFieldKey('Conditions (up to 5 traits)')).toBe('conditions');
        expect(desFieldKey('Внешность')).toBe('');
        expect(desFieldKey('  Mood! ')).toBe('mood');
    });

    it('lists enabled fields with empty keys', () => {
        expect(
            emptyKeyFieldNames([
                { name: 'Внешность', enabled: true },
                { name: 'Поведение' },
                { name: 'Скрытое', enabled: false },
                { name: 'Mood' },
                { name: '' },
                'junk',
            ]),
        ).toEqual(['Внешность', 'Поведение']);
        expect(emptyKeyFieldNames(undefined)).toEqual([]);
    });

    it('finds empty detail keys in stored thoughts', () => {
        expect(hasEmptyDetailKeys(JSON.stringify([{ name: 'A', details: { '': 'x' } }]))).toBe(true);
        expect(hasEmptyDetailKeys(JSON.stringify({ characters: [{ name: 'A', details: { '': 'x' } }] }))).toBe(true);
        expect(hasEmptyDetailKeys(JSON.stringify([{ name: 'A', details: { mood: 'x' } }, 'junk']))).toBe(false);
        expect(hasEmptyDetailKeys('not json')).toBe(false);
        expect(hasEmptyDetailKeys(null)).toBe(false);
    });
});

describe('tracker records', () => {
    it('treats missing and blank sections as missing', () => {
        expect(trackerMissing(null)).toBe(true);
        expect(trackerMissing(undefined)).toBe(true);
        expect(trackerMissing({ quests: null, infoBox: ' ', characterThoughts: undefined })).toBe(true);
        expect(trackerMissing({ quests: null, infoBox: '{}', characterThoughts: null })).toBe(false);
        expect(trackerMissing({ characterThoughts: [] })).toBe(false);
    });

    it('compares records', () => {
        const a = { quests: null, infoBox: '{"a":1}', characterThoughts: '[]' };
        expect(sameTrackerRecord(a, { ...a })).toBe(true);
        expect(sameTrackerRecord(a, { ...a, infoBox: '{"a":2}' })).toBe(false);
        expect(
            sameTrackerRecord({ infoBox: { a: 1 } }, { infoBox: '{"a":1}', quests: null, characterThoughts: null }),
        ).toBe(true);
        expect(sameTrackerRecord(null, undefined)).toBe(true);
        expect(sameTrackerRecord(a, null)).toBe(false);
    });
});

describe('reply text', () => {
    it('finds fenced JSON blocks', () => {
        expect(hasFencedJson('```json\n{"infoBox": broken\n```')).toBe(true);
        expect(hasFencedJson('``` \n{"characters": []}\n```')).toBe(true);
        expect(hasFencedJson('```js\nlet a = 1;\n```')).toBe(false);
        expect(hasFencedJson('plain text')).toBe(false);
        expect(hasFencedJson(undefined)).toBe(false);
    });

    it('finds raw NAI markers', () => {
        expect(hasRawNaiMarker('<img class="x" data-nai=\'{"p":1}\'>')).toBe(true);
        expect(hasRawNaiMarker('<IMG data-nai = "1">')).toBe(true);
        expect(hasRawNaiMarker('[nai:img:abc]')).toBe(false);
        expect(hasRawNaiMarker(42)).toBe(false);
    });
});

describe('compact repair prompt', () => {
    it('uses the previous tracker as the template and the recent history', () => {
        const messages = buildCompactRepairPrompt({
            history: [
                { isUser: true, text: 'Go to the tavern' },
                { isUser: false, text: 'The tavern is warm.' },
            ],
            previous: {
                quests: '{"main":"Find"}',
                infoBox: '{"location":"Gate"}',
                characterThoughts: '[{"name":"Anna"}]',
            },
            sections: { quests: false, infoBox: true, characters: true },
            userName: 'Hero',
        });
        expect(messages[0]?.role).toBe('system');
        expect(messages.slice(1, 3)).toEqual([
            { role: 'user', content: 'Go to the tavern' },
            { role: 'assistant', content: 'The tavern is warm.' },
        ]);
        const last = messages.at(-1)!.content;
        expect(last).toContain('"location": "Gate"');
        expect(last).toContain('"Anna"');
        expect(last).not.toContain('Find');
        expect(last).toContain('"infoBox", "characters"');
        expect(last).toContain('Hero');
    });

    it('works without a previous tracker and trims long history', () => {
        const messages = buildCompactRepairPrompt({
            history: [
                { isUser: true, text: 'a'.repeat(5000) },
                { isUser: false, text: 'b'.repeat(4000) },
            ],
            previous: null,
            sections: { quests: true, infoBox: false, characters: false },
            userName: 'Hero',
        });
        expect(messages.at(-1)!.content).toContain('first update');
        expect(messages.at(-1)!.content).toContain('"quests"');
        const history = messages.slice(1, -1).map((item) => item.content.length);
        expect(history.reduce((sum, length) => sum + length, 0)).toBeLessThanOrEqual(6000);
    });
});
