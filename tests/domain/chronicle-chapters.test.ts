import { describe, expect, it } from 'vitest';
import {
    chapterCap,
    chapterContent,
    chapterFields,
    chapterId,
    chapterInfoOf,
    chapterKeys,
    chapterShare,
    chapterTitle,
    countTerms,
    distinctiveWords,
    eventChars,
    eventLine,
    eventsFromField,
    groupMemories,
    memoryHash,
    mergedKeys,
    mergedMeta,
    planArchive,
    planMerges,
    readChronicleMeta,
    readTracked,
    termKeys,
    textLanguage,
    trackMemories,
    wordKeys,
} from '../../src/domain/chronicle-chapters';
import type {
    ChapterInfo,
    ChapterMemory,
    ChapterTerm,
    MemorySnapshot,
    TrackedMemory,
} from '../../src/domain/chronicle-chapters';

/* ------------------------------------------------------------------ fixtures */

const alice: ChapterTerm = { id: 'character:alice', name: 'Alice', keys: ['Alice', 'Алиса', 'Алисы'] };
const bob: ChapterTerm = { id: 'character:bob', name: 'Bob', keys: ['Bob', 'Боб'] };
const hero: ChapterTerm = { id: 'character:sera', name: 'Sera', keys: ['Sera', 'Сера'], main: true };
const persona: ChapterTerm = { id: 'persona:alex', name: 'Alex', keys: ['Alex', 'Алекс'], main: true };
const tavern: ChapterTerm = { id: 'place:tavern', name: 'Tavern', keys: ['Tavern', 'таверна', 'таверне'] };
const forest: ChapterTerm = { id: 'place:forest', name: 'Forest', keys: ['Forest', 'лес'] };
const sword: ChapterTerm = { id: 'item:sword', name: 'Sword', keys: ['Sword', 'меч'] };
const ring: ChapterTerm = { id: 'item:ring', name: 'Ring', keys: ['Ring', 'кольцо'] };

function memory(index: number, text: string, extra: Partial<ChapterMemory> = {}): ChapterMemory {
    return { index, text, participants: [], place: null, items: [], ...extra };
}

function snap(index: number, extra: Partial<MemorySnapshot> = {}): MemorySnapshot {
    return {
        index,
        date: `d${index}`,
        memory: `memory ${index}`,
        remember: true,
        include: 'long',
        lagging: false,
        ...extra,
    };
}

function info(uid: number, extra: Partial<ChapterInfo> = {}): ChapterInfo {
    return {
        uid,
        id: `ch-${uid}`,
        title: `Chapter ${uid}`,
        name: `Title ${uid}`,
        status: 'active',
        chars: 200,
        from: uid * 10,
        to: uid * 10 + 4,
        indexes: [uid * 10, uid * 10 + 4],
        participants: ['character:alice'],
        primary: 'character:alice',
        place: 'place:tavern',
        characters: ['Alice'],
        events: [`event ${uid}`],
        keys: ['Alice'],
        secondary: ['Tavern'],
        ...extra,
    };
}

/* ------------------------------------------------------------------ tracking */

describe('chronicle tracking', () => {
    it('hashes memory texts stably, ignoring outer whitespace', () => {
        expect(memoryHash(' Alice cut her hair. ')).toBe(memoryHash('Alice cut her hair.'));
        expect(memoryHash('a')).not.toBe(memoryHash('b'));
    });

    it('repairs stored records', () => {
        expect(readTracked(null)).toEqual({});
        expect(readTracked([1])).toEqual({});
        const raw = {
            '3': { date: 'd3', hash: 'h', state: 'fallen', long: true, chapter: 'ch-1', fallenAt: 12, extra: 1 },
            '4': { date: 'd4', hash: 'h', state: 'weird' },
            x: { date: 'd', hash: 'h', state: 'tracked' },
            '5': { date: 5, hash: 'h', state: 'tracked' },
            '6': 'junk',
            '7': { date: 'd7', hash: 'h', state: 'tracked', chapter: '', fallenAt: 'no' },
        };
        expect(readTracked(raw)).toEqual({
            '3': { date: 'd3', hash: 'h', state: 'fallen', long: true, chapter: 'ch-1', fallenAt: 12 },
            '7': { date: 'd7', hash: 'h', state: 'tracked' },
        });
    });

    it('follows a remembered memory from the long-term memory to the fall-out', () => {
        let result = trackMemories({}, [snap(2), snap(5, { include: 'short' })], 10);
        expect(result.changed).toBe(true);
        expect(result.fallen).toEqual([]);
        expect(result.tracked['2']).toMatchObject({ date: 'd2', state: 'tracked', long: true });
        result = trackMemories(result.tracked, [snap(2), snap(5, { include: 'short' })], 11);
        expect(result.changed).toBe(false);
        result = trackMemories(result.tracked, [snap(2, { include: null }), snap(5, { include: 'short' })], 14);
        expect(result.fallen).toEqual([2]);
        expect(result.tracked['2']).toMatchObject({ state: 'fallen', fallenAt: 14 });
        // Back in the budget (the user raised it): tracked again.
        result = trackMemories(result.tracked, [snap(2, { include: 'long' })], 15);
        expect(result.tracked['2']?.state).toBe('tracked');
        expect(result.tracked['2']?.fallenAt).toBeUndefined();
        expect(result.fallen).toEqual([]);
    });

    it('needs proof that the flags were computed past the memory', () => {
        // Never seen long, nothing newer has a slot: Qvink may simply not have refreshed yet.
        let result = trackMemories({}, [snap(2, { include: null })], 10);
        expect(result.fallen).toEqual([]);
        expect(result.tracked['2']?.state).toBe('tracked');
        // A newer message has a slot: the budget walk passed this one and gave it nothing.
        result = trackMemories({}, [snap(2, { include: null }), snap(6, { include: 'short', remember: false })], 10);
        expect(result.fallen).toEqual([2]);
        // Lagging (the raw message is still in the prompt): not fallen.
        result = trackMemories({}, [snap(2, { include: null, lagging: true }), snap(6, { include: 'long' })], 10);
        expect(result.fallen).toEqual([]);
    });

    it('ignores memories that are not remembered or empty, keeps finished records', () => {
        const previous: Record<string, TrackedMemory> = {
            '1': { date: 'd1', hash: memoryHash('memory 1'), state: 'chaptered', chapter: 'ch-a' },
            '2': { date: 'd2', hash: memoryHash('memory 2'), state: 'tracked', long: true },
        };
        const result = trackMemories(
            previous,
            [snap(1, { remember: false }), snap(2, { remember: false }), snap(3, { memory: '  ' })],
            10,
        );
        expect(result.tracked).toEqual({ '1': previous['1'] });
    });

    it('moves a record with its message when indexes shift, and starts over for another message', () => {
        const previous: Record<string, TrackedMemory> = {
            '4': { date: 'd-old', hash: memoryHash('Alice met Bob.'), state: 'chaptered', chapter: 'ch-a' },
        };
        // A message before it was deleted: the same message (date + text) is now at index 3.
        const moved = trackMemories(
            previous,
            [snap(3, { date: 'd-old', memory: 'Alice met Bob.', include: null }), snap(9, { include: 'long' })],
            10,
        );
        expect(moved.tracked['3']).toEqual(previous['4']);
        expect(moved.tracked['4']).toBeUndefined();
        expect(moved.fallen).toEqual([]);
        // Another message took index 4: a fresh record.
        const other = trackMemories(previous, [snap(4, { date: 'd-new', memory: 'Other.' })], 10);
        expect(other.tracked['4']).toMatchObject({ date: 'd-new', state: 'tracked' });
    });

    it('updates the hash of a tracked memory and keeps the hash of a chaptered one', () => {
        const previous: Record<string, TrackedMemory> = {
            '1': { date: 'd1', hash: 'old', state: 'tracked' },
            '2': { date: 'd2', hash: 'old', state: 'chaptered' },
        };
        const result = trackMemories(previous, [snap(1), snap(2)], 5);
        expect(result.tracked['1']?.hash).toBe(memoryHash('memory 1'));
        expect(result.tracked['2']?.hash).toBe('old');
    });
});

/* ------------------------------------------------------------------ grouping */

describe('chronicle grouping', () => {
    it('counts the characters of an event line', () => {
        expect(eventChars(' abc ')).toBe(6);
    });

    it('groups consecutive memories about the same characteristic participant', () => {
        const groups = groupMemories(
            [
                memory(10, 'Alice met Bob.', { participants: [alice, bob] }),
                memory(12, 'Alice gave Sera a sword.', { participants: [alice, hero] }),
                memory(14, 'A storm hit the forest.', { participants: [], place: forest }),
            ],
            { maxChars: 1000 },
        );
        expect(groups.map((group) => group.memories.map((item) => item.index))).toEqual([[10, 12], [14]]);
        expect(groups[0]?.chars).toBe(eventChars('Alice met Bob.') + eventChars('Alice gave Sera a sword.'));
        expect(groups.every((group) => group.ready)).toBe(true);
    });

    it('splits at another place, a long gap, the size and count limits', () => {
        const a = (index: number, extra: Partial<ChapterMemory> = {}) =>
            memory(index, `Alice ${index}`, { participants: [alice], place: tavern, ...extra });
        const ids = (groups: ReturnType<typeof groupMemories>) =>
            groups.map((group) => group.memories.map((item) => item.index));
        expect(ids(groupMemories([a(1), a(2, { place: forest })], { maxChars: 1000 }))).toEqual([[1], [2]]);
        expect(ids(groupMemories([a(1), a(80)], { maxChars: 1000, maxGap: 40 }))).toEqual([[1], [80]]);
        expect(ids(groupMemories([a(1), a(2)], { maxChars: eventChars('Alice 1') + 2 }))).toEqual([[1], [2]]);
        expect(ids(groupMemories([a(1), a(2), a(3)], { maxChars: 1000, maxMemories: 2 }))).toEqual([[1, 2], [3]]);
        // An unknown place does not split.
        expect(ids(groupMemories([a(1), a(2, { place: null })], { maxChars: 1000 }))).toEqual([[1, 2]]);
    });

    it('joins main-hero-only memories, and others only at the same known place', () => {
        const ids = (list: ChapterMemory[]) =>
            groupMemories(list, { maxChars: 1000 }).map((group) => group.memories.map((item) => item.index));
        expect(
            ids([
                memory(1, 'Sera slept.', { participants: [hero] }),
                memory(2, 'Alex cooked.', { participants: [persona] }),
            ]),
        ).toEqual([[1, 2]]);
        expect(
            ids([
                memory(1, 'Sera slept in the tavern.', { participants: [hero], place: tavern }),
                memory(2, 'Bob sang in the tavern.', { participants: [bob], place: tavern }),
            ]),
        ).toEqual([[1, 2]]);
        expect(
            ids([memory(1, 'Alice left.', { participants: [alice] }), memory(2, 'Bob came.', { participants: [bob] })]),
        ).toEqual([[1], [2]]);
        expect(
            ids([memory(1, 'Sera slept.', { participants: [hero] }), memory(2, 'Bob came.', { participants: [bob] })]),
        ).toEqual([[1], [2]]);
    });

    it('keeps the newest small group waiting for a while', () => {
        const list = [
            memory(1, 'Alice left.', { participants: [alice], fallenAt: 100 }),
            memory(2, 'Bob came.', { participants: [bob], fallenAt: 100 }),
        ];
        let groups = groupMemories(list, { maxChars: 1000, chatLength: 105 });
        expect(groups.map((group) => group.ready)).toEqual([true, false]);
        groups = groupMemories(list, { maxChars: 1000, chatLength: 120 });
        expect(groups.map((group) => group.ready)).toEqual([true, true]);
        // Big enough: ready at once.
        groups = groupMemories(list, { maxChars: 1000, chatLength: 105, smallChars: 5 });
        expect(groups.map((group) => group.ready)).toEqual([true, true]);
        // Without fallenAt the chat length itself counts as «just now».
        groups = groupMemories([memory(1, 'Bob came.', { participants: [bob] })], { maxChars: 1000, chatLength: 5 });
        expect(groups[0]?.ready).toBe(false);
    });

    it('drops empty memories', () => {
        expect(groupMemories([memory(1, '  ')], { maxChars: 10 })).toEqual([]);
    });
});

/* ------------------------------------------------------------------ keys */

describe('chronicle keys', () => {
    it('counts terms by memories, then by first appearance', () => {
        expect(countTerms([[bob, alice, alice], [alice], [bob]]).map((term) => term.id)).toEqual([
            'character:bob',
            'character:alice',
        ]);
        expect(countTerms([[bob], [alice, bob], [alice]]).map((term) => term.id)).toEqual([
            'character:bob',
            'character:alice',
        ]);
    });

    it('builds term and word keys', () => {
        expect(termKeys({ id: 'x', name: 'Ann', keys: [] })).toEqual(['Ann']);
        expect(termKeys({ id: 'x', name: 'Ann', keys: ['Ann', ' Ann ', 'A', '{{char}}', 'Анна'] })).toEqual([
            'Ann',
            'Анна',
        ]);
        expect(wordKeys('Excalibur')).toEqual(['Excalibur']);
        expect(wordKeys('Ривенделл')[0]).toBe('Ривенделл');
        expect(wordKeys('Ривенделл')[1]).toBe('/(?:^|[^\\p{L}\\p{N}_])Рив[её]нд[её]лл/iu');
        expect(wordKeys('  ')).toEqual([]);
    });

    it('pairs a characteristic participant with the place, items and other participants', () => {
        const keys = chapterKeys([
            memory(1, 'x', { participants: [alice, hero], place: tavern, items: [sword] }),
            memory(2, 'y', { participants: [alice, bob] }),
        ]);
        expect(keys).toEqual({
            primary: ['Alice', 'Алиса', 'Алисы'],
            secondary: ['Tavern', 'таверна', 'таверне', 'Sword', 'меч', 'Bob', 'Боб'],
            primaryId: 'character:alice',
            basis: 'place',
        });
        // The main hero is not among the secondary keys while something characteristic is there.
        expect(keys?.secondary).not.toContain('Sera');
    });

    it('names the basis of the secondary keys', () => {
        expect(chapterKeys([memory(1, 'x', { participants: [alice], items: [sword] })])?.basis).toBe('item');
        expect(chapterKeys([memory(1, 'x', { participants: [alice, bob] })])).toMatchObject({
            primary: ['Alice', 'Алиса', 'Алисы'],
            secondary: ['Bob', 'Боб'],
            basis: 'participant',
        });
    });

    it('falls back to the event words, then (behind a characteristic primary) to the main heroes', () => {
        expect(chapterKeys([memory(1, 'x', { participants: [alice, hero] })], { words: ['Excalibur'] })).toMatchObject({
            primaryId: 'character:alice',
            secondary: ['Excalibur'],
            basis: 'words',
        });
        expect(chapterKeys([memory(1, 'x', { participants: [alice, hero, persona] })])).toMatchObject({
            primaryId: 'character:alice',
            secondary: ['Sera', 'Сера', 'Alex', 'Алекс'],
            basis: 'mainHero',
        });
        expect(chapterKeys([memory(1, 'x', { participants: [alice] })])).toBeNull();
    });

    it('never makes a main hero the only key or pairs two main heroes', () => {
        expect(chapterKeys([memory(1, 'x', { participants: [hero, persona] })])).toBeNull();
        expect(chapterKeys([memory(1, 'x', { participants: [hero] })])).toBeNull();
        const withPlace = chapterKeys([memory(1, 'x', { participants: [hero, persona], place: forest })]);
        expect(withPlace).toMatchObject({ primaryId: 'character:sera', secondary: ['Forest', 'лес'], basis: 'place' });
        expect(withPlace?.secondary).not.toContain('Alex');
        expect(
            chapterKeys([memory(1, 'x', { participants: [hero] })], { words: ['Драконье', 'Excalibur'] }),
        ).toMatchObject({ primaryId: 'character:sera', basis: 'words' });
        expect(chapterKeys([memory(1, 'x', { participants: [hero], items: [ring] })])?.basis).toBe('item');
    });

    it('uses the place or an item as the primary key when nobody takes part', () => {
        expect(chapterKeys([memory(1, 'x', { place: tavern, items: [ring] })])).toMatchObject({
            primaryId: 'place:tavern',
            secondary: ['Ring', 'кольцо'],
            basis: 'item',
        });
        expect(chapterKeys([memory(1, 'x', { place: tavern })], { words: ['Excalibur'] })?.basis).toBe('words');
        expect(chapterKeys([memory(1, 'x', { place: tavern })])).toBeNull();
        expect(chapterKeys([memory(1, 'x', { items: [ring, sword] })])).toMatchObject({
            primaryId: 'item:ring',
            secondary: ['Sword', 'меч'],
        });
        expect(chapterKeys([memory(1, 'x', { items: [ring] })], { words: ['Mordor'] })?.secondary).toEqual(['Mordor']);
        expect(chapterKeys([memory(1, 'x', { items: [ring] })])).toBeNull();
        expect(chapterKeys([memory(1, 'x')])).toBeNull();
    });

    it('keeps secondary keys apart from the primary ones and within the limits', () => {
        const twin: ChapterTerm = { id: 'place:alice', name: 'alice', keys: ['ALICE', 'Alice Hall'] };
        expect(chapterKeys([memory(1, 'x', { participants: [alice], place: twin })])?.secondary).toEqual([
            'Alice Hall',
        ]);
        const limited = chapterKeys([memory(1, 'x', { participants: [alice], place: tavern })], {
            maxPrimary: 1,
            maxSecondary: 2,
        });
        expect(limited).toMatchObject({ primary: ['Alice'], secondary: ['Tavern', 'таверна'] });
        const noKeys: ChapterTerm = { id: 'character:x', name: 'X', keys: ['{{user}}'] };
        expect(chapterKeys([memory(1, 'x', { participants: [noKeys], place: tavern })])).toBeNull();
    });
});

/* ------------------------------------------------------------------ words and language */

describe('chronicle words', () => {
    it('finds proper nouns that are neither known names nor sentence starters', () => {
        const texts = [
            'Alice found Excalibur in the Silver Lake. Excalibur glowed.',
            'Later, McDonald visited. «Mordor» was quiet; Rivendell waited.',
        ];
        expect(distinctiveWords(texts, ['Alice', 'Silver Lake'])).toEqual(['Excalibur', 'Rivendell']);
        expect(distinctiveWords(['Алиса нашла Экскалибур у Ривенделла.'], ['Алиса'])).toEqual([
            'Экскалибур',
            'Ривенделла',
        ]);
    });

    it('orders by frequency and respects the limit', () => {
        const texts = ['Then Mordor fell.', 'Orcs fled Mordor and Gondor.'];
        expect(distinctiveWords(texts, [])).toEqual(['Mordor', 'Gondor']);
        expect(distinctiveWords(texts, [], 1)).toEqual(['Mordor']);
        expect(distinctiveWords(texts, [], -1)).toEqual([]);
        expect(distinctiveWords(['the Dragon’s lair'], [])).toEqual(['Dragon’s']);
        expect(distinctiveWords(['the Anglo- treaty'], [])).toEqual(['Anglo']);
    });

    it('tells the language of a text by its letters', () => {
        expect(textLanguage('Alice met Bob')).toBe('en');
        expect(textLanguage('Алиса встретила Bob')).toBe('ru');
        expect(textLanguage('123 …')).toBeNull();
    });
});

/* ------------------------------------------------------------------ title and content */

describe('chronicle content', () => {
    it('titles a chapter by its participants and place', () => {
        expect(chapterTitle(['Alice', 'Bob', 'Alice'], 'Tavern', 1, 4)).toBe('Alice, Bob — Tavern');
        expect(chapterTitle(['A', 'B', 'C', 'D'], null, 1, 4)).toBe('A, B, C');
        expect(chapterTitle([], 'Tavern', 1, 4)).toBe('Tavern');
        expect(chapterTitle([], null, 1, 4)).toBe('Messages 1–4');
        expect(chapterTitle([], null, 7, 7)).toBe('Message 7');
    });

    it('writes the typed «chapter» content', () => {
        expect(eventLine('  a\n b  ')).toBe('a b');
        expect(chapterFields('T', ['One.', ' ', 'Two.'], ['Alice', 'Alice', 'Bob'])).toEqual({
            name: 'T',
            events: '- One.\n- Two.',
            characters: 'Alice, Bob',
        });
        expect(chapterFields('T', ['One.'], [])).toEqual({ name: 'T', events: 'One.', characters: '' });
        expect(chapterFields('T', [], [])).toEqual({ name: 'T', events: '', characters: '' });
        expect(chapterContent('Alice — Tavern', ['Alice met Bob.', 'Bob left.'], ['Alice', 'Bob'])).toBe(
            'Chapter: Alice — Tavern\nKey events:\n- Alice met Bob.\n- Bob left.\nCharacters: Alice, Bob',
        );
        expect(chapterContent('T', ['Only.'], [])).toBe('Chapter: T\nKey events: Only.');
    });

    it('reads event lines back', () => {
        expect(eventsFromField('- One.\n• Two.\n\n* Three.\nFour.')).toEqual(['One.', 'Two.', 'Three.', 'Four.']);
        expect(eventsFromField(5)).toEqual([]);
    });

    it('makes stable chapter ids', () => {
        expect(chapterId([1, 2], ['a', 'b'])).toBe(chapterId([1, 2], ['a', 'b']));
        expect(chapterId([1, 2], ['a', 'b'])).not.toBe(chapterId([1, 3], ['a', 'b']));
        expect(chapterId([1], ['a'])).toMatch(/^ch-[0-9a-z]+$/);
    });
});

/* ------------------------------------------------------------------ stored chapters */

describe('chronicle chapters in the canon', () => {
    const chronicle = {
        id: 'ch-1',
        from: 3,
        to: 9,
        indexes: [3, 9, 'x'],
        participants: ['character:alice', 5],
        primary: 'character:alice',
        place: 'place:tavern',
        characters: ['Alice'],
    };

    it('reads the chronicle meta', () => {
        expect(readChronicleMeta(chronicle)).toEqual({
            id: 'ch-1',
            from: 3,
            to: 9,
            indexes: [3, 9],
            participants: ['character:alice'],
            primary: 'character:alice',
            place: 'place:tavern',
            characters: ['Alice'],
        });
        expect(readChronicleMeta({ ...chronicle, primary: '', place: 7, indexes: null })).toMatchObject({
            primary: null,
            place: null,
            indexes: [],
        });
        expect(readChronicleMeta({ ...chronicle, id: '' })).toBeNull();
        expect(readChronicleMeta({ ...chronicle, to: 'x' })).toBeNull();
        expect(readChronicleMeta(null)).toBeNull();
    });

    it('turns a canon item into a chapter', () => {
        const item = {
            uid: 4,
            meta: {
                kind: 'addition',
                status: 'archived',
                origin: 'chronicle',
                type: 'chapter',
                typeFields: { name: 'Alice — Tavern', events: '- One.\n- Two.' },
                chronicle,
            },
            entry: { comment: ' Летопись: Alice ', content: 'Chapter: x', key: ['Alice', 3], keysecondary: ['Tavern'] },
        };
        expect(chapterInfoOf(item)).toMatchObject({
            uid: 4,
            id: 'ch-1',
            title: 'Летопись: Alice',
            name: 'Alice — Tavern',
            status: 'archived',
            chars: 'Chapter: x'.length,
            events: ['One.', 'Two.'],
            keys: ['Alice'],
            secondary: ['Tavern'],
        });
        expect(chapterInfoOf({ ...item, entry: {} })).toMatchObject({ title: 'Alice — Tavern', chars: 0, keys: [] });
        expect(
            chapterInfoOf({ ...item, meta: { ...item.meta, typeFields: null, status: 1 }, entry: {} }),
        ).toMatchObject({ title: '#4', name: '', status: 'active', events: [] });
        expect(chapterInfoOf({ ...item, meta: { ...item.meta, origin: 'user' } })).toBeNull();
        expect(chapterInfoOf({ ...item, meta: { ...item.meta, type: 'event' } })).toBeNull();
        expect(chapterInfoOf({ ...item, meta: { ...item.meta, chronicle: null } })).toBeNull();
        expect(chapterInfoOf({ ...item, meta: null })).toBeNull();
    });
});

/* ------------------------------------------------------------------ budget and merging */

describe('chronicle budget', () => {
    it('caps a chapter at a quarter of the canon budget', () => {
        expect(chapterCap(8000, 1200)).toBe(1200);
        expect(chapterCap(2000, 1200)).toBe(500);
        expect(chapterCap(0, 1200)).toBe(1200);
        expect(chapterCap(100, 1200)).toBe(100);
        expect(chapterCap(0, Number.NaN)).toBe(100);
        expect(chapterShare(8000)).toBe(4000);
        expect(chapterShare(0)).toBe(Number.POSITIVE_INFINITY);
    });

    it('archives the oldest active chapters until the rest fit, never the newest', () => {
        const list = [info(1, { chars: 300 }), info(3, { chars: 300 }), info(2, { chars: 300, status: 'archived' })];
        expect(planArchive(list, 1000)).toEqual([]);
        expect(planArchive(list, 400)).toEqual([1]);
        expect(planArchive(list, 10)).toEqual([1]);
        expect(planArchive([info(1, { chars: 5000 })], 10)).toEqual([]);
    });
});

describe('chronicle merging', () => {
    it('merges neighbouring small chapters about the same participant and place', () => {
        const plans = planMerges([info(3), info(1), info(2)], { maxChars: 1200 });
        expect(plans.map((plan) => [plan.keep.uid, plan.drop.uid])).toEqual([[1, 2]]);
    });

    it('leaves big, archived, distant or different chapters apart', () => {
        const pair = (b: Partial<ChapterInfo>, a: Partial<ChapterInfo> = {}, maxChars = 1200) =>
            planMerges([info(1, a), info(2, b)], { maxChars }).length;
        expect(pair({ chars: 500 })).toBe(0);
        expect(pair({ status: 'archived' })).toBe(0);
        expect(pair({ place: 'place:forest' })).toBe(0);
        expect(pair({ primary: 'character:bob', participants: ['character:bob'] })).toBe(0);
        expect(pair({ from: 500, to: 510 })).toBe(0);
        expect(pair({}, {}, 300)).toBe(0);
        // Another primary key but the same people: one story.
        expect(
            pair(
                { primary: 'character:bob', participants: ['character:bob', 'character:alice'] },
                { participants: ['character:alice', 'character:bob'] },
            ),
        ).toBe(1);
        expect(pair({ primary: null, participants: ['character:alice'] }, { primary: null })).toBe(1);
    });

    it('joins keys and meta of merged chapters', () => {
        expect(
            mergedKeys(
                { keys: ['Alice', 'Алиса'], secondary: ['Tavern'], primary: 'a' },
                { keys: ['Bob'], secondary: ['таверна', 'tavern', 'Alice'], primary: 'b' },
            ),
        ).toEqual({ primary: ['Alice', 'Алиса'], secondary: ['Tavern', 'таверна', 'Bob'] });
        expect(
            mergedKeys(
                { keys: ['Alice'], secondary: ['Tavern'], primary: 'a' },
                { keys: ['Alice'], secondary: ['Ring'], primary: 'a' },
            ),
        ).toEqual({ primary: ['Alice'], secondary: ['Tavern', 'Ring'] });
        const keep = info(1, { indexes: [10, 14], participants: ['a'], characters: ['A'], primary: null, place: null });
        const drop = info(2, { indexes: [20, 24, 14], participants: ['b', 'a'], characters: ['B'] });
        expect(mergedMeta(keep, drop)).toEqual({
            id: 'ch-1',
            from: 10,
            to: 24,
            indexes: [10, 14, 20, 24],
            participants: ['a', 'b'],
            primary: 'character:alice',
            place: 'place:tavern',
            characters: ['A', 'B'],
        });
    });
});
