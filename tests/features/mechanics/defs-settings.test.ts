import { describe, expect, it } from 'vitest';
import type { MechanicsSettings } from '../../../src/features/mechanics/parts';
import { DEFAULT_MECHANICS_SETTINGS } from '../../../src/features/mechanics/parts';
import { defaultMechanicsSettings, readMechanicsSettings } from '../../../src/features/mechanics/settings';
import { DEF_STRINGS } from '../../../src/features/mechanics/strings-defs';

describe('mechanics settings', () => {
    it('defaults to a fresh copy of the contract defaults', () => {
        const value = defaultMechanicsSettings();
        expect(value).toEqual(DEFAULT_MECHANICS_SETTINGS);
        value.book = 'x';
        expect(DEFAULT_MECHANICS_SETTINGS.book).toBe('Maestro · механики');
    });

    it('repairs the live slice in place', () => {
        const slice = {
            book: '   ',
            autoChecks: 'yes',
            strip: false,
            promptBudget: 10_000,
            depth: -3,
            background: undefined,
        } as unknown as Partial<MechanicsSettings>;
        const value = readMechanicsSettings(slice);
        expect(value).toBe(slice);
        expect(value).toEqual({
            book: 'Maestro · механики',
            autoChecks: true,
            strip: false,
            promptBudget: 4000,
            depth: 0,
            background: true,
            modelRolls: true,
            autoCombat: true,
            personaFallback: 'background',
            relevance: 4,
            hud: true,
            hudPlacement: 'chat',
            hudAttrs: [],
            hudHolders: [],
            desAttrs: [],
            desPersona: true,
        });
        expect(
            readMechanicsSettings({
                hud: false,
                hudAttrs: ['magic.mana', 'magic.mana', '', 3, ' magic.hp '] as unknown as string[],
                hudHolders: 'Kai' as unknown as string[],
            }),
        ).toMatchObject({ hud: false, hudPlacement: 'chat', hudAttrs: ['magic.mana', 'magic.hp'], hudHolders: [] });
        expect(readMechanicsSettings({ hudPlacement: 'left' }).hudPlacement).toBe('left');
        expect(
            readMechanicsSettings({ hudPlacement: 'right' as unknown as MechanicsSettings['hudPlacement'] })
                .hudPlacement,
        ).toBe('chat');
        expect(readMechanicsSettings({ book: ' Мои ', promptBudget: 333.4, depth: Number.NaN })).toMatchObject({
            book: 'Мои',
            promptBudget: 333,
            depth: 1,
        });
    });
});

describe('definitions strings', () => {
    it('have the same keys in English and Russian, none empty, all under m25. (or kind./target. labels)', () => {
        expect(Object.keys(DEF_STRINGS.ru).sort()).toEqual(Object.keys(DEF_STRINGS.en).sort());
        for (const [key, text] of Object.entries(DEF_STRINGS.ru)) expect(text, key).not.toBe('');
        for (const key of Object.keys(DEF_STRINGS.en)) {
            const label = key.startsWith('kind.mechanics.def.') || key.startsWith('target.mechanics.');
            expect(key === 'm25.title' || key === 'm25.tab' || key.startsWith('m25.def.') || label, key).toBe(true);
        }
    });

    it('cover every issue code, kind, holder kind and tracking mode', () => {
        const keys = new Set(Object.keys(DEF_STRINGS.en));
        for (const code of [
            'id',
            'name',
            'empty',
            'noRules',
            'holderNames',
            'scope',
            'attrId',
            'attrIdDuplicate',
            'attrName',
            'attrPromptName',
            'bounds',
            'initial',
            'initialRange',
            'levels',
            'initialLevel',
            'options',
            'initialOption',
            'initialSingle',
            'desStatsKind',
            'desStatsHolders',
            'eventId',
            'eventIdDuplicate',
            'eventText',
            'eventValue',
            'eventLevel',
            'eventOp',
            'checkId',
            'checkIdDuplicate',
            'checkName',
            'dice',
            'diceUnknown',
            'diceKind',
            'difficulty',
            'noTriggers',
        ]) {
            expect(keys.has(`m25.def.issue.${code}`), code).toBe(true);
        }
        for (const kind of ['number', 'scale', 'list', 'text']) expect(keys.has(`m25.def.kind.${kind}`)).toBe(true);
        for (const kind of ['persona', 'characters', 'named', 'world', 'factions']) {
            expect(keys.has(`m25.def.holders.${kind}`)).toBe(true);
        }
        for (const mode of ['desStats', 'block', 'background', 'manual']) {
            expect(keys.has(`m25.def.tracking.${mode}`)).toBe(true);
        }
        for (const scope of ['global', 'card', 'chat']) expect(keys.has(`m25.def.scope.${scope}`)).toBe(true);
    });
});
