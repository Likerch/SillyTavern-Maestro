// One-turn flags and injections (plan P8, P11; dev-plan §1.3): set right before a generation, cleared after it.
// - Flags are chat-local variables (`{{if .maestro_x}}` blocks in the preset). They are written straight into
//   ctx().chatMetadata.variables without saveMetadata(): they must never be persisted on purpose.
// - Injections are extension prompt slots `maestro_<key>`; clearing sets them to '' (ST skips empty slots).
import type { GenerationInfo, Host, InjectionSpec, Logger, Unsubscribe } from '../shared/contracts';
import type { EphemeralRunner } from './turn';

export interface EphemeralDeps {
    host: Host;
    log: Logger;
}

type Producer = (gen: GenerationInfo) => void | Promise<void>;

export function injectionKey(key: string): string {
    return `maestro_${key}`;
}

export function createEphemeral(deps: EphemeralDeps): EphemeralRunner {
    const { host, log } = deps;
    const producers = new Map<string, Producer>();
    // Flags remember the exact variables object they were written to: chatMetadata is reassigned on chat
    // load, and clearAll() must clean the object it touched, not whatever chat is open now.
    const flags = new Map<string, Record<string, unknown>>();
    const injections = new Map<string, InjectionSpec>();

    const variables = (): Record<string, unknown> => {
        const meta = host.ctx().chatMetadata;
        const current = meta.variables;
        if (current && typeof current === 'object' && !Array.isArray(current))
            return current as Record<string, unknown>;
        const created: Record<string, unknown> = {};
        meta.variables = created;
        return created;
    };

    const clearAll = (): void => {
        for (const [name, store] of flags) delete store[name];
        flags.clear();
        if (injections.size === 0) return;
        const ctx = host.ctx();
        for (const [key, spec] of injections) {
            try {
                ctx.setExtensionPrompt(injectionKey(key), '', spec.position, spec.depth ?? 0, false, spec.role ?? 0);
            } catch (error) {
                log.warn(`could not clear injection ${key}`, error);
            }
        }
        injections.clear();
    };

    return {
        setFlag(name: string, value: string | number | boolean): void {
            const store = variables();
            const previous = flags.get(name);
            if (previous && previous !== store) delete previous[name];
            // ST variables are strings ('false' and '0' are falsy for {{if}}).
            store[name] = typeof value === 'string' ? value : String(value);
            flags.set(name, store);
        },

        setInjection(key: string, spec: InjectionSpec): void {
            host.ctx().setExtensionPrompt(
                injectionKey(key),
                spec.text,
                spec.position,
                spec.depth ?? 0,
                spec.scan ?? false,
                spec.role ?? 0,
            );
            injections.set(key, { ...spec });
        },

        addProducer(name: string, producer: Producer): Unsubscribe {
            if (producers.has(name)) log.warn(`ephemeral producer ${name} replaced`);
            producers.set(name, producer);
            return () => {
                if (producers.get(name) === producer) producers.delete(name);
            };
        },

        clearAll,

        async run(info: GenerationInfo): Promise<void> {
            clearAll();
            if (info.dryRun) return;
            for (const [name, producer] of [...producers]) {
                try {
                    await producer(info);
                } catch (error) {
                    log.error(`ephemeral producer ${name} failed`, error);
                }
            }
        },
    };
}
