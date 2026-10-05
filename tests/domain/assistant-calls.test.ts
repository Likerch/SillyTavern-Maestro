import { describe, expect, it } from 'vitest';
import {
    TOOL_NAME,
    argProblems,
    functionSpec,
    parseArgs,
    readToolCalls,
    safeToolName,
    wireCall,
} from '../../src/domain/assistant-calls';

describe('assistant-calls: arguments', () => {
    it('parses objects, JSON strings and nothing', () => {
        expect(parseArgs({ a: 1 })).toEqual({ ok: true, args: { a: 1 } });
        expect(parseArgs('{"a": [1, 2]}')).toEqual({ ok: true, args: { a: [1, 2] } });
        expect(parseArgs(undefined)).toEqual({ ok: true, args: {} });
        expect(parseArgs(null)).toEqual({ ok: true, args: {} });
        expect(parseArgs('  ')).toEqual({ ok: true, args: {} });
    });

    it('repairs sloppy JSON: fences, prose, trailing commas', () => {
        expect(parseArgs('```json\n{"a": 1,}\n```')).toEqual({ ok: true, args: { a: 1 } });
        expect(parseArgs('Here: {"list": [1, 2,], "b": "x"} done')).toEqual({
            ok: true,
            args: { list: [1, 2], b: 'x' },
        });
    });

    it('rejects what is not an object', () => {
        expect(parseArgs('{oops')).toEqual({ ok: false, error: 'arguments are not valid JSON' });
        expect(parseArgs('not json at all')).toEqual({ ok: false, error: 'arguments are not valid JSON' });
        expect(parseArgs('[1, 2]')).toEqual({ ok: false, error: 'arguments must be a JSON object' });
        expect(parseArgs('"text"')).toEqual({ ok: false, error: 'arguments must be a JSON object' });
        expect(parseArgs(5)).toEqual({ ok: false, error: 'arguments must be a JSON object' });
        expect(parseArgs([1])).toEqual({ ok: false, error: 'arguments must be a JSON object' });
    });
});

describe('assistant-calls: tool calls', () => {
    it('reads OpenAI-shaped calls and flat ones', () => {
        let next = 0;
        const makeId = () => `gen${++next}`;
        const calls = readToolCalls(
            [
                { id: 'call_1', type: 'function', function: { name: ' get_x ', arguments: '{"a":1}' } },
                { id: 'call_1', function: { name: 'dup_id', arguments: { b: 2 } } },
                { name: 'flat', input: { c: 3 } },
                { id: 'bad id!', function: { name: 'bad_args', arguments: '{nope' } },
                { function: { arguments: '{}' } },
                'junk',
                null,
            ],
            makeId,
        );
        expect(calls).toEqual([
            { id: 'call_1', name: 'get_x', rawArgs: '{"a":1}', args: { a: 1 } },
            { id: 'gen1', name: 'dup_id', rawArgs: '{"b":2}', args: { b: 2 } },
            { id: 'gen2', name: 'flat', rawArgs: '{"c":3}', args: { c: 3 } },
            { id: 'gen3', name: 'bad_args', rawArgs: '{nope', args: {}, error: 'arguments are not valid JSON' },
            { id: 'gen4', name: '', rawArgs: '{}', args: {} },
        ]);
        expect(readToolCalls(undefined, makeId)).toEqual([]);
        const circular: Record<string, unknown> = {};
        circular['self'] = circular;
        expect(readToolCalls([{ name: 'c', args: circular }], makeId)[0]?.rawArgs).toBe('{}');
        expect(readToolCalls([{ name: 'n' }], makeId)[0]?.rawArgs).toBe('{}');
    });

    it('sanitises names going back to the provider', () => {
        expect(safeToolName('functions.get x')).toBe('functions_get_x');
        expect(safeToolName('')).toBe('unknown_tool');
        expect(wireCall({ id: 'a', name: '', args: {} }).function.name).toBe('unknown_tool');
    });

    it('wires calls back with valid JSON', () => {
        expect(wireCall({ id: 'a', name: 'x', args: { q: 'y' } })).toEqual({
            id: 'a',
            type: 'function',
            function: { name: 'x', arguments: '{"q":"y"}' },
        });
    });

    it('builds function specs (object schema enforced)', () => {
        expect(
            functionSpec({ name: 'x', description: 'd', parameters: { type: 'object', properties: { a: {} } } }),
        ).toEqual({
            type: 'function',
            function: { name: 'x', description: 'd', parameters: { type: 'object', properties: { a: {} } } },
        });
        expect(functionSpec({ name: 'x', description: 'd', parameters: { required: [] } }).function.parameters).toEqual(
            {
                type: 'object',
                properties: {},
                required: [],
            },
        );
        expect(functionSpec({ name: 'x', description: 'd', parameters: null as never }).function.parameters).toEqual({
            type: 'object',
            properties: {},
        });
    });

    it('tool names are snake_case', () => {
        expect(TOOL_NAME.test('get_settings')).toBe(true);
        expect(TOOL_NAME.test('Get')).toBe(false);
        expect(TOOL_NAME.test('a-b')).toBe(false);
        expect(TOOL_NAME.test('1a')).toBe(false);
    });
});

describe('assistant-calls: schema check', () => {
    const schema = {
        type: 'object',
        properties: {
            id: { type: 'integer' },
            name: { type: 'string' },
            ratio: { type: 'number' },
            on: { type: 'boolean' },
            tags: { type: 'array' },
            extra: { type: 'object' },
            nothing: { type: 'null' },
            either: { type: ['string', 'number'] },
            mode: { enum: ['a', 'b'] },
            anything: { description: 'no type' },
            custom: { type: 'weird' },
            bad: 'not a schema',
        },
        required: ['id', 'name'],
        additionalProperties: false,
    };

    it('accepts valid arguments', () => {
        expect(
            argProblems(
                {
                    id: 1,
                    name: 'x',
                    ratio: 0.5,
                    on: true,
                    tags: [],
                    extra: {},
                    nothing: null,
                    either: 2,
                    mode: 'a',
                    anything: [1],
                    custom: 1,
                    bad: 2,
                },
                schema,
            ),
        ).toEqual([]);
    });

    it('lists missing, mistyped, out-of-enum and unknown arguments', () => {
        expect(
            argProblems(
                {
                    id: 1.5,
                    ratio: Number.NaN,
                    on: 'yes',
                    tags: {},
                    extra: [],
                    nothing: 0,
                    either: true,
                    mode: 'c',
                    unknown: 1,
                    name: null,
                },
                schema,
            ),
        ).toEqual([
            '"name" is required',
            '"id" must be integer, got number',
            '"name" must be string, got null',
            '"ratio" must be number, got number',
            '"on" must be boolean, got string',
            '"tags" must be array, got object',
            '"extra" must be object, got array',
            '"nothing" must be null, got number',
            '"either" must be string or number, got boolean',
            '"mode" must be one of "a", "b"',
            '"unknown" is not a known argument',
        ]);
        expect(argProblems({}, null)).toEqual([]);
        expect(argProblems({ a: 1 }, { required: 'x', properties: [] })).toEqual([]);
    });
});
