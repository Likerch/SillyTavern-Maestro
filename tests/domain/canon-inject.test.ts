import { describe, expect, it } from 'vitest';
import type { CanonItemLike, CanonMetaLike } from '../../src/domain/canon-book';
import {
    activationKey,
    additionCopy,
    applyCanon,
    isCanonActivation,
    itemKeys,
    keysMentioned,
    listsOf,
    overrideCopy,
    planCanonBudget,
    recentText,
    stripCanonBooks,
} from '../../src/domain/canon-inject';
import type { EntryListsLike } from '../../src/domain/canon-inject';

const CANON = 'Maestro · канон · abcd1234';

function item(uid: number, fields: Partial<CanonMetaLike>, entry: Record<string, unknown> = {}): CanonItemLike {
    return {
        uid,
        meta: { kind: 'addition', status: 'active', origin: 'user', createdAt: 1, updatedAt: 2, ...fields },
        entry: { uid, key: [], keysecondary: [], content: '', ...entry },
    };
}

/** ST-like shallow copies whose nested arrays are frozen (they alias ST's cache). */
function copy(world: string, uid: number, fields: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        uid,
        world,
        key: Object.freeze([`key${uid}`]),
        keysecondary: Object.freeze([]),
        content: `Base ${uid}`,
        comment: `Entry ${uid}`,
        order: 100,
        extensions: Object.freeze({ other: true }),
        ...fields,
    };
}

function lists(): EntryListsLike {
    return {
        globalLore: [copy('World', 0), copy('World', 1)],
        characterLore: [copy('Card', 0), copy('Card', 1)],
        chatLore: [],
        personaLore: [copy('Persona', 0)],
    };
}

const base = (world: string, uid: number) => ({ world, uid, contentHash: 'h' });

describe('payload helpers', () => {
    it('listsOf accepts only the four-array payload', () => {
        expect(listsOf(null)).toBeNull();
        expect(listsOf({ globalLore: [], characterLore: [], chatLore: [] })).toBeNull();
        const payload = { globalLore: [], characterLore: [], chatLore: [], personaLore: [] };
        expect(listsOf(payload)?.chatLore).toBe(payload.chatLore);
        expect(activationKey('World', 3)).toBe('World.3');
    });

    it('strips canon books and reports only the ones ST loaded itself', () => {
        const value = lists();
        value.globalLore.push(copy(CANON, 0), copy('Maestro · канон · other', 1));
        value.chatLore.push(additionCopy(item(5, {}), CANON));
        expect(stripCanonBooks(value)).toEqual([CANON, 'Maestro · канон · other']);
        expect(value.globalLore).toHaveLength(2);
        expect(value.chatLore).toHaveLength(0);
    });
});

describe('applyCanon', () => {
    it('pushes additions into chatLore with fresh arrays and the canon marker', () => {
        const value = lists();
        const addition = item(3, { type: 'place' }, { key: ['Tavern', 'Таверна'], content: 'A tavern.' });
        const result = applyCanon(value, [addition], { canonBook: CANON });
        expect(result).toMatchObject({ added: 1, replaced: 0 });
        expect(value.chatLore).toHaveLength(1);
        const pushed = value.chatLore[0]!;
        expect(pushed).toMatchObject({ uid: 3, world: CANON, content: 'A tavern.', key: ['Tavern', 'Таверна'] });
        expect(pushed.key).not.toBe(addition.entry.key);
        expect(pushed.extensions).toEqual({
            maestro: { kind: 'addition', status: 'active', origin: 'user', canonUid: 3, type: 'place' },
        });
    });

    it('replaces an override in place, in its own list, without touching nested arrays of the base', () => {
        const value = lists();
        const before = value.characterLore[1]!;
        const override = item(
            7,
            { kind: 'override', base: base('Card', 1), fields: ['content', 'key'] },
            { content: 'Changed', key: ['new key'], order: 1 },
        );
        const result = applyCanon(value, [override], { canonBook: CANON });
        expect(result.replaced).toBe(1);
        const replaced = value.characterLore[1]!;
        expect(replaced).not.toBe(before);
        expect(replaced).toMatchObject({ uid: 1, world: 'Card', content: 'Changed', key: ['new key'], order: 100 });
        expect(replaced.extensions).toEqual({
            other: true,
            maestro: { kind: 'override', status: 'active', origin: 'user', canonUid: 7 },
        });
        expect(before.key).toEqual(['key1']);
        expect(before.content).toBe('Base 1');
        expect(value.characterLore).toHaveLength(2);
        expect(value.globalLore.map((entry) => entry.content)).toEqual(['Base 0', 'Base 1']);
    });

    it('suppresses base copies, wins over an override of the same base and collects pins', () => {
        const value = lists();
        const result = applyCanon(
            value,
            [
                item(1, { kind: 'suppress', base: base('World', 0) }),
                item(2, { kind: 'override', base: base('World', 0) }, { content: 'X' }),
                item(3, { kind: 'pin', base: base('Persona', 0) }),
                item(4, { kind: 'pin', base: base('Persona', 0), pinWhen: 'always' }),
                item(5, { kind: 'override', base: base('Gone', 1) }, { content: 'Y' }),
                item(6, { kind: 'suppress', base: base('Gone', 2) }),
            ],
            { canonBook: CANON },
        );
        expect(value.globalLore.map((entry) => entry.uid)).toEqual([1]);
        expect(result).toMatchObject({ suppressed: 1, replaced: 1, missing: 2, pins: ['Persona.0'] });
    });

    it('is idempotent on the same payload', () => {
        const value = lists();
        const items = [
            item(0, {}, { content: 'Added', key: ['a'] }),
            item(1, { kind: 'override', base: base('World', 1) }, { content: 'Over' }),
            item(2, { kind: 'suppress', base: base('Card', 0) }),
        ];
        applyCanon(value, items, { canonBook: CANON });
        const once = JSON.parse(JSON.stringify(value)) as unknown;
        const overrideObject = value.globalLore[1];
        applyCanon(value, items, { canonBook: CANON });
        expect(JSON.parse(JSON.stringify(value))).toEqual(once);
        expect(value.globalLore[1]).toBe(overrideObject);
        expect(value.chatLore).toHaveLength(1);
    });

    it('leaves archived items out unless they were mentioned, and checks pin conditions', () => {
        const items = [
            item(0, { status: 'archived' }, { key: ['Dragon'] }),
            item(1, { status: 'archived', kind: 'override', base: base('World', 0) }, { content: 'Old dragon' }),
            item(2, { kind: 'pin', base: base('World', 1), pinWhen: 'tavern' }),
        ];
        const silent = lists();
        const quiet = applyCanon(silent, items, { canonBook: CANON, mentioned: () => false, pinActive: () => false });
        expect(quiet).toMatchObject({ added: 0, replaced: 0, dormant: 2, pins: [] });
        const seen: unknown[] = [];
        const loud = lists();
        const result = applyCanon(loud, items, {
            canonBook: CANON,
            mentioned: (candidate, baseCopy) => {
                seen.push(baseCopy?.uid);
                return true;
            },
            pinActive: () => true,
        });
        expect(result).toMatchObject({ added: 1, replaced: 1, dormant: 0, pins: ['World.1'] });
        expect(seen).toEqual([0, undefined]);
        expect(applyCanon(lists(), items, { canonBook: CANON }).dormant).toBe(2);
    });

    it('overrideCopy works without base extensions', () => {
        const result = overrideCopy(
            { uid: 1, world: 'W', content: 'a' },
            item(3, { kind: 'override' }, { content: 'b' }),
        );
        expect(result).toEqual({
            uid: 1,
            world: 'W',
            content: 'b',
            extensions: { maestro: { kind: 'override', status: 'active', origin: 'user', canonUid: 3 } },
        });
    });
});

describe('mentions', () => {
    const chat = [
        { mes: 'Old message about nothing', is_user: true },
        { mes: 'System note', is_system: true },
        { mes: 'Она вспомнила Дракона.', is_user: false },
        { mes: '', is_user: true },
        'junk',
        { mes: 'И тут — ёлка!', is_user: true },
    ];

    it('recentText takes the last non-system messages', () => {
        expect(recentText(chat, 2)).toBe('Она вспомнила Дракона.\nИ тут — ёлка!');
        expect(recentText([], 2)).toBe('');
    });

    it('keysMentioned matches plain keys case-insensitively and regex keys by their flags', () => {
        const text = recentText(chat, 2);
        expect(keysMentioned(['дракон'], text)).toBe(true);
        expect(keysMentioned(['Елка'], text)).toBe(true);
        expect(keysMentioned(['/дракон/'], text)).toBe(false);
        expect(keysMentioned(['/дракон/i'], text)).toBe(true);
        expect(keysMentioned(['', 5, ' '], text)).toBe(false);
        expect(keysMentioned('дракон', text)).toBe(false);
        expect(keysMentioned(['дракон'], '')).toBe(false);
    });

    it('itemKeys joins primary and secondary keys', () => {
        expect(itemKeys(item(0, {}, { key: ['a', 3], keysecondary: ['b'] }))).toEqual(['a', 'b']);
        expect(itemKeys({ uid: 0, meta: item(0, {}).meta, entry: {} })).toEqual([]);
    });
});

describe('budget', () => {
    it('recognises canon activations', () => {
        expect(isCanonActivation({ world: CANON }, CANON)).toBe(true);
        expect(
            isCanonActivation({ world: 'W', extensions: { maestro: { kind: 'override', canonUid: 1 } } }, CANON),
        ).toBe(true);
        expect(isCanonActivation({ world: 'W', extensions: { maestro: { kind: 'place' } } }, CANON)).toBe(false);
        expect(isCanonActivation(null, CANON)).toBe(false);
    });

    it('keeps the highest order and newest first and cuts the rest', () => {
        const plan = planCanonBudget(
            100,
            [
                { key: 'a', chars: 400, order: 10, updatedAt: 1 },
                { key: 'b', chars: 400, order: 50, updatedAt: 1 },
                { key: 'c', chars: 400, order: 50, updatedAt: 5 },
                { key: 'd', chars: 50, order: 1, updatedAt: 1 },
            ],
            1000,
        );
        expect(plan).toEqual({ keep: ['c', 'b', 'd'], cut: ['a'], used: 950 });
    });

    it('keeps everything without a limit and orders ties by key', () => {
        const items = [
            { key: 'b', chars: 10, order: 1, updatedAt: 1 },
            { key: 'a', chars: 10, order: 1, updatedAt: 1 },
        ];
        expect(planCanonBudget(5, items, 0)).toEqual({ keep: ['b', 'a'], cut: [], used: 25 });
        expect(planCanonBudget(0, items, 15)).toEqual({ keep: ['a'], cut: ['b'], used: 10 });
    });
});
