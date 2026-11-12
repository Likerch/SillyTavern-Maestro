// Agent definitions (plan §4.2, §4.3): defaults of every result type, sanitising what comes from a file, an import or a
// card (unknown or broken parts are dropped, never trusted), ids, capabilities, and how sets and the three scopes
// («везде / персонаж / чат», the nearest wins) give the state of an agent in the open chat.
import { sanitizeTools } from './tools';
import { AGENT_EVENTS, AGENT_PHASES, AGENT_RESULT_TYPES } from './types';
import type {
    AgentConditions,
    AgentDef,
    AgentEvent,
    AgentLimits,
    AgentModel,
    AgentOrigin,
    AgentPhase,
    AgentReasoning,
    AgentResultSpec,
    AgentResultType,
    AgentScopeState,
    AgentSet,
    AgentSourceRef,
    AgentState,
    AgentTrigger,
    AgentVariant,
    InjectOptions,
    MaestroMode,
    MemoryField,
    VerdictAction,
} from './types';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown, max = 20_000): string {
    return typeof value === 'string' ? value.slice(0, max) : '';
}

function num(value: unknown, min: number, max: number): number | undefined {
    if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
    return Math.min(max, Math.max(min, value));
}

function int(value: unknown, min: number, max: number): number | undefined {
    const n = num(value, min, max);
    return n === undefined ? undefined : Math.round(n);
}

function strList(value: unknown, maxItems = 50, maxLength = 200): string[] {
    if (!Array.isArray(value)) return [];
    const out: string[] = [];
    for (const item of value) {
        if (typeof item !== 'string') continue;
        const text = item.trim().slice(0, maxLength);
        if (text && !out.includes(text)) out.push(text);
        if (out.length >= maxItems) break;
    }
    return out;
}

function pick<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
    return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/* ------------------------------------------------------------------ ids */

/** Latin slug of a name (Cyrillic transliterated) for readable ids. */
export function slugOf(name: string): string {
    const map: Record<string, string> = {
        а: 'a',
        б: 'b',
        в: 'v',
        г: 'g',
        д: 'd',
        е: 'e',
        ё: 'e',
        ж: 'zh',
        з: 'z',
        и: 'i',
        й: 'y',
        к: 'k',
        л: 'l',
        м: 'm',
        н: 'n',
        о: 'o',
        п: 'p',
        р: 'r',
        с: 's',
        т: 't',
        у: 'u',
        ф: 'f',
        х: 'h',
        ц: 'c',
        ч: 'ch',
        ш: 'sh',
        щ: 'sch',
        ъ: '',
        ы: 'y',
        ь: '',
        э: 'e',
        ю: 'yu',
        я: 'ya',
    };
    const latin = [...name.toLowerCase()].map((char) => map[char] ?? char).join('');
    const slug = latin
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 24);
    return slug || 'agent';
}

/** A new id for an own agent: 'u-<slug>-<rand>'. */
export function newAgentId(name: string, random: () => number = Math.random): string {
    const rand = Math.floor(random() * 36 ** 5)
        .toString(36)
        .padStart(5, '0');
    return `u-${slugOf(name)}-${rand}`;
}

export const AGENT_ID_RE = /^u-[a-z0-9-]{1,40}$/;

/** Flag names an agent may set (`maestro_a_<name>`). */
export const FLAG_NAME_RE = /^[a-z][a-z0-9_]{0,31}$/;

/* ------------------------------------------------------------------ defaults */

export const DEFAULT_INJECT: InjectOptions = { position: 'depth', depth: 2, role: 'system', lifetime: 'turn' };

export const DEFAULT_MODEL: Required<Pick<AgentModel, 'temperature' | 'maxTokens' | 'reasoning'>> = {
    temperature: 0.7,
    maxTokens: 800,
    reasoning: 'off',
};

/** Rewrites answer the whole reply: they need room. */
export const REWRITE_MIN_TOKENS = 2500;

export const DEFAULT_SOURCES: AgentSourceRef[] = [{ id: 'messages', budget: 6 }];

export const DEFAULT_ON_SEND_TIMEOUT_MS = 6000;

/** Default options of a result type. */
export function defaultResult(type: AgentResultType): AgentResultSpec {
    switch (type) {
        case 'inject':
            return { type, options: { ...DEFAULT_INJECT } };
        case 'flags':
            return { type, options: { names: [] } };
        case 'rewrite':
            return { type, options: { holdReply: false } };
        case 'verdict':
            return { type, options: { action: 'mark' } };
        case 'note':
            return { type, options: { show: 'strip' } };
        case 'choices':
            return { type, options: { count: 3, send: false } };
        case 'memory':
            return {
                type,
                options: { fields: [], inject: false, injectOptions: { ...DEFAULT_INJECT, lifetime: 'untilNext' } },
            };
        case 'proposals':
            return { type, options: { receivers: [], max: 5 } };
    }
}

/** The phase a result type fits best (a new agent of this type starts there). */
export function defaultPhaseFor(type: AgentResultType): AgentPhase {
    switch (type) {
        case 'inject':
        case 'flags':
            return 'prefetch';
        case 'memory':
        case 'proposals':
            return 'schedule';
        default:
            return 'post';
    }
}

/** A blank own agent (the editor's «Новый агент»). */
export function blankAgent(name: string, now: number, id = newAgentId(name)): AgentDef {
    const result = defaultResult('note');
    return {
        v: 1,
        id,
        kind: 'custom',
        name,
        origin: 'user',
        instruction: '',
        sources: DEFAULT_SOURCES.map((source) => ({ ...source })),
        trigger: { phase: defaultPhaseFor(result.type) },
        result,
        model: {},
        capabilities: capabilitiesOf({ result, sources: DEFAULT_SOURCES }),
        updatedAt: now,
    };
}

/* ------------------------------------------------------------------ capabilities */

/**
 * What an agent may do, as stable codes (the UI translates them, plan §3.10): shown on import and before card agents
 * are switched on.
 */
export function capabilitiesOf(def: Pick<AgentDef, 'result' | 'sources' | 'tools'>): string[] {
    const caps: string[] = [];
    switch (def.result.type) {
        case 'inject':
            caps.push('prompt.inject');
            break;
        case 'flags':
            caps.push('prompt.flags');
            break;
        case 'rewrite':
            caps.push('reply.rewrite');
            break;
        case 'verdict':
            caps.push('reply.verdict');
            if (def.result.options.action === 'swipe' || def.result.options.action === 'continue')
                caps.push('reply.redo');
            break;
        case 'note':
            caps.push('note');
            break;
        case 'choices':
            caps.push('choices');
            break;
        case 'memory':
            caps.push('memory');
            if (def.result.options.inject) caps.push('prompt.inject');
            break;
        case 'proposals':
            for (const kind of def.result.options.receivers) caps.push(`propose.${kind}`);
            break;
    }
    for (const source of def.sources) caps.push(`read.${source.id}`);
    for (const tool of def.tools ?? []) caps.push(`tool.${tool}`);
    return caps;
}

/* ------------------------------------------------------------------ sanitising */

function sanitizeInject(raw: unknown, fallback: InjectOptions): InjectOptions {
    const o = isDict(raw) ? raw : {};
    return {
        position: pick(o.position, ['top', 'afterMain', 'depth'] as const, fallback.position),
        depth: int(o.depth, 0, 100) ?? fallback.depth,
        role: pick(o.role, ['system', 'user', 'assistant'] as const, fallback.role),
        lifetime: pick(o.lifetime, ['turn', 'untilNext'] as const, fallback.lifetime),
    };
}

function sanitizeResult(raw: unknown): AgentResultSpec {
    const r = isDict(raw) ? raw : {};
    const type = pick<AgentResultType>(r.type, AGENT_RESULT_TYPES, 'note');
    const o = isDict(r.options) ? r.options : {};
    const base = defaultResult(type);
    switch (base.type) {
        case 'inject':
            return { type: 'inject', options: sanitizeInject(o, base.options) };
        case 'flags':
            return {
                type: 'flags',
                options: { names: strList(o.names, 20, 32).filter((name) => FLAG_NAME_RE.test(name)) },
            };
        case 'rewrite':
            return { type: 'rewrite', options: { holdReply: o.holdReply === true } };
        case 'verdict':
            return {
                type: 'verdict',
                options: {
                    action: pick<VerdictAction>(o.action, ['mark', 'offerRedo', 'swipe', 'continue'], 'mark'),
                },
            };
        case 'note':
            return { type: 'note', options: { show: pick(o.show, ['strip', 'toast'] as const, 'strip') } };
        case 'choices':
            return { type: 'choices', options: { count: int(o.count, 2, 5) ?? 3, send: o.send === true } };
        case 'proposals':
            return {
                type: 'proposals',
                options: {
                    receivers: strList(o.receivers, 20, 60).filter((kind) => /^[a-z][\w.]{0,59}$/.test(kind)),
                    max: int(o.max, 1, 20) ?? 5,
                },
            };
        case 'memory': {
            const fields: MemoryField[] = [];
            if (Array.isArray(o.fields)) {
                for (const item of o.fields) {
                    if (!isDict(item)) continue;
                    const name = str(item.name, 60).trim();
                    if (!name || fields.some((field) => field.name === name)) continue;
                    const hint = str(item.hint, 300).trim();
                    fields.push(hint ? { name, hint } : { name });
                    if (fields.length >= 20) break;
                }
            }
            return {
                type: 'memory',
                options: {
                    fields,
                    inject: o.inject === true,
                    injectOptions: sanitizeInject(o.injectOptions, base.options.injectOptions),
                },
            };
        }
    }
}

function sanitizeConditions(raw: unknown): AgentConditions | undefined {
    if (!isDict(raw)) return undefined;
    const out: AgentConditions = {};
    const scenes = strList(raw.scenes, 20, 40);
    if (scenes.length) out.scenes = scenes;
    const words = strList(raw.words, 50, 80);
    if (words.length) out.words = words;
    const depth = int(raw.scanDepth, 1, 50);
    if (depth !== undefined) out.scanDepth = depth;
    const modes = strList(raw.modes, 3, 20).filter((mode): mode is MaestroMode =>
        ['economy', 'balanced', 'cinema'].includes(mode),
    );
    if (modes.length) out.modes = modes;
    const requires = strList(raw.requires, 20, 40);
    if (requires.length) out.requires = requires;
    if (raw.group === 'only' || raw.group === 'never') out.group = raw.group;
    if (raw.stalled === true) out.stalled = true;
    return Object.keys(out).length ? out : undefined;
}

function sanitizeTrigger(raw: unknown, resultType: AgentResultType): AgentTrigger {
    const t = isDict(raw) ? raw : {};
    const trigger: AgentTrigger = { phase: pick<AgentPhase>(t.phase, AGENT_PHASES, defaultPhaseFor(resultType)) };
    const every = int(t.everyMessages, 0, 1000);
    if (every) trigger.everyMessages = every;
    const events = strList(t.events, 10, 20).filter((event): event is AgentEvent =>
        (AGENT_EVENTS as readonly string[]).includes(event),
    );
    if (events.length) trigger.events = events;
    const breakHours = num(t.breakHours, 1, 24 * 30);
    if (breakHours !== undefined) trigger.breakHours = breakHours;
    const priority = int(t.priority, -100, 100);
    if (priority !== undefined) trigger.priority = priority;
    const timeout = int(t.onSendTimeoutMs, 1000, 30_000);
    if (timeout !== undefined) trigger.onSendTimeoutMs = timeout;
    const when = sanitizeConditions(t.when);
    if (when) trigger.when = when;
    return trigger;
}

function sanitizeModel(raw: unknown): AgentModel {
    const m = isDict(raw) ? raw : {};
    const model: AgentModel = {};
    const profile = str(m.profile, 200).trim();
    if (profile) model.profile = profile;
    const temperature = num(m.temperature, 0, 2);
    if (temperature !== undefined) model.temperature = temperature;
    const maxTokens = int(m.maxTokens, 50, 16_000);
    if (maxTokens !== undefined) model.maxTokens = maxTokens;
    if (typeof m.reasoning === 'string')
        model.reasoning = pick<AgentReasoning>(m.reasoning, ['off', 'low', 'medium', 'high'], 'off');
    return model;
}

function sanitizeSources(raw: unknown): AgentSourceRef[] {
    if (!Array.isArray(raw)) return DEFAULT_SOURCES.map((source) => ({ ...source }));
    const out: AgentSourceRef[] = [];
    for (const item of raw) {
        if (!isDict(item)) continue;
        const id = str(item.id, 60).trim();
        if (!/^[a-z][a-zA-Z0-9.]*$/.test(id) || out.some((source) => source.id === id)) continue;
        const budget = int(item.budget, 1, 50_000);
        out.push(budget === undefined ? { id } : { id, budget });
        if (out.length >= 30) break;
    }
    return out;
}

function sanitizeVariants(raw: unknown): AgentVariant[] | undefined {
    if (!Array.isArray(raw)) return undefined;
    const out: AgentVariant[] = [];
    for (const item of raw) {
        if (!isDict(item)) continue;
        const id = str(item.id, 40).trim();
        const name = str(item.name, 80).trim();
        if (!id || !name || out.some((variant) => variant.id === id)) continue;
        out.push({ id, name, instruction: str(item.instruction) });
        if (out.length >= 10) break;
    }
    return out.length ? out : undefined;
}

function sanitizeVars(raw: unknown): Record<string, string> | undefined {
    if (!isDict(raw)) return undefined;
    const out: Record<string, string> = {};
    for (const [key, value] of Object.entries(raw)) {
        if (!/^[a-zA-Zа-яА-ЯёЁ_][\wа-яА-ЯёЁ]{0,31}$/.test(key) || typeof value !== 'string') continue;
        out[key] = value.slice(0, 4000);
        if (Object.keys(out).length >= 20) break;
    }
    return Object.keys(out).length ? out : undefined;
}

function sanitizeLimits(raw: unknown): AgentLimits | undefined {
    if (!isDict(raw)) return undefined;
    const limits: AgentLimits = {};
    const perTurn = int(raw.perTurn, 0, 20);
    if (perTurn) limits.perTurn = perTurn;
    const dailyUsd = num(raw.dailyUsd, 0, 1000);
    if (dailyUsd) limits.dailyUsd = dailyUsd;
    return Object.keys(limits).length ? limits : undefined;
}

function sanitizeOrigin(raw: unknown): AgentOrigin {
    if (typeof raw !== 'string') return 'user';
    if (raw === 'user' || raw === 'import' || raw === 'assistant' || raw === 'officina') return raw;
    if (/^template:[a-z0-9-]{1,40}$/.test(raw)) return raw as AgentOrigin;
    if (/^card:.{1,200}$/.test(raw)) return raw as AgentOrigin;
    return 'user';
}

/** Turns stored or imported data into a valid own agent; null when it cannot be one. */
export function sanitizeAgent(raw: unknown, now: number): AgentDef | null {
    if (!isDict(raw)) return null;
    const name = str(raw.name, 80).trim();
    if (!name) return null;
    const id = typeof raw.id === 'string' && AGENT_ID_RE.test(raw.id) ? raw.id : newAgentId(name);
    const result = sanitizeResult(raw.result);
    const sources = sanitizeSources(raw.sources);
    const def: AgentDef = {
        v: 1,
        id,
        kind: 'custom',
        name,
        origin: sanitizeOrigin(raw.origin),
        instruction: str(raw.instruction),
        sources,
        trigger: sanitizeTrigger(raw.trigger, result.type),
        result,
        model: sanitizeModel(raw.model),
        capabilities: capabilitiesOf({ result, sources }),
        updatedAt: typeof raw.updatedAt === 'number' && Number.isFinite(raw.updatedAt) ? raw.updatedAt : now,
    };
    const iconName = str(raw.icon, 40).trim();
    if (/^fa-[a-z0-9-]+$/.test(iconName)) def.icon = iconName;
    const description = str(raw.description, 500).trim();
    if (description) def.description = description;
    const templateId = str(raw.templateId, 40).trim();
    if (/^[a-z0-9-]+$/.test(templateId)) def.templateId = templateId;
    const variants = sanitizeVariants(raw.variants);
    if (variants) def.variants = variants;
    const vars = sanitizeVars(raw.vars);
    if (vars) def.vars = vars;
    if (raw.batch === true) def.batch = true;
    if (isDict(raw.gate)) {
        const question = str(raw.gate.question, 500).trim();
        def.gate = question ? { question } : {};
    }
    const limits = sanitizeLimits(raw.limits);
    if (limits) def.limits = limits;
    const tools = sanitizeTools(raw.tools);
    if (tools.length) {
        def.tools = tools;
        def.capabilities = capabilitiesOf(def);
    }
    return def;
}

function sanitizeState(raw: unknown): Partial<AgentState> | null {
    if (!isDict(raw)) return null;
    const state: Partial<AgentState> = {};
    if (typeof raw.on === 'boolean') state.on = raw.on;
    const variant = str(raw.variant, 40).trim();
    if (variant) state.variant = variant;
    const profile = str(raw.profile, 200).trim();
    if (profile) state.profile = profile;
    return Object.keys(state).length ? state : null;
}

function sanitizeStateMap(
    raw: unknown,
    full: boolean,
): Record<string, AgentState> | Record<string, Partial<AgentState>> {
    const out: Record<string, Partial<AgentState>> = {};
    if (!isDict(raw)) return out;
    for (const [key, value] of Object.entries(raw)) {
        if (!AGENT_ID_RE.test(key) && !/^template:[a-z0-9-]{1,40}$/.test(key) && !/^[a-z][a-zA-Z0-9.]{0,60}$/.test(key))
            continue;
        const state = sanitizeState(value);
        if (!state) continue;
        out[key] = full ? { on: state.on === true, ...state } : state;
    }
    return out;
}

export function sanitizeSet(raw: unknown): AgentSet | null {
    if (!isDict(raw)) return null;
    const id = str(raw.id, 60).trim();
    const name = str(raw.name, 80).trim();
    if (!/^[a-z0-9-]{1,60}$/.test(id) || !name) return null;
    return { id, name, agents: sanitizeStateMap(raw.agents, true) as Record<string, AgentState> };
}

export function sanitizeScopeState(raw: unknown): AgentScopeState {
    const r = isDict(raw) ? raw : {};
    const state: AgentScopeState = { overrides: sanitizeStateMap(r.overrides, false) };
    const set = str(r.set, 60).trim();
    if (set) state.set = set;
    return state;
}

/* ------------------------------------------------------------------ sets and scopes */

/**
 * The state of every agent in the open chat: for each scope from the farthest («везде») to the nearest («чат») its set
 * (as a whole: a set names every agent it switches on, the others are off), then its point changes. An agent no layer
 * mentions is off. Built-in sets name templates; `templateAgents` maps a template id to the own agent taken from it.
 */
export function effectiveStates(
    layers: readonly (AgentScopeState | null | undefined)[],
    sets: ReadonlyMap<string, AgentSet>,
    templateAgents: ReadonlyMap<string, string>,
): Map<string, AgentState> {
    const states = new Map<string, AgentState>();
    for (const layer of layers) {
        if (!layer) continue;
        const set = layer.set ? sets.get(layer.set) : undefined;
        if (set) {
            states.clear();
            for (const [key, state] of Object.entries(set.agents)) {
                const id = key.startsWith('template:') ? templateAgents.get(key.slice('template:'.length)) : key;
                if (id) states.set(id, { ...state });
            }
        }
        for (const [id, override] of Object.entries(layer.overrides)) {
            const current = states.get(id) ?? { on: false };
            states.set(id, { ...current, ...override, on: override.on ?? current.on });
        }
    }
    return states;
}

/** Which scope decides an agent's switch now (for «не как в наборе» and «Вернуть к набору»). */
export function decidingScope(
    agentId: string,
    layers: readonly { scope: string; state: AgentScopeState | null | undefined }[],
): { scope: string; bySet: boolean } | null {
    let found: { scope: string; bySet: boolean } | null = null;
    for (const { scope, state } of layers) {
        if (!state) continue;
        if (state.set) found = { scope, bySet: true };
        if (state.overrides[agentId]?.on !== undefined) found = { scope, bySet: false };
    }
    return found;
}

/** A set made of the states in force now (the user's «Сохранить как набор»): only the agents that are on. */
export function setFromStates(id: string, name: string, states: ReadonlyMap<string, AgentState>): AgentSet {
    const agents: Record<string, AgentState> = {};
    for (const [agentId, state] of states) if (state.on) agents[agentId] = { ...state };
    return { id, name, agents };
}
