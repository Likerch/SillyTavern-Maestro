// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAESTRO_SLOTS } from '../../../src/domain/prompt-audit-map';
import { MARK_ORDER, REFRESH_MS, WRAP_ORDER } from '../../../src/features/sceneSplit';
import { MAESTRO_INJECTIONS } from '../../../src/features/neighbourPrompts/descriptors';
import { WORKSHOP_KEEPS } from '../../../src/features/workshop';
import { MODULES } from '../../../src/app/registry';
import { coreChat, createSceneSplitEnv, reply, said } from './env';
import type { SceneSplitEnv } from './env';

const SLOT = 'maestro_sceneSplit';
const SCENE = 'Вера налила чай и села напротив.';
const AROUND = 'Тем временем Мира продала травы капитану.';
const WITH_BLOCK = `${SCENE}\n\n<offscreen>${AROUND}</offscreen>`;

let env: SceneSplitEnv;

beforeEach(async () => {
    vi.useFakeTimers();
    document.body.innerHTML = '';
    env = await createSceneSplitEnv();
});

afterEach(async () => {
    await env.stop();
    vi.useRealTimers();
});

describe('the module', () => {
    it('is M43 at the end of the registry, a story module paused in workshop chats', () => {
        const module = MODULES.find((item) => item.key === 'sceneSplit');
        expect(module?.id).toBe('M43');
        expect(MODULES[MODULES.length - 1]).toBe(module);
        expect(WORKSHOP_KEEPS).not.toContain('sceneSplit');
        expect(MAESTRO_SLOTS[SLOT]).toBe('sceneSplit');
        expect(MAESTRO_INJECTIONS.some((item) => item.slot === SLOT)).toBe(true);
    });

    it('exposes its API and takes everything back when stopped', async () => {
        const api = await env.start();
        expect(env.api()).toBe(api);
        expect(api.active()).toBe(true);
        expect(api.tag).toBe('offscreen');
        expect(env.ui.styles.has('maestro-m43')).toBe(true);
        expect(env.sections.map((section) => section.id)).toEqual(['sceneSplit']);
        await env.stop();
        expect(api.active()).toBe(false);
        expect(api.departed()).toEqual([]);
        expect(env.ui.styles.has('maestro-m43')).toBe(false);
        expect(env.sections).toEqual([]);
        expect(env.turn.handlers.size).toBe(0);
    });
});

describe('the instruction', () => {
    it('every normal generation gets one system note at depth 0, cleared after it', async () => {
        await env.start();
        env.mock.chat = [said('Привет, я вхожу в таверну и сажусь у огня.'), reply(SCENE)];
        const seen = await env.generate();
        const slot = seen.get(SLOT);
        expect(slot).toMatchObject({ position: 1, depth: 0, role: 0 });
        expect(slot?.value).toContain('<offscreen>…</offscreen>');
        expect(slot?.value).toContain('in Russian');
        expect(slot?.value).toContain('Кай (the player)');
        expect(env.slots.has(SLOT)).toBe(false);
        for (const type of ['swipe', 'regenerate', 'continue'])
            expect((await env.generate({ type })).has(SLOT)).toBe(true);
    });

    it('not for quiet calls, impersonation, dry runs, sheet commands, without a chat or while off', async () => {
        await env.start();
        expect((await env.generate({ quiet: true, type: 'quiet' })).has(SLOT)).toBe(false);
        expect((await env.generate({ type: 'impersonate' })).has(SLOT)).toBe(false);
        expect((await env.generate({ dryRun: true })).has(SLOT)).toBe(false);
        expect((await env.generate({ sheetCommand: '!fullsheet' })).has(SLOT)).toBe(false);
        env.mock.chatId = undefined;
        expect((await env.generate()).has(SLOT)).toBe(false);
        env.mock.chatId = 'chat-1';
        env.set('enabled', false);
        expect((await env.generate()).has(SLOT)).toBe(false);
        env.set('enabled', true);
        expect((await env.generate()).has(SLOT)).toBe(true);
    });

    it('asks for the block in the language of the story', async () => {
        env = await createSceneSplitEnv('en');
        await env.start();
        env.mock.chat = [said('I walk into the tavern and sit down by the fire without a word.')];
        expect((await env.generate()).get(SLOT)?.value).toContain('in English');
    });
});

describe('the prompt', () => {
    function chatWithBlocks(): STChatMessage[] {
        return [
            said('Начало.'),
            reply(`Первый ответ.\n<offscreen>Старое событие.</offscreen>`),
            said('Дальше.'),
            reply(`Второй ответ.\n<offscreen>Среднее событие.</offscreen>`),
            said('Ещё.'),
            reply(`Третий ответ.\n<offscreen>Новое событие.</offscreen>`),
            said('И ещё.'),
        ];
    }

    it('the two newest replies keep one bracket line, older ones lose the block — as copies', async () => {
        await env.start();
        env.mock.chat = chatWithBlocks();
        const core = coreChat(env.mock.chat);
        expect(core[1]!.mes).toBe('Первый ответ.Старое событие.');
        const before = [...core];
        await env.turn.intercept(core, { type: 'normal' });
        expect(core[1]!.mes).toBe('Первый ответ.');
        expect(core[3]!.mes).toBe('Второй ответ.\n\n[Elsewhere, not in the scene: Среднее событие.]');
        expect(core[5]!.mes).toBe('Третий ответ.\n\n[Elsewhere, not in the scene: Новое событие.]');
        expect(core[5]).not.toBe(before[5]);
        expect(core[5]!.extra).toBe(before[5]!.extra);
        expect(core[0]).toBe(before[0]);
        expect(env.mock.chat[5]!.mes).toContain('<offscreen>Новое событие.</offscreen>');
    });

    it('follows the setting, a continuation and the switch', async () => {
        await env.start();
        env.mock.chat = chatWithBlocks();
        env.set('keepRecent', 0);
        let core = coreChat(env.mock.chat);
        await env.turn.intercept(core);
        expect(core.map((entry) => entry.mes).join(' ')).not.toContain('событие');

        env.set('keepRecent', 1);
        env.mock.chat.pop();
        core = coreChat(env.mock.chat);
        await env.turn.intercept(core, { type: 'continue' });
        expect(core[5]!.mes).toBe('Третий ответ.');
        expect(core[3]!.mes).toContain('[Elsewhere, not in the scene: Среднее событие.]');
        expect(core[1]!.mes).toBe('Первый ответ.');

        env.set('enabled', false);
        core = coreChat(env.mock.chat);
        await env.turn.intercept(core);
        expect(core[5]!.mes).toBe('Третий ответ.Новое событие.');
        env.set('enabled', true);
        core = coreChat(env.mock.chat);
        await env.turn.intercept(core, { dryRun: true });
        expect(core[5]!.mes).toBe('Третий ответ.Новое событие.');
    });

    it('rewrites in place when no regex stripped the tags, and caches the regex runs', async () => {
        await env.start();
        env.mock.chat = chatWithBlocks();
        let core = coreChat(env.mock.chat, (text) => text);
        await env.turn.intercept(core);
        expect(core[5]!.mes).toBe('Третий ответ.\n\n[Elsewhere, not in the scene: Новое событие.]');
        expect(env.regexRuns).toBe(0);

        core = coreChat(env.mock.chat);
        await env.turn.intercept(core);
        const runs = env.regexRuns;
        expect(runs).toBeGreaterThan(0);
        core = coreChat(env.mock.chat);
        await env.turn.intercept(core);
        expect(env.regexRuns).toBe(runs);
        expect(core[3]!.mes).toContain('[Elsewhere');
    });

    it('without the regex engine a stripped block is left as it is', async () => {
        env.caps.delete('st.regex');
        await env.start();
        env.mock.chat = chatWithBlocks();
        const core = coreChat(env.mock.chat);
        await env.turn.intercept(core);
        expect(core[5]!.mes).toBe('Третий ответ.Новое событие.');
    });
});

describe('the folded block', () => {
    it('two formatter hooks: before the regexes and after Markdown, before NAI Studio and the message style', async () => {
        await env.start();
        expect(env.hooks.map((hook) => hook.options)).toEqual([
            { stage: 'beforeRegex', order: MARK_ORDER },
            { stage: 'afterMarkdown', order: WRAP_ORDER },
        ]);
        expect(WRAP_ORDER).toBeLessThan(50);
    });

    it('a reply shows the scene, then one folded «Вокруг»; the player’s messages are left alone', async () => {
        await env.start();
        const html = env.format(`${WITH_BLOCK}\n\nЕщё абзац сцены.`);
        expect(html.indexOf('Ещё абзац сцены.')).toBeLessThan(html.indexOf('<details'));
        const holder = document.createElement('div');
        holder.innerHTML = html;
        const box = holder.querySelector('details.custom-maestro-around-box');
        expect(box?.querySelector('summary')?.textContent).toBe('Вокруг');
        expect(box?.textContent).toContain(AROUND);
        expect(holder.querySelector('div.custom-maestro-around')?.getAttribute('style')).toContain('margin');
        expect(html).not.toContain('MAESTROAROUND');
        expect(env.format(WITH_BLOCK, true)).not.toContain('<details');
    });

    it('the label comes from the setting; off, the block reads as SillyTavern draws it', async () => {
        await env.start();
        env.set('label', 'Тем временем');
        expect(env.format(WITH_BLOCK)).toContain('>Тем временем</summary>');
        env.set('enabled', false);
        const plain = env.format(WITH_BLOCK);
        expect(plain).not.toContain('<details');
        expect(plain).toContain(AROUND);
    });

    it('messages drawn before the start are drawn again (and announced); back when it stops', async () => {
        env.mock.chat = [said('Привет.'), reply(WITH_BLOCK), said('Дальше.'), reply(SCENE)];
        env.print();
        expect(env.textOf(1).querySelector('details')).toBeNull();
        await env.start();
        await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
        expect(env.rendered).toEqual([1]);
        expect(env.updated).toEqual([1]);
        expect(env.textOf(1).querySelector('details summary')?.textContent).toBe('Вокруг');

        env.set('label', 'Снаружи');
        await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
        expect(env.rendered).toEqual([1, 1]);
        expect(env.textOf(1).querySelector('summary')?.textContent).toBe('Снаружи');

        await env.stop();
        expect(env.rendered).toEqual([1, 1, 1]);
        expect(env.textOf(1).querySelector('details')).toBeNull();
    });

    it('a message open in the editor is not drawn again', async () => {
        env.mock.chat = [said('Привет.'), reply(WITH_BLOCK)];
        env.print();
        env.textOf(1).appendChild(Object.assign(document.createElement('textarea'), { className: 'edit_textarea' }));
        await env.start();
        await vi.advanceTimersByTimeAsync(REFRESH_MS + 10);
        expect(env.rendered).toEqual([]);
    });

    it('without ST’s message formatter nothing is hooked and the settings say why', async () => {
        env.caps.delete('st.messageFormatter');
        const api = await env.start();
        expect(env.hooks).toEqual([]);
        expect(api.hooked()).toBe(false);
        const container = document.createElement('div');
        env.sections[0]!.render(container);
        expect(container.textContent).toContain('нет обработчика сообщений');
    });
});

describe('departures', () => {
    it('who the committed narration shows leaving is out; the persona and hidden names are no candidates', async () => {
        const api = await env.start();
        env.mock.chat = [
            said('Привет.'),
            reply('Вера кивнула Мартину и вышла из таверны. Кай остался.', ['Вера', 'Мартин', 'Кай']),
            said('Я смотрю на Мартина.'),
        ];
        expect(api.departed()).toEqual(['Вера']);
        expect(api.departed()).toEqual(['Вера']);
        env.des.removed = ['Вера'];
        expect(api.departed()).toEqual([]);
        env.des.removed = [];
        env.set('enabled', false);
        expect(api.departed()).toEqual([]);
    });

    it('the newest reply counts with `latest`; a later reply where they act brings them back', async () => {
        const api = await env.start();
        env.mock.chat = [said('Привет.'), reply('Мартин налил чай.', ['Вера', 'Мартин']), said('Дальше.')];
        env.mock.chat.push(reply('Вера ушла.', ['Вера', 'Мартин']));
        expect(api.departed()).toEqual([]);
        expect(api.departed(undefined, { latest: true })).toEqual(['Вера']);
        env.mock.chat.push(said('Жду.'), reply('Вера вернулась и села рядом.', ['Вера', 'Мартин']), said('Ну?'));
        expect(api.departed()).toEqual([]);
        expect(api.departed([{ broken: true }])).toEqual([]);
    });
});

describe('the settings section', () => {
    it('switch, replies that keep the block, the label', async () => {
        await env.start();
        const container = document.createElement('div');
        env.sections[0]!.render(container);
        expect(container.textContent).toContain('Ответ рассказывает только сцену');
        const toggle = container.querySelector<HTMLInputElement>('input[type="checkbox"]')!;
        toggle.checked = false;
        toggle.dispatchEvent(new Event('change'));
        expect(env.slice().enabled).toBe(false);
        const keep = container.querySelector<HTMLInputElement>('input[type="number"]')!;
        keep.value = '15';
        keep.dispatchEvent(new Event('change'));
        expect(env.slice().keepRecent).toBe(10);
        const label = container.querySelector<HTMLInputElement>('input[type="text"]')!;
        expect(label.placeholder).toBe('Вокруг');
        label.value = '  Снаружи  ';
        label.dispatchEvent(new Event('change'));
        expect(env.slice().label).toBe('Снаружи');
    });
});
