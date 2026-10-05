// Write tools over Maestro's own settings (M33, plan §4.13): one module setting through the core's allowlist
// (ToolContext.settings — API keys, URLs and connection profiles never pass), a module on or off through the module
// manager, the autonomy level of a kind of actions. Every change shows before/after and is journaled with undo.
import { optEnum, reqBool, reqEnum, reqString } from '../../../../domain/assistant-write-args';
import type { App, AutonomyLevel, JournalChange } from '../../../../shared/contracts';
import type { ToolSpec } from '../../api';
import { argsOf, ASSISTANT_KEY, failure, journal, listOf, moduleTitle, planWith, UNDO_TARGETS } from './common';

/* ------------------------------------------------------------------ setting_set */

export function settingSetTool(): ToolSpec {
    return {
        name: 'setting_set',
        kind: 'write',
        description:
            "Changes one setting of a Maestro module (a dot path inside the module's settings). Only allowlisted " +
            'settings can be changed: read them first with maestro_settings (current values, what may change). ' +
            'Never for API keys, server addresses or connection profiles. The user sees before/after and confirms.',
        parameters: {
            type: 'object',
            properties: {
                module: { type: 'string', description: 'Module key, e.g. "director".' },
                path: { type: 'string', description: 'Dot path inside the module settings, e.g. "pacing.every".' },
                value: {
                    type: ['string', 'number', 'boolean', 'array', 'object'],
                    items: {},
                    description: 'The new value, of the same type as the current one.',
                },
            },
            required: ['module', 'path', 'value'],
            additionalProperties: false,
        },
        plan: (raw, ctx) =>
            planWith(ctx, (say) => {
                const args = argsOf(raw);
                const module = reqString(args, 'module', { max: 80 });
                const path = reqString(args, 'path', { max: 200 });
                if (args.value === undefined) throw failure(say, 'argMissing', { name: 'value' });
                // The core checks the allowlist and the value, journals with undo when applied.
                return ctx.settings.plan(module, path, args.value);
            }),
    };
}

/* ------------------------------------------------------------------ module_toggle */

function findModule(app: App, wanted: string) {
    const lower = wanted.trim().toLowerCase();
    return app.modules
        .list()
        .find((item) => item.module.key.toLowerCase() === lower || item.module.id.toLowerCase() === lower);
}

export function moduleToggleTool(): ToolSpec {
    return {
        name: 'module_toggle',
        kind: 'write',
        description:
            'Switches a Maestro module on or off (by its key like "director" or its plan id like "M13"). A ' +
            'module whose SillyTavern capabilities are missing cannot be switched on (see maestro_modules). The ' +
            'assistant never switches itself.',
        parameters: {
            type: 'object',
            properties: {
                module: { type: 'string', description: 'Module key or plan id.' },
                on: { type: 'boolean', description: 'true: switch on, false: switch off.' },
            },
            required: ['module', 'on'],
            additionalProperties: false,
        },
        plan: (raw, ctx) =>
            planWith(ctx, (say) => {
                const args = argsOf(raw);
                const wanted = reqString(args, 'module', { max: 80 });
                const on = reqBool(args, 'on');
                const app = ctx.app;
                const entry = findModule(app, wanted);
                if (!entry) {
                    const keys = app.modules.list().map((item) => item.module.key);
                    throw failure(say, 'moduleUnknown', { module: wanted, list: listOf(keys) });
                }
                const { key, id } = entry.module;
                if (key === ASSISTANT_KEY || id === 'M33') throw failure(say, 'moduleSelf');
                const title = moduleTitle(app, key);
                if (entry.enabled === on) {
                    throw failure(say, 'moduleAlready', { title, state: say(on ? 'm33w.state.on' : 'm33w.state.off') });
                }
                if (on && entry.missing.length) {
                    throw failure(say, 'moduleMissing', { title, caps: entry.missing.join(', ') });
                }
                return {
                    summary: say(on ? 'm33w.module.summary.on' : 'm33w.module.summary.off', { title, id }),
                    target: say('m33w.target.modules'),
                    before: say(entry.enabled ? 'm33w.on' : 'm33w.off'),
                    after: say(on ? 'm33w.on' : 'm33w.off'),
                    async apply() {
                        const was = findModule(app, key)?.enabled ?? !on;
                        if (on) await app.modules.enable(key);
                        else await app.modules.disable(key);
                        const now = findModule(app, key);
                        if (was !== on) {
                            const change: JournalChange = {
                                target: UNDO_TARGETS.module,
                                ref: { key },
                                before: was,
                                after: on,
                            };
                            await journal(app, {
                                kind: 'assistant.module',
                                summary: say('m33w.module.journal', {
                                    title,
                                    state: say(on ? 'm33w.state.on' : 'm33w.state.off'),
                                }),
                                change,
                            });
                        }
                        return { result: { module: key, enabled: now?.enabled ?? on, running: now?.running ?? on } };
                    },
                };
            }),
    };
}

/** Journal undo of module_toggle: the previous state, if nobody switched the module since. */
export async function undoModule(app: App, change: JournalChange): Promise<boolean> {
    const key = change.ref.key;
    if (typeof key !== 'string' || key === ASSISTANT_KEY) return false;
    const entry = findModule(app, key);
    if (!entry || entry.module.id === 'M33' || entry.enabled !== change.after) return false;
    if (change.before === true) await app.modules.enable(key);
    else await app.modules.disable(key);
    return true;
}

/* ------------------------------------------------------------------ autonomy_set */

const LEVELS: readonly (AutonomyLevel | 'default')[] = ['auto', 'notify', 'inbox', 'ask', 'off', 'default'];
const KIND_PATTERN = /^[A-Za-z][\w-]*(?:\.[\w-]+)*$/;

/** Kinds the user can see in Settings (decided at least once, or with a stored level). */
function knownKinds(app: App): string[] {
    const stored = Object.keys(app.settings.core().autonomy ?? {});
    return [...new Set([...app.autonomy.stats().map((stat) => stat.kind), ...stored])].sort();
}

function storedLevel(app: App, kind: string): AutonomyLevel | null {
    return app.settings.core().autonomy?.[kind] ?? null;
}

/** Writes a level (null: back to the module default) the way Settings does. */
function writeLevel(app: App, kind: string, level: AutonomyLevel | null): boolean {
    if (level !== null) return app.autonomy.setLevel?.(kind, level) ?? false;
    const core = app.settings.core();
    if (core.autonomy) delete core.autonomy[kind];
    app.settings.save();
    app.settings.notify(`core.autonomy.${kind}`);
    return true;
}

export function autonomySetTool(): ToolSpec {
    return {
        name: 'autonomy_set',
        kind: 'write',
        description:
            'Sets how Maestro handles one kind of its actions (e.g. "canon.fact"): auto (does it), notify, inbox ' +
            '(a card to accept), ask, off, or default (back to the module default). Kinds that must never be ' +
            'automatic refuse "auto".',
        parameters: {
            type: 'object',
            properties: {
                kind: { type: 'string', description: 'Action kind, as listed in the autonomy settings.' },
                level: {
                    type: 'string',
                    enum: [...LEVELS],
                    description: 'auto, notify, inbox, ask, off, or default (the module decides).',
                },
            },
            required: ['kind', 'level'],
            additionalProperties: false,
        },
        available: (app) => typeof app.autonomy.setLevel === 'function',
        plan: (raw, ctx) =>
            planWith(ctx, (say) => {
                const args = argsOf(raw);
                const kind = reqString(args, 'kind', { max: 80 });
                const level = reqEnum(args, 'level', LEVELS);
                const app = ctx.app;
                const known = knownKinds(app);
                const modulePrefix = new Set(app.modules.list().map((item) => item.module.key.toLowerCase()));
                const prefix = kind.split('.')[0]!.toLowerCase();
                const isKnown = known.includes(kind);
                if (!KIND_PATTERN.test(kind) || (!isKnown && !(kind.includes('.') && modulePrefix.has(prefix)))) {
                    throw failure(say, 'autonomyKind', {
                        kind,
                        list: known.length ? listOf(known) : say('m33w.autonomy.none'),
                    });
                }
                if (level === 'auto' && app.autonomy.isNeverAuto?.(kind)) {
                    throw failure(say, 'autonomyNeverAuto', { kind });
                }
                const before = storedLevel(app, kind);
                const after = level === 'default' ? null : level;
                const label = (value: AutonomyLevel | null) => say(`m33w.level.${value ?? 'default'}`);
                if (before === after) throw failure(say, 'autonomyAlready', { kind, level: label(after) });
                const plan = {
                    summary: say('m33w.autonomy.summary', { kind, from: label(before), to: label(after) }),
                    target: say('m33w.target.autonomy'),
                    before: label(before),
                    after: isKnown ? label(after) : `${label(after)} (${say('m33w.autonomy.newKind')})`,
                    async apply() {
                        const previous = storedLevel(app, kind);
                        if (!writeLevel(app, kind, after)) throw failure(say, 'autonomyNeverAuto', { kind });
                        await journal(app, {
                            kind: 'assistant.autonomy',
                            summary: say('m33w.autonomy.journal', { kind, level: label(after) }),
                            change: { target: UNDO_TARGETS.autonomy, ref: { kind }, before: previous, after },
                        });
                        return { result: { kind, level: after ?? 'default' } };
                    },
                };
                return plan;
            }),
    };
}

/** Journal undo of autonomy_set: the previous level, if it was not changed since. */
export async function undoAutonomy(app: App, change: JournalChange): Promise<boolean> {
    const kind = change.ref.kind;
    if (typeof kind !== 'string') return false;
    if (storedLevel(app, kind) !== (change.after ?? null)) return false;
    const before = optEnum({ level: change.before }, 'level', LEVELS);
    return writeLevel(app, kind, before === undefined || before === 'default' ? null : before);
}
