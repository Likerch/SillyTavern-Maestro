// Internal contract of the mechanics module (M25): three parts built side by side and wired in index.ts.
// - definitions (definitions.ts): the definitions in Maestro books, templates, the constructor;
// - state (state.ts, tracking.ts): values per chat, the three tracking modes, threshold events;
// - checks (checks.ts, prompt.ts, widgets.ts): dice, checks, the prompt injection and flags, the widgets.
// service.ts implements MechanicsApi by delegating to the parts.
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type {
    AttributeValue,
    ChangeSource,
    CheckResult,
    FiredEvent,
    HolderState,
    MechanicDef,
    StateChange,
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
}

export const DEFAULT_MECHANICS_SETTINGS: MechanicsSettings = {
    book: DEFAULT_MECHANICS_BOOK,
    autoChecks: true,
    strip: true,
    promptBudget: 400,
    depth: 1,
    background: true,
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

/** One change to apply (from tracking, a check, an event or the user). */
export interface ChangeInput {
    mechanicId: string;
    holder: string;
    attribute: string;
    /** Absolute value, or a delta for numbers (`delta: true`). */
    value: AttributeValue;
    delta?: boolean;
    source: ChangeSource;
    messageIndex: number;
    reason?: string;
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
    onChange(listener: () => void): Unsubscribe;
    /** Resolves when the queued writes are done (tracking waits for a rollback before deriving a reply again). */
    settled?(): Promise<void>;
    /** Loads the chat's state document (its change log tells which replies were processed). */
    load?(): Promise<unknown>;
    dispose(): void;
}

/** Tracking part: the three ways changes are noticed. */
export interface TrackingPart {
    /**
     * English instruction for the 'block' attributes of the mechanics in the scene (format of the service block,
     * the holders and attributes it may change), '' when none uses the block. The prompt part appends it.
     */
    blockInstruction(defs: MechanicDef[], holdersByMechanic: Record<string, string[]>): string;
    /** Which number attributes of a mechanic are DES stats now (constructor). */
    desStatsStatus(def: MechanicDef): { attribute: string; inDes: boolean }[];
    /** Adds the mechanic's 'desStats' attributes to DES's character stats (asks, journals, undoable). */
    enableDesStats(def: MechanicDef): Promise<boolean>;
    dispose(): void;
}

/** Checks part. */
export interface ChecksPart {
    roll(mechanicId: string, checkId: string, holder: string, options?: { difficulty?: number }): Promise<CheckResult>;
    checks(limit?: number): CheckResult[];
    /** Check results not yet given to the model (the prompt part takes them once per generation). */
    pendingChecks(): CheckResult[];
    markChecksDelivered(results: CheckResult[]): void;
    onChange(listener: () => void): Unsubscribe;
    dispose(): void;
}

/** A section of the pult tab rendered by a part (the tab is composed in index.ts). */
export type SectionRenderer = (container: HTMLElement) => void | Unsubscribe;
