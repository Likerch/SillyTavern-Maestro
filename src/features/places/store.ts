// M24 «Места»: the per-chat document 'places' (plan §2.1, §4.8: a Maestro file per chat). Every change is a
// read-modify-write on a fresh copy with the chat store's version check and one retry when another tab wrote first
// (plan §4.10). Changes are serialised; a change started in one chat is dropped if the chat switches under it.
import { emptyPlacesDoc, normalizePlacesDoc } from '../../domain/places-registry';
import type { PlacesDocData } from '../../domain/places-registry';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';

export const PLACES_KIND = 'places';
const PUT_ATTEMPTS = 2;

export interface Change<R> {
    changed: boolean;
    result: R;
}

export class PlacesStore {
    private doc: PlacesDocData | null = null;
    private docChat: string | null = null;
    private loading: { chatId: string; promise: Promise<PlacesDocData | null> } | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /** The loaded document of the open chat; null until loaded (or without a chat). Never edit it in place. */
    peek(): PlacesDocData | null {
        const chatId = this.app.host.chatId();
        return chatId !== null && chatId === this.docChat ? this.doc : null;
    }

    /** Loads the open chat's document (cached until the chat changes). */
    load(): Promise<PlacesDocData | null> {
        const chatId = this.app.host.chatId();
        if (!chatId) return Promise.resolve(null);
        const ready = this.peek();
        if (ready) return Promise.resolve(ready);
        if (this.loading?.chatId === chatId) return this.loading.promise;
        const promise = this.app.chat
            .get<object>(PLACES_KIND, emptyPlacesDoc)
            .then((raw) => {
                if (this.app.host.chatId() !== chatId) return null;
                if (this.docChat !== chatId || !this.doc) {
                    this.doc = normalizePlacesDoc(raw);
                    this.docChat = chatId;
                    this.emit();
                }
                return this.doc;
            })
            .catch((error: unknown) => {
                this.log.warn('could not load the places of this chat', error);
                return null;
            })
            .finally(() => {
                if (this.loading?.promise === promise) this.loading = null;
            });
        this.loading = { chatId, promise };
        return promise;
    }

    /** Forgets the loaded document (chat switch). */
    reset(): void {
        this.doc = null;
        this.docChat = null;
        this.loading = null;
        this.emit();
    }

    /**
     * Applies `change` to a fresh copy of the open chat's document and saves it when it says it changed. Errors thrown
     * by `change` reach the caller. Resolves undefined when there is no chat, the chat switched, or saving failed twice.
     */
    mutate<R>(change: (doc: PlacesDocData) => Change<R>): Promise<R | undefined> {
        const job = async (): Promise<R | undefined> => {
            const chatId = this.app.host.chatId();
            if (!chatId) return undefined;
            for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
                const live = await this.app.chat.get<object>(PLACES_KIND, emptyPlacesDoc);
                if (this.app.host.chatId() !== chatId) return undefined;
                const doc = normalizePlacesDoc(live);
                const outcome = change(doc);
                if (!outcome.changed) {
                    this.adopt(chatId, doc);
                    return outcome.result;
                }
                // Checked right before put(): it writes to the chat open at call time for a copy it has not seen.
                if (this.app.host.chatId() !== chatId) return undefined;
                if (await this.app.chat.put(PLACES_KIND, doc)) {
                    this.adopt(chatId, doc, true);
                    return outcome.result;
                }
                this.log.info('places were changed in another tab; retrying on the fresh copy');
            }
            this.log.error('places could not be saved');
            return undefined;
        };
        const next = this.chain.then(job, job);
        this.chain = next.catch(() => undefined);
        return next;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private adopt(chatId: string, doc: PlacesDocData, changed = false): void {
        if (this.app.host.chatId() !== chatId) return;
        const fresh = this.docChat !== chatId || !this.doc;
        this.doc = doc;
        this.docChat = chatId;
        if (changed || fresh) this.emit();
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('places listener failed', error);
            }
        }
    }
}
