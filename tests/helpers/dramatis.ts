// Dramatis for tests (release 1.17): a DRAMATIS_API v1 double with settable answers, and the real Dramatis adapter
// installed into a test App reading it from the global (as Maestro does in SillyTavern).
import { DRAMATIS_API_GLOBAL, DramatisAdapter, ExtensionLocator } from '../../src/adapters';
import type { DramatisApiV1, DramatisStanceInfo } from '../../src/adapters';
import type { App, Logger } from '../../src/shared/contracts';

const globals = globalThis as unknown as Record<string, unknown>;

export const quietLog: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    scope: () => quietLog,
};

export class FakeDramatisApi implements DramatisApiV1 {
    readonly version = 1 as const;
    dramatisVersion = '0.1.0';
    isActive = true;
    cast = true;
    owned: string[] = [];
    stanceList: DramatisStanceInfo[] = [];
    briefs: Record<string, string> = {};
    goalMap: Record<string, string[]> = {};
    agendas: { text: string; weight: number }[] = [];
    replaces = false;
    readonly listeners = new Set<() => void>();
    calls: string[] = [];

    active(): boolean {
        return this.isActive;
    }
    castBlockActive(): boolean {
        this.calls.push('castBlockActive');
        return this.cast;
    }
    dependenceOwned(): string[] {
        return [...this.owned];
    }
    stances(): DramatisStanceInfo[] {
        return this.stanceList.map((item) => ({ ...item, reasons: [...item.reasons] }));
    }
    goals(name: string): string[] {
        return [...(this.goalMap[name] ?? [])];
    }
    offscreenBrief(name: string): string | null {
        return this.briefs[name] ?? null;
    }
    matureAgendas(): { text: string; weight: number }[] {
        return this.agendas.map((item) => ({ ...item }));
    }
    replacesSocialMechanics(): boolean {
        return this.replaces;
    }
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(): void {
        for (const listener of [...this.listeners]) listener();
    }
}

export interface InstalledDramatis {
    adapter: DramatisAdapter;
    api: FakeDramatisApi;
    remove(): void;
}

/** Publishes the double as DRAMATIS_API and gives the App a real Dramatis adapter over it. */
export function installDramatis(app: Pick<App, 'host' | 'adapters'>, api = new FakeDramatisApi()): InstalledDramatis {
    globals[DRAMATIS_API_GLOBAL] = api;
    const adapter = new DramatisAdapter({
        host: app.host,
        log: quietLog,
        locator: new ExtensionLocator(app.host, quietLog, async () => new Response('{}', { status: 404 })),
        importModule: async () => ({}),
    });
    (app.adapters as unknown as Record<string, unknown>).dramatis = adapter;
    return {
        adapter,
        api,
        remove() {
            if (globals[DRAMATIS_API_GLOBAL] === api) delete globals[DRAMATIS_API_GLOBAL];
            adapter.dispose();
        },
    };
}

/** Takes DRAMATIS_API off the page (Dramatis disabled or not loaded). */
export function hideDramatis(): void {
    delete globals[DRAMATIS_API_GLOBAL];
}
