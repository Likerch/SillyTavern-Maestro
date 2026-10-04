// A small fake of SillyTavern 1.19 for integration tests. Install with installStMock(); every test file gets
// a fresh instance. Extend through the returned object (chat, metadata, settings, files, requests).

type Listener = (...args: unknown[]) => unknown;

export class FakeEventSource {
    readonly events = new Map<string, Listener[]>();

    on(event: string, listener: Listener): void {
        this.list(event).push(listener);
    }

    makeFirst(event: string, listener: Listener): void {
        this.list(event).unshift(listener);
    }

    makeLast(event: string, listener: Listener): void {
        const list = this.list(event);
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
        list.push(listener);
    }

    removeListener(event: string, listener: Listener): void {
        const list = this.list(event);
        const index = list.indexOf(listener);
        if (index >= 0) list.splice(index, 1);
    }

    async emit(event: string, ...args: unknown[]): Promise<void> {
        for (const listener of [...this.list(event)]) {
            try {
                await listener(...args);
            } catch {
                // ST swallows listener errors (public/lib/eventemitter.js).
            }
        }
    }

    private list(event: string): Listener[] {
        let list = this.events.get(event);
        if (!list) {
            list = [];
            this.events.set(event, list);
        }
        return list;
    }
}

export const EVENT_TYPES: Record<string, string> = {
    APP_READY: 'app_ready',
    CHAT_CHANGED: 'chat_id_changed',
    MESSAGE_SENT: 'message_sent',
    MESSAGE_RECEIVED: 'message_received',
    MESSAGE_EDITED: 'message_edited',
    MESSAGE_DELETED: 'message_deleted',
    MESSAGE_SWIPED: 'message_swiped',
    CHARACTER_MESSAGE_RENDERED: 'character_message_rendered',
    USER_MESSAGE_RENDERED: 'user_message_rendered',
    GENERATION_STARTED: 'generation_started',
    GENERATION_AFTER_COMMANDS: 'GENERATION_AFTER_COMMANDS',
    GENERATION_STOPPED: 'generation_stopped',
    GENERATION_ENDED: 'generation_ended',
    GENERATE_AFTER_DATA: 'GENERATE_AFTER_DATA',
    MORE_MESSAGES_LOADED: 'more_messages_loaded',
    MESSAGE_UPDATED: 'message_updated',
    SETTINGS_UPDATED: 'settings_updated',
    WORLDINFO_UPDATED: 'worldinfo_updated',
    WORLDINFO_SETTINGS_UPDATED: 'worldinfo_settings_updated',
    WORLDINFO_ENTRIES_LOADED: 'worldinfo_entries_loaded',
    WORLDINFO_SCAN_DONE: 'worldinfo_scan_done',
    WORLD_INFO_ACTIVATED: 'world_info_activated',
    WORLDINFO_FORCE_ACTIVATE: 'worldinfo_force_activate',
    CHAT_COMPLETION_PROMPT_READY: 'chat_completion_prompt_ready',
    CHAT_COMPLETION_SETTINGS_READY: 'chat_completion_settings_ready',
    OAI_PRESET_CHANGED_BEFORE: 'oai_preset_changed_before',
    OAI_PRESET_CHANGED_AFTER: 'oai_preset_changed_after',
};

export interface StMock {
    context: STContext;
    eventSource: FakeEventSource;
    chat: STChatMessage[];
    chatMetadata: Record<string, unknown>;
    extensionSettings: Record<string, unknown>;
    /** User files written through /api/files/upload, by name (decoded JSON text). */
    files: Map<string, string>;
    /** Every fetch made through the mock, newest last. */
    requests: { url: string; init?: RequestInit }[];
    chatId: string | undefined;
    saveSettingsCalls: number;
    sendRequest: (
        profileId: string,
        prompt: unknown,
        maxTokens: number,
        custom?: unknown,
        override?: unknown,
    ) => Promise<unknown>;
}

export function message(text: string, options: Partial<STChatMessage> = {}): STChatMessage {
    return {
        name: options.is_user ? 'User' : 'Char',
        is_user: false,
        is_system: false,
        send_date: '',
        mes: text,
        extra: {},
        ...options,
    };
}

/** Installs globalThis.SillyTavern, toastr and fetch fakes. Returns handles to drive the fake. */
export function installStMock(): StMock {
    const eventSource = new FakeEventSource();
    const mock = {
        eventSource,
        chat: [] as STChatMessage[],
        chatMetadata: {} as Record<string, unknown>,
        extensionSettings: {} as Record<string, unknown>,
        files: new Map<string, string>(),
        requests: [] as { url: string; init?: RequestInit }[],
        chatId: 'chat-1' as string | undefined,
        saveSettingsCalls: 0,
        sendRequest: async () => ({ content: '{}' }),
    } as unknown as StMock;

    const context = {
        get chat() {
            return mock.chat;
        },
        get chatMetadata() {
            return mock.chatMetadata;
        },
        get extensionSettings() {
            return mock.extensionSettings;
        },
        characters: [],
        characterId: 0,
        groupId: null,
        groups: [],
        name1: 'User',
        name2: 'Char',
        mainApi: 'openai',
        eventSource,
        eventTypes: EVENT_TYPES,
        saveSettingsDebounced: () => {
            mock.saveSettingsCalls++;
        },
        saveMetadata: async () => {},
        saveChat: async () => {},
        getCurrentChatId: () => mock.chatId,
        getRequestHeaders: () => ({ 'Content-Type': 'application/json' }),
        getCurrentLocale: () => 'ru-ru',
        translate: (text: string) => text,
        substituteParams: (text: string) => text,
        getTokenCountAsync: async (text: string) => Math.ceil(text.length / 4),
        uuidv4: () => Math.random().toString(36).slice(2),
        isMobile: () => false,
        powerUserSettings: {},
        setExtensionPrompt: () => {},
        ConnectionManagerRequestService: {
            sendRequest: (...args: Parameters<StMock['sendRequest']>) => mock.sendRequest(...args),
            getProfile: (id: string) => ({ id, name: id, api: 'openai' }),
            validateProfile: () => ({ selected: 'openai' }),
            getSupportedProfiles: () => [{ id: 'p1', name: 'Profile 1' }],
        },
    } as unknown as STContext;
    mock.context = context;

    (globalThis as unknown as { SillyTavern: unknown }).SillyTavern = {
        getContext: () => context,
        libs: {},
    };
    (globalThis as unknown as { toastr: unknown }).toastr = {
        success: () => {},
        info: () => {},
        warning: () => {},
        error: () => {},
        clear: () => {},
    };

    const fakeFetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        mock.requests.push({ url, init });
        if (url.includes('/api/files/upload')) {
            const body = JSON.parse(String(init?.body ?? '{}')) as { name: string; data: string };
            mock.files.set(body.name, Buffer.from(body.data, 'base64').toString('utf8'));
            return new Response(JSON.stringify({ path: `/user/files/${body.name}` }), { status: 200 });
        }
        if (url.includes('/api/files/delete')) {
            const body = JSON.parse(String(init?.body ?? '{}')) as { path: string };
            mock.files.delete(body.path.replace(/^.*\//, ''));
            return new Response('{}', { status: 200 });
        }
        const fileMatch = url.match(/\/user\/files\/([^?]+)/);
        if (fileMatch?.[1]) {
            const text = mock.files.get(decodeURIComponent(fileMatch[1]));
            return text === undefined
                ? new Response('not found', { status: 404 })
                : new Response(text, { status: 200 });
        }
        return new Response('{}', { status: 200 });
    };
    (globalThis as unknown as { fetch: unknown }).fetch = fakeFetch;

    return mock;
}
