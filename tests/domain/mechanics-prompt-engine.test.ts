// M25 prompt of plan-2 §6–6.А: values as visibility allows (numbers, words by bands, nothing for secret ones), the
// line that tells the model how to mention changes, conditions and inventories cut right after the other holders'
// values, the fight line never cut.
import { describe, expect, it } from 'vitest';
import {
    conditionsLine,
    holderLine,
    inventoryLine,
    mentionText,
    renderRules,
    wordsValue,
} from '../../src/domain/mechanics-prompt';
import type { PromptMechanic } from '../../src/domain/mechanics-prompt';

const HEALTH: PromptMechanic = {
    id: 'health',
    name: 'Health',
    summary: 'Health.',
    rules: 'Wounds hurt.',
    attributes: [
        {
            id: 'hp',
            promptName: 'HP',
            kind: 'number',
            min: 0,
            max: 100,
            visibility: { prompt: 'words', words: [{ upTo: 30, label: 'badly hurt' }, { label: 'fine' }] },
        },
        { id: 'mana', promptName: 'Mana', kind: 'number', min: 0, max: 50, visibility: { prompt: 'words' } },
        { id: 'luck', promptName: 'Luck', kind: 'number', visibility: { prompt: 'words' } },
        { id: 'doom', promptName: 'Doom', kind: 'number', visibility: { preset: 'secret' } },
        { id: 'trust', promptName: 'Trust', kind: 'number', min: 0, max: 100, visibility: { preset: 'book' } },
        { id: 'suspicion', promptName: 'Suspicion', kind: 'number', visibility: { preset: 'hidden' } },
        { id: 'mood', promptName: 'Mood', kind: 'scale', levels: ['cold', 'warm'], visibility: { prompt: 'words' } },
    ],
};

describe('values by visibility', () => {
    it('words by bands, default bands, plain values without bands, nothing for secret ones', () => {
        const line = holderLine(HEALTH, {
            name: 'Kai',
            values: { hp: 20, mana: 50, luck: 3, doom: 9, trust: 60, suspicion: 4, mood: 'warm' },
        });
        expect(line).toBe('Kai: hp: badly hurt, mana: full, luck 3, trust 60/100, suspicion 4, mood: warm');
        expect(wordsValue(HEALTH, HEALTH.attributes[0]!, 90)).toBe('hp: fine');
        expect(wordsValue(HEALTH, HEALTH.attributes[2]!, null)).toBeNull();
    });

    it('tells how changes may be mentioned: words only, never', () => {
        expect(mentionText(HEALTH)).toBe(
            'Changes: trust in words only, never as numbers; suspicion never mentioned; let them show only through behaviour.',
        );
        expect(mentionText({ ...HEALTH, attributes: [{ id: 'a', promptName: 'A', kind: 'number' }] })).toBe('');
        expect(
            mentionText({
                ...HEALTH,
                visibility: { preset: 'book' },
                attributes: [{ id: 'a', promptName: 'A', kind: 'number' }],
            }),
        ).toBe('Changes: a in words only, never as numbers.');
    });
});

describe('renderRules with extras and fixed lines', () => {
    const section = {
        mechanic: { ...HEALTH, attributes: [HEALTH.attributes[4]!] },
        holders: [
            { name: 'Kai', primary: true, values: { trust: 50 } },
            { name: 'Mira', values: { trust: 10 } },
        ],
    };

    it('puts the mention line after the rules and the extras and fixed lines before the instruction', () => {
        const rendered = renderRules([section], {
            budget: 0,
            instruction: '[Mechanics block] …',
            extras: ['[Conditions] Kai: poisoned', ' '],
            fixed: ['[Combat] Round 1.'],
        });
        expect(rendered.text).toBe(
            [
                '[Mechanics] Health: Wounds hurt. Changes: trust in words only, never as numbers. | Kai: trust 50/100 | Mira: trust 10/100',
                '[Conditions] Kai: poisoned',
                '[Combat] Round 1.',
                '[Mechanics block] …',
            ].join('\n'),
        );
    });

    it('cuts the other holders first, then the extras (last first), then the rules; never the fight', () => {
        const length = (text: string) => text.length;
        const extras = ['[Conditions] Kai: poisoned (2 turns left)', '[Inventory] Kai: rope x2'];
        const full = renderRules([section], { budget: 0, extras, fixed: ['[Combat] Round 1.'], count: length });
        const tight = renderRules([section], {
            budget: full.tokens - 20,
            extras,
            fixed: ['[Combat] Round 1.'],
            count: length,
        });
        expect(tight.cut[0]).toMatchObject({ kind: 'holder', holder: 'Mira' });
        const tighter = renderRules([section], {
            budget: full.tokens - 60,
            extras,
            fixed: ['[Combat] Round 1.'],
            count: length,
        });
        expect(tighter.cut.slice(0, 2)).toEqual([
            { kind: 'holder', mechanicId: 'health', holder: 'Mira', primary: false },
            { kind: 'extra', index: 1 },
        ]);
        const tiny = renderRules([section], { budget: 5, extras, fixed: ['[Combat] Round 1.'], count: length });
        expect(tiny.text).toBe('[Combat] Round 1.');
        expect(tiny.cut.map((step) => step.kind)).toContain('mechanic');
    });
});

describe('conditions and inventories', () => {
    it('one line each for the holders that have any', () => {
        expect(
            conditionsLine([
                {
                    holder: 'Kai',
                    statuses: [
                        { promptName: 'poisoned', remaining: { turns: 2 }, text: 'nausea' },
                        { promptName: 'blessed', remaining: null, until: { day: 3, minutes: 1080 }, stacks: 2 },
                    ],
                },
                { holder: 'Mira', statuses: [] },
                { holder: 'Lena', statuses: [{ promptName: 'asleep', remaining: null }] },
            ]),
        ).toBe('[Conditions] Kai: poisoned (2 turns left): nausea, blessed x2 (until day 3 18:00) | Lena: asleep');
        expect(conditionsLine([{ holder: 'Mira', statuses: [] }])).toBe('');
        expect(
            inventoryLine([
                {
                    holder: 'Kai',
                    items: [
                        { id: '1', name: 'rope', qty: 2 },
                        { id: '2', name: 'sword', qty: 1, equipped: 'hand' },
                    ],
                },
                { holder: 'Mira', items: [] },
            ]),
        ).toBe('[Inventory] Kai: rope x2, sword (in hand)');
        expect(inventoryLine([])).toBe('');
    });
});
