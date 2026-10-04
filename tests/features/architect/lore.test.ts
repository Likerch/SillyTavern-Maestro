// M20 lore rules through the real M22 engine and a miniature of ST's scan: damping with K and place nesting, pinning,
// the lore budget (order, exemptions, after book caps), consented duplicates in lore, idempotency and speed.
import { afterEach, describe, expect, it } from 'vitest';
import { DAMP_RULE_ID, LORE_BUDGET_RULE_ID, PIN_RULE_ID } from '../../../src/features/architect/lore';
import type { EntryLists } from '../../../src/features/rules/api';
import { book, entry, listsOf, runScan } from '../../helpers/rules-wi';
import type { WiBook } from '../../helpers/rules-wi';
import { loggedErrors } from '../../helpers/rules-app';
import { EVENT_TYPES } from '../../helpers/st-mock';
import { CANON_BOOK, architectSettings, place, runTurn, startArchitect, trackerReply, userMessage } from './helpers';
import type { ArchitectTestApp, EntitySpec } from './helpers';

const WORLD: EntitySpec[] = [
    { id: 'character:anna', kind: 'character', name: 'Anna', roster: true, present: true },
    { id: 'character:bob', kind: 'character', name: 'Bob', roster: true, present: false },
    { id: 'character:carl', kind: 'character', name: 'Carl' },
    { id: 'place:city', kind: 'place', name: 'City' },
    { id: 'place:docks', kind: 'place', name: 'Docks' },
    { id: 'place:tavern', kind: 'place', name: 'Tavern' },
    { id: 'place:warehouse', kind: 'place', name: 'Warehouse' },
    { id: 'place:hall', kind: 'place', name: 'Hall' },
    { id: 'place:market', kind: 'place', name: 'Market' },
    { id: 'place:farm', kind: 'place', name: 'Farm' },
];

const PLACES = [
    place('city', 'City', null),
    place('docks', 'Docks', 'city'),
    place('market', 'Market', 'city'),
    place('tavern', 'Tavern', 'docks'),
    place('warehouse', 'Warehouse', 'docks'),
    place('hall', 'Hall', 'tavern'),
    place('city2', 'City2', null),
    place('farm', 'Farm', 'city2'),
];

/** Entries keyed by words that are not the subject's name (a key fires, the name is not mentioned). */
function worldBook(): WiBook {
    return book('World', [
        entry(1, { comment: 'Anna', key: ['spellbook'], content: 'Anna is a mage of the north.', order: 100 }),
        entry(2, { comment: 'Bob', key: ['hammer'], content: 'Bob is a smith with a heavy hammer.', order: 100 }),
        entry(3, { comment: 'Farm', key: ['harvest'], content: 'The farm lies far to the south.', order: 100 }),
        entry(4, { comment: 'Docks', key: ['pier'], content: 'The docks smell of tar.', order: 100 }),
        entry(5, { comment: 'Rules of Bob', key: [], constant: true, content: 'Bob never lies.', order: 100 }),
        entry(6, { comment: 'Tavern', key: ['ale'], content: 'The tavern is warm and loud.', order: 100 }),
        entry(7, { comment: 'Market', key: ['stall'], content: 'The market is busy.', order: 100 }),
        entry(8, { comment: 'Warehouse', key: ['crate'], content: 'The warehouse holds crates.', order: 100 }),
        entry(9, { comment: 'Carl', key: ['lute'], content: 'Carl plays the lute.', order: 100 }),
    ]);
}

const SCAN_TEXT = 'spellbook hammer harvest pier ale stall crate lute';

let app: ArchitectTestApp;

async function start(): Promise<ArchitectTestApp> {
    app = await startArchitect({ world: WORLD, places: PLACES });
    app.places.enter('tavern');
    app.env.mock.chat = [
        userMessage('We came in.'),
        trackerReply('Anna sits by the fire.', ['Anna', '!Bob']),
        userMessage('I look at the hammer, the harvest notes, the pier and the stall.'),
    ];
    return app;
}

afterEach(async () => {
    await app?.stop();
});

function activeKeys(result: { activated: Map<string, unknown> }): string[] {
    return [...result.activated.keys()].sort();
}

describe('presence and place: damping', () => {
    it('does nothing while damping is off', async () => {
        await start();
        const result = await runScan(app.env.mock, [worldBook()], SCAN_TEXT);
        expect(activeKeys(result)).toContain('World.2');
        expect(activeKeys(result)).toContain('World.3');
    });

    it('damps absent characters and far places not mentioned in the last K messages', async () => {
        await start();
        architectSettings(app).presence.damp = true;
        const result = await runScan(app.env.mock, [worldBook()], SCAN_TEXT);
        const keys = activeKeys(result);
        // Bob is absent, the farm and the market are far: damped. Constant entries, near places, present Anna,
        // Carl (not in the DES roster) stay.
        expect(keys).not.toContain('World.2');
        expect(keys).not.toContain('World.3');
        expect(keys).not.toContain('World.7');
        expect(keys).toEqual(
            expect.arrayContaining(['World.1', 'World.4', 'World.5', 'World.6', 'World.8', 'World.9']),
        );
        const damped = app.service.lore.latest().damped;
        expect(damped.map((item) => [item.uid, item.reason, item.entity])).toEqual([
            [2, 'absent', 'character:bob'],
            [3, 'farPlace', 'place:farm'],
            [7, 'farPlace', 'place:market'],
        ]);
        expect(damped[0]!.sinceMention).toBe(-1);
        const state = app.rules.api.list().find((rule) => rule.id === DAMP_RULE_ID);
        expect(state?.lastChanges.map((change) => [change.uid, change.field, change.after])).toEqual([
            [2, 'disable', true],
            [3, 'disable', true],
            [7, 'disable', true],
        ]);
    });

    it('keeps an entry mentioned within K messages, damps it once the mention is older', async () => {
        await start();
        const settings = architectSettings(app);
        settings.presence.damp = true;
        app.env.mock.chat = [
            userMessage('Bob waved from the street.'),
            trackerReply('Anna nods.', ['Anna', '!Bob']),
            userMessage('Hm.'),
            trackerReply('Anna waits.', ['Anna', '!Bob']),
            userMessage('The hammer is heavy.'),
        ];
        let result = await runScan(app.env.mock, [worldBook()], SCAN_TEXT);
        expect(activeKeys(result)).toContain('World.2');
        settings.presence.mentionWindow = 3;
        result = await runScan(app.env.mock, [worldBook()], SCAN_TEXT);
        expect(activeKeys(result)).not.toContain('World.2');
        expect(app.service.lore.latest().damped.find((item) => item.uid === 2)?.sinceMention).toBe(4);
    });

    it('takes presence from the committed tracker: an off-scene character is absent', async () => {
        await start();
        architectSettings(app).presence.damp = true;
        app.env.mock.chat = [userMessage('Hi.'), trackerReply('Bob leaves.', ['!Anna', 'Bob']), userMessage('Ok.')];
        const result = await runScan(app.env.mock, [worldBook()], SCAN_TEXT);
        expect(activeKeys(result)).not.toContain('World.1');
        expect(activeKeys(result)).toContain('World.2');
    });

    it('falls back to the world model flags without a DES tracker', async () => {
        await start();
        architectSettings(app).presence.damp = true;
        app.env.mock.chat = [userMessage('Hi.'), userMessage('The hammer.')];
        const result = await runScan(app.env.mock, [worldBook()], SCAN_TEXT);
        expect(activeKeys(result)).not.toContain('World.2');
        expect(activeKeys(result)).toContain('World.1');
    });

    it('never damps canon, canon pins, BunnyMo books or typed entries of other kinds', async () => {
        await start();
        architectSettings(app).presence.damp = true;
        app.roles.roles.Packs = 'bunnymo.pack';
        app.canon.pins = [{ world: 'World', uid: 2 }];
        // Canon pins are read asynchronously: a first scan loads them.
        await runScan(app.env.mock, [worldBook()], SCAN_TEXT);
        await new Promise((resolve) => setTimeout(resolve, 0));
        const books = [
            worldBook(),
            book('Packs', [entry(1, { comment: 'Bob', key: ['hammer'], content: 'Bob tag.' })]),
            book(CANON_BOOK, [entry(1, { comment: 'Bob', key: ['hammer'], content: 'Canon Bob.' })]),
            book('Typed', [
                entry(1, {
                    comment: 'Bob',
                    key: ['hammer'],
                    content: 'An item of Bob.',
                    ...({ extensions: { maestro: { type: 'item', typeFields: { name: 'Hammer' } } } } as object),
                }),
            ]),
        ];
        const result = await runScan(app.env.mock, books, SCAN_TEXT);
        expect(activeKeys(result)).toEqual(
            expect.arrayContaining(['World.2', 'Packs.1', `${CANON_BOOK}.1`, 'Typed.1']),
        );
    });

    it('resolves subjects from typed metadata, the sidecar and the world sources', async () => {
        await start();
        architectSettings(app).presence.damp = true;
        app.world.set([
            ...WORLD,
            { id: 'character:dora', kind: 'character', name: 'Dora', roster: true, present: false, entries: ['Npc#3'] },
        ]);
        app.roles.meta['Npc#2'] = { type: 'character', typeFields: { name: 'Bob' } };
        const books = [
            book('Npc', [
                entry(1, {
                    comment: 'Smith',
                    key: ['hammer'],
                    content: 'The smith.',
                    ...({ extensions: { maestro: { type: 'character', typeFields: { name: 'Bob' } } } } as object),
                }),
                entry(2, { comment: 'Old smith', key: ['hammer'], content: 'Sidecar typed.' }),
                entry(3, { comment: 'Somebody', key: ['hammer'], content: 'Attached by the world model.' }),
                entry(4, { comment: 'Nobody', key: ['hammer'], content: 'Unknown subject.' }),
            ]),
        ];
        const result = await runScan(app.env.mock, books, 'hammer');
        expect(activeKeys(result)).toEqual(['Npc.4']);
    });
});

describe('presence and place: pinning', () => {
    it('forces entries of present characters and the current place into the first loop', async () => {
        await start();
        architectSettings(app).presence.pin = true;
        const result = await runScan(app.env.mock, [worldBook()], 'nothing matches here');
        expect(activeKeys(result)).toEqual(['World.1', 'World.5', 'World.6']);
        expect(result.perLoop[0]).toEqual(expect.arrayContaining(['World.1', 'World.6']));
        const pinned = app.service.lore.latest().pinned;
        expect(pinned.map((item) => [item.uid, item.reason])).toEqual([
            [1, 'present'],
            [6, 'currentPlace'],
        ]);
        const forced = result.activated.get('World.1') as Record<string, unknown>;
        expect(forced.content).toBe('Anna is a mage of the north.');
    });

    it('does not force entries with gates, disabled entries or the canon', async () => {
        await start();
        architectSettings(app).presence.pin = true;
        const books = [
            book('World', [
                entry(1, {
                    comment: 'Anna',
                    key: ['x1'],
                    content: 'Gated.',
                    characterFilter: { isExclude: false, names: ['Carl'], tags: [] },
                }),
                entry(2, { comment: 'Anna', key: ['x2'], content: 'Off.', disable: true }),
                entry(3, { comment: 'Anna', key: ['x3'], content: 'Trigger.', triggers: ['swipe'] }),
            ]),
            book(CANON_BOOK, [entry(1, { comment: 'Anna', key: ['x4'], content: 'Canon Anna.' })]),
        ];
        const result = await runScan(app.env.mock, books, 'nothing');
        expect(activeKeys(result)).toEqual([]);
    });

    it('keeps a pinned entry when the lore budget is tight', async () => {
        await start();
        const settings = architectSettings(app);
        settings.presence.pin = true;
        settings.budgets.lore = 1;
        const result = await runScan(app.env.mock, [worldBook()], 'pier');
        expect(activeKeys(result)).toEqual(expect.arrayContaining(['World.1', 'World.6']));
        expect(activeKeys(result)).not.toContain('World.4');
    });
});

describe('lore budget', () => {
    function budgetBook(): WiBook {
        return book('Lore', [
            entry(1, { key: ['k'], content: 'x'.repeat(360), order: 10 }),
            entry(2, { key: ['k'], content: 'y'.repeat(360), order: 50 }),
            entry(3, { key: ['k'], content: 'z'.repeat(360), order: 90 }),
            entry(4, { key: ['k'], content: 'w'.repeat(360), order: 5, ...({ ignoreBudget: true } as object) }),
            entry(5, { key: [], constant: true, content: 'c'.repeat(360), order: 1 }),
        ]);
    }

    it('cuts the lowest-order entries first, keeps exempt ones and constants last', async () => {
        await start();
        architectSettings(app).budgets.lore = 300;
        const result = await runScan(app.env.mock, [budgetBook()], 'k');
        // 5 × 100 tokens; budget 300: cut order 10, then 50 (non-constant first); ignoreBudget stays.
        expect(activeKeys(result)).toEqual(['Lore.3', 'Lore.4', 'Lore.5']);
        expect(app.lore.cuts).toEqual(['Lore.1', 'Lore.2']);
        const turn = app.service.lore.latest();
        expect(turn.cuts.map((cut) => cut.uid)).toEqual([1, 2]);
        expect(turn.loreBefore).toBe(500);
        expect(turn.loreAfter).toBe(300);
        const cut = result.sorted.find((item) => item.uid === 1);
        expect(cut?.disable).toBe(true);
    });

    it('cuts constants only when nothing else is left and never present-character entries or canon', async () => {
        await start();
        architectSettings(app).budgets.lore = 150;
        const books = [
            budgetBook(),
            book('People', [entry(1, { comment: 'Anna', key: ['k'], content: 'a'.repeat(360), order: 1 })]),
            book(CANON_BOOK, [entry(9, { key: ['k'], content: 'q'.repeat(360), order: 1 })]),
        ];
        const result = await runScan(app.env.mock, books, 'k');
        expect(activeKeys(result)).toEqual(['Lore.4', 'People.1', `${CANON_BOOK}.9`].sort());
    });

    it('runs after the book caps of M22', async () => {
        await start();
        app.rules.api.setBookCap('Lore', { maxTokens: 350 });
        architectSettings(app).budgets.lore = 250;
        const result = await runScan(app.env.mock, [budgetBook()], 'k');
        // The cap keeps the book's highest orders (90, 50, 10) and cuts the rest; the architect then sees 300 tokens
        // and cuts the lowest order of what is left.
        expect(activeKeys(result)).toEqual(['Lore.2', 'Lore.3']);
        expect(app.service.lore.latest().cuts.map((cut) => cut.uid)).toEqual([1]);
        expect(app.service.lore.latest().loreBefore).toBe(300);
    });

    it('reports the lore budget in the turn report', async () => {
        await start();
        architectSettings(app).budgets.lore = 300;
        await runTurn(app, { books: [budgetBook()], chatText: 'k', messages: [{ role: 'user', content: 'k' }] });
        const report = app.api.lastReport();
        expect(report?.budgets.find((row) => row.source === 'lore')).toEqual({
            source: 'lore',
            limit: 300,
            used: 300,
            cut: 200,
            status: 'cut',
        });
        expect(report?.effects?.find((effect) => effect.rule === 'loreBudget')).toEqual({
            rule: 'loreBudget',
            before: 500,
            after: 300,
            count: 2,
        });
        // A turn whose scan never ran (ST skips the loops when no entry is active) reports no stale cuts.
        await app.env.app.bus.emit('generation:before', { type: 'normal', dryRun: false, quiet: false });
        await app.env.mock.eventSource.emit(EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY!, {
            chat: [{ role: 'user', content: 'x' }],
            dryRun: false,
        });
        await new Promise((resolve) => setTimeout(resolve, 0));
        expect(app.api.lastReport()?.cuts).toEqual([]);
        expect(app.api.lastReport()?.budgets[0]).toMatchObject({ source: 'lore', used: 0, cut: 0, status: 'ok' });
    });

    it('leaves the scan alone without a budget', async () => {
        await start();
        const result = await runScan(app.env.mock, [budgetBook()], 'k');
        expect(activeKeys(result)).toHaveLength(5);
        expect(app.service.lore.latest().loreBefore).toBe(500);
    });
});

describe('send path behaviour', () => {
    it('is idempotent over repeated ENTRIES_LOADED and fresh copies', async () => {
        await start();
        architectSettings(app).presence.damp = true;
        const lists = listsOf([worldBook()]);
        const emit = () => app.env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, lists);
        await emit();
        await emit();
        const state = app.rules.api.list().find((rule) => rule.id === DAMP_RULE_ID);
        expect(state?.lastChanges).toHaveLength(3);
        expect(app.service.lore.latest().damped).toHaveLength(3);
        await app.env.mock.eventSource.emit(EVENT_TYPES.WORLDINFO_ENTRIES_LOADED!, listsOf([worldBook()]));
        expect(app.service.lore.latest().damped).toHaveLength(3);
        const disabled = lists.globalLore.filter((item) => item.disable === true).map((item) => item.uid);
        expect(disabled).toEqual([2, 3, 7]);
    });

    it('never mutates nested arrays of the cached entries', async () => {
        await start();
        const settings = architectSettings(app);
        settings.presence.damp = true;
        settings.presence.pin = true;
        settings.budgets.lore = 20;
        const books = [worldBook()];
        for (const item of books[0]!.entries) {
            Object.freeze(item.key);
            Object.freeze(item.triggers);
        }
        await expect(runScan(app.env.mock, books, SCAN_TEXT)).resolves.toBeDefined();
        expect(loggedErrors(app.env)).toEqual([]);
        expect(books[0]!.entries.every((item) => item.disable !== true)).toBe(true);
    });

    it('keeps the last real result during M1 simulations', async () => {
        await start();
        architectSettings(app).presence.damp = true;
        await runScan(app.env.mock, [worldBook()], SCAN_TEXT);
        app.lore.simulatingNow = true;
        app.env.mock.chat = [userMessage('Bob is here, the farm and the market too.')];
        await runScan(app.env.mock, [worldBook()], SCAN_TEXT);
        app.lore.simulatingNow = false;
        expect(app.service.lore.latest().damped).toHaveLength(3);
    });

    it('stays under 5 ms per handler on 500 entries (warm caches)', async () => {
        await start();
        const settings = architectSettings(app);
        settings.presence.damp = true;
        settings.presence.pin = true;
        settings.budgets.lore = 2000;
        const entries = Array.from({ length: 500 }, (_, index) =>
            entry(index + 1, {
                comment: ['Anna', 'Bob', 'Farm', 'Docks', `Thing ${index}`][index % 5],
                key: [`k${index}`],
                content: `Entry number ${index} with some text about the world and its people.`,
                order: index % 200,
            }),
        );
        const books = [book('Big', entries)];
        const lore = app.service.lore;
        const measure = (fn: () => void): number => {
            const start = performance.now();
            fn();
            return performance.now() - start;
        };
        const lists = (): EntryLists => listsOf(books);
        // Warm the caches once (subjects, scene, mentions), as the first ENTRIES_LOADED of a generation does.
        lore.damp(lists(), []);
        lore.pickPins(lists());
        const times = { damp: Infinity, pins: Infinity, dedup: Infinity, budget: Infinity };
        for (let run = 0; run < 5; run++) {
            times.damp = Math.min(
                times.damp,
                measure(() => lore.damp(lists(), [])),
            );
            times.pins = Math.min(
                times.pins,
                measure(() => lore.pickPins(lists())),
            );
            times.dedup = Math.min(
                times.dedup,
                measure(() => lore.dedup(lists(), [])),
            );
            const sorted = lists().globalLore.map((item) => ({ ...item }));
            const activated = new Map(sorted.map((item) => [`${item.world}.${item.uid}`, item]));
            const args = {
                state: { current: 1, next: 0, loopCount: 1 },
                activated: { entries: activated, text: '' },
                sortedEntries: sorted,
                new: { all: sorted, successful: sorted },
            };
            times.budget = Math.min(
                times.budget,
                measure(() => lore.budget(args, { loop: 1, recursionLevel: 0, final: true, simulated: true })),
            );
        }
        expect(times.damp).toBeLessThan(5);
        expect(times.pins).toBeLessThan(5);
        expect(times.dedup).toBeLessThan(5);
        expect(times.budget).toBeLessThan(5);
    });
});

describe('registration in M22', () => {
    it('registers its rules, shows them in the rules list and re-registers after M22 restarts', async () => {
        await start();
        const ids = app.rules.api.list().map((rule) => rule.id);
        expect(ids).toEqual(expect.arrayContaining([DAMP_RULE_ID, PIN_RULE_ID, LORE_BUDGET_RULE_ID]));
        await app.rules.stop();
        expect(app.service.ensureRules()).toBe(false);
        const { startRules } = await import('../../helpers/rules-module');
        app.rules = await startRules(app.env);
        expect(app.service.ensureRules()).toBe(true);
        expect(app.rules.api.list().map((rule) => rule.id)).toContain(DAMP_RULE_ID);
    });

    it('can be switched off in M22 like any lore rule', async () => {
        await start();
        architectSettings(app).presence.damp = true;
        await app.rules.api.setEnabled(DAMP_RULE_ID, false);
        const result = await runScan(app.env.mock, [worldBook()], SCAN_TEXT);
        expect(activeKeys(result)).toContain('World.2');
    });
});
