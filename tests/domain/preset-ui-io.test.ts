import { describe, expect, it } from 'vitest';
import {
    buildPromptListExport,
    parsePresetBody,
    parsePromptList,
    planPromptListImport,
    promptListFileName,
} from '../../src/domain/preset-ui-io';

describe('prompt-list import (P-031)', () => {
    it('validates the shape like PM', () => {
        expect(parsePromptList('{')).toEqual({ ok: false, reason: 'json' });
        expect(parsePromptList('[]')).toEqual({ ok: false, reason: 'shape' });
        expect(parsePromptList('{"version":"1","type":"full","data":{"prompts":[]}}')).toEqual({
            ok: false,
            reason: 'shape',
        });
        expect(parsePromptList('{"version":1,"type":"full"}')).toEqual({ ok: false, reason: 'shape' });
        expect(parsePromptList('{"version":1,"type":"full","data":{"prompts":null}}')).toEqual({
            ok: false,
            reason: 'shape',
        });
        const parsed = parsePromptList(
            JSON.stringify({
                version: 1,
                type: 'full',
                data: { prompts: { a: { identifier: 'a' }, b: { name: 'no id' }, c: 'junk' } },
            }),
        );
        expect(parsed.ok && parsed.file.data.prompts.map((prompt) => prompt.identifier)).toEqual(['a']);
    });

    it('plans updates, additions and the order (the imported block wins)', () => {
        const parsed = parsePromptList(
            JSON.stringify({
                version: 1,
                type: 'full',
                data: {
                    prompts: [
                        {
                            identifier: 'style',
                            name: 'Style',
                            content: 'New text',
                            system_prompt: false,
                            marker: false,
                        },
                        { identifier: 'style', name: 'Duplicate', content: 'ignored' },
                        {
                            identifier: 'same',
                            name: 'Same',
                            content: 'x',
                            role: 'system',
                            system_prompt: false,
                            marker: false,
                        },
                        { identifier: 'fresh', content: 'Fresh', injection_depth: '3' },
                        { identifier: 'main', name: 'Main Prompt', content: 'Main' },
                    ],
                    prompt_order: [{ identifier: 'fresh', enabled: true }],
                },
            }),
        );
        if (!parsed.ok) throw new Error('parse');
        const plan = planPromptListImport(
            [
                {
                    identifier: 'style',
                    name: 'Style',
                    content: 'Old',
                    role: 'system',
                    system_prompt: false,
                    marker: false,
                },
                { identifier: 'same', name: 'Same', content: 'x', role: 'system', system_prompt: false, marker: false },
                { identifier: 'main', name: 'Main Prompt', content: 'Main', system_prompt: true },
            ],
            [
                { identifier: 'main', enabled: true },
                { identifier: 'style', enabled: true },
            ],
            parsed.file,
        );
        expect(plan.update).toEqual([{ identifier: 'style', patch: { content: 'New text' } }]);
        expect(plan.add).toEqual([
            {
                identifier: 'fresh',
                name: 'fresh',
                role: 'system',
                content: 'Fresh',
                injection_depth: 3,
                system_prompt: false,
                marker: false,
            },
        ]);
        expect(plan.order).toEqual([
            { identifier: 'fresh', enabled: true },
            { identifier: 'style', enabled: true },
        ]);
        const noOrder = parsePromptList('{"version":1,"type":"full","data":{"prompts":[]}}');
        if (!noOrder.ok) throw new Error('parse');
        expect(planPromptListImport([], [], noOrder.file).order).toBeNull();
    });
});

describe('prompt-list export (P-032)', () => {
    it('exports user blocks and the whole order', () => {
        const file = buildPromptListExport(
            [
                { identifier: 'main', system_prompt: true },
                { identifier: 'chatHistory', system_prompt: true, marker: true },
                { identifier: 'mine', name: 'Mine', content: 'x', system_prompt: false },
                { identifier: 'legacy', system_prompt: undefined },
            ],
            [
                { identifier: 'main', enabled: true },
                { identifier: 'mine', enabled: false },
            ],
        );
        expect(file).toEqual({
            version: 1,
            type: 'full',
            data: {
                prompts: [
                    {
                        identifier: 'mine',
                        name: 'Mine',
                        role: 'system',
                        content: 'x',
                        system_prompt: false,
                        marker: false,
                    },
                ],
                prompt_order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'mine', enabled: false },
                ],
            },
        });
        expect(promptListFileName(new Date(2026, 9, 4))).toBe('st-prompts-10_04_2026.json');
        expect(promptListFileName(new Date(2026, 0, 15), 'x')).toBe('x-01_15_2026.json');
    });

    it('reads a foreign preset body', () => {
        expect(parsePresetBody('{"prompts":[]}')).toEqual({ prompts: [] });
        expect(parsePresetBody('[1]')).toBeNull();
        expect(parsePresetBody('nope')).toBeNull();
    });
});
