// «Сверить с ИИ» (M7 п. 4, plan §9): appearance and descriptions of one entity compared across its stores by the
// cheap background model. Runs as a background task (kind 'dossier.compare') — only in the leader tab, never during a
// generation and never on the send path (P15); the core caps the daily background spend and records the cost.
// The caller awaits the task's result; the last result per entity is kept in the chat's 'dossier' document.
import {
    COMPARE_SCHEMA,
    buildCompareMessages,
    buildCompareSnippets,
    estimateCompare,
    parseCompareResult,
} from '../../domain/dossier-compare';
import type { CompareSnippet, CompareSource } from '../../domain/dossier-compare';
import { overridePassport, passportTagLine } from '../../domain/dossier-data';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { EntitySource } from '../world/api';
import type { DossierFinding } from './api';
import type { DossierSettings } from './settings';
import type { DossierSources, EntityFacts } from './sources';

export const COMPARE_TASK = 'dossier.compare';
const DOC_KIND = 'dossier';
const MAX_TOKENS = 1200;
const WAIT_MS = 4 * 60_000;
const TASK_TTL_MS = 10 * 60_000;
const KEEP_RESULTS = 30;

export class CompareError extends Error {
    constructor(
        message: string,
        readonly code: string,
    ) {
        super(message);
    }
}

export interface CompareResult {
    entityId: string;
    at: number;
    findings: DossierFinding[];
    costUsd?: number;
    error?: string;
}

interface DossierDoc {
    ai: Record<string, CompareResult>;
}

interface Pending {
    resolve(result: CompareResult): void;
    timer: ReturnType<typeof setTimeout>;
}

interface Snippet extends CompareSource {
    source?: EntitySource;
}

function newId(): string {
    return `dc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Texts worth comparing, one per store, with the source each came from. */
export function compareSources(facts: EntityFacts): Snippet[] {
    const out: Snippet[] = [];
    const add = (store: string, label: string, text: string | null | undefined, source?: EntitySource) => {
        if (text && text.trim()) out.push(source ? { store, label, text, source } : { store, label, text });
    };
    if (facts.persona) add('persona description', facts.persona.name, facts.persona.description);
    add(
        'character card',
        facts.entity.name,
        facts.cardDescription,
        facts.cardAvatar
            ? { kind: 'card', ref: facts.cardAvatar, label: facts.entity.name, avatar: facts.cardAvatar }
            : undefined,
    );
    for (const lore of facts.lore) {
        const content = typeof lore.entry.content === 'string' ? lore.entry.content : '';
        add('lorebook entry', lore.title, content, lore.source);
        if (lore.override && facts.canonBook && typeof lore.override.entry.content === 'string') {
            add('chat canon override', lore.title, lore.override.entry.content, {
                kind: 'canon.entry',
                ref: `${facts.canonBook}#${lore.override.uid}`,
                label: lore.title,
                world: facts.canonBook,
                uid: lore.override.uid,
            });
        }
    }
    for (const item of facts.canon) {
        const title =
            typeof item.entry.comment === 'string' && item.entry.comment.trim() ? item.entry.comment : `#${item.uid}`;
        add(
            'chat canon',
            title,
            typeof item.entry.content === 'string' ? item.entry.content : '',
            facts.canonBook
                ? {
                      kind: 'canon.entry',
                      ref: `${facts.canonBook}#${item.uid}`,
                      label: title,
                      world: facts.canonBook,
                      uid: item.uid,
                  }
                : undefined,
        );
    }
    for (const archive of facts.archives) {
        const tags = archive.summary.tags.join(' ');
        add(
            'CarrotKernel archive',
            archive.source.label,
            [tags, archive.summary.prose].filter(Boolean).join('\n'),
            archive.source,
        );
    }
    for (const fact of facts.passports) {
        const { passport } = overridePassport(fact.passport, fact.chat);
        add('NAI image passport (tags)', passport.name || fact.owner, passportTagLine(passport), fact.source);
    }
    const des = facts.des;
    if (des) {
        const source: EntitySource = { kind: 'des.character', ref: des.canonical, label: des.canonical };
        if (des.messageIndex !== undefined) source.messageIndex = des.messageIndex;
        const details = Object.entries(des.character?.details ?? {}).map(([key, value]) => `${key}: ${value}`);
        add('scene tracker (current scene)', des.canonical, details.join('\n'), source);
        add('portrait prompt', des.canonical, des.portraitPrompt, source);
        add('workshop description', des.canonical, des.workshopDescription, source);
    }
    return out;
}

export class DossierCompare {
    private readonly pending = new Map<string, Pending>();
    private readonly inflight = new Map<string, Promise<CompareResult>>();
    private readonly results = new Map<string, CompareResult>();
    private readonly listeners = new Set<(entityId: string) => void>();
    private loadedFor: string | null = null;

    constructor(
        private readonly app: App,
        private readonly sources: DossierSources,
        private readonly settings: () => DossierSettings,
        private readonly log: Logger,
    ) {}

    install(): Unsubscribe[] {
        return [
            this.app.tasks.register(COMPARE_TASK, (payload) => this.run(payload)),
            this.app.bus.on('chat:changed', () => {
                this.results.clear();
                this.loadedFor = null;
            }),
            () => {
                for (const [id, pending] of this.pending) {
                    clearTimeout(pending.timer);
                    pending.resolve({ entityId: '', at: Date.now(), findings: [], error: 'disabled' });
                    this.pending.delete(id);
                }
            },
        ];
    }

    onResult(listener: (entityId: string) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /** The last comparison of an entity in this chat (memory, then the chat document). */
    async last(entityId: string): Promise<CompareResult | null> {
        await this.load();
        return this.results.get(entityId) ?? null;
    }

    lastCached(entityId: string): CompareResult | null {
        return this.results.get(entityId) ?? null;
    }

    private async load(): Promise<void> {
        const chatId = this.app.host.chatId();
        if (!chatId || this.loadedFor === chatId) return;
        this.loadedFor = chatId;
        try {
            const doc = await this.app.chat.get<DossierDoc>(DOC_KIND, () => ({ ai: {} }));
            for (const [id, result] of Object.entries(doc.ai ?? {})) {
                if (!this.results.has(id) && Array.isArray(result?.findings)) this.results.set(id, result);
            }
        } catch (error) {
            this.log.debug('dossier document did not load', error);
        }
    }

    private async store(result: CompareResult): Promise<void> {
        this.results.set(result.entityId, result);
        if (!this.app.host.chatId()) return;
        try {
            for (let attempt = 0; attempt < 2; attempt++) {
                const doc = await this.app.chat.get<DossierDoc>(DOC_KIND, () => ({ ai: {} }));
                const ai = { ...(doc.ai ?? {}), [result.entityId]: result };
                const ids = Object.keys(ai).sort((a, b) => (ai[b]?.at ?? 0) - (ai[a]?.at ?? 0));
                for (const id of ids.slice(KEEP_RESULTS)) delete ai[id];
                if (await this.app.chat.put<DossierDoc>(DOC_KIND, { ...doc, ai })) return;
            }
        } catch (error) {
            this.log.debug('dossier document was not saved', error);
        }
    }

    /** Snippets that would be sent and the size/cost estimate («≈ N токенов»). */
    plan(facts: EntityFacts): { snippets: CompareSnippet[]; estimate: ReturnType<typeof estimateCompare> } {
        const snippets = buildCompareSnippets(compareSources(facts), this.settings().compareMaxChars);
        return { snippets, estimate: estimateCompare(snippets) };
    }

    /** Why the comparison cannot run in this tab now (null when it can). */
    blocker(): string | null {
        if (!this.app.host.chatId()) return 'noChat';
        if (!this.app.leader.isLeader()) return 'notLeader';
        if (!this.app.llm.available(COMPARE_TASK)) return 'noProfile';
        if (this.app.cost.backgroundCapReached()) return 'cap';
        return null;
    }

    /** Enqueues the comparison and waits for it. Throws CompareError when it cannot run. */
    async request(entityId: string): Promise<CompareResult> {
        const blocker = this.blocker();
        if (blocker) throw new CompareError(this.app.i18n.t(`m7.compare.${blocker}`), blocker);
        // The queue rolls tasks up by entity: a second request while one waits shares its answer.
        const running = this.inflight.get(entityId);
        if (running) return running;
        const request = this.enqueueAndWait(entityId).finally(() => this.inflight.delete(entityId));
        this.inflight.set(entityId, request);
        return request;
    }

    private async enqueueAndWait(entityId: string): Promise<CompareResult> {
        const requestId = newId();
        const done = new Promise<CompareResult>((resolve) => {
            const timer = setTimeout(() => {
                this.pending.delete(requestId);
                resolve({ entityId, at: Date.now(), findings: [], error: 'timeout' });
            }, WAIT_MS);
            this.pending.set(requestId, { resolve, timer });
        });
        try {
            await this.app.tasks.enqueue({
                kind: COMPARE_TASK,
                dedupeKey: entityId,
                payload: { entityId, requestId },
                ttlMs: TASK_TTL_MS,
                priority: 1,
            });
        } catch (error) {
            const pending = this.pending.get(requestId);
            if (pending) clearTimeout(pending.timer);
            this.pending.delete(requestId);
            throw new CompareError(error instanceof Error ? error.message : String(error), 'enqueue');
        }
        this.app.tasks.kick();
        const result = await done;
        if (result.error && result.error !== 'empty') {
            const key = `m7.compare.error.${result.error}`;
            const text = this.app.i18n.t(key);
            throw new CompareError(
                text === key ? this.app.i18n.t('m7.compare.error.other', { error: result.error }) : text,
                result.error,
            );
        }
        return result;
    }

    private settle(requestId: unknown, result: CompareResult): void {
        if (typeof requestId !== 'string') return;
        const pending = this.pending.get(requestId);
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(requestId);
        pending.resolve(result);
    }

    private emit(entityId: string): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(entityId);
            } catch (error) {
                this.log.error('dossier listener failed', error);
            }
        }
    }

    /** Task runner: never throws (a bad answer is not worth the queue's retries; transport retries are the client's). */
    private async run(payload: Record<string, unknown>): Promise<void> {
        const entityId = typeof payload.entityId === 'string' ? payload.entityId : '';
        const fail = (error: string) => {
            const result: CompareResult = { entityId, at: Date.now(), findings: [], error };
            this.settle(payload.requestId, result);
        };
        const entity = entityId ? this.sources.entity(entityId) : undefined;
        if (!entity) {
            fail('gone');
            return;
        }
        let facts: EntityFacts;
        try {
            facts = await this.sources.facts(entity);
        } catch (error) {
            this.log.warn('dossier comparison: sources failed', error);
            fail('sources');
            return;
        }
        const sources = compareSources(facts);
        const snippets = buildCompareSnippets(sources, this.settings().compareMaxChars);
        if (snippets.length < 2) {
            const result: CompareResult = { entityId, at: Date.now(), findings: [], error: 'empty' };
            await this.store(result);
            this.settle(payload.requestId, result);
            this.emit(entityId);
            return;
        }
        const response = await this.app.llm.request<unknown>({
            task: COMPARE_TASK,
            messages: buildCompareMessages(entity.name, entity.aliases, snippets),
            maxTokens: MAX_TOKENS,
            temperature: 0,
            schema: { name: 'dossier_compare', schema: COMPARE_SCHEMA },
        });
        if (!response.ok) {
            fail(response.refusal ? 'refusal' : (response.error ?? 'failed'));
            return;
        }
        const issues = parseCompareResult(
            response.data ?? response.text,
            snippets.map((snippet) => snippet.id),
        );
        if (!issues) {
            fail('parse');
            return;
        }
        // buildCompareSnippets keeps the non-empty sources in order: snippet i is usable[i].
        const usable = sources.filter((item) => item.text.trim());
        const byId = new Map(
            snippets.map((snippet, index) => [snippet.id, { snippet, source: usable[index]?.source }]),
        );
        const t = this.app.i18n.t.bind(this.app.i18n);
        const findings: DossierFinding[] = issues.map((issue) => {
            const a = byId.get(issue.a);
            const b = byId.get(issue.b);
            const finding: DossierFinding = {
                kind: issue.kind === 'appearance' ? 'appearanceMismatch' : 'descriptionMismatch',
                severity: 'warn',
                text: t('m7.ai.finding', {
                    summary: issue.summary || t(`m7.ai.kind.${issue.kind}`),
                    a: a?.snippet.label ?? issue.a,
                    b: b?.snippet.label ?? issue.b,
                    quoteA: issue.quoteA || '—',
                    quoteB: issue.quoteB || '—',
                }),
                sources: [a?.source, b?.source].filter((source): source is EntitySource => !!source),
            };
            return finding;
        });
        const result: CompareResult = { entityId, at: Date.now(), findings };
        if (response.costUsd !== undefined) result.costUsd = response.costUsd;
        await this.store(result);
        this.settle(payload.requestId, result);
        this.emit(entityId);
    }
}
