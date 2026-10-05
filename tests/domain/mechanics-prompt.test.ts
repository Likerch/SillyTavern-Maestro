// M25 prompt rendering: values of visible attributes of holders in the scene, the compact English block, the cut to a
// token budget (other holders, then rules, then the main holder, then mechanics; the instruction never), and facts.
import { describe, expect, it } from 'vitest';
import {
    FACTS_HEADER,
    RULES_HEADER,
    countTokens,
    formatValue,
    holderLine,
    renderFacts,
    renderRules,
} from '../../src/domain/mechanics-prompt';
import type { PromptAttribute, PromptMechanic, PromptSection } from '../../src/domain/mechanics-prompt';

const MANA: PromptAttribute = { id: 'mana', promptName: 'Mana', name: 'Мана', kind: 'number', min: 0, max: 30 };
const SCHOOLS: PromptAttribute = { id: 'schools', promptName: 'Schools', kind: 'list' };
const SECRET: PromptAttribute = { id: 'secret', promptName: 'Secret', kind: 'text', visible: false };

const MAGIC: PromptMechanic = {
    id: 'magic',
    name: 'Magic',
    summary: 'Mana fuels spells.',
    rules: 'Casting costs mana;\n at 0 mana no spells.',
    attributes: [MANA, SCHOOLS, SECRET],
};

const HEALTH: PromptMechanic = {
    id: 'health',
    name: 'Health',
    summary: '',
    rules: 'At 0 health a character falls.',
    attributes: [{ id: 'hp', promptName: 'HP', kind: 'number', max: 10 }],
};

function magicSection(): PromptSection {
    return {
        mechanic: MAGIC,
        holders: [
            { name: 'Kai', primary: true, values: { mana: 12, schools: ['fire', 'water'], secret: 'hidden' } },
            { name: 'Anna', values: { mana: 5, schools: [] } },
        ],
    };
}

function healthSection(): PromptSection {
    return {
        mechanic: HEALTH,
        holders: [
            { name: 'Kai', primary: true, values: { hp: 8 } },
            { name: 'Anna', values: { hp: 3 } },
        ],
    };
}

const length = (text: string) => text.length;

describe('values', () => {
    it('numbers with and without bounds', () => {
        expect(formatValue(MANA, 12)).toBe('mana 12/30');
        expect(formatValue(MANA, '7')).toBe('mana 7/30');
        expect(formatValue({ ...MANA, min: -10, max: 10 }, 2.346)).toBe('mana 2.35 (-10..10)');
        expect(formatValue({ id: 'gold', promptName: 'Gold', kind: 'number' }, 120)).toBe('gold 120');
        expect(formatValue({ id: 'gold', promptName: '', name: 'Gold Coins', kind: 'number', min: 0 }, 3)).toBe(
            'gold coins 3',
        );
        expect(formatValue(MANA, 'lots')).toBeNull();
        expect(formatValue(MANA, null)).toBeNull();
        expect(formatValue(MANA, undefined)).toBeNull();
    });

    it('scales show the level and its place', () => {
        const standing: PromptAttribute = {
            id: 'standing',
            promptName: 'Standing',
            kind: 'scale',
            levels: ['hostile', 'cold', 'neutral', 'warm', 'loyal'],
        };
        expect(formatValue(standing, 'warm')).toBe('standing: warm (4/5)');
        expect(formatValue(standing, 'odd')).toBe('standing: odd');
        expect(formatValue({ ...standing, levels: undefined }, 'warm')).toBe('standing: warm');
    });

    it('lists and texts', () => {
        expect(formatValue(SCHOOLS, ['fire', ' water '])).toBe('schools: fire, water');
        expect(formatValue(SCHOOLS, [])).toBe('schools: none');
        expect(formatValue(SCHOOLS, 'fire')).toBe('schools: fire');
        expect(formatValue({ id: 'mood', promptName: 'Mood', kind: 'text' }, '  calm\n and quiet ')).toBe(
            'mood: "calm and quiet"',
        );
        expect(formatValue({ id: 'mood', promptName: 'Mood', kind: 'text' }, '   ')).toBeNull();
        expect(formatValue({ id: 'mood', promptName: 'Mood', kind: 'text' }, ['a', 'b'])).toBe('mood: "a, b"');
        const long = formatValue({ id: 'note', promptName: 'Note', kind: 'text' }, 'x'.repeat(200)) ?? '';
        expect(long.length).toBeLessThan(100);
        expect(long.endsWith('…"')).toBe(true);
    });

    it('a holder line shows only visible attributes with values', () => {
        expect(holderLine(MAGIC, { name: ' Kai ', values: { mana: 12, schools: ['fire'], secret: 'x' } })).toBe(
            'Kai: mana 12/30, schools: fire',
        );
        expect(holderLine(MAGIC, { name: 'Ghost', values: { secret: 'x' } })).toBeNull();
    });
});

describe('the rules block', () => {
    it('renders the mechanics in the scene as one compact English block', () => {
        const rendered = renderRules([magicSection(), healthSection()], { budget: 0 });
        expect(rendered.text).toBe(
            [
                `${RULES_HEADER} Magic: Casting costs mana; at 0 mana no spells. | Kai: mana 12/30, schools: fire, water | Anna: mana 5/30, schools: none`,
                'Health: At 0 health a character falls. | Kai: hp 8/10 | Anna: hp 3/10',
            ].join('\n'),
        );
        expect(rendered).toMatchObject({ budget: 0, cut: [], mechanics: ['magic', 'health'] });
        expect(rendered.tokens).toBe(countTokens(rendered.text));
    });

    it('names a mechanic by its English prompt name when it has one', () => {
        const russian: PromptMechanic = { ...MAGIC, name: 'Магия', promptName: 'Magic' };
        const rendered = renderRules([{ mechanic: russian, holders: [] }], { budget: 0 });
        expect(rendered.text.startsWith(`${RULES_HEADER} Magic: `)).toBe(true);
    });

    it('falls back to the summary, the id, and keeps sections without holder lines', () => {
        const bare: PromptMechanic = { id: 'luck', name: '', summary: 'Luck bends fate.', rules: ' ', attributes: [] };
        const rendered = renderRules([{ mechanic: bare, holders: [{ name: 'Kai', values: {} }] }], { budget: 0 });
        expect(rendered.text).toBe(`${RULES_HEADER} luck: Luck bends fate.`);
        expect(renderRules([], { budget: 100 })).toMatchObject({ text: '', tokens: 0, mechanics: [] });
    });

    it('appends the instruction, which is never cut', () => {
        const rendered = renderRules([magicSection()], { budget: 1, instruction: ' BLOCK FORMAT ', count: length });
        expect(rendered.text).toBe('BLOCK FORMAT');
        expect(rendered.mechanics).toEqual([]);
        expect(rendered.cut.at(-1)).toEqual({ kind: 'mechanic', mechanicId: 'magic' });
    });

    it('cuts other holders first, then rules (summary, nothing), then the main holder, then mechanics', () => {
        const rendered = renderRules([magicSection(), healthSection()], { budget: 1, count: length });
        expect(rendered.cut).toEqual([
            { kind: 'holder', mechanicId: 'health', holder: 'Anna', primary: false },
            { kind: 'holder', mechanicId: 'magic', holder: 'Anna', primary: false },
            { kind: 'rules', mechanicId: 'magic', to: 'summary' },
            { kind: 'rules', mechanicId: 'health', to: 'none' },
            { kind: 'rules', mechanicId: 'magic', to: 'none' },
            { kind: 'holder', mechanicId: 'health', holder: 'Kai', primary: true },
            { kind: 'holder', mechanicId: 'magic', holder: 'Kai', primary: true },
            { kind: 'mechanic', mechanicId: 'health' },
            { kind: 'mechanic', mechanicId: 'magic' },
        ]);
        expect(rendered.text).toBe('');
    });

    it('stops cutting as soon as the block fits', () => {
        const full = renderRules([magicSection(), healthSection()], { budget: 0, count: length }).text;
        const withoutAnna = full.replace(' | Anna: hp 3/10', '');
        const rendered = renderRules([magicSection(), healthSection()], { budget: withoutAnna.length, count: length });
        expect(rendered.text).toBe(withoutAnna);
        expect(rendered.cut).toHaveLength(1);
        const summary = renderRules([magicSection()], {
            budget: `${RULES_HEADER} Magic: Mana fuels spells. | Kai: mana 12/30, schools: fire, water`.length,
            count: length,
        });
        expect(summary.text).toBe(`${RULES_HEADER} Magic: Mana fuels spells. | Kai: mana 12/30, schools: fire, water`);
    });

    it('without a main holder every holder goes before the rules', () => {
        const section: PromptSection = {
            mechanic: HEALTH,
            holders: [
                { name: 'Anna', values: { hp: 3 } },
                { name: 'Kai', values: { hp: 8 } },
            ],
        };
        const rendered = renderRules([section], { budget: `${RULES_HEADER} Health`.length, count: length });
        expect(rendered.text).toBe(`${RULES_HEADER} Health`);
        expect(rendered.cut).toEqual([
            { kind: 'holder', mechanicId: 'health', holder: 'Kai', primary: false },
            { kind: 'holder', mechanicId: 'health', holder: 'Anna', primary: false },
            { kind: 'rules', mechanicId: 'health', to: 'none' },
        ]);
    });
});

describe('facts', () => {
    it('one line per fact, repeats and blanks dropped', () => {
        expect(
            renderFacts([
                'Persuasion check (Kai): rolled 16 vs 15 — success.',
                ' ',
                'Kai collapses.',
                'Kai collapses.',
            ]),
        ).toBe(`${FACTS_HEADER}\n- Persuasion check (Kai): rolled 16 vs 15 — success.\n- Kai collapses.`);
        expect(renderFacts([])).toBe('');
    });
});
