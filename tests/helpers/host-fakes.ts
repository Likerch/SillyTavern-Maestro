// Small fakes for host/core tests: a silent logger, an in-memory FileStore and helpers to build
// chat-completion responses (JSON and SSE streams).
import type { FileStore, Logger } from '../../src/shared/contracts';

export interface MemoryLogger extends Logger {
    lines: { level: string; args: unknown[] }[];
}

export function memoryLogger(): MemoryLogger {
    const lines: { level: string; args: unknown[] }[] = [];
    const logger: MemoryLogger = {
        lines,
        debug: (...args) => lines.push({ level: 'debug', args }),
        info: (...args) => lines.push({ level: 'info', args }),
        warn: (...args) => lines.push({ level: 'warn', args }),
        error: (...args) => lines.push({ level: 'error', args }),
        scope: () => logger,
    };
    return logger;
}

export interface MemoryFiles extends FileStore {
    data: Map<string, unknown>;
    writes: string[];
}

export function memoryFiles(): MemoryFiles {
    const data = new Map<string, unknown>();
    const writes: string[] = [];
    return {
        data,
        writes,
        async read<T>(name: string): Promise<T | null> {
            return data.has(name) ? (structuredClone(data.get(name)) as T) : null;
        },
        async write(name: string, value: unknown): Promise<void> {
            writes.push(name);
            data.set(name, structuredClone(value));
        },
        async remove(name: string): Promise<void> {
            data.delete(name);
        },
        fileName(kind: string, key?: string): string {
            return key ? `maestro-${kind}-${key}.json` : `maestro-${kind}.json`;
        },
    };
}

/** A non-streamed OpenAI/OpenRouter-style response body. */
export function completion(
    content: string,
    usage?: Record<string, unknown>,
    extra: Record<string, unknown> = {},
): Record<string, unknown> {
    return {
        id: 'gen-1',
        choices: [{ index: 0, message: { role: 'assistant', content, ...extra }, finish_reason: 'stop' }],
        ...(usage ? { usage } : {}),
    };
}

/** SSE text as ST's generate endpoint forwards it. */
export function sse(chunks: unknown[]): string {
    return chunks.map((chunk) => `data: ${JSON.stringify(chunk)}\n\n`).join('') + 'data: [DONE]\n\n';
}

/** A ReadableStream that yields the given string pieces one by one, waiting for each pull. */
export function streamOf(pieces: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder();
    let index = 0;
    return new ReadableStream<Uint8Array>({
        pull(controller) {
            const piece = pieces[index++];
            if (piece === undefined) controller.close();
            else controller.enqueue(encoder.encode(piece));
        },
    });
}

export async function readAll(stream: ReadableStream<Uint8Array> | null): Promise<string> {
    if (!stream) return '';
    return new Response(stream).text();
}

/** Lets pending promise callbacks and zero-delay timers run. */
export async function settle(rounds = 5): Promise<void> {
    for (let i = 0; i < rounds; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
