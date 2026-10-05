// Mechanics (M25, stage 11): the user's own game systems — stats, magic, reputation, money, skills — without lore
// tricks. A mechanic is defined in the constructor (pult, later the assistant): attributes (numbers, scales, lists,
// texts), who has them, rules for the model, change events, checks. Definitions are lore entries of type 'mechanic'
// in a Maestro book (typed fields + `extensions.maestro.mechanic`); the state is a Maestro file per chat. Changes are
// tracked in one of three ways per attribute: DES stats (the tracker's `stats`), a short service block in the reply
// (parsed and hidden by Maestro), or a background parse of the reply. Checks are rolled by Maestro and reach the
// prompt as a fact. Only the rules and state of what takes part in the scene go into the prompt, near the end (P16).
// Exposed as app.modules.api<MechanicsApi>('mechanics').
import type { Unsubscribe } from '../../shared/contracts';

export type AttributeKind = 'number' | 'scale' | 'list' | 'text';

/**
 * How changes of an attribute are noticed:
 * - 'desStats': a DES character stat (numbers of characters only; Maestro adds the stat to DES's tracker config);
 * - 'block': a short service block the model writes at the end of its reply (Maestro parses, repairs and hides it);
 * - 'background': a cheap background parse of the committed reply;
 * - 'manual': only the user (and checks/events) change it.
 */
export type TrackingMode = 'desStats' | 'block' | 'background' | 'manual';

export type AttributeValue = number | string | string[];

/** A change event: when the value crosses a threshold, a one-shot note for the model (and a bus signal). */
export interface AttributeEvent {
    id: string;
    when: { op: '<=' | '>=' | '=' | 'changed'; value?: number | string };
    /** English note for the model, e.g. "{holder} collapses from exhaustion." ({holder}, {value} are filled in). */
    text: string;
    /** Fires once until the condition becomes false again (default true). */
    once?: boolean;
}

export interface AttributeDef {
    /** snake_case, unique within the mechanic. */
    id: string;
    /** Display name in the user's language («Здоровье»). */
    name: string;
    /** English name for the model and for DES stats ("Health"). */
    promptName: string;
    kind: AttributeKind;
    /** number: bounds (inclusive). */
    min?: number;
    max?: number;
    /** Initial value for a new holder. */
    initial?: AttributeValue;
    /** scale: ordered levels, lowest first (English for the model, e.g. ["hostile","cold","neutral","warm","loyal"]). */
    levels?: string[];
    /** list: allowed options (English); `multi` allows several at once. */
    options?: string[];
    multi?: boolean;
    /** Tracking of this attribute; absent → the mechanic's default. */
    tracking?: TrackingMode;
    /** Shown in the widgets (default true). */
    visible?: boolean;
    events?: AttributeEvent[];
}

/** Who has the attributes. Faction and world holders are named things, not characters. */
export type HolderSpec =
    | { kind: 'persona' }
    | { kind: 'characters'; includePersona?: boolean }
    | { kind: 'named'; names: string[] }
    | { kind: 'world' }
    | { kind: 'factions'; names: string[] };

/** A check the mechanic offers («Убеждение»): dice, the attribute that modifies it, difficulty, trigger words. */
export interface CheckDef {
    id: string;
    name: string;
    /** English, for the fact in the prompt ("Persuasion"). */
    promptName: string;
    /**
     * Dice formula: 'NdM', 'NdM+K', 'NdM+@attr' (attribute value as modifier), 'NdM+mod(@attr)' (D&D modifier
     * (value-10)/2), or a roll-under '1d100<=@attr'. Unknown formulas are refused by the constructor.
     */
    dice: string;
    /** Target the total must reach (roll-under formulas carry their own target); null → only the number is reported. */
    difficulty: number | null;
    /** Words in the user's message that call for this check (RU/EN stems, e.g. «убед», «уговор», "persuad"). */
    triggers: string[];
    /** Natural max/min of the die count as critical success/failure (default true for d20 and d100). */
    criticals?: boolean;
}

export type MechanicScope = { kind: 'global' } | { kind: 'card'; avatar: string } | { kind: 'chat'; chatId: string };

export interface MechanicDef {
    id: string;
    /** Display name («Магия»). */
    name: string;
    /** English name for the model ("Magic"); absent → the display name. */
    promptName?: string;
    /** Short English summary for the model. */
    summary: string;
    /** English rules for the model (what the attributes mean, costs, limits). */
    rules: string;
    attributes: AttributeDef[];
    holders: HolderSpec;
    checks: CheckDef[];
    /** Default tracking of the attributes. */
    tracking: TrackingMode;
    /** Where the mechanic applies; a chat can still switch it off. */
    scope: MechanicScope;
    /** Template it was made from (informational). */
    template?: string;
    /** Storage, set by the definitions store. */
    book?: string;
    uid?: number;
    updatedAt?: number;
}

/** A ready-made mechanic: health and stamina, magic with mana and schools, faction reputation, money, skills… */
export interface MechanicTemplate {
    id: string;
    /** i18n key of the title and of the description. */
    titleKey: string;
    descriptionKey: string;
    /** The definition the template creates (id and scope are set on creation). */
    build(locale: 'en' | 'ru'): Omit<MechanicDef, 'id' | 'scope'>;
}

/** Values of one holder in one mechanic. */
export interface HolderState {
    mechanicId: string;
    /** Canonical character name, the persona's name, 'world', or a faction name. */
    holder: string;
    values: Record<string, AttributeValue>;
    /** Committed message index of the last change (-1: initial). */
    updatedAt: number;
}

export type ChangeSource = 'desStats' | 'block' | 'background' | 'check' | 'event' | 'user';

export interface StateChange {
    id: string;
    mechanicId: string;
    holder: string;
    attribute: string;
    from: AttributeValue | null;
    to: AttributeValue;
    source: ChangeSource;
    /** Committed (or, for the block, received) message index the change came from; -1 for user edits. */
    messageIndex: number;
    /** Short reason/quote (Russian allowed). */
    reason?: string;
    at: number;
}

export type CheckOutcome = 'critical' | 'success' | 'failure' | 'fumble' | 'none';

export interface CheckResult {
    id: string;
    mechanicId: string;
    checkId: string;
    holder: string;
    dice: string;
    rolls: number[];
    modifier: number;
    total: number;
    /** Target (difficulty or roll-under value); null when none. */
    target: number | null;
    outcome: CheckOutcome;
    /** The fact for the prompt, English: "Persuasion check (Kai): rolled 14 + 2 = 16 vs 15 — success." */
    text: string;
    /** The user message the check was rolled for (its index), -1 when by button with no message. */
    messageIndex: number;
    /** 'auto': triggered by the user's message; 'user': the pult button or /maestro-roll. */
    by: 'auto' | 'user';
    at: number;
}

/** A threshold event that fired (for the director's twists and the pult). */
export interface FiredEvent {
    mechanicId: string;
    holder: string;
    attribute: string;
    eventId: string;
    /** The filled-in English note. */
    text: string;
    messageIndex: number;
    at: number;
}

export interface MechanicsApi {
    /** Definitions visible in this chat (global, this card's, this chat's), enabled or not. */
    list(): MechanicDef[];
    /** The ones on in this chat. */
    active(): MechanicDef[];
    get(id: string): MechanicDef | null;
    /** Creates or updates a definition (writes its Maestro book entry; journaled with undo). */
    save(def: MechanicDef): Promise<MechanicDef>;
    remove(id: string): Promise<void>;
    templates(): MechanicTemplate[];
    /** An unsaved definition from a template (id generated, scope: this card). */
    fromTemplate(templateId: string): MechanicDef | null;
    /** Per-chat switch (default: on for global/card/chat definitions that match). */
    setEnabledInChat(id: string, on: boolean): Promise<void>;
    /** Current values (all holders, or one). */
    state(holder?: string): HolderState[];
    value(mechanicId: string, holder: string, attribute: string): AttributeValue | null;
    /** The user's edit of a value (journaled, undoable). */
    set(mechanicId: string, holder: string, attribute: string, value: AttributeValue): Promise<void>;
    /** Recent changes, newest first (default 50). */
    history(limit?: number): StateChange[];
    /** Rolls a check now (button / slash command); the result goes into the next generation as a fact. */
    roll(mechanicId: string, checkId: string, holder: string, options?: { difficulty?: number }): Promise<CheckResult>;
    /** Recent checks, newest first (default 20). */
    checks(limit?: number): CheckResult[];
    /** Recent threshold events, newest first (default 20). */
    events(limit?: number): FiredEvent[];
    onChange(listener: () => void): Unsubscribe;
    /** Twist sources for the director (M13 duck-types it): the latest threshold events (their `text`). */
    twists?(): FiredEvent[];
}
