import { describe, expect, it } from 'vitest';
import {
    ADDITION_HEADER,
    applyInstruction,
    defaultChanged,
    effectiveInstruction,
    sanitizeOverride,
    textHash,
} from '../../../src/domain/agents/builtin';

const DEFAULT = 'You are the judge. Find defects.';
const messages = [
    { role: 'system', content: `${DEFAULT}\nAnswer in JSON.` },
    { role: 'user', content: 'The reply: …' },
];

describe('built-in agents: the instruction', () => {
    it('changes nothing without an override (the request stays byte for byte)', () => {
        expect(applyInstruction(messages, [DEFAULT], null)).toEqual({ messages, placed: 'unchanged' });
        expect(applyInstruction(messages, [DEFAULT], { mode: 'default' }).placed).toBe('unchanged');
        expect(applyInstruction(messages, [DEFAULT], { mode: 'addition', addition: '  ' }).placed).toBe('unchanged');
        expect(applyInstruction(messages, [DEFAULT], { mode: 'full' }).placed).toBe('unchanged');
        expect(effectiveInstruction(DEFAULT, null)).toBe(DEFAULT);
    });

    it("adds the user's lines after the default text, the answer form stays", () => {
        const out = applyInstruction(messages, [DEFAULT], {
            mode: 'addition',
            addition: 'Apologies for violence are a defect.',
        });
        expect(out.placed).toBe('replaced');
        expect(out.messages[0]?.content).toBe(
            `${DEFAULT}\n\n${ADDITION_HEADER}\nApologies for violence are a defect.\nAnswer in JSON.`,
        );
        expect(messages[0]?.content).toBe(`${DEFAULT}\nAnswer in JSON.`);
    });

    it('replaces the default text with the full text ($ in the text is kept)', () => {
        const out = applyInstruction(messages, ['missing', DEFAULT], { mode: 'full', full: 'Strict judge $1.' });
        expect(out.messages[0]?.content).toBe('Strict judge $1.\nAnswer in JSON.');
    });

    it('puts the instruction before the last message when the default text is not in the request', () => {
        const out = applyInstruction(messages, ['Other text'], { mode: 'addition', addition: 'Be strict.' });
        expect(out.placed).toBe('appended');
        expect(out.messages).toEqual([
            messages[0],
            { role: 'system', content: `${ADDITION_HEADER}\nBe strict.` },
            messages[1],
        ]);
        const full = applyInstruction(messages, [], { mode: 'full', full: 'Mine.' });
        expect(full.messages[1]).toEqual({ role: 'system', content: 'Mine.' });
    });

    it('tells when the default text changed under a full text', () => {
        expect(defaultChanged({ mode: 'full', full: 'x', baseHash: textHash(DEFAULT) }, DEFAULT)).toBe(false);
        expect(defaultChanged({ mode: 'full', full: 'x', baseHash: textHash('old') }, DEFAULT)).toBe(true);
        expect(defaultChanged({ mode: 'addition', addition: 'x', baseHash: textHash('old') }, DEFAULT)).toBe(false);
        expect(defaultChanged(null, DEFAULT)).toBe(false);
    });
});

describe('sanitizeOverride', () => {
    it('keeps what changes something, clamps numbers, drops empty overrides', () => {
        expect(sanitizeOverride(null)).toBeNull();
        expect(sanitizeOverride({ mode: 'default' })).toBeNull();
        expect(sanitizeOverride({ mode: 'addition', addition: ' ' })).toBeNull();
        expect(sanitizeOverride({ mode: 'weird', temperature: 9, maxTokens: 1, reasoning: 'low' })).toEqual({
            mode: 'default',
            temperature: 2,
            maxTokens: 50,
            reasoning: 'low',
        });
        expect(
            sanitizeOverride({ mode: 'full', full: 'Mine', baseHash: 'h', baseText: 'old', reasoning: 'loud' }),
        ).toEqual({
            mode: 'full',
            full: 'Mine',
            baseHash: 'h',
            baseText: 'old',
        });
    });
});
