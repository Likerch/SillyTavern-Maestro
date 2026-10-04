// UI test environment: the ST mock plus Popup, slash-command and toastr fakes, a minimal Host over the mock's
// event source, real i18n/settings, and ST-like DOM containers (top bar, extensions panel, wand menu, chat).
import { vi } from 'vitest';
import type { Mock } from 'vitest';
import { createI18n } from '../../src/core/i18n';
import type { Translations } from '../../src/core/i18n';
import { Settings } from '../../src/core/settings';
import type { Capabilities, CapabilityReport, FetchGate, Host, HostModules, Logger } from '../../src/shared/contracts';
import { EVENT_TYPES, installStMock } from './st-mock';
import type { StMock } from './st-mock';

export const POPUP_TYPE = { TEXT: 1, CONFIRM: 2, INPUT: 3, DISPLAY: 4, CROP: 5 };
export const POPUP_RESULT = { AFFIRMATIVE: 1, NEGATIVE: 0, CANCELLED: null };

/** Stand-in for ST's Popup class: show() resolves when the popup is closed. */
export class FakePopup {
    static instances: FakePopup[] = [];
    readonly dlg: HTMLDialogElement;
    closed = false;
    private resolve: ((value: unknown) => void) | null = null;

    constructor(
        readonly content: string | HTMLElement,
        readonly type: number,
        readonly inputValue: string = '',
        readonly options: Record<string, unknown> = {},
    ) {
        this.dlg = document.createElement('dialog');
        this.dlg.className = 'popup';
        const body = document.createElement('div');
        body.className = 'popup-content';
        if (typeof content === 'string') body.textContent = content;
        else body.appendChild(content);
        this.dlg.appendChild(body);
        FakePopup.instances.push(this);
    }

    show(): Promise<unknown> {
        document.body.appendChild(this.dlg);
        return new Promise((resolve) => {
            this.resolve = resolve;
        });
    }

    async completeCancelled(): Promise<unknown> {
        this.close(null);
        return null;
    }

    /** Simulates Escape / the user closing the dialog. */
    close(result: unknown = null): void {
        if (this.closed) return;
        this.closed = true;
        this.dlg.remove();
        this.resolve?.(result);
    }

    static open(): FakePopup[] {
        return FakePopup.instances.filter((popup) => !popup.closed);
    }
}

export interface SlashProps {
    name: string;
    helpString: string;
    callback: (named: unknown, unnamed: unknown) => Promise<string>;
    unnamedArgumentList?: Record<string, unknown>[];
    namedArgumentList?: Record<string, unknown>[];
}

export interface UiTestEnv {
    mock: StMock;
    host: Host;
    i18n: Translations;
    settings: Settings;
    log: Logger;
    caps: Capabilities & { items: CapabilityReport[] };
    callGenericPopup: Mock<
        (content: unknown, type: number, input?: string, options?: Record<string, unknown>) => Promise<unknown>
    >;
    toastr: { info: Mock; success: Mock; warning: Mock; error: Mock; clear: Mock };
    slashCommands: Record<string, SlashProps>;
    addCommandObject: Mock<(command: unknown) => void>;
    executeSlash: Mock<(text: string, options?: Record<string, unknown>) => Promise<unknown>>;
    group: { value: boolean };
}

export const silentLog: Logger = {
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
    scope: () => silentLog,
};

export function fakeCaps(items: CapabilityReport[] = []): Capabilities & { items: CapabilityReport[] } {
    return {
        items,
        register: () => {},
        has: (id) => items.some((item) => item.id === id && item.ok),
        report: () => items,
        refresh: async () => {},
    };
}

export function installUiEnv(locale: 'ru' | 'en' = 'ru'): UiTestEnv {
    FakePopup.instances = [];
    const mock = installStMock();
    const context = mock.context as unknown as Record<string, unknown>;
    const callGenericPopup = vi.fn(async (): Promise<unknown> => POPUP_RESULT.AFFIRMATIVE);
    const slashCommands: Record<string, SlashProps> = {};
    const addCommandObject = vi.fn((command: unknown) => {
        const props = command as SlashProps;
        slashCommands[props.name] = props;
    });
    const executeSlash = vi.fn(async (): Promise<unknown> => ({}));
    Object.assign(context, {
        Popup: FakePopup,
        POPUP_TYPE,
        POPUP_RESULT,
        callGenericPopup,
        SlashCommandParser: { commands: slashCommands, addCommandObject },
        SlashCommand: { fromProps: (props: Record<string, unknown>) => props },
        SlashCommandArgument: { fromProps: (props: Record<string, unknown>) => ({ kind: 'unnamed', ...props }) },
        SlashCommandNamedArgument: { fromProps: (props: Record<string, unknown>) => ({ kind: 'named', ...props }) },
        ARGUMENT_TYPE: { STRING: 'string' },
        executeSlashCommandsWithOptions: executeSlash,
    });
    const toastr = { info: vi.fn(), success: vi.fn(), warning: vi.fn(), error: vi.fn(), clear: vi.fn() };
    (globalThis as unknown as { toastr: unknown }).toastr = toastr;

    const group = { value: false };
    const caps = fakeCaps();
    const raw = (event: string) => EVENT_TYPES[event] ?? event;
    const host: Host = {
        ctx: () => mock.context,
        events: {
            on(event, handler) {
                mock.eventSource.on(raw(event), handler);
                return () => mock.eventSource.removeListener(raw(event), handler);
            },
            reassertOrder: () => {},
            emit: (event, ...args) => mock.eventSource.emit(raw(event), ...args),
            name: (key) => EVENT_TYPES[key],
        },
        modules: {} as HostModules,
        caps,
        fetchGate: {} as FetchGate,
        version: () => '1.19.0',
        chatId: () => mock.chatId ?? null,
        isGroupChat: () => group.value,
        isChatCompletion: () => true,
    };
    const i18n = createI18n(() => locale);
    const settings = new Settings(
        () => mock.extensionSettings,
        () => {},
        silentLog,
    );
    return {
        mock,
        host,
        i18n,
        settings,
        log: silentLog,
        caps,
        callGenericPopup,
        toastr,
        slashCommands,
        addCommandObject,
        executeSlash,
        group,
    };
}

/** Minimal ST DOM: top bar with the extensions drawer, extensions panel, wand menu and a chat of `messages`. */
export function buildStDom(messages = 3, options: { withButtons?: boolean } = {}): void {
    const withButtons = options.withButtons ?? true;
    const chat = Array.from({ length: messages }, (_, index) => {
        const buttons = withButtons ? '<div class="mes_buttons"><div class="mes_button mes_edit"></div></div>' : '';
        return `<div class="mes" mesid="${index}"><div class="mes_block"><div class="ch_name">${buttons}</div><div class="mes_text">text ${index}</div></div></div>`;
    }).join('');
    document.body.innerHTML = `
        <div id="top-settings-holder">
            <div id="ai-config-button" class="drawer"></div>
            <div id="extensions-settings-button" class="drawer"></div>
            <div id="persona-management-button" class="drawer"></div>
        </div>
        <div id="extensions_settings2"></div>
        <div id="extensionsMenu"></div>
        <div id="chat">${chat}</div>`;
}

/** Re-renders one message like ST does after an edit (the node is replaced, our badge is gone). */
export function rerenderMessage(index: number): void {
    const old = document.querySelector(`#chat .mes[mesid="${index}"]`);
    if (!old) return;
    const fresh = document.createElement('div');
    fresh.className = 'mes';
    fresh.setAttribute('mesid', String(index));
    fresh.innerHTML =
        '<div class="mes_block"><div class="ch_name"><div class="mes_buttons"></div></div><div class="mes_text">edited</div></div>';
    old.replaceWith(fresh);
}
