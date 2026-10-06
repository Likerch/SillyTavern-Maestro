// Mechanics (M25, stage 11; plan-2 §6, release 1.14): the user's own game systems — stats, magic, reputation, money,
// skills, survival, sanity, trade, combat — without lore tricks. A mechanic is defined in the constructor (pult, the
// assistant): attributes (numbers, scales, lists, texts, derived formulas), who has them, rules for the model, change
// events with actions, checks with consequences, statuses, inventories, time rules, levels, fights, visibility.
// Definitions are lore entries of type 'mechanic' in a Maestro book (typed fields + `extensions.maestro.mechanic`); the
// state is a Maestro file per chat. Changes are tracked in one of three ways per attribute: DES stats (the tracker's
// `stats`; the user's own character, whom DES does not list, falls back to the background parse or the block), a
// short service block in the reply (parsed and hidden by Maestro; it can also ask for rolls and run fights), or a
// background parse of the reply. Checks are rolled by Maestro — on the user's words, by hand, or when the model asks —
// their consequences are applied at once, and the result reaches the next generation as a fact. Only the rules and the
// state of what takes part in the scene go into the prompt, near the end (P16), as each mechanic's visibility allows.
// Exposed as app.modules.api<MechanicsApi>('mechanics').
//
// For the UI wave (HUD, the change line under replies, roll cards, narrator messages, the status block, the mechanics
// window, the constructor): read everything through MechanicsApi below; what the player may see in a place is
// `shown(…)`; changes and rolls of a reply are `changesOf(i)` / `rollsOf(i)`; `onEvent` tells what just happened.
import type { Unsubscribe } from '../../shared/contracts';

export type AttributeKind = 'number' | 'scale' | 'list' | 'text';

/**
 * How changes of an attribute are noticed:
 * - 'desStats': a DES character stat (numbers of characters only; Maestro adds the stat to DES's tracker config);
 * - 'block': a short service block the model writes at the end of its reply (Maestro parses, repairs and hides it);
 * - 'background': a cheap background parse of the committed reply;
 * - 'manual': only the user (and checks/events/time) change it.
 */
export type TrackingMode = 'desStats' | 'block' | 'background' | 'manual';

export type AttributeValue = number | string | string[];

/* ------------------------------------------------------------------ visibility (plan-2 §6.А) */

/**
 * Ready-made sets: 'game' — numbers and bars everywhere, the model gets values; 'book' — words instead of numbers, no
 * HUD values, the model gets values and mentions changes in words; 'hidden' — nothing for the player until revealed
 * (an event action `reveal` or MechanicsApi.reveal), the model gets the value (or words); 'secret' — neither the
 * player nor the model: Maestro applies consequences and gives the model only outcomes.
 */
export type VisibilityPreset = 'game' | 'book' | 'hidden' | 'secret';
/** What the model gets: the value ("mana 25/100"), words by thresholds ("mana: low"), nothing. */
export type PromptVisibility = 'value' | 'words' | 'none';
/** How the model may mention changes in its text: not at all, in words, with numbers. */
export type MentionVisibility = 'none' | 'words' | 'numbers';
/** Where the player may see it: HUD, the change line under a reply, narrator messages, the status block, DES, dossier. */
export type VisibilityPlace = 'hud' | 'strip' | 'narrator' | 'statusBlock' | 'des' | 'dossier';
/** How a value is shown there. */
export type ValueView = 'number' | 'bar' | 'words' | 'icon' | 'hidden';

/** One band of words: numbers up to `upTo` (inclusive; the last band may leave it out), or one scale level. */
export interface WordLevel {
    upTo?: number;
    level?: string;
    /** English, for the model ("badly hurt"). */
    label: string;
    /** For the player in the UI language («тяжело ранен»); absent → `label`. */
    display?: string;
}

export interface Visibility {
    preset: VisibilityPreset;
    prompt: PromptVisibility;
    mention: MentionVisibility;
    places: Record<VisibilityPlace, boolean>;
    view: ValueView;
    words?: WordLevel[];
}

/** Stored form: any subset; `preset` fills the rest (default 'game'; В22: statusBlock and narrator off in all). */
export type VisibilityInput = Partial<Omit<Visibility, 'places'>> & {
    places?: Partial<Record<VisibilityPlace, boolean>>;
};

/* ------------------------------------------------------------------ definitions */

/** What a change does: numbers add/sub/set/mul; lists, statuses and items push (add, give) or pull (remove, take). */
export type ChangeOp = 'add' | 'sub' | 'set' | 'mul' | 'push' | 'pull';

/** How long a status lasts (remaining): committed turns, story minutes, or until a story moment. */
export interface StatusDuration {
    turns?: number;
    minutes?: number;
    until?: { day: number; minutes?: number };
}

/** A status (condition) as defined in a mechanic's catalogue or given by a change. */
export interface StatusSpec {
    id?: string;
    /** Display name («Отравлен»). */
    name: string;
    /** English, for the model ("poisoned"); absent → the name. */
    promptName?: string;
    /** null / absent: until removed. */
    duration?: StatusDuration | null;
    /** Attribute id ('stealth', 'magic.mana'), check id ('check:stealth') or 'checks' (every check) → bonus. */
    modifiers?: Record<string, number>;
    stacks?: number;
    /** More applications stack up to this (default 1: a repeat refreshes the duration). */
    maxStacks?: number;
    /** English note for the model while it lasts. */
    text?: string;
    icon?: string;
}

export type EquipSlot = 'worn' | 'hand';

/** An item as given by a change or the user. */
export interface ItemSpec {
    name: string;
    qty?: number;
    desc?: string;
    equipped?: EquipSlot | null;
    tags?: string[];
    /** Price of one in the inventory's money attribute. */
    value?: number;
    /** Bonuses while equipped (keys as status modifiers). */
    modifiers?: Record<string, number>;
}

/**
 * One consequence: of a check's outcome, a threshold event, a level up. `who`: 'actor' (who rolled / the event's
 * holder), 'target' (the other side of an opposed check), 'persona', or a holder name. `attr`: an attribute id of the
 * mechanic, 'mechanic.attr' of another one, or 'status' / 'item' / 'reveal' / 'combat'. `value`: a number, a text, or a
 * formula ('2d6', '@mana / 2', 'max(1, @roll.margin)'; references read the actor's values).
 */
export interface ChangeAction {
    who: string;
    attr: string;
    op: ChangeOp;
    value: number | string;
    status?: StatusSpec;
    item?: ItemSpec;
}

/** A change event: when the value crosses a threshold, a one-shot note for the model, actions, a chained event. */
export interface AttributeEvent {
    id: string;
    when: { op: '<=' | '>=' | '=' | 'changed'; value?: number | string };
    /** English note for the model, e.g. "{holder} collapses from exhaustion." ({holder}, {value} are filled in). */
    text: string;
    /** Fires once until the condition becomes false again (default true). */
    once?: boolean;
    /** What else happens: value changes, a status, an item, revealing a hidden attribute, leaving a fight. */
    actions?: ChangeAction[];
    /** Another event of this mechanic (`eventId` or `attribute.eventId`) that fires right after. */
    chain?: string;
}

/** Growth by use: every check that reads the attribute (success by default) adds `perUse`, up to `cap`. */
export interface AttributeGrowth {
    perUse: number;
    cap?: number;
    on?: 'success' | 'any';
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
    /** Old switch: false = secret (neither the widgets nor the model). Prefer `visibility`. */
    visible?: boolean;
    events?: AttributeEvent[];
    /** Derived (read-only) number: '50 + 10 * @level' (min/max/floor/ceil/round/abs/clamp, @attr, @mechanic.attr). */
    formula?: string;
    growth?: AttributeGrowth;
    /** Overrides of the mechanic's visibility. */
    visibility?: VisibilityInput;
    /** A short sign before the value on the play surfaces (an emoji: «❤», «🔷»). */
    icon?: string;
}

/** Who has the attributes. Faction and world holders are named things, not characters. */
export type HolderSpec =
    | { kind: 'persona' }
    | { kind: 'characters'; includePersona?: boolean }
    | { kind: 'named'; names: string[] }
    | { kind: 'world' }
    | { kind: 'factions'; names: string[] };

export type EffectOn = 'success' | 'failure' | 'critical' | 'fumble' | 'any';

/** Consequences of a check's outcome ('success' also covers a critical, 'failure' a fumble). */
export interface CheckEffect {
    on: EffectOn;
    changes: ChangeAction[];
    /** English outcome for the model ("the guards raise the alarm"); a secret mechanic gives only these. */
    text?: string;
}

/** A check the mechanic offers («Убеждение»): dice, the attribute that modifies it, difficulty, trigger words. */
export interface CheckDef {
    id: string;
    name: string;
    /** English, for the fact in the prompt ("Persuasion"). */
    promptName: string;
    /**
     * Dice formula: 'NdM', 'NdM+K', 'NdM+@attr' (attribute value as modifier), 'NdM+mod(@attr)' (D&D modifier
     * (value-10)/2), a roll-under '1d100<=@attr', several terms '2d6+1d4+3', keep '4d6kh3', exploding '1d6!'.
     * Unknown formulas are refused by the constructor.
     */
    dice: string;
    /** Target the total must reach (roll-under formulas carry their own target); null → only the number is reported. */
    difficulty: number | null;
    /** Words in the user's message that call for this check (RU/EN stems, e.g. «убед», «уговор», "persuad"). */
    triggers: string[];
    /** Natural max/min of the kept dice as critical success/failure (default: true for one d20 or d100). */
    criticals?: boolean;
    effects?: CheckEffect[];
}

export type TimePer = 'turn' | 'hour' | 'day';

/** Regeneration or decay by story time: `amount` (a number or formula) per committed turn, story hour or day. */
export interface TimeRule {
    attr: string;
    amount: number | string;
    per: TimePer;
    /** 'rest': only while resting (a rest status, a long pause, a time skip); 'awake': not while resting. */
    when?: 'always' | 'rest' | 'awake';
}

/** Experience and levels: crossing `thresholds[i]` of `xp` makes `level` i + 2 (level 1 below the first). */
export interface Progression {
    xp: string;
    level: string;
    thresholds: number[];
    onLevelUp?: ChangeAction[];
}

/** The mechanic keeps inventories of its holders; items with a price trade against `money` ('coins', 'money.coins'). */
export interface InventorySpec {
    money?: string;
}

/** The mechanic runs fights: initiative check, the stats a new enemy starts with. */
export interface CombatSpec {
    initiative?: string;
    enemy?: Record<string, number>;
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
    /** Where it is seen (default «Игровой» / 'game'). */
    visibility?: VisibilityInput;
    /** Status catalogue; present (even empty) → the mechanic's holders can have statuses. */
    statuses?: StatusSpec[];
    inventory?: InventorySpec;
    time?: TimeRule[];
    progression?: Progression;
    combat?: CombatSpec;
    /** World and faction mechanics: always in the prompt (else only when mentioned). */
    pinned?: boolean;
    /** Extra words that make a world mechanic relevant when mentioned. */
    keys?: string[];
    /** The summary and rules as the user wrote them (his language); `summary` / `rules` are the English the model gets. */
    summarySource?: string;
    rulesSource?: string;
    /** Hashes of the source texts the English was translated from (a changed source is translated again). */
    translatedFrom?: { summary?: string; rules?: string };
    /** Narrator messages of this mechanic's rolls are part of the story for the model too (default: the player's). */
    narratorToModel?: boolean;
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

/* ------------------------------------------------------------------ state */

/** Values of one holder in one mechanic. */
export interface HolderState {
    mechanicId: string;
    /** Canonical character name, the persona's name, 'world', or a faction name. */
    holder: string;
    /** Stored values (initial ones for attributes never changed); derived attributes computed. */
    values: Record<string, AttributeValue>;
    /** Committed message index of the last change (-1: initial). */
    updatedAt: number;
}

/** A status on a holder now. */
export interface StatusState {
    /** Instance id (removeStatus takes it). */
    id: string;
    /** Snake id of the status: a repeat refreshes or stacks it. */
    statusId: string;
    name: string;
    promptName: string;
    /** What is left: committed turns and/or story minutes; null: until removed or until `until`. */
    remaining: { turns?: number; minutes?: number } | null;
    until?: { day: number; minutes?: number };
    modifiers: Record<string, number>;
    stacks: number;
    maxStacks: number;
    /** A ChangeSource. */
    source: string;
    /** Message index it came from (-1: by hand). */
    since: number;
    at: number;
    mechanicId?: string;
    text?: string;
    icon?: string;
}

/** An item a holder has. */
export interface ItemState {
    id: string;
    name: string;
    qty: number;
    desc?: string;
    equipped?: EquipSlot | null;
    tags?: string[];
    value?: number;
    modifiers?: Record<string, number>;
}

export interface Combatant {
    holder: string;
    /** Initiative total (higher acts first). */
    init: number;
    enemy?: boolean;
    out?: boolean;
}

export interface CombatState {
    active: boolean;
    /** One round per committed reply. */
    round: number;
    order: Combatant[];
    /** Index into `order` of who acts now. */
    current: number;
    mechanicId: string | null;
    startedAt: number;
    by: 'user' | 'director' | 'model';
    endedAt?: number;
}

/** The story clock the mechanics follow (DES date and time of the committed replies). */
export interface MechanicsClock {
    /** Story day counter (the calendar's). */
    day: number;
    /** Minutes since midnight, when DES gave a time. */
    minutes?: number;
    /** The date as DES wrote it. */
    label: string;
}

/** A number with its parts: the stored (or derived) base and the modifiers of statuses and equipped items. */
export interface DerivedValue {
    mechanicId: string;
    holder: string;
    attribute: string;
    base: number;
    value: number;
    parts: { from: 'status' | 'item'; name: string; amount: number }[];
    /** Derived attributes: the formula, and references that had no value. */
    formula?: string;
    missing?: string[];
}

export type ChangeSource = 'desStats' | 'block' | 'background' | 'check' | 'event' | 'user' | 'time';

export interface StateChange {
    id: string;
    mechanicId: string;
    holder: string;
    /** Attribute id; 'status', 'item' or 'combat' for those kinds. */
    attribute: string;
    /** value: the values; status: the label before/after (or remaining turns on a tick); item: quantities. */
    from: AttributeValue | null;
    to: AttributeValue;
    source: ChangeSource;
    /** Committed (or, for the block, received) message index the change came from; -1 for user edits. */
    messageIndex: number;
    /** Short reason/quote (Russian allowed). */
    reason?: string;
    at: number;
    /** Absent: a value change. */
    kind?: 'status' | 'item' | 'reveal' | 'combat';
    /** The roll whose consequence this is. */
    rollId?: string;
    /** Changes made together (a reset, an event chain): undone together. */
    batch?: string;
    status?: StatusState;
    item?: ItemState;
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
    /** The message the check belongs to: the user's message (auto, by hand before sending), the reply (model). */
    messageIndex: number;
    /** 'auto': triggered by the user's message; 'user': the pult button or /maestro-roll; 'model': asked for in a reply. */
    by: 'auto' | 'user' | 'model';
    at: number;
    // Additions of plan-2 §6 (optional: older logs lack them).
    /** Advantage / disadvantage, and the total of the roll that was not kept. */
    mode?: 'adv' | 'dis';
    other?: number;
    /** An opposed check: the other side. */
    vs?: { holder: string; mechanicId: string; checkId: string; total: number; rolls: number[] };
    /** English consequences given to the model ("Kai: mana -10"). */
    consequences?: string[];
    /** Ids of the changes the roll made (StateChange.id). */
    changes?: string[];
    /** The player must not see this roll (a hidden or secret mechanic). */
    hidden?: boolean;
    /** Its consequences were taken back (undoRoll). */
    undone?: boolean;
}

/** A threshold event that fired (for the director's twists and the pult). */
export interface FiredEvent {
    mechanicId: string;
    holder: string;
    /** Attribute id; 'status' for an expiry, 'combat' for the end of a fight. */
    attribute: string;
    eventId: string;
    /** The filled-in English note. */
    text: string;
    messageIndex: number;
    at: number;
}

/** What `onEvent` reports. */
export type MechanicsEvent =
    | { type: 'changes'; changes: StateChange[]; messageIndex: number }
    | { type: 'roll'; result: CheckResult }
    | { type: 'event'; event: FiredEvent }
    | { type: 'combat'; combat: CombatState | null }
    | { type: 'undone'; changes: StateChange[] };

/** What the next generation would get (MechanicPrompt.preview). */
export interface MechanicsPromptPreview {
    /** The rules + state block as the next generation would get it ('' when no mechanic takes part). */
    text: string;
    tokens: number;
    budget: number;
    budgetSource: 'architect' | 'own';
    /** What was cut to fit, in order (kind 'holder' | 'extra' | 'rules' | 'mechanic'). */
    cut: { kind: string; mechanicId?: string; holder?: string }[];
    /** Mechanics in the scene (their flags are set). */
    mechanics: string[];
    flags: string[];
    /** The facts block the next normal generation would get. */
    facts: string;
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
    /** An unsaved definition from a template (id generated, scope: this card; reputation: factions of the lore). */
    fromTemplate(templateId: string): MechanicDef | null;
    /** Per-chat switch (default: on for global/card/chat definitions that match). */
    setEnabledInChat(id: string, on: boolean): Promise<void>;
    /** Current values (all holders, or one). */
    state(holder?: string): HolderState[];
    /** A value (derived attributes computed; no modifiers — see `derived`). */
    value(mechanicId: string, holder: string, attribute: string): AttributeValue | null;
    /** The user's edit of a value (journaled, undoable). */
    set(mechanicId: string, holder: string, attribute: string, value: AttributeValue): Promise<void>;
    /** Recent changes, newest first (default 50). */
    history(limit?: number): StateChange[];
    /** Rolls a check now (button / slash command); the result goes into the next generation as a fact. */
    roll(
        mechanicId: string,
        checkId: string,
        holder: string,
        options?: {
            difficulty?: number;
            mode?: 'adv' | 'dis';
            /** An opposed check against another holder (its check, default the same one). */
            vs?: { holder: string; mechanicId?: string; checkId?: string };
        },
    ): Promise<CheckResult>;
    /** Recent checks, newest first (default 20). */
    checks(limit?: number): CheckResult[];
    /** Recent threshold events, newest first (default 20). */
    events(limit?: number): FiredEvent[];
    onChange(listener: () => void): Unsubscribe;
    /** Twist sources for the director (M13 duck-types it): the latest threshold events (their `text`). */
    twists?(): FiredEvent[];

    // ---- plan-2 §6 (release 1.14); optional so that fakes of the stage-11 contract stay valid.
    /** Changes a message caused (a reply's tracking and time, a user message's rolls), oldest first. With `place`:
     *  only what the player may see there (hidden-unrevealed and secret attributes dropped). */
    changesOf?(messageIndex: number, options?: { place?: VisibilityPlace }): StateChange[];
    /** Rolls of a message (the user's message: auto and by-hand rolls; a reply: rolls the model asked for). */
    rollsOf?(messageIndex: number): CheckResult[];
    /** Takes one change back (journaled). False when it cannot be (a text overwritten later, a fight changed since). */
    undoChange?(changeId: string): Promise<boolean>;
    /** Takes back every consequence of a roll (the roll stays in the log, marked undone). */
    undoRoll?(rollId: string): Promise<boolean>;
    /** Back to the start: values to initial, statuses and items gone (journaled, undoable as one). */
    reset?(target: { mechanicId?: string; holder?: string }): Promise<number>;
    /** The effective visibility of a mechanic or one attribute. */
    visibilityOf?(mechanicId: string, attribute?: string): Visibility | null;
    /** The player may see it in this place now (hidden: once revealed; secret: never). */
    shown?(mechanicId: string, attribute: string, place: VisibilityPlace, holder?: string): boolean;
    /** The words of a value for the player and the model (bands of the attribute, default bands of bounded numbers). */
    wordsOf?(
        mechanicId: string,
        attribute: string,
        value: AttributeValue | null,
    ): { label: string; display?: string; band?: number } | null;
    /** Saves a mechanic's (or one attribute's) visibility: a preset or fields (the definition is journaled). */
    setVisibility?(
        mechanicId: string,
        attribute: string | null,
        visibility: VisibilityPreset | VisibilityInput,
    ): Promise<void>;
    /** Reveals (or hides again) a hidden attribute for a holder ('*': everyone) — journaled. */
    reveal?(mechanicId: string, holder: string, attribute: string, on?: boolean): Promise<void>;
    isRevealed?(mechanicId: string, holder: string, attribute: string): boolean;
    /** Numbers with their status and item modifiers (derived attributes computed). */
    derived?(mechanicId: string, holder: string): DerivedValue[];
    statuses?(holder?: string): { holder: string; statuses: StatusState[] }[];
    addStatus?(holder: string, status: StatusSpec, mechanicId?: string): Promise<StateChange | null>;
    removeStatus?(holder: string, status: string): Promise<boolean>;
    items?(holder?: string): { holder: string; items: ItemState[] }[];
    giveItem?(holder: string, item: ItemSpec, qty?: number, mechanicId?: string): Promise<StateChange | null>;
    takeItem?(holder: string, name: string, qty?: number): Promise<StateChange | null>;
    equipItem?(holder: string, name: string, slot: EquipSlot | null): Promise<StateChange | null>;
    /** Buys `qty` of an item at its price (or `price` each) from the inventory's money; false when money is short. */
    buy?(holder: string, item: ItemSpec, qty?: number, price?: number): Promise<boolean>;
    /** Sells `qty` of an item for half its price (or `price` each) into the inventory's money. */
    sell?(holder: string, name: string, qty?: number, price?: number): Promise<boolean>;
    combat?(): CombatState | null;
    /** Starts a fight: initiative rolled for everyone in the scene of the combat mechanic and the enemies. */
    startCombat?(options?: { enemies?: string[]; mechanicId?: string }): Promise<CombatState | null>;
    endCombat?(): Promise<void>;
    /** The next combatant acts (a new round after the last). */
    nextTurn?(): Promise<CombatState | null>;
    addEnemy?(name: string, values?: Record<string, number>): Promise<void>;
    clock?(): MechanicsClock | null;
    /** What the next generation would get: the rules block, its budget and cuts, the facts. */
    previewPrompt?(): MechanicsPromptPreview | null;
    /** What just happened (changes, rolls, events, the fight, undo) — for the change line, roll cards, narrator. */
    onEvent?(listener: (event: MechanicsEvent) => void): Unsubscribe;

    // ---- plan-2 §6.А, the play surfaces (release 1.14, second wave); optional like the rest.
    /** Holders of a mechanic in the scene now (present characters, the persona, factions and the world when named). */
    holdersInScene?(mechanicId: string): string[];
    /** The user's character's name ('' without one). */
    persona?(): string;
    /**
     * Draws a holder's mechanics as the player may see them in a place (the dossier's «Механики» section): values in
     * their view, statuses with what is left, items. Nothing is drawn (null) when there is nothing to show.
     */
    renderHolder?(container: HTMLElement, holder: string, place: VisibilityPlace): Unsubscribe | null;
}
