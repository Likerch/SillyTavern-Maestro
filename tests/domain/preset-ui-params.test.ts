import { describe, expect, it } from 'vitest';
import {
    PARAMS,
    PARAM_GROUPS,
    coerceParam,
    isConnectionKey,
    optionKey,
    paramSpec,
    paramsOf,
    stopsToText,
    textToStops,
} from '../../src/domain/preset-ui-params';
import type { ParamSpec } from '../../src/domain/preset-ui-params';

const spec = (key: string) => paramSpec(key) as ParamSpec;

describe('preset parameters', () => {
    it('groups the keys and never offers connection keys', () => {
        expect(PARAM_GROUPS.flatMap((group) => paramsOf(group))).toHaveLength(PARAMS.length);
        expect(paramsOf('samplers').map((item) => item.key)).toContain('temperature');
        expect(PARAMS.some((item) => isConnectionKey(item.key))).toBe(false);
        expect(paramSpec('openai_model')).toBeUndefined();
        expect(isConnectionKey('openrouter_model')).toBe(true);
        expect(isConnectionKey('temperature')).toBe(false);
    });

    it('coerces numbers with ST’s limits', () => {
        expect(coerceParam(spec('temperature'), '0,7')).toEqual({ ok: true, value: 0.7 });
        expect(coerceParam(spec('temperature'), '2.5')).toEqual({ ok: false, error: 'range' });
        expect(coerceParam(spec('temperature'), '')).toEqual({ ok: false, error: 'notNumber' });
        expect(coerceParam(spec('temperature'), 'warm')).toEqual({ ok: false, error: 'notNumber' });
        expect(coerceParam(spec('top_k'), '40.6')).toEqual({ ok: true, value: 41 });
    });

    it('coerces booleans, selects and text', () => {
        expect(coerceParam(spec('stream_openai'), true)).toEqual({ ok: true, value: true });
        expect(coerceParam(spec('stream_openai'), 'false')).toEqual({ ok: true, value: false });
        expect(coerceParam(spec('names_behavior'), '2')).toEqual({ ok: true, value: 2 });
        expect(coerceParam(spec('names_behavior'), '7')).toEqual({ ok: false, error: 'option' });
        expect(coerceParam(spec('continue_postfix'), '\n')).toEqual({ ok: true, value: '\n' });
        expect(coerceParam(spec('wi_format'), '{0}')).toEqual({ ok: true, value: '{0}' });
    });

    it('labels whitespace options', () => {
        expect(['', ' ', '\n', '\n\n', 'low', -1].map(optionKey)).toEqual([
            'none',
            'space',
            'newline',
            'doubleNewline',
            'low',
            '-1',
        ]);
    });

    it('edits stop strings as lines with escaped line breaks', () => {
        const stops = ['\n{{char}}:', 'END', 'back\\slash'];
        const text = stopsToText(stops);
        expect(text).toBe('\\n{{char}}:\nEND\nback\\\\slash');
        expect(textToStops(text)).toEqual(stops);
        expect(textToStops('a\r\n\n\nb')).toEqual(['a', 'b']);
        expect(stopsToText([])).toBe('');
    });
});
