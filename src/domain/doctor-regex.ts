// Regex script inventory and checks of M5 «Доктор» (plan M5 пп. 8–10; research/parity-preset.md §7, des.md §5).
// ST's regex engine (extensions/regex/engine.js) applies a script when its placement matches and its mode fits the
// call: markdownOnly → display, promptOnly → outgoing prompt (and the WI scan), neither → the stored text at
// receive/edit time. World Info content is regexed only with `isPrompt: true`, so WI-placement scripts work only
// when they are promptOnly (world-info.js `getRegexedString(…, WORLD_INFO, {isPrompt: true})`).
// The checks here run scripts on fixed samples with our own port of the engine (no macros), so they are pure.
import { sample } from './doctor-types';
import type { DoctorIssue } from './doctor-types';

export type RegexType = 'global' | 'scoped' | 'preset';

/** ST's `regex_placement`. */
export const REGEX_PLACEMENT = {
    MD_DISPLAY: 0,
    USER_INPUT: 1,
    AI_OUTPUT: 2,
    SLASH_COMMAND: 3,
    WORLD_INFO: 5,
    REASONING: 6,
} as const;

export interface RegexScriptInfo {
    /** `<type>:<script id or index>` (unique within one inventory). */
    id: string;
    /** ST's own script id (uuid) when present. */
    scriptId: string;
    name: string;
    type: RegexType;
    /** Position within its type (ST applies global → preset → scoped, each in list order). */
    index: number;
    find: string;
    replace: string;
    trimStrings: string[];
    placement: number[];
    disabled: boolean;
    markdownOnly: boolean;
    promptOnly: boolean;
    runOnEdit: boolean;
    /** 0 none, 1 raw, 2 escaped macro substitution in the find pattern. */
    substituteRegex: number;
    minDepth: number | null;
    maxDepth: number | null;
    /** Scoped/preset scripts run only when ST allows them for this character/preset. Global: always true. */
    allowed: boolean;
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function depth(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

export function normalizeScript(raw: unknown, type: RegexType, index: number, allowed: boolean): RegexScriptInfo {
    const script = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {};
    const scriptId = str(script.id);
    return {
        id: `${type}:${scriptId || index}`,
        scriptId,
        name: str(script.scriptName),
        type,
        index,
        find: str(script.findRegex),
        replace: str(script.replaceString),
        trimStrings: Array.isArray(script.trimStrings)
            ? script.trimStrings.filter((item) => typeof item === 'string')
            : [],
        placement: Array.isArray(script.placement)
            ? script.placement.filter((item): item is number => typeof item === 'number')
            : [],
        disabled: script.disabled === true,
        markdownOnly: script.markdownOnly === true,
        promptOnly: script.promptOnly === true,
        runOnEdit: script.runOnEdit === true,
        substituteRegex:
            typeof script.substituteRegex === 'number' ? script.substituteRegex : Number(script.substituteRegex) || 0,
        minDepth: depth(script.minDepth),
        maxDepth: depth(script.maxDepth),
        allowed,
    };
}

/** Where a script acts: display only, prompt only, both of those, or the stored text ("edit"). */
export type RegexMode = 'display' | 'prompt' | 'displayAndPrompt' | 'edit';

export function regexMode(script: Pick<RegexScriptInfo, 'markdownOnly' | 'promptOnly'>): RegexMode {
    if (script.markdownOnly && script.promptOnly) return 'displayAndPrompt';
    if (script.markdownOnly) return 'display';
    if (script.promptOnly) return 'prompt';
    return 'edit';
}

/** Runs on the outgoing prompt (promptOnly, alone or with markdownOnly). */
function touchesPrompt(mode: RegexMode): boolean {
    return mode === 'prompt' || mode === 'displayAndPrompt';
}

/** ST's `regexFromString` (utils.js): `/pattern/flags` or a bare pattern; null when it does not compile. */
export function compileFind(input: string): RegExp | null {
    try {
        const match = /(\/?)(.+)\1([a-z]*)/i.exec(input);
        if (!match) return null;
        const flags = match[3] ?? '';
        if (flags && !/^(?!.*?(.).*?\1)[gmixXsuUAJ]+$/.test(flags)) return new RegExp(input);
        return new RegExp(match[2] ?? '', flags);
    } catch {
        return null;
    }
}

/** ST's `runRegexScript` without macro substitution: `{{match}}`, `$1`, `$<name>`, trim strings. */
export function simulateReplace(
    script: Pick<RegexScriptInfo, 'find' | 'replace' | 'trimStrings'>,
    text: string,
    compiled?: RegExp | null,
): string {
    const regex = compiled === undefined ? compileFind(script.find) : compiled;
    if (!regex || !text) return text;
    regex.lastIndex = 0;
    const template = script.replace.replace(/{{match}}/gi, '$0');
    return text.replace(regex, (...args: unknown[]) => {
        const groups = args[args.length - 1];
        return template.replace(/\$(\d+)|\$<([^>]+)>/g, (_whole, num: string | undefined, name: string | undefined) => {
            let value: unknown;
            if (num) value = args[Number(num)];
            else if (name && groups && typeof groups === 'object') value = (groups as Record<string, unknown>)[name];
            if (typeof value !== 'string' || !value) return '';
            let filtered = value;
            for (const trim of script.trimStrings) if (trim) filtered = filtered.split(trim).join('');
            return filtered;
        });
    });
}

/** True when the script finds anything in one of the texts. */
export function firesOn(regex: RegExp, texts: readonly string[]): boolean {
    return texts.some((text) => {
        regex.lastIndex = 0;
        return regex.test(text);
    });
}

/* ------------------------------------------------------------------ owners */

/** The three scripts DES installs on every start (research/des.md §5). */
export const DES_SCRIPT_NAMES: readonly string[] = [
    "Doom's Character Tracker - Remove Tracker JSON (Together Mode)",
    'Clean RPG Trackers (From Outgoing Prompt)',
    'Clean HTML (From Outgoing Prompt)',
];

/** Marinara's regex pack (v9 optional blocks and quote fixing). */
const MARINARA_NAME_RES: readonly RegExp[] = [
    /marinara|spaghetti/i,
    /^\s*Format (?:User'?s Stats|Info Box|Character'?s? Thoughts)\b/i,
    /^\s*Fix Double Quotation/i,
];

/** Best-effort owner: des, marinara, rpgCompanion, horae, rm, user (global) or unknown (card or preset). */
export function guessOwner(
    script: Pick<RegexScriptInfo, 'name' | 'type'>,
    context: { presetIsMarinara?: boolean } = {},
): string {
    const name = script.name;
    if (DES_SCRIPT_NAMES.includes(name) || /^\s*doom'?s\b/i.test(name)) return 'des';
    if (/^\s*\[RM\]/i.test(name)) return 'rm';
    if (/horae/i.test(name)) return 'horae';
    if (/rpg[\s_-]*companion/i.test(name)) return 'rpgCompanion';
    if (MARINARA_NAME_RES.some((re) => re.test(name))) return 'marinara';
    if (script.type === 'preset' && context.presetIsMarinara) return 'marinara';
    return script.type === 'global' ? 'user' : 'unknown';
}

/* ------------------------------------------------------------------ probes */

/** BunnyMo tags as they appear in chat and sheets. */
export const TAG_SAMPLE = 'Анна кивнула. <SPECIES:ELF> <DERE:TSUNDERE> <ESFP-H>';
const TAG_PROBES = ['<SPECIES:ELF>', '<ESFP-H>'];

/** A DES together-mode reply: fenced tracker JSON with typographic quotes inside a string value. */
export const JSON_SAMPLE = [
    '```json',
    '{"characters":[{"name":"Анна","thoughts":"Она сказала «привет» и “ушла”."}],"infoBox":{"location":"Таверна"}}',
    '```',
    'Анна улыбнулась.',
].join('\n');

/** NAI Studio picture markers: the raw marker the model writes and the placeholder NAI leaves in `mes`. */
export const MARKER_SAMPLE = 'Анна улыбнулась. [nai:img:abc123] <img data-nai=\'{"prompt":"1girl, smile"}\'>';
const MARKER_PROBES = ['[nai:img:abc123]', '<img data-nai=\'{"prompt":"1girl, smile"}\'>'];

/** The script removes or changes BunnyMo tags. */
export function probeStripsTags(script: RegexScriptInfo, regex: RegExp): boolean {
    const out = simulateReplace(script, TAG_SAMPLE, regex);
    return TAG_PROBES.some((tag) => !out.includes(tag));
}

function fencedJson(text: string): string | null {
    return /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1] ?? null;
}

function parses(json: string | null): boolean {
    if (json === null) return false;
    try {
        JSON.parse(json);
        return true;
    } catch {
        return false;
    }
}

/** The script breaks the tracker JSON (or removes it) in a reply; `example` shows the damaged spot. */
export function probeBreaksJson(script: RegexScriptInfo, regex: RegExp): { broken: boolean; example: string } {
    const out = simulateReplace(script, JSON_SAMPLE, regex);
    const json = fencedJson(out);
    if (parses(json)) return { broken: false, example: '' };
    if (json === null) return { broken: true, example: '' };
    const before = fencedJson(JSON_SAMPLE) ?? '';
    let at = 0;
    while (at < json.length && json[at] === before[at]) at++;
    const start = Math.max(0, at - 25);
    return { broken: true, example: `…${json.slice(start, at + 25)}…` };
}

/** The script changes NAI Studio markers. */
export function probeBreaksMarkers(script: RegexScriptInfo, regex: RegExp): boolean {
    const out = simulateReplace(script, MARKER_SAMPLE, regex);
    return MARKER_PROBES.some((marker) => !out.includes(marker));
}

/* ------------------------------------------------------------------ checks */

export interface ChatTexts {
    user: string[];
    ai: string[];
    reasoning: string[];
    /** Messages looked at. */
    checked: number;
}

export interface RegexCheckContext {
    /** BunnyMo is in use (tags matter). */
    bunnymo: boolean;
    /** DES state: tracker JSON lives in replies in 'together' mode. */
    des: 'off' | 'on' | 'together';
    /** NAI Studio is in use (markers matter). */
    nai: boolean;
    /** Recent messages of this chat (dead-script check); omitted → no dead check. */
    chat?: ChatTexts;
    /** Contents of active lore entries (WI-placement scripts). */
    lore?: string[];
    /** At least this many messages are needed before calling a script dead (default 10). */
    minMessages?: number;
}

function regexTarget(scripts: readonly RegexScriptInfo[]): Record<string, unknown> {
    return { scripts: scripts.map((script) => ({ id: script.id, name: script.name, type: script.type })) };
}

function label(script: RegexScriptInfo): string {
    return script.name || script.id;
}

function overlaps(a: readonly number[], b: readonly number[]): boolean {
    return a.some((item) => b.includes(item));
}

/** Probes, duplicates, conflicts, dead and not-allowed scripts. Inactive (disabled) scripts are skipped. */
export function findRegexIssues(scripts: readonly RegexScriptInfo[], context: RegexCheckContext): DoctorIssue[] {
    const issues: DoctorIssue[] = [];
    const notAllowed = new Map<RegexType, RegexScriptInfo[]>();
    const active: { script: RegexScriptInfo; regex: RegExp; mode: RegexMode }[] = [];
    for (const script of scripts) {
        if (script.disabled || !script.find) continue;
        if (!script.allowed) {
            const list = notAllowed.get(script.type) ?? [];
            list.push(script);
            notAllowed.set(script.type, list);
            continue;
        }
        const regex = compileFind(script.find);
        if (!regex) {
            issues.push({
                kind: 'regex.dead',
                severity: 'warn',
                messageKey: 'm5.f.regexInvalid',
                params: { name: label(script), type: script.type },
                target: regexTarget([script]),
            });
            continue;
        }
        active.push({ script, regex, mode: regexMode(script) });
    }
    for (const [type, list] of notAllowed) {
        issues.push({
            kind: 'regex.dead',
            severity: 'info',
            messageKey: `m5.f.regexNotAllowed.${type}`,
            params: { type, count: list.length, sample: sample(list.map(label)) },
            target: regexTarget(list),
        });
    }

    for (const { script, regex, mode } of active) {
        const chatPlacement = script.placement.some(
            (place) => place === REGEX_PLACEMENT.USER_INPUT || place === REGEX_PLACEMENT.AI_OUTPUT,
        );
        const aiEdit = mode === 'edit' && script.placement.includes(REGEX_PLACEMENT.AI_OUTPUT);
        if (context.bunnymo && chatPlacement && mode !== 'display' && probeStripsTags(script, regex)) {
            issues.push({
                kind: 'regex.stripsTags',
                severity: 'warn',
                messageKey: mode === 'edit' ? 'm5.f.stripsTagsStored' : 'm5.f.stripsTagsPrompt',
                params: { name: label(script), type: script.type },
                target: regexTarget([script]),
            });
        }
        if (context.des !== 'off' && aiEdit) {
            const probe = probeBreaksJson(script, regex);
            if (probe.broken) {
                issues.push({
                    kind: 'regex.breaksJson',
                    severity: context.des === 'together' ? 'error' : 'warn',
                    messageKey: probe.example ? 'm5.f.breaksJson' : 'm5.f.removesJson',
                    params: { name: label(script), type: script.type, example: probe.example },
                    target: regexTarget([script]),
                });
            }
        }
        if (context.nai && aiEdit && probeBreaksMarkers(script, regex)) {
            issues.push({
                kind: 'regex.breaksMarkers',
                severity: 'warn',
                messageKey: 'm5.f.breaksMarkers',
                params: { name: label(script), type: script.type },
                target: regexTarget([script]),
            });
        }
        if (script.placement.includes(REGEX_PLACEMENT.WORLD_INFO) && !touchesPrompt(mode)) {
            issues.push({
                kind: 'regex.dead',
                severity: 'warn',
                messageKey: 'm5.f.regexWorldInfoNotPrompt',
                params: { name: label(script), type: script.type },
                target: regexTarget([script]),
            });
        }
    }

    // Same pattern twice in the same mode and place: duplicate work, or the first one leaves nothing to the second.
    const seen = new Set<number>();
    active.forEach((first, i) => {
        if (seen.has(i)) return;
        const group = [first];
        active.forEach((other, j) => {
            if (j <= i || seen.has(j)) return;
            if (other.script.find.trim() !== first.script.find.trim() || other.mode !== first.mode) return;
            if (!overlaps(other.script.placement, first.script.placement)) return;
            group.push(other);
            seen.add(j);
        });
        if (group.length < 2) return;
        const second = group[1] as (typeof group)[number];
        const same = group.every(
            (item) =>
                item.script.replace === first.script.replace &&
                item.script.trimStrings.join('\n') === first.script.trimStrings.join('\n'),
        );
        issues.push({
            kind: same ? 'regex.duplicate' : 'regex.conflict',
            severity: same ? 'info' : 'warn',
            messageKey: same ? 'm5.f.regexDuplicate' : 'm5.f.regexConflict',
            params: { a: label(first.script), b: label(second.script), count: group.length },
            target: regexTarget(group.map((item) => item.script)),
        });
    });

    // "Did not fire in this chat": only scripts that run on the stored text each time (display/prompt) can be
    // judged from history; edit-time scripts already rewrote what they matched.
    const chat = context.chat;
    if (chat && chat.checked >= (context.minMessages ?? 10)) {
        for (const { script, regex, mode } of active) {
            if (mode === 'edit') continue;
            const texts: string[] = [];
            let judged = false;
            if (script.placement.includes(REGEX_PLACEMENT.USER_INPUT)) texts.push(...chat.user);
            if (script.placement.includes(REGEX_PLACEMENT.AI_OUTPUT)) texts.push(...chat.ai);
            if (script.placement.includes(REGEX_PLACEMENT.REASONING)) texts.push(...chat.reasoning);
            if (texts.length) judged = true;
            if (script.placement.includes(REGEX_PLACEMENT.WORLD_INFO) && touchesPrompt(mode) && context.lore) {
                texts.push(...context.lore);
                judged = true;
            }
            if (!judged || firesOn(regex, texts)) continue;
            issues.push({
                kind: 'regex.dead',
                severity: 'info',
                messageKey: 'm5.f.regexDead',
                params: { name: label(script), type: script.type, count: chat.checked },
                target: regexTarget([script]),
            });
        }
    }
    return issues;
}
