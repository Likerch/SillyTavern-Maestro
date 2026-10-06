// "Inbox" (plan §4.7, M8): proposals waiting for the user's decision. Cards are stored per chat (document
// kind 'inbox') as JSON; the live Proposal (with its closures) is kept in memory while the page lives, and
// after a reload the module's registered applier applies the stored payload. Before applying, the card is
// re-validated ("before" must still match the live data, plan §4.6, C6).
import type {
    Autonomy,
    Bus,
    ChatStore,
    InboxCard,
    Inbox,
    Journal,
    Logger,
    Proposal,
    Unsubscribe,
} from '../shared/contracts';

export interface InboxDeps {
    chat: ChatStore;
    journal: Journal;
    autonomy: Autonomy;
    bus: Bus;
    log: Logger;
}

export interface InboxOptions {
    defaultTtlMs?: number;
    cap?: number;
}

export type InboxService = Inbox & {
    /** Loads the current chat's cards (list() is synchronous and shows what is loaded). */
    load(): Promise<void>;
    dispose(): void;
};

export interface StoredCard extends InboxCard {
    /** Hidden from list() until this time. */
    snoozedUntil?: number;
}

interface InboxDoc {
    cards: StoredCard[];
}

interface Applier {
    apply: (payload: unknown) => Promise<void>;
    stillValid?: (payload: unknown) => Promise<boolean>;
    onReject?: (payload: unknown) => Promise<void>;
}

export const INBOX_KIND = 'inbox';
const DEFAULT_TTL_MS = 14 * 24 * 60 * 60_000;
const CAP = 200;
const PUT_ATTEMPTS = 3;
const SNOOZE_GRACE_MS = 24 * 60 * 60_000;

function newId(): string {
    return `in-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function jsonCopy<T>(value: T): T {
    const text = JSON.stringify(value);
    return text === undefined ? value : (JSON.parse(text) as T);
}

export function createInbox(deps: InboxDeps, options: InboxOptions = {}): InboxService {
    const { chat, journal, autonomy, bus, log } = deps;
    const defaultTtl = options.defaultTtlMs ?? DEFAULT_TTL_MS;
    const cap = options.cap ?? CAP;
    const appliers = new Map<string, Applier>();
    const live = new Map<string, Proposal>();
    const listeners = new Set<() => void>();
    const busy = new Set<string>();
    /** Cards of the current chat, null until loaded. */
    let cards: StoredCard[] | null = null;
    let loading: { generation: number; promise: Promise<void> } | null = null;
    /** Bumped on chat change: work started for the previous chat must not touch the new one. */
    let generation = 0;
    let chain: Promise<unknown> = Promise.resolve();

    const defaults = (): InboxDoc => ({ cards: [] });

    const emit = () => {
        for (const listener of [...listeners]) {
            try {
                listener();
            } catch (error) {
                log.error('inbox listener failed', error);
            }
        }
    };

    const expired = (card: StoredCard, now: number) => card.expiresAt !== undefined && card.expiresAt <= now;

    /** Drops expired cards, then the oldest non-deferred ones above the cap. Returns dropped ids. */
    const prune = (list: StoredCard[], now: number): string[] => {
        const dropped: string[] = [];
        for (let i = list.length - 1; i >= 0; i--) {
            const card = list[i];
            if (card && expired(card, now)) dropped.push(...list.splice(i, 1).map((item) => item.id));
        }
        while (list.length > cap) {
            const index = list.findIndex((card) => !card.deferred);
            const [removed] = list.splice(index >= 0 ? index : 0, 1);
            if (removed) dropped.push(removed.id);
        }
        for (const id of dropped) live.delete(id);
        return dropped;
    };

    /** Read-modify-write of the current chat's cards with retries when another tab wrote first. */
    const mutate = <R>(
        change: (list: StoredCard[], now: number) => { changed: boolean; result: R },
    ): Promise<R | undefined> => {
        const job = async (): Promise<R | undefined> => {
            const startedIn = generation;
            for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
                if (generation !== startedIn) {
                    log.warn('chat changed during an inbox update; the update was dropped');
                    return undefined;
                }
                const doc = await chat.get<InboxDoc>(INBOX_KIND, defaults);
                if (!Array.isArray(doc.cards)) doc.cards = [];
                const { changed, result } = change(doc.cards, Date.now());
                if (!changed) {
                    if (generation === startedIn) cards = doc.cards;
                    return result;
                }
                if (await chat.put(INBOX_KIND, doc)) {
                    if (generation === startedIn) {
                        cards = doc.cards;
                        emit();
                    }
                    return result;
                }
            }
            log.error(`inbox could not be saved after ${PUT_ATTEMPTS} attempts`);
            return undefined;
        };
        const next = chain.then(job, job);
        chain = next.catch(() => undefined);
        return next;
    };

    const load = (): Promise<void> => {
        if (loading && loading.generation === generation) return loading.promise;
        const startedIn = generation;
        const promise: Promise<void> = chat
            .get<InboxDoc>(INBOX_KIND, defaults)
            .then((doc) => {
                if (generation !== startedIn) return;
                if (!Array.isArray(doc.cards)) doc.cards = [];
                cards = doc.cards;
                emit();
                if (doc.cards.some((card) => expired(card, Date.now()))) {
                    void mutate((list, now) => ({ changed: prune(list, now).length > 0, result: undefined }));
                }
            })
            .catch((error: unknown) => log.warn('could not load the inbox', error))
            .finally(() => {
                if (loading?.promise === promise) loading = null;
            });
        loading = { generation: startedIn, promise };
        return promise;
    };

    const currentCards = async (): Promise<StoredCard[]> => {
        if (!cards) await load();
        return cards ?? [];
    };

    const removeCard = (id: string): Promise<StoredCard | undefined> =>
        mutate((list) => {
            const index = list.findIndex((card) => card.id === id);
            if (index < 0) return { changed: false, result: undefined };
            const [removed] = list.splice(index, 1);
            live.delete(id);
            return { changed: true, result: removed };
        });

    const invalidateMessage = async (messageIndex: number): Promise<number> => {
        const removed = await mutate((list) => {
            let count = 0;
            for (let i = list.length - 1; i >= 0; i--) {
                const card = list[i];
                if (card?.sourceMessage === messageIndex) {
                    list.splice(i, 1);
                    live.delete(card.id);
                    count++;
                }
            }
            return { changed: count > 0, result: count };
        });
        return removed ?? 0;
    };

    const unsubscribers: Unsubscribe[] = [
        bus.on('chat:changed', () => {
            generation++;
            cards = null;
            live.clear();
            emit();
            void load();
        }),
        bus.on('message:invalidated', ({ messageIndex }) => {
            void invalidateMessage(messageIndex);
        }),
    ];

    const visible = (): StoredCard[] => {
        if (!cards) {
            void load();
            return [];
        }
        const now = Date.now();
        return cards.filter(
            (card) => !expired(card, now) && !(card.snoozedUntil !== undefined && card.snoozedUntil > now),
        );
    };

    return {
        registerApplier(
            kind: string,
            apply: (payload: unknown) => Promise<void>,
            stillValid?: (payload: unknown) => Promise<boolean>,
            onReject?: (payload: unknown) => Promise<void>,
        ): Unsubscribe {
            const entry: Applier = { apply, stillValid, onReject };
            appliers.set(kind, entry);
            return () => {
                if (appliers.get(kind) === entry) appliers.delete(kind);
            };
        },

        async add(proposal: Proposal, addOptions?: { deferred?: boolean; ttlMs?: number }): Promise<string> {
            const now = Date.now();
            const card: StoredCard = {
                id: newId(),
                module: proposal.module,
                kind: proposal.kind,
                title: proposal.title,
                description: proposal.description,
                changes: jsonCopy(proposal.changes),
                payload: jsonCopy(proposal.payload),
                createdAt: now,
                sourceMessage: proposal.sourceMessage,
                expiresAt: now + (addOptions?.ttlMs ?? defaultTtl),
            };
            if (addOptions?.deferred) card.deferred = true;
            if (typeof proposal.acceptLabel === 'string' && proposal.acceptLabel.trim()) {
                card.acceptLabel = proposal.acceptLabel.trim();
            }
            if (typeof proposal.rejectLabel === 'string' && proposal.rejectLabel.trim()) {
                card.rejectLabel = proposal.rejectLabel.trim();
            }
            live.set(card.id, proposal);
            const saved = await mutate((list, at) => {
                list.push(card);
                prune(list, at);
                return { changed: true, result: true };
            });
            if (!saved) live.delete(card.id);
            return card.id;
        },

        list(): InboxCard[] {
            return visible().map((card) => ({ ...card }));
        },

        async accept(id: string, edited?: unknown): Promise<boolean> {
            if (busy.has(id)) return false;
            busy.add(id);
            try {
                const card = (await currentCards()).find((item) => item.id === id);
                if (!card) return false;
                const proposal = live.get(id);
                const applier = appliers.get(card.kind);
                const payload = edited !== undefined ? edited : proposal ? proposal.payload : card.payload;
                let valid = true;
                try {
                    if (proposal?.stillValid) valid = await proposal.stillValid();
                    else if (applier?.stillValid) valid = await applier.stillValid(payload);
                } catch (error) {
                    log.warn(`${card.kind}: validation failed`, error);
                    valid = false;
                }
                if (!valid) {
                    log.info(`${card.kind}: card is out of date; dropped`);
                    await removeCard(id);
                    return false;
                }
                const apply = proposal ? (value: unknown) => proposal.apply(value) : applier?.apply;
                if (!apply) {
                    log.warn(`${card.kind}: nothing can apply this card yet (module off?); kept`);
                    return false;
                }
                try {
                    await apply(payload);
                } catch (error) {
                    log.error(`${card.kind}: apply failed`, error);
                    return false;
                }
                await removeCard(id);
                try {
                    await journal.record({
                        module: card.module,
                        kind: card.kind,
                        summary: card.title,
                        changes: card.changes,
                        sourceMessage: card.sourceMessage,
                    });
                } catch (error) {
                    log.error(`${card.kind}: applied but not journaled`, error);
                }
                autonomy.record(card.kind, edited !== undefined ? 'edited' : 'accepted');
                return true;
            } finally {
                busy.delete(id);
            }
        },

        async reject(id: string): Promise<void> {
            const removed = await removeCard(id);
            if (!removed) return;
            autonomy.record(removed.kind, 'rejected');
            try {
                await appliers.get(removed.kind)?.onReject?.(removed.payload);
            } catch (error) {
                log.warn(`${removed.kind}: reject handler failed`, error);
            }
        },

        async snooze(id: string, ms: number): Promise<void> {
            await mutate((list, now) => {
                const card = list.find((item) => item.id === id);
                if (!card) return { changed: false, result: undefined };
                card.snoozedUntil = now + Math.max(0, ms);
                card.expiresAt = Math.max(card.expiresAt ?? 0, card.snoozedUntil + SNOOZE_GRACE_MS);
                return { changed: true, result: undefined };
            });
        },

        invalidateMessage,

        onChange(listener: () => void): Unsubscribe {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },

        count(): number {
            return visible().filter((card) => !card.deferred).length;
        },

        load,

        dispose(): void {
            for (const unsubscribe of unsubscribers.splice(0)) unsubscribe();
            listeners.clear();
        },
    };
}
