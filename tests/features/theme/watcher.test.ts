// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ThemeWatcher, WATCH_DEBOUNCE_MS, WATCH_EVENTS } from '../../../src/features/theme/watcher';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { resetPage } from './theme-env';

let watcher: ThemeWatcher;
let onChange: ReturnType<typeof vi.fn<() => void>>;
let onError: ReturnType<typeof vi.fn<(error: unknown) => void>>;
const handlers = new Map<string, () => void>();

const settle = () => vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS + 5);

function create(subscribe?: (event: string, handler: () => void) => Unsubscribe): ThemeWatcher {
    watcher = new ThemeWatcher({ onChange, onError, subscribe });
    return watcher;
}

beforeEach(() => {
    resetPage();
    vi.useFakeTimers();
    onChange = vi.fn<() => void>();
    onError = vi.fn<(error: unknown) => void>();
    handlers.clear();
});

afterEach(() => {
    watcher?.stop();
    vi.useRealTimers();
    resetPage();
});

describe('ThemeWatcher', () => {
    it('debounces a burst of theme variable writes on <html> into one call', async () => {
        create().start();
        expect(watcher.isRunning()).toBe(true);
        const html = document.documentElement;
        html.style.setProperty('--SmartThemeBodyColor', 'rgb(1, 1, 1)');
        await vi.advanceTimersByTimeAsync(50);
        html.style.setProperty('--SmartThemeQuoteColor', 'rgb(2, 2, 2)');
        await vi.advanceTimersByTimeAsync(50);
        html.style.setProperty('--blurStrength', '4');
        await vi.advanceTimersByTimeAsync(WATCH_DEBOUNCE_MS - 10);
        expect(onChange).not.toHaveBeenCalled();
        await settle();
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('reacts to body classes (chat style, blur, shadows) but not to <html> classes', async () => {
        create().start();
        document.documentElement.classList.add('maestro-theme');
        await settle();
        expect(onChange).not.toHaveBeenCalled();
        document.body.classList.add('bubblechat');
        await settle();
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('reacts to the theme select and ST’s UI theme controls only', async () => {
        document.body.innerHTML = `
            <div id="user-settings-block"><select id="themes"><option>a</option></select></div>
            <input id="elsewhere" type="checkbox">`;
        create().start();
        document.getElementById('elsewhere')!.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(onChange).not.toHaveBeenCalled();
        document.getElementById('themes')!.dispatchEvent(new Event('change', { bubbles: true }));
        await settle();
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('watches ST’s custom CSS, also when it appears later', async () => {
        create().start();
        const custom = document.createElement('style');
        custom.id = 'custom-style';
        document.head.appendChild(custom);
        await settle();
        expect(onChange).toHaveBeenCalledTimes(1);
        custom.textContent = ':root { --SmartThemeQuoteColor: red; }';
        await settle();
        expect(onChange).toHaveBeenCalledTimes(2);

        // Other <head> changes (Maestro's own sheets) are ignored.
        document.head.appendChild(document.createElement('style'));
        await settle();
        expect(onChange).toHaveBeenCalledTimes(2);

        custom.remove();
        await settle();
        expect(onChange).toHaveBeenCalledTimes(3);
    });

    it('observes an existing custom CSS node from the start', async () => {
        const custom = document.createElement('style');
        custom.id = 'custom-style';
        document.head.appendChild(custom);
        create().start();
        custom.textContent = 'body { color: red; }';
        await settle();
        expect(onChange).toHaveBeenCalledTimes(1);
    });

    it('listens to ST’s settings events and reports subscription failures', async () => {
        const failing = new Set(['APP_READY']);
        create((event, handler) => {
            if (failing.has(event)) throw new Error('no such event');
            handlers.set(event, handler);
            return () => handlers.delete(event);
        }).start();
        expect([...handlers.keys()]).toEqual(WATCH_EVENTS.filter((event) => !failing.has(event)));
        expect(onError).toHaveBeenCalledTimes(1);
        handlers.get('SETTINGS_UPDATED')!();
        await settle();
        expect(onChange).toHaveBeenCalledTimes(1);
        watcher.stop();
        expect(handlers.size).toBe(0);
    });

    it('stops completely: no observers, no listeners, no pending call', async () => {
        create().start();
        watcher.start();
        document.documentElement.style.setProperty('--fontScale', '1.1');
        await vi.advanceTimersByTimeAsync(10);
        watcher.stop();
        await settle();
        document.body.classList.add('no-blur');
        document.getElementById('themes')?.dispatchEvent(new Event('change', { bubbles: true }));
        watcher.poke();
        await settle();
        expect(onChange).not.toHaveBeenCalled();
        expect(watcher.isRunning()).toBe(false);
    });

    it('flushes a pending call on demand and survives a throwing callback and unsubscriber', async () => {
        onChange.mockImplementation(() => {
            throw new Error('callback failed');
        });
        create(() => () => {
            throw new Error('unsubscribe failed');
        }).start();
        watcher.flush();
        expect(onChange).not.toHaveBeenCalled();
        watcher.poke();
        watcher.flush();
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'callback failed' }));
        watcher.stop();
        expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'unsubscribe failed' }));
    });
});
