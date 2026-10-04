// M20 at CHAT_COMPLETION_PROMPT_READY (listener placed last, so the prompt is final): injection budgets (п. 1) and
// consented duplicate drops for injections (п. 4) are applied to the assembled messages — never to the neighbours'
// extension prompt slots, which stay as their owners set them — and a capture is kept for the read-only analysis
// that runs right after (duplicates, P16 order). Budgets act on:
// - 'ckRag'  → `carrotkernel_rag` (CK's RAG chunks; whole chunks from the end, then sentences);
// - 'qvink'  → `qvink_memory_short` (oldest memories first; `qvink_memory_long` is never touched);
// - 'des'    → `dooms-tracker-context` only (DES's optional <context> summary; instructions, format, the example
//              tracker, HTML/colour prompts, Doom Counter and Workshop slots are never cut).
// Counts are estimates (P15: nothing awaits the tokenizer here).
import { qvinkShortMemories, findInMessages, messageTextParts, spliceText } from '../../domain/architect-prompt';
import type { TextHit } from '../../domain/architect-prompt';
import {
    estimateText,
    removeSentences,
    trimMemoryInjection,
    trimRagInjection,
    trimToTokens,
} from '../../domain/architect-text';
import type { TrimResult } from '../../domain/architect-text';
import { estimateTokens } from '../../domain/rules-lore';
import type { App, Logger } from '../../shared/contracts';
import type { BudgetSource, BudgetStatus, DroppedCopy, InjectionTrim } from './api';
import type { ConsentStore } from './consents';
import type { ArchitectSettings } from './settings';
import { BUDGET_SOURCES } from './settings';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Extension prompt keys the injection budgets act on. */
export const BUDGET_SLOTS: Partial<Record<BudgetSource, string>> = {
    ckRag: 'carrotkernel_rag',
    qvink: 'qvink_memory_short',
    des: 'dooms-tracker-context',
    voices: 'maestro_voices',
};

/** Sources of later stages: the budget is stored, there is nothing to measure yet. */
export const FUTURE_SOURCES: ReadonlySet<BudgetSource> = new Set(['mechanics', 'director']);

/** Sources that fit themselves to the budget (M15 reads it): measured here, never shortened. */
export const SELF_FITTING: ReadonlySet<BudgetSource> = new Set(['voices']);

/** ST extension_prompt_types.NONE: never injected. */
const POSITION_NONE = -1;

export interface BudgetRow {
    source: BudgetSource;
    limit: number;
    used: number;
    cut: number;
    status: BudgetStatus;
}

export interface SlotCapture {
    key: string;
    /** The text as it went to the model (after M20's own trims and drops). */
    value: string;
    position: number;
    depth: number;
    role: number;
}

export interface LoreCapture {
    world: string;
    uid: number;
    content: string;
    entry: Dict;
}

export interface PromptCapture {
    at: number;
    chatId: string | null;
    /** The final messages (ST's array, read-only from here on). */
    messages: unknown[];
    slots: SlotCapture[];
    lore: LoreCapture[];
    budgets: BudgetRow[];
    trims: InjectionTrim[];
    dropped: DroppedCopy[];
}

/** Replaces the text of one part of a message (string content, or a new array with a new text part). */
export function setPartText(message: unknown, part: number, text: string): void {
    if (!isDict(message)) return;
    if (typeof message.content === 'string') {
        message.content = text;
        return;
    }
    if (Array.isArray(message.content)) {
        const parts = [...message.content];
        const old = parts[part];
        if (!isDict(old)) return;
        parts[part] = { ...old, text };
        message.content = parts;
    }
}

export class PromptStage {
    private activated: unknown[] | null = null;

    constructor(
        private readonly app: App,
        private readonly settings: () => ArchitectSettings,
        private readonly consents: ConsentStore,
        private readonly log: Logger,
    ) {}

    /** A new generation: the lore of the previous one is not this prompt's. */
    reset(): void {
        this.activated = null;
    }

    /** WORLD_INFO_ACTIVATED (non-dry scans): the entries that reached the prompt, contents macro-substituted. */
    onActivated(entries: unknown): void {
        this.activated = Array.isArray(entries) ? entries : null;
    }

    private substitute(text: string): string {
        try {
            return this.app.host.ctx().substituteParams(text);
        } catch {
            return text;
        }
    }

    /**
     * Where a slot's text landed: as set, trimmed (ST trims in-chat injections) or macro-substituted. `form` turns
     * the slot text into the found form, so a replacement can be put in the same shape.
     */
    locate(messages: readonly unknown[], value: string): { hit: TextHit; form: (text: string) => string } | null {
        const forms: ((text: string) => string)[] = [(text) => text, (text) => text.trim()];
        if (value.includes('{{')) forms.push((text) => this.substitute(text.trim()));
        for (const form of forms) {
            const needle = form(value);
            if (!needle.trim()) continue;
            const hit = findInMessages(messages, [needle]);
            if (hit) return { hit, form };
        }
        return null;
    }

    /**
     * Splices the replacement into the message; a plain message left empty leaves the prompt (ST's getChat() drops
     * empty messages too, and `data.chat` is the very array ST sends).
     */
    private replace(messages: unknown[], hit: TextHit, replacement: string): void {
        const message = messages[hit.message];
        const current = messageTextParts(message)[hit.part] ?? '';
        const next = spliceText(current, hit.start, hit.needle.length, replacement);
        setPartText(message, hit.part, next);
        if (isDict(message) && typeof message.content === 'string' && !next.trim() && !message.tool_calls) {
            messages.splice(hit.message, 1);
        }
    }

    private trim(source: BudgetSource, value: string, limit: number): TrimResult {
        if (source === 'ckRag') return trimRagInjection(value, limit, estimateText);
        if (source === 'qvink') {
            const chat = (this.app.host.ctx().chat ?? []) as unknown[];
            return (
                trimMemoryInjection(value, qvinkShortMemories(chat), limit, estimateText) ??
                trimToTokens(value, limit, { from: 'start', unit: 'sentence', keepFirst: true, count: estimateText })
            );
        }
        return trimToTokens(value, limit, { from: 'start', unit: 'sentence', count: estimateText });
    }

    /** CHAT_COMPLETION_PROMPT_READY (non-dry): budgets and consented drops on the final messages; the capture. */
    onPromptReady(data: unknown): PromptCapture | null {
        if (!isDict(data) || data.dryRun !== false || !Array.isArray(data.chat)) return null;
        const messages = data.chat as unknown[];
        const prompts = this.app.host.ctx().extensionPrompts ?? {};
        const settings = this.settings();
        const budgets: BudgetRow[] = [];
        const trims: InjectionTrim[] = [];
        const finals = new Map<string, string>();

        for (const source of BUDGET_SOURCES) {
            if (source === 'lore') continue;
            const limit = settings.budgets[source];
            if (FUTURE_SOURCES.has(source)) {
                budgets.push({ source, limit, used: 0, cut: 0, status: limit > 0 ? 'noSource' : 'off' });
                continue;
            }
            const key = BUDGET_SLOTS[source] as string;
            const slot = prompts[key];
            const value =
                slot && Number(slot.position) !== POSITION_NONE && typeof slot.value === 'string' ? slot.value : '';
            if (!value.trim()) {
                budgets.push({ source, limit, used: 0, cut: 0, status: limit > 0 ? 'empty' : 'off' });
                continue;
            }
            const before = estimateText(value);
            if (!(limit > 0)) {
                budgets.push({ source, limit, used: before, cut: 0, status: 'off' });
                continue;
            }
            if (before <= limit) {
                budgets.push({ source, limit, used: before, cut: 0, status: 'ok' });
                continue;
            }
            if (SELF_FITTING.has(source)) {
                budgets.push({ source, limit, used: before, cut: 0, status: 'over' });
                continue;
            }
            const found = this.locate(messages, value);
            if (!found) {
                budgets.push({ source, limit, used: before, cut: 0, status: 'notFound' });
                continue;
            }
            const result = this.trim(source, value, limit);
            try {
                this.replace(messages, found.hit, result.text ? found.form(result.text) : '');
            } catch (error) {
                this.log.warn(`could not shorten ${key}`, error);
                budgets.push({ source, limit, used: before, cut: 0, status: 'notFound' });
                continue;
            }
            finals.set(key, result.text);
            budgets.push({
                source,
                limit,
                used: result.after,
                cut: Math.max(0, before - result.after),
                status: result.after <= limit ? 'trimmed' : 'over',
            });
            trims.push({ source, key, before, after: result.after, units: result.removed });
        }

        const dropped = this.dropConsented(messages, prompts, finals);

        const slots: SlotCapture[] = [];
        for (const [key, slot] of Object.entries(prompts)) {
            if (!slot || typeof slot.value !== 'string' || !slot.value.trim()) continue;
            if (Number(slot.position) === POSITION_NONE) continue;
            slots.push({
                key,
                value: finals.get(key) ?? slot.value,
                position: Number(slot.position),
                depth: Number(slot.depth) || 0,
                role: Number(slot.role) || 0,
            });
        }
        const lore: LoreCapture[] = [];
        for (const raw of this.activated ?? []) {
            if (!isDict(raw) || typeof raw.world !== 'string') continue;
            lore.push({
                world: raw.world,
                uid: Number(raw.uid),
                content: typeof raw.content === 'string' ? raw.content : '',
                entry: raw,
            });
        }
        return { at: Date.now(), chatId: this.app.host.chatId(), messages, slots, lore, budgets, trims, dropped };
    }

    /** Facts the user chose to keep elsewhere leave the injections that repeat them (inside the slot's text only). */
    private dropConsented(
        messages: unknown[],
        prompts: NonNullable<STContext['extensionPrompts']>,
        finals: Map<string, string>,
    ): DroppedCopy[] {
        const dropped: DroppedCopy[] = [];
        const drops = this.consents.slotDrops();
        if (!drops.size) return dropped;
        for (const [key, keys] of drops) {
            const slot = prompts[key];
            if (!slot || Number(slot.position) === POSITION_NONE) continue;
            const value = finals.get(key) ?? (typeof slot.value === 'string' ? slot.value : '');
            if (!value.trim()) continue;
            const found = this.locate(messages, value);
            if (!found) continue;
            const result = removeSentences(found.hit.needle, keys);
            if (!result.removed) continue;
            this.replace(messages, found.hit, result.text);
            finals.set(key, removeSentences(value, keys).text);
            const consent = this.consents.consentFor(key)[0];
            dropped.push({
                duplicateId: consent?.id ?? '',
                owner: consent?.sources.find((source) => source.ref === key)?.owner ?? 'other',
                ref: key,
                tokens: estimateTokens(result.removedChars),
            });
        }
        return dropped;
    }
}
