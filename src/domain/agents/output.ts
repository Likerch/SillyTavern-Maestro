// Reading an agent's answer (plan §3.5, А6): the form is the code's, not the instruction's — whatever the model wrote,
// only a valid result of the agent's type comes out, cut to sane sizes. Plain-text answers lose fences, quotes and a
// leading «Note:»; «NONE» means «nothing this time».
import type { AgentErrorKind, AgentResultSpec, FlagsOptions, MemoryOptions } from './types';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface VerdictProblem {
    quote: string;
    issue: string;
    fix: string;
}

export type AgentOutput =
    | { type: 'inject'; text: string }
    | { type: 'note'; text: string }
    | { type: 'flags'; flags: Record<string, string | number | boolean> }
    | { type: 'rewrite'; editNeeded: boolean; editedText: string; changes: string[] }
    | { type: 'verdict'; ok: boolean; problems: VerdictProblem[] }
    | { type: 'choices'; choices: string[] }
    | { type: 'memory'; fields: Record<string, string> }
    | { type: 'proposals'; items: ProposalItem[] }
    /** The agent had nothing to say this time (NONE, an empty note, no flags). */
    | { type: 'none' };

/** One proposal of an agent: a receiver kind, why (story words) and the receiver's data. */
export interface ProposalItem {
    kind: string;
    why: string;
    data: Record<string, unknown>;
}

export type ParseOutcome = { ok: true; output: AgentOutput } | { ok: false; error: AgentErrorKind };

const INJECT_MAX = 2000;
const NOTE_MAX = 2000;
const CHOICE_MAX = 300;
const FIELD_MAX = 1500;

/** Removes fences, wrapping quotes and a leading label from a plain-text answer. */
export function cleanPlain(text: string): string {
    let out = text.trim();
    const fence = /^```[a-zA-Z]*\s*\n?([\s\S]*?)\n?```$/.exec(out);
    if (fence?.[1] !== undefined) out = fence[1].trim();
    out = out.replace(/^(?:note|directive|injection|answer|ответ|заметка)\s*:\s*/i, '');
    if (out.length >= 2 && /^["«“]/.test(out) && /["»”]$/.test(out)) out = out.slice(1, -1).trim();
    return out;
}

function isNone(text: string): boolean {
    return /^(?:none|nothing|нет|ничего)\.?$/i.test(text.trim());
}

function plainOf(data: unknown, text: string | undefined): string {
    if (typeof data === 'string') return data;
    return text ?? '';
}

function parseFlags(value: unknown, options: FlagsOptions): AgentOutput | null {
    if (!isDict(value) || !isDict(value.flags)) return null;
    const flags: Record<string, string | number | boolean> = {};
    for (const name of options.names) {
        const raw = value.flags[name];
        if (typeof raw === 'string') flags[name] = raw.slice(0, 200);
        else if (typeof raw === 'number' && Number.isFinite(raw)) flags[name] = raw;
        else if (typeof raw === 'boolean') flags[name] = raw;
    }
    return Object.keys(flags).length ? { type: 'flags', flags } : { type: 'none' };
}

function parseMemory(value: unknown, options: MemoryOptions): AgentOutput | null {
    if (!isDict(value) || !isDict(value.fields)) return null;
    const allowed = new Set(options.fields.map((field) => field.name));
    const fields: Record<string, string> = {};
    for (const [name, raw] of Object.entries(value.fields)) {
        if (!allowed.has(name)) continue;
        const text =
            typeof raw === 'string'
                ? raw
                : typeof raw === 'number' || typeof raw === 'boolean'
                  ? String(raw)
                  : Array.isArray(raw)
                    ? raw.filter((item) => typeof item === 'string').join('; ')
                    : '';
        if (text.trim()) fields[name] = text.trim().slice(0, FIELD_MAX);
    }
    return Object.keys(fields).length ? { type: 'memory', fields } : { type: 'none' };
}

/**
 * The agent's result from the client's answer (`data`: parsed JSON for JSON types, the text otherwise). A wrong shape
 * is 'shape'; an empty plain answer is 'empty'.
 */
export function parseAgentOutput(result: AgentResultSpec, data: unknown, text?: string): ParseOutcome {
    switch (result.type) {
        case 'inject':
        case 'note': {
            const plain = cleanPlain(plainOf(data, text));
            if (!plain) return { ok: false, error: 'empty' };
            if (isNone(plain)) return { ok: true, output: { type: 'none' } };
            const max = result.type === 'inject' ? INJECT_MAX : NOTE_MAX;
            return { ok: true, output: { type: result.type, text: plain.slice(0, max) } };
        }
        case 'flags': {
            const output = parseFlags(data, result.options);
            return output ? { ok: true, output } : { ok: false, error: 'shape' };
        }
        case 'memory': {
            const output = parseMemory(data, result.options);
            return output ? { ok: true, output } : { ok: false, error: 'shape' };
        }
        case 'rewrite': {
            if (!isDict(data) || typeof data.editNeeded !== 'boolean') return { ok: false, error: 'shape' };
            const editedText = typeof data.editedText === 'string' ? data.editedText : '';
            const changes = Array.isArray(data.changes)
                ? data.changes
                      .filter((item): item is string => typeof item === 'string')
                      .map((item) => item.slice(0, 300))
                : [];
            if (data.editNeeded && !editedText.trim()) return { ok: false, error: 'shape' };
            return {
                ok: true,
                output: data.editNeeded
                    ? { type: 'rewrite', editNeeded: true, editedText, changes: changes.slice(0, 30) }
                    : { type: 'none' },
            };
        }
        case 'verdict': {
            if (!isDict(data) || typeof data.ok !== 'boolean') return { ok: false, error: 'shape' };
            const problems: VerdictProblem[] = [];
            if (Array.isArray(data.problems)) {
                for (const item of data.problems) {
                    if (!isDict(item) || typeof item.issue !== 'string' || !item.issue.trim()) continue;
                    problems.push({
                        quote: typeof item.quote === 'string' ? item.quote.slice(0, 300) : '',
                        issue: item.issue.slice(0, 400),
                        fix: typeof item.fix === 'string' ? item.fix.slice(0, 400) : '',
                    });
                    if (problems.length >= 10) break;
                }
            }
            const ok = data.ok && problems.length === 0;
            return { ok: true, output: { type: 'verdict', ok, problems } };
        }
        case 'proposals': {
            if (!isDict(data) || !Array.isArray(data.proposals)) return { ok: false, error: 'shape' };
            const items: ProposalItem[] = [];
            for (const raw of data.proposals) {
                if (!isDict(raw) || typeof raw.kind !== 'string' || !isDict(raw.data)) continue;
                if (!result.options.receivers.includes(raw.kind)) continue;
                items.push({
                    kind: raw.kind,
                    why: typeof raw.why === 'string' ? raw.why.slice(0, 400) : '',
                    data: raw.data,
                });
                if (items.length >= result.options.max) break;
            }
            return { ok: true, output: items.length ? { type: 'proposals', items } : { type: 'none' } };
        }
        case 'choices': {
            if (!isDict(data) || !Array.isArray(data.choices)) return { ok: false, error: 'shape' };
            const choices = data.choices
                .filter((item): item is string => typeof item === 'string')
                .map((item) => cleanPlain(item).slice(0, CHOICE_MAX))
                .filter(Boolean)
                .slice(0, result.options.count);
            return choices.length ? { ok: true, output: { type: 'choices', choices } } : { ok: false, error: 'empty' };
        }
    }
}

/**
 * The one-shot instruction a verdict gives the redone reply (like M12's «[Fix for this reply: …]»): what was wrong and
 * how to write it instead.
 */
export function verdictFix(agentName: string, problems: readonly VerdictProblem[]): string {
    const lines = problems.map((problem) => {
        const quote = problem.quote ? `«${problem.quote}» — ` : '';
        const fix = problem.fix ? ` Instead: ${problem.fix}` : '';
        return `- ${quote}${problem.issue}.${fix}`;
    });
    return `[Fix for this reply (${agentName}):\n${lines.join('\n')}]`;
}
