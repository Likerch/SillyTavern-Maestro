// M25 «Механики», pure parts of the definitions (plan M25 п. 1, 4, 7; §2.1 «Механики: правила», «Тип записи»; P2, P16).
// A mechanic is the user's own game system: attributes (numbers, scales, lists, texts), who has them, English rules for
// the model, threshold events and dice checks. Here: the types (a structural copy of src/features/mechanics/api.ts —
// domain must not import features; the feature layer asserts both stay identical), normalising stored data,
// validation for the constructor, dice formulas (`parseDice`, shared with the dice engine), the lorebook entry of a
// definition (typed fields of the entry type 'mechanic' + `extensions.maestro.mechanic`) and scope matching.
// Pure: no DOM, no SillyTavern.
import { withTemplate } from './canon-book';
import { composeContent, fieldsFromContent, readTypedMeta, withTypedMeta } from './entry-types';

type Dict = Record<string, unknown>;

/* ------------------------------------------------------------------ types (same shape as the public API) */

export type AttributeKind = 'number' | 'scale' | 'list' | 'text';
export type TrackingMode = 'desStats' | 'block' | 'background' | 'manual';
export type AttributeValue = number | string | string[];

export interface AttributeEvent {
    id: string;
    when: { op: '<=' | '>=' | '=' | 'changed'; value?: number | string };
    text: string;
    once?: boolean;
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
}

export type HolderSpec =
    | { kind: 'persona' }
    | { kind: 'characters'; includePersona?: boolean }
    | { kind: 'named'; names: string[] }
    | { kind: 'world' }
    | { kind: 'factions'; names: string[] };

export interface CheckDef {
    id: string;
    name: string;
    promptName: string;
    dice: string;
    difficulty: number | null;
    triggers: string[];
    criticals?: boolean;
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

export interface DiceFormula {
    /** Number of dice (1–100). */
    count: number;
    /** Sides of every die (2–1000). */
    sides: number;
    /**
     * Added to the dice sum (sign 1) or taken from it (sign -1): a constant, an attribute's value (`@attr`) or its
     * D&D modifier (`mod(@attr)` = floor((value - 10) / 2)); null without a modifier.
     */
    modifier: { sign: 1 | -1; term: DiceTerm } | null;
    /**
     * Roll-under (`<=`): the check succeeds when the total is at most this target (a number or an attribute's value);
     * null: the check's difficulty is the target to reach (total >= difficulty).
     */
    under: { kind: 'flat'; value: number } | { kind: 'attr'; attribute: string } | null;
    /** Canonical text: '2d6+3', '1d20+mod(@persuasion)', '1d100<=@stealth'. */
    text: string;
}

const ATTR = '@([a-z][a-z0-9_]*)';
const DICE_RE = new RegExp(`^(\\d*)[dк](\\d+)(?:([+-])(?:(\\d+)|${ATTR}|mod\\(${ATTR}\\)))?(?:<=(?:(\\d+)|${ATTR}))?$`);

/**
 * Parses a check's dice formula: 'NdM', 'NdM+K', 'NdM-K', 'NdM+@attr', 'NdM-@attr', 'NdM+mod(@attr)', and roll-under
 * 'NdM<=@attr' / 'NdM<=K'. N may be omitted (one die); the Russian «к» works as «d» («1к20»); case and spaces do not
 * matter. A modifier together with roll-under, out-of-range numbers and anything else → null.
 */
export function parseDice(formula: string): DiceFormula | null {
    if (typeof formula !== 'string') return null;
    const compact = formula.toLowerCase().replace(/\s+/g, '');
    const match = DICE_RE.exec(compact);
    if (!match) return null;
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

function diceText(formula: Omit<DiceFormula, 'text'>): string {
    let out = `${formula.count}d${formula.sides}`;
    if (formula.modifier) {
        const { sign, term } = formula.modifier;
        const body =
            term.kind === 'flat'
                ? String(term.value)
                : term.kind === 'attr'
                  ? `@${term.attribute}`
                  : `mod(@${term.attribute})`;
        out += `${sign < 0 ? '-' : '+'}${body}`;
    }
    if (formula.under)
        out += `<=${formula.under.kind === 'flat' ? formula.under.value : `@${formula.under.attribute}`}`;
    return out;
}

/** Attributes a formula reads (modifier and roll-under target). */
export function diceAttributes(formula: DiceFormula): string[] {
    const out: string[] = [];
    const term = formula.modifier?.term;
    if (term && term.kind !== 'flat') out.push(term.attribute);
    if (formula.under?.kind === 'attr') out.push(formula.under.attribute);
    return [...new Set(out)];
}

/** D&D ability modifier: floor((value - 10) / 2). */
export function dndModifier(value: number): number {
    return Math.floor((value - 10) / 2);
}

/** The modifier of a formula for given attribute values (a missing value counts as 0 / modifier of 10). */
export function modifierValue(formula: DiceFormula, valueOf: (attribute: string) => number | null): number {
    if (!formula.modifier) return 0;
    const { sign, term } = formula.modifier;
    const raw =
        term.kind === 'flat'
            ? term.value
            : term.kind === 'attr'
              ? (valueOf(term.attribute) ?? 0)
              : dndModifier(valueOf(term.attribute) ?? 10);
    return sign * raw;
}

/** Roll-under target for given attribute values; null for formulas without `<=` (or a missing attribute). */
export function underTarget(formula: DiceFormula, valueOf: (attribute: string) => number | null): number | null {
    if (!formula.under) return null;
    return formula.under.kind === 'flat' ? formula.under.value : valueOf(formula.under.attribute);
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

function normalizeEvent(raw: unknown, index: number): AttributeEvent | null {
    if (!isDict(raw)) return null;
    const when = isDict(raw.when) ? raw.when : {};
    const op = oneOf(EVENT_OPS, when.op);
    if (!op) return null;
    const event: AttributeEvent = { id: str(raw.id) || `event_${index + 1}`, when: { op }, text: text(raw.text) };
    const value = typeof when.value === 'string' ? when.value.trim() : finite(when.value);
    if (op !== 'changed' && value !== undefined) event.when.value = value;
    if (typeof raw.once === 'boolean') event.once = raw.once;
    return event;
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

function eventIssues(attribute: AttributeDef, at: string, push: (issue: DefIssue) => void): void {
    const seen = new Set<string>();
    (attribute.events ?? []).forEach((event, index) => {
        const path = `${at}.events.${index}`;
        const params = { attribute: attribute.name || attribute.id };
        if (!isSnakeId(event.id)) push({ level: 'error', code: 'eventId', path: `${path}.id`, params });
        else if (seen.has(event.id)) push({ level: 'error', code: 'eventIdDuplicate', path: `${path}.id`, params });
        seen.add(event.id);
        if (!event.text.trim()) push({ level: 'error', code: 'eventText', path: `${path}.text`, params });
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
        eventIssues(attribute, at, push);
    });
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
    const events = (attribute.events ?? []).map(eventLine);
    return [`${label}: ${body}`, ...events].join('; ');
}

/** "Persuasion (persuasion): 1d20+mod(@persuasion) vs 12". */
export function describeCheck(check: CheckDef): string {
    const formula = parseDice(check.dice);
    const dice = formula?.text ?? check.dice;
    const target = formula?.under ? '' : check.difficulty !== null ? ` vs ${check.difficulty}` : '';
    return `${check.promptName || check.name} (${check.id}): ${dice}${target}`;
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
