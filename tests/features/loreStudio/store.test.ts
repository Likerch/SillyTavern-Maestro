// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { LoreStudioError } from '../../../src/features/loreStudio/st-lore';
import { PER_ENTRY_JOURNAL_LIMIT, UNDO_BOOK, UNDO_ENTRY } from '../../../src/features/loreStudio/store';
import { createStand, entry, flush, resetDom } from './stand';
import type { Stand } from './stand';

let s: Stand;
let off: () => void;
const user = { module: 'user', summary: 'test' };

beforeEach(() => {
    resetDom();
    s = createStand();
    off = s.store.install();
});

afterEach(() => {
    off();
});

describe('reading', () => {
    it('hands out deep copies, never ST’s cache object', async () => {
        s.addBook('World', { 0: entry(0, { content: 'a' }) });
        const first = await s.store.load('World');
        first!.entries['0']!.content = 'changed';
        expect(s.cache.get('World')?.entries['0']?.content).toBe('a');
        const second = await s.store.load('World');
        expect(second!.entries['0']!.content).toBe('a');
        expect(s.store.books()).toEqual(['World']);
    });
});

describe('the save path', () => {
    beforeEach(() => {
        s.addBook(
            'World',
            {
                0: entry(0, { comment: 'Anna', extensions: { other_extension: { keep: 1 } }, unknownField: 'x' }),
            },
            { name: 'World', extensions: { book_level: true } },
        );
    });

    it('saves immediately, reloads the classic editor and resets the DES cache', async () => {
        const changes: (string | null)[] = [];
        s.store.onChange((book) => changes.push(book));
        await s.store.updateEntry('World', 0, { content: 'Lives in Rome' }, user);
        await flush(s);
        expect(s.wi.saves).toHaveLength(1);
        expect(s.wi.saves[0]).toMatchObject({ name: 'World', immediately: true });
        expect(s.reloads).toEqual(['World']);
        expect(s.des.invalidated).toEqual(['World']);
        // Our own WORLDINFO_UPDATED is not reported a second time as an external change.
        expect(changes).toEqual(['World']);
    });

    it('round-trips unknown entry and book fields', async () => {
        await s.store.updateEntry('World', 0, { content: 'x' }, user);
        const saved = s.book('World');
        expect(saved.extensions).toEqual({ book_level: true });
        expect(saved.name).toBe('World');
        expect(saved.entries['0']).toMatchObject({
            unknownField: 'x',
            extensions: { other_extension: { keep: 1 } },
            content: 'x',
        });
    });

    it('never touches an object after handing it to saveWorldInfo', async () => {
        await s.store.updateEntry('World', 0, { content: 'one' }, user);
        const handed = s.wi.saves[0]!.data as { entries: Record<string, { content: string }> };
        await s.store.updateEntry('World', 0, { content: 'two' }, user);
        expect(handed.entries['0']!.content).toBe('one');
    });

    it('queues saves per book: concurrent edits of one book all land', async () => {
        await Promise.all([
            s.store.updateEntry('World', 0, { content: 'c' }, user),
            s.store.updateEntry('World', 0, { comment: 'renamed' }, user),
            s.store.createEntry('World', { comment: 'new' }),
        ]);
        const saved = s.book('World');
        expect(saved.entries['0']).toMatchObject({ content: 'c', comment: 'renamed' });
        expect(saved.entries['1']).toMatchObject({ comment: 'new' });
        expect(s.wi.saves.every((save) => save.immediately)).toBe(true);
    });

    it('saves two books at the same time without losing either', async () => {
        s.addBook('Other', { 0: entry(0) });
        await Promise.all([
            s.store.updateEntry('World', 0, { content: 'w' }, user),
            s.store.updateEntry('Other', 0, { content: 'o' }, user),
        ]);
        expect(s.book('World').entries['0']!.content).toBe('w');
        expect(s.book('Other').entries['0']!.content).toBe('o');
    });

    it('mirrors originalData of card books through ST’s setter', async () => {
        s.addBook(
            'Card',
            { 0: entry(0, { comment: 'a', disable: false, position: 1 }), 1: entry(1) },
            {
                originalData: {
                    entries: [{ uid: 0, comment: 'a', enabled: true, position: 'after_char' }, { uid: 1 }],
                },
            },
        );
        await s.store.updateEntry('Card', 0, { comment: 'b', disable: true, position: 0, outletName: 'o' }, user);
        await s.store.deleteEntry('Card', 1);
        const original = s.book('Card').originalData as { entries: Record<string, unknown>[] };
        expect(original.entries).toEqual([
            {
                uid: 0,
                comment: 'b',
                enabled: false,
                position: 'before_char',
                extensions: { position: 0, outlet_name: 'o' },
            },
        ]);
        expect(s.wi.setWIOriginalDataValue).toHaveBeenCalled();
        expect(s.wi.deleteWIOriginalDataValue).toHaveBeenCalledWith(expect.anything(), 1);
    });

    it('save() writes a whole book through the same path', async () => {
        const data = await s.store.load('World');
        data!.entries['0']!.comment = 'whole';
        await s.store.save('World', data!, { module: 'M6', summary: 'canon' });
        expect(s.book('World').entries['0']!.comment).toBe('whole');
        expect(s.journal.last().module).toBe('M6');
        expect(await s.store.history('World', 0)).toEqual([expect.objectContaining({ by: 'M6', summary: 'canon' })]);
    });
});

describe('journal and undo', () => {
    beforeEach(() => s.addBook('World', { 0: entry(0, { content: 'old' }) }));

    it('journals entry changes with an undo target', async () => {
        await s.store.updateEntry('World', 0, { content: 'new' }, user);
        const record = s.journal.last();
        expect(record.module).toBe('M23');
        expect(record.changes[0]).toMatchObject({
            target: UNDO_ENTRY,
            ref: { book: 'World', uid: 0 },
            before: { content: 'old' },
            after: { content: 'new' },
        });
        expect(await s.journal.undo(record.id)).toBe(true);
        expect(s.book('World').entries['0']!.content).toBe('old');
    });

    it('refuses to undo over a newer edit', async () => {
        await s.store.updateEntry('World', 0, { content: 'new' }, user);
        const id = s.journal.last().id;
        await s.store.updateEntry('World', 0, { content: 'newer' }, user);
        expect(await s.journal.undo(id)).toBe(false);
        expect(s.book('World').entries['0']!.content).toBe('newer');
    });

    it('undoes a created entry by removing it', async () => {
        const uid = await s.store.createEntry('World');
        expect(await s.journal.undo(s.journal.last().id)).toBe(true);
        expect(s.book('World').entries[String(uid)]).toBeUndefined();
    });

    it('journals large changes as one book snapshot', async () => {
        const many = Object.fromEntries(Array.from({ length: PER_ENTRY_JOURNAL_LIMIT + 3 }, (_, i) => [i, entry(i)]));
        s.addBook('Big', many);
        const patches = Object.keys(many).map((uid) => ({ uid: Number(uid), patch: { order: 7 } }));
        await s.store.patchEntries('Big', patches, user);
        const record = s.journal.last();
        expect(record.changes).toHaveLength(1);
        expect(record.changes[0]?.target).toBe(UNDO_BOOK);
        expect(await s.journal.undo(record.id)).toBe(true);
        expect(s.book('Big').entries['0']!.order).toBeUndefined();
    });
});

describe('history', () => {
    beforeEach(() => s.addBook('World', { 0: entry(0, { content: 'v1' }) }));

    it('keeps previous versions per entry in a Maestro file, newest first', async () => {
        await s.store.updateEntry('World', 0, { content: 'v2' }, user);
        await s.store.updateEntry('World', 0, { content: 'v3' }, { module: 'M6', summary: 'canon' });
        const versions = await s.store.history('World', 0);
        expect(versions.map((version) => version.entry.content)).toEqual(['v2', 'v1']);
        expect(versions.map((version) => version.by)).toEqual(['M6', 'user']);
        expect([...s.files.map.keys()].some((name) => /^maestro-lore-history-.+\.json$/.test(name))).toBe(true);
    });

    it('attributes external changes of a known book to «st» and reports them', async () => {
        await s.store.load('World');
        const changes: (string | null)[] = [];
        s.store.onChange((book) => changes.push(book));
        // The classic editor (or CK, Localizer, a slash command) saves the book.
        const external = { entries: { 0: entry(0, { content: 'edited in ST' }) } };
        s.server.set('World', external);
        await s.emit('WORLDINFO_UPDATED', 'World', external);
        await flush(s);
        expect(changes).toContain('World');
        const versions = await s.store.history('World', 0);
        expect(versions[0]).toMatchObject({ by: 'st', entry: { content: 'v1' } });
    });
});

describe('entries', () => {
    beforeEach(() =>
        s.addBook('World', { 0: entry(0, { displayIndex: 5 }), 2: entry(2, { comment: 'two', custom: 1 }) }),
    );

    it('creates entries with the smallest free uid at the end of the manual order', async () => {
        const uid = await s.store.createEntry('World', { comment: 'new' });
        expect(uid).toBe(1);
        expect(s.book('World').entries['1']).toMatchObject({
            uid: 1,
            comment: 'new',
            displayIndex: 6,
            order: 100,
            selective: true,
        });
    });

    it('duplicates every field under a free uid', async () => {
        const uid = await s.store.duplicateEntry('World', 2);
        expect(uid).toBe(1);
        expect(s.book('World').entries['1']).toMatchObject({ uid: 1, comment: 'two', custom: 1 });
        await expect(s.store.duplicateEntry('World', 9)).rejects.toBeInstanceOf(LoreStudioError);
    });

    it('moves and copies entries between books', async () => {
        s.addBook('Target', { 0: entry(0, { displayIndex: 3 }) });
        const copied = await s.store.moveEntries('World', [2], 'Target', true);
        expect(copied).toEqual([1]);
        expect(s.book('Target').entries['1']).toMatchObject({ comment: 'two', displayIndex: 4 });
        expect(s.book('World').entries['2']).toBeDefined();
        const moved = await s.store.moveEntry('World', 2, 'Target', false);
        expect(moved).toBe(2);
        expect(s.book('World').entries['2']).toBeUndefined();
        expect(await s.store.moveEntries('World', [0], 'World', false)).toEqual([0]);
    });

    it('never deadlocks on crossing moves', async () => {
        s.addBook('Target', { 0: entry(0) });
        await Promise.all([
            s.store.moveEntries('World', [2], 'Target', true),
            s.store.moveEntries('Target', [0], 'World', true),
        ]);
        expect(Object.keys(s.book('Target').entries)).toHaveLength(2);
        expect(Object.keys(s.book('World').entries)).toHaveLength(3);
    });

    it('deletes entries and bulk-patches in one save', async () => {
        const saves = s.wi.saves.length;
        const changed = await s.store.patchEntries(
            'World',
            [
                { uid: 0, patch: { disable: true } },
                { uid: 2, patch: { disable: true } },
            ],
            user,
        );
        expect(changed).toBe(2);
        expect(s.wi.saves.length).toBe(saves + 1);
        expect(await s.store.patchEntries('World', [{ uid: 0, patch: { disable: true } }], user)).toBe(0);
        await expect(s.store.patchEntries('World', [{ uid: 7, patch: {} }], user)).rejects.toBeInstanceOf(
            LoreStudioError,
        );
        expect(await s.store.deleteEntries('World', [0, 7])).toBe(1);
        expect(await s.store.deleteEntries('Nope', [0])).toBe(0);
    });

    it('restores a stored version', async () => {
        await s.store.updateEntry('World', 2, { comment: 'changed' }, user);
        const [version] = await s.store.history('World', 2);
        await s.store.restoreVersion('World', 2, version!);
        expect(s.book('World').entries['2']!.comment).toBe('two');
    });

    it('protects BunnyMo books (P13)', async () => {
        s.bunny.packs.push('MBTI');
        s.addBook('MBTI', { 0: entry(0) });
        await expect(s.store.updateEntry('MBTI', 0, { content: 'x' }, user)).rejects.toMatchObject({
            code: 'readOnly',
        });
        await expect(s.store.createEntry('MBTI')).rejects.toMatchObject({ code: 'readOnly' });
        await expect(s.store.moveEntries('World', [2], 'MBTI', true)).rejects.toMatchObject({ code: 'readOnly' });
        // Copying out of a pack is fine.
        expect(await s.store.moveEntries('MBTI', [0], 'World', true)).toEqual([1]);
    });

    it('takes the role from M35 when it runs; books it has not detected yet stay read-only (P13)', () => {
        s.apis.set('bookRoles', {
            roleOf: (book: string) => (book === 'World' ? { book, role: 'bunnymo.core', readOnly: true } : undefined),
        });
        expect(s.store.roleOf('World')).toMatchObject({ role: 'bunnymo.core', readOnly: true });
        expect(s.store.roleOf('Other')).toEqual({ role: 'world', readOnly: true, pending: true });
    });
});

describe('books', () => {
    it('creates sanitized books and refuses duplicates', async () => {
        s.addBook('Rome', {});
        expect(await s.store.createBook('  New: World? ')).toBe('New World');
        expect(s.server.get('New World')).toEqual({ entries: {} });
        expect(s.wi.listUpdates).toBeGreaterThan(0);
        await expect(s.store.createBook('rome')).rejects.toMatchObject({ code: 'exists' });
        await expect(s.store.createBook(' ?? ')).rejects.toMatchObject({ code: 'emptyName' });
        expect(s.journal.last().changes[0]).toMatchObject({
            target: UNDO_BOOK,
            ref: { op: 'create', book: 'New World' },
        });
    });

    it('duplicates a book with its originalData', async () => {
        s.addBook('Card', { 0: entry(0) }, { originalData: { entries: [{ uid: 0 }] } });
        await s.store.duplicateBook('Card', 'Card (1)');
        expect(s.book('Card (1)')).toEqual(s.book('Card'));
        expect(s.store.books()).toContain('Card (1)');
    });

    it('renames with every link moved (global, characters, charLore, personas, chat, DES, history)', async () => {
        const modules = s.installDes();
        s.addBook('Old', { 0: entry(0, { content: 'v1' }) });
        s.wi.selected_world_info.push('Old');
        const characters = s.mock.context.characters as unknown as { data: { extensions: { world: string } } }[];
        characters[0]!.data.extensions.world = 'Old';
        characters[1]!.data.extensions.world = 'Old';
        s.wi.world_info.charLore.push({ name: 'bob', extraBooks: ['Old', 'X'] });
        s.power.persona_description_lorebook = 'Old';
        (s.power.persona_descriptions as Record<string, { lorebook: string }>)['other.png']!.lorebook = 'Old';
        s.mock.chatMetadata.world_info = 'Old';
        // Anna is open in ST's character form: her link goes through ST's own setter.
        const form = document.createElement('input');
        form.id = 'character_world';
        document.body.append(form);
        await s.store.updateEntry('Old', 0, { content: 'v2' }, user);

        await s.store.renameBook('Old', 'New');

        expect(s.store.books()).toEqual(['New']);
        expect(s.book('New').entries['0']!.content).toBe('v2');
        expect(s.wi.selected_world_info).toEqual(['New']);
        expect(characters[0]!.data.extensions.world).toBe('New');
        expect(s.wi.charUpdatePrimaryWorld).toHaveBeenCalledWith('New');
        expect(characters[1]!.data.extensions.world).toBe('New');
        expect(s.wi.world_info.charLore).toEqual([{ name: 'bob', extraBooks: ['X', 'New'] }]);
        expect(s.power.persona_description_lorebook).toBe('New');
        expect((s.power.persona_descriptions as Record<string, { lorebook: string }>)['other.png']!.lorebook).toBe(
            'New',
        );
        expect(s.mock.chatMetadata.world_info).toBe('New');
        expect(modules.campaigns.onWorldRenamed).toHaveBeenCalledWith('Old', 'New');
        expect(s.des.invalidated).toContain('Old');
        expect((await s.store.history('New', 0)).map((version) => version.entry.content)).toEqual(['v1']);
        // Undo renames back.
        expect(await s.journal.undo(s.journal.last().id)).toBe(true);
        expect(s.store.books()).toEqual(['Old']);
    });

    it('refuses renames to the same or a taken name', async () => {
        s.addBook('A', {});
        s.addBook('B', {});
        await expect(s.store.renameBook('A', 'a')).rejects.toMatchObject({ code: 'sameName' });
        await expect(s.store.renameBook('A', 'b')).rejects.toMatchObject({ code: 'exists' });
        await expect(s.store.renameBook('Z', 'Y')).rejects.toMatchObject({ code: 'missing' });
    });

    it('deletes through ST, cleans charLore, tells DES and can be undone', async () => {
        const modules = s.installDes();
        s.addBook('Doomed', { 0: entry(0, { content: 'keep me' }) });
        s.wi.selected_world_info.push('Doomed');
        s.wi.world_info.charLore.push({ name: 'anna', extraBooks: ['Doomed'] });
        await s.store.deleteBook('Doomed');
        expect(s.store.books()).toEqual([]);
        expect(s.wi.deleted).toEqual(['Doomed']);
        expect(s.wi.world_info.charLore).toEqual([]);
        expect(modules.campaigns.onWorldDeleted).toHaveBeenCalledWith('Doomed');
        expect(await s.journal.undo(s.journal.last().id)).toBe(true);
        expect(s.book('Doomed').entries['0']!.content).toBe('keep me');
        expect(s.wi.selected_world_info).toContain('Doomed');
    });

    it('imports through ST’s importer and drops the cached copy', async () => {
        const file = new File([JSON.stringify({ entries: { 0: { uid: 0, content: 'imported' } } })], 'Fresh.json');
        expect(await s.store.importBook(file)).toBe('Fresh');
        expect(s.wi.importWorldInfo).toHaveBeenCalledWith(file);
        expect(s.journal.last().changes[0]).toMatchObject({ ref: { op: 'import', book: 'Fresh' } });
        // An import over an existing book can be undone back to the old content; ST's cached copy is dropped.
        const again = new File([JSON.stringify({ entries: { 0: { uid: 0, content: 'second' } } })], 'Fresh.json');
        expect(await s.store.importBook(again)).toBe('Fresh');
        expect(s.cache.has('Fresh')).toBe(false);
        expect((await s.store.load('Fresh'))!.entries['0']!.content).toBe('second');
        expect(await s.journal.undo(s.journal.last().id)).toBe(true);
        expect(s.book('Fresh').entries['0']!.content).toBe('imported');
        s.wi.allowOverwrite = false;
        expect(await s.store.importBook(again)).toBe('');
    });

    it('imports the card’s embedded book and binds it as the primary book', async () => {
        const characters = s.mock.context.characters as unknown as {
            name: string;
            data: { extensions: { world: string }; character_book?: unknown };
        }[];
        expect(s.store.cardBookName()).toBeNull();
        await expect(s.store.importCardBook()).rejects.toMatchObject({ code: 'noCardBook' });
        characters[0]!.data.character_book = { entries: [{ id: 0, keys: ['a'], content: 'x' }] };
        expect(s.store.cardBookName()).toBe("Anna's Lorebook");
        await expect(s.store.importCardBook()).rejects.toMatchObject({ code: 'unavailable' });
        (s.mock.context as unknown as Record<string, unknown>).convertCharacterBook = (book: unknown) => ({
            entries: { 0: { uid: 0, key: ['a'], content: 'x' } },
            originalData: book,
        });
        expect(await s.store.importCardBook()).toBe("Anna's Lorebook");
        expect(s.book("Anna's Lorebook").originalData).toMatchObject({ entries: [{ id: 0 }] });
        expect(characters[0]!.data.extensions.world).toBe("Anna's Lorebook");
        expect(s.journal.last().changes[0]).toMatchObject({ ref: { op: 'create' } });
        // Importing again overwrites with a snapshot that the journal can restore.
        expect(await s.store.importCardBook()).toBe("Anna's Lorebook");
        expect(s.journal.last().changes[0]).toMatchObject({ ref: { op: 'restore' } });
    });

    it('exports through ST’s download', async () => {
        const calls: unknown[][] = [];
        s.loads.set('/scripts/utils.js', { download: (...args: unknown[]) => calls.push(args) });
        s.addBook('World', { 0: entry(0) });
        await s.store.exportBook('World');
        expect(calls[0]?.[1]).toBe('World.json');
        expect(JSON.parse(String(calls[0]?.[0]))).toEqual(s.book('World'));
        await expect(s.store.exportBook('Nope')).resolves.toBeUndefined();
    });

    it('uses ST’s sanitize-filename when available', async () => {
        s.loads.set('/scripts/utils.js', { getSanitizedFilename: async (name: string) => name.replace(/ /g, '_') });
        expect(await s.store.createBook('My Book')).toBe('My_Book');
    });

    it('lists links for reports', async () => {
        s.addBook('Lore', {});
        s.wi.selected_world_info.push('Lore');
        const state = await s.store.linkState();
        expect(state.global).toEqual(['Lore']);
        expect(state.characters.map((item) => item.avatar)).toEqual(['anna', 'bob']);
    });
});

describe('bindings', () => {
    beforeEach(() => {
        s.addBook('A', {});
        s.addBook('B', {});
    });

    it('reports global, character, chat and persona books', async () => {
        s.wi.selected_world_info.push('A');
        s.wi.world_info.charLore.push({ name: 'anna', extraBooks: ['B'] });
        s.mock.chatMetadata.world_info = 'B';
        s.power.persona_description_lorebook = 'A';
        expect(await s.store.bindings()).toEqual({
            global: ['A'],
            character: { primary: null, extra: ['B'] },
            chat: 'B',
            persona: 'A',
        });
    });

    it('switches global books through ST’s #world_info handler', async () => {
        s.installWiDom();
        await s.wi.updateWorldInfoList();
        await s.store.setGlobal('B', true);
        expect(s.wi.onWorldInfoChange).toHaveBeenCalledWith('__notSlashCommand__');
        expect(s.wi.selected_world_info).toEqual(['B']);
        expect(s.events.some((event) => event.name === 'WORLDINFO_SETTINGS_UPDATED')).toBe(true);
        await s.store.setGlobal('B', true);
        expect(s.wi.onWorldInfoChange).toHaveBeenCalledTimes(1);
        await s.store.setGlobal('B', false);
        expect(s.wi.selected_world_info).toEqual([]);
        // Undo of the last switch turns it back on.
        expect(await s.journal.undo(s.journal.last().id)).toBe(true);
        expect(s.wi.selected_world_info).toEqual(['B']);
    });

    it('falls back to updateWorldInfoSettings without the classic panel and still emits the event', async () => {
        await s.store.setGlobal('A', true);
        expect(s.wi.updateWorldInfoSettings).toHaveBeenCalledWith({}, ['A']);
        expect(s.wi.selected_world_info).toEqual(['A']);
        expect(s.events.some((event) => event.name === 'WORLDINFO_SETTINGS_UPDATED')).toBe(true);
    });

    it('queues global switches behind DES campaign switches', async () => {
        const modules = s.installDes();
        await s.store.setGlobal('A', true);
        expect(modules.campaigns.queueBookTask).toHaveBeenCalled();
        expect(s.wi.selected_world_info).toEqual(['A']);
    });

    it('sets character, chat and persona books', async () => {
        await s.store.setCharacterPrimary('A');
        expect(s.wi.charUpdatePrimaryWorld).not.toHaveBeenCalled();
        const characters = s.mock.context.characters as unknown as { data: { extensions: { world: string } } }[];
        expect(characters[0]!.data.extensions.world).toBe('A');
        const form = document.createElement('input');
        form.id = 'character_world';
        document.body.append(form);
        await s.store.setCharacterPrimary(null);
        expect(s.wi.charUpdatePrimaryWorld).toHaveBeenCalledWith('');
        await s.store.setCharacterExtra(['A', 'B']);
        expect(s.wi.charSetAuxWorlds).toHaveBeenCalledWith('anna', ['A', 'B']);
        await s.store.setChatBook('B');
        expect(s.mock.chatMetadata.world_info).toBe('B');
        await s.store.setChatBook(null);
        expect(s.mock.chatMetadata.world_info).toBeUndefined();
        await s.store.setPersonaBook('A');
        expect(s.power.persona_description_lorebook).toBe('A');
        expect((s.power.persona_descriptions as Record<string, { lorebook: string }>)['me.png']!.lorebook).toBe('A');
        expect(s.events.some((event) => event.name === 'PERSONA_UPDATED' || event.name === 'persona_updated')).toBe(
            false,
        );
        // Undo the persona change.
        expect(await s.journal.undo(s.journal.last().id)).toBe(true);
        expect(s.power.persona_description_lorebook).toBe('');
    });

    it('refuses persona books for a persona without a name and character books in group chats', async () => {
        s.power.personas = {};
        await expect(s.store.setPersonaBook('A')).rejects.toMatchObject({ code: 'personaName' });
        (s.mock.context as unknown as { groupId: string }).groupId = 'g1';
        await expect(s.store.setCharacterPrimary('A')).rejects.toMatchObject({ code: 'noCharacter' });
        await expect(s.store.setCharacterExtra(['A'])).rejects.toMatchObject({ code: 'noCharacter' });
        s.mock.chatId = undefined;
        await expect(s.store.setChatBook('A')).rejects.toMatchObject({ code: 'noChat' });
    });
});

describe('global settings', () => {
    it('goes through ST’s elements with the event ST listens to', async () => {
        s.installWiDom();
        await s.store.setGlobalSettings({
            world_info_depth: 6,
            world_info_use_group_scoring: true,
            world_info_include_names: false,
        });
        expect(s.wi.world_info_depth).toBe(6);
        expect(s.wi.world_info_use_group_scoring).toBe(true);
        expect(s.wi.world_info_include_names).toBe(false);
        expect((document.getElementById('world_info_depth') as HTMLInputElement).value).toBe('6');
        expect(s.wi.updateWorldInfoSettings).not.toHaveBeenCalled();
        const settings = await s.store.globalSettings();
        expect(settings.world_info_depth).toBe(6);
    });

    it('keeps min activations and max recursion exclusive, and undoes', async () => {
        await s.store.setGlobalSettings({ world_info_max_recursion_steps: 3 });
        await s.store.setGlobalSettings({ world_info_min_activations: 2 });
        expect(s.wi.world_info_min_activations).toBe(2);
        expect(s.wi.world_info_max_recursion_steps).toBe(0);
        expect(await s.journal.undo(s.journal.last().id)).toBe(true);
        expect(s.wi.world_info_min_activations).toBe(0);
        expect(s.wi.world_info_max_recursion_steps).toBe(3);
    });

    it('emits WORLDINFO_SETTINGS_UPDATED in the fallback only for settings ST emits it for', async () => {
        await s.store.setGlobalSettings({ world_info_overflow_alert: true });
        expect(s.events.filter((event) => event.name === 'WORLDINFO_SETTINGS_UPDATED')).toHaveLength(0);
        await s.store.setGlobalSettings({ world_info_budget: 40 });
        expect(s.events.filter((event) => event.name === 'WORLDINFO_SETTINGS_UPDATED')).toHaveLength(1);
        await s.store.setGlobalSettings({ world_info_budget: 40 });
        expect(s.events.filter((event) => event.name === 'WORLDINFO_SETTINGS_UPDATED')).toHaveLength(1);
    });
});

describe('DES campaigns', () => {
    it('is unavailable until DES has loaded', async () => {
        expect(await s.desLore.ready()).toBe(false);
        s.des.presentValue = true;
        expect(await s.desLore.ready()).toBe(false);
    });

    it('calls DES’s own campaign API', async () => {
        const modules = s.installDes();
        s.addBook('World', {});
        expect(await s.desLore.ready()).toBe(true);
        const id = s.desLore.createCampaign('Saga');
        s.desLore.renameCampaign(id, 'Saga II');
        s.desLore.setIcon(id, 'fa-gem');
        s.desLore.setColor(id, '#2ecc71');
        s.desLore.toggleCollapsed(id);
        await s.desLore.moveBook('World', id);
        expect(s.desLore.view(['World'], []).campaigns[0]).toMatchObject({ name: 'Saga II', books: ['World'] });
        await s.desLore.setActive(id);
        await s.desLore.moveBook('World', null);
        expect(modules.campaigns.queueReconcile).toHaveBeenCalled();
        expect(s.desLore.toggleGlobal('World')).toBe(true);
        s.desLore.reorder([id]);
        await s.desLore.setAutoLink(false);
        expect(modules.lorebook.autoLinkByName).toBe(false);
        await s.desLore.setAutoLink(true);
        expect(modules.persistence.saveSettings).toHaveBeenCalledTimes(2);
        expect(modules.autoLink.syncAutoLinkedLorebooks).toHaveBeenCalledTimes(1);
        expect(s.desLore.workshop()).toEqual({ Florence: 'World' });
        expect(await s.desLore.deleteCampaign(id)).toBe(true);
    });

    it('never switches campaigns while the Workshop is open', async () => {
        s.installDes();
        await s.desLore.ready();
        s.des.workshopOpen = true;
        await expect(s.desLore.setActive(null)).rejects.toMatchObject({ code: 'workshopOpen' });
        await expect(s.desLore.deleteCampaign('c1')).rejects.toMatchObject({ code: 'workshopOpen' });
    });
});
