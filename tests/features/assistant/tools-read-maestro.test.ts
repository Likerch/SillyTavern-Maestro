// Read tools about Maestro itself: modules, allowlisted settings, health, journal, Inbox.
import { describe, expect, it } from 'vitest';
import { readTools } from '../../../src/features/assistant/tools';
import type { HealthCheck, InboxCard, JournalRecord } from '../../../src/shared/contracts';
import { fakeApp, fakeSettings, runTool, toolContext } from './tools-helpers';
import type { Loose } from './tools-helpers';

function record(id: string, patch: Partial<JournalRecord> = {}): JournalRecord {
    return {
        id,
        at: 1_760_000_000_000,
        chatId: 'chat-1',
        module: 'M13',
        kind: 'setting',
        summary: `Record ${id}`,
        changes: [{ target: 'setting', ref: { path: 'director.every' }, before: 4, after: 6 }],
        ...patch,
    };
}

function card(id: string, createdAt: number): InboxCard {
    return {
        id,
        module: 'M8',
        kind: 'canon.fact',
        title: `Anna ${id}`,
        changes: [{ target: 'lorebook-entry', ref: {}, before: 'a', after: 'b' }],
        payload: {},
        createdAt,
    };
}

describe('maestro_modules', () => {
    it('lists modules by stage with titles and on/off, in the user language', async () => {
        const fake = fakeApp({
            modules: [
                { key: 'director', id: 'M13', stage: 8, enabled: false, missing: ['st.x'] },
                { key: 'loreJournal', id: 'M1', stage: 1 },
            ],
            strings: { en: { 'm1.title': 'Lore journal' }, ru: { 'm1.title': 'Журнал лора' } },
        });
        const output = await runTool(readTools(fake.app), 'maestro_modules', {}, toolContext(fake, { locale: 'ru' }));
        expect(output.data).toEqual({
            modules: [
                { key: 'loreJournal', id: 'M1', title: 'Lore journal', stage: 1, on: true, running: true },
                {
                    key: 'director',
                    id: 'M13',
                    title: 'director',
                    stage: 8,
                    on: false,
                    running: false,
                    missing: ['st.x'],
                },
            ],
            on: 1,
            total: 2,
        });
        expect(output.summary).toBe('Модули: включено 1 из 2');
        expect(output.untrusted).toBeUndefined();
    });
});

describe('maestro_settings', () => {
    const settings = fakeSettings({
        director: { every: 6, profileId: 'secret-profile', notes: { long: 'x'.repeat(500), apiKey: 'k' } },
        quality: { list: Array.from({ length: 40 }, (_, index) => index) },
    });

    it('lists the readable modules without a module', async () => {
        const fake = fakeApp();
        const output = await runTool(readTools(fake.app), 'maestro_settings', {}, toolContext(fake, { settings }));
        expect(output.data).toEqual({ modules: ['director', 'quality'] });
        expect(output.summary).toBe('Settings of 2 modules');
    });

    it('reads one module through the allowlist, compact and without secrets', async () => {
        const fake = fakeApp();
        const ctx = toolContext(fake, { settings });
        const output = await runTool(readTools(fake.app), 'maestro_settings', { module: 'director' }, ctx);
        const data = output.data as { settings: { every: number; notes: { long: string } } };
        expect(data.settings.every).toBe(6);
        expect(JSON.stringify(data)).not.toContain('secret-profile');
        expect(JSON.stringify(data)).not.toContain('apiKey');
        expect(data.settings.notes.long.length).toBeLessThanOrEqual(300);
        expect(output.untrusted).toBe(true);
        const quality = await runTool(readTools(fake.app), 'maestro_settings', { module: 'quality' }, ctx);
        expect((quality.data as { settings: { list: unknown[] } }).settings.list).toHaveLength(31);
    });

    it('tells which modules exist when the module is unknown', async () => {
        const fake = fakeApp();
        const ctx = toolContext(fake, { settings, locale: 'ru' });
        const output = await runTool(readTools(fake.app), 'maestro_settings', { module: 'nope' }, ctx);
        expect(output.data).toMatchObject({ modules: ['director', 'quality'] });
        expect(output.summary).toBe('Нет доступных настроек модуля «nope».');
    });
});

describe('maestro_health', () => {
    const checks: HealthCheck[] = [
        { id: 'ok', module: 'M3', titleKey: 'm3.ok', run: async () => ({ status: 'ok' }) },
        { id: 'bad', module: 'M3', titleKey: 'm3.bad', run: async () => ({ status: 'error', message: 'No tracker' }) },
        {
            id: 'throws',
            module: 'M4',
            titleKey: 'm4.throws',
            run: async () => {
                throw new Error('boom');
            },
        },
        { id: 'warn', module: 'M5', titleKey: 'm5.warn', run: async () => ({ status: 'warn', message: 'w' }) },
    ];

    it('runs the checks, sorts problems first and reports the stack', async () => {
        const fake = fakeApp({
            healthChecks: checks,
            capsReport: [
                { id: 'st.regex', ok: true },
                { id: 'st.events.scanDone', ok: false, detail: 'missing' },
            ],
            adapters: { des: { present: () => true, version: () => '2.6.0' } },
            apis: {
                doctor: {
                    findings: () => [
                        {
                            id: 'f1',
                            kind: 'regex.dead',
                            severity: 'warn',
                            messageKey: 'm5.dead',
                            params: { name: 'X' },
                            target: {},
                        },
                    ],
                    lastScanAt: () => 1_760_000_000_000,
                },
                guardian: { tabState: () => 'fresh', hasBaseline: () => true },
            },
            strings: { en: { 'm3.bad': 'DES tracker', 'm5.dead': 'Dead script {name}' }, ru: {} },
            coreSettings: { mode: 'cinema' },
        });
        const output = await runTool(readTools(fake.app), 'maestro_health', {}, toolContext(fake));
        const data = output.data as Loose;
        expect(data.checks.map((check: { id: string }) => check.id)).toEqual(['bad', 'throws', 'warn', 'ok']);
        expect(data.checks[0]).toEqual({
            id: 'bad',
            module: 'M3',
            title: 'DES tracker',
            status: 'error',
            message: 'No tracker',
        });
        expect(data.checks[1]).toMatchObject({ status: 'error', message: 'boom' });
        expect(data.capabilities).toEqual({ ok: 1, failing: [{ id: 'st.events.scanDone', detail: 'missing' }] });
        expect(data.neighbours).toContainEqual({ id: 'des', present: true, version: '2.6.0' });
        expect(data.neighbours).toContainEqual({ id: 'qvink', present: false });
        expect(data.maestro.mode).toBe('cinema');
        expect(data.maestro.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(data.host).toEqual({ sillyTavern: '1.19.0', chatCompletion: true, groupChat: false, chatOpen: true });
        expect(data.doctor.findings.items).toEqual([{ kind: 'regex.dead', severity: 'warn', text: 'Dead script X' }]);
        expect(data.guardian).toEqual({ tab: 'fresh', baseline: true });
        expect(output.summary).toBe('Health: 2 errors, 1 warnings; neighbours 1/8');
        expect(output.untrusted).toBe(true);
    });

    it('can skip running the checks and answers in Russian', async () => {
        const fake = fakeApp({ healthChecks: checks });
        const output = await runTool(
            readTools(fake.app),
            'maestro_health',
            { run_checks: false },
            toolContext(fake, { locale: 'ru' }),
        );
        expect((output.data as { checks: unknown[] }).checks).toEqual([]);
        expect(output.summary).toBe('Здоровье: ошибок 0, предупреждений 0; соседи 0/8');
    });

    it('times out a hanging check', async () => {
        const fake = fakeApp({
            healthChecks: [{ id: 'hang', module: 'M3', titleKey: 'x', run: () => new Promise(() => {}) }],
        });
        const { vi } = await import('vitest');
        vi.useFakeTimers();
        try {
            const pending = runTool(readTools(fake.app), 'maestro_health', {}, toolContext(fake));
            await vi.advanceTimersByTimeAsync(4100);
            const output = await pending;
            expect((output.data as { checks: { status: string; message: string }[] }).checks[0]).toMatchObject({
                status: 'skip',
                message: 'timeout',
            });
        } finally {
            vi.useRealTimers();
        }
    });
});

describe('journal_recent', () => {
    it('gives the newest records first, capped, with changes but no sensitive values', async () => {
        const fake = fakeApp({
            modules: [{ key: 'director', id: 'M13', stage: 8 }],
            journal: [
                record('j1'),
                record('j2', {
                    undone: true,
                    changes: [{ target: 'setting', ref: { path: 'core.profiles.default' }, before: 'p1', after: 'p2' }],
                }),
                record('j3', { module: 'M6', summary: 'x'.repeat(400) }),
            ],
        });
        const tools = readTools(fake.app);
        const output = await runTool(tools, 'journal_recent', { limit: 2 }, toolContext(fake));
        const records = (output.data as { records: Loose[] }).records;
        expect(records.map((item) => item.id)).toEqual(['j3', 'j2']);
        expect(records[0]!.summary.length).toBeLessThanOrEqual(200);
        expect(records[1]!.undone).toBe(true);
        expect(records[1]!.details).toEqual([{ target: 'setting' }]);
        expect(output.untrusted).toBe(true);
        const byKey = await runTool(
            tools,
            'journal_recent',
            { module: 'director' },
            toolContext(fake, { locale: 'ru' }),
        );
        const filtered = (byKey.data as { records: Loose[] }).records;
        expect(filtered.map((item) => item.id)).toEqual(['j2', 'j1']);
        expect(filtered[1]!.details).toEqual([{ target: 'setting', before: '4', after: '6' }]);
        expect(byKey.summary).toBe('Журнал: записей — 2');
    });

    it('shows lorebook key changes (only API keys and addresses are hidden)', async () => {
        const fake = fakeApp({
            journal: [
                record('k', {
                    changes: [
                        {
                            target: 'lorebook-entry',
                            ref: { book: 'World', uid: 1, field: 'key' },
                            before: ['Анна'],
                            after: ['Анна', 'Анну'],
                        },
                        { target: 'setting', ref: { path: 'nai.apiKey' }, before: 'a', after: 'b' },
                    ],
                }),
            ],
        });
        const output = await runTool(readTools(fake.app), 'journal_recent', {}, toolContext(fake));
        expect((output.data as { records: Loose[] }).records[0]!.details).toEqual([
            { target: 'lorebook-entry', before: '["Анна"]', after: '["Анна","Анну"]' },
            { target: 'setting' },
        ]);
    });
});

describe('inbox_list', () => {
    it('lists the newest cards first with their size', async () => {
        const fake = fakeApp({ inbox: [card('a', 1), card('b', 3), card('c', 2)] });
        const output = await runTool(readTools(fake.app), 'inbox_list', { limit: 2 }, toolContext(fake));
        const data = output.data as { cards: Loose[]; total: number };
        expect(data.cards.map((item) => item.id)).toEqual(['b', 'c']);
        expect(data.cards[0]).toMatchObject({
            module: 'M8',
            kind: 'canon.fact',
            changes: 1,
            targets: ['lorebook-entry'],
        });
        expect(data.total).toBe(3);
        expect(output.summary).toBe('Inbox: 3 cards');
        expect(output.untrusted).toBe(true);
    });
});
