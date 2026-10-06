// Dock test page: ST's extension columns with fake settings blocks of every neighbour (ids and structure as in their
// sources), DES's portrait bar above #send_form, and the real Maestro UI (pult, settings) over the UI test env. The
// app has fake adapters (presence flags, CK's `kernel()`), and the dock module is started like the module manager does.
import { vi } from 'vitest';
import { dockModule } from '../../../src/features/dock';
import type { DockApi, DockSettings } from '../../../src/features/dock';
import type { App, NeighbourAdapter } from '../../../src/shared/contracts';
import { createUi } from '../../../src/ui';
import type { UiImpl } from '../../../src/ui';
import { installUiEnv, resetWindowLayout } from '../../helpers/ui-env';
import type { UiTestEnv } from '../../helpers/ui-env';

export const PAGE = `
<div id="top-settings-holder"><div id="extensions-settings-button" class="drawer"></div></div>
<div id="rm_extensions_block" class="extensions_block">
    <div id="extensions_settings">
        <div id="left_first"></div>
        <div id="carrot_settings" class="carrot-extension-settings">
            <div class="inline-drawer">
                <div class="inline-drawer-toggle inline-drawer-header"><b>CarrotKernel</b>
                    <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
                <div class="inline-drawer-content">
                    <div class="carrot-status-panel carrot-status-repository"></div>
                    <div id="carrot-main-lorebook-popout-btn"></div>
                    <div id="carrot-popup-overlay"></div>
                </div>
            </div>
        </div>
        <div id="left_last"></div>
    </div>
    <div id="extensions_settings2">
        <div id="right_first"></div>
        <div id="qvink_memory_settings" class="qvink_memory_settings_content">
            <div class="inline-drawer"><div class="inline-drawer-toggle inline-drawer-header">
                <i id="qvink_popout_button" class="fa-solid fa-window-restore menu_button"></i></div>
                <div class="inline-drawer-content"><div class="qvink_memory_settings_content">
                    <button id="edit_memory_state" class="settings_input">Edit</button></div></div></div>
        </div>
        <div class="naist-panel" id="naist_panel"><div class="inline-drawer"><div class="inline-drawer-content">
            <button id="naist_img_open_gallery"></button><button id="naist_open_composer"></button></div></div></div>
        <div id="desru-settings" class="desru-settings"><div class="inline-drawer"></div></div>
        <div class="lorebook-localizer-settings"><div class="inline-drawer">
            <div class="menu_button lbl-open"></div></div></div>
        <div><div class="inline-drawer"><div class="inline-drawer-content">
            <input type="checkbox" id="rpg-extension-enabled"><button id="dooms-open-settings-btn"></button>
        </div></div></div>
        <div id="right_last"></div>
    </div>
</div>
<div id="extensionsMenu"></div>
<div id="sheld">
    <div id="chat"></div>
    <div id="form_sheld">
        <div id="dooms-portrait-bar-wrapper" class="dooms-pb-position-left"><button id="dooms-pb-open-roster"></button></div>
        <div id="dooms-pb-context-menu"></div>
        <form id="send_form"></form>
    </div>
</div>`;

export type NeighbourPresence = Record<NeighbourAdapter['id'], boolean>;

export interface DockEnv {
    env: UiTestEnv;
    ui: UiImpl;
    app: App;
    presence: NeighbourPresence;
    kernel: Record<string, unknown>;
    neighbourSettings: Record<string, unknown>;
    settings(): DockSettings;
    api(): DockApi;
    stop(): Promise<void>;
}

/** Element children of a node (text nodes skipped), as ids/markers: the page layout to compare before and after. */
export function layout(selector: string): string[] {
    const root = document.querySelector(selector);
    if (!root) return [];
    return [...root.childNodes]
        .filter((node) => node.nodeType !== Node.TEXT_NODE)
        .map((node) => {
            if (node.nodeType === Node.COMMENT_NODE) return '#comment';
            const element = node as HTMLElement;
            if (element.id) return element.id;
            return element.className ? `.${element.className.split(' ')[0] ?? ''}` : element.tagName.toLowerCase();
        });
}

export function snapshot(): Record<string, string[]> {
    return {
        left: layout('#extensions_settings'),
        right: layout('#extensions_settings2'),
        form: layout('#form_sheld'),
    };
}

export const desBlock = () =>
    document.getElementById('rpg-extension-enabled')?.closest('.inline-drawer')?.parentElement;

export async function startDock(options: { presence?: Partial<NeighbourPresence> } = {}): Promise<DockEnv> {
    document.body.innerHTML = PAGE;
    resetWindowLayout();
    const env = installUiEnv('ru');
    env.settings.core().firstRunDone = true;
    const ui = createUi({ host: env.host, i18n: env.i18n, settings: env.settings, log: env.log });
    ui.mount();
    const presence: NeighbourPresence = {
        des: true,
        desru: true,
        ck: true,
        qvink: true,
        nai: true,
        localizer: true,
        bunnymo: false,
        preset: false,
        ...options.presence,
    };
    const kernel: Record<string, unknown> = {
        openRepositoryManager: vi.fn(),
        openTemplateManager: vi.fn(),
        openPackManager: vi.fn(),
    };
    const adapters = Object.fromEntries(
        (Object.keys(presence) as NeighbourAdapter['id'][]).map((id) => [
            id,
            {
                id,
                present: () => presence[id],
                version: () => undefined,
                capabilities: () => [],
                ready: async () => {},
                ...(id === 'ck' ? { kernel: () => (presence.ck ? kernel : null) } : {}),
            },
        ]),
    );
    // Neighbours' own settings: the dock must never touch them.
    const neighbourSettings = {
        dooms_tracker: { enabled: true, portraitPosition: 'left' },
        CarrotKernel: { enabled: true },
        qvink_memory: { profile: 'Default' },
        nai_studio: { model: 'nai-diffusion-4-5-full' },
    };
    Object.assign(env.mock.extensionSettings, structuredClone(neighbourSettings));
    const exposed = new Map<string, unknown>();
    const app = {
        host: env.host,
        i18n: env.i18n,
        settings: env.settings,
        ui,
        log: env.log,
        adapters,
        modules: {
            expose: (key: string, api: unknown) => exposed.set(key, api),
            api: (key: string) => exposed.get(key),
        },
    } as unknown as App;
    env.i18n.register(dockModule.i18n!);
    env.settings.registerModule(dockModule.key, dockModule.defaults, dockModule.enabledByDefault);
    const disposers: (() => void | Promise<void>)[] = [];
    await dockModule.init({
        app,
        settings: env.settings.module<DockSettings>(dockModule.key),
        log: env.log,
        own: (dispose) => disposers.push(dispose),
    });
    return {
        env,
        ui,
        app,
        presence,
        kernel,
        neighbourSettings,
        settings: () => env.settings.module<DockSettings>(dockModule.key),
        api: () => exposed.get('dock') as DockApi,
        stop: async () => {
            for (const dispose of disposers.splice(0).reverse()) await dispose();
        },
    };
}
