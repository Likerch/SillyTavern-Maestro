import { describe, expect, it } from 'vitest';
import {
    PRESET_KEY_TABLE,
    SENSITIVE_PRESET_KEYS,
    bodyFromSettings,
    collidingName,
    connectionKeys,
    hasControl,
    jsonClean,
    normalizeKeyValue,
    pickKeys,
    presentSensitiveKeys,
    readKeyTable,
    sameNameLoosely,
    sanitizePresetName,
    withoutKeys,
} from '../../src/domain/preset-store-keys';

describe('key table', () => {
    it('copies ST 1.19 settingsToUpdate: 103 keys, 8 renamed samplers', () => {
        expect(Object.keys(PRESET_KEY_TABLE)).toHaveLength(103);
        expect(PRESET_KEY_TABLE.temperature).toEqual(['#temp_openai', 'temp_openai', false, false]);
        const renamed = Object.entries(PRESET_KEY_TABLE).filter(([key, spec]) => key !== spec[1]);
        expect(renamed.map(([key]) => key).sort()).toEqual([
            'frequency_penalty',
            'min_p',
            'presence_penalty',
            'repetition_penalty',
            'temperature',
            'top_a',
            'top_k',
            'top_p',
        ]);
        expect(connectionKeys(PRESET_KEY_TABLE)).toHaveLength(56);
        expect(SENSITIVE_PRESET_KEYS).toHaveLength(11);
    });

    it('prefers a live table that looks like ST, else the copy', () => {
        const live = { temperature: ['#t', 'temp', false, false], broken: ['x'], other: 'nope' };
        expect(readKeyTable(live)).toEqual({ temperature: ['#t', 'temp', false, false] });
        expect(readKeyTable({ bad: [1, 2, 3, 4] })).toBe(PRESET_KEY_TABLE);
        expect(readKeyTable(null)).toBe(PRESET_KEY_TABLE);
        expect(readKeyTable([])).toBe(PRESET_KEY_TABLE);
    });

    it('knows which keys have a real control', () => {
        expect(hasControl(PRESET_KEY_TABLE.prompts!)).toBe(false);
        expect(hasControl(PRESET_KEY_TABLE.extensions!)).toBe(false);
        expect(hasControl(PRESET_KEY_TABLE.temperature!)).toBe(true);
    });
});

describe('bodies', () => {
    it('builds a body by preset keys and drops undefined settings', () => {
        const body = bodyFromSettings({ temp_openai: 0.5, stream_openai: true, seed: undefined, other: 1 });
        expect(body).toEqual({ temperature: 0.5, stream_openai: true });
        expect(bodyFromSettings({ temp_openai: 1 }, { temperature: ['#t', 'temp_openai', false, false] })).toEqual({
            temperature: 1,
        });
    });

    it('copies, picks and strips keys', () => {
        expect(jsonClean(undefined)).toBeUndefined();
        expect(jsonClean({ a: undefined, b: [1] })).toEqual({ b: [1] });
        expect(withoutKeys({ a: 1, b: 2 }, ['a'])).toEqual({ b: 2 });
        expect(pickKeys({ a: 1, b: undefined }, ['a', 'b', 'c'])).toEqual({ a: 1 });
        expect(pickKeys(null, ['a'])).toEqual({});
        expect(presentSensitiveKeys({ reverse_proxy: 'x', proxy_password: '', custom_url: 'y' })).toEqual([
            'reverse_proxy',
            'custom_url',
        ]);
    });

    it('types values like ST input handlers', () => {
        expect(normalizeKeyValue('false', true, true)).toBe(false);
        expect(normalizeKeyValue(' On ', false, true)).toBe(true);
        expect(normalizeKeyValue(0, true, true)).toBe(false);
        expect(normalizeKeyValue('0.7', 1, false)).toBe(0.7);
        expect(normalizeKeyValue(2, 1, false)).toBe(2);
        expect(normalizeKeyValue('abc', 1, false)).toBe('abc');
        expect(normalizeKeyValue(' ', 1, false)).toBe(' ');
        expect(normalizeKeyValue(Number.NaN, 1, false)).toBeNull();
        expect(normalizeKeyValue(['a'], 'x', false)).toEqual(['a']);
        expect(normalizeKeyValue(undefined, 'x', false)).toBeUndefined();
    });
});

describe('preset names', () => {
    it('sanitises like sanitize-filename', () => {
        expect(sanitizePresetName('My: <copy>?')).toBe('My copy');
        expect(sanitizePresetName('..')).toBe('');
        expect(sanitizePresetName('CON')).toBe('');
        expect(sanitizePresetName('name. ')).toBe('name');
        expect(sanitizePresetName('a\u0001b')).toBe('ab');
        expect(sanitizePresetName('я'.repeat(200))).toHaveLength(127);
        expect(sanitizePresetName('😀'.repeat(70))).toHaveLength(126);
    });

    it('compares names ignoring case and accents like ST', () => {
        expect(sameNameLoosely('Café', 'cafe')).toBe(true);
        expect(sameNameLoosely('A', 'B')).toBe(false);
        expect(sameNameLoosely('', '')).toBe(true);
        expect(sameNameLoosely('', 'a')).toBe(false);
        expect(collidingName(['Marinara', 'Other'], 'marinara')).toBe('Marinara');
        expect(collidingName(['Marinara'], 'Marinara')).toBe('Marinara');
        expect(collidingName(['Marinara'], 'MARINARA', 'Marinara')).toBeNull();
        expect(collidingName(['Marinara'], 'New')).toBeNull();
    });
});
