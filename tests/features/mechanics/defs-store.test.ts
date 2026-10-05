import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { canonBookName } from '../../../src/domain/canon-book';
import { defToEntry } from '../../../src/domain/mechanics-defs';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import type { MechanicDefinitions } from '../../../src/features/mechanics/definitions';
import { MECHANICS_DEF_TARGET, MECHANICS_OFF_POINTER } from '../../../src/features/mechanics/definitions';
import { EVENT_TYPES } from '../../helpers/st-mock';
import { wi } from '../canon/helpers';
import { AVATAR, BOOK, createDefinitions, createDefsEnv, mechanic, settle } from './helpers-defs';
import type { DefsEnv, Dict } from './helpers-defs';

let env: DefsEnv;
let defs: MechanicDefinitions;

const entry = (uid: number, def: MechanicDef) => defToEntry(def, uid);
const ids = (list: MechanicDef[]) => list.map((def) => def.id);
const entries = (book: string) => env.world.entries(book);

async function start(): Promise<void> {
    defs = createDefinitions(env);
    await defs.ready();
    await settle();
}

beforeEach(() => {
    env = createDefsEnv();
});

afterEach(() => {
    defs?.dispose();
});

describe('reading', () => {
    it('reads mechanics from Maestro books only', async () => {
        env.world.book(BOOK, [entry(0, mechanic()), wi(1)]);
        env.world.book('My rules', [entry(3, mechanic({ id: 'money', name: 'Деньги' }))]);
        env.roles.roles.set('My rules', 'maestro');
        env.world.book('World', [entry(0, mechanic({ id: 'world_magic' }))]);
        env.world.book(canonBookName('chat-x'), [entry(0, mechanic({ id: 'canon_magic' }))]);
        env.world.book('Maestro · заметки', [entry(0, mechanic({ id: 'renamed_role' }))]);
        env.roles.roles.set('Maestro · заметки', 'world');
        await start();
        expect(ids(defs.list()).sort()).toEqual(['magic', 'money']);
        expect(defs.get('money')).toMatchObject({ book: 'My rules', uid: 3, name: 'Деньги' });
        expect(defs.candidates()).toEqual([BOOK, 'My rules']);
    });

    it('filters by scope: everywhere, this card, this chat', async () => {
        env.mock.chatId = 'chat-1';
        env.world.book(BOOK, [
            entry(0, mechanic({ id: 'global' })),
            entry(1, mechanic({ id: 'mine', scope: { kind: 'card', avatar: AVATAR } })),
            entry(2, mechanic({ id: 'other_card', scope: { kind: 'card', avatar: 'mia.png' } })),
            entry(3, mechanic({ id: 'this_chat', scope: { kind: 'chat', chatId: 'chat-1' } })),
            entry(4, mechanic({ id: 'other_chat', scope: { kind: 'chat', chatId: 'chat-2' } })),
        ]);
        await start();
        expect(ids(defs.list())).toEqual(['global', 'mine', 'this_chat']);
        expect(defs.get('other_card')?.book).toBe(BOOK);
        expect(defs.get('nope')).toBeNull();
        expect(ids(defs.all())).toHaveLength(5);

        let changes = 0;
        defs.onChange(() => changes++);
        env.character('mia.png');
        env.mock.chatId = 'chat-2';
        await env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, 'chat-2');
        expect(changes).toBeGreaterThan(0);
        expect(ids(defs.list())).toEqual(['global', 'other_card', 'other_chat']);

        // Group chat: every member's card applies.
        const context = env.mock.context as unknown as Dict;
        context.groupId = 'g1';
        context.groups = [{ id: 'g1', name: 'Group', members: [AVATAR, 'mia.png'] }];
        expect(ids(defs.list())).toEqual(['global', 'mine', 'other_card', 'other_chat']);
    });

    it('returns copies', async () => {
        env.world.book(BOOK, [entry(0, mechanic())]);
        await start();
        defs.list()[0]!.name = 'changed';
        defs.get('magic')!.attributes.length = 0;
        expect(defs.get('magic')).toMatchObject({ name: 'Магия', attributes: [{ id: 'mana' }] });
    });

    it('follows WORLDINFO_UPDATED: edits elsewhere, new entries, books leaving the role', async () => {
        env.world.book(BOOK, [entry(0, mechanic())]);
        env.world.book('Side', [entry(0, mechanic({ id: 'side' }))]);
        env.roles.roles.set('Side', 'maestro');
        await start();
        let changes = 0;
        defs.onChange(() => changes++);

        const content = String(entries(BOOK)['0']!.content).replace('Mechanic: Магия', 'Mechanic: Тьма');
        await env.world.edit(BOOK, 0, { content });
        expect(defs.get('magic')?.name).toBe('Тьма');

        const data = structuredClone(env.world.books.get(BOOK)) as Dict;
        (data.entries as Dict)['5'] = entry(5, mechanic({ id: 'luck', name: 'Удача' }));
        await env.mock.context.saveWorldInfo!(BOOK, data, true);
        expect(ids(defs.list())).toEqual(['magic', 'luck', 'side']);

        // A book that is no Maestro book any more (the user changed its role) leaves the list.
        env.roles.roles.set('Side', 'world');
        env.roles.emit();
        await defs.ready();
        await settle();
        expect(ids(defs.list())).toEqual(['magic', 'luck']);
        // Updates of unrelated books change nothing.
        const before = changes;
        await env.world.edit('Side', 0, { comment: 'x' });
        expect(changes).toBe(before);
        expect(changes).toBeGreaterThan(0);
    });

    it('gives a repeated id a suffix in memory and repairs it on save', async () => {
        env.world.book(BOOK, [entry(0, mechanic()), entry(1, mechanic({ name: 'Копия' }))]);
        await start();
        expect(ids(defs.list())).toEqual(['magic', 'magic_2']);
        const copy = defs.get('magic_2')!;
        const saved = await defs.save(copy);
        expect(saved).toMatchObject({ id: 'magic_2', uid: 1, book: BOOK });
        expect(((entries(BOOK)['1']!.extensions as Dict).maestro as Dict).mechanic).toMatchObject({ id: 'magic_2' });
        expect(Object.keys(entries(BOOK))).toEqual(['0', '1']);
    });
});

describe('saving', () => {
    it('creates the book with the role «maestro», saved at once and never activated', async () => {
        await start();
        const saved = await defs.save(mechanic({ scope: { kind: 'card', avatar: AVATAR } }));
        expect(saved).toMatchObject({ id: 'magic', book: BOOK, uid: 0, scope: { kind: 'card', avatar: AVATAR } });
        expect(typeof saved.updatedAt).toBe('number');
        expect(env.world.saves.every((save) => save.immediately)).toBe(true);
        expect(env.world.saves.map((save) => save.name)).toEqual([BOOK, BOOK]);
        expect(env.world.listUpdates).toBe(1);
        expect(env.roles.calls).toEqual([[BOOK, 'maestro']]);
        expect(env.world.books.get(BOOK)?.extensions).toEqual({ maestro: { role: 'maestro' } });
        expect(env.world.reloads).toContain(BOOK);
        expect(env.neighbours.desInvalidated).toContain(BOOK);
        expect(env.world.selected).toEqual([]);
        expect(env.mock.chatMetadata.world_info).toBeUndefined();
        const stored = entries(BOOK)['0']!;
        expect(stored).toMatchObject({ uid: 0, disable: true, constant: false, comment: 'Магия' });
        expect(((stored.extensions as Dict).maestro as Dict).type).toBe('mechanic');
        expect(ids(defs.list())).toEqual(['magic']);
        expect(env.journal.records).toHaveLength(1);
        expect(env.journal.records[0]).toMatchObject({
            module: 'M25',
            kind: 'mechanics.def.create',
            summary: 'Mechanic «Магия» created',
            changes: [{ target: MECHANICS_DEF_TARGET, ref: { book: BOOK, uid: 0, id: 'magic' }, before: null }],
        });
    });

    it('keeps a new book while ST’s book list still lags behind it', async () => {
        const ctx = env.mock.context as unknown as { getWorldInfoNames: () => string[] };
        ctx.getWorldInfoNames = () => [];
        await start();
        await defs.save(mechanic({ scope: { kind: 'card', avatar: AVATAR } }));
        await defs.sync();
        await env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, env.mock.chatId);
        await defs.ready();
        expect(ids(defs.list())).toEqual(['magic']);
    });

    it('writes into the book of the settings', async () => {
        env.slice.book = 'Maestro · мои системы';
        await start();
        await defs.save(mechanic());
        expect(env.world.books.has('Maestro · мои системы')).toBe(true);
        expect(env.world.books.has(BOOK)).toBe(false);
    });

    it('updates in place by uid and by id, undoable', async () => {
        env.world.book(BOOK, [wi(0), entry(1, mechanic())], { maestro: { role: 'maestro' } });
        await start();
        const current = defs.get('magic')!;
        const updated = await defs.save({ ...current, name: 'Высшая магия', rules: 'New rules.' });
        expect(updated).toMatchObject({ uid: 1, name: 'Высшая магия', rules: 'New rules.' });
        expect(Object.keys(entries(BOOK))).toEqual(['0', '1']);
        expect(env.roles.calls).toEqual([]);
        // Without uid: the entry with the same id in this book.
        const { uid: _uid, book: _book, ...bare } = defs.get('magic')!;
        void _uid;
        void _book;
        await defs.save({ ...bare, summary: 'By id.' });
        expect(Object.keys(entries(BOOK))).toEqual(['0', '1']);
        expect(defs.get('magic')?.summary).toBe('By id.');

        const [first, second] = env.journal.records;
        expect(first).toMatchObject({ kind: 'mechanics.def.update', summary: 'Mechanic «Высшая магия» changed' });
        expect(first!.changes[0]!.before).toMatchObject({ comment: 'Магия' });
        expect(await env.journal.undo(second!.id)).toBe(true);
        expect(defs.get('magic')?.summary).toBe('Spellcasting powered by mana.');
        expect(await env.journal.undo(first!.id)).toBe(true);
        expect(defs.get('magic')?.name).toBe('Магия');
    });

    it('undoes a creation by removing the entry', async () => {
        await start();
        await defs.save(mechanic());
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(entries(BOOK)).toEqual({});
        expect(defs.list()).toEqual([]);
    });

    it('removes a definition, undoable', async () => {
        env.world.book(BOOK, [entry(0, mechanic()), entry(1, mechanic({ id: 'luck' }))]);
        await start();
        await defs.remove('magic');
        await defs.remove('nope');
        expect(Object.keys(entries(BOOK))).toEqual(['1']);
        expect(ids(defs.list())).toEqual(['luck']);
        expect(env.journal.records.map((record) => record.kind)).toEqual(['mechanics.def.remove']);
        expect(env.journal.records[0]!.changes[0]).toMatchObject({ before: { uid: 0 }, after: null });
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(ids(defs.list())).toEqual(['magic', 'luck']);
    });

    it('refuses BunnyMo books (P13), books of other roles, invalid definitions and taken ids', async () => {
        env.world.book('BunnyMo MBTI', [wi(0)]);
        env.roles.roles.set('BunnyMo MBTI', 'bunnymo.pack');
        env.world.book('Lore', [wi(0)]);
        env.roles.roles.set('Lore', 'world');
        env.world.book('Side', [entry(0, mechanic())]);
        env.roles.roles.set('Side', 'maestro');
        await start();
        const saves = env.world.saves.length;

        env.slice.book = 'BunnyMo MBTI';
        await expect(defs.save(mechanic({ id: 'other' }))).rejects.toThrow('«BunnyMo MBTI» is a BunnyMo book');
        env.slice.book = 'Lore';
        await expect(defs.save(mechanic({ id: 'other' }))).rejects.toThrow('«Lore» is not a Maestro book');
        env.slice.book = BOOK;
        await expect(defs.save(mechanic({ id: 'Bad id' }))).rejects.toThrow('The mechanic cannot be saved: the id');
        await expect(defs.save({ id: '' } as MechanicDef)).rejects.toThrow('The mechanic cannot be saved');
        await expect(defs.save(mechanic({ checks: [{ ...mechanic().checks[0]!, dice: '1d' }] }))).rejects.toThrow(
            'unknown dice formula',
        );
        await expect(defs.save(mechanic())).rejects.toThrow('The id magic is already taken by «Магия»');
        expect(env.world.saves.length).toBe(saves);
        expect(env.journal.records).toEqual([]);

        // A BunnyMo book is never written by an undo either.
        env.roles.roles.set('Side', 'bunnymo.pack');
        expect(
            await env.journal.handlers.get(MECHANICS_DEF_TARGET)!({
                target: MECHANICS_DEF_TARGET,
                ref: { book: 'Side', uid: 0 },
                before: null,
                after: {},
            }),
        ).toBe(false);
        expect(env.world.entry('Side', 0)).toBeDefined();
    });

    it('undo handles missing books and bad refs', async () => {
        await start();
        const undo = env.journal.handlers.get(MECHANICS_DEF_TARGET)!;
        expect(await undo({ target: MECHANICS_DEF_TARGET, ref: {}, before: null, after: null })).toBe(false);
        expect(
            await undo({ target: MECHANICS_DEF_TARGET, ref: { book: 'Gone', uid: 1 }, before: null, after: {} }),
        ).toBe(true);
        expect(
            await undo({ target: MECHANICS_DEF_TARGET, ref: { book: 'Gone', uid: 1 }, before: {}, after: null }),
        ).toBe(false);
    });
});

describe('per-chat switch', () => {
    it('keeps the ids switched off in the chat metadata', async () => {
        env.world.book(BOOK, [entry(0, mechanic()), entry(1, mechanic({ id: 'luck' }))]);
        await start();
        expect(ids(defs.active())).toEqual(['magic', 'luck']);
        let changes = 0;
        defs.onChange(() => changes++);
        await defs.setEnabledInChat('magic', false);
        await defs.setEnabledInChat('magic', false);
        expect(changes).toBe(1);
        expect(ids(defs.active())).toEqual(['luck']);
        expect(ids(defs.list())).toEqual(['magic', 'luck']);
        expect(defs.isEnabledInChat('magic')).toBe(false);
        const maestro = env.mock.chatMetadata.maestro as Dict;
        expect((maestro.pointers as Dict)[MECHANICS_OFF_POINTER]).toEqual(['magic']);

        // Another chat has its own metadata.
        env.mock.chatMetadata = {};
        env.mock.chatId = 'chat-2';
        expect(ids(defs.active())).toEqual(['magic', 'luck']);

        env.mock.chatMetadata = { maestro };
        env.mock.chatId = 'chat-1';
        await defs.setEnabledInChat('magic', true);
        expect(ids(defs.active())).toEqual(['magic', 'luck']);

        env.mock.chatId = undefined;
        await expect(defs.setEnabledInChat('magic', false)).rejects.toThrow('No chat is open.');
    });
});

describe('lifecycle', () => {
    it('releases its listeners on dispose', async () => {
        await start();
        const count = () => env.mock.eventSource.events.get(EVENT_TYPES.WORLDINFO_UPDATED!)?.length ?? 0;
        expect(count()).toBe(1);
        expect(env.roles.listenerCount()).toBe(1);
        let changes = 0;
        defs.onChange(() => changes++);
        defs.dispose();
        expect(count()).toBe(0);
        expect(env.roles.listenerCount()).toBe(0);
        await env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, 'x');
        expect(changes).toBe(0);
    });

    it('works without the roles module and without World Info', async () => {
        env.modules.apis.delete('bookRoles');
        env.world.book(BOOK, [entry(0, mechanic())]);
        await start();
        expect(ids(defs.list())).toEqual(['magic']);
        defs.dispose();
        const context = env.mock.context as unknown as Dict;
        delete context.loadWorldInfo;
        delete context.saveWorldInfo;
        defs = createDefinitions(env);
        await defs.ready();
        expect(defs.list()).toEqual([]);
        await expect(defs.save(mechanic({ id: 'new_one' }))).rejects.toThrow('cannot read or save lorebooks');
    });
});
