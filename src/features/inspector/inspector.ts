// M2 «Инспектор хода»: what the prompt of each real turn was made of (plan M2, audit T15).
//
// Send path (cheap): CHAT_COMPLETION_PROMPT_READY with dryRun === false right after Maestro's interceptor marked a
// real generation → keep a reference to the final messages, copy the Prompt Manager counts by identifier, the
// extension prompt slots and the preset prompts injected at a depth. After `reply:ready`: token counts of the
// slots, M1's lore of the same turn, reconstruction, storage in the chat document 'inspector'.
import { adaptersOf } from '../../adapters';
import { stableHash } from '../../domain/hash';
import {
    SLOT_POSITION,
    charsByRole,
    loreMeasures,
    messageText,
    promptIdentifierOf,
    pushTurn,
    reconstructSources,
} from '../../domain/lore-inspector';
import type { LoreMeasure, SlotMeasure } from '../../domain/lore-inspector';
import type { App, GenerationInfo, Logger, Unsubscribe } from '../../shared/contracts';
import type { LoreContent, LoreJournalApi, TurnLoreRecord } from '../loreJournal/api';
import type { InspectorApi, InspectorRecord } from './api';

export interface InspectorSettings {
    keepTurns: number;
}

export const INSPECTOR_DOC_KIND = 'inspector';
/** How long finalisation waits for M1's record of the same turn. */
const LORE_WAIT_MS = 5000;
/** A reply this long after the generation ended is not the one the captured prompt belongs to. */
const REPLY_GRACE_MS = 60 * 1000;
const NOT_A_TURN = new Set(['quiet', 'impersonate']);
const TOKEN_CACHE_LIMIT = 2000;

interface InspectorDoc {
    v: 1;
    records: InspectorRecord[];
}

export interface SlotSnapshot {
    key: string;
    value: string;
    position: number;
    depth: number;
    role: number;
}

/** What PROMPT_READY gave us; kept in memory for the last turn only (repeats, export). */
export interface PromptCapture {
    at: number;
    chatId: string | null;
    type: string;
    /** The final Chat Completion messages (ST's array; read-only). */
    messages: unknown[];
    counts: Record<string, number> | null;
    slots: SlotSnapshot[];
    absolute: { identifier: string; name: string; content: string }[];
}

export interface InspectorTurnDetails {
    record: InspectorRecord;
    capture: PromptCapture;
    lore: LoreContent[];
    loreRecord?: TurnLoreRecord;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

interface PromptLike {
    identifier?: unknown;
    name?: unknown;
    content?: unknown;
    marker?: unknown;
    injection_position?: unknown;
}

interface PromptManagerLike {
    activeCharacter?: unknown;
    tokenHandler?: { getCounts?: () => unknown };
    getPromptOrderForCharacter?: (character: unknown) => unknown;
    getPromptById?: (identifier: string) => PromptLike | null | undefined;
}

/** Prompt Manager's "absolute" injection position (PromptManager.js INJECTION_POSITION). */
const ABSOLUTE = 1;

function emptyDoc(): InspectorDoc {
    return { v: 1, records: [] };
}

function ensureDoc(doc: object): InspectorDoc {
    const raw = doc as Dict;
    raw.v = 1;
    if (!Array.isArray(raw.records)) raw.records = [];
    raw.records = (raw.records as unknown[]).filter(
        (record): record is InspectorRecord =>
            isDict(record) && typeof record.messageIndex === 'number' && Array.isArray(record.sources),
    );
    return raw as unknown as InspectorDoc;
}

export class Inspector implements InspectorApi {
    /** Set by a real generation; the next non-dry PROMPT_READY is its prompt. */
    private awaiting: { type: string } | null = null;
    private pending: PromptCapture | null = null;
    private pendingEndedAt: number | null = null;
    private details: (InspectorTurnDetails & { chatId: string | null }) | null = null;
    private view: { chatId: string; doc: InspectorDoc } | null = null;
    private loading: Promise<void> | null = null;
    private openai: Dict | null = null;
    private readonly listeners = new Set<(record: InspectorRecord) => void>();
    private readonly tokenCache = new Map<string, number>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly settings: InspectorSettings,
        private readonly log: Logger,
    ) {}

    install(own: (dispose: Unsubscribe) => void): void {
        const { host, bus } = this.app;
        const on = (key: string, handler: (...args: unknown[]) => unknown): void => {
            const name = host.events.name(key);
            if (!name) {
                this.log.warn(`ST event ${key} is missing; the inspector cannot see it`);
                return;
            }
            own(host.events.on(name, handler));
        };
        on('CHAT_COMPLETION_PROMPT_READY', (data) => this.onPromptReady(data));
        on('GENERATION_STARTED', (type, _params, dryRun) => this.onGenerationStarted(type, dryRun));
        own(bus.on('generation:before', (info) => this.onGenerationBefore(info)));
        own(
            bus.on('generation:ended', () => {
                if (this.pending) this.pendingEndedAt ??= Date.now();
            }),
        );
        own(
            bus.on('reply:ready', ({ messageIndex }) => {
                this.onReplyReady(messageIndex);
            }),
        );
        own(
            bus.on('chat:changed', () => {
                this.awaiting = null;
                this.pending = null;
                this.details = null;
                this.view = null;
                void this.ensureLoaded();
            }),
        );
        own(
            bus.on('message:invalidated', ({ reason }) => {
                if (reason === 'deleted') void this.onDeleted();
            }),
        );
        own(() => {
            this.disposed = true;
            this.listeners.clear();
            this.pending = null;
            this.awaiting = null;
        });
        void this.prefetchOpenAi();
        void this.ensureLoaded();
    }

    /** openai.js is needed synchronously inside PROMPT_READY: import it ahead of time. */
    private async prefetchOpenAi(): Promise<void> {
        if (!this.app.host.caps.has('st.oai.promptManager')) return;
        try {
            this.openai = await this.app.host.modules.openai();
        } catch (error) {
            this.log.debug('openai.js is not available; token counts will be estimated', error);
        }
    }

    /* ---------------------------------------------------------------- send path */

    private onGenerationStarted(type: unknown, dryRun: unknown): void {
        const kind = typeof type === 'string' && type ? type : 'normal';
        this.awaiting = dryRun === true || NOT_A_TURN.has(kind) ? null : { type: kind };
    }

    private onGenerationBefore(info: GenerationInfo): void {
        if (info.quiet || info.dryRun || NOT_A_TURN.has(info.type)) return;
        this.awaiting = { type: info.type };
    }

    private onPromptReady(data: unknown): void {
        if (!isDict(data) || data.dryRun !== false || !this.awaiting) return;
        const { type } = this.awaiting;
        this.awaiting = null;
        this.pendingEndedAt = null;
        this.pending = {
            at: Date.now(),
            chatId: this.app.host.chatId(),
            type,
            messages: Array.isArray(data.chat) ? data.chat : [],
            counts: this.snapshotCounts(),
            slots: this.snapshotSlots(),
            absolute: this.absolutePrompts(),
        };
    }

    private promptManager(): PromptManagerLike | null {
        if (!this.app.host.caps.has('st.oai.promptManager')) return null;
        const pm = this.openai?.promptManager;
        return isDict(pm) ? (pm as PromptManagerLike) : null;
    }

    private snapshotCounts(): Record<string, number> | null {
        try {
            const counts = this.promptManager()?.tokenHandler?.getCounts?.();
            if (!isDict(counts)) return null;
            const copy: Record<string, number> = {};
            for (const [identifier, value] of Object.entries(counts)) {
                if (typeof value === 'number' && Number.isFinite(value)) copy[identifier] = value;
            }
            return copy;
        } catch (error) {
            this.log.debug('Prompt Manager counts', error);
            return null;
        }
    }

    private snapshotSlots(): SlotSnapshot[] {
        const prompts = this.app.host.ctx().extensionPrompts ?? {};
        const slots: SlotSnapshot[] = [];
        for (const [key, prompt] of Object.entries(prompts)) {
            if (!prompt || typeof prompt.value !== 'string' || !prompt.value) continue;
            slots.push({
                key,
                value: prompt.value,
                position: Number(prompt.position),
                depth: Number(prompt.depth) || 0,
                role: Number(prompt.role) || 0,
            });
        }
        return slots;
    }

    /** Enabled preset prompts with the "absolute" position: ST injects them into the chat history. */
    private absolutePrompts(): PromptCapture['absolute'] {
        const pm = this.promptManager();
        if (!pm || typeof pm.getPromptOrderForCharacter !== 'function' || typeof pm.getPromptById !== 'function') {
            return [];
        }
        try {
            const order = pm.getPromptOrderForCharacter(pm.activeCharacter);
            if (!Array.isArray(order)) return [];
            const result: PromptCapture['absolute'] = [];
            for (const item of order) {
                if (!isDict(item) || item.enabled === false || typeof item.identifier !== 'string') continue;
                const prompt = pm.getPromptById(item.identifier);
                if (!prompt || prompt.marker === true || Number(prompt.injection_position) !== ABSOLUTE) continue;
                if (typeof prompt.content !== 'string' || !prompt.content) continue;
                result.push({
                    identifier: item.identifier,
                    name: typeof prompt.name === 'string' ? prompt.name : item.identifier,
                    content: prompt.content,
                });
            }
            return result;
        } catch (error) {
            this.log.debug('Prompt Manager order', error);
            return [];
        }
    }

    private onReplyReady(messageIndex: number): void {
        const capture = this.pending;
        if (!capture) return;
        const endedAt = this.pendingEndedAt;
        this.pending = null;
        this.pendingEndedAt = null;
        if (endedAt !== null && Date.now() - endedAt > REPLY_GRACE_MS) return;
        void this.finalize(capture, messageIndex).catch((error: unknown) =>
            this.log.warn('could not inspect the prompt of this turn', error),
        );
    }

    private async onDeleted(): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId) return;
        const length = this.app.host.ctx().chat.length;
        await this.updateDoc(chatId, (doc) => {
            doc.records = doc.records.filter((record) => record.messageIndex < length);
        });
        if (this.details && this.details.record.messageIndex >= length) this.details = null;
    }

    /* ---------------------------------------------------------------- after the reply */

    private async finalize(capture: PromptCapture, messageIndex: number): Promise<InspectorRecord> {
        const exact = capture.counts !== null;
        const slots: SlotMeasure[] = [];
        for (const slot of capture.slots) {
            if (slot.position === SLOT_POSITION.NONE) continue;
            const counted = capture.counts?.[promptIdentifierOf(slot.key)];
            const tokens =
                slot.position !== SLOT_POSITION.IN_CHAT && exact ? (counted ?? 0) : await this.tokensOf(slot.value);
            slots.push({ key: slot.key, position: slot.position, tokens });
        }
        const substitute = this.substitute();
        const absolute: { identifier: string; name: string; tokens: number }[] = [];
        for (const prompt of capture.absolute) {
            absolute.push({
                identifier: prompt.identifier,
                name: prompt.name,
                tokens: await this.tokensOf(substitute(prompt.content)),
            });
        }
        let messageTokens: number | undefined;
        if (!exact) {
            messageTokens = 0;
            for (const message of capture.messages) messageTokens += await this.tokensOf(messageText(message));
        }
        const loreRecord = await this.loreFor(messageIndex, capture.at);
        const lore: LoreMeasure[] | null = loreRecord ? loreMeasures(loreRecord.activations) : null;
        const result = reconstructSources({
            counts: capture.counts,
            presetNames: this.presetNames(),
            slots,
            lore,
            absolute,
            messageTokens,
        });
        const record: InspectorRecord = {
            messageIndex,
            at: capture.at,
            generationType: capture.type,
            messages: capture.messages.length,
            chars: charsByRole(capture.messages),
            totalTokens: result.total,
            exact: result.exact,
            sources: result.sources,
            loreByBook: lore !== null,
        };
        const journal = this.app.modules.api<LoreJournalApi>('loreJournal');
        this.details = {
            chatId: capture.chatId,
            record,
            capture,
            lore: loreRecord ? (journal?.lastContents?.() ?? []) : [],
            loreRecord: loreRecord ?? undefined,
        };
        const chatId = capture.chatId ?? this.app.host.chatId();
        if (chatId) {
            const keep = Math.max(1, Math.floor(Number(this.settings.keepTurns) || 100));
            await this.updateDoc(chatId, (doc) => {
                doc.records = pushTurn(doc.records, record, keep);
            });
        }
        for (const listener of [...this.listeners]) {
            try {
                listener(record);
            } catch (error) {
                this.log.warn('inspector listener failed', error);
            }
        }
        return record;
    }

    /** M1's record of the same turn (M1 finalises in parallel after the same reply:ready). */
    private loreFor(messageIndex: number, since: number): Promise<TurnLoreRecord | null> {
        const journal = this.app.modules.api<LoreJournalApi>('loreJournal');
        if (!journal) return Promise.resolve(null);
        const matches = (record: TurnLoreRecord | undefined): record is TurnLoreRecord =>
            !!record && !record.simulated && record.messageIndex === messageIndex && record.at >= since;
        const last = journal.last();
        if (matches(last)) return Promise.resolve(last);
        return new Promise((resolve) => {
            let off: Unsubscribe = () => {};
            const timer = setTimeout(() => {
                off();
                resolve(null);
            }, LORE_WAIT_MS);
            off = journal.onTurn((record) => {
                if (!matches(record)) return;
                clearTimeout(timer);
                off();
                resolve(record);
            });
        });
    }

    private presetNames(): Record<string, string> {
        const names: Record<string, string> = {};
        try {
            for (const prompt of adaptersOf(this.app).preset.prompts()) {
                if (prompt.identifier && prompt.name) names[prompt.identifier] = prompt.name;
            }
        } catch (error) {
            this.log.debug('preset prompt names', error);
        }
        return names;
    }

    private substitute(): (text: string) => string {
        const ctx = this.app.host.ctx();
        return (text) => {
            try {
                return typeof ctx.substituteParams === 'function' ? ctx.substituteParams(text) : text;
            } catch {
                return text;
            }
        };
    }

    async tokensOf(text: string): Promise<number> {
        if (!text) return 0;
        const key = stableHash(text);
        const cached = this.tokenCache.get(key);
        if (cached !== undefined) return cached;
        let value: number;
        try {
            const counted = Number(await this.app.host.ctx().getTokenCountAsync(text));
            value = Number.isFinite(counted) && counted >= 0 ? counted : Math.ceil(text.length / 3.5);
        } catch {
            value = Math.ceil(text.length / 3.5);
        }
        if (this.tokenCache.size >= TOKEN_CACHE_LIMIT) {
            const oldest = this.tokenCache.keys().next().value;
            if (oldest !== undefined) this.tokenCache.delete(oldest);
        }
        this.tokenCache.set(key, value);
        return value;
    }

    /* ---------------------------------------------------------------- storage */

    async ensureLoaded(): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId || this.disposed) {
            this.view = null;
            return;
        }
        if (this.view?.chatId === chatId) return;
        if (!this.loading) {
            this.loading = (async () => {
                const doc = ensureDoc(await this.app.chat.getFor(chatId, INSPECTOR_DOC_KIND, emptyDoc));
                if (this.app.host.chatId() === chatId) this.view = { chatId, doc };
            })()
                .catch((error: unknown) => this.log.warn('could not load the inspector records', error))
                .finally(() => {
                    this.loading = null;
                });
        }
        await this.loading;
        if (this.app.host.chatId() !== chatId) await this.ensureLoaded();
    }

    private async updateDoc(chatId: string, change: (doc: InspectorDoc) => void): Promise<void> {
        for (let attempt = 0; attempt < 2; attempt++) {
            const doc = ensureDoc(await this.app.chat.getFor(chatId, INSPECTOR_DOC_KIND, emptyDoc));
            change(doc);
            const saved = await this.app.chat.put(INSPECTOR_DOC_KIND, doc);
            if (this.app.host.chatId() === chatId) this.view = { chatId, doc };
            if (saved) return;
        }
        this.log.warn('the inspector records were not saved (another tab keeps writing them)');
    }

    /* ---------------------------------------------------------------- API */

    turns(limit?: number): InspectorRecord[] {
        const view = this.view;
        if (!view || view.chatId !== this.app.host.chatId()) return [];
        const records = view.doc.records;
        return limit === undefined ? [...records] : limit <= 0 ? [] : records.slice(-limit);
    }

    last(): InspectorRecord | undefined {
        const records = this.turns();
        return records[records.length - 1];
    }

    onTurn(listener: (record: InspectorRecord) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Prompt text and lore contents of a turn, when it is the last turn of this session. */
    detailsFor(record: InspectorRecord): InspectorTurnDetails | null {
        const details = this.details;
        if (!details || details.chatId !== this.app.host.chatId()) return null;
        if (details.record.at !== record.at || details.record.messageIndex !== record.messageIndex) return null;
        return details;
    }
}
