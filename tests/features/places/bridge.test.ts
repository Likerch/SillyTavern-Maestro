import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PLACES_GLOBAL, createPlacesBridge, placesModule } from '../../../src/features/places';
import type { BridgePlace, MaestroPlacesBridge } from '../../../src/features/places';
import type { Place, PlacesApi } from '../../../src/features/places/api';
import { createPlacesTestApp, settle, startModule, turn } from './helpers';
import type { PlacesTestApp } from './helpers';

let env: PlacesTestApp;

function bridge(): MaestroPlacesBridge | undefined {
    return (globalThis as Record<string, unknown>)[PLACES_GLOBAL] as MaestroPlacesBridge | undefined;
}

beforeEach(() => {
    env = createPlacesTestApp();
});

afterEach(() => {
    delete (globalThis as Record<string, unknown>)[PLACES_GLOBAL];
});

describe('globalThis.MAESTRO_PLACES', () => {
    it('is installed on start, follows the registry and goes away on stop', async () => {
        expect(bridge()).toBeUndefined();
        const started = await startModule(env, placesModule);
        await settle();
        const api = bridge()!;
        expect(api.version).toBe(1);
        expect(Object.isFrozen(api)).toBe(true);
        expect(api.current()).toBeNull();
        expect(api.list()).toEqual([]);

        const entered: [BridgePlace | null, BridgePlace | null][] = [];
        const off = api.onEnter((place, previous) => entered.push([place, previous]));
        await turn(env, 'Main Hall, Rusty Anchor Tavern');
        await turn(env, 'Main Hall, Rusty Anchor Tavern');
        const inn = api.list().find((place) => place.name === 'Rusty Anchor Tavern')!;
        const hall = api.current()!;
        expect(hall).toEqual({ id: hall.id, name: 'Main Hall', aliases: [], parent: inn.id });
        expect(Object.keys(hall).sort()).toEqual(['aliases', 'id', 'name', 'parent']);
        expect(api.resolve('Rusty Anchor Tavern — Main Hall')).toEqual(hall);
        expect(api.resolve('Nowhere')).toBeNull();
        expect(api.resolve('   ')).toBeNull();
        expect(api.resolve(42 as unknown as string)).toBeNull();
        expect(entered).toEqual([[hall, null]]);

        // Copies only: changing them does not touch the registry.
        hall.aliases.push('Hacked');
        hall.name = 'Hacked';
        expect(api.current()?.name).toBe('Main Hall');

        await turn(env, 'Rusty Anchor Tavern, Kitchen');
        expect(entered.at(-1)).toEqual([inn, { ...hall, name: 'Main Hall', aliases: [] }]);
        off();
        await turn(env, 'Main Hall');
        expect(entered).toHaveLength(2);
        expect(api.onEnter(null as unknown as () => void)).toBeTypeOf('function');

        const late: unknown[] = [];
        api.onEnter((place) => late.push(place));
        await started.stop();
        expect(bridge()).toBeUndefined();
        await env.app.bus.emit('turn:committed', { messageIndex: 0 });
        await settle();
        expect(late).toEqual([]);
    });

    it('leaves a bridge someone else installed after ours alone', async () => {
        const started = await startModule(env, placesModule);
        const other = { version: 99 };
        (globalThis as Record<string, unknown>)[PLACES_GLOBAL] = other;
        await started.stop();
        expect(bridge()).toBe(other);
    });

    it('wraps any PlacesApi', () => {
        const place: Place = {
            id: 'p1',
            name: 'Inn',
            aliases: ['Tavern'],
            forms: [],
            parent: null,
            createdAt: 0,
            firstSeen: 0,
            lastSeen: 0,
            visits: [],
        };
        let listener: ((place: Place | null, previous: Place | null) => void) | null = null;
        const api = {
            list: () => [place],
            current: () => null,
            resolve: (label: string) => (label === 'inn' ? place : undefined),
            onEnter: (next: typeof listener) => {
                listener = next;
                return () => {
                    listener = null;
                };
            },
        } as unknown as PlacesApi;
        const view = createPlacesBridge(api);
        expect(view.list()).toEqual([{ id: 'p1', name: 'Inn', aliases: ['Tavern'], parent: null }]);
        expect(view.resolve('inn')?.id).toBe('p1');
        const seen: (string | null)[] = [];
        const off = view.onEnter((next, previous) => seen.push(next?.id ?? null, previous?.id ?? null));
        listener!(place, null);
        expect(seen).toEqual(['p1', null]);
        off();
        expect(listener).toBeNull();
    });
});
