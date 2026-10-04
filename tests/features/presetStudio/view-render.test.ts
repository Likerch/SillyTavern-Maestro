// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { presetDiff } from '../../../src/domain/preset-ui-diff';
import { renderBlockEditor } from '../../../src/features/presetStudio/view-editor';
import { describeOp } from '../../../src/features/presetStudio/view-layer';
import { renderMapPanel } from '../../../src/features/presetStudio/view-map';
import { renderVersionsPanel, renderDiff } from '../../../src/features/presetStudio/view-versions';
import { presetStudioTab } from '../../../src/features/presetStudio/view-tab';
import { defaultPresetStudioSettings } from '../../../src/features/presetStudio/studio';
import { click, createStand, presetBody, prompt, q, qa, wait } from './ui-stand';
import type { Stand } from './ui-stand';

let s: Stand;

beforeEach(() => {
    s = createStand();
});

describe('block editor', () => {
    it('shows depth and order only for in-chat blocks and resets a system block in the form only', async () => {
        const save = vi.fn(async () => true);
        const handle = renderBlockEditor(
            s.app,
            {
                prompt: prompt('main', {
                    name: 'Main',
                    content: 'Custom main',
                    system_prompt: true,
                    forbid_overrides: true,
                }),
                isNew: false,
                layerMode: true,
                sourceKey: null,
            },
            { save, close: vi.fn(), countTokens: async (text) => text.length },
        );
        document.body.append(handle.element);
        const depth = q('.maestro-m34-depth')!;
        expect(depth.hidden).toBe(true);
        const position = q<HTMLSelectElement>('.maestro-m34-f-position')!;
        position.value = '1';
        position.dispatchEvent(new Event('change'));
        expect(depth.hidden).toBe(false);
        expect(q('.maestro-m34-f-forbid')).not.toBeNull();
        expect(handle.element.textContent).toContain('into your layer');
        click(q('.maestro-m34-editor-reset'));
        expect(q<HTMLTextAreaElement>('.maestro-m34-f-content')?.value).toBe(
            "Write {{char}}'s next reply in a fictional chat between {{charIfNotGroup}} and {{user}}.",
        );
        expect(q<HTMLInputElement>('.maestro-m34-f-forbid')?.checked).toBe(false);
        expect(handle.dirty()).toBe(true);
        expect(save).not.toHaveBeenCalled();
        handle.element.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true }));
        expect(save).toHaveBeenCalledTimes(1);
        await wait(450);
        expect(q('.maestro-m34-token-count')?.textContent).toContain('tokens');
        handle.markStale();
        expect(q('.maestro-m34-stale')?.hidden).toBe(false);
        handle.dispose();
    });

    it('locks a marker’s text and the whole of chatHistory', () => {
        const external = renderBlockEditor(
            s.app,
            {
                prompt: prompt('scenario', { system_prompt: true, marker: true, content: undefined }),
                isNew: false,
                layerMode: false,
                sourceKey: 'm34.source.scenario',
            },
            { save: vi.fn(), close: vi.fn(), countTokens: async () => null },
        );
        expect(external.element.querySelector<HTMLTextAreaElement>('.maestro-m34-f-content')?.disabled).toBe(true);
        expect(external.element.querySelector<HTMLSelectElement>('.maestro-m34-f-role')?.disabled).toBe(false);
        expect(external.element.textContent).toContain('Source: Character Scenario');
        const history = renderBlockEditor(
            s.app,
            {
                prompt: prompt('chatHistory', { system_prompt: true, marker: true }),
                isNew: false,
                layerMode: false,
                sourceKey: null,
            },
            { save: vi.fn(), close: vi.fn(), countTokens: async () => null },
        );
        expect(history.element.querySelector<HTMLInputElement>('.maestro-m34-f-name')?.disabled).toBe(true);
        expect(history.element.querySelector('.maestro-m34-editor-save')).toBeNull();
        expect(history.dirty()).toBe(false);
    });

    it('lists Maestro flags and side-effect macros of the text', () => {
        const handle = renderBlockEditor(
            s.app,
            {
                prompt: prompt('x', { content: '{{if .maestro_scene_combat}}Fight{{/if}} {{setvar::a::1}}' }),
                isNew: false,
                layerMode: false,
                sourceKey: null,
            },
            { save: vi.fn(), close: vi.fn(), countTokens: async () => null },
        );
        const details = handle.element.querySelector('.maestro-m34-highlight')!;
        expect(details.textContent).toContain('Maestro flags: maestro_scene_combat');
        expect(details.textContent).toContain('setvar');
        expect(details.querySelectorAll('.maestro-m34-hl-variable')).toHaveLength(1);
    });
});

describe('views', () => {
    it('map without the analysis module shows the reduced banner and the loading state', () => {
        const actions = { open: vi.fn(), refresh: vi.fn(async () => {}), setType: vi.fn() };
        const loading = renderMapPanel(s.app, { slots: null, reduced: true, error: 'boom', type: 'normal' }, actions);
        expect(loading.textContent).toContain('Building the map');
        expect(loading.textContent).toContain('boom');
        expect(loading.querySelector<HTMLSelectElement>('.maestro-m34-map-type')?.disabled).toBe(true);
        const empty = renderMapPanel(s.app, { slots: [], reduced: false, error: null, type: 'normal' }, actions);
        expect(empty.textContent).toContain('Nothing to show');
    });

    it('a diff masks secrets and lists order changes', () => {
        const before = presetBody({ reverse_proxy: 'http://proxy-one' });
        const after = presetBody({ reverse_proxy: 'http://proxy-two', temperature: 0.5 });
        after.prompt_order![0]!.order.reverse();
        after.prompt_order![0]!.order[0]!.enabled = false;
        const node = renderDiff(s.app, presetDiff(before, after), new Map([['main', 'Main Prompt']]));
        expect(node.textContent).toContain('changed (secret value hidden)');
        expect(node.textContent).not.toContain('proxy-');
        expect(node.textContent).toContain('Moved:');
        expect(node.textContent).toContain('temperature');
        expect(renderDiff(s.app, presetDiff(before, before), new Map()).textContent).toBe('No differences.');
    });

    it('versions list loading, error and empty states', () => {
        const actions = { select: vi.fn(), restore: vi.fn(async () => {}), refresh: vi.fn(async () => {}) };
        const base = { name: 'Marinara', selected: null, working: presetBody(), error: null };
        expect(renderVersionsPanel(s.app, { ...base, versions: null }, new Map(), actions).textContent).toContain(
            'Reading',
        );
        expect(
            renderVersionsPanel(s.app, { ...base, versions: [], error: 'x' }, new Map(), actions).textContent,
        ).toContain('could not be read: x');
        const list = renderVersionsPanel(
            s.app,
            {
                ...base,
                versions: [
                    { id: 'a', at: 1, by: 'st', summary: 'Outside', body: presetBody() },
                    { id: 'b', at: 2, by: 'weird', summary: 'Other', body: presetBody({ temperature: 2 }) },
                ],
            },
            new Map(),
            actions,
        );
        expect(qa('.maestro-m34-version', list).map((node) => node.dataset.id)).toEqual(['b', 'a']);
        expect(list.textContent).toContain('outside Maestro');
        expect(list.textContent).toContain('same as now');
        click(qa('.maestro-m34-version-pick', list)[0]);
        expect(actions.select).toHaveBeenCalledWith('b');
    });

    it('describes every layer operation', () => {
        const names = new Map([['main', 'Main Prompt']]);
        const lines = [
            describeOp(
                s.app,
                {
                    op: 'add',
                    prompt: prompt('mine', { name: 'Mine' }),
                    anchor: { kind: 'afterText', text: '</task>' },
                    enabled: true,
                },
                names,
            ),
            describeOp(
                s.app,
                {
                    op: 'add',
                    prompt: prompt('mine', { name: 'Mine' }),
                    anchor: { kind: 'before', identifier: 'main' },
                    enabled: true,
                },
                names,
            ),
            describeOp(
                s.app,
                { op: 'add', prompt: prompt('mine', { name: 'Mine' }), anchor: { kind: 'end' }, enabled: true },
                names,
            ),
            describeOp(
                s.app,
                { op: 'edit', identifier: 'main', patch: { content: 'x', role: 'user' }, baseHash: 'h' },
                names,
            ),
            describeOp(s.app, { op: 'toggle', identifier: 'main', enabled: false }, names),
            describeOp(s.app, { op: 'move', identifier: 'main', anchor: { kind: 'start' } }, names),
            describeOp(s.app, { op: 'key', key: 'temperature', value: 0.7 }, names),
            describeOp(s.app, { op: 'key', key: 'proxy_password', value: 'hunter2' }, names),
        ];
        expect(lines).toEqual([
            'Your block «Mine» after the text «</task>»',
            'Your block «Mine» before «Main Prompt»',
            'Your block «Mine» at the end',
            'Edit of «Main Prompt»: content, role',
            '«Main Prompt» off',
            '«Main Prompt» moved at the start',
            'temperature = 0.7',
            'proxy_password = ••••••',
        ]);
    });

    it('pult tab warns about Text Completion and a missing data layer', () => {
        s.app.host.isChatCompletion = () => false;
        const tab = presetStudioTab(s.app, {
            settings: defaultPresetStudioSettings(),
            open: vi.fn(),
            showClassic: vi.fn(),
            setReplace: () => false,
            replaceActive: () => false,
            setEditsToLayer: vi.fn(),
            summary: () => null,
        });
        const container = document.createElement('div');
        tab.render(container);
        expect(container.textContent).toContain('Text Completion is active');
        expect(container.textContent).toContain('data layer is not running');
        expect(container.querySelector<HTMLButtonElement>('.maestro-m34-tab-open')?.disabled).toBe(true);
    });
});
