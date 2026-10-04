import { describe, expect, it } from 'vitest';
import {
    MODEL_PROFILES,
    connectionFrom,
    modelProfile,
    modelQuirks,
    providerHints,
} from '../../src/domain/preset-analysis-hints';
import type { ConnectionInfo } from '../../src/domain/preset-analysis-hints';

function connection(overrides: Partial<ConnectionInfo> = {}): ConnectionInfo {
    return {
        source: 'openrouter',
        model: 'deepseek/deepseek-v4-flash',
        reasoningEffort: 'min',
        showThoughts: false,
        temperature: 0.8,
        providers: [],
        continuePrefill: false,
        ...overrides,
    };
}

describe('connectionFrom', () => {
    it('reads the source, the model by source and the reasoning settings from oai_settings', () => {
        expect(
            connectionFrom({
                chat_completion_source: 'openrouter',
                openrouter_model: 'deepseek/deepseek-v4-pro',
                deepseek_model: 'deepseek-v4-flash',
                reasoning_effort: 'high',
                show_thoughts: true,
                temp_openai: 1.1,
                openrouter_providers: ['DeepSeek', 3],
                continue_prefill: true,
            }),
        ).toEqual({
            source: 'openrouter',
            model: 'deepseek/deepseek-v4-pro',
            reasoningEffort: 'high',
            showThoughts: true,
            temperature: 1.1,
            providers: ['DeepSeek'],
            continuePrefill: true,
        });
    });

    it('handles the website model, unknown sources and missing values', () => {
        expect(connectionFrom({ chat_completion_source: 'openrouter', openrouter_model: 'OR_Website' })).toMatchObject({
            model: '',
            reasoningEffort: 'auto',
            showThoughts: false,
            temperature: null,
            providers: [],
            continuePrefill: false,
        });
        expect(connectionFrom({ chat_completion_source: 'mystery', temp_openai: 'x' })).toMatchObject({
            model: '',
            temperature: null,
        });
        expect(connectionFrom({ chat_completion_source: '' })).toBeNull();
        expect(connectionFrom(null)).toBeNull();
        expect(connectionFrom(undefined)).toBeNull();
    });
});

describe('model profiles and quirks', () => {
    it('matches DeepSeek V4 Flash and Pro, routed and direct ids', () => {
        expect(modelProfile('deepseek/deepseek-v4-flash')?.id).toBe('deepseek-v4-flash');
        expect(modelProfile('deepseek-v4-flash-vision-exp')?.id).toBe('deepseek-v4-flash');
        expect(modelProfile('deepseek/deepseek-v4-pro')?.id).toBe('deepseek-v4-pro');
        expect(modelProfile('deepseek-v4')?.id).toBe('deepseek-v4-flash');
        expect(modelProfile('deepseek/deepseek-chat-v3')).toBeNull();
        expect(modelProfile('')).toBeNull();
        expect(MODEL_PROFILES.length).toBeGreaterThanOrEqual(2);
    });

    it('applies the OpenRouter-only prefill quirk by source', () => {
        expect([...modelQuirks(connection())].sort()).toEqual(['assistantDepth', 'prefillEos', 'systemMerge']);
        expect([...modelQuirks(connection({ source: 'deepseek', model: 'deepseek-v4-flash' }))].sort()).toEqual([
            'assistantDepth',
            'systemMerge',
        ]);
        expect(modelQuirks(connection({ model: 'anthropic/claude' })).size).toBe(0);
        expect(modelQuirks(null).size).toBe(0);
    });
});

describe('providerHints', () => {
    const keys = (value: ConnectionInfo) => providerHints(value).map((line) => line.key);

    it('describes reasoning through OpenRouter by the effort and the reasoning box', () => {
        expect(keys(connection())).toEqual([
            'reasoningOff',
            'prefillEos',
            'systemMerge',
            'assistantDepth',
            'temperature',
            'openrouterProvider',
        ]);
        expect(keys(connection({ reasoningEffort: 'auto' }))[0]).toBe('reasoningAuto');
        expect(providerHints(connection({ reasoningEffort: 'high' }))[0]).toMatchObject({
            key: 'reasoningHiddenOnly',
            params: { effort: 'high' },
        });
        expect(providerHints(connection({ reasoningEffort: 'medium', showThoughts: true }))[0]).toMatchObject({
            key: 'reasoningOn',
            params: { effort: 'medium' },
        });
        expect(keys(connection({ continuePrefill: true }))).toContain('prefillEosContinue');
        expect(keys(connection({ providers: ['DeepSeek'] }))).not.toContain('openrouterProvider');
    });

    it('describes the DeepSeek API: thinking switch, prefix prefill, its temperature scale', () => {
        const direct = connection({
            source: 'deepseek',
            model: 'deepseek-v4-flash',
            showThoughts: true,
            temperature: 1.3,
        });
        expect(providerHints(direct)).toEqual([
            { model: 'deepseek-v4-flash', key: 'thinkingOnDirect' },
            { model: 'deepseek-v4-flash', key: 'prefillDirect' },
            { model: 'deepseek-v4-flash', key: 'systemMerge' },
            { model: 'deepseek-v4-flash', key: 'assistantDepth' },
            {
                model: 'deepseek-v4-flash',
                key: 'temperatureDirect',
                params: { min: 1.0, max: 1.5, model: 'DeepSeek V4 Flash', current: 1.3 },
            },
        ]);
        expect(keys({ ...direct, showThoughts: false })[0]).toBe('thinkingOffDirect');
    });

    it('flags a temperature outside the range and works without one', () => {
        expect(
            providerHints(connection({ temperature: 1.6 })).find((line) => line.key === 'temperatureOutside'),
        ).toMatchObject({
            params: { min: 0.6, max: 1.0, current: 1.6 },
        });
        const noTemperature = providerHints(connection({ temperature: null })).find(
            (line) => line.key === 'temperature',
        );
        expect(noTemperature?.params).toEqual({ min: 0.6, max: 1.0, model: 'DeepSeek V4 Flash' });
    });

    it('gives other sources a generic reasoning hint and unknown models only the routing hint', () => {
        expect(keys(connection({ source: 'custom' }))[0]).toBe('reasoningOther');
        expect(providerHints(connection({ model: 'anthropic/claude-sonnet' }))).toEqual([
            { model: 'openrouter', key: 'openrouterProvider' },
        ]);
        expect(providerHints(connection({ source: 'claude', model: 'claude-x' }))).toEqual([]);
        expect(providerHints(connection({ model: '' }))).toEqual([{ model: 'openrouter', key: 'openrouterProvider' }]);
        expect(providerHints(null)).toEqual([]);
    });
});
