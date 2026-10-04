// Public API of the generation-scenario engine (M34 п. 7, first used by M31 at stage 1).
// A scenario replaces the Chat Completion messages of ONE main generation (last CHAT_COMPLETION_PROMPT_READY
// listener, in place) and sets per-request parameters (CHAT_COMPLETION_SETTINGS_READY), without switching
// the active preset. See review/audit-v0.4.md T5 and research/parity-preset.md §10.
import type { GenerationInfo, Unsubscribe } from '../../shared/contracts';

export interface ScenarioMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ScenarioPlan {
    messages: ScenarioMessage[];
    params?: {
        max_tokens?: number;
        temperature?: number;
        stop?: string[];
        reasoning_effort?: string;
        include_reasoning?: boolean;
    };
}

export interface ScenarioContext {
    info: GenerationInfo;
    /** The messages ST assembled (read-only view) — scenarios may reuse parts of it. */
    original: ScenarioMessage[];
    /** Live chat (read-only). */
    chat: STChatMessage[];
}

export interface Scenario {
    id: string;
    /** True when this scenario takes over the generation. First match wins. */
    match(info: GenerationInfo): boolean;
    build(ctx: ScenarioContext): Promise<ScenarioPlan | null>;
    /** Called when the reply of a scenario generation is ready. */
    onReply?(messageIndex: number): void | Promise<void>;
    /** Optional: restrict WI entries during this generation (ENTRIES_LOADED); return false to drop an entry. */
    keepEntry?(entry: Record<string, unknown>): boolean;
}

export interface ScenariosApi {
    register(scenario: Scenario): Unsubscribe;
    /** Scenario active for the current generation, if any. */
    active(): string | null;
}
