// M38 «Проверка промпта», the AI layer (plan-2 §2 п. 3), pure: the background model gets a compact INSTRUCTION MAP
// (owners, roles, places, the texts — never the lore as data or the chat history) and answers with the conflicts by a
// strict schema: both sides with an exact quote, why it matters in plain words, the risk on the active model and a
// fix (which side, what kind of change, the new text). The answer is checked against the map: unknown references are
// dropped, a quote that is not in its instruction keeps the conflict but loses an edit fix, a role change the model's
// quirks make risky is kept as advice only (the feature decides). Refs go to the model as short ids (I1, I2…).
// Pure: no DOM, no SillyTavern.
import { bootstrapCostUsd } from './doctor-budget';
import type { AuditCapture, AuditItem, AuditOwner, AuditRole } from './prompt-audit-map';
import { FIX_KINDS, SEVERITIES, shortQuote } from './prompt-audit-rules';
import type { AuditFix, AuditSeverity, FixKind, FixScope, RuleHit } from './prompt-audit-rules';

export const AI_SCHEMA_NAME = 'maestro_prompt_audit';
/** Most conflicts taken from one answer. */
export const AI_MAX_CONFLICTS = 12;
/** Answer budget. */
export const AI_MAX_TOKENS = 3000;
/** Every instruction's text together in the request. */
export const AI_MAP_CHARS = 36_000;
/** One instruction's text in the request. */
export const AI_ITEM_CHARS = 2400;

const SIDE_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    required: ['owner', 'ref', 'quote'],
    properties: {
        owner: { type: 'string', description: 'Who the instruction belongs to, as the map names it.' },
        ref: { type: 'string', description: 'The instruction id from the map, e.g. I3.' },
        quote: { type: 'string', description: 'An exact quote (one sentence) of that instruction.' },
    },
} as const;

/** The strict schema of the answer (the mock LLM has a handler for it: tools/mock-llm/scenarios.mjs). */
export const AI_SCHEMA: Record<string, unknown> = {
    type: 'object',
    additionalProperties: false,
    required: ['conflicts'],
    properties: {
        conflicts: {
            type: 'array',
            maxItems: AI_MAX_CONFLICTS,
            items: {
                type: 'object',
                additionalProperties: false,
                required: ['severity', 'a', 'b', 'why', 'risk_for_model', 'fix'],
                properties: {
                    severity: { type: 'string', enum: [...SEVERITIES] },
                    a: SIDE_SCHEMA,
                    b: SIDE_SCHEMA,
                    why: { type: 'string' },
                    risk_for_model: { type: 'string' },
                    fix: {
                        type: 'object',
                        additionalProperties: false,
                        required: ['side', 'kind', 'target', 'after_text', 'scope_hint'],
                        properties: {
                            side: { type: 'string', enum: ['a', 'b', 'both'] },
                            kind: { type: 'string', enum: [...FIX_KINDS] },
                            target: { type: 'string' },
                            after_text: { type: 'string' },
                            scope_hint: { type: 'string', enum: ['global', 'character', 'chat'] },
                        },
                    },
                },
            },
        },
    },
};

/* ------------------------------------------------------------------ the request */

/** How the map names an owner for the model (English; the user never sees this). */
const OWNER_NAMES: Record<AuditOwner, string> = {
    preset: 'Preset',
    card: 'Character card',
    authorsNote: "Author's note",
    des: 'DES (tracker extension)',
    nai: 'NAI Studio (image extension)',
    qvink: 'Qvink (memory extension)',
    desru: 'DES-RU (language extension)',
    ck: 'CarrotKernel (character data extension)',
    bunnymo: 'BunnyMo lorebook (read-only)',
    lore: 'Lorebook entry',
    maestro: 'Maestro (conductor extension)',
    dramatis: 'Dramatis (personality engine extension)',
    other: 'Another extension',
};

/** Who the model is told an item belongs to (the preset's name, the block's name, the module). */
export function ownerText(item: AuditItem, preset?: string): string {
    switch (item.owner) {
        case 'preset':
            return `${OWNER_NAMES.preset} «${preset ?? '?'}», block «${item.label}»`;
        case 'maestro':
            return `${OWNER_NAMES.maestro}: ${item.module ?? item.label}`;
        case 'dramatis':
            return `${OWNER_NAMES.dramatis}: ${item.module ?? item.label}`;
        case 'lore':
        case 'bunnymo':
            return `${OWNER_NAMES[item.owner]} «${item.book ?? '?'}» → «${item.label}»`;
        case 'card':
            return `${OWNER_NAMES.card}: ${item.label}`;
        default:
            return OWNER_NAMES[item.owner];
    }
}

function placeText(item: AuditItem): string {
    if (item.place === 'chat') return `inside the chat history at depth ${item.depth ?? 0}`;
    if (item.place === 'before') return 'before the prompt';
    return 'among the prompt blocks';
}

const QUIRK_TEXT: Record<string, string> = {
    systemMerge:
        'system messages inside or after the chat history have no role token and are merged into the neighbouring turns',
    prefillEos: 'an assistant message at the end (prefill) is closed at once: the reply comes back empty',
    assistantDepth: "assistant messages inside the history read as the model's own earlier replies",
};

/** The message order: instructions by message, chat history runs collapsed. */
function orderText(capture: AuditCapture, ids: Map<string, string>): string {
    const lines: string[] = [];
    let history = 0;
    const flush = () => {
        if (history) lines.push(`… chat history: ${history} message(s) …`);
        history = 0;
    };
    capture.messages.forEach((message, index) => {
        if (!message.refs.length) {
            history++;
            return;
        }
        flush();
        const refs = message.refs.map((ref) => ids.get(ref)).filter(Boolean);
        const last = index === capture.messages.length - 1 ? ' (last)' : '';
        lines.push(`#${index + 1} ${message.role}: ${refs.join(', ')} — ${message.chars} chars${last}`);
    });
    flush();
    return lines.join('\n');
}

export interface AiRequest {
    system: string;
    user: string;
    /** Map ids (I1…) to item refs. */
    ids: Map<string, string>;
    /** Characters of both messages (the estimate). */
    chars: number;
}

/** The request for a capture: what the model must check, in which language to explain, the compact map. */
export function buildAiRequest(capture: AuditCapture, locale: 'en' | 'ru'): AiRequest {
    const ids = new Map<string, string>();
    const refToId = new Map<string, string>();
    capture.items.forEach((item, index) => {
        const id = `I${index + 1}`;
        ids.set(id, item.ref);
        refToId.set(item.ref, id);
    });
    const language = locale === 'ru' ? 'Russian' : 'English';
    const system = [
        'You audit the INSTRUCTIONS a role-play prompt sends to a chat model: the preset blocks, the character card,',
        "the author's note and the texts several extensions inject. Find conflicts between them: demands that cannot",
        'all be met in one reply (length limits against mandatory blocks, JSON trackers, image markers, info boxes,',
        'HTML), opposite rules (language, narration person, tense, formats, writing for the user, asking the user),',
        'and roles or places that are risky on the given model. Ignore conflicts that are not real (an exception',
        'already written, a rule about a different part of the reply such as image tags or tracker fields).',
        'Rules for the answer:',
        '- a and b are two different instructions of the map (ids like I3); quote = an EXACT sentence from that',
        '  instruction, copied character by character;',
        `- why: in plain ${language}, one or two sentences a non-programmer understands; risk_for_model: what this`,
        `  model will do wrong because of it (in ${language}, may be empty);`,
        '- fix: the side that is easier and safer to change (the preset first; lorebooks marked read-only never),',
        '  kind edit = replace the quote of the target by after_text, remove = delete that quote (after_text ""),',
        '  toggle = switch the target off, role = after_text is the new role (system, user or assistant), move =',
        '  after_text is the new depth (a number); do not propose a system role for anything inside the chat history',
        '  when the model merges such messages; scope_hint: global unless the fix only fits this character or chat;',
        `- at most ${AI_MAX_CONFLICTS} conflicts, the most harmful first; an empty list when there are none.`,
    ].join('\n');
    const quirks = (capture.connection?.quirks ?? []).map((quirk) => QUIRK_TEXT[quirk]).filter(Boolean);
    const model = capture.connection
        ? `Model: ${capture.connection.model || 'unknown'} via ${capture.connection.source}.` +
          (quirks.length ? ` Known quirks: ${quirks.join('; ')}.` : '')
        : 'Model: unknown.';
    const budget = Math.max(AI_ITEM_CHARS, Math.floor(AI_MAP_CHARS / Math.max(1, capture.items.length)));
    const items = capture.items.map((item) => {
        const id = refToId.get(item.ref) ?? item.ref;
        const text =
            item.text.length > Math.min(budget, AI_ITEM_CHARS) ? `${item.text.slice(0, AI_ITEM_CHARS)}…` : item.text;
        const where = `${item.role} · ${placeText(item)}${item.message >= 0 ? ` · message #${item.message + 1}` : ''}`;
        return `[${id}] ${ownerText(item, capture.preset)} · ${where}\n<<<\n${text}\n>>>`;
    });
    const user = [
        model,
        '',
        'Final message order (instructions by id):',
        orderText(capture, refToId),
        '',
        'Instructions:',
        items.join('\n\n'),
    ].join('\n');
    return { system, user, ids, chars: system.length + user.length };
}

export interface AiEstimate {
    inputTokens: number;
    outputTokens: number;
    usd: number;
}

/** A rough size and price of the request on a cheap background model (the real price depends on the profile). */
export function estimateAi(chars: number, maxTokens = AI_MAX_TOKENS): AiEstimate {
    const inputTokens = Math.ceil(chars / 3.5) + 50;
    return { inputTokens, outputTokens: maxTokens, usd: bootstrapCostUsd(inputTokens + maxTokens) };
}

/* ------------------------------------------------------------------ the answer */

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max: number): string {
    return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** The exact substring of `source` a quote names: as given, else with whitespace and case loosened. */
export function locateQuote(source: string, quote: string): string | null {
    const wanted = quote.trim().replace(/[…]+$/u, '').trim();
    if (wanted.length < 6) return null;
    if (source.includes(wanted)) return wanted;
    // Loose match: collapse whitespace on both sides and compare case-insensitively, then map back.
    const map: number[] = [];
    let flat = '';
    let space = false;
    for (let i = 0; i < source.length; i++) {
        const char = source[i]!;
        if (/\s/.test(char)) {
            if (!space && flat) {
                flat += ' ';
                map.push(i);
            }
            space = true;
            continue;
        }
        space = false;
        flat += char.toLowerCase();
        map.push(i);
    }
    const needle = wanted.replace(/\s+/g, ' ').toLowerCase();
    const at = flat.indexOf(needle);
    if (at < 0) return null;
    const start = map[at]!;
    const end = map[at + needle.length - 1]! + 1;
    return source.slice(start, end);
}

const ROLE_WORDS: Record<string, AuditRole> = {
    system: 'system',
    user: 'user',
    assistant: 'assistant',
    система: 'system',
    системная: 'system',
    пользователь: 'user',
    ассистент: 'assistant',
};

function roleOf(value: string): AuditRole | null {
    return ROLE_WORDS[value.trim().toLowerCase()] ?? null;
}

function refOf(value: unknown, ids: Map<string, string>): string | null {
    const raw = text(value, 40).replace(/[[\]]/g, '').toUpperCase();
    return ids.get(raw) ?? null;
}

export interface AiConflict extends RuleHit {
    topic: 'ai';
    why: string;
    risk: string;
}

/**
 * The model's answer checked against the map. Returns null for an answer that is not the schema at all.
 * `items` are the capture's items by ref.
 */
export function parseAiAnswer(
    data: unknown,
    ids: Map<string, string>,
    items: Map<string, AuditItem>,
): AiConflict[] | null {
    let value = data;
    if (typeof value === 'string') {
        try {
            value = JSON.parse(value);
        } catch {
            return null;
        }
    }
    if (!isDict(value) || !Array.isArray(value.conflicts)) return null;
    const result: AiConflict[] = [];
    for (const raw of value.conflicts.slice(0, AI_MAX_CONFLICTS)) {
        if (!isDict(raw) || !isDict(raw.a) || !isDict(raw.b)) continue;
        const refA = refOf(raw.a.ref, ids);
        const refB = refOf(raw.b.ref, ids);
        if (!refA || !refB || refA === refB) continue;
        const itemA = items.get(refA);
        const itemB = items.get(refB);
        if (!itemA || !itemB) continue;
        const quoteA = text(raw.a.quote, 600);
        const quoteB = text(raw.b.quote, 600);
        const why = text(raw.why, 800);
        if (!why) continue;
        const severity: AuditSeverity = SEVERITIES.includes(raw.severity as AuditSeverity)
            ? (raw.severity as AuditSeverity)
            : 'medium';
        const exactA = locateQuote(itemA.text, quoteA);
        const exactB = locateQuote(itemB.text, quoteB);
        const conflict: AiConflict = {
            topic: 'ai',
            severity,
            a: { ref: refA, quote: shortQuote(exactA ?? quoteA) },
            b: { ref: refB, quote: shortQuote(exactB ?? quoteB) },
            why,
            risk: text(raw.risk_for_model, 600),
        };
        const fix = parseFix(raw.fix, ids, { a: refA, b: refB }, { a: exactA, b: exactB });
        if (fix) conflict.fix = fix;
        result.push(conflict);
    }
    return result;
}

function parseFix(
    raw: unknown,
    ids: Map<string, string>,
    refs: { a: string; b: string },
    exact: { a: string | null; b: string | null },
): AuditFix | null {
    if (!isDict(raw)) return null;
    const kind = FIX_KINDS.includes(raw.kind as FixKind) ? (raw.kind as FixKind) : null;
    if (!kind) return null;
    const sideValue = raw.side === 'b' ? 'b' : raw.side === 'both' ? 'both' : 'a';
    const target = refOf(raw.target, ids) ?? (sideValue === 'b' ? refs.b : refs.a);
    if (target !== refs.a && target !== refs.b) return null;
    const side: 'a' | 'b' = target === refs.b ? 'b' : 'a';
    const after = typeof raw.after_text === 'string' ? raw.after_text.slice(0, 4000) : '';
    const scope = raw.scope_hint === 'character' || raw.scope_hint === 'chat' ? raw.scope_hint : 'global';
    const fix: AuditFix = { side: sideValue === 'both' ? 'both' : side, kind, target, scopeHint: scope as FixScope };
    const before = side === 'a' ? exact.a : exact.b;
    switch (kind) {
        case 'edit':
            if (!before || !after.trim() || after.trim() === before.trim()) return null;
            fix.before = before;
            fix.after = after.trim();
            return fix;
        case 'remove':
            if (!before) return null;
            fix.before = before;
            fix.after = '';
            return fix;
        case 'toggle':
            fix.enabled = false;
            return fix;
        case 'role': {
            const role = roleOf(after);
            if (!role) return null;
            fix.role = role;
            return fix;
        }
        case 'move': {
            const depth = Number.parseInt(after.trim(), 10);
            if (!Number.isFinite(depth) || depth < 0 || depth > 9999) return null;
            fix.depth = depth;
            return fix;
        }
        default:
            return null;
    }
}
