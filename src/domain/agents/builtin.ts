// Built-in agents (plan §2, §4.8, release 1.29): Maestro's own model tasks with their instruction, model and frequency
// open to the user. The module keeps building its request, its answer form and what it does with the answer; the
// user's instruction is put in place of the default text inside the request (an exact match), or added after it. The
// answer form never changes (plan А6), so an edited instruction cannot break how the answer is applied.
import { stableHash } from '../hash';

export type InstructionMode = 'default' | 'addition' | 'full';

/** What the user changed in a built-in agent. */
export interface BuiltInOverride {
    mode: InstructionMode;
    /** «Дополнительные указания» (mode 'addition'). */
    addition?: string;
    /** The whole instruction (mode 'full'). */
    full?: string;
    /** Hash of the default text the user's full text was made from («Текст по умолчанию изменился — сравнить»). */
    baseHash?: string;
    /** The default text the full text was made from (to compare when it changed). */
    baseText?: string;
    temperature?: number;
    maxTokens?: number;
    reasoning?: 'off' | 'low' | 'medium' | 'high';
}

export interface RequestMessage {
    role: string;
    content: string;
}

export const ADDITION_HEADER =
    'Additional instructions from the player (follow them as long as they do not change the required answer format):';

export function textHash(text: string): string {
    return stableHash(text);
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Turns stored data into an override; null when it says nothing. */
export function sanitizeOverride(raw: unknown): BuiltInOverride | null {
    if (!isDict(raw)) return null;
    const mode: InstructionMode = raw.mode === 'addition' || raw.mode === 'full' ? raw.mode : 'default';
    const out: BuiltInOverride = { mode };
    if (typeof raw.addition === 'string' && raw.addition.trim()) out.addition = raw.addition.slice(0, 8000);
    if (typeof raw.full === 'string' && raw.full.trim()) out.full = raw.full.slice(0, 40_000);
    if (typeof raw.baseHash === 'string') out.baseHash = raw.baseHash;
    if (typeof raw.baseText === 'string') out.baseText = raw.baseText.slice(0, 40_000);
    if (typeof raw.temperature === 'number' && Number.isFinite(raw.temperature))
        out.temperature = Math.min(2, Math.max(0, raw.temperature));
    if (typeof raw.maxTokens === 'number' && Number.isFinite(raw.maxTokens))
        out.maxTokens = Math.round(Math.min(16_000, Math.max(50, raw.maxTokens)));
    if (raw.reasoning === 'off' || raw.reasoning === 'low' || raw.reasoning === 'medium' || raw.reasoning === 'high')
        out.reasoning = raw.reasoning;
    const changesNothing =
        (out.mode === 'default' || (out.mode === 'addition' && !out.addition) || (out.mode === 'full' && !out.full)) &&
        out.temperature === undefined &&
        out.maxTokens === undefined &&
        out.reasoning === undefined &&
        !out.addition &&
        !out.full;
    return changesNothing ? null : out;
}

/** The instruction the request will carry instead of the default text. */
export function effectiveInstruction(defaultText: string, override: BuiltInOverride | null | undefined): string {
    if (!override) return defaultText;
    if (override.mode === 'full' && override.full?.trim()) return override.full;
    if (override.mode === 'addition' && override.addition?.trim())
        return `${defaultText}\n\n${ADDITION_HEADER}\n${override.addition.trim()}`;
    return defaultText;
}

export interface ApplyResult {
    messages: RequestMessage[];
    /** Where the instruction went: in place of the default text, or as a message of its own (text not found). */
    placed: 'replaced' | 'appended' | 'unchanged';
}

/**
 * Puts the user's instruction into a request: the first message holding the default text gets it in its place; when
 * no message holds it (the module changed its text), the addition or the full text goes as a system message right
 * before the last message. Nothing changes without an instruction override.
 */
export function applyInstruction(
    messages: readonly RequestMessage[],
    defaultTexts: readonly string[],
    override: BuiltInOverride | null | undefined,
): ApplyResult {
    if (!override || override.mode === 'default') return { messages: [...messages], placed: 'unchanged' };
    if (override.mode === 'addition' && !override.addition?.trim())
        return { messages: [...messages], placed: 'unchanged' };
    if (override.mode === 'full' && !override.full?.trim()) return { messages: [...messages], placed: 'unchanged' };
    for (const text of defaultTexts) {
        if (!text) continue;
        const index = messages.findIndex((message) => message.content.includes(text));
        if (index < 0) continue;
        const out = messages.map((message) => ({ ...message }));
        const target = out[index]!;
        target.content = target.content.replace(text, () => effectiveInstruction(text, override));
        return { messages: out, placed: 'replaced' };
    }
    const extra =
        override.mode === 'full' ? (override.full ?? '') : `${ADDITION_HEADER}\n${(override.addition ?? '').trim()}`;
    const out = messages.map((message) => ({ ...message }));
    out.splice(Math.max(0, out.length - 1), 0, { role: 'system', content: extra });
    return { messages: out, placed: 'appended' };
}

/** The default text changed since the user's full text was made from it. */
export function defaultChanged(override: BuiltInOverride | null | undefined, defaultText: string): boolean {
    return Boolean(override?.mode === 'full' && override.baseHash && override.baseHash !== textHash(defaultText));
}
