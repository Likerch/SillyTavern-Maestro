// M25 «Механики», the prompt (plan M25 п.5, P16): the rules and the state of the mechanics taking part in the scene,
// as one compact English block near the end of the prompt — only holders in the scene, only visible attributes:
//   [Mechanics] Magic: …rules… | Kai: mana 12/30, schools: fire, water | Anna: mana 5/20
// cut to a token budget, least important first: other holders' values, then the rules (down to the summary, then
// nothing), then the main holder's values (the persona), then whole mechanics from the last. The block-format
// instruction (tracking) is never cut. Plus the facts block for one generation: check results and fired events.
// Visibility (plan-2 §6.А): an attribute the model must not know (prompt 'none', secret) never appears; 'words' gives
// the word band instead of the number ("mana: low"); a mechanic whose attributes may only be mentioned in words, or
// not at all, gets a short "Changes: …" line. Extra lines (conditions, inventories) are cut right after the other
// holders' values; fixed lines (the fight) never.
// Pure: no DOM, no SillyTavern. The shapes are structural copies of features/mechanics/api.ts (domain cannot import
// feature types); a MechanicDef fits PromptMechanic as is.
import { estimateTokens } from './rules-lore';
import { mentionLine, resolveVisibility, wordsFor } from './mechanics-visibility';
import type { MentionGroup, MentionVisibility, VisibilityInput } from './mechanics-visibility';
import { durationText, itemsText } from './mechanics-status';
import type { ItemState } from './mechanics-status';

export type PromptValue = number | string | string[];

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
}

export interface PromptHolder {
    name: string;
    values: Readonly<Record<string, PromptValue | null | undefined>>;
    /** The main holder (the persona): its values are cut last. */
    primary?: boolean;
}

export interface PromptSection {
    mechanic: PromptMechanic;
    holders: readonly PromptHolder[];
}

export type TokenCount = (text: string) => number;

export const countTokens: TokenCount = (text) => estimateTokens(text.length);

export const RULES_HEADER = '[Mechanics]';
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

/** One value for the model: "mana 12/30", "standing: warm (4/5)", "schools: fire, water", 'mood: "calm"'. */
export function formatValue(attribute: PromptAttribute, value: PromptValue | null | undefined): string | null {
    if (value === null || value === undefined) return null;
    const label = labelOf(attribute);
    switch (attribute.kind) {
        case 'number': {
            const number = typeof value === 'number' ? value : Number(value);
            if (!Number.isFinite(number)) return null;
            const { min, max } = attribute;
            if (typeof max === 'number') {
                return typeof min === 'number' && min !== 0
                    ? `${label} ${plainNumber(number)} (${plainNumber(min)}..${plainNumber(max)})`
                    : `${label} ${plainNumber(number)}/${plainNumber(max)}`;
            }
            return `${label} ${plainNumber(number)}`;
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

/** "Kai: mana 12/30, schools: fire, water", or null when the holder shows nothing. */
export function holderLine(mechanic: PromptMechanic, holder: PromptHolder): string | null {
    const parts: string[] = [];
    for (const attribute of mechanic.attributes) {
        const visibility = resolveVisibility(mechanic, attribute);
        if (visibility.prompt === 'none') continue;
        const value = holder.values[attribute.id];
        const text =
            visibility.prompt === 'words' ? wordsValue(mechanic, attribute, value) : formatValue(attribute, value);
        if (text) parts.push(text);
    }
    return parts.length ? `${compact(holder.name)}: ${parts.join(', ')}` : null;
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

/* ------------------------------------------------------------------ the rules block */

type RulesLevel = 'full' | 'summary' | 'none';

interface Draft {
    section: PromptSection;
    lines: { holder: PromptHolder; text: string }[];
    rules: RulesLevel;
    mention: string;
}

export type CutStep =
    | { kind: 'holder'; mechanicId: string; holder: string; primary: boolean }
    | { kind: 'extra'; index: number }
    | { kind: 'rules'; mechanicId: string; to: 'summary' | 'none' }
    | { kind: 'mechanic'; mechanicId: string };

export interface RenderedRules {
    text: string;
    tokens: number;
    /** 0: no budget. */
    budget: number;
    /** What was cut to fit, in order. */
    cut: CutStep[];
    /** Mechanics left in the text. */
    mechanics: string[];
}

export interface RulesOptions {
    /** Token budget of the whole block (0 or less: none). */
    budget: number;
    /** Never cut (the service-block instruction of the tracking part). */
    instruction?: string;
    /** Lines after the mechanics (conditions, inventories), cut right after the other holders' values. */
    extras?: readonly string[];
    /** Lines after the mechanics that are never cut (the fight). */
    fixed?: readonly string[];
    count?: TokenCount;
}

function rulesText(mechanic: PromptMechanic, level: RulesLevel): string {
    if (level === 'none') return '';
    const rules = compact(mechanic.rules);
    const summary = compact(mechanic.summary);
    if (level === 'summary') return summary;
    return rules || summary;
}

function sectionText(draft: Draft): string {
    const label = compact(
        draft.section.mechanic.promptName || draft.section.mechanic.name || draft.section.mechanic.id,
    );
    const rules = rulesText(draft.section.mechanic, draft.rules);
    const head = rules ? `${label}: ${rules}` : label;
    const mention = draft.rules !== 'none' && draft.mention ? ` ${draft.mention}` : '';
    return [`${head}${mention}`, ...draft.lines.map((line) => line.text)].join(' | ');
}

interface Tail {
    extras: string[];
    fixed: string[];
    instruction: string;
}

function assemble(drafts: readonly Draft[], tail: Tail): string {
    const lines = drafts.map(sectionText);
    if (lines.length) lines[0] = `${RULES_HEADER} ${lines[0]}`;
    lines.push(...tail.extras, ...tail.fixed);
    if (tail.instruction) lines.push(tail.instruction);
    return lines.join('\n');
}

/** The next thing to cut, least important first; false when nothing is left to cut. */
function cutOne(drafts: Draft[], cut: CutStep[], tail: Tail): boolean {
    const backwards = [...drafts].reverse();
    for (const draft of backwards) {
        const at = draft.lines.map((line) => !line.holder.primary).lastIndexOf(true);
        if (at < 0) continue;
        const line = draft.lines.splice(at, 1)[0] as Draft['lines'][number];
        cut.push({ kind: 'holder', mechanicId: draft.section.mechanic.id, holder: line.holder.name, primary: false });
        return true;
    }
    if (tail.extras.length) {
        tail.extras.pop();
        cut.push({ kind: 'extra', index: tail.extras.length });
        return true;
    }
    for (const draft of backwards) {
        const { mechanic } = draft.section;
        if (draft.rules !== 'full' || !compact(mechanic.summary) || !compact(mechanic.rules)) continue;
        draft.rules = 'summary';
        cut.push({ kind: 'rules', mechanicId: mechanic.id, to: 'summary' });
        return true;
    }
    for (const draft of backwards) {
        if (draft.rules === 'none' || !rulesText(draft.section.mechanic, draft.rules)) continue;
        draft.rules = 'none';
        cut.push({ kind: 'rules', mechanicId: draft.section.mechanic.id, to: 'none' });
        return true;
    }
    for (const draft of backwards) {
        const line = draft.lines.pop();
        if (!line) continue;
        cut.push({ kind: 'holder', mechanicId: draft.section.mechanic.id, holder: line.holder.name, primary: true });
        return true;
    }
    const last = drafts.pop();
    if (!last) return false;
    cut.push({ kind: 'mechanic', mechanicId: last.section.mechanic.id });
    return true;
}

/**
 * The rules + state block. Sections without a holder line are kept (their rules still apply in the scene); sections
 * are taken in the given order (the caller puts the most important first).
 */
export function renderRules(sections: readonly PromptSection[], options: RulesOptions): RenderedRules {
    const count = options.count ?? countTokens;
    const tail: Tail = {
        instruction: (options.instruction ?? '').trim(),
        extras: (options.extras ?? []).map(compact).filter(Boolean),
        fixed: (options.fixed ?? []).map(compact).filter(Boolean),
    };
    const budget = options.budget > 0 ? Math.floor(options.budget) : 0;
    const drafts: Draft[] = sections.map((section) => ({
        section,
        rules: 'full',
        mention: mentionText(section.mechanic),
        lines: section.holders.flatMap((holder) => {
            const text = holderLine(section.mechanic, holder);
            return text ? [{ holder, text }] : [];
        }),
    }));
    const cut: CutStep[] = [];
    let text = assemble(drafts, tail);
    while (budget > 0 && count(text) > budget && cutOne(drafts, cut, tail)) text = assemble(drafts, tail);
    return {
        text,
        tokens: text ? count(text) : 0,
        budget,
        cut,
        mechanics: drafts.map((draft) => draft.section.mechanic.id),
    };
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

/* ------------------------------------------------------------------ conditions and inventories */

export interface PromptStatus {
    promptName: string;
    remaining: { turns?: number; minutes?: number } | null;
    until?: { day: number; minutes?: number };
    stacks?: number;
    text?: string;
}

/**
 * "[Conditions] Kai: poisoned (2 turns left), blessed (until day 3 18:00) | Mira: stunned" for the holders in the scene
 * that have any; '' when nobody has one.
 */
export function conditionsLine(entries: readonly { holder: string; statuses: readonly PromptStatus[] }[]): string {
    const parts: string[] = [];
    for (const entry of entries) {
        if (!entry.statuses.length) continue;
        const list = entry.statuses.map((status) => {
            const stacks = status.stacks && status.stacks > 1 ? ` x${status.stacks}` : '';
            const time = durationText(status);
            const note = status.text ? `: ${compact(status.text)}` : '';
            return `${compact(status.promptName)}${stacks}${time ? ` (${time})` : ''}${note}`;
        });
        parts.push(`${compact(entry.holder)}: ${list.join(', ')}`);
    }
    return parts.length ? `[Conditions] ${parts.join(' | ')}` : '';
}

/** "[Inventory] Kai: rope x2, sword (in hand) | Mira: lantern"; '' when nobody carries anything. */
export function inventoryLine(entries: readonly { holder: string; items: readonly ItemState[] }[]): string {
    const parts = entries
        .filter((entry) => entry.items.length)
        .map((entry) => `${compact(entry.holder)}: ${itemsText(entry.items)}`);
    return parts.length ? `[Inventory] ${parts.join(' | ')}` : '';
}
