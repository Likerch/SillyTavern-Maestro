// Test environment for M32 «Стиль сообщений»: a minimal App with real i18n, an in-memory settings service with change
// notifications, a UI fake whose style() writes real <style data-maestro-style> nodes, a pult-tab recorder, an
// ephemeral fake, and a SillyTavern context with a chat, a `#chat` DOM and a message formatter that imitates ST's
// pipeline (Maestro's sample renderer → afterMarkdown hooks by order → DOMPurify's `custom-` class prefix).
import { createI18n } from '../../../src/core/i18n';
import type { Translations } from '../../../src/core/i18n';
import { sampleHtml } from '../../../src/domain/message-style-model';
import { messageStyleModule } from '../../../src/features/messageStyle';
import type { MessageStyleApi } from '../../../src/features/messageStyle';
import type {
    App,
    GenerationInfo,
    InjectionSpec,
    MaestroModule,
    PultTab,
    SettingsService,
    Ui,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { memoryLogger } from '../../helpers/host-fakes';
import type { MemoryLogger } from '../../helpers/host-fakes';

export interface FormatterHookRecord {
    fn: (mes: string, info: unknown) => string;
    options?: { stage?: string; order?: number };
}

export interface MessageStyleEnv {
    app: App;
    i18n: Translations;
    log: MemoryLogger;
    slices: Record<string, Record<string, unknown>>;
    notified: string[];
    saves: number;
    tabs: PultTab[];
    hooks: FormatterHookRecord[];
    producers: Map<string, (gen: GenerationInfo) => void | Promise<void>>;
    injections: { key: string; spec: InjectionSpec }[];
    chat: STChatMessage[];
    caps: Set<string>;
    confirmAnswer: boolean;
    confirms: string[];
    module: MaestroModule;
    running: boolean;
    start(): Promise<void>;
    stop(): Promise<void>;
    api(): MessageStyleApi;
    tab(): PultTab;
    /** ST's pipeline for one message: sample HTML, afterMarkdown hooks, sanitizer class prefix. */
    format(text: string, isUser: boolean, messageId?: number): string;
    /** Adds a rendered message to `#chat` (as ST would print it). */
    printMessage(text: string, isUser: boolean): HTMLElement;
    styleText(id: string): string | undefined;
    generate(gen?: Partial<GenerationInfo>): Promise<void>;
}

export interface MessageStyleEnvOptions {
    locale?: 'ru' | 'en';
    /** Offer messageFormatter (and its capability). */
    formatter?: boolean;
    /** Offer messageFormatter.format (ST 1.19 shim used by the preview). */
    format?: boolean;
}

function sanitizeClasses(html: string): string {
    return html.replace(
        /class="([^"]*)"/g,
        (_, value: string) =>
            `class="${value
                .split(' ')
                .filter(Boolean)
                .map((name) => (name.startsWith('custom-') ? name : `custom-${name}`))
                .join(' ')}"`,
    );
}

export function createMessageStyleEnv(options: MessageStyleEnvOptions = {}): MessageStyleEnv {
    const i18n = createI18n(() => options.locale ?? 'ru');
    const log = memoryLogger();
    const slices: Record<string, Record<string, unknown>> = {};
    const listeners = new Set<(path: string) => void>();
    const exposed = new Map<string, unknown>();
    const styles = new Map<string, HTMLStyleElement>();
    let disposers: (() => void | Promise<void>)[] = [];

    const settings = {
        module<T extends object>(key: string): T {
            slices[key] ??= {};
            return slices[key] as T;
        },
        onChange(listener: (path: string) => void): Unsubscribe {
            listeners.add(listener);
            return () => listeners.delete(listener);
        },
        notify(path: string) {
            env.notified.push(path);
            for (const listener of [...listeners]) listener(path);
        },
        save() {
            env.saves += 1;
        },
    } as unknown as SettingsService;

    const ui = {
        addTab(tab: PultTab): Unsubscribe {
            env.tabs.push(tab);
            return () => {
                env.tabs = env.tabs.filter((item) => item !== tab);
            };
        },
        style(id: string, css: string): Unsubscribe {
            let node = styles.get(id);
            if (!node || !node.isConnected) {
                node = document.createElement('style');
                node.setAttribute('data-maestro-style', id);
                document.head.appendChild(node);
                styles.set(id, node);
            }
            node.textContent = css;
            const owned = node;
            return () => {
                if (styles.get(id) !== owned) return;
                owned.remove();
                styles.delete(id);
            };
        },
        async confirm(title: string) {
            env.confirms.push(title);
            return env.confirmAnswer;
        },
        notice() {},
        refresh() {},
        openPult() {},
    } as unknown as Ui;

    const formatter: Record<string, unknown> = {
        addHook(fn: FormatterHookRecord['fn'], hookOptions?: FormatterHookRecord['options']) {
            env.hooks.push({ fn, options: hookOptions });
        },
    };
    if (options.format !== false) {
        formatter.format = (text: string, _name: string, _system: boolean, isUser: boolean, messageId: number) =>
            env.format(text, isUser, messageId);
    }

    const context = {
        get chat() {
            return env.chat;
        },
        ...(options.formatter === false ? {} : { messageFormatter: formatter }),
    };

    const ephemeral = {
        addProducer(name: string, producer: (gen: GenerationInfo) => void | Promise<void>): Unsubscribe {
            env.producers.set(name, producer);
            return () => {
                if (env.producers.get(name) === producer) env.producers.delete(name);
            };
        },
        setInjection(key: string, spec: InjectionSpec) {
            env.injections.push({ key, spec });
        },
    };

    const app = {
        i18n,
        log,
        settings,
        ui,
        ephemeral,
        host: {
            ctx: () => context as unknown as STContext,
            caps: { has: (id: string) => env.caps.has(id) },
            events: { on: () => () => {} },
        },
        modules: {
            expose(key: string, api: unknown) {
                exposed.set(key, api);
            },
            api<T>(key: string): T | undefined {
                return exposed.get(key) as T | undefined;
            },
        },
    } as unknown as App;

    const module = messageStyleModule as unknown as MaestroModule;
    if (module.i18n) i18n.register(module.i18n);

    const env: MessageStyleEnv = {
        app,
        i18n,
        log,
        slices,
        notified: [],
        saves: 0,
        tabs: [],
        hooks: [],
        producers: new Map(),
        injections: [],
        chat: [],
        caps: new Set(options.formatter === false ? [] : ['st.messageFormatter']),
        confirmAnswer: true,
        confirms: [],
        module,
        running: false,
        async start() {
            disposers = [];
            const slice = settings.module<object>(module.key);
            Object.assign(slice, { ...module.defaults(), ...slice });
            await module.init({ app, settings: slice, log, own: (off) => disposers.push(off) });
            env.running = true;
        },
        async stop() {
            for (const off of disposers.splice(0).reverse()) await off();
            env.running = false;
        },
        api: () => exposed.get('messageStyle') as MessageStyleApi,
        tab() {
            const tab = env.tabs.find((item) => item.id === 'messageStyle');
            if (!tab) throw new Error('no tab');
            return tab;
        },
        format(text: string, isUser: boolean, messageId = -1) {
            let html = sampleHtml(text);
            const sorted = env.hooks
                .filter((hook) => (hook.options?.stage ?? 'afterMarkdown') === 'afterMarkdown')
                .sort((a, b) => (a.options?.order ?? 50) - (b.options?.order ?? 50));
            for (const hook of sorted) {
                html = hook.fn(html, Object.freeze({ isUser, isSystem: false, messageId, stage: 'afterMarkdown' }));
            }
            return sanitizeClasses(html);
        },
        printMessage(text: string, isUser: boolean) {
            let chat = document.getElementById('chat');
            if (!chat) {
                chat = document.createElement('div');
                chat.id = 'chat';
                document.body.appendChild(chat);
            }
            const index = env.chat.length;
            env.chat.push({ name: isUser ? 'Я' : 'Мира', is_user: isUser, is_system: false, send_date: '', mes: text });
            const mes = document.createElement('div');
            mes.className = 'mes';
            mes.setAttribute('mesid', String(index));
            mes.setAttribute('is_user', String(isUser));
            const body = document.createElement('div');
            body.className = 'mes_text';
            body.innerHTML = env.format(text, isUser, index);
            mes.appendChild(body);
            chat.appendChild(mes);
            return body;
        },
        styleText: (id) => document.head.querySelector(`style[data-maestro-style="${id}"]`)?.textContent ?? undefined,
        async generate(gen = {}) {
            for (const producer of env.producers.values()) {
                await producer({ type: 'normal', dryRun: false, quiet: false, ...gen });
            }
        },
    };
    return env;
}

/** Resets the page between tests. */
export function resetPage(): void {
    document.documentElement.className = '';
    document.head.innerHTML = '';
    document.body.className = '';
    document.body.innerHTML = '';
}
