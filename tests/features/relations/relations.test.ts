import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { relationsModule } from '../../../src/features/relations';
import type { RelationsApi } from '../../../src/features/relations/api';
import type { Dict, WorldEnv } from '../world/helpers';
import { createWorldEnv, startModule, trackerMessage, userMessage } from '../world/helpers';

let env: WorldEnv;
let relations: RelationsApi;
let stop: () => Promise<void>;

const generating = { type: 'normal', dryRun: false, quiet: false };
const TIME = '3 марта, 14:00';

let sent = 0;

function reply(...characters: [string, string?][]): STChatMessage {
    const message = trackerMessage(
        'Ответ',
        characters.map(([name, status]) => (status ? { name, relationship: { status } } : { name })),
    );
    message.send_date = `date-${++sent}`;
    return message;
}

const des = (messageIndex: number, status: string) => ({ messageIndex, status, source: 'des', storyTime: TIME });

async function tick(ms = 10): Promise<void> {
    await vi.advanceTimersByTimeAsync(ms);
}

async function start(): Promise<void> {
    const started = await startModule(env, relationsModule);
    stop = () => started.stop();
    relations = env.modules.api<RelationsApi>('relations')!;
    await tick();
}

async function commit(messageIndex: number): Promise<void> {
    env.mock.chat.push(userMessage('…'));
    await env.app.bus.emit('turn:committed', { messageIndex });
    await tick(2000);
}

async function storedDoc(): Promise<Dict> {
    return env.app.chat.get<Dict>('relations', () => ({}));
}

beforeEach(() => {
    vi.useFakeTimers();
    env = createWorldEnv();
    (env.mock.context as unknown as Dict).name1 = 'Алекс';
    // The world model knows that DES's «Лиза» is the card «Elizabeth».
    env.modules.expose('world', {
        resolve: (name: string) =>
            name === 'Лиза' ? { name: 'Elizabeth' } : name === 'Алекс' ? { name: 'Алекс' } : undefined,
        onChange: () => () => {},
    });
});

afterEach(async () => {
    await stop();
    vi.useRealTimers();
});

describe('M19 relations: recording', () => {
    it('records a point only when the reply is committed, with the canonical name and story time', async () => {
        env.mock.chat.push(reply(['Лиза', 'Friendly'], ['Боб']));
        await start();
        await tick(5000);
        expect(relations.all()).toEqual([]);
        await commit(0);
        expect(relations.all()).toEqual([
            { from: 'Elizabeth', to: 'Алекс', current: 'Friendly', history: [des(0, 'Friendly')] },
        ]);
        expect((await storedDoc()).relations).toHaveLength(1);
    });

    it('adds a point only when the status changes', async () => {
        await start();
        env.mock.chat.push(reply(['Лиза', 'Friendly']));
        await commit(0);
        env.mock.chat.push(reply(['Лиза', 'friendly']));
        await commit(2);
        env.mock.chat.push(reply(['Лиза', 'Romantic interest'], ['Боб', 'Wary']));
        await commit(4);
        expect(relations.between('Лиза', 'Алекс')?.history).toEqual([des(0, 'Friendly'), des(4, 'Romantic interest')]);
        expect(relations.between('Elizabeth', 'Алекс')?.current).toBe('Romantic interest');
        expect(relations.of('Алекс').map((relation) => relation.from)).toEqual(['Боб', 'Elizabeth']);
        expect(relations.of('Боб')).toHaveLength(1);
        expect(relations.between('Боб', 'Elizabeth')).toBeUndefined();
    });

    it('waits for the generation to end before reading the tracker', async () => {
        await start();
        env.mock.chat.push(reply(['Лиза', 'Friendly']), userMessage('…'));
        env.turn.generation = generating;
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        await tick(5000);
        expect(relations.all()).toEqual([]);
        env.turn.generation = null;
        await env.app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        await tick(500);
        expect(relations.all()).toHaveLength(1);
    });

    it('other tabs do not write', async () => {
        env.leader.value = false;
        await start();
        env.mock.chat.push(reply(['Лиза', 'Friendly']));
        await commit(0);
        expect(relations.all()).toEqual([]);
        expect((await storedDoc()).relations ?? []).toEqual([]);
    });

    it('retries once when another tab wrote first', async () => {
        await start();
        const put = env.app.chat.put.bind(env.app.chat);
        let calls = 0;
        env.app.chat.put = (async (kind: string, data: object) => {
            calls++;
            return calls === 1 ? false : put(kind, data);
        }) as typeof env.app.chat.put;
        env.mock.chat.push(reply(['Лиза', 'Friendly']));
        await commit(0);
        expect(calls).toBe(2);
        expect(relations.all()).toHaveLength(1);
        env.app.chat.put = (async () => false) as typeof env.app.chat.put;
        env.mock.chat.push(reply(['Лиза', 'Hostile']));
        await commit(2);
        expect(relations.all()[0]?.current).toBe('Friendly');
    });
});

describe('M19 relations: invalidation', () => {
    beforeEach(async () => {
        await start();
        env.mock.chat.push(reply(['Лиза', 'Friendly']));
        await commit(0);
        env.mock.chat.push(reply(['Лиза', 'Friendly']));
        await commit(2);
        env.mock.chat.push(reply(['Лиза', 'Hostile']));
        await commit(4);
        expect(relations.all()[0]?.history).toEqual([des(0, 'Friendly'), des(4, 'Hostile')]);
    });

    it('an edited committed reply is read again, with the next one', async () => {
        env.mock.chat[0] = reply(['Лиза', 'Wary']);
        await env.app.bus.emit('message:invalidated', { messageIndex: 0, reason: 'edited' });
        await tick(2000);
        expect(relations.all()[0]?.history).toEqual([des(0, 'Wary'), des(2, 'Friendly'), des(4, 'Hostile')]);
    });

    it('a swiped last reply loses its points until it is committed again', async () => {
        env.mock.chat.pop();
        await env.app.bus.emit('message:invalidated', { messageIndex: 5, reason: 'deleted' });
        env.mock.chat[4] = reply(['Лиза', 'Romantic']);
        await env.app.bus.emit('message:invalidated', { messageIndex: 4, reason: 'swiped' });
        await tick(2000);
        expect(relations.all()[0]?.history).toEqual([des(0, 'Friendly')]);
        await commit(4);
        expect(relations.all()[0]?.history).toEqual([des(0, 'Friendly'), des(4, 'Romantic')]);
    });

    it('deleting the tail drops its points; deleting in the middle reads the chat again', async () => {
        env.mock.chat.splice(4);
        await env.app.bus.emit('message:invalidated', { messageIndex: 4, reason: 'deleted' });
        await tick(2000);
        expect(relations.all()[0]?.history).toEqual([des(0, 'Friendly')]);
        env.mock.chat.push(reply(['Лиза', 'Hostile']));
        await commit(4);
        env.mock.chat.splice(0, 2);
        await env.app.bus.emit('message:invalidated', { messageIndex: 4, reason: 'deleted' });
        await tick(3000);
        expect(relations.all()[0]?.history).toEqual([des(0, 'Friendly'), des(2, 'Hostile')]);
    });
});

describe('M19 relations: rebuild', () => {
    function longChat(): void {
        for (let i = 0; i < 60; i++) {
            env.mock.chat.push(reply(['Лиза', i < 30 ? 'Friendly' : 'Hostile']), userMessage('…'));
        }
    }

    it('reads a chat without a document in the background, leader only', async () => {
        longChat();
        env.leader.value = false;
        await start();
        await tick(5000);
        expect(relations.all()).toEqual([]);
        env.leader.value = true;
        for (const listener of env.leader.listeners) listener(true);
        await tick(5000);
        expect(relations.all()[0]?.history).toEqual([des(0, 'Friendly'), des(60, 'Hostile')]);
        expect((await storedDoc()).builtAt).toBeGreaterThan(0);
    });

    it('rebuild() keeps points that did not come from DES', async () => {
        longChat();
        await env.app.chat.put('relations', {
            relations: [{ from: 'Боб', to: 'Алекс', history: [{ messageIndex: 3, status: 'Mine', source: 'user' }] }],
            builtAt: 1,
        });
        await start();
        await tick(5000);
        expect(relations.all()).toHaveLength(1);
        const done = relations.rebuild();
        await tick(1000);
        await done;
        expect(relations.all().map((relation) => relation.from)).toEqual(['Боб', 'Elizabeth']);
    });

    it('a chat switch reloads; disabling leaves nothing behind', async () => {
        await start();
        env.mock.chat.push(reply(['Лиза', 'Friendly']));
        await commit(0);
        env.mock.chatId = 'Other chat';
        env.mock.chatMetadata = {};
        env.mock.chat.length = 0;
        await env.mock.eventSource.emit('chat_id_changed', 'Other chat');
        await env.app.bus.emit('chat:changed', { chatId: 'Other chat' });
        await tick();
        expect(relations.all()).toEqual([]);
        expect(env.ui.tabs.map((tab) => tab.id)).toEqual(['relations']);
        await stop();
        stop = async () => {};
        expect(env.ui.tabs).toEqual([]);
        expect(env.ui.styles.size).toBe(0);
        env.mock.chat.push(reply(['Лиза', 'Friendly']));
        await commit(0);
        expect((await storedDoc()).relations ?? []).toEqual([]);
    });
});
