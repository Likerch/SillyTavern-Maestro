// M44 «Агенты» (plan docs/agents-plan.md, release 1.28): user-editable helper models with one job each. Exposed as
// app.modules.api<AgentsApi>('agents'). MAESTRO_API.agents for neighbours comes with release 1.34.
import type { BuiltInOverride } from '../../domain/agents/builtin';
import type { AgentOutput } from '../../domain/agents/output';
import type { AgentDef, AgentReasoning, AgentRun, AgentScope, AgentSet, AgentState } from '../../domain/agents/types';
import type { Unsubscribe } from '../../shared/contracts';
import type { ContextSource } from './sources';

export interface AgentsApi {
    /** Every own agent. */
    list(): AgentDef[];
    get(id: string): AgentDef | undefined;
    /** The state of each agent in the open chat (sets and scopes applied). */
    states(): Map<string, AgentState>;
    /** Runs an agent now (manual), on a message or at the end of the chat. */
    run(id: string, options?: { messageIndex?: number; extra?: string }): Promise<AgentRun | null>;
    /** Adds a context source (modules and, from 1.34, neighbours). */
    registerSource(source: ContextSource): Unsubscribe;
    onChange(listener: () => void): Unsubscribe;
    /**
     * Release 1.33: «Картинки агентов могут тратить Anlas» (the agents' settings). False: agents' pictures are free only
     * (backgrounds, illustrations, covers); optional so that fakes of the 1.28 contract stay valid.
     */
    imagesPaid?(): boolean;
    // Release 1.34: the neighbours (MAESTRO_API.agents), the assistant and Officina. Optional for 1.28 fakes.
    /**
     * A built-in agent on its neighbour's own channel: the instruction the user made of `defaultText` («Дополнительные
     * указания» added, or his whole text) and his model parameters. Unchanged: `{ text: defaultText }`.
     */
    builtinInstruction?(
        id: string,
        defaultText: string,
    ): { text: string; temperature?: number; maxTokens?: number; reasoning?: AgentReasoning };
    /** A neighbour's own-channel run, for the run log of the chat. */
    reportBuiltinRun?(id: string, run: BuiltinRunReport): void;
    /** Saves an own agent (new or changed: sanitized, journaled); its id, or null when the definition is not valid. */
    save?(def: unknown, summary?: string): Promise<string | null>;
    /** A new own agent made from a template (not saved; a new id). */
    fromTemplate?(templateId: string): AgentDef | undefined;
    /** Switches an agent in a scope (null: the scope's own switch goes, the set decides). */
    setState?(scope: AgentScope, id: string, patch: Partial<AgentState> | null): Promise<void>;
    sets?(): AgentSet[];
    saveSet?(set: AgentSet): Promise<void>;
    /** A scope follows a set (its templates are taken into work). */
    applySet?(scope: AgentScope, setId: string): Promise<void>;
    /** A test run on a message: what the agent would answer, nothing applied. */
    test?(id: string, options?: { messageIndex?: number }): Promise<{ run: AgentRun; output?: AgentOutput } | null>;
    /** Every finished run of the open chat (own agents and built-ins). */
    onRun?(listener: (run: AgentRun) => void): Unsubscribe;
    /** What the user changed in a built-in agent (instruction, parameters); undefined when nothing. */
    builtinOverride?(id: string): BuiltInOverride | undefined;
    /** Saves a built-in agent's change (null: back to the defaults), journaled with undo. */
    setBuiltinOverride?(id: string, override: BuiltInOverride | null, summary: string): Promise<void>;
}

/** What a neighbour reports about a run on its own channel. */
export interface BuiltinRunReport {
    ok: boolean;
    ms: number;
    error?: string;
    costUsd?: number;
    tokens?: { prompt: number; completion: number };
    /** The request as sent (role / content). */
    request?: { role: string; content: string }[];
    /** The answer's text. */
    raw?: string;
}
