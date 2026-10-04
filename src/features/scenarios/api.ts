// Public API of the generation-scenario engine (M34 п. 7, first used by M31 at stage 1).
// A scenario replaces the Chat Completion messages of ONE main generation (last CHAT_COMPLETION_PROMPT_READY
// listener, in place) and sets per-request parameters (CHAT_COMPLETION_SETTINGS_READY), without switching
// the active preset. See review/audit-v0.4.md T5 and research/parity-preset.md §10.
// Stage 5 (M34 п. 7, п. 9): parameters per scenario (descriptors + the `scenarioParams` settings slice) and two
// built-in scenarios, «impersonate» and «continue», off by default.
import type { ScenarioParamValues } from '../../domain/scenario-builtins';
import type { ScenarioParams } from '../../domain/scenario-params';
import type { GenerationInfo, Unsubscribe } from '../../shared/contracts';

export type { ScenarioParamValues } from '../../domain/scenario-builtins';
export type { ScenarioParams } from '../../domain/scenario-params';

export interface ScenarioMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ScenarioPlan {
    /** Messages that replace ST's prompt (not used with `keepPrompt`). */
    messages: ScenarioMessage[];
    /** ST's prompt goes out as assembled; only `params` are set (needs at least one parameter). */
    keepPrompt?: boolean;
    params?: ScenarioParams;
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

/** A scenario whose parameters the user can edit (M34 п. 9): data for the studio UI. */
export interface ScenarioDescriptor {
    id: string;
    /** i18n key of the title. */
    titleKey: string;
    /** i18n key of a one-line description. */
    descriptionKey?: string;
    /** Generation types the scenario takes over. */
    types: string[];
    /** Values used when the user has set nothing (`enabled` present = the scenario can be switched off). */
    defaults: ScenarioParamValues;
    /** Parameters the UI offers, in display order. */
    fields: (keyof ScenarioParamValues)[];
}

export interface ScenariosApi {
    register(scenario: Scenario): Unsubscribe;
    /** Scenario active for the current generation, if any. */
    active(): string | null;
    /** Descriptors of the scenarios with editable parameters (built-ins first). */
    list?(): ScenarioDescriptor[];
    /** Effective parameters of a scenario: its defaults with the user's values on top; null for an unknown id. */
    params?(id: string): ScenarioParamValues | null;
    /** Stores the user's values of a scenario (merged; null resets it to the defaults) in `scenarioParams`. */
    setParams?(id: string, values: Partial<ScenarioParamValues> | null): void;
    /** Adds a descriptor for a scenario of another module (its parameters are then kept in `scenarioParams`). */
    describe?(descriptor: ScenarioDescriptor): Unsubscribe;
}
