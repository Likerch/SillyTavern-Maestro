// The assistant's access to Maestro's module settings (M33, plan §4.13): an allowlist over every module's slice —
// paths that look like keys, tokens, addresses, profiles, connections or models are invisible and refused (see
// HIDDEN_SETTING), as is anything that is not a primitive or a list of primitives, and the assistant's own slice
// (it must not lift its own limits). A change is validated against the current value, shown as before → after, and
// applied only by the core's loop after the user confirmed; the apply journals it with undo.
import {
    checkSettingPath,
    checkSettingValue,
    isHiddenPath,
    isSettingLeaf,
    visibleSettings,
    writePath,
} from '../../domain/assistant-safety';
import type { PathCheck, ValueCheck } from '../../domain/assistant-safety';
import type { App, JournalChange } from '../../shared/contracts';
import type { SettingsAccess, WritePlan } from './api';
import { ASSISTANT_KEY } from './settings';

export const ASSISTANT_ID = 'M33';
/** Journal target and kind of a setting the assistant changed. */
export const SETTING_TARGET = 'assistant.setting';
export const SETTING_KIND = 'assistant.setting';

export interface SettingsAccessOptions {
    /** Module keys whose settings stay invisible (default: the assistant's own). */
    exclude?: readonly string[];
}

type Slice = Record<string, unknown>;

function clone<T>(value: T): T {
    return Array.isArray(value) ? ([...value] as T) : value;
}

/** A value for a one-line summary: lists joined, strings quoted and cut. */
export function formatSettingValue(value: unknown): string {
    if (Array.isArray(value)) return `[${value.map((item) => formatSettingValue(item)).join(', ')}]`;
    if (typeof value === 'string') return `«${value.length > 60 ? `${value.slice(0, 59)}…` : value}»`;
    if (value === null || value === undefined) return '—';
    return String(value);
}

export function createSettingsAccess(app: App, options: SettingsAccessOptions = {}): SettingsAccess {
    const excluded = new Set(options.exclude ?? [ASSISTANT_KEY]);
    const t = (key: string, params?: Record<string, string | number>) => app.i18n.t(key, params);
    const entry = (key: string) => app.modules.list().find((item) => item.module.key === key);
    const known = (key: unknown): key is string =>
        typeof key === 'string' && !excluded.has(key) && !isHiddenPath(key) && entry(key) !== undefined;
    const slice = (key: string): Slice => app.settings.module<Slice>(key);
    const title = (key: string): string => {
        const found = entry(key);
        return found ? t(found.module.titleKey) : key;
    };

    const pathError = (check: Exclude<PathCheck, { ok: true }>, module: string, path: string): Error => {
        const params = { module: title(module), path: String(path) };
        switch (check.problem) {
            case 'hidden':
                return new Error(t('m33.safety.hidden', params));
            case 'notLeaf':
                return new Error(t('m33.safety.notLeaf', params));
            case 'unknown':
                return new Error(t('m33.safety.unknownPath', params));
            default:
                return new Error(t('m33.safety.malformed', params));
        }
    };

    const valueError = (check: Exclude<ValueCheck, { ok: true }>, path: string, current: unknown): Error => {
        const params = {
            path,
            expected: t(`m33.safety.type.${check.expected}`),
            current: formatSettingValue(current),
        };
        return new Error(t(`m33.safety.value.${check.problem}`, params));
    };

    return {
        modules(): string[] {
            return app.modules
                .list()
                .map((item) => item.module.key)
                .filter((key) => known(key) && Object.keys(visibleSettings(slice(key))).length > 0);
        },

        read(moduleKey: string): Record<string, unknown> | null {
            return known(moduleKey) ? visibleSettings(slice(moduleKey)) : null;
        },

        allowed(moduleKey: string, path: string): boolean {
            return known(moduleKey) && checkSettingPath(slice(moduleKey), path).ok;
        },

        plan(moduleKey: string, path: string, value: unknown): WritePlan {
            if (!known(moduleKey)) throw new Error(t('m33.safety.unknownModule', { module: String(moduleKey) }));
            const check = checkSettingPath(slice(moduleKey), path);
            if (!check.ok) throw pathError(check, moduleKey, path);
            const next = checkSettingValue(check.current, value);
            if (!next.ok) throw valueError(next, path, check.current);
            const before = clone(check.current);
            const after = clone(next.value);
            const moduleTitle = title(moduleKey);
            const summary = t('m33.setting.summary', {
                module: moduleTitle,
                path,
                before: formatSettingValue(before),
                after: formatSettingValue(after),
            });
            return {
                summary,
                target: t('m33.setting.target', { module: moduleTitle }),
                before,
                after,
                async apply() {
                    // Re-checked: the module may be gone or the path hidden by an update since the plan.
                    if (!known(moduleKey)) throw new Error(t('m33.safety.unknownModule', { module: moduleKey }));
                    const live = checkSettingPath(slice(moduleKey), path);
                    if (!live.ok) throw pathError(live, moduleKey, path);
                    const previous = clone(live.current);
                    writePath(slice(moduleKey), live.segments, clone(after));
                    app.settings.save();
                    app.settings.notify(`modules.${moduleKey}.${path}`);
                    const change: JournalChange = {
                        target: SETTING_TARGET,
                        ref: { module: moduleKey, path },
                        before: previous,
                        after: clone(after),
                    };
                    await app.journal.record({ module: ASSISTANT_ID, kind: SETTING_KIND, summary, changes: [change] });
                    return { result: { module: moduleKey, path, value: after } };
                },
            };
        },
    };
}

/** Undo of a setting the assistant changed: the previous value goes back if the path is still allowed. */
export function registerSettingUndo(app: App, options: SettingsAccessOptions = {}): void {
    const excluded = new Set(options.exclude ?? [ASSISTANT_KEY]);
    app.journal.registerUndo(SETTING_TARGET, async (change) => {
        const module = change.ref['module'];
        const path = change.ref['path'];
        if (typeof module !== 'string' || typeof path !== 'string' || excluded.has(module) || isHiddenPath(module))
            return false;
        if (!app.modules.list().some((item) => item.module.key === module)) return false;
        const slice = app.settings.module<Slice>(module);
        const check = checkSettingPath(slice, path);
        if (!check.ok || !isSettingLeaf(change.before)) return false;
        writePath(slice, check.segments, clone(change.before));
        app.settings.save();
        app.settings.notify(`modules.${module}.${path}`);
        return true;
    });
}
