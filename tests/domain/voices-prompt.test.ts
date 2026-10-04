import { describe, expect, it } from 'vitest';
import { CK_CONSISTENCY_SLOT, joinAround, removeSlotText, slotText } from '../../src/domain/voices-prompt';

type Msg = { role: string; content: unknown; tool_calls?: unknown[] };

const CK = 'OOC MANDATORY: [CHARACTER CONTEXT - CarrotKernel Tags]\n\nAnna: ELF, KUUDERE, STOIC\n';

describe('CK consistency slot', () => {
    it('is the /inject slot of CK', () => {
        expect(CK_CONSISTENCY_SLOT).toBe('script_inject_carrot-consistency');
    });

    it('reads the text a slot sends now', () => {
        const prompts = {
            [CK_CONSISTENCY_SLOT]: { value: CK, position: 1, depth: 4, scan: true, role: 0 },
            scanOnly: { value: 'tags', position: -1, depth: 0, scan: true, role: 0 },
            empty: { value: '  ', position: 1 },
            broken: { value: 3 },
        };
        expect(slotText(prompts, CK_CONSISTENCY_SLOT)).toBe(CK);
        expect(slotText(prompts, 'scanOnly')).toBe('');
        expect(slotText(prompts, 'empty')).toBe('');
        expect(slotText(prompts, 'broken')).toBe('');
        expect(slotText(prompts, 'missing')).toBe('');
        expect(slotText(null, CK_CONSISTENCY_SLOT)).toBe('');
    });
});

describe('removing a slot text from the prompt', () => {
    it('drops a message that held only the insert (ST trims in-chat injections)', () => {
        const messages: Msg[] = [
            { role: 'system', content: 'Main prompt.' },
            { role: 'system', content: CK.trim() },
            { role: 'user', content: 'Hello Anna.' },
        ];
        const result = removeSlotText(messages, CK);
        expect(result).toEqual({ removed: true, chars: CK.trim().length, message: 1, droppedMessage: true });
        expect(messages.map((message) => message.content)).toEqual(['Main prompt.', 'Hello Anna.']);
    });

    it('cuts the insert out of a message glued with other injections of the same depth and role', () => {
        const messages: Msg[] = [{ role: 'system', content: `Language lock.\n${CK.trim()}\n[Voice cards]` }];
        const result = removeSlotText(messages, CK);
        expect(result.removed).toBe(true);
        expect(result.droppedMessage).toBe(false);
        expect(messages[0]?.content).toBe('Language lock.\n[Voice cards]');
    });

    it('finds a macro-substituted insert and works on multimodal content', () => {
        const raw = 'Tags of {{char}}: ELF';
        const messages: Msg[] = [
            { role: 'user', content: [{ type: 'image_url' }, { type: 'text', text: 'Look. Tags of Anna: ELF' }] },
        ];
        const result = removeSlotText(messages, raw, (text) => text.replace('{{char}}', 'Anna'));
        expect(result.removed).toBe(true);
        expect(messages).toHaveLength(1);
        expect(messages[0]?.content).toEqual([{ type: 'image_url' }, { type: 'text', text: 'Look.' }]);
    });

    it('keeps a message with tool calls and reports a text that is not there', () => {
        const messages: Msg[] = [{ role: 'assistant', content: CK, tool_calls: [{ id: 1 }] }];
        expect(removeSlotText(messages, CK).droppedMessage).toBe(false);
        expect(messages).toHaveLength(1);
        expect(removeSlotText([{ role: 'user', content: 'nothing' }], CK)).toEqual({ removed: false, chars: 0 });
        expect(removeSlotText(['plain string', null], 'plain')).toEqual({ removed: false, chars: 0 });
    });

    it('glues the text around a cut', () => {
        expect(joinAround('A\nXX\nB', 2, 2)).toBe('A\nB');
        expect(joinAround('A XX B', 2, 2)).toBe('A  B');
        expect(joinAround('XX\nB', 0, 2)).toBe('B');
        expect(joinAround('A\nXX', 2, 2)).toBe('A');
        expect(joinAround('A  \n XX \nB', 5, 2)).toBe('A  \nB');
    });
});
