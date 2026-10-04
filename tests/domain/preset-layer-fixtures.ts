// A small Marinara-like preset body for the «Твой слой» tests.
import { effectiveOrder } from '../../src/domain/preset-layer-apply';
import type { LayerBody, LayerPrompt } from '../../src/domain/preset-layer-apply';

export function baseBody(): LayerBody {
    return {
        temperature: 1,
        top_p: 0.9,
        extensions: { regex_scripts: [] },
        prompts: [
            { identifier: 'main', name: 'Main Prompt', system_prompt: true, role: 'system', content: 'Main text' },
            { identifier: 'nsfw', name: 'Auxiliary Prompt', system_prompt: true, role: 'system', content: '' },
            { identifier: 'chatHistory', name: 'Chat History', system_prompt: true, marker: true },
            { identifier: 'jailbreak', name: 'Post-History', system_prompt: true, role: 'system', content: 'PHI' },
            {
                identifier: 'task',
                name: 'Task',
                system_prompt: false,
                marker: false,
                role: 'system',
                content: '<task>\nWrite well.\n</task>',
            },
            {
                identifier: 'style',
                name: 'Style',
                system_prompt: false,
                marker: false,
                role: 'system',
                content: 'Style rules',
                injection_position: 0,
            },
            {
                identifier: 'spare',
                name: 'Spare',
                system_prompt: false,
                marker: false,
                role: 'user',
                content: 'Detached',
            },
        ],
        prompt_order: [
            { character_id: 100000, order: [{ identifier: 'main', enabled: true }] },
            {
                character_id: 100001,
                order: [
                    { identifier: 'main', enabled: true },
                    { identifier: 'task', enabled: true },
                    { identifier: 'style', enabled: true },
                    { identifier: 'nsfw', enabled: false },
                    { identifier: 'chatHistory', enabled: true },
                    { identifier: 'jailbreak', enabled: true },
                ],
            },
        ],
    };
}

export const ids = (body: LayerBody): string[] => effectiveOrder(body).map((item) => item.identifier);

export const entry = (body: LayerBody, id: string) => effectiveOrder(body).find((item) => item.identifier === id);

export const own = (identifier: string, content: string, extra: Partial<LayerPrompt> = {}): LayerPrompt => ({
    identifier,
    name: identifier,
    content,
    ...extra,
});
