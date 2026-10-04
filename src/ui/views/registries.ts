// Small registries that other layers fill after the UI is built: Settings actions (export, import,
// "Prepare to disable" — implemented in later tasks) and extra task kinds for per-task profiles.
import type { Unsubscribe } from '../../shared/contracts';

export interface SettingsAction {
    id: string;
    labelKey: string;
    run: () => void | Promise<void>;
    icon?: string;
    danger?: boolean;
}

/** Buttons the Settings tab always shows; they call the handler registered under the same id. */
export const BUILTIN_SETTINGS_ACTIONS: readonly { id: string; labelKey: string; icon: string; danger?: boolean }[] = [
    { id: 'export', labelKey: 'ui.settings.export', icon: 'fa-file-export' },
    { id: 'import', labelKey: 'ui.settings.import', icon: 'fa-file-import' },
    { id: 'prepareDisable', labelKey: 'ui.settings.prepareDisable', icon: 'fa-power-off', danger: true },
];

/** Profile rows the Settings tab always shows. */
export const BUILTIN_PROFILE_TASKS: readonly { id: string; labelKey: string }[] = [
    { id: 'default', labelKey: 'ui.settings.profileDefault' },
    { id: 'fallback', labelKey: 'ui.settings.profileFallback' },
];

const actions = new Map<string, SettingsAction>();
const profileTaskMap = new Map<string, string>();
const listeners = new Set<() => void>();

function changed(): void {
    for (const listener of [...listeners]) {
        try {
            listener();
        } catch (error) {
            console.error('[Maestro:ui] registry listener failed', error);
        }
    }
}

/**
 * Registers the handler of a Settings button. Built-in ids: 'export', 'import', 'prepareDisable'; any other id
 * adds a new button labelled with `labelKey`. Registering an id again replaces the handler.
 */
export function registerSettingsAction(
    id: string,
    labelKey: string,
    run: () => void | Promise<void>,
    options: { icon?: string; danger?: boolean } = {},
): Unsubscribe {
    const entry: SettingsAction = { id, labelKey, run, icon: options.icon, danger: options.danger };
    actions.set(id, entry);
    changed();
    return () => {
        if (actions.get(id) !== entry) return;
        actions.delete(id);
        changed();
    };
}

export function settingsAction(id: string): SettingsAction | undefined {
    return actions.get(id);
}

export function settingsActions(): SettingsAction[] {
    return [...actions.values()];
}

/** Adds a task kind to the "Profiles" list of the Settings tab (key in CoreSettings.profiles). */
export function registerProfileTask(id: string, labelKey: string): Unsubscribe {
    profileTaskMap.set(id, labelKey);
    changed();
    return () => {
        if (profileTaskMap.get(id) !== labelKey) return;
        profileTaskMap.delete(id);
        changed();
    };
}

export function profileTasks(): { id: string; labelKey: string }[] {
    return [...profileTaskMap.entries()].map(([id, labelKey]) => ({ id, labelKey }));
}

export function onRegistryChange(listener: () => void): Unsubscribe {
    listeners.add(listener);
    return () => listeners.delete(listener);
}

/** Test helper: forget every registration. */
export function resetRegistries(): void {
    actions.clear();
    profileTaskMap.clear();
    changed();
}
