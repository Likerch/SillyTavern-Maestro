// Test environment for M32 part A (the theme layer): a minimal App with real i18n, an in-memory settings service
// with change notifications, a UI fake whose style() writes real <style data-maestro-style> nodes into <head> (as
// src/ui does), a pult-tab / settings-section recorder, ST events with emit(), and fake neighbour skins.
import { createI18n } from '../../../src/core/i18n';
import type { Translations } from '../../../src/core/i18n';
import { THEME_CLASS, partClass } from '../../../src/features/theme/api';
import type { NeighbourId, NeighbourSkin, ThemeApi } from '../../../src/features/theme/api';
import { createThemeModule } from '../../../src/features/theme/module';
import type { SettingsSectionSpec } from '../../../src/features/theme/view';
import type {
    App,
    I18nParts,
    MaestroModule,
    PultTab,
    SettingsService,
    Ui,
    Unsubscribe,
} from '../../../src/shared/contracts';
import { memoryLogger } from '../../helpers/host-fakes';
import type { MemoryLogger } from '../../helpers/host-fakes';

export interface FakeSkin extends NeighbourSkin {
    isPresent: boolean;
}

export function fakeSkin(id: NeighbourId, isPresent = true, titleKey = `test.skin.${id}`): FakeSkin {
    const skin: FakeSkin = {
        id,
        titleKey,
        css: `html.${THEME_CLASS}.${partClass(id)} .${id}-panel { border-radius: var(--maestro-radius-md); }`,
        isPresent,
        present: () => skin.isPresent,
    };
    return skin;
}

export const SKIN_STRINGS: I18nParts = {
    en: { 'test.skin.des': 'Doom’s Enhancement Suite', 'test.skin.des.hint': 'Scene headers and windows' },
    ru: { 'test.skin.des': 'Doom’s Enhancement Suite', 'test.skin.des.hint': 'Шапки сцен и окна' },
};

export interface ThemeEnv {
    app: App;
    i18n: Translations;
    log: MemoryLogger;
    slices: Record<string, Record<string, unknown>>;
    notified: string[];
    saves: number;
    tabs: PultTab[];
    sections: SettingsSectionSpec[];
    exposed: Map<string, unknown>;
    module: MaestroModule;
    running: boolean;
    start(): Promise<void>;
    stop(): Promise<void>;
    api(): ThemeApi;
    emit(event: string): void;
    /** ui.style ids currently in <head>, in document order. */
    styleIds(): string[];
    styleText(id: string): string | undefined;
    classes(): string[];
}

export interface ThemeEnvOptions {
    skins?: NeighbourSkin[];
    locale?: 'ru' | 'en';
    /** Offer app.ui.addSettingsSection (the stage 12 dock). */
    sections?: boolean;
}

export function createThemeEnv(options: ThemeEnvOptions = {}): ThemeEnv {
    const skins = options.skins ?? [];
    const i18n = createI18n(() => options.locale ?? 'en');
    const log = memoryLogger();
    const slices: Record<string, Record<string, unknown>> = {};
    const listeners = new Set<(path: string) => void>();
    const handlers = new Map<string, Set<() => void>>();
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
        notice() {},
        refresh() {},
        openPult() {},
    } as unknown as Ui & { addSettingsSection?: (section: SettingsSectionSpec) => Unsubscribe };
    if (options.sections) {
        ui.addSettingsSection = (section) => {
            env.sections.push(section);
            return () => {
                env.sections = env.sections.filter((item) => item !== section);
            };
        };
    }

    const app = {
        i18n,
        log,
        settings,
        ui,
        host: {
            events: {
                on(event: string, handler: () => void): Unsubscribe {
                    if (!handlers.has(event)) handlers.set(event, new Set());
                    handlers.get(event)!.add(handler);
                    return () => handlers.get(event)?.delete(handler);
                },
            },
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

    const module = createThemeModule(skins, SKIN_STRINGS) as unknown as MaestroModule;
    if (module.i18n) i18n.register(module.i18n);

    const env: ThemeEnv = {
        app,
        i18n,
        log,
        slices,
        notified: [],
        saves: 0,
        tabs: [],
        sections: [],
        exposed,
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
        api: () => exposed.get('theme') as ThemeApi,
        emit(event: string) {
            for (const handler of [...(handlers.get(event) ?? [])]) handler();
        },
        styleIds: () =>
            [...document.head.querySelectorAll('style[data-maestro-style]')].map(
                (node) => node.getAttribute('data-maestro-style') ?? '',
            ),
        styleText: (id) => document.head.querySelector(`style[data-maestro-style="${id}"]`)?.textContent ?? undefined,
        classes: () => [...document.documentElement.classList].filter((name) => name.startsWith(THEME_CLASS)),
    };
    return env;
}

/** Resets the page between tests (classes, inline theme variables, styles, body). */
export function resetPage(): void {
    document.documentElement.className = '';
    document.documentElement.removeAttribute('style');
    document.head.innerHTML = '';
    document.body.className = '';
    document.body.removeAttribute('style');
    document.body.innerHTML = '';
}
