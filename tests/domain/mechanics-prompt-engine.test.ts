// M25 prompt of plan-2 §6–6.А and release 1.27: values as visibility allows (numbers with band words, words for
// 'words' and «book» attributes, nothing for secret ones), the mention line, lasting threshold events while their
// condition holds, conditions with their modifiers and inventories per holder (cut right after the other holders'
// values), fixed lines never cut, DES's tracker line, and the importance of the sections.
import { describe, expect, it } from 'vitest';
import {
    defaultModifierLabel,
    holderValues,
    isLasting,
    lastingLines,
    mentionText,
    mentionedIn,
    orderSections,
    renderGame,
    statusText,
    trackerLine,
    wordsValue,
} from '../../src/domain/mechanics-prompt';
import type { PromptAttribute, PromptMechanic, PromptSection } from '../../src/domain/mechanics-prompt';
import { templateById } from '../../src/domain/mechanics-templates';

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
    it('words by bands, default bands, plain values without bands, «book» as words, nothing for secret ones', () => {
        const line = holderValues(HEALTH, {
            name: 'Kai',
            values: { hp: 20, mana: 50, luck: 3, doom: 9, trust: 60, suspicion: 4, mood: 'warm' },
        });
        // Release 1.27: «book» gives words to the model too (trust 60/100 → "moderate"), never the number.
        expect(line).toBe('hp: badly hurt, mana: full, luck 3, trust: moderate, suspicion 4, mood: warm');
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

    it('the built-in «book» templates give the model no number', () => {
        const social = { ...templateById('social')!.build('ru'), id: 'social' };
        const rendered = renderGame(
            [{ mechanic: social, holders: [{ name: 'Mira', values: { sympathy: 70, trust: 30, attraction: 5 } }] }],
            { budget: 0 },
        );
        expect(rendered.state).toContain('- Social scales: sympathy: strong, trust: slight, attraction: none');
        expect(rendered.state).not.toMatch(/\d/);
        expect(rendered.rules).toContain('Changes: sympathy, trust, attraction in words only, never as numbers.');
    });
});

describe('lasting events', () => {
    const MANA: PromptAttribute = {
        id: 'mana',
        promptName: 'Mana',
        kind: 'number',
        min: 0,
        max: 100,
        events: [
            { id: 'drained', when: { op: '<=', value: 0 }, text: '{holder} has no mana left and cannot cast.' },
            { id: 'low', when: { op: '<=', value: 15 }, text: '{holder} is nearly out of mana.' },
            { id: 'full', when: { op: '>=', value: 100 }, text: '{holder} brims with power', lasting: false },
            { id: 'spent', when: { op: 'changed' }, text: '{holder} spent mana.' },
            { id: 'silent', when: { op: '<=', value: 50 }, text: ' ' },
        ],
    };
    const MAGIC: PromptMechanic = { id: 'magic', name: 'Magic', summary: '', rules: '', attributes: [MANA] };

    it("'<=', '>=', '=' events last unless switched off; 'changed' never", () => {
        expect(isLasting({ when: { op: '<=', value: 1 } })).toBe(true);
        expect(isLasting({ when: { op: '=', value: 1 } })).toBe(true);
        expect(isLasting({ when: { op: '>=', value: 1 }, lasting: false })).toBe(false);
        expect(isLasting({ when: { op: 'changed' }, lasting: true })).toBe(false);
    });

    it('while the condition holds now, the most extreme of one side, filled in', () => {
        expect(lastingLines(MAGIC, { name: 'Kai', values: { mana: 0 } })).toEqual([
            'Kai has no mana left and cannot cast.',
        ]);
        expect(lastingLines(MAGIC, { name: 'Kai', values: { mana: 10 } })).toEqual(['Kai is nearly out of mana.']);
        expect(lastingLines(MAGIC, { name: 'Kai', values: { mana: 40 } })).toEqual([]);
        // Switched off: never, even when it holds.
        expect(lastingLines(MAGIC, { name: 'Kai', values: { mana: 100 } })).toEqual([]);
        expect(lastingLines(MAGIC, { name: 'Kai', values: {} })).toEqual([]);
    });

    it('scales by their levels, both sides at once, {value} as words for a words attribute', () => {
        const standing: PromptAttribute = {
            id: 'standing',
            promptName: 'Standing',
            kind: 'scale',
            levels: ['hostile', 'cold', 'neutral', 'warm'],
            events: [
                { id: 'enemy', when: { op: '=', value: 'hostile' }, text: '{holder} treats you as an enemy' },
                { id: 'cool', when: { op: '<=', value: 'cold' }, text: '{holder} keeps away' },
            ],
        };
        const scales: PromptMechanic = { id: 'rep', name: 'Rep', summary: '', rules: '', attributes: [standing] };
        expect(lastingLines(scales, { name: 'Guild', values: { standing: 'hostile' } })).toEqual([
            'Guild treats you as an enemy.',
            'Guild keeps away.',
        ]);
        expect(lastingLines(scales, { name: 'Guild', values: { standing: 'warm' } })).toEqual([]);
        const heat: PromptAttribute = {
            id: 'heat',
            promptName: 'Heat',
            kind: 'number',
            min: 0,
            max: 10,
            visibility: { prompt: 'words', words: [{ upTo: 3, label: 'cool' }, { label: 'scorching' }] },
            events: [{ id: 'hot', when: { op: '>=', value: 8 }, text: 'The air is {value} around {holder}.' }],
        };
        const weather: PromptMechanic = { id: 'weather', name: 'Weather', summary: '', rules: '', attributes: [heat] };
        expect(lastingLines(weather, { name: 'Kai', values: { heat: 9 } })).toEqual([
            'The air is scorching around Kai.',
        ]);
        // A secret attribute's events stay Maestro's.
        const secret = { ...weather, attributes: [{ ...heat, visibility: { preset: 'secret' as const } }] };
        expect(lastingLines(secret, { name: 'Kai', values: { heat: 9 } })).toEqual([]);
    });
});

describe('conditions, inventories and fixed lines', () => {
    it('a status: stacks, what is left, its modifiers (times the stacks), the note', () => {
        expect(
            statusText({
                promptName: 'poisoned',
                remaining: { turns: 2 },
                modifiers: { checks: -2, strength: -1, luck: 0 },
                text: ' nausea ',
            }),
        ).toBe('poisoned (2 turns left; checks −2, strength −1): nausea');
        expect(
            statusText({
                promptName: 'blessed',
                remaining: null,
                until: { day: 3, minutes: 1080 },
                stacks: 2,
                modifiers: { 'check:stealth': 1.5 },
            }),
        ).toBe('blessed x2 (until day 3 18:00; stealth checks +3)');
        expect(statusText({ promptName: 'asleep', remaining: null })).toBe('asleep');
        expect(defaultModifierLabel('magic.mana_pool')).toBe('mana pool');
        expect(
            statusText(
                { promptName: 'hexed', remaining: null, modifiers: { mana: -5 }, mechanicId: 'magic' },
                (key, id) => (id === 'magic' && key === 'mana' ? 'arcane power' : key),
            ),
        ).toBe('hexed (arcane power −5)');
    });

    const section: PromptSection = {
        mechanic: { ...HEALTH, attributes: [HEALTH.attributes[4]!] },
        holders: [
            { name: 'Kai', primary: true, persona: true, values: { trust: 50 } },
            { name: 'Mira', values: { trust: 10 } },
        ],
    };

    it('puts conditions and the inventory under their holder, the fixed lines before the closing line', () => {
        const rendered = renderGame([section], {
            budget: 0,
            instruction: '[Mechanics block] …',
            extras: [
                {
                    holder: 'Kai',
                    statuses: [{ promptName: 'poisoned', remaining: null }],
                    items: [{ id: '1', name: 'rope', qty: 2 }],
                },
                { holder: 'Lena', statuses: [{ promptName: 'asleep', remaining: null }] },
                { holder: 'Mira', statuses: [], items: [] },
            ],
            fixed: ['[Combat] Round 1.'],
        });
        expect(rendered.rules).toContain(
            '## Health\nWounds hurt.\nChanges: trust in words only, never as numbers.\n\n[Mechanics block] …\n</game_rules>',
        );
        expect(rendered.state.split('\n')).toEqual([
            '<game_state>',
            "Kai (the user's character)",
            '- Health: trust: moderate',
            '- conditions: poisoned',
            '- inventory: rope x2',
            'Mira',
            '- Health: trust: very low',
            'Lena',
            '- conditions: asleep',
            '[Combat] Round 1.',
            'Write this reply in line with these values.',
            '</game_state>',
        ]);
    });

    it('cuts the other holders, then inventories and conditions (others first), never the fight', () => {
        const length = (text: string) => text.length;
        const extras = [
            {
                holder: 'Kai',
                statuses: [{ promptName: 'poisoned', remaining: { turns: 2 } }],
                items: [{ id: '1', name: 'rope', qty: 2 }],
            },
            { holder: 'Mira', statuses: [{ promptName: 'stunned', remaining: null }] },
        ];
        const fixed = ['[Combat] Round 1.'];
        const tiny = renderGame([section], { budget: 5, extras, fixed, count: length });
        expect(tiny.cut).toEqual([
            { kind: 'rules', mechanicId: 'health', to: 'summary' },
            { kind: 'rules', mechanicId: 'health', to: 'none' },
            { kind: 'holder', mechanicId: 'health', holder: 'Mira', primary: false },
            { kind: 'extra', holder: 'Mira', what: 'conditions', primary: false },
            { kind: 'extra', holder: 'Kai', what: 'inventory', primary: true },
            { kind: 'extra', holder: 'Kai', what: 'conditions', primary: true },
            { kind: 'holder', mechanicId: 'health', holder: 'Kai', primary: true },
            // The fight alone is still over the budget: the mechanic goes, the fight stays.
            { kind: 'mechanic', mechanicId: 'health' },
        ]);
        expect(tiny.mechanics).toEqual([]);
        expect(tiny.state).toBe(
            '<game_state>\n[Combat] Round 1.\nWrite this reply in line with these values.\n</game_state>',
        );
    });

    it('DES’s tracker line names each stat once; none without names', () => {
        expect(trackerLine(['Health', ' Stamina ', 'health', ''])).toBe(
            'Tracker stats: Health, Stamina in your tracker JSON are these same values — start from the numbers above and change them only by what happens in this reply.',
        );
        expect(trackerLine([])).toBe('');
    });
});

describe('importance', () => {
    const sections = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ mechanic: { id } }));

    it('facts of this generation, changed lately, named by the user, the rest — the given order within', () => {
        const ordered = orderSections(sections, { facts: ['d'], changed: ['e', 'b', 'd'], named: ['c', 'a'] });
        expect(ordered.map((section) => section.mechanic.id)).toEqual(['d', 'b', 'e', 'a', 'c']);
        expect(orderSections(sections, {}).map((section) => section.mechanic.id)).toEqual(['a', 'b', 'c', 'd', 'e']);
    });

    it('a name is mentioned when every word of it starts a word of the text (Russian endings may differ)', () => {
        expect(mentionedIn('Я колдую, хотя маны почти нет.', ['Мана'])).toBe(true);
        expect(mentionedIn('Я колдую.', ['Мана', 'Магия'])).toBe(false);
        expect(mentionedIn('Пытаюсь восстановить выносливость.', ['Выносливость'])).toBe(true);
        expect(mentionedIn('Иду к Красной гильдии', ['Красная гильдия'])).toBe(true);
        expect(mentionedIn('I cast a spell with my last mana', ['Mana'])).toBe(true);
        expect(mentionedIn('I wait.', ['HP', 'Mana'])).toBe(false);
        expect(mentionedIn('Kai looks at Mira', ['mira'])).toBe(true);
    });
});
