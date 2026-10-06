import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { CheckResult, FiredEvent, HolderState, StateChange } from '../../../src/features/mechanics/api';
import type { ChecksPart, StatePart } from '../../../src/features/mechanics/parts';
import { MechanicsService } from '../../../src/features/mechanics/service';
import type { App } from '../../../src/shared/contracts';
import { AVATAR, createDefsEnv, FakeDefs, mechanic } from './helpers-defs';
import type { DefsEnv } from './helpers-defs';

let env: DefsEnv;
let defs: FakeDefs;
let state: StatePart & Record<string, ReturnType<typeof vi.fn>>;
let checks: ChecksPart & Record<string, ReturnType<typeof vi.fn>>;
let service: MechanicsService;

const holder: HolderState = { mechanicId: 'magic', holder: 'Kai', values: { mana: 40 }, updatedAt: 3 };
const change = { id: 'c1' } as StateChange;
const fired = { mechanicId: 'magic', text: 'Kai has no mana left.' } as FiredEvent;
const result = { id: 'r1', text: 'Spellcasting (Kai): 12 — success.' } as CheckResult;

beforeEach(() => {
    env = createDefsEnv();
    defs = new FakeDefs();
    defs.defs = [mechanic(), mechanic({ id: 'luck', name: 'Удача' })];
    let stateListener: (() => void) | null = null;
    state = {
        state: vi.fn(() => [holder]),
        value: vi.fn(() => 40),
        apply: vi.fn(async () => [change]),
        history: vi.fn(() => [change]),
        events: vi.fn(() => [fired]),
        pendingEvents: vi.fn(() => []),
        markEventsDelivered: vi.fn(async () => {}),
        holdersInScene: vi.fn(() => []),
        onChange: vi.fn((listener: () => void) => {
            stateListener = listener;
            return () => {
                stateListener = null;
            };
        }),
        dispose: vi.fn(),
        fire: vi.fn(() => stateListener?.()),
    } as unknown as typeof state;
    checks = {
        roll: vi.fn(async () => result),
        checks: vi.fn(() => [result]),
        pendingChecks: vi.fn(() => []),
        markChecksDelivered: vi.fn(),
        onChange: vi.fn(() => () => {}),
        dispose: vi.fn(),
    } as unknown as typeof checks;
    service = new MechanicsService(defs, state, checks, env.deps);
});

describe('MechanicsService', () => {
    it('delegates definitions to the definitions part', async () => {
        expect(service.list().map((def) => def.id)).toEqual(['magic', 'luck']);
        await service.setEnabledInChat('luck', false);
        expect(defs.switches).toEqual([['luck', false]]);
        expect(service.active().map((def) => def.id)).toEqual(['magic']);
        expect(service.get('luck')?.name).toBe('Удача');
        const saved = await service.save(mechanic({ id: 'money' }));
        expect(saved).toMatchObject({ id: 'money', uid: 1 });
        await service.remove('money');
        expect(defs.removed).toEqual(['money']);
    });

    it('delegates values, history and events to the state part, the user edit as a «user» change', async () => {
        expect(service.state('Kai')).toEqual([holder]);
        expect(state.state).toHaveBeenCalledWith('Kai');
        expect(service.value('magic', 'Kai', 'mana')).toBe(40);
        expect(state.value).toHaveBeenCalledWith('magic', 'Kai', 'mana');
        await service.set('magic', 'Kai', 'mana', 70);
        expect(state.apply).toHaveBeenCalledWith([
            { mechanicId: 'magic', holder: 'Kai', attribute: 'mana', value: 70, source: 'user', messageIndex: -1 },
        ]);
        expect(service.history(5)).toEqual([change]);
        expect(state.history).toHaveBeenCalledWith(5);
        expect(service.events(2)).toEqual([fired]);
        expect(state.events).toHaveBeenCalledWith(2);
        expect(service.twists()).toEqual([fired]);
        expect(state.events).toHaveBeenLastCalledWith(5);
    });

    it('delegates rolls and checks to the checks part', async () => {
        expect(await service.roll('magic', 'spell', 'Kai', { difficulty: 10 })).toBe(result);
        expect(checks.roll).toHaveBeenCalledWith('magic', 'spell', 'Kai', { difficulty: 10 });
        expect(service.checks(3)).toEqual([result]);
        expect(checks.checks).toHaveBeenCalledWith(3);
    });

    it('offers the templates and makes unsaved definitions for this card with fresh ids', () => {
        expect(service.templates().map((item) => item.id)).toEqual([
            'health',
            'magic',
            'reputation',
            'money',
            'skills',
            'relationships',
            'survival',
            'sanity',
            'trade',
            'combat',
            'social',
        ]);
        const magic = service.fromTemplate('magic')!;
        expect(magic).toMatchObject({ id: 'magic_2', name: 'Magic', scope: { kind: 'card', avatar: AVATAR } });
        expect(magic.uid).toBeUndefined();
        expect(service.fromTemplate('health')?.id).toBe('health');
        expect(service.fromTemplate('nope')).toBeNull();

        const ruApp = { ...env.app, i18n: { ...env.app.i18n, locale: () => 'ru' as const } } as App;
        expect(new MechanicsService(defs, state, checks, { app: ruApp }).fromTemplate('money')?.name).toBe('Деньги');
        env.character(null);
        expect(service.fromTemplate('money')?.scope).toEqual({ kind: 'chat', chatId: env.mock.chatId });
        expect(new MechanicsService(defs, state, checks).fromTemplate('money')).toMatchObject({
            name: 'Money',
            scope: { kind: 'global' },
        });
    });

    it('reports changes of every part and stops on unsubscribe', () => {
        const listener = vi.fn();
        const off = service.onChange(listener);
        defs.emit();
        (state as unknown as { fire(): void }).fire();
        expect(listener).toHaveBeenCalledTimes(2);
        expect(checks.onChange).toHaveBeenCalledWith(listener);
        off();
        defs.emit();
        (state as unknown as { fire(): void }).fire();
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
