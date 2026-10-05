// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { THEME_CLASS } from '../../../src/features/theme/api';
import { CHAT_STYLE_ID, PREVIEW_MS, ST_STYLE_ID } from '../../../src/features/theme/layer';
import { ALL_PARTS, readThemeSettings } from '../../../src/features/theme/settings';
import type { ThemeSettings } from '../../../src/features/theme/settings';
import { TOKENS_STYLE_ID } from '../../../src/features/theme/tokens';
import { WATCH_DEBOUNCE_MS } from '../../../src/features/theme/watcher';
import { createThemeEnv, fakeSkin, resetPage } from './theme-env';
import type { ThemeEnv } from './theme-env';

const ALL_CLASSES = [THEME_CLASS, ...ALL_PARTS.map((part) => `${THEME_CLASS}-${part}`)];

let env: ThemeEnv;

beforeEach(() => {
    resetPage();
    vi.useFakeTimers();
});

afterEach(async () => {
    if (env?.running) await env.stop();
    vi.useRealTimers();
    resetPage();
});

const settings = () => readThemeSettings(env.slices.theme as Partial<ThemeSettings>);

describe('theme layer: page classes', () => {
    it('adds the layer and every enabled part on start, removes them all on stop', async () => {
        env = createThemeEnv();
        await env.start();
        expect(env.classes().sort()).toEqual([...ALL_CLASSES].sort());
        expect(env.api().enabled()).toBe(true);
        expect(env.api().parts()).toEqual([...ALL_PARTS]);

        // Foreign classes on <html> are left alone.
        document.documentElement.classList.add('someone-else');
        await env.stop();
        expect(env.classes()).toEqual([]);
        expect(document.documentElement.classList.contains('someone-else')).toBe(true);
        expect(env.styleIds()).toEqual([]);
    });

    it('starts with nothing when the layer is off in the settings', async () => {
        env = createThemeEnv();
        env.slices.theme = { enabled: false };
        await env.start();
        expect(env.classes()).toEqual([]);
        expect(env.styleIds()).not.toContain(TOKENS_STYLE_ID);
        expect(env.api().enabled()).toBe(false);
        expect(env.api().parts()).toEqual([]);
    });

    it('switches single parts', async () => {
        env = createThemeEnv();
        env.slices.theme = { parts: { chat: false } };
        await env.start();
        expect(env.classes()).toContain(`${THEME_CLASS}-st`);
        expect(env.classes()).not.toContain(`${THEME_CLASS}-chat`);

        await env.api().setPart('chat', true);
        await env.api().setPart('st', false);
        expect(env.classes()).toContain(`${THEME_CLASS}-chat`);
        expect(env.classes()).not.toContain(`${THEME_CLASS}-st`);
        expect(env.classes()).toContain(THEME_CLASS);
        expect(settings().parts.st).toBe(false);
        expect(env.notified).toEqual(['modules.theme.parts.chat', 'modules.theme.parts.st']);
        expect(env.saves).toBe(2);
        expect(env.api().parts()).not.toContain('st');

        // Unknown parts are ignored.
        await env.api().setPart('nope' as never, true);
        expect(env.saves).toBe(2);
    });

    it('turns the whole layer off and on, keeping the part choices', async () => {
        env = createThemeEnv({ skins: [fakeSkin('des')] });
        await env.start();
        await env.api().setPart('qvink', false);
        await env.api().setEnabled(false);
        expect(env.classes()).toEqual([]);
        expect(env.styleIds()).toEqual(['maestro-m32-view']);
        expect(settings().enabled).toBe(false);

        await env.api().setEnabled(true);
        expect(env.classes()).toContain(THEME_CLASS);
        expect(env.classes()).not.toContain(`${THEME_CLASS}-qvink`);
        expect(env.styleIds()).toEqual(
            expect.arrayContaining([ST_STYLE_ID, CHAT_STYLE_ID, TOKENS_STYLE_ID, 'maestro-theme-des']),
        );
    });

    it('follows settings changed elsewhere (notify) and ignores other paths', async () => {
        env = createThemeEnv();
        await env.start();
        (env.slices.theme as Record<string, unknown>).enabled = false;
        env.app.settings.notify('modules.other.enabled');
        expect(env.classes()).toContain(THEME_CLASS);
        env.app.settings.notify('modules.theme');
        expect(env.classes()).toEqual([]);
    });

    it('notifies listeners on changes only', async () => {
        env = createThemeEnv();
        await env.start();
        const listener = vi.fn();
        const off = env.api().onChange(listener);
        await env.api().setPart('st', false);
        expect(listener).toHaveBeenCalledTimes(1);
        env.api().refresh();
        expect(listener).toHaveBeenCalledTimes(1);
        await env.api().setPart('st', true);
        expect(listener).toHaveBeenCalledTimes(2);
        off();
        await env.api().setEnabled(false);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('keeps a failing listener from breaking the others', async () => {
        env = createThemeEnv();
        await env.start();
        const good = vi.fn();
        env.api().onChange(() => {
            throw new Error('boom');
        });
        env.api().onChange(good);
        await env.api().setEnabled(false);
        expect(good).toHaveBeenCalled();
        expect(env.log.lines.some((line) => line.level === 'warn')).toBe(true);
    });
});

describe('theme layer: stylesheets', () => {
    it('injects tokens, ST, chat and every skin, all removed on stop', async () => {
        const des = fakeSkin('des');
        const ck = fakeSkin('ck', false);
        env = createThemeEnv({ skins: [des, ck] });
        await env.start();
        expect(env.styleText('maestro-theme-des')).toBe(des.css);
        expect(env.styleText('maestro-theme-ck')).toBe(ck.css);
        expect(env.styleText(TOKENS_STYLE_ID)).toContain(`html.${THEME_CLASS} {`);
        expect(env.styleText(ST_STYLE_ID)).toContain(`:where(html.${THEME_CLASS}.${THEME_CLASS}-st)`);
        expect(env.styleText(CHAT_STYLE_ID)).toContain(`:where(html.${THEME_CLASS}.${THEME_CLASS}-chat)`);
        await env.stop();
        expect(env.styleIds()).toEqual([]);
    });

    it('skips a skin without css', async () => {
        const broken = { ...fakeSkin('nai'), css: undefined as unknown as string };
        env = createThemeEnv({ skins: [broken, fakeSkin('des')] });
        await env.start();
        expect(env.styleIds()).not.toContain('maestro-theme-nai');
        expect(env.styleIds()).toContain('maestro-theme-des');
        expect(env.log.lines.some((line) => line.level === 'warn' && String(line.args[0]).includes('nai'))).toBe(true);
    });

    it('puts its sheets before ST’s custom CSS so the user’s rules win', async () => {
        const custom = document.createElement('style');
        custom.id = 'custom-style';
        custom.textContent = '.menu_button { border-radius: 0; }';
        document.head.appendChild(custom);
        env = createThemeEnv({ skins: [fakeSkin('des')] });
        await env.start();
        const order = [...document.head.children].map((node) => node.getAttribute('data-maestro-style') ?? node.id);
        for (const id of [TOKENS_STYLE_ID, CHAT_STYLE_ID]) {
            expect(order.indexOf(id)).toBeLessThan(order.indexOf('custom-style'));
        }
        expect(order.indexOf(ST_STYLE_ID)).toBeLessThan(order.indexOf('custom-style'));
        expect(order.indexOf('maestro-theme-des')).toBeLessThan(order.indexOf('custom-style'));
    });

    it('rebuilds the ST and chat sheets and the tokens for density and corners', async () => {
        env = createThemeEnv();
        await env.start();
        expect(env.styleText(ST_STYLE_ID)).not.toContain('compact density');
        const layer = env.exposed.get('theme');
        expect(layer).toBeDefined();
        const setDensity = async (density: 'compact' | 'comfortable') => {
            (env.slices.theme as Record<string, unknown>).density = density;
            env.app.settings.notify('modules.theme.density');
        };
        await setDensity('compact');
        expect(env.styleText(ST_STYLE_ID)).toContain('compact density');
        expect(env.styleText(CHAT_STYLE_ID)).toContain('compact density');
        expect(env.styleText(TOKENS_STYLE_ID)).toContain('--maestro-mes-pad: 6px;');

        (env.slices.theme as Record<string, unknown>).radiusScale = 0;
        env.app.settings.notify('modules.theme.radiusScale');
        expect(env.styleText(TOKENS_STYLE_ID)).toContain('--maestro-radius-md: 0px;');
    });

    it('derives the tokens from ST’s theme variables and recomputes on refresh()', async () => {
        document.documentElement.style.setProperty('--SmartThemeQuoteColor', 'rgb(111, 133, 253)');
        document.documentElement.style.setProperty('--fontScale', '1.2');
        env = createThemeEnv();
        await env.start();
        expect(env.styleText(TOKENS_STYLE_ID)).toContain('--maestro-accent: rgb(111, 133, 253);');
        expect(env.styleText(TOKENS_STYLE_ID)).toContain('--maestro-font-size: 18px;');

        const before = env.styleText(TOKENS_STYLE_ID);
        document.body.classList.add('no-blur');
        env.api().refresh();
        expect(env.styleText(TOKENS_STYLE_ID)).not.toBe(before);
        expect(env.styleText(TOKENS_STYLE_ID)).toContain('--maestro-blur: 0px;');
    });

    it('logs and keeps the old tokens when the theme cannot be read', async () => {
        env = createThemeEnv();
        await env.start();
        const before = env.styleText(TOKENS_STYLE_ID);
        const spy = vi.spyOn(window, 'getComputedStyle').mockImplementation(() => {
            throw new Error('no styles');
        });
        env.api().refresh();
        spy.mockRestore();
        expect(env.styleText(TOKENS_STYLE_ID)).toBe(before);
        expect(env.log.lines.some((line) => line.level === 'warn')).toBe(true);
    });
});

describe('theme layer: watcher', () => {
    it('recomputes the tokens after ST rewrites the theme variables (debounced)', async () => {
        env = createThemeEnv();
        await env.start();
        const listener = vi.fn();
        env.api().onChange(listener);
        document.documentElement.style.setProperty('--SmartThemeQuoteColor', 'rgb(0, 200, 120)');
        document.documentElement.style.setProperty('--SmartThemeBodyColor', 'rgb(240, 240, 240)');
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS - 20);
        expect(env.styleText(TOKENS_STYLE_ID)).not.toContain('rgb(0, 200, 120)');
        await vi.advanceTimersByTimeAsync(40);
        expect(env.styleText(TOKENS_STYLE_ID)).toContain('--maestro-accent: rgb(0, 200, 120);');
        expect(env.styleText(TOKENS_STYLE_ID)).toContain('--maestro-text: rgb(240, 240, 240);');
        expect(listener).toHaveBeenCalledTimes(1);
    });

    it('reacts to ST’s settings events and stops watching when the layer is off', async () => {
        env = createThemeEnv();
        await env.start();
        document.documentElement.style.setProperty('--SmartThemeQuoteColor', 'rgb(90, 200, 250)');
        env.emit('SETTINGS_UPDATED');
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS + 10);
        expect(env.styleText(TOKENS_STYLE_ID)).toContain('--maestro-accent: rgb(90, 200, 250);');

        await env.api().setEnabled(false);
        document.documentElement.style.setProperty('--SmartThemeQuoteColor', 'rgb(9, 9, 9)');
        env.emit('SETTINGS_UPDATED');
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS + 10);
        expect(env.styleText(TOKENS_STYLE_ID)).toBeUndefined();
    });
});

describe('theme layer: «Как было»', () => {
    it('hides the layer for a while without touching the settings', async () => {
        env = createThemeEnv();
        await env.start();
        const layer = await import('../../../src/features/theme/layer');
        expect(layer.PREVIEW_MS).toBe(PREVIEW_MS);
        const listener = vi.fn();
        env.api().onChange(listener);

        const view = env.tabs[0];
        expect(view).toBeDefined();
        const container = document.createElement('div');
        document.body.appendChild(container);
        view!.render(container);
        const compare = container.querySelector<HTMLButtonElement>('[data-m32-control="compare"]')!;
        compare.click();
        expect(env.classes()).toEqual([]);
        expect(env.api().enabled()).toBe(false);
        expect(settings().enabled).toBe(true);
        expect(env.styleIds()).toContain(ST_STYLE_ID);
        expect(listener).toHaveBeenCalledTimes(1);

        await vi.advanceTimersByTimeAsync(PREVIEW_MS);
        expect(env.classes()).toContain(THEME_CLASS);
        expect(env.api().enabled()).toBe(true);
        expect(listener).toHaveBeenCalledTimes(2);
    });

    it('ends early by the button, by setEnabled and on stop', async () => {
        env = createThemeEnv();
        await env.start();
        const container = document.createElement('div');
        env.tabs[0]!.render(container);
        const press = () => container.querySelector<HTMLButtonElement>('[data-m32-control="compare"]')!.click();
        press();
        expect(env.classes()).toEqual([]);
        press();
        expect(env.classes()).toContain(THEME_CLASS);

        press();
        await env.api().setEnabled(true);
        expect(env.classes()).toContain(THEME_CLASS);

        press();
        await env.stop();
        await vi.advanceTimersByTimeAsync(PREVIEW_MS);
        expect(env.classes()).toEqual([]);
    });
});
