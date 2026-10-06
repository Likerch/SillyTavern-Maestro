import { describe, expect, it } from 'vitest';
import {
    SETTING_KIND,
    SETTING_TARGET,
    createSettingsAccess,
    formatSettingValue,
    registerSettingUndo,
} from '../../../src/features/assistant/safety';
import { ASSISTANT_KEY } from '../../../src/features/assistant/settings';
import { answer, callOf, calls, createAssistantEnv, until } from './env';

describe('settings access (allowlist)', () => {
    it('lists modules with visible settings, never its own slice or secret-only modules', () => {
        const env = createAssistantEnv();
        const access = createSettingsAccess(env.app);
        expect(access.modules()).toEqual(['director', 'quality']);
        expect(access.read(ASSISTANT_KEY)).toBeNull();
        expect(access.read('vault')).toEqual({});
        expect(access.read('missing')).toBeNull();
    });

    it('strips keys, addresses, profiles, models and non-primitive leaves', () => {
        const env = createAssistantEnv();
        const access = createSettingsAccess(env.app);
        expect(access.read('director')).toEqual({
            pacing: { every: 4, mode: 'auto' },
            enabled: true,
            tags: ['a', 'b'],
            note: 'hello',
            maybe: null,
        });
        expect(access.read('quality')).toEqual({ threshold: 0.5 });
        // The copy is detached from the live settings.
        const copy = access.read('director') as { tags: string[] };
        copy.tags.push('c');
        expect(env.settings.module<{ tags: string[] }>('director').tags).toEqual(['a', 'b']);
    });

    it('allows only visible leaves', () => {
        const env = createAssistantEnv();
        const access = createSettingsAccess(env.app);
        expect(access.allowed('director', 'pacing.every')).toBe(true);
        expect(access.allowed('director', 'tags')).toBe(true);
        expect(access.allowed('director', 'apiKey')).toBe(false);
        expect(access.allowed('director', 'connection.retries')).toBe(false);
        expect(access.allowed('director', 'pacing')).toBe(false);
        expect(access.allowed('director', 'rules')).toBe(false);
        expect(access.allowed('director', 'nope')).toBe(false);
        expect(access.allowed('director', '__proto__.x')).toBe(false);
        expect(access.allowed(ASSISTANT_KEY, 'writesPerHour')).toBe(false);
    });

    it.each([
        ['director', 'apiKey', 'x', '«apiKey» is closed to the assistant'],
        ['director', 'connection.retries', 3, '«connection.retries» is closed'],
        ['director', 'pacing', 3, 'is a group of settings'],
        ['director', 'rules', [], 'is a group of settings'],
        ['director', 'nope', 1, 'Director has no setting «nope»'],
        ['director', 'a..b', 1, 'is not a valid setting path'],
        ['assistant', 'writesPerHour', 100, 'no Maestro module «assistant»'],
        ['ghost', 'x', 1, 'no Maestro module «ghost»'],
        ['director', 'pacing.every', 'often', '«pacing.every» expects a number (now 4)'],
        ['director', 'pacing.every', -2, 'cannot be negative'],
        ['director', 'pacing.every', 4_000_000, 'outside a sane range'],
        ['director', 'enabled', 'yes', 'expects true or false'],
        ['director', 'note', { a: 1 }, 'expects text'],
        ['director', 'note', 'x'.repeat(5000), 'too long'],
        ['director', 'tags', [1, 2], 'must stay of the same kind'],
        ['director', 'pacing.every', 4, 'already has this value'],
    ])('refuses %s.%s = %j', (module, path, value, message) => {
        const env = createAssistantEnv();
        const access = createSettingsAccess(env.app);
        expect(() => access.plan(module, path, value)).toThrow(message);
    });

    it('refuses in the user language', () => {
        const env = createAssistantEnv({ locale: 'ru' });
        const access = createSettingsAccess(env.app);
        expect(() => access.plan('director', 'apiKey', 'x')).toThrow('«apiKey» закрыт для ассистента');
        expect(() => access.plan('director', 'nope', 1)).toThrow('В модуле «Режиссёр» нет настройки «nope»');
    });

    it('plans with before/after, applies through the settings service, journals, and undoes', async () => {
        const env = createAssistantEnv({ locale: 'ru' });
        const access = createSettingsAccess(env.app);
        registerSettingUndo(env.app);
        const plan = access.plan('director', 'pacing.every', '6');
        expect(plan).toMatchObject({
            summary: 'Режиссёр: pacing.every — 4 → 6',
            target: 'Maestro · Режиссёр',
            before: 4,
            after: 6,
        });
        // Nothing changes before apply().
        expect(env.settings.module<{ pacing: { every: number } }>('director').pacing.every).toBe(4);
        const outcome = await plan.apply();
        expect(outcome).toEqual({ result: { module: 'director', path: 'pacing.every', value: 6 } });
        expect(env.settings.module<{ pacing: { every: number } }>('director').pacing.every).toBe(6);
        expect(env.saves.count).toBeGreaterThan(0);
        expect(env.notified).toContain('modules.director.pacing.every');
        const record = env.journal.records[0]!;
        expect(record).toMatchObject({
            module: 'M33',
            kind: SETTING_KIND,
            // The journal line has no path (an English key): it stays in the change's ref.
            summary: 'Поменял настройку модуля «Режиссёр»: 4 → 6',
            changes: [
                { target: SETTING_TARGET, ref: { module: 'director', path: 'pacing.every' }, before: 4, after: 6 },
            ],
        });
        expect(await env.journal.undo(record.id)).toBe(true);
        expect(env.settings.module<{ pacing: { every: number } }>('director').pacing.every).toBe(4);
    });

    it('coerces booleans and lists, and accepts any primitive over null', async () => {
        const env = createAssistantEnv();
        const access = createSettingsAccess(env.app);
        expect(access.plan('director', 'enabled', 'false').after).toBe(false);
        expect(access.plan('director', 'tags', '["x","y"]').after).toEqual(['x', 'y']);
        expect(access.plan('director', 'maybe', 3).after).toBe(3);
        expect(access.plan('director', 'note', 12).after).toBe('12');
        const plan = access.plan('director', 'tags', ['c']);
        await plan.apply();
        expect(env.settings.module<{ tags: string[] }>('director').tags).toEqual(['c']);
    });

    it('re-checks at apply time and refuses undo outside the allowlist', async () => {
        const env = createAssistantEnv();
        const access = createSettingsAccess(env.app);
        registerSettingUndo(env.app);
        const plan = access.plan('director', 'note', 'bye');
        delete (env.settings.module<Record<string, unknown>>('director') as { note?: string }).note;
        await expect(plan.apply()).rejects.toThrow('Director has no setting «note»');
        const handler = env.journal.handlers.get(SETTING_TARGET)!;
        const change = (ref: Record<string, unknown>, before: unknown = 1) => ({
            target: SETTING_TARGET,
            ref,
            before,
            after: 2,
        });
        expect(await handler(change({ module: 'director', path: 'apiKey' }))).toBe(false);
        expect(await handler(change({ module: ASSISTANT_KEY, path: 'writesPerHour' }))).toBe(false);
        expect(await handler(change({ module: 'ghost', path: 'x' }))).toBe(false);
        expect(await handler(change({ module: 'director' }))).toBe(false);
        expect(await handler(change({ module: 'director', path: 'pacing.every' }, { evil: true }))).toBe(false);
        expect(await handler(change({ module: 'director', path: 'pacing.every' }, 9))).toBe(true);
        expect(env.settings.module<{ pacing: { every: number } }>('director').pacing.every).toBe(9);
    });

    it('formats values for summaries', () => {
        expect(formatSettingValue(['a', 1])).toBe('[«a», 1]');
        expect(formatSettingValue(null)).toBe('—');
        expect(formatSettingValue('x'.repeat(80))).toHaveLength(62);
        expect(formatSettingValue(true)).toBe('true');
    });

    it('works end to end through a write tool that uses ctx.settings', async () => {
        const env = createAssistantEnv();
        const service = env.service();
        service.registerTool({
            name: 'setting_set',
            kind: 'write',
            description: 'Sets a setting.',
            parameters: { type: 'object', properties: {} },
            plan: async (args, ctx) => ctx.settings.plan(String(args['module']), String(args['path']), args['value']),
        });
        env.llm.script(
            calls(
                callOf('setting_set', { module: 'director', path: 'apiKey', value: 'x' }, 's1'),
                callOf('setting_set', { module: 'director', path: 'pacing.every', value: 6 }, 's2'),
            ),
            answer('Done.'),
        );
        const sending = service.send('set pacing to 6');
        await until(() =>
            service.conversation().some((message) => message.toolCalls?.some((call) => call.status === 'waiting')),
        );
        await service.confirm('s2', true);
        await sending;
        const calls2 = service.conversation().flatMap((message) => message.toolCalls ?? []);
        expect(calls2[0]?.error).toContain('«apiKey» is closed to the assistant');
        expect(calls2[1]).toMatchObject({ status: 'applied', before: 4, after: 6, target: 'Maestro · Director' });
        expect(env.settings.module<{ pacing: { every: number } }>('director').pacing.every).toBe(6);
        expect(env.journal.records).toHaveLength(1);
    });
});
