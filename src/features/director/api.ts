// Director (M13 scene type, M14 pacing and twists, stage 8). The scene type is decided in the pause after a turn
// (DES tracker, dictionaries incl. NAI Studio's explicit-scene words, the cheap model only when unsure) and applied
// to the NEXT turn (P15), with hysteresis. It drives conditional preset blocks through one-shot flags
// `maestro_scene_<type>` (new macro engine `{{if .maestro_scene_combat}}…{{/if}}`, M34 п.8), a reply-length hint and
// an «is a picture fitting now» hint for NAI Studio. Pacing writes a one-shot director's note near the end of the
// prompt (P16) when the story stalls, never when the user steered the plot in the last message.
// Exposed as app.modules.api<DirectorApi>('director').
import type { Unsubscribe } from '../../shared/contracts';

export type SceneType = 'dialogue' | 'combat' | 'intimate' | 'exploration' | 'timeskip' | 'social' | 'drama';

export interface SceneState {
    type: SceneType;
    /** 0..1 */
    confidence: number;
    /** Decided after this committed assistant message; applies from the next generation. */
    messageIndex: number;
    by: 'rules' | 'model' | 'user';
    /** Turns the type has held (hysteresis). */
    held: number;
    // Addition of the M13 implementation (optional so that fakes of the stage-8 contract stay valid).
    /**
     * The cue of the user's message that committed the turn decided the type («Я выхватываю меч», "I kiss her",
     * «Прошло три дня»); `by` stays 'rules'. Shown as «по твоему сообщению».
     */
    fromUserMessage?: boolean;
}

export interface StallState {
    /** Committed turns with no meaningful change (same place, nothing happening, repetition, one loop). */
    turns: number;
    reasons: ('samePlace' | 'noEvents' | 'repetition' | 'loop')[];
}

export interface DirectorNote {
    at: number;
    messageIndex: number;
    /** English note for the model (one-shot injection). */
    text: string;
    /** Where the twist comes from: DES quest, open thread from memory/canon, (stage 9) deadline / offscreen, (11) mechanic. */
    source: 'quest' | 'thread' | 'deadline' | 'offscreen' | 'mechanic';
    // Additions of the M13/M14 implementation (optional so that fakes of the stage-8 contract stay valid).
    /** The twist itself: the quest title, the memory, the promise, the offscreen event (as found). */
    detail?: string;
    /** Stall reasons the note answered (empty for a nudge). */
    reasons?: StallState['reasons'];
    /** Written because the user pressed «Встряхнуть». */
    nudged?: boolean;
}

/** Why a prepared note was not written: the user steered the plot in his last message (M14 п.4). */
export interface SuppressedNote {
    at: number;
    /** Index the reply would have had. */
    messageIndex: number;
    /** 'action': a clear move of the user (an attack, a kiss, a time skip) — he drives the scene himself. */
    reason: 'ooc' | 'request' | 'plot' | 'long' | 'action';
}

export interface DirectorApi {
    scene(): SceneState | null;
    /** The user's override of the scene type for the next turns (null = automatic). */
    setScene(type: SceneType | null): Promise<void>;
    stall(): StallState;
    /** Notes written (last N). */
    notes(): DirectorNote[];
    /** «Встряхнуть»: a director's note for the next generation now (ignores the frequency limit, not the user's steering). */
    nudge(): Promise<DirectorNote | null>;
    /** Flags the director sets for the next generation (`maestro_scene_combat`, `maestro_explicit`, `maestro_lang_ru`, …). */
    flags(): Record<string, string>;
    onChange(listener: () => void): Unsubscribe;
    // Additions of the M13/M14 implementation (optional so that fakes of the stage-8 contract stay valid).
    /** The note prepared for the next generation (written only if the user does not steer), or null. */
    pending?(): DirectorNote | null;
    /** The user's override (null = automatic). */
    override?(): SceneType | null;
    /** A different type seen once that takes over if it wins again on the next turn (hysteresis). */
    candidate?(): { type: SceneType; confidence: number } | null;
    /** The last note that was dropped because the user steered. */
    suppressed?(): SuppressedNote | null;
    /** Static flag catalogue (M34 п.8): every flag the director may set. */
    catalogue?(): { name: string; titleKey: string; descriptionKey: string }[];
}
