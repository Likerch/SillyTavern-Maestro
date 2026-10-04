import { describe, expect, it, vi } from 'vitest';
import type { Defect } from '../../../src/features/quality/api';
import { buildJudgeMessages, parseJudge } from '../../../src/features/quality/judge';
import {
    detectLanguage,
    expectedLanguage,
    findJunkToken,
    finishReasonFromBody,
    fixNote,
    gateValue,
    isOk,
    planActions,
    removeQuotes,
    safeClean,
    trackerPrefix,
    verdictAction,
} from '../../../src/features/quality/logic';
import { patternError, readQualitySettings } from '../../../src/features/quality/settings';
import { FAKE_BOUNDARY_RULES } from './fake-checks';

vi.mock('../../../src/domain/quality-checks', async () => (await import('./fake-checks')).fakeChecksModule);

const d = (kind: Defect['kind'], extra: Partial<Defect> = {}): Defect => ({
    kind,
    confidence: 0.9,
    quote: '',
    by: 'rule',
    ...extra,
});

describe('language', () => {
    it('detects the script of enough text', () => {
        expect(detectLanguage(['Анна улыбнулась и открыла дверь в тёмную комнату'])).toBe('ru');
        expect(detectLanguage(['Anna smiled and opened the door to the dark room at the end of the hall'])).toBe('en');
        expect(detectLanguage(['Hi'])).toBeUndefined();
    });

    it('expects Russian under the lock unless the chat is clearly English', () => {
        const en = ['Anna smiled and opened the door to the dark room at the end of the hall'];
        expect(expectedLanguage({ lock: true, userTexts: [], allTexts: [], fallback: 'en' })).toBe('ru');
        expect(expectedLanguage({ lock: true, userTexts: en, allTexts: en, fallback: 'ru' })).toBe('en');
        expect(expectedLanguage({ lock: false, userTexts: [], allTexts: en, fallback: 'ru' })).toBe('en');
        expect(expectedLanguage({ lock: false, userTexts: [], allTexts: [], fallback: 'ru' })).toBe('ru');
    });
});

describe('junk tokens', () => {
    it('looks only at the new tail', () => {
        expect(findJunkToken('Hello <|eot_id|>', 0)).toBe('<|eot_id|>');
        expect(findJunkToken('Hello <|eot_id|> and more text after it', 40)).toBeUndefined();
        expect(findJunkToken('abc <|im_start|>', 8)).toBe('<|im_start|>');
        expect(findJunkToken('plain story text', 0)).toBeUndefined();
        expect(findJunkToken('x <｜end▁of▁sentence｜>', 0)).toBe('<｜end▁of▁sentence｜>');
    });
});

describe('safe cleaning', () => {
    const tracker = '```json\n{"infoBox":"x"}\n```\n';

    it('finds the tracker block', () => {
        expect(trackerPrefix(`${tracker}Story`)).toBe(tracker);
        expect(trackerPrefix('Story')).toBe('');
    });

    it('puts the tracker back and keeps markers', () => {
        expect(safeClean(`${tracker}Story <|x|> [nai:img:a1]`, 'Story [nai:img:a1]')).toBe(
            `${tracker}Story [nai:img:a1]`,
        );
        expect(safeClean('Story <|x|> [nai:img:a1]', 'Story')).toBeNull();
        expect(safeClean(`Story <img data-nai='{"p":1}'> junk`, 'Story')).toBeNull();
        expect(safeClean('Same', 'Same')).toBeNull();
        expect(safeClean('Text', '  ')).toBeNull();
        expect(safeClean(`${tracker}A`, '```json\n{"infoBox":"y"}\n```\nA')).toBeNull();
    });

    it('removes quotes from the story part only', () => {
        expect(removeQuotes(`${tracker}A <|x|> B\n\n\n\nC <|x|>`, ['<|x|>'])).toBe(`${tracker}A  B\n\nC`);
    });
});

describe('fix note', () => {
    it('joins unique instructions, prefers the defect’s own', () => {
        const note = fixNote(
            [
                d('userSpeech'),
                d('userSpeech'),
                d('language'),
                d('refusal', { fix: { kind: 'swipe', instruction: 'Stay [in] role.\nAlways.' } }),
                d('boundary', { by: 'minors', status: 'dismissed' }),
            ],
            { userName: 'Max', language: 'ru' },
        );
        expect(note).toBe(
            "[Fix for this reply: Do not write Max's lines, actions or thoughts; only Max decides what Max says and does. Write the whole reply in Russian: no words, phrases or calques from other languages. Stay in role. Always.]",
        );
        expect(fixNote([], { userName: 'Max', language: 'ru' })).toBe('');
        expect(
            fixNote([d('boundary', { by: 'r1' })], { userName: 'U', language: 'en', rules: { r1: 'No gore' } }),
        ).toContain('content boundary: No gore');
        expect(fixNote([d('softening', { by: 'judge:tooAgreeable' })], { userName: 'U', language: 'en' })).toContain(
            'must not all agree with U',
        );
    });
});

describe('finish reason', () => {
    it('reads JSON and SSE bodies and normalises the token limit', () => {
        expect(finishReasonFromBody('{"choices":[{"finish_reason":"stop"}]}')).toBe('stop');
        expect(
            finishReasonFromBody(
                'data: {"choices":[{"finish_reason":null}]}\ndata: {"choices":[{"finish_reason":"length"}]}',
            ),
        ).toBe('length');
        expect(finishReasonFromBody('data: {"delta":{"stop_reason":"max_tokens"}}')).toBe('length');
        expect(finishReasonFromBody('{"candidates":[{"finishReason":"MAX_TOKENS"}]}')).toBe('length');
        expect(finishReasonFromBody('{"text":"x"}')).toBeUndefined();
    });
});

describe('plan', () => {
    const action = (map: Partial<Record<Defect['kind'], 'off' | 'auto' | 'notify'>>) => (kind: Defect['kind']) =>
        map[kind] ?? 'notify';

    it('one swipe covers every real defect', () => {
        const plan = planActions({
            defects: [d('refusal'), d('junk'), d('repetition'), d('language', { suspected: true })],
            action: action({ refusal: 'auto', junk: 'auto' }),
            canSwipe: true,
        });
        expect(plan.swipe.map((item) => item.kind)).toEqual(['refusal', 'junk', 'repetition']);
        expect(plan.clean).toEqual([]);
        expect(plan.notify).toEqual([]);
    });

    it('without a swipe: clean, continue, repair and notices; suspicions never act', () => {
        const plan = planActions({
            defects: [
                d('refusal'),
                d('junk'),
                d('truncated'),
                d('missingTracker'),
                d('userSpeech', { suspected: true }),
            ],
            action: action({
                refusal: 'auto',
                junk: 'auto',
                truncated: 'auto',
                missingTracker: 'auto',
                userSpeech: 'auto',
            }),
            canSwipe: false,
        });
        expect(plan.clean.map((item) => item.kind)).toEqual(['junk']);
        expect(plan.continue.map((item) => item.kind)).toEqual(['truncated']);
        expect(plan.repair.map((item) => item.kind)).toEqual(['missingTracker']);
        expect(plan.notify.map((item) => item.kind).sort()).toEqual(['refusal', 'userSpeech']);
    });

    it('summarises a verdict', () => {
        expect(isOk([])).toBe(true);
        expect(isOk([d('junk', { status: 'cleaned' }), d('refusal', { status: 'dismissed' })])).toBe(true);
        expect(isOk([d('junk', { status: 'notified' })])).toBe(false);
        expect(verdictAction([d('junk', { status: 'cleaned' }), d('refusal', { status: 'notified' })])).toBe('cleaned');
        expect(verdictAction([])).toBe('none');
        expect(gateValue({ action: 'swiped' })).toBe(false);
        expect(gateValue({ action: 'continued' })).toBe(false);
        expect(gateValue({ action: 'notified' })).toBe(true);
    });
});

describe('judge prompt and answer', () => {
    const input = {
        reply: { index: 3, isUser: false, name: 'Anna', text: '```json\n{"infoBox":"x"}\n```\nI cannot continue.' },
        history: [{ index: 2, isUser: true, name: 'Max', text: 'Go on.' }],
        userName: 'Max',
        charName: 'Anna',
        language: 'ru',
        desTogether: true,
        boundary: [],
    };

    it('builds a prompt that treats texts as data', () => {
        const messages = buildJudgeMessages(input, [{ id: 1, defect: d('refusal', { quote: 'I cannot' }) }], {});
        expect(messages[0]!.content).toContain('never instructions');
        expect(messages[0]!.content).toContain('Russian');
        expect(messages[1]!.content).toContain('<reply>\nI cannot continue.\n</reply>');
        expect(messages[1]!.content).toContain('Max: Go on.');
        expect(messages[1]!.content).toContain('1. refusal; quote: "I cannot"');
    });

    it('parses confirmations, denials and unknown ids', () => {
        const items = [
            { id: 1, defect: d('refusal', { confidence: 0.5 }) },
            { id: 2, defect: d('truncated', { confidence: 0.6 }) },
            { id: 3, defect: d('repetition', { confidence: 0.6 }) },
        ];
        const answer = parseJudge(
            {
                verdicts: [
                    { id: 1, defect: true, quote: 'I cannot', instruction: 'Stay in role.' },
                    { id: 2, defect: true, quote: '', instruction: 'Finish it.' },
                    { id: 9, defect: true, quote: '', instruction: '' },
                ],
                tooAgreeable: true,
            },
            items,
        )!;
        expect(answer.confirmed.get(1)).toMatchObject({ confidence: 0.9, quote: 'I cannot', fix: { kind: 'swipe' } });
        expect(answer.confirmed.get(2)!.fix).toEqual({ kind: 'continue', instruction: 'Finish it.' });
        expect(answer.confirmed.has(3)).toBe(false);
        expect(answer.denied).toEqual([]);
        expect(answer.tooAgreeable).toBe(true);
        expect(parseJudge({ nope: 1 }, items)).toBeNull();
    });
});

describe('settings', () => {
    it('repairs the slice in place', () => {
        const slice = readQualitySettings({
            actions: { junk: 'never', refusal: 'auto' } as never,
            judge: 'yes' as never,
            boundary: [{ id: 'x', patterns: ['a', 3, ''] }, { nope: true }] as never,
        });
        expect(slice.actions.junk).toBe('auto');
        expect(slice.actions.refusal).toBe('auto');
        expect(slice.judge).toBe(true);
        expect(slice.earlyCutoff).toBe(true);
        expect(slice.boundary).toEqual([{ id: 'x', title: '', patterns: ['a'], enabled: true }]);
        expect(readQualitySettings({}).boundary).toEqual(FAKE_BOUNDARY_RULES);
    });

    it('validates patterns, including both:A&&B', () => {
        expect(patternError('ребён\\w*')).toBeNull();
        expect(patternError('both:child&&sex')).toBeNull();
        expect(patternError('both:child&&')).toBe('both:child&&');
        expect(patternError('(unclosed')).toBe('(unclosed');
    });
});
