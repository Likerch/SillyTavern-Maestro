import { describe, expect, it } from 'vitest';
import { fillBraces, fillDoubleBraces, replaceInMessages, textNeedles } from '../../src/domain/neighbour-prompts';

const GLOBAL = 'Wrap all dialogue in unique colour tags for every speaker.';

describe('replaceInMessages', () => {
    it('replaces the exact text inside a message with other text, keeping the message object, role and keys', () => {
        const symbol = Symbol('ignore');
        const message: Record<string | symbol, unknown> = {
            role: 'system',
            name: 'example_assistant',
            content: `Tracker rules.\n${GLOBAL}\nMore rules.`,
            [symbol]: true,
        };
        const other = { role: 'user', content: 'Hello' };
        const messages = [other, message];
        expect(replaceInMessages(messages, textNeedles(GLOBAL), 'Use plain quotes.')).toBe(1);
        expect(messages[1]).toBe(message);
        expect(message.content).toBe('Tracker rules.\nUse plain quotes.\nMore rules.');
        expect(message.role).toBe('system');
        expect(message.name).toBe('example_assistant');
        expect(Object.keys(message)).toEqual(['role', 'name', 'content']);
        expect(message[symbol]).toBe(true);
        expect(other).toEqual({ role: 'user', content: 'Hello' });
    });

    it('replaces every occurrence, in text parts of multimodal messages too', () => {
        const parts = [
            { type: 'text', text: `A ${GLOBAL}` },
            { type: 'image_url', image_url: { url: 'x' } },
        ];
        const messages = [
            { role: 'user', content: parts },
            { role: 'system', content: `${GLOBAL} ${GLOBAL}` },
        ];
        expect(replaceInMessages(messages, [GLOBAL], 'B')).toBe(3);
        expect(messages[0]?.content).toEqual([{ type: 'text', text: 'A B' }, parts[1]]);
        expect(parts[0]).toEqual({ type: 'text', text: `A ${GLOBAL}` });
        expect(messages[1]?.content).toBe('B B');
    });

    it('tries the trimmed and macro-substituted forms, and never too short texts', () => {
        const messages = [{ role: 'system', content: 'Say hi to Kai, always and everywhere.' }];
        const needles = textNeedles('  Say hi to {{user}}, always and everywhere.\n', (text) =>
            text.replace('{{user}}', 'Kai'),
        );
        expect(replaceInMessages(messages, needles, 'Ignore Kai.')).toBe(1);
        expect(messages[0]?.content).toBe('Ignore Kai.');
        expect(textNeedles('short')).toEqual([]);
        expect(replaceInMessages(messages, textNeedles('nothing like this here'), 'x')).toBe(0);
    });
});

describe('placeholders', () => {
    it('fills {name} and {{name}} placeholders it knows and leaves the rest', () => {
        expect(fillBraces('Exclude {userName}; keep {other}.', { userName: 'Kai' })).toBe('Exclude Kai; keep {other}.');
        expect(fillDoubleBraces('From {{min}} to {{max}}, {{user}}.', { min: '1', max: '3' })).toBe(
            'From 1 to 3, {{user}}.',
        );
    });
});
