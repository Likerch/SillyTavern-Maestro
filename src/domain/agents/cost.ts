// What agents add to a turn (plan §3.12, release 1.30): from the run log — the average cost of an agent's recent paid
// runs times how often it runs per turn (once for the moments around a reply, 1/N for «every N messages», nothing for
// buttons). Agents without paid runs yet are left out (and counted, so the list can say «ещё не оценены»).
import type { AgentPhase, AgentRun, AgentTrigger } from './types';

/** Runs per turn of a trigger. */
export function runsPerTurn(trigger: Pick<AgentTrigger, 'phase' | 'everyMessages' | 'events'>): number {
    switch (trigger.phase as AgentPhase) {
        case 'manual':
            return 0;
        case 'schedule': {
            const every = trigger.everyMessages ?? 0;
            // Events alone (scene end, a new place…) — about once in ten turns.
            if (every > 0) return 1 / every;
            return trigger.events?.length ? 0.1 : 0;
        }
        default:
            return 1;
    }
}

/** Average cost of an agent's last `window` paid runs (null: none yet). */
export function averageRunCost(runs: readonly AgentRun[], agentId: string, window = 10): number | null {
    const paid = runs.filter((run) => run.agentId === agentId && run.costUsd !== undefined && !run.test).slice(-window);
    if (!paid.length) return null;
    return paid.reduce((sum, run) => sum + (run.costUsd ?? 0), 0) / paid.length;
}

export interface TurnEstimate {
    usd: number;
    /** Agents counted. */
    counted: number;
    /** Agents with no paid run yet. */
    unknown: number;
}

/** What the given agents add to a turn. */
export function estimateTurn(
    runs: readonly AgentRun[],
    agents: readonly { id: string; trigger: Pick<AgentTrigger, 'phase' | 'everyMessages' | 'events'> }[],
): TurnEstimate {
    const estimate: TurnEstimate = { usd: 0, counted: 0, unknown: 0 };
    for (const agent of agents) {
        const perTurn = runsPerTurn(agent.trigger);
        if (perTurn === 0) continue;
        const average = averageRunCost(runs, agent.id);
        if (average === null) {
            estimate.unknown += 1;
            continue;
        }
        estimate.usd += average * perTurn;
        estimate.counted += 1;
    }
    return estimate;
}
