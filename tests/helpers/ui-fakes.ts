// In-memory fakes of the core services rendered by the UI core views.
import { vi } from 'vitest';
import type {
    Autonomy,
    AutonomyStats,
    CostMeter,
    CostSummary,
    Inbox,
    InboxCard,
    Journal,
    JournalRecord,
    MaestroModule,
    ModuleManager,
    TaskInfo,
    TaskQueue,
} from '../../src/shared/contracts';
import type { CoreViewDeps } from '../../src/ui';
import type { UiTestEnv } from './ui-env';

export function inboxCard(id: string, overrides: Partial<InboxCard> = {}): InboxCard {
    return {
        id,
        module: 'M8',
        kind: 'canon.fact',
        title: `Card ${id}`,
        changes: [
            {
                target: 'lorebook-entry',
                ref: { book: 'World', uid: 1 },
                before: 'Anna lives in Rome',
                after: 'Anna lives in Paris',
            },
        ],
        payload: {},
        createdAt: 1_700_000_000_000,
        ...overrides,
    };
}

export class FakeInbox implements Inbox {
    cards: InboxCard[] = [];
    readonly listeners = new Set<() => void>();
    readonly accepted: string[] = [];
    readonly rejected: string[] = [];
    readonly snoozed: { id: string; ms: number }[] = [];
    /** Ids whose accept() reports a stale card. */
    stale = new Set<string>();

    registerApplier(): () => void {
        return () => {};
    }
    async add(): Promise<string> {
        return 'new';
    }
    list(): InboxCard[] {
        return this.cards;
    }
    async accept(id: string): Promise<boolean> {
        if (this.stale.has(id)) return false;
        this.accepted.push(id);
        this.remove(id);
        return true;
    }
    async reject(id: string): Promise<void> {
        this.rejected.push(id);
        this.remove(id);
    }
    async snooze(id: string, ms: number): Promise<void> {
        this.snoozed.push({ id, ms });
        this.remove(id);
    }
    async invalidateMessage(): Promise<number> {
        return 0;
    }
    onChange(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    count(): number {
        return this.cards.length;
    }
    set(cards: InboxCard[]): void {
        this.cards = cards;
        this.changed();
    }
    changed(): void {
        for (const listener of [...this.listeners]) listener();
    }
    private remove(id: string): void {
        this.cards = this.cards.filter((card) => card.id !== id);
        this.changed();
    }
}

export class FakeJournal implements Journal {
    records: JournalRecord[] = [];
    readonly undone: string[] = [];
    async record(): Promise<string> {
        return 'r';
    }
    async undo(id: string): Promise<boolean> {
        const record = this.records.find((item) => item.id === id);
        if (!record || record.undone) return false;
        record.undone = true;
        this.undone.push(id);
        return true;
    }
    async undoForMessage(): Promise<number> {
        return 0;
    }
    list(filter?: { module?: string; limit?: number }): JournalRecord[] {
        return this.records
            .filter((record) => !filter?.module || record.module === filter.module)
            .slice(0, filter?.limit ?? Infinity);
    }
    registerUndo(): void {}
}

export function fakeAutonomy(stats: AutonomyStats[] = []): Autonomy {
    return {
        level: (_kind, fallback) => fallback,
        decide: async () => 'skipped',
        record: () => {},
        stats: () => stats,
        neverAuto: () => {},
    };
}

export function fakeCost(summary: Partial<CostSummary> = {}): CostMeter & { fire(): void } {
    const listeners = new Set<() => void>();
    return {
        record: () => {},
        recordAnlas: () => {},
        summary: () => ({ todayUsd: 0, todayBySource: {}, backgroundTodayUsd: 0, anlasToday: 0, ...summary }),
        backgroundCapReached: () => false,
        onChange: (listener) => {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        fire: () => {
            for (const listener of listeners) listener();
        },
    };
}

export function fakeModule(key: string, overrides: Partial<MaestroModule> = {}): MaestroModule {
    return {
        id: key.toUpperCase(),
        key,
        stage: 1,
        titleKey: `test.${key}`,
        enabledByDefault: true,
        defaults: () => ({}),
        init: () => {},
        ...overrides,
    };
}

export class FakeModules implements ModuleManager {
    readonly state = new Map<
        string,
        { module: MaestroModule; enabled: boolean; running: boolean; missing: string[] }
    >();
    enable = vi.fn(async (key: string) => {
        const entry = this.state.get(key);
        if (entry) Object.assign(entry, { enabled: true, running: true });
    });
    disable = vi.fn(async (key: string) => {
        const entry = this.state.get(key);
        if (entry) Object.assign(entry, { enabled: false, running: false });
    });
    constructor(modules: MaestroModule[] = []) {
        for (const module of modules) this.state.set(module.key, { module, enabled: true, running: true, missing: [] });
    }
    list(): { module: MaestroModule; enabled: boolean; running: boolean; missing: string[] }[] {
        return [...this.state.values()].map((entry) => ({ ...entry }));
    }
    api<T>(): T | undefined {
        return undefined;
    }
    expose(): void {}
}

export function fakeTasks(list: TaskInfo[] = []): TaskQueue & { kicks: number } {
    const queue = {
        kicks: 0,
        register: () => () => {},
        enqueue: async () => 'task',
        list: () => list,
        kick: () => {
            queue.kicks++;
        },
    };
    return queue;
}

export interface CoreFakes extends CoreViewDeps {
    inbox: FakeInbox;
    journal: FakeJournal;
    modules: FakeModules;
}

export function coreFakes(env: UiTestEnv, overrides: Partial<CoreFakes> = {}): CoreFakes {
    return {
        inbox: new FakeInbox(),
        journal: new FakeJournal(),
        autonomy: fakeAutonomy(),
        cost: fakeCost(),
        modules: new FakeModules(),
        settings: env.settings,
        caps: env.caps,
        tasks: fakeTasks(),
        i18n: env.i18n,
        ...overrides,
    };
}
