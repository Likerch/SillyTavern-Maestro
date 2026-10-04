// Pure parts of the bench report (tools/stand/measure-lib.mjs) on small recorded requests.
import { describe, expect, it } from 'vitest';
import { percentile as domainPercentile } from '../../../src/domain/metrics-stats';
import { costShare } from '../../../src/domain/metrics-stats';
import {
    analyseRecord,
    buildLoreIndex,
    classifyRequest,
    compareRuns,
    distribution,
    groupTurns,
    loreInText,
    markdownTable,
    metricsFromDoc,
    packIntegrity,
    parseArgs,
    percentile,
    promptText,
    recordBytes,
    recordTime,
    renderReport,
    selectRecords,
    summarizeRun,
    utf8Length,
} from '../../../tools/stand/measure-lib.mjs';

const VELMAR = {
    name: 'Velmar Reaches',
    data: {
        entries: {
            0: {
                uid: 0,
                comment: 'Lighthouse',
                content: 'The old lighthouse of Silver Harbor burns blue when ships are lost at sea.',
            },
            1: {
                uid: 1,
                comment: 'Marsh',
                content: 'The {{char}} marsh swallows careless travellers whole, and the fog never lifts.',
            },
            2: { uid: 2, comment: 'Short', content: 'Too short.' },
            3: {
                uid: 3,
                comment: 'Off',
                disable: true,
                content: 'Disabled entries never count as present in a prompt.',
            },
        },
    },
};
const ARCHIVE = {
    name: 'Архив',
    data: {
        entries: {
            5: {
                uid: 5,
                comment: 'Вера',
                content: 'Вера — капитан портовой стражи, двадцать девять лет, хранит чужие тайны.',
            },
        },
    },
};

let n = 0;
function record(scenario: string, messages: { role: string; content: unknown }[], extra: Record<string, unknown> = {}) {
    n++;
    return {
        n,
        time: new Date(Date.UTC(2026, 9, 4, 12, 0, n)).toISOString(),
        path: '/v1/chat/completions',
        scenario,
        body: { model: 'mock-deepseek-v4', messages, ...((extra.body as object) ?? {}) },
        response: { status: 200, usage: { prompt_tokens: 100 * n, completion_tokens: 10, cost: 0.001 * n } },
        ...extra,
    };
}

const LORE_A = VELMAR.data.entries[0].content;
const LORE_B = VELMAR.data.entries[1].content.replace('{{char}} ', '');
const LORE_C = ARCHIVE.data.entries[5].content;

function story(lore: string[]) {
    return record('story', [
        { role: 'system', content: `Main prompt.\n${lore.join('\n')}` },
        { role: 'user', content: 'Кай идёт к маяку.' },
    ]);
}

describe('numbers', () => {
    it('uses the same nearest-rank percentile as the pult', () => {
        const values = [12, 5, 99, 41, 3, 77, 18, 64, 23, 8];
        for (const p of [0, 10, 50, 90, 95, 100]) expect(percentile(values, p)).toBe(domainPercentile(values, p));
        expect(percentile([], 50)).toBeUndefined();
        expect(percentile([1, 2], NaN)).toBe(1);
        expect(distribution([2, 4])).toEqual({ n: 2, mean: 3, p50: 2, p95: 4, max: 4 });
        expect(distribution([NaN])).toEqual({ n: 0 });
        expect(utf8Length('Вера')).toBe(8);
        expect(utf8Length(undefined)).toBe(0);
    });
});

describe('recorded requests', () => {
    it('classifies by scenario and schema', () => {
        expect(classifyRequest({ scenario: 'story+english' })).toBe('main');
        expect(classifyRequest({ scenario: 'sheet' })).toBe('main');
        expect(classifyRequest({ scenario: 'summary' })).toBe('qvink');
        expect(classifyRequest({ scenario: 'schema:maestro_revision' })).toBe('maestro');
        expect(classifyRequest({ scenario: 'schema:maestro_x(walker)' })).toBe('maestro');
        expect(classifyRequest({ scenario: 'schema:nai_passports' })).toBe('nai');
        expect(classifyRequest({ scenario: 'schema:other' })).toBe('other');
        expect(
            classifyRequest({
                scenario: 'schema-refusal',
                body: { response_format: { type: 'json_schema', json_schema: { name: 'maestro_living_canon' } } },
            }),
        ).toBe('maestro');
        expect(classifyRequest({ scenario: 'tool-call' })).toBe('maestro');
        expect(classifyRequest({ scenario: 'json-object' })).toBe('other');
        expect(classifyRequest({})).toBe('other');
    });

    it('reads time and size, preferring what the mock recorded', () => {
        expect(recordTime({ receivedAt: 1234, time: '2026-10-04T00:00:00.000Z' })).toBe(1234);
        expect(recordTime({ time: '2026-10-04T00:00:00.000Z' })).toBe(Date.UTC(2026, 9, 4));
        expect(recordTime({})).toBe(0);
        expect(recordBytes({ bodyBytes: 77, body: { a: 1 } })).toBe(77);
        expect(recordBytes({ body: { a: 'é' } })).toBe(utf8Length('{"a":"é"}'));
        expect(recordBytes({})).toBe(2);
    });

    it('joins message texts, multimodal parts included', () => {
        expect(
            promptText({
                messages: [{ content: 'a  b' }, { content: [{ type: 'text', text: 'c' }, { type: 'image_url' }] }],
            }),
        ).toBe('a b\nc\n[image]');
        expect(promptText({})).toBe('');
    });
});

describe('lore in prompts', () => {
    const index = buildLoreIndex([VELMAR, ARCHIVE, { name: 'Empty', data: {} }, { name: 'Broken' }]);

    it('indexes enabled entries with a long enough macro-free piece', () => {
        expect(index.map((item) => `${item.book}#${item.uid}`)).toEqual([
            'Velmar Reaches#0',
            'Velmar Reaches#1',
            'Архив#5',
        ]);
        expect(index[0]!.chars).toBe(LORE_A.length);
        expect(buildLoreIndex(undefined)).toEqual([]);
    });

    it('finds entries and counts their characters per book', () => {
        const found = loreInText(`intro ${LORE_A} and ${LORE_C}`, index);
        expect(found.entries.map((item) => item.uid)).toEqual([0, 5]);
        expect(found.chars).toBe(LORE_A.length + LORE_C.length);
        expect(found.byBook['Velmar Reaches']).toEqual({ entries: 1, chars: LORE_A.length });
        expect(loreInText('nothing', undefined)).toEqual({ chars: 0, entries: [], byBook: {} });
    });

    it('analyses a main request and leaves lore out of background ones', () => {
        const row = analyseRecord(story([LORE_A, LORE_B]), index);
        expect(row).toMatchObject({ kind: 'main', status: 200, messages: 2, model: 'mock-deepseek-v4' });
        expect(row.lore.entries).toHaveLength(2);
        expect(row.loreShare).toBeGreaterThan(0.5);
        const summary = analyseRecord(record('summary', [{ role: 'system', content: LORE_A }]), index);
        expect(summary.lore.chars).toBe(0);
        expect(analyseRecord({}).chars).toBe(0);
    });
});

describe('runs', () => {
    const index = buildLoreIndex([VELMAR, ARCHIVE]);
    const run = () => {
        const first = record('schema:nai_passports', [{ role: 'user', content: 'x' }]);
        const a = story([LORE_A, LORE_B, LORE_C]);
        const a1 = record('summary', [{ role: 'system', content: 'summarize' }]);
        const a2 = record('schema:maestro_revision', [{ role: 'user', content: 'x' }]);
        const b = story([LORE_A, LORE_B]);
        const failed = record('story', [{ role: 'user', content: 'x' }], { response: { status: 429, usage: null } });
        return [first, a, a1, a2, b, failed].map((item) => analyseRecord(item, index));
    };

    it('groups background requests into the turn before them', () => {
        const { turns, preamble } = groupTurns(run());
        expect(preamble.map((row) => row.kind)).toEqual(['nai']);
        expect(turns.map((turn) => [turn.index, turn.background.map((row) => row.kind)])).toEqual([
            [1, ['qvink', 'maestro']],
            [2, []],
            [3, []],
        ]);
    });

    it('summarises requests per turn, sizes, lore and costs', () => {
        const summary = summarizeRun(run());
        expect(summary).toMatchObject({ requests: 6, failed: 1, turns: 3, preamble: 1 });
        expect(summary.perTurn).toMatchObject({ n: 3, max: 3 });
        expect(summary.byKind.maestro.requests).toBe(1);
        expect(summary.byKind.qvink.requests).toBe(1);
        expect(summary.byKind.main.requests).toBe(3);
        expect(summary.backgroundShare).toBeCloseTo(summary.byKind.maestro.cost / summary.byKind.main.cost);
        expect(summary.lore.entries.max).toBe(3);
        expect(summary.gaps.n).toBe(2);
        expect(summarizeRun([])).toMatchObject({ requests: 0, turns: 0, from: 0, to: 0 });
    });

    it('compares a run without the rules with a run with them', () => {
        const base = [story([LORE_A, LORE_B, LORE_C]), story([LORE_A, LORE_C])].map((item) =>
            analyseRecord(item, index),
        );
        const current = [story([LORE_A]), story([LORE_A, LORE_B])].map((item) => analyseRecord(item, index));
        const comparison = compareRuns(base, current);
        expect(comparison.turns).toEqual({ base: 2, current: 2, paired: 2 });
        const [a, b, c] = index.map((item) => item.chars) as [number, number, number];
        expect(comparison.lore.ratio).toBeCloseTo((a * 2 + b) / (a * 2 + b + c * 2));
        expect(comparison.lost).toEqual([{ book: 'Архив', uid: 5, comment: 'Вера', turns: 2 }]);
        expect(comparison.added).toEqual([]);
        expect(comparison.perTurnRatio.n).toBe(2);
        expect(compareRuns([], []).lore.ratio).toBeUndefined();
    });
});

describe('Maestro metrics document', () => {
    const turns = [
        {
            id: 'a',
            at: 100,
            device: 'desktop',
            sendMs: 30,
            windowMs: 80,
            maestroMs: 2,
            loreChars: 900,
            dropped: 0,
            assistantDepth: 0,
        },
        {
            id: 'b',
            at: 200,
            device: 'desktop',
            sendMs: 50,
            windowMs: 90,
            maestroMs: 3,
            loreChars: 700,
            dropped: 1,
            assistantDepth: 1,
        },
        { id: 'c', at: 300, device: 'phone', sendMs: 400, auto: true },
    ];
    const costs = [
        { at: 50, source: 'maestro', usd: 5 },
        { at: 110, source: 'main', usd: 0.02 },
        { at: 120, source: 'maestro', usd: 0.002 },
        { at: 210, source: 'main', usd: 0.03 },
        { at: 310, source: 'main', usd: 0.03 },
        { at: 320, source: 'qvink', usd: 0.001 },
        { at: 330, source: 'nai', usd: 0 },
    ];

    it('reads the chat store envelope and matches the pult’s cost share', () => {
        const summary = metricsFromDoc({
            schema: 1,
            version: 3,
            data: { startedAt: 7, turns, costs, counters: { 'data.loss': 0 } },
        });
        expect(summary.turns).toBe(3);
        expect(summary.startedAt).toBe(7);
        expect(summary.latency.desktop.send).toMatchObject({ n: 2, p95: 50 });
        expect(summary.latency.phone.send).toMatchObject({ n: 1, p95: 400 });
        const pult = costShare(
            costs,
            turns.map((turn) => ({ at: turn.at, auto: turn.auto })),
            100,
        );
        expect(summary.cost.share).toBeCloseTo(pult.share!);
        expect(summary.cost.autoSwipes).toBeCloseTo(pult.autoSwipeUsd);
        expect(summary.cost.qvink).toBeCloseTo(0.001);
        expect(summary.dropped).toEqual({ turns: 2, turnsWith: 1, max: 1, total: 1 });
        expect(summary.assistantDepth).toEqual({ turns: 2, turnsWith: 1, max: 1, total: 1 });
        expect(summary.lore.chars).toMatchObject({ n: 2, mean: 800 });
        expect(summary.counters).toEqual({ 'data.loss': 0 });
    });

    it('accepts bare data and empty documents', () => {
        expect(metricsFromDoc({ turns, costs }, { windowTurns: 1 }).cost.turns).toBe(1);
        const empty = metricsFromDoc(null);
        expect(empty).toMatchObject({ turns: 0, startedAt: 0, counters: {} });
        expect(empty.cost.share).toBeUndefined();
    });
});

describe('pack files', () => {
    it('compares installed files with the export', () => {
        const file = (sha256: string, bytes = 10) => ({ sha256, bytes });
        const result = packIntegrity([
            { name: 'Core.json', installed: file('a'), source: file('a') },
            { name: 'Dere.json', installed: file('b'), source: file('c') },
            { name: 'Size.json', installed: file('d', 11), source: file('d', 10) },
            { name: 'Gone.json', installed: null, source: file('e') },
            { name: 'New.json', installed: file('f'), source: null },
        ]);
        expect(result.rows.map((row) => row.status)).toEqual([
            'same',
            'changed',
            'changed',
            'not-installed',
            'no-source',
        ]);
        expect(result).toMatchObject({ same: 1, changed: 2, notInstalled: 1, noSource: 1, ok: false });
        expect(packIntegrity([{ name: 'Core.json', installed: file('a'), source: file('a') }]).ok).toBe(true);
        expect(packIntegrity([]).ok).toBe(false);
    });
});

describe('report', () => {
    it('renders the criteria summary and the details as Markdown', () => {
        const index = buildLoreIndex([VELMAR, ARCHIVE]);
        const base = [story([LORE_A, LORE_B, LORE_C])].map((item) => analyseRecord(item, index));
        const rows = [story([LORE_A]), record('schema:maestro_revision', [{ role: 'user', content: 'x' }])].map(
            (item) => analyseRecord(item, index),
        );
        const desktop = Array.from({ length: 20 }, (_, i) => ({
            id: `d${i}`,
            at: i,
            device: 'desktop',
            sendMs: 900 + i,
            maestroMs: 40 + i,
        }));
        const markdown = renderReport({
            run: summarizeRun(rows),
            comparison: compareRuns(base, rows),
            metrics: [
                {
                    file: 'maestro-chat-abc-metrics.json',
                    summary: metricsFromDoc({ data: { turns: desktop, costs: [], counters: { 'qc.autoSwipe': 2 } } }),
                },
            ],
            packs: packIntegrity([
                { name: 'Core.json', installed: { sha256: 'a', bytes: 1 }, source: { sha256: 'a', bytes: 1 } },
            ]),
            meta: { dir: 'tools/stand/runtime/requests', baselineDir: 'base', generatedAt: Date.UTC(2026, 9, 4) },
        });
        expect(markdown).toContain('# Замеры на стенде (критерии R3)');
        expect(markdown).toContain('база для сравнения: `base`');
        expect(markdown).toMatch(
            /\| 1\. Задержка до запроса, p95 \| .* \| ПК: 58 мс кода Maestro \(замеров: 20\); телефон: нет замеров \| ✅ \|/,
        );
        expect(markdown).toContain(
            '| 10. Файлы паков BunnyMo | побайтно как в выгрузке | совпадают: 1, изменены: 0, нет файла: 0 | ✅ |',
        );
        expect(markdown).toContain('## Лор: сравнение с прогоном без правил');
        expect(markdown).toContain('Velmar Reaches #1 «Marsh»');
        expect(markdown).toContain('## Документ замеров Maestro: `maestro-chat-abc-metrics.json`');
        expect(markdown).toContain('qc.autoSwipe = 2');
        expect(markdown).toContain('| Core.json | same | 1 |');
    });

    it('renders a bare run without optional parts', () => {
        const markdown = renderReport({ run: summarizeRun([]) });
        expect(markdown).toContain('нет базового прогона (--baseline)');
        expect(markdown).toContain('нет документа замеров');
        expect(markdown).not.toContain('## Файлы паков BunnyMo');
        expect(markdownTable(['a|b'], [['c\nd']])).toBe('| a\\|b |\n|---|\n| c d |');
    });
});

describe('arguments', () => {
    it('parses flags with values, inline values and switches', () => {
        expect(parseArgs(['--dir', 'x', '--last=5', '--json', 'extra', '--no-packs'])).toEqual({
            _: ['extra'],
            dir: 'x',
            last: '5',
            json: true,
            'no-packs': true,
        });
    });

    it('selects records by number range and the newest N', () => {
        const records = [{ n: 3 }, { n: 1 }, { n: 2 }, { n: 4 }];
        expect(selectRecords(records).map((item) => item.n)).toEqual([1, 2, 3, 4]);
        expect(selectRecords(records, { from: 2, to: 3 }).map((item) => item.n)).toEqual([2, 3]);
        expect(selectRecords(records, { last: 2 }).map((item) => item.n)).toEqual([3, 4]);
        expect(selectRecords(records, { last: 'x' })).toEqual([]);
    });
});
