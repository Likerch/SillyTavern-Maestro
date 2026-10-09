// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MECHANICS_STRINGS } from '../../../src/features/mechanics/strings';
import { settingsSection } from '../../../src/features/mechanics/view-constructor-settings';
import { BOOK, createDefsEnv } from './helpers-defs';
import type { DefsEnv } from './helpers-defs';

let env: DefsEnv;
let container: HTMLElement;

beforeEach(() => {
    env = createDefsEnv();
    container = document.createElement('div');
    document.body.replaceChildren(container);
});

function input(label: string): HTMLInputElement {
    const found = container.querySelector<HTMLInputElement>(`input[aria-label="${label}"]`);
    if (found) return found;
    const byLabel = [...container.querySelectorAll('label')].find((node) => node.textContent?.trim() === label);
    const box = byLabel?.querySelector<HTMLInputElement>('input');
    if (!box) throw new Error(`no input ${label}`);
    return box;
}

function change(node: HTMLInputElement, value: string | boolean): void {
    if (typeof value === 'boolean') node.checked = value;
    else node.value = value;
    node.dispatchEvent(new Event('change'));
}

describe('mechanics settings section', () => {
    it('edits the live slice and saves it', () => {
        const save = vi.spyOn(env.app.settings, 'save');
        const notify = vi.spyOn(env.app.settings, 'notify');
        const off = settingsSection(env.deps)(container);
        expect(container.textContent).toContain('Mechanics settings');
        expect(input('Roll checks when your message has a trigger word').checked).toBe(true);

        change(input('Roll checks when your message has a trigger word'), false);
        change(input('Widgets next to the DES portraits'), false);
        change(input('Background parse of replies'), false);
        change(input('Prompt budget, tokens'), '10');
        change(input('Depth in the chat'), '3.6');
        expect(env.slice).toMatchObject({
            autoChecks: false,
            strip: false,
            background: false,
            promptBudget: 50,
            depth: 4,
        });

        const book = input('Book for new mechanics');
        expect(book.value).toBe(BOOK);
        change(book, '  Maestro · системы ');
        expect(env.slice.book).toBe('Maestro · системы');
        change(book, '');
        expect(env.slice.book).toBe(BOOK);
        expect(book.value).toBe(BOOK);
        expect(save).toHaveBeenCalledTimes(7);
        expect(notify).toHaveBeenCalledWith('modules.mechanics.depth');

        if (typeof off === 'function') off();
        expect(container.children).toHaveLength(0);
    });

    it('chooses where the HUD shows: over the chat or left of it', () => {
        env.app.i18n.register(MECHANICS_STRINGS);
        const notify = vi.spyOn(env.app.settings, 'notify');
        settingsSection(env.deps)(container);
        const place = container.querySelector<HTMLSelectElement>('select[aria-label="Where the HUD shows"]')!;
        expect([...place.options].map((option) => [option.value, option.textContent])).toEqual([
            ['chat', 'Over the chat (top or bottom)'],
            ['left', 'Left of the chat (on a wide screen)'],
        ]);
        expect(place.value).toBe('chat');
        expect(place.closest('.maestro-field')?.textContent).toContain('at least 1200 px wide');
        place.value = 'left';
        place.dispatchEvent(new Event('change'));
        expect(env.slice.hudPlacement).toBe('left');
        expect(notify).toHaveBeenCalledWith('modules.mechanics.hudPlacement');
    });
});
