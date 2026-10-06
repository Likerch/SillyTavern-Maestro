import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { chapterId, memoryHash } from '../../../src/domain/chronicle-chapters';
import type { CanonItem } from '../../../src/features/canon/api';
import {
    AND_ANY,
    ARCHIVE_KIND,
    CHAPTER_KIND,
    CHAPTER_ORDER,
    MERGE_KIND,
} from '../../../src/features/chronicle/chapters';
import type { ChapterPayload } from '../../../src/features/chronicle/chapters';
import { createChronicleTestApp, createServices, entity, place, reply, storedDoc, userMessage } from './helpers';
import type { ChronicleTestApp, QvinkRecord, Services } from './helpers';

type Dict = Record<string, unknown>;

let t: ChronicleTestApp;
let s: Services;

const alice = entity('character', 'Alice', { forms: ['Алиса', 'Алисы'] });
const bob = entity('character', 'Bob');
const sera = entity('character', 'Sera', { sources: [{ kind: 'card', ref: 'sera.png', label: 'Sera' }] });
const alex = entity('persona', 'Alex');
const ring = entity('item', 'Ring');

/** Pushes replies with Qvink records (null: a user message); returns their indexes. */
function push(...records: (QvinkRecord | null)[]): number[] {
    return records.map((record) => {
        t.mock.chat.push(record === null ? userMessage() : reply('…', record));
        return t.mock.chat.length - 1;
    });
}

const fallen = (memory: string): QvinkRecord => ({ memory, remember: true, include: null });
const longTerm = (memory: string): QvinkRecord => ({ memory, remember: true, include: 'long' });
const shortTerm = (memory: string): QvinkRecord => ({ memory, include: 'short' });

function grow(count: number): void {
    for (let i = 0; i < count; i++) t.mock.chat.push(userMessage());
}

/** The fall-out is noticed, 20 messages pass (the newest small group waits that long), the chronicle runs again. */
async function chronicle(): Promise<void> {
    await s.chapters.scan();
    grow(20);
    await s.chapters.scan();
}

async function memories(): Promise<Record<string, Dict>> {
    return ((await storedDoc(t)).memories ?? {}) as Record<string, Dict>;
}

function chapterItems(): CanonItem[] {
    return t.canon.chapters();
}

beforeEach(() => {
    t = createChronicleTestApp();
    t.world.entitiesList = [alice, bob, sera, alex, ring];
    t.places.placesList = [place('tavern', 'Tavern', [[0, null]], ['таверна', 'таверне'])];
    s = createServices(t);
});

afterEach(() => {
    s.stop();
});

describe('M9 chronicle: falling out of the long-term memory', () => {
    it('notices remembered memories Qvink gave no slot, and waits a little with a small newest group', async () => {
        push(null, fallen('Alice met Bob in the tavern.'), null, fallen('Alice gave Bob a ring.'), shortTerm('Later.'));
        await s.chapters.scan();
        expect(await memories()).toMatchObject({
            '1': { state: 'fallen', fallenAt: 5 },
            '3': { state: 'fallen', fallenAt: 5 },
        });
        expect(chapterItems()).toEqual([]);
        grow(20);
        await s.chapters.scan();
        expect(chapterItems()).toHaveLength(1);
        expect(await memories()).toMatchObject({ '1': { state: 'chaptered' }, '3': { state: 'chaptered' } });
    });

    it('does not chapter memories still in the budget, unmarked or with stale flags', async () => {
        push(longTerm('Alice met Bob.'), { memory: 'Plain.', include: null }, fallen('Lonely, never seen long.'));
        grow(30);
        await s.chapters.scan();
        expect(await memories()).toEqual({
            '0': expect.objectContaining({ state: 'tracked', long: true }),
            '2': expect.objectContaining({ state: 'tracked' }),
        });
        expect(chapterItems()).toEqual([]);
    });

    it('makes a chapter with AND keys: a characteristic participant AND place / item / other participant', async () => {
        push(null, fallen('Alice met Bob in the tavern.'), null, fallen('Alice gave Bob a Ring.'), shortTerm('x'));
        await chronicle();
        const [item] = chapterItems();
        expect(item?.entry).toMatchObject({
            comment: 'Chronicle: Alice, Bob — Tavern (#1–3)',
            content:
                'Chapter: Alice, Bob — Tavern\nKey events:\n- Alice met Bob in the tavern.\n- Alice gave Bob a Ring.\nCharacters: Alice, Bob',
            key: ['Alice', 'Алиса', 'Алисы'],
            keysecondary: ['Tavern', 'таверна', 'таверне', 'Ring', 'Bob'],
            selective: true,
            selectiveLogic: AND_ANY,
            order: CHAPTER_ORDER,
        });
        expect(item?.meta).toMatchObject({
            kind: 'addition',
            status: 'active',
            origin: 'chronicle',
            type: 'chapter',
            typeFields: { name: 'Alice, Bob — Tavern', characters: 'Alice, Bob' },
            chronicle: {
                from: 1,
                to: 3,
                indexes: [1, 3],
                participants: ['character:alice', 'character:bob'],
                primary: 'character:alice',
                place: 'place:tavern',
            },
        });
        const record = t.journal.records.find((entry) => entry.kind === CHAPTER_KIND);
        expect(record).toMatchObject({
            module: 'M9',
            summary: 'New chronicle chapter: Alice, Bob — Tavern (messages #1–3)',
        });
        const proposal = t.autonomy.proposals.find((entry) => entry.kind === CHAPTER_KIND)!;
        expect(proposal.description?.split('\n')).toEqual([
            "The memories of messages #1–3 no longer fit in Qvink's long-term memory. I will keep them as a chronicle chapter in the chat canon, so the model recalls them when the story comes back to them.",
            'What it holds:',
            '— Alice met Bob in the tavern.',
            '— Alice gave Bob a Ring.',
        ]);
        expect(proposal.details).toContain('Keys: Alice, Алиса, Алисы AND one of: Tavern');
        expect(proposal.appliedNotice?.text).toBe(
            'Added a chapter to the chronicle: Alice, Bob — Tavern (messages #1–3).',
        );
        expect(proposal.appliedNotice?.groupText?.(2)).toBe('Added 2 chapters to the chronicle');
        expect(record?.changes[0]).toMatchObject({ target: 'm9.chapter', before: null });
        expect(await s.chapters.chapters()).toEqual([
            {
                uid: item?.uid,
                title: 'Chronicle: Alice, Bob — Tavern (#1–3)',
                from: 1,
                to: 3,
                keys: ['Alice', 'Алиса', 'Алисы'],
                secondary: ['Tavern', 'таверна', 'таверне', 'Ring', 'Bob'],
                chars: String(item?.entry.content).length,
                status: 'active',
            },
        ]);
    });

    it('never keys a chapter on a main hero alone', async () => {
        t.places.placesList = [];
        push(fallen('Sera slept while Alex kept watch.'), shortTerm('x'));
        await chronicle();
        expect(chapterItems()).toEqual([]);
        expect(await memories()).toMatchObject({ '0': { state: 'nokeys' } });
        expect(t.autonomy.proposals).toHaveLength(0);
    });

    it('pairs a main hero with the place when nobody else takes part', async () => {
        push(fallen('Sera slept while Alex kept watch.'), shortTerm('x'));
        await chronicle();
        expect(chapterItems()[0]?.entry).toMatchObject({
            key: ['Sera'],
            keysecondary: ['Tavern', 'таверна', 'таверне'],
        });
    });

    it('splits groups by participants and keeps the chapter cap (canon budget)', async () => {
        t.canon.limit = 400; // chapter cap: 100 characters
        t.places.placesList = [];
        const long = (name: string, n: number) => `${name} and Sera did a long thing number ${n} in the square.`;
        push(fallen(long('Alice', 1)), fallen(long('Alice', 2)), fallen('Bob sang a song for Sera.'), shortTerm('x'));
        await chronicle();
        const items = chapterItems();
        expect(items.map((item) => (item.meta as unknown as Dict).chronicle)).toEqual([
            expect.objectContaining({ indexes: [0] }),
            expect.objectContaining({ indexes: [1] }),
            expect.objectContaining({ indexes: [2] }),
        ]);
        for (const item of items)
            expect(
                String((item.meta as unknown as Dict & { typeFields: Dict }).typeFields.events).length,
            ).toBeLessThanOrEqual(100);
    });

    it('archives the oldest chapters when the active ones pass half of the canon budget', async () => {
        t.canon.limit = 1000; // share 500 characters, cap 250
        const npc = ['Carl', 'Dana', 'Erik'].map((name) => entity('character', name));
        t.world.entitiesList = [...npc, sera, alex];
        t.places.placesList = [];
        const story = (name: string) =>
            `${name} told Sera a long story about the war in the north, the burned villages, the lost banners and the long winter that followed the fall of the old king.`;
        push(fallen(story('Carl')), fallen(story('Dana')), fallen(story('Erik')), shortTerm('x'));
        await chronicle();
        const chapters = await s.chapters.chapters();
        expect(chapters).toHaveLength(3);
        const active = chapters.filter((chapter) => chapter.status === 'active');
        expect(active.reduce((sum, chapter) => sum + chapter.chars, 0)).toBeLessThanOrEqual(500);
        expect(chapters.map((chapter) => chapter.status)).toEqual(['archived', 'active', 'active']);
        expect(t.journal.records.filter((record) => record.kind === ARCHIVE_KIND)).toHaveLength(1);
        const archive = t.autonomy.proposals.find((entry) => entry.kind === ARCHIVE_KIND)!;
        expect(archive.title).toBe('To the archive: 1 old chronicle chapter');
        expect(archive.description).toContain('I will archive the oldest: «Carl, Sera» (message #0).');
        expect(archive.appliedNotice?.text).toBe(
            'Archived 1 old chronicle chapter: it comes back when the story mentions it.',
        );
        expect(t.canon.calls).toContain(`status:${chapters[0]?.uid}:archived`);
        // Undo brings it back.
        const record = t.journal.records.find((entry) => entry.kind === ARCHIVE_KIND)!;
        expect(await t.journal.undo(record.id)).toBe(true);
        expect((await s.chapters.chapters())[0]?.status).toBe('active');
    });

    it('works only in the leader tab and with Qvink and the canon on', async () => {
        push(fallen('Alice met Bob in the tavern.'), shortTerm('x'));
        grow(25);
        t.leader.value = false;
        await s.chapters.scan();
        t.leader.value = true;
        t.qvink.chat = false;
        await s.chapters.scan();
        t.qvink.chat = true;
        t.modules.apis.delete('canon');
        await s.chapters.scan();
        expect(await memories()).toEqual({});
        t.modules.expose('canon', t.canon);
        t.slice().chapters = false;
        await s.chapters.scan();
        expect(await memories()).toEqual({});
        t.slice().chapters = true;
        await chronicle();
        expect(chapterItems()).toHaveLength(1);
    });

    it('adds Russian forms to the keys in a Russian chat', async () => {
        t.canon.forms = { Bob: ['Боб', 'Боба'] };
        t.mock.chat.push(reply('Алиса встретила Боба в таверне.', fallen('Alice met Bob in the tavern.')));
        t.mock.chat.push(reply('Привет.', shortTerm('x')));
        await s.chapters.scan();
        for (let i = 0; i < 25; i++) t.mock.chat.push(userMessage('Пошли дальше.'));
        await s.chapters.scan();
        expect(chapterItems()[0]?.entry.keysecondary).toEqual(['Tavern', 'таверна', 'таверне', 'Bob', 'Боб', 'Боба']);
    });
});

describe('M9 chronicle: autonomy, undo and the Inbox', () => {
    async function oneChapter(): Promise<void> {
        push(fallen('Alice met Bob in the tavern.'), shortTerm('x'));
        await chronicle();
    }

    it('undo removes the chapter and its memories are not chaptered again', async () => {
        await oneChapter();
        const record = t.journal.records.find((entry) => entry.kind === CHAPTER_KIND)!;
        expect(await t.journal.undo(record.id)).toBe(true);
        expect(chapterItems()).toEqual([]);
        expect(await memories()).toMatchObject({ '0': { state: 'dismissed' } });
        await s.chapters.scan();
        expect(chapterItems()).toEqual([]);
    });

    it('a queued proposal marks the memories and is not proposed twice; the Inbox applies or dismisses it', async () => {
        t.autonomy.levels.set(CHAPTER_KIND, 'inbox');
        await oneChapter();
        expect(t.autonomy.proposals).toHaveLength(1);
        expect(await memories()).toMatchObject({ '0': { state: 'proposed' } });
        await s.chapters.scan();
        expect(t.autonomy.proposals).toHaveLength(1);
        const payload = JSON.parse(JSON.stringify(t.autonomy.proposals[0]?.payload)) as ChapterPayload;
        expect(await t.inbox.valid.get(CHAPTER_KIND)?.(payload)).toBe(true);
        await t.inbox.appliers.get(CHAPTER_KIND)?.(payload);
        expect(chapterItems()).toHaveLength(1);
        expect(await memories()).toMatchObject({ '0': { state: 'chaptered' } });
        // Applied twice (another tab): still one chapter; and no longer valid.
        await t.inbox.appliers.get(CHAPTER_KIND)?.(payload);
        expect(chapterItems()).toHaveLength(1);
        expect(await t.inbox.valid.get(CHAPTER_KIND)?.(payload)).toBe(false);
        await t.inbox.rejecters.get(CHAPTER_KIND)?.(payload);
        expect(await memories()).toMatchObject({ '0': { state: 'dismissed' } });
        await expect(t.inbox.appliers.get(CHAPTER_KIND)?.({})).rejects.toThrow();
    });

    it('a level «off» proposes nothing', async () => {
        t.autonomy.levels.set(CHAPTER_KIND, 'off');
        await oneChapter();
        expect(t.autonomy.proposals).toHaveLength(0);
        expect(await memories()).toMatchObject({ '0': { state: 'fallen' } });
    });

    it('a stale proposal is skipped when its message changed', async () => {
        t.autonomy.levels.set(CHAPTER_KIND, 'inbox');
        await oneChapter();
        const payload = t.autonomy.proposals[0]?.payload as ChapterPayload;
        (t.mock.chat[0] as STChatMessage).send_date = 'changed';
        expect(await t.inbox.valid.get(CHAPTER_KIND)?.(payload)).toBe(false);
    });
});

describe('M9 chronicle: merging small chapters', () => {
    async function seedChapter(
        from: number,
        to: number,
        events: string[],
        primary = 'character:alice',
    ): Promise<number> {
        return t.canon.put({
            entry: {
                comment: `Chronicle: Alice — Tavern (#${from}–${to})`,
                content: `Chapter: Alice — Tavern\nKey events:\n${events.map((e) => `- ${e}`).join('\n')}`,
                key: ['Alice'],
                keysecondary: ['Tavern'],
            },
            meta: {
                kind: 'addition',
                status: 'active',
                origin: 'chronicle',
                type: 'chapter',
                typeFields: { name: 'Alice — Tavern', events: events.map((e) => `- ${e}`).join('\n') },
                chronicle: {
                    id: `ch-${from}`,
                    from,
                    to,
                    indexes: [from, to],
                    participants: [primary],
                    primary,
                    place: 'place:tavern',
                    characters: ['Alice'],
                },
            } as unknown as CanonItem['meta'],
        });
    }

    it('merges neighbours about the same participant and place, with undo', async () => {
        const indexes = push(null, null, null, null, null, null, fallen('Alice sang.'), null, fallen('Alice danced.'));
        push(shortTerm('x'));
        await s.store.mutate((doc) => {
            for (const [position, text] of [
                [6, 'Alice sang.'],
                [8, 'Alice danced.'],
            ] as const) {
                const index = indexes[position] as number;
                doc.memories[String(index)] = {
                    date: String(t.mock.chat[index]?.send_date),
                    hash: memoryHash(text),
                    state: 'chaptered',
                    chapter: 'ch-6',
                };
            }
            return true;
        });
        const first = await seedChapter(2, 4, ['Alice came.']);
        const second = await seedChapter(6, 8, ['Alice sang.']);
        const other = await seedChapter(10, 12, ['Bob left.'], 'character:bob');
        await s.chapters.scan();
        const merged = t.canon.items.find((item) => item.uid === first)!;
        expect(t.canon.items.map((item) => item.uid).sort()).toEqual([first, other].sort());
        expect(merged.entry).toMatchObject({
            comment: 'Chronicle: Alice — Tavern (#2–8)',
            content: 'Chapter: Alice — Tavern\nKey events:\n- Alice came.\n- Alice sang.\nCharacters: Alice',
            key: ['Alice'],
            keysecondary: ['Tavern'],
        });
        expect((merged.meta as unknown as Dict).chronicle).toMatchObject({
            id: 'ch-2',
            from: 2,
            to: 8,
            indexes: [2, 4, 6, 8],
        });
        expect(await memories()).toMatchObject({ '6': { chapter: 'ch-2' }, '8': { chapter: 'ch-2' } });
        const record = t.journal.records.find((entry) => entry.kind === MERGE_KIND)!;
        expect(record.summary).toBe(
            'Merging chronicle chapters: «Alice — Tavern» (messages #2–4) and «Alice — Tavern» (messages #6–8)',
        );
        expect(await t.journal.undo(record.id)).toBe(true);
        expect(t.canon.items.find((item) => item.uid === first)?.entry.comment).toBe(
            'Chronicle: Alice — Tavern (#2–4)',
        );
        expect(t.canon.items.find((item) => item.uid === second)?.entry.comment).toBe(
            'Chronicle: Alice — Tavern (#6–8)',
        );
        expect(await memories()).toMatchObject({ '6': { chapter: 'ch-6' }, '8': { chapter: 'ch-6' } });
    });

    it('proposes a merge only once when it waits in the Inbox, and checks it is still valid', async () => {
        t.autonomy.levels.set(MERGE_KIND, 'inbox');
        await seedChapter(2, 4, ['Alice came.']);
        await seedChapter(6, 8, ['Alice sang.']);
        await s.chapters.scan();
        await s.chapters.scan();
        const merges = t.autonomy.proposals.filter((proposal) => proposal.kind === MERGE_KIND);
        expect(merges).toHaveLength(1);
        const payload = JSON.parse(JSON.stringify(merges[0]?.payload)) as unknown;
        expect(await t.inbox.valid.get(MERGE_KIND)?.(payload)).toBe(true);
        await t.inbox.appliers.get(MERGE_KIND)?.(payload);
        expect(chapterItems()).toHaveLength(1);
        expect(await t.inbox.valid.get(MERGE_KIND)?.(payload)).toBe(false);
    });
});

describe('M9 chronicle: bookkeeping and scheduling', () => {
    afterEach(() => {
        vi.useRealTimers();
    });

    it('only marks the memories when their chapter exists already', async () => {
        push(fallen('Alice met Bob in the tavern.'), shortTerm('x'));
        await s.chapters.scan();
        grow(20);
        const id = chapterId([0], [String(t.mock.chat[0]?.send_date)]);
        await t.canon.put({
            entry: { comment: 'made elsewhere', content: 'Chapter: x', key: ['Alice'], keysecondary: ['Tavern'] },
            meta: {
                kind: 'addition',
                status: 'active',
                origin: 'chronicle',
                type: 'chapter',
                chronicle: { id, from: 0, to: 0, indexes: [0], participants: [], primary: null, place: null },
            } as never,
        });
        await s.chapters.scan();
        expect(chapterItems()).toHaveLength(1);
        expect(t.autonomy.proposals).toHaveLength(0);
        expect(await memories()).toMatchObject({ '0': { state: 'chaptered', chapter: id } });
    });

    it('runs after a committed turn, waits for the generation and for Qvink to finish summarising', async () => {
        vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
        const scan = vi.spyOn(s.chapters, 'scan').mockResolvedValue();
        t.turn.generation = { type: 'normal', dryRun: false, quiet: false };
        await t.app.bus.emit('turn:committed', { messageIndex: 0 });
        await vi.advanceTimersByTimeAsync(2500);
        expect(scan).not.toHaveBeenCalled();
        t.turn.generation = null;
        t.qvink.busy = true;
        await t.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await vi.advanceTimersByTimeAsync(600);
        expect(scan).not.toHaveBeenCalled();
        t.qvink.busy = false;
        await vi.advanceTimersByTimeAsync(5000);
        expect(scan).toHaveBeenCalledTimes(1);
        // Other tabs do not run it; the new leader does.
        t.leader.value = false;
        await t.app.bus.emit('reply:ready', { messageIndex: 0, type: 'normal' });
        await vi.advanceTimersByTimeAsync(4000);
        expect(scan).toHaveBeenCalledTimes(1);
        t.leader.value = true;
        for (const listener of t.leader.listeners) listener(true);
        await vi.advanceTimersByTimeAsync(600);
        expect(scan).toHaveBeenCalledTimes(2);
        await t.app.bus.emit('chat:changed', { chatId: 'chat-1' });
        s.chapters.start();
        await vi.advanceTimersByTimeAsync(3000);
        expect(scan).toHaveBeenCalledTimes(3);
    });

    it('logs a failed pass instead of throwing', async () => {
        t.canon.list = async () => {
            throw new Error('boom');
        };
        push(fallen('Alice met Bob in the tavern.'), shortTerm('x'));
        await expect(s.chapters.scan()).resolves.toBeUndefined();
        expect(await s.chapters.chapters()).toEqual([]);
    });
});
