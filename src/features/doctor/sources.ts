// What the doctor reads from SillyTavern: active lorebooks (through the BunnyMo adapter's book list and
// ctx.loadWorldInfo), global World Info settings (world-info.js), regex scripts by type (regex engine, with a
// read-only fallback over settings), recent chat texts and the lore journal summary. Read-only: nothing here writes.
import { adaptersOf } from '../../adapters';
import { readLocalizerMarker } from '../../adapters/localizer';
import { classifyWorlds } from '../../domain/bunnymo';
import { readWiSettings } from '../../domain/doctor-budget';
import type { LoreTurnsSummary, WiGlobalSettings } from '../../domain/doctor-budget';
import { normalizeScript } from '../../domain/doctor-regex';
import type { RegexScriptInfo, RegexType } from '../../domain/doctor-regex';
import { toDoctorEntry } from '../../domain/doctor-types';
import type { BunnyBookKind, DoctorEntry } from '../../domain/doctor-types';
import type { App, Logger } from '../../shared/contracts';
import type { LoreJournalApi } from '../loreJournal/api';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Context members of ST 1.19 that global.d.ts does not declare. */
interface CtxExtras {
    maxContext?: number;
    chatCompletionSettings?: Dict;
    loadWorldInfo?: (name: string) => Promise<unknown>;
}

function extras(app: App): CtxExtras {
    return app.host.ctx() as unknown as CtxExtras;
}

export interface LoreSnapshot {
    books: string[];
    entries: DoctorEntry[];
    bunnyBooks: Map<string, BunnyBookKind>;
}

/** Names of the books ST scans in this chat (global, chat, persona, character books). */
export async function activeBookNames(app: App, log: Logger): Promise<string[]> {
    try {
        return await adaptersOf(app).bunnymo.activeBooks();
    } catch (error) {
        log.warn('active books are not available', error);
        return [];
    }
}

/** Loads every active book (deep copies from ST's cache) and classifies BunnyMo books. */
export async function readLore(app: App, log: Logger): Promise<LoreSnapshot> {
    const books = await activeBookNames(app, log);
    const load = extras(app).loadWorldInfo;
    const entries: DoctorEntry[] = [];
    const loaded: string[] = [];
    if (typeof load === 'function') {
        for (const book of books) {
            let data: unknown;
            try {
                data = await load(book);
            } catch (error) {
                log.warn(`lorebook ${book} did not load`, error);
                continue;
            }
            if (!isDict(data) || !isDict(data.entries)) continue;
            loaded.push(book);
            for (const [uid, raw] of Object.entries(data.entries)) {
                if (!isDict(raw)) continue;
                const marker = readLocalizerMarker(raw);
                const added = marker
                    ? Object.values(marker.languages).flatMap((state) => [
                          ...state.added.key,
                          ...state.added.keysecondary,
                      ])
                    : [];
                entries.push(toDoctorEntry(book, raw, Number(uid) || 0, added));
            }
        }
    }
    const bunnyBooks = new Map<string, BunnyBookKind>();
    // The adapter's last classification of the active books plus the same heuristics over what we just loaded.
    try {
        const known = adaptersOf(app).bunnymo.books();
        for (const book of known.packs) bunnyBooks.set(book, 'pack');
        for (const book of known.core) bunnyBooks.set(book, 'core');
    } catch (error) {
        log.debug('BunnyMo classification is not available', error);
    }
    const classified = classifyWorlds(
        entries.map((entry) => ({
            key: entry.key,
            keysecondary: entry.keysecondary,
            comment: entry.comment,
            content: entry.content,
            world: entry.book,
        })),
    );
    for (const book of classified.packs) if (!bunnyBooks.has(book)) bunnyBooks.set(book, 'pack');
    for (const book of classified.core) bunnyBooks.set(book, 'core');
    return { books: loaded, entries, bunnyBooks };
}

/** Global World Info settings; null when world-info.js is not available. */
export async function readWorldInfoSettings(app: App, log: Logger): Promise<WiGlobalSettings | null> {
    try {
        const module = await app.host.modules.worldInfo();
        const getter = module.getWorldInfoSettings;
        const raw: unknown = typeof getter === 'function' ? (getter as () => unknown)() : module;
        return isDict(raw) ? readWiSettings(raw) : null;
    } catch (error) {
        log.debug('world-info.js is not available', error);
        return null;
    }
}

/** Context size the WI budget is computed from (Chat Completion: openai_max_context). */
export function maxContext(app: App): number | null {
    const ctx = extras(app);
    const value = app.host.isChatCompletion() ? ctx.chatCompletionSettings?.openai_max_context : ctx.maxContext;
    return typeof value === 'number' && value > 0 ? value : null;
}

export interface ChatSample {
    user: string[];
    ai: string[];
    reasoning: string[];
    checked: number;
    /** Newest last: `{index, text, isUser}` for the bench. */
    messages: { index: number; text: string; isUser: boolean; reasoning: string }[];
}

/** The last `limit` non-system messages of the chat. */
export function chatSample(app: App, limit = 200): ChatSample {
    const chat = app.host.ctx().chat ?? [];
    const sample: ChatSample = { user: [], ai: [], reasoning: [], checked: 0, messages: [] };
    for (let index = chat.length - 1; index >= 0 && sample.checked < limit; index--) {
        const message = chat[index];
        if (!message || message.is_system) continue;
        const text = typeof message.mes === 'string' ? message.mes : '';
        const reasoning = typeof message.extra?.reasoning === 'string' ? message.extra.reasoning : '';
        sample.checked += 1;
        (message.is_user ? sample.user : sample.ai).push(text);
        if (reasoning) sample.reasoning.push(reasoning);
        sample.messages.unshift({ index, text, isUser: message.is_user, reasoning });
    }
    return sample;
}

/** Journal of the last turns (M1), when it runs. */
export function loreTurns(app: App, turns = 30): LoreTurnsSummary | undefined {
    const journal = app.modules.api<LoreJournalApi>('loreJournal');
    if (!journal) return undefined;
    try {
        const records = journal.turns(turns).filter((record) => !record.simulated);
        if (!records.length) return undefined;
        return {
            turns: records.length,
            overflowTurns: records.filter((record) => record.overflow).length,
            cut: records.reduce(
                (sum, record) => sum + record.activations.filter((item) => item.cut && item.cutBy !== 'maestro').length,
                0,
            ),
        };
    } catch (error) {
        app.log.debug('lore journal is not available', error);
        return undefined;
    }
}

/* ------------------------------------------------------------------ regex scripts */

export interface RegexSnapshot {
    scripts: RegexScriptInfo[];
    /** The raw script objects by inventory id (the bench passes them to ST's engine). */
    raw: Map<string, Dict>;
    /** `extension_settings.disabledExtensions` includes 'regex'. */
    extensionOff: boolean;
    /** Read through ST's engine (otherwise from settings). */
    viaEngine: boolean;
}

/** ST applies global → preset → scoped (engine.js SCRIPT_TYPES order). */
const ORDER: readonly RegexType[] = ['global', 'preset', 'scoped'];
const DEFAULT_CODES: Record<RegexType, number> = { global: 0, preset: 2, scoped: 1 };

export async function regexEngine(app: App): Promise<Dict | null> {
    if (!app.host.caps.has('st.regex')) return null;
    try {
        return await app.host.modules.regexEngine();
    } catch {
        return null;
    }
}

function fallbackScripts(app: App): Record<RegexType, { list: unknown[]; allowed: boolean }> {
    const ctx = app.host.ctx();
    const settings = ctx.extensionSettings;
    const character = ctx.characterId === undefined ? undefined : ctx.characters[Number(ctx.characterId)];
    const scoped = character?.data?.extensions?.regex_scripts;
    const allowedChars = settings.character_allowed_regex;
    const preset = extras(app).chatCompletionSettings;
    const presetScripts = isDict(preset?.extensions) ? preset.extensions.regex_scripts : undefined;
    const presetName = preset?.preset_settings_openai;
    const allowedPresets = isDict(settings.preset_allowed_regex) ? settings.preset_allowed_regex.openai : undefined;
    return {
        global: { list: Array.isArray(settings.regex) ? settings.regex : [], allowed: true },
        preset: {
            list: app.host.isChatCompletion() && Array.isArray(presetScripts) ? presetScripts : [],
            allowed: Array.isArray(allowedPresets) && allowedPresets.includes(presetName),
        },
        scoped: {
            list: Array.isArray(scoped) ? scoped : [],
            allowed: Array.isArray(allowedChars) && !!character && allowedChars.includes(character.avatar),
        },
    };
}

/** Every regex script with its type and "allowed" state, in ST's execution order. */
export async function readRegexScripts(app: App, log: Logger): Promise<RegexSnapshot> {
    const engine = await regexEngine(app);
    const byType = engine?.getScriptsByType;
    const codes = isDict(engine?.SCRIPT_TYPES) ? (engine.SCRIPT_TYPES as Record<string, unknown>) : null;
    let lists: Record<RegexType, { list: unknown[]; allowed: boolean }>;
    let viaEngine = false;
    if (typeof byType === 'function') {
        const read = byType as (type: number, options: { allowedOnly: boolean }) => unknown;
        const code = (type: RegexType) => {
            const value = codes?.[type.toUpperCase()];
            return typeof value === 'number' ? value : DEFAULT_CODES[type];
        };
        try {
            lists = Object.fromEntries(
                ORDER.map((type) => {
                    const all = read(code(type), { allowedOnly: false });
                    const allowed = type === 'global' ? true : (read(code(type), { allowedOnly: true }) as unknown[]);
                    return [
                        type,
                        {
                            list: Array.isArray(all) ? all : [],
                            allowed: allowed === true || (Array.isArray(allowed) && allowed.length > 0),
                        },
                    ];
                }),
            ) as Record<RegexType, { list: unknown[]; allowed: boolean }>;
            viaEngine = true;
        } catch (error) {
            log.warn('regex engine failed; reading scripts from settings', error);
            lists = fallbackScripts(app);
        }
    } else {
        lists = fallbackScripts(app);
    }
    const scripts: RegexScriptInfo[] = [];
    const raw = new Map<string, Dict>();
    for (const type of ORDER) {
        const { list, allowed } = lists[type];
        list.forEach((item, index) => {
            const script = normalizeScript(item, type, index, allowed);
            scripts.push(script);
            if (isDict(item)) raw.set(script.id, item);
        });
    }
    const disabled = app.host.ctx().extensionSettings.disabledExtensions;
    return { scripts, raw, extensionOff: Array.isArray(disabled) && disabled.includes('regex'), viaEngine };
}

/** Runs one script through ST's `runRegexScript`; disabled scripts are run as if enabled. Null without the engine. */
export async function runRegexScript(app: App, script: Dict, text: string): Promise<string | null> {
    const engine = await regexEngine(app);
    const run = engine?.runRegexScript;
    if (typeof run !== 'function') return null;
    const result: unknown = (run as (script: Dict, text: string) => unknown)({ ...script, disabled: false }, text);
    return typeof result === 'string' ? result : null;
}

/** Opens a lorebook in ST's World Info panel (world-info.js `openWorldInfoEditor`). */
export async function openBook(app: App, book: string): Promise<boolean> {
    try {
        const module = await app.host.modules.worldInfo();
        const open = module.openWorldInfoEditor;
        if (typeof open !== 'function') return false;
        (open as (name: string) => void)(book);
        return true;
    } catch (error) {
        app.log.debug('cannot open the lorebook editor', error);
        return false;
    }
}
