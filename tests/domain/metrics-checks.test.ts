import { describe, expect, it } from 'vitest';
import type { QvinkMessageView } from '../../src/domain/medic-qvink';
import {
    assistantAtDepth,
    autonomyVerdict,
    comparePacks,
    dataLossLines,
    droppedWithoutSummary,
    isDataLoss,
    kindMatches,
    livingVerdict,
    packVerdict,
    qvinkOptions,
    revisionShare,
    sheetSummary,
    sheetVerdict,
    turnCounts,
    undoShare,
    zeroVerdict,
} from '../../src/domain/metrics-checks';

const view = (patch: Partial<QvinkMessageView> = {}): QvinkMessageView => ({
    isUser: false,
    isSystem: false,
    textLength: 200,
    skip: false,
    record: null,
    ...patch,
});

describe('criterion 4: dropped without a summary', () => {
    it('counts dropped messages Qvink would summarise but has no memory for', () => {
        const dropped = [
            view(), // counts
            view({ record: { memory: 'Вера пришла.', exclude: false, remember: false } }),
            view({ record: { memory: '   ', exclude: false, remember: false } }), // counts
            view({ record: { memory: '', exclude: true, remember: false } }),
            view({ skip: true }),
            view({ isUser: true }),
            view({ isSystem: true }),
            view({ textLength: 10 }),
        ];
        expect(droppedWithoutSummary(dropped)).toBe(2);
        expect(droppedWithoutSummary(dropped, { includeUser: true, includeSystem: true, minTokens: 0 })).toBe(5);
        expect(droppedWithoutSummary([])).toBe(0);
    });

    it('reads Qvink settings with defaults', () => {
        expect(qvinkOptions(null)).toEqual({ includeUser: false, includeSystem: false, minTokens: 10 });
        expect(
            qvinkOptions({ include_user_messages: true, include_system_messages: true, message_length_threshold: 3 }),
        ).toEqual({ includeUser: true, includeSystem: true, minTokens: 3 });
        expect(qvinkOptions({ message_length_threshold: -1 }).minTokens).toBe(10);
        expect(qvinkOptions({ message_length_threshold: 'x' }).minTokens).toBe(10);
    });
});

describe('criterion 5: assistant-role lore at depth', () => {
    it('counts activations that reached the prompt at depth as assistant', () => {
        expect(
            assistantAtDepth([
                { position: 4, role: 2 },
                { position: 4, role: 2, cut: true },
                { position: 4, role: 0 },
                { position: 1, role: 2 },
                { position: 4 },
            ]),
        ).toBe(1);
    });
});

describe('criterion 6: data losses in the log', () => {
    const line = (text: string, level = 'warn', at = 10) => ({ at, level, scope: 'Maestro:M1', text });

    it('recognises failed writes and unjournaled actions', () => {
        expect(isDataLoss(line('could not write lore-journal'))).toBe(true);
        expect(isDataLoss(line('the lore journal was not saved (another tab keeps writing it)'))).toBe(true);
        expect(isDataLoss(line('lore change was not journaled'))).toBe(true);
        expect(isDataLoss(line('inbox could not be saved after 3 attempts', 'error'))).toBe(true);
        expect(isDataLoss(line('saveMetadata failed'))).toBe(true);
        expect(isDataLoss(line('canon.fact: applied but not journaled', 'error'))).toBe(true);
    });

    it('ignores the guard refusing a stale save, other warnings and info lines', () => {
        expect(isDataLoss(line('stale tab: an older settings save was refused'))).toBe(false);
        expect(isDataLoss(line('ST event X is missing'))).toBe(false);
        expect(isDataLoss(line('could not write lore-journal', 'info'))).toBe(false);
    });

    it('keeps only lines newer than the cursor', () => {
        const lines = [
            line('could not write a', 'warn', 5),
            line('could not write b', 'warn', 15),
            line('fine', 'warn', 20),
        ];
        expect(dataLossLines(lines, 10).map((item) => item.text)).toEqual(['could not write b']);
        expect(dataLossLines(lines)).toHaveLength(2);
    });
});

describe('criterion 7: revision and undo shares', () => {
    const stats = [
        { kind: 'canon.fact', accepted: 6, edited: 2, rejected: 1, undone: 0 },
        { kind: 'revision.alias', accepted: 2, edited: 0, rejected: 0, undone: 1 },
        { kind: 'lore.save', accepted: 50, edited: 0, rejected: 0, undone: 0 },
    ];

    it('matches kinds exactly or by prefix', () => {
        expect(kindMatches('revision.alias', ['revision.'])).toBe(true);
        expect(kindMatches('revisionist', ['revision.'])).toBe(false);
        expect(kindMatches('ck.tags', ['ck*'])).toBe(true);
        expect(kindMatches('canon.fact', ['canon.fact'])).toBe(true);
        expect(kindMatches('canon.factoid', ['canon.fact'])).toBe(false);
    });

    it('sums the revision kinds only', () => {
        const share = revisionShare(stats, ['revision.', 'canon.fact']);
        expect(share).toMatchObject({ decisions: 11, acceptedAsIs: 8, edited: 2, rejected: 1 });
        expect(share.share).toBeCloseTo(8 / 11);
        expect(revisionShare(stats, ['nothing'])).toEqual({ decisions: 0, acceptedAsIs: 0, edited: 0, rejected: 0 });
    });

    it('measures the undone share of journaled actions', () => {
        expect(undoShare([{ undone: true }, {}, {}, {}])).toEqual({ actions: 4, undone: 1, share: 0.25 });
        expect(undoShare([])).toEqual({ actions: 0, undone: 0 });
    });

    it('needs enough decisions and actions for a verdict', () => {
        const good = { decisions: 10, acceptedAsIs: 8, edited: 1, rejected: 1, share: 0.8 };
        const bad = { ...good, acceptedAsIs: 5, share: 0.5 };
        const fewUndone = { actions: 40, undone: 1, share: 0.025 };
        const manyUndone = { actions: 40, undone: 4, share: 0.1 };
        expect(autonomyVerdict(good, fewUndone)).toBe('ok');
        expect(autonomyVerdict(bad, fewUndone)).toBe('warn');
        expect(autonomyVerdict(good, manyUndone)).toBe('warn');
        expect(autonomyVerdict({ ...good, decisions: 3 }, { actions: 5, undone: 0, share: 0 })).toBe('none');
        expect(autonomyVerdict({ ...good, decisions: 3 }, fewUndone)).toBe('ok');
    });
});

describe('criterion 8: living canon', () => {
    it('fails on a contradiction, otherwise judges the drop share from 10 facts', () => {
        expect(livingVerdict(null)).toBe('none');
        expect(livingVerdict({ provisional: 3, droppedByUser: 0, contradictedAfterConfirm: 1 })).toBe('warn');
        expect(livingVerdict({ provisional: 3, droppedByUser: 0, contradictedAfterConfirm: 0 })).toBe('none');
        expect(livingVerdict({ provisional: 10, droppedByUser: 1, contradictedAfterConfirm: 0 })).toBe('ok');
        expect(livingVerdict({ provisional: 10, droppedByUser: 2, contradictedAfterConfirm: 0 })).toBe('warn');
    });
});

describe('criterion 9: sheets', () => {
    const tags = '<BunnymoTags><Name:Вера>, <GENRE:FANTASY>, <INTJ-H></BunnymoTags>';
    const sheet = `## SECTION 1/14: Core\n**Name:** Вера\n- **Возраст:** 29\n\n${tags}`;

    it('finds scene tails, tracker JSON, unfolded old sheets and missing tags', () => {
        const summary = sheetSummary(
            [
                { index: 2, text: sheet, committed: true },
                { index: 4, text: `${sheet}\n\nВера кивнула и вышла из комнаты, не сказав ни слова.`, committed: true },
                {
                    index: 6,
                    text: `${sheet}\n\n\`\`\`json\n{"infoBox": {"location": "маяк"}, "characters": []}\n\`\`\``,
                    committed: false,
                },
                {
                    index: 9,
                    text: '## SECTION 1/3: Core\n**Name:** Март\n\n## SECTION 2/3: Mind\n- calm',
                    committed: false,
                },
            ],
            8,
            true,
        );
        expect(summary.sheets).toBe(4);
        expect(summary.tail).toBe(1);
        expect(summary.tracker).toBe(1);
        expect(summary.notCollapsed).toBe(1);
        expect(summary.noTags).toBe(1);
        expect(summary.findings.map((item) => item.index)).toEqual([4, 6, 9]);
        expect(sheetVerdict(summary)).toBe('warn');
    });

    it('is clean for folded sheets with visible tags; no sheets means no verdict', () => {
        const clean = sheetSummary([{ index: 2, text: sheet, committed: true }], 3, true);
        expect(sheetVerdict(clean)).toBe('ok');
        expect(sheetVerdict(sheetSummary([{ index: 2, text: sheet, committed: true }], 3, false))).toBe('warn');
        expect(sheetVerdict(sheetSummary([], -1, true))).toBe('none');
    });
});

describe('criterion 10: pack fingerprints', () => {
    const fp = (hash: string, bytes = 10) => ({ hash, bytes, at: 1 });

    it('sorts books into same, changed, missing and added', () => {
        const result = comparePacks(
            { Core: fp('a'), Dere: fp('b'), Gone: fp('c'), Skip: fp('d'), Size: fp('e', 10) },
            { Core: fp('a'), Dere: fp('x'), Gone: null, New: fp('n'), Size: fp('e', 11), Nope: null },
        );
        expect(result).toEqual({
            checked: 4,
            same: ['Core'],
            changed: ['Dere', 'Size'],
            missing: ['Gone'],
            added: ['New'],
        });
        expect(packVerdict(result)).toBe('warn');
        expect(packVerdict(comparePacks({ Core: fp('a') }, { Core: fp('a') }))).toBe('ok');
        expect(packVerdict(comparePacks({ Core: fp('a') }, { Core: null }))).toBe('warn');
        expect(packVerdict(null)).toBe('none');
        expect(packVerdict(comparePacks({}, { New: fp('n') }))).toBe('none');
    });
});

describe('per-turn counts', () => {
    it('counts turns, turns with occurrences, the worst turn and the total', () => {
        expect(turnCounts([0, 2, undefined, 1, NaN, 0])).toEqual({ turns: 4, turnsWith: 2, max: 2, total: 3 });
        expect(turnCounts([])).toEqual({ turns: 0, turnsWith: 0, max: 0, total: 0 });
    });
});

describe('zero criteria', () => {
    it('any occurrence fails; nothing observed gives no verdict', () => {
        expect(zeroVerdict(0, 0)).toBe('none');
        expect(zeroVerdict(5, 0)).toBe('ok');
        expect(zeroVerdict(5, 1)).toBe('warn');
        expect(zeroVerdict(0, 1)).toBe('warn');
    });
});
