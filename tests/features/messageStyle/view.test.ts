// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESET_IDS, presetRules } from '../../../src/domain/message-style';
import { PREVIEW_CLASS, RULES_STYLE_ID, readMessageStyleSettings } from '../../../src/features/messageStyle';
import type { MessageStyleSettings } from '../../../src/features/messageStyle';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { createMessageStyleEnv, resetPage } from './env';
import type { MessageStyleEnv, MessageStyleEnvOptions } from './env';

let env: MessageStyleEnv;
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

const settings = () => readMessageStyleSettings(env.app.settings.module<Partial<MessageStyleSettings>>('messageStyle'));

async function open(options: MessageStyleEnvOptions = {}): Promise<void> {
    env = createMessageStyleEnv(options);
    await env.start();
    container = document.createElement('div');
    document.body.appendChild(container);
    cleanup = env.tab().render(container);
}

const $ = <T extends HTMLElement = HTMLElement>(selector: string) => container.querySelector<T>(selector);
const $$ = (selector: string) => [...container.querySelectorAll<HTMLElement>(selector)];
const control = <T extends HTMLElement = HTMLElement>(key: string) => $<T>(`[data-m32m-control="${key}"]`);
const click = (key: string) => control(key)!.click();
const flush = () => vi.advanceTimersByTimeAsync(0);
const css = () => env.styleText(RULES_STYLE_ID) ?? '';

function type(key: string, value: string, event: 'input' | 'change' = 'input'): void {
    const node = control<HTMLInputElement>(key)!;
    node.value = value;
    node.dispatchEvent(new Event(event));
}

describe('the editor tab', () => {
    it('shows presets, both previews, the rules, the player block and the hint block', async () => {
        await open();
        expect($$('.maestro-m32m-preset')).toHaveLength(PRESET_IDS.length);
        expect(control('preset-classic')!.getAttribute('aria-pressed')).toBe('true');
        expect(control('preset-reset')).toBeNull();
        expect($$('.maestro-m32m-rule')).toHaveLength(presetRules('classic').length);
        expect($$('.maestro-m32m-rule-name').map((node) => node.textContent)).toContain('Повествование');
        expect(control('player-enabled')).not.toBeNull();
        expect(control<HTMLInputElement>('hint')!.checked).toBe(false);
        expect(container.textContent).toContain('Подсказать модели этот формат');
    });

    it('previews a character and a player message through ST’s formatter with the hook', async () => {
        await open();
        const char = $(`.${PREVIEW_CLASS}[data-ms-scope="char"] .${PREVIEW_CLASS}-text`)!;
        const user = $(`.${PREVIEW_CLASS}[data-ms-scope="user"] .${PREVIEW_CLASS}-text`)!;
        expect(char.querySelector('q.custom-maestro-ms-dq')?.textContent).toBe('"Ты вовремя"');
        expect(char.querySelector('q.custom-maestro-ms-gq')?.textContent).toBe('«Закрываемся через час»');
        expect(char.querySelector('strong')?.textContent).toBe('Никто не обернулся.');
        expect(user.querySelector('em')?.textContent).toBe('Сажусь напротив и снимаю мокрые перчатки.');
        expect($(`.${PREVIEW_CLASS}[data-ms-scope="user"] .${PREVIEW_CLASS}-name`)!.textContent).toContain('Ты');
    });

    it('falls back to Maestro’s own rendering for the preview', async () => {
        await open({ format: false });
        const char = $(`.${PREVIEW_CLASS}[data-ms-scope="char"] .${PREVIEW_CLASS}-text`)!;
        expect(char.querySelector('q.maestro-ms-dq')).not.toBeNull();
        click('preset-book');
        await flush();
        const book = $(`.${PREVIEW_CLASS}[data-ms-scope="char"] .${PREVIEW_CLASS}-text`)!;
        expect(book.querySelector('.maestro-ms-dash')?.textContent).toBe('— Прости, дорогу размыло');
    });

    it('warns when ST gives no formatter hook', async () => {
        await open({ formatter: false });
        expect(container.querySelector('.maestro-banner')?.textContent).toContain('хук форматирования');
    });
});

describe('presets', () => {
    it('switches at once while the rules are untouched', async () => {
        await open();
        click('preset-book');
        await flush();
        expect(env.confirms).toEqual([]);
        expect(settings().preset).toBe('book');
        expect(settings().rules).toEqual(presetRules('book'));
        expect(control('preset-book')!.getAttribute('aria-pressed')).toBe('true');
        expect(css()).toContain('maestro-ms-dash');
    });

    it('asks before replacing edited rules, and brings the preset back', async () => {
        await open();
        click('rule-speech-open');
        click('rule-speech-color-accent');
        expect(settings().rules.find((rule) => rule.id === 'speech')!.style.color).toBe('accent');
        expect(control('preset-classic')!.textContent).toContain('изменён');
        env.confirmAnswer = false;
        click('preset-screenplay');
        await flush();
        expect(env.confirms).toHaveLength(1);
        expect(settings().preset).toBe('classic');
        env.confirmAnswer = true;
        click('preset-reset');
        await flush();
        expect(settings().rules).toEqual(presetRules('classic'));
        expect(control('preset-reset')).toBeNull();
    });
});

describe('rules', () => {
    it('edits a rule and the stylesheet follows', async () => {
        await open();
        click('rule-thoughts-open');
        expect(control('rule-thoughts-open')!.getAttribute('aria-expanded')).toBe('true');
        click('rule-thoughts-color-muted');
        click('rule-thoughts-bold-on');
        click('rule-thoughts-bar');
        const thoughts = settings().rules.find((rule) => rule.id === 'thoughts')!;
        expect(thoughts.style).toMatchObject({ color: 'muted', bold: true, bar: true, italic: true });
        expect(css()).toContain('font-weight: bold');
        expect(css()).toContain('padding-left: 0.35em');
        expect(env.saves).toBeGreaterThan(0);
        expect(control('rule-thoughts-color-muted')!.getAttribute('aria-checked')).toBe('true');
    });

    it('switches a rule off and on', async () => {
        await open();
        const box = control<HTMLInputElement>('rule-speech-enabled')!;
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        expect(settings().rules.find((rule) => rule.id === 'speech')!.enabled).toBe(false);
        expect($('[data-rule="speech"]')!.classList.contains('maestro-off')).toBe(true);
        expect(css()).not.toContain('maestro-ms-dq');
    });

    it('moves the opacity slider without redrawing the editor', async () => {
        await open();
        click('rule-narration-open');
        const slider = control<HTMLInputElement>('rule-narration-opacity')!;
        slider.value = '70';
        slider.dispatchEvent(new Event('input'));
        expect(settings().rules.find((rule) => rule.id === 'narration')!.style.opacity).toBe(0.7);
        expect(control('rule-narration-opacity')).toBe(slider);
        expect(slider.parentElement!.textContent).toContain('70%');
        expect(css()).toContain('70%, transparent');
    });

    it('renames, changes the kind and whose messages, sets the font and the marks', async () => {
        await open();
        click('rule-dash-open');
        type('rule-dash-name', '  Реплики  ', 'change');
        click('rule-dash-applyTo-user');
        const marks = control<HTMLSelectElement>('rule-dash-marks')!;
        marks.value = 'guillemets';
        marks.dispatchEvent(new Event('change'));
        const font = control<HTMLSelectElement>('rule-dash-font')!;
        font.value = 'serif';
        font.dispatchEvent(new Event('change'));
        const dash = settings().rules.find((rule) => rule.id === 'dash')!;
        expect(dash).toMatchObject({ name: 'Реплики', applyTo: 'user' });
        expect(dash.style).toMatchObject({ marks: 'guillemets', font: 'serif' });
        expect($('[data-rule="dash"] .maestro-m32m-rule-name')!.textContent).toBe('Реплики');
        const kind = control<HTMLSelectElement>('rule-dash-kind')!;
        kind.value = 'parentheses';
        kind.dispatchEvent(new Event('change'));
        expect(settings().rules.find((rule) => rule.id === 'dash')!.match).toEqual({ kind: 'parentheses' });
        expect(settings().rules.find((rule) => rule.id === 'dash')!.style.marks).toBe('keep');
        expect(control('rule-dash-marks')).toBeNull();
    });

    it('reorders and deletes rules', async () => {
        await open();
        expect(control<HTMLButtonElement>('rule-narration-up')!.disabled).toBe(true);
        click('rule-narration-down');
        expect(
            settings()
                .rules.slice(0, 2)
                .map((rule) => rule.id),
        ).toEqual(['speech', 'narration']);
        click('rule-narration-delete');
        expect(settings().rules.map((rule) => rule.id)).not.toContain('narration');
        expect($('[data-rule="narration"]')).toBeNull();
    });

    it('hides decoration controls for narration', async () => {
        await open();
        click('rule-narration-open');
        expect(control('rule-narration-spacing')).not.toBeNull();
        expect(control('rule-narration-bar')).toBeNull();
        expect(control('rule-narration-marks')).toBeNull();
        expect($('[data-rule="narration"]')!.textContent).toContain('Повествование — весь текст');
    });

    it('picks a custom colour', async () => {
        await open();
        click('rule-speech-open');
        type('rule-speech-color-custom', '#AA3311', 'change');
        expect(settings().rules.find((rule) => rule.id === 'speech')!.style.color).toBe('#aa3311');
        expect(css()).toContain('#aa3311');
    });
});

describe('custom rules', () => {
    it('adds a rule, validates the regex live and commits only a valid one', async () => {
        await open();
        const kind = control<HTMLSelectElement>('add-kind')!;
        kind.value = 'custom';
        kind.dispatchEvent(new Event('change'));
        click('add');
        const added = settings().rules.at(-1)!;
        expect(added).toMatchObject({ id: 'c1', name: 'Своё правило', match: { kind: 'custom', pattern: '' } });
        expect(document.activeElement).toBe(control('rule-c1-pattern'));

        type('rule-c1-pattern', '(');
        const status = $('.maestro-m32m-pattern-status')!;
        expect(status.dataset.state).toBe('error');
        expect(status.textContent).toContain('В выражении ошибка');
        expect(control('rule-c1-pattern')!.getAttribute('aria-invalid')).toBe('true');
        control('rule-c1-pattern')!.dispatchEvent(new Event('change'));
        expect(settings().rules.at(-1)!.match.pattern).toBe('');

        type('rule-c1-pattern', 'a*');
        expect($('.maestro-m32m-pattern-status')!.textContent).toContain('пустым текстом');

        type('rule-c1-pattern', '~[^~]+~');
        expect($('.maestro-m32m-pattern-status')!.dataset.state).toBe('ok');
        expect($$('.maestro-m32m-hit').map((node) => node.textContent)).toEqual(['~слушай внимательно~']);
        expect($('.maestro-m32m-test-result')!.textContent).toContain('Совпадений: 1');
        type('rule-c1-pattern', '~[^~]+~', 'change');
        expect(settings().rules.at(-1)!.match.pattern).toBe('~[^~]+~');
        expect(css()).toContain('maestro-ms-c-c1');
        expect(env.format('Она: ~тише~.', false)).toContain('custom-maestro-ms-c-c1');
    });

    it('tests its own text and honours «ignore case»', async () => {
        await open();
        const kind = control<HTMLSelectElement>('add-kind')!;
        kind.value = 'custom';
        kind.dispatchEvent(new Event('change'));
        click('add');
        type('rule-c1-pattern', 'ура', 'change');
        type('rule-c1-test', 'Ура! ура.');
        expect($$('.maestro-m32m-hit').map((node) => node.textContent)).toEqual(['ура']);
        const box = control<HTMLInputElement>('rule-c1-ignoreCase')!;
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        expect(settings().rules.at(-1)!.match.flags).toBe('i');
        expect($$('.maestro-m32m-hit').map((node) => node.textContent)).toEqual(['Ура', 'ура']);
        type('rule-c1-test', 'ничего');
        expect($('.maestro-m32m-test-result')!.textContent).toContain('Совпадений нет');
    });

    it('adds built-in kinds too', async () => {
        await open();
        const kind = control<HTMLSelectElement>('add-kind')!;
        kind.value = 'brackets';
        kind.dispatchEvent(new Event('change'));
        click('add');
        expect(settings().rules.at(-1)).toMatchObject({ id: 'r1', name: '', match: { kind: 'brackets' } });
        // No style yet, so no CSS — but the hook already marks the asides.
        expect(css()).not.toContain('maestro-ms-bracket');
        expect(env.format('[пометка]', false)).toContain('custom-maestro-ms-bracket');
        expect(document.activeElement).toBe(control('rule-r1-name'));
    });
});

describe('the player and the hint', () => {
    it('edits the player’s look', async () => {
        await open();
        expect(css()).toContain('box-shadow: inset 3px 0 0');
        click('player-mark-tint');
        click('player-color-text');
        click('player-align-indent');
        const name = control<HTMLInputElement>('player-name')!;
        name.checked = false;
        name.dispatchEvent(new Event('change'));
        expect(settings().player).toEqual({ enabled: true, mark: 'tint', color: 'text', name: false, align: 'indent' });
        expect(css()).toContain('linear-gradient');
        expect(css()).toContain('margin-left: clamp(16px, 12%, 120px)');
        expect(css()).not.toContain('.name_text');
    });

    it('turns the hint on and shows what the model gets', async () => {
        await open();
        const box = control<HTMLInputElement>('hint')!;
        box.checked = true;
        box.dispatchEvent(new Event('change'));
        expect(settings().hint).toBe(true);
        expect($('.maestro-m32m-hint-text')!.textContent).toBe(
            'Прямую речь пиши в кавычках "…", мысли и выделения — *курсивом*.',
        );
    });

    it('turns styling off from the tab', async () => {
        await open();
        const box = control<HTMLInputElement>('enabled')!;
        box.focus();
        box.checked = false;
        box.dispatchEvent(new Event('change'));
        expect(settings().enabled).toBe(false);
        expect(css()).toBe('');
        expect(container.textContent).toContain('Выключено: сообщения выглядят так, как их рисует SillyTavern.');
        expect(document.activeElement).toBe(control('enabled'));
    });

    it('cleans up on close', async () => {
        await open();
        (cleanup as Unsubscribe)();
        cleanup = undefined;
        expect(container.children).toHaveLength(0);
    });
});
