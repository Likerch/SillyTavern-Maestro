// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_CLASS } from '../../../src/features/theme/api';
import { ST_STYLE_ID } from '../../../src/features/theme/layer';
import { readThemeSettings } from '../../../src/features/theme/settings';
import type { ThemeSettings } from '../../../src/features/theme/settings';
import { THEME_STRINGS } from '../../../src/features/theme/strings';
import { TOKENS_STYLE_ID } from '../../../src/features/theme/tokens';
import { THEME_SECTION_ORDER, THEME_TAB_ORDER, partLabel } from '../../../src/features/theme/view';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { createThemeEnv, fakeSkin, resetPage } from './theme-env';
import type { ThemeEnv, ThemeEnvOptions } from './theme-env';

let env: ThemeEnv;
let container: HTMLElement;
let cleanup: void | Unsubscribe;

beforeEach(() => {
    resetPage();
    vi.useFakeTimers();
});

afterEach(async () => {
    if (typeof cleanup === 'function') cleanup();
    cleanup = undefined;
    if (env?.running) await env.stop();
    vi.useRealTimers();
    resetPage();
});

const settings = () => readThemeSettings(env.slices.theme as Partial<ThemeSettings>);

async function open(options: ThemeEnvOptions = {}): Promise<void> {
    env = createThemeEnv(options);
    await env.start();
    container = document.createElement('div');
    document.body.appendChild(container);
    const tab = env.tabs.find((item) => item.id === 'theme');
    expect(tab).toMatchObject({ titleKey: 'm32.theme.tab', icon: 'fa-palette', order: THEME_TAB_ORDER });
    cleanup = tab!.render(container);
}

const control = (key: string) => container.querySelector<HTMLInputElement>(`[data-m32-control="${key}"]`);
const labels = () =>
    [...container.querySelectorAll('.maestro-m32-parts label')].map((node) => node.textContent?.trim());
const click = (node: HTMLElement | null) => {
    expect(node).not.toBeNull();
    node!.click();
};

describe('settings section «Оформление»', () => {
    it('lives in its own pult tab while the shell has no settings sections', async () => {
        await open({ skins: [fakeSkin('des'), fakeSkin('ck', false), fakeSkin('qvink', true, 'missing.key')] });
        expect(env.sections).toEqual([]);
        expect(container.querySelector('.maestro-section-title')?.textContent).toBe('Appearance');
        expect(control('enabled')?.checked).toBe(true);
        // ST and the chat always; neighbours only when present; names from the skin, fallback to Maestro's.
        expect(labels()).toEqual([
            'SillyTavern interface',
            'Chat messages',
            'Doom’s Enhancement Suite',
            'Qvink Memory',
        ]);
        expect(container.querySelector('label[data-part="des"]')?.getAttribute('title')).toBe(
            'Scene headers and windows',
        );
        // ST and the chat explain themselves with Maestro's own hints (the clean previews included).
        expect(container.querySelector('label[data-part="st"]')?.getAttribute('title')).toContain('DES tracker');
        expect(container.querySelector('label[data-part="chat"]')?.getAttribute('title')).toContain('message box');
        // A neighbour without a hint has none.
        expect(container.querySelector('label[data-part="qvink"]')?.hasAttribute('title')).toBe(false);
        expect(container.textContent).toContain('Show the original look');
        expect(env.styleIds()).toContain('maestro-m32-view');
    });

    it('uses the shell’s settings sections when offered (no own tab, no extra frame)', async () => {
        env = createThemeEnv({ sections: true });
        await env.start();
        expect(env.tabs).toEqual([]);
        expect(env.sections).toHaveLength(1);
        expect(env.sections[0]).toMatchObject({ id: 'theme', titleKey: 'm32.theme.title', order: THEME_SECTION_ORDER });
        container = document.createElement('div');
        cleanup = env.sections[0]!.render(container);
        expect(container.querySelector('.maestro-section')).toBeNull();
        expect(control('enabled')).not.toBeNull();
        await env.stop();
        expect(env.sections).toEqual([]);
        expect(env.styleIds()).toEqual([]);
    });

    it('switches the layer off and back, disabling the parts meanwhile', async () => {
        await open();
        const enabled = control('enabled')!;
        enabled.focus();
        enabled.checked = false;
        enabled.dispatchEvent(new Event('change'));
        await vi.advanceTimersByTimeAsync(0);
        expect(env.classes()).toEqual([]);
        expect(settings().enabled).toBe(false);
        expect(env.notified).toContain('modules.theme.enabled');
        expect(container.textContent).toContain('The unified style is off');
        expect(control('part-st')?.disabled).toBe(true);
        expect(container.querySelector('label[data-part="st"]')?.getAttribute('aria-disabled')).toBe('true');
        expect((control('compare') as unknown as HTMLButtonElement).disabled).toBe(true);
        // The focused control survives the re-render.
        expect(document.activeElement).toBe(control('enabled'));

        control('enabled')!.checked = true;
        control('enabled')!.dispatchEvent(new Event('change'));
        await vi.advanceTimersByTimeAsync(0);
        expect(env.classes()).toContain(THEME_CLASS);
        expect(control('part-st')?.disabled).toBe(false);
    });

    it('switches one part', async () => {
        await open();
        const chat = control('part-chat')!;
        chat.checked = false;
        chat.dispatchEvent(new Event('change'));
        await vi.advanceTimersByTimeAsync(0);
        expect(env.classes()).not.toContain(`${THEME_CLASS}-chat`);
        expect(env.classes()).toContain(`${THEME_CLASS}-st`);
        expect(settings().parts.chat).toBe(false);
        expect(control('part-chat')?.checked).toBe(false);
    });

    it('changes density and corners', async () => {
        await open();
        click(control('density-compact'));
        await vi.advanceTimersByTimeAsync(0);
        expect(settings().density).toBe('compact');
        expect(env.styleText(ST_STYLE_ID)).toContain('compact density');
        expect(control('density-compact')?.getAttribute('aria-checked')).toBe('true');

        click(control('radius-0.5'));
        await vi.advanceTimersByTimeAsync(0);
        expect(settings().radiusScale).toBe(0.5);
        expect(env.styleText(TOKENS_STYLE_ID)).toContain('--maestro-radius-md: 5px;');
        expect(control('radius-0.5')?.getAttribute('aria-checked')).toBe('true');
        expect(env.saves).toBe(2);
    });

    it('shows the original look on demand and flips the button', async () => {
        await open();
        click(control('compare'));
        expect(env.classes()).toEqual([]);
        expect(control('compare')?.textContent).toBe('Back to the unified style');
        expect(control('compare')?.getAttribute('aria-pressed')).toBe('true');
        click(control('compare'));
        expect(env.classes()).toContain(THEME_CLASS);
        expect(control('compare')?.textContent).toBe('Show the original look');
    });

    it('cleans up its view', async () => {
        await open();
        expect(container.children).toHaveLength(1);
        if (typeof cleanup === 'function') cleanup();
        cleanup = undefined;
        expect(container.children).toHaveLength(0);
        await env.api().setEnabled(false);
        expect(container.children).toHaveLength(0);
    });

    it('speaks Russian', async () => {
        await open({ locale: 'ru', skins: [fakeSkin('nai', true, 'no.such.key')] });
        expect(container.querySelector('.maestro-section-title')?.textContent).toBe('Оформление');
        expect(labels()).toEqual(['Интерфейс SillyTavern', 'Сообщения чата', 'NAI Studio']);
        expect(container.textContent).toContain('Показать, как было');
        expect(container.textContent).toContain('Свободно');
    });

    it('survives a skin whose presence probe throws', async () => {
        const broken = fakeSkin('ck');
        broken.present = () => {
            throw new Error('probe failed');
        };
        await open({ skins: [broken] });
        expect(labels()).toEqual(['SillyTavern interface', 'Chat messages']);
    });

    it('names parts from the skin or falls back to Maestro’s strings', async () => {
        env = createThemeEnv();
        expect(partLabel(env.app, 'st', [])).toBe('SillyTavern interface');
        expect(partLabel(env.app, 'des', [fakeSkin('des')])).toBe('Doom’s Enhancement Suite');
        expect(partLabel(env.app, 'ck', [{ ...fakeSkin('ck'), titleKey: '' }])).toBe('CarrotKernel');
    });
});

describe('strings', () => {
    it('has every key in both languages', () => {
        expect(Object.keys(THEME_STRINGS.ru).sort()).toEqual(Object.keys(THEME_STRINGS.en).sort());
        expect(Object.keys(THEME_STRINGS.en).every((key) => key.startsWith('m32.theme.'))).toBe(true);
    });
});
