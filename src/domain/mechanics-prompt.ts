// M25 «Механики», the prompt (plan M25 п.5, P16; release 1.27 «механики, которые правят игрой»): what the main model
// gets about the mechanics taking part in the scene, as two English blocks.
// - The rules, `<game_rules>` … `</game_rules>`: one framing line (the systems are binding; the values are in
//   <game_state>), per mechanic a `## Name` heading with its rules (line breaks kept, spaces compacted) and the line that
//   tells how changes may be mentioned, then the service-block instruction of the tracking part. Its mechanics come in
//   a stable order (the definitions', not the importance), so the block stays the same while the scene's mechanics do
//   not change and may sit at the top of the prompt.
// - The state, `<game_state>` … `</game_state>`: per holder (the user's character first) one line per mechanic with the
//   values the model may know — bounded numbers with their band word ("mana 12/100 (very low)"), 'words' attributes as
//   words only —, a "now:" line with the lasting threshold events whose condition holds now ("now: Kai has no mana left
//   and cannot cast.", every generation while it holds: '<=', '>=', '=' events unless `lasting: false`; of several on
//   one attribute and side the most extreme), the conditions with what is left and their modifiers ("poisoned (2 turns
//   left; checks −2): nausea") and the inventory; then the fixed lines (the fight, DES's tracker stats) and one closing
//   line.
// One shared token budget, cut least important first: the rules (to the summary, then nothing; the least important
// mechanic first), the other holders' values, inventories, then conditions (the main holders' after them), the other
// holders' "now" lines, the main holders' values (the persona), their "now" lines, whole mechanics. The block
// instruction and the fixed lines are never cut. Sections come most important first (orderSections: facts of this
// generation, changed lately, named in the user's latest message, the rest); the cutting goes from the end.
// Plus the facts block for one generation: check results and fired events.
// Visibility (plan-2 §6.А): an attribute the model must not know (prompt 'none', secret) never appears; 'words' gives the
// word band instead of the number ("mana: low"); attributes that may be mentioned only in words, or not at all, get a
// "Changes: …" line after the mechanic's rules.
// Pure: no DOM, no SillyTavern. The shapes are structural copies of features/mechanics/api.ts (domain cannot import
// feature types); a MechanicDef fits PromptMechanic as is.
import { estimateTokens } from './rules-lore';
import { eventCondition, fillEventText, nameKey, toNumber } from './mechanics-state';
import { mentionLine, resolveVisibility, wordsFor } from './mechanics-visibility';
import type { MentionGroup, MentionVisibility, VisibilityInput } from './mechanics-visibility';
import { durationText, itemsText } from './mechanics-status';
import type { ItemState } from './mechanics-status';

export type PromptValue = number | string | string[];

export interface PromptEvent {
    id: string;
    when: { op: '<=' | '>=' | '=' | 'changed'; value?: number | string };
    text: string;
    /** Shown under the holder every generation while the condition holds (default: true; never for 'changed'). */
    lasting?: boolean;
}

export interface PromptAttribute {
    id: string;
    promptName: string;
    name?: string;
    kind: 'number' | 'scale' | 'list' | 'text';
    min?: number;
    max?: number;
    levels?: string[];
    visible?: boolean;
    visibility?: VisibilityInput;
    events?: readonly PromptEvent[];
}

export interface PromptMechanic {
    id: string;
    name: string;
    /** English name for the model; the display name when absent. */
    promptName?: string;
    summary: string;
    rules: string;
    attributes: readonly PromptAttribute[];
    visibility?: VisibilityInput;
    /** Levels from experience: the level attribute gets no band word ("level 2 (1..5)", never "(very low)"). */
    progression?: { level: string };
}

export interface PromptHolder {
    name: string;
    values: Readonly<Record<string, PromptValue | null | undefined>>;
    /** The main holder of the section (the persona, else the first): its values and "now" lines are cut last. */
    primary?: boolean;
    /** The user's character: named so in the state and shown first. */
    persona?: boolean;
}

export interface PromptSection {
    mechanic: PromptMechanic;
    holders: readonly PromptHolder[];
}

export type TokenCount = (text: string) => number;

export const countTokens: TokenCount = (text) => estimateTokens(text.length);

export const RULES_OPEN = '<game_rules>';
export const RULES_CLOSE = '</game_rules>';
export const STATE_OPEN = '<game_state>';
export const STATE_CLOSE = '</game_state>';
/** The framing line of the rules: at the top of the prompt, or right before the state. */
export const RULES_FRAME = {
    top: 'This story runs on the game systems below. They are binding: costs, limits and outcomes decide what can happen; the current values are in <game_state> near the end.',
    end: 'This story runs on the game systems below. They are binding: costs, limits and outcomes decide what can happen; the current values follow in <game_state>.',
} as const;
export const STATE_CLOSING = 'Write this reply in line with these values.';
export const PERSONA_MARK = "(the user's character)";
export const FACTS_HEADER = '[Mechanics results — already decided; narrate them as given, do not change them]';
const TEXT_VALUE_MAX = 80;

/* ------------------------------------------------------------------ values */

function compact(text: string): string {
    return text.replace(/\s+/g, ' ').trim();
}

function plainNumber(value: number): string {
    return String(Math.round(value * 100) / 100);
}

function labelOf(attribute: PromptAttribute): string {
    return compact(attribute.promptName || attribute.name || attribute.id).toLowerCase();
}

function mechanicLabel(mechanic: PromptMechanic): string {
    return compact(mechanic.promptName || mechanic.name || mechanic.id);
}

/**
 * One value for the model: "mana 12/30", "standing: warm (4/5)", "schools: fire, water", 'mood: "calm"'. `band`: the word
 * of a number ("mana 12/30 (low)", "heat 2 (-10..10, low)").
 */
export function formatValue(
    attribute: PromptAttribute,
    value: PromptValue | null | undefined,
    band?: string | null,
): string | null {
    if (value === null || value === undefined) return null;
    const label = labelOf(attribute);
    switch (attribute.kind) {
        case 'number': {
            const number = typeof value === 'number' ? value : Number(value);
            if (!Number.isFinite(number)) return null;
            const { min, max } = attribute;
            const word = band ? compact(band) : '';
            if (typeof max === 'number') {
                return typeof min === 'number' && min !== 0
                    ? `${label} ${plainNumber(number)} (${plainNumber(min)}..${plainNumber(max)}${word ? `, ${word}` : ''})`
                    : `${label} ${plainNumber(number)}/${plainNumber(max)}${word ? ` (${word})` : ''}`;
            }
            return `${label} ${plainNumber(number)}${word ? ` (${word})` : ''}`;
        }
        case 'scale': {
            const level = String(value);
            const levels = attribute.levels ?? [];
            const index = levels.indexOf(level);
            return index >= 0 ? `${label}: ${level} (${index + 1}/${levels.length})` : `${label}: ${level}`;
        }
        case 'list': {
            const items = (Array.isArray(value) ? value : [String(value)]).map(compact).filter(Boolean);
            return `${label}: ${items.length ? items.join(', ') : 'none'}`;
        }
        default: {
            const text = compact(Array.isArray(value) ? value.join(', ') : String(value));
            if (!text) return null;
            const short = text.length > TEXT_VALUE_MAX ? `${text.slice(0, TEXT_VALUE_MAX - 1).trimEnd()}…` : text;
            return `${label}: "${short}"`;
        }
    }
}

/**
 * The band word of a number the model gets as a value: the attribute's own bands, else the default bands of a bounded
 * number ("very low"); null for other kinds, unbounded numbers without bands and a progression's level.
 */
export function bandWord(
    mechanic: PromptMechanic,
    attribute: PromptAttribute,
    value: PromptValue | null | undefined,
): string | null {
    if (attribute.kind !== 'number' || mechanic.progression?.level === attribute.id) return null;
    const words = wordsFor(attribute, resolveVisibility(mechanic, attribute), value);
    return words ? compact(words.label) || null : null;
}

/** One value as words ("mana: low"), or as a value when the attribute has no words. */
export function wordsValue(
    mechanic: PromptMechanic,
    attribute: PromptAttribute,
    value: PromptValue | null | undefined,
): string | null {
    const words = wordsFor(attribute, resolveVisibility(mechanic, attribute), value);
    if (!words) return formatValue(attribute, value);
    return `${labelOf(attribute)}: ${compact(words.label)}`;
}

/** One value as the model may know it: words, or the value with its band word; null for secret ones. */
export function valueText(
    mechanic: PromptMechanic,
    attribute: PromptAttribute,
    value: PromptValue | null | undefined,
): string | null {
    const visibility = resolveVisibility(mechanic, attribute);
    if (visibility.prompt === 'none') return null;
    if (visibility.prompt === 'words') return wordsValue(mechanic, attribute, value);
    return formatValue(attribute, value, bandWord(mechanic, attribute, value));
}

/** "mana 12/30 (low), schools: fire, water" of one holder in one mechanic, or null when it shows nothing. */
export function holderValues(mechanic: PromptMechanic, holder: PromptHolder): string | null {
    const parts: string[] = [];
    for (const attribute of mechanic.attributes) {
        const text = valueText(mechanic, attribute, holder.values[attribute.id]);
        if (text) parts.push(text);
    }
    return parts.length ? parts.join(', ') : null;
}

/** "Changes: attitude in words only, never as numbers." for attributes that may not be stated with numbers. */
export function mentionText(mechanic: PromptMechanic): string {
    const groups = new Map<MentionVisibility, string[]>();
    for (const attribute of mechanic.attributes) {
        const visibility = resolveVisibility(mechanic, attribute);
        if (visibility.prompt === 'none' || visibility.mention === 'numbers') continue;
        const list = groups.get(visibility.mention) ?? [];
        list.push(labelOf(attribute));
        groups.set(visibility.mention, list);
    }
    const ordered: MentionGroup[] = (['words', 'none'] as const)
        .filter((mention) => groups.has(mention))
        .map((mention) => ({ mention, names: groups.get(mention) ?? [] }));
    return mentionLine(ordered);
}

/* ------------------------------------------------------------------ lasting events */

/** A threshold event the model is reminded of every generation while its condition holds. */
export function isLasting(event: Pick<PromptEvent, 'when' | 'lasting'>): boolean {
    return event.when.op !== 'changed' && event.lasting !== false;
}

/** Where a threshold sits on its attribute: a number (lists: a size), a scale level's index; null when unknown. */
function thresholdRank(attribute: PromptAttribute, raw: number | string | undefined): number | null {
    if (raw === undefined) return null;
    if (attribute.kind === 'scale') {
        const index = (attribute.levels ?? []).findIndex((level) => nameKey(level) === nameKey(String(raw)));
        if (index >= 0) return index;
    }
    return attribute.kind === 'text' ? null : toNumber(raw);
}

/** Of several holding events on one side ('<=' or '>='), the most extreme threshold; '=' events all. */
function strongest(attribute: PromptAttribute, events: readonly PromptEvent[]): PromptEvent[] {
    const keep = new Set<PromptEvent>(events.filter((event) => event.when.op === '='));
    for (const op of ['<=', '>='] as const) {
        const ranked = events
            .filter((event) => event.when.op === op)
            .map((event) => ({ event, rank: thresholdRank(attribute, event.when.value) }));
        const known = ranked.map((item) => item.rank).filter((rank): rank is number => rank !== null);
        const best = known.length ? (op === '<=' ? Math.min(...known) : Math.max(...known)) : null;
        for (const item of ranked) if (item.rank === null || item.rank === best) keep.add(item.event);
    }
    return events.filter((event) => keep.has(event));
}

function sentence(text: string): string {
    const clean = compact(text);
    return !clean || /[.!?…"»)]$/.test(clean) ? clean : `${clean}.`;
}

/**
 * The lasting events of a holder's values that hold now, filled in ("Kai has no mana left and cannot cast."). Only the
 * attributes the model may know; a 'words' attribute fills {value} with its word.
 */
export function lastingLines(mechanic: PromptMechanic, holder: PromptHolder): string[] {
    const lines: string[] = [];
    for (const attribute of mechanic.attributes) {
        const visibility = resolveVisibility(mechanic, attribute);
        if (visibility.prompt === 'none') continue;
        const value = holder.values[attribute.id];
        if (value === null || value === undefined) continue;
        const holding = (attribute.events ?? []).filter((event) => {
            if (!isLasting(event) || !event.text.trim()) return false;
            try {
                return eventCondition(attribute, event.when, value);
            } catch {
                return false;
            }
        });
        if (!holding.length) continue;
        const shown = visibility.prompt === 'words' ? (wordsFor(attribute, visibility, value)?.label ?? value) : value;
        const name = compact(attribute.promptName || attribute.name || attribute.id);
        for (const event of strongest(attribute, holding)) {
            const line = sentence(fillEventText(event.text, compact(holder.name), shown, name));
            if (line && !lines.includes(line)) lines.push(line);
        }
    }
    return lines;
}

/* ------------------------------------------------------------------ conditions and inventories */

export interface PromptStatus {
    promptName: string;
    remaining: { turns?: number; minutes?: number } | null;
    until?: { day: number; minutes?: number };
    stacks?: number;
    text?: string;
    /** Bonuses and penalties per check or attribute ('checks', 'check:stealth', 'mana', 'magic.mana'). */
    modifiers?: Readonly<Record<string, number>>;
    /** The mechanic that gave it (its checks and attributes name the modifier keys first). */
    mechanicId?: string;
}

/** A modifier key in words for the model ("checks", "stealth checks", "mana"), with the status's mechanic. */
export type ModifierLabel = (key: string, mechanicId?: string) => string;

function spaced(id: string): string {
    return compact(id.replace(/_/g, ' '));
}

export const defaultModifierLabel: ModifierLabel = (key) => {
    const clean = key.trim();
    if (clean.toLowerCase() === 'checks') return 'checks';
    if (/^check:/i.test(clean)) return `${spaced(clean.slice(6))} checks`;
    return spaced(clean.includes('.') ? clean.slice(clean.lastIndexOf('.') + 1) : clean);
};

function signed(amount: number): string {
    const rounded = Math.round(amount * 100) / 100;
    return rounded < 0 ? `−${plainNumber(-rounded)}` : `+${plainNumber(rounded)}`;
}

/** "poisoned x2 (2 turns left; checks −4): nausea" — stacks, what is left, the modifiers (times the stacks), the note. */
export function statusText(status: PromptStatus, label: ModifierLabel = defaultModifierLabel): string {
    const stacks = status.stacks && status.stacks > 1 ? status.stacks : 1;
    const inside: string[] = [];
    const time = durationText(status);
    if (time) inside.push(time);
    const modifiers = Object.entries(status.modifiers ?? {})
        .filter(([, amount]) => Number.isFinite(amount) && amount !== 0)
        .map(([key, amount]) => `${label(key, status.mechanicId)} ${signed(amount * stacks)}`);
    if (modifiers.length) inside.push(modifiers.join(', '));
    const note = status.text ? `: ${compact(status.text)}` : '';
    return `${compact(status.promptName)}${stacks > 1 ? ` x${stacks}` : ''}${inside.length ? ` (${inside.join('; ')})` : ''}${note}`;
}

/** What a holder has besides values: conditions and inventory (the producer reads them from the state). */
export interface HolderExtras {
    holder: string;
    statuses?: readonly PromptStatus[];
    items?: readonly ItemState[];
}

/* ------------------------------------------------------------------ fixed lines */

/** The DES line: the tracker's stats are these values (no line without names). */
export function trackerLine(names: readonly string[]): string {
    const clean: string[] = [];
    for (const name of names) {
        const text = compact(name);
        if (text && !clean.some((known) => nameKey(known) === nameKey(text))) clean.push(text);
    }
    return clean.length
        ? `Tracker stats: ${clean.join(', ')} in your tracker JSON are these same values — start from the numbers above and change them only by what happens in this reply.`
        : '';
}

/* ------------------------------------------------------------------ importance */

export interface SectionSignals {
    /** Mechanics with a fact (a roll, an event) in this generation. */
    facts?: Iterable<string>;
    /** Mechanics changed in the last turns. */
    changed?: Iterable<string>;
    /** Mechanics named in the user's latest message (their name, keys, attributes or a holder). */
    named?: Iterable<string>;
}

/** Sections most important first (facts, changed, named, the rest); the given order otherwise. */
export function orderSections<T extends { mechanic: { id: string } }>(
    sections: readonly T[],
    signals: SectionSignals,
): T[] {
    const facts = new Set(signals.facts ?? []);
    const changed = new Set(signals.changed ?? []);
    const named = new Set(signals.named ?? []);
    const rank = (id: string) => (facts.has(id) ? 0 : changed.has(id) ? 1 : named.has(id) ? 2 : 3);
    return sections
        .map((section, index) => ({ section, index, rank: rank(section.mechanic.id) }))
        .sort((a, b) => a.rank - b.rank || a.index - b.index)
        .map((item) => item.section);
}

/** Lower-case words of a text with spaces around: " kai casts a fireball ". */
function plainWords(text: string): string {
    return ` ${nameKey(text)
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .trim()} `;
}

/** The words of a name cut to stems (Russian case endings: «мана» → «ман», «здоровье» → «здоров»). */
function stemsOf(name: string): string[] {
    return plainWords(name)
        .trim()
        .split(' ')
        .filter((word) => word.length >= 3)
        .map((word) => {
            if (!/[а-я]/.test(word) || word.length < 4) return word;
            return word.slice(0, word.length >= 6 ? -2 : -1);
        });
}

/** One of the names occurs in the text (every word of it, as a word start; Russian endings may differ). */
export function mentionedIn(text: string, names: readonly string[]): boolean {
    const plain = plainWords(text);
    return names.some((name) => {
        const stems = stemsOf(name);
        return stems.length > 0 && stems.every((stem) => plain.includes(` ${stem}`));
    });
}

/* ------------------------------------------------------------------ the two blocks */

type RulesLevel = 'full' | 'summary' | 'none';

interface Slice {
    holder: PromptHolder;
    values: string | null;
    now: string[];
}

interface Draft {
    section: PromptSection;
    rules: RulesLevel;
    mention: string;
    slices: Slice[];
}

interface ExtraDraft {
    name: string;
    conditions: string;
    inventory: string;
    primary: boolean;
}

export type CutStep =
    | { kind: 'rules'; mechanicId: string; to: 'summary' | 'none' }
    | { kind: 'holder'; mechanicId: string; holder: string; primary: boolean }
    | { kind: 'extra'; holder: string; what: 'conditions' | 'inventory'; primary: boolean }
    | { kind: 'now'; mechanicId: string; holder: string; primary: boolean }
    | { kind: 'mechanic'; mechanicId: string };

export interface RenderedGame {
    /** `<game_rules>…</game_rules>`, '' when there is nothing to say. */
    rules: string;
    /** `<game_state>…</game_state>`, '' when there is nothing to show. */
    state: string;
    /** Both blocks together (the budget counts them as one). */
    tokens: number;
    rulesTokens: number;
    stateTokens: number;
    /** 0: no budget. */
    budget: number;
    /** What was cut to fit, in order. */
    cut: CutStep[];
    /** Mechanics left in the blocks. */
    mechanics: string[];
}

export interface GameOptions {
    /** Token budget of both blocks together (0 or less: none). */
    budget: number;
    /** The service-block instruction of the tracking part: at the end of the rules, never cut. */
    instruction?: string;
    /** Conditions and inventories of the holders. */
    extras?: readonly HolderExtras[];
    /** Lines at the end of the state that are never cut (the fight, DES's tracker stats). */
    fixed?: readonly string[];
    /** Mechanic ids in the order of the rules block (stable); sections not listed follow in the given order. */
    rulesOrder?: readonly string[];
    /** Where the rules go: the framing line says where the values are (default 'top'). */
    place?: 'top' | 'end';
    modifierLabel?: ModifierLabel;
    count?: TokenCount;
}

/** The rules of a mechanic at a level, lines kept (each compacted, empty ones dropped). */
function rulesBody(mechanic: PromptMechanic, level: RulesLevel): string {
    if (level === 'none') return '';
    const lines = (text: string) => text.split(/\r?\n/).map(compact).filter(Boolean).join('\n');
    const rules = lines(mechanic.rules);
    const summary = lines(mechanic.summary);
    if (level === 'summary') return summary;
    return rules || summary;
}

function sectionRules(draft: Draft): string {
    if (draft.rules === 'none') return '';
    const body = rulesBody(draft.section.mechanic, draft.rules);
    const lines = [body, draft.mention].filter(Boolean);
    return lines.length ? `## ${mechanicLabel(draft.section.mechanic)}\n${lines.join('\n')}` : '';
}

interface Tail {
    instruction: string;
    fixed: string[];
    place: 'top' | 'end';
    rulesOrder: readonly string[];
    extras: ExtraDraft[];
}

function assembleRules(drafts: readonly Draft[], tail: Tail): string {
    const position = (id: string) => {
        const at = tail.rulesOrder.indexOf(id);
        return at < 0 ? Number.MAX_SAFE_INTEGER : at;
    };
    const ordered = drafts
        .map((draft, index) => ({ draft, index }))
        .sort(
            (a, b) =>
                position(a.draft.section.mechanic.id) - position(b.draft.section.mechanic.id) || a.index - b.index,
        )
        .map((item) => item.draft);
    const sections = ordered.map(sectionRules).filter(Boolean);
    const parts = sections.length ? [RULES_FRAME[tail.place], ...sections] : [];
    if (tail.instruction) parts.push(tail.instruction);
    return parts.length ? [RULES_OPEN, parts.join('\n\n'), RULES_CLOSE].join('\n') : '';
}

/** Holders in the order of the state: the user's character first, then as the sections name them, then the rest. */
function holderOrder(drafts: readonly Draft[], extras: readonly ExtraDraft[]): string[] {
    const names: string[] = [];
    const add = (name: string) => {
        if (compact(name) && !names.some((known) => nameKey(known) === nameKey(name))) names.push(compact(name));
    };
    for (const draft of drafts) for (const slice of draft.slices) if (slice.holder.persona) add(slice.holder.name);
    for (const draft of drafts) for (const slice of draft.slices) add(slice.holder.name);
    for (const extra of extras) add(extra.name);
    return names;
}

function assembleState(drafts: readonly Draft[], tail: Tail, order: readonly string[]): string {
    const blocks: string[] = [];
    for (const name of order) {
        const key = nameKey(name);
        const lines: string[] = [];
        const now: string[] = [];
        let persona = false;
        for (const draft of drafts) {
            for (const slice of draft.slices) {
                if (nameKey(slice.holder.name) !== key) continue;
                persona ||= slice.holder.persona === true;
                if (slice.values) lines.push(`- ${mechanicLabel(draft.section.mechanic)}: ${slice.values}`);
                for (const line of slice.now) if (!now.includes(line)) now.push(line);
            }
        }
        if (now.length) lines.push(`- now: ${now.join(' ')}`);
        const extra = tail.extras.find((item) => nameKey(item.name) === key);
        if (extra?.conditions) lines.push(`- conditions: ${extra.conditions}`);
        if (extra?.inventory) lines.push(`- inventory: ${extra.inventory}`);
        if (lines.length) blocks.push([persona ? `${name} ${PERSONA_MARK}` : name, ...lines].join('\n'));
    }
    if (!blocks.length && !tail.fixed.length) return '';
    return [STATE_OPEN, ...blocks, ...tail.fixed, STATE_CLOSING, STATE_CLOSE].join('\n');
}

/** The next thing to cut, least important first; false when nothing is left to cut. */
function cutOne(drafts: Draft[], extras: ExtraDraft[], cut: CutStep[]): boolean {
    const backwards = [...drafts].reverse();
    for (const draft of backwards) {
        const { mechanic } = draft.section;
        if (draft.rules !== 'full' || !rulesBody(mechanic, 'summary') || !compact(mechanic.rules)) continue;
        if (rulesBody(mechanic, 'summary') === rulesBody(mechanic, 'full')) continue;
        draft.rules = 'summary';
        cut.push({ kind: 'rules', mechanicId: mechanic.id, to: 'summary' });
        return true;
    }
    for (const draft of backwards) {
        if (draft.rules === 'none' || !sectionRules(draft)) continue;
        draft.rules = 'none';
        cut.push({ kind: 'rules', mechanicId: draft.section.mechanic.id, to: 'none' });
        return true;
    }
    const slices = (primary: boolean, what: 'values' | 'now') => {
        for (const draft of backwards) {
            for (const slice of [...draft.slices].reverse()) {
                if ((slice.holder.primary === true) !== primary) continue;
                if (what === 'values' ? !slice.values : !slice.now.length) continue;
                if (what === 'values') slice.values = null;
                else slice.now = [];
                cut.push({
                    kind: what === 'values' ? 'holder' : 'now',
                    mechanicId: draft.section.mechanic.id,
                    holder: slice.holder.name,
                    primary,
                });
                return true;
            }
        }
        return false;
    };
    const extra = (primary: boolean, what: 'conditions' | 'inventory') => {
        for (const item of [...extras].reverse()) {
            if (item.primary !== primary || !item[what]) continue;
            item[what] = '';
            cut.push({ kind: 'extra', holder: item.name, what, primary });
            return true;
        }
        return false;
    };
    if (slices(false, 'values')) return true;
    if (extra(false, 'inventory') || extra(false, 'conditions')) return true;
    if (extra(true, 'inventory') || extra(true, 'conditions')) return true;
    if (slices(false, 'now')) return true;
    if (slices(true, 'values')) return true;
    if (slices(true, 'now')) return true;
    const last = drafts.pop();
    if (!last) return false;
    cut.push({ kind: 'mechanic', mechanicId: last.section.mechanic.id });
    return true;
}

/**
 * The rules and the state of the mechanics in the scene, cut together to the budget. Sections are taken in the given
 * order (the caller puts the most important first); the rules block follows `rulesOrder`. Sections without a value
 * still give their rules (they apply in the scene).
 */
export function renderGame(sections: readonly PromptSection[], options: GameOptions): RenderedGame {
    const count = options.count ?? countTokens;
    const label = options.modifierLabel ?? defaultModifierLabel;
    const drafts: Draft[] = sections.map((section) => ({
        section,
        rules: 'full',
        mention: mentionText(section.mechanic),
        slices: section.holders.map((holder) => ({
            holder,
            values: holderValues(section.mechanic, holder),
            now: lastingLines(section.mechanic, holder),
        })),
    }));
    const primaryNames = new Set(
        sections.flatMap((section) =>
            section.holders.filter((holder) => holder.primary || holder.persona).map((holder) => nameKey(holder.name)),
        ),
    );
    const extras: ExtraDraft[] = [];
    for (const entry of options.extras ?? []) {
        const name = compact(entry.holder);
        if (!name) continue;
        const conditions = (entry.statuses ?? []).map((status) => statusText(status, label)).join(', ');
        const inventory = entry.items?.length ? itemsText(entry.items) : '';
        if (!conditions && !inventory) continue;
        const known = extras.find((item) => nameKey(item.name) === nameKey(name));
        if (known) {
            known.conditions ||= conditions;
            known.inventory ||= inventory;
            continue;
        }
        extras.push({ name, conditions, inventory, primary: primaryNames.has(nameKey(name)) });
    }
    const tail: Tail = {
        instruction: (options.instruction ?? '').trim(),
        fixed: (options.fixed ?? []).map(compact).filter(Boolean),
        place: options.place === 'end' ? 'end' : 'top',
        rulesOrder: options.rulesOrder ?? [],
        extras,
    };
    const order = holderOrder(drafts, extras);
    const budget = options.budget > 0 ? Math.floor(options.budget) : 0;
    const cut: CutStep[] = [];
    const render = () => {
        const rules = assembleRules(drafts, tail);
        const state = assembleState(drafts, tail, order);
        const rulesTokens = rules ? count(rules) : 0;
        const stateTokens = state ? count(state) : 0;
        return { rules, state, rulesTokens, stateTokens, tokens: rulesTokens + stateTokens };
    };
    let result = render();
    while (budget > 0 && result.tokens > budget && cutOne(drafts, extras, cut)) result = render();
    // Mechanics that still say something (their rules, a value or a "now" line).
    const mechanics = drafts
        .filter((draft) => sectionRules(draft) || draft.slices.some((slice) => slice.values || slice.now.length))
        .map((draft) => draft.section.mechanic.id);
    return { ...result, budget, cut, mechanics };
}

/* ------------------------------------------------------------------ facts */

/** Check results and fired events for one generation (each fact on its own line, repeats dropped). */
export function renderFacts(facts: readonly string[]): string {
    const seen = new Set<string>();
    const lines: string[] = [];
    for (const fact of facts) {
        const text = compact(fact);
        if (!text || seen.has(text)) continue;
        seen.add(text);
        lines.push(`- ${text}`);
    }
    return lines.length ? `${FACTS_HEADER}\n${lines.join('\n')}` : '';
}
