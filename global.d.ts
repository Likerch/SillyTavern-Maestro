// Minimal typing of the SillyTavern 1.19 host API used by Maestro (based on NAI Studio's typing).
// Only what we call is declared; everything comes from SillyTavern.getContext() / SillyTavern.libs.

export {};

declare global {
    interface STEventSource {
        on(event: string, listener: (...args: unknown[]) => unknown): void;
        /** Puts the listener before the others (ST 1.12+, public/lib/eventemitter.js). */
        makeFirst?(event: string, listener: (...args: unknown[]) => unknown): void;
        removeListener(event: string, listener: (...args: unknown[]) => unknown): void;
        emit(event: string, ...args: unknown[]): Promise<void>;
    }

    interface STMediaAttachment {
        url: string;
        type: 'image' | 'video' | 'audio';
        title?: string;
        source?: 'api' | 'upload' | 'generated' | 'captioned';
        width?: number;
        height?: number;
    }

    interface STChatMessage {
        name: string;
        is_user: boolean;
        is_system: boolean;
        send_date: string;
        mes: string;
        extra?: Record<string, unknown> & {
            media?: STMediaAttachment[];
            media_display?: 'list' | 'gallery';
            media_index?: number;
            inline_image?: boolean;
        };
        [key: string]: unknown;
    }

    interface STCharacter {
        name: string;
        avatar: string;
        data?: { extensions?: Record<string, unknown> };
        description?: string;
        personality?: string;
        first_mes?: string;
        scenario?: string;
        shallow?: boolean;
    }

    interface STGroup {
        id: string;
        name: string;
        members: string[];
    }

    interface STSlashCommandStatic {
        fromProps(props: Record<string, unknown>): unknown;
    }

    interface STSlashCommandArgStatic {
        fromProps(props: Record<string, unknown>): unknown;
    }

    interface STMessageFormattingInfo {
        messageId: number;
        isSystem: boolean;
        isUser: boolean;
        characterName?: string;
        stage: string;
    }

    interface STLoaderHandle {
        hide(): Promise<void>;
    }

    interface STToolDefinition {
        name: string;
        displayName?: string;
        description: string;
        parameters: Record<string, unknown>;
        action: (args: Record<string, unknown>) => Promise<unknown>;
        formatMessage?: (args: Record<string, unknown>) => string;
        shouldRegister?: () => boolean | Promise<boolean>;
        stealth?: boolean;
    }

    interface STPopupStatic {
        new (
            content: string | HTMLElement,
            type: number,
            inputValue?: string,
            options?: Record<string, unknown>,
        ): {
            show(): Promise<unknown>;
            /** Closes the popup and resolves show() (closing the dialog element directly leaves it pending). */
            completeCancelled(): Promise<unknown>;
            dlg: HTMLDialogElement;
        };
    }

    interface STContext {
        chat: STChatMessage[];
        characters: STCharacter[];
        tags?: { id: string; name: string }[];
        characterId: string | number | undefined;
        groupId: string | null;
        name1: string;
        name2: string;
        chatId?: string;
        extensionSettings: Record<string, unknown>;
        saveSettingsDebounced(): void;
        chatMetadata: Record<string, unknown>;
        /** Current main API: openai (Chat Completion), textgenerationwebui, novel, kobold, koboldhorde. */
        mainApi: string;
        saveMetadata(): Promise<void>;
        eventSource: STEventSource;
        eventTypes: Record<string, string>;
        getRequestHeaders(options?: { omitContentType?: boolean }): Record<string, string>;
        addOneMessage(message: STChatMessage, options?: Record<string, unknown>): void;
        saveChat(): Promise<void>;
        getCurrentChatId(): string | undefined;
        callGenericPopup(
            content: string | HTMLElement,
            type: number,
            inputValue?: string,
            options?: Record<string, unknown>,
        ): Promise<unknown>;
        Popup: STPopupStatic;
        POPUP_TYPE: { TEXT: number; CONFIRM: number; INPUT: number; DISPLAY: number; CROP?: number };
        POPUP_RESULT: { AFFIRMATIVE: number; NEGATIVE: number; CANCELLED: null };
        translate(text: string, key?: string | null): string;
        getCurrentLocale(): string;
        uuidv4(): string;
        humanizedDateTime(timestamp?: number): string;
        substituteParams(content: string): string;
        substituteParamsExtended(content: string, additionalMacro?: Record<string, unknown>): string;
        getThumbnailUrl(type: string, file: string): string;
        isMobile(): boolean;
        groups: STGroup[];
        powerUserSettings: Record<string, unknown>;
        accountStorage: { getItem(key: string): string | null; setItem(key: string, value: string): void };
        writeExtensionField(characterId: number | string, key: string, value: unknown): Promise<void>;
        unshallowCharacter(characterId: number | string): Promise<void>;
        appendMediaToMessage(message: STChatMessage, element: unknown, scrollBehavior?: string): void;
        updateMessageBlock(messageId: number, message: STChatMessage, options?: { rerenderMessage?: boolean }): void;
        messageFormatter: {
            addHook(
                hook: (mes: string, info: STMessageFormattingInfo) => string,
                options?: { stage?: 'beforeRegex' | 'afterRegex' | 'afterMarkdown'; order?: number },
            ): void;
        };
        generateRaw(options: Record<string, unknown>): Promise<string>;
        /** Extension prompt slot (position 1 = in chat at depth; role 0 system, 1 user, 2 assistant). */
        setExtensionPrompt(
            key: string,
            value: string,
            position: number,
            depth: number,
            scan?: boolean,
            role?: number,
            filter?: (() => boolean | Promise<boolean>) | null,
        ): void;
        /** Background requests through a saved connection profile (ST 1.19, extensions/shared.js). */
        ConnectionManagerRequestService: {
            sendRequest(
                profileId: string,
                prompt: string | { role: string; content: string }[],
                maxTokens: number,
                custom?: Record<string, unknown>,
                overridePayload?: Record<string, unknown>,
            ): Promise<unknown>;
            getProfile(profileId: string): Record<string, unknown> | undefined;
            validateProfile(profile: Record<string, unknown> | undefined): { selected: string };
            getSupportedProfiles(): { id: string; name: string }[];
        };
        getTokenCountAsync(text: string, padding?: number): Promise<number>;
        /** Manifest ST fetched at startup for an installed extension ('third-party/<folder>'). */
        getExtensionManifest?(name: string): unknown;
        getWorldInfoNames?(): string[];
        loadWorldInfo?(name: string): Promise<unknown>;
        saveWorldInfo?(name: string, data: unknown, immediately?: boolean): Promise<void>;
        reloadWorldInfoEditor?(name: string, loadIfNotSelected?: boolean): void;
        updateWorldInfoList?(): Promise<void>;
        getWorldInfoPrompt?(
            chat: string[],
            maxContext: number,
            isDryRun: boolean,
            globalScanData?: unknown,
        ): Promise<unknown>;
        /** Live Chat Completion settings (oai_settings). */
        chatCompletionSettings?: Record<string, unknown>;
        extensionPrompts?: Record<
            string,
            { value: string; position: number; depth: number; scan: boolean; role: number }
        >;
        variables?: {
            local: { get(name: string): unknown; set(name: string, value: unknown): void };
            global: { get(name: string): unknown; set(name: string, value: unknown): void };
        };
        generateQuietPrompt(options: { quietPrompt: string; [key: string]: unknown }): Promise<string>;
        executeSlashCommandsWithOptions(text: string, options?: Record<string, unknown>): Promise<unknown>;
        SlashCommandParser: { addCommandObject(command: unknown): void; commands: Record<string, unknown> };
        SlashCommand: STSlashCommandStatic;
        SlashCommandArgument: STSlashCommandArgStatic;
        SlashCommandNamedArgument: STSlashCommandArgStatic;
        ARGUMENT_TYPE: Record<string, string>;
        registerFunctionTool(tool: STToolDefinition): void;
        unregisterFunctionTool(name: string): void;
        isToolCallingSupported(): boolean;
        macros?: { register(name: string, options: Record<string, unknown>): void; category?: Record<string, string> };
        registerMacro?(name: string, handler: () => string, description?: string): void;
        loader?: {
            show(options: {
                blocking?: boolean;
                slug?: string;
                title?: string;
                message?: string;
                onStop?: () => void;
            }): STLoaderHandle;
        };
    }

    interface STLibs {
        lodash: typeof import('lodash');
        localforage: {
            createInstance(options: { name: string; storeName?: string }): STLocalForage;
        };
        DOMPurify: { sanitize(dirty: string, config?: Record<string, unknown>): string };
        Handlebars: { compile(template: string): (data: unknown) => string };
        moment: (input?: unknown) => { format(fmt?: string): string; fromNow(): string };
        Popper: {
            createPopper(
                reference: Element,
                popper: HTMLElement,
                options?: Record<string, unknown>,
            ): { update(): Promise<unknown> };
        };
    }

    interface STLocalForage {
        getItem<T>(key: string): Promise<T | null>;
        setItem<T>(key: string, value: T): Promise<T>;
        removeItem(key: string): Promise<void>;
        keys(): Promise<string[]>;
        clear(): Promise<void>;
    }

    interface Window {
        SillyTavern: {
            getContext(): STContext;
            libs: STLibs;
        };
    }

    var SillyTavern: Window['SillyTavern'];
    var jQuery: (selector: string | Element) => { length: number; get(index: number): HTMLElement | undefined };
    var toastr: {
        success(message: string, title?: string, options?: Record<string, unknown>): void;
        info(message: string, title?: string, options?: Record<string, unknown>): void;
        warning(message: string, title?: string, options?: Record<string, unknown>): void;
        error(message: string, title?: string, options?: Record<string, unknown>): void;
        clear(toast?: unknown): void;
    };
}
