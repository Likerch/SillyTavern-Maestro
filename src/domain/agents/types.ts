// Agents (plan docs/agents-plan.md, module M44): the data model shared by the pure logic and the feature. An agent is
// an instruction + what it sees (context sources) + when it runs (phase and conditions) + the model + what it returns
// (result type) + where it is on (scope). Release 1.28: the user's own agents, seven phases, seven result types, sets.

/** When an agent runs (plan §3.3). */
export type AgentPhase = 'prefetch' | 'onSend' | 'parallel' | 'post' | 'commit' | 'schedule' | 'manual';

export const AGENT_PHASES: readonly AgentPhase[] = [
    'prefetch',
    'onSend',
    'parallel',
    'post',
    'commit',
    'schedule',
    'manual',
];

/** What an agent returns (plan §3.5). 'proposals' since release 1.31; 'image' comes with 1.33. */
export type AgentResultType = 'inject' | 'flags' | 'rewrite' | 'verdict' | 'note' | 'choices' | 'memory' | 'proposals';

export const AGENT_RESULT_TYPES: readonly AgentResultType[] = [
    'inject',
    'flags',
    'rewrite',
    'verdict',
    'note',
    'choices',
    'memory',
    'proposals',
];

/** Result types answered as JSON (with a schema); the others are plain text. */
export const JSON_RESULT_TYPES: ReadonlySet<AgentResultType> = new Set([
    'flags',
    'rewrite',
    'verdict',
    'choices',
    'memory',
    'proposals',
]);

export type AgentReasoning = 'off' | 'low' | 'medium' | 'high';

/** Story events a scheduled agent can wait for (plan §3.3 «По расписанию / событию»). */
export type AgentEvent = 'sceneEnd' | 'placeChange' | 'newCharacter' | 'timeSkip' | 'break' | 'chatOpen';

export const AGENT_EVENTS: readonly AgentEvent[] = [
    'sceneEnd',
    'placeChange',
    'newCharacter',
    'timeSkip',
    'break',
    'chatOpen',
];

export type MaestroMode = 'economy' | 'balanced' | 'cinema';

/** Conditions of any phase; all optional, all must hold (plan §3.3 «Условия»). */
export interface AgentConditions {
    /** Director scene types (M13 names); empty = any. */
    scenes?: string[];
    /** Any of these words in the last `scanDepth` messages (case-insensitive, ё = е). */
    words?: string[];
    scanDepth?: number;
    /** Maestro modes the agent runs in; empty = all. */
    modes?: MaestroMode[];
    /** Maestro module keys or neighbour ids ('des', 'qvink', 'nai', 'dramatis') that must be on. */
    requires?: string[];
    /** Only in group chats (Ведущий группы) / never in group chats. */
    group?: 'only' | 'never';
    /** Only while the director (M14) sees the story stalling (Осложнения). */
    stalled?: boolean;
}

export interface AgentTrigger {
    phase: AgentPhase;
    /** schedule: every N messages since the last successful run (0/absent = no counter). */
    everyMessages?: number;
    /** schedule: story events that start the agent. */
    events?: AgentEvent[];
    /** Hours of silence that count as a break (event 'break'). */
    breakHours?: number;
    /** Lower runs first within a phase (rewrites always run last, one after another). */
    priority?: number;
    /** onSend: how long the reply waits for this agent (ms). */
    onSendTimeoutMs?: number;
    when?: AgentConditions;
}

export type InjectPosition = 'top' | 'afterMain' | 'depth';
export type InjectRole = 'system' | 'user' | 'assistant';

export interface InjectOptions {
    position: InjectPosition;
    depth: number;
    role: InjectRole;
    /** 'turn': only for the next generation; 'untilNext': every generation until the agent runs again. */
    lifetime: 'turn' | 'untilNext';
}

export interface FlagsOptions {
    /** Flag names the agent may set (without the `maestro_a_` prefix): latin letters, digits, underscore. */
    names: string[];
}

export interface RewriteOptions {
    /** Hide the reply until the agent is done (plan В5: on by default for «Прозаик»). */
    holdReply: boolean;
}

export type VerdictAction = 'mark' | 'offerRedo' | 'swipe' | 'continue';

export interface VerdictOptions {
    action: VerdictAction;
}

export interface NoteOptions {
    /** Where the note shows: the strip under the message, or also a toast. */
    show: 'strip' | 'toast';
}

export interface ChoicesOptions {
    count: number;
    /** A click sends the choice at once instead of putting it into the send box. */
    send: boolean;
}

export interface MemoryField {
    name: string;
    /** What the field is for (goes to the model). */
    hint?: string;
}

export interface MemoryOptions {
    fields: MemoryField[];
    /** The records also go into the prompt (as an injection). */
    inject: boolean;
    injectOptions: InjectOptions;
}

export interface ProposalsOptions {
    /** Receivers the agent may propose to (ProposalReceiver.kind). */
    receivers: string[];
    /** Proposals per run at most. */
    max: number;
}

export type AgentResultSpec =
    | { type: 'inject'; options: InjectOptions }
    | { type: 'flags'; options: FlagsOptions }
    | { type: 'rewrite'; options: RewriteOptions }
    | { type: 'verdict'; options: VerdictOptions }
    | { type: 'note'; options: NoteOptions }
    | { type: 'choices'; options: ChoicesOptions }
    | { type: 'memory'; options: MemoryOptions }
    | { type: 'proposals'; options: ProposalsOptions };

export interface AgentModel {
    /** Connection Manager profile id; absent = «профиль агентов по умолчанию» (core profiles.agents), then default. */
    profile?: string;
    temperature?: number;
    maxTokens?: number;
    reasoning?: AgentReasoning;
}

export interface AgentSourceRef {
    id: string;
    /** Characters (messages: a count for 'messages'); absent = the source's default. */
    budget?: number;
}

export interface AgentVariant {
    id: string;
    name: string;
    instruction: string;
}

export interface AgentLimits {
    /** Runs per turn at most (0/absent = no limit). */
    perTurn?: number;
    /** USD per day at most (0/absent = no limit). */
    dailyUsd?: number;
}

export type AgentOrigin = 'user' | 'import' | 'assistant' | 'officina' | `template:${string}` | `card:${string}`;

/** A user's own agent (plan §4.2). Built-in agents (release 1.29) keep their spec in code. */
export interface AgentDef {
    v: 1;
    /** 'u-<slug>-<rand>'. */
    id: string;
    kind: 'custom';
    name: string;
    icon?: string;
    description?: string;
    origin: AgentOrigin;
    /** Template the agent was taken from (to find it again for a set). */
    templateId?: string;
    instruction: string;
    variants?: AgentVariant[];
    /** Variables of the instruction: `{{agent.<name>}}`. */
    vars?: Record<string, string>;
    sources: AgentSourceRef[];
    trigger: AgentTrigger;
    result: AgentResultSpec;
    model: AgentModel;
    /** May be sent in one request with other agents of the same model (release 1.30). */
    batch?: boolean;
    /** Ask a cheap model «is it needed now?» before running (release 1.30). */
    gate?: { question?: string };
    limits?: AgentLimits;
    /** What the agent may do (shown on import and for card agents). */
    capabilities: string[];
    updatedAt: number;
}

/** The state of an agent within a set or a scope (plan §3.15). */
export interface AgentState {
    on: boolean;
    /** Variant of the instruction (AgentVariant.id); absent = the main text. */
    variant?: string;
    /** Profile override for this scope. */
    profile?: string;
}

/** A named set of agents and their states (plan §3.15). Built-in sets name templates (`template:<id>`). */
export interface AgentSet {
    id: string;
    name: string;
    builtin?: boolean;
    /** i18n key of a built-in set's name and description. */
    titleKey?: string;
    descriptionKey?: string;
    /** Agent id (or `template:<id>` in a built-in set) → state. */
    agents: Record<string, AgentState>;
}

/** What one scope (везде / персонаж / чат) says: a set and point changes over it. */
export interface AgentScopeState {
    set?: string;
    overrides: Record<string, Partial<AgentState>>;
}

export type AgentScope = 'global' | 'character' | 'chat';

/** Why a run failed, in words the log can translate (plan §3.8). */
export type AgentErrorKind =
    | 'length'
    | 'timeout'
    | 'refusal'
    | 'no-profile'
    | 'cap'
    | 'limit'
    | 'parse'
    | 'shape'
    | 'transport'
    | 'aborted'
    | 'empty'
    | 'shrunk'
    | 'other';

export interface AgentTokens {
    prompt: number;
    completion: number;
}

/** One run in the run log (plan §4.2 AgentRun). */
export interface AgentRun {
    id: string;
    agentId: string;
    agentName: string;
    chatId: string | null;
    phase: AgentPhase;
    /** Why it ran: 'schedule', 'event:sceneEnd', 'manual', 'test'… */
    reason: string;
    messageIndex?: number;
    swipeId?: number;
    startedAt: number;
    ms: number;
    tokens?: AgentTokens;
    costUsd?: number;
    ok: boolean;
    error?: AgentErrorKind;
    /** A test run: nothing was applied. */
    test?: boolean;
    /** A run of a built-in agent (a module's own request, release 1.29). */
    builtin?: boolean;
    /** The batch request the run was part of (release 1.30). */
    batchId?: string;
    /** The request and the raw answer (kept for the newest runs only). */
    request?: { role: string; content: string }[];
    raw?: string;
    /** The parsed result. */
    result?: unknown;
    /** What was done with it, in words («вставка на 1 ход», «правка: 3 изменения»). */
    applied?: string[];
}
