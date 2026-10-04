// Dossier (M7 п. 4) AI comparison of appearance and descriptions across stores (plan §9): English instructions,
// the stores' texts as stored (Russian prose, English lore, Danbooru tags), a strict JSON schema, and a tolerant
// reader that drops anything it cannot tie to the snippets it sent. Pure: the feature sends the request.
import { bootstrapCostUsd } from './doctor-budget';
import { truncate } from './dossier-data';

export interface CompareSource {
    /** Store kind ('lore', 'nai', 'des', …), shown to the model as is. */
    store: string;
    label: string;
    text: string;
}

export interface CompareSnippet extends CompareSource {
    /** `S1`, `S2`, … in the order sent. */
    id: string;
}

export type CompareKind = 'appearance' | 'description';

export interface CompareIssue {
    kind: CompareKind;
    /** Snippet ids. */
    a: string;
    b: string;
    quoteA: string;
    quoteB: string;
    summary: string;
}

export interface CompareMessage {
    role: 'system' | 'user';
    content: string;
}

const MIN_SNIPPET = 300;
const QUOTE_MAX = 160;
const SUMMARY_MAX = 300;
const MAX_ISSUES = 12;
/** Prompt overhead (instructions, labels) in tokens. */
const OVERHEAD_TOKENS = 450;
/** Expected answer size in tokens. */
const OUTPUT_TOKENS = 600;

export const COMPARE_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['findings'],
    properties: {
        findings: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['kind', 'a', 'b', 'quoteA', 'quoteB', 'summary'],
                properties: {
                    kind: { type: 'string', enum: ['appearance', 'description'] },
                    a: { type: 'string', description: 'Id of the first snippet, e.g. S1' },
                    b: { type: 'string', description: 'Id of the second snippet, e.g. S3' },
                    quoteA: { type: 'string', description: 'Short verbatim quote from snippet a' },
                    quoteB: { type: 'string', description: 'Short verbatim quote from snippet b' },
                    summary: { type: 'string', description: 'One short English sentence: what contradicts what' },
                },
            },
        },
    },
};

const SYSTEM_PROMPT = [
    'You check one entity of a role-play for contradictions between the places its facts are stored in.',
    'Snippets come from different stores and languages: English lorebook prose, Russian prose, Danbooru-style image tags, tracker fields. Compare meaning, not wording or language.',
    'Report only statements that cannot both be true:',
    '- appearance: hair, eyes, skin, body, height, age, species, scars, permanent clothing or accessories;',
    '- description: personality, background, role, occupation, family, relationships.',
    'Missing information is not a contradiction. Temporary states (current outfit, mood, wet, injured, location) are not contradictions unless a snippet states them as permanent.',
    'Quote each side briefly (at most 12 words) exactly as written in its snippet, in its original language.',
    'Reply with JSON only. If nothing contradicts, reply {"findings": []}.',
].join('\n');

/** Ids S1…Sn; texts trimmed, empty ones dropped, each cut to its share of `maxChars`. */
export function buildCompareSnippets(sources: readonly CompareSource[], maxChars: number): CompareSnippet[] {
    const usable = sources.filter((source) => source.text.trim());
    if (!usable.length) return [];
    const share = Math.max(MIN_SNIPPET, Math.floor(maxChars / usable.length));
    return usable.map((source, index) => ({
        id: `S${index + 1}`,
        store: source.store,
        label: source.label.trim(),
        text: truncate(source.text, share),
    }));
}

export function buildCompareMessages(
    name: string,
    aliases: readonly string[],
    snippets: readonly CompareSnippet[],
): CompareMessage[] {
    const names = aliases.filter((alias) => alias.trim() && alias.trim() !== name.trim());
    const header = names.length ? `Entity: ${name} (also known as: ${names.join(', ')})` : `Entity: ${name}`;
    const body = snippets.map((snippet) => `[${snippet.id}] ${snippet.store}: ${snippet.label}\n${snippet.text}`);
    return [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: [header, '', ...body.flatMap((part) => [part, ''])].join('\n').trim() },
    ];
}

function text(value: unknown, max: number): string {
    return typeof value === 'string' ? truncate(value.replace(/\s+/g, ' '), max) : '';
}

function kindOf(value: unknown): CompareKind | null {
    if (typeof value !== 'string') return null;
    const kind = value.trim().toLowerCase();
    if (kind.startsWith('appearance')) return 'appearance';
    if (kind.startsWith('description')) return 'description';
    return null;
}

function idOf(value: unknown, ids: ReadonlySet<string>): string | null {
    if (typeof value !== 'string') return null;
    const match = /S?\s*(\d+)/i.exec(value.trim());
    const id = match?.[1] ? `S${match[1]}` : '';
    return ids.has(id) ? id : null;
}

/**
 * Issues from the model's answer (parsed JSON or a JSON string). Null when the answer has no findings list at all
 * (malformed); items with an unknown kind, unknown snippet ids or the same snippet twice are dropped.
 */
export function parseCompareResult(data: unknown, snippetIds: readonly string[]): CompareIssue[] | null {
    let value = data;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value) as unknown;
        } catch {
            return null;
        }
    }
    const list = Array.isArray(value)
        ? value
        : typeof value === 'object' && value !== null && Array.isArray((value as { findings?: unknown }).findings)
          ? (value as { findings: unknown[] }).findings
          : null;
    if (!list) return null;
    const ids = new Set(snippetIds);
    const issues: CompareIssue[] = [];
    const seen = new Set<string>();
    for (const raw of list) {
        if (typeof raw !== 'object' || raw === null) continue;
        const item = raw as Record<string, unknown>;
        const kind = kindOf(item.kind);
        const a = idOf(item.a, ids);
        const b = idOf(item.b, ids);
        if (!kind || !a || !b || a === b) continue;
        const key = `${kind}:${[a, b].sort().join('-')}:${text(item.summary, 60)}`;
        if (seen.has(key)) continue;
        seen.add(key);
        issues.push({
            kind,
            a,
            b,
            quoteA: text(item.quoteA, QUOTE_MAX),
            quoteB: text(item.quoteB, QUOTE_MAX),
            summary: text(item.summary, SUMMARY_MAX),
        });
        if (issues.length >= MAX_ISSUES) break;
    }
    return issues;
}

/** Rough size of the request: ~4 characters per token plus the instructions; the answer is a guess. */
export function estimateCompare(snippets: readonly CompareSnippet[]): { input: number; output: number; usd: number } {
    const chars = snippets.reduce((sum, snippet) => sum + snippet.text.length + snippet.label.length + 16, 0);
    const input = Math.ceil(chars / 4) + OVERHEAD_TOKENS;
    return { input, output: OUTPUT_TOKENS, usd: bootstrapCostUsd(input + OUTPUT_TOKENS) };
}
