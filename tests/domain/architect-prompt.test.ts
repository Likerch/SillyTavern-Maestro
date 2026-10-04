import { describe, expect, it } from 'vitest';
import {
    findInMessages,
    messageTextParts,
    qvinkShortMemories,
    slotNeedles,
    spliceText,
} from '../../src/domain/architect-prompt';

describe('messages', () => {
    const messages = [
        { role: 'system', content: 'Main prompt.\nRAG: chunk one.' },
        { role: 'user', content: [{ type: 'image_url' }, { type: 'text', text: 'Look: memory text here.' }] },
        null,
    ];

    it('lists text parts of string and multimodal content', () => {
        expect(messageTextParts(messages[0])).toEqual(['Main prompt.\nRAG: chunk one.']);
        expect(messageTextParts(messages[1])).toEqual(['', 'Look: memory text here.']);
        expect(messageTextParts(null)).toEqual([]);
        expect(messageTextParts({ content: 5 })).toEqual([]);
    });

    it('finds needles in order of preference, from a given message', () => {
        expect(findInMessages(messages, ['RAG: chunk one.'])).toEqual({
            message: 0,
            part: 0,
            start: 13,
            needle: 'RAG: chunk one.',
        });
        expect(findInMessages(messages, ['nope', 'memory text'])).toMatchObject({ message: 1, part: 1, start: 6 });
        expect(findInMessages(messages, ['Main'], 1)).toBeNull();
    });

    it('builds needle forms and splices', () => {
        expect(slotNeedles('  text  ')).toEqual(['  text  ', 'text']);
        expect(slotNeedles('Hi {{user}}', (text) => text.replace('{{user}}', 'Bob'))).toEqual([
            'Hi {{user}}',
            'Hi Bob',
        ]);
        expect(
            slotNeedles('{{x}}', () => {
                throw new Error('no');
            }),
        ).toEqual(['{{x}}']);
        expect(slotNeedles('   ')).toEqual([]);
        expect(spliceText('abcdef', 2, 2, 'XY')).toBe('abXYef');
    });
});

describe('qvinkShortMemories', () => {
    it('lists injected short-term memories oldest first', () => {
        const chat = [
            { extra: { qvink_memory: { memory: 'Old.', include: 'short' } } },
            { extra: { qvink_memory: { memory: 'Long one.', include: 'long' } } },
            { extra: { qvink_memory: { memory: 'Lagging.', include: 'short', lagging: true } } },
            { extra: { qvink_memory: { memory: '  ', include: 'short' } } },
            { extra: {} },
            null,
            { extra: { qvink_memory: { memory: 'New.', include: 'short' } } },
        ];
        expect(qvinkShortMemories(chat)).toEqual(['Old.', 'New.']);
    });
});
