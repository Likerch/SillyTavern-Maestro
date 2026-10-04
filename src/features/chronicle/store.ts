// M9 — the chat document 'chronicle' (plan §2.1, §4.8, §4.10): Qvink memories the chronicle follows (by message
// index, with send_date + memory hash as identity), the «remember» marks Maestro set with their reasons, and the
// stamp of the last «Ранее в истории…» (once per absence, across reloads and devices). Compare-and-swap with one
// retry, like every chat document; only the leader tab writes.
import { readTracked } from '../../domain/chronicle-chapters';
import type { TrackedMemory } from '../../domain/chronicle-chapters';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';

export const CHRONICLE_DOC = 'chronicle';
const PUT_ATTEMPTS = 2;

export const REASON_CODES = ['important', 'quest', 'relationship', 'oath', 'secret'] as const;
export type ReasonCode = (typeof REASON_CODES)[number];

export interface RememberReason {
    code: ReasonCode;
    /** Detail: the revision's reason, the quest or the pair whose relationship changed. */
    text?: string;
}

export interface RememberRecord {
    index: number;
    /** send_date of the message (identity). */
    date: string;
    reasons: RememberReason[];
    at: number;
}

export interface RecapStamp {
    /** When the recap was shown (the absence is measured from here too). */
    shownAt: number;
    source: 'memory' | 'ai';
    /** The text shown (the tab repeats it). */
    text?: string;
}

export interface ChronicleDoc {
    memories: Record<string, TrackedMemory>;
    remembered: RememberRecord[];
    recap: RecapStamp | null;
}

export function emptyChronicleDoc(): ChronicleDoc {
    return { memories: {}, remembered: [], recap: null };
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function isReasonCode(value: unknown): value is ReasonCode {
    return typeof value === 'string' && (REASON_CODES as readonly string[]).includes(value);
}

function readReasons(raw: unknown): RememberReason[] {
    if (!Array.isArray(raw)) return [];
    const out: RememberReason[] = [];
    for (const item of raw) {
        if (!isDict(item) || !isReasonCode(item.code)) continue;
        const reason: RememberReason = { code: item.code };
        if (typeof item.text === 'string' && item.text.trim()) reason.text = item.text.trim();
        out.push(reason);
    }
    return out;
}

function readRemembered(raw: unknown): RememberRecord[] {
    if (!Array.isArray(raw)) return [];
    const out: RememberRecord[] = [];
    for (const item of raw) {
        if (!isDict(item) || !Number.isInteger(item.index) || typeof item.date !== 'string') continue;
        out.push({
            index: item.index as number,
            date: item.date,
            reasons: readReasons(item.reasons),
            at: typeof item.at === 'number' ? item.at : 0,
        });
    }
    return out;
}

function readRecap(raw: unknown): RecapStamp | null {
    if (!isDict(raw) || typeof raw.shownAt !== 'number' || !Number.isFinite(raw.shownAt)) return null;
    const stamp: RecapStamp = { shownAt: raw.shownAt, source: raw.source === 'ai' ? 'ai' : 'memory' };
    if (typeof raw.text === 'string' && raw.text) stamp.text = raw.text;
    return stamp;
}

/** Repairs a stored document in place. */
export function readChronicleDoc(raw: Dict): ChronicleDoc {
    raw.memories = readTracked(raw.memories);
    raw.remembered = readRemembered(raw.remembered);
    raw.recap = readRecap(raw.recap);
    return raw as unknown as ChronicleDoc;
}

/** Adds reasons that are not there yet; true when something was added. */
export function mergeReasons(into: RememberReason[], more: readonly RememberReason[]): boolean {
    let added = false;
    for (const reason of more) {
        if (into.some((item) => item.code === reason.code && (item.text ?? '') === (reason.text ?? ''))) continue;
        into.push({ ...reason });
        added = true;
    }
    return added;
}

export class ChronicleStore {
    private doc: ChronicleDoc | null = null;
    private loading: Promise<ChronicleDoc | null> | null = null;
    private generation = 0;
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    install(): Unsubscribe[] {
        return [
            this.app.bus.on('chat:changed', () => {
                this.generation++;
                this.doc = null;
                this.loading = null;
                this.emit();
                void this.load();
            }),
            () => this.listeners.clear(),
        ];
    }

    /** Bumped on every chat switch: work started in another chat must not write here. */
    epoch(): number {
        return this.generation;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('chronicle listener failed', error);
            }
        }
    }

    /** The loaded document (null before the first load or without a chat). */
    peek(): ChronicleDoc | null {
        return this.doc;
    }

    load(): Promise<ChronicleDoc | null> {
        if (!this.app.host.chatId()) return Promise.resolve(null);
        if (this.doc) return Promise.resolve(this.doc);
        if (this.loading) return this.loading;
        const startedIn = this.generation;
        const loading = this.app.chat
            .get<Dict>(CHRONICLE_DOC, () => emptyChronicleDoc() as unknown as Dict)
            .then((raw) => {
                const doc = readChronicleDoc(raw);
                if (startedIn !== this.generation) return null;
                this.doc = doc;
                this.emit();
                return doc;
            })
            .catch((error: unknown) => {
                this.log.warn('the chronicle document could not be read', error);
                return null;
            })
            .finally(() => {
                if (this.loading === loading) this.loading = null;
            });
        this.loading = loading;
        return loading;
    }

    /**
     * Read-modify-write; on a version conflict the newer document is re-read and the change applied once more.
     * `change` returns false when there is nothing to write. Resolves true when the change was saved.
     */
    async mutate(change: (doc: ChronicleDoc) => boolean): Promise<boolean> {
        const startedIn = this.generation;
        for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
            if (startedIn !== this.generation || !this.app.host.chatId()) return false;
            let raw: Dict;
            try {
                raw = await this.app.chat.get<Dict>(CHRONICLE_DOC, () => emptyChronicleDoc() as unknown as Dict);
            } catch (error) {
                this.log.warn('the chronicle document could not be read', error);
                return false;
            }
            if (startedIn !== this.generation) return false;
            // A copy: a failed write must not leave the change in the chat store's cached document.
            const doc = readChronicleDoc(structuredClone(raw));
            if (!change(doc)) {
                this.doc = readChronicleDoc(raw);
                return false;
            }
            if (await this.app.chat.put(CHRONICLE_DOC, doc)) {
                if (startedIn === this.generation) {
                    this.doc = doc;
                    this.emit();
                }
                return true;
            }
        }
        this.log.warn(`the chronicle document could not be saved after ${PUT_ATTEMPTS} attempts`);
        return false;
    }
}
