// M38 «Проверка промпта», the capture (plan-2 §2 п. 2): what the last real turn sent as instructions, with texts.
//
// Send path (cheap): at CHAT_COMPLETION_PROMPT_READY of a real generation only references and shallow copies are
// taken — the outgoing messages array (neighbours may still change it in place: M36's copies run last), the extension
// prompt slots (Maestro's own injections are cleared after the generation, so they are copied now) and the chat's
// local variables (the flags the preset's `{{if}}` blocks read). After GENERATION_ENDED the instruction map is built
// (domain/prompt-audit-map.ts) and stored in the chat document 'prompt-audit' (size-capped), off the send path.
// A dry run («Пробная сборка») calls ST's `generate(type, {}, true)` (when the context has it): ST assembles the prompt
// and emits PROMPT_READY with dryRun true without sending it; generation interceptors do not run then, so the slots of
// the last real turn that the dry run lacks are added from it (marked).
import { fillBraces } from '../../domain/neighbour-prompts';
import { connectionFrom, modelQuirks } from '../../domain/preset-analysis-hints';
import { promptsById, resolveOrder } from '../../domain/preset-analysis-map';
import { evaluate } from '../../domain/preset-conditional-syntax';
import { buildCapture, isInstructionLore, mergeFromTurn, sanitizeCapture } from '../../domain/prompt-audit-map';
import type {
    AuditCapture,
    AuditConnection,
    AuditRole,
    RawBlock,
    RawCardField,
    RawLore,
    RawNeighbour,
    RawSlot,
} from '../../domain/prompt-audit-map';
import type { App, GenerationInfo, Logger, Unsubscribe } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { LoreJournalApi } from '../loreJournal/api';
import type { NeighbourPromptsApi } from '../neighbourPrompts/api';
import type { PresetStore } from '../presetStudio/store-api';
import type { AuditReport } from './api';

export const AUDIT_DOC_KIND = 'prompt-audit';
/** Generation types that are not a turn of the story. */
const NOT_A_TURN = new Set(['quiet', 'impersonate']);
/** How long a dry run may take before Maestro stops waiting. */
const DRY_RUN_TIMEOUT_MS = 20_000;
/** Neighbour prompts written into a known slot (found there by key, not by text). */
const NEIGHBOUR_SLOTS: Record<string, string> = {
    'nai.markers': 'nai_studio_markers',
    'desru.languageLock': 'desru_bunnymo_language',
    'ck.consistency': 'script_inject_carrot-consistency',
};

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface AuditDoc {
    v: 1;
    /** The last real turn. */
    turn: AuditCapture | null;
    /** The last test assembly. */
    dry: AuditCapture | null;
    report: AuditReport | null;
}

export function emptyAuditDoc(): AuditDoc {
    return { v: 1, turn: null, dry: null, report: null };
}

/** The document as stored (hand edits and older versions never break the audit). */
export function sanitizeDoc(raw: unknown): AuditDoc {
    const doc = emptyAuditDoc();
    if (!isDict(raw)) return doc;
    doc.turn = sanitizeCapture(raw.turn);
    doc.dry = sanitizeCapture(raw.dry);
    if (isDict(raw.report) && Array.isArray(raw.report.conflicts)) doc.report = raw.report as unknown as AuditReport;
    return doc;
}

/** What PROMPT_READY gave: references and shallow copies only. */
interface Snapshot {
    at: number;
    chatId: string | null;
    type: string;
    messages: unknown[];
    slots: RawSlot[];
    flags: Record<string, unknown>;
}

export class AuditCapturer {
    private awaiting: { type: string } | null = null;
    private pending: Snapshot | null = null;
    private dry: { snapshot: Snapshot | null } | null = null;
    private view: { chatId: string; doc: AuditDoc } | null = null;
    private loading: Promise<void> | null = null;
    private readonly listeners = new Set<() => void>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    install(own: (dispose: Unsubscribe) => void): void {
        const { host, bus } = this.app;
        const on = (key: string, handler: (...args: unknown[]) => unknown) => {
            const name = host.events.name(key);
            if (!name) {
                this.log.warn(`ST event ${key} is missing; the prompt audit cannot see it`);
                return;
            }
            own(host.events.on(name, handler));
        };
        on('GENERATION_STARTED', (type, _params, dryRun) => {
            const kind = typeof type === 'string' && type ? type : 'normal';
            if (dryRun === true) return;
            this.awaiting = NOT_A_TURN.has(kind) ? null : { type: kind };
        });
        // No place of its own among the listeners: only references are kept here, and the messages are read after
        // the generation, when every listener (M36's copies, placed last) has changed them in place.
        on('CHAT_COMPLETION_PROMPT_READY', (data) => this.onPromptReady(data));
        own(bus.on('generation:before', (info: GenerationInfo) => this.onGenerationBefore(info)));
        own(
            bus.on('generation:ended', () => {
                const snapshot = this.pending;
                this.pending = null;
                if (snapshot) void this.finalize(snapshot);
            }),
        );
        own(
            bus.on('chat:changed', () => {
                this.awaiting = null;
                this.pending = null;
                this.view = null;
                void this.ensureLoaded().then(() => this.emit());
            }),
        );
        own(() => {
            this.disposed = true;
            this.listeners.clear();
            this.pending = null;
            this.awaiting = null;
        });
        void this.ensureLoaded();
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
                this.log.error('prompt audit listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- send path */

    private onGenerationBefore(info: GenerationInfo): void {
        if (info.quiet || info.dryRun || NOT_A_TURN.has(info.type)) return;
        this.awaiting = { type: info.type };
    }

    private onPromptReady(data: unknown): void {
        if (this.disposed || !isDict(data) || !Array.isArray(data.chat)) return;
        if (data.dryRun === true) {
            if (this.dry && !this.dry.snapshot) this.dry.snapshot = this.snapshot(data.chat, 'normal');
            return;
        }
        if (data.dryRun !== false || !this.awaiting) return;
        const { type } = this.awaiting;
        this.awaiting = null;
        this.pending = this.snapshot(data.chat, type);
    }

    private snapshot(messages: unknown[], type: string): Snapshot {
        const ctx = this.app.host.ctx();
        const slots: RawSlot[] = [];
        for (const [key, prompt] of Object.entries(ctx.extensionPrompts ?? {})) {
            if (!prompt || typeof prompt.value !== 'string' || !prompt.value) continue;
            slots.push({
                key,
                value: prompt.value,
                position: Number(prompt.position),
                depth: Number(prompt.depth) || 0,
                role: Number(prompt.role) || 0,
            });
        }
        const variables = ctx.chatMetadata?.variables;
        return {
            at: Date.now(),
            chatId: this.app.host.chatId(),
            type,
            messages,
            slots,
            flags: isDict(variables) ? { ...variables } : {},
        };
    }

    /* ---------------------------------------------------------------- building */

    private async finalize(snapshot: Snapshot): Promise<void> {
        try {
            const capture = this.build(snapshot, 'turn');
            const chatId = snapshot.chatId ?? this.app.host.chatId();
            if (!chatId) return;
            await this.update(chatId, (doc) => {
                doc.turn = capture;
            });
            this.emit();
        } catch (error) {
            this.log.warn('the prompt of this turn was not captured for the audit', error);
        }
    }

    /** The instruction map of a snapshot. */
    build(snapshot: Snapshot, source: 'turn' | 'dry'): AuditCapture {
        const ctx = this.app.host.ctx();
        const substitute = (text: string): string => {
            try {
                return typeof ctx.substituteParams === 'function' ? ctx.substituteParams(text) : text;
            } catch {
                return text;
            }
        };
        const capture = buildCapture({
            at: snapshot.at,
            chatId: snapshot.chatId,
            type: snapshot.type,
            source,
            messageIndex: source === 'turn' ? Math.max(0, (ctx.chat?.length ?? 1) - 1) : undefined,
            preset: this.presetName(),
            connection: this.connection(),
            messages: snapshot.messages,
            slots: snapshot.slots,
            blocks: this.blocks(snapshot),
            card: this.cardFields(),
            neighbours: this.neighbours(),
            lore: this.lore(),
            substitute,
        });
        return capture;
    }

    private presetName(): string | undefined {
        const store = this.app.modules.api<PresetStore>('presetStore');
        try {
            const name = store?.current();
            if (name) return name;
        } catch {
            // fall through to ST's settings
        }
        const name = this.app.host.ctx().chatCompletionSettings?.preset_settings_openai;
        return typeof name === 'string' && name ? name : undefined;
    }

    private connection(): AuditConnection | null {
        const settings = this.app.host.ctx().chatCompletionSettings;
        const connection = connectionFrom(isDict(settings) ? settings : null);
        if (!connection) return null;
        return { source: connection.source, model: connection.model, quirks: [...modelQuirks(connection)] };
    }

    /** Enabled preset blocks of the working copy (layers applied), conditionals resolved with the turn's flags. */
    private blocks(snapshot: Snapshot): RawBlock[] {
        const rows: { identifier: string; enabled: boolean; prompt: Dict | null }[] = [];
        const store = this.app.modules.api<PresetStore>('presetStore');
        try {
            if (store) {
                for (const row of store.prompts()) {
                    rows.push({ identifier: row.item.identifier, enabled: row.item.enabled, prompt: row.prompt });
                }
            }
        } catch (error) {
            this.log.debug('preset store prompts', error);
        }
        if (!rows.length) {
            const settings = this.app.host.ctx().chatCompletionSettings;
            const byId = promptsById(isDict(settings) ? settings.prompts : undefined);
            for (const item of resolveOrder(isDict(settings) ? settings.prompt_order : undefined)) {
                rows.push({
                    identifier: item.identifier,
                    enabled: item.enabled !== false,
                    prompt: byId.get(item.identifier) ?? null,
                });
            }
        }
        const blocks: RawBlock[] = [];
        for (const row of rows) {
            const prompt = row.prompt;
            if (!row.enabled || !prompt || prompt.marker === true) continue;
            const content = typeof prompt.content === 'string' ? prompt.content : '';
            if (!content.trim()) continue;
            const triggers = Array.isArray(prompt.injection_trigger) ? prompt.injection_trigger : [];
            if (triggers.length && !triggers.includes(snapshot.type)) continue;
            let text = content;
            try {
                text = evaluate(content, snapshot.flags);
            } catch {
                // an unparsable conditional stays as written
            }
            const role: AuditRole = prompt.role === 'user' || prompt.role === 'assistant' ? prompt.role : 'system';
            blocks.push({
                identifier: row.identifier,
                name: typeof prompt.name === 'string' ? prompt.name : row.identifier,
                role,
                inChat: Number(prompt.injection_position) === 1,
                depth: Number.isFinite(Number(prompt.injection_depth)) ? Number(prompt.injection_depth) : 4,
                text,
            });
        }
        return blocks;
    }

    /** The card's system prompt and post-history instructions, when ST prefers them over the preset's. */
    private cardFields(): RawCardField[] {
        const ctx = this.app.host.ctx();
        if (this.app.host.isGroupChat() || ctx.characterId === undefined || ctx.characterId === '') return [];
        const character = ctx.characters?.[Number(ctx.characterId)] as unknown;
        const data = isDict(character) && isDict(character.data) ? character.data : null;
        if (!data) return [];
        const user = ctx.powerUserSettings ?? {};
        const fields: RawCardField[] = [];
        if (user.prefer_character_prompt !== false && typeof data.system_prompt === 'string') {
            fields.push({ field: 'system', text: data.system_prompt });
        }
        if (user.prefer_character_jailbreak !== false && typeof data.post_history_instructions === 'string') {
            fields.push({ field: 'postHistory', text: data.post_history_instructions });
        }
        return fields.filter((field) => field.text.trim());
    }

    /** The neighbours' prompt texts (M36), as they go out. */
    private neighbours(): RawNeighbour[] {
        const api = this.app.modules.api<NeighbourPromptsApi>('neighbourPrompts');
        if (!api) return [];
        const name = this.app.host.ctx().name1 || 'User';
        const result: RawNeighbour[] = [];
        try {
            for (const entry of api.list()) {
                if (!entry.present || entry.usedIn !== 'prompt' || entry.owner === 'maestro') continue;
                const text = fillBraces(entry.text, { userName: name });
                if (!text.trim()) continue;
                const neighbour: RawNeighbour = { id: entry.id, text };
                const slot = NEIGHBOUR_SLOTS[entry.id];
                if (slot) neighbour.slot = slot;
                result.push(neighbour);
            }
        } catch (error) {
            this.log.debug('neighbour prompts', error);
        }
        return result;
    }

    /** Lore entries of the last real turn that instruct the model (memory only: none after a reload). */
    private lore(): RawLore[] {
        const journal = this.app.modules.api<LoreJournalApi>('loreJournal');
        const contents = journal?.lastContents?.() ?? [];
        if (!contents.length) return [];
        const activations = new Map(
            (journal?.last()?.activations ?? []).map((activation) => [
                `${activation.world}#${activation.uid}`,
                activation,
            ]),
        );
        const roles = this.app.modules.api<BookRolesApi>('bookRoles');
        const result: RawLore[] = [];
        for (const content of contents) {
            const activation = activations.get(`${content.world}#${content.uid}`);
            if (activation?.cut) continue;
            const role = roles?.roleOf(content.world)?.role;
            const tags = activation?.tags ?? [];
            const bunnymo =
                tags.includes('bunnymo.core') || tags.includes('bunnymo.pack') || !!role?.startsWith('bunnymo');
            const core = tags.includes('bunnymo.core') || role === 'bunnymo.core';
            if (!isInstructionLore({ comment: content.comment, content: content.content, bunnymoCore: core })) continue;
            const entry: RawLore = {
                world: content.world,
                uid: content.uid,
                comment: content.comment,
                content: content.content,
                bunnymo,
                position: activation?.position ?? 0,
            };
            if (activation?.depth !== undefined) entry.depth = activation.depth;
            if (activation?.role !== undefined) entry.role = activation.role;
            result.push(entry);
        }
        return result;
    }

    /* ---------------------------------------------------------------- dry run */

    /** ST's generate with a dry run, when the context offers it and nothing else is generating. */
    dryRunAvailable(): boolean {
        const ctx = this.app.host.ctx();
        return (
            typeof ctx.generate === 'function' &&
            this.app.host.isChatCompletion() &&
            !this.app.host.isGroupChat() &&
            ctx.characterId !== undefined &&
            ctx.characterId !== '' &&
            !!this.app.host.chatId() &&
            !this.app.turn.current() &&
            !this.dry
        );
    }

    /** A test assembly without sending; null when ST did not assemble one. */
    async dryRun(): Promise<AuditCapture | null> {
        const ctx = this.app.host.ctx();
        if (!this.dryRunAvailable() || typeof ctx.generate !== 'function') return null;
        const chatId = this.app.host.chatId();
        const slot: { snapshot: Snapshot | null } = { snapshot: null };
        this.dry = slot;
        let timer: ReturnType<typeof setTimeout> | null = null;
        try {
            await Promise.race([
                Promise.resolve(ctx.generate('normal', {}, true)).catch((error: unknown) =>
                    this.log.warn('the test assembly failed', error),
                ),
                new Promise<void>((resolve) => {
                    timer = setTimeout(resolve, DRY_RUN_TIMEOUT_MS);
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
            if (this.dry === slot) this.dry = null;
        }
        if (!slot.snapshot || !chatId || this.app.host.chatId() !== chatId) return null;
        await this.ensureLoaded();
        const capture = mergeFromTurn(this.build(slot.snapshot, 'dry'), this.view?.doc.turn ?? null);
        await this.update(chatId, (doc) => {
            doc.dry = capture;
        });
        this.emit();
        return capture;
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
                const doc = sanitizeDoc(await this.app.chat.getFor(chatId, AUDIT_DOC_KIND, emptyAuditDoc));
                if (this.app.host.chatId() === chatId) this.view = { chatId, doc };
            })()
                .catch((error: unknown) => this.log.warn('the prompt audit could not be loaded', error))
                .finally(() => {
                    this.loading = null;
                });
        }
        await this.loading;
        if (this.app.host.chatId() !== chatId) await this.ensureLoaded();
    }

    /** The document of the chat open now (loaded), null without a chat. */
    doc(): AuditDoc | null {
        const view = this.view;
        return view && view.chatId === this.app.host.chatId() ? view.doc : null;
    }

    async update(chatId: string, change: (doc: AuditDoc) => void): Promise<void> {
        // The chat store writes the chat open now: a turn that ended after a chat switch is not stored elsewhere.
        if (this.app.host.chatId() !== chatId) {
            this.log.debug('the chat changed before the prompt audit was stored; skipped');
            return;
        }
        for (let attempt = 0; attempt < 2; attempt++) {
            const doc = sanitizeDoc(await this.app.chat.getFor(chatId, AUDIT_DOC_KIND, emptyAuditDoc));
            change(doc);
            const saved = await this.app.chat.put(AUDIT_DOC_KIND, doc);
            if (this.app.host.chatId() === chatId) this.view = { chatId, doc };
            if (saved) return;
        }
        this.log.warn('the prompt audit was not saved (another tab keeps writing it)');
    }
}
