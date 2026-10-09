// Dramatis for tests (release 1.17): a DRAMATIS_API v1 double with settable answers, and the real Dramatis adapter
// installed into a test App reading it from the global (as Maestro does in SillyTavern). `upgrade()` gives the double
// Dramatis 1.3's optional members (intentState, readIntent, describe, openSheet); without it it is a Dramatis 1.2.
import { DRAMATIS_API_GLOBAL, DramatisAdapter, ExtensionLocator } from '../../src/adapters';
import type {
    DramatisApiV1,
    DramatisCharacterView,
    DramatisIntentState,
    DramatisReadOutcome,
    DramatisStanceInfo,
    DramatisStartMember,
} from '../../src/adapters';
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
    /** Dramatis 1.2's starting scenes by greeting (startCast). */
    starts: Record<number, DramatisStartMember[]> = {};
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
    /** An own property: `delete api.startCast` gives a Dramatis older than 1.2. */
    startCast?: (greeting: number) => DramatisStartMember[] = (greeting) =>
        (this.starts[greeting] ?? []).map((item) => ({ ...item }));
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(): void {
        for (const listener of [...this.listeners]) listener();
    }

    /* Dramatis 1.3 (after upgrade()): own properties, so `delete api.describe` gives a Dramatis without it. */
    /** Where the reading of the card stands (null: outside a solo chat). */
    intent: DramatisIntentState | null = { read: false, characters: 0, groups: 0, running: false };
    /** What readIntent answers; a successful reading marks the card read with its count. */
    readAnswer: DramatisReadOutcome = { ok: true, characters: 3, message: 'Замысел прочитан: 3 персонажа' };
    /** Holds readIntent until resolved (null: answers at once). */
    readGate: Promise<void> | null = null;
    readonly readCalls: ({ force?: boolean } | undefined)[] = [];
    /** Summaries by the exact name asked. */
    views: Record<string, DramatisCharacterView> = {};
    readonly described: string[] = [];
    readonly opened: (string | undefined)[] = [];
    intentState?: () => DramatisIntentState | null;
    readIntent?: (options?: { force?: boolean }) => Promise<DramatisReadOutcome>;
    describe?: (name: string) => DramatisCharacterView | null;
    openSheet?: (name?: string) => void;

    /** Turns the double into a Dramatis 1.3. */
    upgrade(): this {
        this.dramatisVersion = '1.3.0';
        this.intentState = () => (this.intent ? { ...this.intent } : null);
        this.readIntent = async (options) => {
            this.readCalls.push(options);
            if (this.readGate) await this.readGate;
            const answer = { ...this.readAnswer };
            if (answer.ok && !answer.skipped && this.intent) {
                this.intent = { ...this.intent, read: true, characters: answer.characters, at: 1 };
                this.emit();
            }
            return answer;
        };
        this.describe = (name) => {
            this.described.push(name);
            const view = this.views[name];
            return view ? (JSON.parse(JSON.stringify(view)) as DramatisCharacterView) : null;
        };
        this.openSheet = (name) => void this.opened.push(name);
        return this;
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
