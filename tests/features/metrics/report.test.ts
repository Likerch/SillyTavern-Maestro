// Texts of the criteria table and the export (src/features/metrics/report.ts) in both languages.
import { describe, expect, it } from 'vitest';
import { createI18n } from '../../../src/core/i18n';
import { comparePacks, sheetSummary, turnCounts } from '../../../src/domain/metrics-checks';
import { buildCriteria } from '../../../src/domain/metrics-report';
import type { CriteriaInput, CriterionRow } from '../../../src/domain/metrics-report';
import { costShare, summarizeLatency } from '../../../src/domain/metrics-stats';
import { M21M_STRINGS } from '../../../src/features/metrics';
import type { MetricsSnapshot } from '../../../src/features/metrics';
import { criterionText, renderJson, renderMarkdown, statusLabel } from '../../../src/features/metrics/report';

function i18n(locale: 'ru' | 'en') {
    const value = createI18n(() => locale);
    value.register(M21M_STRINGS);
    return value;
}

function richInput(): CriteriaInput {
    const turns = Array.from({ length: 25 }, (_, i) => ({ at: i * 10, auto: i === 24 }));
    return {
        latency: summarizeLatency([
            ...Array.from({ length: 25 }, (_, i) => ({
                device: 'desktop' as const,
                sendMs: 900 + i,
                windowMs: 990,
                maestroMs: 20 + i,
            })),
            { device: 'phone' as const, sendMs: 1200, maestroMs: 320, modules: { 'rules.scan': 4 } },
        ]),
        cost: costShare(
            [
                { at: 1, source: 'main', usd: 0.5 },
                { at: 2, source: 'maestro', usd: 0.04 },
                { at: 245, source: 'main', usd: 0.02 },
                { at: 246, source: 'qvink', usd: 0.01 },
            ],
            turns,
        ),
        lore: {
            ratio: { ratio: 0.45, source: 'whatIf' },
            current: { avg: 4500, turns: 25 },
            whatIf: { at: 1, before: 10_000, after: 4500, ruleIds: ['book.cap'], removed: 7 },
        },
        dropped: turnCounts([0, 2, 1]),
        assistantDepth: turnCounts([0, 0]),
        tabs: { observedTurns: 25, staleSaves: 1, dataLosses: 2, blocked: 3, staleEpisodes: 1 },
        revision: { decisions: 12, acceptedAsIs: 9, edited: 2, rejected: 1, share: 0.75 },
        undo: { actions: 40, undone: 1, share: 0.025 },
        living: { provisional: 12, droppedByUser: 3, contradictedAfterConfirm: 1 },
        sheets: sheetSummary(
            [
                { index: 1, text: 'no tags', committed: false },
                { index: 3, text: '<BunnymoTags><Name:Вера>, <GENRE:FANTASY></BunnymoTags>', committed: true },
            ],
            5,
            true,
        ),
        packs: comparePacks(
            { Core: { hash: 'a', bytes: 1, at: 0 }, Dere: { hash: 'b', bytes: 1, at: 0 } },
            { Core: { hash: 'a', bytes: 1, at: 0 }, Dere: { hash: 'x', bytes: 1, at: 0 } },
        ),
    };
}

function texts(rows: CriterionRow[], locale: 'ru' | 'en'): Record<string, string> {
    const t = i18n(locale);
    // Intl puts no-break spaces into Russian numbers and currency.
    return Object.fromEntries(rows.map((row) => [row.key, criterionText(row, t).current.replace(/\u00a0/g, ' ')]));
}

describe('criterion texts', () => {
    it('words every measured value in English', () => {
        const current = texts(buildCriteria(richInput()), 'en');
        expect(current).toEqual({
            latency: 'PC: p95 43 ms (p50 32 ms, samples: 25); phone: p95 320 ms (p50 320 ms, samples: 1)',
            cost: '12 % ($0.06 of $0.50), turns: 25 Auto-swipes: 1.',
            lore: '45 % of the lore without rules (characters: 4,500 of 10,000)',
            dropped: 'turns with dropped messages: 2 of 3 (at most 2 in one turn)',
            assistantDepth: 'turns with such entries: 0 of 2 (at most 0 in one turn)',
            tabs: 'rollbacks: 1, losses: 2, the tab went stale: 1 Saves blocked now: 3.',
            autonomy: 'revision: 75 % as is (decisions: 12); undone: 2.5 % (actions: 40)',
            living: 'dropped: 25 % (provisional facts: 12); contradictions: 1',
            sheets: 'sheets: 2, with problems: 1 (not folded: 1, tags not shown: 1)',
            packs: 'checked: 2, changed: 1, missing: 0',
        });
    });

    it('words every measured value in natural Russian', () => {
        const current = texts(buildCriteria(richInput()), 'ru');
        expect(current.latency).toBe(
            'ПК: p95 43 мс (p50 32 мс, замеров: 25); телефон: p95 320 мс (p50 320 мс, замеров: 1)',
        );
        expect(current.cost!.replace(/\u00a0/g, ' ')).toBe('12 % (0,06 $ из 0,50 $), ходов: 25 Авто-свайпов: 1.');
        expect(current.lore).toBe('45 % от лора без правил (символов: 4 500 из 10 000)');
        expect(current.dropped).toBe('ходов с выпавшими: 2 из 3 (больше всего за ход: 2)');
        expect(current.living).toBe('удалено: 25 % (пробных фактов: 12); противоречий: 1');
        expect(current.sheets).toBe('листов: 2, с проблемами: 1 (не свёрнуто: 1, теги не видны: 1)');
    });

    it('says when nothing is measured yet', () => {
        const empty = buildCriteria({
            ...richInput(),
            latency: summarizeLatency([]),
            cost: costShare([], []),
            lore: { ratio: { source: 'none' }, current: { turns: 0 } },
            dropped: turnCounts([]),
            assistantDepth: turnCounts([]),
            tabs: { observedTurns: 0, staleSaves: 0, dataLosses: 0 },
            revision: { decisions: 0, acceptedAsIs: 0, edited: 0, rejected: 0 },
            undo: { actions: 0, undone: 0 },
            living: null,
            sheets: null,
            packs: null,
        });
        expect(texts(empty, 'en')).toEqual({
            latency: 'PC: no samples; phone: no samples',
            cost: 'the main model cost nothing yet (turns: 0)',
            lore: 'no data yet',
            dropped: 'Qvink does not remove messages in this chat',
            assistantDepth: 'no data yet',
            tabs: 'rollbacks: 0, losses: 0, the tab went stale: 0',
            autonomy: 'revision: no decisions yet; undone: no actions yet',
            living: 'the living canon reports nothing yet',
            sheets: 'no sheets in this chat',
            packs: 'not checked yet',
        });
    });

    it('words a baseline comparison and the current average', () => {
        const input = richInput();
        input.lore = {
            ratio: { ratio: 0.6, source: 'baseline' },
            current: { avg: 600, turns: 30 },
            baseline: { avgChars: 1000, turns: 50, from: 0, to: 1, rulesOff: true, at: 0 },
        };
        expect(texts(buildCriteria(input), 'en').lore).toBe(
            '60 % of the baseline (characters per turn: 600 against 1,000)',
        );
        input.lore = { ratio: { source: 'none' }, current: { avg: 800, turns: 4 } };
        expect(texts(buildCriteria(input), 'en').lore).toBe(
            'characters per turn: 800 (turns: 4); press «Compare without the rules»',
        );
        input.living = { provisional: 0, droppedByUser: 0, contradictedAfterConfirm: 0 };
        expect(texts(buildCriteria(input), 'en').living).toBe('dropped: — (provisional facts: 0); contradictions: 0');
    });

    it('labels statuses', () => {
        const t = i18n('ru');
        expect(statusLabel('ok', t)).toBe('✅ выполнен');
        expect(statusLabel('warn', t)).toBe('⚠ не выполнен');
        expect(statusLabel('none', t)).toBe('— нет вывода');
    });
});

describe('export', () => {
    const snapshot = (): MetricsSnapshot => {
        const input = richInput();
        return {
            report: {
                generatedAt: Date.UTC(2026, 9, 4, 12),
                turns: 25,
                startedAt: Date.UTC(2026, 9, 1),
                device: 'desktop',
                rows: buildCriteria(input),
            },
            input,
            latency: input.latency,
            cost: input.cost,
            lore: { current: input.lore.current, ratio: input.lore.ratio, whatIf: input.lore.whatIf },
            idle: {},
            losses: ['Maestro:M1: could not write lore-journal'],
            counters: { 'data.loss': 2 },
            chatId: 'chat-1',
        };
    };

    it('renders Markdown with the criteria, the devices, module timings and spend', () => {
        const markdown = renderMarkdown(snapshot(), i18n('ru'));
        expect(markdown).toContain('# Maestro: критерии R3');
        expect(markdown).toContain(
            'Сформировано 2026-10-04T12:00:00.000Z; замерено ходов: 25, с 2026-10-01T00:00:00.000Z',
        );
        expect(markdown).toContain('| № | Критерий | Цель | Сейчас | Статус | Как измерено | Стенд |');
        expect(markdown).toContain('| 3 | Символы лора на ход | минимум вдвое меньше, без потери нужных записей |');
        expect(markdown.replace(/\u00a0/g, ' ')).toContain('| телефон | 1 | 1 200 | 1 200 | 1 200 | — | 320 |');
        expect(markdown).toContain('## Время модулей Maestro во время генерации');
        expect(markdown).toContain('| rules.scan | 1 | 4 | 4 |');
        expect(markdown.replace(/\u00a0/g, ' ')).toContain('- Авто-свайпы: 0,02 $ (1)');
    });

    it('renders JSON with texts and raw numbers', () => {
        const json = JSON.parse(renderJson(snapshot(), i18n('en'))) as {
            format: string;
            criteria: { key: string; status: string; text: { name: string } }[];
            dataLossSamples: number;
            counters: Record<string, number>;
        };
        expect(json.format).toBe('maestro-r3-metrics');
        expect(json.criteria.map((row) => row.key)).toHaveLength(10);
        expect(json.criteria[0]!.text.name).toBe('Added latency before the request (p95)');
        expect(json.dataLossSamples).toBe(1);
        expect(json.counters).toEqual({ 'data.loss': 2 });
    });
});
