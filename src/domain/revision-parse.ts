// Revision (M8): reading the model's answer. The LLM client already checked the JSON against the schema when it
// could; this is the item-by-item check that keeps good changes when one item is broken, plus the "answer was cut
// off" test that makes the revision split its batch (plan §9). Pure: no DOM, no SillyTavern.
import { isRevisionTarget } from './revision-prompt';
import type { RevisionTargetName } from './revision-prompt';
import { russianSentence } from './text-script';

export interface ParsedChange {
    class: 'known' | 'new';
    entityName: string;
    target: RevisionTargetName;
    /** Passport slot of 'nai.appearance', state key of 'places.state'. */
    field?: string;
    value: string;
    /** The change as one short Russian sentence for the user's card (the value keeps its English/tag format). */
    russian?: string;
    before?: string;
    evidence: string;
    sourceMessage: number;
    confidence: number;
}

export interface ParseResult {
    changes: ParsedChange[];
    /** Items that could not be read. */
    invalid: number;
}

const MAX_NAME = 80;
const MAX_VALUE = 800;
const MAX_EVIDENCE = 400;
const MAX_FIELD = 40;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

/** 0..1; percentages (1 < x ≤ 100) are scaled; anything else unreadable gives 0.5. */
export function normalizeConfidence(value: unknown): number {
    const number = typeof value === 'string' ? Number(value) : value;
    if (typeof number !== 'number' || !Number.isFinite(number) || number < 0) return 0.5;
    if (number <= 1) return number;
    if (number <= 100) return number / 100;
    return 1;
}

function clip(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** One item of `changes`; null when it cannot be used. */
export function readChange(raw: unknown, range: { from: number; to: number }): ParsedChange | null {
    if (!isDict(raw)) return null;
    const target = str(raw.target);
    if (!isRevisionTarget(target)) return null;
    const entityName = str(raw.entity ?? raw.entityName);
    const value = str(raw.value);
    if (!entityName || entityName.length > MAX_NAME || !value || value.length > MAX_VALUE) return null;
    const changeClass = str(raw.class) === 'new' ? 'new' : 'known';
    const index = typeof raw.sourceMessage === 'string' ? Number(raw.sourceMessage) : raw.sourceMessage;
    let sourceMessage = typeof index === 'number' && Number.isFinite(index) ? Math.round(index) : range.to;
    // A message outside the batch is a misread number: the batch end is the honest fallback.
    if (sourceMessage < range.from || sourceMessage > range.to) sourceMessage = range.to;
    const change: ParsedChange = {
        class: changeClass,
        entityName,
        target,
        value,
        evidence: clip(str(raw.evidence), MAX_EVIDENCE),
        sourceMessage,
        confidence: normalizeConfidence(raw.confidence),
    };
    const field = str(raw.field).toLowerCase();
    if (field && field.length <= MAX_FIELD) change.field = field;
    const before = str(raw.before);
    if (before) change.before = clip(before, MAX_VALUE);
    const russian = russianSentence(raw.russian);
    if (russian) change.russian = russian;
    return change;
}

/** `{changes: [...]}` (or a bare array) → the readable changes; duplicates are folded. */
export function parseRevisionChanges(data: unknown, range: { from: number; to: number }): ParseResult | null {
    const list = Array.isArray(data) ? data : isDict(data) && Array.isArray(data.changes) ? data.changes : null;
    if (!list) return null;
    const changes: ParsedChange[] = [];
    let invalid = 0;
    for (const raw of list) {
        const change = readChange(raw, range);
        if (change) changes.push(change);
        else invalid++;
    }
    return { changes: dedupeChanges(changes), invalid };
}

function norm(text: string | undefined): string {
    return String(text ?? '')
        .toLowerCase()
        .replace(/ё/g, 'е')
        .replace(/[\s.,;:!?«»"'“”]+/g, ' ')
        .trim();
}

/** Identity of a change for folding duplicates (split halves often report the same change). */
export function changeKey(change: Pick<ParsedChange, 'target' | 'entityName' | 'field' | 'value'>): string {
    return [change.target, norm(change.entityName), change.field ?? '', norm(change.value)].join('|');
}

/** Keeps the first of equal changes, with the higher confidence of the two. */
export function dedupeChanges(changes: readonly ParsedChange[]): ParsedChange[] {
    const byKey = new Map<string, ParsedChange>();
    for (const change of changes) {
        const key = changeKey(change);
        const seen = byKey.get(key);
        if (!seen) byKey.set(key, { ...change });
        else seen.confidence = Math.max(seen.confidence, change.confidence);
    }
    return [...byKey.values()];
}

/**
 * The model's text is JSON that was cut off: it opens an object or array that never closes (or ends inside a
 * string). Fences and reasoning blocks are ignored. Prose without JSON is not "truncated" — it is just invalid.
 */
export function looksTruncated(text: string | undefined): boolean {
    if (typeof text !== 'string') return false;
    const cleaned = text
        .replace(/<(think|thinking|reasoning)>[\s\S]*?<\/\1>/gi, '')
        .replace(/```[a-zA-Z]*\s*/g, '')
        .replace(/```/g, '');
    const start = cleaned.search(/[[{]/);
    if (start < 0) return false;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < cleaned.length; i++) {
        const char = cleaned[i];
        if (escaped) {
            escaped = false;
            continue;
        }
        if (char === '\\') {
            escaped = inString;
            continue;
        }
        if (char === '"') {
            inString = !inString;
            continue;
        }
        if (inString) continue;
        if (char === '{' || char === '[') depth++;
        else if (char === '}' || char === ']') {
            depth--;
            if (depth === 0) return false;
        }
    }
    return depth > 0 || inString;
}
