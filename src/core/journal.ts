// Action journal with undo (plan §4.6): every change Maestro makes to user-visible data is recorded with
// "before" and "after"; undo handlers are registered per target type ('lorebook-entry', 'chat-flag', ...).
// Stored per chat (document kind 'journal'); kept for 30 days or 2000 records.
import type {
    ChatStore,
    Host,
    Journal,
    JournalAction,
    JournalRecord,
    Logger,
    UndoHandler,
    Unsubscribe,
} from '../shared/contracts';

export interface JournalDeps {
    host: Host;
    chat: ChatStore;
    log: Logger;
}

export interface JournalOptions {
    retentionMs?: number;
    maxRecords?: number;
}

export type JournalService = Journal & {
    /** Called after a record was undone (autonomy counts it as 'undone'). */
    onUndone(listener: (record: JournalRecord) => void): Unsubscribe;
    /** Called when the records of the current chat change or finish loading. */
    onChange(listener: () => void): Unsubscribe;
    /** Loads the current chat's journal (list() is synchronous and shows what is loaded). */
    load(): Promise<void>;
};

interface JournalDoc {
    records: JournalRecord[];
}

export const JOURNAL_KIND = 'journal';
const RETENTION_MS = 30 * 24 * 60 * 60_000;
const MAX_RECORDS = 2000;
const PUT_ATTEMPTS = 3;

function newId(): string {
    return `j-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** JSON copy: the journal is stored as JSON, so what is kept in memory must look the same. */
function jsonCopy<T>(value: T): T {
    const text = JSON.stringify(value);
    return text === undefined ? value : (JSON.parse(text) as T);
}

export function createJournal(deps: JournalDeps, options: JournalOptions = {}): JournalService {
    const { host, chat, log } = deps;
    const retentionMs = options.retentionMs ?? RETENTION_MS;
    const maxRecords = options.maxRecords ?? MAX_RECORDS;
    const handlers = new Map<string, UndoHandler>();
    const undoneListeners = new Set<(record: JournalRecord) => void>();
    const changeListeners = new Set<() => void>();
    const undoing = new Set<string>();
    /** Records made without a chat live only in memory. */
    const loose: JournalRecord[] = [];
    let loaded: { chatId: string; records: JournalRecord[] } | null = null;
    let loading: { chatId: string; promise: Promise<void> } | null = null;
    let chain: Promise<unknown> = Promise.resolve();

    const defaults = (): JournalDoc => ({ records: [] });

    const emitChange = () => {
        for (const listener of [...changeListeners]) {
            try {
                listener();
            } catch (error) {
                log.error('journal listener failed', error);
            }
        }
    };

    const trim = (records: JournalRecord[], now: number): void => {
        const cutoff = now - retentionMs;
        let drop = 0;
        while (drop < records.length && (records[drop]?.at ?? 0) < cutoff) drop++;
        if (records.length - drop > maxRecords) drop = records.length - maxRecords;
        if (drop > 0) records.splice(0, drop);
    };

    const needsTrim = (records: JournalRecord[], now: number): boolean =>
        records.length > maxRecords || (records[0]?.at ?? now) < now - retentionMs;

    const readDoc = async (chatId: string): Promise<JournalDoc> => {
        const doc = await chat.getFor<JournalDoc>(chatId, JOURNAL_KIND, defaults);
        if (!Array.isArray(doc.records)) doc.records = [];
        return doc;
    };

    /** Read-modify-write of one chat's journal with retries when another tab wrote first. */
    const mutate = (chatId: string, change: (records: JournalRecord[]) => boolean): Promise<boolean> => {
        const job = async () => {
            for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
                const doc = await readDoc(chatId);
                if (!change(doc.records)) return true;
                trim(doc.records, Date.now());
                if (await chat.put(JOURNAL_KIND, doc)) {
                    if (host.chatId() === chatId) {
                        loaded = { chatId, records: doc.records };
                        emitChange();
                    }
                    return true;
                }
            }
            log.error(`journal of this chat could not be saved after ${PUT_ATTEMPTS} attempts`);
            return false;
        };
        const next = chain.then(job, job);
        chain = next.catch(() => undefined);
        return next;
    };

    const load = (): Promise<void> => {
        const chatId = host.chatId();
        if (!chatId) {
            loaded = null;
            return Promise.resolve();
        }
        if (loaded?.chatId === chatId) return Promise.resolve();
        if (loading?.chatId === chatId) return loading.promise;
        const promise: Promise<void> = readDoc(chatId)
            .then((doc) => {
                if (host.chatId() !== chatId) return;
                loaded = { chatId, records: doc.records };
                emitChange();
                if (needsTrim(doc.records, Date.now())) void mutate(chatId, () => true);
            })
            .catch((error: unknown) => log.warn('could not load the journal', error))
            .finally(() => {
                if (loading?.promise === promise) loading = null;
            });
        loading = { chatId, promise };
        return promise;
    };

    const currentRecords = async (): Promise<JournalRecord[]> => {
        const chatId = host.chatId();
        if (!chatId) return loose;
        if (loaded?.chatId !== chatId) {
            const doc = await readDoc(chatId);
            return doc.records;
        }
        return loaded.records;
    };

    const markUndone = async (record: JournalRecord): Promise<void> => {
        if (!record.chatId) {
            record.undone = true;
            return;
        }
        await mutate(record.chatId, (records) => {
            const stored = records.find((item) => item.id === record.id);
            if (!stored || stored.undone) return false;
            stored.undone = true;
            return true;
        });
        record.undone = true;
    };

    const undo = async (id: string): Promise<boolean> => {
        if (undoing.has(id)) return false;
        const records = await currentRecords();
        const record = records.find((item) => item.id === id) ?? loose.find((item) => item.id === id);
        if (!record || record.undone) return false;
        const missing = record.changes.find((change) => !handlers.has(change.target));
        if (missing) {
            log.warn(`no undo handler for ${missing.target}; ${record.kind} cannot be undone`);
            return false;
        }
        undoing.add(id);
        try {
            for (const change of [...record.changes].reverse()) {
                const handler = handlers.get(change.target);
                let ok = false;
                try {
                    ok = handler ? await handler(change) : false;
                } catch (error) {
                    log.error(`undo handler for ${change.target} failed`, error);
                }
                if (!ok) {
                    log.warn(`undo of ${record.kind} stopped at ${change.target}`);
                    return false;
                }
            }
            await markUndone(record);
            const copy = jsonCopy(record);
            for (const listener of [...undoneListeners]) {
                try {
                    listener(copy);
                } catch (error) {
                    log.error('undo listener failed', error);
                }
            }
            return true;
        } finally {
            undoing.delete(id);
        }
    };

    const chatChanged = host.events.name('CHAT_CHANGED');
    if (chatChanged) {
        host.events.on(chatChanged, () => {
            loaded = null;
            emitChange();
            void load();
        });
    }

    return {
        async record(action: JournalAction): Promise<string> {
            const chatId = host.chatId();
            const record: JournalRecord = { ...jsonCopy(action), id: newId(), at: Date.now(), chatId };
            if (!chatId) {
                loose.push(record);
                trim(loose, record.at);
                return record.id;
            }
            await mutate(chatId, (records) => {
                records.push(record);
                return true;
            });
            return record.id;
        },

        undo,

        async undoForMessage(messageIndex: number): Promise<number> {
            const records = await currentRecords();
            // Records are appended in order: newest last. Undo newest first.
            const targets = records
                .filter((record) => record.sourceMessage === messageIndex && !record.undone)
                .reverse();
            let count = 0;
            for (const record of targets) {
                if (await undo(record.id)) count++;
            }
            return count;
        },

        list(filter?: { module?: string; limit?: number }): JournalRecord[] {
            const chatId = host.chatId();
            let records: JournalRecord[];
            if (!chatId) records = loose;
            else if (loaded?.chatId === chatId) records = loaded.records;
            else {
                void load();
                records = [];
            }
            let result = [...records].reverse();
            if (filter?.module) result = result.filter((record) => record.module === filter.module);
            if (filter?.limit !== undefined) result = result.slice(0, Math.max(0, filter.limit));
            return result.map((record) => ({ ...record }));
        },

        registerUndo(target: string, handler: UndoHandler): void {
            if (handlers.has(target)) log.debug(`undo handler for ${target} replaced`);
            handlers.set(target, handler);
        },

        onUndone(listener: (record: JournalRecord) => void): Unsubscribe {
            undoneListeners.add(listener);
            return () => undoneListeners.delete(listener);
        },

        onChange(listener: () => void): Unsubscribe {
            changeListeners.add(listener);
            return () => changeListeners.delete(listener);
        },

        load,
    };
}
