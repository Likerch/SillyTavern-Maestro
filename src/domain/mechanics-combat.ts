// M25 «Механики», combat mode (plan-2 §6 п. 11 «Боевой режим»): initiative, the turn order, enemies with their own
// stats, rounds. A fight starts by hand, by the model's service block or when the director sees a fight; every
// committed reply is one round; a combatant knocked out leaves the order; the fight ends by hand, by the block, when
// the director's scene is no longer a fight, or when every enemy is out. The prompt gets one compact line.
// Pure: no DOM, no SillyTavern. Functions return new states.

export interface Combatant {
    holder: string;
    /** Initiative total (higher acts first). */
    init: number;
    enemy?: boolean;
    /** Knocked out, fled or otherwise out of the fight. */
    out?: boolean;
}

export type CombatBy = 'user' | 'director' | 'model';

export interface CombatState {
    active: boolean;
    round: number;
    order: Combatant[];
    /** Index into `order` of who acts now. */
    current: number;
    /** The mechanic that runs the fight (its initiative check and enemy stats). */
    mechanicId: string | null;
    /** Message index the fight started at (-1: by hand outside a reply). */
    startedAt: number;
    by: CombatBy;
    /** Message index the fight ended at, when it did. */
    endedAt?: number;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function same(a: string, b: string): boolean {
    return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/** Higher initiative first; on a tie the side that is not an enemy, then by name. */
function byInitiative(a: Combatant, b: Combatant): number {
    return b.init - a.init || Number(!!a.enemy) - Number(!!b.enemy) || a.holder.localeCompare(b.holder);
}

/** A fight with these combatants (duplicates by name dropped), round 1, the fastest acting. */
export function startCombat(
    combatants: readonly Combatant[],
    options: { mechanicId: string | null; at: number; by: CombatBy },
): CombatState {
    const order: Combatant[] = [];
    for (const combatant of combatants) {
        if (!combatant.holder.trim() || order.some((item) => same(item.holder, combatant.holder))) continue;
        const copy: Combatant = { holder: combatant.holder.trim(), init: Math.round(combatant.init) };
        if (combatant.enemy) copy.enemy = true;
        order.push(copy);
    }
    order.sort(byInitiative);
    return {
        active: true,
        round: 1,
        order,
        current: 0,
        mechanicId: options.mechanicId,
        startedAt: options.at,
        by: options.by,
    };
}

function firstIn(order: readonly Combatant[], from: number): number {
    for (let i = 0; i < order.length; i++) {
        const index = (from + i) % order.length;
        if (!order[index]?.out) return index;
    }
    return -1;
}

/** The next combatant acts (a new round after the last one). */
export function nextTurn(state: CombatState): CombatState {
    if (!state.active || !state.order.length) return state;
    const next = structuredClone(state);
    const index = firstIn(next.order, next.current + 1);
    if (index < 0) return next;
    if (index <= next.current) next.round += 1;
    next.current = index;
    return next;
}

/** A new round: the fastest one still in acts. */
export function nextRound(state: CombatState): CombatState {
    if (!state.active) return state;
    const next = structuredClone(state);
    next.round += 1;
    const index = firstIn(next.order, 0);
    next.current = index < 0 ? 0 : index;
    return next;
}

/** Adds (or brings back) a combatant at its initiative; the one acting now keeps acting. */
export function addCombatant(state: CombatState, combatant: Combatant): CombatState {
    const next = structuredClone(state);
    const acting = next.order[next.current]?.holder;
    const existing = next.order.find((item) => same(item.holder, combatant.holder));
    if (existing) {
        delete existing.out;
        if (combatant.enemy) existing.enemy = true;
        return next;
    }
    const copy: Combatant = { holder: combatant.holder.trim(), init: Math.round(combatant.init) };
    if (combatant.enemy) copy.enemy = true;
    next.order.push(copy);
    next.order.sort(byInitiative);
    if (acting)
        next.current = Math.max(
            0,
            next.order.findIndex((item) => same(item.holder, acting)),
        );
    return next;
}

/** A combatant is out; `ended` when every enemy is out (there were enemies) or nobody is left. */
export function markOut(state: CombatState, holder: string): { state: CombatState; ended: boolean } {
    const next = structuredClone(state);
    const found = next.order.find((item) => same(item.holder, holder));
    if (!found || found.out) return { state, ended: false };
    found.out = true;
    if (next.order[next.current] === found) {
        const index = firstIn(next.order, next.current + 1);
        if (index >= 0) next.current = index;
    }
    const enemies = next.order.filter((item) => item.enemy);
    const ended =
        (enemies.length > 0 && enemies.every((item) => item.out)) || next.order.every((item) => item.out === true);
    return { state: next, ended };
}

/** The fight is over (kept for the journal and the window until the next one starts). */
export function endCombat(state: CombatState, at: number): CombatState {
    const next = structuredClone(state);
    next.active = false;
    next.endedAt = at;
    return next;
}

/** The combatant with this name, case-insensitive. */
export function combatantOf(state: CombatState | null, holder: string): Combatant | null {
    return state?.order.find((item) => same(item.holder, holder)) ?? null;
}

/**
 * The prompt line: "[Combat] Round 2. Turn order: Kai 17, Bandit 12 (enemy), Mira 9; out: Wolf. Now acting: Kai."
 * '' when no fight is on.
 */
export function combatLine(state: CombatState | null): string {
    if (!state?.active || !state.order.length) return '';
    const inFight = state.order.filter((item) => !item.out);
    const out = state.order.filter((item) => item.out).map((item) => item.holder);
    const order = inFight.map((item) => `${item.holder} ${item.init}${item.enemy ? ' (enemy)' : ''}`).join(', ');
    const acting = state.order[state.current];
    const parts = [`[Combat] Round ${state.round}. Turn order: ${order || 'nobody'}`];
    if (out.length) parts[0] += `; out: ${out.join(', ')}`;
    parts[0] += '.';
    if (acting && !acting.out) parts.push(`Now acting: ${acting.holder}.`);
    parts.push('Keep the fight to this order; one round per reply.');
    return parts.join(' ');
}

/** A stored combat state repaired, or null. */
export function readCombat(raw: unknown): CombatState | null {
    if (!isDict(raw) || !Array.isArray(raw.order)) return null;
    const order: Combatant[] = [];
    for (const item of raw.order) {
        if (!isDict(item) || typeof item.holder !== 'string' || !item.holder.trim()) continue;
        const combatant: Combatant = {
            holder: item.holder,
            init: typeof item.init === 'number' && Number.isFinite(item.init) ? item.init : 0,
        };
        if (item.enemy === true) combatant.enemy = true;
        if (item.out === true) combatant.out = true;
        order.push(combatant);
    }
    const int = (value: unknown, fallback: number) =>
        typeof value === 'number' && Number.isFinite(value) ? Math.trunc(value) : fallback;
    const state: CombatState = {
        active: raw.active === true,
        round: Math.max(1, int(raw.round, 1)),
        order,
        current: Math.min(Math.max(0, int(raw.current, 0)), Math.max(0, order.length - 1)),
        mechanicId: typeof raw.mechanicId === 'string' && raw.mechanicId ? raw.mechanicId : null,
        startedAt: int(raw.startedAt, -1),
        by: raw.by === 'director' || raw.by === 'model' ? raw.by : 'user',
    };
    if (typeof raw.endedAt === 'number') state.endedAt = int(raw.endedAt, -1);
    return state;
}
