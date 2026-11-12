// The assistant's agent tools (release 1.34, plan §3.11): it reads the agents, the built-in ones and the sets, tries an
// agent on a message, and — each as a «было / стало» card the user confirms — makes or changes an agent («сделай агента,
// который следит, чтобы злодей не забывал свою цель»), switches one in a scope, puts a set in force, changes a built-in
// agent's instruction. Everything goes through M44's API (journaled with undo there).
import { builtInAgent, builtInAgents } from '../../../core/builtin-agents';
import type { BuiltInOverride } from '../../../domain/agents/builtin';
import { sanitizeAgent } from '../../../domain/agents/def';
import { AGENT_TEMPLATES } from '../../../domain/agents/templates';
import type { AgentDef, AgentScope } from '../../../domain/agents/types';
import type { App } from '../../../shared/contracts';
import type { AgentsApi } from '../../agents/api';
import type { ToolSpec } from '../api';
import { apiOf, argsOf, cut, intArg, notice, objectSchema, prop, readTool, say, strArg } from './read/common';
import type { Dict } from './read/common';
import { failure, planWith } from './write/common';

const SCOPES: readonly AgentScope[] = ['global', 'character', 'chat'];
const MODES = ['addition', 'full', 'default'] as const;

const agentsOf = (app: App) => apiOf<AgentsApi>(app, 'agents');
const available = (app: App) => agentsOf(app) !== undefined;

/** A definition as the model reads it (no ids of no interest, instruction kept whole). */
function view(def: AgentDef): Dict {
    const out: Dict = {
        id: def.id,
        name: def.name,
        instruction: def.instruction,
        sources: def.sources,
        trigger: def.trigger,
        result: def.result,
        model: def.model,
    };
    if (def.vars) out.vars = def.vars;
    if (def.tools) out.tools = def.tools;
    if (def.templateId) out.template = def.templateId;
    if (def.batch) out.batch = true;
    if (def.gate) out.gate = def.gate;
    if (def.limits) out.limits = def.limits;
    return out;
}

/** A built-in agent's default instruction texts ([] when they cannot be read). */
function defaultsOf(id: string): string[] {
    try {
        return builtInAgent(id)?.defaultInstructions() ?? [];
    } catch {
        return [];
    }
}

/** Without the «Агенты» module: a note instead of an answer. */
function off(ctx: { locale: 'en' | 'ru' }) {
    return notice(ctx, 'The Agents module is off.', 'Модуль «Агенты» выключен.');
}

function title(app: App, key: string, fallback: string): string {
    const text = app.i18n.t(key);
    return text && text !== key ? text : fallback;
}

/* ------------------------------------------------------------------ read */

const agentsList = (): ToolSpec =>
    readTool({
        name: 'agents_list',
        description:
            "Lists Maestro's agents: the user's own agents (id, name, when it runs, what it returns, on in this chat), the built-in ones (Maestro's and neighbours' model jobs with an editable instruction), the sets, and the templates one can start from. Use before changing or creating an agent.",
        parameters: objectSchema({}),
        available,
        async run(_args, ctx) {
            const api = agentsOf(ctx.app);
            if (!api) return off(ctx);
            const states = api.states();
            const own = api.list().map((def) => ({
                id: def.id,
                name: def.name,
                phase: def.trigger.phase,
                result: def.result.type,
                on: states.get(def.id)?.on === true,
                ...(def.tools ? { tools: def.tools } : {}),
            }));
            const builtins = builtInAgents().map((spec) => ({
                id: spec.id,
                title: title(ctx.app, `m44.bi.${spec.id}.title`, spec.id),
                changed: Boolean(api.builtinOverride?.(spec.id)),
                ...(spec.neighbour ? { neighbour: spec.neighbour } : {}),
            }));
            const sets = (api.sets?.() ?? []).map((set) => ({
                id: set.id,
                name: set.name,
                builtin: set.builtin === true,
            }));
            const templates = AGENT_TEMPLATES.map((template) => ({
                id: template.id,
                name: title(ctx.app, `m44.tpl.${template.id}.name`, template.id),
                group: template.group,
            }));
            return {
                data: { agents: own, builtins, sets, templates },
                summary: say(ctx, `Agents: ${own.length}`, `Агентов: ${own.length}`),
            };
        },
    });

const agentGet = (): ToolSpec =>
    readTool({
        name: 'agent_get',
        description:
            "One agent's whole definition: the user's own agent by id (instruction, sources, trigger, result, model, tools), or a built-in agent by its id (its default instruction and what the user changed).",
        parameters: objectSchema({ id: prop.string('The agent id (from agents_list).') }, ['id']),
        available,
        async run(rawArgs, ctx) {
            const api = agentsOf(ctx.app);
            if (!api) return off(ctx);
            const id = strArg(argsOf(rawArgs), 'id', 120) ?? '';
            const def = api.get(id);
            if (def) {
                return {
                    data: view(def),
                    untrusted: true,
                    summary: say(ctx, `Agent ${def.name}`, `Агент ${def.name}`),
                };
            }
            const spec = builtInAgent(id);
            if (spec) {
                const defaults = defaultsOf(id);
                return {
                    data: {
                        id,
                        builtin: true,
                        title: title(ctx.app, `m44.bi.${id}.title`, id),
                        defaultInstruction: cut(defaults[0] ?? '', 6000),
                        changed: api.builtinOverride?.(id) ?? null,
                        defaults: spec.defaults,
                    },
                    untrusted: true,
                    summary: say(ctx, `Built-in agent ${id}`, `Встроенный агент ${id}`),
                };
            }
            return {
                data: { error: `No agent "${id}". Use agents_list.` },
                summary: say(ctx, 'No such agent', 'Нет такого агента'),
            };
        },
    });

const agentTest = (): ToolSpec =>
    readTool({
        name: 'agent_test',
        description:
            "Tries the user's own agent on a message without applying anything: returns what it would answer. Costs one request to the agent's model.",
        parameters: objectSchema(
            {
                id: prop.string('The agent id.'),
                message_index: prop.integer('The message to try it on (default: the last reply).'),
            },
            ['id'],
        ),
        available: (app) => typeof agentsOf(app)?.test === 'function',
        async run(rawArgs, ctx) {
            const api = agentsOf(ctx.app);
            if (!api?.test) return off(ctx);
            const args = argsOf(rawArgs);
            const id = strArg(args, 'id', 120) ?? '';
            const index = intArg(args, 'message_index', -1, -1, 1_000_000);
            const outcome = await api.test(id, index >= 0 ? { messageIndex: index } : {});
            if (!outcome)
                return {
                    data: { error: `No agent "${id}".` },
                    summary: say(ctx, 'No such agent', 'Нет такого агента'),
                };
            return {
                data: { ok: outcome.run.ok, error: outcome.run.error ?? null, output: outcome.output ?? null },
                untrusted: true,
                summary: say(ctx, 'Agent tried', 'Пробный запуск агента'),
            };
        },
    });

/* ------------------------------------------------------------------ write */

const agentSave = (): ToolSpec => ({
    name: 'agent_save',
    kind: 'write',
    description:
        "Creates or changes one of the user's own agents. Give `template` (a template id from agents_list) to start from one, and/or `definition`: {id (to change an existing one), name, instruction (English for the model, or the user's language), sources [{id, budget}] (ids: messages, reply, card, persona, lore, canon, wardrobe, staging, desScene, desCharacters, mechanics, director, knowledge, worldNames, places, ownMemory, …), trigger {phase: prefetch|onSend|parallel|post|commit|schedule|manual, everyMessages, events, priority, when}, result {type: inject|flags|rewrite|verdict|note|choices|memory|proposals, options}, model {temperature, maxTokens, reasoning}, vars, tools [roll, lore_search, chat_search]}. A change keeps the fields not given. New agents start off: switch them on with agent_switch.",
    parameters: {
        type: 'object',
        properties: {
            template: { type: 'string', description: 'A template id to start from.' },
            definition: { type: 'object', description: 'The agent (or the fields to change of an existing one).' },
        },
        additionalProperties: false,
    },
    available: (app) => typeof agentsOf(app)?.save === 'function',
    plan: (raw, ctx) =>
        planWith(ctx, (sayIt) => {
            const app = ctx.app;
            const api = agentsOf(app)!;
            const args = argsOf(raw);
            const templateId = strArg(args, 'template', 40);
            const given =
                typeof args.definition === 'object' && args.definition !== null ? (args.definition as Dict) : {};
            let base: Dict = {};
            if (templateId) {
                const made = api.fromTemplate?.(templateId);
                if (!made) {
                    throw failure(sayIt, 'agentTemplate', {
                        template: templateId,
                        list: AGENT_TEMPLATES.map((template) => template.id).join(', '),
                    });
                }
                base = { ...made, name: title(app, `m44.tpl.${templateId}.name`, made.name) };
            }
            const id = typeof given.id === 'string' ? given.id : '';
            const existing = id ? api.get(id) : undefined;
            if (existing) base = { ...existing };
            const draft = sanitizeAgent({ ...base, ...given, ...(existing ? { id: existing.id } : {}) }, Date.now());
            if (!draft) throw failure(sayIt, 'agentInvalid');
            return {
                summary: existing
                    ? sayIt('m33w.agent.summary.change', { name: draft.name })
                    : sayIt('m33w.agent.summary.create', { name: draft.name }),
                target: sayIt('m33w.target.agents'),
                before: existing ? view(existing) : null,
                after: view(draft),
                full: true,
                async apply() {
                    const live = agentsOf(app);
                    if (!live?.save) throw failure(sayIt, 'agentsUnavailable');
                    const saved = await live.save(draft);
                    if (!saved) throw failure(sayIt, 'agentInvalid');
                    return { result: { id: saved, name: draft.name } };
                },
            };
        }),
});

const agentSwitch = (): ToolSpec => ({
    name: 'agent_switch',
    kind: 'write',
    description:
        "Switches one of the user's own agents on or off: everywhere (global), for this character, or in this chat only.",
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The agent id.' },
            on: { type: 'boolean', description: 'true: on; false: off.' },
            scope: { type: 'string', enum: [...SCOPES], description: 'Where (default: chat).' },
        },
        required: ['id', 'on'],
        additionalProperties: false,
    },
    available: (app) => typeof agentsOf(app)?.setState === 'function',
    plan: (raw, ctx) =>
        planWith(ctx, (sayIt) => {
            const api = agentsOf(ctx.app)!;
            const args = argsOf(raw);
            const def = api.get(strArg(args, 'id', 120) ?? '');
            if (!def) throw failure(sayIt, 'agentUnknown', { id: String(args.id ?? '') });
            const on = args.on === true;
            const scope = SCOPES.includes(args.scope as AgentScope) ? (args.scope as AgentScope) : 'chat';
            const now = api.states().get(def.id)?.on === true;
            const state = (value: boolean) => sayIt(value ? 'm33w.state.on' : 'm33w.state.off');
            return {
                summary: sayIt(on ? 'm33w.agent.summary.on' : 'm33w.agent.summary.off', {
                    name: def.name,
                    scope: sayIt(`m33w.agent.scope.${scope}`),
                }),
                target: sayIt('m33w.target.agents'),
                before: { [def.name]: state(now) },
                after: { [def.name]: state(on) },
                scope,
                scopes: SCOPES.map((value) => ({ value, label: sayIt(`m33w.agent.scope.${value}`) })),
                async apply(choice) {
                    const picked = SCOPES.find((value) => value === choice?.scope) ?? scope;
                    await agentsOf(ctx.app)!.setState!(picked, def.id, { on });
                    return { result: { id: def.id, on, scope: picked } };
                },
            };
        }),
});

const agentSetApply = (): ToolSpec => ({
    name: 'agent_set_apply',
    kind: 'write',
    description:
        'Puts a set of agents in force (its templates are taken into work) everywhere, for this character or in this chat. Sets: agents_list.',
    parameters: {
        type: 'object',
        properties: {
            set: { type: 'string', description: 'The set id.' },
            scope: { type: 'string', enum: [...SCOPES], description: 'Where (default: chat).' },
        },
        required: ['set'],
        additionalProperties: false,
    },
    available: (app) => typeof agentsOf(app)?.applySet === 'function',
    plan: (raw, ctx) =>
        planWith(ctx, (sayIt) => {
            const api = agentsOf(ctx.app)!;
            const args = argsOf(raw);
            const setId = strArg(args, 'set', 80) ?? '';
            const set = api.sets?.().find((item) => item.id === setId);
            if (!set) throw failure(sayIt, 'agentSetUnknown', { set: setId });
            const scope = SCOPES.includes(args.scope as AgentScope) ? (args.scope as AgentScope) : 'chat';
            const name = set.titleKey ? title(ctx.app, set.titleKey, set.name) : set.name;
            return {
                summary: sayIt('m33w.agent.summary.set', { name, scope: sayIt(`m33w.agent.scope.${scope}`) }),
                target: sayIt('m33w.target.agents'),
                before: null,
                after: { set: name, agents: Object.keys(set.agents) },
                scope,
                scopes: SCOPES.map((value) => ({ value, label: sayIt(`m33w.agent.scope.${value}`) })),
                async apply(choice) {
                    const picked = SCOPES.find((value) => value === choice?.scope) ?? scope;
                    await agentsOf(ctx.app)!.applySet!(picked, set.id);
                    return { result: { set: set.id, scope: picked } };
                },
            };
        }),
});

const builtinInstruction = (): ToolSpec => ({
    name: 'builtin_agent_instruction',
    kind: 'write',
    description:
        "Changes the instruction of a built-in agent (Maestro's or a neighbour's model job): mode `addition` adds «additional instructions» after its default text, `full` replaces the whole text, `default` goes back to the default. The logic of the job is unchanged.",
    parameters: {
        type: 'object',
        properties: {
            id: { type: 'string', description: 'The built-in agent id (agents_list → builtins).' },
            mode: { type: 'string', enum: [...MODES] },
            text: { type: 'string', description: 'The addition or the whole text (not for default).' },
        },
        required: ['id', 'mode'],
        additionalProperties: false,
    },
    available: (app) => typeof agentsOf(app)?.setBuiltinOverride === 'function',
    plan: (raw, ctx) =>
        planWith(ctx, (sayIt) => {
            const api = agentsOf(ctx.app)!;
            const args = argsOf(raw);
            const id = strArg(args, 'id', 120) ?? '';
            const spec = builtInAgent(id);
            if (!spec) throw failure(sayIt, 'agentUnknown', { id });
            const mode = MODES.find((value) => value === args.mode) ?? 'addition';
            const text = typeof args.text === 'string' ? args.text.trim().slice(0, 12_000) : '';
            if (mode !== 'default' && !text) throw failure(sayIt, 'argEmpty', { name: 'text' });
            const before = api.builtinOverride?.(id) ?? null;
            let next: BuiltInOverride | null = null;
            if (mode !== 'default') {
                next = { ...(before ?? {}), mode };
                if (mode === 'addition') next.addition = text;
                else {
                    const defaults = defaultsOf(id);
                    next.full = text;
                    next.baseText = defaults[0] ?? '';
                }
            }
            const name = title(ctx.app, `m44.bi.${id}.title`, id);
            return {
                summary: sayIt(mode === 'default' ? 'm33w.agent.summary.builtinReset' : 'm33w.agent.summary.builtin', {
                    name,
                }),
                target: sayIt('m33w.target.agents'),
                before: before ? { mode: before.mode, addition: before.addition, full: before.full } : null,
                after: next ? { mode: next.mode, addition: next.addition, full: next.full } : null,
                full: true,
                async apply() {
                    await agentsOf(ctx.app)!.setBuiltinOverride!(
                        id,
                        next,
                        sayIt('m33w.agent.journal.builtin', { name }),
                    );
                    return { result: { id, mode } };
                },
            };
        }),
});

export function agentReadTools(): ToolSpec[] {
    return [agentsList(), agentGet(), agentTest()];
}

export function agentWriteTools(): ToolSpec[] {
    return [agentSave(), agentSwitch(), agentSetApply(), builtinInstruction()];
}
