// M24 «Места» → NAI Studio (plan §16: location continuity binds to Maestro place ids). NAI Studio is another
// extension and cannot reach `app.modules`, so the registry is published as `globalThis.MAESTRO_PLACES` while the
// module runs (installed on init, removed on dispose). Plain copies only: nothing NAI Studio does with the objects
// reaches the registry. Version 1; later versions only add members.
import type { Unsubscribe } from '../../shared/contracts';
import type { Place, PlacesApi } from './api';

export const PLACES_GLOBAL = 'MAESTRO_PLACES';
export const PLACES_BRIDGE_VERSION = 1;
/** Fired on window when the bridge appears (an extension that loaded first can subscribe then). */
export const PLACES_READY_EVENT = 'maestro-places-ready';

export interface BridgePlace {
    id: string;
    name: string;
    aliases: string[];
    parent: string | null;
}

export interface MaestroPlacesBridge {
    readonly version: 1;
    /** The current place (the last committed DES location), or null. */
    current(): BridgePlace | null;
    /** A DES label, name, alias or Russian case form → the place, or null. */
    resolve(label: string): BridgePlace | null;
    list(): BridgePlace[];
    /** Called after a committed turn moved the current place; returns the unsubscribe. */
    onEnter(listener: (place: BridgePlace | null, previous: BridgePlace | null) => void): () => void;
}

function view(place: Place | null | undefined): BridgePlace | null {
    if (!place) return null;
    return { id: place.id, name: place.name, aliases: [...place.aliases], parent: place.parent };
}

export function createPlacesBridge(
    api: PlacesApi,
    track: (off: Unsubscribe) => Unsubscribe = (off) => off,
): MaestroPlacesBridge {
    return Object.freeze({
        version: PLACES_BRIDGE_VERSION,
        current: () => view(api.current()),
        resolve: (label: string) => (typeof label === 'string' && label.trim() ? view(api.resolve(label)) : null),
        list: () => api.list().map((place) => view(place) as BridgePlace),
        onEnter: (listener: (place: BridgePlace | null, previous: BridgePlace | null) => void) => {
            if (typeof listener !== 'function') return () => {};
            return track(api.onEnter((place, previous) => listener(view(place), view(previous))));
        },
    } as const);
}

/** Publishes the bridge; the returned disposer removes it and every listener registered through it. */
export function installPlacesBridge(api: PlacesApi): Unsubscribe {
    const listeners = new Set<Unsubscribe>();
    const bridge = createPlacesBridge(api, (off) => {
        listeners.add(off);
        return () => {
            listeners.delete(off);
            off();
        };
    });
    const scope = globalThis as Record<string, unknown>;
    scope[PLACES_GLOBAL] = bridge;
    try {
        if (typeof globalThis.dispatchEvent === 'function' && typeof CustomEvent === 'function') {
            globalThis.dispatchEvent(
                new CustomEvent(PLACES_READY_EVENT, { detail: { version: PLACES_BRIDGE_VERSION } }),
            );
        }
    } catch {
        // no window (tests)
    }
    return () => {
        for (const off of [...listeners]) off();
        listeners.clear();
        if (scope[PLACES_GLOBAL] === bridge) delete scope[PLACES_GLOBAL];
    };
}
