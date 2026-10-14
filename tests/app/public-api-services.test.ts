// MAESTRO_API service facades (release 1.24) over fakes of Maestro's services: validation ('bad-args'), modules that
// are off ('off'), the services' errors in the contract's words, journaling under the neighbour's module, the shared
// daily cap, BunnyMo books refused, typed lore fields in the entry or the sidecar, mechanics with the module off
// (templates, the block parser) and in a service chat (the definitions door alone), the preset store and layer of any
// card, the prompt audit's findings, the persona from a ready description and the service card.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createServiceFacades } from '../../src/app/public-api-services';
import type { ServiceFacades } from '../../src/app/public-api-services';
import { createI18n } from '../../src/core/i18n';
import { CORE_STRINGS } from '../../src/core/strings';
import { MECHANICS_STRINGS } from '../../src/features/mechanics/strings';
import { LoreStudioError } from '../../src/features/loreStudio/st-lore';
import { PresetStoreError } from '../../src/features/presetStudio/st-preset';
import type { App, CostEntry, Unsubscribe } from '../../src/shared/contracts';
import type { ApiMechanicDef } from '../../src/shared/public-api-types';

type Dict = Record<string, unknown>;

interface Env {
    app: App;
    apis: Map<string, unknown>;
    costs: (Omit<CostEntry, 'at'> & { at?: number })[];
    own: { begun: AbortSignal[]; ended: AbortSignal[] };
    chatId: string | null;
    disposed: boolean;
    offs: Unsubscribe[];
    facades: ServiceFacades;
}

let env: Env;

function start(): Env {
    const i18n = createI18n(() => 'ru');
    i18n.register(CORE_STRINGS);
    i18n.register(MECHANICS_STRINGS);
    const apis = new Map<string, unknown>();
    const costs: Env['costs'] = [];
    const own: Env['own'] = { begun: [], ended: [] };
    const log = { debug() {}, info() {}, warn() {}, error() {}, scope: () => log };
    const state = { chatId: 'chat-1' as string | null, disposed: false };
    const offs: Unsubscribe[] = [];
    const app = {
        log,
        i18n,
        host: {
            ctx: () => ({
                characters: [
                    { name: 'Вера', avatar: 'vera.png' },
                    { name: 'Мартин', avatar: 'martin.png' },
                ],
            }),
            chatId: () => state.chatId,
        },
        modules: { api: <T>(key: string) => apis.get(key) as T | undefined },
        settings: { core: () => ({ backgroundDailyCapUsd: 0 }) },
        cost: {
            record: (entry: Omit<CostEntry, 'at'> & { at?: number }) => costs.push(entry),
            summary: () => ({ todayUsd: 0, todayBySource: {}, backgroundTodayUsd: 0, anlasToday: 0 }),
            backgroundBudget: () => ({ capUsd: 2, spentUsd: 0.5, remainingUsd: 1.5 }),
            beginOwn: (signal?: AbortSignal) => signal && own.begun.push(signal),
            endOwn: (signal?: AbortSignal) => signal && own.ended.push(signal),
        },
    } as unknown as App;
    const facades = createServiceFacades({
        app,
        log,
        disposed: () => state.disposed,
        own: (off) => {
            offs.push(off);
            return off;
        },
    });
    return {
        app,
        apis,
        costs,
        own,
        get chatId() {
            return state.chatId;
        },
        set chatId(value) {
            state.chatId = value;
        },
        get disposed() {
            return state.disposed;
        },
        set disposed(value) {
            state.disposed = value;
        },
        offs,
        facades,
    };
}

beforeEach(() => {
    env = start();
});

describe('cost', () => {
    it('records a spend of the neighbour’s own channel under «officina», belonging to no chat turn', () => {
        expect(
            env.facades.cost.record({
                task: 'officina.bible',
                model: 'deepseek/deepseek-v4',
                provider: 'DeepInfra',
                tokens: { prompt: 1200.4, completion: 300, cached: 0 },
                usd: 0.0042,
                at: 1000,
            }),
        ).toEqual({ ok: true });
        expect(env.costs).toEqual([
            {
                source: 'officina',
                task: 'officina.bible',
                usd: 0.0042,
                tokens: { prompt: 1200, completion: 300 },
                model: 'deepseek/deepseek-v4',
                provider: 'DeepInfra',
                at: 1000,
                chatId: null,
            },
        ]);
        expect(env.facades.cost.record({ task: 'officina.card', usd: 0 })).toEqual({ ok: true });
        expect(env.costs.at(-1)).toMatchObject({ estimated: true, tokens: { prompt: 0, completion: 0 } });
    });

    it('refuses other tasks and bad amounts', () => {
        expect(env.facades.cost.record({ task: 'dramatis.turn', usd: 1 })).toMatchObject({
            ok: false,
            error: 'bad-args',
        });
        expect(env.facades.cost.record({ task: 'officina.x', usd: -1 })).toMatchObject({
            ok: false,
            error: 'bad-args',
        });
        expect(env.facades.cost.record({ task: 'officina.x', usd: Number.NaN })).toMatchObject({ ok: false });
        expect(env.facades.cost.record(null as never)).toMatchObject({ ok: false, error: 'bad-args' });
        expect(env.costs).toEqual([]);
    });

    it('tells what is left of the shared cap and claims requests by their signal', () => {
        expect(env.facades.cost.remaining()).toEqual({ capUsd: 2, spentUsd: 0.5, remainingUsd: 1.5 });
        const controller = new AbortController();
        const off = env.facades.cost.claim(controller.signal);
        expect(env.own.begun).toEqual([controller.signal]);
        off();
        expect(env.own.ended).toEqual([controller.signal]);
        env.facades.cost.claim('nope' as never)();
        expect(env.own.begun).toHaveLength(1);
    });

    it('answers safely after Maestro stopped', () => {
        env.disposed = true;
        expect(env.facades.cost.record({ task: 'officina.bible', usd: 1 })).toEqual({
            ok: false,
            error: 'maestro-stopped',
        });
    });
});

/* ------------------------------------------------------------------ lore */

function fakeLore() {
    const books = new Map<string, { entries: Record<string, Dict> }>([
        [
            'Velmar',
            {
                entries: {
                    '0': { uid: 0, key: ['Вера'], keysecondary: [], content: 'Character: Vera', comment: 'Vera' },
                },
            },
        ],
        ['Officina — Хроники', { entries: {} }],
        ['BunnyMo', { entries: {} }],
    ]);
    const calls: { op: string; args: unknown[] }[] = [];
    const store = {
        books: () => [...books.keys()],
        isReadOnly: (book: string): boolean => book === 'BunnyMo',
        load: async (book: string) => (books.has(book) ? JSON.parse(JSON.stringify(books.get(book))) : null),
        createBook: vi.fn(async (name: string, reason?: unknown) => {
            calls.push({ op: 'createBook', args: [name, reason] });
            if (books.has(name)) throw new LoreStudioError('exists', { name });
            books.set(name, { entries: {} });
            return name;
        }),
        createEntry: vi.fn(async (book: string, partial: Dict, reason: unknown) => {
            calls.push({ op: 'createEntry', args: [book, partial, reason] });
            const entries = books.get(book)!.entries;
            const uid = Object.keys(entries).length;
            entries[String(uid)] = { uid, key: [], keysecondary: [], content: '', comment: '', ...partial };
            return uid;
        }),
        updateEntry: vi.fn(async (book: string, uid: number, patch: Dict, reason: unknown) => {
            calls.push({ op: 'updateEntry', args: [book, uid, patch, reason] });
            const entry = books.get(book)!.entries[String(uid)];
            if (!entry) throw new LoreStudioError('missingEntry', { book, uid });
            Object.assign(entry, patch);
        }),
        deleteEntry: vi.fn(async (book: string, uid: number, reason: unknown) => {
            calls.push({ op: 'deleteEntry', args: [book, uid, reason] });
            delete books.get(book)!.entries[String(uid)];
        }),
        setCharacterPrimaryOf: vi.fn(async (avatar: string, name: string | null, by?: string) => {
            calls.push({ op: 'setCharacterPrimaryOf', args: [avatar, name, by] });
        }),
    };
    const sidecar = new Map<string, Dict>();
    const roles = {
        roleOf: (book: string) =>
            book === 'BunnyMo'
                ? { book, role: 'bunnymo.pack', source: 'auto', fingerprint: '', readOnly: true, localizable: false }
                : book.startsWith('Officina')
                  ? { book, role: 'maestro', source: 'user', fingerprint: '', readOnly: false, localizable: true }
                  : { book, role: 'world', source: 'auto', fingerprint: '', readOnly: false, localizable: true },
        setRole: vi.fn(async () => {}),
        entryMeta: (book: string, uid: number) => sidecar.get(`${book}#${uid}`),
        loadEntryMeta: async (book: string, uid: number) => sidecar.get(`${book}#${uid}`),
        setEntryMeta: vi.fn(async (book: string, uid: number, meta: Dict | undefined) => {
            if (meta) sidecar.set(`${book}#${uid}`, meta);
            else sidecar.delete(`${book}#${uid}`);
        }),
    };
    return { books, calls, store, roles, sidecar };
}

describe('lore', () => {
    let lore: ReturnType<typeof fakeLore>;

    beforeEach(() => {
        lore = fakeLore();
        env.apis.set('loreStore', lore.store);
        env.apis.set('bookRoles', lore.roles);
    });

    it('lists the books with their roles; says off without the Lore Studio', () => {
        expect(env.facades.lore.listBooks()).toEqual({
            ok: true,
            books: [
                { name: 'Velmar', role: 'world', readOnly: false },
                { name: 'Officina — Хроники', role: 'maestro', readOnly: false },
                { name: 'BunnyMo', role: 'bunnymo.pack', readOnly: true },
            ],
        });
        env.apis.delete('loreStore');
        expect(env.facades.lore.listBooks()).toEqual({ ok: false, error: 'off' });
    });

    it('writes through the store, journaled under the neighbour (its words when given)', async () => {
        expect(await env.facades.lore.createBook('Officina — Сад', { summary: 'Книга проекта «Сад»' })).toEqual({
            ok: true,
            name: 'Officina — Сад',
        });
        expect(lore.calls[0]).toEqual({
            op: 'createBook',
            args: ['Officina — Сад', { module: 'officina', summary: 'Книга проекта «Сад»' }],
        });
        expect(await env.facades.lore.createBook('Velmar')).toMatchObject({ ok: false, error: 'exists' });

        const created = await env.facades.lore.createEntry('Velmar', {
            key: ['Мартин', ' '],
            content: 'Character: Martin',
            uid: 99,
        } as never);
        expect(created).toEqual({ ok: true, uid: 1 });
        expect(lore.calls.at(-1)).toEqual({
            op: 'createEntry',
            args: [
                'Velmar',
                { key: ['Мартин'], content: 'Character: Martin' },
                expect.objectContaining({ module: 'officina' }),
            ],
        });
        expect(await env.facades.lore.updateEntry('Velmar', 1, { comment: 'Martin' }, { by: 'dramatis' })).toEqual({
            ok: true,
        });
        expect((lore.calls.at(-1)!.args[3] as Dict).module).toBe('dramatis');
        expect(await env.facades.lore.deleteEntry('Velmar', 1)).toEqual({ ok: true });
        expect(await env.facades.lore.deleteEntry('Velmar', 1)).toMatchObject({ ok: false, error: 'not-found' });
        expect(await env.facades.lore.updateEntry('Velmar', 7, { comment: 'x' })).toMatchObject({
            ok: false,
            error: 'not-found',
        });
    });

    it('refuses BunnyMo books and bad arguments', async () => {
        expect(await env.facades.lore.createEntry('BunnyMo', { content: 'x' })).toMatchObject({
            ok: false,
            error: 'read-only',
        });
        expect(await env.facades.lore.updateEntry('BunnyMo', 0, { content: 'x' })).toMatchObject({
            error: 'read-only',
        });
        expect(await env.facades.lore.createEntry('Velmar', { key: 'Вера' } as never)).toMatchObject({
            error: 'bad-args',
        });
        expect(await env.facades.lore.createEntry('Velmar', { content: 5 } as never)).toMatchObject({
            error: 'bad-args',
        });
        expect(await env.facades.lore.updateEntry('Velmar', -1, {})).toMatchObject({ error: 'bad-args' });
        expect(await env.facades.lore.createEntry('Nope', {})).toMatchObject({ error: 'not-found' });
        expect(await env.facades.lore.load('Nope')).toMatchObject({ error: 'not-found' });
        expect(lore.store.createEntry).not.toHaveBeenCalled();
    });

    it('detects a book made a moment ago before writing into it (read-only while its role is unknown)', async () => {
        const known = new Set<string>(['Velmar']);
        const detect = vi.fn(async (books: readonly string[]) => {
            for (const book of books) known.add(book);
        });
        env.apis.set('bookRoles', {
            ...lore.roles,
            roleOf: (book: string) => (known.has(book) ? lore.roles.roleOf(book) : undefined),
            detect,
        });
        lore.store.isReadOnly = (book: string) => !known.has(book) || book === 'BunnyMo';
        expect(await env.facades.lore.createBook('Officina — Новая')).toEqual({ ok: true, name: 'Officina — Новая' });
        expect(detect).toHaveBeenCalledWith(['Officina — Новая']);
        expect(await env.facades.lore.createEntry('Officina — Новая', { content: 'x' })).toEqual({ ok: true, uid: 0 });
        known.delete('Officina — Новая');
        expect(await env.facades.lore.updateEntry('Officina — Новая', 0, { content: 'y' })).toEqual({ ok: true });
        expect(detect).toHaveBeenCalledTimes(2);
    });

    it('binds a book to any card it knows', async () => {
        expect(await env.facades.lore.setCharacterBook('martin.png', 'Velmar')).toEqual({ ok: true });
        expect(lore.calls.at(-1)).toEqual({ op: 'setCharacterPrimaryOf', args: ['martin.png', 'Velmar', 'officina'] });
        expect(await env.facades.lore.setCharacterBook('martin.png', null)).toEqual({ ok: true });
        expect(await env.facades.lore.setCharacterBook('ghost.png', 'Velmar')).toMatchObject({ error: 'not-found' });
        expect(await env.facades.lore.setCharacterBook('vera.png', 'Nope')).toMatchObject({ error: 'not-found' });
    });

    it('gives the entry types and composes their content', () => {
        const types = env.facades.lore.entryTypes();
        expect(types.map((type) => type.id)).toContain('character');
        expect(types.find((type) => type.id === 'character')?.fields[0]).toEqual({ id: 'name', label: 'Name' });
        expect(env.facades.lore.composeContent('character', { name: 'Вера', role: 'капитан', bogus: 7 } as never)).toBe(
            'Character: Вера\nRole: капитан',
        );
        expect(env.facades.lore.composeContent('nope' as never, {})).toBe('');
    });

    it('keeps typed fields in the entry of a Maestro book and in the sidecar of a base book', async () => {
        const typed = { type: 'character' as const, fields: { name: 'Вера', role: 'капитан' } };
        const own = await env.facades.lore.createEntry('Officina — Хроники', { content: '' });
        const uid = (own as { uid: number }).uid;
        expect(await env.facades.lore.setTypeFields('Officina — Хроники', uid, typed, { compose: true })).toEqual({
            ok: true,
            storage: 'entry',
        });
        const entry = lore.books.get('Officina — Хроники')!.entries[String(uid)]!;
        expect(entry.content).toBe('Character: Вера\nRole: капитан');
        expect((entry.extensions as Dict).maestro).toEqual({ type: 'character', typeFields: typed.fields });
        expect(await env.facades.lore.typeFields('Officina — Хроники', uid)).toEqual({ ok: true, typed });

        expect(await env.facades.lore.setTypeFields('Velmar', 0, typed)).toEqual({ ok: true, storage: 'sidecar' });
        expect(lore.sidecar.get('Velmar#0')).toEqual({ type: 'character', typeFields: typed.fields });
        expect(lore.books.get('Velmar')!.entries['0']!.extensions).toBeUndefined();
        expect(await env.facades.lore.typeFields('Velmar', 0)).toEqual({ ok: true, typed });
        expect(await env.facades.lore.setTypeFields('Velmar', 0, null)).toEqual({ ok: true, storage: 'sidecar' });
        expect(lore.sidecar.has('Velmar#0')).toBe(false);
        expect(await env.facades.lore.setTypeFields('Velmar', 0, { type: 'nope', fields: {} } as never)).toMatchObject({
            error: 'bad-args',
        });
    });
});

describe('book roles', () => {
    it('reads and sets roles; a BunnyMo book stays what it is', async () => {
        const lore = fakeLore();
        env.apis.set('bookRoles', lore.roles);
        expect(env.facades.bookRoles.get('Velmar')).toMatchObject({ ok: true, info: { role: 'world' } });
        expect(await env.facades.bookRoles.set('Velmar', 'card')).toEqual({ ok: true });
        expect(lore.roles.setRole).toHaveBeenCalledWith('Velmar', 'card', 'officina');
        expect(await env.facades.bookRoles.set('BunnyMo', 'world')).toMatchObject({ ok: false, error: 'read-only' });
        expect(await env.facades.bookRoles.set('Velmar', 'nonsense' as never)).toMatchObject({ error: 'bad-args' });
        env.apis.delete('bookRoles');
        expect(env.facades.bookRoles.get('Velmar')).toEqual({ ok: false, error: 'off' });
    });
});

/* ------------------------------------------------------------------ mechanics */

function mechanicDef(id: string, scope: ApiMechanicDef['scope']): ApiMechanicDef {
    return {
        id,
        name: 'Доверие',
        summary: 'Trust of the characters toward the player.',
        rules: 'Trust grows with kept promises.',
        attributes: [
            { id: 'trust', name: 'Доверие', promptName: 'Trust', kind: 'number', min: 0, max: 10, initial: 5 },
        ],
        holders: { kind: 'characters' },
        checks: [],
        tracking: 'block',
        scope,
    };
}

describe('mechanics', () => {
    it('works without the module for templates, a template and the block parser; the rest says off', async () => {
        const templates = env.facades.mechanics.templates();
        expect(templates.ok && templates.templates.length).toBeGreaterThan(3);
        const first = templates.ok ? templates.templates[0]! : null;
        expect(first?.title).not.toMatch(/^m25\./);
        const made = env.facades.mechanics.fromTemplate(first!.id, { scope: { kind: 'card', avatar: 'vera.png' } });
        expect(made).toMatchObject({
            ok: true,
            def: { template: first!.id, scope: { kind: 'card', avatar: 'vera.png' } },
        });
        expect(env.facades.mechanics.fromTemplate('nope')).toMatchObject({ ok: false, error: 'not-found' });
        expect(env.facades.mechanics.fromTemplate(first!.id, { scope: { kind: 'card' } as never })).toMatchObject({
            error: 'bad-args',
        });
        const block = env.facades.mechanics.parseBlock(
            'Текст.\n<mechanics>\nKai.hp -3 (удар)\nroll: Stealth Kai\n</mechanics>',
        );
        expect(block.found).toBe(true);
        expect(block.items[0]).toMatchObject({ holder: 'Kai', attribute: 'hp', value: -3 });
        expect(block.rolls).toHaveLength(1);
        expect(env.facades.mechanics.list()).toEqual({ ok: false, error: 'off' });
        expect(
            await env.facades.mechanics.save(mechanicDef('trust', { kind: 'global' }), { scope: { kind: 'global' } }),
        ).toEqual({ ok: false, error: 'off' });
    });

    it('lists every scope, saves with the scope asked for, validates and journals under the neighbour', async () => {
        const defs = [
            mechanicDef('trust', { kind: 'card', avatar: 'vera.png' }),
            mechanicDef('fame', { kind: 'global' }),
            mechanicDef('debt', { kind: 'chat', chatId: 'chat-1' }),
        ];
        const fake = {
            all: () => defs,
            list: () => defs.slice(1),
            get: (id: string) => defs.find((def) => def.id === id) ?? null,
            save: vi.fn(async (def: ApiMechanicDef) => ({ ...def, book: 'Maestro — механики', uid: 3 })),
            remove: vi.fn(async () => {}),
            templates: () => [],
            fromTemplate: () => null,
            setEnabledInChat: vi.fn(async () => {}),
        };
        env.apis.set('mechanics', fake);
        expect(env.facades.mechanics.list({ scope: 'card', avatar: 'vera.png' })).toMatchObject({
            ok: true,
            defs: [{ id: 'trust' }],
        });
        expect((env.facades.mechanics.list() as { defs: unknown[] }).defs).toHaveLength(3);
        const saved = await env.facades.mechanics.save(mechanicDef('respect', { kind: 'global' }), {
            scope: { kind: 'card', avatar: 'martin.png' },
        });
        expect(saved).toMatchObject({
            ok: true,
            def: { id: 'respect', scope: { kind: 'card', avatar: 'martin.png' }, uid: 3 },
        });
        expect(fake.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'respect' }), 'officina');
        expect(
            await env.facades.mechanics.save({ ...mechanicDef('', { kind: 'global' }) }, { scope: { kind: 'global' } }),
        ).toMatchObject({ ok: false, error: 'bad-args' });
        expect(
            await env.facades.mechanics.save(mechanicDef('x', { kind: 'global' }), {
                scope: { kind: 'nope' } as never,
            }),
        ).toMatchObject({ ok: false, error: 'bad-args', message: 'scope' });
        expect(await env.facades.mechanics.remove('fame')).toEqual({ ok: true });
        expect(fake.remove).toHaveBeenCalledWith('fame', 'officina');
        expect(await env.facades.mechanics.remove('nope')).toMatchObject({ error: 'not-found' });
        expect(await env.facades.mechanics.setEnabledInChat('fame', false)).toEqual({ ok: true });
        env.chatId = null;
        expect(await env.facades.mechanics.setEnabledInChat('fame', true)).toMatchObject({ error: 'no-chat' });
    });

    it('in a service chat (1.24.1): the definitions through their own door, the per-chat switch off', async () => {
        const defs = [mechanicDef('trust', { kind: 'card', avatar: 'vera.png' })];
        // M25 is paused: only the definitions door it keeps there (no 'mechanics').
        const door = {
            all: () => defs,
            list: () => [],
            get: (id: string) => defs.find((def) => def.id === id) ?? null,
            save: vi.fn(async (def: ApiMechanicDef) => ({ ...def, book: 'Maestro · механики', uid: 1 })),
            remove: vi.fn(async () => {}),
            templates: () => [{ id: 'health', titleKey: 'm25.def.template.health', descriptionKey: 'x' }],
            fromTemplate: vi.fn(() => ({ ...mechanicDef('trust_2', { kind: 'chat', chatId: 'chat-1' }) })),
            onChange: () => () => {},
        };
        env.apis.set('mechanicsDefinitions', door);
        expect(env.facades.mechanics.list()).toMatchObject({ ok: true, defs: [{ id: 'trust' }] });
        expect(env.facades.mechanics.get('trust')).toMatchObject({ ok: true, def: { id: 'trust' } });
        expect(
            await env.facades.mechanics.save(mechanicDef('debt', { kind: 'global' }), {
                scope: { kind: 'card', avatar: 'officina.png' },
                by: 'officina',
            }),
        ).toMatchObject({ ok: true, def: { id: 'debt', scope: { avatar: 'officina.png' }, uid: 1 } });
        expect(door.save).toHaveBeenCalledWith(expect.objectContaining({ id: 'debt' }), 'officina');
        expect(await env.facades.mechanics.remove('trust')).toEqual({ ok: true });
        expect(door.remove).toHaveBeenCalledWith('trust', 'officina');
        expect(env.facades.mechanics.templates()).toMatchObject({ ok: true, templates: [{ id: 'health' }] });
        // The module's own template (its fresh id), the caller's scope.
        expect(env.facades.mechanics.fromTemplate('health', { scope: { kind: 'global' } })).toMatchObject({
            ok: true,
            def: { id: 'trust_2', scope: { kind: 'global' } },
        });
        expect(await env.facades.mechanics.setEnabledInChat('trust', false)).toEqual({ ok: false, error: 'off' });
        // The door goes with the module (switched off): off again.
        env.apis.delete('mechanicsDefinitions');
        expect(env.facades.mechanics.list()).toEqual({ ok: false, error: 'off' });
    });
});

/* ------------------------------------------------------------------ presets */

describe('presets', () => {
    function fakes() {
        const store = {
            names: () => ['Marinara', 'Мастерская'],
            current: () => 'Marinara',
            working: () => ({ temperature: 1, prompts: [] }),
            saved: (name: string) => (name === 'Marinara' ? { temperature: 0.9 } : null),
            draft: vi.fn(() => ({ dirty: false, changedPrompts: [] as string[], changedKeys: [] as string[] })),
            select: vi.fn(async () => {}),
            saveAs: vi.fn(async (name: string) => name),
            createFromBody: vi.fn(async (name: string) => {
                if (name === 'Marinara') throw new PresetStoreError('exists', '«Marinara» exists');
                return name;
            }),
        };
        const layer = {
            part: vi.fn(async (scope: string) => ({
                layers:
                    scope === 'character' ? { Marinara: [{ op: 'toggle', identifier: 'main', enabled: false }] } : {},
                binding: scope === 'character' ? 'Мастерская' : null,
            })),
            recordFor: vi.fn(async () => {}),
            removeFor: vi.fn(async () => {}),
            bindFor: vi.fn(async () => {}),
        };
        env.apis.set('presetStore', store);
        env.apis.set('presetLayer', layer);
        return { store, layer };
    }

    it('reads the store and switches presets without dropping unsaved edits', async () => {
        const { store } = fakes();
        expect(env.facades.presets.list()).toEqual({
            ok: true,
            names: ['Marinara', 'Мастерская'],
            current: 'Marinara',
        });
        expect(env.facades.presets.working()).toMatchObject({ ok: true, name: 'Marinara', body: { temperature: 1 } });
        expect(env.facades.presets.saved('Nope')).toMatchObject({ ok: false, error: 'not-found' });
        expect(await env.facades.presets.select('Мастерская')).toEqual({ ok: true });
        expect(store.select).toHaveBeenCalledWith('Мастерская', { keepConnection: true });
        store.draft.mockReturnValue({ dirty: true, changedPrompts: ['main'], changedKeys: [] });
        expect(await env.facades.presets.select('Мастерская')).toMatchObject({ ok: false, error: 'unsaved' });
        expect(await env.facades.presets.select('Мастерская', { force: true })).toEqual({ ok: true });
        expect(await env.facades.presets.select('Nope')).toMatchObject({ error: 'not-found' });
    });

    it('saves a new preset from a body or the working copy, journaled under the neighbour', async () => {
        const { store } = fakes();
        expect(
            await env.facades.presets.saveAs(
                'Officina — соавтор',
                { temperature: 0.7 },
                { summary: 'Пресет соавтора' },
            ),
        ).toEqual({ ok: true, name: 'Officina — соавтор' });
        expect(store.createFromBody).toHaveBeenCalledWith(
            'Officina — соавтор',
            { temperature: 0.7 },
            {
                module: 'officina',
                summary: 'Пресет соавтора',
            },
        );
        expect(await env.facades.presets.saveAs('Marinara', {})).toMatchObject({ ok: false, error: 'exists' });
        expect(await env.facades.presets.saveAs('Копия')).toEqual({ ok: true, name: 'Копия' });
        expect(store.saveAs).toHaveBeenCalledWith('Копия', { module: 'officina' });
        expect(await env.facades.presets.saveAs('', {})).toMatchObject({ error: 'bad-args' });
    });

    it('edits and binds the layer part of any card it knows; the chat part only of the open chat', async () => {
        const { layer } = fakes();
        expect(await env.facades.presets.ops('character', 'martin.png')).toEqual({
            ok: true,
            layers: { Marinara: [{ op: 'toggle', identifier: 'main', enabled: false }] },
            binding: 'Мастерская',
        });
        const op = { op: 'toggle' as const, identifier: 'main', enabled: false };
        expect(await env.facades.presets.record('Marinara', op, 'character', 'martin.png')).toEqual({ ok: true });
        expect(layer.recordFor).toHaveBeenCalledWith('Marinara', op, 'character', {
            by: 'officina',
            owner: 'martin.png',
        });
        expect(await env.facades.presets.record('Marinara', { op: 'bogus' } as never, 'character')).toMatchObject({
            error: 'bad-args',
        });
        expect(await env.facades.presets.record('Nope', op, 'global')).toMatchObject({ error: 'not-found' });
        expect(await env.facades.presets.record('Marinara', op, 'character', 'ghost.png')).toMatchObject({
            error: 'not-found',
        });
        expect(await env.facades.presets.record('Marinara', op, 'chat', 'other-chat')).toMatchObject({
            error: 'bad-args',
        });
        expect(await env.facades.presets.remove('Marinara', 0, 'character', 'martin.png')).toEqual({ ok: true });
        expect(await env.facades.presets.remove('Marinara', 3, 'character', 'martin.png')).toMatchObject({
            error: 'not-found',
        });
        expect(await env.facades.presets.bind('character', 'Мастерская', 'martin.png')).toEqual({ ok: true });
        expect(layer.bindFor).toHaveBeenCalledWith('character', 'Мастерская', { by: 'officina', owner: 'martin.png' });
        expect(await env.facades.presets.unbind('character', 'martin.png')).toEqual({ ok: true });
        expect(layer.bindFor).toHaveBeenLastCalledWith('character', null, { by: 'officina', owner: 'martin.png' });
        expect(await env.facades.presets.bind('global' as never, 'Мастерская')).toMatchObject({ error: 'bad-args' });
        env.chatId = null;
        expect(await env.facades.presets.ops('chat')).toMatchObject({ error: 'no-chat' });
    });
});

/* ------------------------------------------------------------------ audit, persona, the service card */

describe('prompt audit', () => {
    it('gives the findings of the rules (no fixes), refuses a dry run that cannot run', async () => {
        const audit = {
            ready: async () => {},
            busy: () => null,
            dryRunAvailable: () => false,
            check: vi.fn(async () => ({
                at: 5,
                captureAt: 4,
                source: 'turn',
                hidden: 1,
                conflicts: [
                    {
                        id: 'c1',
                        fingerprint: 'f',
                        source: 'rules',
                        topic: 'pov',
                        severity: 'high',
                        a: { ref: 'preset:main', quote: 'Write in first person.' },
                        b: { ref: 'card:system', quote: 'Narrate in third person.' },
                        title: 'Чьими глазами',
                        why: 'Пресет и карточка спорят.',
                        fix: { side: 'a', kind: 'edit', target: 'preset:main' },
                    },
                ],
            })),
        };
        env.apis.set('promptAudit', audit);
        expect(await env.facades.promptAudit.run()).toEqual({
            ok: true,
            report: {
                at: 5,
                source: 'turn',
                hidden: 1,
                conflicts: [
                    {
                        id: 'c1',
                        source: 'rules',
                        topic: 'pov',
                        severity: 'high',
                        title: 'Чьими глазами',
                        why: 'Пресет и карточка спорят.',
                        a: { ref: 'preset:main', quote: 'Write in first person.' },
                        b: { ref: 'card:system', quote: 'Narrate in third person.' },
                    },
                ],
            },
        });
        expect(await env.facades.promptAudit.run({ dry: true })).toMatchObject({ ok: false, error: 'unavailable' });
        env.apis.delete('promptAudit');
        expect(await env.facades.promptAudit.run()).toEqual({ ok: false, error: 'off' });
    });
});

describe('persona', () => {
    it('creates a persona from a ready description, linked to a card, with its passport when asked', async () => {
        const create = vi.fn(async (plan: Dict) => ({
            ok: true,
            avatarId: 'persona-1.png',
            name: plan.name,
            steps: [
                { id: 'persona', status: 'done' },
                { id: 'link', status: 'done' },
                { id: 'passport', status: 'skipped', detail: 'нет NAI Studio' },
            ],
            current: false,
            picture: false,
            outfits: 0,
        }));
        env.apis.set('personaCreator', { create });
        const outcome = await env.facades.persona.create({
            name: 'Кай',
            description: 'Наёмник с северных перевалов.',
            wardrobe: [{ name: 'Дорожный', wording: 'плащ и сапоги', tags: 'cloak, boots' }],
            linkAvatar: 'vera.png',
            passport: true,
        });
        expect(outcome).toMatchObject({ ok: true, avatarId: 'persona-1.png', linked: true, passport: false });
        const plan = create.mock.calls[0]![0] as Dict;
        expect(plan).toMatchObject({
            card: { avatar: 'vera.png', name: 'Вера', index: 0 },
            name: 'Кай',
            description: 'Наёмник с северных перевалов.',
            outfits: [{ name: 'Дорожный', wording: 'плащ и сапоги', tags: 'cloak, boots' }],
            options: { passport: true, picture: true, link: true, makeCurrent: false },
        });
        expect(await env.facades.persona.create({ name: 'Кай', description: '' })).toMatchObject({ error: 'bad-args' });
        expect(
            await env.facades.persona.create({ name: 'Кай', description: 'x', linkAvatar: 'ghost.png' }),
        ).toMatchObject({
            error: 'not-found',
        });
        create.mockResolvedValueOnce({ ok: false, error: 'ST refused', avatarId: '', name: 'Кай', steps: [] } as never);
        expect(await env.facades.persona.create({ name: 'Кай', description: 'x' })).toEqual({
            ok: false,
            error: 'failed',
            message: 'ST refused',
        });
    });
});

describe('the service card', () => {
    it('tells and sets it through M42, journaled under the neighbour', async () => {
        const setCard = vi.fn(async () => true);
        env.apis.set('workshop', { isWorkshopCard: (avatar: string) => avatar === 'vera.png', setCard });
        expect(env.facades.serviceCard.isServiceCard('vera.png')).toBe(true);
        expect(env.facades.serviceCard.isServiceCard('martin.png')).toBe(false);
        expect(await env.facades.serviceCard.setCard('martin.png', true)).toEqual({ ok: true });
        expect(setCard).toHaveBeenCalledWith('martin.png', true, { by: 'officina', quiet: true });
        setCard.mockResolvedValueOnce(false);
        expect(await env.facades.serviceCard.setCard('martin.png', true)).toMatchObject({ ok: false, error: 'failed' });
        expect(await env.facades.serviceCard.setCard('ghost.png', true)).toMatchObject({ error: 'not-found' });
        env.apis.delete('workshop');
        expect(await env.facades.serviceCard.setCard('martin.png', false)).toEqual({ ok: false, error: 'off' });
    });
});
