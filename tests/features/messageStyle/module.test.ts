// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PRESET_IDS, presetRules } from '../../../src/domain/message-style';
import {
    EDITOR_STYLE_ID,
    HINT_INJECTION,
    HOOK_ORDER,
    MESSAGE_STYLE_CLASS,
    MESSAGE_STYLE_STRINGS,
    RESTYLE_MS,
    RULES_STYLE_ID,
    messageStyleModule,
    readMessageStyleSettings,
} from '../../../src/features/messageStyle';
import type { MessageStyleSettings } from '../../../src/features/messageStyle';
import { createMessageStyleEnv, resetPage } from './env';
import type { MessageStyleEnv, MessageStyleEnvOptions } from './env';

let env: MessageStyleEnv;

beforeEach(() => {
    resetPage();
    vi.useFakeTimers();
});

afterEach(async () => {
    if (env?.running) await env.stop();
    vi.useRealTimers();
    resetPage();
});

const settings = () => readMessageStyleSettings(env.app.settings.module<Partial<MessageStyleSettings>>('messageStyle'));

function edit(change: (value: MessageStyleSettings) => void, path = 'rules'): void {
    change(settings());
    env.app.settings.notify(`modules.messageStyle.${path}`);
}

async function boot(options: MessageStyleEnvOptions = {}): Promise<void> {
    env = createMessageStyleEnv(options);
    await env.start();
}

const classes = () => [...document.documentElement.classList];

describe('messageStyleModule', () => {
    it('is M32m «messageStyle» of stage 12, on by default, with Classic rules and the player bar', () => {
        expect(messageStyleModule).toMatchObject({
            id: 'M32m',
            key: 'messageStyle',
            stage: 12,
            enabledByDefault: true,
            titleKey: 'm32m.title',
        });
        const defaults = messageStyleModule.defaults();
        expect(defaults).toMatchObject({ enabled: true, preset: 'classic', hint: false });
        expect(defaults.rules).toEqual(presetRules('classic'));
        expect(defaults.player).toMatchObject({ enabled: true, mark: 'bar', color: 'accent' });
        expect(messageStyleModule.requires).toBeUndefined();
    });

    it('has the same m32m.* strings in English and Russian, for every preset and kind', () => {
        const { en, ru } = MESSAGE_STYLE_STRINGS;
        expect(Object.keys(ru).sort()).toEqual(Object.keys(en).sort());
        for (const key of Object.keys(en)) expect(key.startsWith('m32m.')).toBe(true);
        for (const id of PRESET_IDS) {
            expect(ru[`m32m.preset.${id}`]).toBeTruthy();
            expect(en[`m32m.preset.${id}.desc`]).toBeTruthy();
        }
        expect(ru['m32m.preset.classic']).toBe('Классика');
        expect(ru['m32m.preset.minimal']).toBe('Минимум');
    });
});

describe('the page class, the stylesheet and the hook', () => {
    it('start adds the class, the rules sheet, the editor sheet, the tab and one late afterMarkdown hook', async () => {
        await boot();
        expect(classes()).toContain(MESSAGE_STYLE_CLASS);
        expect(env.styleText(RULES_STYLE_ID)).toContain(`html.${MESSAGE_STYLE_CLASS} #chat .mes[is_user="true"]`);
        expect(env.styleText(EDITOR_STYLE_ID)).toContain('.maestro-m32m');
        expect(env.tab()).toMatchObject({ titleKey: 'm32m.tab', icon: 'fa-paintbrush', group: 'settings', order: 97 });
        expect(env.hooks).toHaveLength(1);
        expect(env.hooks[0]!.options).toEqual({ stage: 'afterMarkdown', order: HOOK_ORDER });
        expect(env.api().annotated()).toBe(true);
        expect(env.api().enabled()).toBe(true);
        expect(env.api().preset()).toBe('classic');
    });

    it('the hook marks what ST does not and never touches the stored message', async () => {
        await boot();
        edit((value) => {
            value.rules = presetRules('book');
        });
        const text = '— Привет, — сказал он. "Да" *мысль*';
        const body = env.printMessage(text, false);
        expect(body.innerHTML).toContain('<span class="custom-maestro-ms-dash">— Привет</span>');
        expect(body.innerHTML).toContain('<q class="custom-maestro-ms-dq">"Да"</q>');
        expect(body.innerHTML).toContain('<em>мысль</em>');
        expect(env.chat[0]!.mes).toBe(text);
    });

    it('the hook skips reasoning and plain HTML, and is a no-op while off', async () => {
        await boot();
        const hook = env.hooks[0]!.fn;
        expect(hook('<p><q>"Да"</q></p>', { isReasoning: true, isUser: false })).toBe('<p><q>"Да"</q></p>');
        expect(hook('<p>Просто текст</p>', { isUser: false })).toBe('<p>Просто текст</p>');
        expect(hook('<p><q>"Да"</q></p>', null)).toBe('<p><q class="maestro-ms-dq">"Да"</q></p>');
        edit((value) => {
            value.enabled = false;
        }, 'enabled');
        expect(hook('<p><q>"Да"</q></p>', { isUser: false })).toBe('<p><q>"Да"</q></p>');
    });

    it('uses the plan of the scope: user rules mark only the player’s messages', async () => {
        await boot();
        edit((value) => {
            value.rules = presetRules('player');
        });
        expect(env.format('— Да.', true)).toContain('custom-maestro-ms-dash');
        expect(env.format('— Да.', false)).not.toContain('maestro-ms-dash');
    });

    it('marks messages already on screen, skipping a message being edited', async () => {
        env = createMessageStyleEnv();
        const plain = env.printMessage('— Привет, — сказал он.', false);
        const editing = env.printMessage('— Правлю, — сказал я.', true);
        editing.appendChild(document.createElement('textarea'));
        edit((value) => {
            value.rules = presetRules('book');
        });
        await env.start();
        expect(plain.querySelector('.maestro-ms-dash')).toBeNull();
        vi.advanceTimersByTime(RESTYLE_MS);
        expect(plain.querySelector('.maestro-ms-dash')?.textContent).toBe('— Привет');
        expect(editing.querySelector('.maestro-ms-dash')).toBeNull();
    });

    it('marks visible messages again only when what is marked changes', async () => {
        await boot();
        const body = env.printMessage('— Привет, — сказал он.', false);
        vi.advanceTimersByTime(RESTYLE_MS);
        expect(body.querySelector('[class*="maestro-ms-dash"]')).toBeNull();
        edit((value) => {
            value.rules.find((rule) => rule.id === 'dash')!.enabled = true;
        });
        vi.advanceTimersByTime(RESTYLE_MS);
        expect(body.querySelector('.maestro-ms-dash')?.textContent).toBe('— Привет');
        // A colour change restyles through CSS only: the DOM is left as it is.
        const before = body.innerHTML;
        edit((value) => {
            value.rules.find((rule) => rule.id === 'dash')!.style.color = 'accent';
        });
        vi.advanceTimersByTime(RESTYLE_MS);
        expect(body.innerHTML).toBe(before);
        expect(env.styleText(RULES_STYLE_ID)).toContain('var(--maestro-accent, var(--SmartThemeQuoteColor))');
        env.api().refresh();
        expect(body.querySelector('.maestro-ms-dash')).not.toBeNull();
    });

    it('turning it off removes the class, the sheet and the marks; on brings them back', async () => {
        await boot();
        edit((value) => {
            value.rules = presetRules('book');
        });
        const body = env.printMessage('— Привет, — сказал он. "Да"', false);
        const original = env.chat[0]!.mes;
        expect(body.querySelector('[class*="maestro-ms-"]')).not.toBeNull();
        edit((value) => {
            value.enabled = false;
        }, 'enabled');
        expect(classes()).not.toContain(MESSAGE_STYLE_CLASS);
        expect(env.styleText(RULES_STYLE_ID)).toBeUndefined();
        expect(body.querySelector('[class*="maestro-ms-"]')).toBeNull();
        expect(body.textContent).toBe('— Привет, — сказал он. "Да"');
        expect(env.api().enabled()).toBe(false);
        edit((value) => {
            value.enabled = true;
        }, 'enabled');
        expect(classes()).toContain(MESSAGE_STYLE_CLASS);
        vi.advanceTimersByTime(RESTYLE_MS);
        expect(body.querySelector('.maestro-ms-dash')).not.toBeNull();
        expect(env.chat[0]!.mes).toBe(original);
    });

    it('stopping the module leaves no trace and does not add a second hook on restart', async () => {
        await boot();
        edit((value) => {
            value.rules = presetRules('book');
        });
        const body = env.printMessage('— Привет, — сказал он.', false);
        await env.stop();
        expect(classes()).not.toContain(MESSAGE_STYLE_CLASS);
        expect(env.styleText(RULES_STYLE_ID)).toBeUndefined();
        expect(env.styleText(EDITOR_STYLE_ID)).toBeUndefined();
        expect(env.tabs).toEqual([]);
        expect(env.producers.size).toBe(0);
        expect(body.querySelector('[class*="maestro-ms-"]')).toBeNull();
        expect(env.hooks[0]!.fn('<p><q>"Да"</q></p>', { isUser: false })).toBe('<p><q>"Да"</q></p>');
        await env.start();
        expect(env.hooks).toHaveLength(1);
        expect(classes()).toContain(MESSAGE_STYLE_CLASS);
    });

    it('works on CSS alone without ST’s formatter hook', async () => {
        await boot({ formatter: false });
        expect(env.hooks).toHaveLength(0);
        expect(env.api().annotated()).toBe(false);
        const css = env.styleText(RULES_STYLE_ID)!;
        expect(css).toContain('#chat .mes:not([is_user="true"]) .mes_text q,');
        expect(css).not.toContain('maestro-ms-');
    });

    it('keeps its sheet before ST’s custom CSS', async () => {
        const custom = document.createElement('style');
        custom.id = 'custom-style';
        document.head.appendChild(custom);
        await boot();
        const node = document.head.querySelector(`style[data-maestro-style="${RULES_STYLE_ID}"]`)!;
        expect(node.nextElementSibling).toBe(custom);
    });
});

describe('the hint to the model', () => {
    it('adds nothing while the toggle is off (the default)', async () => {
        await boot();
        await env.generate();
        expect(env.injections).toEqual([]);
    });

    it('adds a system note at depth 1 in the chat language when on', async () => {
        await boot();
        edit((value) => {
            value.hint = true;
        }, 'hint');
        env.chat.push({
            name: 'Мира',
            is_user: false,
            is_system: false,
            send_date: '',
            mes: 'Дождь стучал по крыше таверны, и никто не хотел выходить наружу.',
        });
        await env.generate();
        expect(env.injections).toEqual([
            {
                key: HINT_INJECTION,
                spec: {
                    text: 'Прямую речь пиши в кавычках "…", мысли и выделения — *курсивом*.',
                    position: 1,
                    depth: 1,
                    role: 0,
                    scan: false,
                },
            },
        ]);
    });

    it('follows an English chat, and skips quiet, dry and disabled runs', async () => {
        await boot({ locale: 'ru' });
        edit((value) => {
            value.hint = true;
        }, 'hint');
        env.chat.push({
            name: 'Mira',
            is_user: false,
            is_system: false,
            send_date: '',
            mes: 'The rain drummed on the tavern roof and nobody wanted to go outside.',
        });
        await env.generate({ quiet: true });
        await env.generate({ dryRun: true });
        expect(env.injections).toEqual([]);
        await env.generate();
        expect(env.injections[0]!.spec.text).toBe(
            'Write direct speech in double quotes "…", thoughts and emphasis in *italics*.',
        );
        env.injections.length = 0;
        edit((value) => {
            value.enabled = false;
        }, 'enabled');
        await env.generate();
        expect(env.injections).toEqual([]);
    });

    it('says nothing when the rules ask nothing of the model', async () => {
        await boot();
        edit((value) => {
            value.hint = true;
            value.rules = presetRules('minimal');
        }, 'hint');
        await env.generate();
        expect(env.injections).toEqual([]);
    });
});
