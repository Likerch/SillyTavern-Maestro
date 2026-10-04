// @vitest-environment happy-dom
// Conditional preset blocks (M34 п.8), the feature logic: the flag catalogue read defensively from the director's
// API, the macro engine state, the rows and the simulator, analysis findings and «Подготовить к отключению».
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
    FALLBACK_FLAGS,
    conditionalFindings,
    conditionalRows,
    directorCatalogue,
    directorCurrentFlags,
    directorFlagsOn,
    flagCatalogue,
    flagHint,
    flagLabel,
    knownFlags,
    macroEngineState,
    maestroConditionalBlocks,
    prepareConditionalsForDisable,
    presetFlags,
    simulate,
} from '../../../src/features/presetStudio/conditional';
import type { PresetBody } from '../../../src/features/presetStudio/store-api';
import { createStand, presetBody, prompt } from './ui-stand';
import type { Stand } from './ui-stand';

let s: Stand;

/** Marinara with conditional blocks: whole, negated with else, mixed, malformed, in-chat, off, outside the order. */
function conditionalPreset(): PresetBody {
    return presetBody({
        prompts: [
            prompt('main', { name: 'Main Prompt', system_prompt: true, content: 'Write {{char}}.' }),
            prompt('chatHistory', { name: 'Chat History', system_prompt: true, marker: true, content: undefined }),
            prompt('combat', { name: 'Combat', content: '{{if .maestro_scene_combat}}Short sentences.{{/if}}' }),
            prompt('calm', {
                name: 'Calm',
                content: '{{if !.maestro_scene_combat}}\nTake your time.\n{{else}}\nHurry.\n{{/if}}',
            }),
            prompt('mixed', { name: 'Mixed', content: 'Style: {{if .maestro_explicit}}frank{{else}}tasteful{{/if}}.' }),
            prompt('broken', { name: 'Broken', content: '{{if .maestro_explicit}}Explicit' }),
            prompt('depth', {
                name: 'Depth note',
                injection_position: 1,
                injection_depth: 2,
                content: '\n{{if .maestro_scene_drama}}Raise the stakes.{{/if}}',
            }),
            prompt('own', { name: 'Own var', content: '{{if .mood}}Moody{{/if}}' }),
            prompt('off', { name: 'Off block', content: '{{if .maestro_lang_ru}}Пиши по-русски.{{/if}}' }),
            prompt('loose', { name: 'Loose', content: '{{if .maestro_rain}}Rain.{{/if}}' }),
            prompt('plain', { name: 'Plain', content: 'No conditions.' }),
        ],
        prompt_order: [
            {
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'combat', enabled: true },
                    { identifier: 'calm', enabled: true },
                    { identifier: 'mixed', enabled: true },
                    { identifier: 'broken', enabled: true },
                    { identifier: 'depth', enabled: true },
                    { identifier: 'own', enabled: true },
                    { identifier: 'off', enabled: false },
                    { identifier: 'plain', enabled: true },
                    { identifier: 'chatHistory', enabled: true },
                ],
            },
        ],
    });
}

function engine(value: boolean | undefined): void {
    Object.assign(s.lore.ctx, { powerUserSettings: value === undefined ? {} : { experimental_macro_engine: value } });
}

beforeEach(() => {
    s = createStand({ presets: { Marinara: conditionalPreset(), Other: presetBody() } });
    s.expose();
    engine(true);
});

describe('flag catalogue', () => {
    it('falls back to the scene, explicit and language flags without the director', () => {
        expect(directorCatalogue(s.app)).toEqual([]);
        expect(directorCurrentFlags(s.app)).toBeNull();
        expect(directorFlagsOn(s.app)).toEqual([]);
        const names = flagCatalogue(s.app).map((entry) => entry.name);
        expect(names).toContain('maestro_scene_combat');
        expect(names).toContain('maestro_explicit');
        expect(names).toContain('maestro_lang_ru');
        expect(names).toHaveLength(FALLBACK_FLAGS.length);
        expect(flagLabel(s.app, FALLBACK_FLAGS[1]!)).toBe('Scene: combat and danger');
    });

    it('reads the director’s catalogue in any of the shapes it may expose', () => {
        s.app.modules.expose('director', {
            catalogue: () => [{ name: 'maestro_scene_combat', titleKey: 'm13.flag.combat', descriptionKey: 'x.hint' }],
        });
        expect(directorCatalogue(s.app)).toEqual([
            { name: 'maestro_scene_combat', titleKey: 'm13.flag.combat', descriptionKey: 'x.hint', source: 'director' },
        ]);
        // The director's entry wins; an unknown title key shows the name.
        const combat = flagCatalogue(s.app).find((entry) => entry.name === 'maestro_scene_combat')!;
        expect(combat.source).toBe('director');
        expect(flagLabel(s.app, combat)).toBe('maestro_scene_combat');
        expect(flagHint(s.app, combat)).toBeUndefined();
        s.app.i18n.register({ en: { 'x.hint': 'Fights' }, ru: { 'x.hint': 'Бои' } });
        expect(flagHint(s.app, combat)).toBe('Fights');
        expect(flagHint(s.app, { name: 'a', source: 'custom' })).toBeUndefined();
        expect(flagLabel(s.app, { name: 'a', source: 'custom' })).toBe('a');

        s.app.modules.expose('director', { DIRECTOR_FLAGS: [{ name: 'maestro_mech_x', titleKey: 'k' }] });
        expect(directorCatalogue(s.app).map((entry) => entry.name)).toEqual(['maestro_mech_x']);
        s.app.modules.expose('director', { flags: () => [{ name: 'maestro_y' }] });
        expect(directorCatalogue(s.app).map((entry) => entry.name)).toEqual(['maestro_y']);
        s.app.modules.expose('director', {
            catalogue: () => {
                throw new Error('not ready');
            },
            flags: () => ({ maestro_scene_combat: '1', maestro_explicit: '0', maestro_lang_ru: 'true' }),
        });
        expect(directorCatalogue(s.app)).toEqual([]);
        expect(directorCurrentFlags(s.app)).toEqual({
            maestro_scene_combat: '1',
            maestro_explicit: '0',
            maestro_lang_ru: 'true',
        });
        expect(directorFlagsOn(s.app)).toEqual(['maestro_scene_combat', 'maestro_lang_ru']);
        s.app.modules.expose('director', 'nonsense');
        expect(directorCatalogue(s.app)).toEqual([]);
        expect(directorCurrentFlags(s.app)).toBeNull();
    });

    it('adds the flags the preset uses', () => {
        const names = presetFlags(s.store.working()).map((entry) => entry.name);
        expect(names).toEqual([
            'maestro_scene_combat',
            'maestro_explicit',
            'maestro_scene_drama',
            'mood',
            'maestro_lang_ru',
            'maestro_rain',
        ]);
        const catalogue = flagCatalogue(s.app, s.store.working());
        expect(catalogue.find((entry) => entry.name === 'maestro_rain')?.source).toBe('preset');
        expect(catalogue.find((entry) => entry.name === 'maestro_explicit')?.source).toBe('builtin');
        // The preset's own variables are offered to the simulator but never owned by Maestro.
        expect(catalogue.some((entry) => entry.name === 'mood')).toBe(true);
        expect(knownFlags(s.app)).not.toContain('mood');
        expect(knownFlags(s.app)).not.toContain('maestro_rain');
    });
});

describe('macro engine', () => {
    it('reads power_user.experimental_macro_engine', () => {
        expect(macroEngineState(s.app)).toBe('on');
        engine(false);
        expect(macroEngineState(s.app)).toBe('off');
        engine(undefined);
        expect(macroEngineState(s.app)).toBe('unknown');
        Object.defineProperty(s.lore.ctx, 'powerUserSettings', {
            get() {
                throw new Error('no settings');
            },
            configurable: true,
        });
        expect(macroEngineState(s.app)).toBe('unknown');
    });
});

describe('rows and the simulator', () => {
    const known = () => knownFlags(s.app);

    it('lists the conditional blocks in order, then those outside the list', () => {
        const rows = conditionalRows(s.store, known(), 'on');
        expect(rows.map((row) => row.identifier)).toEqual([
            'combat',
            'calm',
            'mixed',
            'broken',
            'depth',
            'own',
            'off',
            'loose',
        ]);
        const byId = new Map(rows.map((row) => [row.identifier, row]));
        expect(byId.get('combat')!.condition).toMatchObject({ flag: 'maestro_scene_combat', negate: false });
        expect(byId.get('calm')!.condition).toMatchObject({
            negate: true,
            body: 'Take your time.',
            elseText: 'Hurry.',
        });
        expect(byId.get('mixed')!.condition).toBeNull();
        expect(byId.get('broken')!.issues.map((issue) => issue.code)).toEqual(['unclosed']);
        expect(byId.get('depth')!.inChat).toBe(true);
        expect(byId.get('depth')!.issues.map((issue) => issue.code)).toEqual(['outsideWhitespace']);
        expect(byId.get('own')!.issues.map((issue) => issue.code)).toEqual(['unknownFlag']);
        expect(byId.get('off')!.enabled).toBe(false);
        expect(byId.get('loose')!.listed).toBe(false);
        expect(conditionalRows(s.store, known(), 'off')[0]!.issues.map((issue) => issue.code)).toEqual([
            'macroEngineOff',
        ]);
    });

    it('shows what each block sends for the ticked flags', () => {
        const rows = conditionalRows(s.store, known(), 'on');
        const run = (on: string[], engineState: 'on' | 'off' = 'on') =>
            Object.fromEntries(
                rows.map((row) => {
                    const result = simulate(row, new Set(on), engineState);
                    return [row.identifier, `${result.status}:${result.text}`];
                }),
            );
        expect(run([])).toMatchObject({
            combat: 'empty:',
            calm: 'sent:Take your time.',
            mixed: 'sent:Style: tasteful.',
            broken: 'sent:{{if .maestro_explicit}}Explicit',
            depth: 'whitespace:\n',
            off: 'off:',
            loose: 'off:',
        });
        expect(run(['maestro_scene_combat', 'maestro_explicit', 'maestro_scene_drama'])).toMatchObject({
            combat: 'sent:Short sentences.',
            calm: 'sent:Hurry.',
            mixed: 'sent:Style: frank.',
            depth: 'sent:\nRaise the stakes.',
        });
        expect(run([], 'off')).toMatchObject({
            combat: 'literal:{{if .maestro_scene_combat}}Short sentences.{{/if}}',
            off: 'off:{{if .maestro_lang_ru}}Пиши по-русски.{{/if}}',
        });
    });

    it('gives «Анализ» the findings it does not have itself', () => {
        const findings = conditionalFindings(s.app, conditionalRows(s.store, known(), 'off'));
        expect(findings.map((finding) => [finding.identifier, finding.severity])).toEqual([
            ['broken', 'warn'],
            ['depth', 'warn'],
            ['own', 'warn'],
        ]);
        expect(findings[0]!.label).toBe('Conditional block');
        expect(findings[0]!.text).toContain('“Broken”: {{if}} has no {{/if}}');
        expect(findings[1]!.text).toContain('outside {{if}}…{{/if}}');
        expect(findings[2]!.text).toContain('.mood');
    });
});

describe('«Подготовить к отключению»', () => {
    it('keeps the if-branch text as plain text and saves the preset when it is safe', async () => {
        const report = await prepareConditionalsForDisable(s.app, 'keepText');
        expect(report).toEqual({
            mode: 'keepText',
            preset: 'Marinara',
            rewritten: ['Combat', 'Calm', 'Mixed', 'Depth note', 'Off block', 'Loose'],
            disabled: [],
            skipped: ['Broken'],
            saved: true,
            unsaved: false,
        });
        const text = (id: string) => s.store.working().prompts!.find((item) => item.identifier === id)!.content;
        expect(text('combat')).toBe('Short sentences.');
        expect(text('calm')).toBe('Take your time.');
        expect(text('mixed')).toBe('Style: frank.');
        expect(text('depth')).toBe('\nRaise the stakes.');
        expect(text('own')).toBe('{{if .mood}}Moody{{/if}}');
        expect(text('broken')).toBe('{{if .maestro_explicit}}Explicit');
        expect(s.store.called('save')).toEqual([
            ['Marinara', 'Preparing to turn Maestro off: conditional blocks kept as plain text'],
        ]);
        expect(s.layer.recorded).toEqual([]);
    });

    it('switches whole conditionals off and cuts Maestro parts out of mixed blocks', async () => {
        const report = await prepareConditionalsForDisable(s.app, 'disable');
        expect(report.disabled).toEqual(['Combat', 'Calm', 'Depth note']);
        expect(report.rewritten).toEqual(['Mixed']);
        expect(report.skipped).toEqual(['Broken']);
        const order = new Map(s.store.prompts().map((row) => [row.item.identifier, row.item.enabled]));
        expect(order.get('combat')).toBe(false);
        expect(order.get('calm')).toBe(false);
        expect(order.get('depth')).toBe(false);
        expect(order.get('own')).toBe(true);
        expect(s.store.working().prompts!.find((item) => item.identifier === 'mixed')!.content).toBe(
            'Style: tasteful.',
        );
        expect(s.store.called('setEnabled')).toEqual([[['combat', 'calm', 'depth'], false]]);
        expect(report.saved).toBe(true);
    });

    it('leaves saving to the layer step or to the user', async () => {
        s.layer.layers.set('Marinara', [{ op: 'toggle', identifier: 'main', enabled: true }]);
        const layered = await prepareConditionalsForDisable(s.app, 'keepText');
        expect(layered.saved).toBe(false);
        expect(layered.unsaved).toBe(true);
        expect(s.store.called('save')).toEqual([]);

        s = createStand({ presets: { Marinara: conditionalPreset() } });
        s.expose();
        await s.store.updatePrompt('plain', { content: 'Edited elsewhere' });
        const dirty = await prepareConditionalsForDisable(s.app, 'disable');
        expect(dirty.saved).toBe(false);
        expect(dirty.unsaved).toBe(true);

        s = createStand({ presets: { Marinara: conditionalPreset() } });
        s.expose();
        const asked = await prepareConditionalsForDisable(s.app, 'keepText', { save: 'never' });
        expect(asked.saved).toBe(false);
        expect(asked.unsaved).toBe(true);

        // After the layer step «reselectBase» the base file takes the edits when asked to.
        s = createStand({ presets: { Marinara: conditionalPreset() } });
        s.expose();
        s.layer.layers.set('Marinara', [{ op: 'toggle', identifier: 'main', enabled: true }]);
        const forced = await prepareConditionalsForDisable(s.app, 'disable', { save: 'always' });
        expect(forced.saved).toBe(true);
        expect(s.store.called('save')).toHaveLength(1);
    });

    it('waits for the store to settle first (after a reselect)', async () => {
        const idle = vi.fn(async () => {});
        Object.assign(s.store, { whenIdle: idle });
        await prepareConditionalsForDisable(s.app, 'keepText', { save: 'never' });
        expect(idle).toHaveBeenCalledTimes(1);
    });

    it('names the blocks it would touch', () => {
        expect(maestroConditionalBlocks(s.app)).toEqual([
            'Combat',
            'Calm',
            'Mixed',
            'Broken',
            'Depth note',
            'Off block',
            'Loose',
        ]);
        expect(maestroConditionalBlocks(createStand().app)).toEqual([]);
    });

    it('does nothing without the store or without conditional blocks', async () => {
        s = createStand({
            presets: { Plain: presetBody({ prompts: [prompt('a', { content: 'A' })] }) },
            current: 'Plain',
        });
        s.expose();
        const none = await prepareConditionalsForDisable(s.app, 'keepText');
        expect(none).toMatchObject({ preset: 'Plain', rewritten: [], disabled: [], saved: false, unsaved: false });
        s = createStand();
        expect(await prepareConditionalsForDisable(s.app, 'disable')).toMatchObject({ preset: null });
    });
});
