// The mock LLM of the bench (tools/mock-llm/server.mjs), started as a real process on a random port.
import { spawn, type ChildProcess } from 'node:child_process';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const SERVER = fileURLToPath(new URL('../../tools/mock-llm/server.mjs', import.meta.url));

interface Usage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
    cost: number;
}

interface ToolCall {
    id: string;
    type: string;
    function: { name: string; arguments: string };
}

interface ChatResponse {
    model: string;
    choices: { finish_reason: string; message: { role: string; content: string; tool_calls?: ToolCall[] } }[];
    usage: Usage;
}

interface StreamChunk {
    choices: { delta: { content?: string; role?: string }; finish_reason: string | null }[];
    usage?: Usage;
}

interface Message {
    role: string;
    content: string;
}

let child: ChildProcess;
let base = '';
let recordDir = '';

beforeAll(async () => {
    recordDir = mkdtempSync(path.join(tmpdir(), 'maestro-mock-'));
    child = spawn(process.execPath, [SERVER, '--port', '0', '--record-dir', recordDir, '--quiet'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, MOCK_CHUNK_DELAY_MS: '0' },
    });
    const port = await new Promise<number>((resolve, reject) => {
        let output = '';
        const timer = setTimeout(() => reject(new Error(`mock did not start: ${output}`)), 10000);
        child.stdout?.on('data', (chunk: Buffer) => {
            output += chunk.toString();
            const match = /MOCK_LLM_LISTENING port=(\d+)/.exec(output);
            if (match) {
                clearTimeout(timer);
                resolve(Number(match[1]));
            }
        });
        child.on('exit', (code) => reject(new Error(`mock exited with ${code}: ${output}`)));
    });
    base = `http://127.0.0.1:${port}`;
});

afterAll(() => {
    child?.kill();
    rmSync(recordDir, { recursive: true, force: true });
});

const story: Message[] = [
    { role: 'system', content: 'Ты рассказчик. Персонажи: Вера и Мартин, место действия — Серебряная Гавань.' },
    { role: 'user', content: '*Киваю.* Идём к маяку?' },
];

async function chat(body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> {
    return fetch(`${base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body: JSON.stringify({ model: 'mock-deepseek-v4', ...body }),
    });
}

async function complete(body: Record<string, unknown>): Promise<ChatResponse> {
    const response = await chat(body);
    expect(response.status).toBe(200);
    return (await response.json()) as ChatResponse;
}

function sseEvents(text: string): string[] {
    return text
        .split('\n\n')
        .map((block) => block.trim())
        .filter((block) => block.startsWith('data: '))
        .map((block) => block.slice('data: '.length));
}

describe('mock LLM', () => {
    it('lists models', async () => {
        const response = await fetch(`${base}/v1/models`);
        const body = (await response.json()) as { data: { id: string }[] };
        expect(body.data.map((m) => m.id)).toContain('mock-deepseek-v4');
    });

    it('answers with a DES tracker block, Russian prose and OpenRouter-like usage', async () => {
        const body = await complete({ messages: story });
        const content = body.choices[0]!.message.content;
        expect(content.startsWith('```json\n')).toBe(true);
        const json = JSON.parse(content.slice(8, content.indexOf('\n```', 8))) as Record<string, unknown>;
        expect(Object.keys(json)).toEqual(['quests', 'infoBox', 'characters']);
        expect(content.slice(content.indexOf('\n```') + 4)).toMatch(/[а-яё]{4,}/);
        expect(content).toContain('Вера');
        expect(body.usage.cost).toBeGreaterThan(0);
        expect(body.usage.total_tokens).toBe(body.usage.prompt_tokens + body.usage.completion_tokens);
    });

    it('streams SSE chunks, then a usage chunk and [DONE]', async () => {
        const response = await chat({ messages: story, stream: true });
        expect(response.headers.get('content-type')).toContain('text/event-stream');
        const events = sseEvents(await response.text());
        expect(events.at(-1)).toBe('[DONE]');
        const chunks = events.slice(0, -1).map((e) => JSON.parse(e) as StreamChunk);
        const usage = chunks.at(-1)!;
        expect(usage.choices).toEqual([]);
        expect(usage.usage!.cost).toBeGreaterThan(0);
        expect(chunks.at(-2)!.choices[0]!.finish_reason).toBe('stop');
        const text = chunks.map((c) => c.choices[0]?.delta.content ?? '').join('');
        expect(text.startsWith('```json')).toBe(true);
        expect(chunks.length).toBeGreaterThan(10);
    });

    it('fills a registered json_schema and walks an unknown one', async () => {
        const known = await complete({
            messages: [{ role: 'user', content: 'ревизия' }],
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'maestro_revision',
                    strict: true,
                    schema: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['changes'],
                        properties: {
                            changes: {
                                type: 'array',
                                items: {
                                    type: 'object',
                                    additionalProperties: false,
                                    required: ['class', 'target'],
                                    properties: {
                                        class: { type: 'string', enum: ['known', 'new'] },
                                        target: { type: 'string' },
                                    },
                                },
                            },
                        },
                    },
                },
            },
        });
        const revision = JSON.parse(known.choices[0]!.message.content) as { changes: Record<string, unknown>[] };
        expect(revision.changes.length).toBeGreaterThan(0);
        for (const change of revision.changes) {
            expect(Object.keys(change).sort()).toEqual(['class', 'target']);
            expect(['known', 'new']).toContain(change.class);
        }

        const unknown = await complete({
            messages: [{ role: 'user', content: 'x' }],
            response_format: {
                type: 'json_schema',
                json_schema: {
                    name: 'something_new',
                    schema: {
                        type: 'object',
                        required: ['count', 'items', 'mode'],
                        properties: {
                            count: { type: 'integer', minimum: 3 },
                            items: { type: 'array', minItems: 2, items: { $ref: '#/$defs/item' } },
                            mode: { anyOf: [{ type: 'null' }, { type: 'string', enum: ['a', 'b'] }] },
                            optional: { type: 'string' },
                        },
                        $defs: { item: { type: 'object', required: ['id'], properties: { id: { type: 'string' } } } },
                    },
                },
            },
        });
        const value = JSON.parse(unknown.choices[0]!.message.content) as Record<string, unknown>;
        expect(value).toEqual({ count: 3, items: [{ id: 'mock id' }, { id: 'mock id' }], mode: 'a' });
    });

    it('switches scenarios by markers in the trailing user turn', async () => {
        const truncated = await complete({
            messages: [...story.slice(0, 1), { role: 'user', content: '[mock:truncate] дальше' }],
        });
        expect(truncated.choices[0]!.finish_reason).toBe('length');

        const sheet = await complete({
            messages: [...story.slice(0, 1), { role: 'user', content: '!fullsheet Вера' }],
        });
        const text = sheet.choices[0]!.message.content;
        expect(text).toContain('<Name:Вера>');
        expect(text).toMatch(/<[EI][NS][FT][JP]-[HU]>/);
        expect(text.indexOf('```json')).toBeGreaterThan(text.indexOf('</BunnymoTags>'));

        const mention = await complete({
            messages: [...story, { role: 'system', content: 'Листы (!fullsheet, !quicksheet) пиши по-русски.' }],
        });
        expect(mention.choices[0]!.message.content).not.toContain('<BunnymoTags>');

        const english = await complete({
            messages: [...story.slice(0, 1), { role: 'user', content: '[mock:english][mock:nojson]' }],
        });
        // Names stay as they are; the prose itself must be English.
        expect(english.choices[0]!.message.content.replace(/[А-ЯЁ][а-яё]+/g, '')).not.toMatch(/[а-яё]{3,}/);
        expect(english.choices[0]!.message.content).toMatch(/\b(the|and|of)\b/);

        const dressed = await complete({
            messages: [...story.slice(0, 1), { role: 'user', content: '[mock:outfit:Мартин=синий камзол] дальше' }],
        });
        const reply = dressed.choices[0]!.message.content;
        const tracker = JSON.parse(reply.slice(8, reply.indexOf('\n```', 8))) as {
            characters: { name: string; details: Record<string, string> }[];
        };
        expect(tracker.characters.find((ch) => ch.name === 'Мартин')?.details.outfit).toBe('синий камзол');
        expect(tracker.characters.find((ch) => ch.name === 'Вера')?.details.outfit).toBeUndefined();

        const joined = await complete({
            messages: [...story.slice(0, 1), { role: 'user', content: '[mock:outfit:Элизабет=красное платье]' }],
        });
        const joinedReply = joined.choices[0]!.message.content;
        const joinedTracker = JSON.parse(joinedReply.slice(8, joinedReply.indexOf('\n```', 8))) as typeof tracker;
        expect(joinedTracker.characters[0]).toMatchObject({ name: 'Элизабет', details: { outfit: 'красное платье' } });
        expect(joinedTracker.characters.filter((ch) => ch.details.outfit)).toHaveLength(1);
    });

    it('calls a tool when asked and answers the tool result', async () => {
        const tools = [
            {
                type: 'function',
                function: {
                    name: 'search_lore',
                    parameters: { type: 'object', required: ['query'], properties: { query: { type: 'string' } } },
                },
            },
        ];
        const call = await complete({ messages: [{ role: 'user', content: '[mock:tool] найди маяк' }], tools });
        expect(call.choices[0]!.finish_reason).toBe('tool_calls');
        const toolCall = call.choices[0]!.message.tool_calls![0]!;
        expect(toolCall.function.name).toBe('search_lore');
        expect(JSON.parse(toolCall.function.arguments)).toHaveProperty('query');

        const answer = await complete({
            messages: [
                { role: 'user', content: 'найди маяк' },
                { role: 'assistant', content: '', tool_calls: [toolCall] },
                { role: 'tool', tool_call_id: toolCall.id, content: '{"hits":1}' },
            ],
            tools,
        });
        expect(answer.choices[0]!.message.content).toContain('{"hits":1}');
    });

    it('injects failures from headers', async () => {
        const limited = await chat({ messages: story }, { 'x-mock-fail': '429' });
        expect(limited.status).toBe(429);
        const broken = await chat({ messages: story }, { 'x-mock-fail': '500' });
        expect(broken.status).toBe(500);

        let text = '';
        let cut = false;
        try {
            const dropped = await chat({ messages: story, stream: true }, { 'x-mock-stream-drop': '1' });
            text = await dropped.text();
        } catch {
            // The connection is cut mid-stream: fetch or the body read fails, which is the point.
            cut = true;
        }
        expect(cut || !text.includes('[DONE]')).toBe(true);
    });

    it('records requests and resets', async () => {
        const list = (await (await fetch(`${base}/__requests`)).json()) as {
            count: number;
            requests: { file: string }[];
        };
        expect(list.count).toBeGreaterThan(5);
        expect(readdirSync(recordDir).length).toBe(list.requests.length);
        const last = (await (await fetch(`${base}/__requests/last`)).json()) as { body: { messages: unknown[] } };
        expect(Array.isArray(last.body.messages)).toBe(true);

        const reset = (await (await fetch(`${base}/__reset`, { method: 'POST' })).json()) as { deleted: number };
        expect(reset.deleted).toBe(list.requests.length);
        expect(readdirSync(recordDir)).toEqual([]);
    });
});
