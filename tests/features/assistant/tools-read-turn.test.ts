// Read tools about one turn: the prompt (inspector + architect), the lore and why an entry stayed silent (lore journal
// + the explainer), the cost and why (treasurer + the cost explainer).
import { describe, expect, it } from 'vitest';
import type { ArchitectReport } from '../../../src/features/architect/api';
import { readTools } from '../../../src/features/assistant/tools';
import type { InspectorRecord } from '../../../src/features/inspector/api';
import type { LoreActivation, TurnLoreRecord } from '../../../src/features/loreJournal/api';
import type { TurnSpend } from '../../../src/features/treasurer/api';
import { fakeApp, msg, runTool, toolContext, userMsg } from './tools-helpers';
import type { Loose } from './tools-helpers';

function inspectorRecord(messageIndex: number): InspectorRecord {
    return {
        messageIndex,
        at: 1_760_000_000_000,
        generationType: 'normal',
        messages: 40,
        chars: { system: 1000, user: 500, assistant: 800, tool: 0 },
        totalTokens: 12000,
        exact: true,
        loreByBook: true,
        sources: [
            { id: 'history', kind: 'history', tokens: 3000 },
            { id: 'lore:World', kind: 'lore', name: 'World', tokens: 6000 },
            { id: 'preset:main', kind: 'preset', name: 'Main', tokens: 2000 },
            { id: 'ext:des', kind: 'extension', owner: 'des', tokens: 1000 },
        ],
    };
}

function activation(uid: number, patch: Partial<LoreActivation> = {}): LoreActivation {
    return {
        world: 'World',
        uid,
        comment: `Entry ${uid}`,
        chars: 400,
        tokens: 100 * uid,
        position: 0,
        order: 100,
        loop: 1,
        recursionLevel: 0,
        tags: [],
        ...patch,
    };
}

function loreRecord(messageIndex: number, activations: LoreActivation[]): TurnLoreRecord {
    return {
        messageIndex,
        at: 1_760_000_000_000,
        generationType: 'normal',
        activations,
        totalChars: 1200,
        totalTokens: 300,
        overflow: false,
        budgetTokens: 2000,
    };
}

const BOOK = {
    entries: {
        '1': { uid: 1, comment: 'Kai', key: ['Kai'], content: 'Kai is a smith.' },
        '2': { uid: 2, comment: 'Anna, the sister', key: ['Анна'], content: 'Anna is the heroine sister.' },
        '3': { uid: 3, comment: 'Forest', key: ['лес'], content: 'A dark forest.', disable: true },
    },
};

function loreFake(records: TurnLoreRecord[], extra: Record<string, unknown> = {}) {
    return fakeApp({
        chat: [userMsg('Ты помнишь Анну?'), msg('Нет. Кто это?')],
        apis: {
            loreJournal: {
                turns: () => records,
                last: () => records[records.length - 1],
                attributeKeys: async (record: TurnLoreRecord) => ({
                    ...record,
                    activations: record.activations.map((item) => ({ ...item, key: 'Kai' })),
                }),
                whyActive: async () => [{ book: 'World', reasons: ['global'] }],
            },
            loreStore: { books: () => ['World'], load: async (name: string) => (name === 'World' ? BOOK : null) },
            ...extra,
        },
        hostModules: { worldInfo: { world_info_depth: 2, world_info_case_sensitive: false } },
    });
}

describe('turn_prompt', () => {
    it('gives the prompt by source, biggest first, with lore cuts and the architect report', async () => {
        const report: ArchitectReport = {
            at: 1,
            messageIndex: 5,
            budgets: [
                { source: 'lore', limit: 4000, used: 3900, cut: 300, status: 'cut' },
                { source: 'qvink', limit: 0, used: 0, cut: 0, status: 'off' },
            ],
            damped: [],
            duplicates: [],
            cuts: [{ world: 'World', uid: 9, comment: 'Old war', tokens: 300, order: 10 }],
        };
        const fake = fakeApp({
            apis: {
                inspector: { last: () => inspectorRecord(5), turns: () => [inspectorRecord(3), inspectorRecord(5)] },
                loreJournal: {
                    turns: () => [loreRecord(5, [activation(1), activation(2, { cut: true, cutBy: 'budget' })])],
                },
                architect: { reports: () => [report], lastReport: () => report },
            },
        });
        const output = await runTool(readTools(fake.app), 'turn_prompt', {}, toolContext(fake));
        const data = output.data as Loose;
        expect(data.totalTokens).toBe(12000);
        expect(data.sources.items.map((item: { id: string }) => item.id)).toEqual([
            'lore:World',
            'history',
            'preset:main',
            'ext:des',
        ]);
        expect(data.byKind).toEqual({ history: 3000, lore: 6000, preset: 2000, extension: 1000 });
        expect(data.loreCut).toEqual([{ book: 'World', uid: 2, title: 'Entry 2', tokens: 200, by: 'budget' }]);
        expect(data.architect.budgets).toEqual([{ source: 'lore', limit: 4000, used: 3900, cut: 300, status: 'cut' }]);
        expect(data.architect.cuts[0].comment).toBe('Old war');
        expect(output.untrusted).toBe(true);
        expect(output.summary).toBe('Prompt of turn #5: 12000 tokens');
    });

    it('finds an older turn by message index and says when there is none', async () => {
        const fake = fakeApp({ apis: { inspector: { last: () => undefined, turns: () => [inspectorRecord(3)] } } });
        const tools = readTools(fake.app);
        const ctx = toolContext(fake, { locale: 'ru' });
        const old = await runTool(tools, 'turn_prompt', { message_index: 3 }, ctx);
        expect(old.summary).toBe('Промпт хода №3: 12000 токенов');
        const none = await runTool(tools, 'turn_prompt', {}, ctx);
        expect(none.summary).toBe('Пока нет разобранного хода.');
    });
});

describe('lore_turn', () => {
    it('lists the activations of the last turn with their keys, biggest first', async () => {
        const records = [
            loreRecord(1, [activation(1)]),
            loreRecord(3, [
                activation(1),
                activation(4, { recursionLevel: 1, via: { world: 'World', uid: 1 }, tags: ['constant', 'canon'] }),
                activation(2, { cut: true }),
            ]),
        ];
        const fake = loreFake(records);
        const output = await runTool(readTools(fake.app), 'lore_turn', {}, toolContext(fake));
        const data = output.data as Loose;
        expect(data.messageIndex).toBe(3);
        expect(data.activations.items[0]).toEqual({
            book: 'World',
            uid: 4,
            title: 'Entry 4',
            tokens: 400,
            key: 'Kai',
            recursion: 1,
            via: 'World#1',
            constant: true,
            tags: ['canon'],
        });
        expect(data.activations.items[1]).toMatchObject({ uid: 2, cut: 'other' });
        expect(data.cut).toBe(1);
        expect(data.about).toBeUndefined();
        expect(output.summary).toBe('Lore of turn #3: 3 entries');
        expect(output.untrusted).toBe(true);
    });

    it('explains why the entries about a name did not fire (case form) and which did', async () => {
        const fake = loreFake([loreRecord(1, [activation(1)])]);
        const output = await runTool(
            readTools(fake.app),
            'lore_turn',
            { name: 'Анна' },
            toolContext(fake, { locale: 'ru' }),
        );
        const about = (output.data as Loose).about;
        expect(about.name).toBe('Анна');
        expect(about.scanDepth).toBe(2);
        expect(about.entries).toHaveLength(1);
        expect(about.entries[0]).toMatchObject({ book: 'World', uid: 2, keys: ['Анна'], fired: false });
        expect(about.entries[0].reasons[0]).toMatchObject({ code: 'otherCaseForm', detail: 'Анна ≠ анну' });
        expect(about.reasonTexts.otherCaseForm).toContain('падеж');
        expect(output.summary).toBe('Лор хода №1: записей 1, о «Анна»');
    });

    it('uses the world model to find entries by alias and reports fired ones', async () => {
        const fake = loreFake([loreRecord(1, [activation(1)])], {
            world: {
                resolve: (name: string) =>
                    name === 'Кузнец'
                        ? {
                              id: 'character:kai',
                              kind: 'character',
                              name: 'Kai',
                              aliases: ['Кузнец'],
                              forms: [],
                              sources: [{ kind: 'lore.entry', ref: 'World#1', label: 'Kai', world: 'World', uid: 1 }],
                          }
                        : undefined,
            },
        });
        const output = await runTool(readTools(fake.app), 'lore_turn', { name: 'Кузнец' }, toolContext(fake));
        const entry = (output.data as Loose).about.entries[0];
        expect(entry).toMatchObject({ uid: 1, fired: true });
        expect(entry.reasons[0].code).toBe('fired');
    });

    it('notes when nothing is known about the name', async () => {
        const fake = loreFake([loreRecord(1, [])]);
        const output = await runTool(readTools(fake.app), 'lore_turn', { name: 'Zed' }, toolContext(fake));
        expect((output.data as Loose).about.note).toContain('No entry');
    });

    it('says when the journal is empty', async () => {
        const fake = loreFake([]);
        const output = await runTool(readTools(fake.app), 'lore_turn', {}, toolContext(fake));
        expect(output.summary).toBe('No lore turn recorded yet.');
    });
});

describe('cost_turn and cost_summary', () => {
    const turns: TurnSpend[] = [
        {
            messageIndex: 3,
            at: 1,
            lines: [
                {
                    source: 'main',
                    usd: 0.01,
                    requests: 1,
                    tokens: { prompt: 9000, completion: 300, cached: 8000 },
                    estimated: false,
                },
            ],
        },
        {
            messageIndex: 5,
            at: 2,
            lines: [
                {
                    source: 'main',
                    usd: 0.03,
                    requests: 1,
                    tokens: { prompt: 12000, completion: 600, cached: 0 },
                    estimated: false,
                },
                {
                    source: 'regeneration',
                    usd: 0.03,
                    requests: 1,
                    tokens: { prompt: 12000, completion: 500 },
                    estimated: false,
                },
            ],
        },
    ];

    it('explains why the last turn was expensive', async () => {
        const fake = fakeApp({
            apis: {
                treasurer: { turns: () => turns },
                inspector: { turns: () => [inspectorRecord(5)], last: () => inspectorRecord(5) },
                quality: {
                    verdict: () => ({ ok: false, action: 'swiped', defects: [{ kind: 'english' }], costUsd: 0.001 }),
                },
                architect: {
                    cache: () => ({ hitRate: 0.123, firstChangeAt: 4, requests: 3, cachedTokens: 1, promptTokens: 9 }),
                },
            },
        });
        const output = await runTool(readTools(fake.app), 'cost_turn', {}, toolContext(fake));
        const data = output.data as Loose;
        expect(data.messageIndex).toBe(5);
        expect(data.totals.usd).toBe(0.06);
        expect(data.lines[0]).toEqual({
            source: 'main',
            usd: 0.03,
            requests: 1,
            prompt: 12000,
            completion: 600,
            cached: 0,
            cacheShare: 0,
        });
        expect(data.averageUsd).toBe(0.01);
        expect(data.quality).toEqual({ ok: false, action: 'swiped', defects: ['english'], judgeUsd: 0.001 });
        expect(data.providerCache).toEqual({ hitRate: 0.12, firstChangeAt: 4 });
        expect(data.reasons.map((reason: { code: string }) => reason.code)).toEqual([
            'retries',
            'lowCache',
            'loreHeavy',
            'aboveAverage',
        ]);
        expect(output.summary).toBe('Turn #5: $0.06, 4 reasons');
        const ru = await runTool(
            readTools(fake.app),
            'cost_turn',
            { message_index: 3 },
            toolContext(fake, { locale: 'ru' }),
        );
        expect(ru.summary).toBe('Ход №3: $0.01');
        expect((ru.data as Loose).lines[0].cacheShare).toBe(0.89);
    });

    it('says when the turn has no spend', async () => {
        const fake = fakeApp({ apis: { treasurer: { turns: () => [] } } });
        const output = await runTool(readTools(fake.app), 'cost_turn', {}, toolContext(fake));
        expect(output.summary).toBe('No spend recorded for this turn.');
    });

    it('sums a period through the treasurer, or today through the core meter', async () => {
        const treasurer = {
            summary: (period: string) => ({
                period,
                from: 1_760_000_000_000,
                to: 1_760_000_100_000,
                totalUsd: 0.25,
                totalAnlas: 10,
                lines: [
                    { source: 'main', usd: 0.25, requests: 5, tokens: { prompt: 1, completion: 1 }, estimated: false },
                ],
            }),
            days: async (limit: number) =>
                Array.from({ length: limit }, (_, index) => ({
                    period: 'day',
                    from: 1_760_000_000_000 + index * 86_400_000,
                    to: 0,
                    totalUsd: 0.5,
                    totalAnlas: 0,
                    lines: [],
                })),
        };
        const core = { todayUsd: 0.3, todayBySource: { main: 0.3 }, backgroundTodayUsd: 0.05, anlasToday: 0 };
        const fake = fakeApp({ apis: { treasurer }, costSummary: core });
        const tools = readTools(fake.app);
        const day = await runTool(tools, 'cost_summary', {}, toolContext(fake, { locale: 'ru' }));
        expect((day.data as Loose).core.backgroundTodayUsd).toBe(0.05);
        expect(day.summary).toBe('Расходы (день): $0.250');
        const session = await runTool(tools, 'cost_summary', { period: 'session' }, toolContext(fake));
        expect((session.data as Loose).core).toBeUndefined();
        const days = await runTool(tools, 'cost_summary', { period: 'days', days: 3 }, toolContext(fake));
        expect((days.data as Loose).days).toHaveLength(3);
        expect(days.summary).toBe('3 days: $1.50');
        const off = fakeApp({ costSummary: core });
        const coreOnly = await runTool(readTools(off.app), 'cost_summary', { period: 'session' }, toolContext(off));
        expect((coreOnly.data as Loose).core.todayUsd).toBe(0.3);
        expect(coreOnly.summary).toBe('Today: $0.3');
    });
});

describe('output size', () => {
    it('keeps a busy turn with entries about a name under the core result cap', async () => {
        const long = 'L'.repeat(300);
        const activations = Array.from({ length: 80 }, (_, index) =>
            activation(index + 1, { comment: long, key: long, tags: ['canon', 'des.book'] }),
        );
        const entries: Record<string, Record<string, unknown>> = {};
        for (let uid = 1; uid <= 20; uid++) {
            entries[String(uid)] = {
                uid,
                comment: `Анна ${long}`,
                key: Array.from({ length: 30 }, (_, index) => `Анна${index}`),
                content: long,
                probability: 50,
                group: long,
                characterFilter: { names: [long, long] },
            };
        }
        const fake = fakeApp({
            chat: [userMsg('Ты помнишь Анну?')],
            apis: {
                loreJournal: {
                    turns: () => [loreRecord(9, activations)],
                    attributeKeys: async (record: TurnLoreRecord) => record,
                    whyActive: async () => [{ book: 'World', reasons: ['global'] }],
                },
                loreStore: { books: () => ['World'], load: async () => ({ entries }) },
            },
        });
        const output = await runTool(
            readTools(fake.app),
            'lore_turn',
            { name: 'Анна' },
            toolContext(fake, { locale: 'ru' }),
        );
        expect(JSON.stringify(output.data).length).toBeLessThan(12000);
        expect((output.data as Loose).about.entries).toHaveLength(8);
    });
});
