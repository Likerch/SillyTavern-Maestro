// M36 «Промпты соседей»: the registry over the descriptors (descriptors.ts), Maestro's copies for the card and the chat
// (core/scoped-docs: `maestro-neighbour-prompts-char-<hash(avatar)>.json`, chat document `neighbour-prompts`), global
// writes through the neighbours' own save paths (journaled, undo, M4 acknowledged), and the copies applied at
// CHAT_COMPLETION_PROMPT_READY — Maestro's listener placed last, so the neighbours have put their texts in — by
// replacing the global text in the outgoing messages (domain/neighbour-prompts.ts). The read-only entries show what
// their slots sent at the last real generation (Maestro's own injections are cleared after every generation).
import { EMPTY_SCOPE_CONTEXT, ScopedDocs, currentScopeContext, scopeOwner } from '../../core/scoped-docs';
import type { ScopeContext } from '../../core/scoped-docs';
import { replaceInMessages, textNeedles } from '../../domain/neighbour-prompts';
import type { App, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { GuardianApi } from '../guardian/api';
import { NeighbourPromptError } from './api';
import type { NeighbourPrompt, NeighbourPromptsApi, NeighbourPromptsReport, NeighbourScope } from './api';
import { createDescriptors } from './descriptors';
import type { Descriptor } from './descriptors';

export const NEIGHBOUR_DOC_KIND = 'neighbour-prompts';
/** Journal targets and kinds: a neighbour's own setting, and Maestro's copy for a card or a chat. */
export const GLOBAL_TARGET = 'neighbour-prompt';
export const COPY_TARGET = 'neighbour-prompt-copy';
export const NEIGHBOUR_JOURNAL_KINDS = ['neighbourPrompts.global', 'neighbourPrompts.copy'] as const;
const MODULE_ID = 'M36';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface NeighbourDoc {
    /** Copies by descriptor id. */
    texts: Record<string, string>;
}

function emptyDoc(): NeighbourDoc {
    return { texts: {} };
}

function sanitizeDoc(raw: unknown): NeighbourDoc {
    const doc = emptyDoc();
    if (!isDict(raw) || !isDict(raw.texts)) return doc;
    for (const [id, text] of Object.entries(raw.texts)) {
        if (id && typeof text === 'string') doc.texts[id] = text;
    }
    return doc;
}

export class NeighbourPromptsService implements NeighbourPromptsApi {
    private readonly descriptors: Descriptor[];
    private readonly byId: Map<string, Descriptor>;
    private readonly docs: ScopedDocs<NeighbourDoc>;
    private readonly listeners = new Set<() => void>();
    /** Slot texts seen at the last real generation (the read-only entries show them). */
    private readonly seen = new Map<string, string>();
    private context: ScopeContext = { ...EMPTY_SCOPE_CONTEXT };
    private loading: Promise<void> = Promise.resolve();
    private report: NeighbourPromptsReport | null = null;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {
        this.descriptors = createDescriptors(app);
        this.byId = new Map(this.descriptors.map((descriptor) => [descriptor.id, descriptor]));
        this.docs = new ScopedDocs<NeighbourDoc>(
            { files: app.files, chat: app.chat, log },
            {
                kind: NEIGHBOUR_DOC_KIND,
                defaults: emptyDoc,
                sanitize: sanitizeDoc,
                onError: () => app.ui.notice(this.t('m36.saveFailed'), { level: 'error' }),
            },
        );
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(own: (dispose: Unsubscribe | (() => void | Promise<void>)) => void): void {
        this.app.journal.registerUndo(GLOBAL_TARGET, (change) => this.undoGlobal(change));
        this.app.journal.registerUndo(COPY_TARGET, (change) => this.undoCopy(change));
        own(this.app.bus.on('chat:changed', () => this.reload()));
        const name = this.app.host.events.name('CHAT_COMPLETION_PROMPT_READY');
        if (name) {
            // Last: the neighbours' own PROMPT_READY listeners (DES history and the like) have shaped the prompt.
            own(this.app.host.events.on(name, (data) => this.onPromptReady(data), { order: 'last' }));
        } else {
            this.log.warn('CHAT_COMPLETION_PROMPT_READY is missing: copies for a card or a chat do not apply');
        }
        own(() => {
            this.disposed = true;
            this.listeners.clear();
        });
        this.reload();
    }

    private reload(): void {
        const context = currentScopeContext(this.app.host);
        const job = this.loading.then(async () => {
            await this.docs.load(context);
            this.context = context;
            this.emit();
        });
        this.loading = job.catch((error: unknown) =>
            this.log.warn('neighbour prompt copies could not be loaded', error),
        );
    }

    ready(): Promise<void> {
        return this.loading;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        if (this.disposed) return;
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('neighbour prompts listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- reading */

    private slotNow(descriptor: Descriptor): string | null {
        if (!descriptor.slot) return null;
        try {
            const slot = this.app.host.ctx().extensionPrompts?.[descriptor.slot];
            const value = isDict(slot) && typeof slot.value === 'string' ? slot.value : '';
            return value.trim() ? value : null;
        } catch {
            return null;
        }
    }

    private copies(id: string): { character?: string; chat?: string } {
        const result: { character?: string; chat?: string } = {};
        const avatar = this.context.avatar;
        const chatId = this.context.chatId;
        const character = avatar ? this.docs.get('character', avatar)?.texts[id] : undefined;
        const chat = chatId ? this.docs.get('chat', chatId)?.texts[id] : undefined;
        if (character !== undefined) result.character = character;
        if (chat !== undefined) result.chat = chat;
        return result;
    }

    /** The neighbour's own text: its setting, its built-in text, or what its slot sends (now / last seen). */
    private globalOf(descriptor: Descriptor): { text: string; setting: string | null; builtin: string | null } {
        const setting = descriptor.setting ? descriptor.setting() : null;
        const builtin = descriptor.builtin ? descriptor.builtin() : null;
        const slot = descriptor.slot ? (this.slotNow(descriptor) ?? this.seen.get(descriptor.slot) ?? null) : null;
        return { text: setting || builtin || slot || '', setting, builtin };
    }

    private describe(descriptor: Descriptor): NeighbourPrompt {
        const present = safe(() => descriptor.present(), false, this.log);
        const global = present ? this.globalOf(descriptor) : { text: '', setting: null, builtin: null };
        const scoped = this.copies(descriptor.id);
        const editable = present && typeof descriptor.write === 'function' && global.setting !== null;
        const scopable = present && descriptor.scopable && global.text.trim() !== '';
        const entry: NeighbourPrompt = {
            id: descriptor.id,
            owner: descriptor.owner,
            label: this.t(`m36.p.${descriptor.id}.label`),
            description: this.t(`m36.p.${descriptor.id}.description`),
            present,
            text: scoped.chat ?? scoped.character ?? global.text,
            globalText: global.text,
            scoped,
            editable,
            scopable,
            usedIn: descriptor.usedIn,
        };
        if (typeof descriptor.write === 'function' && global.setting !== null) entry.setting = global.setting;
        if (global.builtin !== null) entry.defaultText = global.builtin;
        const note = this.noteOf(descriptor, present, editable, scopable);
        if (note) entry.note = note;
        return entry;
    }

    private noteOf(descriptor: Descriptor, present: boolean, editable: boolean, scopable: boolean): string | null {
        if (!present) return this.t('m36.note.absent');
        if (descriptor.moduleKey) {
            const module = this.app.modules.list().find((item) => item.module.key === descriptor.moduleKey)?.module;
            return this.t('m36.note.maestro', { module: module ? this.t(module.titleKey) : descriptor.moduleKey });
        }
        if (editable && scopable) return null;
        if (descriptor.noteKey) return this.t(descriptor.noteKey);
        if (editable && descriptor.scopable && !scopable) return this.t('m36.note.unknownGlobal');
        return null;
    }

    list(): NeighbourPrompt[] {
        return this.descriptors.map((descriptor) => this.describe(descriptor));
    }

    get(id: string): NeighbourPrompt | null {
        const descriptor = this.byId.get(id);
        return descriptor ? this.describe(descriptor) : null;
    }

    effective(id: string): string {
        return this.get(id)?.text ?? '';
    }

    lastReport(): NeighbourPromptsReport | null {
        return this.report
            ? { ...this.report, replaced: [...this.report.replaced], notFound: [...this.report.notFound] }
            : null;
    }

    /* ---------------------------------------------------------------- writing */

    private find(id: string): Descriptor {
        const descriptor = this.byId.get(id);
        if (!descriptor) throw new NeighbourPromptError('unknown', `no neighbour prompt ${id}`);
        return descriptor;
    }

    async setGlobal(id: string, text: string): Promise<void> {
        const descriptor = this.find(id);
        if (typeof descriptor.write !== 'function') throw new NeighbourPromptError('readOnly', `${id} is read-only`);
        if (!safe(() => descriptor.present(), false, this.log))
            throw new NeighbourPromptError('absent', `${id}: no neighbour`);
        // Plan §10.8: DES must not be written while its Workshop is open (it saves its own copy over ours).
        if (descriptor.busy?.()) throw new NeighbourPromptError('busy', `${id}: the neighbour is busy`);
        const before = descriptor.setting?.() ?? null;
        if (before === null) throw new NeighbourPromptError('absent', `${id}: the setting cannot be read`);
        const next = descriptor.normalize ? descriptor.normalize(text) : text;
        if (next === before) return;
        const raw = descriptor.snapshot ? descriptor.snapshot() : before;
        if (!descriptor.write(next)) throw new NeighbourPromptError('absent', `${id}: the neighbour did not take it`);
        await this.journal(
            'neighbourPrompts.global',
            this.t(next ? 'm36.journal.global' : 'm36.journal.reset', this.names(descriptor)),
            [{ target: GLOBAL_TARGET, ref: { id, raw }, before, after: next }],
        );
        await this.acknowledge(descriptor);
        this.emit();
    }

    async setScoped(id: string, scope: NeighbourScope, text: string | null): Promise<void> {
        const descriptor = this.find(id);
        await this.ready();
        const entry = this.describe(descriptor);
        const next = text === null || !text.trim() ? null : text;
        if (next !== null && !entry.scopable) throw new NeighbourPromptError('notScopable', `${id} cannot be copied`);
        const owner = scopeOwner(this.context, scope);
        if (!owner) throw new NeighbourPromptError('noScope', `no ${scope} is open`);
        await this.docs.loadOne(scope, owner);
        const before = this.docs.get(scope, owner)?.texts[id] ?? null;
        if (before === next) return;
        await this.docs.mutate(scope, owner, (doc) => {
            if (next === null) delete doc.texts[id];
            else doc.texts[id] = next;
        });
        const key = next === null ? `m36.journal.copyRemoved.${scope}` : `m36.journal.copy.${scope}`;
        await this.journal('neighbourPrompts.copy', this.t(key, this.names(descriptor)), [
            { target: COPY_TARGET, ref: { id, scope, owner }, before, after: next },
        ]);
        this.emit();
    }

    private names(descriptor: Descriptor): Record<string, string> {
        return {
            name: this.t(`m36.p.${descriptor.id}.label`),
            character: this.context.characterName ?? this.context.avatar ?? '',
        };
    }

    private async journal(
        kind: (typeof NEIGHBOUR_JOURNAL_KINDS)[number],
        summary: string,
        changes: JournalChange[],
    ): Promise<void> {
        try {
            await this.app.journal.record({ module: MODULE_ID, kind, summary, changes });
        } catch (error) {
            this.log.warn('neighbour prompt change was not journaled', error);
        }
    }

    /** M4 must not report Maestro's own write as drift. */
    private async acknowledge(descriptor: Descriptor): Promise<void> {
        const guardian = this.app.modules.api<GuardianApi>('guardian');
        if (!guardian || !descriptor.guardPaths?.length) return;
        try {
            await guardian.acknowledge(descriptor.guardPaths);
        } catch (error) {
            this.log.debug('guardian acknowledge failed', error);
        }
    }

    private async undoGlobal(change: JournalChange): Promise<boolean> {
        const id = typeof change.ref.id === 'string' ? change.ref.id : '';
        const descriptor = this.byId.get(id);
        if (!descriptor?.write || !safe(() => descriptor.present(), false, this.log) || descriptor.busy?.())
            return false;
        const current = descriptor.setting?.() ?? null;
        if (current === null || current !== change.after) return false;
        const before = typeof change.before === 'string' ? change.before : '';
        const ok =
            descriptor.restore && change.ref.raw !== undefined
                ? descriptor.restore(change.ref.raw)
                : descriptor.write(before);
        if (!ok) return false;
        await this.acknowledge(descriptor);
        this.emit();
        return true;
    }

    private async undoCopy(change: JournalChange): Promise<boolean> {
        const id = typeof change.ref.id === 'string' ? change.ref.id : '';
        const scope = change.ref.scope === 'character' || change.ref.scope === 'chat' ? change.ref.scope : null;
        const owner = typeof change.ref.owner === 'string' ? change.ref.owner : '';
        if (!id || !scope || !owner) return false;
        await this.docs.loadOne(scope, owner);
        const current = this.docs.get(scope, owner)?.texts[id] ?? null;
        if (current !== (typeof change.after === 'string' ? change.after : null)) return false;
        const before = typeof change.before === 'string' ? change.before : null;
        await this.docs.mutate(scope, owner, (doc) => {
            if (before === null) delete doc.texts[id];
            else doc.texts[id] = before;
        });
        this.emit();
        return true;
    }

    /* ---------------------------------------------------------------- generation time */

    private substitute(text: string): string {
        try {
            return this.app.host.ctx().substituteParams(text);
        } catch {
            return text;
        }
    }

    /**
     * CHAT_COMPLETION_PROMPT_READY `{chat, dryRun}`: every copy of the card or the chat open now replaces its global
     * text in the outgoing messages (dry runs too, so a test assembly shows what would really go). Cheap: string reads
     * and a search per copy; nothing is awaited.
     */
    onPromptReady(data: unknown): void {
        if (this.disposed || !isDict(data) || !Array.isArray(data.chat)) return;
        const real = data.dryRun === false;
        if (real) this.remember();
        const replaced: string[] = [];
        const notFound: string[] = [];
        for (const descriptor of this.descriptors) {
            const copies = this.copies(descriptor.id);
            const copy = copies.chat ?? copies.character;
            if (copy === undefined || !descriptor.scopable) continue;
            try {
                if (!descriptor.present()) continue;
                const global = descriptor.outgoing(this.slotNow(descriptor));
                if (!global || global === copy) {
                    if (!global) notFound.push(descriptor.id);
                    continue;
                }
                const rendered = descriptor.render(copy);
                const replacement = rendered.includes('{{') ? this.substitute(rendered) : rendered;
                const count = replaceInMessages(
                    data.chat,
                    textNeedles(global, (text) => this.substitute(text)),
                    replacement,
                );
                (count ? replaced : notFound).push(descriptor.id);
            } catch (error) {
                this.log.warn(`the copy of ${descriptor.id} was not applied`, error);
                notFound.push(descriptor.id);
            }
        }
        if (!real) return;
        this.report = { at: Date.now(), replaced, notFound };
        if (notFound.length)
            this.log.info(`copies not applied (global text not in the prompt): ${notFound.join(', ')}`);
    }

    /** What the slots of the read-only entries sent (Maestro's own are cleared after the generation). */
    private remember(): void {
        for (const descriptor of this.descriptors) {
            if (!descriptor.slot) continue;
            const value = this.slotNow(descriptor);
            if (value) this.seen.set(descriptor.slot, value);
        }
    }
}

function safe<T>(read: () => T, fallback: T, log: Logger): T {
    try {
        return read();
    } catch (error) {
        log.debug('neighbour read failed', error);
        return fallback;
    }
}
