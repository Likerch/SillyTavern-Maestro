import { describe, expect, it } from 'vitest';
import {
    CANON_BOOK_PREFIX,
    LORE_TAG_ORDER,
    addRecord,
    bookReasons,
    catalogFromLists,
    decodeRecord,
    decodeRecords,
    desLinkedBooks,
    emptyJournal,
    encodeRecord,
    ensureJournal,
    isCanonMeta,
    removeRecordsFrom,
    setRecordKeys,
    summarize,
    tagMask,
    tagsFor,
    tagsOfMask,
} from '../../src/domain/lore-journal';
import type { CatalogEntry, TagContext } from '../../src/domain/lore-journal';
import type { ActivationRow, LoreRecordRow } from '../../src/domain/lore-scan';

const noTags: TagContext = { bunnymoCore: new Set(), bunnymoPacks: new Set(), ckRepos: new Set(), desBooks: new Set() };

function row(world: string, uid: number, chars: number, extra: Partial<ActivationRow> = {}): ActivationRow {
    return {
        world,
        uid,
        comment: `${world}#${uid}`,
        chars,
        tokens: Math.ceil(chars / 4),
        position: 0,
        order: 100,
        loop: 1,
        recursionLevel: 0,
        tags: [],
        ...extra,
    };
}

function record(messageIndex: number, activations: ActivationRow[], extra: Partial<LoreRecordRow> = {}): LoreRecordRow {
    const kept = activations.filter((item) => !item.cut);
    return {
        messageIndex,
        at: messageIndex * 1000,
        generationType: 'normal',
        activations,
        totalChars: kept.reduce((sum, item) => sum + item.chars, 0),
        totalTokens: kept.reduce((sum, item) => sum + item.tokens, 0),
        overflow: false,
        canonChars: kept.filter((item) => item.tags.includes('canon')).reduce((sum, item) => sum + item.chars, 0),
        ...extra,
    };
}

describe('tags', () => {
    it('tags entries by stack role', () => {
        const context: TagContext = {
            bunnymoCore: new Set(['Core']),
            bunnymoPacks: new Set(['Pack', 'Core']),
            ckRepos: new Set(['Repo']),
            desBooks: new Set(['Repo']),
        };
        expect(tagsFor({ world: 'Core', constant: true }, context, true)).toEqual([
            'bunnymo.core',
            'localizer',
            'constant',
        ]);
        expect(tagsFor({ world: 'Pack', constant: false }, context, false)).toEqual(['bunnymo.pack']);
        expect(tagsFor({ world: 'Repo', constant: false }, context, false)).toEqual(['ck.archive', 'des.book']);
        expect(tagsFor({ world: `${CANON_BOOK_PREFIX} · ab12`, constant: false }, noTags, false)).toEqual(['canon']);
        expect(tagsFor({ world: 'Maestro · NPC', constant: false }, noTags, false)).toEqual(['maestro.book']);
        // Canon overrides keep the base book name; the meta tells them apart.
        expect(
            tagsFor({ world: 'World', constant: false, extensions: { maestro: { kind: 'override' } } }, noTags, false),
        ).toEqual(['canon']);
        expect(isCanonMeta({ maestro: {} })).toBe(false);
        expect(isCanonMeta(null)).toBe(false);
    });

    it('round-trips tag masks', () => {
        expect(tagsOfMask(tagMask(['canon', 'constant', 'ck.archive']))).toEqual(['ck.archive', 'canon', 'constant']);
        expect(tagsOfMask(tagMask([...LORE_TAG_ORDER]))).toEqual([...LORE_TAG_ORDER]);
        expect(tagMask([])).toBe(0);
    });
});

describe('desLinkedBooks', () => {
    it('reads campaigns, the campaign ledger, auto-link and Workshop injections', () => {
        const links = desLinkedBooks({
            lorebook: {
                campaigns: { c1: { books: ['A', 'B'] }, c2: { books: ['C', 7] }, bad: 3 },
                activeCampaignId: 'c1',
                campaignActivated: ['B', 'Z'],
                autoLinked: ['Anna', ''],
            },
            characterInjection: { Anna: { lorebook: 'Anna NPC' }, Boris: { lorebook: '' }, Bad: 1 },
        });
        expect(links.campaign.sort()).toEqual(['A', 'B', 'Z']);
        expect(links.campaignAll.sort()).toEqual(['A', 'B', 'C']);
        expect(links.autoLinked).toEqual(['Anna']);
        expect(links.workshop).toEqual(['Anna NPC']);
    });

    it('is empty without DES settings', () => {
        expect(desLinkedBooks(null)).toEqual({ campaign: [], campaignAll: [], autoLinked: [], workshop: [] });
        expect(desLinkedBooks({ lorebook: { activeCampaignId: 'none' } }).campaign).toEqual([]);
    });
});

describe('bookReasons', () => {
    it('explains every active book in scan priority order', () => {
        const rows = bookReasons({
            global: ['World', 'Anna', 'Camp', 'NPC'],
            characterPrimary: ['Card book'],
            characterExtra: ['Extra', 'Card book'],
            chat: `${CANON_BOOK_PREFIX} · 1`,
            persona: 'Persona book',
            ckChatBooks: [`${CANON_BOOK_PREFIX} · 1`, 'Inactive'],
            des: { campaign: ['Camp'], campaignAll: ['Camp'], autoLinked: ['Anna'], workshop: ['NPC'] },
        });
        expect(rows).toEqual([
            { book: `${CANON_BOOK_PREFIX} · 1`, reasons: ['chat', 'ckConnector', 'canon'] },
            { book: 'Persona book', reasons: ['persona'] },
            { book: 'Card book', reasons: ['character', 'characterExtra'] },
            { book: 'Extra', reasons: ['characterExtra'] },
            { book: 'World', reasons: ['global'] },
            { book: 'Anna', reasons: ['global', 'desAutoLink'] },
            { book: 'Camp', reasons: ['global', 'desCampaign'] },
            { book: 'NPC', reasons: ['global', 'workshop'] },
        ]);
    });

    it('handles a chat without chat or persona books', () => {
        const des = { campaign: [], campaignAll: [], autoLinked: [], workshop: [] };
        expect(bookReasons({ global: [], characterPrimary: [], characterExtra: [], ckChatBooks: [], des })).toEqual([]);
        expect(
            bookReasons({ global: [], characterPrimary: [], characterExtra: [], chat: 'C', ckChatBooks: [], des }),
        ).toEqual([{ book: 'C', reasons: ['chat'] }]);
    });
});

describe('compact storage', () => {
    it('round-trips a record', () => {
        const doc = emptyJournal();
        const original = record(4, [
            row('World', 1, 100, { tags: ['bunnymo.pack', 'constant'], position: 4, depth: 3, role: 2, key: 'Anna' }),
            row('World', 2, 50, { loop: 2, recursionLevel: 1, via: { world: 'World', uid: 1 }, key: '' }),
            row('Other', 3, 70, { cut: true, cutBy: 'budget' }),
            row('Other', 4, 10, { cut: true, cutBy: 'maestro' }),
            row('Other', 5, 10, { cut: true }),
            row('Other', 6, 10, { comment: '' }),
        ]);
        original.budgetTokens = 500;
        original.overflow = true;
        const stored = encodeRecord(doc, original);
        expect(doc.worlds).toEqual(['World', 'Other']);
        expect(decodeRecord(doc, stored)).toEqual(original);
        const bare = encodeRecord(doc, { ...record(5, []), canonChars: undefined });
        expect(bare).not.toHaveProperty('cc');
        expect(decodeRecord(doc, bare)).not.toHaveProperty('budgetTokens');
    });

    it('repairs loaded documents in place', () => {
        const raw: Record<string, unknown> = { records: [{ i: 1, a: [] }, { bad: true }], stats: { turns: 'x' } };
        const doc = ensureJournal(raw);
        expect(doc).toBe(raw);
        expect(doc.records).toHaveLength(1);
        expect(doc.stats).toEqual({ turns: 0, chars: 0, canon: 0, entries: {} });
        expect(doc.worlds).toEqual([]);
        const kept = ensureJournal({ stats: { turns: 2, chars: 10, canon: 1, entries: { '0:1': [1, 2, 3] } } });
        expect(kept.stats.turns).toBe(2);
    });
});

describe('addRecord and counters', () => {
    it('adds turns, replaces the same message and trims the list but not the counters', () => {
        const doc = emptyJournal();
        addRecord(doc, record(1, [row('W', 1, 100), row('W', 2, 40, { cut: true, cutBy: 'budget' })]), 2);
        addRecord(doc, record(3, [row('W', 1, 100), row(`${CANON_BOOK_PREFIX}`, 9, 30, { tags: ['canon'] })]), 2);
        expect(doc.stats.turns).toBe(2);
        expect(doc.stats.entries['0:1']).toEqual([2, 200, 3]);
        expect(doc.stats.entries['0:2']).toBeUndefined();
        expect(doc.stats.canon).toBe(30);
        // Swipe of message 3: the earlier record and its counters are replaced.
        addRecord(doc, record(3, [row('W', 2, 60)]), 2);
        expect(doc.records.map((item) => item.i)).toEqual([1, 3]);
        expect(doc.stats.turns).toBe(2);
        expect(doc.stats.entries['0:1']).toEqual([1, 100, 3]);
        expect(doc.stats.entries['0:2']).toEqual([1, 60, 3]);
        expect(doc.stats.canon).toBe(0);
        // Beyond `keep`: the oldest record leaves the list, the counters keep it.
        addRecord(doc, record(5, [row('W', 1, 100)]), 2);
        expect(doc.records.map((item) => item.i)).toEqual([3, 5]);
        expect(doc.stats.turns).toBe(3);
        expect(decodeRecords(doc).map((item) => item.messageIndex)).toEqual([3, 5]);
    });

    it('removes records of deleted messages', () => {
        const doc = emptyJournal();
        addRecord(doc, record(1, [row('W', 1, 100)]), 10);
        addRecord(doc, record(3, [row('W', 1, 100)]), 10);
        addRecord(doc, record(5, [row('W', 2, 10)]), 10);
        expect(removeRecordsFrom(doc, 3)).toBe(2);
        expect(doc.records.map((item) => item.i)).toEqual([1]);
        expect(doc.stats.turns).toBe(1);
        expect(doc.stats.entries['0:1']).toEqual([1, 100, 3]);
        expect(doc.stats.entries['0:2']).toBeUndefined();
    });

    it('stores lazily attributed keys', () => {
        const doc = emptyJournal();
        const original = record(2, [row('W', 1, 10), row('W', 2, 10)]);
        addRecord(doc, original, 10);
        const keyed = {
            ...original,
            activations: [
                { ...original.activations[0]!, key: 'Anna' },
                original.activations[1]!,
                row('X', 9, 1, { key: 'k' }),
            ],
        };
        expect(setRecordKeys(doc, keyed)).toBe(true);
        expect(decodeRecords(doc)[0]?.activations.map((item) => item.key)).toEqual(['Anna', undefined]);
        expect(setRecordKeys(doc, { ...keyed, at: 1 })).toBe(false);
    });
});

describe('catalog and summary', () => {
    const lists = {
        chatLore: [{ world: 'W', uid: 1, comment: 'One', content: 'aaaa' }],
        personaLore: 'nope',
        characterLore: [{ world: 'W', uid: 1, content: 'dup' }, { world: 'W', uid: 'x' }, null],
        globalLore: [
            { world: 'W', uid: 2, content: 'bb', constant: true },
            { world: 'G', uid: 5, content: 'ccccccc' },
            { world: 'G', uid: 6, content: 'dddddd', disable: true },
            { world: 7, uid: 1 },
        ],
    };

    it('builds the catalog from ENTRIES_LOADED lists', () => {
        const catalog = catalogFromLists(lists);
        expect(catalog.map((entry) => `${entry.world}:${entry.uid}`)).toEqual(['W:1', 'W:2', 'G:5', 'G:6']);
        expect(catalog[0]).toEqual({ world: 'W', uid: 1, comment: 'One', chars: 4, constant: false, disabled: false });
        expect(catalog[1]?.constant).toBe(true);
        expect(catalog[3]?.disabled).toBe(true);
        expect(catalogFromLists(null)).toEqual([]);
    });

    it('summarises heaviest books and entries, always and never active, averages', () => {
        const doc = emptyJournal();
        const catalog: CatalogEntry[] = catalogFromLists(lists);
        expect(summarize(doc, catalog)).toMatchObject({ turns: 0, neverActive: [], avgTotalChars: 0 });
        addRecord(doc, record(1, [row('W', 1, 100), row('W', 2, 10)]), 10);
        addRecord(doc, record(3, [row('W', 1, 100), row('C', 9, 40, { tags: ['canon'] })]), 10);
        doc.stats.entries['bad'] = [1, 1, 1];
        doc.stats.entries['9:1'] = [1, 1, 1];
        const summary = summarize(doc, catalog, { books: 1, entries: 2 });
        expect(summary.turns).toBe(2);
        expect(summary.heaviestBooks).toEqual([{ world: 'W', activations: 3, avgChars: 105 }]);
        expect(summary.heaviestEntries).toEqual([
            { world: 'W', uid: 1, comment: 'W#1', activations: 2, avgChars: 100, lastSeenTurn: 3 },
            { world: 'C', uid: 9, comment: 'C#9', activations: 1, avgChars: 40, lastSeenTurn: 3 },
        ]);
        expect(summary.alwaysActive.map((item) => item.uid)).toEqual([1]);
        expect(summary.neverActive.map((item) => `${item.world}:${item.uid}`)).toEqual(['G:5']);
        expect(summary.neverActive[0]).toMatchObject({ activations: 0, avgChars: 7 });
        expect(summary.avgTotalChars).toBe(125);
        expect(summary.avgCanonChars).toBe(20);
    });

    it('does not call anything "always active" after a single turn', () => {
        const doc = emptyJournal();
        addRecord(doc, record(1, [row('W', 1, 100)]), 10);
        const summary = summarize(doc, []);
        expect(summary.alwaysActive).toEqual([]);
        expect(summary.heaviestBooks[0]?.avgChars).toBe(100);
    });
});
