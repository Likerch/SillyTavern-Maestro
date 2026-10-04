// Capability registry: every ST feature Maestro relies on is checked by a probe, so a different ST or
// neighbour version switches off only what depends on the missing piece (plan §4.3). Probes never throw:
// an exception or rejection is reported as a missing capability with the error as detail.
import type { Capabilities, CapabilityReport, HostModules, Logger } from '../shared/contracts';

export type ProbeOutcome = boolean | { ok: boolean; detail?: string };
export type Probe = () => ProbeOutcome | Promise<ProbeOutcome>;

export interface CapabilityRegistry extends Capabilities {
    /** Like register(), but the probe may also return a detail line for the health view. */
    probe(id: string, probe: Probe, detail?: string): void;
    unregister(id: string): void;
}

interface Entry {
    probe: Probe;
    detail?: string;
    result?: { ok: boolean; detail?: string };
    /** Bumped on re-registration so a stale async result is dropped. */
    generation: number;
}

export function createCapabilities(log: Logger): CapabilityRegistry {
    const entries = new Map<string, Entry>();
    let refreshed = false;

    async function run(id: string, entry: Entry): Promise<void> {
        const generation = entry.generation;
        let result: { ok: boolean; detail?: string };
        try {
            result = normalize(await entry.probe(), entry.detail);
        } catch (error) {
            result = { ok: false, detail: errorText(error) };
        }
        if (entries.get(id) !== entry || entry.generation !== generation) return;
        if (entry.result?.ok !== result.ok)
            log.debug(`capability ${id}: ${result.ok ? 'yes' : 'no'}`, result.detail ?? '');
        entry.result = result;
    }

    function add(id: string, probe: Probe, detail?: string): void {
        const previous = entries.get(id);
        const entry: Entry = { probe, detail, generation: (previous?.generation ?? 0) + 1 };
        entries.set(id, entry);
        // Late registrations (adapters, modules) are probed right away once the first refresh has happened.
        if (refreshed) void run(id, entry);
    }

    return {
        register(id: string, probe: () => boolean | Promise<boolean>, detail?: string): void {
            add(id, probe, detail);
        },

        probe(id: string, probe: Probe, detail?: string): void {
            add(id, probe, detail);
        },

        unregister(id: string): void {
            entries.delete(id);
        },

        has(id: string): boolean {
            return entries.get(id)?.result?.ok === true;
        },

        report(): CapabilityReport[] {
            return [...entries].map(([id, entry]) => {
                const detail = entry.result ? entry.result.detail : 'not probed yet';
                return detail === undefined
                    ? { id, ok: entry.result?.ok === true }
                    : { id, ok: entry.result?.ok === true, detail };
            });
        },

        async refresh(): Promise<void> {
            refreshed = true;
            await Promise.all([...entries].map(([id, entry]) => run(id, entry)));
        },
    };
}

function normalize(outcome: ProbeOutcome, fallbackDetail: string | undefined): { ok: boolean; detail?: string } {
    if (typeof outcome === 'boolean')
        return fallbackDetail === undefined ? { ok: outcome } : { ok: outcome, detail: fallbackDetail };
    if (outcome && typeof outcome === 'object' && typeof outcome.ok === 'boolean') {
        const detail = outcome.detail ?? fallbackDetail;
        return detail === undefined ? { ok: outcome.ok } : { ok: outcome.ok, detail };
    }
    return { ok: false, detail: 'probe returned no result' };
}

function errorText(error: unknown): string {
    if (error instanceof Error) return error.message || error.name;
    return String(error);
}

/* ------------------------------------------------------------------ built-in SillyTavern probes */

/**
 * Built-in capability ids (public contract: modules list them in `requires`).
 *
 * | id | true when |
 * |---|---|
 * | `st.events.scanDone` | `eventTypes.WORLDINFO_SCAN_DONE` exists |
 * | `st.events.entriesLoaded` | `eventTypes.WORLDINFO_ENTRIES_LOADED` exists |
 * | `st.events.wiActivated` | `eventTypes.WORLD_INFO_ACTIVATED` exists |
 * | `st.events.forceActivate` | `eventTypes.WORLDINFO_FORCE_ACTIVATE` exists |
 * | `st.events.ccPromptReady` | `eventTypes.CHAT_COMPLETION_PROMPT_READY` exists |
 * | `st.events.ccSettingsReady` | `eventTypes.CHAT_COMPLETION_SETTINGS_READY` exists |
 * | `st.events.presetChangedBefore` | `eventTypes.OAI_PRESET_CHANGED_BEFORE` exists |
 * | `st.cm` | `ConnectionManagerRequestService.sendRequest` is a function and the connection-manager extension is not disabled |
 * | `st.chatCompletion` | the main API is Chat Completion (`mainApi === 'openai'`) |
 * | `st.messageFormatter` | `messageFormatter.addHook` is a function |
 * | `st.files` | user files API (always present in 1.19) |
 * | `st.wi.module` | world-info.js exports `getSortedEntries`, `checkWorldInfo`, `world_info_position` |
 * | `st.wi.navbarHandler` | script.js exports `doNavbarIconClick` |
 * | `st.oai.promptManager` | openai.js exports `promptManager` (live binding, may still be null) and `getChatCompletionPreset` |
 * | `st.presetManager` | preset-manager.js exports `getPresetManager` |
 * | `st.chats.hide` | chats.js exports `hideChatMessageRange` |
 * | `st.regex` | extensions/regex/engine.js exports `getRegexScripts` |
 * | `st.macros.newEngine` | `power_user.experimental_macro_engine === true` (public/scripts/power-user.js; default true in 1.19) |
 * | `st.version.1.19` | the server version (`GET /version` → `pkgVersion`) starts with `1.19`; unknown → true with a detail |
 */
export const BUILTIN_CAPABILITIES = [
    'st.events.scanDone',
    'st.events.entriesLoaded',
    'st.events.wiActivated',
    'st.events.forceActivate',
    'st.events.ccPromptReady',
    'st.events.ccSettingsReady',
    'st.events.presetChangedBefore',
    'st.cm',
    'st.chatCompletion',
    'st.messageFormatter',
    'st.files',
    'st.wi.module',
    'st.wi.navbarHandler',
    'st.oai.promptManager',
    'st.presetManager',
    'st.chats.hide',
    'st.regex',
    'st.macros.newEngine',
    'st.version.1.19',
] as const;

export type BuiltinCapability = (typeof BUILTIN_CAPABILITIES)[number];

export interface BuiltinProbeDeps {
    ctx: () => STContext;
    modules: HostModules;
    /** Resolves to the ST version once known (undefined when /version failed). */
    version: () => Promise<string | undefined>;
    /** How long the version probe waits for /version (ms). */
    versionTimeoutMs?: number;
}

type ExportKind = 'function' | 'object' | 'present';

export function registerBuiltinProbes(caps: CapabilityRegistry, deps: BuiltinProbeDeps): void {
    const { ctx, modules } = deps;
    const partial = (): Partial<STContext> => ctx();

    const eventProbe =
        (key: string): Probe =>
        () => {
            const types = partial().eventTypes;
            const value = types && Object.prototype.hasOwnProperty.call(types, key) ? types[key] : undefined;
            return typeof value === 'string'
                ? { ok: true, detail: value }
                : { ok: false, detail: `eventTypes.${key} is missing` };
        };

    const exportsProbe =
        (load: () => Promise<Record<string, unknown>>, wanted: Record<string, ExportKind>): Probe =>
        async () => {
            const namespace = await load();
            const missing = Object.entries(wanted)
                .filter(([name, kind]) => !hasExport(namespace, name, kind))
                .map(([name]) => name);
            return missing.length === 0 ? true : { ok: false, detail: `missing exports: ${missing.join(', ')}` };
        };

    const events: Record<string, string> = {
        'st.events.scanDone': 'WORLDINFO_SCAN_DONE',
        'st.events.entriesLoaded': 'WORLDINFO_ENTRIES_LOADED',
        'st.events.wiActivated': 'WORLD_INFO_ACTIVATED',
        'st.events.forceActivate': 'WORLDINFO_FORCE_ACTIVATE',
        'st.events.ccPromptReady': 'CHAT_COMPLETION_PROMPT_READY',
        'st.events.ccSettingsReady': 'CHAT_COMPLETION_SETTINGS_READY',
        'st.events.presetChangedBefore': 'OAI_PRESET_CHANGED_BEFORE',
    };
    for (const [id, key] of Object.entries(events)) caps.probe(id, eventProbe(key));

    caps.probe('st.cm', () => {
        const context = partial();
        if (typeof context.ConnectionManagerRequestService?.sendRequest !== 'function') {
            return { ok: false, detail: 'ConnectionManagerRequestService.sendRequest is missing' };
        }
        const disabled = context.extensionSettings?.disabledExtensions;
        if (Array.isArray(disabled) && disabled.includes('connection-manager')) {
            return { ok: false, detail: 'the Connection Manager extension is disabled' };
        }
        return true;
    });

    caps.probe('st.chatCompletion', () => {
        const api = partial().mainApi;
        return api === 'openai' ? true : { ok: false, detail: `main API is ${String(api)}` };
    });

    caps.probe('st.messageFormatter', () => typeof partial().messageFormatter?.addHook === 'function');

    caps.probe('st.files', () => true, 'user files API (/api/files) is part of ST 1.19');

    caps.probe(
        'st.wi.module',
        exportsProbe(() => modules.worldInfo(), {
            getSortedEntries: 'function',
            checkWorldInfo: 'function',
            world_info_position: 'object',
        }),
    );
    caps.probe(
        'st.wi.navbarHandler',
        exportsProbe(() => modules.script(), { doNavbarIconClick: 'function' }),
    );
    caps.probe(
        'st.oai.promptManager',
        exportsProbe(() => modules.openai(), { promptManager: 'present', getChatCompletionPreset: 'function' }),
    );
    caps.probe(
        'st.presetManager',
        exportsProbe(() => modules.presetManager(), { getPresetManager: 'function' }),
    );
    caps.probe(
        'st.chats.hide',
        exportsProbe(() => modules.chats(), { hideChatMessageRange: 'function' }),
    );
    caps.probe(
        'st.regex',
        exportsProbe(() => modules.regexEngine(), { getRegexScripts: 'function' }),
    );

    caps.probe('st.macros.newEngine', () => {
        const power = partial().powerUserSettings;
        const flag = power && typeof power === 'object' ? power['experimental_macro_engine'] : undefined;
        if (flag === true) return true;
        return {
            ok: false,
            detail:
                flag === undefined
                    ? 'this ST has no experimental_macro_engine setting'
                    : 'experimental_macro_engine is off',
        };
    });

    caps.probe('st.version.1.19', async () => {
        const version = await withTimeout(deps.version(), deps.versionTimeoutMs ?? 3000);
        if (!version) return { ok: true, detail: 'ST version unknown; assuming 1.19' };
        if (version.startsWith('1.19')) return { ok: true, detail: version };
        return { ok: false, detail: `ST ${version}; Maestro is tested with 1.19` };
    });
}

function hasExport(namespace: Record<string, unknown>, name: string, kind: ExportKind): boolean {
    if (!(name in namespace)) return false;
    const value = namespace[name];
    if (kind === 'function') return typeof value === 'function';
    if (kind === 'object') return value !== null && typeof value === 'object';
    return true;
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | undefined> {
    return new Promise((resolve) => {
        const timer = setTimeout(() => resolve(undefined), ms);
        promise.then(
            (value) => {
                clearTimeout(timer);
                resolve(value);
            },
            () => {
                clearTimeout(timer);
                resolve(undefined);
            },
        );
    });
}
