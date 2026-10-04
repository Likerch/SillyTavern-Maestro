// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { bunnymoTagsRule } from '../../../src/features/rules/builtin/display';
import {
    CK_BUTTON_CSS,
    DES_PORTRAIT_BAR_CSS,
    collapsePortraitBarOnce,
    ckButtonRule,
    desPortraitBarRule,
} from '../../../src/features/rules/builtin/ui';
import { RulesEngine } from '../../../src/features/rules/engine';
import type { RuleEnv } from '../../../src/features/rules/env';
import { createRulesTestApp } from '../../helpers/rules-app';
import type { RulesTestApp } from '../../helpers/rules-app';
import { startRules } from '../../helpers/rules-module';

const INFO = { messageId: 1, isSystem: false, isUser: false, stage: 'afterRegex' };

let env: RulesTestApp;
let ruleEnv: RuleEnv;

beforeEach(() => {
    env = createRulesTestApp();
    ruleEnv = new RulesEngine(env.app, env.log).env();
});

afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
});

describe('display.bunnymoTags', () => {
    it('adds one synchronous afterRegex hook that escapes BunnyMo tags only while the rule runs', () => {
        const rule = bunnymoTagsRule(ruleEnv);
        const stop = rule.start!() as () => void;
        expect(env.hooks).toHaveLength(1);
        const hook = env.hooks[0]!;
        expect(hook.options).toEqual({ stage: 'afterRegex' });
        expect(hook.fn.constructor.name).toBe('Function');
        expect(hook.fn('<SPECIES:ELF> <INTJ-U> <b>bold</b>', INFO)).toBe(
            '&lt;SPECIES:ELF&gt; &lt;INTJ-U&gt; <b>bold</b>',
        );

        stop();
        expect(hook.fn('<SPECIES:ELF>', INFO)).toBe('<SPECIES:ELF>');

        // ST has no removeHook: starting again reuses the same hook.
        const stopAgain = rule.start!() as () => void;
        expect(env.hooks).toHaveLength(1);
        expect(hook.fn('<SPECIES:ELF>', INFO)).toBe('&lt;SPECIES:ELF&gt;');
        stopAgain();
    });

    it('runs before the wizard and goes quiet when the module stops', async () => {
        const rules = await startRules(env);
        const hook = env.hooks[0]!;
        expect(hook.fn('<TRAIT:STOIC>', INFO)).toBe('&lt;TRAIT:STOIC&gt;');
        await rules.stop();
        expect(hook.fn('<TRAIT:STOIC>', INFO)).toBe('<TRAIT:STOIC>');
    });

    it('does nothing without a message formatter', () => {
        (env.mock.context as unknown as Record<string, unknown>).messageFormatter = undefined;
        expect(bunnymoTagsRule(ruleEnv).start!()).toBeUndefined();
    });
});

describe('ui.ckVectorizeButton', () => {
    it('adds and removes its stylesheet', () => {
        const stop = ckButtonRule(ruleEnv).start!() as () => void;
        expect(env.ui.styles.get('m22-ck-vectorize-button')).toBe(CK_BUTTON_CSS);
        stop();
        expect(env.ui.styles.has('m22-ck-vectorize-button')).toBe(false);
    });

    it('moves the button with !important rules and hides it while editing', () => {
        expect(CK_BUTTON_CSS).toContain('.mes > .carrot-rag-fullsheet-button');
        expect(CK_BUTTON_CSS).toMatch(/top: auto !important/);
        expect(CK_BUTTON_CSS).toMatch(
            /\.mes:has\(\.edit_textarea\) > \.carrot-rag-fullsheet-button \{\s*display: none !important/,
        );
    });
});

describe('ui.desPortraitBarMobile', () => {
    function desToggle(open: boolean): { toggle: HTMLElement; clicks: () => number } {
        document.body.innerHTML =
            '<div id="dooms-portrait-bar-wrapper" class="dooms-pb-position-right">' +
            `<div class="dooms-pb-toggle${open ? ' dooms-pb-open' : ''}" id="dooms-pb-toggle"></div>` +
            '<div class="dooms-portrait-bar" id="dooms-portrait-bar"></div></div>';
        const toggle = document.getElementById('dooms-pb-toggle')!;
        let count = 0;
        // DES's own handler (portraitBar.js): flips the classes.
        toggle.addEventListener('click', () => {
            count += 1;
            toggle.classList.toggle('dooms-pb-open');
            document.getElementById('dooms-portrait-bar-wrapper')!.classList.toggle('dooms-pb-collapsed-side');
        });
        return { toggle, clicks: () => count };
    }

    it('styles only through a mobile media query', () => {
        expect(DES_PORTRAIT_BAR_CSS.trim().startsWith('@media (max-width: 1000px)')).toBe(true);
        expect(DES_PORTRAIT_BAR_CSS).toContain('#dooms-portrait-bar-wrapper.dooms-pb-position-left');
        expect(DES_PORTRAIT_BAR_CSS).toContain('max-height: min(45vh, 340px) !important');
    });

    it('collapses an expanded bar once with DES’s own toggle on narrow screens', () => {
        const { toggle, clicks } = desToggle(true);
        collapsePortraitBarOnce(env.log, { isNarrow: () => true })();
        expect(clicks()).toBe(1);
        expect(toggle.classList.contains('dooms-pb-open')).toBe(false);
        toggle.click(); // the user opens it again
        collapsePortraitBarOnce(env.log, { isNarrow: () => true })();
        expect(clicks()).toBe(2);
        expect(toggle.classList.contains('dooms-pb-open')).toBe(true);
    });

    it('leaves a collapsed bar and wide screens alone', () => {
        const { clicks } = desToggle(false);
        collapsePortraitBarOnce(env.log, { isNarrow: () => true })();
        expect(clicks()).toBe(0);
        const wide = desToggle(true);
        collapsePortraitBarOnce(env.log, { isNarrow: () => false })();
        expect(wide.clicks()).toBe(0);
    });

    it('waits for DES to build its bar, and gives up after the attempts', () => {
        vi.useFakeTimers();
        document.body.innerHTML = '';
        const stop = collapsePortraitBarOnce(env.log, { isNarrow: () => true, intervalMs: 100, attempts: 5 });
        vi.advanceTimersByTime(200);
        const { clicks } = desToggle(true);
        vi.advanceTimersByTime(100);
        expect(clicks()).toBe(1);
        stop();

        document.body.innerHTML = '';
        const never = collapsePortraitBarOnce(env.log, { isNarrow: () => true, intervalMs: 100, attempts: 2 });
        vi.advanceTimersByTime(1000);
        const late = desToggle(true);
        vi.advanceTimersByTime(1000);
        expect(late.clicks()).toBe(0);
        never();
    });

    it('adds the stylesheet and stops polling when the rule stops', () => {
        vi.useFakeTimers();
        const stop = desPortraitBarRule(ruleEnv).start!() as () => void;
        expect(env.ui.styles.get('m22-des-portrait-bar')).toBe(DES_PORTRAIT_BAR_CSS);
        stop();
        expect(env.ui.styles.has('m22-des-portrait-bar')).toBe(false);
    });
});
