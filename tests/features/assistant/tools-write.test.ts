// The write tools as a set (M33 part C): names, kinds, schemas, availability, undo registration, strings.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { WRITE_STRINGS } from '../../../src/features/assistant/tools/write';
import { UNDO_TARGETS } from '../../../src/features/assistant/tools/write/common';
import { sayer } from '../../../src/features/assistant/tools/write/strings';
import { fakeLore, fakeMechanics, fakePassports, fakePreset, writeFake } from './tools-write-fakes';
import { schemaProblems, toolNamed } from './tools-helpers';

const NAMES = [
    'setting_set',
    'module_toggle',
    'autonomy_set',
    'mechanic_save',
    'mechanic_toggle_chat',
    'regex_create',
    'regex_toggle',
    'preset_block_add',
    'preset_block_condition',
    'preset_block_edit',
    'preset_block_toggle',
    'preset_block_move',
    'preset_block_remove',
    'preset_params_set',
    'preset_pack',
    'preset_create',
    'preset_bind',
    'preset_unbind',
    'preset_save',
    'preset_version_restore',
    'neighbour_prompt_set',
    'lore_entry_create',
    'lore_entry_update',
    'passport_set',
];

describe('write tools', () => {
    it('are all write tools with plan() and no run()', () => {
        const fake = writeFake();
        expect(fake.tools.map((tool) => tool.name)).toEqual(NAMES);
        for (const tool of fake.tools) {
            expect(tool.kind).toBe('write');
            expect(typeof tool.plan).toBe('function');
            expect(tool.run).toBeUndefined();
        }
    });

    it('have strict English schemas', () => {
        const fake = writeFake();
        for (const tool of fake.tools) {
            expect(schemaProblems(tool), tool.name).toEqual([]);
            expect(tool.description.length).toBeGreaterThan(40);
        }
    });

    it('register undo handlers for the changes they journal themselves', () => {
        const fake = writeFake();
        expect([...fake.undoJournal.handlers.keys()].sort()).toEqual(Object.values(UNDO_TARGETS).sort());
    });

    it('are offered only when their module or capability is there', () => {
        const bare = writeFake();
        const offered = (fake: ReturnType<typeof writeFake>) =>
            fake.tools.filter((tool) => !tool.available || tool.available(fake.app)).map((tool) => tool.name);
        expect(offered(bare)).toEqual(['setting_set', 'module_toggle', 'autonomy_set']);

        const preset = fakePreset([]);
        Object.assign(preset.store, { createFromBody: async () => 'New' });
        Object.assign(preset.layer, { bind: async () => {}, bindings: () => null });
        const full = writeFake({
            caps: ['st.regex'],
            apis: {
                mechanics: fakeMechanics(),
                presetStore: preset.store,
                presetLayer: preset.layer,
                loreStore: fakeLore({}).store,
                lorePassports: fakePassports(),
                neighbourPrompts: {},
            },
        });
        expect(offered(full)).toEqual(NAMES);

        const settingsOnly = writeFake({ ctx: { extensionSettings: { regex: [] } } });
        expect(offered(settingsOnly)).toContain('regex_create');

        const noLayer = writeFake({ apis: { presetStore: preset.store } });
        expect(offered(noLayer)).not.toContain('preset_block_add');
        // Saving and versions need only the store; binding needs a layer that binds.
        expect(offered(noLayer)).toEqual(expect.arrayContaining(['preset_save', 'preset_version_restore']));
        expect(offered(noLayer)).not.toContain('preset_bind');

        const old = writeFake();
        old.autonomy.withoutSetLevel();
        expect(toolNamed(old.tools, 'autonomy_set').available?.(old.app)).toBe(false);
    });

    it('have every string in both languages', () => {
        const en = Object.keys(WRITE_STRINGS.en).sort();
        expect(Object.keys(WRITE_STRINGS.ru).sort()).toEqual(en);
        for (const key of en) expect(key.startsWith('m33w.')).toBe(true);
    });

    it('use the same placeholders in both languages', () => {
        const placeholders = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
        for (const [key, text] of Object.entries(WRITE_STRINGS.en)) {
            expect(placeholders(WRITE_STRINGS.ru[key] ?? ''), key).toEqual(placeholders(text));
        }
    });

    it('have a string for every key and error code the code uses', () => {
        const root = join(__dirname, '../../../src');
        const sources = [
            ...readdirSync(join(root, 'features/assistant/tools/write')).map((name) =>
                join(root, 'features/assistant/tools/write', name),
            ),
            ...readdirSync(join(root, 'domain'))
                .filter((name) => name.startsWith('assistant-write-'))
                .map((name) => join(root, 'domain', name)),
        ];
        const keys = new Set<string>();
        for (const file of sources) {
            const text = readFileSync(file, 'utf8');
            for (const match of text.matchAll(/'(m33w\.[\w.]+[\w])'/g)) keys.add(match[1]!);
            for (const match of text.matchAll(/(?:failure\(say, |new ArgError\()'(\w+)'/g))
                keys.add(`m33w.err.${match[1]}`);
        }
        expect(keys.size).toBeGreaterThan(60);
        for (const key of keys) expect(WRITE_STRINGS.en[key], key).toBeTypeOf('string');
    });

    it('translate with the conversation locale and fall back to English, then the key', () => {
        expect(sayer('ru')('m33w.on')).toBe('вкл');
        expect(sayer('en')('m33w.err.argMissing', { name: 'book' })).toBe('The parameter «book» is missing.');
        expect(sayer('ru')('m33w.unknown.key')).toBe('m33w.unknown.key');
        expect(sayer('en')('m33w.err.argRange', { name: 'x' })).toContain('{min}');
    });
});
