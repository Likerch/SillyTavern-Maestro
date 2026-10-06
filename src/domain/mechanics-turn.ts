// M25 «Механики», what a committed turn does by itself (plan-2 §6 п. 3, 5, 11): the story clock moves to the time DES
// wrote for the reply; statuses lose a turn and the story minutes that passed, and the ones that ran out (or whose
// moment came) end with an event for the model; regeneration and decay rules run per turn, per story hour and per
// story day (only while resting / awake when they say so); a fight goes to its next round. Everything is returned as
// operations of one batch for the committed reply (source 'time'): a swipe, deletion or edit of that reply takes it
// all back. A status that started in this very reply does not lose its first turn.
// Pure: no DOM, no SillyTavern.
import { constantOf, computeFormula } from './mechanics-formula';
import type { MechanicDef } from './mechanics-defs';
import type { Rng } from './mechanics-dice';
import { nextRound } from './mechanics-combat';
import { tickStatuses } from './mechanics-status';
import type { StatusState } from './mechanics-status';
import { statusesOf, valueReader } from './mechanics-state';
import type { ClockRecord, MechanicsStateDoc, OpBase, OpInput } from './mechanics-state';
import { periodsOf, REST_MINUTES, ruleApplies, timeStep } from './mechanics-time';
import type { TimeStep } from './mechanics-time';

export interface TurnInput {
    /** The committed reply. */
    index: number;
    /** The clock the reply's DES time gives (null: unknown, the clock stays). */
    clock: ClockRecord | null;
    /** Mechanics on in the chat. */
    defs: readonly MechanicDef[];
    /** Holders whose time rules run (those in the scene). */
    holdersOf(def: MechanicDef): string[];
    /** The scene itself is a rest (a time skip). */
    restScene?: boolean;
    rng?: Rng;
}

const REST_RE = /(?:^|[\s_])(?:rest|resting|sleep|sleeping|asleep|nap|camp|отдых|отдыхает|сон|спит|спящ|привал|дрем)/i;

/** A holder rests now: a rest or sleep status, a long pause (a night) between the replies, or a time-skip scene. */
export function isResting(statuses: readonly StatusState[], step: TimeStep, restScene = false): boolean {
    if (restScene || step.minutes >= REST_MINUTES) return true;
    return statuses.some((status) => REST_RE.test(` ${status.statusId} ${status.name} ${status.promptName}`));
}

/** The operations of one committed turn, and the time step it took. */
export function turnOps(
    doc: MechanicsStateDoc,
    input: TurnInput,
    getDef: (id: string) => MechanicDef | null,
): { ops: OpInput[]; step: TimeStep } {
    const base: OpBase = { source: 'time', messageIndex: input.index };
    const clock = input.clock ?? doc.clock;
    const step = timeStep(doc.clock, clock, 1);
    const ops: OpInput[] = [{ ...base, kind: 'clock', index: input.index, clock: input.clock }];
    const now = clock ? { day: clock.day, ...(clock.minutes !== undefined ? { minutes: clock.minutes } : {}) } : null;

    for (const [holder, list] of Object.entries(doc.statuses)) {
        const ticking = list.filter((status) => status.since < input.index);
        const tick = tickStatuses(ticking, { turns: step.turns, minutes: step.minutes, now });
        for (const status of tick.expired) {
            ops.push({
                ...base,
                kind: 'status',
                op: 'remove',
                mechanicId: status.mechanicId ?? '',
                holder,
                ref: status.id,
                expired: true,
                reason: 'expired',
            });
        }
        for (const [, after] of tick.updated) {
            ops.push({
                ...base,
                kind: 'status',
                op: 'update',
                mechanicId: after.mechanicId ?? '',
                holder,
                instance: after,
            });
        }
    }

    const reader = valueReader(doc, getDef);
    for (const def of input.defs) {
        if (!def.time?.length) continue;
        for (const holder of input.holdersOf(def)) {
            const statuses = statusesOf(doc, holder);
            const resting = isResting(statuses, step, input.restScene);
            for (const rule of def.time) {
                if (!ruleApplies(rule, resting)) continue;
                const periods = periodsOf(rule, step);
                if (periods <= 0) continue;
                const amount =
                    constantOf(rule.amount) ??
                    computeFormula(
                        rule.amount,
                        {
                            ref: (path) =>
                                path.length === 1
                                    ? reader.number(def.id, holder, path[0] as string)
                                    : reader.number(path[0] as string, holder, path[1] as string),
                            ...(input.rng ? { rng: input.rng } : {}),
                        },
                        { dice: true },
                    )?.value ??
                    0;
                if (!amount) continue;
                ops.push({
                    ...base,
                    mechanicId: def.id,
                    holder,
                    attribute: rule.attr,
                    value: Math.round(amount * periods * 10000) / 10000,
                    delta: true,
                    reason: `${rule.per === 'turn' ? 'per turn' : rule.per === 'hour' ? 'per hour' : 'per day'}`,
                });
            }
        }
    }

    if (doc.combat?.active && doc.combat.startedAt < input.index) {
        ops.push({
            ...base,
            kind: 'combat',
            op: 'set',
            mechanicId: doc.combat.mechanicId ?? '',
            next: nextRound(doc.combat),
        });
    }
    return { ops, step };
}
