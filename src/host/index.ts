// The only door to SillyTavern (docs/ARCHITECTURE.md): context, ordered events, runtime module imports,
// capabilities and the fetch gate.
import type { Host, Logger } from '../shared/contracts';
import { createCapabilities, registerBuiltinProbes } from './caps';
import type { CapabilityRegistry } from './caps';
import { createHostEvents } from './events';
import type { HostEventsImpl } from './events';
import { createFetchGate } from './fetch-gate';
import type { FetchGateImpl } from './fetch-gate';
import { createHostModules } from './modules';
import type { HostModulesImpl } from './modules';

export { BUILTIN_CAPABILITIES } from './caps';
export type { BuiltinCapability, CapabilityRegistry, Probe, ProbeOutcome } from './caps';
export type { FetchGateImpl } from './fetch-gate';
export type { HostEventsImpl } from './events';
export type { HostModulesImpl } from './modules';

export interface HostImpl extends Host {
    events: HostEventsImpl;
    modules: HostModulesImpl;
    caps: CapabilityRegistry;
    fetchGate: FetchGateImpl;
    /** Installs the fetch gate (once), registers the built-in capability probes and starts reading the ST version. */
    install(): void;
    /** Removes our listeners and the fetch wrapper (pass-through if someone wrapped fetch after us). */
    dispose(): void;
    /** Resolves when the ST version request has finished (value may be undefined). */
    versionReady(): Promise<string | undefined>;
}

/** Never cache the result: getContext() builds a new object on every call and chatMetadata is reassigned on chat load. */
function context(): STContext {
    return SillyTavern.getContext();
}

export function createHost(log: Logger): HostImpl {
    const events = createHostEvents(context, log.scope('events'));
    const modules = createHostModules(log.scope('modules'));
    const caps = createCapabilities(log.scope('caps'));
    const fetchGate = createFetchGate(log.scope('fetch'));

    let version: string | undefined;
    let versionPromise: Promise<string | undefined> | null = null;
    let installed = false;

    async function loadVersion(): Promise<string | undefined> {
        try {
            // GET /version → { agent, pkgVersion, gitRevision, gitBranch } (src/server-main.js, src/util.js getVersion).
            const response = await fetch('/version', { cache: 'no-cache' });
            if (!response.ok) return undefined;
            const data: unknown = await response.json();
            const pkgVersion =
                data && typeof data === 'object' ? (data as Record<string, unknown>)['pkgVersion'] : undefined;
            if (typeof pkgVersion === 'string' && pkgVersion && pkgVersion !== 'UNKNOWN') version = pkgVersion;
        } catch (error) {
            log.debug('could not read the ST version', error);
        }
        return version;
    }

    const host: HostImpl = {
        ctx: context,
        events,
        modules,
        caps,
        fetchGate,

        version(): string | undefined {
            return version;
        },

        chatId(): string | null {
            return context().getCurrentChatId() ?? null;
        },

        isGroupChat(): boolean {
            return Boolean(context().groupId);
        },

        isChatCompletion(): boolean {
            return context().mainApi === 'openai';
        },

        install(): void {
            if (installed) return;
            installed = true;
            fetchGate.install();
            versionPromise = loadVersion();
            registerBuiltinProbes(caps, { ctx: context, modules, version: () => host.versionReady() });
        },

        dispose(): void {
            fetchGate.dispose();
            events.dispose();
            installed = false;
        },

        versionReady(): Promise<string | undefined> {
            return versionPromise ?? Promise.resolve(version);
        },
    };
    return host;
}
