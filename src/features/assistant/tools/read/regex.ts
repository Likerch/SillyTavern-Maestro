// Read tools over SillyTavern's regex scripts (M33: «что делает этот регекс?», «регексы с испытанием»): the inventory
// (the Doctor's, else read from the settings), a plain-words explanation of a pattern and a test run with ST's
// replacement semantics (plus ST's own engine through the Doctor when it is on). Patterns, replacements and samples
// may come from presets, cards or the chat: untrusted.
import { RUN_NOTE_TEXT, runRegex } from '../../../../domain/assistant-explain-regex-run';
import { explainRegex, splitPattern } from '../../../../domain/assistant-explain-regex';
import { normalizeScript, regexMode, REGEX_PLACEMENT } from '../../../../domain/doctor-regex';
import type { RegexMode, RegexType } from '../../../../domain/doctor-regex';
import type { App } from '../../../../shared/contracts';
import type { DoctorApi } from '../../../doctor/api';
import type { ToolContext, ToolSpec } from '../../api';
import {
    apiOf,
    argsOf,
    boolArg,
    capList,
    compact,
    cut,
    enumArg,
    isDict,
    notice,
    objectSchema,
    prop,
    rawArg,
    readTool,
    safely,
    say,
    strArg,
    withTimeout,
} from './common';
import type { Dict } from './common';

export interface ScriptView {
    id: string;
    name: string;
    type: RegexType;
    disabled: boolean;
    allowed: boolean;
    placement: number[];
    mode: RegexMode;
    find: string;
    replace: string;
    trimStrings?: string[];
    owner?: string;
    minDepth?: number | null;
    maxDepth?: number | null;
}

const PLACEMENT_NAMES: Record<number, string> = {
    [REGEX_PLACEMENT.MD_DISPLAY]: 'markdown display (legacy)',
    [REGEX_PLACEMENT.USER_INPUT]: 'user input',
    [REGEX_PLACEMENT.AI_OUTPUT]: 'AI output',
    [REGEX_PLACEMENT.SLASH_COMMAND]: 'slash commands',
    [REGEX_PLACEMENT.WORLD_INFO]: 'world info',
    [REGEX_PLACEMENT.REASONING]: 'reasoning',
};

const MODE_TEXT: Record<'en' | 'ru', Record<RegexMode, string>> = {
    en: {
        display: 'changes only what you see on screen (the stored text and the prompt stay as they are)',
        prompt: 'changes only the outgoing prompt (and the lore scan), not what you see or the stored text',
        displayAndPrompt: 'changes what you see and the outgoing prompt, not the stored text',
        edit: 'rewrites the stored message text itself when the message arrives or is edited',
    },
    ru: {
        display: 'меняет только то, что видно на экране (сам текст и промпт не трогает)',
        prompt: 'меняет только уходящий промпт (и сканирование лора), а не то, что видно, и не сам текст',
        displayAndPrompt: 'меняет то, что видно, и уходящий промпт, но не сам текст',
        edit: 'переписывает сам текст сообщения, когда оно приходит или правится',
    },
};

const TYPES: readonly RegexType[] = ['global', 'preset', 'scoped'];

/** Scripts read from the settings (when the Doctor is off): global → preset → scoped, like ST runs them. */
function scriptsFromSettings(app: App): ScriptView[] {
    const ctx = safely(() => app.host.ctx(), null);
    if (!ctx) return [];
    const settings = ctx.extensionSettings ?? {};
    const character = ctx.characterId === undefined ? undefined : ctx.characters?.[Number(ctx.characterId)];
    const preset = (ctx as unknown as { chatCompletionSettings?: Dict }).chatCompletionSettings;
    const presetScripts = isDict(preset?.extensions) ? preset.extensions.regex_scripts : undefined;
    const allowedChars = settings.character_allowed_regex;
    const allowedPresets = isDict(settings.preset_allowed_regex) ? settings.preset_allowed_regex.openai : undefined;
    const lists: Record<RegexType, { list: unknown; allowed: boolean }> = {
        global: { list: settings.regex, allowed: true },
        preset: {
            list: presetScripts,
            allowed: Array.isArray(allowedPresets) && allowedPresets.includes(preset?.preset_settings_openai),
        },
        scoped: {
            list: character?.data?.extensions?.regex_scripts,
            allowed: Array.isArray(allowedChars) && !!character && allowedChars.includes(character.avatar),
        },
    };
    const views: ScriptView[] = [];
    for (const type of TYPES) {
        const { list, allowed } = lists[type];
        if (!Array.isArray(list)) continue;
        list.forEach((raw, index) => {
            const script = normalizeScript(raw, type, index, allowed);
            views.push({
                id: script.id,
                name: script.name,
                type,
                disabled: script.disabled,
                allowed: script.allowed,
                placement: script.placement,
                mode: regexMode(script),
                find: script.find,
                replace: script.replace,
                trimStrings: script.trimStrings,
                minDepth: script.minDepth,
                maxDepth: script.maxDepth,
            });
        });
    }
    return views;
}

/** Every regex script: the Doctor's inventory when it runs (trim strings from the settings), else the settings. */
export async function regexScripts(app: App): Promise<ScriptView[]> {
    const fromSettings = scriptsFromSettings(app);
    const doctor = apiOf<DoctorApi>(app, 'doctor');
    if (!doctor) return fromSettings;
    const inventory = await withTimeout(doctor.regexInventory(), 4000, null);
    if (!inventory) return fromSettings;
    const trims = new Map(fromSettings.map((script) => [script.id, script.trimStrings]));
    return inventory.map((info) =>
        compact({
            id: info.id,
            name: info.name,
            type: info.type,
            disabled: info.disabled,
            allowed: info.allowed !== false,
            placement: info.placement,
            mode: regexMode(info),
            find: info.find ?? '',
            replace: info.replace ?? '',
            trimStrings: trims.get(info.id),
            owner: info.owner,
            minDepth: info.minDepth,
            maxDepth: info.maxDepth,
        }),
    );
}

/** A script by inventory id, ST id or name (case-insensitive). */
export function findScript(scripts: readonly ScriptView[], wanted: string): ScriptView | undefined {
    const lower = wanted.toLowerCase();
    return (
        scripts.find((script) => script.id === wanted) ??
        scripts.find((script) => script.id.toLowerCase().endsWith(`:${lower}`)) ??
        scripts.find((script) => script.name.toLowerCase() === lower) ??
        scripts.find((script) => script.name.toLowerCase().includes(lower))
    );
}

function placementNames(placement: readonly number[]): string[] {
    return placement.map((code) => PLACEMENT_NAMES[code] ?? String(code));
}

const regexList = (app: App): ToolSpec =>
    readTool({
        name: 'regex_list',
        description:
            "SillyTavern's regex scripts in run order (global → preset → scoped): id, name, type, on/off, allowed for this character/preset, where they run (placement), what they change (display / prompt / the stored text), depth limits, find pattern and replace string (cut), plus the Doctor's findings about them (breaks DES JSON or NAI markers, strips BunnyMo tags, duplicate, dead, conflict).",
        parameters: objectSchema({
            type: prop.enum('Only this type.', TYPES),
            include_disabled: prop.boolean('Include switched-off scripts (default true).'),
            query: prop.string('Only scripts whose name or pattern contains this text.'),
        }),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const type = enumArg(args, 'type', TYPES);
            const query = strArg(args, 'query', 100)?.toLowerCase();
            let scripts = await regexScripts(app);
            if (type) scripts = scripts.filter((script) => script.type === type);
            if (!boolArg(args, 'include_disabled', true)) scripts = scripts.filter((script) => !script.disabled);
            if (query) {
                scripts = scripts.filter(
                    (script) => script.name.toLowerCase().includes(query) || script.find.toLowerCase().includes(query),
                );
            }
            const list = capList(
                scripts.map((script) =>
                    compact({
                        id: script.id,
                        name: cut(script.name, 80),
                        type: script.type,
                        disabled: script.disabled || undefined,
                        allowed: script.allowed ? undefined : false,
                        placement: placementNames(script.placement),
                        mode: script.mode,
                        depth:
                            script.minDepth != null || script.maxDepth != null
                                ? [script.minDepth ?? null, script.maxDepth ?? null]
                                : undefined,
                        owner: script.owner && script.owner !== 'unknown' ? script.owner : undefined,
                        find: cut(script.find, 160),
                        replace: cut(script.replace, 100),
                    }),
                ),
                60,
            );
            const doctor = apiOf<DoctorApi>(app, 'doctor');
            const findings = doctor
                ? safely(() => doctor.findings(), [])
                      .filter((finding) => finding.kind.startsWith('regex.'))
                      .slice(0, 20)
                      .map((finding) =>
                          compact({
                              kind: finding.kind,
                              severity: finding.severity,
                              script:
                                  typeof finding.target.name === 'string'
                                      ? finding.target.name
                                      : typeof finding.target.id === 'string'
                                        ? finding.target.id
                                        : undefined,
                              text: cut(
                                  safely(() => app.i18n.t(finding.messageKey, finding.params), ''),
                                  200,
                              ),
                          }),
                      )
                : [];
            const extensionOff = safely(() => {
                const disabled = app.host.ctx().extensionSettings.disabledExtensions;
                return Array.isArray(disabled) && disabled.includes('regex');
            }, false);
            return {
                data: compact({
                    scripts: list.items,
                    total: list.total,
                    findings: findings.length ? findings : undefined,
                    regexExtensionOff: extensionOff || undefined,
                    modes: MODE_TEXT[ctx.locale],
                }),
                untrusted: true,
                summary: say(
                    ctx,
                    `Regexes: ${list.total}${findings.length ? `, ${findings.length} findings` : ''}`,
                    `Регексы: ${list.total}${findings.length ? `, находок: ${findings.length}` : ''}`,
                ),
            };
        },
    });

const regexExplain = (app: App): ToolSpec =>
    readTool({
        name: 'regex_explain',
        description:
            'Explain a regular expression in plain words (groups, classes, quantifiers, anchors, look-arounds, flags) with pitfalls (\\w and \\b do not know Cyrillic, no g flag, Cyrillic ranges missing Yo, greedy .*, nested repetition). Give `script` (id or name from regex_list) to explain a stored script, including where it runs and what it changes, or `pattern` (`/source/flags` or a bare source with `flags`).',
        parameters: objectSchema({
            script: prop.string('Script id or name from regex_list.'),
            pattern: prop.string('A pattern: "/source/flags" or a bare source.'),
            flags: prop.string('Flags for a bare source (e.g. "gi").'),
        }),
        async run(rawArgs, ctx: ToolContext) {
            const args = argsOf(rawArgs);
            const scriptName = strArg(args, 'script', 200);
            const pattern = rawArg(args, 'pattern', 2000);
            let script: ScriptView | undefined;
            let input: { source: string; flags: string };
            if (scriptName) {
                script = findScript(await regexScripts(app), scriptName);
                if (!script) return notice(ctx, `No regex script «${scriptName}».`, `Нет регекса «${scriptName}».`);
                input = splitPattern(script.find);
            } else if (pattern) {
                input = splitPattern(pattern, strArg(args, 'flags', 10));
            } else {
                return notice(ctx, 'Give a script or a pattern.', 'Нужен скрипт или шаблон.');
            }
            const explanation = explainRegex(input.source, input.flags, ctx.locale);
            const data: Dict = { ...explanation };
            if (script) {
                data.script = compact({
                    id: script.id,
                    name: script.name,
                    type: script.type,
                    disabled: script.disabled || undefined,
                    allowed: script.allowed ? undefined : false,
                    placement: placementNames(script.placement),
                    changes: MODE_TEXT[ctx.locale][script.mode],
                    replace: cut(script.replace, 300),
                    trimStrings: script.trimStrings?.length ? script.trimStrings.slice(0, 10) : undefined,
                });
            }
            return {
                data: compact(data),
                untrusted: true,
                summary: explanation.ok
                    ? say(
                          ctx,
                          `Regex explained${script ? `: ${cut(script.name, 40)}` : ''}`,
                          `Регекс разобран${script ? `: ${cut(script.name, 40)}` : ''}`,
                      )
                    : say(ctx, 'The pattern does not compile', 'Шаблон не компилируется'),
            };
        },
    });

const regexTest = (app: App): ToolSpec =>
    readTool({
        name: 'regex_test',
        description:
            "Test a find/replace on a sample text with SillyTavern's semantics: {{match}} and $0 = the whole match, $1… and $<name> = groups (empty when missing), trim strings removed from groups, {{user}}/{{char}} filled, $& and $' NOT expanded; a pattern without the g flag replaces only the first match. Returns the matches with groups and the result. Give `script` (id or name) to test a stored script (also run through ST's own engine when available), or `pattern` with optional `flags` and `replacement`.",
        parameters: objectSchema(
            {
                sample: prop.string('Text to run on (up to 4000 characters).'),
                script: prop.string('Script id or name from regex_list.'),
                pattern: prop.string('A pattern: "/source/flags" (ST style) or a bare source.'),
                flags: prop.string('Flags for a bare source; when given, `pattern` is taken as the bare source.'),
                replacement: prop.string("Replace string (default: the script's; omit to only list matches)."),
            },
            ['sample'],
        ),
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const sample = rawArg(args, 'sample', 4000);
            if (sample === undefined) return notice(ctx, 'Give a sample text.', 'Нужен пример текста.');
            const scriptName = strArg(args, 'script', 200);
            let script: ScriptView | undefined;
            if (scriptName) {
                script = findScript(await regexScripts(app), scriptName);
                if (!script) return notice(ctx, `No regex script «${scriptName}».`, `Нет регекса «${scriptName}».`);
            }
            const pattern = script?.find ?? rawArg(args, 'pattern', 2000);
            if (!pattern) return notice(ctx, 'Give a script or a pattern.', 'Нужен скрипт или шаблон.');
            const replacement = rawArg(args, 'replacement', 2000) ?? script?.replace;
            const host = safely(() => app.host.ctx(), null);
            const macros: Record<string, string> = {};
            if (host?.name1) macros.user = host.name1;
            if (host?.name2) macros.char = host.name2;
            const flags = script ? undefined : strArg(args, 'flags', 10);
            const run = runRegex({
                pattern,
                ...(flags !== undefined ? { flags } : {}),
                ...(replacement !== undefined ? { replacement } : {}),
                sample,
                trimStrings: script?.trimStrings ?? [],
                macros,
            });
            const data: Dict = {
                ...run,
                result: run.result === undefined ? undefined : cut(run.result, 4000),
                notes: run.notes.map((note) => ({ code: note, text: RUN_NOTE_TEXT[ctx.locale][note] })),
            };
            if (script) {
                data.script = { id: script.id, name: script.name, disabled: script.disabled || undefined };
                const doctor = apiOf<DoctorApi>(app, 'doctor');
                if (doctor?.testRegex) {
                    const engine = await withTimeout(doctor.testRegex(script.id, sample), 4000, null);
                    if (engine !== null) data.engineResult = cut(engine, 4000);
                }
            }
            return {
                data: compact(data),
                untrusted: true,
                summary: run.ok
                    ? say(
                          ctx,
                          `Regex test: ${run.matchCount} matches${run.changed ? ', text changed' : ''}`,
                          `Испытание регекса: совпадений ${run.matchCount}${run.changed ? ', текст изменён' : ''}`,
                      )
                    : say(ctx, 'The pattern does not compile', 'Шаблон не компилируется'),
            };
        },
    });

export function regexTools(app: App): ToolSpec[] {
    return [regexList(app), regexExplain(app), regexTest(app)];
}
