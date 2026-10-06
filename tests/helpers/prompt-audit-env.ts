// A feature env for the prompt audit (M38): the ST mock with a Chat Completion connection (DeepSeek V4 via OpenRouter),
// a character card, and fakes of the preset store and layer (M34), the neighbour prompts (M36), the lore journal (M1),
// the book roles (M35) and the assistant (M33).
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import type { NeighbourPrompt, NeighbourPromptsApi } from '../../src/features/neighbourPrompts/api';
import type { LayerOp, LayerScope } from '../../src/features/presetStudio/layer-api';
import type { PresetBody, PresetPrompt } from '../../src/features/presetStudio/store-api';
import { createUserJobs } from '../../src/core/jobs';
import { promptAuditModule } from '../../src/features/promptAudit';
import type { PromptAuditApi } from '../../src/features/promptAudit/api';
import type { ToolSpec } from '../../src/features/assistant/api';
import { createFeatureEnv } from './medic-app';
import type { FeatureEnv } from './medic-app';
import { EVENT_TYPES } from './st-mock';
import { MARKERS_TEXT, TASK_TEXT, TRACKER_TEXT, WORLD_TEXT } from './prompt-audit-fixtures';

type Dict = Record<string, unknown>;

export class FakePresetStore {
    readonly name = 'Marinara';
    body: PresetBody;
    readonly saved_: PresetBody;
    readonly updates: { identifier: string; patch: Partial<PresetPrompt> }[] = [];
    readonly enabled: { identifiers: string[]; enabled: boolean }[] = [];

    constructor(prompts: PresetPrompt[]) {
        this.body = {
            prompts,
            prompt_order: [
                {
                    character_id: 100001,
                    order: prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: true })),
                },
            ],
        };
        this.saved_ = structuredClone(this.body);
    }

    current(): string {
        return this.name;
    }

    working(): PresetBody {
        return this.body;
    }

    saved(): PresetBody {
        return this.saved_;
    }

    prompts() {
        const order = this.body.prompt_order?.[0]?.order ?? [];
        return order.map((item) => ({
            item,
            prompt: this.body.prompts?.find((prompt) => prompt.identifier === item.identifier) ?? null,
        }));
    }

    async updatePrompt(identifier: string, patch: Partial<PresetPrompt>): Promise<void> {
        this.updates.push({ identifier, patch });
        const prompt = this.body.prompts?.find((item) => item.identifier === identifier);
        if (prompt) Object.assign(prompt, patch);
    }

    async setEnabled(identifiers: string[], enabled: boolean): Promise<void> {
        this.enabled.push({ identifiers, enabled });
        for (const item of this.body.prompt_order?.[0]?.order ?? []) {
            if (identifiers.includes(item.identifier)) item.enabled = enabled;
        }
    }
}

export interface AuditEnv {
    env: FeatureEnv;
    api: PromptAuditApi;
    store: FakePresetStore;
    recorded: { base: string; op: LayerOp; scope?: LayerScope }[];
    neighbours: Map<string, NeighbourPrompt>;
    setGlobal: Mock<(id: string, text: string) => Promise<void>>;
    setScoped: Mock<(id: string, scope: string, text: string | null) => Promise<void>>;
    tools: Map<string, ToolSpec>;
    loreContents: { world: string; uid: number; comment: string; content: string }[];
    /** Runs one real generation with these outgoing messages (slots and flags as set on the context). */
    generate(messages: Dict[], type?: string): Promise<void>;
    restart(): Promise<void>;
    stop(): Promise<void>;
}

export function neighbour(id: string, text: string, extra: Partial<NeighbourPrompt> = {}): NeighbourPrompt {
    return {
        id,
        owner: id.split('.')[0] as NeighbourPrompt['owner'],
        label: `Label of ${id}`,
        description: '',
        present: true,
        text,
        globalText: text,
        setting: '',
        scoped: {},
        editable: true,
        scopable: true,
        usedIn: 'prompt',
        ...extra,
    };
}

export const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

/** The real case as a live setup: the preset's task and world blocks, the DES tracker and NAI Studio's markers. */
export async function createAuditEnv(): Promise<AuditEnv> {
    const env = await createFeatureEnv();
    env.app.jobs = createUserJobs({ log: env.app.log, notice: (text, options) => env.app.ui.notice(text, options) });
    const ctx = env.mock.context as unknown as Dict;
    ctx.characters = [
        { name: 'Alice', avatar: 'alice.png', data: { system_prompt: '', post_history_instructions: '' } },
    ];
    ctx.characterId = 0;
    ctx.name1 = 'Bob';
    ctx.chatCompletionSettings = {
        chat_completion_source: 'openrouter',
        openrouter_model: 'deepseek/deepseek-v4-flash',
        preset_settings_openai: 'Marinara',
    };
    ctx.extensionPrompts = {};
    const store = new FakePresetStore([
        { identifier: 'task', name: 'Task', role: 'system', content: TASK_TEXT },
        {
            identifier: 'world',
            name: 'World',
            role: 'system',
            content: `{{if .maestro_quiet}}Nothing happens.{{else}}${WORLD_TEXT}{{/if}}`,
        },
        { identifier: 'chatHistory', name: 'Chat History', marker: true },
        { identifier: 'combat', name: 'Combat only', role: 'system', content: 'Fight!', injection_trigger: ['swipe'] },
    ]);
    const recorded: AuditEnv['recorded'] = [];
    env.apis.set('presetStore', store);
    env.apis.set('presetLayer', {
        record: async (base: string, op: LayerOp, scope?: LayerScope) => {
            recorded.push({ base, op, scope });
        },
        below: () => structuredClone(store.saved_),
        strip: (_base: string, body: PresetBody) => body,
        get: () => null,
    });
    const neighbours = new Map<string, NeighbourPrompt>([
        ['des.tracker', neighbour('des.tracker', TRACKER_TEXT)],
        ['nai.markers', neighbour('nai.markers', MARKERS_TEXT)],
        [
            'desru.languageLock',
            neighbour('desru.languageLock', '[Отвечай по-русски.]', { editable: false, setting: undefined }),
        ],
    ]);
    const setGlobal = vi.fn(async (id: string, text: string) => {
        const entry = neighbours.get(id)!;
        neighbours.set(id, { ...entry, text, globalText: text, setting: text });
    });
    const setScoped = vi.fn(async (id: string, scope: string, text: string | null) => {
        const entry = neighbours.get(id)!;
        neighbours.set(id, {
            ...entry,
            scoped: { ...entry.scoped, [scope]: text ?? undefined },
            text: text ?? entry.globalText,
        });
    });
    env.apis.set('neighbourPrompts', {
        list: () => [...neighbours.values()],
        get: (id: string) => neighbours.get(id) ?? null,
        setGlobal,
        setScoped,
        effective: (id: string) => neighbours.get(id)?.text ?? '',
        lastReport: () => null,
        ready: async () => {},
        onChange: () => () => {},
    } satisfies NeighbourPromptsApi);
    const loreContents: AuditEnv['loreContents'] = [];
    env.apis.set('loreJournal', {
        lastContents: () => loreContents,
        last: () => ({
            messageIndex: 1,
            at: 1,
            generationType: 'normal',
            totalChars: 0,
            totalTokens: 0,
            overflow: false,
            activations: loreContents.map((content) => ({
                world: content.world,
                uid: content.uid,
                comment: content.comment,
                chars: content.content.length,
                tokens: 1,
                position: 0,
                order: 100,
                loop: 1,
                recursionLevel: 0,
                tags: content.world === 'BunnyMo' ? ['bunnymo.core'] : [],
            })),
        }),
    });
    env.apis.set('bookRoles', { roleOf: () => undefined });
    const tools = new Map<string, ToolSpec>();
    env.apis.set('assistant', {
        registerTool: (tool: ToolSpec) => {
            tools.set(tool.name, tool);
            return () => tools.delete(tool.name);
        },
    });

    const holder: { stop: () => Promise<void>; api: PromptAuditApi } = {
        stop: async () => {},
        api: undefined as unknown as PromptAuditApi,
    };
    const start = async () => {
        holder.stop = await env.start(promptAuditModule);
        holder.api = env.apis.get('promptAudit') as PromptAuditApi;
        await holder.api.ready();
    };
    await start();
    const result: AuditEnv = {
        env,
        get api() {
            return holder.api;
        },
        store,
        recorded,
        neighbours,
        setGlobal,
        setScoped,
        tools,
        loreContents,
        async generate(messages, type = 'normal') {
            await env.mock.eventSource.emit(EVENT_TYPES.GENERATION_STARTED ?? 'generation_started', type, {}, false);
            await env.mock.eventSource.emit(
                EVENT_TYPES.CHAT_COMPLETION_PROMPT_READY ?? 'chat_completion_prompt_ready',
                {
                    chat: messages,
                    dryRun: false,
                },
            );
            // Maestro's own injections are cleared after the generation: the capture must not depend on them now.
            (env.mock.context as unknown as Dict).extensionPrompts = {};
            await env.app.bus.emit('generation:ended', { type, stopped: false });
            await flush();
            await flush();
        },
        async restart() {
            await holder.stop();
            (env.app.chat as unknown as { clearCache?: () => void }).clearCache?.();
            await start();
        },
        stop: () => holder.stop(),
    } as AuditEnv;
    return result;
}

/** The slots of the real case at generation time. */
export function realCaseSlots(): Dict {
    const slot = (value: string, role = 0, depth = 0) => ({ value, position: 1, depth, scan: false, role });
    return {
        'dooms-tracker-inject': slot(TRACKER_TEXT, 1),
        'dooms-tracker-example': slot('```json\n{"old": true}\n```', 2, 1),
        nai_studio_markers: slot(MARKERS_TEXT),
        maestro_wardrobe: slot('Now wearing: Alice — a travel cloak.', 0, 1),
    };
}

/** The outgoing messages of the real case (the preset blocks first, the history, the in-chat inserts last). */
export function realCaseMessages(): Dict[] {
    return [
        { role: 'system', content: `${TASK_TEXT}\n\n${WORLD_TEXT}` },
        { role: 'assistant', content: 'Alice looks at the road.' },
        { role: 'user', content: 'I follow her.' },
        { role: 'system', content: 'Now wearing: Alice — a travel cloak.' },
        { role: 'user', content: TRACKER_TEXT },
        { role: 'system', content: MARKERS_TEXT },
    ];
}
