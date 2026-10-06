// «Области действия» of «Твой слой»: the global, character and chat parts laid over a base one after another.
import { describe, expect, it } from 'vitest';
import { applyLayer, findPrompt, textHash } from '../../src/domain/preset-layer-apply';
import type { LayerOp } from '../../src/domain/preset-layer-apply';
import {
    applyScoped,
    holdsParts,
    plainOp,
    rebaseOp,
    sanitizeScopeDoc,
    stripScoped,
} from '../../src/domain/preset-layer-scopes';
import type { ScopeOps } from '../../src/domain/preset-layer-scopes';
import { baseBody, ids } from './preset-layer-fixtures';

const content = (body: unknown, id: string) => findPrompt(body, id)?.content;

const globalEdit: LayerOp = {
    op: 'edit',
    identifier: 'main',
    patch: { content: 'Global main' },
    baseHash: textHash('Main text'),
    baseText: 'Main text',
};
// Made on the base with the global part laid over it.
const chatEdit: LayerOp = {
    op: 'edit',
    identifier: 'main',
    patch: { content: 'Chat main' },
    baseHash: textHash('Global main'),
    baseText: 'Global main',
};
const characterKey: LayerOp = { op: 'key', key: 'temperature', value: 0.4, baseValue: 1 };
const chatBlock: LayerOp = {
    op: 'add',
    prompt: { identifier: 'chatOwn', name: 'Chat block', content: 'Only here' },
    anchor: { kind: 'after', identifier: 'task' },
    enabled: true,
};

function parts(): ScopeOps[] {
    return [
        { scope: 'global', ops: [globalEdit] },
        { scope: 'character', ops: [characterKey] },
        { scope: 'chat', ops: [chatEdit, chatBlock] },
    ];
}

describe('applyScoped / stripScoped', () => {
    it('lays the parts in order global → character → chat, like their concatenation', () => {
        const { body, report } = applyScoped(baseBody(), parts());
        expect(content(body, 'main')).toBe('Chat main');
        expect(body.temperature).toBe(0.4);
        expect(ids(body)).toEqual(['main', 'task', 'chatOwn', 'style', 'nsfw', 'chatHistory', 'jailbreak']);
        expect(report).toEqual({ applied: 4, conflicts: [], orphaned: [] });
        expect(body).toEqual(applyLayer(baseBody(), [globalEdit, characterKey, chatEdit, chatBlock]).body);
    });

    it('tags conflicts and lost ops with their scope (global ones stay untagged)', () => {
        const stale: LayerOp = { ...chatEdit, baseHash: textHash('Something else'), baseText: 'Something else' };
        const lost: LayerOp = { op: 'toggle', identifier: 'missing', enabled: true };
        const { report } = applyScoped(baseBody(), [
            { scope: 'global', ops: [globalEdit, lost] },
            { scope: 'chat', ops: [stale, lost] },
        ]);
        expect(report.conflicts).toEqual([
            { identifier: 'main', oldBase: 'Something else', newBase: 'Global main', mine: 'Chat main', scope: 'chat' },
        ]);
        expect(report.orphaned).toEqual([lost, { ...lost, scope: 'chat' }]);
    });

    it('strips the parts the last first: back to the base, or only the chat and character parts', () => {
        const applied = applyScoped(baseBody(), parts()).body;
        expect(stripScoped(applied, parts())).toEqual(baseBody());
        const withoutChat = stripScoped(applied, parts().slice(1));
        expect(content(withoutChat, 'main')).toBe('Global main');
        expect(withoutChat.temperature).toBe(1);
        expect(findPrompt(withoutChat, 'chatOwn')).toBeUndefined();
    });

    it('tells a body that holds the parts from one written without them', () => {
        const applied = applyScoped(baseBody(), parts()).body;
        const chatParts = parts().slice(1);
        expect(holdsParts(applied, chatParts)).toBe(true);
        expect(holdsParts(stripScoped(applied, chatParts), chatParts)).toBe(false);
        expect(holdsParts(applied, [{ scope: 'chat', ops: [] }])).toBe(false);
    });
});

describe('scope documents and ops', () => {
    it('keeps valid ops per base and the binding; drops tags, broken ops and empty layers', () => {
        const doc = sanitizeScopeDoc({
            layers: {
                Marinara: { ops: [{ ...chatEdit, scope: 'chat', owner: 'chat-1' }, { op: 'nope' }], updatedAt: 5 },
                Empty: { ops: [] },
                '': { ops: [chatEdit] },
            },
            binding: { preset: 'Marinara', at: 3 },
        });
        expect(doc).toEqual({
            layers: { Marinara: { ops: [chatEdit], updatedAt: 5 } },
            binding: { preset: 'Marinara', at: 3 },
        });
        expect(sanitizeScopeDoc(null)).toEqual({ layers: {}, binding: null });
        expect(sanitizeScopeDoc({ binding: { preset: '' } }).binding).toBeNull();
    });

    it('plainOp takes the tags off; rebaseOp drops the base values of the old scope', () => {
        expect(plainOp({ ...globalEdit, scope: 'global', owner: 'x' } as LayerOp)).toEqual(globalEdit);
        expect(rebaseOp(globalEdit)).toEqual({
            op: 'edit',
            identifier: 'main',
            patch: { content: 'Global main' },
            baseHash: '',
        });
        expect(rebaseOp(characterKey)).toEqual({ op: 'key', key: 'temperature', value: 0.4 });
        expect(rebaseOp({ op: 'toggle', identifier: 'main', enabled: false, baseEnabled: true })).toEqual({
            op: 'toggle',
            identifier: 'main',
            enabled: false,
        });
        expect(
            rebaseOp({ op: 'move', identifier: 'main', anchor: { kind: 'end' }, baseAnchor: { kind: 'start' } }),
        ).toEqual({ op: 'move', identifier: 'main', anchor: { kind: 'end' } });
        expect(rebaseOp(chatBlock)).toEqual(chatBlock);
    });
});
