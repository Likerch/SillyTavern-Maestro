import { describe, expect, it } from 'vitest';
import { applyLayer, findPrompt, stripLayer, textHash } from '../../src/domain/preset-layer-apply';
import type { AddOp, EditOp, LayerBody, LayerOp, ToggleOp } from '../../src/domain/preset-layer-apply';
import {
    anchorOf,
    baseFingerprint,
    baseMatches,
    isValidAnchor,
    layerFingerprint,
    layerView,
    mergeOp,
    opKey,
    pruneOp,
    resolveOp,
    sanitizeOps,
    setOpAt,
    validateOp,
    withOrigins,
} from '../../src/domain/preset-layer-ops';
import { baseBody, own } from './preset-layer-fixtures';

const add = (id: string, content: string): AddOp => ({
    op: 'add',
    prompt: own(id, content),
    anchor: { kind: 'after', identifier: 'task' },
    enabled: true,
});

describe('opKey and validation', () => {
    it('keys one op per block and kind', () => {
        expect(opKey(add('a', 'A'))).toBe('add:a');
        expect(opKey({ op: 'edit', identifier: 'main', patch: {}, baseHash: '' })).toBe('edit:main');
        expect(opKey({ op: 'toggle', identifier: 'nsfw', enabled: true })).toBe('toggle:nsfw');
        expect(opKey({ op: 'move', identifier: 'x', anchor: { kind: 'end' } })).toBe('move:x');
        expect(opKey({ op: 'key', key: 'temperature', value: 1 })).toBe('key:temperature');
    });

    it('accepts well-formed ops', () => {
        const ops: unknown[] = [
            add('a', 'A'),
            { op: 'add', prompt: { name: 'no id yet' }, anchor: { kind: 'start' }, enabled: false },
            { op: 'edit', identifier: 'main', patch: { content: 'x', identifier: 'main' }, baseHash: '' },
            { op: 'toggle', identifier: 'chatHistory', enabled: true },
            { op: 'move', identifier: 'main', anchor: { kind: 'afterText', text: '</task>' } },
            { op: 'key', key: 'temperature', value: 0.5 },
        ];
        for (const op of ops) expect(validateOp(op)).toBeNull();
    });

    it('rejects malformed ops with a reason', () => {
        const cases: [unknown, string][] = [
            [null, 'not an object'],
            [{ op: 'drop' }, 'unknown op'],
            [{ op: 'add', anchor: { kind: 'end' }, enabled: true }, 'prompt missing'],
            [{ op: 'add', prompt: { identifier: 5 }, anchor: { kind: 'end' }, enabled: true }, 'must be a string'],
            [{ op: 'add', prompt: { identifier: 'chatHistory' }, anchor: { kind: 'end' }, enabled: true }, 'marker'],
            [{ op: 'add', prompt: { identifier: 'a' }, anchor: { kind: 'after' }, enabled: true }, 'invalid anchor'],
            [
                { op: 'add', prompt: { identifier: 'a' }, anchor: { kind: 'afterText', text: '' }, enabled: true },
                'anchor',
            ],
            [{ op: 'add', prompt: { identifier: 'a' }, anchor: { kind: 'up' }, enabled: true }, 'anchor'],
            [{ op: 'add', prompt: { identifier: 'a' }, anchor: { kind: 'end' }, enabled: 'yes' }, 'boolean'],
            [{ op: 'edit', patch: {}, baseHash: '' }, 'identifier missing'],
            [{ op: 'edit', identifier: 'main', baseHash: '' }, 'patch missing'],
            [{ op: 'edit', identifier: 'main', patch: { identifier: 'other' }, baseHash: '' }, 'cannot change'],
            [{ op: 'edit', identifier: 'main', patch: {} }, 'baseHash'],
            [{ op: 'toggle', enabled: true }, 'identifier missing'],
            [{ op: 'toggle', identifier: 'nsfw', enabled: 1 }, 'boolean'],
            [{ op: 'toggle', identifier: 'chatHistory', enabled: false }, 'chatHistory'],
            [{ op: 'move', anchor: { kind: 'end' } }, 'identifier missing'],
            [{ op: 'move', identifier: 'main', anchor: null }, 'invalid anchor'],
            [{ op: 'key', value: 1 }, 'key missing'],
            [{ op: 'key', key: 'prompt_order', value: [] }, 'not a key override'],
            [{ op: 'key', key: 'proxy_password', value: 'x' }, 'never stored'],
            [{ op: 'key', key: 'temperature' }, 'not JSON'],
            [{ op: 'key', key: 'temperature', value: () => 1 }, 'not JSON'],
            [{ op: 'key', key: 'temperature', value: { big: BigInt(1) } }, 'not JSON'],
        ];
        for (const [op, reason] of cases) expect(validateOp(op)).toContain(reason);
        expect(isValidAnchor({ kind: 'before', identifier: '' })).toBe(false);
    });

    it('keeps valid stored ops only', () => {
        expect(sanitizeOps('nope')).toEqual([]);
        const stored = [
            add('a', 'A'),
            { op: 'add', prompt: { name: 'no id' }, anchor: { kind: 'end' }, enabled: true },
            { op: 'toggle', identifier: 'x' },
            { op: 'key', key: 'temperature', value: 1 },
        ];
        expect(sanitizeOps(stored).map(opKey)).toEqual(['add:a', 'key:temperature']);
    });
});

describe('withOrigins', () => {
    it('fills the text fingerprint and base fields of an edit', () => {
        const op = withOrigins(
            {
                op: 'edit',
                identifier: 'style',
                patch: { content: 'S', injection_position: 1, injection_depth: 2 },
                baseHash: '',
            },
            baseBody(),
        );
        expect(op).toEqual({
            op: 'edit',
            identifier: 'style',
            patch: { content: 'S', injection_position: 1, injection_depth: 2 },
            baseHash: textHash('Style rules'),
            baseText: 'Style rules',
            baseFields: { injection_position: 0 },
            baseMissing: ['injection_depth'],
        });
    });

    it('keeps a given fingerprint and adds the base text only when it matches', () => {
        const matching = withOrigins(
            { op: 'edit', identifier: 'main', patch: { content: 'x' }, baseHash: textHash('Main text') },
            baseBody(),
        ) as EditOp;
        expect(matching.baseText).toBe('Main text');
        const other = withOrigins(
            { op: 'edit', identifier: 'main', patch: { content: 'x' }, baseHash: 'older' },
            baseBody(),
        ) as EditOp;
        expect(other.baseHash).toBe('older');
        expect(other.baseText).toBeUndefined();
        const gone: LayerOp = { op: 'edit', identifier: 'gone', patch: { content: 'x' }, baseHash: '' };
        expect(withOrigins(gone, baseBody())).toEqual(gone);
        expect(withOrigins(gone, null)).toEqual(gone);
    });

    it('reads the base state of toggles, moves and keys', () => {
        const base = baseBody();
        expect(withOrigins({ op: 'toggle', identifier: 'nsfw', enabled: true }, base)).toMatchObject({
            baseEnabled: false,
        });
        expect(withOrigins({ op: 'toggle', identifier: 'gone', enabled: true }, base)).not.toHaveProperty(
            'baseEnabled',
        );
        const move = (identifier: string) => withOrigins({ op: 'move', identifier, anchor: { kind: 'end' } }, base);
        expect(move('task')).toMatchObject({ baseAnchor: { kind: 'after', identifier: 'main' } });
        expect(move('main')).toMatchObject({ baseAnchor: { kind: 'start' } });
        expect(move('spare')).toMatchObject({ baseAnchor: null });
        expect(move('gone')).not.toHaveProperty('baseAnchor');
        expect(withOrigins({ op: 'key', key: 'temperature', value: 2, baseUnset: true }, base)).toEqual({
            op: 'key',
            key: 'temperature',
            value: 2,
            baseValue: 1,
        });
        expect(withOrigins({ op: 'key', key: 'seed', value: 2, baseValue: 5 }, base)).toEqual({
            op: 'key',
            key: 'seed',
            value: 2,
            baseUnset: true,
        });
        expect(withOrigins(add('a', 'A'), base)).toEqual(add('a', 'A'));
    });

    it('anchors a block after its predecessor', () => {
        const order = [
            { identifier: 'a', enabled: true },
            { identifier: 'b', enabled: true },
        ];
        expect(anchorOf(order, 'b')).toEqual({ kind: 'after', identifier: 'a' });
        expect(anchorOf(order, 'a')).toEqual({ kind: 'start' });
        expect(anchorOf(order, 'c')).toBeNull();
    });
});

describe('mergeOp', () => {
    const base = baseBody();
    const edit = (patch: EditOp['patch']) =>
        withOrigins({ op: 'edit', identifier: 'style', patch, baseHash: '' }, base) as EditOp;

    it('appends a new op and merges repeated edits keeping the first base values', () => {
        const first = mergeOp([], edit({ content: 'One' }));
        expect(first).toMatchObject({ key: 'edit:style', index: 0, before: null });
        const changedBase = { ...edit({ injection_depth: 3 }), baseHash: 'later', baseText: 'later text' };
        const second = mergeOp(first.ops, changedBase);
        expect(second.before).toEqual(first.after);
        expect(second.after).toEqual({
            op: 'edit',
            identifier: 'style',
            patch: { content: 'One', injection_depth: 3 },
            baseHash: textHash('Style rules'),
            baseText: 'Style rules',
            baseFields: {},
            baseMissing: ['injection_depth'],
        });
        const third = mergeOp(second.ops, edit({ injection_position: 1 }));
        expect((third.after as EditOp).baseFields).toEqual({ injection_position: 0 });
        expect((third.after as EditOp).baseMissing).toEqual(['injection_depth']);
    });

    it('takes the fingerprint of a later edit when the first had none', () => {
        const blind: EditOp = { op: 'edit', identifier: 'style', patch: { name: 'S' }, baseHash: '' };
        const merged = mergeOp([blind], edit({ content: 'Two' })).after as EditOp;
        expect(merged.baseHash).toBe(textHash('Style rules'));
        expect(merged.baseText).toBe('Style rules');
    });

    it('drops an op that brings the block back to the base', () => {
        const first = mergeOp([], edit({ content: 'One', injection_position: 1 }));
        const back = mergeOp(first.ops, edit({ content: 'Style rules', injection_position: 0 }));
        expect(back).toMatchObject({ ops: [], before: first.after, after: null, index: 0 });
        const toggle = withOrigins({ op: 'toggle', identifier: 'nsfw', enabled: true }, base) as ToggleOp;
        const on = mergeOp([], toggle);
        expect(mergeOp(on.ops, { ...toggle, enabled: false, baseEnabled: true }).ops).toEqual([]);
        const key = withOrigins({ op: 'key', key: 'temperature', value: 2 }, base);
        const set = mergeOp([], key);
        expect(mergeOp(set.ops, withOrigins({ op: 'key', key: 'temperature', value: 1 }, base)).ops).toEqual([]);
        const move = withOrigins({ op: 'move', identifier: 'task', anchor: { kind: 'start' } }, base);
        const moved = mergeOp([], move);
        const home = withOrigins(
            { op: 'move', identifier: 'task', anchor: { kind: 'after', identifier: 'main' } },
            base,
        );
        expect(mergeOp(moved.ops, home).ops).toEqual([]);
    });

    it('ignores a new op that changes nothing', () => {
        const noop = withOrigins({ op: 'toggle', identifier: 'task', enabled: true }, base);
        expect(mergeOp([add('a', 'A')], noop)).toMatchObject({ ops: [add('a', 'A')], before: null, after: null });
    });

    it('folds edits, toggles and moves of an own block into its add op', () => {
        const ops: LayerOp[] = [add('a', 'A')];
        const edited = mergeOp(ops, {
            op: 'edit',
            identifier: 'a',
            patch: { content: 'B', injection_depth: '2' as never },
            baseHash: '',
        });
        expect(edited.key).toBe('add:a');
        expect((edited.after as AddOp).prompt).toMatchObject({ identifier: 'a', content: 'B', injection_depth: 2 });
        const toggled = mergeOp(edited.ops, { op: 'toggle', identifier: 'a', enabled: false });
        expect((toggled.after as AddOp).enabled).toBe(false);
        const moved = mergeOp(toggled.ops, { op: 'move', identifier: 'a', anchor: { kind: 'start' } });
        expect((moved.after as AddOp).anchor).toEqual({ kind: 'start' });
        expect(moved.ops).toHaveLength(1);
        const replaced = mergeOp(moved.ops, add('a', 'C'));
        expect(replaced.after).toEqual(add('a', 'C'));
    });

    it('keeps the base values of toggles, moves and keys', () => {
        const toggle = mergeOp([{ op: 'toggle', identifier: 'x', enabled: true }], {
            op: 'toggle',
            identifier: 'x',
            enabled: false,
        });
        expect(toggle.after).toEqual({ op: 'toggle', identifier: 'x', enabled: false });
        const move = mergeOp([{ op: 'move', identifier: 'x', anchor: { kind: 'start' } }], {
            op: 'move',
            identifier: 'x',
            anchor: { kind: 'end' },
        });
        expect(move.after).toEqual({ op: 'move', identifier: 'x', anchor: { kind: 'end' } });
        const nullAnchor = mergeOp([{ op: 'move', identifier: 'x', anchor: { kind: 'start' }, baseAnchor: null }], {
            op: 'move',
            identifier: 'x',
            anchor: { kind: 'end' },
            baseAnchor: { kind: 'start' },
        });
        expect(nullAnchor.after).toMatchObject({ baseAnchor: null });
        const unset = mergeOp([{ op: 'key', key: 'seed', value: 1, baseUnset: true }], {
            op: 'key',
            key: 'seed',
            value: 2,
            baseValue: 7,
        });
        expect(unset.after).toEqual({ op: 'key', key: 'seed', value: 2, baseUnset: true });
        const plain = mergeOp([{ op: 'key', key: 'seed', value: 1 }], { op: 'key', key: 'seed', value: 2 });
        expect(plain.after).toEqual({ op: 'key', key: 'seed', value: 2 });
    });

    it('puts or removes an op under a key', () => {
        const ops: LayerOp[] = [add('a', 'A'), { op: 'toggle', identifier: 'x', enabled: true }];
        expect(setOpAt(ops, 'add:a', add('a', 'B')).map((op) => (op.op === 'add' ? op.prompt.content : op.op))).toEqual(
            ['B', 'toggle'],
        );
        expect(setOpAt(ops, 'add:a', null).map(opKey)).toEqual(['toggle:x']);
        expect(setOpAt(ops, 'add:b', add('b', 'B'), 0).map(opKey)).toEqual(['add:b', 'add:a', 'toggle:x']);
        expect(setOpAt(ops, 'add:b', add('b', 'B')).map(opKey)).toEqual(['add:a', 'toggle:x', 'add:b']);
    });

    it('prunes only what equals the base', () => {
        expect(pruneOp(add('a', 'A'))).toEqual(add('a', 'A'));
        const partial = pruneOp({
            op: 'edit',
            identifier: 'style',
            patch: { content: 'Style rules', injection_position: 1 },
            baseHash: 'h',
            baseText: 'Style rules',
            baseFields: { injection_position: 0 },
        });
        expect((partial as EditOp).patch).toEqual({ injection_position: 1 });
    });
});

describe('resolveOp', () => {
    const edit: EditOp = {
        op: 'edit',
        identifier: 'main',
        patch: { content: 'Mine', role: 'user' },
        baseHash: textHash('Old'),
        baseText: 'Old',
        baseFields: { role: 'system' },
    };

    it("rebases on 'mine', drops the text on 'newBase', takes a custom text", () => {
        expect(resolveOp(edit, 'mine', 'New')).toEqual({ ...edit, baseHash: textHash('New'), baseText: 'New' });
        expect(resolveOp(edit, 'newBase', 'New')).toEqual({
            ...edit,
            patch: { role: 'user' },
            baseHash: textHash('New'),
            baseText: 'New',
        });
        expect(resolveOp(edit, { text: 'Merged' }, 'New')).toMatchObject({
            patch: { content: 'Merged', role: 'user' },
        });
        expect(resolveOp({ ...edit, patch: { content: 'Mine' } }, 'newBase', 'New')).toBeNull();
        expect(resolveOp({ ...edit, patch: { content: 'Mine' } }, { text: 'New' }, 'New')).toBeNull();
    });

    it('turns a colliding add into an edit of the base block', () => {
        const op = add('task', 'Mine');
        expect(resolveOp(op, 'mine', 'Base')).toEqual({
            op: 'edit',
            identifier: 'task',
            patch: { content: 'Mine' },
            baseHash: textHash('Base'),
            baseText: 'Base',
        });
        expect(resolveOp(op, 'newBase', 'Base')).toBeNull();
        expect(resolveOp(op, { text: 'Both' }, 'Base')).toMatchObject({ patch: { content: 'Both' } });
        const toggle: LayerOp = { op: 'toggle', identifier: 'x', enabled: true };
        expect(resolveOp(toggle, 'mine', 'x')).toBe(toggle);
    });

    it('resolved edits apply cleanly over the new base', () => {
        const base = baseBody();
        const stale: EditOp = { op: 'edit', identifier: 'main', patch: { content: 'Mine' }, baseHash: textHash('Old') };
        expect(applyLayer(base, [stale]).report.conflicts).toHaveLength(1);
        const fixed = resolveOp(stale, 'mine', 'Main text') as LayerOp;
        const { body, report } = applyLayer(base, [fixed]);
        expect(report.conflicts).toEqual([]);
        expect(findPrompt(body, 'main')?.content).toBe('Mine');
    });
});

describe('fingerprints', () => {
    const ops: LayerOp[] = [
        add('a', 'A'),
        withOrigins({ op: 'edit', identifier: 'main', patch: { content: 'Mine' }, baseHash: '' }, baseBody()),
        { op: 'toggle', identifier: 'nsfw', enabled: true },
        { op: 'move', identifier: 'jailbreak', anchor: { kind: 'start' } },
        { op: 'key', key: 'temperature', value: 0.4 },
    ];

    it('match between a working copy holding the layer and apply(base)', () => {
        const expected = applyLayer(baseBody(), ops).body;
        const working = JSON.parse(JSON.stringify(expected)) as LayerBody;
        working.extra_key = 'unrelated';
        (working.prompts as unknown[]).push({ identifier: 'enhanceDefinitions', name: 'Enhance', content: 'x' });
        expect(layerFingerprint(working, ops)).toBe(layerFingerprint(expected, ops));
        expect(layerFingerprint(baseBody(), ops)).not.toBe(layerFingerprint(expected, ops));
        expect(layerView(baseBody(), ops)[0]).toEqual(['add', 'a', null, null, null]);
        expect(layerView(expected, ops)[3]).toEqual(['move', 'jailbreak', '^']);
    });

    it('fingerprint a base without its extensions', () => {
        const base = baseBody();
        const print = baseFingerprint(base);
        expect(baseFingerprint({ ...base, extensions: { regex_scripts: [{ id: 'r' }] } })).toBe(print);
        const changed = baseBody();
        const main = findPrompt(changed, 'main');
        if (main) main.content = 'New main';
        expect(baseFingerprint(changed)).not.toBe(print);
        expect(baseFingerprint({ ...base, prompts: [...(base.prompts ?? [])].reverse() })).toBe(print);
    });

    it('tell whether a body holds the saved base', () => {
        const saved = baseBody();
        const working = applyLayer(saved, ops).body;
        expect(baseMatches(saved, working)).toBe(false);
        expect(
            baseMatches(
                saved,
                stripLayer(
                    working,
                    ops.map((op) => withOrigins(op, saved)),
                ),
            ),
        ).toBe(true);
        const extra = { ...baseBody(), unknown_key: 1 } as LayerBody;
        expect(baseMatches(extra, baseBody())).toBe(true);
        expect(baseMatches(baseBody(), { ...baseBody(), top_p: 0.5 })).toBe(false);
        const missing = baseBody();
        missing.prompts = missing.prompts?.slice(1);
        expect(baseMatches(baseBody(), missing)).toBe(false);
        expect(baseMatches({ prompts: [] }, { prompts: [], prompt_order: [] })).toBe(true);
    });
});
