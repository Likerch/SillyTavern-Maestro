import { describe, expect, it } from 'vitest';
import {
    buildHistory,
    clip,
    estimateTokens,
    groupTurns,
    messagesTokens,
    toolMessageContent,
    turnLine,
} from '../../src/domain/assistant-history';
import type { HistoryCall, HistoryMessage } from '../../src/domain/assistant-history';

const user = (text: string): HistoryMessage => ({ role: 'user', text });
const reply = (text: string, toolCalls?: HistoryCall[]): HistoryMessage => ({ role: 'assistant', text, toolCalls });
const call = (id: string, extra: Partial<HistoryCall> = {}): HistoryCall => ({
    id,
    name: 'get_x',
    args: { a: 1 },
    status: 'ok',
    result: 'R',
    ...extra,
});

function conversation(turns: number): HistoryMessage[] {
    const out: HistoryMessage[] = [];
    for (let i = 1; i <= turns; i++) {
        out.push(user(`question ${i}`));
        out.push(reply('', [call(`c${i}`)]));
        out.push(reply(`answer ${i}`));
    }
    return out;
}

describe('assistant-history', () => {
    it('estimates tokens', () => {
        expect(estimateTokens('')).toBe(0);
        expect(estimateTokens('abcd')).toBe(2);
        expect(messagesTokens([{ role: 'user', content: 'abcd' }])).toBe(6);
        expect(messagesTokens([{ role: 'assistant', content: '', tool_calls: [{ id: 'x' }] }])).toBeGreaterThan(4);
    });

    it('groups turns at user messages', () => {
        const notice: HistoryMessage = { role: 'notice', text: 'n' };
        expect(groupTurns([notice, user('a'), reply('b'), user('c')])).toEqual([
            [notice],
            [user('a'), reply('b')],
            [user('c')],
        ]);
        expect(groupTurns([])).toEqual([]);
    });

    it('tells the model what a call returned', () => {
        expect(toolMessageContent(call('a'))).toBe('R');
        expect(toolMessageContent(call('a', { result: undefined }))).toBe('ok');
        expect(toolMessageContent(call('a', { untrusted: true }))).toContain('<data source="get_x">\nR\n</data>');
        expect(toolMessageContent(call('a', { status: 'applied', summary: 'S', result: '{"uid":1}' }))).toBe(
            'Applied: S. Result: {"uid":1}',
        );
        expect(toolMessageContent(call('a', { status: 'applied', summary: undefined, result: undefined }))).toBe(
            'Applied.',
        );
        expect(toolMessageContent(call('a', { status: 'declined' }))).toContain('declined');
        expect(toolMessageContent(call('a', { status: 'error', error: 'boom' }))).toBe('Error: boom.');
        expect(toolMessageContent(call('a', { status: 'error' }))).toBe('Error: the tool failed.');
        expect(toolMessageContent(call('a', { status: 'waiting' }))).toContain('interrupted');
    });

    it('keeps everything in full when it fits', () => {
        const history = [
            user('q'),
            reply('', [call('c1')]),
            reply('a'),
            { role: 'notice', text: 'skip' } as HistoryMessage,
        ];
        const built = buildHistory(history, { budgetTokens: 10_000, fullTurns: 3 });
        expect(built.earlier).toEqual([]);
        expect(built.omitted).toBe(0);
        expect(built.messages).toEqual([
            { role: 'user', content: 'q' },
            {
                role: 'assistant',
                content: '',
                tool_calls: [{ id: 'c1', type: 'function', function: { name: 'get_x', arguments: '{"a":1}' } }],
            },
            { role: 'tool', tool_call_id: 'c1', content: 'R' },
            { role: 'assistant', content: 'a' },
        ]);
    });

    it('drops tool results of turns older than fullTurns', () => {
        const built = buildHistory(conversation(4), { budgetTokens: 10_000, fullTurns: 2 });
        const roles = built.messages.map((message) => message.role);
        expect(roles).toEqual([
            'user',
            'assistant',
            'user',
            'assistant',
            'user',
            'assistant',
            'tool',
            'assistant',
            'user',
            'assistant',
            'tool',
            'assistant',
        ]);
        expect(built.messages[1]?.content).toBe('answer 1\n[tools: get_x]');
    });

    it('shrinks the oldest turns to lines, then omits them, within the budget', () => {
        const history = conversation(30);
        const built = buildHistory(history, { budgetTokens: 400, fullTurns: 3 });
        expect(built.messages.at(-1)?.content).toBe('answer 30');
        expect(built.earlier.length).toBeGreaterThan(0);
        expect(built.omitted).toBeGreaterThan(0);
        expect(
            built.earlier.length +
                built.omitted +
                new Set(built.messages.filter((m) => m.role === 'user').map((m) => m.content)).size,
        ).toBe(30);
        expect(built.earlier[0]).toMatch(/^User: «question \d+» → Assistant: «answer \d+» → \[get_x\]$/);
        const cost =
            messagesTokens(built.messages) + built.earlier.reduce((sum, line) => sum + estimateTokens(line) + 1, 0);
        expect(cost).toBeLessThanOrEqual(400);
    });

    it('keeps a share of the budget for lines even when long turns would fill it', () => {
        const history: HistoryMessage[] = [];
        for (let i = 1; i <= 12; i++) history.push(user(`question ${i}`), reply(`answer ${i} ${'long '.repeat(300)}`));
        const built = buildHistory(history, { budgetTokens: 2000, fullTurns: 3 });
        expect(built.messages.filter((message) => message.role === 'user').length).toBe(3);
        expect(built.earlier.length).toBeGreaterThanOrEqual(3);
        expect(built.earlier.every((line) => line.length < 320)).toBe(true);
        expect(built.omitted).toBe(12 - 3 - built.earlier.length);
    });

    it('with no budget, everything is omitted', () => {
        expect(buildHistory(conversation(2), { budgetTokens: 0, fullTurns: 3 })).toEqual({
            messages: [],
            earlier: [],
            omitted: 2,
        });
    });

    it('describes calls in compact turns and lines', () => {
        const turn = [
            user('change it'),
            reply('', [
                call('a', { name: 'set_x', status: 'applied', summary: 'X: 1 → 2' }),
                call('b', { name: 'set_y', status: 'declined' }),
                call('c', { name: 'get_z', status: 'error', error: 'e' }),
            ]),
        ];
        const built = buildHistory([...turn, ...conversation(1)], { budgetTokens: 10_000, fullTurns: 1 });
        expect(built.messages[1]?.content).toBe('[tools: set_x applied (X: 1 → 2); set_y declined; get_z failed]');
        expect(turnLine(turn)).toBe(
            'User: «change it» → Assistant: no answer → [set_x applied (X: 1 → 2); set_y declined; get_z failed]',
        );
        expect(turnLine([reply('orphan')])).toBe('User: — → Assistant: «orphan»');
        expect(buildHistory([user('just a question')], { budgetTokens: 10_000, fullTurns: 0 }).messages).toEqual([
            { role: 'user', content: 'just a question' },
        ]);
    });

    it('clips text to one line', () => {
        expect(clip('  a\n b  ', 10)).toBe('a b');
        expect(clip('abcdef', 4)).toBe('abc…');
    });
});
