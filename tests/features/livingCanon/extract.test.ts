import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { livingCanonModule } from '../../../src/features/livingCanon';
import type { LivingCanonService } from '../../../src/features/livingCanon';
import { canonItem, contradiction, createLivingTestApp, flush, proposalsOf, startModule, turn } from './helpers';
import type { LivingTestApp } from './helpers';

const FESTIVAL =
    'Вечером начинался Праздник Фонарей — каждый год жители запускают бумажные фонари над рекой. Элдрин улыбнулся.';
/** Nothing capitalised: the quick search finds nothing here, the model does. */
const QUIET = 'Старики шептались, что мост через реку уже триста лет охраняют люди в серых плащах.';

let env: LivingTestApp;
let living: LivingCanonService;
let stop: () => Promise<void>;

beforeEach(async () => {
    env = createLivingTestApp();
    env.world.add('Элдрин');
    const started = await startModule(env, livingCanonModule);
    living = started.living;
    stop = () => started.stop();
});

afterEach(async () => {
    await stop();
});

function settings(): { maxPerTurn: number; surviveTurns: number; extractEvery: number } {
    return env.settings.module('livingCanon');
}

async function runExtraction(): Promise<void> {
    await env.tasks.runLatest('living.extract');
    await flush(living);
}

describe('M26: when the batch extraction runs', () => {
    it('queues itself every N messages, not before', async () => {
        settings().extractEvery = 4;
        await turn(env, living, 'Тихий вечер.');
        expect(env.tasks.queued).toEqual([]);
        await turn(env, living, 'Тихая ночь.');
        await turn(env, living, 'Тихое утро.');
        expect(env.tasks.queued).toEqual([
            expect.objectContaining({
                kind: 'living.extract',
                dedupeKey: 'extract',
                payload: { from: 0, to: 4, manual: false },
            }),
        ]);
    });

    it('does not queue itself when the interval is 0 or no model is available', async () => {
        settings().extractEvery = 0;
        for (let i = 0; i < 4; i++) await turn(env, living, 'Тихий вечер.');
        env.llm.available = false;
        settings().extractEvery = 2;
        for (let i = 0; i < 3; i++) await turn(env, living, 'Тихий вечер.');
        expect(env.tasks.queued).toEqual([]);
    });

    it('can be queued by hand', async () => {
        await turn(env, living, 'Тихий вечер.');
        await living.extractNow();
        expect(env.tasks.queued).toEqual([
            expect.objectContaining({ kind: 'living.extract', payload: { from: 0, to: 0, manual: true } }),
        ]);
    });

    it('records an unavailable model and a failed request without throwing', async () => {
        await turn(env, living, FESTIVAL);
        await living.extractNow();
        env.llm.available = false;
        await runExtraction();
        expect(living.extractState()).toMatchObject({ lastError: 'unavailable', upTo: -1 });
        env.llm.available = true;
        env.llm.result = { ok: false, error: 'timeout' };
        await runExtraction();
        expect(living.extractState()?.lastError).toBe('timeout');
        env.llm.result = { ok: false, refusal: true, error: 'refusal' };
        await runExtraction();
        expect(living.extractState()?.lastError).toBe('refusal');
    });
});

describe('M26: what the batch extraction writes', () => {
    it('gives provisional facts an English text and keeps the Russian keys', async () => {
        await turn(env, living, FESTIVAL);
        const uid = living.provisional()[0]!.uid!;
        const keys = env.canon.item(uid)?.entry.key as string[];
        env.llm.result = {
            ok: true,
            data: {
                provisional: [
                    {
                        uid,
                        name: 'Праздник Фонарей',
                        english: 'Lantern Festival',
                        type: 'tradition',
                        text: 'Every year the townsfolk release paper lanterns over the river.',
                        duplicateOf: '',
                    },
                ],
                facts: [],
            },
        };
        await living.extractNow();
        await runExtraction();
        const [request] = env.llm.requests;
        expect(request).toMatchObject({ task: 'living.extract', schema: { name: 'living_canon' } });
        expect(request?.messages[1]?.content).toContain(`uid ${uid}: Праздник Фонарей (tradition)`);
        const item = env.canon.item(uid);
        expect(item?.entry.content).toBe(
            'Tradition: Lantern Festival (Праздник Фонарей)\nEvery year the townsfolk release paper lanterns over the river.',
        );
        expect(item?.entry.key).toEqual([...keys, 'Lantern Festival']);
        expect(item?.meta.status).toBe('provisional');
        expect(living.provisional()[0]?.text).toBe('Every year the townsfolk release paper lanterns over the river.');
        expect(living.extractState()).toMatchObject({ added: 0, updated: 1 });
        expect(living.extractState()?.lastError).toBeUndefined();
    });

    it('does not overwrite an entry the user edited', async () => {
        await turn(env, living, FESTIVAL);
        const uid = living.provisional()[0]!.uid!;
        env.canon.edit(uid, { content: 'My own words.' });
        env.llm.result = {
            ok: true,
            data: {
                provisional: [
                    {
                        uid,
                        name: '',
                        english: '',
                        type: 'tradition',
                        text: 'An English text for the lantern festival.',
                        duplicateOf: '',
                    },
                ],
                facts: [],
            },
        };
        await living.extractNow();
        await runExtraction();
        expect(env.llm.requests[0]?.messages[1]?.content).toContain('<provisional>\n(none)');
        expect(env.canon.item(uid)?.entry.content).toBe('My own words.');
    });

    it('adds the facts the quick search missed, with checked quotes and the K limit', async () => {
        settings().maxPerTurn = 1;
        const index = await turn(env, living, QUIET);
        expect(env.canon.living()).toEqual([]);
        env.llm.result = {
            ok: true,
            data: {
                provisional: [],
                facts: [
                    {
                        name: 'Мост через реку',
                        english: 'River Bridge',
                        type: 'place',
                        text: 'An old bridge over the river, guarded for three hundred years.',
                        quote: QUIET,
                        message: index,
                    },
                    {
                        name: 'Серые плащи',
                        english: 'Grey Cloaks',
                        type: 'faction',
                        text: 'Guards in grey cloaks who have watched the bridge for three centuries.',
                        quote: QUIET,
                        message: index,
                    },
                    {
                        name: 'Дракон',
                        english: 'Dragon',
                        type: 'person',
                        text: 'A dragon that does not exist in the story at all.',
                        quote: 'Дракон спал.',
                        message: index,
                    },
                ],
            },
        };
        await living.extractNow();
        await runExtraction();
        expect(env.canon.living().map((item) => item.entry.comment)).toEqual(['Мост через реку']);
        const [item] = env.canon.living();
        expect(item?.entry.content).toBe(
            'Place: River Bridge (Мост через реку)\nAn old bridge over the river, guarded for three hundred years.',
        );
        expect(item?.entry.key).toEqual(expect.arrayContaining(['Мост через реку', 'River Bridge']));
        expect(living.records()[0]).toMatchObject({ origin: 'extract', sourceMessage: index, status: 'provisional' });
        expect(living.extractState()).toMatchObject({ added: 1, updated: 0, upTo: index });
    });

    it('sends contradicting new facts to the Inbox', async () => {
        env.canon.items.push(canonItem(0, 'Мост', 'The bridge was built last year.'));
        env.contradictions.rule = (input) =>
            input.against.some((item) => item.label === 'Мост')
                ? [contradiction('Мост', 'триста лет', 'last year')]
                : [];
        const index = await turn(env, living, QUIET);
        env.llm.result = {
            ok: true,
            data: {
                provisional: [],
                facts: [
                    {
                        name: 'Серые плащи',
                        english: 'Grey Cloaks',
                        type: 'faction',
                        text: 'Guards in grey cloaks who have watched the bridge (Мост) for three centuries.',
                        quote: QUIET,
                        message: index,
                    },
                ],
            },
        };
        await living.extractNow();
        await runExtraction();
        expect(env.canon.living()).toEqual([]);
        const [card] = proposalsOf(env, 'living.disputed');
        expect(card?.title).toBe('Disputed invented fact: Серые плащи');
        // Inside the extraction task the full check runs inline (a queued one would wait for this very task).
        expect(env.contradictions.checkOptions).toEqual([expect.objectContaining({ inline: true })]);
        expect(living.facts()).toEqual([expect.objectContaining({ name: 'Серые плащи', status: 'disputed' })]);
    });

    it('removes a provisional fact the model calls a duplicate of known lore', async () => {
        await turn(env, living, FESTIVAL);
        const uid = living.provisional()[0]!.uid!;
        env.llm.result = {
            ok: true,
            data: {
                provisional: [
                    { uid, name: '', english: '', type: 'tradition', text: '', duplicateOf: 'Lantern Night' },
                ],
                facts: [],
            },
        };
        await living.extractNow();
        await runExtraction();
        expect(env.canon.item(uid)).toBeUndefined();
        expect(living.records()[0]).toMatchObject({ status: 'dropped', droppedBy: 'duplicate' });
    });

    it('survives a malformed answer: nothing changes, the error is recorded', async () => {
        await turn(env, living, FESTIVAL);
        const uid = living.provisional()[0]!.uid!;
        const before = structuredClone(env.canon.item(uid));
        env.llm.result = { ok: true, text: '{"provisional": [oops', data: '{"provisional": [oops' };
        await living.extractNow();
        await expect(env.tasks.runLatest('living.extract')).resolves.toBeUndefined();
        await flush(living);
        expect(env.canon.item(uid)).toEqual(before);
        expect(living.extractState()).toMatchObject({ lastError: 'parse', upTo: -1 });
        expect(living.extractState()?.attemptAt).toBeGreaterThanOrEqual(0);
    });

    it('ignores a task of another chat and finishes quickly with nothing to do', async () => {
        await env.app.tasks.enqueue({ kind: 'living.extract', payload: { from: 0, to: 0 }, chatId: 'other' });
        const runner = env.tasks.runners.get('living.extract')!;
        await runner(
            { from: 0, to: 0 },
            {
                kind: 'living.extract',
                payload: {},
                chatId: 'other',
                id: 'x',
                state: 'running',
                attempts: 1,
                createdAt: 0,
            },
        );
        expect(env.llm.requests).toEqual([]);
        await living.extractNow();
        await runExtraction();
        expect(env.llm.requests).toEqual([]);
        expect(living.extractState()).toMatchObject({ added: 0, updated: 0 });
        expect(proposalsOf(env, 'living.fact')).toEqual([]);
    });
});
