// Plan-2 §9 «Офелия из другого чата»: a namesake of another story (a CK repo archive, an NPC passport NAI Studio once
// saved into the card, DES Workshop data) stays out of this chat's Офелия until the user answers one Inbox question.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WORLD_DOC } from '../../../src/features/world/store';
import { worldModule } from '../../../src/features/world';
import type { WorldModelApi } from '../../../src/features/world/api';
import { createChatStore } from '../../../src/core/chat-store';
import { createFileStore } from '../../../src/core/files';
import { stripMessageOf } from '../../../src/ui/views/inbox-strip';
import { createTestLogger } from '../../helpers/core-host';
import type { Dict, WorldEnv } from './helpers';
import { addCard, createWorldEnv, FakeNaiApi, startModule, trackerMessage, userMessage, wi } from './helpers';

let env: WorldEnv;
let world: WorldModelApi;
let stop: () => Promise<void>;
let nai: FakeNaiApi;

const ARCHIVE = 'ck:Архив персонажей#офелия';
const PASSPORT = 'nai:Elizabeth.png#npc1';
const WORKSHOP = 'des:офелия';

async function tick(ms = 10): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

async function start(): Promise<void> {
    const started = await startModule(env, worldModule);
    stop = () => started.stop();
    world = env.modules.api<WorldModelApi>('world')!;
}

async function worldDoc(): Promise<Dict> {
    return env.app.chat.get<Dict>(WORLD_DOC, () => ({}));
}

function ofelia() {
    return world.resolve('Офелия')!;
}

function sourceKinds(): string[] {
    return ofelia().sources.map((source) => source.kind);
}

function questions() {
    return env.inbox.cards.filter((card) => card.kind === 'world.sameAs');
}

beforeEach(async () => {
    vi.useFakeTimers();
    env = createWorldEnv();
    nai = new FakeNaiApi();
    nai.features = ['excludePassport'];
    nai.byAvatar['Elizabeth.png'] = [
        { id: 'p1', kind: 'character', name: '', aliases: [] },
        // NAI Studio saved the passport of an NPC of another chat into the card.
        { id: 'npc1', kind: 'character', name: 'Офелия', aliases: [], origin: 'auto-des' },
    ];
    env.neighbours.naiApi = nai;
    const index = addCard(env, 'Elizabeth');
    (env.mock.context.characters[index] as STCharacter).description = 'Хозяйка таверны «Дракон».';
    (env.mock.context as unknown as Dict).name1 = 'Алекс';
    env.neighbours.desKnown = ['Офелия'];
    env.neighbours.desSettings = { characterAppearance: { Офелия: 'red hair, green dress' } };
    env.neighbours.ckRepos = ['Архив персонажей'];
    env.books.book('Архив персонажей', [
        wi(5, {
            comment: 'Офелия Character Archive',
            key: ['Офелия'],
            content: '<BunnymoTags><Name:Офелия>, <SPECIES:HUMAN></BunnymoTags>',
        }),
        wi(6, {
            comment: 'Странник Character Archive',
            key: ['Странник'],
            content: '<BunnymoTags><Name:Странник>, <SPECIES:ELF></BunnymoTags>',
        }),
    ]);
    env.mock.chat.push(
        userMessage('Заходим в таверну.'),
        trackerMessage('В таверну вошла Офелия.', [{ name: 'Офелия' }]),
        userMessage('Здравствуй, Офелия!'),
    );
    await start();
});

afterEach(async () => {
    await stop();
    vi.useRealTimers();
});

describe('a namesake of another story', () => {
    it('stays out of this chat’s Офелия and is asked about once, in plain words', async () => {
        world.entities();
        await tick();
        expect(sourceKinds()).toEqual(['des.character']);
        expect(world.identity!(ofelia().id)?.pending.map((source) => source.key)).toEqual([
            ARCHIVE,
            PASSPORT,
            WORKSHOP,
        ]);
        expect(questions()).toHaveLength(1);
        const card = questions()[0]!;
        expect(card.title).toBe('Офелия here — the same character as in the book «Архив персонажей»?');
        expect(card.description).toBe(
            'The name «Офелия» is known from other stories already: character and way of speaking from the sheet ' +
                'in «Архив персонажей»; looks and outfits from the card «Elizabeth»; portrait and description from ' +
                'DES. Answer «The same», and all that helps here too. «Another one» — everything here is its own, ' +
                'the old stays out. Until you answer, the old is not used here.',
        );
        // Books, entry numbers and passport ids are details, not the question.
        expect(card.proposal?.details).toContain('npc1');
        expect(card.proposal).toMatchObject({ acceptLabel: 'The same', rejectLabel: 'Another one' });
        expect(card.payload).toMatchObject({
            name: 'Офелия',
            entityName: 'Офелия',
            keys: [ARCHIVE, PASSPORT, WORKSHOP],
        });
        expect(card.changes[0]).toMatchObject({ target: 'world-identity', before: null });
        expect(card.changes[0]?.after).toBe(
            'CarrotKernel archive «Офелия Character Archive» in «Архив персонажей»; NAI Studio passport npc1 (Elizabeth.png); DES Workshop: Офелия',
        );
        // The strip under the message where the name first appears asks it (the Inbox's strip items), no badge.
        expect(card.payload).toMatchObject({ messageIndex: 1 });
        expect(stripMessageOf(card)).toBe(1);
        expect(env.ui.badges).toEqual([]);
        expect((await worldDoc()).asked).toEqual({ 'being\u0000офелия': [ARCHIVE, PASSPORT, WORKSHOP] });

        await world.rebuild();
        await tick();
        expect(questions()).toHaveLength(1);
    });

    it('«The same» binds every listed source; undoing it asks again', async () => {
        world.entities();
        await tick();
        const card = questions()[0]!;
        expect(await env.inbox.accept(card.id)).toBe(true);
        expect(sourceKinds()).toEqual(['des.character', 'nai.passport', 'des.workshop', 'ck.archive']);
        expect((await worldDoc()).bound).toEqual([ARCHIVE, PASSPORT, WORKSHOP]);
        expect(world.identity!(ofelia().id)?.pending).toEqual([]);
        // The real Inbox journals an accepted card with its changes.
        const id = await env.journal.record({
            module: card.module,
            kind: card.kind,
            summary: card.title,
            changes: card.changes,
        });
        expect(await env.journal.undo(id)).toBe(true);
        expect(sourceKinds()).toEqual(['des.character']);
        expect((await worldDoc()).bound).toEqual([]);
        await tick();
        expect(questions()).toHaveLength(1);
    });

    it('«Another one» keeps them out for good and switches the card passport off in this chat; undo turns it back', async () => {
        world.entities();
        await tick();
        const card = questions()[0]!;
        const onReject = env.inbox.appliers.get('world.sameAs')!.args[1] as (payload: unknown) => Promise<void>;
        await env.inbox.reject(card.id);
        await onReject(card.payload);
        expect((await worldDoc()).apart).toEqual([ARCHIVE, PASSPORT, WORKSHOP]);
        expect(nai.exclusions).toEqual([['npc1', true]]);
        const record = env.journal.records.at(-1)!;
        expect(record.kind).toBe('world.apart');
        expect(record.summary).toBe(
            'Noted: Офелия here is another character, not the one in the book «Архив персонажей»',
        );
        expect(record.changes.map((change) => change.target)).toEqual(['world-identity', 'world-nai-excluded']);
        await world.rebuild();
        await tick();
        expect(sourceKinds()).toEqual(['des.character']);
        expect(questions()).toHaveLength(0);
        // The excluded passport is invisible now, but still part of the decision.
        expect(world.identity!(ofelia().id)?.apart.map((source) => source.key)).toEqual([ARCHIVE, PASSPORT, WORKSHOP]);

        expect(await env.journal.undo(record.id)).toBe(true);
        expect(nai.exclusions.at(-1)).toEqual(['npc1', false]);
        expect((await worldDoc()).apart).toEqual([]);
        await world.rebuild();
        await tick();
        expect(questions()).toHaveLength(1);
    });

    it('without NAI Studio’s exclusion «Another one» still keeps the sources out', async () => {
        nai.features = [];
        world.entities();
        await tick();
        const card = questions()[0]!;
        const onReject = env.inbox.appliers.get('world.sameAs')!.args[1] as (payload: unknown) => Promise<void>;
        await onReject(card.payload);
        expect(nai.exclusions).toEqual([]);
        expect(env.journal.records.at(-1)?.changes.map((change) => change.target)).toEqual(['world-identity']);
        expect(sourceKinds()).toEqual(['des.character']);
    });

    it('the card’s own names join without a question', async () => {
        (env.mock.context.characters[0] as STCharacter).description = 'Хозяйка таверны и её сестра Офелия.';
        await world.rebuild();
        await tick();
        expect(questions()).toHaveLength(0);
        expect(sourceKinds()).toEqual(['des.character', 'nai.passport', 'des.workshop', 'ck.archive']);
        expect(world.identity!(ofelia().id)).toMatchObject({ ofCard: true, pending: [], apart: [] });
    });

    it('a name only the messages use is asked about; a name nobody uses is not', async () => {
        env.mock.chat.push(userMessage('Ты видел Странника?'));
        await world.rebuild();
        await tick();
        expect(questions().map((card) => card.title)).toEqual([
            'Офелия here — the same character as in the book «Архив персонажей»?',
            'Странник here — the same character as in the book «Архив персонажей»?',
        ]);
        expect(world.resolve('Странник')).toBeUndefined();
        expect(questions().find((card) => card.title.startsWith('Странник'))?.payload).toMatchObject({
            messageIndex: 3,
        });
    });

    it('other tabs do not ask', async () => {
        env.leader.value = false;
        world.entities();
        await tick();
        expect(questions()).toHaveLength(0);
        expect(sourceKinds()).toEqual(['des.character']);
        expect(env.ui.badges).toEqual([]);
    });

    it('the dossier changes the answer later, journaled', async () => {
        world.entities();
        await tick();
        await world.sameAs!(ofelia().id);
        expect(sourceKinds()).toEqual(['des.character', 'nai.passport', 'des.workshop', 'ck.archive']);
        expect(env.journal.records.at(-1)?.kind).toBe('world.sameAs');
        await world.different!(ofelia().id);
        expect(sourceKinds()).toEqual(['des.character']);
        expect(nai.exclusions).toEqual([['npc1', true]]);
        expect(world.foreignRefs!()).toEqual(['Архив персонажей#5', 'Архив персонажей#6']);
        await world.sameAs!(ofelia().id);
        expect(nai.exclusions.at(-1)).toEqual(['npc1', false]);
        expect(sourceKinds()).toEqual(['des.character', 'nai.passport', 'des.workshop', 'ck.archive']);
        const last = env.journal.records.at(-1)!;
        expect(last.changes.map((change) => change.target)).toEqual(['world-identity', 'world-nai-excluded']);
        expect(await env.journal.undo(last.id)).toBe(true);
        expect(nai.exclusions.at(-1)).toEqual(['npc1', true]);
        expect((await worldDoc()).apart).toEqual([ARCHIVE, PASSPORT, WORKSHOP]);
        await expect(world.sameAs!('character:nobody')).rejects.toThrow();
    });

    it('NAI Studio’s own buttons answer about the card passport too; Maestro’s own switches are not echoed', async () => {
        world.entities();
        await tick();
        nai.userSwitch('npc1', true);
        await tick(500);
        expect((await worldDoc()).apart).toEqual([PASSPORT]);
        expect(world.identity!(ofelia().id)?.pending.map((source) => source.key)).toEqual([ARCHIVE, WORKSHOP]);
        nai.userSwitch('npc1', false);
        await tick(500);
        expect((await worldDoc()).apart).toEqual([]);
        expect((await worldDoc()).bound).toEqual([PASSPORT]);
        expect(sourceKinds()).toEqual(['des.character', 'nai.passport']);
        // «Это другой персонаж» switches it off through NAI Studio: the echo changes nothing.
        await world.different!(ofelia().id);
        await tick(500);
        expect((await worldDoc()).apart).toEqual([ARCHIVE, PASSPORT, WORKSHOP]);
        expect((await worldDoc()).bound).toEqual([]);
        expect(nai.exclusions).toEqual([['npc1', true]]);
    });

    it('the question is not tied to its message as a source: a swipe of it does not drop the question', async () => {
        world.entities();
        await tick();
        const card = questions()[0]!;
        expect(card.proposal.sourceMessage).toBeUndefined();
        expect(card.payload).toMatchObject({ messageIndex: 1 });
    });
});

describe('the world document', () => {
    it('migrates schema 1 to 2 with empty identity decisions', async () => {
        const name = env.app.files.fileName(
            `chat-${(await import('../../../src/domain/hash')).stableHash('Old chat')}-world`,
        );
        env.mock.files.set(
            name,
            JSON.stringify({
                schema: 1,
                version: 4,
                updatedAt: 1,
                tabId: 'x',
                data: { aliases: { Рыжая: 'character:elizabeth' }, separated: [], merged: {}, proposed: [] },
            }),
        );
        const store = createChatStore(env.host, createFileStore(env.host, createTestLogger()), createTestLogger());
        const { registerWorldMigrations } = await import('../../../src/features/world/store');
        registerWorldMigrations(store);
        registerWorldMigrations(store);
        const doc = await store.getFor<Dict>('Old chat', WORLD_DOC, () => ({}));
        expect(doc).toEqual({
            aliases: { Рыжая: 'character:elizabeth' },
            separated: [],
            merged: {},
            proposed: [],
            bound: [],
            apart: [],
            asked: {},
        });
        store.dispose();
    });
});
