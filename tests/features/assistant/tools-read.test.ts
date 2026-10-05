// The assistant's read tools (M33, part B): the registry as a whole — unique names, valid strict schemas, kinds,
// available() gating by module APIs, and that every tool answers (never throws) on an app with nothing on.
import { describe, expect, it } from 'vitest';
import { builtinTools, readTools } from '../../../src/features/assistant/tools';
import { fakeApp, schemaProblems, toolContext, toolNamed } from './tools-helpers';

const READ_NAMES = [
    'maestro_modules',
    'maestro_settings',
    'maestro_health',
    'journal_recent',
    'inbox_list',
    'docs_search',
    'docs_read',
    'chat_read',
    'chat_search',
    'card_read',
    'persona_read',
    'scenario_overview',
    'turn_prompt',
    'lore_turn',
    'cost_turn',
    'cost_summary',
    'lore_search',
    'lore_entry',
    'canon_list',
    'regex_list',
    'regex_explain',
    'regex_test',
    'dossier',
    'relations',
    'knowledge_who',
    'places_current',
    'calendar_now',
    'wardrobe',
    'passports_scene',
    'mechanics_state',
    'director_scene',
    'preset_blocks',
];

/** Tool → the module API keys that switch it on. */
const GATES: Record<string, string[]> = {
    turn_prompt: ['inspector'],
    lore_turn: ['loreJournal'],
    cost_turn: ['treasurer'],
    canon_list: ['canon'],
    dossier: ['world'],
    relations: ['relations'],
    knowledge_who: ['knowledge'],
    places_current: ['places'],
    calendar_now: ['calendar'],
    wardrobe: ['wardrobe'],
    passports_scene: ['lorePassports'],
    mechanics_state: ['mechanics'],
    director_scene: ['director'],
    preset_blocks: ['presetStore'],
    lore_search: ['loreStore'],
    lore_entry: ['loreStore'],
};

describe('read tools registry', () => {
    const fake = fakeApp();
    const tools = readTools(fake.app);

    it('has every read tool, all of kind read with a run()', () => {
        expect(tools.map((tool) => tool.name)).toEqual(READ_NAMES);
        for (const tool of tools) {
            expect(tool.kind).toBe('read');
            expect(typeof tool.run).toBe('function');
            expect(tool.plan).toBeUndefined();
        }
    });

    it('gives every tool a valid strict schema and an English description', () => {
        for (const tool of tools) expect(schemaProblems(tool), tool.name).toEqual([]);
    });

    it('keeps names unique together with the write tools', () => {
        const all = builtinTools(fake.app, fake.log);
        const names = all.map((tool) => tool.name);
        expect(new Set(names).size).toBe(names.length);
        expect(names).toEqual(expect.arrayContaining(READ_NAMES));
        expect(all.filter((tool) => tool.kind === 'write').length).toBeGreaterThan(0);
    });

    it('offers module tools only when their module API is there', () => {
        for (const [name, keys] of Object.entries(GATES)) {
            const tool = toolNamed(tools, name);
            const off = fakeApp();
            expect(tool.available?.(off.app), `${name} off`).toBe(false);
            const on = fakeApp({ apis: Object.fromEntries(keys.map((key) => [key, {}])) });
            expect(tool.available?.(on.app), `${name} on`).toBe(true);
        }
    });

    it('offers the chat, card and persona tools only while a chat is open', () => {
        const chatNames = ['chat_read', 'chat_search', 'card_read', 'persona_read', 'scenario_overview'];
        const closed = fakeApp({ chatId: null });
        for (const name of chatNames) {
            expect(toolNamed(tools, name).available?.(closed.app), `${name} closed`).toBe(false);
            expect(toolNamed(tools, name).available?.(fake.app), `${name} open`).toBe(true);
        }
    });

    it('offers lore reading through ST when the Lore Studio is off', () => {
        const st = fakeApp({ ctx: { loadWorldInfo: async () => null } });
        expect(toolNamed(tools, 'lore_entry').available?.(st.app)).toBe(true);
    });

    it('offers the always-available tools without any module', () => {
        const always = tools.filter((tool) => !tool.available).map((tool) => tool.name);
        expect(always).toEqual([
            'maestro_modules',
            'maestro_settings',
            'maestro_health',
            'journal_recent',
            'inbox_list',
            'docs_search',
            'docs_read',
            'cost_summary',
            'regex_list',
            'regex_explain',
            'regex_test',
        ]);
    });

    it('answers every tool on an app with nothing on (no throw, a summary chip in both languages)', async () => {
        const empty = fakeApp();
        const all = readTools(empty.app);
        for (const locale of ['en', 'ru'] as const) {
            const ctx = toolContext(empty, { locale });
            for (const tool of all) {
                const output = await tool.run!({ name: 'Anna', query: 'x', sample: 'x', topic: 'x' }, ctx);
                expect(output.data, tool.name).toBeDefined();
                expect(typeof output.summary, tool.name).toBe('string');
                expect(JSON.stringify(output.data).length, tool.name).toBeLessThan(20000);
            }
        }
    });

    it('survives arguments of the wrong types', async () => {
        const ctx = toolContext(fake);
        for (const tool of tools) {
            await expect(
                tool.run!({ limit: 'many', name: 42, query: null, sample: {}, message_index: 'x' } as never, ctx),
                tool.name,
            ).resolves.toBeDefined();
            await expect(tool.run!(undefined as never, ctx), tool.name).resolves.toBeDefined();
        }
    });
});
