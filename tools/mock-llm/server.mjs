#!/usr/bin/env node
// Maestro mock LLM: a dependency-free OpenAI-compatible server for the local test bench.
//
//   node tools/mock-llm/server.mjs [--port 5199] [--host 127.0.0.1] [--record-dir <dir>] [--no-record] [--quiet]
//
// Endpoints: GET /v1/models, POST /v1/chat/completions (stream false/true), plus the bench helpers
// GET /__requests, GET /__requests/<n|last>, POST /__reset, GET|POST /__config, GET /__health.
// Every reply carries OpenRouter-like usage with a cost. Scenarios are described in README.md.
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { analyseRequest, buildReply, estimateTokens, makeRng } from './scenarios.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_PORT = 5199;
export const DEFAULT_RECORD_DIR = path.resolve(HERE, '..', 'stand', 'runtime', 'requests');

/** USD per 1M tokens. The first model is the default one. */
export const PRICES = {
    'mock-deepseek-v4': { prompt: 0.3, completion: 1.2 },
    'mock-cheap': { prompt: 0.05, completion: 0.2 },
    'mock-premium': { prompt: 3, completion: 15 },
};
const FALLBACK_PRICE = { prompt: 0.5, completion: 1.5 };

const RECORD_FILE_RE = /^\d{8}-\d{6}-\d{3}-(\d{4,})\.json$/;
const MAX_BODY = 64 * 1024 * 1024;

/* ------------------------------------------------------------------ flags */

function parseRate(value, fallback = 1) {
    if (value === undefined || value === null || value === '') return fallback;
    if (value === true || value === 'true' || value === 'on' || value === 'yes') return 1;
    if (value === false || value === 'false' || value === 'off' || value === 'no') return 0;
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : fallback;
}

/** "250" or "200-800" → [min, max] milliseconds. */
function parseLatency(value) {
    if (value === undefined || value === null || value === '') return [0, 0];
    const [a, b] = String(value)
        .split('-')
        .map((x) => Math.max(0, Number(x) || 0));
    return [a ?? 0, b ?? a ?? 0];
}

/** MOCK_FAIL: "429", "500", "drop", with an optional rate: "429:0.3" / "429@0.3". */
function parseFail(value, rate) {
    if (!value || value === 'off' || value === '0' || value === 'none') return null;
    const [kind, inlineRate] = String(value).split(/[:@]/);
    if (!['429', '500', 'drop'].includes(kind)) return null;
    return { kind, rate: parseRate(inlineRate ?? rate, 1) };
}

function envFlags(env) {
    return {
        latencyMs: env.MOCK_LATENCY_MS,
        fail: env.MOCK_FAIL,
        failRate: env.MOCK_FAIL_RATE,
        failScope: env.MOCK_FAIL_SCOPE,
        streamDrop: env.MOCK_STREAM_DROP,
        chunkDelayMs: env.MOCK_CHUNK_DELAY_MS,
        scenario: env.MOCK_SCENARIO,
        userName: env.MOCK_USER_NAME,
    };
}

function headerFlags(headers) {
    const h = (name) => {
        const value = headers[name];
        return Array.isArray(value) ? value[0] : value;
    };
    return {
        latencyMs: h('x-mock-latency-ms'),
        fail: h('x-mock-fail'),
        failRate: h('x-mock-fail-rate'),
        failScope: h('x-mock-fail-scope'),
        streamDrop: h('x-mock-stream-drop'),
        chunkDelayMs: h('x-mock-chunk-delay-ms'),
        scenario: h('x-mock-scenario'),
        userName: h('x-mock-user') ? decodeURIComponent(String(h('x-mock-user'))) : undefined,
    };
}

function mergeFlags(...layers) {
    const result = {};
    for (const layer of layers) {
        for (const [key, value] of Object.entries(layer ?? {})) {
            if (value !== undefined && value !== null && value !== '') result[key] = value;
        }
    }
    return result;
}

/* ------------------------------------------------------------------ helpers */

function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function stamp(date = new Date()) {
    const p = (n, w = 2) => String(n).padStart(w, '0');
    return (
        `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}-` +
        `${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}-${p(date.getUTCMilliseconds(), 3)}`
    );
}

function sendJson(res, status, value, headers = {}) {
    const body = JSON.stringify(value, null, 2);
    res.writeHead(status, {
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': Buffer.byteLength(body),
        ...headers,
    });
    res.end(body);
}

function readBody(req) {
    return new Promise((resolve, reject) => {
        const chunks = [];
        let size = 0;
        req.on('data', (chunk) => {
            size += chunk.length;
            if (size > MAX_BODY) {
                reject(new Error('request body too large'));
                req.destroy();
                return;
            }
            chunks.push(chunk);
        });
        req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        req.on('error', reject);
    });
}

/** Usage block shaped like OpenRouter's (usage accounting on). */
export function makeUsage(model, promptTokens, completionTokens) {
    const price = PRICES[model] ?? FALLBACK_PRICE;
    const cost = Math.round(((promptTokens * price.prompt + completionTokens * price.completion) / 1e6) * 1e10) / 1e10;
    return {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
        cost,
        is_byok: false,
        prompt_tokens_details: { cached_tokens: 0 },
        completion_tokens_details: { reasoning_tokens: 0 },
        cost_details: { upstream_inference_cost: null },
    };
}

function promptTokensOf(body, ctx) {
    let total = 0;
    for (const text of ctx.texts) total += estimateTokens(text) + 4;
    if (Array.isArray(body?.tools)) total += estimateTokens(JSON.stringify(body.tools));
    if (body?.response_format) total += estimateTokens(JSON.stringify(body.response_format));
    return total;
}

/** Splits text into small streaming pieces (about three words each), keeping all characters. */
function splitForStream(text) {
    const tokens = String(text).match(/\s*\S+/g) ?? [];
    const pieces = [];
    for (let i = 0; i < tokens.length; i += 3) pieces.push(tokens.slice(i, i + 3).join(''));
    const rest = String(text).slice(pieces.join('').length);
    if (rest) pieces.push(rest);
    return pieces;
}

/* ------------------------------------------------------------------ server */

/**
 * Creates the mock server. `listen()` resolves with the actual port (pass 0 for a random one).
 * @param {{ recordDir?: string | null, env?: Record<string, string | undefined>, log?: (line: string) => void }} [options]
 */
export function createMockServer(options = {}) {
    const env = options.env ?? process.env;
    const recordDir = options.recordDir === undefined ? DEFAULT_RECORD_DIR : options.recordDir;
    const log = options.log ?? (() => {});
    const seeded = env.MOCK_SEED ? makeRng(Number(env.MOCK_SEED) || 1) : null;
    const random = () => (seeded ? seeded() : Math.random());

    /** @type {{ n: number, file: string | null, time: string, path: string, model: string, stream: boolean, scenario: string, messages: number, chars: number, status: number }[]} */
    let records = [];
    let counter = 0;
    let runtimeFlags = {};

    if (recordDir && fs.existsSync(recordDir)) {
        for (const file of fs.readdirSync(recordDir).sort()) {
            const match = RECORD_FILE_RE.exec(file);
            if (!match) continue;
            try {
                const record = JSON.parse(fs.readFileSync(path.join(recordDir, file), 'utf8'));
                records.push(summaryOf(record, file));
                counter = Math.max(counter, Number(match[1]));
            } catch {
                // A half-written file from a killed run: ignore it.
            }
        }
    }

    function summaryOf(record, file) {
        const messages = Array.isArray(record.body?.messages) ? record.body.messages : [];
        return {
            n: record.n,
            file,
            time: record.time,
            path: record.path,
            model: record.body?.model ?? null,
            stream: Boolean(record.body?.stream),
            scenario: record.scenario ?? null,
            messages: messages.length,
            chars: messages.reduce((sum, m) => sum + (typeof m.content === 'string' ? m.content.length : 0), 0),
            status: record.response?.status ?? null,
        };
    }

    function record(entry) {
        let file = null;
        if (recordDir) {
            fs.mkdirSync(recordDir, { recursive: true });
            file = `${stamp(new Date(entry.time))}-${String(entry.n).padStart(4, '0')}.json`;
            fs.writeFileSync(path.join(recordDir, file), JSON.stringify(entry, null, 2) + '\n', 'utf8');
        }
        records.push(summaryOf(entry, file));
    }

    function readRecord(selector) {
        const summary = selector === 'last' ? records.at(-1) : records.find((r) => String(r.n) === String(selector));
        if (!summary) return null;
        if (summary.file && recordDir) {
            try {
                return JSON.parse(fs.readFileSync(path.join(recordDir, summary.file), 'utf8'));
            } catch {
                return null;
            }
        }
        return summary;
    }

    function reset(keepFiles) {
        let deleted = 0;
        if (recordDir && fs.existsSync(recordDir) && !keepFiles) {
            for (const file of fs.readdirSync(recordDir)) {
                if (!RECORD_FILE_RE.test(file)) continue;
                fs.rmSync(path.join(recordDir, file), { force: true });
                deleted++;
            }
        }
        records = [];
        counter = 0;
        runtimeFlags = {};
        return deleted;
    }

    async function handleChat(req, res) {
        let body;
        try {
            body = JSON.parse((await readBody(req)) || '{}');
        } catch (error) {
            sendJson(res, 400, { error: { message: `Invalid JSON: ${error.message}`, code: 400 } });
            return;
        }
        const n = ++counter;
        const time = new Date().toISOString();
        const flags = mergeFlags(envFlags(env), runtimeFlags, headerFlags(req.headers));
        const ctx = analyseRequest(body, { scenario: flags.scenario, userName: flags.userName });
        const reply = buildReply(ctx, n);
        const model = typeof body.model === 'string' && body.model ? body.model : Object.keys(PRICES)[0];
        const stream = Boolean(body.stream);
        const kind = ctx.schema || ctx.jsonObject ? 'schema' : ctx.tools.length ? 'tools' : 'main';

        // Failure injection.
        const fail = parseFail(flags.fail, flags.failRate);
        const scope = String(flags.failScope ?? 'all');
        const inScope = scope === 'all' || scope.split(',').includes(kind);
        const failing = fail && inScope && random() < fail.rate ? fail.kind : null;
        const dropRate = parseRate(flags.streamDrop, 0);
        const dropStream = stream && !failing && dropRate > 0 && random() < dropRate;

        const promptTokens = promptTokensOf(body, ctx);
        const completionText =
            reply.content + (reply.toolCalls ? JSON.stringify(reply.toolCalls) : '') + (reply.reasoning ?? '');
        const usage = makeUsage(model, promptTokens, estimateTokens(completionText));
        const status = failing === '429' ? 429 : failing === '500' ? 500 : 200;

        record({
            n,
            time,
            path: req.url,
            scenario: reply.scenario,
            flags: { ...flags, failing, dropStream },
            headers: Object.fromEntries(
                Object.entries(req.headers).filter(([key]) => key.startsWith('x-mock-') || key === 'user-agent'),
            ),
            body,
            response: {
                status,
                finish_reason: reply.finishReason,
                content: reply.content,
                tool_calls: reply.toolCalls,
                reasoning: reply.reasoning,
                usage: failing ? null : usage,
            },
        });
        log(
            `#${n} ${req.url} model=${model} stream=${stream} scenario=${reply.scenario}${failing ? ` FAIL=${failing}` : ''}${dropStream ? ' DROP' : ''}`,
        );

        const [minLatency, maxLatency] = parseLatency(flags.latencyMs);
        const latency = minLatency + Math.floor(random() * (maxLatency - minLatency + 1));
        if (latency > 0) await sleep(latency);

        if (failing === 'drop') {
            req.socket.destroy();
            return;
        }
        if (failing === '429') {
            sendJson(
                res,
                429,
                { error: { message: 'Rate limit exceeded (mock)', code: 429, type: 'rate_limit_exceeded' } },
                { 'Retry-After': '1' },
            );
            return;
        }
        if (failing === '500') {
            sendJson(res, 500, { error: { message: 'Internal server error (mock)', code: 500, type: 'server_error' } });
            return;
        }

        const id = `gen-mock-${n}`;
        const created = Math.floor(Date.now() / 1000);
        if (!stream) {
            const message = { role: 'assistant', content: reply.content, refusal: null };
            if (reply.reasoning) {
                message.reasoning = reply.reasoning;
                message.reasoning_content = reply.reasoning;
            }
            if (reply.toolCalls) message.tool_calls = reply.toolCalls;
            sendJson(res, 200, {
                id,
                provider: 'Mock',
                model,
                object: 'chat.completion',
                created,
                choices: [
                    {
                        index: 0,
                        logprobs: null,
                        finish_reason: reply.finishReason,
                        native_finish_reason: reply.finishReason,
                        message,
                    },
                ],
                usage,
            });
            return;
        }

        res.writeHead(200, {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        });
        const chunkDelay = Math.max(0, Number(flags.chunkDelayMs ?? 5) || 0);
        const base = { id, provider: 'Mock', model, object: 'chat.completion.chunk', created };
        const send = (choices, extra = {}) => res.write(`data: ${JSON.stringify({ ...base, choices, ...extra })}\n\n`);
        const delta = (d, finish = null) => [
            { index: 0, delta: d, finish_reason: finish, native_finish_reason: finish },
        ];

        let closed = false;
        res.on('close', () => {
            closed = true;
        });

        send(delta({ role: 'assistant', content: '' }));
        if (reply.reasoning) {
            for (const piece of splitForStream(reply.reasoning)) {
                if (closed) return;
                send(delta({ content: '', reasoning: piece, reasoning_content: piece }));
                if (chunkDelay) await sleep(chunkDelay);
            }
        }
        const pieces = splitForStream(reply.content);
        const dropAt = dropStream ? Math.max(1, Math.floor(pieces.length * 0.4)) : -1;
        for (let i = 0; i < pieces.length; i++) {
            if (closed) return;
            if (i === dropAt) {
                // Simulate a broken connection mid-stream: no finish chunk, no usage, no [DONE].
                req.socket.destroy();
                return;
            }
            send(delta({ content: pieces[i] }));
            if (chunkDelay) await sleep(chunkDelay);
        }
        if (reply.toolCalls) {
            reply.toolCalls.forEach((call, index) => {
                send(
                    delta({
                        tool_calls: [
                            {
                                index,
                                id: call.id,
                                type: 'function',
                                function: { name: call.function.name, arguments: '' },
                            },
                        ],
                    }),
                );
                const args = call.function.arguments;
                const half = Math.ceil(args.length / 2);
                for (const part of [args.slice(0, half), args.slice(half)]) {
                    if (part) send(delta({ tool_calls: [{ index, function: { arguments: part } }] }));
                }
            });
        }
        if (closed) return;
        send(delta({}, reply.finishReason));
        send([], { usage });
        res.write('data: [DONE]\n\n');
        res.end();
    }

    async function handle(req, res) {
        const url = new URL(req.url ?? '/', 'http://mock.local');
        const route = url.pathname.replace(/\/+$/, '') || '/';
        res.setHeader('Access-Control-Allow-Origin', '*');
        res.setHeader('Access-Control-Allow-Headers', '*');
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
        if (req.method === 'OPTIONS') {
            res.writeHead(204);
            res.end();
            return;
        }

        if (req.method === 'GET' && (route === '/v1/models' || route === '/models')) {
            sendJson(res, 200, {
                object: 'list',
                data: Object.keys(PRICES).map((id) => ({
                    id,
                    object: 'model',
                    created: 1767225600,
                    owned_by: 'maestro-mock',
                    pricing: {
                        prompt: String(PRICES[id].prompt / 1e6),
                        completion: String(PRICES[id].completion / 1e6),
                    },
                })),
            });
            return;
        }
        if (req.method === 'POST' && (route === '/v1/chat/completions' || route === '/chat/completions')) {
            await handleChat(req, res);
            return;
        }
        if (req.method === 'GET' && (route === '/' || route === '/__health')) {
            sendJson(res, 200, { ok: true, name: 'maestro-mock-llm', requests: records.length });
            return;
        }
        if (req.method === 'GET' && route === '/__requests') {
            sendJson(res, 200, { recordDir, count: records.length, requests: records });
            return;
        }
        if (req.method === 'GET' && route.startsWith('/__requests/')) {
            const found = readRecord(decodeURIComponent(route.slice('/__requests/'.length)));
            if (found) sendJson(res, 200, found);
            else sendJson(res, 404, { error: { message: 'no such request', code: 404 } });
            return;
        }
        if (req.method === 'POST' && route === '/__reset') {
            let keepFiles = url.searchParams.get('keepFiles') === '1';
            try {
                const text = await readBody(req);
                if (text) keepFiles = Boolean(JSON.parse(text).keepFiles) || keepFiles;
            } catch {
                // An empty or invalid body means "reset everything".
            }
            sendJson(res, 200, { ok: true, deleted: reset(keepFiles) });
            return;
        }
        if (route === '/__config') {
            if (req.method === 'POST') {
                try {
                    const text = await readBody(req);
                    const patch = text ? JSON.parse(text) : {};
                    runtimeFlags = patch.clear ? {} : { ...runtimeFlags, ...patch };
                    delete runtimeFlags.clear;
                } catch (error) {
                    sendJson(res, 400, { error: { message: `Invalid JSON: ${error.message}`, code: 400 } });
                    return;
                }
            }
            sendJson(res, 200, { env: mergeFlags(envFlags(env)), runtime: runtimeFlags });
            return;
        }
        sendJson(res, 404, { error: { message: `Unknown route ${req.method} ${url.pathname}`, code: 404 } });
    }

    const server = http.createServer((req, res) => {
        handle(req, res).catch((error) => {
            log(`error: ${error?.stack ?? error}`);
            if (!res.headersSent)
                sendJson(res, 500, { error: { message: String(error?.message ?? error), code: 500 } });
            else res.end();
        });
    });

    return {
        server,
        listen(port = DEFAULT_PORT, host = '127.0.0.1') {
            return new Promise((resolve, reject) => {
                server.once('error', reject);
                server.listen(port, host, () => {
                    server.off('error', reject);
                    resolve(/** @type {import('node:net').AddressInfo} */ (server.address()).port);
                });
            });
        },
        close() {
            return new Promise((resolve) => {
                server.closeAllConnections?.();
                server.close(() => resolve(undefined));
            });
        },
    };
}

function parseArgs(argv) {
    const args = { port: undefined, host: undefined, recordDir: undefined, record: true, quiet: false };
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        const [flag, inline] = arg.split('=', 2);
        const value = () => inline ?? argv[++i];
        if (flag === '--port') args.port = Number(value());
        else if (flag === '--host') args.host = value();
        else if (flag === '--record-dir') args.recordDir = value();
        else if (flag === '--no-record') args.record = false;
        else if (flag === '--quiet') args.quiet = true;
        else if (flag === '--help' || flag === '-h') {
            console.log(
                'Usage: node tools/mock-llm/server.mjs [--port 5199] [--host 127.0.0.1] [--record-dir <dir>] [--no-record] [--quiet]',
            );
            process.exit(0);
        }
    }
    return args;
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    const port = args.port ?? Number(process.env.MOCK_PORT ?? DEFAULT_PORT);
    const host = args.host ?? process.env.MOCK_HOST ?? '127.0.0.1';
    const recordDir =
        !args.record || process.env.MOCK_NO_RECORD === '1'
            ? null
            : path.resolve(args.recordDir ?? process.env.MOCK_RECORD_DIR ?? DEFAULT_RECORD_DIR);
    const mock = createMockServer({
        recordDir,
        log: args.quiet ? () => {} : (line) => console.log(`[mock-llm ${new Date().toISOString()}] ${line}`),
    });
    const actual = await mock.listen(Number.isFinite(port) ? port : DEFAULT_PORT, host);
    // Machine-readable line: the bench and the tests read the port from it.
    console.log(`MOCK_LLM_LISTENING port=${actual} url=http://${host}:${actual}/v1 record=${recordDir ?? 'off'}`);
    const stop = () => {
        mock.close().then(() => process.exit(0));
        setTimeout(() => process.exit(0), 1000).unref();
    };
    process.on('SIGINT', stop);
    process.on('SIGTERM', stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch((error) => {
        console.error(error);
        process.exit(1);
    });
}
