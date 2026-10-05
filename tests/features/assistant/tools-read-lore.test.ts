// Read tools over lorebooks and the chat canon: search, one entry, the canon list.
import { describe, expect, it } from 'vitest';
import { readTools } from '../../../src/features/assistant/tools';
import type { CanonItem } from '../../../src/features/canon/api';
import { fakeApp, runTool, toolContext } from './tools-helpers';
import type { Loose } from './tools-helpers';

const WORLD = {
    entries: {
        '1': { uid: 1, comment: 'Kai the smith', key: ['Kai', 'кузнец'], content: 'Kai forges swords in the village.' },
        '2': {
            uid: 2,
            comment: 'Anna',
            key: ['Анна', 'Аня'],
            keysecondary: ['сестра'],
            selectiveLogic: 3,
            content: 'Anna is the heroine sister. '.repeat(200),
            position: 4,
            depth: 2,
            role: 0,
            order: 50,
            probability: 80,
            useProbability: true,
            group: 'family',
            sticky: 2,
            scanDepth: 6,
            caseSensitive: false,
            matchWholeWords: true,
            characterFilter: { names: ['Kai'], isExclude: true },
            extensions: { maestro: { type: 'character', kind: 'override', status: 'active' } },
        },
        '3': { uid: 3, comment: 'Mill', key: ['мельница'], content: 'Old mill.', disable: true, constant: true },
    },
};
const ARCHIVE = { entries: { '7': { uid: 7, comment: 'Kai archive', key: ['Kai'], content: '<BunnymoTags>…' } } };

function loreFake(extra: Record<string, unknown> = {}) {
    return fakeApp({
        apis: {
            loreStore: {
                books: () => ['World', 'Archive'],
                load: async (name: string) => ({ World: WORLD, Archive: ARCHIVE })[name] ?? null,
            },
            loreJournal: { whyActive: async () => [{ book: 'World', reasons: ['global'] }] },
            ...extra,
        },
    });
}

describe('lore_search', () => {
    it('searches the active books by keys, title and text, Russian forms included', async () => {
        const fake = loreFake();
        const tools = readTools(fake.app);
        const output = await runTool(tools, 'lore_search', { query: 'кузнеца' }, toolContext(fake, { locale: 'ru' }));
        const data = output.data as { hits: Loose[]; books: number; total: number };
        expect(data.books).toBe(1);
        expect(data.hits[0]).toMatchObject({ book: 'World', uid: 1, title: 'Kai the smith', keys: ['Kai', 'кузнец'] });
        expect(output.summary).toBe('Поиск по лору «кузнеца»: найдено 1');
        expect(output.untrusted).toBe(true);
        const sister = await runTool(tools, 'lore_search', { query: 'heroine sister' }, toolContext(fake));
        const hit = (sister.data as { hits: Loose[] }).hits[0]!;
        expect(hit.uid).toBe(2);
        expect(hit.snippet.length).toBeLessThanOrEqual(200);
        const flags = await runTool(tools, 'lore_search', { query: 'mill' }, toolContext(fake));
        expect((flags.data as { hits: Loose[] }).hits[0]).toMatchObject({ disabled: true, constant: true });
    });

    it('searches one named book, and every book when none is active', async () => {
        const fake = loreFake({ loreJournal: { whyActive: async () => [] } });
        const tools = readTools(fake.app);
        const all = await runTool(tools, 'lore_search', { query: 'Kai', limit: 5 }, toolContext(fake));
        expect((all.data as { hits: { book: string }[] }).hits.map((hit) => hit.book).sort()).toEqual([
            'Archive',
            'World',
        ]);
        const one = await runTool(tools, 'lore_search', { query: 'Kai', book: 'Archive' }, toolContext(fake));
        expect((one.data as { hits: { uid: number }[] }).hits.map((hit) => hit.uid)).toEqual([7]);
        const none = await runTool(tools, 'lore_search', { query: 'the' }, toolContext(fake));
        expect((none.data as { total: number }).total).toBe(0);
    });

    it('reads through ST when the Lore Studio is off', async () => {
        const fake = fakeApp({
            ctx: { loadWorldInfo: async () => WORLD, getWorldInfoNames: () => ['World'] },
        });
        const output = await runTool(readTools(fake.app), 'lore_search', { query: 'Kai' }, toolContext(fake));
        expect((output.data as { hits: { uid: number }[] }).hits[0]!.uid).toBe(1);
    });
});

describe('lore_entry', () => {
    it('reads every activation field and caps the text', async () => {
        const fake = loreFake({
            bookRoles: { roleOf: () => ({ role: 'world', readOnly: false }) },
            lorePassports: {
                get: async () => ({ passport: { kind: 'character', name: 'Anna' }, storage: 'sidecar', updatedAt: 1 }),
            },
        });
        const output = await runTool(readTools(fake.app), 'lore_entry', { book: 'World', uid: 2 }, toolContext(fake));
        const data = output.data as Loose;
        expect(data).toMatchObject({
            book: 'World',
            uid: 2,
            bookRole: { role: 'world' },
            title: 'Anna',
            keys: ['Анна', 'Аня'],
            secondaryKeys: ['сестра'],
            logic: 'AND ALL',
            position: 'at depth',
            depth: 2,
            role: 'system',
            order: 50,
            probability: 80,
            group: 'family',
            sticky: 2,
            scanDepth: 6,
            caseSensitive: false,
            wholeWords: true,
            characterFilter: { exclude: true, names: ['Kai'] },
            maestro: { type: 'character', canon: 'override/active' },
            passport: { storage: 'sidecar', kind: 'character', name: 'Anna' },
        });
        expect(data.chars).toBe(WORLD.entries['2'].content.length);
        expect(data.content.length).toBeLessThanOrEqual(3000);
        expect(output.untrusted).toBe(true);
        expect(output.summary).toBe('Entry «Anna»');
    });

    it('says when the entry or the arguments are missing', async () => {
        const fake = loreFake();
        const tools = readTools(fake.app);
        const ctx = toolContext(fake, { locale: 'ru' });
        expect((await runTool(tools, 'lore_entry', { book: 'World', uid: 99 }, ctx)).summary).toBe(
            'В «World» нет записи 99.',
        );
        expect((await runTool(tools, 'lore_entry', { book: 'World' }, ctx)).summary).toBe('Нужны книга и uid.');
        const simple = await runTool(tools, 'lore_entry', { book: 'World', uid: '3' }, ctx);
        expect(simple.data).toMatchObject({ disabled: true, constant: true });
    });
});

describe('canon_list', () => {
    const items: CanonItem[] = [
        {
            uid: 1,
            meta: {
                kind: 'override',
                status: 'active',
                origin: 'revision',
                base: { world: 'World', uid: 2, contentHash: 'h' },
                createdAt: 1,
                updatedAt: 1,
            },
            entry: { comment: 'Anna cut her hair', key: ['Анна'], content: 'Anna now has short hair.' },
        },
        {
            uid: 2,
            meta: {
                kind: 'addition',
                status: 'provisional',
                origin: 'living',
                survivedTurns: 3,
                createdAt: 1,
                updatedAt: 1,
            },
            entry: { comment: 'Harvest festival', key: ['праздник'], content: 'The village celebrates the harvest.' },
        },
    ];

    it('lists the canon with filters, budget and the last scan', async () => {
        const calls: unknown[] = [];
        const fake = fakeApp({
            apis: {
                canon: {
                    list: async (filter: unknown) => {
                        calls.push(filter);
                        return items;
                    },
                    bookName: () => 'Maestro · канон · abc',
                    budget: () => ({ limitChars: 4000, usedChars: 120 }),
                    lastScan: () => ({
                        at: 1,
                        added: 1,
                        replaced: 1,
                        suppressed: 0,
                        pinned: 0,
                        dormant: 0,
                        missing: 0,
                        cut: 0,
                    }),
                },
            },
        });
        const tools = readTools(fake.app);
        const output = await runTool(tools, 'canon_list', { status: 'active', kind: 'bogus' }, toolContext(fake));
        expect(calls[0]).toEqual({ status: 'active' });
        const data = output.data as Loose;
        expect(data.book).toBe('Maestro · канон · abc');
        expect(data.budget).toEqual({ limitChars: 4000, usedChars: 120 });
        expect(data.items[0]).toEqual({
            uid: 1,
            kind: 'override',
            status: 'active',
            origin: 'revision',
            title: 'Anna cut her hair',
            keys: ['Анна'],
            content: 'Anna now has short hair.',
            base: 'World#2',
        });
        expect(output.summary).toBe('Canon: 2 items');
        const query = await runTool(tools, 'canon_list', { query: 'праздника' }, toolContext(fake, { locale: 'ru' }));
        expect((query.data as Loose).items.map((item: { uid: number }) => item.uid)).toEqual([2]);
        expect(query.summary).toBe('Канон: пунктов — 1');
    });
});
