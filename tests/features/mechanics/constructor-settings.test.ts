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

    it('switches the roll in the middle of a reply (1.27, on by default) and says what it does', () => {
        env.app.i18n.register(MECHANICS_STRINGS);
        const notify = vi.spyOn(env.app.settings, 'notify');
        settingsSection(env.deps)(container);
        const box = input('Roll in the middle of a reply');
        expect(box.checked).toBe(true);
        expect(container.textContent).toContain('the same reply goes on with the result');
        change(box, false);
        expect(env.slice.rollContinue).toBe(false);
        expect(notify).toHaveBeenCalledWith('modules.mechanics.rollContinue');
    });

    it('chooses where the HUD shows: over the chat, left or right of it', () => {
        env.app.i18n.register(MECHANICS_STRINGS);
        const notify = vi.spyOn(env.app.settings, 'notify');
        settingsSection(env.deps)(container);
        const place = container.querySelector<HTMLSelectElement>('select[aria-label="Where the HUD shows"]')!;
        expect([...place.options].map((option) => [option.value, option.textContent])).toEqual([
            ['chat', 'Over the chat (top or bottom)'],
            ['left', 'Left of the chat'],
            ['right', 'Right of the chat'],
        ]);
        expect(place.value).toBe('chat');
        // The hint tells the room it needs, the rail without it and phones.
        const hint = place.closest('.maestro-field')?.textContent ?? '';
        expect(hint).toContain('at least 150 px');
        expect(hint).toContain('«Mechanics» tab');
        expect(hint).toContain('On a phone the HUD is always over the chat');
        expect(hint).not.toContain('1200 px');
        place.value = 'right';
        place.dispatchEvent(new Event('change'));
        expect(env.slice.hudPlacement).toBe('right');
        expect(notify).toHaveBeenCalledWith('modules.mechanics.hudPlacement');
    });

    it('chooses what the panel beside the chat shows', () => {
        env.app.i18n.register(MECHANICS_STRINGS);
        const notify = vi.spyOn(env.app.settings, 'notify');
        settingsSection(env.deps)(container);
        const view = container.querySelector<HTMLSelectElement>('select[aria-label="The panel beside the chat"]')!;
        expect([...view.options].map((option) => [option.value, option.textContent])).toEqual([
            ['compact', 'Short: what the HUD over the chat shows'],
            ['full', 'Full: every character of the scene'],
        ]);
        expect(view.value).toBe('compact');
        view.value = 'full';
        view.dispatchEvent(new Event('change'));
        expect(env.slice.hudSideView).toBe('full');
        expect(notify).toHaveBeenCalledWith('modules.mechanics.hudSideView');
    });
});
