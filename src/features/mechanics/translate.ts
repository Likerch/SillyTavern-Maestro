// M25 «Механики», the English for the model (plan-2 §6 п.8 «правила пишешь по-русски — модели уходит английский
// перевод»): the user writes the summary and the rules in his language (MechanicDef.summarySource / rulesSource) and
// names things in it; the model gets English. After a save the definition waits for its translation (until then the
// model reads the source itself, see interimEnglish); a background task 'mechanics.translate' (the cheap model, one
// JSON answer) translates what changed and saves the definition again (journaled like any save). The constructor can
// also ask for the translation at once («Перевести сейчас») to show and edit it before saving. Chats opened later
// pick up definitions still waiting (the task runs only in the leader tab of an open chat).
import { applyTranslation, translationItems } from '../../domain/mechanics-view';
import type { TranslationItem } from '../../domain/mechanics-view';
import type { LlmMessage, TaskInfo, Unsubscribe } from '../../shared/contracts';
import type { MechanicDef } from './api';
import type { DefinitionsPart, PartDeps } from './parts';

export const TRANSLATE_TASK = 'mechanics.translate';
export const TRANSLATE_SCHEMA = 'maestro_mechanics_translate';
const MAX_TOKENS = 2000;
/** Texts sent in one request at most (a definition has a few). */
const ITEMS_MAX = 40;

const SYSTEM = [
    'You translate the texts of a role-play game mechanic into English for the model that runs the story.',
    'Each item has a key and a text in the user language (usually Russian). Return the same keys with concise, natural',
    'English: rules and summaries as clear instructions; names as short names (a stat, a check, a condition).',
    'Keep numbers, dice formulas and references like @mana exactly as they are. Never add anything.',
    'Answer with JSON only: {"items":[{"key":"...","text":"..."}]}.',
].join(' ');

export const TRANSLATE_JSON_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['items'],
    properties: {
        items: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['key', 'text'],
                properties: { key: { type: 'string' }, text: { type: 'string' } },
            },
        },
    },
};

export function translateMessages(items: readonly TranslationItem[]): LlmMessage[] {
    return [
        { role: 'system', content: SYSTEM },
        { role: 'user', content: JSON.stringify({ items: items.slice(0, ITEMS_MAX) }) },
    ];
}

/** The answer's items (tolerant: a bare array, text with the JSON inside). */
export function parseTranslation(raw: unknown): TranslationItem[] | null {
    let value = raw;
    if (typeof value === 'string') {
        const start = value.indexOf('{');
        const end = value.lastIndexOf('}');
        try {
            value = JSON.parse(start >= 0 && end > start ? value.slice(start, end + 1) : value);
        } catch {
            return null;
        }
    }
    const list = Array.isArray(value)
        ? value
        : typeof value === 'object' && value !== null && Array.isArray((value as { items?: unknown }).items)
          ? (value as { items: unknown[] }).items
          : null;
    if (!list) return null;
    return list
        .filter(
            (item): item is TranslationItem =>
                typeof item === 'object' &&
                item !== null &&
                typeof (item as TranslationItem).key === 'string' &&
                typeof (item as TranslationItem).text === 'string',
        )
        .map((item) => ({ key: item.key, text: item.text.trim() }));
}

export class MechanicTranslator {
    private readonly offs: Unsubscribe[] = [];
    private readonly listeners = new Set<(id: string) => void>();
    private disposed = false;

    constructor(
        private readonly deps: PartDeps,
        private readonly defs: DefinitionsPart,
    ) {}

    install(): void {
        const { app } = this.deps;
        this.offs.push(app.tasks.register(TRANSLATE_TASK, (payload, info) => this.run(payload, info)));
        this.offs.push(app.bus.on('chat:changed', () => void this.enqueueWaiting()));
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        for (const off of this.offs.splice(0)) off();
        this.listeners.clear();
    }

    /** Called when a definition got its English (the constructor refreshes). */
    onTranslated(listener: (id: string) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    available(): boolean {
        try {
            return this.deps.app.llm.available(TRANSLATE_TASK);
        } catch {
            return false;
        }
    }

    /** One request: the English of the items, or null when it failed. */
    async translate(items: readonly TranslationItem[], signal?: AbortSignal): Promise<TranslationItem[] | null> {
        if (!items.length) return [];
        const response = await this.deps.app.llm.request<unknown>({
            task: TRANSLATE_TASK,
            messages: translateMessages(items),
            maxTokens: MAX_TOKENS,
            temperature: 0.2,
            schema: { name: TRANSLATE_SCHEMA, schema: TRANSLATE_JSON_SCHEMA },
            ...(signal ? { signal } : {}),
        });
        if (!response.ok) {
            this.deps.log.info(`mechanics: the translation failed (${response.error ?? 'unknown error'})`);
            return null;
        }
        return parseTranslation(response.data ?? response.text);
    }

    /** A draft with its English laid in now (the constructor's «Перевести сейчас»); null when it failed. */
    async translateDraft(def: MechanicDef): Promise<MechanicDef | null> {
        const items = translationItems(def);
        if (!items.length) return def;
        const answers = await this.translate(items);
        return answers ? applyTranslation(def, items, answers) : null;
    }

    /** Puts a saved definition in the queue when it waits for English (false without a chat). */
    async enqueue(id: string): Promise<boolean> {
        const { app } = this.deps;
        // Without a model for Maestro's background work nothing would come of the task.
        if (this.disposed || !app.host.chatId() || !this.available()) return false;
        const def = this.defs.get(id);
        if (!def || !translationItems(def).length) return false;
        try {
            await app.tasks.enqueue({
                kind: TRANSLATE_TASK,
                dedupeKey: `${TRANSLATE_TASK}:${id}`,
                payload: { mechanicId: id },
            });
            return true;
        } catch (error) {
            this.deps.log.debug('mechanics: the translation was not queued', error);
            return false;
        }
    }

    /** Every visible definition still waiting (a chat was opened). */
    async enqueueWaiting(): Promise<number> {
        let count = 0;
        let list: MechanicDef[];
        try {
            list = this.defs.list();
        } catch {
            list = [];
        }
        for (const def of list) if (translationItems(def).length && (await this.enqueue(def.id))) count++;
        return count;
    }

    private async run(payload: Record<string, unknown>, info: TaskInfo): Promise<void> {
        const { app } = this.deps;
        if (this.disposed) return;
        const chatId = app.host.chatId();
        if (!chatId || (info.chatId && info.chatId !== chatId)) return;
        const id = typeof payload.mechanicId === 'string' ? payload.mechanicId : '';
        const def = id ? this.defs.get(id) : null;
        if (!def) return;
        const items = translationItems(def);
        if (!items.length) return;
        if (!this.available() || app.cost.backgroundCapReached()) return;
        const answers = await this.translate(items);
        // A failed request is retried by the queue.
        if (!answers) throw new Error('translation failed');
        const fresh = this.defs.get(id);
        if (!fresh) return;
        const next = applyTranslation(fresh, items, answers);
        if (JSON.stringify(next) === JSON.stringify(fresh)) return;
        await this.defs.save(next);
        for (const listener of [...this.listeners]) {
            try {
                listener(id);
            } catch (error) {
                this.deps.log.debug('mechanics: translation listener failed', error);
            }
        }
    }
}
