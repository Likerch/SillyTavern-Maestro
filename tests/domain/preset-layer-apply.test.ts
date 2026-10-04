import { describe, expect, it } from 'vitest';
import {
    anchorIndex,
    applyLayer,
    DEFAULT_ORDER,
    effectiveOrder,
    findPrompt,
    globalOrder,
    normalizeOwnBlock,
    normalizePatch,
    normalizeRole,
    promptsOf,
    stripLayer,
    textHash,
} from '../../src/domain/preset-layer-apply';
import type { LayerBody, LayerOp, LayerPrompt } from '../../src/domain/preset-layer-apply';
import { withOrigins } from '../../src/domain/preset-layer-ops';
import { baseBody, entry, ids, own } from './preset-layer-fixtures';

describe('applyLayer: add', () => {
    it('places an own block by identifier, before, text, start and end anchors', () => {
        const ops: LayerOp[] = [
            { op: 'add', prompt: own('a', 'A'), anchor: { kind: 'after', identifier: 'task' }, enabled: true },
            { op: 'add', prompt: own('b', 'B'), anchor: { kind: 'before', identifier: 'chatHistory' }, enabled: true },
            { op: 'add', prompt: own('c', 'C'), anchor: { kind: 'afterText', text: '</task>' }, enabled: false },
            { op: 'add', prompt: own('d', 'D'), anchor: { kind: 'start' }, enabled: true },
            { op: 'add', prompt: own('e', 'E'), anchor: { kind: 'end' }, enabled: true },
        ];
        const { body, report } = applyLayer(baseBody(), ops);
        expect(report).toEqual({ applied: 5, conflicts: [], orphaned: [] });
        expect(ids(body)).toEqual([
            'd',
            'main',
            'task',
            'c',
            'a',
            'style',
            'nsfw',
            'b',
            'chatHistory',
            'jailbreak',
            'e',
        ]);
        expect(entry(body, 'c')?.enabled).toBe(false);
        expect(findPrompt(body, 'a')?.content).toBe('A');
    });

    it('writes own blocks with the strict types ST needs', () => {
        const prompt = {
            identifier: 'x',
            name: '',
            role: 'narrator',
            content: 'Text',
            system_prompt: true,
            marker: true,
            injection_position: '1',
            injection_depth: '2',
            injection_order: 'soon',
            injection_trigger: ['normal', 5, 'swipe'],
            enabled: true,
            extension: true,
            position: 'start',
            custom: { keep: 1 },
        } as unknown as LayerPrompt;
        const { body } = applyLayer(baseBody(), [{ op: 'add', prompt, anchor: { kind: 'end' }, enabled: true }]);
        expect(findPrompt(body, 'x')).toEqual({
            identifier: 'x',
            name: 'x',
            role: 'system',
            content: 'Text',
            system_prompt: false,
            marker: false,
            injection_position: 1,
            injection_depth: 2,
            injection_order: 100,
            injection_trigger: ['normal', 'swipe'],
            forbid_overrides: false,
            custom: { keep: 1 },
        });
    });

    it('keeps a block with a lost anchor switched off at the end and reports it', () => {
        const op: LayerOp = {
            op: 'add',
            prompt: own('a', 'A'),
            anchor: { kind: 'after', identifier: 'gone' },
            enabled: true,
        };
        const { body, report } = applyLayer(baseBody(), [op]);
        expect(report.orphaned).toEqual([op]);
        expect(ids(body).at(-1)).toBe('a');
        expect(entry(body, 'a')?.enabled).toBe(false);
    });

    it('cannot add to a preset without prompts (ST keeps the previous blocks then)', () => {
        const base: LayerBody = { temperature: 1 };
        const op: LayerOp = { op: 'add', prompt: own('a', 'A'), anchor: { kind: 'end' }, enabled: true };
        const { body, report } = applyLayer(base, [op]);
        expect(report.orphaned).toEqual([op]);
        expect(body.prompts).toBeUndefined();
        expect(body.prompt_order).toBeUndefined();
    });

    it('is idempotent on a base that already holds the block (a baked layer)', () => {
        const ops: LayerOp[] = [
            { op: 'add', prompt: own('a', 'A'), anchor: { kind: 'after', identifier: 'task' }, enabled: true },
        ];
        const once = applyLayer(baseBody(), ops).body;
        const twice = applyLayer(once, ops);
        expect(twice.report).toEqual({ applied: 1, conflicts: [], orphaned: [] });
        expect(ids(twice.body)).toEqual(ids(once));
        expect(promptsOf(twice.body).filter((prompt) => prompt.identifier === 'a')).toHaveLength(1);
    });

    it('refreshes the fields of a baked own block and orders it when the entry is missing', () => {
        const base = baseBody();
        base.prompts?.push({ identifier: 'a', name: 'a', content: 'A', system_prompt: false, injection_depth: 9 });
        const op: LayerOp = {
            op: 'add',
            prompt: own('a', 'A', { injection_depth: 2 }),
            anchor: { kind: 'after', identifier: 'main' },
            enabled: true,
        };
        const { body, report } = applyLayer(base, [op]);
        expect(report.conflicts).toEqual([]);
        expect(findPrompt(body, 'a')?.injection_depth).toBe(2);
        expect(ids(body).slice(0, 2)).toEqual(['main', 'a']);
    });

    it('reports a base block under the same identifier as a conflict and keeps it', () => {
        const op: LayerOp = { op: 'add', prompt: own('task', 'Mine'), anchor: { kind: 'end' }, enabled: true };
        const { body, report } = applyLayer(baseBody(), [op]);
        expect(report.conflicts).toEqual([
            { identifier: 'task', oldBase: '', newBase: '<task>\nWrite well.\n</task>', mine: 'Mine' },
        ]);
        expect(findPrompt(body, 'task')?.content).toBe('<task>\nWrite well.\n</task>');
    });
});

describe('applyLayer: edit', () => {
    it('changes a base block whose text matches the fingerprint', () => {
        const op: LayerOp = {
            op: 'edit',
            identifier: 'main',
            patch: { content: 'My main', injection_depth: '3' as unknown as number },
            baseHash: textHash('Main text'),
            baseText: 'Main text',
        };
        const { body, report } = applyLayer(baseBody(), [op]);
        expect(report.applied).toBe(1);
        expect(findPrompt(body, 'main')).toMatchObject({ content: 'My main', injection_depth: 3, system_prompt: true });
    });

    it('gives a three-version conflict when the base text changed, keeping the base text', () => {
        const op: LayerOp = {
            op: 'edit',
            identifier: 'main',
            patch: { content: 'My main', role: 'user' },
            baseHash: textHash('Old main'),
            baseText: 'Old main',
        };
        const { body, report } = applyLayer(baseBody(), [op]);
        expect(report.applied).toBe(0);
        expect(report.conflicts).toEqual([
            { identifier: 'main', oldBase: 'Old main', newBase: 'Main text', mine: 'My main' },
        ]);
        expect(findPrompt(body, 'main')).toMatchObject({ content: 'Main text', role: 'user' });
    });

    it('keeps a missing base content missing on conflict', () => {
        const base = baseBody();
        const op: LayerOp = { op: 'edit', identifier: 'chatHistory', patch: { content: 'x' }, baseHash: 'nope' };
        // Markers never take a text from the layer.
        const marker = applyLayer(base, [op]);
        expect(marker.report.conflicts).toEqual([]);
        expect(findPrompt(marker.body, 'chatHistory')?.content).toBeUndefined();
        base.prompts?.push({ identifier: 'empty', name: 'Empty' });
        const missing = applyLayer(base, [{ ...op, identifier: 'empty' }]);
        expect(missing.report.conflicts).toHaveLength(1);
        expect(findPrompt(missing.body, 'empty')).toEqual({ identifier: 'empty', name: 'Empty' });
    });

    it('sees an edit the base already holds as applied, not as a conflict', () => {
        const base = baseBody();
        const main = findPrompt(base, 'main');
        if (main) main.content = 'My main';
        const op: LayerOp = {
            op: 'edit',
            identifier: 'main',
            patch: { content: 'My main' },
            baseHash: textHash('Main text'),
        };
        expect(applyLayer(base, [op]).report).toEqual({ applied: 1, conflicts: [], orphaned: [] });
    });

    it('reports an edit of a block the base does not have', () => {
        const op: LayerOp = { op: 'edit', identifier: 'gone', patch: { content: 'x' }, baseHash: '' };
        expect(applyLayer(baseBody(), [op]).report.orphaned).toEqual([op]);
        expect(applyLayer({}, [op]).report.orphaned).toEqual([op]);
    });

    it('changes the role and depth of a marker but not its text', () => {
        const op: LayerOp = {
            op: 'edit',
            identifier: 'chatHistory',
            patch: { role: 'user', content: 'ignored' },
            baseHash: textHash(''),
        };
        const { body } = applyLayer(baseBody(), [op]);
        expect(findPrompt(body, 'chatHistory')).toEqual({
            identifier: 'chatHistory',
            name: 'Chat History',
            system_prompt: true,
            marker: true,
            role: 'user',
        });
    });
});

describe('applyLayer: toggle, move, key', () => {
    it('toggles an order entry and reports an unknown one', () => {
        const ops: LayerOp[] = [
            { op: 'toggle', identifier: 'nsfw', enabled: true },
            { op: 'toggle', identifier: 'task', enabled: true },
            { op: 'toggle', identifier: 'gone', enabled: true },
        ];
        const { body, report } = applyLayer(baseBody(), ops);
        expect(entry(body, 'nsfw')?.enabled).toBe(true);
        expect(report.applied).toBe(2);
        expect(report.orphaned).toEqual([ops[2]]);
        expect(applyLayer({}, [ops[0] as LayerOp]).report.orphaned).toHaveLength(1);
    });

    it('moves a block, keeps the order when the anchor is lost, and orders a detached block', () => {
        const ops: LayerOp[] = [
            { op: 'move', identifier: 'style', anchor: { kind: 'start' } },
            { op: 'move', identifier: 'task', anchor: { kind: 'after', identifier: 'gone' } },
            { op: 'move', identifier: 'gone', anchor: { kind: 'start' } },
            { op: 'move', identifier: 'spare', anchor: { kind: 'after', identifier: 'main' } },
            { op: 'move', identifier: 'main', anchor: { kind: 'after', identifier: 'style' } },
        ];
        const { body, report } = applyLayer(baseBody(), ops);
        expect(ids(body)).toEqual(['style', 'main', 'spare', 'task', 'nsfw', 'chatHistory', 'jailbreak']);
        expect(entry(body, 'spare')?.enabled).toBe(false);
        expect(report.orphaned).toEqual([ops[1], ops[2]]);
        expect(applyLayer({}, [ops[0] as LayerOp]).report.orphaned).toHaveLength(1);
    });

    it('overrides body keys by preset key names and never touches the reserved ones', () => {
        const ops: LayerOp[] = [
            { op: 'key', key: 'temperature', value: 0.7 },
            { op: 'key', key: 'top_p', value: 0.9 },
            { op: 'key', key: 'reasoning_effort', value: 'high' },
            { op: 'key', key: 'prompts', value: [] },
            { op: 'key', key: '', value: 1 },
        ];
        const base = baseBody();
        const { body, report } = applyLayer(base, ops);
        expect(body).toMatchObject({ temperature: 0.7, top_p: 0.9, reasoning_effort: 'high' });
        expect(body.prompts).toBe(base.prompts);
        expect(report.applied).toBe(3);
        expect(report.orphaned).toHaveLength(2);
    });
});

describe('applyLayer: the order list', () => {
    it('creates 100001 from 100000 when the preset has no global list', () => {
        const base: LayerBody = {
            prompts: [{ identifier: 'main', name: 'Main', content: 'M' }],
            prompt_order: [
                {
                    character_id: 100000,
                    order: [
                        { identifier: 'main', enabled: true },
                        { identifier: 'chatHistory', enabled: true },
                    ],
                },
            ],
        };
        const { body } = applyLayer(base, [
            { op: 'add', prompt: own('a', 'A'), anchor: { kind: 'after', identifier: 'main' }, enabled: true },
        ]);
        expect(body.prompt_order).toHaveLength(2);
        expect(body.prompt_order?.[0]).toBe(base.prompt_order?.[0]);
        expect(globalOrder(body)?.map((item) => item.identifier)).toEqual(['main', 'a', 'chatHistory']);
    });

    it('uses ST default order when neither list exists, and only for ops that need the order', () => {
        const base: LayerBody = { prompts: [{ identifier: 'main', name: 'Main', content: 'M' }] };
        expect(applyLayer(base, [{ op: 'key', key: 'temperature', value: 1 }]).body.prompt_order).toBeUndefined();
        const { body } = applyLayer(base, [{ op: 'toggle', identifier: 'enhanceDefinitions', enabled: true }]);
        expect(globalOrder(body)?.map((item) => item.identifier)).toEqual(DEFAULT_ORDER.map((item) => item.identifier));
        expect(globalOrder(body)?.find((item) => item.identifier === 'enhanceDefinitions')?.enabled).toBe(true);
    });

    it('works on a global list with an empty order (ST adds a second one later)', () => {
        const base: LayerBody = { prompts: [], prompt_order: [{ character_id: 100001, order: [] }] };
        const { body } = applyLayer(base, [
            { op: 'add', prompt: own('a', 'A'), anchor: { kind: 'start' }, enabled: true },
        ]);
        expect(body.prompt_order).toEqual([{ character_id: 100001, order: [{ identifier: 'a', enabled: true }] }]);
    });
});

describe('applyLayer: copies', () => {
    it('never changes the base and gives fresh arrays only for what changed', () => {
        const base = baseBody();
        const before = JSON.stringify(base);
        const ops: LayerOp[] = [
            { op: 'add', prompt: own('a', 'A'), anchor: { kind: 'end' }, enabled: true },
            { op: 'toggle', identifier: 'nsfw', enabled: true },
        ];
        const { body } = applyLayer(base, ops);
        expect(JSON.stringify(base)).toBe(before);
        expect(body).not.toBe(base);
        expect(body.prompts).not.toBe(base.prompts);
        expect(body.prompt_order).not.toBe(base.prompt_order);
        expect(findPrompt(body, 'main')).toBe(findPrompt(base, 'main'));
        expect(body.prompt_order?.[0]).toBe(base.prompt_order?.[0]);
        expect(body.extensions).toBe(base.extensions);
        const keysOnly = applyLayer(base, [{ op: 'key', key: 'temperature', value: 2 }]).body;
        expect(keysOnly.prompts).toBe(base.prompts);
        expect(keysOnly.prompt_order).toBe(base.prompt_order);
    });

    it('skips entries without an identifier', () => {
        const base = baseBody();
        (base.prompts as unknown[]).push(null, { name: 'no id' });
        (base.prompt_order?.[1]?.order as unknown[]).push({ enabled: true });
        const { body, report } = applyLayer(base, [{ op: 'toggle', identifier: 'nsfw', enabled: true }]);
        expect(report.applied).toBe(1);
        expect(promptsOf(body)).toHaveLength(7);
    });
});

describe('stripLayer', () => {
    function layered(): { base: LayerBody; ops: LayerOp[] } {
        const base = baseBody();
        const raw: LayerOp[] = [
            { op: 'add', prompt: own('a', 'A'), anchor: { kind: 'after', identifier: 'task' }, enabled: true },
            {
                op: 'edit',
                identifier: 'main',
                patch: { content: 'My main', injection_position: 1, injection_depth: 2 },
                baseHash: '',
            },
            { op: 'edit', identifier: 'style', patch: { injection_position: 1 }, baseHash: '' },
            { op: 'toggle', identifier: 'nsfw', enabled: true },
            { op: 'move', identifier: 'jailbreak', anchor: { kind: 'after', identifier: 'main' } },
            { op: 'move', identifier: 'spare', anchor: { kind: 'before', identifier: 'chatHistory' } },
            { op: 'key', key: 'temperature', value: 0.5 },
            { op: 'key', key: 'reasoning_effort', value: 'low' },
        ];
        return { base, ops: raw.map((op) => withOrigins(op, base)) };
    }

    it('round-trips: apply then strip gives the base back', () => {
        const { base, ops } = layered();
        const { body, report } = applyLayer(base, ops);
        expect(report.conflicts).toEqual([]);
        expect(stripLayer(body, ops)).toEqual(base);
    });

    it('brings back several moved blocks whose base neighbours moved too', () => {
        const base: LayerBody = {
            prompts: ['A', 'B', 'C', 'D'].map((id) => own(id, id)),
            prompt_order: [
                { character_id: 100001, order: ['A', 'B', 'C', 'D'].map((id) => ({ identifier: id, enabled: true })) },
            ],
        };
        const ops = (
            [
                { op: 'move', identifier: 'D', anchor: { kind: 'after', identifier: 'A' } },
                { op: 'move', identifier: 'B', anchor: { kind: 'after', identifier: 'C' } },
            ] as LayerOp[]
        ).map((op) => withOrigins(op, base));
        const { body } = applyLayer(base, ops);
        expect(ids(body)).toEqual(['A', 'D', 'C', 'B']);
        expect(stripLayer(body, ops)).toEqual(base);
    });

    it('keeps what no longer holds the layer value (a conflict, a draft)', () => {
        const { base, ops } = layered();
        const { body } = applyLayer(base, ops);
        const main = findPrompt(body, 'main');
        if (main) main.content = 'Draft text';
        body.temperature = 0.9;
        const stripped = stripLayer(body, ops);
        expect(findPrompt(stripped, 'main')?.content).toBe('Draft text');
        expect(findPrompt(stripped, 'main')?.injection_position).toBeUndefined();
        expect(stripped.temperature).toBe(0.9);
    });

    it('leaves a base block that took the identifier of an own block', () => {
        const op: LayerOp = { op: 'add', prompt: own('task', 'Mine'), anchor: { kind: 'end' }, enabled: true };
        expect(stripLayer(baseBody(), [op])).toEqual(baseBody());
        const system: LayerOp = { op: 'add', prompt: own('main', 'Main text'), anchor: { kind: 'end' }, enabled: true };
        expect(stripLayer(baseBody(), [system])).toEqual(baseBody());
    });

    it('takes a block that was outside the base order out again, and keeps a lost anchor at the end', () => {
        const base = baseBody();
        const ops: LayerOp[] = [
            { op: 'move', identifier: 'spare', anchor: { kind: 'start' }, baseAnchor: null },
            {
                op: 'move',
                identifier: 'task',
                anchor: { kind: 'start' },
                baseAnchor: { kind: 'after', identifier: 'x' },
            },
        ];
        const { body } = applyLayer(base, ops);
        expect(ids(body).slice(0, 2)).toEqual(['task', 'spare']);
        const stripped = stripLayer(body, ops);
        expect(ids(stripped)).toEqual(['main', 'style', 'nsfw', 'chatHistory', 'jailbreak', 'task']);
    });

    it('does nothing without an order or without base values', () => {
        const ops: LayerOp[] = [
            { op: 'toggle', identifier: 'nsfw', enabled: true, baseEnabled: false },
            { op: 'move', identifier: 'task', anchor: { kind: 'start' }, baseAnchor: { kind: 'start' } },
            { op: 'toggle', identifier: 'task', enabled: false },
            { op: 'edit', identifier: 'gone', patch: { content: 'x' }, baseHash: '' },
            { op: 'edit', identifier: 'main', patch: { name: 'Main Prompt' }, baseHash: '' },
            { op: 'key', key: 'top_p', value: 0.9 },
        ];
        const body: LayerBody = { prompts: [own('main', 'M', { name: 'Main Prompt' })] };
        expect(stripLayer(body, ops)).toEqual(body);
        expect(stripLayer(baseBody(), ops.slice(2))).toEqual(baseBody());
    });
});

describe('helpers', () => {
    it('normalises patches for base blocks', () => {
        expect(
            normalizePatch({
                identifier: 'x',
                system_prompt: false,
                marker: true,
                enabled: true,
                role: 'robot',
                content: 5,
                injection_position: '1',
                injection_depth: 'deep',
                injection_order: '50',
                injection_trigger: 'normal',
                forbid_overrides: 1,
            } as unknown as Partial<LayerPrompt>),
        ).toEqual({
            role: 'system',
            content: '5',
            injection_position: 1,
            injection_order: 50,
            injection_trigger: [],
            forbid_overrides: false,
        });
        expect(normalizePatch(null as unknown as Partial<LayerPrompt>)).toEqual({});
        expect(normalizePatch({ content: null, injection_position: 0 } as unknown as Partial<LayerPrompt>)).toEqual({
            content: '',
            injection_position: 0,
        });
    });

    it('normalises roles and own-block names', () => {
        expect(normalizeRole('assistant')).toBe('assistant');
        expect(normalizeRole(undefined)).toBe('system');
        expect(normalizeOwnBlock({ identifier: 'z', name: 'Zed', injection_depth: -3 } as LayerPrompt)).toMatchObject({
            name: 'Zed',
            content: '',
            injection_depth: 4,
        });
    });

    it('resolves anchors', () => {
        const order = [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
        ];
        const content = (id: string) => (id === 'b' ? 'has </task> in it' : '');
        expect(anchorIndex(order, { kind: 'afterText', text: '</task>' }, content)).toBe(2);
        expect(anchorIndex(order, { kind: 'afterText', text: '' }, content)).toBe(-1);
        expect(anchorIndex(order, { kind: 'afterText', text: 'none' }, content)).toBe(-1);
        expect(anchorIndex(order, { kind: 'before', identifier: 'b' }, content)).toBe(1);
        expect(anchorIndex(order, { kind: 'after', identifier: 'x' }, content)).toBe(-1);
        expect(anchorIndex(order, { kind: 'odd' } as never, content)).toBe(-1);
    });

    it('hashes texts independently of line endings', () => {
        expect(textHash('a\r\nb')).toBe(textHash('a\nb'));
        expect(textHash('a')).not.toBe(textHash('b'));
    });

    it('reads orders and prompts defensively', () => {
        expect(promptsOf(null)).toEqual([]);
        expect(effectiveOrder({ prompt_order: [{ character_id: 100000, order: [] }] })).toHaveLength(12);
        expect(globalOrder({})).toBeNull();
        expect(findPrompt(baseBody(), 'nope')).toBeUndefined();
    });

    it('ignores unknown op kinds', () => {
        const op = { op: 'rename', identifier: 'main' } as unknown as LayerOp;
        expect(applyLayer(baseBody(), [op]).report.orphaned).toEqual([op]);
    });
});
