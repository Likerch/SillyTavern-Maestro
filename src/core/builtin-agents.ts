// The registry of built-in agents (plan §4.8, release 1.29): a module that asks a model for one of its jobs registers
// it here in init() (with own()): its task id (= the agent id, so the «Профили подключения» row keeps working), the
// default instruction texts as they appear in its requests, the module settings that tune it («ручки») and its
// switch. The module keeps building the request and applying the answer; M44 «Агенты» shows the agent and puts the
// user's instruction and model parameters into the module's requests (an LLM client interceptor).
import type { Unsubscribe } from '../shared/contracts';

export interface BuiltInKnob {
    /** Dot path in the module's settings slice ('everyMessages', 'recap.afterHours'). */
    path: string;
    /** i18n key of the label (agents strings: `m44.bi.<id>.knob.<path>`). */
    labelKey: string;
    kind: 'number' | 'toggle' | 'select';
    min?: number;
    max?: number;
    step?: number;
    /** select: values and their i18n keys. */
    options?: { value: string; labelKey: string }[];
    hintKey?: string;
    /** Release 1.34: a neighbour's setting — read and written by the neighbour instead of Maestro's settings slice. */
    get?(): unknown;
    set?(value: unknown): void | Promise<void>;
}

export type BuiltInGroup = 'canon' | 'story' | 'quality' | 'world' | 'mechanics' | 'button' | 'neighbours';

export interface BuiltInAgentSpec {
    /** The task id of the module's requests (LlmRequest.task). */
    id: string;
    /** The module key (settings slice, module switch). */
    module: string;
    group: BuiltInGroup;
    icon: string;
    /**
     * The default instruction as it appears in the system message of a request; several when it depends on the story
     * language or a setting (the first one is shown). The first one found in a request is the one replaced.
     */
    defaultInstructions(): string[];
    defaults: { maxTokens: number; temperature: number };
    /** Settings of the module shown in the agent's card. */
    knobs?: BuiltInKnob[];
    /** What switches the job off: the module itself, or a boolean setting of it. */
    switch?: 'module' | { path: string };
    /** The user starts it himself (buttons): no background cap, no schedule. */
    interactive?: boolean;
    /**
     * Release 1.34: a neighbour's job (MAESTRO_API.agents.registerBuiltIn): the neighbour ('dramatis', 'localizer'…).
     * Its `module` is the same name, not a Maestro module: the switch is `toggle` (or none), the knobs read and write
     * through their own get/set.
     */
    neighbour?: string;
    /** Release 1.34: the neighbour's own switch of the job. */
    toggle?: { get(): boolean; set(on: boolean): void | Promise<void> };
    /**
     * Release 1.34: 'own' — the neighbour calls its model on its own channel (plan В11: NAI Studio, Localizer); Maestro's
     * client never sees the request, so the neighbour asks for the instruction (MAESTRO_API.agents.instruction) and
     * reports its runs. Absent: through Maestro's client (the interceptor applies the user's changes).
     */
    channel?: 'maestro' | 'own';
}

const specs = new Map<string, BuiltInAgentSpec>();
const listeners = new Set<() => void>();

function changed(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (error) {
            console.error('[Maestro] built-in agents listener failed', error);
        }
    }
}

export function registerBuiltInAgent(spec: BuiltInAgentSpec): Unsubscribe {
    specs.set(spec.id, spec);
    changed();
    return () => {
        if (specs.get(spec.id) !== spec) return;
        specs.delete(spec.id);
        changed();
    };
}

export function builtInAgents(): BuiltInAgentSpec[] {
    return [...specs.values()];
}

export function builtInAgent(id: string): BuiltInAgentSpec | undefined {
    return specs.get(id);
}

export function onBuiltInAgentsChange(listener: () => void): Unsubscribe {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Test helper. */
export function resetBuiltInAgents(): void {
    specs.clear();
    changed();
}
