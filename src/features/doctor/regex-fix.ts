// Regex treatment from the doctor (plan M5 «Лечение», §8; dev-plan 2.5): enable, disable or delete one script.
// Where scripts live (ST 1.19 extensions/regex/engine.js `getScriptsByType` / `saveScriptsByType`):
// - global: `extension_settings.regex` (settings.json, debounced save);
// - scoped: the character card's `data.extensions.regex_scripts` (`writeExtensionField`);
// - preset: the Chat Completion preset's `extensions.regex_scripts` — saving writes the preset file, so these always
//   ask (kind 'doctor.presetRegexFix', never 'auto').
// Toggles flip `disabled` on the live script object, as ST's own /regex-toggle does (its panel keeps references to
// those objects); a delete saves a new list. Every action goes through autonomy (deletes ask), is journaled with the
// whole script as the backup (target 'doctor-regex') and acknowledged to M4, so it is not reported as drift.
// «Dead» scripts are only ever disabled: other chats may need them.
import type { RegexScriptInfo, RegexType } from '../../domain/doctor-regex';
import type { App, AutonomyLevel, Decision, JournalChange, Unsubscribe } from '../../shared/contracts';
import type { GuardianApi } from '../guardian/api';
import type { RegexAction } from './api';
import { regexEngine } from './sources';

export const REGEX_FIX_KIND = 'doctor.regexFix';
export const PRESET_REGEX_KIND = 'doctor.presetRegexFix';
export const REGEX_TARGET = 'doctor-regex';

export interface RegexFixPayload {
    action: RegexAction;
    type: RegexType;
    /** ST's script id (uuid); '' for scripts without one (then `index` and `name` locate it). */
    scriptId: string;
    index: number;
    name: string;
    /** Character avatar (scoped) or preset name (preset) the script belongs to; null for global scripts. */
    owner: string | null;
}

type Dict = Record<string, unknown>;

interface ScriptStore {
    list: Dict[];
    owner: string | null;
    save(list: Dict[]): Promise<void>;
}

const DEFAULT_CODES: Record<RegexType, number> = { global: 0, scoped: 1, preset: 2 };
const ACTIONS: readonly RegexAction[] = ['enable', 'disable', 'delete'];
const TYPES: readonly RegexType[] = ['global', 'scoped', 'preset'];

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function jsonCopy<T>(value: T): T {
    return JSON.parse(JSON.stringify(value)) as T;
}

export function isRegexFixPayload(value: unknown): value is RegexFixPayload {
    if (!isDict(value)) return false;
    return (
        ACTIONS.includes(value.action as RegexAction) &&
        TYPES.includes(value.type as RegexType) &&
        typeof value.scriptId === 'string' &&
        typeof value.index === 'number' &&
        typeof value.name === 'string' &&
        (value.owner === null || typeof value.owner === 'string')
    );
}

interface PresetManagerLike {
    readPresetExtensionField?(options: { path: string }): unknown;
    writePresetExtensionField?(options: { path: string; value: unknown }): Promise<void>;
    getSelectedPresetName?(): unknown;
}

async function presetManager(app: App): Promise<PresetManagerLike | null> {
    try {
        const module = await app.host.modules.presetManager();
        const get = module.getPresetManager;
        const manager: unknown = typeof get === 'function' ? (get as () => unknown)() : null;
        return isDict(manager) ? (manager as PresetManagerLike) : null;
    } catch {
        return null;
    }
}

function currentAvatar(app: App): string | null {
    const ctx = app.host.ctx();
    if (ctx.characterId === undefined || ctx.characterId === '') return null;
    const avatar = ctx.characters[Number(ctx.characterId)]?.avatar;
    return typeof avatar === 'string' ? avatar : null;
}

async function currentPresetName(app: App, engine: Dict | null): Promise<string | null> {
    const fromEngine = engine?.getCurrentPresetName;
    if (typeof fromEngine === 'function') {
        try {
            const name: unknown = (fromEngine as () => unknown)();
            if (typeof name === 'string' && name) return name;
        } catch {
            // Fall through to the settings.
        }
    }
    const name = app.host.ctx().chatCompletionSettings?.preset_settings_openai;
    return typeof name === 'string' && name ? name : null;
}

async function ownerOf(app: App, type: RegexType, engine: Dict | null): Promise<string | null> {
    if (type === 'scoped') return currentAvatar(app);
    if (type === 'preset') return currentPresetName(app, engine);
    return null;
}

/** The live scripts of one type and how to save them (ST's engine, or the same stores directly). */
async function scriptStore(app: App, type: RegexType): Promise<ScriptStore | null> {
    const engine = await regexEngine(app);
    const owner = await ownerOf(app, type, engine);
    const read = engine?.getScriptsByType;
    const write = engine?.saveScriptsByType;
    if (typeof read === 'function' && typeof write === 'function') {
        const codes = isDict(engine?.SCRIPT_TYPES) ? engine.SCRIPT_TYPES : {};
        const stored = codes[type.toUpperCase()];
        const code = typeof stored === 'number' ? stored : DEFAULT_CODES[type];
        const list: unknown = (read as (code: number, options: { allowedOnly: boolean }) => unknown)(code, {
            allowedOnly: false,
        });
        return {
            list: Array.isArray(list) ? list.filter(isDict) : [],
            owner,
            save: async (next) => {
                await (write as (scripts: Dict[], code: number) => unknown)(next, code);
            },
        };
    }
    const ctx = app.host.ctx();
    if (type === 'global') {
        const list = ctx.extensionSettings.regex;
        return {
            list: Array.isArray(list) ? list.filter(isDict) : [],
            owner,
            save: async (next) => {
                app.host.ctx().extensionSettings.regex = next;
                app.host.ctx().saveSettingsDebounced();
            },
        };
    }
    if (type === 'scoped') {
        const id = ctx.characterId;
        if (id === undefined || id === '') return null;
        const list = ctx.characters[Number(id)]?.data?.extensions?.regex_scripts;
        return {
            list: Array.isArray(list) ? list.filter(isDict) : [],
            owner,
            save: async (next) => {
                await app.host.ctx().writeExtensionField(id, 'regex_scripts', next);
            },
        };
    }
    const manager = await presetManager(app);
    if (!manager?.readPresetExtensionField || !manager.writePresetExtensionField) return null;
    const list = manager.readPresetExtensionField({ path: 'regex_scripts' });
    return {
        list: Array.isArray(list) ? list.filter(isDict) : [],
        owner,
        save: async (next) => {
            await manager.writePresetExtensionField?.({ path: 'regex_scripts', value: next });
        },
    };
}

/** Index of the script: by ST's id, else by position and name, else by name. */
function locate(list: readonly Dict[], ref: Pick<RegexFixPayload, 'scriptId' | 'index' | 'name'>): number {
    if (ref.scriptId) return list.findIndex((script) => script.id === ref.scriptId);
    const at = list[ref.index];
    if (at && (at.scriptName ?? '') === ref.name) return ref.index;
    return list.findIndex((script) => (script.scriptName ?? '') === ref.name);
}

async function acknowledge(app: App, type: RegexType): Promise<void> {
    const guardian = app.modules.api<GuardianApi>('guardian');
    if (!guardian) return;
    try {
        await guardian.acknowledge(type === 'preset' ? ['regex', 'preset.body'] : ['regex']);
    } catch (error) {
        app.log.warn('guardian acknowledge failed', error);
    }
}

async function openStore(app: App, payload: Pick<RegexFixPayload, 'type' | 'owner'>): Promise<ScriptStore | null> {
    const store = await scriptStore(app, payload.type);
    if (!store) return null;
    // A character's or a preset's script belongs to that character or preset only.
    if (payload.type !== 'global' && payload.owner !== null && store.owner !== payload.owner) return null;
    return store;
}

/** Applies one action; throws when the script is gone or belongs to another character/preset now. */
export async function applyRegexFix(app: App, payload: RegexFixPayload): Promise<void> {
    const store = await openStore(app, payload);
    const index = store ? locate(store.list, payload) : -1;
    if (!store || index < 0) throw new Error(app.i18n.t('m5.regexFix.notFound', { name: payload.name }));
    if (payload.action === 'delete') {
        await store.save(store.list.filter((_, position) => position !== index));
    } else {
        const script = store.list[index] as Dict;
        script.disabled = payload.action === 'disable';
        await store.save(store.list);
    }
    await acknowledge(app, payload.type);
}

/** The script is still there and the action still changes something. */
export async function regexFixValid(app: App, payload: RegexFixPayload): Promise<boolean> {
    const store = await openStore(app, payload);
    const index = store ? locate(store.list, payload) : -1;
    if (!store || index < 0) return false;
    const disabled = store.list[index]?.disabled === true;
    if (payload.action === 'enable') return disabled;
    if (payload.action === 'disable') return !disabled;
    return true;
}

/** Undo: a deleted script goes back to its place, a toggled one gets its previous state. */
export async function undoRegexFix(app: App, change: JournalChange): Promise<boolean> {
    const ref = change.ref;
    const type = ref.type as RegexType;
    if (!TYPES.includes(type) || typeof ref.name !== 'string' || typeof ref.index !== 'number') return false;
    const payload = {
        type,
        scriptId: typeof ref.scriptId === 'string' ? ref.scriptId : '',
        index: ref.index,
        name: ref.name,
        owner: typeof ref.owner === 'string' ? ref.owner : null,
    };
    const store = await openStore(app, payload);
    if (!store || !isDict(change.before)) return false;
    if (change.after === null) {
        if (payload.scriptId && store.list.some((script) => script.id === payload.scriptId)) return false;
        const next = [...store.list];
        next.splice(Math.min(Math.max(0, payload.index), next.length), 0, jsonCopy(change.before));
        await store.save(next);
    } else {
        const index = locate(store.list, payload);
        const live = index >= 0 ? store.list[index] : undefined;
        // Switched again since (by the user or ST's panel): leave it.
        if (!live || (live.disabled === true) !== (isDict(change.after) && change.after.disabled === true))
            return false;
        live.disabled = change.before.disabled === true;
        await store.save(store.list);
    }
    await acknowledge(app, type);
    return true;
}

/** Proposes the action for one script of the inventory; `note` is added to the question (e.g. «only disabled»). */
export async function regexAction(
    app: App,
    script: RegexScriptInfo,
    action: RegexAction,
    note?: string,
): Promise<Decision> {
    const t = app.i18n.t.bind(app.i18n);
    const store = await scriptStore(app, script.type);
    const payload: RegexFixPayload = {
        action,
        type: script.type,
        scriptId: script.scriptId,
        index: script.index,
        name: script.name,
        owner: store?.owner ?? null,
    };
    const index = store ? locate(store.list, payload) : -1;
    const live = store && index >= 0 ? store.list[index] : undefined;
    if (!live) {
        app.ui.notice(t('m5.regexFix.notFound', { name: script.name || script.id }), { level: 'warn' });
        return 'skipped';
    }
    const before = jsonCopy(live);
    const after = action === 'delete' ? null : { ...before, disabled: action === 'disable' };
    const preset = script.type === 'preset';
    const fallback: AutonomyLevel = preset || action === 'delete' ? 'ask' : 'auto';
    const name = script.name || t('m5.regex.unnamed');
    const description = [
        t(`m5.regexFix.description.${action}`, { name, type: t(`m5.regexType.${script.type}`) }),
        preset ? t('m5.regexFix.presetFile') : '',
        note ?? '',
    ]
        .filter(Boolean)
        .join('\n\n');
    return app.autonomy.decide<RegexFixPayload>(
        {
            module: 'M5',
            kind: preset ? PRESET_REGEX_KIND : REGEX_FIX_KIND,
            title: t(`m5.regexFix.title.${action}`, { name, type: t(`m5.regexType.${script.type}`) }),
            description,
            changes: [
                {
                    target: REGEX_TARGET,
                    ref: {
                        type: payload.type,
                        scriptId: payload.scriptId,
                        index: payload.index,
                        name: payload.name,
                        owner: payload.owner,
                    },
                    before,
                    after,
                },
            ],
            payload,
            stillValid: () => regexFixValid(app, payload),
            apply: (value) => applyRegexFix(app, value),
        },
        fallback,
    );
}

/** Undo handler and Inbox appliers; the module owns the returned disposers. */
export function registerRegexFixes(app: App): Unsubscribe[] {
    app.journal.registerUndo(REGEX_TARGET, (change) => undoRegexFix(app, change));
    // Writing preset scripts writes the preset file (plan §8: presets never become «auto»).
    app.autonomy.neverAuto(PRESET_REGEX_KIND);
    const apply = async (payload: unknown) => {
        if (!isRegexFixPayload(payload)) throw new Error('bad regex card');
        await applyRegexFix(app, payload);
    };
    const valid = async (payload: unknown) => isRegexFixPayload(payload) && regexFixValid(app, payload);
    return [
        app.inbox.registerApplier(REGEX_FIX_KIND, apply, valid),
        app.inbox.registerApplier(PRESET_REGEX_KIND, apply, valid),
    ];
}
