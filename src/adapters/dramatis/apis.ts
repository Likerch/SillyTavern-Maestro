// Copied verbatim from SillyTavern-Dramatis src/shared/apis.ts (the contract between Maestro and Dramatis).
// Keep in sync: change it in Dramatis first, then copy it here unchanged below this note.
// Cross-extension APIs (docs/dev-plan.md). This file is copied verbatim into Maestro
// (src/adapters/dramatis/apis.ts): keep it self-contained, types only plus the global names.
//
// - Maestro publishes MAESTRO_API v1 (infrastructure: background LLM, Inbox, journal, names, turn events,
//   quiet modes). Dramatis uses it when present; without it only the standalone features work.
// - Dramatis publishes DRAMATIS_API v1. Maestro's adapter pulls from it (voices merge, CK / Medicine Check
//   quiet modes, relations graph, mechanics templates, offscreen briefs, director twists, prompt audit).
// Both are versioned: a consumer checks `version` and the presence of each optional method.

export const MAESTRO_API_GLOBAL = 'MAESTRO_API';
export const MAESTRO_API_READY_EVENT = 'maestro-api-ready';
export const DRAMATIS_API_GLOBAL = 'DRAMATIS_API';
export const DRAMATIS_API_READY_EVENT = 'dramatis-api-ready';

export type ApiUnsubscribe = () => void;

/* ------------------------------------------------------------------ MAESTRO_API v1 */

export interface ApiLlmMessage {
    role: 'system' | 'user' | 'assistant';
    content: string;
}

export interface ApiLlmRequest {
    /** Task id registered with llm.registerTask ('dramatis.turn'); picks the profile and labels the cost. */
    task: string;
    messages: ApiLlmMessage[];
    maxTokens: number;
    temperature?: number;
    schema?: { name: string; schema: Record<string, unknown> };
    /**
     * Background work: refused (ok:false, error 'not-leader' / 'cap') when this tab is not the chat's leader or the
     * daily background cap is reached. Interactive tasks (the user pressed a button) pass false.
     */
    background: boolean;
    signal?: AbortSignal;
}

export interface ApiLlmResult<T = unknown> {
    ok: boolean;
    data?: T;
    text?: string;
    refusal?: boolean;
    /** 'not-leader' | 'cap' | 'no-profile' | 'breaker' | free text. */
    error?: string;
    costUsd?: number;
    tokens?: { prompt: number; completion: number };
}

export interface ApiJournalChange {
    target: string;
    ref: Record<string, unknown>;
    before: unknown;
    after: unknown;
}

/** A proposal routed by Maestro's autonomy levels; applied through the applier registered for its kind. */
export interface ApiProposal {
    /** Action kind ('dramatis.intent', 'dramatis.arc'…); Maestro shows `label` for it in its settings. */
    kind: string;
    /** Plain story words (already translated). */
    title: string;
    description?: string;
    details?: string;
    changes: ApiJournalChange[];
    /** JSON-serialisable: stored in the Inbox and handed to the applier. */
    payload: unknown;
    sourceMessage?: number;
    /** Default level when the user never chose one for this kind. */
    fallback: 'auto' | 'notify' | 'inbox' | 'ask' | 'off';
    ttlMs?: number;
    acceptLabel?: string;
    rejectLabel?: string;
}

export type ApiDecision = 'applied' | 'queued' | 'notified' | 'rejected' | 'skipped';

export type ApiTurnEvent =
    | { type: 'chat:changed'; chatId: string | null }
    | { type: 'reply:ready'; messageIndex: number }
    | { type: 'turn:committed'; messageIndex: number }
    | { type: 'message:invalidated'; messageIndex: number; reason: 'swiped' | 'deleted' | 'edited' }
    | { type: 'generation:before'; generation: string; dryRun: boolean; quiet: boolean }
    | { type: 'generation:ended'; generation: string; stopped: boolean };

export interface ApiEntityRef {
    id: string;
    name: string;
    aliases: string[];
    /** Search forms (Russian cases, short names) — for matching text, not for display. */
    forms: string[];
}

export type MaestroQuietFunction = 'voices' | 'ck.consistency' | 'bunnymo.medicineCheck';

export interface MaestroApiV1 {
    version: 1;
    maestroVersion: string;
    llm: {
        request<T = unknown>(request: ApiLlmRequest): Promise<ApiLlmResult<T>>;
        available(task: string): boolean;
        /** Shows the task in Maestro's profile list (per-task connection profile); returns a remover. */
        registerTask(id: string, label: { ru: string; en: string }): ApiUnsubscribe;
    };
    leader: { isLeader(): boolean; onChange(listener: (leader: boolean) => void): ApiUnsubscribe };
    /** Routes through autonomy: applied now, queued to the Inbox, notified or skipped. */
    propose(proposal: ApiProposal): Promise<ApiDecision>;
    /** How a stored Inbox card of this kind is applied after a reload (and optional checks). */
    registerApplier(
        kind: string,
        label: { ru: string; en: string },
        apply: (payload: unknown) => Promise<void>,
        stillValid?: (payload: unknown) => Promise<boolean>,
    ): ApiUnsubscribe;
    journal: {
        record(action: {
            kind: string;
            summary: string;
            changes: ApiJournalChange[];
            sourceMessage?: number;
        }): Promise<string>;
        registerUndo(target: string, handler: (change: ApiJournalChange) => Promise<boolean>): ApiUnsubscribe;
    };
    notice(
        text: string,
        options?: { importance?: 'info' | 'important' | 'urgent'; action?: { label: string; run: () => void } },
    ): void;
    /** Maestro's turn pipeline (swipes, edits and branches already handled). */
    onTurn(listener: (event: ApiTurnEvent) => void | Promise<void>): ApiUnsubscribe;
    names: {
        /** The world-model entity for a name in the current chat (aliases, Russian forms), or null. */
        resolve(name: string): ApiEntityRef | null;
        /** Same person in the current chat (aliases, forms, chat alias map). */
        same(a: string, b: string): boolean;
    };
    /** Characters present after the last committed turn (DES tracker, Maestro's view), names as in the story. */
    present(): string[];
    /** The speech digest Maestro's voice cards would show for this character (CK LING + Linguistics, MBTI), or null. */
    speech(name: string): string | null;
    /** Silences a function on Maestro's side while Dramatis owns it; the remover gives it back. */
    quiet(fn: MaestroQuietFunction, owner: string): ApiUnsubscribe;
    /** Stage 3: give a new NPC a CK archive with these BunnyMo tags («Оформить»); false when not possible. */
    styleUp?(name: string, tags: string[]): Promise<boolean>;
    /** Stage 3: write goals into the chat canon entry of this character (canon `goals` field). */
    setCanonGoals?(name: string, goals: string[]): Promise<boolean>;
}

/* ------------------------------------------------------------------ DRAMATIS_API v1 */

export interface DramatisStanceInfo {
    from: string;
    to: string;
    /** −3 … +3. */
    stance: number;
    /** Ladder word in the UI language («Враждебен»). */
    label: string;
    reasons: string[];
}

/** One character of a starting scene as Dramatis read it (DRAMATIS_API.startCast). */
export interface DramatisStartMember {
    /** As the story writes it. */
    name: string;
    /** Present when this starting scene begins. */
    present: boolean;
    /** What they are doing / want in that scene (English, as Dramatis stores it). */
    doing?: string;
    goal?: string;
    /** Stance toward the player −3…+3 and its ladder word in the UI language. */
    stance?: number;
    stanceLabel?: string;
    /** The strongest reason for that stance (story words). */
    reason?: string;
    /** Baseline mood in the author's words or the octant name. */
    mood?: string;
    gender?: 'female' | 'male';
}

export interface DramatisApiV1 {
    version: 1;
    dramatisVersion: string;
    /** Enabled and the current chat has a cast. */
    active(): boolean;
    /** This generation gets the `dramatis_cast` block (Maestro then silences maestro_voices and CK consistency). */
    castBlockActive(): boolean;
    /** Names whose dependence (drink, substance) the engine owns: BunnyMo Medicine Check is silenced for them. */
    dependenceOwned(): string[];
    /** Stances between characters (NPC → player and NPC ↔ NPC) for the relations graph. */
    stances(): DramatisStanceInfo[];
    /** Goals of a character in the current chat (canon `goals`, prepare). */
    goals(name: string): string[];
    /** Extra lines for Maestro's offscreen brief: goals, what they attempted, the roll outcome. */
    offscreenBrief(name: string): string | null;
    /** Agendas whose clocks are full or close: director twist sources. */
    matureAgendas(): { text: string; weight: number }[];
    /** True while Dramatis replaces the «relationships» / «social» mechanics templates. */
    replacesSocialMechanics(): boolean;
    /**
     * Optional (Dramatis 1.2+): the cast of a starting scene — greeting N, 0 = first_mes — with presence, what they do
     * and their stance toward the player; [] when Dramatis has not read the card. Maestro seeds DES from it.
     */
    startCast?(greeting: number): DramatisStartMember[];
    /** Fired when stances, goals or the cast changed. */
    onChange(listener: () => void): ApiUnsubscribe;
}
