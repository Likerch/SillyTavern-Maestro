import { describe, expect, it } from 'vitest';
import { MASKED, comparePresets, sameBodies } from '../../src/domain/preset-compare';
import type { LayerBody } from '../../src/domain/preset-layer-apply';
import { baseBody } from './preset-layer-fixtures';

describe('comparePresets', () => {
    it('finds nothing between a body and its copy', () => {
        const result = comparePresets(baseBody(), baseBody());
        expect(sameBodies(result)).toBe(true);
    });

    it('lists added, removed and changed blocks, switched blocks, the order and the parameters', () => {
        const a = baseBody();
        const b = structuredClone(a) as LayerBody;
        const prompts = b.prompts ?? [];
        prompts[0] = { ...prompts[0]!, content: 'Main text, new', role: 'user' };
        b.prompts = [
            ...prompts.filter((prompt) => prompt.identifier !== 'style'),
            { identifier: 'fresh', name: 'Fresh', content: 'New block' },
        ];
        const order = b.prompt_order?.[1]?.order ?? [];
        b.prompt_order![1]!.order = [
            { identifier: 'task', enabled: true },
            { identifier: 'main', enabled: true },
            ...order.filter((item) => !['main', 'task', 'style'].includes(item.identifier)),
        ].map((item) => (item.identifier === 'nsfw' ? { ...item, enabled: true } : item));
        b.temperature = 0.5;
        b.reverse_proxy = 'http://secret';
        const result = comparePresets(a, b);
        expect(result.added).toEqual([{ identifier: 'fresh', name: 'Fresh' }]);
        expect(result.removed).toEqual([{ identifier: 'style', name: 'Style' }]);
        expect(result.changed).toEqual([{ identifier: 'main', name: 'Main Prompt', fields: ['role', 'content'] }]);
        expect(result.toggled).toEqual([
            { identifier: 'style', name: 'Style', a: true, b: null },
            { identifier: 'nsfw', name: 'Auxiliary Prompt', a: false, b: true },
        ]);
        expect(result.reordered).toBe(true);
        expect(result.params).toEqual([
            { key: 'reverse_proxy', a: null, b: MASKED },
            { key: 'temperature', a: 1, b: 0.5 },
        ]);
        expect(sameBodies(result)).toBe(false);
    });

    it('counts a missing field and its default as equal', () => {
        const a = baseBody();
        const b = structuredClone(a) as LayerBody;
        b.prompts![4] = { ...b.prompts![4]!, injection_depth: 4, injection_order: 100, injection_trigger: [] };
        expect(comparePresets(a, b).changed).toEqual([]);
    });
});
