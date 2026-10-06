// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LAUNCHER_ID, PmInfo, PmLauncher, REPLACED_CLASS } from '../../../src/features/presetStudio/launcher';
import { createPresetStudioModule, presetStudioRuntime } from '../../../src/features/presetStudio/module';
import { defaultPresetStudioSettings, servicesOf } from '../../../src/features/presetStudio/studio';
import type { PultTab } from '../../../src/shared/contracts';
import { buildPmDom, click, createStand, q, wait } from './ui-stand';
import type { Stand } from './ui-stand';

let s: Stand;
let launcher: PmLauncher;
let opened: number;

const stats = () => q('.maestro-m34-launcher-stats')?.textContent ?? '';

beforeEach(() => {
    s = createStand();
    s.expose();
    s.lore.openai.promptManager = {
        tokenUsage: 1234,
        error: null,
        overriddenPrompts: [],
        tokenHandler: { getCounts: () => ({ main: 10, style: 20 }) },
    };
    opened = 0;
    launcher = new PmLauncher({
        app: s.app,
        log: s.app.log,
        services: servicesOf(s.app),
        pm: new PmInfo(s.app, s.app.log),
        open: () => opened++,
    });
});

afterEach(() => {
    launcher.restore();
    document.body.className = '';
});

describe('launcher in place of Prompt Manager', () => {
    it('goes right before #completion_prompt_manager and hides PM with the body class only', async () => {
        const block = buildPmDom();
        expect(launcher.install()).toBe(true);
        const node = document.getElementById(LAUNCHER_ID)!;
        expect(node.parentElement).toBe(block);
        expect(node.nextElementSibling?.id).toBe('completion_prompt_manager');
        expect(document.body.classList.contains(REPLACED_CLASS)).toBe(true);
        // PM itself is untouched: still there with its content (P-013).
        expect(document.getElementById('completion_prompt_manager')?.textContent).toBe('PM');
        await wait(300);
        expect(q('.maestro-m34-launcher-preset')?.textContent).toBe('Marinara');
        expect(stats()).toContain('Blocks on: 4 of 5');
        expect(stats()).toMatch(/Total tokens: 1\D?234/);
        expect(q<HTMLElement>('.maestro-m34-launcher-unsaved')?.hidden).toBe(true);
        expect(launcher.active()).toBe(true);
        click(q('.maestro-m34-launcher-open'));
        expect(opened).toBe(1);
    });

    it('refreshes the summary on ST events and store changes (debounced)', async () => {
        buildPmDom();
        launcher.install();
        await wait(300);
        await s.store.setEnabled(['extra'], true);
        (s.lore.openai.promptManager as { error: string | null }).error = 'Not enough tokens';
        await s.lore.emit('CHAT_COMPLETION_PROMPT_READY', { chat: [], dryRun: true });
        expect(stats()).toContain('4 of 5');
        await wait(300);
        expect(stats()).toContain('Blocks on: 5 of 5');
        expect(q<HTMLElement>('.maestro-m34-launcher-unsaved')?.hidden).toBe(false);
        expect(q('.maestro-m34-launcher-error')?.textContent).toContain('Not enough tokens');
        await s.store.select('Yablochny');
        await s.lore.emit('OAI_PRESET_CHANGED_AFTER');
        await wait(300);
        expect(q('.maestro-m34-launcher-preset')?.textContent).toBe('Yablochny');
    });

    it('«Классический редактор» shows PM for the session and can hide it again', async () => {
        buildPmDom();
        launcher.install();
        click(q('.maestro-m34-launcher-classic'));
        expect(document.body.classList.contains(REPLACED_CLASS)).toBe(false);
        expect(launcher.classicVisible()).toBe(true);
        expect(q('.maestro-m34-launcher-classic')?.textContent).toBe('Hide the classic editor');
        click(q('.maestro-m34-launcher-classic'));
        expect(document.body.classList.contains(REPLACED_CLASS)).toBe(true);
    });

    it('restores everything and stops listening', async () => {
        buildPmDom();
        launcher.install();
        launcher.restore();
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();
        expect(document.body.classList.contains(REPLACED_CLASS)).toBe(false);
        expect(launcher.active()).toBe(false);
        expect(s.lore.listenerCount('SETTINGS_UPDATED')).toBe(0);
        expect(s.store.listeners.size).toBe(0);
        launcher.restore();
    });

    it('waits for the PM container and never hides PM without the launcher', async () => {
        const block = buildPmDom(false);
        expect(launcher.install()).toBe(false);
        expect(document.body.classList.contains(REPLACED_CLASS)).toBe(false);
        const container = document.createElement('div');
        container.id = 'completion_prompt_manager';
        block.append(container);
        await s.lore.emit('SETTINGS_UPDATED');
        await wait(300);
        expect(document.getElementById(LAUNCHER_ID)?.nextElementSibling).toBe(container);
        expect(document.body.classList.contains(REPLACED_CLASS)).toBe(true);
    });

    it('summarizes ST’s live settings when the store is missing', async () => {
        s.app.modules.expose('presetStore', undefined);
        (s.lore.ctx as { chatCompletionSettings?: unknown }).chatCompletionSettings = {
            preset_settings_openai: 'Live',
            prompts: [{ identifier: 'main' }, { identifier: 'b' }],
            prompt_order: [
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'main', enabled: true },
                        { identifier: 'b', enabled: false },
                    ],
                },
            ],
        };
        expect(launcher.summary()).toMatchObject({ preset: 'Live', enabled: 1, total: 2, dirty: false });
    });
});

describe('module lifecycle', () => {
    async function start(replace: boolean) {
        const module = createPresetStudioModule({
            store: () => s.store,
            // A handle with `api` and install() returning disposers, like layer.ts.
            layer: () => ({ api: s.layer, install: () => [() => void (installed = false)] }),
            analysis: () => s.analysis,
        });
        let installed = true;
        s.app.modules.expose('presetStore', undefined);
        s.app.modules.expose('presetLayer', undefined);
        s.app.modules.expose('presetAnalysis', undefined);
        const settings = { ...defaultPresetStudioSettings(), replacePromptManager: replace };
        const started = await s.lore.start(module, settings);
        return { ...started, installed: () => installed };
    }

    it('exposes the parts and the studio, replaces PM when asked and puts everything back on disable', async () => {
        buildPmDom();
        const run = await start(true);
        expect(s.app.modules.api('presetStore')).toBe(s.store);
        expect(s.app.modules.api('presetLayer')).toBe(s.layer);
        expect(s.app.modules.api('presetAnalysis')).toBe(s.analysis);
        expect(s.app.modules.api('presetStudio')).toBeDefined();
        expect(document.getElementById(LAUNCHER_ID)).not.toBeNull();
        expect(s.lore.styles.get('m34-preset-studio')).toContain('body.maestro-pm-replaced #completion_prompt_manager');
        expect(s.lore.tabs.map((tab) => tab.id)).toContain('presetStudio');
        expect(s.slash.map((command) => command.name)).toEqual(['maestro-preset']);
        await s.slash[0]!.callback({}, 'Style');
        await wait();
        expect(document.querySelector('.maestro-m34-dialog')).not.toBeNull();
        expect(q<HTMLInputElement>('.maestro-m34-f-name')?.value).toBe('Style');
        await run.stop();
        expect(run.installed()).toBe(false);
        expect(presetStudioRuntime()).toBeNull();
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();
        expect(document.body.classList.contains(REPLACED_CLASS)).toBe(false);
        expect(document.querySelector('.maestro-m34-dialog')).toBeNull();
        expect(s.app.modules.api('presetStore')).toBeUndefined();
        expect(s.app.modules.api('presetStudio')).toBeUndefined();
        expect(s.lore.tabs.map((tab) => tab.id)).not.toContain('presetStudio');
        expect(s.slash).toEqual([]);
    });

    it('leaves PM alone by default and toggles the replacement from the pult tab', async () => {
        buildPmDom();
        const run = await start(false);
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();
        const tab = s.lore.tabs.find((item) => item.id === 'presetStudio') as PultTab;
        expect(tab.order).toBe(42);
        const container = document.createElement('div');
        document.body.append(container);
        tab.render(container);
        expect(container.textContent).toContain('Preset: Marinara');
        const replace = [...container.querySelectorAll<HTMLInputElement>('input[type=checkbox]')][0]!;
        replace.checked = true;
        replace.dispatchEvent(new Event('change'));
        expect(run.settings.replacePromptManager).toBe(true);
        expect(document.getElementById(LAUNCHER_ID)).not.toBeNull();
        replace.checked = false;
        replace.dispatchEvent(new Event('change'));
        expect(document.getElementById(LAUNCHER_ID)).toBeNull();
        expect(document.body.classList.contains(REPLACED_CLASS)).toBe(false);
        await run.stop();
    });

    it('starts without the data layer and keeps the studio closed', async () => {
        const module = createPresetStudioModule({});
        s.app.modules.expose('presetStore', undefined);
        const run = await s.lore.start(module);
        await s.slash[0]!.callback({}, '');
        expect(document.querySelector('.maestro-m34-dialog')).toBeNull();
        expect(s.notices.at(-1)?.text).toContain('cannot open');
        await run.stop();
    });
});
