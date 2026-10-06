// M25 combat mode (plan-2 §6 п. 11) with the real state: a fight started by hand (initiative for the scene and the
// enemies, enemy stats), turns, rounds per committed reply, enemies joining and going out (the fight ends with the
// last one), the block's fight lines, the director starting and ending a fight by the scene type.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DirectorApi, SceneState } from '../../../src/features/director/api';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { COMBAT_KIND, MechanicCombat } from '../../../src/features/mechanics/combat';
import { ENGINE_STRINGS } from '../../../src/features/mechanics/strings-engine';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { createMechanicsEnv } from './helpers-state';
import type { MechanicsEnv } from './helpers-state';

function fightDef(): MechanicDef {
    return {
        id: 'fight',
        name: 'Бой',
        summary: '',
        rules: 'Rounds.',
        attributes: [
            {
                id: 'hp',
                name: 'Здоровье',
                promptName: 'HP',
                kind: 'number',
                min: 0,
                max: 30,
                initial: 20,
                events: [
                    {
                        id: 'down',
                        when: { op: '<=', value: 0 },
                        text: '{holder} is down.',
                        actions: [{ who: 'actor', attr: 'combat', op: 'pull', value: '' }],
                    },
                ],
            },
            { id: 'agility', name: 'Ловкость', promptName: 'Agility', kind: 'number', min: 0, max: 10, initial: 2 },
        ],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'init',
                name: 'Инициатива',
                promptName: 'Initiative',
                dice: '1d20+@agility',
                difficulty: null,
                triggers: [],
            },
        ],
        tracking: 'block',
        scope: { kind: 'global' },
        combat: { initiative: 'init', enemy: { hp: 8, agility: 5 } },
    };
}

class FakeDirector {
    scene: SceneState | null = null;
    private readonly listeners = new Set<() => void>();
    api(): DirectorApi {
        return {
            scene: () => this.scene,
            setScene: async () => {},
            stall: () => ({ turns: 0, reasons: [] }),
            notes: () => [],
            nudge: async () => null,
            flags: () => ({}),
            onChange: (listener: () => void): Unsubscribe => {
                this.listeners.add(listener);
                return () => this.listeners.delete(listener);
            },
        };
    }
    set(type: SceneState['type'], messageIndex: number): void {
        this.scene = { type, confidence: 0.9, messageIndex, by: 'rules', held: 1 };
        for (const listener of [...this.listeners]) listener();
    }
}

let env: MechanicsEnv;
let combat: MechanicCombat;
let director: FakeDirector;

/** Initiative rolls in order: d20 faces. */
function faces(...values: number[]): () => number {
    let i = 0;
    return () => ((values[i++] ?? 10) - 0.5) / 20;
}

async function start(rng: () => number = faces(10, 15, 3)): Promise<void> {
    vi.useFakeTimers();
    env = createMechanicsEnv();
    env.app.i18n.register(ENGINE_STRINGS);
    director = new FakeDirector();
    env.modules.expose('director', director.api());
    env.defs.defs = [fightDef()];
    await env.start();
    combat = new MechanicCombat(
        { app: env.app, log: env.app.log, settings: () => env.settings },
        env.defs,
        env.state,
        rng,
    );
    combat.install();
    env.tracking.onCombatLines((index, lines) => combat.handleLines(index, lines));
}

beforeEach(() => {
    // each test starts its own env
});

afterEach(() => {
    combat?.dispose();
    env?.stop();
    vi.useRealTimers();
});

describe('a fight by hand', () => {
    it('rolls initiative for the scene and the enemies, gives enemies their stats, journals it', async () => {
        await start();
        const state = await combat.start({ enemies: ['Bandit'] });
        // Kai 10+2, Алекс 15+2, Bandit 3+5.
        expect(state?.order).toEqual([
            { holder: 'Алекс', init: 17 },
            { holder: 'Kai', init: 12 },
            { holder: 'Bandit', init: 8, enemy: true },
        ]);
        expect(state).toMatchObject({ active: true, round: 1, by: 'user', mechanicId: 'fight' });
        expect(env.state.value('fight', 'Bandit', 'hp')).toBe(8);
        expect(env.state.holdersInScene(fightDef())).toEqual(['Kai', 'Алекс', 'Bandit']);
        const record = env.journal.records.find((item) => item.kind === COMBAT_KIND)!;
        expect(record.changes.length).toBeGreaterThanOrEqual(2);
        // Starting again adds the enemies to the running fight.
        await combat.start({ enemies: ['Wolf'] });
        expect(combat.combat()?.order.map((item) => item.holder)).toContain('Wolf');
    });

    it('turns, rounds per committed reply, the end when every enemy is down', async () => {
        await start();
        await combat.start({ enemies: ['Bandit'] });
        expect((await combat.nextTurn())?.current).toBe(1);
        await env.commit(await env.receive('Удар.', [{ name: 'Kai' }]));
        expect(combat.combat()?.round).toBe(2);
        await combat.addEnemy('Wolf', { hp: 3 });
        expect(env.state.value('fight', 'Wolf', 'hp')).toBe(3);
        await combat.out('Wolf');
        expect(combat.combat()?.order.find((item) => item.holder === 'Wolf')?.out).toBe(true);
        // The bandit falls: its HP event takes it out and the fight ends.
        await env.state.apply([
            { mechanicId: 'fight', holder: 'Bandit', attribute: 'hp', value: 0, source: 'user', messageIndex: -1 },
        ]);
        expect(combat.combat()).toMatchObject({ active: false });
        expect(env.state.pendingEvents().map((event) => event.text)).toEqual([
            'Bandit is down.',
            'The fight is over: every enemy is down.',
        ]);
        await combat.end();
        expect(await combat.nextTurn()).toMatchObject({ active: false });
    });

    it('without a fight mechanic: an error for the user, nothing for others', async () => {
        await start();
        env.defs.defs = [];
        await expect(combat.start()).rejects.toThrow('No mechanic on in this chat runs fights');
        expect(await combat.start({}, { by: 'model', source: 'block', messageIndex: 3 })).toBeNull();
        await combat.out('Kai');
        await combat.addEnemy(' ');
        expect(combat.combat()).toBeNull();
    });
});

describe('fights from the block and the director', () => {
    it('the block starts, adds, takes out and ends a fight at the commit', async () => {
        await start();
        const index = await env.receive(
            '<mechanics>\ncombat: start Bandit\ncombat: enemy Wolf hp=4\ncombat: out Wolf\n</mechanics>',
            [{ name: 'Kai' }],
        );
        await env.commit(index);
        expect(combat.combat()).toMatchObject({ active: true, by: 'model', startedAt: index });
        expect(combat.combat()?.order.find((item) => item.holder === 'Wolf')).toMatchObject({ out: true });
        expect(env.state.value('fight', 'Wolf', 'hp')).toBe(4);
        const end = await env.receive('<mechanics>\ncombat: end\n</mechanics>', [{ name: 'Kai' }]);
        await env.commit(end);
        expect(combat.combat()?.active).toBe(false);
        // A swipe of the starting reply takes the fight back.
        await env.app.bus.emit('message:invalidated', { messageIndex: index, reason: 'deleted' });
        await env.tick(20);
        expect(combat.combat()).toBeNull();
    });

    it('the director starts a fight when the scene becomes one and ends its own when it stops', async () => {
        await start();
        director.set('combat', 4);
        await env.tick(20);
        expect(combat.combat()).toMatchObject({ active: true, by: 'director', startedAt: 4 });
        director.set('combat', 5);
        await env.tick(20);
        expect(combat.combat()?.startedAt).toBe(4);
        director.set('dialogue', 6);
        await env.tick(20);
        expect(combat.combat()?.active).toBe(false);
        // The user ends a director's fight: the same scene decision does not start it again.
        director.set('combat', 7);
        await env.tick(20);
        await combat.end();
        director.set('combat', 7);
        await env.tick(20);
        expect(combat.combat()?.active).toBe(false);
        // Switched off: nothing happens.
        env.settings.autoCombat = false;
        director.set('combat', 9);
        await env.tick(20);
        expect(combat.combat()?.active).toBe(false);
    });

    it('the director’s fights are not followed in another tab', async () => {
        await start();
        env.leader.value = false;
        director.set('combat', 4);
        await env.tick(20);
        expect(combat.combat()).toBeNull();
    });
});
