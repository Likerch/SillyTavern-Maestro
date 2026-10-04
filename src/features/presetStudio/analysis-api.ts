// Preset analysis and the prompt map (M34 п.1, п.3, п.9; stage 5). Read-only. Exposed as
// app.modules.api<PresetAnalysisApi>('presetAnalysis').
import type { PresetBody } from './store-api';

/** One slot of the assembled prompt as ST builds it (research/parity-preset.md §5.1). */
export interface MapSlot {
    identifier: string;
    name: string;
    role: 'system' | 'user' | 'assistant';
    /** 'relative' blocks in order, 'depth' blocks inside the chat history. */
    placement: 'relative' | 'depth';
    depth?: number;
    order?: number;
    tokens: number;
    enabled: boolean;
    /** Marker blocks (chatHistory, worldInfoBefore, …) and where extension injections land. */
    marker: boolean;
    /** Extension prompts that go here (DES, CK, Qvink, NAI, DES-RU, Maestro…), by owner. */
    injections: MapInjection[];
    /** Why an enabled block would still not be sent (strict types, triggers, missing marker…). */
    dropped?: string;
    /** Machine-readable reason behind `dropped`. */
    droppedCode?: string;
    /** Remarks that do not drop the block (moved after the history, glued with other in-chat blocks, …), translated. */
    note?: string;
    /** Machine-readable remarks behind `note`. */
    noteCodes?: string[];
    /** Where `tokens` came from: ST's Prompt Manager counts of the last assembly, or Maestro's own count. */
    tokensFrom?: 'st' | 'count';
    /** Generation types the block is limited to (empty/absent = all). */
    triggers?: string[];
}

/** An extension prompt that lands in a slot. */
export interface MapInjection {
    owner: string;
    key: string;
    tokens: number;
    /** Inside main (before/after its text) or in the history at a depth. */
    where?: 'start' | 'end' | 'chat';
    depth?: number;
    role?: 'system' | 'user' | 'assistant';
}

export type FindingKind =
    | 'neverIncluded'
    | 'typeMismatch'
    | 'contradiction'
    | 'duplicateWithLore'
    | 'duplicateWithInjection'
    | 'duplicateBlock'
    | 'heavyBlock'
    | 'unsaved'
    | 'macroEngineOff'
    | 'modelQuirk'
    | 'emptyMessage';

export interface PresetFinding {
    kind: FindingKind;
    severity: 'info' | 'warn';
    identifier?: string;
    text: string;
    /** The other block of a pair (contradictions, duplicate blocks). */
    otherIdentifier?: string;
}

export interface ProviderHint {
    /** OpenRouter provider or model family the hint is about (e.g. 'deepseek/deepseek-v4-flash'). */
    model: string;
    text: string;
    /** Machine-readable hint id (`reasoningOff`, `prefillEos`, `temperature`, …). */
    key?: string;
}

/** Options of map() and findings(). */
export interface PresetAnalysisOptions {
    /** Generation type the prompt is assembled for (default 'normal'; triggers depend on it). */
    type?: string;
}

export interface PresetAnalysisApi {
    /** The prompt map of the working copy (tokens via ST's tokenizer, cached by text hash). */
    map(body?: PresetBody, options?: PresetAnalysisOptions): Promise<MapSlot[]>;
    findings(body?: PresetBody, options?: PresetAnalysisOptions): Promise<PresetFinding[]>;
    /** Model/provider specifics for the current connection (DeepSeek V4: prefill via OpenRouter, mid-history system). */
    hints(): ProviderHint[];
}
