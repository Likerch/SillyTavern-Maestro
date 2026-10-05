// @vitest-environment happy-dom
import { afterEach, describe, expect, it } from 'vitest';
import { CHAT_GATE, chatCss } from '../../../src/features/theme/css-chat';
import { ST_GATE, TOP_BAR_PADDING, stCss } from '../../../src/features/theme/css-st';
import { ALL_PARTS, defaultThemeSettings, isThemePart, readThemeSettings } from '../../../src/features/theme/settings';
import type { ThemeSettings } from '../../../src/features/theme/settings';
import { ST_THEME_VARS, THEME_TOKENS, buildTokensCss, readStTheme } from '../../../src/features/theme/tokens';
import { THEME_CSS } from '../../../src/features/theme/view';
import { resetPage } from './theme-env';

afterEach(() => resetPage());

/** Selectors of every style rule (inside @media/@supports too), split at top-level commas. */
function selectors(css: string): string[] {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: string[] = [];
    let prelude = '';
    for (const char of text) {
        if (char === '{') {
            const head = prelude.trim();
            if (!head.startsWith('@')) out.push(...splitTopLevel(head));
            prelude = '';
        } else if (char === '}' || char === ';') {
            prelude = '';
        } else {
            prelude += char;
        }
    }
    return out;
}

function splitTopLevel(list: string): string[] {
    const parts: string[] = [];
    let depth = 0;
    let current = '';
    for (const char of list) {
        if (char === '(') depth++;
        if (char === ')') depth--;
        if (char === ',' && depth === 0) {
            parts.push(current.trim());
            current = '';
        } else {
            current += char;
        }
    }
    if (current.trim()) parts.push(current.trim());
    return parts;
}

/** Every style rule (inside @media/@supports too): its selectors, its declarations and the at-rules around it. */
function rules(css: string): { selectors: string[]; body: string; within: string[] }[] {
    const text = css.replace(/\/\*[\s\S]*?\*\//g, '');
    const out: { selectors: string[]; body: string; within: string[] }[] = [];
    const stack: string[] = [];
    let prelude = '';
    let current: { selectors: string[]; body: string; within: string[] } | null = null;
    for (const char of text) {
        if (current) {
            if (char === '}') {
                out.push(current);
                current = null;
            } else {
                current.body += char;
            }
        } else if (char === '{') {
            const head = prelude.trim();
            if (head.startsWith('@')) stack.push(head);
            else current = { selectors: splitTopLevel(head), body: '', within: [...stack] };
            prelude = '';
        } else if (char === '}') {
            stack.pop();
            prelude = '';
        } else {
            prelude += char;
        }
    }
    return out;
}

/** Desktop part of a sheet: the phone media blocks (any query ending at ST's 1000px breakpoint) removed. */
const desktopOnly = (css: string) => css.replace(/@media screen and [^{]*\(max-width: 1000px\) \{[\s\S]*?\n\}/g, '');

const balanced = (css: string) => {
    let depth = 0;
    for (const char of css) {
        if (char === '{') depth++;
        if (char === '}') depth--;
        expect(depth).toBeGreaterThanOrEqual(0);
    }
    return depth === 0;
};

const sheets = [
    { name: 'st comfortable', css: stCss('comfortable'), gate: ST_GATE },
    { name: 'st compact', css: stCss('compact'), gate: ST_GATE },
    { name: 'chat comfortable', css: chatCss('comfortable'), gate: CHAT_GATE },
    { name: 'chat compact', css: chatCss('compact'), gate: CHAT_GATE },
];

describe('restyle stylesheets', () => {
    it.each(sheets)('$name: every selector is gated by the layer and the part', ({ css, gate }) => {
        expect(gate).toMatch(/^:where\(html\.maestro-theme\.maestro-theme-(st|chat)\)$/);
        const list = selectors(css);
        expect(list.length).toBeGreaterThan(20);
        for (const selector of list) expect(selector.startsWith(gate)).toBe(true);
        expect(balanced(css)).toBe(true);
    });

    it.each(sheets)('$name: no !important, only known tokens', ({ css }) => {
        expect(css).not.toContain('!important');
        const used = new Set([...css.matchAll(/var\((--maestro-[a-z0-9-]+)/g)].map((match) => match[1]));
        expect(used.size).toBeGreaterThan(5);
        for (const name of used) expect(THEME_TOKENS).toContain(name);
    });

    it('never touches layout properties of ST elements (sizes only for touch targets on phones)', () => {
        const all = sheets.map((sheet) => sheet.css).join('\n');
        expect(all).not.toMatch(/(^|[\s;{])(display|position|top|left|right|bottom|float|overflow)\s*:/m);
        expect(desktopOnly(all)).not.toMatch(/(^|[\s;{])(width|height|min-width|min-height)\s*:/m);
        // The only margin: the gap between compact bubbles (ST's own rule sets 5px).
        const margins = [...all.matchAll(/(?:^|[\s;{])(margin[a-z-]*\s*:[^;]*;)/gm)].map((match) => match[1]);
        expect(margins).toEqual(['margin-bottom: var(--maestro-space-1);']);
    });

    it('changes padding only at the compact density, and the composer’s text area (inside ST’s block size)', () => {
        const padded = (css: string) =>
            rules(css)
                .filter((rule) => /(^|[\s;])padding\s*:/.test(rule.body))
                .flatMap((rule) => rule.selectors);
        expect(padded(stCss('comfortable'))).toEqual([]);
        expect(stCss('compact')).toMatch(/padding: var\(--maestro-control-py\)/);
        expect(padded(chatCss('comfortable'))).toEqual([`${CHAT_GATE} #send_textarea`]);
        expect(chatCss('comfortable')).toContain('padding: 6px var(--maestro-space-2);');
        expect(chatCss('compact')).toMatch(/padding: var\(--maestro-mes-pad\)/);
    });

    it('sets only ST’s top bar variables, only at the comfortable density, only under the gate and never on iOS', () => {
        const custom = (css: string) =>
            rules(css).flatMap((rule) =>
                [...rule.body.matchAll(/(?:^|[\s;])(--[\w-]+)\s*:\s*([^;]+);/g)].map((match) => ({
                    name: match[1],
                    value: match[2]!.trim(),
                    selectors: rule.selectors,
                    within: rule.within,
                })),
            );
        const comfortable = custom(stCss('comfortable'));
        expect(comfortable.map((item) => item.name)).toEqual(['--topBarBlockPadding', '--bottomFormBlockSize']);
        expect(comfortable[0]).toEqual({
            name: '--topBarBlockPadding',
            value: TOP_BAR_PADDING,
            selectors: [`${ST_GATE}:root`],
            within: ['@supports not (-webkit-touch-callout: none)'],
        });
        expect(comfortable[1]).toEqual({
            name: '--bottomFormBlockSize',
            value: 'var(--topBarBlockSize)',
            selectors: [`${ST_GATE} #top-bar`],
            within: ['@supports not (-webkit-touch-callout: none)'],
        });
        // ST's value: calc(var(--mainFontSize) / 3).
        expect(TOP_BAR_PADDING).toBe('calc(var(--mainFontSize) / 1.6)');
        expect(custom(stCss('compact'))).toEqual([]);
        expect(custom(chatCss('comfortable'))).toEqual([]);
        expect(custom(chatCss('compact'))).toEqual([]);
        // The bar keeps its elevation and divider.
        expect(stCss('comfortable')).toContain(
            `${ST_GATE} #top-bar {\n    box-shadow: var(--maestro-elevation-2);\n    border-bottom: 1px solid var(--maestro-divider);`,
        );
    });

    it('applies the top bar variable only while the layer and the part are on', () => {
        const html = document.documentElement;
        // The gate is the condition: the rule's selector matches <html> only with both classes.
        const selector = `${ST_GATE}:root`;
        expect(html.matches(selector)).toBe(false);
        html.classList.add('maestro-theme');
        expect(html.matches(selector)).toBe(false);
        html.classList.add('maestro-theme-st');
        expect(html.matches(selector)).toBe(true);
        html.classList.remove('maestro-theme');
        expect(html.matches(selector)).toBe(false);
    });

    it('styles the start page, chat files, personas, the chat bar and the composer', () => {
        const st = selectors(stCss('comfortable'));
        for (const selector of [
            '.welcomePanel',
            '.welcomeRecent .recentChatList .recentChat',
            '.welcomeRecent .recentChatList .recentChat:hover',
            '.welcomeRecent .recentChatList .recentChat:has(.recentChatPinned)',
            '.welcomeRecent .recentChatList .recentChat .chatMessageContainer .chatMessage',
            '.welcomeRecent .recentChatList .recentChat .chatActions .pinChat.active',
            '.welcomeRecent .recentChatList .showMoreChats',
            '.welcomePanel .welcomeShortcuts .menu_button',
            'body:not(.bubblechat) #chat .mes[type="assistant_message"]:not(.selected)',
            '#chat .mes[type="welcome_prompt"] .drawer-opener',
            '#select_chat_popup',
            '#select_chat_search',
            '.select_chat_block',
            '.select_chat_block[highlight]',
            '.select_chat_block_mes',
            '.avatar-container.selected',
            '#persona-management-block .avatar_container_states .menu_button',
            '#persona_description',
            '#persona_connections_buttons .menu_button.locked',
            '#sheld #extensionTopBar',
            '#sheld #extensionTopBarChatName',
            '#sheld #extensionTopBarSearchInput',
            '#movingDivs #extensionSideBar #extensionSideBarContainer .sideBarItem',
        ]) {
            expect(st, selector).toContain(`${ST_GATE} ${selector}`);
        }
        // The Top Info Bar loads its sheet after Maestro's: its elements are outranked by one more id.
        for (const selector of st.filter((item) => /#extension(TopBar|SideBar|ConnectionProfiles)/.test(item))) {
            expect(selector.startsWith(`${ST_GATE} #sheld #`) || selector.startsWith(`${ST_GATE} #movingDivs #`)).toBe(
                true,
            );
        }
        // The send form moved to the «chat» part.
        expect(st.some((selector) => selector.includes('#send_form'))).toBe(false);
        const chat = selectors(chatCss('comfortable'));
        for (const selector of [
            '#send_form',
            '#send_form:has(#send_textarea:focus-visible)',
            '#send_textarea',
            '#send_textarea::placeholder',
            '#rightSendForm>div:not(.mes_stop)',
            '#leftSendForm>div',
            '#rightSendForm>div:focus-visible',
            '#send_form #qr--bar>.qr--buttons .qr--button',
        ]) {
            expect(chat, selector).toContain(`${CHAT_GATE} ${selector}`);
        }
    });

    it('gives the composer 16px text and touch-sized icons on phones only', () => {
        const phone = rules(chatCss('comfortable')).filter((rule) => rule.within.some((at) => at.includes('1000px')));
        const textarea = phone.find((rule) => rule.selectors.includes(`${CHAT_GATE} #send_textarea`));
        expect(textarea?.body).toContain('font-size: max(16px, var(--mainFontSize));');
        const icons = phone.filter((rule) => rule.selectors.includes(`${CHAT_GATE} #leftSendForm>div`));
        expect(icons.map((rule) => rule.body.trim())).toEqual([
            'min-height: var(--maestro-touch);',
            'min-width: var(--maestro-touch);',
        ]);
        // Square targets only where ST's icon columns are not 1.15em wide (portrait phones, ≤ 450px).
        expect(icons[1]!.within).toEqual(['@media screen and (min-width: 451px) and (max-width: 1000px)']);
        const desktop = rules(desktopOnly(chatCss('comfortable')));
        expect(desktop.some((rule) => /font-size/.test(rule.body) && rule.selectors.join().includes('#send'))).toBe(
            false,
        );
    });

    it('lets Maestro’s own dialogs and buttons keep their phone sizes and colours', () => {
        const list = selectors(stCss('comfortable'));
        // Plain `.popup` (ST's specificity): `.popup.maestro-*-dialog { border-radius: 0 }` on phones still wins.
        expect(list.filter((selector) => /\.popup(?![-\w])/.test(selector) && !selector.includes(' .popup '))).toEqual([
            `${ST_GATE} .popup`,
        ]);
        const sized = list.filter(
            (selector) => /\.menu_button(?![-\w])/.test(selector) && !selector.includes(':hover'),
        );
        expect(sized).toContain(`${ST_GATE} .menu_button:where(:not(.maestro-btn))`);
    });

    it('the settings view sheet is Maestro’s own (not gated) and balanced', () => {
        expect(balanced(THEME_CSS)).toBe(true);
        for (const selector of selectors(THEME_CSS)) expect(selector.startsWith('.maestro-m32')).toBe(true);
    });
});

describe('tokens on the page', () => {
    it('lists every token the layer defines, including the documented ones', () => {
        for (const name of [
            '--maestro-radius-sm',
            '--maestro-radius-md',
            '--maestro-radius-lg',
            '--maestro-space-1',
            '--maestro-space-4',
            '--maestro-font-ui',
            '--maestro-font-chat',
            '--maestro-surface-1',
            '--maestro-surface-2',
            '--maestro-surface-3',
            '--maestro-border',
            '--maestro-accent',
            '--maestro-accent-soft',
            '--maestro-text-muted',
            '--maestro-shadow',
            '--maestro-blur',
        ]) {
            expect(THEME_TOKENS).toContain(name);
        }
        expect(Object.isFrozen(THEME_TOKENS)).toBe(true);
    });

    it('reads ST’s theme from <html> and the body classes', () => {
        const html = document.documentElement;
        html.style.setProperty('--SmartThemeBodyColor', 'rgba(171, 198, 223, 1)');
        html.style.setProperty('--blurStrength', '11');
        html.style.setProperty('--sheldWidth', '55vw');
        document.body.classList.add('no-blur', 'noShadows');
        const input = readStTheme(document);
        expect(input).toMatchObject({
            body: 'rgba(171, 198, 223, 1)',
            blurStrength: '11',
            chatWidth: '55vw',
            noBlur: true,
            noShadows: true,
        });
        expect(input.quote).toBeUndefined();
        expect(Object.values(ST_THEME_VARS)).toContain('--SmartThemeQuoteColor');

        const css = buildTokensCss(input, { density: 'comfortable', radiusScale: 1 });
        expect(css).toContain('html.maestro-theme {');
        expect(css).toContain('--maestro-text: rgb(171, 198, 223);');
        expect(css).toContain('--maestro-blur: 0px;');
        expect(css).toContain('--maestro-elevation-2: none;');
        expect(css).toContain('--maestro-chat-width: 55vw;');
    });

    it('prefers values a custom CSS set on <body>', () => {
        document.documentElement.style.setProperty('--SmartThemeQuoteColor', 'rgb(1, 1, 1)');
        document.body.style.setProperty('--SmartThemeQuoteColor', 'rgb(200, 100, 50)');
        expect(readStTheme(document).quote).toBe('rgb(200, 100, 50)');
    });
});

describe('settings', () => {
    it('defaults: on, every part on, comfortable, normal corners', () => {
        const defaults = defaultThemeSettings();
        expect(defaults).toMatchObject({ enabled: true, density: 'comfortable', radiusScale: 1 });
        expect(Object.keys(defaults.parts)).toEqual([...ALL_PARTS]);
        expect(Object.values(defaults.parts).every(Boolean)).toBe(true);
    });

    it('repairs a damaged slice in place', () => {
        const slice = { enabled: 'yes', parts: { st: false, chat: 'no' }, density: 'huge', radiusScale: 7 };
        const settings = readThemeSettings(slice as unknown as Partial<ThemeSettings>);
        expect(settings).toBe(slice);
        expect(settings.enabled).toBe(true);
        expect(settings.parts.st).toBe(false);
        expect(settings.parts.chat).toBe(true);
        expect(settings.parts.localizer).toBe(true);
        expect(settings.density).toBe('comfortable');
        expect(settings.radiusScale).toBe(2);
        expect(readThemeSettings({ parts: [] as never }).parts.des).toBe(true);
        expect(readThemeSettings({ radiusScale: 'x' as never }).radiusScale).toBe(1);
    });

    it('knows the parts', () => {
        expect(isThemePart('qvink')).toBe(true);
        expect(isThemePart('bunnymo')).toBe(false);
        expect(isThemePart(3)).toBe(false);
    });
});
