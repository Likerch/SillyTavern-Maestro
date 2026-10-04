// A test App for M21: the lore test app plus a fake core cost meter (today's entries, Anlas, change and limit
// listeners), core settings, a memory file store, a journal with undo handlers, notices, a fake M12 API and a fake
// NAI Studio adapter with imageReady, all driven by hand.
import { makeFileName } from '../../../src/core/files';
import { dayKey } from '../../../src/domain/treasurer-spend';
import { M21_STRINGS, TreasurerService, defaultTreasurerSettings } from '../../../src/features/treasurer';
import type { TreasurerDeps, TreasurerSettings } from '../../../src/features/treasurer';
import type { QualityVerdict } from '../../../src/features/quality/api';
import type { NaiImageReadyDetail } from '../../../src/adapters/nai';
import type {
    App,
    CoreSettings,
    CostEntry,
    FileStore,
    JournalAction,
    UndoHandler,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { createLoreApp } from '../../helpers/lore-app';
import type { LoreTestApp } from '../../helpers/lore-app';

export type Entry = CostEntry & { anlas?: number };
type LimitInfo = { usd: number; limit: number; action: CoreSettings['dailyLimit']['action'] };

export const wait = (ms = 5) => new Promise((resolve) => setTimeout(resolve, ms));

export interface TreasurerStand {
    stand: LoreTestApp;
    app: App;
    wall: { value: number };
    recent: Entry[];
    costListeners: Set<() => void>;
    limitListeners: Set<(info: LimitInfo) => void>;
    limitReached: { value: boolean };
    files: Map<string, unknown>;
    core: CoreSettings;
    notices: { text: string; options?: Parameters<App['ui']['notice']>[1] }[];
    journal: JournalAction[];
    undo: Map<string, UndoHandler>;
    naiListeners: Set<(detail: NaiImageReadyDetail) => void>;
    naiApi: { value: unknown };
    verdictListeners: Set<(verdict: QualityVerdict) => void>;
    opened: string[];
    settingsNotified: string[];
    /** The core meter records an entry now (at = wall clock, chatId = current chat). */
    record(entry: Partial<Entry> & { source: Entry['source'] }): Entry;
    costChanged(): void;
    makeService(
        deps?: TreasurerDeps,
        settings?: TreasurerSettings,
    ): { service: TreasurerService; settings: TreasurerSettings; stop(): void };
    /** generation:before as the turn pipeline emits it. */
    begin(type?: string, quiet?: boolean): Promise<void>;
    /** The reply at `index` is rendered (pushes it into the chat when given). */
    reply(index: number, message?: STChatMessage): Promise<void>;
    ended(): Promise<void>;
    imageReady(messageIndex: number, kind: NaiImageReadyDetail['kind']): void;
    verdict(messageIndex: number, action: QualityVerdict['action']): void;
}

export function chatMessage(text: string, patch: Partial<STChatMessage> = {}): STChatMessage {
    return { name: 'Char', is_user: false, is_system: false, send_date: '', mes: text, extra: {}, ...patch };
}

export function userMessage(text: string): STChatMessage {
    return chatMessage(text, { name: 'User', is_user: true });
}

export function createTreasurerStand(): TreasurerStand {
    const stand = createLoreApp();
    const app = stand.app;
    app.i18n.register(M21_STRINGS);
    const files = new Map<string, unknown>();
    const core: CoreSettings = {
        schemaVersion: 1,
        mode: 'balanced',
        debug: false,
        uiLanguage: 'auto',
        profiles: {},
        backgroundDailyCapUsd: 0.5,
        dailyLimit: { enabled: false, usd: 0, action: 'warn' },
        autonomy: {},
        modules: {},
        firstRunDone: true,
    };
    const env: TreasurerStand = {
        stand,
        app,
        wall: { value: new Date(2026, 9, 4, 12, 0, 0).getTime() },
        recent: [],
        costListeners: new Set(),
        limitListeners: new Set(),
        limitReached: { value: false },
        files,
        core,
        notices: [],
        journal: [],
        undo: new Map(),
        naiListeners: new Set(),
        naiApi: { value: { version: 1 } },
        verdictListeners: new Set(),
        opened: [],
        settingsNotified: [],
        record(patch) {
            const entry = { usd: 0, at: env.wall.value, chatId: app.host.chatId(), ...patch } as Entry;
            env.recent.push(entry);
            env.costChanged();
            return entry;
        },
        costChanged() {
            for (const listener of [...env.costListeners]) listener();
        },
        makeService(deps = {}, settings = defaultTreasurerSettings()) {
            const service = new TreasurerService(app, settings, app.log, {
                now: () => env.wall.value,
                ingestDelayMs: 60_000,
                saveDelayMs: 60_000,
                daysSaveDelayMs: 60_000,
                graceMs: 100,
                ...deps,
            });
            const disposers: Unsubscribe[] = [];
            service.install((dispose) => disposers.push(dispose));
            return {
                service,
                settings,
                stop() {
                    for (const dispose of disposers.splice(0).reverse()) dispose();
                },
            };
        },
        async begin(type = 'normal', quiet = false) {
            await app.bus.emit('generation:before', { type, dryRun: false, quiet });
        },
        async reply(index, message) {
            if (message) stand.mock.chat[index] = message;
            await app.bus.emit('reply:ready', { messageIndex: index, type: 'normal' });
        },
        async ended() {
            await app.bus.emit('generation:ended', { type: 'normal', stopped: false });
        },
        imageReady(messageIndex, kind) {
            for (const listener of [...env.naiListeners]) listener({ messageIndex, kind, passportIds: [] });
        },
        verdict(messageIndex, action) {
            const verdict: QualityVerdict = {
                messageIndex,
                swipeId: 0,
                ok: action === 'none',
                defects: [],
                judged: false,
                action,
                costUsd: 0,
                at: env.wall.value,
            };
            for (const listener of [...env.verdictListeners]) listener(verdict);
        },
    };

    const totals = () => {
        const date = dayKey(env.wall.value);
        const today = env.recent.filter((entry) => dayKey(entry.at) === date);
        const bySource: Record<string, number> = {};
        const byTask: Record<string, number> = {};
        let totalUsd = 0;
        let anlas = 0;
        for (const entry of today) {
            if (entry.anlas !== undefined) {
                anlas += entry.anlas;
                continue;
            }
            totalUsd += entry.usd;
            bySource[entry.source] = (bySource[entry.source] ?? 0) + entry.usd;
            if (entry.task) byTask[entry.task] = (byTask[entry.task] ?? 0) + entry.usd;
        }
        return { date, totalUsd, bySource, byTask, anlas, recent: today };
    };

    app.cost = {
        record(entry: Omit<CostEntry, 'at'>) {
            env.record(entry);
        },
        recordAnlas(amount: number) {
            env.record({ source: 'nai', usd: 0, anlas: amount });
        },
        summary: () => {
            const day = totals();
            return {
                todayUsd: day.totalUsd,
                todayBySource: day.bySource,
                backgroundTodayUsd: day.bySource.maestro ?? 0,
                anlasToday: day.anlas,
            };
        },
        backgroundCapReached: () => (totals().bySource.maestro ?? 0) >= core.backgroundDailyCapUsd,
        recent: () => env.recent.slice(),
        onChange(listener: () => void) {
            env.costListeners.add(listener);
            return () => env.costListeners.delete(listener);
        },
        onLimitReached(listener: (info: LimitInfo) => void) {
            env.limitListeners.add(listener);
            return () => env.limitListeners.delete(listener);
        },
        today: () => totals(),
        dailyLimitReached: () => env.limitReached.value,
    } as unknown as App['cost'];

    const settingsService = app.settings as unknown as Record<string, unknown>;
    settingsService.core = () => core;
    settingsService.notify = (path: string) => {
        env.settingsNotified.push(path);
    };

    app.files = {
        read: async <T>(name: string) => (files.has(name) ? (structuredClone(files.get(name)) as T) : null),
        write: async (name, data) => {
            files.set(name, structuredClone(data));
        },
        remove: async (name) => {
            files.delete(name);
        },
        fileName: (kind, key) => makeFileName(kind, key),
    } satisfies FileStore;

    app.journal = {
        record: async (action: JournalAction) => {
            env.journal.push(action);
            return `j${env.journal.length}`;
        },
        registerUndo: (target: string, handler: UndoHandler) => {
            env.undo.set(target, handler);
        },
    } as unknown as App['journal'];

    app.ui.notice = (text, options) => {
        env.notices.push({ text, options });
    };
    app.ui.openPult = (tabId?: string) => {
        env.opened.push(tabId ?? '');
    };

    (app.adapters as unknown as Record<string, unknown>).nai = {
        present: () => true,
        api: () => env.naiApi.value,
        on(event: string, listener: (detail: NaiImageReadyDetail) => void) {
            if (event !== 'imageReady') return () => {};
            env.naiListeners.add(listener);
            return () => env.naiListeners.delete(listener);
        },
    };
    app.modules.expose('quality', {
        onVerdict(listener: (verdict: QualityVerdict) => void) {
            env.verdictListeners.add(listener);
            return () => env.verdictListeners.delete(listener);
        },
    });
    return env;
}
