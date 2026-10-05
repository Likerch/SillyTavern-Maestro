// Read tools over the game layer (M33): mechanics and their state, the director's scene and flags, the preset's
// blocks with their conditions and the flag catalogue for conditional blocks.
import { normalizeText } from '../../../../domain/assistant-docs';
import { blockCondition, flagUses } from '../../../../domain/preset-conditional-syntax';
import {
    isInChat,
    isMarker,
    promptDepth,
    promptName,
    promptRole,
    promptText,
} from '../../../../domain/preset-ui-blocks';
import type { App } from '../../../../shared/contracts';
import type { DirectorApi } from '../../../director/api';
import type { MechanicDef, MechanicsApi } from '../../../mechanics/api';
import type { PresetStore } from '../../../presetStudio/store-api';
import type { ToolSpec } from '../../api';
import { findEntity } from './world';
import {
    apiOf,
    argsOf,
    boolArg,
    capList,
    compact,
    cut,
    isDict,
    needsApi,
    notice,
    objectSchema,
    prop,
    readTool,
    safely,
    say,
    strArg,
    when,
} from './common';
import type { Dict } from './common';

/* ------------------------------------------------------------------ mechanics_state */

function definitionView(def: MechanicDef, active: boolean): Dict {
    return compact({
        id: def.id,
        name: def.name,
        active,
        scope: def.scope.kind,
        tracking: def.tracking,
        holders: def.holders.kind,
        summary: cut(def.summary, 200),
        rules: cut(def.rules, 300),
        attributes: def.attributes.slice(0, 12).map((attribute) =>
            compact({
                id: attribute.id,
                name: attribute.name,
                kind: attribute.kind,
                min: attribute.min,
                max: attribute.max,
                levels: attribute.levels?.slice(0, 8),
                options: attribute.options?.slice(0, 8),
                tracking: attribute.tracking,
                events: attribute.events?.length || undefined,
            }),
        ),
        checks: def.checks.slice(0, 8).map((check) =>
            compact({
                id: check.id,
                name: check.name,
                dice: check.dice,
                difficulty: check.difficulty,
                triggers: check.triggers.slice(0, 6),
            }),
        ),
    });
}

/** Duck-typed extras of the mechanics service: its flags for conditional blocks. */
function mechanicsFlags(api: unknown): { catalogue: string[]; on: string[] } {
    if (!isDict(api)) return { catalogue: [], on: [] };
    const catalogue = safely(() => {
        const list = typeof api.flagCatalogue === 'function' ? (api.flagCatalogue as () => unknown).call(api) : [];
        return Array.isArray(list)
            ? list.flatMap((item) => (isDict(item) && typeof item.flag === 'string' ? [item.flag] : []))
            : [];
    }, [] as string[]);
    const on = safely(() => {
        const list = typeof api.flagsOn === 'function' ? (api.flagsOn as () => unknown).call(api) : [];
        return Array.isArray(list) ? list.filter((item): item is string => typeof item === 'string') : [];
    }, [] as string[]);
    return { catalogue, on };
}

const mechanicsState = (app: App): ToolSpec =>
    readTool({
        name: 'mechanics_state',
        description:
            "The user's game mechanics (stats, magic, reputation, money, skills…): definitions visible in this chat (attributes, holders, tracking mode, checks with dice and trigger words), current values (all holders or one), recent changes, checks rolled and threshold events, and their flags for conditional preset blocks.",
        parameters: objectSchema({
            holder: prop.string('Only this holder (character, persona, faction or "world").'),
        }),
        available: needsApi('mechanics'),
        async run(rawArgs, ctx) {
            const api = apiOf<MechanicsApi>(app, 'mechanics');
            if (!api) return notice(ctx, 'Mechanics are off.', 'Механики выключены.');
            const holderArg = strArg(argsOf(rawArgs), 'holder', 80);
            const holder = holderArg ? (findEntity(app, holderArg)?.name ?? holderArg) : undefined;
            const active = new Set(safely(() => api.active(), [] as MechanicDef[]).map((def) => def.id));
            const defs = safely(() => api.list(), [] as MechanicDef[]);
            const state = safely(() => api.state(holder), []);
            const flags = mechanicsFlags(api);
            return {
                data: compact({
                    mechanics: defs.slice(0, 10).map((def) => definitionView(def, active.has(def.id))),
                    state: capList(
                        state.map((row) => ({ mechanic: row.mechanicId, holder: row.holder, values: row.values })),
                        30,
                    ),
                    recentChanges: safely(() => api.history(10), []).map((change) =>
                        compact({
                            mechanic: change.mechanicId,
                            holder: change.holder,
                            attribute: change.attribute,
                            from: change.from,
                            to: change.to,
                            source: change.source,
                            message: change.messageIndex,
                            reason: change.reason ? cut(change.reason, 120) : undefined,
                        }),
                    ),
                    checks: safely(() => api.checks(5), []).map((check) => cut(check.text, 200)),
                    events: safely(() => api.events(5), []).map((event) => cut(event.text, 200)),
                    flags: flags.catalogue.length ? flags : undefined,
                }),
                untrusted: true,
                summary: say(
                    ctx,
                    `Mechanics: ${active.size} active of ${defs.length}`,
                    `Механики: активных ${active.size} из ${defs.length}`,
                ),
            };
        },
    });

/* ------------------------------------------------------------------ director_scene */

const directorScene = (app: App): ToolSpec =>
    readTool({
        name: 'director_scene',
        description:
            "The scene director: the scene type decided after the last turn (dialogue, combat, intimate, exploration, timeskip, social, drama) with confidence and who decided it, the user's override, a pending type change, the stall state (turns without change and why), the director's note prepared for the next generation and the recent notes, the one-shot flags it sets for the next generation (maestro_scene_<type>, length, explicit, language, picture moment) and its flag catalogue.",
        parameters: objectSchema(),
        available: needsApi('director'),
        async run(_rawArgs, ctx) {
            const api = apiOf<DirectorApi>(app, 'director');
            if (!api) return notice(ctx, 'The director is off.', 'Режиссёр выключен.');
            const scene = safely(() => api.scene(), null);
            const pending = safely(() => api.pending?.() ?? null, null);
            const suppressed = safely(() => api.suppressed?.() ?? null, null);
            const noteView = (note: {
                at: number;
                messageIndex: number;
                text: string;
                source: string;
                detail?: string;
            }) =>
                compact({
                    at: when(note.at),
                    message: note.messageIndex,
                    source: note.source,
                    text: cut(note.text, 300),
                    detail: note.detail ? cut(note.detail, 160) : undefined,
                });
            return {
                data: compact({
                    scene,
                    override: safely(() => api.override?.() ?? null, null),
                    candidate: safely(() => api.candidate?.() ?? null, null),
                    stall: safely(() => api.stall(), undefined),
                    pendingNote: pending ? noteView(pending) : null,
                    suppressed: suppressed
                        ? { reason: suppressed.reason, message: suppressed.messageIndex }
                        : undefined,
                    notes: safely(() => api.notes(), [])
                        .slice(-3)
                        .map(noteView),
                    flags: safely(() => api.flags(), {}),
                    catalogue: safely(() => api.catalogue?.() ?? [], []).map((entry) => entry.name),
                }),
                untrusted: true,
                summary: scene
                    ? say(ctx, `Scene: ${scene.type}`, `Сцена: ${scene.type}`)
                    : say(ctx, 'Scene not decided yet', 'Тип сцены ещё не определён'),
            };
        },
    });

/* ------------------------------------------------------------------ preset_blocks */

/** `power_user.experimental_macro_engine`: {{if}} works only with the new engine. */
function macroEngine(app: App): 'on' | 'off' | 'unknown' {
    const value = safely(() => app.host.ctx().powerUserSettings?.experimental_macro_engine, undefined);
    return value === true ? 'on' : value === false ? 'off' : 'unknown';
}

const presetBlocks = (app: App): ToolSpec =>
    readTool({
        name: 'preset_blocks',
        description:
            "Blocks of the active Chat Completion preset in prompt order (Preset Studio): identifier, name, on/off, role, marker, in-chat depth, size, and the condition of conditional blocks ({{if .maestro_<flag>}} «only when» / {{if !.flag}} «except when», or flags used inside); plus the flag catalogue (director, mechanics, the preset's own), the flags set now, the macro engine state (needed for {{if}}) and unsaved edits. `query` filters blocks and shows a text preview.",
        parameters: objectSchema({
            query: prop.string('Only blocks whose name, identifier or text contains this; previews their text.'),
            conditional_only: prop.boolean('Only blocks with a condition or flags (default false).'),
        }),
        available: needsApi('presetStore'),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const store = apiOf<PresetStore>(app, 'presetStore');
            if (!store) return notice(ctx, 'The Preset Studio is off.', 'Пресет-студия выключена.');
            const query = strArg(args, 'query', 120);
            const wanted = query ? normalizeText(query) : '';
            const conditionalOnly = boolArg(args, 'conditional_only', false);
            const presetFlags = new Set<string>();
            const rows: Dict[] = [];
            for (const { item, prompt } of safely(() => store.prompts(), [])) {
                if (!prompt) continue;
                const text = promptText(prompt);
                const condition = blockCondition(text);
                const uses = flagUses(text).map((use) => (use.negated && !use.plain ? `!${use.name}` : use.name));
                for (const use of flagUses(text)) presetFlags.add(use.name);
                if (conditionalOnly && !condition && !uses.length) continue;
                const name = promptName(prompt);
                if (wanted && !normalizeText(`${name} ${prompt.identifier} ${text}`).includes(wanted)) {
                    continue;
                }
                rows.push(
                    compact({
                        id: prompt.identifier,
                        name: cut(name, 80),
                        on: item.enabled,
                        role: isMarker(prompt) ? undefined : promptRole(prompt),
                        marker: isMarker(prompt) || undefined,
                        depth: isInChat(prompt) ? promptDepth(prompt) : undefined,
                        chars: isMarker(prompt) ? undefined : text.length,
                        condition: condition
                            ? `${condition.negate ? 'except when' : 'only when'} ${condition.flag}`
                            : undefined,
                        flags: !condition && uses.length ? uses : undefined,
                        preview: wanted && !isMarker(prompt) ? cut(text, 300) : undefined,
                    }),
                );
            }
            const list = capList(rows, 60);
            const director = apiOf<DirectorApi>(app, 'director');
            const mechanics = mechanicsFlags(apiOf<unknown>(app, 'mechanics'));
            const directorCatalogue = safely(() => director?.catalogue?.() ?? [], []).map((entry) => entry.name);
            const draft = safely(() => store.draft(), null);
            return {
                data: compact({
                    preset: safely(() => store.current(), undefined),
                    unsaved: draft?.dirty || undefined,
                    macroEngine: macroEngine(app),
                    blocks: list.items,
                    total: list.total,
                    flags: {
                        director: directorCatalogue,
                        mechanics: mechanics.catalogue,
                        preset: [...presetFlags],
                        nowSet: compact({
                            director: director ? safely(() => director.flags(), {}) : undefined,
                            mechanics: mechanics.on.length ? mechanics.on : undefined,
                        }),
                    },
                }),
                untrusted: true,
                summary: say(ctx, `Preset blocks: ${list.total}`, `Блоки пресета: ${list.total}`),
            };
        },
    });

export function playTools(app: App): ToolSpec[] {
    return [mechanicsState(app), directorScene(app), presetBlocks(app)];
}
