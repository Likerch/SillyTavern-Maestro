// M25 prompt rendering (release 1.27): two English blocks — the rules (`<game_rules>`: the framing line, a heading and
// the rules per mechanic in a stable order, the block instruction last) and the state (`<game_state>`: per holder the
// values with their band words, the lasting events, conditions, inventory; the fixed lines and the closing line) — cut
// together to one token budget (the rules first; the main holders' values and "now" lines last), and the facts.
import { describe, expect, it } from 'vitest';
import {
    FACTS_HEADER,
    PERSONA_MARK,
    RULES_CLOSE,
    RULES_FRAME,
    RULES_OPEN,
    STATE_CLOSE,
    STATE_CLOSING,
    STATE_OPEN,
    countTokens,
    formatValue,
    holderValues,
    renderFacts,
    renderGame,
    valueText,
} from '../../src/domain/mechanics-prompt';
import type { PromptAttribute, PromptMechanic, PromptSection } from '../../src/domain/mechanics-prompt';

const MANA: PromptAttribute = {
    id: 'mana',
    promptName: 'Mana',
    name: 'Мана',
    kind: 'number',
    min: 0,
    max: 30,
    events: [{ id: 'empty', when: { op: '<=', value: 0 }, text: '{holder} has no mana left and cannot cast' }],
};
const SCHOOLS: PromptAttribute = { id: 'schools', promptName: 'Schools', kind: 'list' };
const SECRET: PromptAttribute = { id: 'secret', promptName: 'Secret', kind: 'text', visible: false };

const MAGIC: PromptMechanic = {
    id: 'magic',
    name: 'Magic',
    summary: 'Mana fuels spells.',
    rules: 'Casting costs   mana;\n\n at 0 mana no spells.',
    attributes: [MANA, SCHOOLS, SECRET],
};

const HEALTH: PromptMechanic = {
    id: 'health',
    name: 'Health',
    summary: '',
    rules: 'At 0 health a character falls.',
    attributes: [{ id: 'hp', promptName: 'HP', kind: 'number', max: 10 }],
};

function magicSection(mana = 12): PromptSection {
    return {
        mechanic: MAGIC,
        holders: [
            {
                name: 'Kai',
                primary: true,
                persona: true,
                values: { mana, schools: ['fire', 'water'], secret: 'hidden' },
            },
            { name: 'Anna', values: { mana: 5, schools: [] } },
        ],
    };
}

function healthSection(): PromptSection {
    return {
        mechanic: HEALTH,
        holders: [
            { name: 'Anna', values: { hp: 3 } },
            { name: 'Kai', primary: true, persona: true, values: { hp: 8 } },
        ],
    };
}

const length = (text: string) => text.length;

describe('values', () => {
    it('numbers with and without bounds, with their band word', () => {
        expect(formatValue(MANA, 12)).toBe('mana 12/30');
        expect(formatValue(MANA, 12, 'low')).toBe('mana 12/30 (low)');
        expect(formatValue(MANA, '7')).toBe('mana 7/30');
        expect(formatValue({ ...MANA, min: -10, max: 10 }, 2.346)).toBe('mana 2.35 (-10..10)');
        expect(formatValue({ ...MANA, min: -10, max: 10 }, 2, 'moderate')).toBe('mana 2 (-10..10, moderate)');
        expect(formatValue({ id: 'gold', promptName: 'Gold', kind: 'number' }, 120)).toBe('gold 120');
        expect(formatValue({ id: 'gold', promptName: '', name: 'Gold Coins', kind: 'number', min: 0 }, 3)).toBe(
            'gold coins 3',
        );
        expect(formatValue(MANA, 'lots')).toBeNull();
        expect(formatValue(MANA, null)).toBeNull();
        expect(formatValue(MANA, undefined)).toBeNull();
    });

    it('bounded numbers get the default band word; unbounded ones and a progression level none', () => {
        expect(valueText(MAGIC, MANA, 0)).toBe('mana 0/30 (none left)');
        expect(valueText(MAGIC, MANA, 5)).toBe('mana 5/30 (very low)');
        expect(valueText(MAGIC, MANA, 30)).toBe('mana 30/30 (full)');
        expect(valueText(HEALTH, HEALTH.attributes[0]!, 8)).toBe('hp 8/10');
        const level: PromptAttribute = { id: 'level', promptName: 'Level', kind: 'number', min: 1, max: 5 };
        const skills: PromptMechanic = { ...MAGIC, attributes: [level], progression: { level: 'level' } };
        expect(valueText(skills, level, 1)).toBe('level 1 (1..5)');
        expect(valueText({ ...skills, progression: undefined }, level, 1)).toBe('level 1 (1..5, none left)');
        // The attribute's own bands win over the default ones.
        const stealth: PromptAttribute = {
            id: 'stealth',
            promptName: 'Stealth',
            kind: 'number',
            min: 0,
            max: 10,
            visibility: { words: [{ upTo: 5, label: 'trained' }, { label: 'master' }] },
        };
        expect(valueText(MAGIC, stealth, 6)).toBe('stealth 6/10 (master)');
        expect(valueText(MAGIC, SECRET, 'x')).toBeNull();
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

    it('a holder shows only the visible attributes with values', () => {
        expect(holderValues(MAGIC, { name: ' Kai ', values: { mana: 12, schools: ['fire'], secret: 'x' } })).toBe(
            'mana 12/30 (low), schools: fire',
        );
        expect(holderValues(MAGIC, { name: 'Ghost', values: { secret: 'x' } })).toBeNull();
    });
});

describe('the two blocks', () => {
    it('renders the rules and the state of the mechanics in the scene', () => {
        const rendered = renderGame([magicSection(), healthSection()], { budget: 0 });
        expect(rendered.rules).toBe(
            [
                RULES_OPEN,
                RULES_FRAME.top,
                '',
                '## Magic',
                'Casting costs mana;',
                'at 0 mana no spells.',
                '',
                '## Health',
                'At 0 health a character falls.',
                RULES_CLOSE,
            ].join('\n'),
        );
        expect(rendered.state).toBe(
            [
                STATE_OPEN,
                `Kai ${PERSONA_MARK}`,
                '- Magic: mana 12/30 (low), schools: fire, water',
                '- Health: hp 8/10',
                'Anna',
                '- Magic: mana 5/30 (very low), schools: none',
                '- Health: hp 3/10',
                STATE_CLOSING,
                STATE_CLOSE,
            ].join('\n'),
        );
        expect(rendered).toMatchObject({ budget: 0, cut: [], mechanics: ['magic', 'health'] });
        expect(rendered.rulesTokens).toBe(countTokens(rendered.rules));
        expect(rendered.stateTokens).toBe(countTokens(rendered.state));
        expect(rendered.tokens).toBe(rendered.rulesTokens + rendered.stateTokens);
    });

    it('a "now" line while a lasting event holds; the fixed lines and the closing line end the state', () => {
        const rendered = renderGame([magicSection(0)], { budget: 0, fixed: ['[Combat] Round 1.', ' '] });
        expect(rendered.state.split('\n')).toEqual([
            STATE_OPEN,
            `Kai ${PERSONA_MARK}`,
            '- Magic: mana 0/30 (none left), schools: fire, water',
            '- now: Kai has no mana left and cannot cast.',
            'Anna',
            '- Magic: mana 5/30 (very low), schools: none',
            '[Combat] Round 1.',
            STATE_CLOSING,
            STATE_CLOSE,
        ]);
    });

    it('the rules keep their own order whatever the importance; the frame says where the values are', () => {
        const rendered = renderGame([healthSection(), magicSection()], {
            budget: 0,
            rulesOrder: ['magic', 'health'],
            place: 'end',
        });
        expect(rendered.rules.indexOf('## Magic')).toBeLessThan(rendered.rules.indexOf('## Health'));
        expect(rendered.rules).toContain(RULES_FRAME.end);
        // The state follows the importance: the persona first, its lines in the sections' order.
        expect(rendered.state.split('\n').slice(1, 4)).toEqual([
            `Kai ${PERSONA_MARK}`,
            '- Health: hp 8/10',
            '- Magic: mana 12/30 (low), schools: fire, water',
        ]);
    });

    it('names a mechanic by its English prompt name when it has one', () => {
        const russian: PromptMechanic = { ...MAGIC, name: 'Магия', promptName: 'Magic' };
        const rendered = renderGame([{ mechanic: russian, holders: [] }], { budget: 0 });
        expect(rendered.rules).toContain('\n## Magic\n');
        expect(rendered.state).toBe('');
    });

    it('falls back to the summary and the id; a mechanic with nothing to say has no rules', () => {
        const bare: PromptMechanic = { id: 'luck', name: '', summary: 'Luck bends fate.', rules: ' ', attributes: [] };
        const rendered = renderGame([{ mechanic: bare, holders: [{ name: 'Kai', values: {} }] }], { budget: 0 });
        expect(rendered.rules).toContain('## luck\nLuck bends fate.');
        expect(rendered.state).toBe('');
        const silent = { ...bare, summary: '' };
        expect(renderGame([{ mechanic: silent, holders: [] }], { budget: 0 }).rules).toBe('');
        expect(renderGame([], { budget: 100 })).toMatchObject({ rules: '', state: '', tokens: 0, mechanics: [] });
    });

    it('ends the rules with the instruction, which is never cut', () => {
        const full = renderGame([magicSection()], { budget: 0, instruction: ' BLOCK FORMAT ' });
        expect(full.rules.endsWith(`\n\nBLOCK FORMAT\n${RULES_CLOSE}`)).toBe(true);
        const rendered = renderGame([magicSection()], { budget: 1, instruction: ' BLOCK FORMAT ', count: length });
        expect(rendered.rules).toBe(`${RULES_OPEN}\nBLOCK FORMAT\n${RULES_CLOSE}`);
        expect(rendered.state).toBe('');
        expect(rendered.mechanics).toEqual([]);
        expect(rendered.cut.at(-1)).toEqual({ kind: 'mechanic', mechanicId: 'magic' });
    });
});

describe('the budget', () => {
    it('cuts the rules first, then other holders, then the main holders, their "now" lines last', () => {
        const rendered = renderGame([magicSection(0), healthSection()], { budget: 1, count: length });
        expect(rendered.cut).toEqual([
            { kind: 'rules', mechanicId: 'magic', to: 'summary' },
            { kind: 'rules', mechanicId: 'health', to: 'none' },
            { kind: 'rules', mechanicId: 'magic', to: 'none' },
            { kind: 'holder', mechanicId: 'health', holder: 'Anna', primary: false },
            { kind: 'holder', mechanicId: 'magic', holder: 'Anna', primary: false },
            { kind: 'holder', mechanicId: 'health', holder: 'Kai', primary: true },
            { kind: 'holder', mechanicId: 'magic', holder: 'Kai', primary: true },
            { kind: 'now', mechanicId: 'magic', holder: 'Kai', primary: true },
        ]);
        expect(rendered).toMatchObject({ rules: '', state: '', tokens: 0, mechanics: [] });
    });

    it('cuts the other holders’ "now" lines before the main holder’s values', () => {
        const section: PromptSection = {
            mechanic: MAGIC,
            holders: [
                { name: 'Kai', primary: true, persona: true, values: { mana: 10 } },
                { name: 'Anna', values: { mana: 0 } },
            ],
        };
        const rendered = renderGame([section], { budget: 1, count: length });
        expect(rendered.cut.map((step) => step.kind)).toEqual(['rules', 'rules', 'holder', 'now', 'holder']);
        expect(rendered.cut[3]).toEqual({ kind: 'now', mechanicId: 'magic', holder: 'Anna', primary: false });
    });

    it('stops cutting as soon as both blocks fit, the rules going to the summary first', () => {
        const full = renderGame([magicSection(), healthSection()], { budget: 0, count: length });
        const rendered = renderGame([magicSection(), healthSection()], {
            budget: full.tokens - 5,
            count: length,
        });
        expect(rendered.cut).toEqual([{ kind: 'rules', mechanicId: 'magic', to: 'summary' }]);
        expect(rendered.rules).toContain('## Magic\nMana fuels spells.');
        expect(rendered.state).toBe(full.state);
        expect(rendered.tokens).toBeLessThanOrEqual(full.tokens - 5);
    });

    it('keeps the main holder and its "now" line when only the state fits', () => {
        const section = magicSection(0);
        const stateOnly = renderGame([section], { budget: 0, count: length });
        const rendered = renderGame([section], { budget: stateOnly.stateTokens, count: length });
        expect(rendered.rules).toBe('');
        expect(rendered.state).toBe(stateOnly.state);
        const tighter = renderGame([section], { budget: stateOnly.stateTokens - 1, count: length });
        expect(tighter.state).toContain('now: Kai has no mana left');
        expect(tighter.state).not.toContain('Anna');
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
