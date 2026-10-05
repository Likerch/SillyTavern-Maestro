// M25 «Механики»: helpers shared by the state and tracking parts — who the holders are (the persona, canonical
// character names through the world model) and Maestro's record on chat messages.
import type { HolderContext } from '../../domain/mechanics-state';
import type { App } from '../../shared/contracts';
import type { WorldModelApi } from '../world/api';

export function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The world model (M7), when it runs. */
export function worldOf(app: App): WorldModelApi | undefined {
    try {
        return app.modules.api<WorldModelApi>('world');
    } catch {
        return undefined;
    }
}

/** The persona's name (`name1`), '' without one. */
export function personaOf(app: App): string {
    try {
        return String(app.host.ctx().name1 ?? '').trim();
    } catch {
        return '';
    }
}

/** Holder resolution context: the persona and canonical character names (DES aliases, chat aliases, case forms). */
export function holderContextOf(app: App): HolderContext {
    const context: HolderContext = { persona: personaOf(app) };
    const world = worldOf(app);
    if (world && typeof world.resolve === 'function') {
        context.canonical = (name: string) => {
            const entity = world.resolve(name, 'character') ?? world.resolve(name, 'persona');
            return entity?.name;
        };
    }
    return context;
}

export function swipeIdOf(message: STChatMessage | null | undefined): number {
    return typeof message?.swipe_id === 'number' && message.swipe_id >= 0 ? message.swipe_id : 0;
}
