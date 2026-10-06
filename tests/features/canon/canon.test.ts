import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonBookName } from '../../../src/domain/canon-book';
import { entryContentHash } from '../../../src/domain/roles-meta';
import type { BookRolesApi } from '../../../src/features/bookRoles/api';
import { canonModule } from '../../../src/features/canon';
import type { CanonApi, CanonDraft } from '../../../src/features/canon/api';
import { EVENT_TYPES } from '../../helpers/st-mock';
import { message } from '../../helpers/st-mock';
import { createCanonTestApp, listenerCount, listsFrom, runScan, settle, startModule, wi } from './helpers';
import type { CanonTestApp, Dict } from './helpers';

let env: CanonTestApp;
let canon: Required<CanonApi>;
let stop: () => Promise<void>;
let book: string;

const addition = (entry: Dict, meta: Partial<CanonDraft['meta']> = {}): CanonDraft => ({
    entry,
    meta: { kind: 'addition', status: 'active', origin: 'user', ...meta },
});

const onBase = (kind: 'override' | 'suppress' | 'pin', world: string, uid: number, entry: Dict = {}): CanonDraft => ({
    entry,
    meta: { kind, status: 'active', origin: 'user', base: { world, uid, contentHash: '' } },
});

beforeEach(async () => {
    env = createCanonTestApp();
    env.world.book('World', [
        wi(0, { key: ['castle'], content: 'An old castle.', comment: 'Castle' }),
        wi(1, { key: ['dragon'], content: 'A red dragon.', comment: 'Dragon' }),
        wi(2, { key: ['road'], content: 'A long road.', comment: 'Road' }),
        wi(3, { key: ['nobody says this'], content: 'Pinned lore.', comment: 'Pinned' }),
    ]);
    const started = await startModule(env, canonModule);
    stop = () => started.stop();
    canon = env.modules.api<Required<CanonApi>>('canon')!;
    book = canonBookName(env.mock.chatId!);
});

afterEach(async () => {
    await stop();
    delete (globalThis as { DESRU_API?: unknown }).DESRU_API;
});

describe('module', () => {
    it('registers its tab, health check, producer and scan listeners, and removes them on stop', async () => {
        expect(env.ui.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['canon', 'm6.tab', 35]]);
        expect(env.ui.checks.map((check) => check.id)).toEqual(['m6.inactive']);
        expect(env.ephemeral.producers.has('canonScan')).toBe(true);
        expect(listenerCount(env, 'WORLDINFO_ENTRIES_LOADED')).toBe(1);
        expect(listenerCount(env, 'WORLDINFO_SCAN_DONE')).toBe(1);
        expect(canon.bookName()).toBe(book);
        expect(canon.bookName('other')).toBe(canonBookName('other'));
        await stop();
        stop = async () => {};
        expect(env.ui.tabs).toEqual([]);
        expect(env.ui.checks).toEqual([]);
        expect(env.ephemeral.producers.size).toBe(0);
        expect(listenerCount(env, 'WORLDINFO_ENTRIES_LOADED')).toBe(0);
        expect(listenerCount(env, 'WORLDINFO_SCAN_DONE')).toBe(0);
        expect(listenerCount(env, 'WORLDINFO_UPDATED')).toBe(0);
    });

    it('creates the canon book once, saved immediately and never activated', async () => {
        expect(await canon.ensureBook()).toBe(book);
        expect(await canon.ensureBook()).toBe(book);
        expect(env.world.saves).toEqual([{ name: book, immediately: true }]);
        expect(env.world.listUpdates).toBe(1);
        expect(env.world.books.get(book)).toEqual({
            entries: {},
            extensions: { maestro: { role: 'canon', chatId: env.mock.chatId, chatName: env.mock.chatId } },
        });
        expect(env.world.selected).toEqual([]);
        expect(env.mock.chatMetadata.world_info).toBeUndefined();
    });

    it('needs a chat', async () => {
        env.mock.chatId = undefined;
        expect(canon.bookName()).toBe('');
        await expect(canon.put(addition({ content: 'x' }))).rejects.toThrow('No chat is open.');
        expect(await canon.list()).toEqual([]);
    });
});

describe('items', () => {
    it('put writes immediately, refreshes ST and DES, journals and undoes', async () => {
        const uid = await canon.put(addition({ comment: 'Tavern', key: ['tavern', 'таверна'], content: 'A tavern.' }));
        expect(uid).toBe(0);
        const stored = env.world.entry(book, 0)!;
        expect(stored).toMatchObject({ uid: 0, comment: 'Tavern', content: 'A tavern.', disable: false, order: 100 });
        const meta = (stored.extensions as Dict).maestro as Dict;
        expect(meta).toMatchObject({ kind: 'addition', status: 'active', origin: 'user' });
        expect(meta.createdAt).toBe(meta.updatedAt);
        expect(env.world.saves.every((save) => save.immediately)).toBe(true);
        expect(env.world.reloads).toContain(book);
        expect(env.neighbours.desInvalidated).toContain(book);
        const record = env.journal.records.at(-1)!;
        expect(record).toMatchObject({ module: 'M6', kind: 'canon.put', summary: 'Added to the chat canon: «Tavern»' });
        expect(record.changes[0]).toMatchObject({ target: 'canon-entry', ref: { book, uid: 0 }, before: null });
        expect((await canon.list()).map((item) => item.uid)).toEqual([0]);

        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.world.entry(book, 0)).toBeUndefined();
        expect(await canon.list()).toEqual([]);
    });

    it('updates the item of the same base, snapshots the base and keeps createdAt', async () => {
        const first = await canon.put(onBase('override', 'World', 1, { content: 'A dead dragon.' }));
        const created = (await canon.list())[0]!;
        expect(created.meta.base).toEqual({
            world: 'World',
            uid: 1,
            contentHash: entryContentHash({ content: 'A red dragon.' }),
            content: 'A red dragon.',
        });
        expect(created.meta.fields).toEqual(['content']);
        expect(created.entry).toMatchObject({ disable: true, comment: 'Override: Dragon' });
        await new Promise((resolve) => setTimeout(resolve, 2));
        const second = await canon.put(onBase('suppress', 'World', 1));
        expect(second).toBe(first);
        const updated = (await canon.list())[0]!;
        expect(updated.meta.kind).toBe('suppress');
        expect(updated.meta.createdAt).toBe(created.meta.createdAt);
        expect(updated.meta.updatedAt).toBeGreaterThan(created.meta.updatedAt);
        expect(env.journal.records.at(-1)?.summary).toBe('Changed in the chat canon: «Suppressed: Dragon»');
        const pin = await canon.put(onBase('pin', 'World', 1));
        expect(pin).not.toBe(first);
        expect(await canon.list({ kind: 'pin' })).toHaveLength(1);
    });

    it('keeps a lore passport stored in the item when the item is updated (M28)', async () => {
        const uid = await canon.put(onBase('override', 'World', 1, { content: 'A dead dragon.' }));
        const stored = env.world.entry(book, uid)!;
        const extensions = stored.extensions as Dict;
        const passport = { passport: { name: 'Dragon', tags: 'dragon, red scales' }, generatedBy: 'user' };
        await env.world.edit(book, uid, {
            extensions: { ...extensions, maestro: { ...(extensions.maestro as Dict), passport } },
        });
        await settle();
        await canon.put(onBase('override', 'World', 1, { content: 'A sleeping dragon.' }));
        const updated = env.world.entry(book, uid)!;
        expect(updated.content).toBe('A sleeping dragon.');
        expect(((updated.extensions as Dict).maestro as Dict).passport).toEqual(passport);
    });

    it('rejects drafts without a base or with an unknown kind', async () => {
        await expect(
            canon.put({ entry: {}, meta: { kind: 'override', status: 'active', origin: 'user' } }),
        ).rejects.toThrow('needs a base entry');
        await expect(
            canon.put({ entry: {}, meta: { kind: 'other' as 'pin', status: 'active', origin: 'user' } }),
        ).rejects.toThrow('Unknown kind');
    });

    it('removes and changes status with undo', async () => {
        const uid = await canon.put(addition({ comment: 'Fact', content: 'Fact.' }, { status: 'provisional' }));
        await canon.setStatus(uid, 'archived');
        expect((await canon.list({ status: 'archived' })).map((item) => item.uid)).toEqual([uid]);
        await canon.setStatus(uid, 'archived');
        expect(env.journal.records.filter((record) => record.kind === 'canon.status')).toHaveLength(1);
        await env.journal.undo(env.journal.records.at(-1)!.id);
        expect((await canon.list())[0]?.meta.status).toBe('provisional');

        await canon.remove(uid);
        expect(await canon.list()).toEqual([]);
        await canon.remove(99);
        await env.journal.undo(env.journal.records.at(-1)!.id);
        expect((await canon.list()).map((item) => item.entry.comment)).toEqual(['Fact']);
    });

    it('never writes during a generation (P8)', async () => {
        env.turn.generation = { type: 'normal', dryRun: false, quiet: false };
        const pending = canon.put(addition({ content: 'Later.' }));
        await settle();
        expect(env.world.books.has(book)).toBe(false);
        env.turn.generation = null;
        await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        expect(await pending).toBe(0);
        expect(env.world.entry(book, 0)?.content).toBe('Later.');
    });

    it('writes a queued item into the chat it was made in, even after a chat switch', async () => {
        env.turn.generation = { type: 'normal', dryRun: false, quiet: false };
        const pending = canon.put(addition({ content: 'Belongs to Alice.' }));
        await settle();
        env.mock.chatId = 'Bob - 2026-10-04@13h00m00s';
        env.mock.chatMetadata = {};
        await env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, env.mock.chatId);
        env.turn.generation = null;
        await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await pending;
        expect(env.world.entry(book, 0)?.content).toBe('Belongs to Alice.');
        expect(env.world.books.has(canonBookName(env.mock.chatId))).toBe(false);
    });

    it('notices edits made elsewhere (WORLDINFO_UPDATED)', async () => {
        await canon.put(addition({ comment: 'Fact', content: 'Fact.' }));
        let changes = 0;
        const off = canon.onChange(() => changes++);
        await env.world.edit(book, 0, { content: 'Edited in ST.' });
        expect((await canon.list())[0]?.entry.content).toBe('Edited in ST.');
        expect(changes).toBeGreaterThan(0);
        off();
    });
});

describe('scan', () => {
    async function seed(): Promise<void> {
        await canon.put(addition({ comment: 'Tavern', key: ['tavern'], content: 'A tavern by the road.' }));
        await canon.put(onBase('override', 'World', 1, { content: 'The dragon is dead.', key: ['dragon', 'дракон'] }));
        await canon.put(onBase('suppress', 'World', 2));
        await canon.put(onBase('pin', 'World', 3));
    }

    it('mixes additions, overrides in place, suppressions and pins into the scan', async () => {
        await seed();
        const lists = listsFrom(env.world, { characterLore: ['World'] });
        const before = lists.characterLore[1]!;
        const result = await runScan(env, lists, 'we enter the tavern and see the dragon');
        expect(lists.characterLore.map((entry) => entry.uid)).toEqual([0, 1, 3]);
        expect(lists.characterLore[1]).not.toBe(before);
        expect(lists.characterLore[1]).toMatchObject({
            world: 'World',
            uid: 1,
            content: 'The dragon is dead.',
            key: ['dragon', 'дракон'],
            comment: 'Dragon',
        });
        expect(before).toMatchObject({ content: 'A red dragon.', key: ['dragon'] });
        expect(lists.chatLore.map((entry) => [entry.world, entry.uid])).toEqual([[book, 0]]);
        expect([...result.activated.keys()].sort()).toEqual([`${book}.0`, 'World.1', 'World.3'].sort());
        expect(result.activated.get('World.1')?.content).toBe('The dragon is dead.');
        expect(result.sorted.some((entry) => entry.world === 'World' && entry.uid === 2)).toBe(false);
        expect(canon.lastScan()).toMatchObject({ added: 1, replaced: 1, suppressed: 1, pinned: 1, cut: 0, missing: 0 });
        expect(canon.budget()).toEqual({ limitChars: 8000, usedChars: 'A tavern by the road.'.length + 19 });
    });

    it('is idempotent when the event fires again for the same lists', async () => {
        await seed();
        const lists = listsFrom(env.world, { globalLore: ['World'] });
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
        const once = JSON.stringify(lists);
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
        expect(JSON.stringify(lists)).toBe(once);
    });

    it('cuts canon activations above the budget, lowest order first, and keeps pins', async () => {
        env.settings.module<{ budgetChars: number }>('canon').budgetChars = 30;
        await canon.put(addition({ comment: 'Low', key: ['tavern'], content: 'Low priority text.', order: 10 }));
        await canon.put(addition({ comment: 'High', key: ['tavern'], content: 'High priority text.', order: 90 }));
        await canon.put(onBase('pin', 'World', 3));
        const result = await runScan(env, listsFrom(env.world, { globalLore: ['World'] }), 'the tavern');
        expect(result.activated.has(`${book}.1`)).toBe(true);
        expect(result.activated.has(`${book}.0`)).toBe(false);
        expect(result.sorted.find((entry) => entry.world === book && entry.uid === 0)?.disable).toBe(true);
        expect(result.activated.has('World.3')).toBe(true);
        expect(canon.budget()).toEqual({ limitChars: 30, usedChars: 'High priority text.'.length });
        expect(canon.lastScan()?.cut).toBe(1);
    });

    it('brings archived items back only when the last messages mention them', async () => {
        await canon.put(
            addition({ comment: 'Old', key: ['tavern', 'mermaid'], content: 'Old fact.' }, { status: 'archived' }),
        );
        const quiet = listsFrom(env.world, { globalLore: ['World'] });
        await runScan(env, quiet, 'the tavern');
        expect(quiet.chatLore).toEqual([]);
        expect(canon.lastScan()?.dormant).toBe(1);
        env.mock.chat.push(message('A mermaid swims by.'), message('Hello', { is_user: true }));
        const loud = listsFrom(env.world, { globalLore: ['World'] });
        await runScan(env, loud, 'the tavern');
        expect(loud.chatLore.map((entry) => entry.comment)).toEqual(['Old']);
    });

    it('strips a canon book that is active in ST and warns once', async () => {
        await canon.put(onBase('override', 'World', 0, { content: 'Ruins.' }));
        const lists = listsFrom(env.world, { globalLore: ['World', book] });
        await runScan(env, lists, 'castle');
        await runScan(env, listsFrom(env.world, { globalLore: ['World', book] }), 'castle');
        expect(lists.globalLore.filter((entry) => entry.world === book)).toEqual([]);
        expect(lists.globalLore.find((entry) => entry.uid === 0)?.content).toBe('Ruins.');
        const warnings = env.ui.notices.filter((notice) => notice.text.includes('switched on in SillyTavern'));
        expect(warnings).toHaveLength(1);
        expect(warnings[0]?.options).toMatchObject({ importance: 'important', level: 'warn' });
    });

    it('reports canon books in the health check', async () => {
        env.neighbours.active = ['World', book];
        expect(await env.ui.checks[0]!.run()).toMatchObject({ status: 'warn' });
        env.neighbours.active = ['World'];
        expect(await env.ui.checks[0]!.run()).toMatchObject({ status: 'ok' });
    });
});

describe('base book actions', () => {
    it('reports base drift with the text then and now', async () => {
        await canon.put(onBase('override', 'World', 1, { content: 'The dragon is dead.' }));
        await canon.put(onBase('pin', 'World', 0));
        expect(await canon.baseDrift()).toEqual([]);
        await env.world.edit('World', 1, { content: 'A blue dragon.' });
        const drift = await canon.baseDrift();
        expect(drift.map((row) => [row.item.meta.kind, row.baseThen, row.baseNow])).toEqual([
            ['override', 'A red dragon.', 'A blue dragon.'],
        ]);
    });

    it('follows a renamed base book in every chat canon', async () => {
        await canon.put(onBase('override', 'World', 1, { content: 'The dragon is dead.' }));
        await canon.put(addition({ key: ['tavern'], content: 'A tavern.' }));
        const other = canonBookName('other-chat');
        env.world.book(other, [
            wi(0, {
                disable: true,
                extensions: {
                    maestro: {
                        kind: 'suppress',
                        status: 'active',
                        origin: 'user',
                        createdAt: 0,
                        updatedAt: 0,
                        base: { world: 'World', uid: 2, contentHash: '' },
                    },
                },
            }),
        ]);
        expect(await canon.renameBase('World', 'Realm')).toBe(2);
        const bases = [book, other].flatMap((name) =>
            Object.values(env.world.entries(name)).map(
                (entry) => ((entry.extensions as Dict).maestro as { base?: { world: string } }).base?.world,
            ),
        );
        expect(bases.filter(Boolean)).toEqual(['Realm', 'Realm']);
        expect(await canon.renameBase('World', 'Realm')).toBe(0);
    });

    it('promotes an override into the base book after confirmation, with undo', async () => {
        const uid = await canon.put(onBase('override', 'World', 1, { content: 'The dragon is dead.' }));
        env.ui.confirmAnswer = false;
        expect(await canon.promote(uid)).toBe(false);
        expect(env.world.entry('World', 1)?.content).toBe('A red dragon.');
        env.ui.confirmAnswer = true;
        expect(await canon.promote(uid)).toBe(true);
        expect(env.world.entry('World', 1)).toMatchObject({ content: 'The dragon is dead.', key: ['dragon'] });
        expect(env.world.entry('World', 1)).not.toHaveProperty('world');
        expect(await canon.list()).toEqual([]);
        const record = env.journal.records.at(-1)!;
        expect(record.changes.map((change) => change.target)).toEqual(['canon-base-entry', 'canon-entry']);
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.world.entry('World', 1)?.content).toBe('A red dragon.');
        expect((await canon.list()).map((item) => item.uid)).toEqual([uid]);
    });

    it('refuses to promote into read-only books and additions', async () => {
        const roles: Partial<BookRolesApi> = {
            roleOf: (name) =>
                name === 'World'
                    ? {
                          book: name,
                          role: 'bunnymo.pack',
                          source: 'auto',
                          fingerprint: '',
                          readOnly: true,
                          localizable: false,
                      }
                    : undefined,
        };
        env.modules.expose('bookRoles', roles);
        const uid = await canon.put(onBase('suppress', 'World', 1));
        expect(await canon.promote(uid)).toBe(false);
        expect(env.ui.notices.at(-1)?.text).toContain('read-only');
        expect(env.ui.confirms).toEqual([]);
        const fact = await canon.put(addition({ content: 'x' }));
        expect(await canon.promote(fact)).toBe(false);
        expect(await canon.promote(404)).toBe(false);
    });

    it('exports a plain lorebook with overrides expanded and a note, and undo deletes it', async () => {
        await expect(canon.exportPlain()).rejects.toThrow('nothing to export');
        await canon.put(addition({ comment: 'Tavern', key: ['tavern'], content: 'A tavern.' }));
        await canon.put(onBase('override', 'World', 1, { content: 'The dragon is dead.' }));
        await canon.put(onBase('suppress', 'World', 2));
        const name = await canon.exportPlain();
        expect(name).toBe(`${env.mock.chatId} — канон`);
        const entries = Object.values(env.world.entries(name));
        expect(entries.map((entry) => entry.comment)).toEqual([
            'Tavern',
            'Dragon',
            'Maestro canon: base entries to review',
        ]);
        expect(entries[1]).toMatchObject({ content: 'The dragon is dead.', key: ['dragon'], disable: false });
        expect(entries[2]?.content).toContain('- World — Road (uid 2)');
        expect(entries.every((entry) => !(entry.extensions as Dict | undefined)?.maestro)).toBe(true);
        expect(env.world.books.get(name)).not.toHaveProperty('extensions');
        expect(env.world.selected).toEqual([]);
        expect(await canon.exportPlain()).toBe(`${env.mock.chatId} — канон (2)`);
        expect(await env.journal.undo(env.journal.records.at(-1)!.id)).toBe(true);
        expect(env.world.deleted).toEqual([`${env.mock.chatId} — канон (2)`]);
    });
});

describe('prepare to turn off', () => {
    it('exports the canon of every chat that has items, named after its chat', async () => {
        await canon.put(addition({ comment: 'Tavern', key: ['tavern'], content: 'A tavern.' }));
        const other = canonBookName('other-chat');
        env.world.book(other, [wi(0, { comment: 'Bell', key: ['bell'], content: 'A bell.' })], {
            maestro: { role: 'canon', chatId: 'other-chat', chatName: 'Other chat' },
        });
        env.world.book(canonBookName('empty-chat'), []);
        const names = await canon.exportAll();
        expect(names.sort()).toEqual([`${env.mock.chatId} — канон`, 'Other chat — канон'].sort());
        expect(Object.values(env.world.entries('Other chat — канон')).map((entry) => entry.comment)).toContain('Bell');
    });
});

describe('russian keys and glosses', () => {
    it('uses DES-RU forms, then its key, then the fallback', async () => {
        expect(await canon.russianKeys('Маша')).toEqual(['Маша', '/(?:^|[^\\p{L}\\p{N}_])Маш/iu']);
        expect(await canon.russianKeys('Masha')).toEqual(['Masha']);
        (globalThis as { DESRU_API?: unknown }).DESRU_API = {
            nameForms: (name: string) => (name === 'Маша' ? ['Маша', 'Маши', 'Машей'] : []),
            nameFormsKey: (name: string) => (name === 'Петя' ? '/Пет(?:я|и|е)/iu' : null),
        };
        expect(await canon.russianKeys('Маша')).toEqual(['Маша', 'Маши', 'Машей']);
        expect(await canon.russianKeys('Петя')).toEqual(['/Пет(?:я|и|е)/iu']);
        env.neighbours.desruApi = {
            nameForms: () => {
                throw new Error('boom');
            },
        };
        expect(await canon.russianKeys('Маша')).toEqual(['Маша', '/(?:^|[^\\p{L}\\p{N}_])Маш/iu']);
    });

    it('adds English names of Russian mentions as a scan-only injection', async () => {
        await canon.put(addition({ comment: 'Elizabeth', key: ['Elizabeth', 'Элизабет'], content: 'She rules.' }));
        env.neighbours.desAliases = { Rowan: ['Роуэн'] };
        env.neighbours.desruApi = {
            nameForms: (name: string) => (name === 'Лиза' ? ['Лизой'] : []),
            aliases: () => ({ Liz: ['Лиза'] }),
        };
        env.world.book('Castle book', [
            wi(0, {
                key: ['Castle', 'Замок'],
                extensions: {
                    lorebook_localizer: {
                        version: 1,
                        languages: {
                            ru: {
                                language: 'Russian',
                                sources: ['Castle'],
                                added: { key: ['Замок', 'Замку'], keysecondary: [] },
                            },
                        },
                    },
                },
            }),
        ]);
        await runScan(env, listsFrom(env.world, { globalLore: ['Castle book'] }), '');
        env.mock.chat.push(
            message('Элизабетой восхищались все.'),
            message('Роуэна позвали к замку, а с Лизой мы молчали.', { is_user: true }),
        );
        await env.ephemeral.run();
        expect(env.ephemeral.injections.get('canonScan')).toEqual({
            text: 'Castle, Elizabeth, Liz, Rowan',
            position: -1,
            depth: 0,
            scan: true,
            role: 0,
        });
        env.settings.module<{ scanGlosses: boolean }>('canon').scanGlosses = false;
        await env.ephemeral.run();
        expect(env.ephemeral.injections.size).toBe(0);
    });

    it('sets nothing when no known name is mentioned', async () => {
        env.mock.chat.push(message('Тишина.'));
        await env.ephemeral.run();
        expect(env.ephemeral.injections.size).toBe(0);
    });
});

describe('branches', () => {
    it('offers to copy the parent canon once, through autonomy (Inbox by default)', async () => {
        const parent = 'Alice - parent chat';
        env.world.book(canonBookName(parent), [
            wi(0, { extensions: { maestro: { kind: 'addition', status: 'active', origin: 'user' } } }),
        ]);
        env.mock.chatId = 'Alice - parent chat - Branch #1';
        env.mock.chatMetadata = { main_chat: parent };
        await env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, env.mock.chatId);
        await settle();
        const proposal = env.autonomy.proposals.at(-1)!;
        expect(proposal.kind).toBe('canon.branchCopy');
        expect(proposal).toMatchObject({
            title: 'Canon for the new branch of the chat',
            details: `Canon lorebook of the parent chat: ${canonBookName(parent)}`,
            appliedNotice: { text: `Copied the canon of «${parent}» into this branch.` },
        });
        expect(proposal.description).not.toContain(canonBookName(parent));
        expect(env.autonomy.levels.get('canon.branchCopy')).toBeUndefined();
        await env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, env.mock.chatId);
        await settle();
        expect(env.autonomy.proposals.filter((item) => item.kind === 'canon.branchCopy')).toHaveLength(1);

        const applier = env.inbox.appliers.get('canon.branchCopy')!;
        await applier(proposal.payload);
        const copied = env.world.books.get(canonBookName(env.mock.chatId));
        expect(copied?.extensions).toMatchObject({ maestro: { role: 'canon', copiedFrom: canonBookName(parent) } });
        expect((await canon.list()).map((item) => item.uid)).toEqual([0]);
        await expect(applier(proposal.payload)).rejects.toThrow('not copied');
    });

    it('does not offer when this is not a branch or the parent has no canon', async () => {
        env.mock.chatMetadata = { main_chat: 'no canon here' };
        await env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, env.mock.chatId);
        await settle();
        expect(env.autonomy.proposals).toEqual([]);
    });
});
