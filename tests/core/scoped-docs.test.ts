// Documents of a card and of a chat (plan-2 «Области действия»), over the ST mock: a Maestro file per avatar, a
// per-chat document of the chat store; writes replayed on a fresh read so two tabs merge.
import { beforeEach, describe, expect, it } from 'vitest';
import {
    EMPTY_SCOPE_CONTEXT,
    ScopedDocs,
    currentScopeContext,
    sameScopeContext,
    scopeOwner,
} from '../../src/core/scoped-docs';
import { createFeatureEnv } from '../helpers/medic-app';
import type { FeatureEnv } from '../helpers/medic-app';

interface Doc {
    texts: Record<string, string>;
}

const sanitize = (raw: unknown): Doc => {
    const texts = (raw as { texts?: unknown } | null)?.texts;
    return { texts: texts && typeof texts === 'object' ? { ...(texts as Record<string, string>) } : {} };
};

let env: FeatureEnv;
let docs: ScopedDocs<Doc>;

function make(): ScopedDocs<Doc> {
    return new ScopedDocs<Doc>(
        { files: env.app.files, chat: env.app.chat, log: env.app.log },
        { kind: 'test-scope', defaults: () => ({ texts: {} }), sanitize },
    );
}

beforeEach(async () => {
    env = await createFeatureEnv();
    env.mock.context.characters = [{ name: 'Alice', avatar: 'alice.png' }] as never;
    env.mock.context.characterId = 0;
    docs = make();
});

describe('the scope context', () => {
    it('is the card avatar and name and the chat id; a group chat has neither', () => {
        const context = currentScopeContext(env.host);
        expect(context).toEqual({ avatar: 'alice.png', characterName: 'Alice', chatId: 'chat-1' });
        expect(scopeOwner(context, 'character')).toBe('alice.png');
        expect(scopeOwner(context, 'chat')).toBe('chat-1');
        expect(sameScopeContext(context, { ...context, characterName: 'Other name' })).toBe(true);
        expect(sameScopeContext(context, { ...context, chatId: 'chat-2' })).toBe(false);
        env.group.value = true;
        expect(currentScopeContext(env.host)).toEqual(EMPTY_SCOPE_CONTEXT);
        env.group.value = false;
        env.mock.context.characterId = undefined;
        expect(currentScopeContext(env.host)).toEqual({ avatar: null, characterName: null, chatId: 'chat-1' });
    });
});

describe('ScopedDocs', () => {
    it('writes the character document as a Maestro file per avatar and reads it back', async () => {
        await docs.mutate('character', 'alice.png', (doc) => {
            doc.texts.a = 'one';
        });
        expect(docs.get('character', 'alice.png')).toEqual({ texts: { a: 'one' } });
        const stored = JSON.parse(env.mock.files.get(docs.fileName('alice.png')) ?? 'null') as Record<string, unknown>;
        expect(stored).toMatchObject({ schema: 1, owner: 'alice.png', data: { texts: { a: 'one' } } });
        const again = make();
        await again.load({ avatar: 'alice.png', characterName: 'Alice', chatId: null });
        expect(again.get('character', 'alice.png')).toEqual({ texts: { a: 'one' } });
        expect(again.has('chat', 'chat-1')).toBe(false);
    });

    it('writes the chat document through the chat store, also for a chat that is not open', async () => {
        await docs.mutate('chat', 'chat-1', (doc) => {
            doc.texts.x = 'here';
        });
        await docs.mutate('chat', 'chat-9', (doc) => {
            doc.texts.y = 'there';
        });
        expect(await env.app.chat.getFor('chat-1', 'test-scope', () => ({}))).toMatchObject({ texts: { x: 'here' } });
        expect(await env.app.chat.getFor('chat-9', 'test-scope', () => ({}))).toMatchObject({ texts: { y: 'there' } });
        const again = make();
        await again.loadOne('chat', 'chat-9');
        expect(again.get('chat', 'chat-9')).toEqual({ texts: { y: 'there' } });
    });

    it('replays its change on what another tab wrote meanwhile', async () => {
        await docs.mutate('character', 'alice.png', (doc) => {
            doc.texts.mine = '1';
        });
        // Another tab adds its own text to the same file.
        const name = docs.fileName('alice.png');
        const stored = JSON.parse(env.mock.files.get(name) ?? '{}') as { data: Doc };
        stored.data.texts.theirs = '2';
        env.mock.files.set(name, JSON.stringify(stored));
        await docs.mutate('character', 'alice.png', (doc) => {
            doc.texts.mine = '3';
        });
        expect(docs.get('character', 'alice.png')).toEqual({ texts: { mine: '3', theirs: '2' } });
    });

    it('keeps a change in memory and retries it with the next write when saving failed', async () => {
        const files = env.app.files as { write: (name: string, data: unknown) => Promise<void> };
        const write = files.write.bind(files);
        let fail = true;
        files.write = async (name, data) => {
            if (fail) throw new Error('offline');
            return write(name, data);
        };
        await docs.mutate('character', 'alice.png', (doc) => {
            doc.texts.a = 'kept';
        });
        expect(docs.get('character', 'alice.png')).toEqual({ texts: { a: 'kept' } });
        expect(env.mock.files.get(docs.fileName('alice.png'))).toBeUndefined();
        fail = false;
        await docs.mutate('character', 'alice.png', (doc) => {
            doc.texts.b = 'next';
        });
        const stored = JSON.parse(env.mock.files.get(docs.fileName('alice.png')) ?? '{}') as { data: Doc };
        expect(stored.data).toEqual({ texts: { a: 'kept', b: 'next' } });
    });
});
