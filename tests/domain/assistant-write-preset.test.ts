import { describe, expect, it } from 'vitest';
import { ArgError } from '../../src/domain/assistant-write-args';
import {
    anchorOf,
    conditionChoice,
    conditionedText,
    flagStanding,
    storeAfterOf,
} from '../../src/domain/assistant-write-preset';

function codeOf(run: () => unknown): string {
    try {
        run();
    } catch (error) {
        if (error instanceof ArgError) return error.code;
        throw error;
    }
    return 'none';
}

describe('places of a new block', () => {
    const order = ['main', 'chatHistory', 'jailbreak'];

    it('gives the layer anchor and the block to insert after in the working copy', () => {
        expect(anchorOf('start', null)).toEqual({ kind: 'start' });
        expect(anchorOf('end', 'ignored')).toEqual({ kind: 'end' });
        expect(anchorOf('after', 'main')).toEqual({ kind: 'after', identifier: 'main' });
        expect(anchorOf('before', 'jailbreak')).toEqual({ kind: 'before', identifier: 'jailbreak' });
        expect(codeOf(() => anchorOf('before', null))).toBe('presetNeedAnchor');
        expect(storeAfterOf(order, { kind: 'start' })).toBeUndefined();
        expect(storeAfterOf(order, { kind: 'end' })).toBe('jailbreak');
        expect(storeAfterOf([], { kind: 'end' })).toBeUndefined();
        expect(storeAfterOf(order, { kind: 'after', identifier: 'main' })).toBe('main');
        expect(storeAfterOf(order, { kind: 'before', identifier: 'jailbreak' })).toBe('chatHistory');
        expect(storeAfterOf(order, { kind: 'before', identifier: 'main' })).toBeUndefined();
    });
});

describe('conditions', () => {
    it('maps modes to the editor choices', () => {
        expect(conditionChoice('only', 'maestro_x')).toEqual({ mode: 'when', flag: 'maestro_x' });
        expect(conditionChoice('except', 'maestro_x')).toEqual({ mode: 'unless', flag: 'maestro_x' });
        expect(conditionChoice('always', null)).toEqual({ mode: 'always' });
        expect(codeOf(() => conditionChoice('only', null))).toBe('presetFlagNeeded');
    });

    it('accepts catalogue flags and maestro_ names, refuses the rest', () => {
        expect(flagStanding('my_var', ['my_var'])).toBe('catalogue');
        expect(flagStanding('maestro_scene_combat', [])).toBe('maestro');
        expect(codeOf(() => flagStanding('combat', ['maestro_a']))).toBe('presetFlagUnknown');
        expect(codeOf(() => flagStanding('bad name', []))).toBe('presetFlagInvalid');
    });

    it('wraps, re-wraps and unwraps block texts', () => {
        expect(conditionedText('Fight.', { mode: 'when', flag: 'maestro_x' })).toBe('{{if .maestro_x}}Fight.{{/if}}');
        expect(conditionedText('{{if .maestro_x}}Fight.{{/if}}', { mode: 'unless', flag: 'maestro_y' })).toBe(
            '{{if !.maestro_y}}Fight.{{/if}}',
        );
        expect(conditionedText('{{if .maestro_x}}Fight.{{/if}}', { mode: 'always' })).toBe('Fight.');
        expect(codeOf(() => conditionedText('a {{/if}}', { mode: 'when', flag: 'maestro_x' }))).toBe('presetBlocked');
        expect(codeOf(() => conditionedText('a', { mode: 'when', flag: 'bad name' }))).toBe('presetFlagInvalid');
    });
});
