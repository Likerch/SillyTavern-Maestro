// M25 «Механики», pure parts of the definitions (plan M25 п. 1, 4, 7; §2.1 «Механики: правила», «Тип записи»; P2, P16).
// A mechanic is the user's own game system: attributes (numbers, scales, lists, texts), who has them, English rules for
// the model, threshold events and dice checks. Here: the types (a structural copy of src/features/mechanics/api.ts —
// domain must not import features; the feature layer asserts both stay identical), normalising stored data,
// validation for the constructor, dice formulas (`parseDice`, shared with the dice engine), the lorebook entry of a
// definition (typed fields of the entry type 'mechanic' + `extensions.maestro.mechanic`) and scope matching.
// Pure: no DOM, no SillyTavern.
import { withTemplate } from './canon-book';
import { composeContent, fieldsFromContent, readTypedMeta, withTypedMeta } from './entry-types';
import { formulaCycles, formulaErrorText, parseFormula } from './mechanics-formula';
import type { FormulaError } from './mechanics-formula';
import { normalizeVisibilityInput } from './mechanics-visibility';
import type { VisibilityInput } from './mechanics-visibility';

type Dict = Record<string, unknown>;

/* ------------------------------------------------------------------ types (same shape as the public API) */

export type AttributeKind = 'number' | 'scale' | 'list' | 'text';
export type TrackingMode = 'desStats' | 'block' | 'background' | 'manual';
export type AttributeValue = number | string | string[];

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
 * formula ('2d6', '@mana / 2', 'max(1, @roll.margin)').
 */
export interface ChangeAction {
    who: string;
    attr: string;
    op: ChangeOp;
    value: number | string;
    status?: StatusSpec;
    item?: ItemSpec;
}

export interface AttributeEvent {
    id: string;
    when: { op: '<=' | '>=' | '=' | 'changed'; value?: number | string };
    text: string;
    once?: boolean;
    /** What else happens: value changes, a status, an item, revealing a hidden attribute. */
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
    id: string;
    name: string;
    promptName: string;
    kind: AttributeKind;
    min?: number;
    max?: number;
    initial?: AttributeValue;
    levels?: string[];
    options?: string[];
    multi?: boolean;
    tracking?: TrackingMode;
    visible?: boolean;
    events?: AttributeEvent[];
    /** Derived (read-only) number: '50 + 10 * @level'. */
    formula?: string;
    growth?: AttributeGrowth;
    visibility?: VisibilityInput;
}

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

export interface CheckDef {
    id: string;
    name: string;
    promptName: string;
    dice: string;
    difficulty: number | null;
    triggers: string[];
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
    name: string;
    promptName?: string;
    summary: string;
    rules: string;
    attributes: AttributeDef[];
    holders: HolderSpec;
    checks: CheckDef[];
    tracking: TrackingMode;
    scope: MechanicScope;
    template?: string;
    book?: string;
    uid?: number;
    updatedAt?: number;
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
}

export interface MechanicTemplate {
    id: string;
    titleKey: string;
    descriptionKey: string;
    build(locale: 'en' | 'ru'): Omit<MechanicDef, 'id' | 'scope'>;
}

/* ------------------------------------------------------------------ constants */

export const ATTRIBUTE_KINDS: readonly AttributeKind[] = ['number', 'scale', 'list', 'text'];
export const TRACKING_MODES: readonly TrackingMode[] = ['desStats', 'block', 'background', 'manual'];
export const HOLDER_KINDS: readonly HolderSpec['kind'][] = ['persona', 'characters', 'named', 'world', 'factions'];
export const EVENT_OPS: readonly AttributeEvent['when']['op'][] = ['<=', '>=', '=', 'changed'];
export const SCOPE_KINDS: readonly MechanicScope['kind'][] = ['global', 'card', 'chat'];
export const CHANGE_OPS: readonly ChangeOp[] = ['add', 'sub', 'set', 'mul', 'push', 'pull'];
export const EFFECT_ONS: readonly EffectOn[] = ['success', 'failure', 'critical', 'fumble', 'any'];
export const TIME_PERS: readonly TimePer[] = ['turn', 'hour', 'day'];
/** Pseudo attributes of a change. */
export const SPECIAL_ATTRS = ['status', 'item', 'reveal', 'combat'] as const;
export type SpecialAttr = (typeof SPECIAL_ATTRS)[number];
/** Limits of the stored parts. */
export const DEF_LIMITS = { actions: 12, effects: 8, statuses: 40, time: 12, thresholds: 50, keys: 20 } as const;

/** Ids of mechanics, attributes, checks and events: snake_case, a letter first (flags are `maestro_mech_<id>`). */
export const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
export const MAX_ID_LENGTH = 40;
/** Key of the definition JSON inside `entry.extensions.maestro`. */
export const MECHANIC_EXTENSION_KEY = 'mechanic';
/** Entry type of a definition (src/domain/entry-types.ts). */
export const MECHANIC_ENTRY_TYPE = 'mechanic';

/** Dice limits accepted by parseDice. */
export const DICE_LIMITS = { count: 100, sides: 1000, flat: 10000, target: 100000 } as const;

/* ------------------------------------------------------------------ small helpers */

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** A string kept as typed (multi-line rules keep inner spacing), only trimmed at the ends. */
function text(value: unknown): string {
    return typeof value === 'string' ? value.replace(/\r\n?/g, '\n').trim() : '';
}

function finite(value: unknown): number | undefined {
    return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Trimmed non-empty strings without duplicates (case-insensitive), in order. */
export function cleanList(value: unknown): string[] {
    const list = Array.isArray(value) ? value : typeof value === 'string' ? value.split(',') : [];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const item of list) {
        const clean = str(item);
        const key = clean.toLowerCase();
        if (!clean || seen.has(key)) continue;
        seen.add(key);
        out.push(clean);
    }
    return out;
}

function oneOf<T extends string>(list: readonly T[], value: unknown): T | undefined {
    return typeof value === 'string' && (list as readonly string[]).includes(value) ? (value as T) : undefined;
}

/** JSON-safe deep copy. */
export function cloneDef<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

/* ------------------------------------------------------------------ ids */

// prettier-ignore
const TRANSLIT: Record<string, string> = {
    а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k', л: 'l',
    м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts', ч: 'ch', ш: 'sh',
    щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya', і: 'i', ї: 'yi', є: 'ye', ґ: 'g',
};

export function isSnakeId(value: unknown): value is string {
    return typeof value === 'string' && value.length <= MAX_ID_LENGTH && ID_PATTERN.test(value);
}

/** snake_case id from any text («Здоровье» → `zdorove`, "Stamina Points" → `stamina_points`); `fallback` when empty. */
export function snakeId(value: string, fallback = 'item'): string {
    const latin = [...value.toLowerCase()].map((char) => TRANSLIT[char] ?? char).join('');
    let id = latin
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_+|_+$/g, '')
        .slice(0, 32)
        .replace(/_+$/g, '');
    if (id && !/^[a-z]/.test(id)) id = `x_${id}`;
    return id || fallback;
}

/** `base`, else `base_2`, `base_3`… — the first not in `taken`. */
export function uniqueId(base: string, taken: Iterable<string>): string {
    const used = new Set(taken);
    if (!used.has(base)) return base;
    for (let n = 2; ; n++) {
        const candidate = `${base}_${n}`;
        if (!used.has(candidate)) return candidate;
    }
}

/** A fresh mechanic id from its name (readable: it is part of the preset flag `maestro_mech_<id>`). */
export function newMechanicId(name: string, taken: Iterable<string>): string {
    return uniqueId(snakeId(name, 'mechanic'), taken);
}

/* ------------------------------------------------------------------ dice */

export type DiceTerm =
    { kind: 'flat'; value: number } | { kind: 'attr'; attribute: string } | { kind: 'mod'; attribute: string };

/** One part of a multi-term formula: a group of dice (keep highest/lowest, exploding) or a modifier term. */
export type DicePart =
    | {
          kind: 'dice';
          sign: 1 | -1;
          count: number;
          sides: number;
          /** Keep the highest (`high`) or lowest `n` dice: 4d6kh3, 2d20kl1. */
          keep?: { high: boolean; n: number };
          /** A die showing its highest face rolls again and adds (1d6!). */
          explode?: boolean;
      }
    | { kind: 'term'; sign: 1 | -1; term: DiceTerm };

export interface DiceFormula {
    /** Number of dice (1–100); the first group's for multi-term formulas. */
    count: number;
    /** Sides of every die (2–1000); the first group's for multi-term formulas. */
    sides: number;
    /**
     * Added to the dice sum (sign 1) or taken from it (sign -1): a constant, an attribute's value (`@attr`) or its
     * D&D modifier (`mod(@attr)` = floor((value - 10) / 2)); null without a modifier (and for multi-term formulas).
     */
    modifier: { sign: 1 | -1; term: DiceTerm } | null;
    /**
     * Roll-under (`<=`): the check succeeds when the total is at most this target (a number or an attribute's value);
     * null: the check's difficulty is the target to reach (total >= difficulty).
     */
    under: { kind: 'flat'; value: number } | { kind: 'attr'; attribute: string } | null;
    /** Canonical text: '2d6+3', '1d20+mod(@persuasion)', '1d100<=@stealth', '2d6+1d4+3', '4d6kh3'. */
    text: string;
    /** Every part, present only for formulas beyond 'NdM[±term][<=target]' (several groups, keep, exploding). */
    parts?: DicePart[];
}

const ATTR = '@([a-z][a-z0-9_]*)';
const DICE_RE = new RegExp(`^(\\d*)[dк](\\d+)(?:([+-])(?:(\\d+)|${ATTR}|mod\\(${ATTR}\\)))?(?:<=(?:(\\d+)|${ATTR}))?$`);
const PART_RE = new RegExp(`([+-])(?:(\\d*)[dк](\\d+)(?:k([hl])(\\d+))?(!)?|(\\d+)|${ATTR}|mod\\(${ATTR}\\))`, 'y');
const MAX_PARTS = 10;

/**
 * Parses a check's dice formula: 'NdM', 'NdM+K', 'NdM-K', 'NdM+@attr', 'NdM-@attr', 'NdM+mod(@attr)', and roll-under
 * 'NdM<=@attr' / 'NdM<=K'. N may be omitted (one die); the Russian «к» works as «d» («1к20»); case and spaces do not
 * matter. Also several terms ('2d6+1d4+3', '1d20+@agility+2'), keep highest/lowest ('4d6kh3', '2d20kl1') and
 * exploding dice ('1d6!'); those carry `parts`. A modifier together with roll-under, out-of-range numbers and
 * anything else → null.
 */
export function parseDice(formula: string): DiceFormula | null {
    if (typeof formula !== 'string') return null;
    const compact = formula.toLowerCase().replace(/\s+/g, '');
    const match = DICE_RE.exec(compact);
    if (!match) return parseMultiDice(compact);
    const [, countText, sidesText, sign, flat, attr, modAttr, underFlat, underAttr] = match;
    const count = countText ? Number(countText) : 1;
    const sides = Number(sidesText);
    if (!Number.isInteger(count) || count < 1 || count > DICE_LIMITS.count) return null;
    if (!Number.isInteger(sides) || sides < 2 || sides > DICE_LIMITS.sides) return null;
    let modifier: DiceFormula['modifier'] = null;
    if (sign) {
        const term: DiceTerm =
            flat !== undefined
                ? { kind: 'flat', value: Number(flat) }
                : attr !== undefined
                  ? { kind: 'attr', attribute: attr }
                  : { kind: 'mod', attribute: modAttr ?? '' };
        if (term.kind === 'flat' && term.value > DICE_LIMITS.flat) return null;
        if (term.kind !== 'flat' && !isSnakeId(term.attribute)) return null;
        modifier = { sign: sign === '-' ? -1 : 1, term };
    }
    let under: DiceFormula['under'] = null;
    if (underFlat !== undefined) {
        const value = Number(underFlat);
        if (value > DICE_LIMITS.target) return null;
        under = { kind: 'flat', value };
    } else if (underAttr !== undefined) {
        if (!isSnakeId(underAttr)) return null;
        under = { kind: 'attr', attribute: underAttr };
    }
    if (modifier && under) return null;
    return { count, sides, modifier, under, text: diceText({ count, sides, modifier, under }) };
}

/** Several terms, keep and exploding dice (no roll-under). */
function parseMultiDice(compact: string): DiceFormula | null {
    if (!compact || compact.includes('<') || compact.includes('>')) return null;
    const source = /^[+-]/.test(compact) ? compact : `+${compact}`;
    const parts: DicePart[] = [];
    let at = 0;
    let dice = 0;
    while (at < source.length) {
        PART_RE.lastIndex = at;
        const match = PART_RE.exec(source);
        if (!match) return null;
        at = PART_RE.lastIndex;
        const [, signText, countText, sidesText, keepKind, keepText, bang, flat, attr, modAttr] = match;
        const sign: 1 | -1 = signText === '-' ? -1 : 1;
        if (sidesText !== undefined) {
            const count = countText ? Number(countText) : 1;
            const sides = Number(sidesText);
            if (count < 1 || sides < 2 || sides > DICE_LIMITS.sides) return null;
            dice += count;
            const part: DicePart = { kind: 'dice', sign, count, sides };
            if (keepKind) {
                const n = Number(keepText);
                if (!Number.isInteger(n) || n < 1 || n > count) return null;
                part.keep = { high: keepKind === 'h', n };
            }
            if (bang) part.explode = true;
            parts.push(part);
        } else if (flat !== undefined) {
            const value = Number(flat);
            if (value > DICE_LIMITS.flat) return null;
            parts.push({ kind: 'term', sign, term: { kind: 'flat', value } });
        } else {
            const attribute = attr ?? modAttr ?? '';
            if (!isSnakeId(attribute)) return null;
            parts.push({ kind: 'term', sign, term: { kind: attr !== undefined ? 'attr' : 'mod', attribute } });
        }
        if (parts.length > MAX_PARTS) return null;
    }
    const first = parts.find((part): part is Extract<DicePart, { kind: 'dice' }> => part.kind === 'dice');
    if (!first || dice > DICE_LIMITS.count) return null;
    const text = parts
        .map((part, index) => {
            const sign = part.sign < 0 ? '-' : index ? '+' : '';
            if (part.kind === 'term') return `${sign}${termText(part.term)}`;
            const keep = part.keep ? `k${part.keep.high ? 'h' : 'l'}${part.keep.n}` : '';
            return `${sign}${part.count}d${part.sides}${keep}${part.explode ? '!' : ''}`;
        })
        .join('');
    return { count: first.count, sides: first.sides, modifier: null, under: null, text, parts };
}

function termText(term: DiceTerm): string {
    if (term.kind === 'flat') return String(term.value);
    return term.kind === 'attr' ? `@${term.attribute}` : `mod(@${term.attribute})`;
}

function diceText(formula: Omit<DiceFormula, 'text'>): string {
    let out = `${formula.count}d${formula.sides}`;
    if (formula.modifier) {
        const { sign, term } = formula.modifier;
        out += `${sign < 0 ? '-' : '+'}${termText(term)}`;
    }
    if (formula.under)
        out += `<=${formula.under.kind === 'flat' ? formula.under.value : `@${formula.under.attribute}`}`;
    return out;
}

/** The parts of any formula (a simple one as one dice group and its modifier). */
export function diceParts(formula: DiceFormula): DicePart[] {
    if (formula.parts) return formula.parts;
    const parts: DicePart[] = [{ kind: 'dice', sign: 1, count: formula.count, sides: formula.sides }];
    if (formula.modifier) parts.push({ kind: 'term', sign: formula.modifier.sign, term: formula.modifier.term });
    return parts;
}

/** Attributes a formula reads (modifiers and roll-under target). */
export function diceAttributes(formula: DiceFormula): string[] {
    const out: string[] = [];
    for (const part of diceParts(formula)) {
        if (part.kind === 'term' && part.term.kind !== 'flat') out.push(part.term.attribute);
    }
    if (formula.under?.kind === 'attr') out.push(formula.under.attribute);
    return [...new Set(out)];
}

/** D&D ability modifier: floor((value - 10) / 2). */
export function dndModifier(value: number): number {
    return Math.floor((value - 10) / 2);
}

/** The modifier of a formula for given attribute values (a missing value counts as 0 / modifier of 10). */
export function modifierValue(formula: DiceFormula, valueOf: (attribute: string) => number | null): number {
    let total = 0;
    for (const part of diceParts(formula)) {
        if (part.kind !== 'term') continue;
        const { term } = part;
        const raw =
            term.kind === 'flat'
                ? term.value
                : term.kind === 'attr'
                  ? (valueOf(term.attribute) ?? 0)
                  : dndModifier(valueOf(term.attribute) ?? 10);
        total += part.sign * raw;
    }
    return total;
}

/** Roll-under target for given attribute values; null for formulas without `<=` (or a missing attribute). */
export function underTarget(formula: DiceFormula, valueOf: (attribute: string) => number | null): number | null {
    if (!formula.under) return null;
    return formula.under.kind === 'flat' ? formula.under.value : valueOf(formula.under.attribute);
}

/** Lowest and highest natural sum (kept dice, no modifiers); null for exploding dice (no highest). */
export function naturalRange(formula: DiceFormula): { min: number; max: number } | null {
    let min = 0;
    let max = 0;
    for (const part of diceParts(formula)) {
        if (part.kind !== 'dice') continue;
        if (part.explode) return null;
        const kept = part.keep?.n ?? part.count;
        if (part.sign > 0) {
            min += kept;
            max += kept * part.sides;
        } else {
            min -= kept * part.sides;
            max -= kept;
        }
    }
    return { min, max };
}

/** Criticals by default: a single d20 or d100. */
export function criticalsDefault(formula: Pick<DiceFormula, 'count' | 'sides' | 'parts'>): boolean {
    return !formula.parts && formula.count === 1 && (formula.sides === 20 || formula.sides === 100);
}

/** Whether a check counts natural extremes as critical success / failure: its own switch, else the default. */
export function criticalsOf(check: Pick<CheckDef, 'dice' | 'criticals'>): boolean {
    if (typeof check.criticals === 'boolean') return check.criticals;
    const formula = parseDice(check.dice);
    return formula ? criticalsDefault(formula) : false;
}

/* ------------------------------------------------------------------ holders and tracking */

/** The holders are characters (DES stats are possible): the persona, every character, or named characters. */
export function holdsCharacters(holders: HolderSpec): boolean {
    return holders.kind === 'persona' || holders.kind === 'characters' || holders.kind === 'named';
}

/**
 * Effective tracking of an attribute: its own mode, else the mechanic's. DES stats exist only for numbers of
 * characters; anything else that would be 'desStats' falls back to 'background' (validateDef reports an explicit one).
 */
export function trackingOf(def: Pick<MechanicDef, 'tracking' | 'holders'>, attribute: AttributeDef): TrackingMode {
    const mode = attribute.tracking ?? def.tracking;
    if (mode === 'desStats' && (attribute.kind !== 'number' || !holdsCharacters(def.holders))) return 'background';
    return mode;
}

/** Number attributes tracked as DES stats. */
export function desStatsAttributes(def: Pick<MechanicDef, 'tracking' | 'holders' | 'attributes'>): AttributeDef[] {
    return def.attributes.filter((attribute) => trackingOf(def, attribute) === 'desStats');
}

/** Initial value of an attribute for a new holder (bounds and levels respected). */
export function initialValueOf(attribute: AttributeDef): AttributeValue {
    const initial = attribute.initial;
    switch (attribute.kind) {
        case 'number': {
            let value = typeof initial === 'number' && Number.isFinite(initial) ? initial : (attribute.min ?? 0);
            if (attribute.min !== undefined) value = Math.max(attribute.min, value);
            if (attribute.max !== undefined) value = Math.min(attribute.max, value);
            return value;
        }
        case 'scale': {
            const levels = attribute.levels ?? [];
            return typeof initial === 'string' && levels.includes(initial) ? initial : (levels[0] ?? '');
        }
        case 'list': {
            const options = attribute.options ?? [];
            const list = (Array.isArray(initial) ? initial : typeof initial === 'string' ? [initial] : []).filter(
                (item) => options.includes(item),
            );
            return attribute.multi ? list : list.slice(0, 1);
        }
        default:
            return typeof initial === 'string' ? initial : '';
    }
}

/* ------------------------------------------------------------------ normalising stored data */

function numberRecord(raw: unknown): Record<string, number> | undefined {
    if (!isDict(raw)) return undefined;
    const out: Record<string, number> = {};
    for (const [key, value] of Object.entries(raw)) {
        const name = key.trim().toLowerCase();
        const number = finite(value) ?? (typeof value === 'string' && value.trim() ? Number(value) : NaN);
        if (name && Number.isFinite(number)) out[name] = number;
    }
    return Object.keys(out).length ? out : undefined;
}

/** A duration from stored data, or from words: {turns: 3}, {minutes: 120}, {until: {day, minutes}}; null: none. */
export function normalizeDuration(raw: unknown): StatusDuration | null {
    if (!isDict(raw)) return null;
    const out: StatusDuration = {};
    const turns = finite(raw.turns);
    if (turns !== undefined && turns > 0) out.turns = Math.ceil(turns);
    let minutes = finite(raw.minutes) ?? 0;
    minutes += (finite(raw.hours) ?? 0) * 60 + (finite(raw.days) ?? 0) * 1440 + (finite(raw.weeks) ?? 0) * 10080;
    if (minutes > 0) out.minutes = Math.round(minutes);
    if (isDict(raw.until) && finite(raw.until.day) !== undefined) {
        out.until = { day: Math.trunc(raw.until.day as number) };
        const at = finite(raw.until.minutes);
        if (at !== undefined) out.until.minutes = Math.max(0, Math.min(1439, Math.round(at)));
    }
    return Object.keys(out).length ? out : null;
}

export function normalizeStatusSpec(raw: unknown): StatusSpec | null {
    if (typeof raw === 'string') return raw.trim() ? { name: raw.trim() } : null;
    if (!isDict(raw)) return null;
    const name = str(raw.name) || str(raw.promptName) || str(raw.id);
    if (!name) return null;
    const spec: StatusSpec = { name };
    if (str(raw.id)) spec.id = str(raw.id);
    if (str(raw.promptName)) spec.promptName = str(raw.promptName);
    if (raw.duration === null) spec.duration = null;
    else {
        const duration = normalizeDuration(raw.duration);
        if (duration) spec.duration = duration;
    }
    const modifiers = numberRecord(raw.modifiers);
    if (modifiers) spec.modifiers = modifiers;
    const stacks = finite(raw.stacks);
    if (stacks !== undefined && stacks >= 1) spec.stacks = Math.round(stacks);
    const maxStacks = finite(raw.maxStacks);
    if (maxStacks !== undefined && maxStacks >= 1) spec.maxStacks = Math.round(maxStacks);
    if (text(raw.text)) spec.text = text(raw.text);
    if (str(raw.icon)) spec.icon = str(raw.icon);
    return spec;
}

export function normalizeItemSpec(raw: unknown): ItemSpec | null {
    if (typeof raw === 'string') return raw.trim() ? { name: raw.trim() } : null;
    if (!isDict(raw)) return null;
    const name = str(raw.name);
    if (!name) return null;
    const item: ItemSpec = { name };
    const qty = finite(raw.qty);
    if (qty !== undefined) item.qty = qty;
    if (text(raw.desc)) item.desc = text(raw.desc);
    if (raw.equipped === 'worn' || raw.equipped === 'hand') item.equipped = raw.equipped;
    else if (raw.equipped === null) item.equipped = null;
    const tags = cleanList(raw.tags);
    if (tags.length) item.tags = tags;
    const value = finite(raw.value);
    if (value !== undefined && value >= 0) item.value = value;
    const modifiers = numberRecord(raw.modifiers);
    if (modifiers) item.modifiers = modifiers;
    return item;
}

export function normalizeAction(raw: unknown): ChangeAction | null {
    if (!isDict(raw)) return null;
    const attr = str(raw.attr) || str(raw.attribute);
    const op =
        oneOf(CHANGE_OPS, raw.op) ??
        (raw.op === '+' ? 'add' : raw.op === '-' ? 'sub' : raw.op === '=' ? 'set' : undefined);
    if (!attr || !op) return null;
    const value =
        typeof raw.value === 'number' && Number.isFinite(raw.value)
            ? raw.value
            : typeof raw.value === 'string'
              ? raw.value.trim()
              : '';
    const action: ChangeAction = { who: str(raw.who) || 'actor', attr: attr.toLowerCase(), op, value };
    const status = raw.status === undefined ? null : normalizeStatusSpec(raw.status);
    if (status) action.status = status;
    const item = raw.item === undefined ? null : normalizeItemSpec(raw.item);
    if (item) action.item = item;
    return action;
}

function normalizeActions(raw: unknown): ChangeAction[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const actions = raw
        .map(normalizeAction)
        .filter((item): item is ChangeAction => item !== null)
        .slice(0, DEF_LIMITS.actions);
    return actions.length ? actions : undefined;
}

function normalizeEvent(raw: unknown, index: number): AttributeEvent | null {
    if (!isDict(raw)) return null;
    const when = isDict(raw.when) ? raw.when : {};
    const op = oneOf(EVENT_OPS, when.op);
    if (!op) return null;
    const event: AttributeEvent = { id: str(raw.id) || `event_${index + 1}`, when: { op }, text: text(raw.text) };
    const value = typeof when.value === 'string' ? when.value.trim() : finite(when.value);
    if (op !== 'changed' && value !== undefined) event.when.value = value;
    if (typeof raw.once === 'boolean') event.once = raw.once;
    const actions = normalizeActions(raw.actions);
    if (actions) event.actions = actions;
    if (str(raw.chain)) event.chain = str(raw.chain);
    return event;
}

function normalizeEffect(raw: unknown): CheckEffect | null {
    if (!isDict(raw)) return null;
    const on = oneOf(EFFECT_ONS, raw.on);
    if (!on) return null;
    const effect: CheckEffect = { on, changes: normalizeActions(raw.changes) ?? [] };
    if (text(raw.text)) effect.text = text(raw.text);
    return effect.changes.length || effect.text ? effect : null;
}

function normalizeTimeRule(raw: unknown): TimeRule | null {
    if (!isDict(raw)) return null;
    const attr = str(raw.attr).toLowerCase();
    const per = oneOf(TIME_PERS, raw.per);
    const amount =
        typeof raw.amount === 'number' && Number.isFinite(raw.amount)
            ? raw.amount
            : typeof raw.amount === 'string' && raw.amount.trim()
              ? raw.amount.trim()
              : null;
    if (!attr || !per || amount === null) return null;
    const rule: TimeRule = { attr, amount, per };
    if (raw.when === 'rest' || raw.when === 'awake' || raw.when === 'always') rule.when = raw.when;
    return rule;
}

function normalizeProgression(raw: unknown): Progression | undefined {
    if (!isDict(raw)) return undefined;
    const xp = str(raw.xp).toLowerCase();
    const level = str(raw.level).toLowerCase();
    if (!xp || !level || !Array.isArray(raw.thresholds)) return undefined;
    const thresholds = raw.thresholds
        .map((value) => finite(value) ?? (typeof value === 'string' ? Number(value) : NaN))
        .filter((value) => Number.isFinite(value))
        .slice(0, DEF_LIMITS.thresholds);
    const progression: Progression = { xp, level, thresholds };
    const actions = normalizeActions(raw.onLevelUp);
    if (actions) progression.onLevelUp = actions;
    return progression;
}

function normalizeAttribute(raw: unknown, index: number): AttributeDef | null {
    if (!isDict(raw)) return null;
    const kind = oneOf(ATTRIBUTE_KINDS, raw.kind) ?? (raw.kind === undefined ? 'number' : 'text');
    const name = str(raw.name);
    const promptName = str(raw.promptName);
    const attribute: AttributeDef = {
        id: str(raw.id) || `attr_${index + 1}`,
        name: name || promptName,
        promptName: promptName || name,
        kind,
    };
    const initial = raw.initial;
    if (kind === 'number') {
        const min = finite(raw.min);
        const max = finite(raw.max);
        if (min !== undefined) attribute.min = min;
        if (max !== undefined) attribute.max = max;
        const value = finite(initial) ?? (typeof initial === 'string' && initial.trim() ? Number(initial) : undefined);
        if (value !== undefined && Number.isFinite(value)) attribute.initial = value;
    } else if (kind === 'scale') {
        attribute.levels = cleanList(raw.levels);
        if (typeof initial === 'string' && initial.trim()) attribute.initial = initial.trim();
    } else if (kind === 'list') {
        attribute.options = cleanList(raw.options);
        if (raw.multi === true) attribute.multi = true;
        if (Array.isArray(initial) || typeof initial === 'string') attribute.initial = cleanList(initial);
    } else if (typeof initial === 'string') {
        attribute.initial = text(initial);
    }
    const tracking = oneOf(TRACKING_MODES, raw.tracking);
    if (tracking) attribute.tracking = tracking;
    if (typeof raw.visible === 'boolean') attribute.visible = raw.visible;
    if (Array.isArray(raw.events)) {
        const events = raw.events
            .map((item, eventIndex) => normalizeEvent(item, eventIndex))
            .filter((item): item is AttributeEvent => item !== null);
        if (events.length) attribute.events = events;
    }
    if (kind === 'number' && typeof raw.formula === 'string' && raw.formula.trim()) {
        attribute.formula = raw.formula.trim();
    }
    if (kind === 'number' && isDict(raw.growth)) {
        const perUse = finite(raw.growth.perUse);
        if (perUse !== undefined && perUse !== 0) {
            const growth: AttributeGrowth = { perUse };
            const cap = finite(raw.growth.cap);
            if (cap !== undefined) growth.cap = cap;
            if (raw.growth.on === 'success' || raw.growth.on === 'any') growth.on = raw.growth.on;
            attribute.growth = growth;
        }
    }
    const visibility = normalizeVisibilityInput(raw.visibility);
    if (visibility) attribute.visibility = visibility;
    return attribute;
}

function normalizeCheck(raw: unknown, index: number): CheckDef | null {
    if (!isDict(raw)) return null;
    const name = str(raw.name);
    const promptName = str(raw.promptName);
    const difficulty =
        finite(raw.difficulty) ??
        (typeof raw.difficulty === 'string' && raw.difficulty.trim() ? Number(raw.difficulty) : null);
    const check: CheckDef = {
        id: str(raw.id) || `check_${index + 1}`,
        name: name || promptName,
        promptName: promptName || name,
        dice: str(raw.dice),
        difficulty: difficulty !== null && Number.isFinite(difficulty) ? difficulty : null,
        triggers: cleanList(raw.triggers),
    };
    if (typeof raw.criticals === 'boolean') check.criticals = raw.criticals;
    if (Array.isArray(raw.effects)) {
        const effects = raw.effects
            .map(normalizeEffect)
            .filter((item): item is CheckEffect => item !== null)
            .slice(0, DEF_LIMITS.effects);
        if (effects.length) check.effects = effects;
    }
    return check;
}

export function normalizeHolders(raw: unknown): HolderSpec {
    const kind = isDict(raw) ? oneOf(HOLDER_KINDS, raw.kind) : undefined;
    const names = isDict(raw) ? cleanList(raw.names) : [];
    switch (kind) {
        case 'persona':
            return { kind };
        case 'world':
            return { kind };
        case 'named':
            return { kind, names };
        case 'factions':
            return { kind, names };
        default: {
            const holders: HolderSpec = { kind: 'characters' };
            if (isDict(raw) && raw.includePersona === true) holders.includePersona = true;
            return holders;
        }
    }
}

export function normalizeScope(raw: unknown): MechanicScope {
    if (isDict(raw)) {
        if (raw.kind === 'card' && str(raw.avatar)) return { kind: 'card', avatar: str(raw.avatar) };
        if (raw.kind === 'chat' && str(raw.chatId)) return { kind: 'chat', chatId: str(raw.chatId) };
    }
    return { kind: 'global' };
}

/**
 * A structurally valid definition from stored or edited data: types coerced, lists cleaned, defaults filled, fields
 * of other attribute kinds dropped. Semantic problems (bounds, levels, dice…) are left for validateDef.
 * Null when it is not an object or has no id.
 */
export function normalizeDef(raw: unknown): MechanicDef | null {
    if (!isDict(raw)) return null;
    const id = str(raw.id);
    if (!id) return null;
    const def: MechanicDef = {
        id,
        name: str(raw.name) || id,
        ...(str(raw.promptName) ? { promptName: str(raw.promptName) } : {}),
        summary: text(raw.summary),
        rules: text(raw.rules),
        attributes: (Array.isArray(raw.attributes) ? raw.attributes : [])
            .map((item, index) => normalizeAttribute(item, index))
            .filter((item): item is AttributeDef => item !== null),
        holders: normalizeHolders(raw.holders),
        checks: (Array.isArray(raw.checks) ? raw.checks : [])
            .map((item, index) => normalizeCheck(item, index))
            .filter((item): item is CheckDef => item !== null),
        tracking: oneOf(TRACKING_MODES, raw.tracking) ?? 'background',
        scope: normalizeScope(raw.scope),
    };
    if (str(raw.template)) def.template = str(raw.template);
    if (str(raw.book)) def.book = str(raw.book);
    if (typeof raw.uid === 'number' && Number.isInteger(raw.uid) && raw.uid >= 0) def.uid = raw.uid;
    if (finite(raw.updatedAt) !== undefined) def.updatedAt = raw.updatedAt as number;
    const visibility = normalizeVisibilityInput(raw.visibility);
    if (visibility) def.visibility = visibility;
    if (Array.isArray(raw.statuses)) {
        def.statuses = raw.statuses
            .map(normalizeStatusSpec)
            .filter((item): item is StatusSpec => item !== null)
            .slice(0, DEF_LIMITS.statuses);
    }
    if (isDict(raw.inventory)) {
        def.inventory = str(raw.inventory.money) ? { money: str(raw.inventory.money).toLowerCase() } : {};
    }
    if (Array.isArray(raw.time)) {
        const rules = raw.time
            .map(normalizeTimeRule)
            .filter((item): item is TimeRule => item !== null)
            .slice(0, DEF_LIMITS.time);
        if (rules.length) def.time = rules;
    }
    const progression = normalizeProgression(raw.progression);
    if (progression) def.progression = progression;
    if (isDict(raw.combat)) {
        const combat: CombatSpec = {};
        if (str(raw.combat.initiative)) combat.initiative = str(raw.combat.initiative);
        const enemy = numberRecord(raw.combat.enemy);
        if (enemy) combat.enemy = enemy;
        def.combat = combat;
    }
    if (raw.pinned === true) def.pinned = true;
    const keys = cleanList(raw.keys).slice(0, DEF_LIMITS.keys);
    if (keys.length) def.keys = keys;
    return def;
}

/* ------------------------------------------------------------------ validation */

export type IssueLevel = 'error' | 'warn';

/** A problem of a definition; the constructor shows `m25.def.issue.<code>` with `params`. */
export interface DefIssue {
    level: IssueLevel;
    code: string;
    /** Where: 'name', 'attributes.2.min', 'checks.0.dice'… */
    path: string;
    params?: Record<string, string | number>;
}

/** `formulaRef`, `formulaSyntax`… — the issue code of a formula error. */
export function formulaIssueCode(error: FormulaError): string {
    return `formula${error.code[0]?.toUpperCase() ?? ''}${error.code.slice(1)}`;
}

/** Roll references an effect may read: `@roll.total`, `@roll.margin`, `@roll.natural`. */
const ROLL_REFS = new Set(['total', 'margin', 'natural']);

/** Whether a formula reference names something that may exist: an own attribute, another mechanic's, the roll. */
function refKnown(def: MechanicDef, path: readonly string[], roll: boolean): boolean {
    if (path.length === 1) return def.attributes.some((attr) => attr.id === path[0]);
    if (path[0] === 'roll') return roll && path.length === 2 && ROLL_REFS.has(path[1] as string);
    return path.length === 2;
}

/** A formula's problems (syntax, unknown references) as one issue, or none. */
function formulaIssue(
    def: MechanicDef,
    formula: string | number,
    path: string,
    where: string,
    options: { dice: boolean; roll: boolean },
    push: (issue: DefIssue) => void,
): void {
    const parsed = parseFormula(formula, { dice: options.dice });
    if (!parsed.ok) {
        push({
            level: 'error',
            code: formulaIssueCode(parsed.error),
            path,
            params: formulaParams(where, parsed.error),
        });
        return;
    }
    for (const ref of parsed.refs) {
        if (refKnown(def, ref, options.roll)) continue;
        const error: FormulaError = { code: 'ref', detail: `@${ref.join('.')}` };
        push({ level: 'error', code: formulaIssueCode(error), path, params: formulaParams(where, error) });
        return;
    }
}

function formulaParams(where: string, error: FormulaError): Record<string, string | number> {
    return {
        where,
        detail: error.detail ?? '',
        at: error.at !== undefined ? error.at + 1 : '',
        text: formulaErrorText(error),
    };
}

const NUMBER_OPS: readonly ChangeOp[] = ['add', 'sub', 'set', 'mul'];

/** Problems of consequences (check effects, event actions, level-up actions). */
function actionIssues(
    def: MechanicDef,
    actions: readonly ChangeAction[],
    at: string,
    where: string,
    roll: boolean,
    push: (issue: DefIssue) => void,
): void {
    actions.forEach((action, index) => {
        const path = `${at}.${index}`;
        const params = { where, attribute: action.attr };
        if ((SPECIAL_ATTRS as readonly string[]).includes(action.attr)) {
            if (action.attr === 'status' && !action.status && !String(action.value).trim()) {
                push({ level: 'error', code: 'actionStatus', path, params });
            }
            if (action.attr === 'item' && !action.item && !String(action.value).trim()) {
                push({ level: 'error', code: 'actionItem', path, params });
            }
            if (action.attr === 'reveal' && !def.attributes.some((attr) => attr.id === String(action.value).trim())) {
                push({
                    level: 'error',
                    code: 'actionReveal',
                    path,
                    params: { where, attribute: String(action.value) },
                });
            }
            return;
        }
        if (action.attr.includes('.')) {
            if (typeof action.value === 'string' && /^[\d\s@(+-]/.test(action.value)) {
                const parsed = parseFormula(action.value, { dice: true });
                if (!parsed.ok) {
                    push({
                        level: 'error',
                        code: formulaIssueCode(parsed.error),
                        path: `${path}.value`,
                        params: formulaParams(where, parsed.error),
                    });
                }
            }
            return;
        }
        const attr = def.attributes.find((item) => item.id === action.attr);
        if (!attr) {
            push({ level: 'error', code: 'actionAttr', path: `${path}.attr`, params });
            return;
        }
        if (attr.formula) {
            push({
                level: 'error',
                code: 'actionDerived',
                path: `${path}.attr`,
                params: { where, attribute: attr.name },
            });
            return;
        }
        if (attr.kind === 'number') {
            if (!NUMBER_OPS.includes(action.op)) push({ level: 'error', code: 'actionOp', path: `${path}.op`, params });
            else formulaIssue(def, action.value, `${path}.value`, where, { dice: true, roll }, push);
        } else if (attr.kind === 'list' && !['push', 'pull', 'set'].includes(action.op)) {
            push({ level: 'error', code: 'actionOp', path: `${path}.op`, params });
        } else if (attr.kind === 'scale' && !['add', 'sub', 'set'].includes(action.op)) {
            push({ level: 'error', code: 'actionOp', path: `${path}.op`, params });
        } else if (attr.kind === 'text' && action.op !== 'set') {
            push({ level: 'error', code: 'actionOp', path: `${path}.op`, params });
        }
    });
}

/** Every event of a mechanic as `attribute.event` (chains name one). */
function eventKeys(def: MechanicDef): Set<string> {
    const keys = new Set<string>();
    for (const attr of def.attributes) for (const event of attr.events ?? []) keys.add(`${attr.id}.${event.id}`);
    return keys;
}

/** The event a chain names (`event` alone, or `attribute.event`), or null. */
export function findChainEvent(
    def: Pick<MechanicDef, 'attributes'>,
    chain: string,
): { attribute: AttributeDef; event: AttributeEvent } | null {
    const [first, second] = chain.split('.');
    for (const attribute of def.attributes) {
        if (second !== undefined && attribute.id !== first) continue;
        const event = (attribute.events ?? []).find((item) => item.id === (second ?? first));
        if (event) return { attribute, event };
    }
    return null;
}

function eventIssues(def: MechanicDef, attribute: AttributeDef, at: string, push: (issue: DefIssue) => void): void {
    const seen = new Set<string>();
    const known = eventKeys(def);
    (attribute.events ?? []).forEach((event, index) => {
        const path = `${at}.events.${index}`;
        const params = { attribute: attribute.name || attribute.id };
        if (!isSnakeId(event.id)) push({ level: 'error', code: 'eventId', path: `${path}.id`, params });
        else if (seen.has(event.id)) push({ level: 'error', code: 'eventIdDuplicate', path: `${path}.id`, params });
        seen.add(event.id);
        if (!event.text.trim() && !event.actions?.length) {
            push({ level: 'error', code: 'eventText', path: `${path}.text`, params });
        }
        if (event.actions) actionIssues(def, event.actions, `${path}.actions`, params.attribute, false, push);
        if (event.chain) {
            const target = findChainEvent(def, event.chain);
            if (!target || !known.has(`${target.attribute.id}.${target.event.id}`)) {
                push({
                    level: 'error',
                    code: 'eventChain',
                    path: `${path}.chain`,
                    params: { ...params, chain: event.chain },
                });
            } else if (target.attribute.id === attribute.id && target.event.id === event.id) {
                push({ level: 'error', code: 'eventChainSelf', path: `${path}.chain`, params });
            }
        }
        const { op, value } = event.when;
        if (op === 'changed') return;
        if (attribute.kind === 'number') {
            if (typeof value !== 'number') push({ level: 'error', code: 'eventValue', path: `${path}.value`, params });
        } else if (attribute.kind === 'scale') {
            if (typeof value !== 'string' || !(attribute.levels ?? []).includes(value)) {
                push({ level: 'error', code: 'eventLevel', path: `${path}.value`, params });
            }
        } else if (op !== '=') {
            push({ level: 'error', code: 'eventOp', path: `${path}.op`, params });
        } else if (typeof value !== 'string' || !value.trim()) {
            push({ level: 'error', code: 'eventValue', path: `${path}.value`, params });
        }
    });
}

function attributeIssues(def: MechanicDef, push: (issue: DefIssue) => void): void {
    const seen = new Set<string>();
    def.attributes.forEach((attribute, index) => {
        const at = `attributes.${index}`;
        const params = { attribute: attribute.name || attribute.id || String(index + 1) };
        if (!isSnakeId(attribute.id)) push({ level: 'error', code: 'attrId', path: `${at}.id`, params });
        else if (seen.has(attribute.id)) push({ level: 'error', code: 'attrIdDuplicate', path: `${at}.id`, params });
        seen.add(attribute.id);
        if (!attribute.name.trim()) push({ level: 'error', code: 'attrName', path: `${at}.name`, params });
        if (!attribute.promptName.trim())
            push({ level: 'warn', code: 'attrPromptName', path: `${at}.promptName`, params });
        const initial = attribute.initial;
        if (attribute.kind === 'number') {
            const { min, max } = attribute;
            if (min !== undefined && max !== undefined && min > max) {
                push({ level: 'error', code: 'bounds', path: `${at}.min`, params });
            }
            if (initial !== undefined) {
                if (typeof initial !== 'number')
                    push({ level: 'error', code: 'initial', path: `${at}.initial`, params });
                else if ((min !== undefined && initial < min) || (max !== undefined && initial > max)) {
                    push({ level: 'error', code: 'initialRange', path: `${at}.initial`, params });
                }
            }
        } else if (attribute.kind === 'scale') {
            const levels = attribute.levels ?? [];
            if (levels.length < 2) push({ level: 'error', code: 'levels', path: `${at}.levels`, params });
            if (initial !== undefined && (typeof initial !== 'string' || !levels.includes(initial))) {
                push({ level: 'error', code: 'initialLevel', path: `${at}.initial`, params });
            }
        } else if (attribute.kind === 'list') {
            const options = attribute.options ?? [];
            if (!options.length) push({ level: 'error', code: 'options', path: `${at}.options`, params });
            const chosen = Array.isArray(initial) ? initial : initial === undefined ? [] : [String(initial)];
            if (chosen.some((item) => !options.includes(item))) {
                push({ level: 'error', code: 'initialOption', path: `${at}.initial`, params });
            } else if (!attribute.multi && chosen.length > 1) {
                push({ level: 'error', code: 'initialSingle', path: `${at}.initial`, params });
            }
        }
        if (attribute.tracking === 'desStats') {
            if (attribute.kind !== 'number') {
                push({ level: 'error', code: 'desStatsKind', path: `${at}.tracking`, params });
            } else if (!holdsCharacters(def.holders)) {
                push({ level: 'error', code: 'desStatsHolders', path: `${at}.tracking`, params });
            }
        }
        if (attribute.formula !== undefined) {
            formulaIssue(def, attribute.formula, `${at}.formula`, params.attribute, { dice: false, roll: false }, push);
        }
        if (attribute.growth && attribute.growth.cap !== undefined && attribute.max !== undefined) {
            if (attribute.growth.cap > attribute.max)
                push({ level: 'warn', code: 'growthCap', path: `${at}.growth`, params });
        }
        eventIssues(def, attribute, at, push);
    });
    // Derived attributes reading each other in a circle.
    const graph = new Map<string, string[]>();
    for (const attribute of def.attributes) {
        if (!attribute.formula) continue;
        const parsed = parseFormula(attribute.formula);
        if (parsed.ok)
            graph.set(
                attribute.id,
                parsed.refs.filter((ref) => ref.length === 1).map((ref) => ref[0] as string),
            );
    }
    for (const cycle of formulaCycles(graph)) {
        const index = def.attributes.findIndex((attribute) => attribute.id === cycle[0]);
        push({
            level: 'error',
            code: 'formulaCycle',
            path: `attributes.${index}.formula`,
            params: { where: cycle.join(' → '), detail: cycle.join(' → '), at: '', text: 'circle' },
        });
    }
}

function partsIssues(def: MechanicDef, push: (issue: DefIssue) => void): void {
    const number = (id: string) => def.attributes.find((attr) => attr.id === id && attr.kind === 'number');
    (def.time ?? []).forEach((rule, index) => {
        const path = `time.${index}`;
        const attr = number(rule.attr);
        if (!attr) push({ level: 'error', code: 'timeAttr', path: `${path}.attr`, params: { attribute: rule.attr } });
        else if (attr.formula)
            push({ level: 'error', code: 'actionDerived', path, params: { where: attr.name, attribute: attr.name } });
        else formulaIssue(def, rule.amount, `${path}.amount`, attr.name, { dice: true, roll: false }, push);
    });
    const progression = def.progression;
    if (progression) {
        if (!number(progression.xp)) {
            push({
                level: 'error',
                code: 'progressionAttr',
                path: 'progression.xp',
                params: { attribute: progression.xp },
            });
        }
        if (!number(progression.level)) {
            push({
                level: 'error',
                code: 'progressionAttr',
                path: 'progression.level',
                params: { attribute: progression.level },
            });
        }
        const thresholds = progression.thresholds;
        if (
            !thresholds.length ||
            thresholds.some((value, index) => index > 0 && value <= (thresholds[index - 1] as number))
        ) {
            push({ level: 'error', code: 'progressionThresholds', path: 'progression.thresholds' });
        }
        if (progression.onLevelUp) {
            actionIssues(def, progression.onLevelUp, 'progression.onLevelUp', def.name, false, push);
        }
    }
    if (def.combat?.initiative && !def.checks.some((check) => check.id === def.combat?.initiative)) {
        push({
            level: 'error',
            code: 'combatInitiative',
            path: 'combat.initiative',
            params: { check: def.combat.initiative },
        });
    }
    const money = def.inventory?.money;
    if (money && !money.includes('.') && !number(money)) {
        push({ level: 'error', code: 'inventoryMoney', path: 'inventory.money', params: { attribute: money } });
    }
}

function checkIssues(def: MechanicDef, push: (issue: DefIssue) => void): void {
    const seen = new Set<string>();
    const kinds = new Map(def.attributes.map((attribute) => [attribute.id, attribute.kind]));
    def.checks.forEach((check, index) => {
        const at = `checks.${index}`;
        const params = { check: check.name || check.id || String(index + 1) };
        if (!isSnakeId(check.id)) push({ level: 'error', code: 'checkId', path: `${at}.id`, params });
        else if (seen.has(check.id)) push({ level: 'error', code: 'checkIdDuplicate', path: `${at}.id`, params });
        seen.add(check.id);
        if (!check.name.trim()) push({ level: 'error', code: 'checkName', path: `${at}.name`, params });
        const formula = parseDice(check.dice);
        if (!formula) {
            push({ level: 'error', code: 'dice', path: `${at}.dice`, params });
        } else {
            for (const attribute of diceAttributes(formula)) {
                const kind = kinds.get(attribute);
                if (kind === undefined) {
                    push({ level: 'error', code: 'diceUnknown', path: `${at}.dice`, params: { ...params, attribute } });
                } else if (kind !== 'number') {
                    push({ level: 'error', code: 'diceKind', path: `${at}.dice`, params: { ...params, attribute } });
                }
            }
        }
        if (check.difficulty !== null && !Number.isFinite(check.difficulty)) {
            push({ level: 'error', code: 'difficulty', path: `${at}.difficulty`, params });
        }
        if (!check.triggers.length) push({ level: 'warn', code: 'noTriggers', path: `${at}.triggers`, params });
        (check.effects ?? []).forEach((effect, effectIndex) => {
            actionIssues(def, effect.changes, `${at}.effects.${effectIndex}.changes`, params.check, true, push);
        });
    });
}

/** Problems of a (normalised) definition: errors block saving, warnings are shown. */
export function validateDef(def: MechanicDef): DefIssue[] {
    const issues: DefIssue[] = [];
    const push = (issue: DefIssue) => issues.push(issue);
    if (!isSnakeId(def.id)) push({ level: 'error', code: 'id', path: 'id' });
    if (!def.name.trim()) push({ level: 'error', code: 'name', path: 'name' });
    if (!def.attributes.length && !def.checks.length && !def.rules.trim()) {
        push({ level: 'error', code: 'empty', path: 'attributes' });
    }
    if (!def.rules.trim() && !def.summary.trim()) push({ level: 'warn', code: 'noRules', path: 'rules' });
    if ((def.holders.kind === 'named' || def.holders.kind === 'factions') && !def.holders.names.length) {
        push({ level: 'warn', code: 'holderNames', path: 'holders.names' });
    }
    if (def.scope.kind === 'card' && !def.scope.avatar) push({ level: 'error', code: 'scope', path: 'scope' });
    if (def.scope.kind === 'chat' && !def.scope.chatId) push({ level: 'error', code: 'scope', path: 'scope' });
    attributeIssues(def, push);
    checkIssues(def, push);
    partsIssues(def, push);
    return issues;
}

export function hasErrors(issues: readonly DefIssue[]): boolean {
    return issues.some((issue) => issue.level === 'error');
}

/* ------------------------------------------------------------------ scope */

/** Where the chat is: the avatars of its character(s) and its id. */
export interface ScopeContext {
    avatars: string[];
    chatId: string | null;
}

/** The definition applies here: global ones always, card ones with that character, chat ones in that chat. */
export function scopeMatches(scope: MechanicScope, context: ScopeContext): boolean {
    if (scope.kind === 'global') return true;
    if (scope.kind === 'card') return context.avatars.includes(scope.avatar);
    return context.chatId !== null && scope.chatId === context.chatId;
}

/** Scope of a new definition: this character's card, else this chat (group chats), else everywhere. */
export function scopeForNew(context: ScopeContext): MechanicScope {
    if (context.avatars.length === 1 && context.avatars[0]) return { kind: 'card', avatar: context.avatars[0] };
    if (context.chatId) return { kind: 'chat', chatId: context.chatId };
    return { kind: 'global' };
}

/* ------------------------------------------------------------------ English descriptions (entry content) */

function range(attribute: AttributeDef): string {
    const { min, max } = attribute;
    if (min !== undefined && max !== undefined) return ` ${min}–${max}`;
    if (min !== undefined) return ` from ${min}`;
    if (max !== undefined) return ` up to ${max}`;
    return '';
}

function eventLine(event: AttributeEvent): string {
    const when = event.when.op === 'changed' ? 'on change' : `at ${event.when.op} ${String(event.when.value ?? '')}`;
    return `${when}: ${event.text}`;
}

/** "Health (health): number 0–100, starts at 100; at <= 0: {holder} falls unconscious." */
export function describeAttribute(attribute: AttributeDef): string {
    const label = `${attribute.promptName || attribute.name} (${attribute.id})`;
    const initial = attribute.initial;
    let body: string;
    switch (attribute.kind) {
        case 'number':
            body = `number${range(attribute)}${typeof initial === 'number' ? `, starts at ${initial}` : ''}`;
            break;
        case 'scale':
            body = `scale ${(attribute.levels ?? []).join(' < ')}${typeof initial === 'string' && initial ? `, starts at ${initial}` : ''}`;
            break;
        case 'list': {
            const start = Array.isArray(initial) && initial.length ? `, starts with ${initial.join(', ')}` : '';
            body = `${attribute.multi ? 'any of' : 'one of'} ${(attribute.options ?? []).join(', ')}${start}`;
            break;
        }
        default:
            body = 'free text';
    }
    if (attribute.formula) body = `derived number${range(attribute)} = ${attribute.formula}`;
    if (attribute.growth) {
        body += `, grows by ${attribute.growth.perUse} per ${attribute.growth.on === 'any' ? 'use' : 'successful use'}`;
        if (attribute.growth.cap !== undefined) body += ` up to ${attribute.growth.cap}`;
    }
    const events = (attribute.events ?? []).map(eventLine);
    return [`${label}: ${body}`, ...events].join('; ');
}

/** "mana -5", "status +poisoned (3 turns)", "item +rope x2", "reveal attitude" (who omitted when it is the actor). */
export function describeAction(action: ChangeAction): string {
    const who = action.who && action.who !== 'actor' ? `${action.who}'s ` : '';
    const sign =
        action.op === 'push' || action.op === 'add' ? '+' : action.op === 'pull' || action.op === 'sub' ? '-' : '';
    switch (action.attr) {
        case 'status': {
            const name = action.status?.promptName ?? action.status?.name ?? String(action.value);
            const turns = action.status?.duration?.turns;
            return `${who}status ${sign || '+'}${name}${turns ? ` (${turns} turns)` : ''}`;
        }
        case 'item': {
            const name = action.item?.name ?? String(action.value);
            const qty = action.item?.qty ?? 1;
            return `${who}item ${sign || '+'}${name}${qty !== 1 ? ` x${qty}` : ''}`;
        }
        case 'reveal':
            return `reveal ${String(action.value)}`;
        case 'combat':
            return `${action.who && action.who !== 'actor' ? `${action.who} ` : ''}${action.op === 'pull' ? 'leaves' : 'joins'} the fight`;
        default: {
            if (action.op === 'set') return `${who}${action.attr} = ${String(action.value)}`;
            if (action.op === 'mul') return `${who}${action.attr} x${String(action.value)}`;
            return `${who}${action.attr} ${sign}${String(action.value)}`;
        }
    }
}

/** "Persuasion (persuasion): 1d20+mod(@persuasion) vs 12". */
export function describeCheck(check: CheckDef): string {
    const formula = parseDice(check.dice);
    const dice = formula?.text ?? check.dice;
    const target = formula?.under ? '' : check.difficulty !== null ? ` vs ${check.difficulty}` : '';
    const effects = (check.effects ?? []).map((effect) => {
        const parts = effect.changes.map(describeAction);
        if (effect.text) parts.push(effect.text);
        return `on ${effect.on}: ${parts.join(', ')}`;
    });
    const tail = effects.length ? `; ${effects.join('; ')}` : '';
    return `${check.promptName || check.name} (${check.id}): ${dice}${target}${tail}`;
}

export function describeHolders(holders: HolderSpec): string {
    switch (holders.kind) {
        case 'persona':
            return "the user's character";
        case 'characters':
            return holders.includePersona ? "every character and the user's character" : 'every character';
        case 'named':
            return holders.names.join(', ') || 'named characters';
        case 'world':
            return 'the world';
        case 'factions':
            return holders.names.length ? `factions: ${holders.names.join(', ')}` : 'factions';
    }
}

/** The «Costs and limits» field of the entry: holders, attributes and checks, English (regenerated on every save). */
export function mechanicLimits(def: MechanicDef): string {
    const lines = [`Holders: ${describeHolders(def.holders)}`];
    if (def.attributes.length)
        lines.push('Attributes:', ...def.attributes.map((item) => `- ${describeAttribute(item)}`));
    if (def.checks.length) lines.push('Checks:', ...def.checks.map((item) => `- ${describeCheck(item)}`));
    if (def.statuses?.length) {
        lines.push(`Statuses: ${def.statuses.map((status) => status.promptName ?? status.name).join(', ')}`);
    }
    if (def.inventory) lines.push(`Inventory${def.inventory.money ? `, money in ${def.inventory.money}` : ''}`);
    for (const rule of def.time ?? []) {
        const when = rule.when === 'rest' ? ' while resting' : rule.when === 'awake' ? ' while awake' : '';
        lines.push(`Over time: ${rule.attr} ${String(rule.amount)} per ${rule.per}${when}`);
    }
    if (def.progression) {
        const { level, xp, thresholds } = def.progression;
        lines.push(`Levels: ${level} by ${xp} at ${thresholds.join(', ')}`);
    }
    if (def.combat) lines.push(`Combat${def.combat.initiative ? `, initiative by ${def.combat.initiative}` : ''}`);
    return lines.join('\n');
}

/* ------------------------------------------------------------------ the lorebook entry */

/** The stored JSON of a definition (storage fields are the book's business). */
export function storedDef(def: MechanicDef): MechanicDef {
    const copy = cloneDef(def);
    delete copy.book;
    delete copy.uid;
    return copy;
}

/** The definition JSON of an entry, or null when it is not a mechanic entry. */
export function mechanicJsonOf(entry: unknown): Dict | null {
    if (!isDict(entry) || !isDict(entry.extensions) || !isDict(entry.extensions.maestro)) return null;
    const maestro = entry.extensions.maestro;
    if (maestro.type !== undefined && maestro.type !== MECHANIC_ENTRY_TYPE) return null;
    const json = maestro[MECHANIC_EXTENSION_KEY];
    return isDict(json) ? json : null;
}

export function isMechanicEntry(entry: unknown): boolean {
    return mechanicJsonOf(entry) !== null;
}

/**
 * The lorebook entry of a definition. A previous entry keeps its unknown fields, keys and the user's «Examples»
 * text; the entry is always disabled (ST never scans it: Maestro injects the rules itself, P16); its content is the
 * typed fields composed (name, summary, rules, and the holders/attributes/checks as «Costs and limits»).
 */
export function defToEntry(def: MechanicDef, uid: number, previous?: Dict | null): Dict {
    const stored = storedDef(def);
    const before = isDict(previous) ? previous : {};
    const previousTyped = readTypedMeta(isDict(before.extensions) ? before.extensions.maestro : undefined);
    const fields: Record<string, string> = {
        name: stored.name,
        summary: stored.summary,
        rules: stored.rules,
        limits: mechanicLimits(stored),
        examples: previousTyped?.type === MECHANIC_ENTRY_TYPE ? (previousTyped.fields.examples ?? '') : '',
    };
    const meta = { type: MECHANIC_ENTRY_TYPE, fields } as const;
    const extensions = withTypedMeta(before.extensions, meta) ?? {};
    const maestro = isDict(extensions.maestro) ? extensions.maestro : {};
    extensions.maestro = { ...maestro, [MECHANIC_EXTENSION_KEY]: stored };
    const rest: Dict = { ...before };
    delete rest.world;
    return withTemplate({
        ...rest,
        uid,
        comment: stored.name,
        content: composeContent(meta),
        key: Array.isArray(before.key) ? before.key : [],
        keysecondary: Array.isArray(before.keysecondary) ? before.keysecondary : [],
        constant: false,
        disable: true,
        extensions,
    });
}

/**
 * The definition of an entry, tolerant of the user's edits: when the content no longer matches the stored typed
 * fields (edited in ST's editor), the name, summary and rules are read back from the «Label: value» lines; free
 * text without labels becomes the rules. Structured parts (attributes, checks…) always come from the JSON.
 * Null for entries without a mechanic.
 */
export function entryToDef(entry: unknown, book?: string): MechanicDef | null {
    const json = mechanicJsonOf(entry);
    const def = json ? normalizeDef(json) : null;
    if (!def || !isDict(entry)) return null;
    const maestro = (entry.extensions as Dict).maestro as Dict;
    const typed = readTypedMeta(maestro);
    const content = typeof entry.content === 'string' ? entry.content.replace(/\r\n?/g, '\n').trim() : '';
    let fields: Record<string, string> | null = typed?.type === MECHANIC_ENTRY_TYPE ? typed.fields : null;
    const composed = fields ? composeContent({ type: MECHANIC_ENTRY_TYPE, fields }).trim() : null;
    if (composed === null || composed !== content) {
        const parsed = fieldsFromContent(MECHANIC_ENTRY_TYPE, content);
        if (Object.values(parsed).some((value) => value !== '')) fields = parsed;
        else fields = content ? { rules: content } : null;
    }
    if (fields) {
        const name = (fields.name ?? '').trim();
        if (name) def.name = name;
        if (fields.summary !== undefined) def.summary = fields.summary.trim();
        if (fields.rules !== undefined) def.rules = fields.rules.trim();
    }
    if (book) def.book = book;
    else delete def.book;
    if (typeof entry.uid === 'number') def.uid = entry.uid;
    return def;
}
