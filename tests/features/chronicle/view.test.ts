// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chronicleModule } from '../../../src/features/chronicle';
import type { ChronicleApi } from '../../../src/features/chronicle/api';
import { CHRONICLE_STRINGS, CHRONICLE_TARGETS } from '../../../src/features/chronicle/strings';
import { profileTasks, resetRegistries } from '../../../src/ui/views/registries';
import { createChronicleTestApp, reply, settle, startModule, userMessage } from './helpers';
import type { ChronicleTestApp } from './helpers';

let t: ChronicleTestApp;
let stop: () => Promise<void>;
let container: HTMLElement;
let unmount: (() => void) | void;

function render(): void {
    unmount = t.ui.tabs.find((tab) => tab.id === 'chronicle')!.render(container);
}

function buttonByText(text: string): HTMLButtonElement {
    const found = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (node) => node.textContent?.trim() === text,
    );
    if (!found) throw new Error(`no button ${text}`);
    return found;
}

async function seedChapter(status = 'active'): Promise<number> {
    return t.canon.put({
        entry: {
            comment: 'Chronicle: Alice, Bob — Tavern (#1–3)',
            content: 'Chapter: Alice, Bob — Tavern\nKey events: Alice met Bob.',
            key: ['Alice', 'Алиса', 'Алисы', 'Alicia', 'Ali', 'Лис', 'Лиса'],
            keysecondary: ['Tavern', 'таверна'],
        },
        meta: {
            kind: 'addition',
            status,
            origin: 'chronicle',
            type: 'chapter',
            typeFields: { name: 'Alice, Bob — Tavern', events: 'Alice met Bob.' },
            chronicle: { id: 'ch-1', from: 1, to: 3, indexes: [1, 3], participants: [], primary: null, place: null },
        } as never,
    });
}

beforeEach(async () => {
    resetRegistries();
    document.body.innerHTML = '<div id="form_sheld"><div id="send_form"></div></div>';
    t = createChronicleTestApp();
    const started = await startModule(t, chronicleModule);
    stop = () => started.stop();
    container = document.createElement('div');
    document.body.appendChild(container);
    await settle();
});

afterEach(async () => {
    if (typeof unmount === 'function') unmount();
    unmount = undefined;
    await stop();
    resetRegistries();
});

describe('M9 module', () => {
    it('registers the tab, styles, the recap profile task and the API, and removes them when stopped', async () => {
        expect(t.ui.tabs.find((tab) => tab.id === 'chronicle')).toMatchObject({ titleKey: 'm9.tab', order: 51 });
        expect(t.ui.styles.get('m9-chronicle')).toContain('.maestro-m9-recap');
        expect(profileTasks()).toContainEqual({ id: 'chronicle.recap', labelKey: 'm9.profileTask' });
        const api = t.modules.api<ChronicleApi>('chronicle')!;
        expect(await api.chapters()).toEqual([]);
        expect(api.remembered()).toEqual([]);
        let changes = 0;
        const off = api.onChange(() => changes++);
        await seedChapter();
        expect(changes).toBeGreaterThan(0);
        off();
        await stop();
        expect(t.modules.api('chronicle')).toBeUndefined();
        expect(t.ui.tabs).toEqual([]);
        expect(profileTasks()).toEqual([]);
        stop = async () => {};
    });

    it('has the same strings in English and Russian', () => {
        expect(Object.keys(CHRONICLE_STRINGS.ru).sort()).toEqual(Object.keys(CHRONICLE_STRINGS.en).sort());
        for (const [key, text] of Object.entries(CHRONICLE_STRINGS.ru)) expect(text, key).not.toBe('');
        for (const key of Object.keys(CHRONICLE_STRINGS.en))
            expect(key.startsWith('m9.') || key.startsWith('kind.chronicle.') || key.startsWith('target.m9.')).toBe(
                true,
            );
        for (const reason of ['important', 'quest', 'relationship', 'oath', 'secret']) {
            expect(CHRONICLE_STRINGS.ru).toHaveProperty(`m9.reason.${reason}`);
        }
        for (const target of ['user', 'userAndPrompt', 'off']) {
            expect(CHRONICLE_STRINGS.ru).toHaveProperty(`m9.recap.target.${target}`);
        }
    });

    it('names its action kinds and journal targets in both languages', () => {
        expect(chronicleModule.targets).toBe(CHRONICLE_TARGETS);
        const targets = CHRONICLE_TARGETS.map((spec) => spec.target);
        expect(targets).toEqual(['m9.chapter', 'm9.merge', 'm9.archive', 'm9.remember']);
        const kinds = ['chapter', 'merge', 'archive', 'remember'].map((kind) => `kind.chronicle.${kind}`);
        const fields = CHRONICLE_TARGETS.flatMap((spec) => Object.values(spec.fields ?? {}).map((f) => f.labelKey));
        const keys = [...kinds, ...targets.map((target) => `target.${target}`), ...fields, 'm9.field.state'];
        for (const key of keys) {
            expect(CHRONICLE_STRINGS.en[key], key).toBeTruthy();
            expect(CHRONICLE_STRINGS.ru[key], key).toBeTruthy();
        }
        for (const name of ['chapter.appliedMany', 'merge.appliedMany', 'archive.proposal', 'archive.applied']) {
            for (const form of ['one', 'few', 'many']) expect(CHRONICLE_STRINGS.ru[`m9.${name}.${form}`]).toBeTruthy();
        }
        expect(CHRONICLE_STRINGS.ru['kind.chronicle.archive']).not.toContain('бюджет');
    });
});

describe('M9 chronicle tab', () => {
    it('lists chapters with their AND keys and opens one in the Lore Studio', async () => {
        const uid = await seedChapter();
        await seedChapter('archived');
        render();
        await settle(150);
        const cards = container.querySelectorAll('.maestro-m9-chapter');
        expect(cards).toHaveLength(2);
        const first = cards[0] as HTMLElement;
        expect(first.querySelector('.maestro-card-title')?.textContent).toBe('Chronicle: Alice, Bob — Tavern (#1–3)');
        expect(first.textContent).toContain('Messages #1–3');
        expect(first.textContent).toContain(
            `${'Chapter: Alice, Bob — Tavern\nKey events: Alice met Bob.'.length} chars`,
        );
        const keys = [...first.querySelectorAll('.maestro-m9-keys > span')].map((node) => node.textContent);
        expect(keys).toEqual(['Alice', 'Алиса', 'Алисы', 'Alicia', 'Ali', 'Лис', '+1', 'AND', 'Tavern', 'таверна']);
        expect(cards[1]?.textContent).toContain('archive');
        (first.querySelector('button') as HTMLButtonElement).click();
        expect(t.studio.opened).toEqual([[t.canon.book, uid]]);
        expect(t.ui.closed).toBe(1);
        t.modules.apis.delete('loreStudio');
        (first.querySelector('button') as HTMLButtonElement).click();
        expect(t.ui.notices.at(-1)?.text).toBe('The Lore Studio is off: open the canon book in the lorebook editor.');
    });

    it('shows remembered messages and redraws when the chronicle changes', async () => {
        render();
        await settle(150);
        expect(container.textContent).toContain('No chapters yet');
        expect(container.textContent).toContain('Nothing marked yet.');
        t.mock.chat.push(reply('a', { memory: 'A' }), userMessage());
        await t.app.bus.emit('signal', {
            kind: 'memory.important',
            chatId: 'chat-1',
            at: 0,
            data: { messageIndex: 0, reason: 'Turning point' },
        });
        await settle(1800);
        await settle(150);
        const rows = [...container.querySelectorAll('.maestro-m9-row')].map((row) => row.textContent);
        expect(rows).toEqual(['#0important event (Turning point)']);
    });

    it('edits the settings and shows the recap now', async () => {
        t.mock.chat.push(reply('a', { memory: 'Alice met Bob.', remember: true, include: 'long' }));
        render();
        await settle(150);
        const hours = container.querySelector<HTMLInputElement>('input[aria-label="After a break of (hours)"]')!;
        hours.value = '24.4';
        hours.dispatchEvent(new Event('change'));
        expect(t.slice().recap.afterHours).toBe(24);
        const target = container.querySelector<HTMLSelectElement>('select[aria-label="Show"]')!;
        target.value = 'userAndPrompt';
        target.dispatchEvent(new Event('change'));
        expect(t.slice().recap.target).toBe('userAndPrompt');
        const source = container.querySelector<HTMLSelectElement>('select[aria-label="Made from"]')!;
        source.value = 'ai';
        source.dispatchEvent(new Event('change'));
        expect(t.slice().recap.source).toBe('ai');
        const size = container.querySelector<HTMLInputElement>('input[aria-label="Chapter size limit (chars)"]')!;
        size.value = '800';
        size.dispatchEvent(new Event('change'));
        expect(t.slice().maxChapterChars).toBe(800);
        const toggles = [...container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
        expect(toggles.map((input) => input.checked)).toEqual([true, true, true]);
        for (const input of toggles) {
            input.checked = false;
            input.dispatchEvent(new Event('change'));
        }
        expect(t.slice()).toMatchObject({ chapters: false, autoMemory: false, keywords: false });
        t.llm.answer = { ok: true, text: 'Alice met Bob.' };
        buttonByText('Show now').click();
        await settle(100);
        expect(document.querySelector('.maestro-m9-recap-text')?.textContent).toBe('Alice met Bob.');
        await settle(150);
        expect(container.querySelector('.maestro-m9-last')?.textContent).toBe('Alice met Bob.');
    });

    it('warns about missing Qvink and canon, and has an empty state without a chat', async () => {
        t.qvink.present = false;
        t.modules.apis.delete('canon');
        render();
        await settle(150);
        const banners = [...container.querySelectorAll('.maestro-banner')].map((node) => node.textContent);
        expect(banners).toEqual([
            'Qvink Memory is not installed or is off for this chat: no chapters and no «remember» marks.',
            'Chronicle chapters have nowhere to go: the «Chat canon» module is off.',
        ]);
        if (typeof unmount === 'function') unmount();
        t.mock.chatId = undefined;
        container.replaceChildren();
        render();
        await settle(50);
        expect(container.textContent).toBe('No chat is open.');
    });

    it('shows how many memories wait for a chapter', async () => {
        t.mock.chat.push(
            reply('a', { memory: 'Sera slept.', remember: true, include: null }),
            reply('b', { memory: 'x', include: 'short' }),
        );
        t.modules.apis.delete('world');
        t.places.placesList = [];
        const api = t.modules.api<ChronicleApi>('chronicle')!;
        await api.chapters();
        render();
        await t.app.bus.emit('turn:committed', { messageIndex: 1 });
        await settle(2400);
        await settle(150);
        expect(container.textContent).toContain('Waiting for a chapter: 1; left out (no keys): 0');
    });
});
