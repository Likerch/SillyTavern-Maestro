// What ST feeds its World Info scan, rebuilt for dry runs and key attribution the way Generate does it
// (script.js:4496-4635, research/st-world-info.md §2): `chatForWI` (non-system messages, regexed, "Name: text"
// when world_info_include_names, newest first), the card fields of `globalScanData`, and `getMaxPromptTokens()`.
import type { GlobalMatchSettings, GlobalScanText } from '../../domain/lore-match';
import type { App } from '../../shared/contracts';

/** The parts of world-info.js M1 reads (live `export let` bindings: read through the namespace each time). */
export interface WorldInfoModule {
    checkWorldInfo?: (
        chat: string[],
        maxContext: number,
        isDryRun: boolean,
        globalScanData?: unknown,
    ) => Promise<unknown>;
    parseRegexFromString?: (input: string) => RegExp | null;
    selected_world_info?: unknown;
    world_info?: unknown;
    world_info_depth?: unknown;
    world_info_include_names?: unknown;
    world_info_case_sensitive?: unknown;
    world_info_match_whole_words?: unknown;
}

type RegexFn = (text: string, placement: number, options: { isPrompt: boolean; depth: number }) => string;

/** extensions/regex/engine.js `regex_placement`. */
const PLACEMENT = { USER_INPUT: 1, AI_OUTPUT: 2 } as const;

export interface CardFields extends GlobalScanText {
    trigger: string;
}

interface StCardFields {
    persona?: unknown;
    description?: unknown;
    personality?: unknown;
    charDepthPrompt?: unknown;
    scenario?: unknown;
    creatorNotes?: unknown;
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

export async function loadWorldInfo(app: App): Promise<WorldInfoModule | null> {
    try {
        return (await app.host.modules.worldInfo()) as WorldInfoModule;
    } catch {
        return null;
    }
}

export function matchGlobals(wi: WorldInfoModule | null): GlobalMatchSettings {
    return {
        caseSensitive: wi?.world_info_case_sensitive === true,
        matchWholeWords: wi?.world_info_match_whole_words === true,
    };
}

export function globalDepth(wi: WorldInfoModule | null): number {
    const depth = Number(wi?.world_info_depth);
    return Number.isFinite(depth) && depth >= 0 ? depth : 2;
}

/** ST's regex engine for prompt-time scripts, when the regex extension is available. */
async function regexEngine(app: App): Promise<RegexFn | null> {
    if (!app.host.caps.has('st.regex')) return null;
    try {
        const engine = await app.host.modules.regexEngine();
        const fn = engine.getRegexedString;
        return typeof fn === 'function' ? (fn as RegexFn) : null;
    } catch {
        return null;
    }
}

/**
 * `chatForWI` of the messages before `end` (exclusive), newest first. Without the regex engine the raw text is
 * used (a dry run then may differ from the real scan for chats with prompt-only regex scripts).
 */
export async function chatForWI(app: App, wi: WorldInfoModule | null, end?: number): Promise<string[]> {
    const chat = app.host.ctx().chat ?? [];
    const core = chat.slice(0, end ?? chat.length).filter((message) => message && !message.is_system);
    const regex = await regexEngine(app);
    const includeNames = wi?.world_info_include_names !== false;
    return core
        .map((message, index) => {
            let mes = text(message.mes);
            if (regex) {
                try {
                    mes = regex(mes, message.is_user ? PLACEMENT.USER_INPUT : PLACEMENT.AI_OUTPUT, {
                        isPrompt: true,
                        depth: core.length - index - 1,
                    });
                } catch {
                    // keep the raw text
                }
            }
            return includeNames ? `${text(message.name)}: ${mes}` : mes;
        })
        .reverse();
}

/** `globalScanData` of Generate (script.js:4626-4634). */
export function cardFields(app: App, trigger = 'normal'): CardFields {
    let fields: StCardFields = {};
    try {
        const getter = (app.host.ctx() as unknown as { getCharacterCardFields?: () => StCardFields })
            .getCharacterCardFields;
        if (typeof getter === 'function') fields = getter() ?? {};
    } catch {
        fields = {};
    }
    return {
        personaDescription: text(fields.persona),
        characterDescription: text(fields.description),
        characterPersonality: text(fields.personality),
        characterDepthPrompt: text(fields.charDepthPrompt),
        scenario: text(fields.scenario),
        creatorNotes: text(fields.creatorNotes),
        trigger,
    };
}

/** `getMaxPromptTokens()` (script.js:5981), else ST's max context, else a conservative default. */
export async function maxPromptTokens(app: App): Promise<number> {
    try {
        const script = await app.host.modules.script();
        const fn = script.getMaxPromptTokens;
        if (typeof fn === 'function') {
            const value = Number((fn as () => unknown)());
            if (Number.isFinite(value) && value > 0) return value;
        }
    } catch {
        // fall through
    }
    const context = Number((app.host.ctx() as unknown as { maxContext?: unknown }).maxContext);
    return Number.isFinite(context) && context > 0 ? context : 8192;
}

/** Extension prompts with `scan: true` (they are part of every entry's scan text, WI:4719-4726). */
export function scanInjects(app: App): string[] {
    const prompts = app.host.ctx().extensionPrompts ?? {};
    return Object.values(prompts)
        .filter((prompt) => prompt && prompt.scan === true && typeof prompt.value === 'string' && prompt.value)
        .map((prompt) => prompt.value);
}
