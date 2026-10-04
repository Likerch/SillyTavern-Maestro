// M26 «Живой канон»: the per-chat document 'livingCanon' (plan §4.8: a Maestro file per chat) — drafts of uncommitted
// replies and the living facts. Every change is a read-modify-write on a fresh copy with the chat store's version
// check and one retry when another tab wrote first (plan §4.10); changes are serialised and a change started in one
// chat is dropped if the chat switches under it.
import { emptyLivingDoc, normalizeLivingDoc } from '../../domain/living-facts';
import type { LivingDocData } from '../../domain/living-facts';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';

export const LIVING_DOC_KIND = 'livingCanon';
const PUT_ATTEMPTS = 2;

export interface Change<R> {
    changed: boolean;
    result: R;
}

export class LivingStore {
    private doc: LivingDocData | null = null;
    private docChat: string | null = null;
    private loading: { chatId: string; promise: Promise<LivingDocData | null> } | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /** The loaded document of the open chat; null until loaded (or without a chat). Never edit it in place. */
    peek(): LivingDocData | null {
        const chatId = this.app.host.chatId();
        return chatId !== null && chatId === this.docChat ? this.doc : null;
    }

    /** Loads the open chat's document (cached until the chat changes). */
    load(): Promise<LivingDocData | null> {
        const chatId = this.app.host.chatId();
        if (!chatId) return Promise.resolve(null);
        const ready = this.peek();
        if (ready) return Promise.resolve(ready);
        if (this.loading?.chatId === chatId) return this.loading.promise;
        const promise = this.app.chat
            .get<object>(LIVING_DOC_KIND, emptyLivingDoc)
            .then((raw) => {
                if (this.app.host.chatId() !== chatId) return null;
                if (this.docChat !== chatId || !this.doc) {
                    this.doc = normalizeLivingDoc(raw);
                    this.docChat = chatId;
                    this.emit();
                }
                return this.doc;
            })
            .catch((error: unknown) => {
                this.log.warn('could not load the living canon of this chat', error);
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
    mutate<R>(change: (doc: LivingDocData) => Change<R>): Promise<R | undefined> {
        const job = async (): Promise<R | undefined> => {
            const chatId = this.app.host.chatId();
            if (!chatId) return undefined;
            for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
                const live = await this.app.chat.get<object>(LIVING_DOC_KIND, emptyLivingDoc);
                if (this.app.host.chatId() !== chatId) return undefined;
                const doc = normalizeLivingDoc(structuredClone(live));
                const outcome = change(doc);
                if (!outcome.changed) {
                    this.adopt(chatId, doc);
                    return outcome.result;
                }
                if (this.app.host.chatId() !== chatId) return undefined;
                if (await this.app.chat.put(LIVING_DOC_KIND, doc)) {
                    this.adopt(chatId, doc, true);
                    return outcome.result;
                }
                this.log.info('the living canon was changed in another tab; retrying on the fresh copy');
            }
            this.log.error('the living canon could not be saved');
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

    private adopt(chatId: string, doc: LivingDocData, changed = false): void {
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
                this.log.error('living canon listener failed', error);
            }
        }
    }
}
