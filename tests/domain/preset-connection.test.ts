// Automatic preset switches keep the connection: the live model, source and providers go into the incoming preset.
import { describe, expect, it } from 'vitest';
import { keepConnection } from '../../src/domain/preset-connection';

const TABLE = {
    chat_completion_source: ['#chat_completion_source', 'chat_completion_source', false, true],
    openrouter_model: ['#model_openrouter_select', 'openrouter_model', false, true],
    openrouter_providers: ['#openrouter_providers_chat', 'openrouter_providers', false, true],
    temperature: ['#temp_openai', 'temp_openai', false, false],
    reverse_proxy: ['#openai_reverse_proxy', 'reverse_proxy', false, true],
};

describe('keepConnection', () => {
    it('writes the live connection values over the preset’s and leaves the rest alone', () => {
        const preset: Record<string, unknown> = {
            chat_completion_source: 'openrouter',
            openrouter_model: 'z-ai/glm-5.3-flash',
            openrouter_providers: ['DeepInfra'],
            temperature: 1,
        };
        const live = {
            chat_completion_source: 'openrouter',
            openrouter_model: 'deepseek/deepseek-v4.1-flash',
            openrouter_providers: ['DeepInfra', 'Novita'],
            temp_openai: 0.5,
        };
        expect(keepConnection(preset, TABLE, live)).toEqual([
            'chat_completion_source',
            'openrouter_model',
            'openrouter_providers',
        ]);
        expect(preset).toEqual({
            chat_completion_source: 'openrouter',
            openrouter_model: 'deepseek/deepseek-v4.1-flash',
            openrouter_providers: ['DeepInfra', 'Novita'],
            temperature: 1,
        });
        // A copy: the preset does not share the live array.
        expect(preset.openrouter_providers).not.toBe(live.openrouter_providers);
    });

    it('does nothing with malformed input', () => {
        expect(keepConnection(null, TABLE, {})).toEqual([]);
        expect(keepConnection({}, null, {})).toEqual([]);
        expect(keepConnection({}, { x: 'bad' }, { x: 1 })).toEqual([]);
    });
});
