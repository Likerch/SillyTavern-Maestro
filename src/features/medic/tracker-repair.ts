// Tracker repair (plan M3, §8 "Ремонт трекера через DES — Само"; dev-plan 1.9; audit T22, A16).
//
// DES's own update path is apiClient.updateRPGData(), but it returns at once unless DES runs in separate or external
// mode (apiClient.js:252-268), and in together mode its Refresh button is hidden. Switching DES's generationMode for
// one call would mean toggling a neighbour's setting (plan §10 forbids it; DES reads the mode from other handlers
// and may save it meanwhile). So the repair re-runs DES's update *pipeline* from DES's own pieces instead:
//   1. prompt   — promptBuilder.generateSeparateUpdatePrompt() (history + previous committed tracker + FORMAT spec),
//                 macros substituted like generateRaw does; a compact prompt of our own if that export is missing;
//   2. request  — Maestro's background client (task 'medic.trackerRepair', its own Connection Manager profile),
//                 never DES's safeGenerateRaw (that would use and possibly switch the main connection);
//   3. parse    — parser.parseResponse(), lockManager.removeLocks(), characterAliases.applyCharacterAliases();
//   4. store    — `extra.dooms_tracker_swipes[swipe_id]` as JSON strings, `lastGeneratedData` per section (+ the
//                 quests mirror via parseQuests), `committedTrackerData` only when empty — exactly what
//                 onMessageReceived/updateRPGData do; then DES's renderers and persistence.saveChatData({immediate}).
// Autonomy kind 'medic.trackerRepair' (default 'auto'); every repair is journaled and can be undone.
import { adaptersOf } from '../../adapters';
import { desSwipeRecord } from '../../domain/des-tracker';
import { stableHash } from '../../domain/hash';
import { buildCompactRepairPrompt, sameTrackerRecord, trackerMissing } from '../../domain/medic-des';
import type { App, JournalChange, LlmMessage, Logger, Proposal } from '../../shared/contracts';
import { loadDesKit } from './des-kit';
import { isPicturePost } from './sources';
import type { DesKit, DesSections } from './des-kit';

export const REPAIR_KIND = 'medic.trackerRepair';
export const TRACKER_TARGET = 'des-tracker-swipe';
const MAX_TOKENS = 2048;
const COMPACT_HISTORY = 4;

export interface RepairPayload {
    chatId: string;
    messageIndex: number;
    swipeId: number;
    /** Hash of the reply text when the repair was generated (an edit invalidates it). */
    mesHash: string;
    record: DesSections;
}

interface TrackerBefore {
    /** The raw swipe record before the repair (undefined = none). */
    record: unknown;
    lastGenerated: Partial<DesSections> | null;
}

export type RepairBlock =
    'disabled' | 'mode' | 'present' | 'message' | 'workshop' | 'busy' | 'noKit' | 'noLlm' | 'llm' | 'cap' | 'parse';

/** Reasons that need no message: nothing to repair. */
const QUIET_BLOCKS: readonly RepairBlock[] = ['disabled', 'mode', 'present', 'message'];

type Translate = (key: string, params?: Record<string, string | number>) => string;

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function swipeIdOf(message: STChatMessage): number {
    return typeof message.swipe_id === 'number' && message.swipe_id >= 0 ? message.swipe_id : 0;
}

function sectionsOf(value: Record<string, unknown> | null): Partial<DesSections> | null {
    if (!value) return null;
    const pick = (raw: unknown) => (typeof raw === 'string' ? raw : null);
    return {
        quests: pick(value.quests),
        infoBox: pick(value.infoBox),
        characterThoughts: pick(value.characterThoughts),
    };
}

function llmRole(role: string): LlmMessage['role'] {
    return role === 'assistant' || role === 'user' ? role : 'system';
}

export class TrackerRepair {
    private kitPromise: Promise<DesKit | null> | null = null;
    private readonly running = new Set<string>();

    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly t: Translate,
    ) {}

    /** DES's modules (cached; a failed load is retried next time). */
    kit(): Promise<DesKit | null> {
        if (!this.kitPromise) {
            const pending = loadDesKit(this.app, this.log).catch((error: unknown) => {
                this.log.warn('DES modules could not be loaded', error);
                return null;
            });
            this.kitPromise = pending;
            void pending.then((kit) => {
                if (!kit && this.kitPromise === pending) this.kitPromise = null;
            });
        }
        return this.kitPromise;
    }

    /** Why a repair of this message cannot run now, or DES's modules when it can. */
    async blocker(index: number): Promise<{ block: RepairBlock } | { kit: DesKit }> {
        const des = adaptersOf(this.app).des;
        if (!des.present() || !des.enabled()) return { block: 'disabled' };
        if (des.generationMode() !== 'together') return { block: 'mode' };
        if (!expectsTracker(des.settings())) return { block: 'disabled' };
        const chat = this.app.host.ctx().chat;
        const message = chat[index];
        if (!message || message.is_user || message.is_system || !this.isLatestTurn(index)) return { block: 'message' };
        if (!trackerMissing(desSwipeRecord(message))) return { block: 'present' };
        if (des.isWorkshopOpen()) return { block: 'workshop' };
        if (this.app.turn.current() !== null) return { block: 'busy' };
        const kit = await this.kit();
        if (!kit) return { block: 'noKit' };
        if (kit.isGenerating()) return { block: 'busy' };
        if (kit.isSynthetic(message)) return { block: 'message' };
        if (!this.app.llm.available(REPAIR_KIND)) return { block: 'noLlm' };
        return { kit };
    }

    /** Reply handler path: generate, then let the autonomy level decide (default 'auto'). */
    async auto(index: number): Promise<void> {
        if (this.app.autonomy.level(REPAIR_KIND, 'auto') === 'off') return;
        const key = this.runKey(index);
        if (!key || this.running.has(key)) return;
        this.running.add(key);
        try {
            const check = await this.blocker(index);
            if ('block' in check) {
                if (!QUIET_BLOCKS.includes(check.block)) this.reportFailure(index, check.block);
                return;
            }
            const result = await this.generate(index, check.kit);
            if ('block' in result) {
                this.reportFailure(index, result.block);
                return;
            }
            const decision = await this.app.autonomy.decide(this.proposal(result, check.kit), 'auto');
            if (decision === 'applied') {
                this.app.ui.notice(this.t('m3.repair.done', { index: index + 1 }), { level: 'info' });
            }
        } catch (error) {
            this.log.error('tracker repair failed', error);
            this.reportFailure(index, 'llm');
        } finally {
            this.running.delete(key);
        }
    }

    /** "Починить": the user asked, so the result is applied at once (and journaled). */
    async manual(index: number): Promise<boolean> {
        const key = this.runKey(index);
        if (!key || this.running.has(key)) return false;
        this.running.add(key);
        try {
            const check = await this.blocker(index);
            if ('block' in check) {
                if (check.block !== 'present') this.reportFailure(index, check.block, false);
                return check.block === 'present';
            }
            const result = await this.generate(index, check.kit);
            if ('block' in result) {
                this.reportFailure(index, result.block, false);
                return false;
            }
            const proposal = this.proposal(result, check.kit);
            await this.apply(result);
            await this.app.journal.record({
                module: 'M3',
                kind: REPAIR_KIND,
                summary: proposal.title,
                changes: proposal.changes,
                sourceMessage: index,
            });
            this.app.ui.notice(this.t('m3.repair.done', { index: index + 1 }), { level: 'info' });
            return true;
        } catch (error) {
            this.log.error('tracker repair failed', error);
            this.reportFailure(index, 'llm', false);
            return false;
        } finally {
            this.running.delete(key);
        }
    }

    /** Asks the model for the tracker of the reply and parses it with DES's parser. */
    async generate(index: number, kit: DesKit): Promise<RepairPayload | { block: RepairBlock }> {
        const ctx = this.app.host.ctx();
        const chatId = this.app.host.chatId();
        const message = ctx.chat[index];
        if (!chatId || !message) return { block: 'message' };
        const messages = await this.prompt(index, kit);
        const response = await this.app.llm.request({ task: REPAIR_KIND, messages, maxTokens: MAX_TOKENS });
        if (!response.ok || typeof response.text !== 'string' || !response.text.trim()) {
            return { block: response.error === 'cap' ? 'cap' : 'llm' };
        }
        const parsed = kit.parse(response.text);
        if (!parsed || parsed.parsingFailed || trackerMissing(parsed)) return { block: 'parse' };
        // The chat may have moved on while the model answered.
        if (this.app.host.chatId() !== chatId || ctx.chat[index] !== message) return { block: 'message' };
        return {
            chatId,
            messageIndex: index,
            swipeId: swipeIdOf(message),
            mesHash: stableHash(message.mes ?? ''),
            record: kit.normalise(parsed),
        };
    }

    private async prompt(index: number, kit: DesKit): Promise<LlmMessage[]> {
        const ctx = this.app.host.ctx();
        try {
            const built = await kit.updatePrompt();
            if (built?.length) {
                // generateRaw substitutes macros ({{persona}}, {{user}}…) in every message; do the same.
                return built.map((item) => ({ role: llmRole(item.role), content: ctx.substituteParams(item.content) }));
            }
        } catch (error) {
            this.log.warn('DES update prompt failed; using the compact prompt', error);
        }
        const des = adaptersOf(this.app).des;
        const settings = des.settings() ?? {};
        const history = ctx.chat
            .slice(Math.max(0, index + 1 - COMPACT_HISTORY), index + 1)
            .filter((item) => !item.is_system)
            .map((item) => ({ isUser: item.is_user, text: String(item.mes ?? '') }));
        let previous = null;
        for (let i = index - 1; i >= 0 && !previous; i--) {
            const record = desSwipeRecord(ctx.chat[i]);
            if (record && !trackerMissing(record)) previous = record;
        }
        return buildCompactRepairPrompt({
            history,
            previous,
            sections: {
                quests: settings.showQuests === true,
                infoBox: settings.showInfoBox !== false,
                characters: settings.showCharacterThoughts !== false,
            },
            userName: ctx.name1 || 'User',
        });
    }

    /** The proposal handed to autonomy (also the source of the journal record). */
    proposal(payload: RepairPayload, kit: DesKit | null): Proposal<RepairPayload> {
        const message = this.app.host.ctx().chat[payload.messageIndex];
        const swipes = message?.extra?.dooms_tracker_swipes;
        const raw = isDict(swipes) ? swipes[String(payload.swipeId)] : undefined;
        const before: TrackerBefore = {
            record: raw === undefined ? null : raw,
            lastGenerated: sectionsOf(kit?.lastGenerated() ?? null),
        };
        const change: JournalChange = {
            target: TRACKER_TARGET,
            ref: { chatId: payload.chatId, messageIndex: payload.messageIndex, swipeId: payload.swipeId },
            before,
            after: { record: payload.record },
        };
        return {
            module: 'M3',
            kind: REPAIR_KIND,
            title: this.t('m3.repair.title', { index: payload.messageIndex + 1 }),
            description: this.t('m3.repair.description'),
            changes: [change],
            payload,
            sourceMessage: payload.messageIndex,
            apply: (value) => this.apply(value),
            stillValid: () => this.stillValid(payload),
        };
    }

    /** The reply is unchanged (same chat, message, swipe and text) and still has no tracker. */
    async stillValid(payload: unknown): Promise<boolean> {
        if (!isRepairPayload(payload)) return false;
        if (this.app.host.chatId() !== payload.chatId) return false;
        const message = this.app.host.ctx().chat[payload.messageIndex];
        if (!message || message.is_user || swipeIdOf(message) !== payload.swipeId) return false;
        if (stableHash(message.mes ?? '') !== payload.mesHash) return false;
        return trackerMissing(desSwipeRecord(message));
    }

    /** Writes the repaired tracker the way DES stores a parsed reply. */
    async apply(payload: unknown): Promise<void> {
        if (!isRepairPayload(payload) || !(await this.stillValid(payload))) {
            throw new Error('the reply changed; the tracker repair is out of date');
        }
        const chat = this.app.host.ctx().chat;
        const message = chat[payload.messageIndex] as STChatMessage;
        const kit = await this.kit();
        const extra = (message.extra ??= {});
        const swipes = isDict(extra.dooms_tracker_swipes) ? extra.dooms_tracker_swipes : {};
        extra.dooms_tracker_swipes = swipes;
        swipes[String(payload.swipeId)] = { ...payload.record };
        if (kit && this.isLatestReply(payload.messageIndex)) kit.adopt(payload.record, String(message.mes ?? ''));
        await this.persist(kit, payload.record, payload.messageIndex);
    }

    /** Undo handler of TRACKER_TARGET: puts the previous record (and DES's display state) back. */
    async undo(change: JournalChange): Promise<boolean> {
        const ref = change.ref as { chatId?: unknown; messageIndex?: unknown; swipeId?: unknown };
        const after = isDict(change.after) ? (change.after.record as DesSections | undefined) : undefined;
        const before = (isDict(change.before) ? change.before : {}) as Partial<TrackerBefore>;
        if (typeof ref.messageIndex !== 'number' || typeof ref.swipeId !== 'number' || !after) return false;
        if (this.app.host.chatId() !== ref.chatId) return false;
        const message = this.app.host.ctx().chat[ref.messageIndex];
        const swipes = message?.extra?.dooms_tracker_swipes;
        const key = String(ref.swipeId);
        if (!message || !isDict(swipes) || !sameTrackerRecord(swipes[key] as DesSections, after)) return false;
        if (before.record === null || before.record === undefined) delete swipes[key];
        else swipes[key] = before.record;
        const kit = await this.kit();
        if (kit && this.isLatestReply(ref.messageIndex) && before.lastGenerated) {
            const current = sectionsOf(kit.lastGenerated());
            if (current && sameTrackerRecord(current, after)) kit.restoreLastGenerated(before.lastGenerated);
        }
        await this.persist(kit, before.lastGenerated ?? {}, ref.messageIndex);
        return true;
    }

    private async persist(kit: DesKit | null, rendered: Partial<DesSections>, index: number): Promise<void> {
        if (kit) {
            kit.render(rendered, index);
            await kit.save();
        } else {
            await this.app.host.ctx().saveChat();
        }
    }

    /** No assistant reply after this one: DES's display state belongs to it. */
    private isLatestReply(index: number): boolean {
        const chat = this.app.host.ctx().chat;
        for (let i = chat.length - 1; i > index; i--) {
            const message = chat[i];
            if (message && !message.is_user && !message.is_system && !isPicturePost(message)) return false;
        }
        return true;
    }

    /** Nothing but NAI picture posts came after the reply: the user has not answered it yet. */
    private isLatestTurn(index: number): boolean {
        const chat = this.app.host.ctx().chat;
        for (let i = chat.length - 1; i > index; i--) {
            const message = chat[i];
            if (message && !message.is_system && !isPicturePost(message)) return false;
        }
        return true;
    }

    private runKey(index: number): string | null {
        const chatId = this.app.host.chatId();
        const message = this.app.host.ctx().chat[index];
        return chatId && message ? `${chatId}:${index}:${swipeIdOf(message)}` : null;
    }

    private reportFailure(index: number, block: RepairBlock, offerFix = true): void {
        const text = this.t('m3.repair.failed', { index: index + 1, reason: this.t(`m3.repair.block.${block}`) });
        this.app.ui.notice(
            text,
            offerFix
                ? { level: 'warn', action: { label: this.t('m3.repair.fix'), run: () => void this.manual(index) } }
                : { level: 'warn' },
        );
    }
}

/**
 * DES asks for a tracker at all: some section is shown (DES defaults: info box and characters on, quests off).
 * With every section hidden DES's prompt asks for nothing (apiClient.js:262-268).
 */
export function expectsTracker(settings: Record<string, unknown> | null): boolean {
    if (!settings) return true;
    return settings.showInfoBox !== false || settings.showCharacterThoughts !== false || settings.showQuests === true;
}

export function isRepairPayload(value: unknown): value is RepairPayload {
    if (!isDict(value)) return false;
    return (
        typeof value.chatId === 'string' &&
        typeof value.messageIndex === 'number' &&
        typeof value.swipeId === 'number' &&
        typeof value.mesHash === 'string' &&
        isDict(value.record)
    );
}
