import { describe, expect, it } from 'vitest';
import {
    AI_MAX_CONFLICTS,
    AI_SCHEMA,
    AI_SCHEMA_NAME,
    buildAiRequest,
    estimateAi,
    locateQuote,
    ownerText,
    parseAiAnswer,
} from '../../src/domain/prompt-audit-ai';
import { itemsByRef } from '../../src/domain/prompt-audit-map';
import { matchesSchema } from '../../src/core/llm';
import { analyseRequest, buildReply } from '../../tools/mock-llm/scenarios.mjs';
import { item, realCaseCapture } from '../helpers/prompt-audit-fixtures';

type Dict = Record<string, unknown>;

describe('the request', () => {
    it('sends the map of instructions with short ids, owners, places, the message order and the model quirks', () => {
        const capture = realCaseCapture();
        const request = buildAiRequest(capture, 'ru');
        expect([...request.ids.entries()]).toEqual([
            ['I1', 'preset:task'],
            ['I2', 'preset:world'],
            ['I3', 'preset:format'],
            ['I4', 'slot:dooms-tracker-inject'],
            ['I5', 'slot:nai_studio_markers'],
        ]);
        expect(request.system).toContain('plain Russian');
        expect(request.user).toContain('Model: deepseek/deepseek-v4-flash via openrouter.');
        expect(request.user).toContain('merged into the neighbouring turns');
        expect(request.user).toContain(
            '[I1] Preset «Marinara», block «Task» · system · among the prompt blocks · message #1',
        );
        expect(request.user).toContain(
            '[I4] DES (tracker extension) · user · inside the chat history at depth 0 · message #5',
        );
        expect(request.user).toContain('… chat history: 3 message(s) …');
        expect(request.user).toContain('#6 system: I5 — 80 chars (last)');
        expect(request.chars).toBe(request.system.length + request.user.length);
        expect(buildAiRequest(capture, 'en').system).toContain('plain English');
    });

    it('names owners for the model', () => {
        expect(ownerText(item({ ref: 'slot:m', owner: 'maestro', module: 'wardrobe', text: 'x' }))).toBe(
            'Maestro (conductor extension): wardrobe',
        );
        expect(ownerText(item({ ref: 'lore:B#1', owner: 'bunnymo', book: 'B', label: 'Core', text: 'x' }))).toBe(
            'BunnyMo lorebook (read-only) «B» → «Core»',
        );
    });

    it('estimates the size and the price', () => {
        const estimate = estimateAi(3500, 1000);
        expect(estimate.inputTokens).toBe(1050);
        expect(estimate.outputTokens).toBe(1000);
        expect(estimate.usd).toBeCloseTo((2050 / 1_000_000) * 0.5);
    });

    it('has a strict schema the mock LLM answers', () => {
        const capture = realCaseCapture();
        const request = buildAiRequest(capture, 'ru');
        const ctx = analyseRequest({
            messages: [
                { role: 'system', content: request.system },
                { role: 'user', content: request.user },
            ],
            response_format: { type: 'json_schema', json_schema: { name: AI_SCHEMA_NAME, schema: AI_SCHEMA } },
        });
        const reply = buildReply(ctx) as { content: string };
        const data = JSON.parse(reply.content) as Dict;
        expect(matchesSchema(data, AI_SCHEMA)).toBe(true);
        const conflicts = parseAiAnswer(data, request.ids, itemsByRef(capture));
        expect(conflicts).toHaveLength(1);
        expect(conflicts![0]).toMatchObject({
            topic: 'ai',
            severity: 'medium',
            a: { ref: 'preset:task', quote: 'Write the next reply of the story as {{char}}.' },
            b: {
                ref: 'preset:world',
                quote: 'Every turn something happens in the world: an event, a complication or a twist.',
            },
            fix: {
                side: 'a',
                kind: 'edit',
                target: 'preset:task',
                before: 'Write the next reply of the story as {{char}}.',
                after: 'Write the next reply of the story as {{char}}. (mock fix)',
            },
        });
    });
});

describe('the answer', () => {
    const capture = realCaseCapture();
    const request = buildAiRequest(capture, 'en');
    const items = itemsByRef(capture);
    const conflict = (extra: Dict = {}): Dict => ({
        severity: 'high',
        a: { owner: 'Preset', ref: 'I1', quote: 'Keep it short:   ONE line, no more than 150 words.' },
        b: {
            owner: 'DES',
            ref: '[I4]',
            quote: 'At the start of every reply attach the tracker JSON in a ```json code block.',
        },
        why: ' The reply cannot hold the JSON. ',
        risk_for_model: 'The tracker is dropped.',
        fix: { side: 'a', kind: 'edit', target: 'I1', after_text: 'Keep it short.', scope_hint: 'chat' },
        ...extra,
    });

    it('maps ids back, finds the exact quote despite case and spaces, keeps the fix', () => {
        const parsed = parseAiAnswer({ conflicts: [conflict()] }, request.ids, items)!;
        expect(parsed[0]).toEqual({
            topic: 'ai',
            severity: 'high',
            a: { ref: 'preset:task', quote: 'Keep it short: one line, no more than 150 words.' },
            b: {
                ref: 'slot:dooms-tracker-inject',
                quote: 'At the start of every reply attach the tracker JSON in a ```json code block.',
            },
            why: 'The reply cannot hold the JSON.',
            risk: 'The tracker is dropped.',
            fix: {
                side: 'a',
                kind: 'edit',
                target: 'preset:task',
                before: 'Keep it short: one line, no more than 150 words.',
                after: 'Keep it short.',
                scopeHint: 'chat',
            },
        });
    });

    it('drops unknown or identical references and empty explanations; a quote not found loses an edit fix', () => {
        const parsed = parseAiAnswer(
            JSON.stringify({
                conflicts: [
                    conflict({ a: { ref: 'I99', quote: 'x' } }),
                    conflict({ b: { ref: 'I1', quote: 'Keep it short.' } }),
                    conflict({ why: '' }),
                    conflict({ a: { owner: 'x', ref: 'I1', quote: 'A sentence that is not there at all.' } }),
                    'junk',
                ],
            }),
            request.ids,
            items,
        )!;
        expect(parsed).toHaveLength(1);
        expect(parsed[0]!.fix).toBeUndefined();
        expect(parseAiAnswer('not json', request.ids, items)).toBeNull();
        expect(parseAiAnswer({ nope: [] }, request.ids, items)).toBeNull();
    });

    it('reads every kind of fix', () => {
        const fix = (value: Dict) =>
            parseAiAnswer({ conflicts: [conflict({ fix: value })] }, request.ids, items)![0]!.fix;
        expect(fix({ side: 'b', kind: 'remove', target: 'I4', after_text: '', scope_hint: 'global' })).toMatchObject({
            side: 'b',
            kind: 'remove',
            target: 'slot:dooms-tracker-inject',
            before: 'At the start of every reply attach the tracker JSON in a ```json code block.',
            after: '',
        });
        expect(
            fix({ side: 'b', kind: 'role', target: 'I4', after_text: 'System', scope_hint: 'global' }),
        ).toMatchObject({
            kind: 'role',
            role: 'system',
        });
        expect(
            fix({ side: 'a', kind: 'role', target: 'I1', after_text: 'пользователь', scope_hint: 'global' }),
        ).toMatchObject({
            role: 'user',
        });
        expect(fix({ side: 'a', kind: 'move', target: 'I1', after_text: '3', scope_hint: 'global' })).toMatchObject({
            depth: 3,
        });
        expect(fix({ side: 'a', kind: 'toggle', target: 'I1', after_text: '', scope_hint: 'global' })).toMatchObject({
            enabled: false,
        });
        expect(
            fix({ side: 'a', kind: 'move', target: 'I1', after_text: 'deep', scope_hint: 'global' }),
        ).toBeUndefined();
        expect(
            fix({ side: 'a', kind: 'role', target: 'I1', after_text: 'narrator', scope_hint: 'global' }),
        ).toBeUndefined();
        expect(fix({ side: 'a', kind: 'edit', target: 'I1', after_text: '', scope_hint: 'global' })).toBeUndefined();
        expect(fix({ side: 'a', kind: 'explode', target: 'I1', after_text: '', scope_hint: 'global' })).toBeUndefined();
        expect(fix({ side: 'a', kind: 'edit', target: 'I2', after_text: 'x', scope_hint: 'global' })).toBeUndefined();
    });

    it('takes at most the schema’s number of conflicts', () => {
        const many = Array.from({ length: AI_MAX_CONFLICTS + 3 }, () => conflict());
        expect(parseAiAnswer({ conflicts: many }, request.ids, items)).toHaveLength(AI_MAX_CONFLICTS);
    });

    it('locates quotes exactly or loosely', () => {
        expect(locateQuote('Hello  World. Bye.', 'hello world.')).toBe('Hello  World.');
        expect(locateQuote('Hello World.', 'Hello World…')).toBe('Hello World');
        expect(locateQuote('abc', 'ab')).toBeNull();
        expect(locateQuote('Some text here.', 'Other text here.')).toBeNull();
    });
});
