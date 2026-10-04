// Pure helpers of the M12 service: language of a chat, junk tokens of the early cutoff, safe cleaning (the DES
// tracker JSON and NAI markers survive), fix instructions for a swipe, the finish reason of a response body and the
// plan of what to do with the defects of one reply. No DOM, no SillyTavern: the service feeds them.
import { stripDesTrackerJson } from '../../domain/text-clean';
import type { Defect, DefectAction, DefectKind, DefectStatus, QualityVerdict } from './api';

/* ------------------------------------------------------------------ language */

const CYRILLIC_RE = /[Ѐ-ӿ]/g;
const LATIN_RE = /[a-z]/gi;
/** Fewer letters than this say nothing about the language. */
const MIN_LETTERS = 40;

/** 'ru' or 'en' when the texts clearly use that script; undefined for too little text or a mix. */
export function detectLanguage(texts: readonly string[]): 'ru' | 'en' | undefined {
    let cyrillic = 0;
    let latin = 0;
    for (const text of texts) {
        cyrillic += text.match(CYRILLIC_RE)?.length ?? 0;
        latin += text.match(LATIN_RE)?.length ?? 0;
    }
    const total = cyrillic + latin;
    if (total < MIN_LETTERS) return undefined;
    if (cyrillic / total >= 0.6) return 'ru';
    if (latin / total >= 0.8) return 'en';
    return undefined;
}

/**
 * Expected language of the replies: DES-RU's language lock means Russian unless the chat is clearly English; without
 * the lock the chat's dominant language (the user's own messages first), else the interface language.
 */
export function expectedLanguage(options: {
    lock: boolean;
    userTexts: readonly string[];
    allTexts: readonly string[];
    fallback: 'ru' | 'en';
}): string {
    const dominant = detectLanguage(options.userTexts) ?? detectLanguage(options.allTexts);
    if (options.lock) return dominant === 'en' ? 'en' : 'ru';
    return dominant ?? options.fallback;
}

/* ------------------------------------------------------------------ junk tokens (early cutoff) */

/** Service tokens that never belong in a story (DeepSeek, Llama 3, ChatML, Gemma, Mistral). */
export const JUNK_TOKENS: readonly string[] = [
    '<｜begin▁of▁sentence｜>',
    '<｜end▁of▁sentence｜>',
    '<|begin▁of▁sentence|>',
    '<|end▁of▁sentence|>',
    '<｜User｜>',
    '<｜Assistant｜>',
    '<｜tool▁calls▁begin｜>',
    '<|begin_of_text|>',
    '<|end_of_text|>',
    '<|eot_id|>',
    '<|start_header_id|>',
    '<|end_header_id|>',
    '<|im_start|>',
    '<|im_end|>',
    '<|endoftext|>',
    '<start_of_turn>',
    '<end_of_turn>',
    '[INST]',
    '[/INST]',
];

const LONGEST_TOKEN = Math.max(...JUNK_TOKENS.map((token) => token.length));

/**
 * The first junk token in `text` that ends after `from` (the length already scanned): only the new tail is looked at,
 * so the check per stream chunk stays tiny (P15).
 */
export function findJunkToken(text: string, from = 0): string | undefined {
    const start = Math.max(0, from - LONGEST_TOKEN);
    if (start >= text.length) return undefined;
    const tail = start === 0 ? text : text.slice(start);
    if (!tail.includes('<') && !tail.includes('[')) return undefined;
    return JUNK_TOKENS.find((token) => tail.includes(token));
}

/* ------------------------------------------------------------------ safe cleaning */

const NAI_MARKER_RE = /\[nai:img:[^\]\s]{1,80}\]|<img\b[^>]*\bdata-nai\s*=[^>]*>/gi;

/** The DES tracker JSON block opening the reply (as written, with the whitespace after it); '' when none. */
export function trackerPrefix(text: string): string {
    const rest = stripDesTrackerJson(text);
    return rest === text ? '' : text.slice(0, text.length - rest.length);
}

function markerCounts(text: string): Map<string, number> {
    const counts = new Map<string, number>();
    for (const match of text.match(NAI_MARKER_RE) ?? []) counts.set(match, (counts.get(match) ?? 0) + 1);
    return counts;
}

/**
 * A cleaned version of `before` that is safe to write: the tracker JSON block stays at the start (re-attached when the
 * cleaner returned story text only) and every NAI marker / placeholder survives. Null when the candidate is unsafe,
 * empty or changes nothing.
 */
export function safeClean(before: string, candidate: string | undefined): string | null {
    if (typeof candidate !== 'string' || !candidate.trim() || candidate === before) return null;
    let text = candidate;
    const prefix = trackerPrefix(before);
    if (prefix && !text.startsWith(prefix.trimEnd())) {
        if (trackerPrefix(text)) return null;
        text = prefix + text.replace(/^\s+/, '');
    }
    const kept = markerCounts(text);
    for (const [marker, count] of markerCounts(before)) {
        if ((kept.get(marker) ?? 0) < count) return null;
    }
    return text === before ? null : text;
}

/** Removes the quoted junk from the story part of the reply (the tracker block is left as it is). */
export function removeQuotes(before: string, quotes: readonly string[]): string {
    const prefix = trackerPrefix(before);
    let body = before.slice(prefix.length);
    for (const quote of quotes) {
        if (quote.trim()) body = body.split(quote).join('');
    }
    body = body
        .replace(/[ \t]+\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .replace(/\s+$/, '');
    return prefix + body;
}

/* ------------------------------------------------------------------ fix instructions */

const LANGUAGE_NAMES: Record<string, string> = { ru: 'Russian', en: 'English' };

/** Default fix per kind (service instructions are in English, plan §9). */
const INSTRUCTIONS: Record<DefectKind, string> = {
    language: 'Write the whole reply in {language}: no words, phrases or calques from other languages.',
    userSpeech: "Do not write {user}'s lines, actions or thoughts; only {user} decides what {user} says and does.",
    refusal: 'Stay in character and continue the story; no refusals and no out-of-character remarks.',
    moralizing: 'No moralizing, warnings or disclaimers; tell the story as it is.',
    softening:
        'Do not soften, skip or summarize the scene and do not keep asking for consent; characters keep their own will and may disagree.',
    repetition: 'Do not repeat phrases, images or beats of earlier replies; move the scene forward.',
    truncated: 'Finish the reply completely; do not stop mid-sentence.',
    junk: 'Write only the story text: no service tokens, code or HTML.',
    missingTracker: 'Start the reply with the tracker JSON block exactly as the format instructions say.',
    canonContradiction: 'Keep to the established facts of the story and the lore.',
    boundary: 'Stay within the content boundary: {rule}.',
};

export const TOO_AGREEABLE_INSTRUCTION =
    'Characters must not all agree with {user}; let them keep their own goals, doubts and objections.';

export interface InstructionContext {
    userName: string;
    language: string;
    /** Boundary rule titles by id. */
    rules?: Record<string, string>;
}

function fill(template: string, context: InstructionContext, defect?: Defect): string {
    return template
        .split('{user}')
        .join(context.userName || 'the user')
        .split('{language}')
        .join(LANGUAGE_NAMES[context.language] ?? context.language)
        .split('{rule}')
        .join((defect && context.rules?.[defect.by]) || 'the configured rules');
}

/** One line, no brackets that would close the fix block early, at most 300 characters. */
function tidy(text: string): string {
    return text.replace(/\s+/g, ' ').replace(/[[\]]/g, '').trim().slice(0, 300);
}

/** The instruction of one defect: the judge's / rule's own, else the default of its kind. */
export function instructionFor(defect: Defect, context: InstructionContext): string {
    const own = defect.fix?.instruction ? tidy(defect.fix.instruction) : '';
    if (own) return own;
    if (defect.kind === 'softening' && defect.by === 'judge:tooAgreeable') {
        return fill(TOO_AGREEABLE_INSTRUCTION, context, defect);
    }
    return fill(INSTRUCTIONS[defect.kind], context, defect);
}

/** The one-shot note injected into the swipe: `[Fix for this reply: …]`. Empty without instructions. */
export function fixNote(defects: readonly Defect[], context: InstructionContext): string {
    const lines: string[] = [];
    for (const defect of defects) {
        if (defect.status === 'dismissed') continue;
        const line = instructionFor(defect, context);
        if (line && !lines.includes(line)) lines.push(line);
    }
    return lines.length ? `[Fix for this reply: ${lines.join(' ')}]` : '';
}

/* ------------------------------------------------------------------ finish reason */

const FINISH_RE = /"(?:finish_reason|stop_reason|finishReason)"\s*:\s*"([^"]+)"/g;

/** Normalises provider reasons: every «cut by the token limit» becomes 'length'. */
export function normaliseFinish(reason: string): string {
    const lower = reason.toLowerCase();
    return lower === 'length' || lower === 'max_tokens' || lower === 'max_output_tokens' ? 'length' : lower;
}

/** The last finish reason in a response body (JSON or SSE); undefined when none is reported. */
export function finishReasonFromBody(text: string): string | undefined {
    if (!text.includes('reason') && !text.includes('Reason')) return undefined;
    let last: string | undefined;
    for (const match of text.matchAll(FINISH_RE)) last = match[1];
    return last ? normaliseFinish(last) : undefined;
}

/* ------------------------------------------------------------------ action plan */

export type FixKind = 'clean' | 'continue' | 'swipe' | 'repairTracker';

/** How a kind is fixed automatically unless the defect says otherwise. */
export function defaultFix(kind: DefectKind): FixKind {
    switch (kind) {
        case 'junk':
            return 'clean';
        case 'truncated':
            return 'continue';
        case 'missingTracker':
            return 'repairTracker';
        default:
            return 'swipe';
    }
}

export interface PlanInput {
    defects: Defect[];
    action(kind: DefectKind): DefectAction;
    /** An automatic swipe can run now: the turn's one auto-swipe is unused, ST can swipe this message. */
    canSwipe: boolean;
}

export interface Plan {
    /** Swipe with these defects' instructions (supersedes every other fix). */
    swipe: Defect[];
    clean: Defect[];
    continue: Defect[];
    repair: Defect[];
    notify: Defect[];
}

/** What to do with the defects of one reply (kinds switched off are already dropped). */
export function planActions(input: PlanInput): Plan {
    const plan: Plan = { swipe: [], clean: [], continue: [], repair: [], notify: [] };
    const auto: { defect: Defect; fix: FixKind }[] = [];
    for (const defect of input.defects) {
        const action = input.action(defect.kind);
        if (action === 'off') continue;
        if (action === 'notify' || defect.suspected) plan.notify.push(defect);
        else auto.push({ defect, fix: defect.fix?.kind ?? defaultFix(defect.kind) });
    }
    const swipes = auto.filter((item) => item.fix === 'swipe');
    if (swipes.length && input.canSwipe) {
        // A new reply replaces this one: every other fix is moot, and every real defect goes into the instruction.
        plan.swipe = input.defects.filter((defect) => input.action(defect.kind) !== 'off' && !defect.suspected);
        plan.notify = [];
        return plan;
    }
    for (const { defect, fix } of auto) {
        if (fix === 'clean') plan.clean.push(defect);
        else if (fix === 'continue') plan.continue.push(defect);
        else if (fix === 'repairTracker') plan.repair.push(defect);
        else plan.notify.push(defect);
    }
    return plan;
}

/* ------------------------------------------------------------------ verdict summary */

const RESOLVED: readonly DefectStatus[] = ['cleaned', 'repaired', 'delegated', 'dismissed'];

/** The reply needs nothing more: no defects, or each one was cleaned, repaired or dismissed. */
export function isOk(defects: readonly Defect[]): boolean {
    return defects.every((defect) => defect.status !== undefined && RESOLVED.includes(defect.status));
}

/** The strongest thing done to the reply (one word for the verdict). */
export function verdictAction(defects: readonly Defect[]): QualityVerdict['action'] {
    const has = (status: DefectStatus) => defects.some((defect) => defect.status === status);
    if (has('swiped')) return 'swiped';
    if (has('continued')) return 'continued';
    if (has('cleaned')) return 'cleaned';
    if (has('repaired')) return 'repaired';
    if (has('notified')) return 'notified';
    return 'none';
}

/** NAI Studio may draw for this reply: it is not being redone. */
export function gateValue(verdict: Pick<QualityVerdict, 'action'>): boolean {
    return verdict.action !== 'swiped' && verdict.action !== 'continued';
}

/** A quote short enough for the chat document and the pult. */
export function shortQuote(text: string, max = 200): string {
    const flat = text.replace(/\s+/g, ' ').trim();
    return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}
