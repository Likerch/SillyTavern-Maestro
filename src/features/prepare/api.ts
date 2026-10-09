// Public API of M37 «Подготовить к игре» (plan-2 §7; app.modules.api<PrepareApi>('prepare')).
//
// For the UI wave (the offer under the greeting, the preparation window, the «Готово к игре» summary):
// 1. `eligibility()` / `isNewChat()` — only a one-on-one chat with a card and no messages of the user yet (the
//    greeting and its alternate swipes are fine). The strip offers preparation while this holds and no plan was
//    applied (`state().stage`).
// 2. `savedFor()` — a character-level preparation saved for this card: offer «Применить сохранённую подготовку»
//    (`applySaved()`, no model call) and/or a fresh look at what changed (`start({ reuse: true })` reads only the
//    changed card fields and book entries).
// 3. `estimate()` before `start()`: parts, sources, skipped sources and the price; `start()` runs a user job
//    (app.jobs, key `prepare:<chatId>`, progress and «Stop») and resolves to the job key at once.
// 4. `plan()` + `onChange()` — the plan by sections; every item has an id, its kind and data, a Russian line, its
//    sources, `exists` («уже есть»), `conflicts` (the canon says otherwise) and the proposed scope.
// 5. `apply(selection, options)` — the chosen items, each with its scope 'chat' (default, plan-2 В20) or 'character';
//    every item is written as one part with its own journal record (undo per part: `undoItem(id)` or the journal),
//    the summary lists what was done, skipped and failed in story words.
// 6. `status()` — «Готово к игре»: what is still missing (passports, DES portraits, places, backgrounds) and how many
//    starting scenes are prepared, which one is active.
// 7. `startScenes()` — every greeting of the card is a start of its own (the alternate greetings are the swipes of
//    message 0): the greeting shown now, the scenes prepared for this chat, the active one (its outfits, type of the
//    first scene and canon note are applied; it follows the greeting swipe until the player's first message), the lock.
// 8. «Персонажи в DES» (1.18): `apply(…, { desSeed })` also gives every prepared greeting its DES tracker (one line of
//    the summary, item id 'des', kind 'des', with its own undo); `desSeedOffered()` tells the review to show the switch,
//    `desSeeded()` that the greeting on screen carries a prepared tracker.
// 9. Dramatis (1.19, Dramatis 1.3+): `dramatisIntent()` — where Dramatis' reading of the card's intent stands (the review
//    shows the switch «Личности в Dramatis»); `apply(…, { dramatis })` has Dramatis read the card (again) before the DES
//    seeding, as the user's action — one line of the summary, item id 'dramatis', kind 'dramatis', no undo (Dramatis
//    journals its own reading); `openDramatis()` opens Dramatis' «Лист замысла» (the line's «Открыть»).
// The module's own face uses nothing but this API (plus the service's `watch()` while the window shows the job):
// controller.ts (shared actions, per-chat drafts), offer.ts (the strip line under the greeting, the quiet notice),
// window.ts + review.ts (the window «Подготовка к игре», or the pult tab «Подготовка» in a shell without windows).
import type { Unsubscribe } from '../../shared/contracts';
import type { AnyPrepareItem, PrepareKind, PreparePlan } from '../../domain/prepare-plan';
import type { SelectionRow, MissingItem } from '../../domain/prepare-apply';
import type { PrepareEstimate } from '../../domain/prepare-sources';

export type {
    AnyPrepareItem,
    PrepareItem,
    PrepareKind,
    PreparePlan,
    PrepareScope,
    PrepareDataMap,
    ExistsInfo,
    ConflictInfo,
} from '../../domain/prepare-plan';
export type { SelectionRow, MissingItem, MissingKind } from '../../domain/prepare-apply';
export type { PrepareEstimate } from '../../domain/prepare-sources';

/** Why preparation is not offered here. */
export type IneligibleReason = 'noChat' | 'group' | 'noCard' | 'started';

export interface PrepareEligibility {
    ok: boolean;
    reason?: IneligibleReason;
}

/** Where the chat's preparation is. */
export type PrepareStage = 'none' | 'running' | 'ready' | 'applied' | 'failed';

export interface PrepareState {
    stage: PrepareStage;
    /** Key of the user job while it runs (or of the last one). */
    jobKey: string | null;
    /** Translated error of a failed run. */
    error?: string;
    /** When the plan was last applied. */
    appliedAt?: number;
}

export interface PrepareStartOptions {
    /** Read only what changed since the saved character-level preparation (falls back to everything). */
    reuse?: boolean;
    /** Start even when the chat is no longer new (tests, the slash command with «again»). */
    force?: boolean;
}

export interface PrepareEstimateResult extends PrepareEstimate {
    /** The sources that will be read, labelled for the user. */
    labels: string[];
    /** Labels of the sources left out by the budget. */
    skippedLabels: string[];
    /** The estimate reads only changed sources of the saved preparation. */
    reuse: boolean;
}

export interface PrepareApplyOptions {
    /** Generate NAI passports (text only, never Anlas) for characters without one (default: the module setting). */
    passports?: boolean;
    /**
     * Put the prepared starting scenes into DES (release 1.18): who is in each one, their looks, behaviour, clothes,
     * relationship, thoughts and stats, the scene's date, time, place and weather (default: the module setting).
     */
    desSeed?: boolean;
    /**
     * Dramatis 1.3 reads the author's intent of the card — the characters' personalities — before the DES seeding (its
     * starting cast feeds the seeds). Default: a full apply when Dramatis has not read this card yet; true on a card it
     * has read reads it again. Without it the summary still says what Dramatis has (release 1.19).
     */
    dramatis?: boolean;
    /**
     * Items «для персонажа» write into the card's own Maestro book and the card's passports; the user is asked once
     * unless the caller already asked (its own dialog): `confirmed: true`.
     */
    confirmed?: boolean;
}

/**
 * What a line of the summary is about: an item of the plan, 'des' — the starting scenes in DES (release 1.18), or
 * 'dramatis' — Dramatis' reading of the card (release 1.19).
 */
export type ApplyLineKind = PrepareKind | 'des' | 'dramatis';

/** One applied item in story words. */
export interface ApplyLine {
    itemId: string;
    kind: ApplyLineKind;
    /** «Вера — в канон, паспорт» / «Механика «Репутация» с начальными значениями». */
    text: string;
    /** Journal record of the part (undo). */
    journalId?: string;
    /** Says what is there, nothing was written now (counts neither for «applied» nor in the notice). */
    info?: boolean;
}

/** Where Dramatis' reading of the card's intent stands (Dramatis 1.3+). */
export interface DramatisIntentInfo {
    /** Dramatis has read this card. */
    read: boolean;
    /** Characters it read. */
    characters: number;
    /** A reading runs now. */
    running: boolean;
    /** Dramatis can open its «Лист замысла». */
    canOpen: boolean;
}

export interface PrepareApplySummary {
    done: ApplyLine[];
    /** Not written: exists already, nothing to write, the module is off… (the reason is in the text). */
    skipped: ApplyLine[];
    failed: ApplyLine[];
    /** Proposals for the user (backgrounds are never generated here). */
    proposals: string[];
    /** The user declined the character-level writes. */
    cancelled?: boolean;
}

export interface SavedPreparationInfo {
    avatar: string;
    cardName: string;
    savedAt: number;
    /** Items saved «для персонажа». */
    items: AnyPrepareItem[];
    /** The card's Maestro book that holds them. */
    book: string | null;
    /** Card fields and book entries changed since (labels); empty when nothing changed. */
    changed: string[];
}

export interface ReadyStatus {
    /** Nothing important is missing. */
    ready: boolean;
    missing: MissingItem[];
    /** One line per missing thing, in story words. */
    lines: string[];
    /** The starting scenes prepared for this chat and the active one, in one line (none prepared: absent). */
    scenes?: { prepared: number; active: number | null; line: string };
    /** What Dramatis has read of the card, in one line (Dramatis 1.3 absent or nothing read: absent). */
    dramatis?: { characters: number; line: string };
}

/** The starting scenes of the chat (every greeting of the card is a start of its own). */
export interface StartScenesInfo {
    /** The greeting message 0 shows now: 0 the first message, n alternate greeting n (null: unknown). */
    shown: number | null;
    /** Greetings whose scene is prepared for this chat, in order. */
    prepared: number[];
    /** The active one (its outfits, type of the first scene and canon note are applied), null when none. */
    active: number | null;
    /** The player wrote: the start no longer follows the greeting swipe. */
    locked: boolean;
}

export interface PrepareApi {
    isNewChat(): boolean;
    eligibility(): PrepareEligibility;
    state(): PrepareState;
    /** The chat's plan (null before the first run). */
    plan(): PreparePlan | null;
    /** Loads the chat's plan document (after a chat switch the API answers from it). */
    load(): Promise<PreparePlan | null>;
    estimate(options?: PrepareStartOptions): Promise<PrepareEstimateResult>;
    /** Starts the analysis as a user job; resolves to its key (null when not eligible or already running). */
    start(options?: PrepareStartOptions): Promise<string | null>;
    /** Resolves when the running job ends (immediately when none runs). */
    whenDone(): Promise<void>;
    cancel(): boolean;
    apply(selection: readonly SelectionRow[] | 'all', options?: PrepareApplyOptions): Promise<PrepareApplySummary>;
    /** Undoes one applied item (its journal record). */
    undoItem(itemId: string): Promise<boolean>;
    savedFor(avatar?: string): Promise<SavedPreparationInfo | null>;
    /** Applies the saved character-level preparation to this new chat (no model call). */
    applySaved(options?: PrepareApplyOptions): Promise<PrepareApplySummary>;
    /** Forgets the chat's plan (applied parts stay; undo them through the journal). */
    discard(): Promise<void>;
    status(): Promise<ReadyStatus>;
    /** The starting scenes of this chat (sync; empty until the chat's document is read). */
    startScenes(): StartScenesInfo;
    /** DES is there, on and shows something the prepared starting scenes would fill (the switch «Персонажи в DES»). */
    desSeedOffered(): boolean;
    /**
     * The greeting message 0 shows now carries the DES tracker Maestro prepared for it (sync; false until the chat's
     * document is read). M3 «Медик» never repairs it.
     */
    desSeeded(): boolean;
    /**
     * Dramatis 1.3+ is there and reads cards: where its reading of this card stands (sync). Null without Dramatis, with
     * an older one, or outside a solo chat.
     */
    dramatisIntent(): DramatisIntentInfo | null;
    /** Opens Dramatis' «Лист замысла» (on a character when named); false when Dramatis cannot. */
    openDramatis(name?: string): boolean;
    /** The item as one Russian line (its own line, else a made-up one from the data). */
    describe(item: AnyPrepareItem): string;
    onChange(listener: () => void): Unsubscribe;
}
