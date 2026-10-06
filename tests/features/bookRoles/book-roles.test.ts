import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonBookName } from '../../../src/domain/canon-book';
import { entryContentHash } from '../../../src/domain/roles-meta';
import { bookRolesModule } from '../../../src/features/bookRoles';
import type { BookRolesApi } from '../../../src/features/bookRoles/api';
import { BookRolesService, ENTRY_META_FILE, ROLES_FILE } from '../../../src/features/bookRoles/service';
import { EVENT_TYPES } from '../../helpers/st-mock';
import { createCanonTestApp, settle, startModule, wi } from '../canon/helpers';
import type { CanonTestApp, Dict } from '../canon/helpers';

let env: CanonTestApp;
let service: BookRolesService;
let offs: (() => void)[];

const archive = (uid: number, name: string) =>
    wi(uid, { key: [name], content: `<BunnymoTags><Name:${name}><GENRE:FANTASY></BunnymoTags>` });

function seedBooks(): void {
    env.world.book('BunnyMo Core', [
        wi(0, { key: ['!fullsheet'] }),
        wi(1, { key: ['!quicksheet'] }),
        wi(2, { comment: 'Master - Rules' }),
    ]);
    env.world.book('MBTI V2', [
        wi(0, { key: ['<ENTJ-U>'] }),
        wi(1, { key: ['<INTP-H>'] }),
        wi(2, { key: ['<ESFP-H>'] }),
    ]);
    env.world.book('Repo', [wi(0)]);
    env.world.book('Archives', [archive(0, 'Alice'), archive(1, 'Bob')]);
    env.world.book('Card Lore', [wi(0)]);
    env.world.book('Extra Lore', [wi(0)]);
    env.world.book('Chat Book', [wi(0)]);
    env.world.book('Me', [wi(0)]);
    env.world.book('Rowan', [wi(0)]);
    env.world.book('World (backup 2026-10-04)', [wi(0)]);
    env.world.book('Repo.carrot_backup', [archive(0, 'Alice')]);
    env.world.book(canonBookName('chat'), []);
    env.world.book('Maestro · места', []);
    env.world.book('Marked', [], { maestro: { role: 'maestro' } });
    env.world.book('Plain', [wi(0)]);
    env.neighbours.ckRepos = ['Repo'];
    env.neighbours.desKnown = ['Rowan'];
    (env.mock.context as unknown as Dict).characters = [
        { name: 'Alice', avatar: 'alice.png', data: { extensions: { world: 'Card Lore' } } },
    ];
    env.world.charLore = [{ name: 'alice', extraBooks: ['Extra Lore'] }];
    env.mock.chatMetadata.world_info = 'Chat Book';
    (env.mock.context as unknown as Dict).powerUserSettings = { persona_description_lorebook: 'Me' };
}

function api(): Required<BookRolesApi> {
    return service.api();
}

beforeEach(() => {
    env = createCanonTestApp();
    service = new BookRolesService(env.app, env.log, { saveDelayMs: 0, refreshDelayMs: 0 });
    offs = service.install();
});

afterEach(async () => {
    for (const off of offs) off();
    await service.dispose();
});

describe('detection', () => {
    it('recognises every role from names, content, bindings and neighbours', async () => {
        seedBooks();
        await api().refresh();
        const roles = Object.fromEntries(
            api()
                .all()
                .map((info) => [info.book, info.role]),
        );
        expect(roles).toEqual({
            'BunnyMo Core': 'bunnymo.core',
            'MBTI V2': 'bunnymo.pack',
            Repo: 'ck.archive',
            Archives: 'ck.archive',
            'Card Lore': 'card',
            'Extra Lore': 'card',
            'Chat Book': 'chat',
            Me: 'persona',
            Rowan: 'npc',
            'World (backup 2026-10-04)': 'backup',
            'Repo.carrot_backup': 'backup',
            [canonBookName('chat')]: 'canon',
            'Maestro · места': 'maestro',
            Marked: 'maestro',
            Plain: 'world',
        });
        expect(api().roleOf('MBTI V2')).toMatchObject({
            readOnly: true,
            localizable: false,
            source: 'auto',
            pack: { name: 'MBTI', version: '2' },
        });
        expect(api().roleOf('Plain')).toMatchObject({ readOnly: false, localizable: true });
    });

    it('persists the registry and keeps another tab’s records', async () => {
        env.mock.files.set(
            ROLES_FILE,
            JSON.stringify({
                schema: 1,
                books: { Elsewhere: { role: 'world', source: 'user', fingerprint: '', at: 1 } },
            }),
        );
        env.world.book('Plain', [wi(0)]);
        await api().refresh();
        await service.saveNow();
        const stored = JSON.parse(env.mock.files.get(ROLES_FILE)!) as { books: Record<string, Dict> };
        expect(Object.keys(stored.books).sort()).toEqual(['Elsewhere', 'Plain']);
        expect(stored.books.Plain).toMatchObject({ role: 'world', source: 'auto' });
    });

    it('detects the active books after ST events, lazily unknown ones, and drops vanished auto records', async () => {
        seedBooks();
        env.neighbours.active = ['Plain', 'MBTI V2'];
        service.start();
        await settle();
        expect(
            api()
                .all()
                .map((info) => info.book),
        ).toEqual(['MBTI V2', 'Plain']);
        expect(api().roleOf('Me')).toBeUndefined();
        await settle();
        expect(api().roleOf('Me')?.role).toBe('persona');
        expect(api().roleOf('Nowhere')).toBeUndefined();
        await settle();
        expect(api().roleOf('Nowhere')?.role).toBe('unknown');
        env.world.books.delete('Plain');
        await api().refresh();
        expect(api().roleOf('Plain')).toBeUndefined();
    });

    it('re-detects a book when its content changes and keeps the role while it does not', async () => {
        env.world.book('Shifty', [wi(0, { key: ['castle'] })]);
        await api().refresh();
        expect(api().roleOf('Shifty')?.role).toBe('world');
        let changes = 0;
        const off = api().onChange(() => changes++);
        await env.world.edit('Shifty', 0, { key: ['<SPECIES:ELF>'] });
        await env.world.edit('Shifty', 1, { key: ['<SPECIES:ORC>'] });
        await env.world.edit('Shifty', 2, { key: ['<SPECIES:DWARF>'] });
        await settle();
        expect(api().roleOf('Shifty')?.role).toBe('bunnymo.pack');
        expect(changes).toBeGreaterThan(0);
        off();
    });

    it('keeps a chat book role after switching chats while its content is the same', async () => {
        seedBooks();
        await api().refresh();
        env.mock.chatMetadata = {};
        await env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, 'other');
        env.neighbours.active = ['Chat Book'];
        await settle();
        expect(api().roleOf('Chat Book')?.role).toBe('chat');
        env.world.selected.push('Chat Book');
        await env.world.edit('Chat Book', 0, { content: 'New text.' });
        await settle();
        expect(api().roleOf('Chat Book')?.role).toBe('world');
    });

    it('waits for the generation to end before reading books', async () => {
        env.world.book('Plain', [wi(0)]);
        env.neighbours.active = ['Plain'];
        env.turn.generation = { type: 'normal', dryRun: false, quiet: false };
        service.queueActive();
        await settle();
        expect(api().all()).toEqual([]);
        env.turn.generation = null;
        await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await settle();
        expect(api().roleOf('Plain')?.role).toBe('world');
    });
});

describe('user roles', () => {
    it('keeps the user’s role over detection, journals it and undoes it', async () => {
        env.world.book('Plain', [wi(0)]);
        await api().refresh();
        await api().setRole('Plain', 'npc');
        expect(api().roleOf('Plain')).toMatchObject({ role: 'npc', source: 'user' });
        const record = env.journal.records.at(-1)!;
        expect(record).toMatchObject({ module: 'M35r', kind: 'bookRoles.set', summary: 'Role of «Plain»: NPC book' });
        await env.world.edit('Plain', 0, { content: 'Other text.' });
        await settle();
        expect(api().roleOf('Plain')).toMatchObject({ role: 'npc', source: 'user' });
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(api().roleOf('Plain')).toMatchObject({ role: 'world', source: 'auto' });
    });

    it('records a pack role with its pack name and resets to detection', async () => {
        env.world.book('Species V3', [wi(0)]);
        await api().setRole('Species V3', 'bunnymo.pack');
        expect(api().roleOf('Species V3')).toMatchObject({ readOnly: true, pack: { name: 'Species', version: '3' } });
        await api().setRole('Species V3', 'unknown');
        expect(api().roleOf('Species V3')).toMatchObject({ role: 'world', source: 'auto' });
        expect(env.journal.records.at(-1)?.summary).toBe('Role of «Species V3» is detected again: World');
        await api().resetRole('Species V3');
        expect(env.journal.records).toHaveLength(2);
        await api().setRole('', 'world');
        expect(env.journal.records).toHaveLength(2);
    });
});

describe('renamed books', () => {
    it('moves the user’s role and the entry metadata to the new name', async () => {
        env.world.book('Plain', [wi(0, { content: 'A castle.' })]);
        await api().setRole('Plain', 'npc');
        await api().setEntryMeta('Plain', 0, { type: 'place' });
        env.world.book('Renamed', [wi(0, { content: 'A castle.' })]);
        await api().renameBook('Plain', 'Renamed');
        expect(api().roleOf('Renamed')).toMatchObject({ role: 'npc', source: 'user' });
        expect(api().entryMeta('Renamed', 0)).toEqual({ type: 'place' });
        expect(api().entryMeta('Plain', 0)).toBeUndefined();
        await service.saveNow();
        const roles = JSON.parse(env.mock.files.get(ROLES_FILE)!) as { books: Record<string, Dict> };
        expect(roles.books.Renamed).toMatchObject({ role: 'npc', source: 'user' });
        expect(roles.books.Plain).toBeUndefined();
        const meta = JSON.parse(env.mock.files.get(ENTRY_META_FILE)!) as { entries: Record<string, Dict> };
        expect(Object.keys(meta.entries)).toEqual(['Renamed#0']);
    });
});

describe('entry meta sidecar', () => {
    it('returns metadata only while the entry content is unchanged', async () => {
        env.world.book('Plain', [wi(0, { content: 'A castle.' }), wi(1)]);
        await api().setEntryMeta('Plain', 0, { type: 'place', passport: { id: 'p1' } });
        expect(api().entryMeta('Plain', 0)).toEqual({ type: 'place', passport: { id: 'p1' } });
        await service.saveNow();
        const stored = JSON.parse(env.mock.files.get(ENTRY_META_FILE)!) as { entries: Record<string, Dict> };
        expect(stored.entries['Plain#0']).toMatchObject({
            meta: { type: 'place' },
            contentHash: entryContentHash({ content: 'A castle.' }),
        });

        let changes = 0;
        const off = api().onChange(() => changes++);
        await env.world.edit('Plain', 0, { content: 'A ruin.' });
        expect(api().entryMeta('Plain', 0)).toBeUndefined();
        await settle();
        expect(api().staleEntryMeta()).toEqual([{ book: 'Plain', uid: 0 }]);
        expect(changes).toBeGreaterThan(0);
        await env.world.edit('Plain', 0, { content: 'A castle.' });
        expect(api().entryMeta('Plain', 0)).toEqual({ type: 'place', passport: { id: 'p1' } });
        expect(api().staleEntryMeta()).toEqual([]);
        off();
    });

    it('reads unknown books lazily and treats a deleted entry as stale', async () => {
        env.mock.files.set(
            ENTRY_META_FILE,
            JSON.stringify({
                schema: 1,
                entries: { 'Plain#1': { meta: { type: 'item' }, contentHash: entryContentHash(wi(1)), at: 1 } },
            }),
        );
        env.world.book('Plain', [wi(0), wi(1)]);
        await service.load();
        expect(api().entryMeta('Plain', 1)).toBeUndefined();
        expect(await api().loadEntryMeta('Plain', 1)).toEqual({ type: 'item' });
        expect(api().entryMeta('Plain', 9)).toBeUndefined();
        const data = structuredClone(env.world.books.get('Plain')!) as { entries: Record<string, Dict> };
        delete data.entries['1'];
        await (
            env.mock.context as unknown as { saveWorldInfo(n: string, d: unknown, i: boolean): Promise<void> }
        ).saveWorldInfo('Plain', data, true);
        expect(api().entryMeta('Plain', 1)).toBeUndefined();
        expect(api().staleEntryMeta()).toEqual([{ book: 'Plain', uid: 1 }]);
    });

    it('deletes metadata, refuses missing entries and books', async () => {
        env.world.book('Plain', [wi(0)]);
        await api().setEntryMeta('Plain', 0, { type: 'note' });
        await api().setEntryMeta('Plain', 0, undefined);
        expect(api().entryMeta('Plain', 0)).toBeUndefined();
        await api().setEntryMeta('Plain', 5, undefined);
        await expect(api().setEntryMeta('Plain', 5, { type: 'x' })).rejects.toThrow('has no such entry');
        await expect(api().setEntryMeta('Missing', 0, { type: 'x' })).rejects.toThrow('could not be read');
    });
});

describe('module', () => {
    it('exposes the API and stops cleanly', async () => {
        env.world.book('Plain', [wi(0)]);
        const started = await startModule(env, bookRolesModule);
        const exposed = env.modules.api<BookRolesApi>('bookRoles')!;
        await exposed.refresh();
        expect(exposed.roleOf('Plain')?.role).toBe('world');
        await started.stop();
        expect(env.modules.api('bookRoles')).toBeUndefined();
    });
});
