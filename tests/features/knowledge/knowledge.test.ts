// M18 «Кто что знает»: scene facts of committed turns known by the DES cast at that time, the revision's secrets taken
// in and dismissed, «what X does not know» when the topic came up (Russian forms, English words), the cap, «знает»
// marks with undo, rollback on invalidation, per-chat storage and the module's registration.
import { afterEach, describe, expect, it } from 'vitest';
import { knowledgeModule } from '../../../src/features/knowledge';
import type { KnowledgeApi } from '../../../src/features/knowledge/api';
import { KNOWN_TARGET, SECRET_TARGET } from '../../../src/features/knowledge/settings';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { switchChat } from '../../helpers/core-host';
import {
    FakeRevision,
    FakeSignals,
    commit,
    createKnowledgeTestApp,
    settle,
    signal,
    startKnowledge,
    trackerReply,
    userMessage,
} from './helpers';
import type { KnowledgeTestApp, Started } from './helpers';

let started: Started | null = null;

afterEach(() => {
    started?.stop();
    started = null;
});

function start(env: KnowledgeTestApp, options: { batchWaitMs?: number } = {}): Started {
    started = startKnowledge(env, options);
    return started;
}

function texts(api: KnowledgeApi): string[] {
    return api.facts().map((fact) => fact.text);
}

function factOf(api: KnowledgeApi, text: string) {
    const fact = api.facts().find((item) => item.text === text);
    if (!fact) throw new Error(`no fact «${text}»: ${texts(api).join(' / ')}`);
    return fact;
}

/** Anna (as «Annie» in DES) and Corvin are in the scene, Bob is away. */
function sceneReply(text = 'The rain goes on.') {
    return trackerReply(
        [
            { name: 'Annie', relationship: 'Lover' },
            { name: 'Corvin' },
            { name: 'Bob', thoughts: 'Not currently in the scene; at the docks.' },
        ],
        undefined,
        text,
    );
}

describe('scene facts', () => {
    it('come from the turn’s signals and sentences, known by the cast at that time and the persona', async () => {
        const env = createKnowledgeTestApp();
        const signals = new FakeSignals();
        env.modules.expose('signals', signals);
        const { api } = start(env);
        env.mock.chat.push(userMessage('Hi.'));
        const index = await commit(env, sceneReply('Анна поцеловала Кая. Корвин отвернулся.'));
        signals.emit({
            messageIndex: index,
            signals: [
                signal('quest.added', index, { title: 'Find the old map', main: true }),
                signal('relationship.changed', index, { name: 'Anna', from: 'Friend', to: 'Lover' }),
                signal('time.skipped', index, {}),
            ],
            folded: 0,
        });
        await settle();
        expect(texts(api)).toEqual([
            'Quest begun: Find the old map',
            'Anna now regards Kai as Lover (was Friend)',
            'Kiss involving Anna and Kai',
        ]);
        const kiss = factOf(api, 'Kiss involving Anna and Kai');
        expect(kiss).toMatchObject({
            knownBy: ['Anna', 'Corvin', 'Kai'],
            secret: false,
            sourceMessage: index,
            quote: 'Анна поцеловала Кая.',
        });
        expect(kiss.topics).toContain('Анной');
        expect(kiss.topics).not.toContain('Кая');
        expect(factOf(api, 'Quest begun: Find the old map').knownBy).toEqual(['Anna', 'Corvin', 'Kai']);

        // Later Bob is in the scene alone: he knows what happens now, not what happened before.
        const next = await commit(env, trackerReply([{ name: 'Bob' }], undefined, 'Bob waits.'));
        signals.emit({ messageIndex: next, signals: [signal('character.appeared', next, { name: 'Bob' })], folded: 0 });
        await settle();
        expect(factOf(api, 'Bob joined the scene').knownBy).toEqual(['Bob', 'Kai']);
        expect(api.facts().filter((fact) => fact.knownBy.includes('Bob'))).toHaveLength(1);
    });

    it('reads the turn without a batch after a wait, with the signals still pending for it', async () => {
        const env = createKnowledgeTestApp();
        const signals = new FakeSignals();
        env.modules.expose('signals', signals);
        const { api } = start(env, { batchWaitMs: 20 });
        signals.pendingList = [signal('name.new', 0, { name: 'Ирэн' }), signal('name.new', 9, { name: 'Other' })];
        await commit(env, sceneReply());
        await settle(10);
        expect(texts(api)).toEqual([]);
        await settle(60);
        expect(texts(api)).toEqual(['The name Ирэн came up']);
    });

    it('works without the signals service, and the reply reader can be turned off', async () => {
        const env = createKnowledgeTestApp();
        const { api } = start(env);
        await commit(env, sceneReply('Corvin stole the ring.'));
        await settle();
        expect(texts(api)).toEqual(['Theft involving Corvin']);

        env.knowledgeSettings().replyEvents = false;
        await commit(env, sceneReply('Anna stole the cup.'));
        await settle();
        expect(texts(api)).toEqual(['Theft involving Corvin']);
    });

    it('adds nothing when a turn is read twice; a late batch adds only its own signals', async () => {
        const env = createKnowledgeTestApp();
        const signals = new FakeSignals();
        env.modules.expose('signals', signals);
        const { api, service } = start(env);
        const index = await commit(env, sceneReply('Corvin was arrested.'));
        const batch = {
            messageIndex: index,
            signals: [signal('quest.removed', index, { title: 'Pay Bob' })],
            folded: 0,
        };
        signals.emit(batch);
        await settle();
        signals.emit(batch);
        await settle();
        expect(await service.readTurn(index, batch.signals, true)).toBe(0);
        expect(texts(api)).toEqual(['Quest over: Pay Bob', 'Arrest involving Corvin']);

        signals.emit({
            messageIndex: index,
            signals: [signal('location.changed', index, { to: 'Old Mill' })],
            folded: 0,
            late: true,
        });
        await settle();
        expect(texts(api)).toEqual(['Quest over: Pay Bob', 'Arrest involving Corvin', 'Kai went to Old Mill']);
    });

    it('leaves out characters hidden in DES and reads the cast of an earlier reply when this one has none', async () => {
        const env = createKnowledgeTestApp();
        env.hidden.push('corvin');
        const { api } = start(env);
        env.mock.chat.push(sceneReply('Quiet.'));
        env.mock.chat.push(userMessage('Hm.'));
        await commit(env, { ...userMessage('x'), is_user: false, mes: 'Corvin died in the night.' });
        await settle();
        expect(factOf(api, 'Death involving Corvin').knownBy).toEqual(['Anna', 'Kai', 'Corvin']);
    });

    it('reads nothing for user messages, other tabs or without a chat', async () => {
        const env = createKnowledgeTestApp();
        const { api, service } = start(env);
        env.mock.chat.push(userMessage('Anna kissed Kai.'));
        expect(await service.readTurn(0, [], true)).toBe(0);
        env.leader.value = false;
        await commit(env, sceneReply('Corvin stole the ring.'));
        await settle();
        expect(texts(api)).toEqual([]);
        env.leader.value = true;
        await switchChat(env.mock, undefined);
        expect(await service.readTurn(1, [], true)).toBe(0);
    });

    it('keeps the facts of each chat apart', async () => {
        const env = createKnowledgeTestApp();
        const { api } = start(env);
        await commit(env, sceneReply('Corvin stole the ring.'));
        await settle();
        expect(texts(api)).toHaveLength(1);
        await switchChat(env.mock, 'chat-2');
        await env.app.bus.emit('chat:changed', { chatId: 'chat-2' });
        await settle();
        expect(api.facts()).toEqual([]);
        await switchChat(env.mock, 'chat-1');
        await env.app.bus.emit('chat:changed', { chatId: 'chat-1' });
        await settle();
        expect(texts(api)).toEqual(['Theft involving Corvin']);
    });
});

describe('invalidation', () => {
    async function prepared() {
        const env = createKnowledgeTestApp();
        const { api } = start(env);
        const first = await commit(env, sceneReply('Corvin stole the ring.'));
        const second = await commit(env, sceneReply('Anna kissed Bob.'));
        await settle();
        await api.addSecret({ text: 'Bob is a thief', topics: ['Bob'], knownBy: ['Bob'], sourceMessage: second });
        return { env, api, first, second };
    }

    it('a swipe drops the facts of the message and reads it again', async () => {
        const { env, api, second } = await prepared();
        env.mock.chat[second] = sceneReply('Anna wounded Corvin.');
        await env.app.bus.emit('message:invalidated', { messageIndex: second, reason: 'swiped' });
        await settle();
        expect(texts(api)).toEqual(['Theft involving Corvin', 'Injury involving Anna and Corvin']);
    });

    it('an edit keeps the secrets of the message; a deletion drops everything from the index on', async () => {
        const { env, api, first, second } = await prepared();
        await env.app.bus.emit('message:invalidated', { messageIndex: second, reason: 'edited' });
        await settle();
        expect(texts(api)).toEqual(['Theft involving Corvin', 'Bob is a thief', 'Kiss involving Anna and Bob']);
        env.mock.chat.splice(first + 1);
        await env.app.bus.emit('message:invalidated', { messageIndex: first + 1, reason: 'deleted' });
        await settle();
        expect(texts(api)).toEqual(['Theft involving Corvin']);
    });
});

describe('secrets', () => {
    it('takes the revision’s secret cards in (the backlog too) and dismisses them', async () => {
        const env = createKnowledgeTestApp();
        const revision = new FakeRevision();
        env.modules.expose('revision', revision);
        env.mock.chat.push(userMessage('Hi.'), sceneReply('…'), userMessage('Hm.'));
        revision.add({ value: 'Anna is a spy for the Duke; Kai does not know.', evidence: '«Я работаю на герцога»' });
        revision.add({ target: 'deferred.promise', value: 'Corvin will pay Bob back.' });
        const { api } = start(env);
        await settle();
        expect(revision.dismissed).toEqual(['def-1']);
        expect(revision.cards.map((card) => card.target)).toEqual(['deferred.promise']);
        const spy = factOf(api, 'Anna is a spy for the Duke; Kai does not know.');
        expect(spy).toMatchObject({ secret: true, knownBy: ['Anna', 'Corvin'], quote: '«Я работаю на герцога»' });
        expect(spy.topics).toEqual(['Anna', 'Annie', 'Анна', 'Анны', 'Анне', 'Анну', 'Анной']);
        expect(env.journal.records.map((record) => [record.kind, record.changes[0]?.target])).toEqual([
            ['knowledge.secret', SECRET_TARGET],
        ]);

        // A card of a later run: knowers named in the statement.
        revision.add({ id: 'def-9', entityName: 'Corvin', value: 'Corvin killed the king; only Bob knows.' });
        revision.changed();
        await settle();
        expect(factOf(api, 'Corvin killed the king; only Bob knows.').knownBy).toEqual(['Corvin', 'Bob']);
        expect(revision.dismissed).toEqual(['def-1', 'def-9']);
    });

    it('takes a secret straight from the revision, and the same statement again only adds knowers', async () => {
        const env = createKnowledgeTestApp();
        env.mock.chat.push(userMessage('Hi.'), sceneReply('…'), userMessage('Hm.'));
        const { api } = start(env);
        const intake = api.intakeSecret!;
        const id = await intake({
            entityName: 'the amulet',
            value: 'The amulet is cursed.',
            evidence: '',
            sourceMessage: 1,
        });
        expect(factOf(api, 'The amulet is cursed.')).toMatchObject({
            id,
            knownBy: ['Anna', 'Corvin', 'Kai'],
            topics: ['amulet', 'cursed'],
        });
        const again = await api.addSecret({
            text: 'the amulet is cursed.',
            topics: ['амулет'],
            knownBy: ['Bob'],
            sourceMessage: 5,
        });
        expect(again).toBe(id);
        expect(factOf(api, 'The amulet is cursed.')).toMatchObject({
            knownBy: ['Anna', 'Corvin', 'Kai', 'Bob'],
            topics: ['amulet', 'cursed', 'амулет'],
        });
        expect(env.journal.records).toHaveLength(1);
        expect(await intake({ entityName: 'x', value: '  ', evidence: '', sourceMessage: 1 })).toBeNull();
        await expect(api.addSecret({ text: ' ', topics: [], knownBy: [], sourceMessage: 1 })).rejects.toThrow(
            'The secret has no text.',
        );
    });

    it('a secret can be undone from the journal', async () => {
        const env = createKnowledgeTestApp();
        const { api } = start(env);
        await api.addSecret({ text: 'Bob is a thief', topics: ['Bob'], knownBy: ['Bob'], sourceMessage: 3 });
        expect(texts(api)).toEqual(['Bob is a thief']);
        expect(await env.journal.undo(env.journal.records[0]!.id)).toBe(true);
        expect(api.facts()).toEqual([]);
    });

    it('does not take cards in another tab or without a chat', async () => {
        const env = createKnowledgeTestApp();
        const revision = new FakeRevision();
        env.modules.expose('revision', revision);
        revision.add({ value: 'Anna is a spy.' });
        env.leader.value = false;
        const { api } = start(env);
        await settle();
        expect(revision.dismissed).toEqual([]);
        env.leader.value = true;
        await env.app.bus.emit('leader:changed', { leader: true });
        await settle();
        expect(revision.dismissed).toEqual(['def-1']);
        expect(texts(api)).toEqual(['Anna is a spy.']);
        await switchChat(env.mock, undefined);
        await expect(api.addSecret({ text: 'x', topics: [], knownBy: [], sourceMessage: 1 })).rejects.toThrow(
            'No chat is open.',
        );
    });
});

describe('what a character does not know', () => {
    async function prepared() {
        const env = createKnowledgeTestApp();
        const { api } = start(env);
        await commit(env, sceneReply('Анна поцеловала Кая.'));
        await commit(env, trackerReply([{ name: 'Bob' }], undefined, 'Bob stole the gold.'));
        await settle();
        await api.addSecret({ text: 'Anna is a spy', topics: ['Anna', 'Анна'], knownBy: ['Anna'], sourceMessage: 1 });
        return { env, api };
    }

    it('names the facts whose topic came up (Russian forms) that the character does not know, secrets first', async () => {
        const { api } = await prepared();
        expect(api.unknownFor('Bob', 'Где сейчас Анна?').map((fact) => fact.text)).toEqual([
            'Anna is a spy',
            'Kiss involving Anna and Kai',
        ]);
        expect(api.unknownFor('Bob', 'О поцелуях ни слова.').map((fact) => fact.text)).toEqual([
            'Kiss involving Anna and Kai',
        ]);
        expect(api.unknownFor('Corvin', 'Где сейчас Анна?').map((fact) => fact.text)).toEqual(['Anna is a spy']);
        expect(api.unknownFor('Corvin', 'Is the gold safe?').map((fact) => fact.text)).toEqual([]);
        expect(api.unknownFor('Anna', 'Who has the gold? Bob stole it.').map((fact) => fact.text)).toEqual([
            'Theft involving Bob',
        ]);
        expect(api.unknownFor('Annie', 'Где Анна?')).toEqual([]);
        expect(api.unknownFor('Bob', 'Nothing related.')).toEqual([]);
        expect(api.unknownFor('', 'Анна')).toEqual([]);
        expect(api.unknownFor('Bob', '')).toEqual([]);
    });

    it('names three facts at most', async () => {
        const env = createKnowledgeTestApp();
        const { api } = start(env);
        for (let index = 1; index <= 5; index++) {
            await api.addSecret({ text: `Secret ${index}`, topics: ['Anna'], knownBy: [], sourceMessage: index });
        }
        expect(api.unknownFor('Bob', 'Anna').map((fact) => fact.text)).toEqual(['Secret 5', 'Secret 4', 'Secret 3']);
    });
});

describe('the store', () => {
    it('keeps at most the set number of facts, dropping the oldest scene facts first', async () => {
        const env = createKnowledgeTestApp();
        env.knowledgeSettings().maxFacts = 50;
        const { api } = start(env);
        await api.addSecret({ text: 'Old secret', topics: [], knownBy: [], sourceMessage: 0 });
        for (let index = 0; index < 60; index++) {
            await commit(env, sceneReply(`Corvin stole ring ${index}.`));
            await settle(5);
        }
        await settle();
        const facts = api.facts();
        expect(facts).toHaveLength(50);
        expect(facts[0]?.text).toBe('Old secret');
        expect(facts.filter((fact) => !fact.secret)).toHaveLength(49);
        expect(facts[1]?.quote).toBe('Corvin stole ring 11.');
    });
});

describe('who knows: marks from the pult', () => {
    it('marks a character as knowing or not, journaled with undo', async () => {
        const env = createKnowledgeTestApp();
        const { api } = start(env);
        const id = await api.addSecret({ text: 'Anna is a spy', topics: [], knownBy: ['Anna'], sourceMessage: 1 });
        await api.markKnown(id, 'Корвина');
        expect(factOf(api, 'Anna is a spy').knownBy).toEqual(['Anna', 'Corvin']);
        await api.markKnown(id, 'Corvin');
        await api.markUnknown!(id, 'Annie');
        expect(factOf(api, 'Anna is a spy').knownBy).toEqual(['Corvin']);
        const records = env.journal.records.slice(1);
        expect(records.map((record) => [record.kind, record.summary])).toEqual([
            ['knowledge.known', 'Corvin knows: Anna is a spy'],
            ['knowledge.known', 'Anna does not know: Anna is a spy'],
        ]);
        expect(records[0]?.changes).toEqual([
            { target: KNOWN_TARGET, ref: { factId: id, character: 'Corvin' }, before: false, after: true },
        ]);

        expect(await env.journal.undo(records[1]!.id)).toBe(true);
        expect(factOf(api, 'Anna is a spy').knownBy).toEqual(['Corvin', 'Anna']);
        expect(await env.journal.undo(records[0]!.id)).toBe(true);
        expect(factOf(api, 'Anna is a spy').knownBy).toEqual(['Anna']);
        await expect(api.markKnown('nope', 'Bob')).rejects.toThrow('This fact is gone.');
        await expect(api.markKnown(id, ' ')).rejects.toThrow('No character name.');
    });
});

describe('module', () => {
    it('is experimental and off by default, and releases everything it registered', async () => {
        expect(knowledgeModule).toMatchObject({ id: 'M18', key: 'knowledge', stage: 9, enabledByDefault: false });
        const env = createKnowledgeTestApp();
        const signals = new FakeSignals();
        env.modules.expose('signals', signals);
        const revision = new FakeRevision();
        env.modules.expose('revision', revision);
        const disposers: Unsubscribe[] = [];
        await knowledgeModule.init({
            app: env.app,
            settings: env.settings.module('knowledge'),
            log: env.app.log,
            own: (dispose) => disposers.push(dispose as Unsubscribe),
        });
        const api = env.modules.api<KnowledgeApi>('knowledge');
        expect(typeof api?.unknownFor).toBe('function');
        expect(typeof api?.intakeSecret).toBe('function');
        expect(env.ui.tabs.map((tab) => [tab.id, tab.titleKey, tab.order])).toEqual([['knowledge', 'm18.tab', 59]]);
        expect(env.ui.styles.has('maestro-m18')).toBe(true);
        expect(signals.listenerCount()).toBe(1);
        expect(Object.keys(knowledgeModule.i18n?.ru ?? {}).sort()).toEqual(
            Object.keys(knowledgeModule.i18n?.en ?? {}).sort(),
        );

        for (const dispose of disposers.splice(0).reverse()) await dispose();
        expect(env.ui.tabs).toEqual([]);
        expect(env.ui.styles.has('maestro-m18')).toBe(false);
        expect(signals.listenerCount()).toBe(0);
        await commit(env, sceneReply('Corvin stole the ring.'));
        await settle();
        expect(api?.facts()).toEqual([]);
    });
});
