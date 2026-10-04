// Per-scenario parameters and the built-in scenarios of M34 п. 7 / п. 9 (stage 5).
// - Registry: descriptors {id, title, types, defaults, fields} for the studio UI; the user's values live in the
//   settings slice `scenarioParams[id]` and are merged over the defaults (domain/scenario-builtins.ts).
// - «impersonate» (type 'impersonate') and «continue» (type 'continue'), both OFF by default. Without a custom message
//   set they keep ST's prompt and only set this request's parameters (CHAT_COMPLETION_SETTINGS_READY; `stream` never
//   changes, P-128): impersonate — a short reply, its own stop strings, no reasoning; continue — its own length.
//   With a custom message set the prompt is replaced: `{{history}}` = the recent chat; continue appends ST's continued
//   message (and its nudge) once, so neither the continued text nor a prefill goes out twice.
// - A continue of a sheet message (M31) is left to the sheets module: the scenario does not take it.
import {
    DEFAULT_HISTORY_MESSAGES,
    chatExcerpt,
    continuedIndex,
    expandCustomMessages,
    expandNames,
    hasCustomMessages,
    mergeScenarioParams,
    requestParams,
    sanitizeScenarioParams,
} from '../../domain/scenario-builtins';
import type { ChatNames, ScenarioParamValues } from '../../domain/scenario-builtins';
import type { PromptMessage } from '../../domain/scenario-params';
import type { GenerationInfo, Host, Logger, Unsubscribe } from '../../shared/contracts';
import type { Scenario, ScenarioContext, ScenarioDescriptor, ScenarioPlan } from './api';

export const IMPERSONATE_SCENARIO = 'impersonate';
export const CONTINUE_SCENARIO = 'continue';

const ALL_FIELDS: (keyof ScenarioParamValues)[] = [
    'enabled',
    'max_tokens',
    'temperature',
    'stop',
    'reasoning',
    'messages',
    'historyMessages',
];

export const BUILTIN_DESCRIPTORS: readonly ScenarioDescriptor[] = [
    {
        id: IMPERSONATE_SCENARIO,
        titleKey: 'scn.impersonate.title',
        descriptionKey: 'scn.impersonate.desc',
        types: ['impersonate'],
        defaults: {
            enabled: false,
            max_tokens: 300,
            stop: ['\n{{char}}:'],
            reasoning: 'off',
            messages: [],
            historyMessages: DEFAULT_HISTORY_MESSAGES,
        },
        fields: ALL_FIELDS,
    },
    {
        id: CONTINUE_SCENARIO,
        titleKey: 'scn.continue.title',
        descriptionKey: 'scn.continue.desc',
        types: ['continue'],
        defaults: {
            enabled: false,
            max_tokens: 400,
            reasoning: 'keep',
            messages: [],
            historyMessages: DEFAULT_HISTORY_MESSAGES,
        },
        fields: ALL_FIELDS,
    },
];

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The settings part the registry owns. */
export interface ScenarioParamsSlice {
    scenarioParams: Record<string, ScenarioParamValues>;
}

export class ScenarioRegistry {
    private readonly descriptors = new Map<string, ScenarioDescriptor>();

    constructor(
        private readonly slice: ScenarioParamsSlice,
        /** Persists the settings (notify + save). */
        private readonly persist: () => void,
    ) {
        for (const descriptor of BUILTIN_DESCRIPTORS) this.descriptors.set(descriptor.id, descriptor);
    }

    list(): ScenarioDescriptor[] {
        return [...this.descriptors.values()].map((descriptor) => ({
            ...descriptor,
            types: [...descriptor.types],
            defaults: { ...descriptor.defaults },
            fields: [...descriptor.fields],
        }));
    }

    params(id: string): ScenarioParamValues | null {
        const descriptor = this.descriptors.get(id);
        if (!descriptor) return null;
        return mergeScenarioParams(descriptor.defaults, this.stored()[id]);
    }

    setParams(id: string, values: Partial<ScenarioParamValues> | null): void {
        if (!this.descriptors.has(id)) return;
        const stored = this.stored();
        if (values === null) delete stored[id];
        else stored[id] = { ...sanitizeScenarioParams(stored[id]), ...sanitizeScenarioParams(values) };
        this.persist();
    }

    describe(descriptor: ScenarioDescriptor): Unsubscribe {
        this.descriptors.set(descriptor.id, descriptor);
        return () => {
            if (this.descriptors.get(descriptor.id) === descriptor) this.descriptors.delete(descriptor.id);
        };
    }

    private stored(): Record<string, ScenarioParamValues> {
        if (!isDict(this.slice.scenarioParams)) this.slice.scenarioParams = {};
        return this.slice.scenarioParams;
    }
}

export interface BuiltinDeps {
    host: Host;
    log: Logger;
    params(id: string): ScenarioParamValues | null;
    /** M31: the message is a sheet command or a sheet reply. */
    isSheetMessage?(index: number): boolean;
}

function namesOf(host: Host): ChatNames {
    const context = host.ctx();
    return { char: String(context.name2 ?? ''), user: String(context.name1 ?? '') };
}

/** Full macro substitution of custom messages (ST's own), falling back to the two names. */
function substituter(host: Host, names: ChatNames): (text: string) => string {
    return (text) => {
        try {
            const context = host.ctx();
            if (typeof context.substituteParams === 'function') return context.substituteParams(text);
        } catch {
            // fall through to the plain names
        }
        return expandNames(text, names);
    };
}

/** Drops trailing assistant messages: the continued message already plays that part. */
function withoutTrailingAssistant(messages: PromptMessage[]): PromptMessage[] {
    let end = messages.length;
    while (end > 0 && messages[end - 1]?.role === 'assistant') end--;
    return messages.slice(0, end);
}

export function builtinScenario(
    id: typeof IMPERSONATE_SCENARIO | typeof CONTINUE_SCENARIO,
    deps: BuiltinDeps,
): Scenario {
    const type = id === IMPERSONATE_SCENARIO ? 'impersonate' : 'continue';
    return {
        id,
        match(info: GenerationInfo): boolean {
            if (info.dryRun || info.quiet || info.type !== type) return false;
            if (deps.params(id)?.enabled !== true) return false;
            if (type === 'continue') {
                const last = deps.host.ctx().chat.length - 1;
                if (last >= 0 && deps.isSheetMessage?.(last)) return false;
            }
            return true;
        },
        async build(context: ScenarioContext): Promise<ScenarioPlan | null> {
            const values = deps.params(id) ?? {};
            const names = namesOf(deps.host);
            const params = requestParams(values, names);
            const keep: ScenarioPlan | null = params ? { messages: [], keepPrompt: true, params } : null;
            if (!hasCustomMessages(values)) return keep;
            const limit = values.historyMessages ?? DEFAULT_HISTORY_MESSAGES;
            const substitute = substituter(deps.host, names);
            const template = values.messages ?? [];
            if (type === 'impersonate') {
                const messages = expandCustomMessages(template, chatExcerpt(context.chat, limit), substitute);
                return { messages, params };
            }
            const last = context.chat.at(-1);
            const at = continuedIndex(context.original, typeof last?.mes === 'string' ? last.mes : '');
            if (at < 0) {
                deps.log.info(`scenario ${id}: the continued message is not in the prompt; ST's prompt is kept`);
                return keep;
            }
            const tail = context.original.slice(at).map((message) => ({ ...message }));
            let head = expandCustomMessages(template, chatExcerpt(context.chat, limit, { skipLast: true }), substitute);
            if (tail[0]?.role === 'assistant') head = withoutTrailingAssistant(head);
            return { messages: [...head, ...tail], params };
        },
    };
}
