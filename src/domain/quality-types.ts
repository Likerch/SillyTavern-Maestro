// Shared types of the reply quality checks (M12, stage 6). Pure: the checks get everything they need in
// QualityInput and return defects; the quality service (features/quality) builds the input and acts on the result
// (its Defect extends BaseDefect with what it did about it).

export type DefectKind =
    | 'language'
    | 'userSpeech'
    | 'refusal'
    | 'moralizing'
    | 'softening'
    | 'repetition'
    | 'truncated'
    | 'junk'
    | 'missingTracker'
    | 'canonContradiction'
    | 'boundary';

export interface BaseDefect {
    kind: DefectKind;
    /** 0..1; rule hits below the judge threshold go to the AI judge. */
    confidence: number;
    /** Short quote of the offending text (as written). */
    quote: string;
    /** Rule id or 'judge'. */
    by: string;
    /** For 'auto': what the fix does (clean text, continue, swipe with this instruction). */
    fix?: { kind: 'clean' | 'continue' | 'swipe' | 'repairTracker'; instruction?: string; cleaned?: string };
}

type Defect = BaseDefect;

export interface QualityMessage {
    index: number;
    isUser: boolean;
    name: string;
    /** Text as stored (the checks clean it themselves: DES tracker JSON at the start and NAI markers are normal). */
    text: string;
}

export interface QualityInput {
    /** The reply being checked (assistant). */
    reply: QualityMessage;
    /** Earlier messages, oldest first (the last ~10 assistant replies are enough for repetition). */
    history: QualityMessage[];
    userName: string;
    charName: string;
    /** Expected language of the replies ('ru' | 'en' | …), from the chat and DES-RU's language lock. */
    language: string;
    /** DES generation mode: 'together' expects a tracker JSON block at the start of the reply. */
    desTogether: boolean;
    /** Finish reason of the request when known ('length' = cut by max_tokens). */
    finishReason?: string;
    /** Content-boundary patterns (enabled rules only). */
    boundary: { id: string; patterns: string[] }[];
    /** Sheet replies (M31) are skipped by the caller; true here means «do not check at all». */
    isSheet?: boolean;
}

/** One free check: pure, fast (< 5 ms on a 4 000-char reply), RU and EN. */
export type QualityCheck = (input: QualityInput) => Defect[];

/** Confidence at or above which a rule hit is a defect without asking the judge. */
export const JUDGE_THRESHOLD = 0.8;

/** Default action per defect kind (plan M12 table; «notify» until false positives are measured). */
export const DEFAULT_ACTIONS: Record<DefectKind, 'off' | 'auto' | 'notify'> = {
    junk: 'auto',
    truncated: 'notify',
    missingTracker: 'auto',
    language: 'notify',
    userSpeech: 'notify',
    refusal: 'notify',
    moralizing: 'notify',
    softening: 'notify',
    boundary: 'notify',
    repetition: 'notify',
    canonContradiction: 'notify',
};
