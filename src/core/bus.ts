import type { Bus, Logger, MaestroEvents, Unsubscribe } from '../shared/contracts';

type Handler<K extends keyof MaestroEvents> = (payload: MaestroEvents[K]) => void | Promise<void>;

/** Maestro's internal event bus. Handlers run in registration order; one failing handler does not stop others. */
export class EventBus implements Bus {
    private readonly handlers = new Map<keyof MaestroEvents, Set<Handler<never>>>();

    constructor(private readonly log: Logger) {}

    on<K extends keyof MaestroEvents>(event: K, handler: Handler<K>): Unsubscribe {
        let set = this.handlers.get(event);
        if (!set) {
            set = new Set();
            this.handlers.set(event, set);
        }
        set.add(handler as Handler<never>);
        return () => {
            set.delete(handler as Handler<never>);
        };
    }

    async emit<K extends keyof MaestroEvents>(event: K, payload: MaestroEvents[K]): Promise<void> {
        const set = this.handlers.get(event);
        if (!set) return;
        for (const handler of [...set]) {
            try {
                await (handler as Handler<K>)(payload);
            } catch (error) {
                this.log.error(`bus handler for ${String(event)} failed`, error);
            }
        }
    }
}

export function createBus(log: Logger): EventBus {
    return new EventBus(log);
}
