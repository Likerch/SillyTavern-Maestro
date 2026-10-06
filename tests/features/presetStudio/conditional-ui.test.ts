// @vitest-environment happy-dom
// Conditional preset blocks (M34 п.8) in the studio window: the editor's «Условие» control (wrapping is a normal
// edit recorded into the layer), the «Условия» tab with its flag simulator and the macro-engine banner, the findings
// in «Анализ», and the strings of both files.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FALLBACK_FLAGS } from '../../../src/features/presetStudio/conditional';
import { PmInfo } from '../../../src/features/presetStudio/launcher';
import { PRESET_STUDIO_STRINGS } from '../../../src/features/presetStudio/module';
import { PresetStudio, presetStudioWindow, servicesOf } from '../../../src/features/presetStudio/studio';
import type { PresetBody } from '../../../src/features/presetStudio/store-api';
import { click, createStand, presetBody, prompt, q, qa, wait } from './ui-stand';
import type { Stand } from './ui-stand';

let s: Stand;
let studio: PresetStudio;

function preset(): PresetBody {
    return presetBody({
        prompts: [
            prompt('main', { name: 'Main Prompt', system_prompt: true, content: 'Write {{char}}.' }),
            prompt('chatHistory', { name: 'Chat History', system_prompt: true, marker: true, content: undefined }),
            prompt('rules', { name: 'Rules', content: 'Line one.\nLine two.' }),
            prompt('combat', {
                name: 'Combat',
                content: '{{if .maestro_scene_combat}}Short sentences.{{else}}Long prose.{{/if}}',
            }),
            prompt('broken', { name: 'Broken', content: 'A{{else}}B' }),
            prompt('depth', {
                name: 'Depth note',
                injection_position: 1,
                injection_depth: 2,
                content: '\n{{if .maestro_scene_drama}}Raise the stakes.{{/if}}',
            }),
        ],
        prompt_order: [
            {
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'rules', enabled: true },
                    { identifier: 'combat', enabled: true },
                    { identifier: 'broken', enabled: true },
                    { identifier: 'depth', enabled: true },
                    { identifier: 'chatHistory', enabled: true },
                ],
            },
        ],
    });
}

const change = (node: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement | null, value: string) => {
    (node as HTMLInputElement).value = value;
    node?.dispatchEvent(new Event('change', { bubbles: true }));
};
const tab = async (id: string) => {
    click(qa('.maestro-tab').find((node) => node.dataset.tab === id));
    await wait();
};
const content = () => q<HTMLTextAreaElement>('.maestro-m34-f-content')!;
const condRow = (id: string) => qa('.maestro-m34-cond-row').find((node) => node.dataset.id === id) as HTMLElement;
const status = (id: string) => condRow(id)?.dataset.status;

function engine(value: boolean | undefined): void {
    Object.assign(s.lore.ctx, { powerUserSettings: value === undefined ? {} : { experimental_macro_engine: value } });
}

async function openEditor(identifier: string): Promise<void> {
    studio.open(identifier);
    await wait();
}

beforeEach(() => {
    s = createStand({ presets: { Marinara: preset() } });
    s.expose();
    engine(true);
    s.lore.openai.promptManager = {
        tokenUsage: 0,
        error: null,
        overriddenPrompts: [],
        tokenHandler: { getCounts: () => ({}) },
    };
    studio = new PresetStudio({
        app: s.app,
        log: s.app.log,
        services: servicesOf(s.app),
        settings: s.settings,
        saveSettings: vi.fn(),
        pm: new PmInfo(s.app, s.app.log),
        showClassic: () => {},
    });
    s.app.ui.addWindow!(presetStudioWindow(studio));
});

afterEach(() => {
    studio.close();
});

describe('the «Условие» control of the block editor', () => {
    it('wraps a block; saving records the edit in the layer and updates the text', async () => {
        s.layer.layers.set('Marinara', [{ op: 'toggle', identifier: 'main', enabled: true }]);
        await openEditor('rules');
        const control = q('.maestro-m34-cond-control')!;
        expect(control).not.toBeNull();
        expect(q<HTMLSelectElement>('.maestro-m34-cond-mode')!.value).toBe('always');
        expect(q('.maestro-m34-cond-flag-row')!.hidden).toBe(true);
        expect(q('.maestro-m34-cond-state')!.textContent).toBe('The block is always sent.');
        // The editor offers the catalogue: the scene flags with their titles.
        const options = qa<HTMLOptionElement>('.maestro-m34-cond-pick option').map((option) => option.value);
        expect(options).toEqual([...FALLBACK_FLAGS.map((flag) => flag.name), '__custom']);

        change(q('.maestro-m34-cond-mode'), 'when');
        expect(q('.maestro-m34-cond-flag-row')!.hidden).toBe(false);
        change(q('.maestro-m34-cond-pick'), 'maestro_scene_combat');
        change(q('.maestro-m34-cond-else'), 'Calm pace.');
        click(q('.maestro-m34-cond-apply'));
        expect(content().value).toBe(
            '{{if .maestro_scene_combat}}\nLine one.\nLine two.\n{{else}}\nCalm pace.\n{{/if}}',
        );
        expect(q('.maestro-m34-cond-state')!.textContent).toBe(
            'Now: only when «Scene: combat and danger» (maestro_scene_combat).',
        );
        // Nothing written until «Сохранить».
        expect(s.layer.recorded).toEqual([]);
        click(q('.maestro-m34-editor-save'));
        await wait();
        const edit = s.layer.recorded.find((entry) => entry.op.op === 'edit');
        expect(edit?.op).toMatchObject({
            op: 'edit',
            identifier: 'rules',
            patch: { content: '{{if .maestro_scene_combat}}\nLine one.\nLine two.\n{{else}}\nCalm pace.\n{{/if}}' },
            baseText: 'Line one.\nLine two.',
        });
        expect(s.store.working().prompts!.find((item) => item.identifier === 'rules')!.content).toContain(
            '{{if .maestro_scene_combat}}',
        );
    });

    it('reads a wrapped block, re-wraps it negated and unwraps it back', async () => {
        await openEditor('combat');
        expect(q<HTMLSelectElement>('.maestro-m34-cond-mode')!.value).toBe('when');
        expect(q<HTMLSelectElement>('.maestro-m34-cond-pick')!.value).toBe('maestro_scene_combat');
        expect(q<HTMLTextAreaElement>('.maestro-m34-cond-else')!.value).toBe('Long prose.');
        change(q('.maestro-m34-cond-mode'), 'unless');
        click(q('.maestro-m34-cond-apply'));
        expect(content().value).toBe('{{if !.maestro_scene_combat}}Short sentences.{{else}}Long prose.{{/if}}');
        expect(q('.maestro-m34-cond-state')!.textContent).toContain('Now: except when');
        change(q('.maestro-m34-cond-mode'), 'always');
        click(q('.maestro-m34-cond-apply'));
        expect(content().value).toBe('Short sentences.');
        expect(q<HTMLSelectElement>('.maestro-m34-cond-mode')!.value).toBe('always');
        // Applying the same thing again changes nothing.
        click(q('.maestro-m34-cond-apply'));
        expect(content().value).toBe('Short sentences.');
    });

    it('takes a free maestro_ name and refuses bad names and stray tags', async () => {
        await openEditor('rules');
        change(q('.maestro-m34-cond-mode'), 'when');
        change(q('.maestro-m34-cond-pick'), '__custom');
        expect(q('.maestro-m34-cond-custom-row')!.hidden).toBe(false);
        change(q('.maestro-m34-cond-custom'), 'two words');
        click(q('.maestro-m34-cond-apply'));
        expect(q('.maestro-m34-cond-error')!.hidden).toBe(false);
        expect(q('.maestro-m34-cond-error')!.textContent).toContain('Choose a flag');
        expect(content().value).toBe('Line one.\nLine two.');
        change(q('.maestro-m34-cond-custom'), 'weather_rain');
        click(q('.maestro-m34-cond-apply'));
        expect(content().value).toBe('{{if .maestro_weather_rain}}\nLine one.\nLine two.\n{{/if}}');
        // The new name joins the picker as the current flag.
        expect(q<HTMLSelectElement>('.maestro-m34-cond-pick')!.value).toBe('maestro_weather_rain');

        studio.closeEditor();
        await openEditor('broken');
        expect(q('.maestro-m34-cond-state')!.textContent).toContain('broken {{if}} tags');
        change(q('.maestro-m34-cond-mode'), 'when');
        click(q('.maestro-m34-cond-apply'));
        expect(q('.maestro-m34-cond-error')!.textContent).toContain('{{else}} outside a condition');
        expect(content().value).toBe('A{{else}}B');
    });

    it('follows the text typed into the form and warns about the macro engine', async () => {
        engine(false);
        await openEditor('rules');
        expect(q('.maestro-m34-cond-control .maestro-m34-cond-engine')).not.toBeNull();
        content().value = '{{if !.maestro_explicit}}Tasteful.{{/if}}';
        content().dispatchEvent(new Event('input', { bubbles: true }));
        expect(q<HTMLSelectElement>('.maestro-m34-cond-mode')!.value).toBe('unless');
        content().value = 'Intro {{if .maestro_explicit}}x{{/if}}';
        content().dispatchEvent(new Event('input', { bubbles: true }));
        expect(q('.maestro-m34-cond-state')!.textContent).toContain('conditions inside');
    });

    it('keeps an unapplied choice while the text is typed without changing its condition', async () => {
        await openEditor('rules');
        change(q('.maestro-m34-cond-mode'), 'unless');
        change(q('.maestro-m34-cond-pick'), 'maestro_explicit');
        content().value = 'Line one.\nLine two.\nLine three.';
        content().dispatchEvent(new Event('input', { bubbles: true }));
        expect(q<HTMLSelectElement>('.maestro-m34-cond-mode')!.value).toBe('unless');
        click(q('.maestro-m34-cond-apply'));
        expect(content().value).toBe('{{if !.maestro_explicit}}\nLine one.\nLine two.\nLine three.\n{{/if}}');
        expect(studio.editorOpen()).toBe('rules');
    });

    it('is not offered for markers', async () => {
        await openEditor('chatHistory');
        expect(q('.maestro-m34-cond-control')).toBeNull();
    });
});

describe('the «Условия» tab', () => {
    it('lists conditional blocks and simulates flags', async () => {
        studio.open();
        await wait();
        await tab('conditional');
        expect(qa('.maestro-m34-cond-row').map((node) => node.dataset.id)).toEqual(['combat', 'broken', 'depth']);
        expect(q('.maestro-m34-cond-engine')).toBeNull();
        expect(status('combat')).toBe('sent');
        expect(condRow('combat').textContent).toContain('Only when Scene: combat and danger. Otherwise its own text.');
        expect(condRow('combat').querySelector('.maestro-m34-cond-text')?.textContent).toBe('Long prose.');
        expect(status('depth')).toBe('whitespace');
        expect(condRow('depth').textContent).toContain('outside {{if}}…{{/if}}');
        expect(condRow('broken').textContent).toContain('{{else}} outside a condition');
        expect(q('.maestro-m34-cond-summary')!.textContent).toBe('Conditional blocks: 3. Sent with these flags: 2');
        expect(q('.maestro-m34-cond-current')).toBeNull();

        const box = (name: string) =>
            qa<HTMLInputElement>('.maestro-m34-cond-check').find((node) => node.dataset.flag === name)!;
        box('maestro_scene_combat').checked = true;
        box('maestro_scene_combat').dispatchEvent(new Event('change'));
        box('maestro_scene_drama').checked = true;
        box('maestro_scene_drama').dispatchEvent(new Event('change'));
        expect(box('maestro_scene_combat').checked).toBe(true);
        expect(condRow('combat').querySelector('.maestro-m34-cond-text')?.textContent).toBe('Short sentences.');
        expect(status('depth')).toBe('sent');
        // The preview stays open across re-renders.
        const details = condRow('combat').querySelector('details')!;
        details.open = true;
        details.dispatchEvent(new Event('toggle'));
        click(q('.maestro-m34-cond-reset'));
        expect(box('maestro_scene_combat').checked).toBe(false);
        expect(status('depth')).toBe('whitespace');
        expect(condRow('combat').querySelector('details')!.open).toBe(true);
        expect(condRow('depth').querySelector('.maestro-m34-cond-text')?.textContent).toBe('↵\n');

        click(condRow('combat').querySelector('.maestro-m34-cond-open'));
        await wait();
        expect(studio.editorOpen()).toBe('combat');
    });

    it('takes the director’s current flags', async () => {
        s.app.modules.expose('director', { flags: () => ({ maestro_scene_drama: '1', maestro_explicit: '0' }) });
        studio.open();
        await wait();
        await tab('conditional');
        click(q('.maestro-m34-cond-current'));
        const on = qa<HTMLInputElement>('.maestro-m34-cond-check')
            .filter((node) => node.checked)
            .map((node) => node.dataset.flag);
        expect(on).toEqual(['maestro_scene_drama']);
        expect(status('depth')).toBe('sent');
    });

    it('shows a prominent banner when the macro engine is off', async () => {
        engine(false);
        studio.open();
        await wait();
        await tab('conditional');
        const banner = q('.maestro-m34-cond-engine')!;
        expect(banner.classList.contains('maestro-level-error')).toBe(true);
        expect(banner.textContent).toContain('new macro engine is off');
        expect(banner.textContent).toContain('Experimental Macro Engine');
        expect(status('combat')).toBe('literal');
        expect(condRow('combat').textContent).toContain('the new macro engine is off');

        engine(undefined);
        await tab('analysis');
        await tab('conditional');
        expect(q('.maestro-m34-cond-engine')!.classList.contains('maestro-level-warn')).toBe(true);
    });

    it('shows an empty state for a preset without conditions', async () => {
        s = createStand({
            presets: { Plain: presetBody({ prompts: [prompt('a', { content: 'A' })] }) },
            current: 'Plain',
        });
        s.expose();
        studio = new PresetStudio({
            app: s.app,
            log: s.app.log,
            services: servicesOf(s.app),
            settings: s.settings,
            saveSettings: vi.fn(),
            pm: new PmInfo(s.app, s.app.log),
            showClassic: () => {},
        });
        s.app.ui.addWindow!(presetStudioWindow(studio));
        studio.open();
        await wait();
        await tab('conditional');
        expect(q('.maestro-m34-conditional .maestro-empty')!.textContent).toContain('no conditional blocks');
    });
});

describe('«Анализ»', () => {
    it('adds the conditional findings next to the analysis module’s', async () => {
        s.analysis.list = [{ kind: 'heavyBlock', severity: 'info', identifier: 'main', text: 'Main is heavy' }];
        studio.open();
        await wait();
        await tab('analysis');
        const findings = qa('.maestro-m34-finding');
        expect(findings.map((node) => node.querySelector('.maestro-m34-finding-kind')?.textContent)).toEqual([
            'Conditional block',
            'Conditional block',
            'Heavy block',
        ]);
        expect(findings[0]!.textContent).toContain('“Broken”: {{else}} outside a condition');
        expect(findings[1]!.textContent).toContain('“Depth note”: spaces or line breaks outside');
        expect(q('.maestro-m34-h')!.textContent).toBe('Findings: 3');
        click(findings[0]!.querySelector('.maestro-m34-finding-open'));
        await wait();
        expect(studio.editorOpen()).toBe('broken');
    });
});

describe('strings', () => {
    it('cover every key of the conditional files in English and Russian', () => {
        const source = join(__dirname, '../../../src/features/presetStudio');
        const used = new Set<string>();
        for (const file of ['conditional.ts', 'view-conditional.ts', 'studio.ts']) {
            const text = readFileSync(join(source, file), 'utf8');
            for (const match of text.matchAll(/'(m34\.cond\.[A-Za-z0-9_.-]+)'/g)) used.add(match[1]!);
        }
        const dynamic = [
            'm34.tab.conditional',
            ...['sent', 'empty', 'whitespace', 'off', 'literal'].map((value) => `m34.cond.status.${value}`),
            ...[
                'unclosed',
                'strayClose',
                'strayElse',
                'extraElse',
                'emptyCondition',
                'outsideWhitespace',
                'whitespaceResult',
                'neverSends',
                'unknownFlag',
                'customFlag',
                'bareFlag',
                'globalFlag',
                'macroEngineOff',
            ].map((code) => `m34.cond.issue.${code}`),
            ...['always', 'when', 'unless'].map((mode) => `m34.cond.mode.${mode}`),
            ...['always', 'mixed', 'malformed', 'when', 'unless'].map((state) => `m34.cond.state.${state}`),
            ...['strayElse', 'strayClose', 'unclosed'].map((code) => `m34.cond.tag.${code}`),
            ...['keepText', 'disable'].map((mode) => `m34.cond.prepare.${mode}`),
            ...FALLBACK_FLAGS.map((flag) => flag.titleKey!),
        ];
        for (const key of [...used, ...dynamic]) {
            expect(PRESET_STUDIO_STRINGS.en[key], key).toBeTruthy();
            expect(PRESET_STUDIO_STRINGS.ru[key], key).toBeTruthy();
        }
        expect(used.size).toBeGreaterThan(30);
    });
});
