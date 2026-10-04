// @vitest-environment happy-dom
// M22 stage 2 (dev-plan 2.6): Cyrillic left boundary, pack version conflicts, the <NSFW> wrapper, CK archive proposals.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { matchKey } from '../../../src/domain/lore-match';
import { LEFT_BOUNDARY } from '../../../src/domain/rules-keys';
import { packGroupId } from '../../../src/domain/rules-packs';
import type { EntryCopy, PackGroupInfo, RulesApi } from '../../../src/features/rules/api';
import {
    ARCHIVE_DEPTH_KIND,
    PACK_VERSION_KIND,
    builtinRules,
    proposeArchiveFixes,
    registerLoreHandlers,
} from '../../../src/features/rules/builtin';
import { RulesEngine } from '../../../src/features/rules/engine';
import type { Decision, Proposal } from '../../../src/shared/contracts';
import { FakeLoreJournal, createRulesTestApp, loggedErrors } from '../../helpers/rules-app';
import type { RulesTestApp } from '../../helpers/rules-app';
import { startRules } from '../../helpers/rules-module';
import type { StartedRules } from '../../helpers/rules-module';
import { book, entry, freezeNested, listsOf, runScan } from '../../helpers/rules-wi';
import type { WiBook, WiEntry } from '../../helpers/rules-wi';
import { EVENT_TYPES } from '../../helpers/st-mock';

let env: RulesTestApp;
let started: StartedRules | null = null;

/** An entry with fields the shared helper does not declare (matchWholeWords, caseSensitive, scanDepth…). */
function wi(uid: number, fields: Record<string, unknown>): WiEntry {
    return { ...entry(uid), ...fields } as WiEntry;
}

async function settle(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

async function start(): Promise<Required<RulesApi>> {
    started = await startRules(env);
    await settle();
    return started.api;
}

async function load(books: WiBook[]): Promise<EntryCopy[]> {
    const lists = listsOf(books);
    await env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
    return lists.globalLore;
}

function adapter(id: string, fields: Record<string, unknown>): void {
    const adapters = env.app.adapters as unknown as Record<string, Record<string, unknown>>;
    adapters[id] = { ...adapters[id], ...fields };
}

function proposalsOf(kind: string): Proposal[] {
    return env.autonomy.proposals.filter((proposal) => proposal.kind === kind);
}

beforeEach(() => {
    env = createRulesTestApp({ firstRunDone: true });
});

afterEach(async () => {
    await started?.stop();
    started = null;
    vi.useRealTimers();
});

/* ------------------------------------------------------------------ Cyrillic left boundary */

describe('keys.cyrillicLeftBoundary', () => {
    let globals: Record<string, unknown>;

    beforeEach(() => {
        globals = { world_info_match_whole_words: false, world_info_case_sensitive: false };
        env.host.modules.worldInfo = async () => globals;
    });

    const world = (): WiBook[] => [
        book('Мир', [
            wi(1, { key: ['Иван', 'Ivan'], matchWholeWords: true }),
            wi(2, { key: ['Аня'], keysecondary: ['лес'] }),
            wi(3, { key: ['Таня'], matchWholeWords: false }),
            wi(4, { key: ['{{char}}', '/аня/i', 'Аня Петрова'], matchWholeWords: true }),
            wi(5, { key: ['Иван'], matchWholeWords: true, caseSensitive: true }),
            wi(6, { key: ['Аня'], matchWholeWords: true, disable: true }),
        ]),
    ];

    it('replaces plain Cyrillic keys on the copies, per entry and per global setting, without touching the cache', async () => {
        const rules = await start();
        const source = world();
        freezeNested(source);
        const copies = await load(source);
        expect(copies.map((copy) => copy.key)).toEqual([
            [`/${LEFT_BOUNDARY}Иван/iu`, 'Ivan'],
            ['Аня'],
            ['Таня'],
            ['{{char}}', '/аня/i', 'Аня Петрова'],
            [`/${LEFT_BOUNDARY}Иван/u`],
            ['Аня'],
        ]);
        expect(source[0]!.entries[0]!.key).toEqual(['Иван', 'Ivan']);
        const state = rules.list().find((item) => item.id === 'keys.cyrillicLeftBoundary')!;
        expect(state.lastChanges.map((change) => [change.uid, change.field])).toEqual([
            [1, 'key'],
            [5, 'key'],
        ]);

        // The global switch is a live binding: read on every scan.
        globals.world_info_match_whole_words = true;
        const again = await load(world());
        expect(again[1]).toMatchObject({ key: [`/${LEFT_BOUNDARY}Аня/iu`], keysecondary: [`/${LEFT_BOUNDARY}лес/iu`] });
        expect(again[2]!.key).toEqual(['Таня']);
        expect(loggedErrors(env)).toEqual([]);
    });

    it('keeps case endings and stops «аня» inside «Таня» with ST matching', async () => {
        await start();
        const [ivan, anya] = await load([
            book('Мир', [
                wi(1, { key: ['Иван'], matchWholeWords: true }),
                wi(2, { key: ['аня'], matchWholeWords: true }),
            ]),
        ]);
        const fires = (copy: EntryCopy | undefined, text: string) =>
            (copy?.key as string[]).some((key) => matchKey(text, key, { caseSensitive: false, matchWholeWords: true }));
        expect(fires(ivan, 'Отдай это Ивану.')).toBe(true);
        expect(fires(ivan, 'Ливан')).toBe(false);
        expect(fires(anya, 'Аня, иди сюда')).toBe(true);
        expect(fires(anya, 'Таня пришла')).toBe(false);
        // What ST does with the plain key.
        expect(matchKey('Таня пришла', 'аня', { caseSensitive: false, matchWholeWords: true })).toBe(true);
    });

    it('leaves CK archives to DES-RU while its BunnyMo module widens them', async () => {
        await start();
        const archive = wi(7, {
            key: ['Анна'],
            matchWholeWords: true,
            content: '<BunnymoTags><Name:Анна>, <SPECIES:ELF></BunnymoTags>',
        });
        expect((await load([book('Архив', [archive])]))[0]!.key).toEqual([`/${LEFT_BOUNDARY}Анна/iu`]);
        adapter('desru', { capabilities: () => ['desru.present', 'desru.bunnymo'] });
        expect((await load([book('Архив', [archive])]))[0]!.key).toEqual(['Анна']);
        // Other entries are still converted.
        expect((await load([book('Мир', [wi(1, { key: ['Иван'], matchWholeWords: true })])]))[0]!.key).toEqual([
            `/${LEFT_BOUNDARY}Иван/iu`,
        ]);
    });

    it('compares before and after through M1', async () => {
        const rules = await start();
        const books = [
            book('Мир', [
                wi(1, { key: ['аня'], matchWholeWords: true, comment: 'Аня' }),
                wi(2, { key: ['Иван'], matchWholeWords: true, comment: 'Иван' }),
            ]),
        ];
        const text = 'Таня отдала Ивану письмо';
        env.modules.expose(
            'loreJournal',
            new FakeLoreJournal(async () => {
                const copies = await load(books);
                return copies
                    .filter((copy) =>
                        (copy.key as string[]).some((key) =>
                            matchKey(text, key, { caseSensitive: false, matchWholeWords: true }),
                        ),
                    )
                    .map((copy) => ({
                        world: copy.world,
                        uid: copy.uid,
                        comment: String(copy.comment),
                        chars: 10,
                        tokens: 3,
                        position: 0,
                        order: 100,
                        loop: 1,
                        recursionLevel: 0,
                        tags: [],
                    }));
            }),
        );
        const impact = await rules.compare(['keys.cyrillicLeftBoundary']);
        expect(impact.removed.map((row) => row.comment)).toEqual(['Аня']);
        expect(impact.added).toEqual([]);
        expect(impact.after.activations.map((row) => row.comment)).toEqual(['Иван']);
    });
});

/* ------------------------------------------------------------------ pack version conflicts */

describe('pack.versionConflict', () => {
    const V1 = 'MBTI v1 (Retired)';
    const V2 = 'MBTI V2';
    const group = packGroupId([V1, V2]);

    const mbti = (): WiBook[] => [
        book(V1, [
            entry(1, { key: ['<INTJ-H>'], content: 'Mastermind' }),
            entry(2, { key: ['<INTJ-U>'], content: 'The Schemer' }),
            entry(3, { key: ['<ENTP-U>'], content: 'Old debater' }),
        ]),
        book(V2, [
            entry(1, { key: ['<INTJ-H>'], content: 'Mastermind' }),
            entry(2, { key: ['<INTJ-U>'], content: 'The Cynic' }),
            entry(3, { key: ['<ENTP-U>'], content: 'New debater' }),
            entry(4, { key: ['<ESFP-H>'], content: 'Only in V2' }),
        ]),
    ];
    const disabled = (copies: EntryCopy[]) =>
        copies.filter((copy) => copy.disable === true).map((copy) => `${copy.world}#${copy.uid}`);

    it('asks once, offers the newest book and suppresses the other copies after the answer', async () => {
        await start();
        expect(disabled(await load(mbti()))).toEqual([`${V1}#1`]);
        await settle();
        const asked = proposalsOf(PACK_VERSION_KIND);
        expect(asked).toHaveLength(1);
        expect(asked[0]).toMatchObject({ module: 'M22', payload: { group, book: V2 } });
        expect(asked[0]!.description).toContain(
            '2 entries with the same keys but different text (for example <INTJ-U>, <ENTP-U>)',
        );
        expect(asked[0]!.title).toBe('Pack versions: keep “MBTI V2”?');
        expect(env.settings.module<{ packChoices: Record<string, string> }>('rules').packChoices).toEqual({
            [group]: V2,
        });
        expect(disabled(await load(mbti()))).toEqual([`${V1}#1`, `${V1}#2`, `${V1}#3`]);
        await settle();
        expect(proposalsOf(PACK_VERSION_KIND)).toHaveLength(1);
        // The journal entry of the answer: undo keeps every version and does not ask again.
        const record = env.journal.records.find((item) => item.kind === PACK_VERSION_KIND)!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(disabled(await load(mbti()))).toEqual([`${V1}#1`]);
        await settle();
        expect(proposalsOf(PACK_VERSION_KIND)).toHaveLength(1);
    });

    it('suppresses nothing while the answer waits in the Inbox, and asks only once', async () => {
        env.autonomy.levels.set(PACK_VERSION_KIND, 'inbox');
        await start();
        await load(mbti());
        await settle();
        await load(mbti());
        await settle();
        expect(proposalsOf(PACK_VERSION_KIND)).toHaveLength(1);
        expect(disabled(await load(mbti()))).toEqual([`${V1}#1`]);
        // Accepting the stored card later (after a reload) applies the answer.
        await env.inbox.appliers.get(PACK_VERSION_KIND)!({ group, book: V1 });
        expect(disabled(await load(mbti()))).toEqual([`${V1}#1`, `${V2}#2`, `${V2}#3`]);
    });

    it('keeps every version when the user says no, and lets him choose on the Rules tab', async () => {
        const rules = await start();
        env.app.autonomy.decide = async (): Promise<Decision> => 'rejected';
        await load(mbti());
        await settle();
        expect(disabled(await load(mbti()))).toEqual([`${V1}#1`]);
        const options = rules.options('pack.versionConflict') as { groups: PackGroupInfo[] };
        expect(options.groups).toEqual([
            {
                id: group,
                books: [V1, V2],
                newest: V2,
                count: 2,
                sample: ['<INTJ-U>', '<ENTP-U>'],
                choice: '',
                asked: true,
            },
        ]);

        const container = document.createElement('div');
        document.body.replaceChildren(container);
        const unmount = env.ui.tabs.find((tab) => tab.id === 'rules')!.render(container);
        const select = [...container.querySelectorAll<HTMLSelectElement>('select')].find((node) =>
            [...node.options].some((option) => option.value === V1),
        )!;
        expect([...select.options].map((option) => option.textContent)).toEqual([
            `keep “${V1}”`,
            `keep “${V2}” (newest)`,
            'keep every version',
        ]);
        select.value = V1;
        select.dispatchEvent(new Event('change'));
        await settle();
        expect(disabled(await load(mbti()))).toEqual([`${V1}#1`, `${V2}#2`, `${V2}#3`]);
        if (typeof unmount === 'function') unmount();
    });

    it('waits for the end of a generation and never asks from a simulation', async () => {
        await start();
        const generating = { type: 'normal', dryRun: false, quiet: false };
        env.turn.current = () => generating;
        await load(mbti());
        await settle();
        expect(proposalsOf(PACK_VERSION_KIND)).toHaveLength(0);
        env.turn.current = () => null;
        await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await settle();
        expect(proposalsOf(PACK_VERSION_KIND)).toHaveLength(1);

        const other = createRulesTestApp({ firstRunDone: true });
        env = other;
        await start();
        const lore = new FakeLoreJournal(async () => {
            await load(mbti());
            return [];
        });
        env.modules.expose('loreJournal', lore);
        await lore.simulate({});
        await settle();
        expect(proposalsOf(PACK_VERSION_KIND)).toHaveLength(0);
    });

    it('does not treat ordinary books as packs', async () => {
        await start();
        await load([
            book('World A', [entry(1, { key: ['Anna'], content: 'Anna the baker' })]),
            book('World B', [entry(1, { key: ['Anna'], content: 'Anna the knight' })]),
        ]);
        await settle();
        expect(proposalsOf(PACK_VERSION_KIND)).toHaveLength(0);
    });
});

/* ------------------------------------------------------------------ <NSFW> wrapper */

describe('wrapper.nsfwCollision', () => {
    const books = (): WiBook[] => [
        book('--CarrotCastLimited', [
            entry(58, {
                key: ['<GENRE:EROTIC>', '<NSFW>'],
                comment: 'Erotic',
                content: '# 🔥 **BunnyFlix Premium**',
            }),
            entry(59, { key: ['<GENRE:NSFW>'], comment: 'Genre tag', content: 'genre' }),
        ]),
        book('Genres', [entry(1, { key: ['<NSFW>'], comment: 'Adult', content: 'adult themes' })]),
        book('Архив', [
            entry(1, {
                key: ['анна'],
                comment: 'Анна',
                content: '<BunnymoTags><Name:Анна>, <SPECIES:ELF>\n<NSFW>secret</NSFW></BunnymoTags>',
            }),
        ]),
    ];

    it('stops recursion from firing CarrotCast’s <NSFW> entry, and only that one', async () => {
        await start();
        const copies = await load(books());
        expect(copies.map((copy) => copy.excludeRecursion)).toEqual([true, undefined, undefined, undefined]);
        const result = await runScan(env.mock, books(), 'анна пришла');
        expect([...result.activated.keys()].sort()).toEqual(['Genres.1', 'Архив.1']);
        // A direct mention still works.
        const direct = await runScan(env.mock, books(), 'тег <nsfw> в чате');
        expect(direct.activated.has('--CarrotCastLimited.58')).toBe(true);
    });

    it('lets recursion fire it again when the rule is off', async () => {
        const rules = await start();
        await rules.setEnabled('wrapper.nsfwCollision', false);
        const result = await runScan(env.mock, books(), 'анна пришла');
        expect(result.activated.has('--CarrotCastLimited.58')).toBe(true);
    });
});

/* ------------------------------------------------------------------ CK archive proposals */

describe('ck.archiveDepth', () => {
    type Book = { entries: Record<string, Record<string, unknown>> };
    let books: Map<string, Book>;
    let saves: { name: string; immediately: unknown }[];
    let reloads: string[];
    let engine: RulesEngine | null;

    const archive = (name: string, extra: Record<string, unknown> = {}) => ({
        key: [name],
        comment: `${name} Character Archive`,
        content: `<BunnymoTags><Name:${name}>, <SPECIES:ELF></BunnymoTags>`,
        position: 4,
        role: 2,
        scanDepth: 1,
        ...extra,
    });
    const stored = (...entries: Record<string, unknown>[]): Book => ({
        entries: Object.fromEntries(entries.map((item, index) => [String(index), { uid: index, ...item }])),
    });

    beforeEach(() => {
        vi.useFakeTimers();
        books = new Map([
            [
                'Архив',
                stored(archive('Анна'), archive('Борис', { scanDepth: null }), { key: ['лес'], content: 'Лес.' }),
            ],
            ['Species', stored(...['ELF', 'ORC', 'HUMAN'].map((tag) => ({ key: [`<SPECIES:${tag}>`], content: tag })))],
            ['Мир', stored({ key: ['город'], content: 'Город.', scanDepth: 1 })],
        ]);
        saves = [];
        reloads = [];
        engine = null;
        Object.assign(env.mock.context as unknown as Record<string, unknown>, {
            loadWorldInfo: async (name: string) => structuredClone(books.get(name) ?? null),
            saveWorldInfo: async (name: string, data: Book, immediately: unknown) => {
                saves.push({ name, immediately });
                books.set(name, structuredClone(data));
            },
            reloadWorldInfoEditor: (name: string) => reloads.push(name),
        });
        adapter('bunnymo', { activeBooks: async () => ['Архив', 'Species', 'Мир'] });
        adapter('desru', { api: () => ({ nameFormsKey: (name: string) => `/(?:${name.toLowerCase()}|анны)/iu` }) });
    });

    afterEach(() => {
        engine?.dispose();
    });

    function rulesEngine(): ReturnType<RulesEngine['env']> {
        engine = new RulesEngine(env.app, env.log);
        const renv = engine.env();
        for (const rule of builtinRules(renv)) engine.register(rule);
        registerLoreHandlers(renv);
        return renv;
    }

    it('proposes one Inbox card per archive book, once, with scan depth and case forms', async () => {
        const renv = rulesEngine();
        expect(await proposeArchiveFixes(renv)).toBe(1);
        const [card] = proposalsOf(ARCHIVE_DEPTH_KIND);
        expect(card).toMatchObject({
            module: 'M22',
            payload: {
                book: 'Архив',
                patches: [
                    {
                        uid: 0,
                        before: { scanDepth: 1, key: ['Анна'] },
                        after: { scanDepth: null, key: ['Анна', '/(?:анна|анны)/iu'] },
                    },
                ],
            },
        });
        expect(card!.description).toContain('DES-RU');
        expect(card!.changes[0]).toMatchObject({ target: 'lore-entry', ref: { book: 'Архив', uid: 0 } });
        // Queued (default 'inbox'): nothing written, and not proposed again for the same entries.
        expect(saves).toEqual([]);
        expect(await proposeArchiveFixes(renv)).toBe(0);
    });

    it('writes the book right away when accepted, and undo restores it', async () => {
        env.autonomy.levels.set(ARCHIVE_DEPTH_KIND, 'auto');
        adapter('desru', { api: () => undefined });
        const renv = rulesEngine();
        const before = JSON.stringify(books.get('Архив'));
        expect(await proposeArchiveFixes(renv)).toBe(1);
        expect(proposalsOf(ARCHIVE_DEPTH_KIND)[0]!.description).toContain('DES-RU is not available');
        expect(saves).toEqual([{ name: 'Архив', immediately: true }]);
        expect(reloads).toEqual(['Архив']);
        expect(books.get('Архив')!.entries['0']).toMatchObject({ scanDepth: null, key: ['Анна'] });
        const record = env.journal.records.find((item) => item.kind === ARCHIVE_DEPTH_KIND)!;
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(JSON.stringify(books.get('Архив'))).toBe(before);
    });

    it('never touches BunnyMo books, respects M35 roles and refuses stale cards', async () => {
        const roles: Record<string, { role: string; readOnly: boolean }> = {
            Архив: { role: 'world', readOnly: false },
            Мир: { role: 'ck.archive', readOnly: false },
            Species: { role: 'bunnymo.pack', readOnly: true },
        };
        env.modules.expose('bookRoles', { roleOf: (name: string) => roles[name], all: () => [] });
        const renv = rulesEngine();
        // «Архив» is a world book by role; «Мир» is an archive book by role but holds no archives.
        expect(await proposeArchiveFixes(renv)).toBe(0);

        roles['Архив'] = { role: 'ck.archive', readOnly: false };
        expect(await proposeArchiveFixes(renv)).toBe(1);
        const card = proposalsOf(ARCHIVE_DEPTH_KIND)[0]!;
        const apply = env.inbox.appliers.get(ARCHIVE_DEPTH_KIND)!;
        // The archive was edited in the meantime: the stored card no longer applies.
        books.get('Архив')!.entries['0']!.scanDepth = 3;
        await expect(apply(card.payload)).rejects.toThrow();
        expect(saves).toEqual([]);
        await expect(apply({ book: 'Species', patches: [] })).rejects.toThrow();
        await expect(apply({ nonsense: true })).rejects.toThrow();
    });

    it('loads only books the BunnyMo adapter knows to hold archives', async () => {
        const loaded: string[] = [];
        const load = (env.mock.context as unknown as { loadWorldInfo: (name: string) => Promise<unknown> })
            .loadWorldInfo;
        Object.assign(env.mock.context as unknown as Record<string, unknown>, {
            loadWorldInfo: async (name: string) => {
                loaded.push(name);
                return load(name);
            },
        });
        adapter('bunnymo', { books: () => ({ core: [], packs: ['Species'], archives: ['Архив'] }) });
        expect(await proposeArchiveFixes(rulesEngine())).toBe(1);
        expect(loaded).toEqual(['Архив']);
    });

    it('checks the books after a chat change, off the send path', async () => {
        await startRules(env).then((value) => {
            started = value;
        });
        expect(proposalsOf(ARCHIVE_DEPTH_KIND)).toHaveLength(0);
        await vi.advanceTimersByTimeAsync(2000);
        expect(proposalsOf(ARCHIVE_DEPTH_KIND)).toHaveLength(1);
        books.set('Мир', stored(archive('Вера')));
        await env.mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, 'chat-2');
        await vi.advanceTimersByTimeAsync(2000);
        expect(proposalsOf(ARCHIVE_DEPTH_KIND).map((card) => (card.payload as { book: string }).book)).toEqual([
            'Архив',
            'Мир',
        ]);
    });
});
