// A test App for M43 «Сцена и вокруг»: the rules test app (real settings, fake turn hooks with the interceptor, fake
// modules, recording UI, recorded formatter hooks) plus the real ephemeral injections, a regex engine that imitates
// DES's «Clean HTML (From Outgoing Prompt)», DES and DES-RU adapters, a world model, a `#chat` DOM with ST's
// updateMessageBlock, and a formatter pipeline that runs the hooks by stage and order like ST 1.19 (Markdown and
// DOMPurify imitated: paragraphs, unknown tags dropped with their words kept, classes prefixed `custom-`).
import { createEphemeral } from '../../../src/core/ephemeral';
import { createI18n } from '../../../src/core/i18n';
import { CORE_STRINGS } from '../../../src/core/strings';
import type { EphemeralRunner } from '../../../src/core/turn';
import { sceneSplitModule, SCENE_SPLIT_KEY, SCENE_SPLIT_STRINGS } from '../../../src/features/sceneSplit';
import type { SceneSplitApi, SceneSplitService, SceneSplitSettings } from '../../../src/features/sceneSplit';
import type { Entity, WorldModelApi } from '../../../src/features/world/api';
import type { GenerationInfo, SettingsSection, Unsubscribe } from '../../../src/shared/contracts';
import { createRulesTestApp } from '../../helpers/rules-app';
import type { FormatterHook, RulesTestApp } from '../../helpers/rules-app';
import { EVENT_TYPES, message } from '../../helpers/st-mock';

export interface Slot {
    value: string;
    position: number;
    depth: number;
    role: number;
}

export interface SceneSplitEnv extends RulesTestApp {
    ephemeral: EphemeralRunner;
    slots: Map<string, Slot>;
    /** Slots set during the last generation, before they were cleared. */
    injected: Map<string, Slot>;
    sections: SettingsSection[];
    rendered: number[];
    updated: number[];
    des: { removed: string[] };
    world: Map<string, Entity>;
    regexRuns: number;
    disposers: (Unsubscribe | (() => void | Promise<void>))[];
    start(): Promise<SceneSplitService>;
    stop(): Promise<void>;
    api(): SceneSplitApi | undefined;
    slice(): SceneSplitSettings;
    set(path: keyof SceneSplitSettings, value: unknown): void;
    generate(info?: Partial<GenerationInfo>): Promise<Map<string, Slot>>;
    format(text: string, isUser?: boolean): string;
    /** Prints the chat into `#chat` with the current hooks. */
    print(): void;
    textOf(index: number): HTMLElement;
}

const STAGES = ['beforeRegex', 'afterRegex', 'afterMarkdown'];

/** DES's «Clean HTML (From Outgoing Prompt)»: every tag goes, with one whitespace before it. */
export function cleanHtml(text: string): string {
    return text.replace(/\s?<(?!!--)(?:"[^"]*"|'[^']*'|[^'">])*>/g, '');
}

function markdown(text: string): string {
    return text
        .split(/\n{2,}/)
        .map((part) => part.trim())
        .filter(Boolean)
        .map((part) => `<p>${part.replace(/\n/g, '<br>')}</p>`)
        .join('\n');
}

const KNOWN = new Set(['p', 'br', 'em', 'q', 'i', 'b', 'strong', 'div', 'details', 'summary', 'span', 'font']);

/** DOMPurify as ST configures it: unknown elements dropped (their words kept), classes prefixed. */
function sanitize(html: string): string {
    return html
        .replace(/<\/?([A-Za-z][\w-]*)\b[^<>]*>/g, (tag, name: string) => (KNOWN.has(name.toLowerCase()) ? tag : ''))
        .replace(
            /class="([^"]*)"/g,
            (_, value: string) =>
                `class="${value
                    .split(' ')
                    .filter(Boolean)
                    .map((item) => (item.startsWith('custom-') ? item : `custom-${item}`))
                    .join(' ')}"`,
        );
}

export function reply(text: string, characters?: string[]): STChatMessage {
    const extra: Record<string, unknown> = {};
    if (characters) {
        extra.dooms_tracker_swipes = [
            { characterThoughts: JSON.stringify(characters.map((name) => ({ name }))), quests: null, infoBox: null },
        ];
    }
    return message(text, { name: 'Рассказчик', extra, send_date: `d-${Math.random().toString(36).slice(2)}` });
}

export function said(text: string): STChatMessage {
    return message(text, { is_user: true, name: 'Кай', send_date: `d-${Math.random().toString(36).slice(2)}` });
}

/** ST's coreChat for a generation: non-system messages, prompt regexes applied, `index` added. */
export function coreChat(chat: readonly STChatMessage[], regex: (text: string) => string = cleanHtml): STChatMessage[] {
    return chat
        .filter((item) => !item.is_system)
        .map((item, index) => ({ ...item, mes: item.is_user ? item.mes : regex(item.mes), index }) as STChatMessage);
}

function entity(name: string, forms: string[] = [], kind: Entity['kind'] = 'character'): Entity {
    return { id: `${kind}:${name.toLowerCase()}`, kind, name, aliases: [], forms, sources: [] };
}

export async function createSceneSplitEnv(locale: 'ru' | 'en' = 'ru'): Promise<SceneSplitEnv> {
    const base = createRulesTestApp({ firstRunDone: true });
    base.settings.registerModule(SCENE_SPLIT_KEY, sceneSplitModule.defaults as () => object, true);
    const i18n = createI18n(() => locale);
    i18n.register(CORE_STRINGS);
    i18n.register(SCENE_SPLIT_STRINGS);
    (base.app as { i18n: unknown }).i18n = i18n;
    const context = base.mock.context as unknown as Record<string, unknown>;
    context.name1 = 'Кай';
    // Like ST's MessageFormatter, addHook needs its object: the hooks live in a private field of `this`.
    const formatter = {
        addHook(this: unknown, fn: FormatterHook['fn'], options?: FormatterHook['options']) {
            if (this !== formatter) throw new TypeError('Cannot read private member #hooks');
            base.hooks.push({ fn, options });
        },
    };
    context.messageFormatter = formatter;

    const env = base as SceneSplitEnv;
    env.slots = new Map();
    env.injected = new Map();
    env.sections = [];
    env.rendered = [];
    env.updated = [];
    env.des = { removed: [] };
    env.regexRuns = 0;
    env.disposers = [];
    env.world = new Map([
        ['вера', entity('Вера', ['Вера', 'Веры', 'Вере', 'Веру', 'Верой'])],
        ['мартин', entity('Мартин', ['Мартин', 'Мартина', 'Мартину', 'Мартином'])],
        ['кай', entity('Кай', [], 'persona')],
    ]);

    context.setExtensionPrompt = (
        key: string,
        value: string,
        position: number,
        depth: number,
        _s: boolean,
        role: number,
    ) => {
        if (value) {
            env.slots.set(key, { value, position, depth, role });
            env.injected.set(key, { value, position, depth, role });
        } else env.slots.delete(key);
    };
    env.ephemeral = createEphemeral({ host: base.host, log: base.log });
    (base.app as { ephemeral: unknown }).ephemeral = env.ephemeral;

    base.host.modules.regexEngine = async () => ({
        getRegexedString: (text: string) => {
            env.regexRuns++;
            return cleanHtml(text);
        },
        getRegexScripts: () => [{ id: 'clean', findRegex: '/x/', minDepth: null, maxDepth: null }],
    });
    base.caps.add('st.regex');

    Object.assign(base.app.adapters.des as unknown as Record<string, unknown>, {
        removedCharacters: () => env.des.removed,
    });
    Object.assign(base.app.adapters.desru as unknown as Record<string, unknown>, { api: () => undefined });
    const world: Partial<WorldModelApi> = {
        resolve: (name: string, kind?: string) => {
            const found = env.world.get(name.trim().toLowerCase());
            return found && (!kind || found.kind === kind) ? found : undefined;
        },
    };
    base.modules.expose('world', world);

    (base.ui as unknown as { addSettingsSection(section: SettingsSection): Unsubscribe }).addSettingsSection = (
        section,
    ) => {
        env.sections.push(section);
        return () => {
            env.sections = env.sections.filter((item) => item !== section);
        };
    };

    context.updateMessageBlock = (index: number, item: STChatMessage) => {
        env.rendered.push(index);
        const node = document.querySelector(`#chat .mes[mesid="${index}"] .mes_text`);
        if (node) node.innerHTML = env.format(item.mes, item.is_user);
    };
    base.mock.eventSource.on(EVENT_TYPES.MESSAGE_UPDATED!, (index: unknown) => {
        env.updated.push(Number(index));
    });

    env.format = (text: string, isUser = false) => {
        let mes = text;
        const run = (stage: string) => {
            const hooks = env.hooks
                .filter((hook) => (hook.options?.stage ?? 'afterMarkdown') === stage)
                .sort((a, b) => (a.options?.order ?? 50) - (b.options?.order ?? 50));
            for (const hook of hooks) {
                mes = hook.fn(
                    mes,
                    Object.freeze({ isUser, isSystem: false, isReasoning: false, messageId: 0, stage }) as never,
                );
            }
        };
        run(STAGES[0]!);
        run(STAGES[1]!);
        mes = markdown(mes);
        run(STAGES[2]!);
        return sanitize(mes);
    };
    env.print = () => {
        let root = document.getElementById('chat');
        if (!root) {
            root = document.createElement('div');
            root.id = 'chat';
            document.body.appendChild(root);
        }
        root.innerHTML = '';
        base.mock.chat.forEach((item, index) => {
            const node = document.createElement('div');
            node.className = 'mes';
            node.setAttribute('mesid', String(index));
            node.setAttribute('is_user', String(item.is_user));
            const text = document.createElement('div');
            text.className = 'mes_text';
            text.innerHTML = env.format(item.mes, item.is_user);
            node.appendChild(text);
            root.appendChild(node);
        });
    };
    env.textOf = (index) => {
        const node = document.querySelector<HTMLElement>(`#chat .mes[mesid="${index}"] .mes_text`);
        if (!node) throw new Error(`no message ${index}`);
        return node;
    };

    env.start = async () => {
        await sceneSplitModule.init({
            app: base.app,
            settings: base.settings.module(SCENE_SPLIT_KEY) as SceneSplitSettings,
            log: base.log,
            own: (dispose) => env.disposers.push(dispose),
        });
        return env.api() as SceneSplitService;
    };
    env.stop = async () => {
        for (const dispose of env.disposers.splice(0).reverse()) await dispose();
        base.modules.apis.delete(SCENE_SPLIT_KEY);
    };
    env.api = () => base.modules.api<SceneSplitApi>(SCENE_SPLIT_KEY);
    env.slice = () => base.settings.module(SCENE_SPLIT_KEY) as SceneSplitSettings;
    env.set = (path, value) => {
        (env.slice() as unknown as Record<string, unknown>)[path] = value;
        base.settings.notify(`modules.${SCENE_SPLIT_KEY}.${path}`);
    };
    env.generate = async (info = {}) => {
        const full: GenerationInfo = { type: 'normal', dryRun: false, quiet: false, ...info };
        env.injected = new Map();
        await env.ephemeral.run(full);
        const seen = env.injected;
        env.ephemeral.clearAll();
        return seen;
    };
    return env;
}
