// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Mock } from 'vitest';
import type { EntryFormContext, RenderEntryForm } from '../../../src/features/loreStudio/form-api';
import { LoreStudio, defaultStudioSettings } from '../../../src/features/loreStudio/studio';
import type { LoreStudioSettings } from '../../../src/features/loreStudio/studio';
import { loreStudioTab } from '../../../src/features/loreStudio/view-tab';
import { FakePopup, POPUP_RESULT } from '../../helpers/ui-env';
import { createStand, entry, resetDom } from './stand';
import type { Stand } from './stand';

let s: Stand;
let off: () => void;
let studio: LoreStudio;
let form: Mock<RenderEntryForm>;
let formCleanup: Mock<() => void>;
let settings: LoreStudioSettings;
let openClassic: Mock<(book?: string) => Promise<boolean>>;

const wait = (ms = 80) => new Promise((resolve) => setTimeout(resolve, ms));
const q = <T extends Element = HTMLElement>(selector: string) => document.querySelector<T>(selector);
const qa = <T extends Element = HTMLElement>(selector: string) => [...document.querySelectorAll<T>(selector)];
const rows = () => qa('.maestro-m23-entry');
const row = (uid: number) => q(`.maestro-m23-entry[data-uid="${uid}"]`) as HTMLElement;
const click = (node: Element | null | undefined) => (node as HTMLElement).click();
const byTitle = (scope: ParentNode, title: string) => scope.querySelector<HTMLElement>(`[title="${title}"]`);

async function openBook(name: string): Promise<void> {
    studio.open();
    await wait();
    click(
        qa('.maestro-m23-book')
            .find((node) => node.dataset.book === name)
            ?.querySelector('.maestro-m23-book-name'),
    );
    await wait();
}

beforeEach(() => {
    resetDom();
    s = createStand();
    off = s.store.install();
    const many: Record<string, Record<string, unknown>> = {};
    for (let i = 0; i < 30; i++)
        many[i] = entry(i, { comment: `Entry ${i}`, key: [`key${i}`], order: 100 - i, displayIndex: i });
    many[3] = entry(3, { comment: 'Anna', key: ['Anna'], content: 'Heroine of the story', order: 97, displayIndex: 3 });
    s.addBook('World', many);
    s.addBook('Pack', { 0: entry(0, { comment: 'Trait' }) });
    s.addBook('Chat book', { 0: entry(0) });
    s.bunny.packs.push('Pack');
    s.mock.chatMetadata.world_info = 'Chat book';
    formCleanup = vi.fn<() => void>();
    form = vi.fn<RenderEntryForm>(() => formCleanup);
    settings = defaultStudioSettings();
    openClassic = vi.fn<(book?: string) => Promise<boolean>>(async () => true);
    studio = new LoreStudio({
        app: s.app,
        log: s.app.log,
        store: s.store,
        renderForm: form,
        settings,
        saveSettings: vi.fn(),
        openClassic,
    });
});

afterEach(() => {
    studio.close();
    off();
});

describe('books panel', () => {
    it('opens a large dialog with books grouped by role section', async () => {
        studio.open();
        await wait();
        expect(q('.popup.maestro-m23-dialog')).not.toBeNull();
        const sections = qa('.maestro-m23-section').map((node) => node.dataset.section);
        expect(sections).toEqual(['chat', 'world', 'system']);
        const pack = qa('.maestro-m23-book').find((node) => node.dataset.book === 'Pack')!;
        expect(pack.querySelector('.maestro-m23-badge-lock')).not.toBeNull();
        const chat = qa('.maestro-m23-book').find((node) => node.dataset.book === 'Chat book')!;
        expect(chat.classList.contains('maestro-m23-active')).toBe(true);
    });

    it('filters to books active in this chat and by name', async () => {
        studio.open();
        await wait();
        const only = q('.maestro-m23-only-active input') as HTMLInputElement;
        only.checked = true;
        only.dispatchEvent(new Event('change'));
        expect(qa('.maestro-m23-book').map((node) => node.dataset.book)).toEqual(['Chat book']);
        only.checked = false;
        only.dispatchEvent(new Event('change'));
        const search = q('.maestro-m23-book-search') as HTMLInputElement;
        search.value = 'wor';
        search.dispatchEvent(new Event('input'));
        expect(qa('.maestro-m23-book').map((node) => node.dataset.book)).toEqual(['World']);
    });

    it('switches a book globally from its row', async () => {
        studio.open();
        await wait();
        const toggle = qa('.maestro-m23-book')
            .find((node) => node.dataset.book === 'World')!
            .querySelector('input') as HTMLInputElement;
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await wait();
        expect(s.wi.selected_world_info).toEqual(['World']);
    });

    it('creates and imports books', async () => {
        studio.open();
        await wait();
        s.callGenericPopup.mockResolvedValueOnce('Atlas');
        click(qa('.maestro-m23-books-tools .maestro-btn').find((node) => node.textContent === 'New'));
        await wait();
        expect(s.store.books()).toContain('Atlas');
        expect(q('.maestro-m23-book-heading-title')?.textContent).toBe('Atlas');
        const input = q('.maestro-m23-hidden-file') as HTMLInputElement;
        const file = new File([JSON.stringify({ entries: {} })], 'Imported.json');
        Object.defineProperty(input, 'files', { value: [file], configurable: true });
        input.dispatchEvent(new Event('change'));
        await wait();
        expect(s.store.books()).toContain('Imported');
    });

    it('edits the bindings of this chat', async () => {
        studio.open();
        await wait();
        const selects = qa<HTMLSelectElement>('.maestro-m23-binding-select');
        const chat = selects.find((node) => node.getAttribute('aria-label') === 'Chat lorebook')!;
        chat.value = 'World';
        chat.dispatchEvent(new Event('change'));
        await wait();
        expect(s.mock.chatMetadata.world_info).toBe('World');
        const primary = qa<HTMLSelectElement>('.maestro-m23-binding-select')[0]!;
        primary.value = 'World';
        primary.dispatchEvent(new Event('change'));
        await wait();
        const characters = s.mock.context.characters as unknown as { data: { extensions: { world: string } } }[];
        expect(characters[0]!.data.extensions.world).toBe('World');
    });
});

describe('deep links', () => {
    it('opens straight on a book and an entry (/maestro-lore, takeover deep links)', async () => {
        studio.open('World', 3);
        await wait();
        expect(q('.maestro-m23-book-heading-title')?.textContent).toBe('World');
        expect((form.mock.calls.at(-1)![1] as EntryFormContext).uid).toBe(3);
        studio.open('Missing book');
        await wait();
        expect(q('.maestro-m23-book-heading-title')?.textContent).toBe('World');
    });
});

describe('entries panel', () => {
    it('lists, pages and sorts entries', async () => {
        await openBook('World');
        expect(rows()).toHaveLength(25);
        expect(q('.maestro-m23-pager-text')?.textContent).toBe('1–25 of 30');
        click(byTitle(document, 'Next page'));
        expect(rows()).toHaveLength(5);
        const sort = q('.maestro-m23-sort') as HTMLSelectElement;
        sort.value = '10';
        sort.dispatchEvent(new Event('change'));
        await wait();
        expect(rows()[0]?.dataset.uid).toBe('29');
        expect(settings.sort).toBe(10);
        const size = q('.maestro-m23-page-size') as HTMLSelectElement;
        size.value = '50';
        size.dispatchEvent(new Event('change'));
        await wait();
        expect(rows()).toHaveLength(30);
        expect(settings.pageSize).toBe(50);
    });

    it('searches with the «Search» sort', async () => {
        await openBook('World');
        const search = q('.maestro-m23-entry-search') as HTMLInputElement;
        search.value = 'anna';
        search.dispatchEvent(new Event('input'));
        await wait(400);
        expect(rows().map((node) => node.dataset.uid)).toEqual(['3']);
        const sort = q('.maestro-m23-sort') as HTMLSelectElement;
        expect(sort.disabled).toBe(true);
        expect(sort.value).toBe('14');
        expect(studio.listedEntries().map((item) => item.uid)).toEqual([3]);
    });

    it('opens the entry form with the contract context', async () => {
        await openBook('World');
        click(row(3).querySelector('.maestro-m23-entry-title'));
        expect(form).toHaveBeenCalledTimes(1);
        const ctx = form.mock.calls[0]![1] as EntryFormContext;
        expect(ctx).toMatchObject({ book: 'World', uid: 3, readOnly: false });
        expect(ctx.store).toBe(s.store);
        expect((q('.maestro-m23-col-form') as HTMLElement).hidden).toBe(false);
        expect(q('.maestro-m23-layout')?.getAttribute('data-pane')).toBe('form');
        ctx.onClose();
        await wait();
        expect(formCleanup).toHaveBeenCalled();
        expect((q('.maestro-m23-col-form') as HTMLElement).hidden).toBe(true);
    });

    it('creates an entry and opens it', async () => {
        await openBook('World');
        click(qa('.maestro-m23-entries-tools .maestro-btn').find((node) => node.textContent === 'New entry'));
        await wait();
        expect(s.book('World').entries['30']).toBeDefined();
        expect((form.mock.calls.at(-1)![1] as EntryFormContext).uid).toBe(30);
    });

    it('toggles, cycles status, duplicates and deletes from a row', async () => {
        await openBook('World');
        // A disabled entry sorts last (priority sort): keep every entry on one page.
        const size = q('.maestro-m23-page-size') as HTMLSelectElement;
        size.value = '50';
        size.dispatchEvent(new Event('change'));
        await wait();
        click(row(0).querySelector('.maestro-m23-toggle'));
        await wait();
        expect(s.book('World').entries['0']!.disable).toBe(true);
        click(row(0).querySelector('.maestro-m23-status'));
        await wait();
        expect(s.book('World').entries['0']).toMatchObject({ constant: true, vectorized: false });
        click(byTitle(row(1), 'Duplicate entry'));
        await wait();
        expect(s.book('World').entries['30']!.comment).toBe('Entry 1');
        click(byTitle(row(2), 'Delete entry'));
        await wait();
        expect(s.book('World').entries['2']).toBeUndefined();
    });

    it('selects rows and acts on them in bulk', async () => {
        await openBook('World');
        for (const uid of [0, 1]) {
            const box = row(uid).querySelector('input[type="checkbox"]') as HTMLInputElement;
            box.checked = true;
            box.dispatchEvent(new Event('change'));
        }
        expect(q('.maestro-m23-bulk-count')?.textContent).toBe('Selected: 2');
        click(byTitle(q('.maestro-m23-bulk')!, 'Disable selected'));
        await wait();
        expect(s.book('World').entries['0']!.disable).toBe(true);
        expect(s.book('World').entries['1']!.disable).toBe(true);
        // Bulk edit: the user types an Order; the row ticks itself.
        s.callGenericPopup.mockImplementationOnce(async (content: unknown) => {
            const order = [...(content as HTMLElement).querySelectorAll('.maestro-m23-bulk-row')].find(
                (node) => node.querySelector('.maestro-m23-bulk-label')?.textContent === 'Order',
            );
            const input = order?.querySelector('input[type="number"]') as HTMLInputElement;
            input.value = '7';
            input.dispatchEvent(new Event('input'));
            return POPUP_RESULT.AFFIRMATIVE;
        });
        click(qa('.maestro-m23-bulk .maestro-btn').find((node) => node.textContent === 'Change fields…'));
        await wait();
        expect(s.book('World').entries['0']!.order).toBe(7);
        expect(s.book('World').entries['1']!.order).toBe(7);
        expect(s.book('World').entries['0']!.disable).toBe(true);
    });

    it('moves and copies entries to another book', async () => {
        await openBook('World');
        // The first action of the dialog is «Move».
        click(byTitle(row(5), 'Move or copy to another book'));
        await wait();
        expect(s.book('World').entries['5']).toBeUndefined();
        expect(Object.values(s.book('Chat book').entries).some((item) => item.comment === 'Entry 5')).toBe(true);
        s.callGenericPopup.mockResolvedValueOnce(100);
        click(byTitle(row(6), 'Move or copy to another book'));
        await wait();
        expect(s.book('World').entries['6']).toBeDefined();
        expect(Object.values(s.book('Chat book').entries).some((item) => item.comment === 'Entry 6')).toBe(true);
    });

    it('applies the current sorting as Order and fills empty titles', async () => {
        s.addBook('Small', {
            0: entry(0, { order: 1, key: ['alpha'] }),
            1: entry(1, { order: 2, comment: 'Beta' }),
        });
        await openBook('Small');
        click(byTitle(document, 'Apply current sorting as Order'));
        await wait();
        // Priority sort: order desc → uid 1 first.
        expect(s.book('Small').entries['1']!.order).toBe(100);
        expect(s.book('Small').entries['0']!.order).toBe(99);
        click(byTitle(document, 'Fill empty titles with keywords'));
        await wait();
        expect(s.book('Small').entries['0']!.comment).toBe('alpha');
        expect(s.ui.notices.some((notice) => notice.text === 'Filled 1 titles.')).toBe(true);
    });

    it('reorders by up/down in the custom sort', async () => {
        await openBook('World');
        const sort = q('.maestro-m23-sort') as HTMLSelectElement;
        sort.value = '13';
        sort.dispatchEvent(new Event('change'));
        await wait();
        click(byTitle(row(1), 'Move up'));
        await wait();
        expect(s.book('World').entries['1']!.displayIndex).toBe(0);
        expect(s.book('World').entries['0']!.displayIndex).toBe(1);
        expect(rows()[0]?.dataset.uid).toBe('1');
    });

    it('opens previews and collapses them', async () => {
        await openBook('World');
        click(byTitle(document, 'Open all previews on this page'));
        expect(qa('.maestro-m23-entry-preview')).toHaveLength(25);
        click(byTitle(document, 'Close all previews on this page'));
        expect(qa('.maestro-m23-entry-preview')).toHaveLength(0);
    });

    it('keeps BunnyMo books read-only', async () => {
        await openBook('Pack');
        const create = qa<HTMLButtonElement>('.maestro-m23-entries-tools .maestro-btn').find(
            (node) => node.textContent === 'New entry',
        );
        expect(create?.disabled).toBe(true);
        click(row(0).querySelector('.maestro-m23-entry-title'));
        expect((form.mock.calls.at(-1)![1] as EntryFormContext).readOnly).toBe(true);
    });

    it('refreshes when the book changes outside the studio', async () => {
        await openBook('World');
        const changed = structuredClone(s.book('World'));
        changed.entries['0']!.comment = 'Changed in ST';
        s.server.set('World', changed);
        s.cache.delete('World');
        await s.emit('WORLDINFO_UPDATED', 'World', changed);
        await wait();
        expect(row(0).querySelector('.maestro-m23-entry-name')?.textContent).toBe('Changed in ST');
    });
});

describe('leave guard of the entry form', () => {
    let guard: Mock<() => Promise<boolean>>;
    const title = (uid: number) => row(uid).querySelector('.maestro-m23-entry-title');
    const bookButton = (name: string) =>
        qa('.maestro-m23-book')
            .find((node) => node.dataset.book === name)
            ?.querySelector('.maestro-m23-book-name');

    beforeEach(() => {
        guard = vi.fn<() => Promise<boolean>>(async () => false);
        form.mockImplementation((_container, ctx) => {
            ctx.setLeaveGuard?.(guard);
            return formCleanup;
        });
    });

    it('asks the open form before switching entries, books or views and before closing', async () => {
        await openBook('World');
        click(title(3));
        expect(form).toHaveBeenCalledTimes(1);
        click(title(4));
        await wait();
        expect(guard).toHaveBeenCalledTimes(1);
        expect(form).toHaveBeenCalledTimes(1);
        click(bookButton('Pack'));
        await wait();
        expect(q('.maestro-m23-book-heading-title')?.textContent).toBe('World');
        click(qa('.maestro-segment').find((node) => node.dataset.value === 'settings'));
        await wait();
        expect(q('.maestro-m23-setting')).toBeNull();
        expect(q('.maestro-segment.maestro-on')?.dataset.value).toBe('library');
        click(q('.maestro-m23-close'));
        await wait();
        expect(studio.isOpen()).toBe(true);
        click(byTitle(document, 'Open in the classic editor'));
        await wait();
        expect(openClassic).not.toHaveBeenCalled();
        expect(formCleanup).not.toHaveBeenCalled();
        // The form agrees (saved or discarded): everything goes on.
        guard.mockResolvedValue(true);
        click(title(4));
        await wait();
        expect((form.mock.calls.at(-1)![1] as EntryFormContext).uid).toBe(4);
        expect(formCleanup).toHaveBeenCalledTimes(1);
        click(q('.maestro-m23-close'));
        await wait();
        expect(studio.isOpen()).toBe(false);
    });

    it('does not ask again when the form closes itself, and forgets the guard', async () => {
        await openBook('World');
        click(title(3));
        (form.mock.calls[0]![1] as EntryFormContext).onClose();
        await wait();
        click(bookButton('Pack'));
        await wait();
        expect(q('.maestro-m23-book-heading-title')?.textContent).toBe('Pack');
        expect(guard).not.toHaveBeenCalled();
    });

    it('hands the guard to ST’s onClosing (Escape) unless the close was already allowed', async () => {
        await openBook('World');
        click(title(3));
        const popup = FakePopup.instances.at(-1)!;
        const onClosing = popup.options.onClosing as () => Promise<boolean> | boolean;
        expect(await onClosing()).toBe(false);
        guard.mockResolvedValue(true);
        expect(await onClosing()).toBe(true);
        guard.mockClear();
        studio.close();
        expect(await onClosing()).toBe(true);
        expect(guard).not.toHaveBeenCalled();
    });
});

describe('book actions', () => {
    it('renames, duplicates and deletes the selected book', async () => {
        await openBook('World');
        s.callGenericPopup.mockResolvedValueOnce('Atlas');
        click(byTitle(document, 'Rename book'));
        await wait();
        expect(s.store.books()).toContain('Atlas');
        expect(q('.maestro-m23-book-heading-title')?.textContent).toBe('Atlas');
        s.callGenericPopup.mockResolvedValueOnce('Atlas copy');
        click(byTitle(document, 'Duplicate book'));
        await wait();
        expect(s.store.books()).toContain('Atlas copy');
        click(byTitle(document, 'Delete book'));
        await wait();
        expect(s.store.books()).not.toContain('Atlas copy');
        expect(q('.maestro-m23-pick')).not.toBeNull();
    });

    it('closes for the classic editor', async () => {
        await openBook('World');
        click(byTitle(document, 'Open in the classic editor'));
        await wait();
        expect(openClassic).toHaveBeenCalledWith('World');
        expect(studio.isOpen()).toBe(false);
    });

    it('reports failures as notices', async () => {
        await openBook('World');
        s.callGenericPopup.mockResolvedValueOnce('Pack');
        click(byTitle(document, 'Rename book'));
        await wait();
        expect(s.ui.notices.at(-1)?.text).toBe('A book named «Pack» already exists.');
    });
});

describe('other views', () => {
    it('edits the global WI settings', async () => {
        studio.open();
        await wait();
        click(qa('.maestro-segment').find((node) => node.dataset.value === 'settings'));
        await wait();
        expect(qa('.maestro-m23-setting')).toHaveLength(13);
        const depth = q('.maestro-m23-setting[data-key="world_info_depth"] input') as HTMLInputElement;
        depth.value = '5';
        depth.dispatchEvent(new Event('change'));
        await wait();
        expect(s.wi.world_info_depth).toBe(5);
        const recursive = q('.maestro-m23-setting[data-key="world_info_recursive"] input') as HTMLInputElement;
        recursive.checked = true;
        recursive.dispatchEvent(new Event('change'));
        await wait();
        expect(s.wi.world_info_recursive).toBe(true);
    });

    it('shows DES campaigns through DES', async () => {
        studio.open();
        await wait();
        click(qa('.maestro-segment').find((node) => node.dataset.value === 'campaigns'));
        await wait();
        expect(q('.maestro-m23-campaigns .maestro-empty')?.textContent).toContain('not installed');
        const modules = s.installDes();
        s.callGenericPopup.mockResolvedValueOnce('Saga');
        click(qa('.maestro-segment').find((node) => node.dataset.value === 'library'));
        await wait();
        click(qa('.maestro-segment').find((node) => node.dataset.value === 'campaigns'));
        await wait();
        click(qa('.maestro-m23-campaigns-head .maestro-btn').find((node) => node.textContent === 'New campaign'));
        await wait();
        expect(modules.campaigns.createCampaign).toHaveBeenCalledWith('Saga', 'fa-folder', '');
        expect(qa('.maestro-m23-campaign')).toHaveLength(1);
        click(byTitle(q('.maestro-m23-campaign')!, 'Make active'));
        await wait();
        expect(modules.campaigns.setActiveCampaign).toHaveBeenCalledWith('c1', {});
        const move = qa<HTMLSelectElement>('.maestro-m23-unfiled .maestro-m23-move-book')[0]!;
        move.value = 'c1';
        move.dispatchEvent(new Event('change'));
        await wait();
        expect(modules.campaigns.moveBookBetweenCampaigns).toHaveBeenCalled();
        // The auto-link switch asks once, then changes DES's setting.
        const autoLink = qa<HTMLInputElement>('.maestro-m23-campaigns-head input[type="checkbox"]')[0]!;
        autoLink.checked = false;
        autoLink.dispatchEvent(new Event('change'));
        await wait();
        expect(settings.autoLinkAsked).toBe(true);
        expect(modules.lorebook.autoLinkByName).toBe(false);
        // Opening a book from a campaign goes back to the library.
        click(q('.maestro-m23-book-link'));
        await wait();
        expect(q('.maestro-m23-book-heading-title')).not.toBeNull();
    });
});

describe('pult tab', () => {
    it('opens the studio and switches the takeover', async () => {
        const setTakeover = vi.fn<(on: boolean) => Promise<boolean>>(async () => true);
        const tab = loreStudioTab(s.app, {
            settings,
            open: () => studio.open(),
            openClassic: vi.fn(),
            setTakeover,
            takeoverActive: () => false,
            bookCount: () => s.store.books().length,
        });
        const container = document.createElement('div');
        document.body.append(container);
        tab.render(container);
        expect(container.textContent).toContain('Books: 3');
        click(
            [...container.querySelectorAll<HTMLElement>('.maestro-btn')].find(
                (node) => node.textContent === 'Open the Lore Studio',
            ),
        );
        await wait();
        expect(studio.isOpen()).toBe(true);
        const toggle = container.querySelector('input[type="checkbox"]') as HTMLInputElement;
        toggle.checked = true;
        toggle.dispatchEvent(new Event('change'));
        await wait();
        expect(setTakeover).toHaveBeenCalledWith(true);
    });
});
