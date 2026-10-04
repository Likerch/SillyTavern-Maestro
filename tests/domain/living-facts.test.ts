import { describe, expect, it } from 'vitest';
import {
    addQuote,
    affectedBy,
    bumpStat,
    canonTypeOf,
    confirmReason,
    countConfirmed,
    countContradicted,
    emptyLivingDoc,
    englishContent,
    entryHash,
    entryInPrompt,
    factsFrom,
    invalidationPlan,
    isLivingType,
    isSeedContent,
    markDropped,
    mergeKeys,
    messageStamp,
    normalizeLivingDoc,
    recentlyConfirmed,
    relocate,
    rememberCommit,
    seedContent,
    typeLabel,
} from '../../src/domain/living-facts';
import type { FactData, LivingDocData } from '../../src/domain/living-facts';

function fact(patch: Partial<FactData>): FactData {
    return {
        id: 'f',
        name: 'Праздник Фонарей',
        type: 'tradition',
        quote: 'q',
        quotes: [],
        keys: ['Праздник Фонарей'],
        sourceMessage: 3,
        stamp: 's',
        status: 'provisional',
        survivedTurns: 0,
        createdAt: 1,
        origin: 'reply',
        ...patch,
    };
}

describe('living-facts: the document', () => {
    it('starts empty', () => {
        expect(emptyLivingDoc()).toEqual({
            drafts: [],
            facts: [],
            committed: [],
            extract: { upTo: -1, attemptAt: -1 },
            started: false,
            stats: { provisional: 0, droppedByUser: 0, confirmed: 0, contradictedAfterConfirm: 0 },
        });
    });

    it('repairs any stored shape', () => {
        expect(normalizeLivingDoc(null)).toEqual(emptyLivingDoc());
        expect(normalizeLivingDoc([])).toEqual(emptyLivingDoc());
        const doc = normalizeLivingDoc({
            drafts: [
                {
                    name: ' Ржавый якорь ',
                    type: 'place',
                    pattern: 'quoted',
                    quote: 'q',
                    count: 2,
                    descriptive: true,
                    variants: ['Ржавый якорь', 5],
                    sourceMessage: 4,
                    stamp: 's',
                    score: 3,
                    at: 9,
                    mergeInto: 'f1',
                },
                { name: 'X', sourceMessage: -1 },
                { name: '', sourceMessage: 1 },
                { name: 'Y', sourceMessage: 2, type: 'weird', pattern: 'weird', count: 'many' },
                'junk',
            ],
            facts: [
                {
                    id: 'f1',
                    uid: 7,
                    name: 'Праздник',
                    type: 'tradition',
                    quote: 'q',
                    quotes: ['a', 3],
                    text: 'Text.',
                    english: 'Fest',
                    keys: ['k'],
                    sourceMessage: 3,
                    stamp: 's',
                    status: 'active',
                    survivedTurns: 4,
                    confirmedBy: 'resurfaced',
                    confirmedAt: 10,
                    createdAt: 2,
                    entryHash: 'h',
                    conflict: 'c',
                    dispute: 'kept',
                    droppedBy: 'user',
                    origin: 'extract',
                    countedTurn: 5,
                    wasConfirmed: true,
                    wasContradicted: true,
                },
                { id: 'f2', name: 'Z', type: 'nope', status: 'nope', confirmedBy: 'nope', droppedBy: 'nope' },
                { id: 3, name: 'bad' },
                { name: 'no id' },
            ],
            committed: [{ index: 1, stamp: 'a' }, { index: 'x' }, 'junk', { index: 2 }],
            extract: { upTo: 5, attemptAt: 6, lastRun: 7, lastError: 'parse', added: 1, updated: 2 },
            started: true,
            stats: { provisional: 4, droppedByUser: -2, confirmed: 'x', contradictedAfterConfirm: 1.5 },
        });
        expect(doc.drafts).toEqual([
            {
                name: 'Ржавый якорь',
                type: 'place',
                pattern: 'quoted',
                quote: 'q',
                count: 2,
                descriptive: true,
                variants: ['Ржавый якорь'],
                sourceMessage: 4,
                stamp: 's',
                score: 3,
                mergeInto: 'f1',
                at: 9,
            },
            {
                name: 'Y',
                type: 'other',
                pattern: 'single',
                quote: '',
                count: 1,
                descriptive: false,
                variants: [],
                sourceMessage: 2,
                stamp: '',
                score: 0,
                at: 0,
            },
        ]);
        expect(doc.facts).toHaveLength(2);
        expect(doc.facts[0]).toMatchObject({
            uid: 7,
            quotes: ['a'],
            dispute: 'kept',
            droppedBy: 'user',
            countedTurn: 5,
            wasConfirmed: true,
            wasContradicted: true,
        });
        expect(doc.facts[1]).toMatchObject({
            type: 'other',
            status: 'provisional',
            confirmedBy: 'survived',
            droppedBy: 'missing',
            origin: 'reply',
            sourceMessage: -1,
        });
        expect(doc.committed).toEqual([
            { index: 1, stamp: 'a' },
            { index: 2, stamp: '' },
        ]);
        expect(doc.extract).toEqual({ upTo: 5, attemptAt: 6, lastRun: 7, lastError: 'parse', added: 1, updated: 2 });
        expect(doc.started).toBe(true);
        expect(doc.stats).toEqual({ provisional: 4, droppedByUser: 0, confirmed: 0, contradictedAfterConfirm: 1 });
        expect(normalizeLivingDoc({ extract: {} }).extract).toEqual({ upTo: -1, attemptAt: -1 });
    });

    it('checks living types', () => {
        expect(isLivingType('tradition')).toBe(true);
        expect(isLivingType('character')).toBe(false);
        expect(isLivingType(3)).toBe(false);
    });
});

describe('living-facts: commits and invalidation', () => {
    it('fingerprints messages by date, swipe and text', () => {
        const a = messageStamp({ send_date: 'd1', swipe_id: 0, mes: 'text' });
        expect(a).toBe(messageStamp({ send_date: 'd1', mes: 'text' }));
        expect(a).not.toBe(messageStamp({ send_date: 'd1', swipe_id: 1, mes: 'text' }));
        expect(a).not.toBe(messageStamp({ send_date: 'd1', swipe_id: 0, mes: 'other' }));
        expect(messageStamp(null)).toBe('');
    });

    it('records each committed reply once and keeps the recent ones', () => {
        const doc = emptyLivingDoc();
        expect(rememberCommit(doc, 3, 'a')).toBe(true);
        expect(rememberCommit(doc, 3, 'a')).toBe(false);
        expect(rememberCommit(doc, 3, 'b')).toBe(true);
        expect(doc.committed).toEqual([{ index: 3, stamp: 'b' }]);
        for (let i = 0; i < 5; i++) rememberCommit(doc, 10 + i, 'x', 3);
        expect(doc.committed.map((item) => item.index)).toEqual([12, 13, 14]);
    });

    it('counts the facts of one message that are not dropped', () => {
        const doc: LivingDocData = {
            ...emptyLivingDoc(),
            facts: [
                fact({ id: 'a' }),
                fact({ id: 'b', status: 'dropped' }),
                fact({ id: 'c', sourceMessage: 4 }),
                fact({ id: 'd', status: 'disputed' }),
            ],
        };
        expect(factsFrom(doc, 3).map((item) => item.id)).toEqual(['a', 'd']);
    });

    it('takes back the drafts and provisional facts of a swiped, edited or deleted message', () => {
        expect(affectedBy(5, 5, 'swiped')).toBe(true);
        expect(affectedBy(6, 5, 'edited')).toBe(false);
        expect(affectedBy(6, 5, 'deleted')).toBe(true);
        expect(affectedBy(4, 5, 'deleted')).toBe(false);
        const doc: LivingDocData = {
            ...emptyLivingDoc(),
            drafts: [{ ...draft(5) }, { ...draft(7) }],
            facts: [
                fact({ id: 'p5', sourceMessage: 5 }),
                fact({ id: 'a5', sourceMessage: 5, status: 'active' }),
                fact({ id: 'd5', sourceMessage: 5, status: 'disputed' }),
                fact({ id: 'p7', sourceMessage: 7 }),
            ],
        };
        const swipe = invalidationPlan(doc, 5, 'swiped');
        expect(swipe.drafts.map((item) => item.sourceMessage)).toEqual([5]);
        expect(swipe.provisional.map((item) => item.id)).toEqual(['p5']);
        expect(swipe.disputed.map((item) => item.id)).toEqual(['d5']);
        const deleted = invalidationPlan(doc, 6, 'deleted');
        expect(deleted.provisional.map((item) => item.id)).toEqual(['p7']);
        expect(deleted.drafts.map((item) => item.sourceMessage)).toEqual([7]);
    });

    it('marks facts dropped once', () => {
        const doc: LivingDocData = {
            ...emptyLivingDoc(),
            facts: [fact({ id: 'a', confirmedBy: 'survived' }), fact({ id: 'b' })],
        };
        expect(markDropped(doc, ['a', 'zzz'], 'user')).toBe(1);
        expect(markDropped(doc, ['a'], 'user')).toBe(0);
        expect(doc.facts[0]).toMatchObject({ status: 'dropped', droppedBy: 'user' });
        expect(doc.facts[0]?.confirmedBy).toBe('survived');
        expect(doc.facts[1]?.status).toBe('provisional');
    });
});

function draft(sourceMessage: number) {
    return {
        name: 'n',
        type: 'other' as const,
        pattern: 'single' as const,
        quote: '',
        count: 1,
        descriptive: false,
        variants: [],
        sourceMessage,
        stamp: '',
        score: 2,
        at: 0,
    };
}

describe('living-facts: statistics and deletions', () => {
    it('counts confirmations and later contradictions once per fact', () => {
        const doc: LivingDocData = { ...emptyLivingDoc(), facts: [fact({ id: 'a' })] };
        const target = doc.facts[0]!;
        bumpStat(doc, 'provisional');
        expect(countConfirmed(doc, target)).toBe(true);
        expect(countConfirmed(doc, target)).toBe(false);
        expect(countContradicted(doc, target)).toBe(true);
        expect(countContradicted(doc, target)).toBe(false);
        expect(doc.stats).toEqual({ provisional: 1, droppedByUser: 0, confirmed: 1, contradictedAfterConfirm: 1 });
    });

    it('finds a message again after a deletion by its fingerprint', () => {
        // Message 1 ('b') was deleted: 'c' moved from 2 to 1, 'd' from 3 to 2; the new length is 3.
        const stamps = ['a', 'c', 'd'];
        expect(relocate(stamps, 0, 'a', 3)).toBe(0);
        expect(relocate(stamps, 1, 'b', 3)).toBeNull();
        expect(relocate(stamps, 2, 'c', 3)).toBe(1);
        expect(relocate(stamps, 3, 'd', 3)).toBe(2);
        expect(relocate(stamps, 3, 'd', 3, 0)).toBeNull();
        expect(relocate(stamps, 1, '', 3)).toBe(1);
        expect(relocate(stamps, 3, '', 3)).toBeNull();
    });
});

describe('living-facts: confirmation rules', () => {
    const none = {
        userMentioned: false,
        userAccepted: false,
        resurfaced: false,
        survivedTurns: 0,
        surviveTurns: 10,
        clean: true,
    };

    it('needs a clean contradiction check on every path', () => {
        expect(confirmReason({ ...none, userAccepted: true, clean: false })).toBeNull();
        expect(confirmReason({ ...none, survivedTurns: 10, clean: false })).toBeNull();
    });

    it('names the reason, the user first', () => {
        expect(confirmReason({ ...none, userAccepted: true, userMentioned: true })).toBe('userAccepted');
        expect(confirmReason({ ...none, userMentioned: true, resurfaced: true })).toBe('userMentioned');
        expect(confirmReason({ ...none, resurfaced: true, survivedTurns: 10 })).toBe('resurfaced');
        expect(confirmReason({ ...none, survivedTurns: 10 })).toBe('survived');
        expect(confirmReason({ ...none, survivedTurns: 9 })).toBeNull();
        expect(confirmReason({ ...none, survivedTurns: 50, surviveTurns: 0 })).toBeNull();
    });

    it('tells whether the entry was in the prompt', () => {
        const activations = [
            { world: 'canon', uid: 1 },
            { world: 'canon', uid: 2, cut: true },
            { world: 'other', uid: 3 },
        ];
        expect(entryInPrompt(activations, 'canon', 1)).toBe(true);
        expect(entryInPrompt(activations, 'canon', 2)).toBe(false);
        expect(entryInPrompt(activations, 'canon', 3)).toBe(false);
    });
});

describe('living-facts: canon entries', () => {
    it('maps living types to canon entry types and labels', () => {
        expect(canonTypeOf('person')).toBe('character');
        expect(canonTypeOf('other')).toBe('note');
        expect(canonTypeOf('tradition')).toBe('tradition');
        expect(typeLabel('place')).toBe('Place');
        expect(typeLabel('other')).toBe('Note');
    });

    it('writes the provisional seed with the quotes', () => {
        const seed = seedContent({
            name: 'Праздник Фонарей',
            type: 'tradition',
            quote: '«Каждый год запускают фонари.»',
            quotes: ['', 'Второй раз.'],
        });
        expect(seed).toBe('[provisional] Tradition: Праздник Фонарей\n«Каждый год запускают фонари.»\n«Второй раз.»');
        expect(isSeedContent(seed)).toBe(true);
        expect(isSeedContent('Tradition: x')).toBe(false);
        expect(isSeedContent(5)).toBe(false);
        const long = seedContent({ name: 'X', type: 'other', quote: 'a'.repeat(800), quotes: ['b'.repeat(300)] });
        expect(long.split('\n')).toHaveLength(2);
    });

    it('writes the English content with both names', () => {
        expect(
            englishContent({
                name: 'Праздник Фонарей',
                type: 'tradition',
                english: 'Lantern Festival',
                text: ' Held yearly. ',
            }),
        ).toBe('Tradition: Lantern Festival (Праздник Фонарей)\nHeld yearly.');
        expect(englishContent({ name: 'Elmira', type: 'place', english: 'Elmira', text: 'A town.' })).toBe(
            'Place: Elmira\nA town.',
        );
        expect(englishContent({ name: 'Элмира', type: 'place', text: 'A town.' })).toBe('Place: Элмира\nA town.');
    });

    it('fingerprints content and keys', () => {
        const a = entryHash({ content: 'x', key: ['a', 1] });
        expect(a).toBe(entryHash({ content: 'x', key: ['a'] }));
        expect(a).not.toBe(entryHash({ content: 'y', key: ['a'] }));
        expect(entryHash({})).toBe(entryHash({ content: 5, key: 'a' }));
    });

    it('merges keys without duplicates, up to a limit', () => {
        expect(mergeKeys(['A', 'b'], ['a', ' c ', '', 'B', 3 as unknown as string])).toEqual(['A', 'b', 'c']);
        expect(mergeKeys(['a'], ['b', 'c'], 2)).toEqual(['a', 'b']);
    });

    it('adds new quotes only', () => {
        const target = { quote: '«Первая.»', quotes: [] as string[] };
        expect(addQuote(target, 'Первая.')).toBe(false);
        expect(addQuote(target, '  ')).toBe(false);
        expect(addQuote(target, 'Вторая.')).toBe(true);
        expect(addQuote(target, '«Вторая.»')).toBe(false);
        for (const quote of ['3', '4', '5']) addQuote(target, quote);
        expect(addQuote(target, '6')).toBe(false);
        expect(target.quotes).toEqual(['Вторая.', '3', '4', '5']);
    });

    it('lists confirmed facts, newest first', () => {
        const doc: LivingDocData = {
            ...emptyLivingDoc(),
            facts: [
                fact({ id: 'a', status: 'active', confirmedAt: 5 }),
                fact({ id: 'b', status: 'active', createdAt: 9 }),
                fact({ id: 'c', status: 'provisional' }),
            ],
        };
        expect(recentlyConfirmed(doc).map((item) => item.id)).toEqual(['b', 'a']);
        expect(recentlyConfirmed(doc, 1).map((item) => item.id)).toEqual(['b']);
    });
});
