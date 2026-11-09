// M45 «Мизансцена» (plan docs/agents-plan.md §3.16, release 1.32): the store of poses and positions per reply and swipe
// (chat document 'staging'), the receiver an agent writes into (`staging.set`, applied directly as a tracker: journaled
// with undo, no notice every turn), the prompt line «кто где и как» (ephemeral slot `maestro_staging`) and what the
// panel and the agents read. Without an agent the module is empty and does nothing (P11).
import { registerProposalReceiver } from '../../core/proposal-receivers';
import { mergeStaging, sanitizeEntries, stagingLine } from '../../domain/staging';
import type { StagingEntry } from '../../domain/staging';
import type { App, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { StagingApi } from './api';

export const STAGING_DOC = 'staging';
export const STAGING_KIND = 'staging.set';
export const STAGING_TARGET = 'staging.record';
const SAVE_DELAY_MS = 500;

export interface StagingSettings {
    /** The prompt line «кто где и как» (plan В16: on). */
    promptLine: boolean;
    depth: number;
}

export function defaultStagingSettings(): StagingSettings {
    return { promptLine: true, depth: 2 };
}

interface StagingDoc {
    version: 1;
    records: Record<string, { entries: StagingEntry[]; at: number }>;
}

function emptyDoc(): StagingDoc {
    return { version: 1, records: {} };
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function swipeOf(message: STChatMessage | undefined): number {
    return typeof message?.swipe_id === 'number' && message.swipe_id >= 0 ? message.swipe_id : 0;
}

export function recordKey(index: number, swipe: number): string {
    return `${index}:${swipe}`;
}

export class StagingService implements StagingApi {
    private doc: StagingDoc = emptyDoc();
    private chatId: string | null = null;
    private timer: ReturnType<typeof setTimeout> | null = null;
    private readonly listeners = new Set<() => void>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => StagingSettings,
        private readonly now: () => number = Date.now,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private chat(): STChatMessage[] {
        try {
            return this.app.host.ctx().chat ?? [];
        } catch {
            return [];
        }
    }

    install(): Unsubscribe[] {
        this.app.journal.registerUndo?.(STAGING_TARGET, (change) => this.undo(change));
        void this.load();
        return [
            this.app.bus.on('chat:changed', () => void this.load()),
            this.app.bus.on('message:invalidated', ({ messageIndex, reason, removedAt }) => {
                if (reason !== 'deleted') return;
                const from = removedAt ?? messageIndex;
                let changed = false;
                for (const key of Object.keys(this.doc.records)) {
                    if (Number(key.split(':')[0]) >= from) {
                        delete this.doc.records[key];
                        changed = true;
                    }
                }
                if (changed) this.changed();
            }),
            this.app.ephemeral.addProducer('staging', (gen) => {
                if (gen.dryRun || gen.quiet || !this.settings().promptLine) return;
                const text = stagingLine(this.current());
                if (!text) return;
                this.app.ephemeral.setInjection('staging', {
                    text,
                    position: 1,
                    depth: this.settings().depth,
                    role: 0,
                });
            }),
            registerProposalReceiver({
                kind: STAGING_KIND,
                module: 'staging',
                labelKey: 'm45.receiver',
                describe:
                    "the staging after the reply: for every character present (and the player's character) what changed in pose (stands, sits, lies…), where in the scene (at the window, in the door), next to whom and how, what they hold, what is visible on them (wet, wounded, bound). characters: only those whose staging the reply changed or that are not in the current staging yet; a field you leave out stays as it was (write the new state instead, e.g. holding: "nothing"); gone: names that left the scene.",
                schema: {
                    type: 'object',
                    properties: {
                        characters: {
                            type: 'array',
                            items: {
                                type: 'object',
                                properties: {
                                    name: { type: 'string' },
                                    pose: { type: 'string' },
                                    where: { type: 'string' },
                                    near: { type: 'string' },
                                    holding: { type: 'string' },
                                    state: { type: 'string' },
                                },
                                required: ['name'],
                            },
                        },
                        gone: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['characters'],
                },
                defaultAutonomy: 'auto',
                direct: true,
                toProposal: (data, context) => this.proposal(data, context.messageIndex),
                apply: (payload) => this.applyPayload(payload),
            }),
            () => this.flush(),
        ];
    }

    /* ------------------------------------------------------------ store */

    private async load(): Promise<void> {
        this.flush();
        const chatId = this.app.host.chatId();
        this.chatId = chatId;
        this.doc = emptyDoc();
        if (!chatId || this.app.host.isGroupChat()) return this.notify();
        try {
            const raw = await this.app.chat.get<StagingDoc>(STAGING_DOC, emptyDoc);
            if (this.chatId !== chatId) return;
            const records: StagingDoc['records'] = {};
            if (isDict(raw.records)) {
                for (const [key, value] of Object.entries(raw.records)) {
                    if (!/^\d+:\d+$/.test(key) || !isDict(value)) continue;
                    records[key] = { entries: sanitizeEntries(value.entries), at: Number(value.at) || 0 };
                }
            }
            this.doc = { version: 1, records };
        } catch (error) {
            this.log.warn('could not load staging', error);
        }
        this.notify();
    }

    private changed(): void {
        this.notify();
        if (!this.chatId || this.timer !== null) return;
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.save();
        }, SAVE_DELAY_MS);
    }

    private flush(): void {
        if (this.timer === null) return;
        clearTimeout(this.timer);
        this.timer = null;
        void this.save();
    }

    private async save(): Promise<void> {
        if (!this.chatId) return;
        try {
            if (!(await this.app.chat.put(STAGING_DOC, this.doc))) this.log.info('staging: write conflict');
        } catch (error) {
            this.log.warn('could not save staging', error);
        }
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('staging listener failed', error);
            }
        }
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /* ------------------------------------------------------------ reading */

    /** The record in force at a message (its own, else the nearest earlier reply's). */
    recordAt(index: number): { key: string | null; entries: StagingEntry[] } {
        const chat = this.chat();
        for (let i = Math.min(index, chat.length - 1); i >= 0; i--) {
            const message = chat[i];
            if (!message || message.is_user || message.is_system) continue;
            const key = recordKey(i, swipeOf(message));
            const record = this.doc.records[key];
            if (record) return { key, entries: record.entries.map((entry) => ({ ...entry })) };
        }
        return { key: null, entries: [] };
    }

    current(): StagingEntry[] {
        return this.recordAt(this.chat().length - 1).entries;
    }

    text(): string {
        return stagingLine(this.current());
    }

    /* ------------------------------------------------------------ writing */

    private lastReplyIndex(): number {
        const chat = this.chat();
        for (let i = chat.length - 1; i >= 0; i--) if (chat[i] && !chat[i]?.is_user && !chat[i]?.is_system) return i;
        return -1;
    }

    private proposal(
        data: Record<string, unknown>,
        messageIndex: number | undefined,
    ): Proposal<{ key: string; entries: StagingEntry[] }> | null {
        const index = messageIndex ?? this.lastReplyIndex();
        const message = this.chat()[index];
        if (index < 0 || !message || message.is_user) return null;
        const key = recordKey(index, swipeOf(message));
        const previous = this.recordAt(index).entries;
        const gone = Array.isArray(data.gone)
            ? data.gone.filter((name): name is string => typeof name === 'string')
            : [];
        const next = mergeStaging(previous, sanitizeEntries(data.characters), gone);
        if (JSON.stringify(next) === JSON.stringify(previous)) return null;
        const own = this.doc.records[key];
        return {
            module: 'staging',
            kind: STAGING_KIND,
            title: this.t('m45.proposal', { names: next.map((entry) => entry.name).join(', ') }),
            changes: [{ target: STAGING_TARGET, ref: { key }, before: own ? own.entries : null, after: next }],
            payload: { key, entries: next },
            sourceMessage: index,
            apply: (payload) => this.applyPayload(payload),
        };
    }

    private async applyPayload(raw: unknown): Promise<void> {
        if (!isDict(raw) || typeof raw.key !== 'string') return;
        this.doc.records[raw.key] = { entries: sanitizeEntries(raw.entries), at: this.now() };
        this.changed();
    }

    /** The user's edit in the panel: the record of the last reply. */
    async setCurrent(entries: StagingEntry[]): Promise<void> {
        const index = this.lastReplyIndex();
        const message = this.chat()[index];
        if (index < 0 || !message) return;
        const key = recordKey(index, swipeOf(message));
        const before = this.doc.records[key]?.entries ?? null;
        const after = sanitizeEntries(entries);
        this.doc.records[key] = { entries: after, at: this.now() };
        this.changed();
        try {
            await this.app.journal.record({
                module: 'staging',
                kind: STAGING_KIND,
                summary: this.t('m45.edited'),
                changes: [{ target: STAGING_TARGET, ref: { key }, before, after }],
                sourceMessage: index,
            });
        } catch (error) {
            this.log.debug('journal record failed', error);
        }
    }

    private async undo(change: JournalChange): Promise<boolean> {
        const key = typeof change.ref.key === 'string' ? change.ref.key : '';
        if (!key) return false;
        if (change.before === null) delete this.doc.records[key];
        else this.doc.records[key] = { entries: sanitizeEntries(change.before), at: this.now() };
        this.changed();
        return true;
    }
}
