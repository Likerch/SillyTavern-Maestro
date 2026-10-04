import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { PROMPT_ROLES, PROMPT_TRIGGERS } from '../../../src/domain/preset-ui-blocks';
import { PARAMS, PARAM_GROUPS, optionKey } from '../../../src/domain/preset-ui-params';
import { PRESET_STUDIO_STRINGS } from '../../../src/features/presetStudio/module';
import { M34_STRINGS } from '../../../src/features/presetStudio/strings';
import { STUDIO_TABS } from '../../../src/features/presetStudio/studio';

const SOURCE = join(__dirname, '../../../src/features/presetStudio');
const SHELL_FILES = [
    'studio.ts',
    'launcher.ts',
    'module.ts',
    'dialogs.ts',
    'view-analysis.ts',
    'view-blocks.ts',
    'view-editor.ts',
    'view-layer.ts',
    'view-map.ts',
    'view-params.ts',
    'view-scenarios.ts',
    'view-tab.ts',
    'view-versions.ts',
];

describe('Preset Studio strings', () => {
    it('have the same non-empty keys in English and Russian', () => {
        expect(Object.keys(M34_STRINGS.ru).sort()).toEqual(Object.keys(M34_STRINGS.en).sort());
        for (const [key, text] of Object.entries(M34_STRINGS.ru)) expect(text, key).not.toBe('');
        for (const key of Object.keys(M34_STRINGS.en)) expect(key.startsWith('m34.'), key).toBe(true);
    });

    it('cover every literal key of the shell (the parts’ strings merged in the module)', () => {
        const used = new Set<string>();
        for (const file of SHELL_FILES) {
            const source = readFileSync(join(SOURCE, file), 'utf8');
            for (const match of source.matchAll(/'(m34\.[A-Za-z0-9_.-]+)'/g)) used.add(match[1]!);
        }
        expect(used.size).toBeGreaterThan(250);
        expect([...used].filter((key) => !(key in PRESET_STUDIO_STRINGS.en))).toEqual([]);
        expect([...used].filter((key) => !(key in PRESET_STUDIO_STRINGS.ru))).toEqual([]);
    });

    it('cover every key built at runtime', () => {
        const dynamic = [
            ...STUDIO_TABS.map((tab) => `m34.tab.${tab}`),
            ...PROMPT_ROLES.map((role) => `m34.role.${role}`),
            ...PROMPT_TRIGGERS.map((trigger) => `m34.trigger.${trigger}`),
            ...['inChat', 'marker', 'important', 'global', 'user'].map((kind) => `m34.kind.${kind}`),
            ...[
                'neverIncluded',
                'typeMismatch',
                'contradiction',
                'duplicateWithLore',
                'duplicateWithInjection',
                'duplicateBlock',
                'heavyBlock',
                'unsaved',
                'macroEngineOff',
                'modelQuirk',
                'emptyMessage',
            ].map((kind) => `m34.finding.${kind}`),
            ...['user', 'layer', 'import', 'st', 'migration', 'draft', 'other'].map((by) => `m34.versions.by.${by}`),
            ...['added', 'removed', 'changed'].map((kind) => `m34.diff.${kind}`),
            ...['json', 'shape'].map((reason) => `m34.list.invalid.${reason}`),
            ...['migrate', 'transfer'].map((kind) => `m34.layer.report.${kind}`),
            ...['start', 'end', 'chat'].map((where) => `m34.map.where.${where}`),
            ...['notNumber', 'range', 'option'].map((error) => `m34.params.error.${error}`),
            ...PARAM_GROUPS.map((group) => `m34.params.group.${group}`),
            ...PARAMS.map((spec) => `m34.params.key.${spec.key}`),
            ...PARAMS.flatMap((spec) =>
                spec.type === 'select'
                    ? spec.options.map((option) => `m34.params.opt.${spec.key}.${optionKey(option)}`)
                    : [],
            ),
            ...['enabled', 'max_tokens', 'temperature', 'historyMessages', 'stop', 'reasoning', 'messages'].map(
                (field) => `m34.scn.field.${field}`,
            ),
            ...['keep', 'off'].map((value) => `m34.scn.reasoning.${value}`),
            ...[
                'charDescription',
                'charPersonality',
                'scenario',
                'personaDescription',
                'worldInfoBefore',
                'worldInfoAfter',
            ].map((source) => `m34.source.${source}`),
        ];
        expect(dynamic.filter((key) => !(key in M34_STRINGS.en))).toEqual([]);
    });
});
