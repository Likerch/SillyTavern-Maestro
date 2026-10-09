// @vitest-environment happy-dom
// M39 «Раздел Dramatis в листе персонажа DES» (release 1.19) over a fake of DES 2.6's modal UI: the Dramatis tab is
// added every time DES (re)builds the character sheet, shows Dramatis' summary of the character (secrets blurred,
// shown or left out as Dramatis says; an empty state; a note on the player's own card), follows Dramatis' changes; the
// Workshop gets a Dramatis pane (the iOS route); the portrait menu gets «Dramatis», which opens the sheet on that tab;
// nothing appears without Dramatis 1.3; everything goes when the module stops.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DramatisCharacterView } from '../../../src/adapters';
import { createBus } from '../../../src/core/bus';
import { createI18n } from '../../../src/core/i18n';
import { CORE_STRINGS } from '../../../src/core/strings';
import { DES_DRAMATIS_STRINGS, desDramatisModule } from '../../../src/features/desDramatis';
import type { App, Unsubscribe } from '../../../src/shared/contracts';
import { createFakeUi, createTestHost, createTestLogger } from '../../helpers/core-host';
import type { FakeUi } from '../../helpers/core-host';
import { FakeDramatisApi, hideDramatis, installDramatis } from '../../helpers/dramatis';
import type { InstalledDramatis } from '../../helpers/dramatis';
import { installStMock } from '../../helpers/st-mock';
import { installFakeDes } from './fake-des';
import type { FakeDesUi } from './fake-des';

type Dict = Record<string, unknown>;

interface Env {
    app: App;
    ui: FakeUi;
    des: FakeDesUi;
    desSettings: Dict;
    aliases: Record<string, string[]>;
    opened: string[];
    dramatis: InstalledDramatis;
    api: FakeDramatisApi;
    start(): void;
    stop(): Promise<void>;
}

function vera(): DramatisCharacterView {
    return {
        name: 'Вера',
        headline: 'Капитан «Чайки», бывшая контрабандистка',
        detail: 'портрет',
        secrets: 'spoiler',
        sections: [
            {
                id: 'motives',
                title: 'Мотивы',
                lines: [{ text: 'Хочет вернуть корабль' }, { text: 'Должна гильдии сорок крон', secret: true }],
            },
            { id: 'secrets', title: 'Тайны', lines: [{ text: 'Сдала брата страже', secret: true }] },
        ],
    };
}

function createEnv(): Env {
    const mock = installStMock();
    Object.assign(mock.context, { name1: 'Кай' });
    const host = createTestHost(mock);
    const log = createTestLogger();
    const i18n = createI18n(() => 'ru');
    i18n.register(CORE_STRINGS);
    i18n.register(DES_DRAMATIS_STRINGS);
    const ui = createFakeUi();
    const fake = installFakeDes();
    const desSettings: Dict = { userCharacters: { Кай: {} } };
    const aliases: Record<string, string[]> = {};
    const opened: string[] = [];
    const des = {
        id: 'des',
        present: () => true,
        version: () => '2.6.0',
        capabilities: () => [],
        ready: async () => {},
        settings: () => desSettings,
        aliases: () => aliases,
        // DesAdapter.openCharacterSheet: DES's ensureSettingsUI + openCharacterSheet.
        openCharacterSheet: async (name: string) => {
            opened.push(name);
            fake.openSheet(name);
            return true;
        },
    };
    const app = {
        host,
        log,
        i18n,
        ui,
        bus: createBus(log),
        adapters: { des },
    } as unknown as App;
    const api = new FakeDramatisApi().upgrade();
    api.views['Вера'] = vera();
    const dramatis = installDramatis(app, api);
    const offs: Unsubscribe[] = [];
    return {
        app,
        ui,
        des: fake,
        desSettings,
        aliases,
        opened,
        dramatis,
        api,
        start() {
            void desDramatisModule.init({ app, settings: {}, log, own: (off) => void offs.push(off as Unsubscribe) });
        },
        async stop() {
            for (const off of offs.splice(0).reverse()) await off();
        },
    };
}

/** MutationObserver records are delivered after the current task. */
async function flush(): Promise<void> {
    for (let round = 0; round < 3; round++) await new Promise((resolve) => setTimeout(resolve, 0));
}

function tabOf(env: Env): HTMLElement | null {
    return env.des.sheet?.querySelector<HTMLElement>('.rpg-cs-tab[data-tab="dramatis"]') ?? null;
}

function contentOf(env: Env): HTMLElement | null {
    return env.des.sheet?.querySelector<HTMLElement>('.rpg-cs-tab-content[data-tab="dramatis"]') ?? null;
}

function texts(root: ParentNode, selector: string): string[] {
    return [...root.querySelectorAll(selector)].map((node) => (node.textContent ?? '').trim());
}

let env: Env;

beforeEach(() => {
    env = createEnv();
});

afterEach(async () => {
    await env.stop();
    env.dramatis.remove();
    env.des.remove();
});

describe("M39: the Dramatis tab of DES's character sheet", () => {
    it('is added when DES opens the sheet (its template comes later), before Notes Mode, hidden until chosen', async () => {
        env.start();
        env.des.openSheet('Вера');
        await flush();
        const tabs = env.des.sheet!.querySelector('.rpg-cs-tabs')!;
        expect([...tabs.children].map((node) => (node as HTMLElement).dataset.tab ?? node.tagName)).toEqual([
            'sheet',
            'stats',
            'dramatis',
            'LABEL',
        ]);
        const tab = tabOf(env)!;
        const content = contentOf(env)!;
        expect(tab.textContent?.trim()).toBe('Dramatis');
        expect(tab.hasAttribute('data-desru-skip')).toBe(true);
        expect(content.hasAttribute('data-desru-skip')).toBe(true);
        expect(content.classList.contains('rpg-cs-section')).toBe(false);
        expect(content.querySelector('.rpg-cs-section, .rpg-cs-section-header, [data-i18n-key]')).toBeNull();
        expect(env.des.shownContents()).toEqual(['sheet']);
        // The summary: name (the hero hides it on phones), headline, detail, the sections as titled blocks.
        expect(texts(content, '.maestro-m39-name')).toEqual(['Вера']);
        expect(texts(content, '.maestro-m39-headline')).toEqual(['Капитан «Чайки», бывшая контрабандистка']);
        expect(texts(content, '.maestro-m39-detail')).toEqual(['портрет']);
        expect(texts(content, '.rpg-cs-stat-section-title')).toEqual(['Мотивы', 'Тайны']);
        expect(texts(content, '.maestro-m39-line')).toEqual([
            'Хочет вернуть корабль',
            'Должна гильдии сорок крон',
            'Сдала брата страже',
        ]);
        // DES's own tab switching shows it.
        tab.click();
        expect(env.des.activeTab()).toBe('dramatis');
        expect(env.des.shownContents()).toEqual(['dramatis']);
        env.des.sheet!.querySelector<HTMLElement>('.rpg-cs-tab[data-tab="stats"]')!.click();
        expect(env.des.shownContents()).toEqual(['stats']);
    });

    it('comes back every time DES rebuilds the sheet: another character, the Notes Mode toggle', async () => {
        env.des.appendTemplate();
        env.start();
        env.des.openSheet('Вера');
        await flush();
        env.des.toggleNotes();
        await flush();
        expect(env.des.sheet!.querySelectorAll('.rpg-cs-tab[data-tab="dramatis"]')).toHaveLength(1);
        expect(env.des.sheet!.querySelectorAll('.rpg-cs-tab-content[data-tab="dramatis"]')).toHaveLength(1);
        expect(texts(contentOf(env)!, '.maestro-m39-name')).toEqual(['Вера']);
        env.des.closeSheet();
        env.des.openSheet('Томас');
        await flush();
        expect(env.des.sheet!.querySelectorAll('.rpg-cs-tab[data-tab="dramatis"]')).toHaveLength(1);
        // Nothing known yet: the empty state and a way into Dramatis.
        const content = contentOf(env)!;
        expect(content.querySelector('.rpg-cs-empty')?.textContent).toContain('Dramatis ещё не знает этого персонажа');
        const open = [...content.querySelectorAll('button')].find((node) =>
            node.textContent?.includes('Открыть Dramatis'),
        );
        open!.click();
        expect(env.api.opened).toEqual([undefined]);
    });

    it('blurs secrets until clicked («spoiler»), shows them marked («open»), leaves them out («known»)', async () => {
        env.start();
        env.des.openSheet('Вера');
        await flush();
        let content = contentOf(env)!;
        const secrets = [...content.querySelectorAll<HTMLElement>('.maestro-m39-secret')];
        expect(secrets).toHaveLength(2);
        expect(secrets.every((node) => node.getAttribute('aria-expanded') === 'false')).toBe(true);
        expect(secrets[0]!.getAttribute('title')).toBe('Тайна: нажми, чтобы открыть');
        secrets[0]!.click();
        expect(secrets[0]!.classList.contains('maestro-m39-revealed')).toBe(true);
        secrets[1]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        expect(secrets[1]!.getAttribute('aria-expanded')).toBe('true');
        secrets[1]!.click();
        expect(secrets[1]!.classList.contains('maestro-m39-revealed')).toBe(false);
        // A redraw (Dramatis changed) keeps what was revealed.
        env.api.emit();
        content = contentOf(env)!;
        expect(
            [...content.querySelectorAll<HTMLElement>('.maestro-m39-secret')].map((node) =>
                node.classList.contains('maestro-m39-revealed'),
            ),
        ).toEqual([true, false]);

        env.api.views['Вера'] = { ...vera(), secrets: 'open' };
        env.api.emit();
        content = contentOf(env)!;
        expect(content.querySelectorAll('.maestro-m39-secret')).toHaveLength(0);
        expect(texts(content, '.maestro-m39-secret-open')).toEqual(['Должна гильдии сорок крон', 'Сдала брата страже']);

        env.api.views['Вера'] = { ...vera(), secrets: 'known' };
        env.api.emit();
        content = contentOf(env)!;
        expect(texts(content, '.maestro-m39-line')).toEqual(['Хочет вернуть корабль']);
        // A section of secrets only is left out.
        expect(texts(content, '.rpg-cs-stat-section-title')).toEqual(['Мотивы']);
        expect(content.querySelector('.maestro-m39-open')?.textContent?.trim()).toBe('Открыть в Dramatis');
        content.querySelector<HTMLElement>('.maestro-m39-open')!.click();
        expect(env.api.opened).toEqual(['Вера']);
    });

    it("says the player's own card is his, and asks Dramatis by the DES aliases too", async () => {
        env.start();
        env.des.openSheet('Кай');
        await flush();
        expect(contentOf(env)!.textContent).toContain('Это твой персонаж');
        expect(env.api.described).not.toContain('Кай');

        // DES's name is canonical; Dramatis knows her by another name.
        env.api.views = { Верочка: { ...vera(), name: 'Верочка' } };
        env.aliases['Вера'] = ['Верочка'];
        env.des.openSheet('Вера');
        await flush();
        expect(env.api.described.slice(-2)).toEqual(['Вера', 'Верочка']);
        expect(texts(contentOf(env)!, '.maestro-m39-name')).toEqual(['Верочка']);
    });

    it('follows Dramatis while the sheet is open', async () => {
        env.start();
        env.des.openSheet('Вера');
        await flush();
        env.api.views['Вера'] = { ...vera(), headline: 'Капитан без корабля' };
        env.api.emit();
        expect(texts(contentOf(env)!, '.maestro-m39-headline')).toEqual(['Капитан без корабля']);
    });
});

describe('M39: the Dramatis pane of the Workshop (the iOS route)', () => {
    it('adds a nav button and a pane DES switches to; shows the summary of the open character', async () => {
        env.des.appendTemplate();
        env.start();
        const workshop = env.des.workshop!;
        const button = workshop.querySelector<HTMLElement>('.workshop-nav button[data-pane="dramatis"]')!;
        const pane = workshop.querySelector<HTMLElement>(
            '.workshop-pane-host > .rpg-editor-pane[data-pane="dramatis"]',
        )!;
        expect(button.hasAttribute('data-desru-skip')).toBe(true);
        expect(button.querySelector('.cw-tab-label')?.textContent).toBe('Dramatis');
        expect(pane.hasAttribute('data-desru-skip')).toBe(true);
        expect(pane.childElementCount).toBe(0);

        env.des.openWorkshop('Вера');
        await flush();
        expect(env.des.activePane()).toBe('identity');
        expect(texts(pane, '.maestro-m39-headline')).toEqual(['Капитан «Чайки», бывшая контрабандистка']);
        expect(texts(pane, '.maestro-m39-section-title')).toEqual(['Мотивы', 'Тайны']);
        expect(pane.querySelector('h4.maestro-m39-section-title')).not.toBeNull();
        button.click();
        expect(env.des.activePane()).toBe('dramatis');
        // Other changes of the page (a toast appended to body) leave the drawn pane alone.
        const drawn = pane.firstElementChild;
        document.body.appendChild(document.createElement('div'));
        await flush();
        expect(pane.firstElementChild).toBe(drawn);
        // Dramatis changed: drawn again.
        env.api.emit();
        expect(pane.firstElementChild).not.toBe(drawn);

        // Reopened on the player's character: DES goes back to Identity; the pane says it is his.
        env.des.closeWorkshop();
        env.des.openWorkshop('Кай', 'user');
        await flush();
        expect(env.des.activePane()).toBe('identity');
        expect(pane.textContent).toContain('Это твой персонаж');
        expect(workshop.querySelectorAll('[data-pane="dramatis"]')).toHaveLength(2);
    });
});

describe('M39: «Dramatis» in the portrait card menu', () => {
    it("opens DES's sheet on the Dramatis tab; hidden on the player's card", async () => {
        env.start();
        const card = env.des.card('Вера');
        env.des.rightClick(card);
        const items = [...env.des.menu.querySelectorAll<HTMLElement>('.dooms-pb-ctx-item')];
        expect(items.map((node) => node.dataset.action ?? 'maestro')).toEqual([
            'open-workshop',
            'character-sheet',
            'maestro',
            'regenerate-portrait',
        ]);
        const item = env.des.menu.querySelector<HTMLElement>('.maestro-m39-ctx')!;
        expect(item.hasAttribute('data-desru-skip')).toBe(true);
        expect(item.textContent?.trim()).toBe('Dramatis');
        expect(item.style.display).toBe('');
        item.click();
        await flush();
        expect(env.opened).toEqual(['Вера']);
        expect(env.des.menu.style.display).toBe('none');
        expect(env.des.activeTab()).toBe('dramatis');
        expect(env.des.shownContents()).toEqual(['dramatis']);

        env.des.rightClick(env.des.card('Кай', true));
        expect(item.style.display).toBe('none');
        env.des.rightClick(card);
        expect(item.style.display).toBe('');
        expect(env.des.menu.querySelectorAll('.maestro-m39-ctx')).toHaveLength(1);
    });

    it('says so when the sheet does not open', async () => {
        env.start();
        (env.app.adapters as unknown as { des: Dict }).des.openCharacterSheet = async () => false;
        env.des.rightClick(env.des.card('Вера'));
        env.des.menu.querySelector<HTMLElement>('.maestro-m39-ctx')!.click();
        await flush();
        expect(env.ui.notices.map((notice) => notice.text)).toEqual(['Лист персонажа DES не открылся']);
    });
});

describe('M39: without Dramatis 1.3, and when the module stops', () => {
    it('adds nothing for an older Dramatis, and catches up when Dramatis 1.3 appears', async () => {
        const older = new FakeDramatisApi();
        env.dramatis.remove();
        env.dramatis = installDramatis(env.app, older);
        env.start();
        env.des.openSheet('Вера');
        env.des.openWorkshop('Вера');
        env.des.rightClick(env.des.card('Вера'));
        await flush();
        expect(tabOf(env)).toBeNull();
        expect(env.des.workshop!.querySelector('[data-pane="dramatis"]')).toBeNull();
        expect(env.des.menu.querySelector('.maestro-m39-ctx')).toBeNull();

        older.upgrade().views['Вера'] = vera();
        older.emit();
        expect(tabOf(env)).not.toBeNull();
        expect(env.des.workshop!.querySelectorAll('[data-pane="dramatis"]')).toHaveLength(2);
        expect(env.des.menu.querySelector('.maestro-m39-ctx')).not.toBeNull();

        // Dramatis goes away: so do the tab, the pane and the item (on the next look: a chat switch here).
        hideDramatis();
        await env.app.bus.emit('chat:changed', { chatId: 'chat-2' });
        expect(tabOf(env)).toBeNull();
        expect(contentOf(env)).toBeNull();
        expect(env.des.workshop!.querySelector('[data-pane="dramatis"]')).toBeNull();
        expect(env.des.menu.querySelector('.maestro-m39-ctx')).toBeNull();
    });

    it('takes everything back, handing the screen back to DES first', async () => {
        env.start();
        env.des.openSheet('Вера');
        env.des.openWorkshop('Вера');
        env.des.rightClick(env.des.card('Вера'));
        await flush();
        tabOf(env)!.click();
        env.des.workshop!.querySelector<HTMLElement>('.workshop-nav button[data-pane="dramatis"]')!.click();
        expect(env.des.activeTab()).toBe('dramatis');
        expect(env.des.activePane()).toBe('dramatis');

        await env.stop();
        expect(document.querySelectorAll('[data-desru-skip]')).toHaveLength(0);
        expect(document.querySelectorAll('[class*="maestro-m39"]')).toHaveLength(0);
        expect(env.des.activeTab()).toBe('sheet');
        expect(env.des.shownContents()).toEqual(['sheet']);
        expect(env.des.activePane()).toBe('identity');

        // No observer is left: DES's next opening stays DES's own.
        env.des.openSheet('Вера');
        env.des.closeWorkshop();
        env.des.openWorkshop('Вера');
        env.des.rightClick(env.des.card('Вера'));
        await flush();
        env.api.emit();
        expect(document.querySelectorAll('[class*="maestro-m39"]')).toHaveLength(0);
    });
});
