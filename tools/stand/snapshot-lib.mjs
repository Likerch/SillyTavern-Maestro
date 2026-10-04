// Prompt snapshots: normalise a recorded chat completion request, summarise it (sizes per role, detected
// blocks, lorebook entries present) and diff it against a golden copy. Used by tools/stand/snapshot.mjs.

/** Values that change between runs and must not break a snapshot. Order matters (longest first). */
export const VOLATILE_PATTERNS = [
    [/\b\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?/g, '<TS>'],
    [/\b\d{4}-\d{1,2}-\d{1,2} ?@\d{1,2}h ?\d{1,2}m ?\d{1,2}s(?: ?\d{1,3}ms)?/g, '<CHATSTAMP>'],
    [/\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/gi, '<UUID>'],
    [/\b1[6-9]\d{11}\b/g, '<EPOCH_MS>'],
    [
        /\b(?:January|February|March|April|May|June|July|August|September|October|November|December) \d{1,2}, \d{4}(?:,? \d{1,2}:\d{2} ?(?:am|pm))?/gi,
        '<DATE>',
    ],
    [/\b\d{1,2}:\d{2} ?(?:AM|PM|am|pm)\b/g, '<TIME>'],
];

/** Text of a message content: a string, or the text parts of a multimodal array. */
export function contentText(content) {
    if (typeof content === 'string') return content;
    if (Array.isArray(content)) {
        return content
            .map((part) => {
                if (typeof part === 'string') return part;
                if (part?.type === 'text') return part.text ?? '';
                if (part?.type === 'image_url') return '[image]';
                return `[${part?.type ?? 'part'}]`;
            })
            .join('\n');
    }
    if (content === null || content === undefined) return '';
    return JSON.stringify(content);
}

/** Line endings, trailing spaces, runs of blanks and empty lines, volatile values. */
export function normalizeText(text) {
    let result = String(text ?? '').replace(/\r\n?/g, '\n');
    for (const [pattern, replacement] of VOLATILE_PATTERNS) result = result.replace(pattern, replacement);
    return result
        .replace(/[ \t]+$/gm, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

/** @returns {{ role: string, name?: string, content: string, tool_calls?: string }[]} */
export function normalizeMessages(messages) {
    return (Array.isArray(messages) ? messages : []).map((message) => {
        const result = { role: String(message?.role ?? 'unknown') };
        if (typeof message?.name === 'string' && message.name) result.name = message.name;
        result.content = normalizeText(contentText(message?.content));
        if (Array.isArray(message?.tool_calls) && message.tool_calls.length) {
            result.tool_calls = message.tool_calls.map((c) => c?.function?.name ?? '?').join(',');
        }
        return result;
    });
}

/** Request parameters that matter for a snapshot (sampling noise such as seed or user ids is left out). */
export function normalizeParams(body) {
    const params = {};
    for (const key of [
        'stream',
        'max_tokens',
        'max_completion_tokens',
        'temperature',
        'top_p',
        'top_k',
        'frequency_penalty',
        'presence_penalty',
    ]) {
        if (body?.[key] !== undefined && body[key] !== null) params[key] = body[key];
    }
    if (Array.isArray(body?.stop) && body.stop.length) params.stop = body.stop.map(normalizeText);
    if (body?.response_format) {
        params.response_format = body.response_format.json_schema?.name ?? body.response_format.type ?? 'custom';
    }
    if (Array.isArray(body?.tools) && body.tools.length) params.tools = body.tools.map((t) => t?.function?.name ?? '?');
    if (body?.tool_choice !== undefined) params.tool_choice = body.tool_choice;
    return params;
}

export function normalizeRequest(body) {
    return { model: body?.model ?? null, params: normalizeParams(body), messages: normalizeMessages(body?.messages) };
}

/* ------------------------------------------------------------------ block detection */

/** Recognisable blocks of the stack. Spans may overlap (an instruction can contain a tracker example). */
export const BLOCK_DETECTORS = [
    ['des-tracker', /```json\s*\{[\s\S]*?\}\s*```/g, (m) => /"(?:infoBox|characters|quests)"/.test(m)],
    ['des-instructions', /Start every reply with ONE JSON code block[\s\S]*/g],
    ['bunnymo-tags', /<BunnymoTags[^>]*>[\s\S]*?<\/BunnymoTags>/gi],
    ['bunnymo-sheet-section', /^## SECTION \d+\/\d+:[^\n]*$/gm],
    [
        'qvink-memory',
        /\[Following is a list of (?:events that occurred in the past|recent events)\]:[\s\S]*?(?=\n\n(?!\*)|$)/g,
    ],
    ['language-lock', /\[Язык ролевой игры[\s\S]*?\](?=\s*$|\n\n)/g],
    ['ck-ooc', /^.*(?:OOC[^\n]*MANDATORY|MANDATORY OOC)[\s\S]*?(?=\n\n|$)/gm],
    ['think', /<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi],
    ['html', /<\/?(?:div|span|details|summary|figure|img|font|br|p|table|tr|td)\b[^>]*>/gi],
    ['nai-marker', /\[nai:img:[^\]]*\]|<figure[^>]*data-nai[\s\S]*?<\/figure>/gi],
    ['maestro', /<maestro\b[\s\S]*?<\/maestro>|\[maestro:[^\]]*\]|\{\{\s*if\s+\.maestro_[\s\S]*?\{\{\s*\/if\s*\}\}/gi],
    ['service-garbage', /<｜begin▁of▁sentence｜>|<\|begin_of_text\|>|<\|im_start\|>/g],
];

/** @returns {Record<string, { count: number, chars: number }>} */
export function detectBlocks(text, detectors = BLOCK_DETECTORS) {
    const found = {};
    for (const [kind, regex, accept] of detectors) {
        for (const match of String(text).matchAll(regex)) {
            if (accept && !accept(match[0])) continue;
            found[kind] ??= { count: 0, chars: 0 };
            found[kind].count++;
            found[kind].chars += match[0].length;
        }
    }
    return found;
}

/**
 * Probes that recognise lorebook entries inside a prompt: the start of the longest macro-free piece of each
 * entry's content. `worlds` is [{ name, data: { entries } }].
 */
export function buildProbes(worlds, minLength = 24, length = 64) {
    const probes = [];
    for (const world of worlds) {
        for (const entry of Object.values(world.data?.entries ?? {})) {
            if (entry?.disable) continue;
            const pieces = String(entry?.content ?? '').split(/\{\{[^}]*\}\}/);
            const longest = pieces.map(normalizeText).sort((a, b) => b.length - a.length)[0] ?? '';
            if (longest.length < minLength) continue;
            probes.push({
                book: world.name,
                uid: entry.uid,
                comment: entry.comment ?? '',
                probe: longest.slice(0, length),
            });
        }
    }
    return probes;
}

/** Sizes per role, detected blocks and lorebook entries found in a normalised message list. */
export function summarize(messages, probes = []) {
    const roles = {};
    const blocks = {};
    let chars = 0;
    for (const message of messages) {
        roles[message.role] ??= { count: 0, chars: 0 };
        roles[message.role].count++;
        roles[message.role].chars += message.content.length;
        chars += message.content.length;
        for (const [kind, value] of Object.entries(detectBlocks(message.content))) {
            blocks[kind] ??= { count: 0, chars: 0 };
            blocks[kind].count += value.count;
            blocks[kind].chars += value.chars;
        }
    }
    const lorebooks = {};
    if (probes.length) {
        const all = messages.map((m) => m.content).join('\n');
        for (const probe of probes) {
            if (!all.includes(probe.probe)) continue;
            lorebooks[probe.book] ??= { entries: 0, uids: [] };
            lorebooks[probe.book].entries++;
            lorebooks[probe.book].uids.push(probe.uid);
        }
    }
    return { messages: messages.length, chars, roles, blocks, lorebooks };
}

/* ------------------------------------------------------------------ diff */

const keyOf = (m) => `${m.role}\u0000${m.name ?? ''}\u0000${m.content}\u0000${m.tool_calls ?? ''}`;

/**
 * LCS over whole messages. `a` indexes `before`, `b` indexes `after`; '~' pairs a removal and an addition
 * of the same role (a modified message).
 * @returns {{ op: '=' | '-' | '+' | '~', a?: number, b?: number }[]}
 */
export function diffMessages(before, after) {
    const a = before.map(keyOf);
    const b = after.map(keyOf);
    const table = Array.from({ length: a.length + 1 }, () => new Uint32Array(b.length + 1));
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
        }
    }
    const raw = [];
    let i = 0;
    let j = 0;
    while (i < a.length || j < b.length) {
        if (i < a.length && j < b.length && a[i] === b[j]) raw.push({ op: '=', a: i++, b: j++ });
        else if (j < b.length && (i === a.length || table[i][j + 1] >= table[i + 1][j])) raw.push({ op: '+', b: j++ });
        else raw.push({ op: '-', a: i++ });
    }
    // Pair removals and additions of the same role inside one changed stretch as modifications.
    const ops = [];
    for (let k = 0; k < raw.length;) {
        if (raw[k].op === '=') {
            ops.push(raw[k++]);
            continue;
        }
        const removed = [];
        const added = [];
        while (k < raw.length && raw[k].op !== '=') {
            if (raw[k].op === '-') removed.push(raw[k].a);
            else added.push(raw[k].b);
            k++;
        }
        const usedAdded = new Set();
        for (const ai of removed) {
            const match = added.find((bi) => !usedAdded.has(bi) && after[bi].role === before[ai].role);
            if (match !== undefined) {
                usedAdded.add(match);
                ops.push({ op: '~', a: ai, b: match });
            } else {
                ops.push({ op: '-', a: ai });
            }
        }
        for (const bi of added) if (!usedAdded.has(bi)) ops.push({ op: '+', b: bi });
    }
    return ops;
}

const fmt = (n) => Number(n).toLocaleString('en-US');
const excerpt = (text, length = 90) => {
    const flat = String(text).replace(/\s+/g, ' ').trim();
    return flat.length > length ? `${flat.slice(0, length - 1)}…` : flat;
};

function firstDifference(a, b) {
    const left = a.split('\n');
    const right = b.split('\n');
    for (let i = 0; i < Math.max(left.length, right.length); i++) {
        if (left[i] !== right[i]) return { line: i + 1, before: left[i] ?? '', after: right[i] ?? '' };
    }
    return null;
}

function arrow(before, after, unit = '') {
    if (before === after) return `${fmt(before)}${unit}`;
    const delta = after - before;
    return `${fmt(before)} → ${fmt(after)}${unit} (${delta > 0 ? '+' : ''}${fmt(delta)})`;
}

/**
 * Compares a golden snapshot with the current one.
 * @param {{ messages: any[], params?: object }} golden
 * @param {{ messages: any[], params?: object }} current
 * @returns {{ equal: boolean, lines: string[] }}
 */
export function compareSnapshots(golden, current, probes = [], { maxChanges = 30 } = {}) {
    const lines = [];
    const before = summarize(golden.messages, probes);
    const after = summarize(current.messages, probes);
    const ops = diffMessages(golden.messages, current.messages);
    const changed = ops.filter((o) => o.op !== '=');
    const paramsBefore = JSON.stringify(golden.params ?? {});
    const paramsAfter = JSON.stringify(current.params ?? {});
    const equal = changed.length === 0 && paramsBefore === paramsAfter;

    lines.push(
        `size      ${arrow(before.messages, after.messages, ' messages')}, ${arrow(before.chars, after.chars, ' chars')}`,
    );
    const roles = [...new Set([...Object.keys(before.roles), ...Object.keys(after.roles)])];
    lines.push(
        `roles     ${roles
            .map((role) => {
                const x = before.roles[role] ?? { count: 0, chars: 0 };
                const y = after.roles[role] ?? { count: 0, chars: 0 };
                return `${role} ${arrow(x.count, y.count)} [${arrow(x.chars, y.chars, ' ch')}]`;
            })
            .join(' | ')}`,
    );
    const kinds = [...new Set([...Object.keys(before.blocks), ...Object.keys(after.blocks)])];
    if (kinds.length) {
        lines.push(
            `blocks    ${kinds
                .map((kind) => {
                    const x = before.blocks[kind] ?? { count: 0, chars: 0 };
                    const y = after.blocks[kind] ?? { count: 0, chars: 0 };
                    return `${kind} ${arrow(x.count, y.count)} [${arrow(x.chars, y.chars, ' ch')}]`;
                })
                .join(' | ')}`,
        );
    }
    const books = [...new Set([...Object.keys(before.lorebooks), ...Object.keys(after.lorebooks)])];
    if (books.length) {
        lines.push(
            `lorebooks ${books
                .map(
                    (book) =>
                        `${book} ${arrow(before.lorebooks[book]?.entries ?? 0, after.lorebooks[book]?.entries ?? 0, ' entries')}`,
                )
                .join(' | ')}`,
        );
    }
    if (paramsBefore !== paramsAfter) lines.push(`params    ${paramsBefore} → ${paramsAfter}`);
    if (changed.length) {
        lines.push(`changes   ${changed.length} (golden #index → current #index)`);
        for (const op of changed.slice(0, maxChanges)) {
            if (op.op === '+') {
                const m = current.messages[op.b];
                lines.push(`  + #${op.b} ${m.role} ${fmt(m.content.length)} ch: "${excerpt(m.content)}"`);
            } else if (op.op === '-') {
                const m = golden.messages[op.a];
                lines.push(`  - #${op.a} ${m.role} ${fmt(m.content.length)} ch: "${excerpt(m.content)}"`);
            } else {
                const x = golden.messages[op.a];
                const y = current.messages[op.b];
                const diff = firstDifference(x.content, y.content);
                lines.push(
                    `  ~ #${op.a}→#${op.b} ${x.role} ${arrow(x.content.length, y.content.length, ' ch')}${diff ? `, line ${diff.line}:` : ''}`,
                );
                if (diff) {
                    lines.push(`      - ${excerpt(diff.before, 110)}`);
                    lines.push(`      + ${excerpt(diff.after, 110)}`);
                }
            }
        }
        if (changed.length > maxChanges) lines.push(`  … ${changed.length - maxChanges} more`);
    }
    return { equal, lines };
}
