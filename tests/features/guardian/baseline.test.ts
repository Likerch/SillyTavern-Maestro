// The baseline file: schema 2, the schema 1 migration and settling a migrated file against live settings.
import { describe, expect, it } from 'vitest';
import { valueHash } from '../../../src/domain/settings-diff';
import type { TrackedPart } from '../../../src/domain/settings-diff';
import { readBaseline, settleBaseline } from '../../../src/features/guardian/baseline';
import { acknowledgeTargets, migrateTracked, presetBodyHash } from '../../../src/features/guardian/tracked';

describe('reading the baseline file', () => {
    it('accepts schema 2 as it is and rejects anything else', () => {
        const file = readBaseline({
            schema: 2,
            takenAt: 5,
            reason: 'manual',
            values: { 'regex.r1': { name: 'a' } },
            restore: {},
            dismissed: ['h', 3],
        });
        expect(file).toEqual({
            schema: 2,
            takenAt: 5,
            reason: 'manual',
            values: { 'regex.r1': { name: 'a' } },
            restore: {},
            dismissed: ['h'],
        });
        expect(readBaseline({ schema: 3, values: {} })).toBeNull();
        expect(readBaseline({ schema: 2 })).toBeNull();
        expect(readBaseline('nope')).toBeNull();
        // A migrated file written before it was settled keeps its list of paths to take in.
        expect(readBaseline({ schema: 2, values: {}, adoptMissing: ['api'] })?.adoptMissing).toEqual(['api']);
    });

    it('migrates schema 1: today’s rules, no content, no dismissed drifts, new paths to take in', () => {
        const body = { temperature: 1, deepseek_model: 'deepseek-v4-flash', openai_max_tokens: 300, prompts: [] };
        const prompts = { prefix: 'best', activeStyle: 'Ink', characterPrompts: { kai: {} } };
        const file = readBaseline({
            schema: 1,
            takenAt: 7,
            reason: 'first-start',
            values: {
                'preset.body': valueHash({
                    temperature: 1,
                    deepseek_model: 'deepseek-v4-flash',
                    openai_max_tokens: 300,
                }),
                'worldInfo.world_info_budget': 25,
                'worldInfo.globalSelect': ['World'],
                'qvink.auto_summarize': true,
                'qvink.notify_on_profile_switch': false,
                'ck.enabled': true,
                'ck.tagLibraries': ['Tags'],
                'nai.prompts': valueHash(prompts),
                'nai.des': { enabled: true, legacyPortraits: { Kai: 'kai.png' } },
                'des.historyPersistence': { enabled: true },
            },
            restore: { 'preset.body': { name: 'Marinara', body }, 'nai.prompts': prompts },
            dismissed: ['old'],
        })!;
        expect(file.schema).toBe(2);
        expect(file.takenAt).toBe(7);
        expect(file.dismissed).toEqual([]);
        expect(file.adoptMissing).toEqual(['api', 'qvink.profiles']);
        expect(file.values).toEqual({
            'preset.body': presetBodyHash(body),
            'worldInfo.world_info_budget': 25,
            'qvink.notify_on_profile_switch': false,
            'ck.enabled': true,
            'nai.prompts': valueHash({ prefix: 'best' }),
            'nai.des': { enabled: true },
        });
        expect(file.restore['nai.prompts']).toEqual({ prefix: 'best' });
        expect((file.restore['preset.body'] as { body: unknown }).body).toEqual(body);
    });
});

describe('settling a baseline', () => {
    it('takes live values of new paths it lacks, keeps the ones it has, once', () => {
        const file = readBaseline({ schema: 1, values: { 'api.maxTokens': 300, 'regex.r1': 1 } })!;
        const current: TrackedPart = {
            values: { 'api.maxTokens': 500, 'api.model': 'm (s)', 'qvink.profiles.A': 'h', 'regex.r2': 2 },
            restore: { 'qvink.profiles.A': { a: 1 } },
        };
        expect(settleBaseline(file, current)).toBe(true);
        // A path the old file had keeps its value (real drift); only missing new paths are taken in.
        expect(file.values).toEqual({
            'api.maxTokens': 300,
            'api.model': 'm (s)',
            'qvink.profiles.A': 'h',
            'regex.r1': 1,
        });
        expect(file.restore).toEqual({ 'qvink.profiles.A': { a: 1 } });
        expect(file).not.toHaveProperty('adoptMissing');
        current.values['api.stream'] = true;
        expect(settleBaseline(file, current)).toBe(false);
        expect(file.values).not.toHaveProperty('api.stream');
    });

    it('drops paths outside the scope', () => {
        const file = readBaseline({ schema: 2, values: { 'worldInfo.globalSelect': [], 'ck.enabled': true } })!;
        expect(settleBaseline(file, { values: {}, restore: {} })).toBe(true);
        expect(file.values).toEqual({ 'ck.enabled': true });
    });
});

describe('migrating tracked values', () => {
    it('leaves a snapshot taken under today’s rules as it is', () => {
        const part = { values: { 'nai.des': { enabled: true }, 'ck.enabled': true }, restore: {} };
        expect(migrateTracked(part)).toEqual(part);
    });

    it('lets the preset body cover its connection fields when acknowledged', () => {
        expect(acknowledgeTargets(['regex'])).toEqual(['regex']);
        expect(acknowledgeTargets(['preset'])).toEqual(
            expect.arrayContaining(['preset', 'api.model', 'api.maxTokens', 'api.maxContext', 'api.stream']),
        );
        expect(acknowledgeTargets(['preset.body'])).toContain('api.reasoningEffort');
        expect(acknowledgeTargets(['preset.roles'])).toEqual(['preset.roles']);
    });
});
