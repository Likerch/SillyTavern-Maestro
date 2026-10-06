// M25 public API of plan-2 §6 (what the UI wave builds on): visibility (effective, per place, words, saving a preset,
// revealing), statuses and items by hand, buying and selling against the inventory's money, derived values, changes
// and rolls of a message, undo and reset, fights, the clock, the prompt preview, the events, templates with factions.
// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckResult, MechanicDef, MechanicsEvent } from '../../../src/features/mechanics/api';
import type { ChecksPart } from '../../../src/features/mechanics/parts';
import { MechanicsService } from '../../../src/features/mechanics/service';
import { ENGINE_STRINGS } from '../../../src/features/mechanics/strings-engine';
import type { Entity, EntityKind } from '../../../src/features/world/api';
import { createMechanicsEnv, fakeWorld, magicDef } from './helpers-state';
import type { MechanicsEnv } from './helpers-state';

function tradeDef(extra: Partial<MechanicDef> = {}): MechanicDef {
    return magicDef({
        id: 'trade',
        name: 'Торговля',
        attributes: [
            { id: 'coins', name: 'Монеты', promptName: 'Coins', kind: 'number', min: 0, initial: 30 },
            { id: 'rank', name: 'Ранг', promptName: 'Rank', kind: 'number', formula: 'floor(@coins / 10)' },
            {
                id: 'trust',
                name: 'Доверие',
                promptName: 'Trust',
                kind: 'number',
                min: 0,
                max: 100,
                initial: 50,
                visibility: { preset: 'hidden' },
            },
        ],
        statuses: [],
        inventory: { money: 'coins' },
        holders: { kind: 'characters', includePersona: true },
        ...extra,
    });
}

const roll: CheckResult = {
    id: 'r1',
    mechanicId: 'trade',
    checkId: 'haggle',
    holder: 'Алекс',
    dice: '1d20',
    rolls: [12],
    modifier: 0,
    total: 12,
    target: 10,
    outcome: 'success',
    text: 'Haggle check (Алекс): rolled 12 vs 10 — success.',
    messageIndex: 4,
    by: 'auto',
    at: 1,
};

function fakeChecks(): ChecksPart & { undone: string[] } {
    const undone: string[] = [];
    return {
        undone,
        roll: async () => roll,
        checks: () => [roll],
        pendingChecks: () => [],
        markChecksDelivered: () => {},
        onChange: () => () => {},
        dispose: () => {},
        rollsOf: (index) => (index === 4 ? [roll] : []),
        undoRoll: async (id) => {
            undone.push(id);
            return true;
        },
    };
}

let env: MechanicsEnv;
let service: MechanicsService;
let checks: ReturnType<typeof fakeChecks>;
const combatCalls: string[] = [];

beforeEach(async () => {
    vi.useFakeTimers();
    env = createMechanicsEnv();
    env.app.i18n.register(ENGINE_STRINGS);
    env.defs.defs = [tradeDef()];
    await env.start();
    checks = fakeChecks();
    combatCalls.length = 0;
    const combat = {
        start: async () => {
            combatCalls.push('start');
            return null;
        },
        end: async () => {
            combatCalls.push('end');
        },
        nextTurn: async () => {
            combatCalls.push('next');
            return null;
        },
        addEnemy: async (name: string) => {
            combatCalls.push(`enemy ${name}`);
        },
    };
    service = new MechanicsService(
        env.defs,
        env.state,
        checks,
        { app: env.app },
        {
            prompt: {
                preview: () => ({
                    text: 'x',
                    tokens: 1,
                    budget: 0,
                    budgetSource: 'own',
                    cut: [],
                    mechanics: [],
                    flags: [],
                    facts: '',
                }),
            },
            combat: combat as never,
        },
    );
});

afterEach(() => {
    env.stop();
    vi.useRealTimers();
});

describe('visibility', () => {
    it('effective sets, places with reveal, words, saving a preset or fields', async () => {
        expect(service.visibilityOf('trade')?.preset).toBe('game');
        expect(service.visibilityOf('trade', 'Trust')).toMatchObject({ preset: 'hidden', prompt: 'value' });
        expect(service.visibilityOf('trade', 'nope')).toBeNull();
        expect(service.visibilityOf('nope')).toBeNull();
        expect(service.shown('trade', 'coins', 'hud')).toBe(true);
        expect(service.shown('trade', 'trust', 'strip', 'Алекс')).toBe(false);
        await service.reveal('trade', 'Алекс', 'trust');
        expect(service.isRevealed('trade', 'Алекс', 'trust')).toBe(true);
        expect(service.shown('trade', 'trust', 'strip', 'Алекс')).toBe(true);
        expect(service.shown('nope', 'x', 'hud')).toBe(false);
        expect(env.journal.records.some((record) => record.kind === 'mechanics.reveal')).toBe(true);
        expect(service.wordsOf('trade', 'trust', 10)).toEqual({ label: 'very low', band: 1 });
        expect(service.wordsOf('trade', 'nope', 10)).toBeNull();

        await service.setVisibility('trade', 'coins', 'book');
        expect(env.defs.get('trade')?.attributes[0]?.visibility).toEqual({ preset: 'book' });
        await service.setVisibility('trade', null, { places: { narrator: true } });
        expect(env.defs.get('trade')?.visibility).toEqual({ places: { narrator: true } });
        await expect(service.setVisibility('trade', 'nope', 'game')).rejects.toThrow('unknown attribute');
        await expect(service.setVisibility('nope', null, 'game')).rejects.toThrow('unknown mechanic');
    });
});

describe('statuses, items, trade', () => {
    it('statuses by hand: add with the owner mechanic, remove by name', async () => {
        const change = await service.addStatus('Алекс', { name: 'Устал', duration: { turns: 2 } });
        expect(change).toMatchObject({ kind: 'status', mechanicId: 'trade', holder: 'Алекс' });
        expect(service.statuses('Алекс')[0]?.statuses[0]?.name).toBe('Устал');
        expect(await service.removeStatus('Алекс', 'устал')).toBe(true);
        expect(await service.removeStatus('Алекс', 'устал')).toBe(false);
        expect(env.journal.records.filter((record) => record.kind === 'mechanics.status')).toHaveLength(2);
        env.defs.defs = [magicDef()];
        expect(await service.addStatus('Алекс', { name: 'x' })).toBeNull();
    });

    it('items by hand: give, equip, take', async () => {
        expect(await service.giveItem('Алекс', { name: 'Верёвка' }, 2)).toMatchObject({ kind: 'item', to: 2 });
        expect(await service.equipItem('Алекс', 'верёвка', 'hand')).toMatchObject({ to: 'hand' });
        expect(await service.takeItem('Алекс', 'верёвка', 1)).toMatchObject({ from: 2, to: 1 });
        expect(service.items('Алекс')[0]?.items[0]).toMatchObject({ name: 'Верёвка', qty: 1, equipped: 'hand' });
        expect(env.journal.records.filter((record) => record.kind === 'mechanics.item')).toHaveLength(3);
    });

    it('buys against the money (refused when short) and sells for half the price', async () => {
        expect(await service.buy('Алекс', { name: 'Зелье', value: 10 }, 2)).toBe(true);
        expect(service.value('trade', 'Алекс', 'coins')).toBe(10);
        expect(service.items('Алекс')[0]?.items[0]).toMatchObject({ name: 'Зелье', qty: 2, value: 10 });
        expect(await service.buy('Алекс', { name: 'Меч' }, 1, 150)).toBe(false);
        expect(await service.sell('Алекс', 'зелье', 1)).toBe(true);
        expect(service.value('trade', 'Алекс', 'coins')).toBe(15);
        expect(await service.sell('Алекс', 'зелье', 5)).toBe(false);
        expect(await service.sell('Алекс', 'нет', 1)).toBe(false);
        expect(await service.buy('Алекс', { name: 'Подарок' })).toBe(true);
        expect(service.value('trade', 'Алекс', 'coins')).toBe(15);
        // Money in another mechanic.
        env.defs.defs = [
            tradeDef({ inventory: { money: 'purse.gold' } }),
            magicDef({
                id: 'purse',
                attributes: [{ id: 'gold', name: 'Золото', promptName: 'Gold', kind: 'number', initial: 5 }],
                holders: { kind: 'characters', includePersona: true },
            }),
        ];
        expect(await service.buy('Алекс', { name: 'Хлеб', value: 2 })).toBe(true);
        expect(service.value('purse', 'Алекс', 'gold')).toBe(3);
        env.defs.defs = [magicDef()];
        expect(await service.buy('Алекс', { name: 'x' })).toBe(false);
        expect(await service.sell('Алекс', 'x')).toBe(false);
        expect(await service.giveItem('Алекс', { name: 'x' })).toBeNull();
    });

    it('derived values with their parts', async () => {
        await service.set('trade', 'Алекс', 'coins', 42);
        expect(service.derived('trade', 'Алекс').map((value) => [value.attribute, value.value, value.formula])).toEqual(
            [
                ['coins', 42, undefined],
                ['rank', 4, 'floor(@coins / 10)'],
                ['trust', 50, undefined],
            ],
        );
    });
});

describe('per message, undo, reset, fights, the rest', () => {
    it('changes and rolls of a message; undo of a change and of a roll; reset', async () => {
        const [change] = await env.state.apply([
            {
                mechanicId: 'trade',
                holder: 'Алекс',
                attribute: 'coins',
                value: -5,
                delta: true,
                source: 'check',
                messageIndex: 4,
                rollId: 'r1',
            },
        ]);
        expect(service.changesOf(4).map((item) => item.id)).toEqual([change!.id]);
        expect(service.changesOf(4, { place: 'strip' })).toHaveLength(1);
        expect(service.rollsOf(4)).toEqual([roll]);
        expect(await service.undoRoll('r1')).toBe(true);
        expect(checks.undone).toEqual(['r1']);
        expect(await service.undoChange(change!.id)).toBe(true);
        expect(service.value('trade', 'Алекс', 'coins')).toBe(30);
        await service.set('trade', 'Алекс', 'coins', 1);
        expect(await service.reset({ holder: 'Алекс' })).toBe(1);
        expect(service.value('trade', 'Алекс', 'coins')).toBe(30);
    });

    it('fights, the clock, the preview, events, flags', async () => {
        await service.startCombat({ enemies: ['Bandit'] });
        await service.nextTurn();
        await service.addEnemy('Wolf');
        await service.endCombat();
        expect(combatCalls).toEqual(['start', 'next', 'enemy Wolf', 'end']);
        expect(service.combat()).toBeNull();
        expect(service.clock()).toBeNull();
        expect(service.previewPrompt()?.text).toBe('x');
        const events: MechanicsEvent[] = [];
        const off = service.onEvent((event) => events.push(event));
        await service.set('trade', 'Алекс', 'coins', 3);
        off();
        expect(events[0]).toMatchObject({ type: 'changes', messageIndex: -1 });
        expect(await service.roll('trade', 'haggle', 'Алекс', { mode: 'adv' })).toBe(roll);
    });

    it('without the optional parts the API answers with nothing', async () => {
        const bare = new MechanicsService(env.defs, { ...env.state, applyOps: undefined } as never, {
            roll: async () => roll,
            checks: () => [],
            pendingChecks: () => [],
            markChecksDelivered: () => {},
            onChange: () => () => {},
            dispose: () => {},
        });
        expect(bare.changesOf(1)).toEqual([]);
        expect(bare.rollsOf(1)).toEqual([]);
        expect(await bare.undoRoll('x')).toBe(false);
        expect(bare.previewPrompt()).toBeNull();
        expect(await bare.startCombat()).toBeNull();
        expect(await bare.nextTurn()).toBeNull();
        await bare.endCombat();
        await bare.addEnemy('x');
        expect(await bare.addStatus('Алекс', { name: 'x' })).toBeNull();
    });
});

describe('templates with factions of the lore', () => {
    it('a reputation template takes the factions the world model knows', () => {
        const world = fakeWorld();
        const factions: Entity[] = [
            { id: 'faction:guild', kind: 'faction', name: 'Гильдия воров', aliases: [], forms: [], sources: [] },
            { id: 'faction:crown', kind: 'faction', name: 'Корона', aliases: [], forms: [], sources: [] },
        ];
        env.modules.expose('world', {
            ...world,
            entities: (kind?: EntityKind) => (kind === 'faction' ? factions : world.entities(kind)),
        });
        expect(service.fromTemplate('reputation')?.holders).toEqual({
            kind: 'factions',
            names: ['Гильдия воров', 'Корона'],
        });
        env.modules.expose('world', {
            ...world,
            entities: () => {
                throw new Error('not ready');
            },
        });
        expect(service.fromTemplate('reputation')?.holders).toEqual({ kind: 'factions', names: [] });
        expect(new MechanicsService(env.defs, env.state, checks).fromTemplate('reputation')?.holders).toEqual({
            kind: 'factions',
            names: [],
        });
    });
});
