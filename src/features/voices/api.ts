// Character voices (M15, stage 8): a compact card for every PRESENT character — speech manner (BunnyMo LING tags),
// MBTI state (CK does not see MBTI tags), attitude to the persona now (M19), current goals; later stages add what
// the character does not know (9) and stats (11). Cards go near the end of the prompt (P16). When cards are on,
// Maestro silences CarrotKernel's «Character Consistency» injection while assembling the prompt (CK settings are not
// touched — quiet mode, plan §2.2) and asks DES-RU to stop rebuilding it (DES-RU 0.8 `setMaestroOwned`
// 'ck.consistencyRebuild'). Exposed as app.modules.api<VoicesApi>('voices').
import type { Unsubscribe } from '../../shared/contracts';

export interface VoiceCard {
    /** Canonical name (world model). */
    name: string;
    entityId?: string;
    /** «Speech: …» from LING tags (and the archive's Linguistics block), English. */
    speech: string;
    /** MBTI type with H/U and a short state line. */
    mbti?: string;
    /** Attitude to the persona now (relations M19 / DES). */
    attitude?: string;
    /** Current goals (DES thoughts/goals, canon). */
    goals?: string;
    /** Stage 9: what the character does not know. */
    unknown?: string;
    /** Rendered text of the card as injected. */
    text: string;
    tokens: number;
    // Additions of the M15 implementation (optional).
    /** Stage 11: stats. */
    stats?: string;
}

/** What happened to CK's «Character Consistency» insert in a generation with cards. */
export type CkInsertOutcome = 'removed' | 'absent' | 'notFound';

export interface VoicesQuietState {
    /** Cards are ready for the next real generation, so CK's insert will be taken out of its prompt. */
    armed: boolean;
    /** The last generation with cards: CK's insert removed, CK sent none, or its text was not found (null: none yet). */
    ck: { outcome: CkInsertOutcome; at: number; tokens: number } | null;
    /** DES-RU was told to stop rebuilding CK's insert; 'absent' — no DES-RU API (DES-RU older than 0.8 or off). */
    desru: 'told' | 'notTold' | 'absent';
}

/** The injection for the next generation. */
export interface VoicesInjection {
    text: string;
    tokens: number;
    /** Tokens allowed: the architect's 'voices' budget when set, else the module's own cap. */
    budget: number;
    budgetSource: 'architect' | 'cap';
    /** Trimming steps applied to fit the budget, in order (goals, bonds, speech, state, extras, cards). */
    trimmed: string[];
    /** Present characters whose cards did not fit. */
    dropped: string[];
    /** Attitudes between present characters, as injected. */
    bonds: string[];
}

export interface VoicesApi {
    /** Cards for the next generation (present characters only). */
    cards(): VoiceCard[];
    /** Quiet mode state: CK consistency silenced + DES-RU told. */
    ckSilenced(): boolean;
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M15 implementation (optional so that fakes stay valid).
    /** Quiet mode in detail (pult, health). */
    quiet?(): VoicesQuietState;
    /** The whole injection with its budget. */
    injection?(): VoicesInjection;
}
