import { describe, expect, it } from 'vitest';
import { applyLayer, findPrompt, globalOrder, textHash } from '../../src/domain/preset-layer-apply';
import type { AddOp, LayerBody, LayerOp, LayerPrompt } from '../../src/domain/preset-layer-apply';
import { planMigration, splitForeign, transferOps } from '../../src/domain/preset-layer-migrate';
import { opKey } from '../../src/domain/preset-layer-ops';
import { baseBody, entry, ids, own } from './preset-layer-fixtures';

function edit(body: LayerBody, id: string, change: Partial<LayerPrompt>): void {
    const prompt = findPrompt(body, id);
    if (prompt) Object.assign(prompt, change);
}

function setOrder(body: LayerBody, order: [string, boolean][]): void {
    const list = body.prompt_order?.find((item) => item.character_id === 100001);
    if (list) list.order = order.map(([identifier, enabled]) => ({ identifier, enabled }));
}

/** The user's Marinara: the reference with edits made in Prompt Manager. */
function editedBody(): LayerBody {
    const body = baseBody();
    edit(body, 'main', { content: 'My main' });
    edit(body, 'style', { injection_position: 1, injection_depth: 2 });
    body.prompts?.push({ identifier: 'mine', name: 'Mine', role: 'user', content: 'My rules', system_prompt: false });
    setOrder(body, [
        ['main', true],
        ['spare', true],
        ['task', true],
        ['mine', true],
        ['style', true],
        ['nsfw', true],
        ['jailbreak', true],
        ['chatHistory', true],
    ]);
    body.temperature = 0.6;
    body.reasoning_effort = 'high';
    body.proxy_password = 'secret';
    return body;
}

const view = (body: LayerBody, id: string) => {
    const prompt = findPrompt(body, id);
    return (
        prompt && {
            content: prompt.content,
            role: prompt.role ?? 'system',
            position: prompt.injection_position ?? 0,
            depth: prompt.injection_depth ?? 4,
        }
    );
};

describe('planMigration (Q23)', () => {
    it('turns the edits into ops whose application reproduces the edited preset', () => {
        const reference = baseBody();
        const edited = editedBody();
        const plan = planMigration(reference, edited);
        const { body, report } = applyLayer(reference, plan.ops);
        expect(report.conflicts).toEqual([]);
        expect(report.orphaned).toEqual([]);
        expect(globalOrder(body)).toEqual(globalOrder(edited));
        for (const id of ['main', 'style', 'mine', 'task', 'spare']) expect(view(body, id)).toEqual(view(edited, id));
        expect(body.temperature).toBe(0.6);
        // Keys the reference lacks (a body from ST has all of them) and secrets are left out.
        expect(body.reasoning_effort).toBeUndefined();
        expect(plan.ops.some((op) => op.op === 'key' && op.key === 'proxy_password')).toBe(false);
        expect(plan.removed).toEqual([]);
        expect(plan.ops.map(opKey)).toEqual([
            'move:spare',
            'add:mine',
            'move:chatHistory',
            'toggle:spare',
            'toggle:nsfw',
            'edit:main',
            'edit:style',
            'key:temperature',
        ]);
    });

    it('fingerprints edits against the reference and keeps the base values for strip', () => {
        const plan = planMigration(baseBody(), editedBody());
        expect(plan.ops.find((op) => opKey(op) === 'edit:main')).toEqual({
            op: 'edit',
            identifier: 'main',
            patch: { content: 'My main' },
            baseHash: textHash('Main text'),
            baseText: 'Main text',
            baseFields: {},
        });
        expect(plan.ops.find((op) => opKey(op) === 'edit:style')).toMatchObject({
            baseFields: { injection_position: 0 },
            baseMissing: ['injection_depth'],
        });
        expect(plan.ops.find((op) => opKey(op) === 'move:spare')).toMatchObject({ baseAnchor: null });
        expect(plan.ops.find((op) => opKey(op) === 'move:chatHistory')).toMatchObject({
            anchor: { kind: 'after', identifier: 'jailbreak' },
            baseAnchor: { kind: 'after', identifier: 'nsfw' },
        });
        const added = plan.ops.find((op) => opKey(op) === 'add:mine') as AddOp;
        expect(added.anchor).toEqual({ kind: 'after', identifier: 'task' });
        expect(added.prompt).toMatchObject({ system_prompt: false, marker: false, injection_depth: 4 });
    });

    it('switches off base blocks the edited order dropped, but never chatHistory', () => {
        const edited = baseBody();
        setOrder(edited, [
            ['main', true],
            ['task', true],
            ['jailbreak', true],
        ]);
        const plan = planMigration(baseBody(), edited);
        expect(plan.removed).toEqual(['style', 'nsfw', 'chatHistory']);
        expect(plan.ops.filter((op) => op.op === 'toggle')).toEqual([
            { op: 'toggle', identifier: 'style', enabled: false, baseEnabled: true },
        ]);
        const disabled = baseBody();
        setOrder(disabled, [
            ['main', true],
            ['task', true],
            ['style', true],
            ['nsfw', false],
            ['chatHistory', false],
            ['jailbreak', true],
        ]);
        expect(planMigration(baseBody(), disabled).ops).toEqual([]);
    });

    it('ignores what Prompt Manager writes when a block is saved unchanged', () => {
        const edited = baseBody();
        edit(edited, 'task', {
            injection_position: 0,
            injection_depth: 4,
            injection_order: 100,
            injection_trigger: [],
        });
        edit(edited, 'task', { forbid_overrides: false });
        expect(planMigration(baseBody(), edited).ops).toEqual([]);
        edit(edited, 'chatHistory', { content: 'cannot change' });
        expect(planMigration(baseBody(), edited).ops).toEqual([]);
    });

    it('keeps own blocks outside the order, skips dangling entries', () => {
        const edited = baseBody();
        edited.prompts?.push(own('loose', 'Loose block'), own('worldInfoBefore', ''));
        const list = edited.prompt_order?.find((item) => item.character_id === 100001);
        list?.order.splice(1, 0, { identifier: 'ghost', enabled: true });
        const plan = planMigration(baseBody(), edited);
        expect(plan.ops).toEqual([
            {
                op: 'add',
                prompt: expect.objectContaining({ identifier: 'loose', content: 'Loose block' }),
                anchor: { kind: 'end' },
                enabled: false,
            },
        ]);
        const duplicate = baseBody();
        duplicate.prompt_order?.[1]?.order.push({ identifier: 'main', enabled: true });
        expect(planMigration(baseBody(), duplicate).ops).toEqual([]);
    });

    it('works from a reference that has only the legacy order list', () => {
        const reference: LayerBody = {
            prompts: [own('main', 'M'), own('a', 'A'), own('b', 'B')],
            prompt_order: [
                {
                    character_id: 100000,
                    order: [
                        { identifier: 'main', enabled: true },
                        { identifier: 'a', enabled: true },
                        { identifier: 'b', enabled: true },
                    ],
                },
            ],
        };
        const edited: LayerBody = {
            prompts: [own('main', 'M'), own('a', 'A'), own('b', 'B')],
            prompt_order: [
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'b', enabled: true },
                        { identifier: 'main', enabled: true },
                        { identifier: 'a', enabled: false },
                    ],
                },
            ],
        };
        const { body } = applyLayer(reference, planMigration(reference, edited).ops);
        expect(globalOrder(body)).toEqual(globalOrder(edited));
    });
});

describe('transferOps', () => {
    const source = baseBody();
    const ops: LayerOp[] = [
        { op: 'add', prompt: own('a', 'A'), anchor: { kind: 'after', identifier: 'task' }, enabled: true },
        { op: 'add', prompt: own('b', 'B'), anchor: { kind: 'after', identifier: 'a' }, enabled: true },
        { op: 'edit', identifier: 'main', patch: { content: 'Mine' }, baseHash: textHash('Main text') },
        { op: 'toggle', identifier: 'nsfw', enabled: true },
        { op: 'move', identifier: 'style', anchor: { kind: 'before', identifier: 'task' } },
        { op: 'key', key: 'temperature', value: 0.4 },
    ];

    it('keeps everything on a preset with the same identifiers', () => {
        const result = transferOps(ops, source, baseBody());
        expect(result.orphaned).toEqual([]);
        expect(result.ops).toEqual(ops);
        expect(transferOps(ops, source, null)).toEqual({ ops, orphaned: [] });
    });

    it('re-anchors by block name, then by a text anchor from the neighbour', () => {
        const target: LayerBody = {
            prompts: [
                own('main2', 'Other main', { name: 'Main Prompt' }),
                own('rules', 'Some rules\n</task>'),
                own('nsfw', ''),
                own('chatHistory', '', { marker: true }),
            ],
            prompt_order: [
                {
                    character_id: 100001,
                    order: ['main2', 'rules', 'nsfw', 'chatHistory'].map((identifier) => ({
                        identifier,
                        enabled: true,
                    })),
                },
            ],
        };
        const result = transferOps(ops, source, target);
        expect(result.ops.find((op) => opKey(op) === 'add:a')).toMatchObject({
            anchor: { kind: 'afterText', text: '</task>' },
        });
        expect(result.ops.find((op) => opKey(op) === 'add:b')).toMatchObject({
            anchor: { kind: 'after', identifier: 'a' },
        });
        expect(result.ops.find((op) => op.op === 'edit')).toMatchObject({
            identifier: 'main2',
            baseHash: textHash('Main text'),
        });
        expect(result.ops.find((op) => op.op === 'toggle')).toMatchObject({ identifier: 'nsfw' });
        expect(result.orphaned.map(opKey)).toEqual(['move:style']);
        const { report } = applyLayer(target, result.ops);
        expect(report.conflicts).toEqual([{ identifier: 'main2', oldBase: '', newBase: 'Other main', mine: 'Mine' }]);
        expect(ids(applyLayer(target, result.ops).body)).toEqual(['main2', 'rules', 'a', 'b', 'nsfw', 'chatHistory']);
    });

    it('puts an add without any anchor at the end, switched off, and leaves block ops behind', () => {
        const target: LayerBody = {
            prompts: [own('x', 'X')],
            prompt_order: [{ character_id: 100001, order: [{ identifier: 'x', enabled: true }] }],
        };
        const result = transferOps(ops, source, target);
        expect(result.ops.find((op) => opKey(op) === 'add:a')).toMatchObject({
            anchor: { kind: 'end' },
            enabled: false,
        });
        expect(result.orphaned.map(opKey)).toEqual(['add:a', 'edit:main', 'toggle:nsfw', 'move:style']);
        expect(entry(applyLayer(target, result.ops).body, 'a')?.enabled).toBe(false);
    });

    it('resolves before, text and edge anchors', () => {
        const target = baseBody();
        const anchors: LayerOp[] = [
            { op: 'move', identifier: 'style', anchor: { kind: 'before', identifier: 'main' } },
            { op: 'move', identifier: 'task', anchor: { kind: 'afterText', text: 'Style rules' } },
            { op: 'move', identifier: 'nsfw', anchor: { kind: 'afterText', text: 'nowhere' } },
            { op: 'move', identifier: 'jailbreak', anchor: { kind: 'start' } },
        ];
        const result = transferOps(anchors, source, target);
        expect(result.ops.map(opKey)).toEqual(['move:style', 'move:task', 'move:jailbreak']);
        expect(result.orphaned.map(opKey)).toEqual(['move:nsfw']);
        const renamed: LayerBody = {
            prompts: [own('first', 'Main text', { name: 'Main Prompt' }), own('style', 'S')],
            prompt_order: [
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'first', enabled: true },
                        { identifier: 'style', enabled: true },
                    ],
                },
            ],
        };
        const before = transferOps(
            [
                { op: 'move', identifier: 'style', anchor: { kind: 'before', identifier: 'main' } },
                { op: 'add', prompt: own('n', 'N'), anchor: { kind: 'before', identifier: 'task' }, enabled: true },
                { op: 'add', prompt: own('m', 'M'), anchor: { kind: 'before', identifier: 'gone' }, enabled: true },
            ],
            source,
            renamed,
        );
        expect(before.ops[0]).toMatchObject({ anchor: { kind: 'before', identifier: 'first' } });
        expect(before.ops[1]).toMatchObject({ anchor: { kind: 'after', identifier: 'first' } });
        expect(before.ops[2]).toMatchObject({ anchor: { kind: 'end' }, enabled: false });
        const startOf = transferOps(
            [{ op: 'add', prompt: own('s', 'S'), anchor: { kind: 'before', identifier: 'main' }, enabled: true }],
            source,
            {
                prompts: [own('x', 'X')],
                prompt_order: [{ character_id: 100001, order: [{ identifier: 'x', enabled: true }] }],
            },
        );
        expect(startOf.ops[0]).toMatchObject({ anchor: { kind: 'start' } });
    });

    it('prefers a unique text anchor and works without the source body', () => {
        const target: LayerBody = {
            prompts: [own('p', 'Write well.\nend'), own('q', 'Write well.\n</task>')],
            prompt_order: [
                {
                    character_id: 100001,
                    order: [
                        { identifier: 'p', enabled: true },
                        { identifier: 'q', enabled: true },
                    ],
                },
            ],
        };
        const result = transferOps([ops[0] as LayerOp], source, target);
        expect(result.ops[0]).toMatchObject({ anchor: { kind: 'afterText', text: '</task>' } });
        const shared: LayerBody = {
            ...target,
            prompts: [own('p', 'Write well.\nx'), own('q', 'Write well.\ny')],
        };
        const sourceShared: LayerBody = { ...baseBody(), prompts: [own('task', 'Write well.')] };
        expect(transferOps([ops[0] as LayerOp], sourceShared, shared).ops[0]).toMatchObject({
            anchor: { kind: 'afterText', text: 'Write well.' },
        });
        expect(transferOps([ops[0] as LayerOp], null, target).orphaned).toHaveLength(1);
    });
});

describe('splitForeign (п.6)', () => {
    it('splits a foreign preset into own blocks, in its order, without markers and empty defaults', () => {
        const foreign: LayerBody = {
            prompts: [
                { identifier: 'main', name: 'Main Prompt', system_prompt: true, content: 'Foreign main' },
                { identifier: 'nsfw', name: 'Aux', system_prompt: true, content: '  ' },
                { identifier: 'jailbreak', name: 'PHI', system_prompt: true, content: '' },
                { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
                { identifier: 'worldInfoAfter', name: 'WI' },
                {
                    identifier: 'auto',
                    name: 'Autonomy',
                    role: 'assistant',
                    content: 'Act',
                    injection_depth: '1',
                } as unknown as LayerPrompt,
                { identifier: 'loose', name: 'Loose', content: 'Not ordered', marker: false },
                { identifier: 'odd', name: 'Odd', content: 'x', marker: true },
            ],
            prompt_order: [
                {
                    character_id: 100000,
                    order: [
                        { identifier: 'auto', enabled: true },
                        { identifier: 'main', enabled: true },
                        { identifier: 'chatHistory', enabled: true },
                    ],
                },
            ],
        };
        const blocks = splitForeign(foreign);
        expect(blocks.map((block) => block.identifier)).toEqual(['auto', 'main', 'loose']);
        expect(blocks[0]).toMatchObject({
            name: 'Autonomy',
            role: 'assistant',
            injection_depth: 1,
            system_prompt: false,
        });
        expect(blocks[1]).toMatchObject({ name: 'Main Prompt', system_prompt: false, marker: false });
    });

    it('uses the global list first, the first list otherwise, and survives junk', () => {
        const global: LayerBody = {
            prompts: [own('a', 'A'), own('b', 'B')],
            prompt_order: [
                { character_id: 7, order: [{ identifier: 'a', enabled: true }] },
                { character_id: 100001, order: [{ identifier: 'b', enabled: true }] },
            ],
        };
        expect(splitForeign(global).map((block) => block.identifier)).toEqual(['b', 'a']);
        const other: LayerBody = {
            prompts: [own('a', 'A'), own('b', 'B')],
            prompt_order: [{ character_id: 7, order: [{ identifier: 'b', enabled: true }, 'junk'] as never }],
        };
        expect(splitForeign(other).map((block) => block.identifier)).toEqual(['b', 'a']);
        expect(splitForeign({ prompts: [own('a', 'A')], prompt_order: [{ character_id: 7 }] as never })).toHaveLength(
            1,
        );
        expect(splitForeign(null as unknown as LayerBody)).toEqual([]);
        expect(splitForeign({})).toEqual([]);
    });
});
