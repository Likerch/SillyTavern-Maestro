// M25 «Механики», combat mode (plan-2 §6 п. 11 «Боевой режим»): a fight run by a mechanic with `combat` (its
// initiative check, the stats a new enemy starts with). It starts by hand (the pult, the API), from the model's
// service block (`combat: start`, `combat: enemy Bandit hp=12`) or by itself when the director decides the scene is a
// fight (settings.autoCombat; the director's own decision, never on the send path); it ends by hand, from the block
// (`combat: end`), when every enemy is out (an HP event action `combat: pull`) or when the director's scene is no
// longer a fight (only for fights the director started). Initiative is rolled for everyone in the scene and the
// enemies; each committed reply is a round (the state's turn); the order goes into the prompt as one line.
// Every step is a change of the state's log (rolled back with its message) — the user's own steps are journaled.
import { parseDice } from '../../domain/mechanics-defs';
import { rollDice } from '../../domain/mechanics-dice';
import type { Rng } from '../../domain/mechanics-dice';
import { combatantOf, endCombat, nextTurn, startCombat } from '../../domain/mechanics-combat';
import type { Combatant } from '../../domain/mechanics-combat';
import type { BlockCombat } from '../../domain/mechanics-block';
import { nameKey } from '../../domain/mechanics-state';
import type { Unsubscribe } from '../../shared/contracts';
import type { DirectorApi } from '../director/api';
import type { ChangeSource, CombatState, MechanicDef } from './api';
import type { DefinitionsPart, PartDeps, StateOp, StatePart } from './parts';
import { personaOf } from './state-holders';

/** Journal kind of the user's own fight steps. */
export const COMBAT_KIND = 'mechanics.combat';

export interface CombatStep {
    by: CombatState['by'];
    source: ChangeSource;
    messageIndex: number;
}

const USER_STEP: CombatStep = { by: 'user', source: 'user', messageIndex: -1 };

export class MechanicCombat {
    private readonly offs: Unsubscribe[] = [];
    /** The director's fight the user ended by hand: not started again for the same scene decision. */
    private dismissed = -1;
    private disposed = false;

    constructor(
        private readonly deps: PartDeps,
        private readonly defs: DefinitionsPart,
        private readonly state: StatePart,
        private readonly rng: Rng,
    ) {}

    install(): void {
        const director = this.director();
        if (director) this.offs.push(director.onChange(() => void this.followDirector()));
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.log.debug('mechanics combat: release failed', error);
            }
        }
    }

    private director(): DirectorApi | undefined {
        try {
            return this.deps.app.modules.api<DirectorApi>('director');
        } catch {
            return undefined;
        }
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.deps.app.i18n.t(key, params);
    }

    combat(): CombatState | null {
        return this.state.combat?.() ?? null;
    }

    /** The mechanic that runs fights: the given one, else the first active one with combat settings. */
    mechanic(id?: string): MechanicDef | null {
        let active: MechanicDef[];
        try {
            active = this.defs.active();
        } catch {
            active = [];
        }
        if (id) return active.find((def) => def.id === id) ?? null;
        return active.find((def) => def.combat !== undefined) ?? null;
    }

    private async apply(ops: StateOp[], step: CombatStep): Promise<void> {
        if (!ops.length) return;
        if (!this.state.applyOps) return;
        await this.state.applyOps(
            ops,
            step.source === 'user' || step.by === 'director' ? { journal: true, kind: COMBAT_KIND } : {},
        );
    }

    /** An initiative total: the mechanic's initiative check (1d20 without one) with the holder's numbers. */
    private initiative(def: MechanicDef, holder: string, stats: Record<string, number> = {}): number {
        const check = def.checks.find((item) => item.id === def.combat?.initiative);
        const formula = parseDice(check?.dice ?? '1d20') ?? parseDice('1d20');
        if (!formula) return 0;
        const lookup = (attribute: string) =>
            stats[attribute] ?? this.state.numberOf?.(def.id, holder, attribute) ?? null;
        const bonus = check ? (this.state.checkBonus?.(def, check.id, holder) ?? 0) : 0;
        return rollDice(formula, lookup, this.rng, { bonus, criticals: false }).total;
    }

    /** Starting values of a new enemy: the mechanic's enemy stats, then the given ones. */
    private enemyOps(def: MechanicDef, name: string, values: Record<string, number>, step: CombatStep): StateOp[] {
        const known = this.state.state(name).some((item) => item.mechanicId === def.id && item.updatedAt !== -1);
        const stats = { ...(known ? {} : (def.combat?.enemy ?? {})), ...values };
        return Object.entries(stats)
            .filter(([attribute]) => def.attributes.some((attr) => attr.id === attribute && !attr.formula))
            .map(([attribute, value]) => ({
                mechanicId: def.id,
                holder: name,
                attribute,
                value,
                source: step.source,
                messageIndex: step.messageIndex,
                reason: 'enemy',
            }));
    }

    /** Starts a fight with everyone in the scene of the combat mechanic and the enemies; null without such a mechanic. */
    async start(
        options: { enemies?: string[]; mechanicId?: string; stats?: Record<string, number> } = {},
        step: CombatStep = USER_STEP,
    ): Promise<CombatState | null> {
        const def = this.mechanic(options.mechanicId);
        if (!def) {
            if (step.source === 'user') throw new Error(this.t('m25.combat.error.noMechanic'));
            return null;
        }
        const current = this.combat();
        if (current?.active) {
            for (const enemy of options.enemies ?? []) await this.addEnemy(enemy, options.stats, step);
            return this.combat();
        }
        const persona = personaOf(this.deps.app);
        const enemies = (options.enemies ?? []).map((name) => name.trim()).filter(Boolean);
        const sides = this.state
            .holdersInScene(def)
            .filter((holder) => !enemies.some((enemy) => nameKey(enemy) === nameKey(holder)));
        if (persona && !sides.some((holder) => nameKey(holder) === nameKey(persona))) sides.push(persona);
        const ops: StateOp[] = [];
        const combatants: Combatant[] = sides.map((holder) => ({ holder, init: this.initiative(def, holder) }));
        for (const enemy of enemies) {
            const stats = { ...(def.combat?.enemy ?? {}), ...(options.stats ?? {}) };
            ops.push(...this.enemyOps(def, enemy, options.stats ?? {}, step));
            combatants.push({ holder: enemy, init: this.initiative(def, enemy, stats), enemy: true });
        }
        const next = startCombat(combatants, { mechanicId: def.id, at: step.messageIndex, by: step.by });
        ops.push({
            kind: 'combat',
            op: 'set',
            mechanicId: def.id,
            next,
            source: step.source,
            messageIndex: step.messageIndex,
        });
        await this.apply(ops, step);
        return this.combat();
    }

    async end(step: CombatStep = USER_STEP): Promise<void> {
        const current = this.combat();
        if (!current?.active) return;
        if (step.source === 'user' && current.by === 'director') this.dismissed = this.directorIndex();
        const next = endCombat(current, step.messageIndex);
        await this.apply(
            [
                {
                    kind: 'combat',
                    op: 'set',
                    mechanicId: current.mechanicId ?? '',
                    next,
                    source: step.source,
                    messageIndex: step.messageIndex,
                },
            ],
            step,
        );
    }

    async nextTurn(step: CombatStep = USER_STEP): Promise<CombatState | null> {
        const current = this.combat();
        if (!current?.active) return current;
        await this.apply(
            [
                {
                    kind: 'combat',
                    op: 'set',
                    mechanicId: current.mechanicId ?? '',
                    next: nextTurn(current),
                    source: step.source,
                    messageIndex: step.messageIndex,
                },
            ],
            step,
        );
        return this.combat();
    }

    /** An enemy joins (a fight starts when none is on). */
    async addEnemy(name: string, values: Record<string, number> = {}, step: CombatStep = USER_STEP): Promise<void> {
        const clean = name.trim();
        if (!clean) return;
        const current = this.combat();
        if (!current?.active) {
            await this.start({ enemies: [clean], stats: values }, step);
            return;
        }
        const def = this.mechanic(current.mechanicId ?? undefined) ?? this.mechanic();
        if (!def) return;
        const ops = this.enemyOps(def, clean, values, step);
        if (!combatantOf(current, clean) || combatantOf(current, clean)?.out) {
            const stats = { ...(def.combat?.enemy ?? {}), ...values };
            ops.push({
                kind: 'combat',
                op: 'join',
                mechanicId: def.id,
                holder: clean,
                init: this.initiative(def, clean, stats),
                enemy: true,
                source: step.source,
                messageIndex: step.messageIndex,
            });
        }
        await this.apply(ops, step);
    }

    /** A combatant is out (down, fled); the fight ends when every enemy is out. */
    async out(name: string, step: CombatStep = USER_STEP): Promise<void> {
        const current = this.combat();
        if (!current?.active || !combatantOf(current, name)) return;
        await this.apply(
            [
                {
                    kind: 'combat',
                    op: 'out',
                    mechanicId: current.mechanicId ?? '',
                    holder: name,
                    source: step.source,
                    messageIndex: step.messageIndex,
                },
            ],
            step,
        );
    }

    /** The block's fight lines of a committed reply. */
    async handleLines(index: number, lines: readonly BlockCombat[]): Promise<void> {
        const step: CombatStep = { by: 'model', source: 'block', messageIndex: index };
        for (const line of lines) {
            switch (line.action) {
                case 'start':
                    await this.start({ enemies: line.names, ...(line.stats ? { stats: line.stats } : {}) }, step);
                    break;
                case 'end':
                    await this.end(step);
                    break;
                case 'enemy':
                    for (const name of line.names) await this.addEnemy(name, line.stats ?? {}, step);
                    break;
                case 'out':
                    for (const name of line.names) await this.out(name, step);
                    break;
            }
        }
    }

    private directorIndex(): number {
        try {
            return this.director()?.scene()?.messageIndex ?? -1;
        } catch {
            return -1;
        }
    }

    private isLeader(): boolean {
        try {
            return this.deps.app.leader.isLeader();
        } catch {
            return false;
        }
    }

    /** The director decided the scene: a fight starts when it becomes one, a director's fight ends when it stops. */
    private async followDirector(): Promise<void> {
        if (this.disposed || !this.deps.settings().autoCombat || !this.isLeader()) return;
        if (!this.deps.app.host.chatId() || !this.mechanic()) return;
        let scene: ReturnType<DirectorApi['scene']>;
        try {
            scene = this.director()?.scene() ?? null;
        } catch {
            scene = null;
        }
        if (!scene) return;
        const current = this.combat();
        const step: CombatStep = { by: 'director', source: 'event', messageIndex: scene.messageIndex };
        try {
            if (scene.type === 'combat' && !current?.active && scene.messageIndex !== this.dismissed) {
                if (current && current.startedAt >= scene.messageIndex) return;
                await this.start({}, step);
            } else if (scene.type !== 'combat' && current?.active && current.by === 'director') {
                await this.end(step);
            }
        } catch (error) {
            this.deps.log.warn('mechanics: the fight did not follow the director', error);
        }
    }
}
