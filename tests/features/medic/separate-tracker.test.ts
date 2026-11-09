// «Трекер сцены» (release 1.32): DES's tracker instruction and example leave the assembled prompt of a real generation;
// DES's other slots and dry runs are left alone.
import { describe, expect, it } from 'vitest';
import { removeTrackerInstruction } from '../../../src/features/medic/separate-tracker';
import type { App } from '../../../src/shared/contracts';
import { createTestLogger } from '../../helpers/core-host';

function app(prompts: Record<string, { value: string }>): App {
    return {
        host: {
            ctx: () => ({
                extensionPrompts: prompts,
                substituteParams: (text: string) => text.replace('{{char}}', 'Мира'),
            }),
        },
    } as unknown as App;
}

describe('separate tracker', () => {
    const prompts = {
        'dooms-tracker-inject': { value: 'Begin the reply with the tracker JSON for {{char}}.' },
        'dooms-tracker-example': { value: '```json\n{"infoBox": {}}\n```' },
        'dooms-tracker-html': { value: 'Use HTML colours.' },
    };

    it('removes the instruction and the example, keeps the rest', () => {
        const chat = [
            { role: 'system', content: 'Main prompt.' },
            { role: 'assistant', content: '```json\n{"infoBox": {}}\n```' },
            { role: 'user', content: 'Я вхожу.\n\nBegin the reply with the tracker JSON for Мира.' },
            { role: 'system', content: 'Use HTML colours.' },
        ];
        const removed = removeTrackerInstruction(app(prompts), { dryRun: false, chat }, createTestLogger());
        expect(removed).toBe(2);
        const text = chat.map((message) => message.content).join('\n');
        expect(text).not.toContain('tracker JSON');
        expect(text).not.toContain('infoBox');
        expect(text).toContain('Use HTML colours.');
        expect(text).toContain('Я вхожу.');
    });

    it('does nothing on dry runs or without the slots', () => {
        const chat = [{ role: 'user', content: 'Begin the reply with the tracker JSON for Мира.' }];
        expect(removeTrackerInstruction(app(prompts), { dryRun: true, chat }, createTestLogger())).toBe(0);
        expect(removeTrackerInstruction(app({}), { dryRun: false, chat }, createTestLogger())).toBe(0);
        expect(removeTrackerInstruction(app(prompts), 'x', createTestLogger())).toBe(0);
        expect(chat[0]?.content).toContain('tracker JSON');
    });
});
