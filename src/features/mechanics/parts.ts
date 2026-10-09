// Internal contract of the mechanics module (M25): three parts built side by side and wired in index.ts.
// - definitions (definitions.ts): the definitions in Maestro books, templates, the constructor;
// - state (state.ts, tracking.ts): values per chat, the three tracking modes, threshold events;
// - checks (checks.ts, prompt.ts, widgets.ts): dice, checks, the prompt injection and flags, the widgets.
// service.ts implements MechanicsApi by delegating to the parts.
import type { BlockRoll } from '../../domain/mechanics-block';
import type { OpInput } from '../../domain/mechanics-state';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type {
    AttributeValue,
    ChangeSource,
    CheckResult,
    CombatState,
    DerivedValue,
    FiredEvent,
    HolderState,
    ItemState,
    MechanicDef,
    MechanicsClock,
    MechanicsEvent,
    StateChange,
    StatusState,
    VisibilityPlace,
} from './api';

export const MECHANICS_KEY = 'mechanics';
export const MECHANICS_ID = 'M25';
/** Default Maestro book of the definitions (role 'maestro', never active: Maestro injects the rules itself). */
export const DEFAULT_MECHANICS_BOOK = 'Maestro · механики';
/** Ephemeral injection keys (one generation each). */
export const INJECT_RULES = 'maestro_mechanics';
export const INJECT_FACTS = 'maestro_mechanics_facts';
/** Flag for conditional preset blocks: `maestro_mech_<mechanic id>` while the mechanic takes part in the scene. */
export const FLAG_PREFIX = 'maestro_mech_';
/** The service block the model writes in 'block' mode: `<mechanics>…</mechanics>` at the end of the reply. */
export const BLOCK_TAG = 'mechanics';

/** Where the HUD goes: over the chat (top or bottom, dragged) or, on a wide screen, left of the chat (hud-place.ts). */
export type HudPlacement = 'chat' | 'left';

export interface MechanicsSettings {
    /** Book for new definitions. */
    book: string;
    /** Roll checks when the user's message calls for one (trigger words). */
    autoChecks: boolean;
    /** Widgets next to DES's portrait bar. */
    strip: boolean;
    /** Token cap of the rules + state injection (the architect's «механики» budget wins when it is set). */
    promptBudget: number;
    /** Chat depth of the injection (P16: near the end). */
    depth: number;
    /** Background parse of committed replies for 'background' attributes. */
    background: boolean;
    /** The model may ask Maestro for rolls in its service block (`roll: …`). */
    modelRolls: boolean;
    /** A fight starts and ends with the director's scene type. */
    autoCombat: boolean;
    /** DES does not list the user's character: its DES-stat attributes are read by the background parse or the block. */
    personaFallback: 'background' | 'block';
    /** Messages looked back for names of factions and world mechanics (they join the prompt only when mentioned). */
    relevance: number;
    /** The HUD over the chat (plan-2 §6.А п.4): shown while a mechanic is on. */
    hud: boolean;
    /** Where the HUD goes; 'left' falls back to over the chat when the left side has no room (phones, narrow windows). */
    hudPlacement: HudPlacement;
    /** Attributes pinned to the HUD (`mechanic.attribute`); empty: every one the HUD may show. */
    hudAttrs: string[];
    /** Characters shown in the HUD besides the user's character. */
    hudHolders: string[];
    /** Attributes chosen for the strip under DES portraits (`mechanic.attribute`); empty: every one it may show. */
    desAttrs: string[];
    /** The user's character in the strip under DES portraits. */
    desPersona: boolean;
}

export const DEFAULT_MECHANICS_SETTINGS: MechanicsSettings = {
    book: DEFAULT_MECHANICS_BOOK,
    autoChecks: true,
    strip: true,
    promptBudget: 400,
    depth: 1,
    background: true,
    modelRolls: true,
    autoCombat: true,
    personaFallback: 'background',
    relevance: 4,
    hud: true,
    hudPlacement: 'chat',
    hudAttrs: [],
    hudHolders: [],
    desAttrs: [],
    desPersona: true,
};

export interface PartDeps {
    app: App;
    log: Logger;
    settings: () => MechanicsSettings;
}

/** Definitions part. */
export interface DefinitionsPart {
    /** Visible in this chat (global, this card's, this chat's), cached; refreshed on WORLDINFO_UPDATED and chat change. */
    list(): MechanicDef[];
    /** Visible and not switched off in this chat. */
    active(): MechanicDef[];
    get(id: string): MechanicDef | null;
    save(def: MechanicDef): Promise<MechanicDef>;
    remove(id: string): Promise<void>;
    setEnabledInChat(id: string, on: boolean): Promise<void>;
    onChange(listener: () => void): Unsubscribe;
    dispose(): void;
}

/** One value change to apply (from tracking, a check, an event or the user). */
export interface ChangeInput {
    mechanicId: string;
    holder: string;
    attribute: string;
    /** Absolute value, or a delta for numbers (`delta: true`). */
    value: AttributeValue;
    delta?: boolean;
    /** 'mul': a factor (numbers); 'push' / 'pull': options added to / removed from a list. */
    op?: 'mul' | 'push' | 'pull';
    source: ChangeSource;
    messageIndex: number;
    reason?: string;
    rollId?: string;
    batch?: string;
    kind?: 'value';
}

/** Any state operation: a value change, a status, an item, revealing, the fight, the clock (domain/mechanics-state). */
export type StateOp = OpInput;

/** Options of an application. */
export interface ApplyOpsOptions {
    /** Journal the user's own operations as one record (default: when every operation is the user's). */
    journal?: boolean;
    /** Kind of that journal record (default 'mechanics.set'). */
    kind?: string;
}

/** State part: values per chat (a Maestro file), per-message changes (swipes and deletions roll them back). */
export interface StatePart {
    state(holder?: string): HolderState[];
    value(mechanicId: string, holder: string, attribute: string): AttributeValue | null;
    /** Validates (kind, bounds, levels, options), clamps, records, fires threshold events; journals 'user' changes. */
    apply(changes: ChangeInput[]): Promise<StateChange[]>;
    history(limit?: number): StateChange[];
    events(limit?: number): FiredEvent[];
    /** Fired events not yet given to the model (the prompt part takes them once per generation). */
    pendingEvents(): FiredEvent[];
    markEventsDelivered(events: FiredEvent[]): Promise<void>;
    /** Holders of a mechanic in the current scene: present characters (DES), the persona, 'world', faction names. */
    holdersInScene(def: MechanicDef): string[];
    /** The tracker's name of a holder in the scene, else the holder (MechanicsApi.shownName). */
    shownName?(holder: string): string;
    onChange(listener: () => void): Unsubscribe;
    /** Resolves when the queued writes are done (tracking waits for a rollback before deriving a reply again). */
    settled?(): Promise<void>;
    /** Loads the chat's state document (its change log tells which replies were processed). */
    load?(): Promise<unknown>;
    dispose(): void;
    // plan-2 §6 additions (optional: fakes of the stage-11 contract stay valid).
    /** Applies any operations (statuses, items, reveal, fight, clock) like apply(). */
    applyOps?(ops: StateOp[], options?: ApplyOpsOptions): Promise<StateChange[]>;
    /** A number for dice and formulas: with status and item modifiers; scales as their level index. */
    numberOf?(mechanicId: string, holder: string, attribute: string): number | null;
    /** The bonus statuses and equipped items give to a check of a holder. */
    checkBonus?(def: MechanicDef, checkId: string, holder: string): number;
    derived?(mechanicId: string, holder: string): DerivedValue[];
    statuses?(holder?: string): { holder: string; statuses: StatusState[] }[];
    items?(holder?: string): { holder: string; items: ItemState[] }[];
    combat?(): CombatState | null;
    clock?(): MechanicsClock | null;
    isRevealed?(mechanicId: string, holder: string, attribute: string): boolean;
    changesOf?(messageIndex: number, options?: { place?: VisibilityPlace }): StateChange[];
    undoChange?(changeId: string): Promise<boolean>;
    /** Takes back every change matching (newest first); the removed changes. */
    undoWhere?(
        match: (change: StateChange) => boolean,
        journal?: { kind: string; summary: string },
    ): Promise<StateChange[]>;
    reset?(target: { mechanicId?: string; holder?: string }): Promise<number>;
    /** The committed reply's turn: the story clock, statuses, time rules, the fight's round (leader, once). */
    processTurn?(index: number): Promise<void>;
    onEvent?(listener: (event: MechanicsEvent) => void): Unsubscribe;
    emitEvent?(event: MechanicsEvent): void;
}

/** Tracking part: the three ways changes are noticed. */
export interface TrackingPart {
    /**
     * English instruction for the 'block' attributes of the mechanics in the scene (format of the service block,
     * the holders and attributes it may change), '' when none uses the block. The prompt part appends it.
     */
    blockInstruction(
        defs: MechanicDef[],
        holdersByMechanic: Record<string, string[]>,
        options?: { checks?: string[]; combat?: boolean },
    ): string;
    /** Which number attributes of a mechanic are DES stats now (constructor). */
    desStatsStatus(def: MechanicDef): { attribute: string; inDes: boolean }[];
    /** Adds the mechanic's 'desStats' attributes to DES's character stats (asks, journals, undoable). */
    enableDesStats(def: MechanicDef): Promise<boolean>;
    dispose(): void;
    /** Roll requests of a reply's block, as soon as the reply arrives (the checks part rolls them). */
    onRollRequests?(listener: (index: number, swipeId: number, rolls: BlockRoll[]) => void): Unsubscribe;
}

/** Options of a roll by hand. */
export interface RollOptions {
    difficulty?: number;
    mode?: 'adv' | 'dis';
    vs?: { holder: string; mechanicId?: string; checkId?: string };
}

/** Checks part. */
export interface ChecksPart {
    roll(mechanicId: string, checkId: string, holder: string, options?: RollOptions): Promise<CheckResult>;
    checks(limit?: number): CheckResult[];
    /** Check results not yet given to the model (the prompt part takes them once per generation). */
    pendingChecks(): CheckResult[];
    markChecksDelivered(results: CheckResult[]): void;
    onChange(listener: () => void): Unsubscribe;
    dispose(): void;
    rollsOf?(messageIndex: number): CheckResult[];
    undoRoll?(rollId: string): Promise<boolean>;
    /** Names of the checks the model may ask for (the block instruction lists them). */
    checkNames?(): string[];
}

/** A section of the pult tab rendered by a part (the tab is composed in index.ts). */
export type SectionRenderer = (container: HTMLElement) => void | Unsubscribe;
