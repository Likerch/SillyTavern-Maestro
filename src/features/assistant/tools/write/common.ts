// Shared parts of the assistant's write tools (M33): argument errors in the user's language, the journal records of
// the tools whose target API does not journal by itself, typed access to the neighbours' APIs, a uuid.
import { ArgError } from '../../../../domain/assistant-write-args';
import type { Dict, ErrorParams } from '../../../../domain/assistant-write-args';
import type { App, JournalChange } from '../../../../shared/contracts';
import type { ToolContext, WritePlan } from '../../api';
import { sayer } from './strings';
import type { Say } from './strings';

/** Journal module id of the assistant (plan id, like every module's records). */
export const ASSISTANT_MODULE = 'M33';
/** The assistant's module key: it never switches itself. */
export const ASSISTANT_KEY = 'assistant';

/** Undo targets of the write tools that journal their own changes. */
export const UNDO_TARGETS = {
    module: 'assistant-module',
    autonomy: 'assistant-autonomy',
    mechanicChat: 'assistant-mechanic-chat',
    regex: 'assistant-regex',
} as const;

/** An Error with a sentence in the user's language for `m33w.err.<code>`. */
export function failure(say: Say, code: string, params: ErrorParams = {}): Error {
    // `argType` names the expected type with a word of the user's language.
    if (code === 'argType' && typeof params.expected === 'string') {
        return new Error(say(`m33w.err.${code}`, { ...params, expected: say(`m33w.type.${params.expected}`) }));
    }
    return new Error(say(`m33w.err.${code}`, params));
}

/**
 * Runs a tool's plan with the conversation's translator: argument and validation errors of the domain (ArgError)
 * become user-language Errors; other errors (the neighbours' own, already translated) pass unchanged.
 */
export async function planWith(
    ctx: ToolContext,
    build: (say: Say) => WritePlan | Promise<WritePlan>,
): Promise<WritePlan> {
    const say = sayer(ctx.locale);
    try {
        return await build(say);
    } catch (error) {
        if (error instanceof ArgError) throw failure(say, error.code, error.params);
        throw error;
    }
}

/** The arguments as a record (the model may send nothing at all). */
export function argsOf(args: unknown): Dict {
    return typeof args === 'object' && args !== null && !Array.isArray(args) ? (args as Dict) : {};
}

/** Records one change of the assistant in the journal; a failed record is logged, never thrown (the change is done). */
export async function journal(
    app: App,
    entry: { kind: string; summary: string; change: JournalChange },
): Promise<void> {
    try {
        await app.journal.record({
            module: ASSISTANT_MODULE,
            kind: entry.kind,
            summary: entry.summary,
            changes: [entry.change],
        });
    } catch (error) {
        app.log.warn(`assistant: ${entry.kind} was not journaled`, error);
    }
}

/** A fresh uuid: ST's own generator, else the browser's, else a time-based id. */
export function newUuid(app: App): string {
    try {
        const id = app.host.ctx().uuidv4?.();
        if (typeof id === 'string' && id) return id;
    } catch {
        // fall through
    }
    return (
        globalThis.crypto?.randomUUID?.() ?? `maestro-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
    );
}

/** A module's title in the app's language, else its key. */
export function moduleTitle(app: App, key: string): string {
    const entry = app.modules.list().find((item) => item.module.key === key);
    if (!entry) return key;
    const title = app.i18n.t(entry.module.titleKey);
    return title && title !== entry.module.titleKey ? title : key;
}

/** Up to `max` names joined for an error message. */
export function listOf(names: readonly string[], max = 40): string {
    if (!names.length) return '—';
    const shown = names.slice(0, max).join(', ');
    return names.length > max ? `${shown}, …` : shown;
}
