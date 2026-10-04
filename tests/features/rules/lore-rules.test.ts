import { beforeEach, describe, expect, it } from 'vitest';
import type { RuleChange, ScanInfo } from '../../../src/features/rules/api';
import { applyCaps, capRule, duplicatesRule, roleRule } from '../../../src/features/rules/builtin/lore';
import { RulesEngine } from '../../../src/features/rules/engine';
import { createRulesTestApp } from '../../helpers/rules-app';
import type { RulesTestApp } from '../../helpers/rules-app';
import { startRules } from '../../helpers/rules-module';
import { book, entry, freezeNested, listsOf, runScan } from '../../helpers/rules-wi';

let env: RulesTestApp;

beforeEach(() => {
    env = createRulesTestApp({ firstRunDone: true });
});

describe('role.assistantToSystem', () => {
    it('turns assistant-role depth entries into system ones and leaves the rest', () => {
        const source = [
            book('BunnyMo', [
                entry(64, { position: 4, role: 2 }),
                entry(65, { position: 4, role: 1 }),
                entry(66, { position: 1, role: 2 }),
                entry(67, { position: 4, role: 2, disable: true }),
                entry(68, { position: 4, role: null }),
                entry(69, { position: 4, role: 0 }),
            ]),
        ];
        freezeNested(source);
        const lists = listsOf(source, 'characterLore');
        const changes: RuleChange[] = [];
        roleRule().applyEntries!(lists, changes);
        expect(lists.characterLore.map((copy) => copy.role)).toEqual([0, 1, 2, 2, null, 0]);
        expect(changes).toEqual([{ world: 'BunnyMo', uid: 64, field: 'role', before: 2, after: 0 }]);
        expect(source[0]!.entries[0]!.role).toBe(2);
    });
});

describe('pack.duplicates', () => {
    it('disables the copies of older books and keeps arrays shared with the cache untouched', () => {
        const source = [
            book('MBTI v1', [entry(1, { key: ['<ENTJ-U>', 'entj'], content: 'Commander.' })]),
            book('MBTI V2', [entry(5, { key: ['entj ', '<entj-u>'], content: 'Commander.' })]),
            book('Other', [entry(1, { key: ['<ENTJ-U>', 'entj'], content: 'Commander (edited).' })]),
        ];
        freezeNested(source);
        const lists = listsOf(source, 'chatLore');
        const keys = lists.chatLore.map((copy) => copy.key);
        const changes: RuleChange[] = [];
        duplicatesRule().applyEntries!(lists, changes);
        expect(lists.chatLore.map((copy) => copy.disable)).toEqual([true, undefined, undefined]);
        expect(lists.chatLore.map((copy) => copy.key)).toEqual(keys);
        expect(changes).toEqual([{ world: 'MBTI v1', uid: 1, field: 'disable', before: false, after: true }]);
    });
});

describe('book.cap', () => {
    const info = (fields: Partial<ScanInfo> = {}): ScanInfo => ({
        loop: 1,
        recursionLevel: 0,
        final: false,
        simulated: false,
        ...fields,
    });

    it('prevents recursion only for books with a recursion limit', () => {
        env.settings.module<{ bookCaps: unknown }>('rules').bookCaps = {
            Limited: { maxRecursionLevel: 1 },
            TokensOnly: { maxTokens: 100 },
        };
        const engine = new RulesEngine(env.app, env.log);
        const lists = listsOf([
            book('Limited', [entry(1), entry(2, { preventRecursion: true })]),
            book('TokensOnly', [entry(3)]),
            book('Free', [entry(4)]),
        ]);
        const changes: RuleChange[] = [];
        capRule(engine.env()).applyEntries!(lists, changes);
        expect(lists.globalLore.map((copy) => copy.preventRecursion)).toEqual([true, true, undefined, undefined]);
        expect(changes).toEqual([{ world: 'Limited', uid: 1, field: 'preventRecursion', before: false, after: true }]);
    });

    it('does nothing without caps or without the activated map', () => {
        const engine = new RulesEngine(env.app, env.log);
        const lists = listsOf([book('Any', [entry(1)])]);
        capRule(engine.env()).applyEntries!(lists, []);
        expect(lists.globalLore[0]!.preventRecursion).toBeUndefined();
        expect(applyCaps(engine.env(), { activated: { entries: new Map() } }, info())).toEqual([]);
        engine.setBookCap('Any', { maxTokens: 10 });
        expect(applyCaps(engine.env(), { activated: {} }, info())).toEqual([]);
        expect(applyCaps(engine.env(), { activated: { entries: new Map([['x', 'y']]) } }, info())).toEqual([]);
    });

    it('cuts a book above its token cap, highest order first, and the cut entries never come back', async () => {
        const rules = (await startRules(env)).api;
        rules.setBookCap('Big World', { maxTokens: 60 });
        const long = 'x'.repeat(180); // 50 tokens by the estimate
        const books = [
            book('Big World', [
                entry(1, { key: ['castle'], order: 300, content: `${long} dragon` }),
                entry(2, { key: ['castle'], order: 200, content: long }),
                entry(3, { key: ['dragon'], order: 400, content: 'x'.repeat(18) }), // 5 tokens, via recursion
            ]),
            book('Small', [entry(9, { key: ['castle'], content: 'Small book entry.' })]),
        ];
        const result = await runScan(env.mock, books, 'We reach the castle.');
        expect([...result.activated.keys()].sort()).toEqual(['Big World.1', 'Big World.3', 'Small.9']);
        const cut = result.sorted.find((wi) => wi.world === 'Big World' && wi.uid === 2);
        expect(cut?.disable).toBe(true);
        // Loop 1: entries 1 (52 tokens) and 2 (50) exceed 60, entry 2 is cut. Loop 2 brings entry 3 through
        // recursion (order 400, 5 tokens): 5 + 52 still fits, and the disabled entry 2 cannot return.
        expect(result.perLoop[0]).not.toContain('Big World.2');
        expect(result.perLoop.at(-1)).not.toContain('Big World.2');
        expect(rules.cutEntries()).toEqual([
            {
                world: 'Big World',
                uid: 2,
                comment: 'Entry 2',
                chars: 180,
                tokens: 50,
                ruleId: 'book.cap',
                reason: 'tokens',
                loop: 1,
            },
        ]);
    });

    it('drops activations deeper than the recursion limit and keeps the capped book out of recursion', async () => {
        const rules = (await startRules(env)).api;
        rules.setBookCap('Lore', { maxRecursionLevel: 0 });
        const books = [
            book('Lore', [
                entry(1, { key: ['tavern'], content: 'The tavern keeper mentions the duke.' }),
                entry(2, { key: ['duke'], content: 'The duke rules the valley.' }),
                entry(3, { key: ['valley'], content: 'The valley is green.' }),
            ]),
            book('World', [entry(7, { key: ['tavern'], content: 'A tavern has a secret cellar.' })]),
            book('Lore2', [entry(8, { key: ['cellar'], content: 'The cellar hides a valley map.' })]),
        ];
        const result = await runScan(env.mock, books, 'We enter the tavern.');
        // Lore.1 matches directly; its text does not recurse (preventRecursion), so Lore.2 never fires.
        // World.7 recurses into Lore2.8 (level 1), whose text would trigger Lore.3 at level 2: cut.
        expect([...result.activated.keys()].sort()).toEqual(['Lore.1', 'Lore2.8', 'World.7']);
        expect(result.sorted.find((wi) => wi.world === 'Lore' && wi.uid === 3)?.disable).toBe(true);
        expect(rules.cutEntries().map((cut) => [cut.world, cut.uid, cut.reason, cut.loop])).toEqual([
            ['Lore', 3, 'recursion', 3],
        ]);
    });

    it('also disables the sortedEntries twin of a force-activated entry', () => {
        const engine = new RulesEngine(env.app, env.log);
        engine.setBookCap('Big', { maxTokens: 1 });
        const sortedTwin = { world: 'Big', uid: 5, order: 100, content: 'x'.repeat(50) };
        const forced = { ...sortedTwin };
        const activated = new Map<string, unknown>([['Big.5', forced]]);
        const cuts = applyCaps(
            engine.env(),
            { activated: { entries: activated }, new: { successful: [forced] }, sortedEntries: [sortedTwin] },
            info({ loop: 2 }),
        );
        expect(cuts).toHaveLength(1);
        expect(activated.size).toBe(0);
        expect(forced).toMatchObject({ disable: true });
        expect(sortedTwin).toMatchObject({ disable: true });
    });

    it('fills exact token counts after the final loop of a real scan and uses them next time', async () => {
        const engine = new RulesEngine(env.app, env.log);
        engine.setBookCap('Big', { maxTokens: 20 });
        const wi = { world: 'Big', uid: 1, order: 1, hash: 7, content: 'y'.repeat(72) };
        expect(engine.tokens.get(wi)).toBe(20);
        const args = { activated: { entries: new Map([['Big.1', wi]]) }, sortedEntries: [wi] };
        expect(applyCaps(engine.env(), args, info({ final: true, simulated: true }))).toEqual([]);
        expect(engine.tokens.has(wi)).toBe(false);
        applyCaps(engine.env(), args, info({ final: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        // The ST mock counts length / 4.
        expect(engine.tokens.get(wi)).toBe(18);
        engine.tokens.set(wi, 25);
        expect(
            applyCaps(engine.env(), { ...args, activated: { entries: new Map([['Big.1', wi]]) } }, info()),
        ).toHaveLength(1);
    });
});
