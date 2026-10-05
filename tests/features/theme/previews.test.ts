// @vitest-environment happy-dom
// Clean last-message previews of the chat lists (M32, part «st»): the domain cleaner and the DOM service on fake ST
// markup (welcome panel, «Manage chat files», Top Info Bar side bar), and its wiring into the theme layer.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanPreviewText, stripTrackerTail } from '../../../src/domain/text-clean';
import { PREVIEW_MS } from '../../../src/features/theme/layer';
import {
    PREVIEW_TARGETS,
    PREVIEW_TEXT_ATTR,
    PREVIEW_TITLE_ATTR,
    PreviewCleaner,
} from '../../../src/features/theme/previews';
import { createThemeEnv, resetPage } from './theme-env';
import type { ThemeEnv } from './theme-env';

const TRACKER =
    '```json\n{"quests": {"main": "Find the key"}, "characters": [{"name": "Lyra", "thoughts": "{hm}"}]}\n```';
const STORY = '<font color="#dc143c">Лира</font> улыбнулась. [nai:img:abc123] Дверь открылась.';
const RAW = `${TRACKER}\n\n${STORY}`;
const CLEAN = 'Лира улыбнулась. Дверь открылась.';
/** ST's past-chats preview: '...' + the last 400 characters, here cut inside the tracker. */
const CUT = '...ts": "{hm}"}]}\n```\n\nОна кивнула &lt;b&gt;молча&lt;/b&gt;.';
const DUMP = 'Лира ушла.\n\n<BunnyMoTags>\nLyra:\n• SPECIES: elf\n• PERSONALITY: calm\n</BunnyMoTags>';

const escapeHtml = (text: string) =>
    text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** The page as ST and the Top Info Bar build it (handlebars escapes `{{mes}}`, jQuery `.text()` sets text). */
function buildPage(): void {
    document.body.innerHTML = `
        <div id="sheld"><div id="chat">
            <div class="welcomePanel"><div class="welcomeRecent"><div class="recentChatList">
                <div class="recentChat" data-file="Lyra - 1"><div class="recentChatInfo"><div class="chatMessageContainer">
                    <div class="chatMessage" title="${escapeHtml(RAW)}">
                        ${escapeHtml(RAW)}
                    </div>
                </div></div></div>
                <div class="recentChat" data-file="Lyra - 2"><div class="recentChatInfo"><div class="chatMessageContainer">
                    <div class="chatMessage" title="Привет!">
                        Привет!
                    </div>
                </div></div></div>
            </div></div></div>
            <div class="mes" mesid="0"><div class="mes_text"><p>Story</p></div></div>
        </div></div>
        <div id="shadow_select_chat_popup"><div id="select_chat_popup"><div id="select_chat_div"></div></div></div>
        <div id="movingDivs"><div id="extensionSideBar"><div id="extensionSideBarContainer">
            <div class="sideBarItem"><div class="chatMessageContainer"><div class="chatMessage"></div></div></div>
        </div></div></div>`;
    pastChats([CUT, 'Обычный текст.']);
    document.querySelector('#extensionSideBar .chatMessage')!.textContent = DUMP;
}

/** «Manage chat files» as script.js displayChats renders it: the list emptied and rebuilt. */
function pastChats(previews: string[]): void {
    const list = document.getElementById('select_chat_div')!;
    list.innerHTML = '';
    for (const preview of previews) {
        const wrapper = document.createElement('div');
        wrapper.className = 'select_chat_block_wrapper';
        wrapper.innerHTML = '<div class="select_chat_block"><div class="select_chat_block_mes"></div></div>';
        wrapper.querySelector('.select_chat_block_mes')!.textContent = preview;
        list.appendChild(wrapper);
    }
}

const welcome = () => document.querySelectorAll<HTMLElement>('.welcomeRecent .recentChat .chatMessage');
const past = () => document.querySelectorAll<HTMLElement>('#select_chat_div .select_chat_block_mes');
const side = () => document.querySelector<HTMLElement>('#extensionSideBar .sideBarItem .chatMessage')!;
/** MutationObserver callbacks run after the current task. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

afterEach(() => resetPage());

describe('cleanPreviewText', () => {
    it('drops the DES tracker, NAI placeholders and HTML, collapses whitespace', () => {
        expect(cleanPreviewText(RAW)).toBe(CLEAN);
        expect(cleanPreviewText(`\n      ${RAW}\n   `)).toBe(CLEAN);
    });

    it('removes HTML that was escaped into text too', () => {
        expect(cleanPreviewText('Она &lt;font color="#dc143c"&gt;кивнула&lt;/font&gt;.')).toBe('Она кивнула.');
        expect(cleanPreviewText('<div class="x"><b>Жирно</b></div><style>.x{color:red}</style>')).toBe('Жирно');
    });

    it('keeps the ellipsis of a cut preview and drops the tracker tail before the story', () => {
        expect(cleanPreviewText(CUT)).toBe('...Она кивнула молча.');
        expect(cleanPreviewText('…"main": "key"}}\n\nТекст после.')).toBe('…Текст после.');
        expect(cleanPreviewText('...\n```\n\nСразу после блока.')).toBe('...Сразу после блока.');
        expect(cleanPreviewText('...и тогда она ушла.')).toBe('...и тогда она ушла.');
    });

    it('drops CK dumps and mechanics blocks', () => {
        expect(cleanPreviewText(DUMP)).toBe('Лира ушла.');
        expect(cleanPreviewText('Удар!\n<mechanics>\nKai.Mana: -10\n</mechanics>')).toBe('Удар!');
    });

    it('keeps paragraphs for tooltips', () => {
        expect(cleanPreviewText(`${TRACKER}\n\nПервый.\n\n\n\nВторой.`, { keepLines: true })).toBe(
            'Первый.\n\nВторой.',
        );
    });

    it('gives empty text for noise only and odd input', () => {
        expect(cleanPreviewText(TRACKER)).toBe('');
        expect(cleanPreviewText('...}]}\n```')).toBe('');
        expect(cleanPreviewText('   ')).toBe('');
        expect(cleanPreviewText(undefined as unknown as string)).toBe('');
    });

    it('keeps text that only looks like JSON', () => {
        expect(cleanPreviewText('Он сказал: "ключ" {позже}.')).toBe('Он сказал: "ключ" {позже}.');
        expect(cleanPreviewText('```python\nprint(1)\n```')).toBe('```python print(1) ```');
    });
});

describe('stripTrackerTail', () => {
    it('removes a fenced or unfenced JSON tail only', () => {
        expect(stripTrackerTail('": 1}]}\n```\nТекст')).toBe('Текст');
        expect(stripTrackerTail('"a": [1]}}\n\nТекст')).toBe('Текст');
        expect(stripTrackerTail('Просто текст\n```\nкод\n```')).toBe('Просто текст\n```\nкод\n```');
        expect(stripTrackerTail('{"a": 1}\n\nТекст')).toBe('{"a": 1}\n\nТекст');
        expect(stripTrackerTail('```json\n{"a": 1}}\n```\nТекст')).toBe('```json\n{"a": 1}}\n```\nТекст');
        expect(stripTrackerTail('')).toBe('');
        expect(stripTrackerTail(null as unknown as string)).toBe('');
    });
});

describe('PreviewCleaner', () => {
    let cleaner: PreviewCleaner;

    beforeEach(() => buildPage());
    afterEach(() => cleaner?.stop());

    it('knows ST’s and the Top Info Bar’s preview nodes', () => {
        expect(PREVIEW_TARGETS.map((target) => target.selector)).toEqual([
            '.welcomeRecent .recentChat .chatMessage',
            '#select_chat_div .select_chat_block_mes',
            '#extensionSideBar .sideBarItem .chatMessage',
        ]);
        expect(Object.isFrozen(PREVIEW_TARGETS)).toBe(true);
    });

    it('cleans the previews, keeps the originals in data attributes and restores them on stop', () => {
        cleaner = new PreviewCleaner();
        cleaner.start();
        expect(cleaner.isRunning()).toBe(true);

        const [first, plain] = welcome();
        expect(first!.textContent).toBe(CLEAN);
        expect(first!.getAttribute(PREVIEW_TEXT_ATTR)).toContain('```json');
        expect(first!.getAttribute('title')).toBe(CLEAN);
        expect(first!.getAttribute(PREVIEW_TITLE_ATTR)).toBe(RAW);
        // Nothing to clean: left exactly as ST made it.
        expect(plain!.textContent).toContain('Привет!');
        expect(plain!.hasAttribute(PREVIEW_TEXT_ATTR)).toBe(false);
        expect(plain!.hasAttribute(PREVIEW_TITLE_ATTR)).toBe(false);

        expect([...past()].map((node) => node.textContent)).toEqual(['...Она кивнула молча.', 'Обычный текст.']);
        expect(past()[0]!.getAttribute(PREVIEW_TEXT_ATTR)).toBe(CUT);
        expect(side().textContent).toBe('Лира ушла.');

        cleaner.stop();
        expect(cleaner.isRunning()).toBe(false);
        expect(first!.textContent).toContain('```json');
        expect(first!.textContent).toContain('<font color="#dc143c">');
        expect(first!.getAttribute('title')).toBe(RAW);
        expect(past()[0]!.textContent).toBe(CUT);
        expect(side().textContent).toBe(DUMP);
        expect(document.querySelector(`[${PREVIEW_TEXT_ATTR}], [${PREVIEW_TITLE_ATTR}]`)).toBeNull();
        // Idempotent.
        cleaner.stop();
        expect(past()[0]!.textContent).toBe(CUT);
    });

    it('cleans lists ST re-renders and texts ST rewrites while running', async () => {
        cleaner = new PreviewCleaner();
        cleaner.start();
        cleaner.start();
        pastChats([`${TRACKER}\nНовая глава.`, CUT]);
        await settle();
        expect([...past()].map((node) => node.textContent)).toEqual(['Новая глава.', '...Она кивнула молча.']);

        // jQuery `.text()` on an existing node.
        side().textContent = `${TRACKER}\n\nСвежий ответ.`;
        await settle();
        expect(side().textContent).toBe('Свежий ответ.');
        expect(side().getAttribute(PREVIEW_TEXT_ATTR)).toContain('Свежий ответ.');

        // ST puts a clean text back: the node becomes ST's again.
        side().textContent = 'Чистый текст.';
        await settle();
        expect(side().textContent).toBe('Чистый текст.');
        expect(side().hasAttribute(PREVIEW_TEXT_ATTR)).toBe(false);

        // The welcome screen is rebuilt (refreshWelcomeScreen empties #chat and appends a new panel).
        const chat = document.getElementById('chat')!;
        chat.innerHTML = `<div class="welcomePanel"><div class="welcomeRecent"><div class="recentChatList">
            <div class="recentChat"><div class="chatMessage" title="x">${escapeHtml(RAW)}</div></div>
        </div></div></div>`;
        await settle();
        expect(welcome()[0]!.textContent).toBe(CLEAN);
    });

    it('leaves a text ST wrote after the cleaning alone when it stops', () => {
        cleaner = new PreviewCleaner();
        cleaner.start();
        const node = past()[0]!;
        cleaner.stop();
        cleaner.start();
        expect(node.textContent).toBe('...Она кивнула молча.');
        // ST changes the text node in place (no child list change): Maestro has not seen it.
        node.firstChild!.textContent = 'Новое от ST.';
        cleaner.stop();
        expect(node.textContent).toBe('Новое от ST.');
        expect(node.hasAttribute(PREVIEW_TEXT_ATTR)).toBe(false);
    });

    it('ignores mutations inside chat messages and stops watching when stopped', async () => {
        const clean = vi.fn((text: string, options?: { keepLines?: boolean }) => cleanPreviewText(text, options));
        cleaner = new PreviewCleaner({ clean });
        cleaner.start();
        const calls = clean.mock.calls.length;
        const mes = document.querySelector('#chat .mes_text')!;
        for (let i = 0; i < 5; i++) mes.innerHTML = `<p>Streaming ${i} ${TRACKER}</p>`;
        await settle();
        expect(clean.mock.calls.length).toBe(calls);

        cleaner.stop();
        pastChats([RAW]);
        await settle();
        expect(past()[0]!.textContent).toBe(RAW);
        expect(clean.mock.calls.length).toBe(calls);
    });

    it('reports a failing cleaner instead of throwing', () => {
        const onError = vi.fn();
        cleaner = new PreviewCleaner({
            onError,
            clean: () => {
                throw new Error('boom');
            },
        });
        expect(() => cleaner.start()).not.toThrow();
        expect(onError).toHaveBeenCalled();
        expect(past()[0]!.textContent).toBe(CUT);
    });

    it('sync() turns it on and off', () => {
        cleaner = new PreviewCleaner({ doc: document });
        cleaner.sync(true);
        expect(side().textContent).toBe('Лира ушла.');
        cleaner.sync(false);
        expect(side().textContent).toBe(DUMP);
    });
});

describe('theme layer: clean previews follow the layer and the «st» part', () => {
    let env: ThemeEnv;

    beforeEach(() => {
        resetPage();
        buildPage();
        vi.useFakeTimers();
    });

    afterEach(async () => {
        if (env?.running) await env.stop();
        vi.useRealTimers();
    });

    it('cleans while the layer and the part are on, restores otherwise', async () => {
        env = createThemeEnv();
        await env.start();
        expect(side().textContent).toBe('Лира ушла.');

        await env.api().setPart('st', false);
        expect(side().textContent).toBe(DUMP);
        await env.api().setPart('chat', false);
        expect(side().textContent).toBe(DUMP);
        await env.api().setPart('st', true);
        expect(side().textContent).toBe('Лира ушла.');

        await env.api().setEnabled(false);
        expect(side().textContent).toBe(DUMP);
        await env.api().setEnabled(true);
        expect(past()[0]!.textContent).toBe('...Она кивнула молча.');

        await env.stop();
        expect(past()[0]!.textContent).toBe(CUT);
        expect(document.querySelector(`[${PREVIEW_TEXT_ATTR}]`)).toBeNull();
    });

    it('shows the originals during «Как было» and cleans again after it', async () => {
        env = createThemeEnv();
        await env.start();
        const container = document.createElement('div');
        document.body.appendChild(container);
        env.tabs[0]!.render(container);
        container.querySelector<HTMLButtonElement>('[data-m32-control="compare"]')!.click();
        expect(welcome()[0]!.textContent).toContain('```json');
        await vi.advanceTimersByTimeAsync(PREVIEW_MS);
        expect(welcome()[0]!.textContent).toBe(CLEAN);
    });

    it('starts without cleaning when the part is off', async () => {
        env = createThemeEnv();
        env.slices.theme = { parts: { st: false } };
        await env.start();
        expect(side().textContent).toBe(DUMP);
    });
});
