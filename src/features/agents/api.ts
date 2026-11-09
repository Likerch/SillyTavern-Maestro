// M44 «Агенты» (plan docs/agents-plan.md, release 1.28): user-editable helper models with one job each. Exposed as
// app.modules.api<AgentsApi>('agents'). MAESTRO_API.agents for neighbours comes with release 1.34.
import type { AgentDef, AgentRun, AgentState } from '../../domain/agents/types';
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
}
