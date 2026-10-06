import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bunnymoModeModule } from '../../../src/features/bunnymoMode';
import type { BunnyMoModeApi } from '../../../src/features/bunnymoMode/api';
import {
    BUNNYMO_RULES,
    BunnyMoModeService,
    SELECTION_POINTER,
    SHEET_TARGET,
} from '../../../src/features/bunnymoMode/service';
import type { BookRoleInfo, BookRolesApi } from '../../../src/features/bookRoles/api';
import type { RuleState, RulesApi } from '../../../src/features/rules/api';
import { EVENT_TYPES } from '../../helpers/st-mock';
import {
    ARCHIVES,
    ATSU_CONTENT,
    BSM,
    CORE,
    CORE_OLD,
    COT,
    DERE,
    MBTI_V1,
    MBTI_V2,
    SPECIES,
    SPECIES_A,
    oldCoreEntries,
} from './fixtures';
import { allLists, bunnySaves, bunnySnapshot, createBunnyEnv, file, loadFixtures, startModule } from './helpers';
import type { BunnyEnv } from './helpers';

let env: BunnyEnv;
let api: Required<BunnyMoModeApi>;
let stop: () => Promise<void>;
let before: string;

beforeEach(async () => {
    env = createBunnyEnv();
    loadFixtures(env);
    before = bunnySnapshot(env);
    const started = await startModule(env, bunnymoModeModule);
    stop = () => started.stop();
    api = env.modules.api<Required<BunnyMoModeApi>>('bunnymoMode')!;
});

afterEach(async () => {
    // P13 after every test: BunnyMo books are byte-identical and were never saved.
    expect(bunnySnapshot(env)).toBe(before);
    expect(bunnySaves(env)).toEqual([]);
    await stop();
});

function roleInfo(book: string, role: BookRoleInfo['role'], source: 'auto' | 'user' = 'auto'): BookRoleInfo {
    return { book, role, source, fingerprint: 'f', readOnly: role.startsWith('bunnymo'), localizable: true };
}

function fakeRoles(infos: BookRoleInfo[]): BookRolesApi & { refreshed: number } {
    const roles = {
        refreshed: 0,
        roleOf: (book: string) => infos.find((info) => info.book === book),
        all: () => [...infos],
        setRole: async () => {},
        refresh: async () => {
            roles.refreshed++;
        },
        entryMeta: () => undefined,
        setEntryMeta: async () => {},
        onChange: () => () => {},
    };
    return roles;
}

/** A second service on the same app, for the parts the module does not expose (lists, rule edits). */
function service(): BunnyMoModeService {
    return new BunnyMoModeService(env.app, env.log);
}

describe('module', () => {
    it('registers its tab, health check, command and API, and leaves no listener behind', async () => {
        expect(env.ui.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['bunnymo', 'm35b.tab', 41]]);
        expect(env.ui.checks.map((check) => check.id)).toEqual(['m35b.integrity']);
        expect(env.commands.map((command) => command.name)).toEqual(['maestro-bunnymo']);
        const loaded = env.mock.eventSource.events.get(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!)?.length ?? 0;
        expect(loaded).toBe(1);
        await stop();
        expect(env.mock.eventSource.events.get(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!)?.length ?? 0).toBe(0);
        expect(env.ui.tabs).toEqual([]);
        expect(env.commands).toEqual([]);
        const started = await startModule(env, bunnymoModeModule);
        stop = () => started.stop();
    });

    it('opens the pult on the BunnyMo tab from the API and the command', async () => {
        const opened: (string | undefined)[] = [];
        env.ui.openPult = (tab) => void opened.push(tab);
        api.open({ tag: '<SPECIES:ELF>' });
        const command = env.commands[0]!;
        expect(await command.callback({}, '')).toBe('');
        expect(await command.callback({}, 'SPECIES:ELF')).toBe('');
        expect(await command.callback({}, 'Мира')).toBe('');
        expect(await command.callback({}, 'World')).toBe('');
        expect(await command.callback({}, 'something else')).toBe('');
        expect(opened).toEqual(['bunnymo', 'bunnymo', 'bunnymo', 'bunnymo', 'bunnymo', 'bunnymo']);
    });
});

describe('books and the tag dictionary', () => {
    it('finds BunnyMo books by content when no roles module runs, and builds the dictionary', async () => {
        env.ck.repos = [ARCHIVES];
        const dictionary = await api.dictionary();
        const tag = (name: string) => dictionary.tags.find((item) => item.tag === name);
        expect(tag('<INTJ-U>')).toMatchObject({ conflict: true, usedBy: [{ book: ARCHIVES, uid: 1, name: 'Мира' }] });
        expect(tag('<ISTJ-H>')?.duplicate).toBe(true);
        expect(tag('<DEPRESSION>')?.conflict).toBe(false);
        expect(tag('<TRAIT:STOIC>')?.orphan).toBe(true);
        expect(tag('<ATTACHMENT:FEARFUL_AVOIDANT>')?.orphan).toBe(false);
        expect(tag('<DERE_SYSTEM>')?.entries[0]).toMatchObject({ book: CORE, kind: 'info' });
        expect(dictionary.tags.some((item) => item.entries.some((entry) => entry.book === 'World'))).toBe(false);
    });

    it('finds archive books by content too, without CK', async () => {
        const dictionary = await api.dictionary();
        expect(dictionary.tags.find((item) => item.tag === '<SPECIES:ELF>')?.usedBy.map((use) => use.book)).toEqual([
            ARCHIVES,
        ]);
    });

    it('caches the dictionary by content and rebuilds it after a book is saved', async () => {
        const first = await api.dictionary();
        expect(await api.dictionary()).toBe(first);
        await env.world.edit(ARCHIVES, 2, {
            content: '<BunnymoTags><Name:Tavernkeeper>, <SPECIES:DWARF></BunnymoTags>',
        });
        const second = await api.dictionary();
        expect(second).not.toBe(first);
        expect(second.tags.find((tag) => tag.tag === '<SPECIES:DWARF>')?.usedBy.map((use) => use.name)).toEqual([
            'Tavernkeeper',
        ]);
    });

    it('takes BunnyMo books from M35 roles (refreshed once), the user role winning over the content', async () => {
        const roles = fakeRoles([
            roleInfo(CORE, 'bunnymo.core'),
            roleInfo(MBTI_V2, 'bunnymo.pack'),
            roleInfo(DERE, 'world', 'user'),
            roleInfo(ARCHIVES, 'ck.archive'),
        ]);
        env.modules.expose('bookRoles', roles);
        env.bunny.packs = [SPECIES, DERE];
        const packs = await api.packs();
        expect(packs.map((pack) => pack.book).sort()).toEqual([MBTI_V2, SPECIES].sort());
        const dictionary = await api.dictionary();
        expect(roles.refreshed).toBe(1);
        expect(dictionary.tags.find((tag) => tag.tag === '<INTJ-U>')?.usedBy.map((use) => use.name)).toEqual(['Мира']);
        expect(dictionary.tags.some((tag) => tag.entries.some((entry) => entry.book === DERE))).toBe(false);
    });
});

describe('pack manager', () => {
    it('describes packs: family, version, edition, active state', async () => {
        env.neighbours.active = [CORE, MBTI_V2, SPECIES, SPECIES_A];
        const packs = await api.packs();
        const byBook = new Map(packs.map((pack) => [pack.book, pack]));
        expect(new Set(packs.slice(0, 3).map((pack) => pack.book))).toEqual(new Set([MBTI_V2, SPECIES, SPECIES_A]));
        expect(byBook.get(MBTI_V2)).toMatchObject({
            name: 'MBTI',
            family: 'MBTI',
            version: '2',
            edition: 'shared',
            entries: 5,
            active: true,
            offInChat: false,
        });
        expect(byBook.get(MBTI_V1)).toMatchObject({ name: 'MBTI', version: '1', active: false });
        expect(byBook.get(SPECIES_A)).toMatchObject({ name: 'Species', edition: 'split' });
        expect(byBook.get(SPECIES)).toMatchObject({ edition: 'shared' });
        expect(byBook.get(COT)).toMatchObject({ name: 'BSM-5 CoT Lenses' });
        expect(byBook.has(CORE)).toBe(false);
    });

    it('stores the per-chat selection in the chat pointer, journals it and undoes it', async () => {
        expect(api.selection()).toEqual({ mode: 'all' });
        let changes = 0;
        const off = api.onChange(() => changes++);
        await api.setSelection({ mode: 'only', books: [MBTI_V2, MBTI_V2, SPECIES] });
        const stored = { mode: 'only', books: [MBTI_V2, SPECIES].sort() };
        expect(api.selection()).toEqual(stored);
        expect(env.app.chat.pointer(SELECTION_POINTER)).toEqual(stored);
        expect(changes).toBe(1);
        // Kinds come from roles, the adapter or a content classification already made (packs() here).
        expect(api.isOffInChat(MBTI_V1)).toBe(false);
        expect((await api.packs()).find((pack) => pack.book === MBTI_V1)?.offInChat).toBe(true);
        expect(api.isOffInChat(MBTI_V1)).toBe(true);
        expect(api.isOffInChat(MBTI_V2)).toBe(false);
        expect(api.isOffInChat(CORE)).toBe(false);
        expect(api.isOffInChat('World')).toBe(false);

        // The same selection again is no change.
        await api.setSelection({ mode: 'only', books: [SPECIES, MBTI_V2] });
        expect(env.journal.records).toHaveLength(1);
        const record = env.journal.records[0]!;
        expect(record).toMatchObject({ module: 'M35b', kind: 'bunnymo.packSelection' });
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(api.selection()).toEqual({ mode: 'all' });
        off();
    });

    it('refuses a selection without a chat, and undo in another chat', async () => {
        await api.setSelection({ mode: 'only', books: [] });
        const record = env.journal.records[0]!;
        const chat = env.mock.chatId;
        env.mock.chatId = undefined;
        await expect(api.setSelection({ mode: 'only', books: [] })).rejects.toThrow('Open a chat first.');
        expect(await env.journal.undo(record.id)).toBe(false);
        env.mock.chatId = chat;
    });

    it('compares a pack with a new file and writes nothing', async () => {
        const v2 = JSON.stringify(env.world.books.get(MBTI_V2));
        const diff = await api.diffWithFile(MBTI_V1, file('--BunnMBTI-Pack V2.json', v2));
        expect(diff.added).toEqual([]);
        expect(diff.removed).toEqual([]);
        expect(diff.changed.map((item) => item.comment)).toEqual([
            'INTJ (Healthy) - The Architect',
            'INTJ (Unhealthy) - The Cynic',
            'ENTJ (Unhealthy) - The Controlling Perfectionist',
        ]);
        await expect(api.diffWithFile(MBTI_V1, file('notes.txt', 'hello'))).rejects.toThrow('is not a lorebook file');
        await expect(api.diffWithFile('Missing', file('a.json', { entries: {} }))).rejects.toThrow('could not be read');
        expect(env.world.saves).toEqual([]);
    });
});

describe('per-chat suppression at scan time', () => {
    const worldsOf = (lists: object) =>
        [
            ...new Set(
                Object.values(lists as Record<string, Record<string, unknown>[]>)
                    .flat()
                    .map((entry) => String(entry.world)),
            ),
        ].sort();

    it('splices non-selected packs out of the scan copies, never the core, idempotently', async () => {
        await api.setSelection({ mode: 'only', books: [MBTI_V2, DERE] });
        const lists = allLists(env);
        const objects = Object.values(lists).flat();
        const snapshot = JSON.stringify(objects);
        await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
        expect(worldsOf(lists)).toEqual([ARCHIVES, CORE, DERE, MBTI_V2, 'World'].sort());
        // Entry objects (and their frozen nested arrays) are untouched.
        expect(JSON.stringify(objects)).toBe(snapshot);
        // Idempotent: a second pass (M22 first, then our listener) removes nothing more.
        expect(api.applySelection(lists)).toBe(0);
        expect(worldsOf(lists)).toEqual([ARCHIVES, CORE, DERE, MBTI_V2, 'World'].sort());
    });

    it('counts what it removed and leaves the scan alone for «all packs»', async () => {
        await api.setSelection({ mode: 'only', books: [MBTI_V2] });
        const lists = allLists(env);
        // MBTI v1 5, Dere 4, Species 3, split 3, BSM 3, CoT 3.
        expect(api.applySelection(lists)).toBe(21);
        const edits = await service().ruleEdits();
        expect(edits).toBeNull();
        await api.setSelection({ mode: 'all' });
        const full = allLists(env);
        const count = Object.values(full).flat().length;
        expect(api.applySelection(full)).toBe(0);
        expect(Object.values(full).flat()).toHaveLength(count);
        expect(api.applySelection({ nonsense: true })).toBe(0);
    });

    it('asks M35 roles first, so a pack the user re-labelled stays', async () => {
        env.modules.expose('bookRoles', fakeRoles([roleInfo(SPECIES, 'world', 'user'), roleInfo(BSM, 'bunnymo.pack')]));
        await api.setSelection({ mode: 'only', books: [] });
        const lists = allLists(env);
        api.applySelection(lists);
        const worlds = worldsOf(lists);
        expect(worlds).toContain(SPECIES);
        expect(worlds).not.toContain(BSM);
        expect(worlds).toContain(CORE);
    });
});

describe('integrity', () => {
    it('is quiet for a sane setup', async () => {
        env.neighbours.active = [CORE, MBTI_V2];
        expect(await api.integrity()).toEqual([]);
    });

    it('reports old cores, repos, CK rewrites, backups and global chat books', async () => {
        env.world.book(CORE_OLD, oldCoreEntries());
        env.neighbours.active = [CORE_OLD, MBTI_V2, MBTI_V1];
        env.ck.repos = [ARCHIVES, MBTI_V1];
        env.ck.tagLibraries = [DERE];
        env.ck.settings = { bunnymoTagWrapping: true };
        const archive = env.world.books.get(ARCHIVES) as { entries: Record<string, Record<string, unknown>> };
        env.world.book(`${ARCHIVES}.carrot_backup`, Object.values(structuredClone(archive.entries)));
        await env.world.edit(ARCHIVES, 2, {
            content: '<BunnymoTags:The Tavern>\nA noisy tavern by the river.\n</BunnymoTags:The Tavern>',
        });
        env.world.selected.push('Maestro · канон · abc', 'Chat book');
        env.mock.chatMetadata.world_info = 'Chat book';
        const findings = await api.integrity();
        expect(findings.map((finding) => `${finding.kind}:${finding.book ?? ''}`)).toEqual([
            `coreVersion:${CORE_OLD}`,
            `packAsRepo:${MBTI_V1}`,
            `ckWrapRewrite:${DERE}`,
            `ckWrapRewrite:${ARCHIVES}`,
            `ckBackup:${ARCHIVES}.carrot_backup`,
            'canonGlobal:Maestro · канон · abc',
            'chatBookGlobal:Chat book',
        ]);
        expect(findings[0]?.text).toBe(
            `The core «${CORE_OLD}» looks like version 2.7; Maestro is checked against V3.0.`,
        );
        expect(findings[2]?.text).toContain('CarrotKernel will rewrite the BunnyMo pack');
        env.world.books.delete(CORE_OLD);
    });

    it('reports packs active without the core, as a health check too', async () => {
        env.neighbours.active = [MBTI_V2];
        const findings = await api.integrity();
        expect(findings).toEqual([
            {
                kind: 'coreMissing',
                book: CORE,
                text: `Active packs: 1, but the core «${CORE}» is not active: sheet commands and Master entries do not work.`,
            },
        ]);
        const check = env.ui.checks.find((item) => item.id === 'm35b.integrity')!;
        expect(await check.run()).toEqual({ status: 'warn', message: `Problems: 1. ${findings[0]!.text}` });
        env.neighbours.active = [CORE, MBTI_V2];
        expect(await check.run()).toEqual({ status: 'ok', message: 'BunnyMo books are in order.' });
    });
});

describe('sheet editor', () => {
    beforeEach(() => {
        env.ck.repos = [ARCHIVES];
    });

    it('reads an archive as a sheet', async () => {
        expect(await api.readSheet(ARCHIVES, 1)).toEqual({
            book: ARCHIVES,
            uid: 1,
            name: 'Мира',
            tags: [
                { key: 'GENRE', value: 'FANTASY' },
                { key: 'SPECIES', value: 'ELF' },
                { key: 'GENDER', value: 'FEMALE' },
                { key: 'Dere', value: 'Kuudere' },
                { key: 'TRAIT', value: 'STOIC' },
                { key: 'ATTACHMENT', value: 'SECURE' },
            ],
            mbti: { type: 'INTJ', variant: 'U' },
            linguistics: ' Mira speaks with <LING:FORMAL> precision. ',
            sections: [{ title: '', text: 'She keeps a diary in Elvish.' }],
            title: 'Мира',
            blocks: 1,
        });
        expect(await api.readSheet(ARCHIVES, 2)).toBeNull();
        expect(await api.readSheet(ARCHIVES, 99)).toBeNull();
        expect(await api.readSheet('Missing', 1)).toBeNull();
    });

    it('validates tags against the dictionary with translated reasons', async () => {
        const results = await api.validateTags(['<SPECIES:ELF>', '<DERE:KUDERE>', '<TRAIT:STOIC>', '<GENRE:BLANK>']);
        expect(results.map((result) => [result.ok, result.reason])).toEqual([
            [true, undefined],
            [false, 'unknownValue'],
            [false, 'noPack'],
            [false, 'placeholder'],
        ]);
        expect(results[1]).toMatchObject({ suggestions: ['<DERE:KUUDERE>'], message: 'no pack entry for this value' });
    });

    it('saves through ST without the Lore Studio: untouched parts byte-identical, journal and undo', async () => {
        const sheet = (await api.readSheet(ARCHIVES, 0))!;
        sheet.tags = sheet.tags.map((tag) => (tag.value === 'CRUEL' ? { ...tag, value: 'MERCIFUL' } : tag));
        sheet.mbti = { type: 'ENTJ', variant: 'H' };
        await api.saveSheet(sheet);
        const saved = env.world.entry(ARCHIVES, 0)!;
        expect(saved.content).toBe(
            ATSU_CONTENT.replace('<TRAIT:CRUEL>', '<TRAIT:MERCIFUL>').replace('<ENTJ-U>', '<ENTJ-H>'),
        );
        expect(env.world.saves).toEqual([{ name: ARCHIVES, immediately: true }]);
        expect(env.world.reloads).toEqual([ARCHIVES]);
        expect(env.neighbours.desInvalidated).toEqual([ARCHIVES]);
        expect(env.ck.rescans).toEqual([[ARCHIVES]]);
        // Other entries and fields stay as they were.
        expect(env.world.entry(ARCHIVES, 1)?.content).toContain('<Name:Мира>');
        expect(saved.key).toEqual(['Atsu', 'Pharaoh']);
        const record = env.journal.records.find((item) => item.kind === 'bunnymo.sheet')!;
        expect(record.changes[0]).toMatchObject({
            target: SHEET_TARGET,
            ref: { book: ARCHIVES, uid: 0 },
            before: ATSU_CONTENT,
        });
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.world.entry(ARCHIVES, 0)?.content).toBe(ATSU_CONTENT);
        // Undo again: the entry no longer holds the saved text.
        record.undone = false;
        expect(await env.journal.undo(record.id)).toBe(false);
    });

    it('does not write an unchanged sheet', async () => {
        await api.saveSheet((await api.readSheet(ARCHIVES, 1))!);
        expect(env.world.saves).toEqual([]);
    });

    it('saves through the Lore Studio store when it runs', async () => {
        const calls: unknown[][] = [];
        env.modules.expose('loreStore', {
            books: () => [...env.world.books.keys()],
            load: async (name: string) => structuredClone(env.world.books.get(name) ?? null),
            updateEntry: async (...args: unknown[]) => void calls.push(args),
        });
        const sheet = (await api.readSheet(ARCHIVES, 1))!;
        sheet.tags.push({ key: 'TRAIT', value: 'PROUD' });
        await api.saveSheet(sheet);
        expect(calls).toHaveLength(1);
        const [book, uid, patch, reason] = calls[0]!;
        expect([book, uid]).toEqual([ARCHIVES, 1]);
        expect((patch as { content: string }).content).toContain('<TRAIT:STOIC>, <TRAIT:PROUD>');
        expect(reason).toEqual({ module: 'M35b', summary: 'Character sheet saved: Мира' });
        expect(env.world.saves).toEqual([]);
        expect(env.journal.records.some((item) => item.kind === 'bunnymo.sheet')).toBe(false);
    });

    it('refuses BunnyMo books, a changed name, missing entries and several blocks', async () => {
        const sheet = (await api.readSheet(ARCHIVES, 1))!;
        await expect(api.saveSheet({ ...sheet, name: 'Mira' })).rejects.toThrow('cannot change');
        await expect(api.saveSheet({ ...sheet, book: CORE, uid: 44 })).rejects.toThrow('is a BunnyMo book');
        await expect(api.saveSheet({ ...sheet, book: MBTI_V2, uid: 2 })).rejects.toThrow('is a BunnyMo book');
        env.bunny.packs = [DERE];
        await expect(api.saveSheet({ ...sheet, book: DERE, uid: 14 })).rejects.toThrow('is a BunnyMo book');
        await expect(api.saveSheet({ ...sheet, uid: 77 })).rejects.toThrow('has no such entry');
        await expect(api.saveSheet({ ...sheet, book: 'Missing' })).rejects.toThrow('could not be read');
        const content = `${String(env.world.entry(ARCHIVES, 1)!.content)}\n<BunnymoTags><Name:Ann></BunnymoTags>`;
        await env.world.edit(ARCHIVES, 1, { content });
        const two = (await api.readSheet(ARCHIVES, 1))!;
        expect(two.blocks).toBe(2);
        await expect(api.saveSheet({ ...two, tags: [] })).rejects.toThrow('holds several characters');
        expect(env.world.saves.map((save) => save.name)).toEqual([ARCHIVES]);
    });

    it('lists archives by book and finds them by name', async () => {
        const archives = await service().archives();
        expect(archives).toEqual([
            {
                book: ARCHIVES,
                items: [
                    {
                        uid: 0,
                        name: 'Atsu_Ibn_Oba_Al-Masri',
                        title: 'Atsu Character Archive - Generated by Baby Bunny Mode',
                        tags: 21,
                    },
                    { uid: 1, name: 'Мира', title: 'Мира', tags: 6 },
                ],
            },
        ]);
        expect(await service().findArchive('мира')).toEqual({ book: ARCHIVES, uid: 1 });
        expect(await service().findArchive('Atsu Ibn Oba Al-Masri')).toEqual({ book: ARCHIVES, uid: 0 });
        expect(await service().findArchive('pharaoh')).toEqual({ book: ARCHIVES, uid: 0 });
        expect(await service().findArchive('Nobody')).toBeNull();
    });
});

describe('runtime fixes (M22)', () => {
    it('lists rule changes to BunnyMo books with their switches', async () => {
        const toggled: [string, boolean][] = [];
        const state = (id: string, changes: RuleState['lastChanges'], enabled = true): RuleState => ({
            id,
            enabled,
            lastChanges: changes,
            waiting: id === 'pack.versionConflict',
            definition: {
                id,
                titleKey: `m22.rule.${id}.title`,
                descriptionKey: '',
                owner: id === 'desru.thing' ? 'desru' : 'maestro',
                stage: 1,
                kind: 'lore',
                defaultLevel: 'auto',
                enabledByDefault: true,
            },
        });
        const rules: Partial<RulesApi> = {
            list: () => [
                state('role.assistantToSystem', [
                    { world: CORE, uid: 64, field: 'role', before: 2, after: 0 },
                    { world: ARCHIVES, uid: 0, field: 'role', before: 2, after: 0 },
                ]),
                state('pack.versionConflict', [], false),
                state('keys.cyrillicLeftBoundary', [{ world: 'World', uid: 1, field: 'key', before: [], after: [] }]),
                state('desru.thing', [
                    { world: MBTI_V2, uid: 2, field: 'excludeRecursion', before: true, after: false },
                ]),
                state('qvink.gapGuard', []),
            ],
            setEnabled: async (id, enabled) => void toggled.push([id, enabled]),
            cutEntries: () => [
                {
                    world: MBTI_V2,
                    uid: 33,
                    comment: '',
                    chars: 1,
                    tokens: 1,
                    ruleId: 'book.cap',
                    reason: 'tokens',
                    loop: 1,
                },
                {
                    world: 'World',
                    uid: 1,
                    comment: '',
                    chars: 1,
                    tokens: 1,
                    ruleId: 'book.cap',
                    reason: 'tokens',
                    loop: 1,
                },
            ],
        };
        env.modules.expose('rules', rules);
        expect(BUNNYMO_RULES).toContain('pack.versionConflict');
        const edits = await service().ruleEdits();
        expect(
            edits?.rules.map((rule) => [rule.id, rule.changes.length, rule.cuts, rule.enabled, rule.waiting]),
        ).toEqual([
            ['role.assistantToSystem', 1, 0, true, false],
            ['pack.versionConflict', 0, 0, false, true],
            ['desru.thing', 1, 0, true, false],
        ]);
        await service().setRuleEnabled('pack.versionConflict', true);
        expect(toggled).toEqual([['pack.versionConflict', true]]);
    });
});
