// MAESTRO_API.agents and .context (release 1.34, plan §4.10, docs/integration-agents.md): neighbours' model jobs as
// built-in agents of the «Агенты» window (Dramatis' six tasks through Maestro's client; Localizer's «Расширить мир» on its
// own channel, plan В11), their proposal receivers (Dramatis: a profile), their sources of context (Dramatis: the
// cast), and own agents and sets for Officina and other authors. Ids, kinds and sources carry the neighbour's prefix
// (AGENT_PREFIXES); the words a neighbour gives for both languages become i18n keys of the agents window.
import { registerBuiltInAgent } from '../core/builtin-agents';
import type { BuiltInAgentSpec, BuiltInKnob } from '../core/builtin-agents';
import { registerProposalReceiver } from '../core/proposal-receivers';
import type { AgentRun, AgentScope } from '../domain/agents/types';
import type { AgentsApi } from '../features/agents/api';
import type { App, AutonomyLevel, I18nParts, JournalChange, Logger, Proposal, Unsubscribe } from '../shared/contracts';
import type {
    ApiAgentRun,
    ApiAgents,
    ApiBuiltInSpec,
    ApiContext,
    ApiContextSource,
    ApiLabel,
    ApiProposalReceiver,
} from '../shared/public-api-types';

/** Neighbours that may register agents, receivers and sources (NAI Studio and Localizer use their own channels). */
export const AGENT_NEIGHBOURS = ['dramatis', 'officina', 'nai', 'localizer'] as const;
export type AgentNeighbour = (typeof AGENT_NEIGHBOURS)[number];
export const AGENT_PREFIXES: readonly string[] = AGENT_NEIGHBOURS.map((name) => `${name}.`);

const ID_RE = new RegExp(`^(${AGENT_NEIGHBOURS.join('|')})\\.[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}$`);
const LEVELS: readonly AutonomyLevel[] = ['auto', 'notify', 'inbox', 'ask', 'off'];
const SCOPES: readonly AgentScope[] = ['global', 'character', 'chat'];

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** An id with an agents neighbour's prefix ('dramatis.turn', 'localizer.expand'). */
export function isAgentNeighbourId(value: unknown): value is string {
    return typeof value === 'string' && ID_RE.test(value);
}

export function neighbourOf(id: string): AgentNeighbour {
    return AGENT_NEIGHBOURS.find((name) => id.startsWith(`${name}.`)) ?? 'dramatis';
}

function label(value: unknown): ApiLabel | null {
    if (!isDict(value)) return null;
    const ru = typeof value.ru === 'string' ? value.ru.trim() : '';
    const en = typeof value.en === 'string' ? value.en.trim() : '';
    if (!ru && !en) return null;
    return { ru: ru || en, en: en || ru };
}

function jsonCopy<T>(value: T): T {
    const json = JSON.stringify(value);
    return json === undefined ? value : (JSON.parse(json) as T);
}

/** Strings for i18n.register: { key: label } → { en: {key: en}, ru: {key: ru} }. */
function partsOf(entries: [string, ApiLabel][]): I18nParts {
    const en: Record<string, string> = {};
    const ru: Record<string, string> = {};
    for (const [key, value] of entries) {
        en[key] = value.en;
        ru[key] = value.ru;
    }
    return { en, ru };
}

function publicRun(run: AgentRun): ApiAgentRun {
    const out: ApiAgentRun = {
        agentId: run.agentId,
        agentName: run.agentName,
        ok: run.ok,
        builtin: run.builtin === true,
        applied: [...(run.applied ?? [])],
        at: run.startedAt + run.ms,
    };
    if (run.messageIndex !== undefined) out.messageIndex = run.messageIndex;
    if (run.error) out.error = run.error;
    return out;
}

export interface AgentsFacadeDeps {
    app: App;
    log: Logger;
    disposed(): boolean;
    own(off: Unsubscribe): Unsubscribe;
}

export function createAgentsFacade(deps: AgentsFacadeDeps): { agents: ApiAgents; context: ApiContext } {
    const { app, log, own } = deps;
    const agentsApi = () => app.modules.api<AgentsApi>('agents');
    const fail = (message: string): never => {
        throw new Error(`MAESTRO_API.agents: ${message}`);
    };
    /** Built-in agents registered through the API (instruction / report only for these). */
    const external = new Map<string, BuiltInAgentSpec>();

    /* ---------------------------------------------------------------- built-in agents */

    const registerBuiltIn = (raw: ApiBuiltInSpec): Unsubscribe => {
        if (deps.disposed()) return () => {};
        if (!isDict(raw) || !isAgentNeighbourId(raw.id)) fail('id must start with a neighbour prefix');
        const id = raw.id;
        const title = label(raw.title) ?? fail('title {ru, en} is required');
        const when = label(raw.when) ?? fail('when {ru, en} is required');
        const instructions = raw.defaultInstructions;
        const defaults = (): string[] => {
            try {
                const list = typeof instructions === 'function' ? instructions() : instructions;
                return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
            } catch (error) {
                log.debug(`${id}: default instructions not available`, error);
                return [];
            }
        };
        if (!defaults().length) fail('defaultInstructions must give at least one text');
        const strings: [string, ApiLabel][] = [
            [`m44.bi.${id}.title`, title],
            [`m44.bi.${id}.when`, when],
            [`m44.bi.${id}.desc`, label(raw.description) ?? when],
            [`m44.bi.${id}.sources`, label(raw.sources) ?? { ru: '—', en: '—' }],
        ];
        const knobs: BuiltInKnob[] = [];
        for (const knob of Array.isArray(raw.knobs) ? raw.knobs : []) {
            if (!isDict(knob) || typeof knob.id !== 'string' || typeof knob.get !== 'function') continue;
            if (typeof knob.set !== 'function') continue;
            const kind = knob.kind === 'toggle' || knob.kind === 'select' ? knob.kind : 'number';
            const labelKey = `m44.bi.${id}.knob.${knob.id}`;
            strings.push([labelKey, label(knob.label) ?? { ru: knob.id, en: knob.id }]);
            const spec: BuiltInKnob = {
                path: knob.id,
                labelKey,
                kind,
                get: () => knob.get(),
                set: (value) => knob.set(value),
            };
            if (typeof knob.min === 'number') spec.min = knob.min;
            if (typeof knob.max === 'number') spec.max = knob.max;
            if (typeof knob.step === 'number') spec.step = knob.step;
            if (kind === 'select' && Array.isArray(knob.options)) {
                spec.options = knob.options
                    .filter((option) => isDict(option) && typeof option.value === 'string')
                    .map((option) => {
                        const key = `${labelKey}.${option.value}`;
                        strings.push([key, label(option.label) ?? { ru: option.value, en: option.value }]);
                        return { value: option.value, labelKey: key };
                    });
            }
            knobs.push(spec);
        }
        app.i18n.register(partsOf(strings));
        const neighbour = neighbourOf(id);
        const temperature = Number(raw.defaults?.temperature);
        const maxTokens = Number(raw.defaults?.maxTokens);
        const spec: BuiltInAgentSpec = {
            id,
            module: neighbour,
            neighbour,
            group: 'neighbours',
            icon: typeof raw.icon === 'string' && /^fa-[a-z0-9-]+$/.test(raw.icon) ? raw.icon : 'fa-puzzle-piece',
            defaultInstructions: defaults,
            defaults: {
                maxTokens: Number.isFinite(maxTokens) && maxTokens > 0 ? maxTokens : 1000,
                temperature: Number.isFinite(temperature) ? temperature : 0.5,
            },
            channel: raw.channel === 'own' ? 'own' : 'maestro',
        };
        if (knobs.length) spec.knobs = knobs;
        if (raw.interactive === true) spec.interactive = true;
        if (typeof raw.enabled === 'function' && typeof raw.setEnabled === 'function') {
            const get = raw.enabled.bind(raw);
            const set = raw.setEnabled.bind(raw);
            spec.toggle = { get: () => get() !== false, set: (on) => set(on) };
        }
        external.set(id, spec);
        const off = registerBuiltInAgent(spec);
        return own(() => {
            off();
            if (external.get(id) === spec) external.delete(id);
        });
    };

    const instruction: ApiAgents['instruction'] = (id, defaultText) => {
        const text = typeof defaultText === 'string' ? defaultText : '';
        if (!external.has(id)) return { text };
        return agentsApi()?.builtinInstruction?.(id, text) ?? { text };
    };

    const report: ApiAgents['report'] = (id, run) => {
        if (deps.disposed() || !external.has(id) || !isDict(run)) return;
        agentsApi()?.reportBuiltinRun?.(id, {
            ok: run.ok === true,
            ms: Number(run.ms) || 0,
            ...(typeof run.error === 'string' ? { error: run.error } : {}),
            ...(typeof run.costUsd === 'number' ? { costUsd: run.costUsd } : {}),
            ...(isDict(run.tokens) ? { tokens: run.tokens as { prompt: number; completion: number } } : {}),
            ...(Array.isArray(run.request) ? { request: run.request } : {}),
            ...(typeof run.raw === 'string' ? { raw: run.raw } : {}),
        });
    };

    /* ---------------------------------------------------------------- own agents and sets */

    const scopeOf = (value: unknown): AgentScope =>
        SCOPES.includes(value as AgentScope) ? (value as AgentScope) : 'global';

    const list: ApiAgents['list'] = () => {
        const api = agentsApi();
        if (!api) return [];
        const states = api.states();
        return api.list().map((def) => ({
            id: def.id,
            name: def.name,
            builtin: false,
            phase: def.trigger.phase,
            result: def.result.type,
            on: states.get(def.id)?.on === true,
        }));
    };

    const agents: ApiAgents = {
        registerBuiltIn,
        instruction,
        report,
        list,
        get: (id) => {
            const def = agentsApi()?.get(id);
            return def ? (jsonCopy(def) as unknown as Record<string, unknown>) : null;
        },
        save: async (def) => {
            const api = agentsApi();
            if (deps.disposed() || !api?.save || !isDict(def)) return null;
            return api.save(jsonCopy(def));
        },
        setEnabled: async (id, on, scope) => {
            const api = agentsApi();
            if (deps.disposed() || !api?.setState || !api.get(id)) return false;
            await api.setState(scopeOf(scope), id, { on: on === true });
            return true;
        },
        sets: () => jsonCopy(agentsApi()?.sets?.() ?? []) as unknown as Record<string, unknown>[],
        saveSet: async (set) => {
            const api = agentsApi();
            if (deps.disposed() || !api?.saveSet || !isDict(set)) return false;
            if (typeof set.id !== 'string' || typeof set.name !== 'string' || !isDict(set.agents)) return false;
            if (set.builtin === true) return false;
            await api.saveSet(jsonCopy(set) as never);
            return true;
        },
        applySet: async (setId, scope) => {
            const api = agentsApi();
            if (deps.disposed() || !api?.applySet || !api.sets?.().some((set) => set.id === setId)) return false;
            await api.applySet(scopeOf(scope), setId);
            return true;
        },
        run: async (id, options) => {
            const api = agentsApi();
            if (deps.disposed() || !api) return null;
            const run = await api.run(
                id,
                typeof options?.messageIndex === 'number' ? { messageIndex: options.messageIndex } : {},
            );
            return run ? publicRun(run) : null;
        },
        onResult: (listener) => {
            const api = agentsApi();
            if (deps.disposed() || typeof listener !== 'function' || !api?.onRun) return () => {};
            return own(
                api.onRun((run) => {
                    try {
                        listener(publicRun(run));
                    } catch (error) {
                        log.warn('MAESTRO_API agents.onResult listener failed', error);
                    }
                }),
            );
        },
        registerReceiver: (raw: ApiProposalReceiver) => {
            if (deps.disposed()) return () => {};
            if (!isDict(raw) || !isAgentNeighbourId(raw.kind)) fail('kind must start with a neighbour prefix');
            if (typeof raw.toProposal !== 'function' || typeof raw.apply !== 'function')
                fail('toProposal and apply are required');
            if (typeof raw.describe !== 'string' || !isDict(raw.schema)) fail('describe and schema are required');
            const kind = raw.kind;
            const name = label(raw.label) ?? fail('label {ru, en} is required');
            app.i18n.register(
                partsOf([
                    [`m44.recv.${kind}`, name],
                    [`kind.${kind}`, name],
                ]),
            );
            const module = neighbourOf(kind);
            const apply = (payload: unknown) => raw.apply(payload);
            const off = registerProposalReceiver({
                kind,
                module,
                labelKey: `m44.recv.${kind}`,
                describe: raw.describe,
                schema: raw.schema,
                defaultAutonomy: LEVELS.includes(raw.defaultAutonomy as AutonomyLevel)
                    ? (raw.defaultAutonomy as AutonomyLevel)
                    : 'inbox',
                ...(raw.neverAuto === true ? { neverAuto: true } : {}),
                ...(raw.direct === true ? { direct: true } : {}),
                ...(typeof raw.available === 'function' ? { available: (context) => raw.available!(context) } : {}),
                toProposal: async (data, context): Promise<Proposal | null> => {
                    const made = await raw.toProposal(data, context);
                    if (!isDict(made) || typeof made.title !== 'string' || !made.title.trim()) return null;
                    const changes: JournalChange[] = Array.isArray(made.changes)
                        ? made.changes.filter(
                              (change): change is JournalChange =>
                                  isDict(change) && typeof change.target === 'string' && isDict(change.ref),
                          )
                        : [];
                    const proposal: Proposal = {
                        module,
                        kind,
                        title: made.title.trim(),
                        changes,
                        payload: made.payload,
                        apply,
                    };
                    if (typeof made.description === 'string' && made.description.trim())
                        proposal.description = made.description.trim();
                    if (typeof made.sourceMessage === 'number') proposal.sourceMessage = made.sourceMessage;
                    return proposal;
                },
                apply,
            });
            return own(off);
        },
    };

    /* ---------------------------------------------------------------- context sources */

    const context: ApiContext = {
        register: (raw: ApiContextSource) => {
            if (deps.disposed()) return () => {};
            if (!isDict(raw) || !isAgentNeighbourId(raw.id)) fail('source id must start with a neighbour prefix');
            if (typeof raw.render !== 'function' || typeof raw.title !== 'string')
                fail('title and render are required');
            const api = agentsApi();
            if (!api) return () => {};
            const name = label(raw.label) ?? { ru: raw.id, en: raw.id };
            const labelKey = `m44.src.${raw.id}`;
            app.i18n.register(partsOf([[labelKey, name]]));
            const budget = Number(raw.budget);
            const off = api.registerSource({
                id: raw.id,
                labelKey,
                title: raw.title.slice(0, 120),
                budget: Number.isFinite(budget) && budget > 0 ? Math.min(budget, 20_000) : 1500,
                stable: raw.stable === true,
                ...(typeof raw.available === 'function'
                    ? {
                          available: () => {
                              try {
                                  return raw.available!() !== false;
                              } catch {
                                  return false;
                              }
                          },
                      }
                    : {}),
                render: async (ctx, limit) => {
                    try {
                        const text = await raw.render({
                            agentId: ctx.agentId,
                            budget: limit,
                            ...(ctx.focusIndex !== undefined ? { focusIndex: ctx.focusIndex } : {}),
                        });
                        return typeof text === 'string' ? text.slice(0, limit) : '';
                    } catch (error) {
                        log.warn(`source ${raw.id} failed`, error);
                        return '';
                    }
                },
            });
            return own(off);
        },
    };

    return { agents, context };
}
