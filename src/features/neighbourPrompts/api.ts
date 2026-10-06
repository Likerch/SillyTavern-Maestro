// M36 «Промпты соседей» (plan-2 §2 п. 5, «Области действия» п. 3): one registry of the instruction texts other
// extensions put into the prompt, with Maestro's way to change them. Exposed as
// app.modules.api<NeighbourPromptsApi>('neighbourPrompts').
//
// What it knows (descriptors.ts; ids are stable, the second wave refers to them):
// | id | owner | where the text lives | global edit | scoped copy |
// |---|---|---|---|---|
// | des.tracker | DES | `customTrackerPrompt` (the whole tracker block; '' = DES builds it from its tracker settings) | yes | yes |
// | des.trackerInstructions | DES | `customTrackerInstructionsPrompt` (inside the generated block; '' = DES's text) | yes | when set |
// | des.trackerContinuation | DES | `customTrackerContinuationPrompt` (after the block) | yes | when set |
// | des.html | DES | `customHtmlPrompt` (immersive HTML) | yes | yes |
// | des.dialogueColoring | DES | `customDialogueColoringPrompt` | yes | yes |
// | des.contextInstructions | DES | `customContextInstructionsPrompt` | yes | yes |
// | des.narrator | DES | `customNarratorPrompt` | yes | yes |
// | nai.markers | NAI Studio | `markers.template` with preset 'custom' (the image rules for the chat model) | yes | yes |
// | qvink.prompt | Qvink | `prompt` (the summary prompt of Qvink's own requests) | yes | no: not in the main prompt |
// | qvink.shortTemplate / qvink.longTemplate | Qvink | `short_template` / `long_template` (memory headers) | yes | no: filled with memories |
// | desru.languageLock | DES-RU | its constant language rule for BunnyMo (slot `desru_bunnymo_language`) | no | yes |
// | ck.consistency | CarrotKernel | «Character Consistency» insert (built per scene) | no | no |
// | ck.template | CarrotKernel | the user's «Character Consistency» template | no | no |
// | maestro.<module> | Maestro | its own injections (director, voices, mechanics, wardrobe…) — edited in module settings | no | no |
//
// Global edits go through the neighbour's own save path (DES persistence.saveSettings, ST's settings save for NAI
// Studio and Qvink), are journaled with undo and acknowledged by M4. DES is never written while its Workshop is open.
// Scoped copies (for the card or the chat open now) are kept by Maestro (core/scoped-docs: a file per card avatar, a
// per-chat document) and applied only at generation time: at CHAT_COMPLETION_PROMPT_READY (Maestro's listener placed
// last) the neighbour's global text, as it went into the outgoing messages, is replaced by the copy — roles, message
// objects and their symbol keys stay, nothing is cloned. Neighbours' settings are never touched for a copy, so with
// Maestro off every neighbour sends its own text.
import type { Unsubscribe } from '../../shared/contracts';

export const NEIGHBOUR_PROMPTS_KEY = 'neighbourPrompts';

export type NeighbourOwner = 'des' | 'nai' | 'qvink' | 'desru' | 'ck' | 'maestro';

/** Where a scoped copy lives: every chat of the card open now, or the chat open now. */
export type NeighbourScope = 'character' | 'chat';

export interface NeighbourPrompt {
    /** Stable id, e.g. 'des.trackerInstructions'. */
    id: string;
    owner: NeighbourOwner;
    /** Human name, translated («Инструкции трекера DES»). */
    label: string;
    /** One sentence: what the text does and where it goes, translated. */
    description: string;
    /** The neighbour is installed and on. */
    present: boolean;
    /** What goes to the model in the chat open now: the chat's copy, else the card's, else the global text. */
    text: string;
    /**
     * The neighbour's own text («везде»): its setting, or its built-in text when the setting is empty and the
     * built-in is known; for read-only entries what was last seen in the prompt ('' before the first generation).
     */
    globalText: string;
    /** The neighbour's setting as stored ('' = the neighbour uses its built-in text). Absent for read-only entries. */
    setting?: string;
    /** The neighbour's built-in text, when it is known. */
    defaultText?: string;
    /** Maestro's copies for the card and the chat open now. */
    scoped: { character?: string; chat?: string };
    /** setGlobal() works now (present and writable). */
    editable: boolean;
    /** setScoped() works now (the text goes into the main prompt and can be found there). */
    scopable: boolean;
    /** Why it cannot be edited or copied, translated (shown under the entry). */
    note?: string;
    /** 'prompt': the main prompt; 'background': the neighbour's own requests (Qvink summaries). */
    usedIn: 'prompt' | 'background';
}

export interface NeighbourPromptsReport {
    at: number;
    /** Copies that replaced their global text in the last real generation. */
    replaced: string[];
    /** Copies whose global text was not found in the outgoing messages (the copy did not apply). */
    notFound: string[];
}

export interface NeighbourPromptsApi {
    list(): NeighbourPrompt[];
    get(id: string): NeighbourPrompt | null;
    /**
     * «Изменить везде»: writes the neighbour's own setting through its own save path (journaled with undo; M4 is told
     * it was Maestro). '' gives the neighbour back its built-in text («вернуть как было»). Throws
     * NeighbourPromptError: 'unknown' id, 'readOnly', 'absent' neighbour, 'busy' (DES Workshop open).
     */
    setGlobal(id: string, text: string): Promise<void>;
    /**
     * «Копия для персонажа / для чата»: Maestro's copy for the card or the chat open now (null removes it), journaled
     * with undo. Throws NeighbourPromptError 'notScopable' or 'noScope' (no such card/chat open).
     */
    setScoped(id: string, scope: NeighbourScope, text: string | null): Promise<void>;
    /** The text that goes to the model in the chat open now ('' for an unknown id). */
    effective(id: string): string;
    /** What the copies did in the last real generation (null before one). */
    lastReport(): NeighbourPromptsReport | null;
    /** Resolves when the copies of the chat open now are loaded. */
    ready(): Promise<void>;
    onChange(listener: () => void): Unsubscribe;
}

export type NeighbourPromptErrorCode = 'unknown' | 'readOnly' | 'absent' | 'busy' | 'notScopable' | 'noScope';

export class NeighbourPromptError extends Error {
    constructor(
        readonly code: NeighbourPromptErrorCode,
        message: string,
    ) {
        super(message);
        this.name = 'NeighbourPromptError';
    }
}
