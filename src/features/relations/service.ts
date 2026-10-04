// M19 «Граф отношений», data part (plan M19, §2.1; dev-plan 3.4). DES writes each character's relationship status
// toward the persona into every assistant message's tracker; the history of changes lives in the chat document
// 'relations' (schema 1, compare-and-swap with one retry). Points are recorded only for committed messages (P14):
// after `turn:committed`, later and after the generation (P15). A swiped, edited or deleted message loses its points;
// an edited committed message is read again (with the next one, whose «no change» may now be a change). A chat with
// no document yet is read in full in the background. Only the leader tab writes.
import { adaptersOf } from '../../adapters';
import {
    applyMessage,
    currentStatus,
    dropPoints,
    isCommittedIndex,
    lastCommittedIndex,
    mergeByName,
    needsRepair,
    nextAssistantIndex,
    observationsFrom,
    publicPoint,
    readRelations,
} from '../../domain/relations-history';
import type { RelationObservation, RelationPointData, StoredRelation } from '../../domain/relations-history';
import { normalizeName } from '../../domain/world-names';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { WorldModelApi } from '../world/api';
import type { Relation, RelationsApi } from './api';

export const RELATIONS_ID = 'M19';
export const RELATIONS_KEY = 'relations';
export const RELATIONS_DOC = 'relations';

const COMMIT_DELAY_MS = 1500;
const OPEN_DELAY_MS = 2000;
const IDLE_DELAY_MS = 300;
const YIELD_EVERY = 50;
const PUT_ATTEMPTS = 2;

export interface RelationsDoc {
    relations: StoredRelation[];
    /** When the whole chat was last read (0: never). */
    builtAt: number;
}

export function emptyRelationsDoc(): RelationsDoc {
    return { relations: [], builtAt: 0 };
}

/** Repairs a stored document in place. */
function readDoc(raw: Record<string, unknown>): RelationsDoc {
    raw.relations = readRelations(raw.relations);
    raw.builtAt = typeof raw.builtAt === 'number' && Number.isFinite(raw.builtAt) ? raw.builtAt : 0;
    return raw as unknown as RelationsDoc;
}

const pause = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

export class RelationsService {
    private doc: RelationsDoc | null = null;
    private loading: Promise<RelationsDoc | null> | null = null;
    private generation = 0;
    private readonly listeners = new Set<() => void>();
    private readonly pendingReads = new Set<number>();
    private rebuildWanted = false;
    private rebuilding: Promise<void> | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private waitingForIdle = false;
    private disposed = false;
    private world: { api: WorldModelApi; off: Unsubscribe } | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /* ---------------------------------------------------------------- lifecycle */

    install(): Unsubscribe[] {
        const { app } = this;
        return [
            app.bus.on('chat:changed', () => {
                this.generation++;
                this.doc = null;
                this.loading = null;
                this.pendingReads.clear();
                this.rebuildWanted = false;
                this.emit();
                void this.open();
            }),
            app.bus.on('turn:committed', ({ messageIndex }) => {
                // P15: remember the index only; the tracker is read after the send and the generation.
                this.pendingReads.add(messageIndex);
                this.arm(COMMIT_DELAY_MS);
            }),
            app.bus.on('message:invalidated', ({ messageIndex, reason }) => this.invalidate(messageIndex, reason)),
            app.bus.on('generation:ended', () => {
                if (!this.waitingForIdle) return;
                this.waitingForIdle = false;
                this.arm(IDLE_DELAY_MS);
            }),
            app.leader.onChange((leader) => {
                if (leader) void this.open();
            }),
            () => this.dispose(),
        ];
    }

    start(): void {
        void this.open();
    }

    private dispose(): void {
        this.disposed = true;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.world?.off();
        this.world = null;
        this.listeners.clear();
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('relations listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- names */

    private worldApi(): WorldModelApi | undefined {
        const api = this.app.modules.api<WorldModelApi>('world');
        if (api !== this.world?.api) {
            this.world?.off();
            this.world = null;
            if (api) {
                try {
                    this.world = { api, off: api.onChange(() => this.emit()) };
                } catch (error) {
                    this.log.debug('cannot listen to the world model', error);
                }
            }
        }
        return api;
    }

    /** The world model's canonical name (DES alias, card name), or the name as DES wrote it. */
    private canonical(name: string): string {
        try {
            return this.worldApi()?.resolve(name)?.name ?? name;
        } catch {
            return name;
        }
    }

    private persona(): string {
        const name = (this.app.host.ctx().name1 ?? '').trim();
        if (!name) return '';
        try {
            return this.worldApi()?.resolve(name, 'persona')?.name ?? name;
        } catch {
            return name;
        }
    }

    private chat(): STChatMessage[] {
        return this.app.host.ctx().chat ?? [];
    }

    private observationsAt(index: number): RelationObservation[] {
        const message = this.chat()[index];
        if (!message || message.is_user || message.is_system) return [];
        let snapshot = null;
        try {
            snapshot = adaptersOf(this.app).des.trackerFor(index);
        } catch (error) {
            this.log.debug('DES tracker is not available', error);
        }
        return observationsFrom(snapshot, this.persona(), (name) => this.canonical(name));
    }

    /** What one message says, with its send_date as the point fingerprint. */
    private readMessage(relations: StoredRelation[], index: number): StoredRelation[] {
        const sent = this.chat()[index]?.send_date;
        return applyMessage(
            relations,
            index,
            this.observationsAt(index),
            'des',
            typeof sent === 'string' && sent ? sent : undefined,
        );
    }

    /* ---------------------------------------------------------------- document */

    private load(): Promise<RelationsDoc | null> {
        if (!this.app.host.chatId()) return Promise.resolve(null);
        if (this.doc) return Promise.resolve(this.doc);
        if (this.loading) return this.loading;
        const startedIn = this.generation;
        const loading = this.app.chat
            .get<Record<string, unknown>>(
                RELATIONS_DOC,
                () => emptyRelationsDoc() as unknown as Record<string, unknown>,
            )
            .then((raw) => {
                const doc = readDoc(raw);
                if (startedIn !== this.generation) return null;
                this.doc = doc;
                this.emit();
                return doc;
            })
            .catch((error: unknown) => {
                this.log.warn('relations could not be read', error);
                return null;
            })
            .finally(() => {
                if (this.loading === loading) this.loading = null;
            });
        this.loading = loading;
        return loading;
    }

    /** Read-modify-write; on a version conflict the newer document is re-read and the change applied once more. */
    private async mutate(change: (doc: RelationsDoc) => boolean): Promise<boolean> {
        const startedIn = this.generation;
        for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
            if (startedIn !== this.generation || !this.app.host.chatId()) return false;
            const raw = await this.app.chat.get<Record<string, unknown>>(
                RELATIONS_DOC,
                () => emptyRelationsDoc() as unknown as Record<string, unknown>,
            );
            if (startedIn !== this.generation) return false;
            // A copy: a failed write must not leave the change in the chat store's cached document.
            const doc = readDoc(structuredClone(raw));
            if (!change(doc)) {
                this.doc = readDoc(raw);
                return false;
            }
            if (await this.app.chat.put(RELATIONS_DOC, doc)) {
                if (startedIn === this.generation) {
                    this.doc = doc;
                    this.emit();
                }
                return true;
            }
        }
        this.log.warn(`relations could not be saved after ${PUT_ATTEMPTS} attempts`);
        return false;
    }

    private setRelations(doc: RelationsDoc, next: StoredRelation[]): boolean {
        if (JSON.stringify(next) === JSON.stringify(doc.relations)) return false;
        doc.relations = next;
        return true;
    }

    /* ---------------------------------------------------------------- work (leader, off the send path) */

    /** On chat open: a chat without a document is read in full in the background. */
    private async open(): Promise<void> {
        const doc = await this.load();
        if (!doc || doc.builtAt > 0) return;
        const chat = this.chat();
        if (lastCommittedIndex(chat) < 0) return;
        this.rebuildWanted = true;
        this.arm(OPEN_DELAY_MS);
    }

    private arm(delay: number): void {
        if (this.disposed) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, delay);
    }

    private async flush(): Promise<void> {
        if (this.disposed) return;
        if (this.app.turn.current() !== null) {
            this.waitingForIdle = true;
            return;
        }
        if (!this.app.leader.isLeader()) {
            this.pendingReads.clear();
            return;
        }
        if (this.rebuildWanted) {
            this.rebuildWanted = false;
            this.pendingReads.clear();
            await this.rebuild();
            return;
        }
        if (!this.pendingReads.size) return;
        const chat = this.chat();
        const reads = [...this.pendingReads].sort((a, b) => a - b).filter((index) => isCommittedIndex(chat, index));
        this.pendingReads.clear();
        if (!reads.length) return;
        await this.load();
        await this.mutate((doc) => {
            let relations = doc.relations;
            for (const index of reads) relations = this.readMessage(relations, index);
            return this.setRelations(doc, relations);
        });
    }

    private async invalidate(messageIndex: number, reason: 'swiped' | 'deleted' | 'edited'): Promise<void> {
        if (reason === 'deleted') {
            for (const index of [...this.pendingReads]) if (index >= messageIndex) this.pendingReads.delete(index);
        } else {
            this.pendingReads.delete(messageIndex);
        }
        if (!this.app.leader.isLeader() || !this.app.host.chatId()) return;
        const doc = await this.load();
        if (!doc) return;
        const chat = this.chat();
        let repair = false;
        await this.mutate((current) => {
            const next = dropPoints(current.relations, messageIndex, reason === 'deleted' ? 'from' : 'at');
            if (reason === 'deleted') {
                repair = needsRepair(next, (point: RelationPointData) => {
                    const message = chat[point.messageIndex];
                    if (!message || message.is_user || message.is_system) return false;
                    return !point.sent || message.send_date === point.sent;
                });
            }
            return this.setRelations(current, next);
        });
        if (repair) {
            // Messages were deleted in the middle: indexes moved, so the history is read again.
            this.rebuildWanted = true;
            this.arm(COMMIT_DELAY_MS);
            return;
        }
        // An edited committed message is final already: read it again now, and the next reply too. A swiped or
        // edited last reply waits for its commit (P14).
        if (reason === 'edited' && isCommittedIndex(chat, messageIndex)) {
            this.pendingReads.add(messageIndex);
            const next = nextAssistantIndex(chat, messageIndex);
            if (next >= 0 && isCommittedIndex(chat, next)) this.pendingReads.add(next);
            this.arm(COMMIT_DELAY_MS);
        }
    }

    /** Reads every committed assistant message (yields every 50); keeps points that did not come from DES. */
    rebuild(): Promise<void> {
        this.rebuilding ??= this.rebuildAll().finally(() => {
            this.rebuilding = null;
        });
        return this.rebuilding;
    }

    private async rebuildAll(): Promise<void> {
        if (!this.app.host.chatId()) return;
        const startedIn = this.generation;
        const current = await this.load();
        const chat = this.chat();
        const last = lastCommittedIndex(chat);
        let relations: StoredRelation[] = (current?.relations ?? [])
            .map((relation) => ({ ...relation, history: relation.history.filter((point) => point.source !== 'des') }))
            .filter((relation) => relation.history.length > 0);
        let read = 0;
        for (let index = 0; index <= last; index++) {
            const message = chat[index];
            if (!message || message.is_user || message.is_system) continue;
            relations = this.readMessage(relations, index);
            if (++read % YIELD_EVERY === 0) {
                await pause();
                if (startedIn !== this.generation || this.disposed) return;
            }
        }
        if (startedIn !== this.generation) return;
        await this.mutate((doc) => {
            doc.relations = relations;
            doc.builtAt = Date.now();
            return true;
        });
    }

    /* ---------------------------------------------------------------- reading */

    loaded(): boolean {
        return this.doc !== null;
    }

    all(): Relation[] {
        if (!this.doc) {
            void this.load();
            return [];
        }
        return mergeByName(this.doc.relations, (name) => this.canonical(name))
            .map((relation) => ({
                from: relation.from,
                to: relation.to,
                current: currentStatus(relation.history),
                history: relation.history.map(publicPoint),
            }))
            .sort((a, b) => a.from.localeCompare(b.from, 'ru') || a.to.localeCompare(b.to, 'ru'));
    }

    of(name: string): Relation[] {
        const key = normalizeName(this.canonical(name));
        return this.all().filter(
            (relation) => normalizeName(relation.from) === key || normalizeName(relation.to) === key,
        );
    }

    between(from: string, to: string): Relation | undefined {
        const a = normalizeName(this.canonical(from));
        const b = normalizeName(this.canonical(to));
        return this.all().find((relation) => normalizeName(relation.from) === a && normalizeName(relation.to) === b);
    }

    api(): RelationsApi {
        return {
            all: () => this.all(),
            of: (name) => this.of(name),
            between: (from, to) => this.between(from, to),
            rebuild: () => this.rebuild(),
            onChange: (listener) => this.onChange(listener),
        };
    }
}
