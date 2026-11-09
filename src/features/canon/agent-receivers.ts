// What agents may propose to the chat canon (plan §3.18 «Создатели», release 1.31): a new entry of this chat's lore
// (a character, a place, a faction… the story established) and a change of an existing lore entry as a chat-only
// override (the original book is never touched, P13). Both go through autonomy and the Inbox; undo removes the entry
// or puts the previous override back. Characters live in the chat and its lore — agents never create ST cards (В14).
import { registerProposalReceiver } from '../../core/proposal-receivers';
import type { App, JournalChange, Logger, Proposal, Unsubscribe } from '../../shared/contracts';
import type { LoreStore } from '../loreStudio/store-api';
import type { WorldModelApi } from '../world/api';
import type { CanonApi, CanonItem, EntryType } from './api';

export const AGENT_ENTRY_KIND = 'canon.agentEntry';
export const AGENT_EDIT_KIND = 'canon.agentEdit';
export const AGENT_ENTRY_TARGET = 'canon.agentEntry';
export const AGENT_EDIT_TARGET = 'canon.agentEdit';

const ENTRY_TYPES: EntryType[] = ['character', 'place', 'item', 'faction', 'event', 'tradition', 'note'];

interface EntryPayload {
    name: string;
    englishName: string;
    type: EntryType;
    text: string;
    keys: string[];
    sourceMessage?: number;
}

interface EditPayload {
    world: string;
    uid: number;
    name: string;
    text: string;
}

function fold(text: string): string {
    return text.trim().toLowerCase().replace(/ё/g, 'е');
}

function str(value: unknown, max = 4000): string {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** «Book#12» (or «Book #12») → the entry's book and uid. */
export function parseEntryRef(ref: string): { world: string; uid: number } | null {
    const match = /^(.+?)\s*#\s*(\d+)$/.exec(ref.trim());
    if (!match?.[1] || !match[2]) return null;
    return { world: match[1].trim(), uid: Number(match[2]) };
}

export class CanonAgentReceivers {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    private canon(): CanonApi | undefined {
        return this.app.modules.api<CanonApi>('canon');
    }

    install(): Unsubscribe[] {
        this.app.journal.registerUndo?.(AGENT_ENTRY_TARGET, (change) => this.undoEntry(change));
        this.app.journal.registerUndo?.(AGENT_EDIT_TARGET, (change) => this.undoEdit(change));
        return [
            registerProposalReceiver({
                kind: AGENT_ENTRY_KIND,
                module: 'canon',
                labelKey: 'm44.recv.canon.agentEntry',
                describe:
                    "a NEW entry of this chat's lore about something the story established that the lore and the known names do not have yet. name: as the story writes it (its language, nominative case); englishName: the English name; type: character, place, item, faction, event, tradition or note; text: 1-6 short English sentences, present tense, third person, only what the story showed or clearly implied (a character: role, appearance, manner, relations; a place: what and where it is, what is there); keys: other names it goes by.",
                schema: {
                    type: 'object',
                    properties: {
                        name: { type: 'string' },
                        englishName: { type: 'string' },
                        type: { type: 'string', enum: ENTRY_TYPES },
                        text: { type: 'string' },
                        keys: { type: 'array', items: { type: 'string' } },
                    },
                    required: ['name', 'type', 'text'],
                },
                defaultAutonomy: 'inbox',
                toProposal: (data, context) => this.entryProposal(data, context),
                apply: (payload) => this.applyEntry(payload),
            }),
            registerProposalReceiver({
                kind: AGENT_EDIT_KIND,
                module: 'canon',
                labelKey: 'm44.recv.canon.agentEdit',
                describe:
                    'a CHANGE of an existing lore entry (shown in the lore context as [Name · Book#uid]) because the story changed it: a new scar, a new role, a new relation, a deepened past. entry: the reference exactly as shown (Book#uid); text: the WHOLE new English text of the entry — keep everything that is still true, change or add only what the story changed. The original book stays untouched: the change lives in this chat only.',
                schema: {
                    type: 'object',
                    properties: { entry: { type: 'string' }, text: { type: 'string' } },
                    required: ['entry', 'text'],
                },
                defaultAutonomy: 'inbox',
                toProposal: (data, context) => this.editProposal(data, context),
                apply: (payload) => this.applyEdit(payload),
            }),
        ];
    }

    /* ------------------------------------------------------------ a new entry */

    private async known(name: string): Promise<boolean> {
        const key = fold(name);
        const world = this.app.modules.api<WorldModelApi>('world');
        try {
            if (world?.resolve(name)) return true;
        } catch {
            // the world model changed under us
        }
        const items =
            (await this.canon()
                ?.list()
                .catch(() => [] as CanonItem[])) ?? [];
        return items.some((item) => {
            if (fold(String(item.entry.comment ?? '')) === key) return true;
            const keys = Array.isArray(item.entry.key) ? (item.entry.key as unknown[]) : [];
            return keys.some((value) => typeof value === 'string' && fold(value) === key);
        });
    }

    private async entryProposal(
        data: Record<string, unknown>,
        context: { agentName: string; messageIndex?: number },
    ): Promise<Proposal<EntryPayload> | null> {
        const name = str(data.name, 120);
        const text = str(data.text);
        const type = ENTRY_TYPES.includes(data.type as EntryType) ? (data.type as EntryType) : 'note';
        if (!name || !text || !this.canon()) return null;
        if (await this.known(name)) return null;
        const keys = Array.isArray(data.keys)
            ? data.keys
                  .filter((key): key is string => typeof key === 'string' && key.trim().length > 0)
                  .map((key) => key.trim())
                  .slice(0, 8)
            : [];
        const payload: EntryPayload = { name, englishName: str(data.englishName, 120), type, text, keys };
        if (context.messageIndex !== undefined) payload.sourceMessage = context.messageIndex;
        const proposal: Proposal<EntryPayload> = {
            module: 'canon',
            kind: AGENT_ENTRY_KIND,
            title: this.t('m44.recv.entryTitle', { name, type: this.t(`m44.recv.type.${type}`) }),
            details: text,
            changes: [{ target: AGENT_ENTRY_TARGET, ref: { name }, before: null, after: { name, type, text } }],
            payload,
            apply: (value) => this.applyEntry(value),
        };
        if (context.messageIndex !== undefined) proposal.sourceMessage = context.messageIndex;
        return proposal;
    }

    private async applyEntry(raw: unknown): Promise<void> {
        const canon = this.canon();
        if (!canon || !isDict(raw)) throw new Error('canon is off');
        const payload = raw as unknown as EntryPayload;
        const russian = await canon.russianKeys(payload.name).catch(() => [payload.name]);
        const keys = [
            ...new Set([...russian, payload.name, payload.englishName, ...(payload.keys ?? [])].filter(Boolean)),
        ];
        const meta: Parameters<CanonApi['put']>[0]['meta'] = {
            kind: 'addition',
            status: 'active',
            origin: 'agent',
            type: payload.type,
        };
        if (payload.sourceMessage !== undefined) meta.sourceMessage = payload.sourceMessage;
        await canon.put({ entry: { key: keys, keysecondary: [], comment: payload.name, content: payload.text }, meta });
    }

    private async undoEntry(change: JournalChange): Promise<boolean> {
        const canon = this.canon();
        const after = isDict(change.after) ? change.after : null;
        if (!canon || !after) return false;
        const items = await canon.list({ kind: 'addition' });
        const item = items.find(
            (candidate) => candidate.entry.comment === after.name && candidate.entry.content === after.text,
        );
        if (!item) return true;
        await canon.remove(item.uid);
        return true;
    }

    /* ------------------------------------------------------------ a change of an entry */

    private async editProposal(
        data: Record<string, unknown>,
        context: { agentName: string; messageIndex?: number },
    ): Promise<Proposal<EditPayload> | null> {
        const ref = parseEntryRef(str(data.entry, 300));
        const text = str(data.text, 8000);
        const canon = this.canon();
        if (!ref || !text || !canon) return null;
        const store = this.app.modules.api<LoreStore>('loreStore');
        const book = await store?.load(ref.world).catch(() => null);
        const entry = book?.entries[String(ref.uid)];
        if (!entry) return null;
        const items = await canon.list({ kind: 'override' });
        const override = items.find((item) => item.meta.base?.world === ref.world && item.meta.base.uid === ref.uid);
        const current = String(override?.entry.content ?? entry.content ?? '');
        if (current.trim() === text.trim()) return null;
        const name = String(entry.comment || (Array.isArray(entry.key) ? entry.key[0] : '') || ref.world);
        const payload: EditPayload = { world: ref.world, uid: ref.uid, name, text };
        const proposal: Proposal<EditPayload> = {
            module: 'canon',
            kind: AGENT_EDIT_KIND,
            title: this.t('m44.recv.editTitle', { name }),
            details: this.t('m44.recv.editDetails', { book: ref.world }),
            changes: [
                {
                    target: AGENT_EDIT_TARGET,
                    ref: { world: ref.world, uid: ref.uid },
                    before: { content: current, override: override ? String(override.entry.content ?? '') : null },
                    after: { content: text },
                },
            ],
            payload,
            apply: (value) => this.applyEdit(value),
        };
        if (context.messageIndex !== undefined) proposal.sourceMessage = context.messageIndex;
        return proposal;
    }

    private async applyEdit(raw: unknown): Promise<void> {
        const canon = this.canon();
        if (!canon || !isDict(raw)) throw new Error('canon is off');
        const payload = raw as unknown as EditPayload;
        await canon.put({
            entry: { content: payload.text },
            meta: {
                kind: 'override',
                status: 'active',
                origin: 'agent',
                base: { world: payload.world, uid: payload.uid, contentHash: '' },
                fields: ['content'],
            },
        });
    }

    private async undoEdit(change: JournalChange): Promise<boolean> {
        const canon = this.canon();
        const world = typeof change.ref.world === 'string' ? change.ref.world : '';
        const uid = typeof change.ref.uid === 'number' ? change.ref.uid : -1;
        if (!canon || !world || uid < 0) return false;
        const items = await canon.list({ kind: 'override' });
        const item = items.find((candidate) => candidate.meta.base?.world === world && candidate.meta.base.uid === uid);
        const before = isDict(change.before) ? change.before : {};
        if (!item) return true;
        if (typeof before.override === 'string') {
            await canon.put(
                {
                    entry: { content: before.override },
                    meta: {
                        kind: 'override',
                        status: 'active',
                        origin: 'agent',
                        base: { world, uid, contentHash: '' },
                        fields: ['content'],
                    },
                },
                { uid: item.uid },
            );
        } else {
            await canon.remove(item.uid);
        }
        this.log.debug(`agent edit of ${world}#${uid} undone`);
        return true;
    }
}
