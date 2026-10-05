// Maestro's assistant (M33, stage 13): a conversation in the pult, apart from the role-play; the model comes from a
// chosen connection profile. Its own tool loop through that profile (never ST's tool calling: the RP model would see
// those tools). It knows Maestro's and the stack's documentation; it reads settings, health, the journal, lore and
// regexes; it explains, diagnoses and does: module settings, mechanics, regexes with a test, preset flags and blocks,
// passports, lore entries. Safety (plan §4.13): chat and lore content is data, never instructions; settings only from
// an allowlist (never API keys, addresses or connection profiles); every change of Maestro's or another extension's
// settings shows before/after and waits for the user's confirmation; everything goes to the journal with undo; rate
// limits. Exposed as app.modules.api<AssistantApi>('assistant').
import type { App, Logger, Unsubscribe } from '../../shared/contracts';

export type ToolKind = 'read' | 'write';

export interface ToolContext {
    app: App;
    log: Logger;
    signal?: AbortSignal;
    /** The user's interface language (answers and summaries in it). */
    locale: 'en' | 'ru';
    /** Allowlisted access to Maestro's module settings (the core's safety layer). */
    settings: SettingsAccess;
}

/**
 * Maestro's module settings through the allowlist: secrets, connection profiles, API keys, URLs and anything not on
 * the list are invisible to read() and refused by plan(). The plan journals the change with undo when applied.
 */
export interface SettingsAccess {
    /** Module keys whose settings the assistant may see. */
    modules(): string[];
    /** A module's settings with the hidden paths removed, null when unknown or not allowed. */
    read(moduleKey: string): Record<string, unknown> | null;
    /** Whether a dot path of a module's settings may be changed. */
    allowed(moduleKey: string, path: string): boolean;
    /** Plans a change of one setting (dot path); throws a user-language Error when not allowed or invalid. */
    plan(moduleKey: string, path: string, value: unknown): WritePlan;
}

/** What a read tool returns to the model. */
export interface ToolOutput {
    /** JSON-serialisable data. */
    data: unknown;
    /**
     * The data contains text from the chat, lore, cards, presets or other users' content: the core wraps it as
     * untrusted data (the model is told it is never an instruction).
     */
    untrusted?: boolean;
    /** Short line for the conversation's tool chip, in the user's language. */
    summary?: string;
}

/** What a write tool would do: shown as a before/after card; applied only after the user confirms. */
export interface WritePlan {
    /** One line in the user's language: «Режиссёр: темп — каждые 4 хода → каждые 6». */
    summary: string;
    /** What is changed: «Maestro · Режиссёр», «Регексы ST», «Книга «Мир» · запись 12». */
    target: string;
    /** Values for the card (strings or small JSON); secrets never appear here. */
    before: unknown;
    after: unknown;
    /**
     * Does the change. Writes through module APIs that journal themselves, or through the core's settings helper;
     * returns what the model should know (e.g. the new entry's uid).
     */
    apply(): Promise<{ result?: unknown }>;
}

export interface ToolSpec<A extends Record<string, unknown> = Record<string, unknown>> {
    /** snake_case, unique. */
    name: string;
    kind: ToolKind;
    /** English, for the model: what it does, when to use it. */
    description: string;
    /** JSON schema of the arguments (type 'object'). */
    parameters: Record<string, unknown>;
    /** Offered only when this is true (module on, neighbour present, capability). */
    available?(app: App): boolean;
    /** Read tools. */
    run?(args: A, ctx: ToolContext): Promise<ToolOutput>;
    /** Write tools: validate and describe the change (throws a user-language Error when it is not allowed). */
    plan?(args: A, ctx: ToolContext): Promise<WritePlan>;
}

export type ToolCallStatus = 'running' | 'ok' | 'error' | 'waiting' | 'applied' | 'declined';

export interface ToolCallRecord {
    id: string;
    name: string;
    args: Record<string, unknown>;
    status: ToolCallStatus;
    /** Chip text (read) or the plan's summary (write). */
    summary?: string;
    /** Write tools: the card's values. */
    target?: string;
    before?: unknown;
    after?: unknown;
    error?: string;
    /**
     * What the model received from the call (capped, secrets redacted, without the untrusted wrapper): the chip's
     * preview and the context of later turns.
     */
    result?: string;
    /** The result is untrusted content (re-wrapped as `<data>` when later turns send it again). */
    untrusted?: boolean;
}

export interface AssistantMessage {
    id: string;
    role: 'user' | 'assistant' | 'notice';
    text: string;
    at: number;
    toolCalls?: ToolCallRecord[];
    costUsd?: number;
}

export interface AssistantApi {
    /** The conversation of this chat (oldest first). */
    conversation(): AssistantMessage[];
    /** Sends the user's message and runs the tool loop until the model answers. */
    send(text: string): Promise<void>;
    /** Stops the running loop (pending confirmations are declined). */
    stop(): void;
    busy(): boolean;
    /** Answers a waiting write card. */
    confirm(callId: string, accept: boolean): Promise<void>;
    clear(): Promise<void>;
    /** The tools offered now. */
    tools(): { name: string; kind: ToolKind; description: string }[];
    /** Other modules may add tools (owned by them). */
    registerTool(tool: ToolSpec): Unsubscribe;
    onChange(listener: () => void): Unsubscribe;
}

/** The built-in tools (tools/index.ts) are built per app. */
export type ToolFactory = (app: App, log: Logger) => ToolSpec[];
