// The assistant's conversation per chat (M33): Maestro's per-chat document `assistant` (app.chat, versioned,
// compare-and-swap between tabs). Without an open chat the conversation lives in memory only. Tool records are kept
// compact: long arguments, card values and results are cut before they are stored — except the values of cards that
// ask to stay whole (preset block texts: the card's word diff and the user's decision need the whole text; the model
// never gets them back, its history carries only the summaries).
import { capText } from '../../domain/assistant-safety';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type {
    AssistantContextItem,
    AssistantMessage,
    ScopeOption,
    ToolCallItem,
    ToolCallRecord,
    ToolCallStatus,
} from './api';

export const ASSISTANT_DOC = 'assistant';
export const MAX_MESSAGES = 200;
/** Stored size of one tool result (the model got up to resultChars during the turn itself). */
export const STORED_RESULT_CHARS = 2000;
/** Stored size of a card value (before/after) and of a long string argument. */
export const STORED_VALUE_CHARS = 4000;
/** Stored size of a value of a card that keeps its values whole (WritePlan.full): a sanity cap only. */
export const STORED_FULL_VALUE_CHARS = 100_000;
/** The same for each change of a pack (a pack holds up to 20 of them; the conversation file stays reasonable). */
export const STORED_FULL_ITEM_CHARS = 20_000;
export const STORED_ARG_CHARS = 600;
/** Most changes a stored pack card keeps. */
export const MAX_STORED_ITEMS = 50;
const PUT_ATTEMPTS = 3;

export interface AssistantDoc {
    messages: AssistantMessage[];
    /** When changes were applied in this chat (rate limit; only the last hour matters). */
    writes: number[];
}

export function emptyAssistantDoc(): AssistantDoc {
    return { messages: [], writes: [] };
}

const STATUSES: readonly ToolCallStatus[] = ['running', 'ok', 'error', 'waiting', 'applied', 'declined'];
const ROLES: readonly AssistantMessage['role'][] = ['user', 'assistant', 'notice'];

function isRecord(value: unknown): value is Record<string, unknown> {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** Long strings inside arguments are cut (the conversation file must stay small). */
export function compactArgs(args: Record<string, unknown>): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
        if (typeof value === 'string') out[key] = capText(value, STORED_ARG_CHARS);
        else {
            const json = safeJson(value);
            out[key] = json.length > STORED_ARG_CHARS ? capText(json, STORED_ARG_CHARS) : value;
        }
    }
    return out;
}

/** A card value as stored: small JSON stays as it is, big values become a cut text (`max` characters). */
export function compactValue(value: unknown, max = STORED_VALUE_CHARS): unknown {
    if (value === undefined) return undefined;
    if (typeof value === 'string') return capText(value, max);
    const json = safeJson(value);
    return json.length > max ? capText(json, max) : value;
}

function safeJson(value: unknown): string {
    try {
        return JSON.stringify(value) ?? '';
    } catch {
        return String(value);
    }
}

function normalizeCall(raw: unknown, live: ReadonlySet<string>): ToolCallRecord | null {
    if (!isRecord(raw) || typeof raw['id'] !== 'string' || typeof raw['name'] !== 'string') return null;
    let status = STATUSES.includes(raw['status'] as ToolCallStatus) ? (raw['status'] as ToolCallStatus) : 'error';
    let error = typeof raw['error'] === 'string' ? raw['error'] : undefined;
    // Nothing survives a reload mid-call (the loop and the plan's closure are gone) — unless this tab's loop is
    // still on the call.
    const gone = !live.has(raw['id']);
    if (gone && status === 'running') {
        status = 'error';
        error ??= 'interrupted';
    } else if (gone && status === 'waiting') {
        status = 'declined';
    }
    const record: ToolCallRecord = {
        id: raw['id'],
        name: raw['name'],
        args: isRecord(raw['args']) ? raw['args'] : {},
        status,
    };
    if (typeof raw['summary'] === 'string') record.summary = raw['summary'];
    if (typeof raw['target'] === 'string') record.target = raw['target'];
    if ('before' in raw) record.before = raw['before'];
    if ('after' in raw) record.after = raw['after'];
    if (Array.isArray(raw['items'])) {
        const items = raw['items'].map(normalizeItem).filter((item): item is ToolCallItem => item !== null);
        if (items.length) record.items = items.slice(0, MAX_STORED_ITEMS);
    }
    if (typeof raw['scope'] === 'string') record.scope = raw['scope'];
    if (Array.isArray(raw['scopes'])) {
        const scopes = raw['scopes'].filter(
            (option): option is ScopeOption =>
                isRecord(option) && typeof option['value'] === 'string' && typeof option['label'] === 'string',
        );
        if (scopes.length) record.scopes = scopes.map((option) => ({ value: option.value, label: option.label }));
    }
    if (error !== undefined) record.error = error;
    if (typeof raw['result'] === 'string') record.result = raw['result'];
    if (raw['untrusted'] === true) record.untrusted = true;
    return record;
}

const ITEM_STATUSES: readonly NonNullable<ToolCallItem['status']>[] = ['applied', 'skipped', 'error'];

function normalizeItem(raw: unknown): ToolCallItem | null {
    if (!isRecord(raw) || typeof raw['id'] !== 'string' || typeof raw['summary'] !== 'string') return null;
    const item: ToolCallItem = { id: raw['id'], summary: raw['summary'] };
    if (typeof raw['target'] === 'string') item.target = raw['target'];
    if ('before' in raw) item.before = raw['before'];
    if ('after' in raw) item.after = raw['after'];
    if (ITEM_STATUSES.includes(raw['status'] as NonNullable<ToolCallItem['status']>)) {
        item.status = raw['status'] as NonNullable<ToolCallItem['status']>;
    }
    if (typeof raw['error'] === 'string') item.error = raw['error'];
    return item;
}

const CONTEXT_KINDS: readonly AssistantContextItem['kind'][] = ['preset', 'presetBlock'];

/** An attached item as stored (unknown shapes dropped). */
export function normalizeContext(raw: unknown): AssistantContextItem | null {
    if (!isRecord(raw) || !CONTEXT_KINDS.includes(raw['kind'] as AssistantContextItem['kind'])) return null;
    if (typeof raw['preset'] !== 'string' || !raw['preset'] || typeof raw['label'] !== 'string') return null;
    const item: AssistantContextItem = {
        kind: raw['kind'] as AssistantContextItem['kind'],
        preset: raw['preset'],
        label: raw['label'],
    };
    if (typeof raw['identifier'] === 'string' && raw['identifier']) item.identifier = raw['identifier'];
    if (item.kind === 'presetBlock' && !item.identifier) return null;
    return item;
}

function normalizeMessage(raw: unknown, live: ReadonlySet<string>): AssistantMessage | null {
    if (!isRecord(raw) || typeof raw['id'] !== 'string') return null;
    const role = raw['role'] as AssistantMessage['role'];
    if (!ROLES.includes(role)) return null;
    const message: AssistantMessage = {
        id: raw['id'],
        role,
        text: typeof raw['text'] === 'string' ? raw['text'] : '',
        at: typeof raw['at'] === 'number' ? raw['at'] : 0,
    };
    if (Array.isArray(raw['toolCalls'])) {
        const calls = raw['toolCalls']
            .map((call) => normalizeCall(call, live))
            .filter((call): call is ToolCallRecord => call !== null);
        if (calls.length) message.toolCalls = calls;
    }
    if (typeof raw['costUsd'] === 'number' && Number.isFinite(raw['costUsd'])) message.costUsd = raw['costUsd'];
    if (Array.isArray(raw['context'])) {
        const context = raw['context']
            .map(normalizeContext)
            .filter((item): item is AssistantContextItem => item !== null);
        if (context.length) message.context = context;
    }
    return message;
}

const NONE: ReadonlySet<string> = new Set();

/**
 * A stored document made safe to use: unknown shapes dropped, size capped, and calls left running or waiting by a
 * loop that is gone closed (`live`: ids this tab's loop is still working on).
 */
export function normalizeAssistantDoc(raw: unknown, live: ReadonlySet<string> = NONE): AssistantDoc {
    if (!isRecord(raw)) return emptyAssistantDoc();
    const messages = Array.isArray(raw['messages'])
        ? raw['messages']
              .map((message) => normalizeMessage(message, live))
              .filter((message): message is AssistantMessage => message !== null)
        : [];
    const writes = Array.isArray(raw['writes'])
        ? raw['writes'].filter((stamp): stamp is number => typeof stamp === 'number' && Number.isFinite(stamp))
        : [];
    return { messages: messages.slice(-MAX_MESSAGES), writes };
}

/**
 * Loads and changes the document of the current chat. Writes are serialised; a write that loses the race against
 * another tab re-reads and applies the change again.
 */
export class AssistantStore {
    private doc: AssistantDoc | null = null;
    private docChat: string | null = null;
    private memory: AssistantDoc = emptyAssistantDoc();
    private loading: Promise<AssistantDoc> | null = null;
    private queue: Promise<unknown> = Promise.resolve();
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        /** Calls this tab's loop is running or waiting on (kept open by the normalisation). */
        private readonly live: () => ReadonlySet<string> = () => NONE,
    ) {}

    /** The current chat's document as far as it is loaded (an empty one while loading). */
    current(): AssistantDoc {
        const chatId = this.app.host.chatId();
        if (!chatId) return this.memory;
        if (this.docChat === chatId && this.doc) return this.doc;
        void this.load().catch(() => undefined);
        return emptyAssistantDoc();
    }

    async load(): Promise<AssistantDoc> {
        const chatId = this.app.host.chatId();
        if (!chatId) return this.memory;
        if (this.docChat === chatId && this.doc) return this.doc;
        if (this.loading && this.docChat === chatId) return this.loading;
        this.docChat = chatId;
        this.doc = null;
        const loading = this.app.chat
            .get<AssistantDoc>(ASSISTANT_DOC, emptyAssistantDoc)
            .then((raw) => {
                const doc = this.adoptRaw(raw);
                if (this.app.host.chatId() === chatId && this.docChat === chatId) {
                    this.doc = doc;
                    this.emit();
                }
                return doc;
            })
            .finally(() => {
                if (this.loading === loading) this.loading = null;
            });
        this.loading = loading;
        return loading;
    }

    /** The chat changed: forget the cached document (the next read loads the new chat's). */
    reset(): void {
        this.doc = null;
        this.docChat = null;
        this.loading = null;
        this.emit();
        void this.load().catch((error: unknown) => this.log.warn('assistant conversation could not be loaded', error));
    }

    /**
     * Changes the document and saves it. `change` may run more than once (another tab wrote first, or the file
     * write failed) and must be idempotent. With `chatId` the change is dropped unless that chat is still open.
     */
    mutate(change: (doc: AssistantDoc) => void, chatId?: string | null): Promise<void> {
        const job = () => this.write(change, chatId);
        const next = this.queue.then(job, job);
        this.queue = next.catch(() => undefined);
        return next;
    }

    async clear(): Promise<void> {
        await this.mutate((doc) => {
            doc.messages.splice(0);
        });
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private async write(change: (doc: AssistantDoc) => void, expected?: string | null): Promise<void> {
        const chatId = this.app.host.chatId();
        if (expected !== undefined && expected !== chatId) {
            this.log.debug('assistant: the chat changed; conversation write dropped');
            return;
        }
        if (!chatId) {
            change(this.memory);
            trim(this.memory);
            this.emit();
            return;
        }
        for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
            const doc = this.adoptRaw(await this.app.chat.get<AssistantDoc>(ASSISTANT_DOC, emptyAssistantDoc));
            if (this.app.host.chatId() !== chatId) return;
            change(doc);
            trim(doc);
            // Shown at once; the file follows.
            this.doc = doc;
            this.docChat = chatId;
            this.emit();
            if (await this.app.chat.put(ASSISTANT_DOC, doc)) return;
        }
        this.log.warn(`assistant conversation could not be saved after ${PUT_ATTEMPTS} attempts`);
    }

    /** Normalises the chat store's object in place, so later puts write the same (cached) object back. */
    private adoptRaw(raw: AssistantDoc): AssistantDoc {
        const normal = normalizeAssistantDoc(raw, this.live());
        if (!isRecord(raw)) return normal;
        const target = raw as unknown as AssistantDoc;
        target.messages = normal.messages;
        target.writes = normal.writes;
        return target;
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('assistant listener failed', error);
            }
        }
    }
}

function trim(doc: AssistantDoc): void {
    if (doc.messages.length > MAX_MESSAGES) doc.messages.splice(0, doc.messages.length - MAX_MESSAGES);
    const cutoff = Date.now() - 3_600_000;
    if (doc.writes.some((stamp) => stamp <= cutoff)) doc.writes = doc.writes.filter((stamp) => stamp > cutoff);
}
