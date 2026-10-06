// Test doubles for core services: a Host over the ST mock, a recording logger, a fake Ui and a real I18n.
import { createI18n } from '../../src/core/i18n';
import { CORE_STRINGS } from '../../src/core/strings';
import type { Host, HostEvents, I18n, Logger, Ui, Unsubscribe } from '../../src/shared/contracts';
import { EVENT_TYPES } from './st-mock';
import type { StMock } from './st-mock';

export interface TestHost extends Host {
    /** Simulates a group chat. */
    group: boolean;
}

export function createTestHost(mock: StMock): TestHost {
    const resolve = (event: string) => EVENT_TYPES[event] ?? event;
    const events: HostEvents = {
        on(event, handler): Unsubscribe {
            const name = resolve(event);
            mock.eventSource.on(name, handler);
            return () => mock.eventSource.removeListener(name, handler);
        },
        reassertOrder() {},
        emit: (event, ...args) => mock.eventSource.emit(resolve(event), ...args),
        name: (key) => EVENT_TYPES[key],
    };
    const host: TestHost = {
        group: false,
        ctx: () => mock.context,
        events,
        modules: {
            worldInfo: async () => ({}),
            script: async () => ({}),
            openai: async () => ({}),
            presetManager: async () => ({}),
            chats: async () => ({}),
            regexEngine: async () => ({}),
            utils: async () => ({}),
            load: async () => ({}),
        },
        caps: { register() {}, has: () => true, report: () => [], refresh: async () => {} },
        fetchGate: { beforeRequest: () => () => {}, afterResponse: () => () => {} },
        version: () => '1.19.0',
        chatId: () => mock.chatId ?? null,
        isGroupChat: () => host.group,
        isChatCompletion: () => true,
    };
    return host;
}

/** Switches the mock to another chat the way ST does: new metadata object, then CHAT_CHANGED. */
export async function switchChat(
    mock: StMock,
    chatId: string | undefined,
    metadata: Record<string, unknown> = {},
): Promise<void> {
    mock.chatId = chatId;
    mock.chatMetadata = metadata;
    await mock.eventSource.emit(EVENT_TYPES.CHAT_CHANGED!, chatId);
}

export interface LogLineRecord {
    level: 'debug' | 'info' | 'warn' | 'error';
    args: unknown[];
}

export function createTestLogger(lines: LogLineRecord[] = []): Logger & { lines: LogLineRecord[] } {
    const make = (): Logger & { lines: LogLineRecord[] } => ({
        lines,
        debug: (...args) => void lines.push({ level: 'debug', args }),
        info: (...args) => void lines.push({ level: 'info', args }),
        warn: (...args) => void lines.push({ level: 'warn', args }),
        error: (...args) => void lines.push({ level: 'error', args }),
        scope: () => make(),
    });
    return make();
}

export interface FakeUi extends Ui {
    notices: { text: string; options?: Parameters<Ui['notice']>[1] }[];
    badges: { messageIndex: number; badge: Parameters<Ui['messageBadge']>[1]; removed: boolean }[];
    confirms: { title: string; body: string | HTMLElement }[];
    confirmOptions: ({ details?: string } | undefined)[];
    confirmAnswer: boolean;
}

export function createFakeUi(): FakeUi {
    const ui: FakeUi = {
        notices: [],
        badges: [],
        confirms: [],
        confirmOptions: [],
        confirmAnswer: true,
        addTab: () => () => {},
        addHealthCheck: () => () => {},
        addWizardStep: () => () => {},
        addSlashCommand: () => () => {},
        openPult() {},
        refresh() {},
        notice(text, options) {
            ui.notices.push({ text, options });
        },
        async confirm(title, body, options) {
            ui.confirms.push({ title, body });
            ui.confirmOptions.push(options);
            return ui.confirmAnswer;
        },
        messageBadge(messageIndex, badge) {
            const entry = { messageIndex, badge, removed: false };
            ui.badges.push(entry);
            return () => {
                entry.removed = true;
            };
        },
        style: () => () => {},
    };
    return ui;
}

export function createTestI18n(locale: 'ru' | 'en' = 'en'): I18n {
    const i18n = createI18n(() => locale);
    i18n.register(CORE_STRINGS);
    return i18n;
}

/** Parsed JSON of a user file written through the mock. */
export function storedJson<T = Record<string, unknown>>(mock: StMock, name: string): T | undefined {
    const text = mock.files.get(name);
    return text === undefined ? undefined : (JSON.parse(text) as T);
}

/** Lets pending promise chains (fetch mock, async handlers) settle without moving fake time. */
export async function settle(rounds = 20): Promise<void> {
    for (let i = 0; i < rounds; i++) await Promise.resolve();
}
