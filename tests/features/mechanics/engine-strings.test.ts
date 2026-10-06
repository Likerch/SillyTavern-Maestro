// Strings of M25's engine (plan-2 §6): both languages carry the same keys and placeholders, every new definition
// issue and formula error has words, the default word bands and visibility sets are named, Russian texts are Russian.
import { describe, expect, it } from 'vitest';
import { validateDef } from '../../../src/domain/mechanics-defs';
import type { FormulaErrorCode } from '../../../src/domain/mechanics-formula';
import { DEFAULT_WORDS, VISIBILITY_PLACES, VISIBILITY_PRESETS } from '../../../src/domain/mechanics-visibility';
import { ENGINE_STRINGS, MECHANICS_STRINGS } from '../../../src/features/mechanics/strings';

const FORMULA_CODES: FormulaErrorCode[] = [
    'empty',
    'long',
    'char',
    'syntax',
    'paren',
    'func',
    'args',
    'dice',
    'ref',
    'cycle',
    'depth',
];

const ISSUE_CODES = [
    ...FORMULA_CODES.map((code) => `formula${code[0]!.toUpperCase()}${code.slice(1)}`),
    'actionAttr',
    'actionDerived',
    'actionOp',
    'actionStatus',
    'actionItem',
    'actionReveal',
    'eventChain',
    'eventChainSelf',
    'growthCap',
    'timeAttr',
    'progressionAttr',
    'progressionThresholds',
    'combatInitiative',
    'inventoryMoney',
];

describe('ENGINE_STRINGS', () => {
    it('same keys and placeholders in both languages, Russian in Russian', () => {
        expect(Object.keys(ENGINE_STRINGS.ru).sort()).toEqual(Object.keys(ENGINE_STRINGS.en).sort());
        const names = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const [key, text] of Object.entries(ENGINE_STRINGS.en)) {
            expect(names(ENGINE_STRINGS.ru[key] ?? ''), key).toEqual(names(text));
            expect(text.trim(), key).toBeTruthy();
        }
        const russian = Object.entries(ENGINE_STRINGS.ru).filter(([, text]) => /[а-яё]/i.test(text));
        expect(russian.length).toBeGreaterThan(Object.keys(ENGINE_STRINGS.ru).length - 4);
    });

    it('words every new definition issue and formula error', () => {
        for (const code of ISSUE_CODES) {
            for (const locale of ['en', 'ru'] as const) {
                expect(MECHANICS_STRINGS[locale][`m25.def.issue.${code}`], `${locale} ${code}`).toBeTruthy();
            }
        }
        for (const code of FORMULA_CODES) expect(ENGINE_STRINGS.ru[`m25.formula.error.${code}`], code).toBeTruthy();
    });

    it('every issue a broken definition gets has words', () => {
        const def = {
            id: 'x',
            name: 'X',
            summary: '',
            rules: 'r',
            attributes: [
                { id: 'a', name: 'A', promptName: 'A', kind: 'number' as const, formula: '@b +' },
                { id: 'b', name: 'B', promptName: 'B', kind: 'number' as const, formula: '@a' },
                { id: 'c', name: 'C', promptName: 'C', kind: 'number' as const, formula: '@c' },
            ],
            holders: { kind: 'characters' as const },
            checks: [],
            tracking: 'block' as const,
            scope: { kind: 'global' as const },
            time: [{ attr: 'zz', amount: 1, per: 'turn' as const }],
            combat: { initiative: 'nope' },
        };
        for (const issue of validateDef(def)) {
            expect(MECHANICS_STRINGS.ru[`m25.def.issue.${issue.code}`], issue.code).toBeTruthy();
        }
    });

    it('names the default word bands, the visibility sets and places', () => {
        DEFAULT_WORDS.forEach((_, index) => expect(ENGINE_STRINGS.ru[`m25.words.default.${index}`]).toBeTruthy());
        for (const preset of VISIBILITY_PRESETS) expect(ENGINE_STRINGS.ru[`m25.visibility.${preset}`]).toBeTruthy();
        for (const place of VISIBILITY_PLACES) expect(ENGINE_STRINGS.ru[`m25.visibility.place.${place}`]).toBeTruthy();
    });
});
