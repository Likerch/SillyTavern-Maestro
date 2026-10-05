// Shared parts of the assistant's read tools (M33, stage 13): argument readers (the model may send anything), JSON
// schema builders (strict: typed, described properties, no extra ones), output helpers (cut texts, capped lists,
// user-language chip lines), defensive access to other modules' APIs and to the host (active lorebooks, a book's
// data, World Info scan settings, recent chat texts). Read tools never write and never return secrets: settings come
// only through ctx.settings (the core's allowlist) and the core redacts what slips through.
import { adaptersOf } from '../../../../adapters';
import { readWiSettings } from '../../../../domain/doctor-budget';
import type { WiGlobalSettings } from '../../../../domain/doctor-budget';
import type { App } from '../../../../shared/contracts';
import type { LoreJournalApi } from '../../../loreJournal/api';
import type { LoreStore } from '../../../loreStudio/store-api';
import type { ToolContext, ToolOutput, ToolSpec } from '../../api';

export type Dict = Record<string, unknown>;

export function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ arguments */

export function argsOf(args: unknown): Dict {
    return isDict(args) ? args : {};
}

/** A trimmed string argument (numbers are accepted as text), undefined when absent or empty. */
export function strArg(args: Dict, name: string, max = 300): string | undefined {
    const value = args[name];
    const text = typeof value === 'string' ? value.trim() : typeof value === 'number' ? String(value) : '';
    return text ? text.slice(0, max) : undefined;
}

/** A raw string argument (spaces kept: samples, replacements), undefined when not a string. */
export function rawArg(args: Dict, name: string, max = 4000): string | undefined {
    const value = args[name];
    return typeof value === 'string' ? value.slice(0, max) : undefined;
}

/** An integer argument clamped to [min, max]; `fallback` when absent or not a number. */
export function intArg(args: Dict, name: string, fallback: number, min: number, max: number): number {
    const value = args[name];
    const number = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
    if (!Number.isFinite(number)) return fallback;
    return Math.min(max, Math.max(min, Math.round(number)));
}

/** An optional integer argument (undefined when absent or not a number). */
export function optIntArg(args: Dict, name: string): number | undefined {
    const value = args[name];
    const number = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : NaN;
    return Number.isFinite(number) ? Math.round(number) : undefined;
}

export function boolArg(args: Dict, name: string, fallback: boolean): boolean {
    const value = args[name];
    if (typeof value === 'boolean') return value;
    if (value === 'true') return true;
    if (value === 'false') return false;
    return fallback;
}

/** One of the allowed values, else the fallback (undefined when none). */
export function enumArg<T extends string>(
    args: Dict,
    name: string,
    allowed: readonly T[],
    fallback?: T,
): T | undefined {
    const value = args[name];
    return typeof value === 'string' && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;
}

/* ------------------------------------------------------------------ schema */

export type PropertySchema = Record<string, unknown> & { type: string | string[]; description: string };

/** An object schema with no extra properties. */
export function objectSchema(properties: Record<string, PropertySchema> = {}, required: string[] = []): Dict {
    const schema: Dict = { type: 'object', properties, additionalProperties: false };
    if (required.length) schema.required = required;
    return schema;
}

export const prop = {
    string: (description: string, extra: Dict = {}): PropertySchema => ({ type: 'string', description, ...extra }),
    integer: (description: string, extra: Dict = {}): PropertySchema => ({ type: 'integer', description, ...extra }),
    boolean: (description: string): PropertySchema => ({ type: 'boolean', description }),
    enum: (description: string, values: readonly string[]): PropertySchema => ({
        type: 'string',
        description,
        enum: [...values],
    }),
};

/* ------------------------------------------------------------------ output */

/** Text cut to `max` characters (with «…»); non-strings become ''. */
export function cut(value: unknown, max: number): string {
    const text = typeof value === 'string' ? value : value === undefined || value === null ? '' : String(value);
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1)).trimEnd()}…` : text;
}

/** The first `max` items and how many were left out. */
export function capList<T>(items: readonly T[], max: number): { items: T[]; total: number; more?: number } {
    const shown = items.slice(0, max);
    const result: { items: T[]; total: number; more?: number } = { items: shown, total: items.length };
    if (items.length > max) result.more = items.length - max;
    return result;
}

/** A line in the user's language. */
export function say(ctx: Pick<ToolContext, 'locale'>, en: string, ru: string): string {
    return ctx.locale === 'ru' ? ru : en;
}

/** An answer that tells the model why there is nothing (module off, nothing found). */
export function notice(ctx: Pick<ToolContext, 'locale'>, en: string, ru: string, data: Dict = {}): ToolOutput {
    return { data: { note: en, ...data }, summary: say(ctx, en, ru) };
}

/** Time of a record as ISO text (compact, model-friendly). */
export function when(at: unknown): string | undefined {
    return typeof at === 'number' && Number.isFinite(at) && at > 0 ? new Date(at).toISOString() : undefined;
}

/** Drops undefined members (smaller JSON). */
export function compact<T extends Dict>(object: T): T {
    for (const key of Object.keys(object)) if (object[key] === undefined) delete object[key];
    return object;
}

/** Paths and values that may hold secrets are never shown (profiles, keys, addresses). */
export const SENSITIVE = /key|token|secret|password|api|url|endpoint|host|proxy|profile|connection/i;

/**
 * The same for journal locators, where `key` alone is common and harmless (lorebook keys): only API keys and the
 * other secrets count.
 */
export const SENSITIVE_REF = /api[_-]?key|token|secret|password|url|endpoint|host|proxy|profile|connection/i;

/* ------------------------------------------------------------------ app access */

/** Another module's API, undefined when it is off (or its getter throws). */
export function apiOf<T>(app: App, key: string): T | undefined {
    try {
        return app.modules.api<T>(key) ?? undefined;
    } catch {
        return undefined;
    }
}

/** available() for a tool that needs a module's API. */
export function needsApi(...keys: string[]): (app: App) => boolean {
    return (app) => keys.every((key) => apiOf(app, key) !== undefined);
}

/** A promise with a deadline: the fallback when it is late or fails. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise.catch(() => fallback),
            new Promise<T>((resolve) => {
                timer = setTimeout(() => resolve(fallback), ms);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/** Runs a getter that may throw (another module's API); the fallback on error. */
export function safely<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch {
        return fallback;
    }
}

/** Texts of the chat's messages, oldest first, system messages left out (the last `limit`). */
export function chatTexts(app: App, limit = 200): string[] {
    const chat = safely(() => app.host.ctx().chat ?? [], [] as STChatMessage[]);
    const texts: string[] = [];
    for (let index = chat.length - 1; index >= 0 && texts.length < limit; index--) {
        const message = chat[index];
        if (!message || message.is_system) continue;
        texts.unshift(typeof message.mes === 'string' ? message.mes : '');
    }
    return texts;
}

/** Names of the lorebooks ST scans now: the lore journal's reasons, else the BunnyMo adapter's list. */
export async function activeBooks(app: App): Promise<string[]> {
    const journal = apiOf<LoreJournalApi>(app, 'loreJournal');
    if (journal) {
        const reasons = await withTimeout(journal.whyActive(), 3000, []);
        if (reasons.length) return reasons.map((row) => row.book);
    }
    try {
        const books = await withTimeout(adaptersOf(app).bunnymo.activeBooks(), 3000, [] as string[]);
        if (books.length) return books;
    } catch {
        // no adapter: fall through
    }
    return [];
}

/** Every lorebook name ST knows (the Lore Studio's list, else ST's). */
export function allBooks(app: App): string[] {
    const store = apiOf<LoreStore>(app, 'loreStore');
    if (store) return safely(() => store.books(), []);
    return safely(() => app.host.ctx().getWorldInfoNames?.() ?? [], []);
}

/** A book's data (a copy): the Lore Studio's store, else ST's loadWorldInfo; null when missing. */
export async function loadBook(app: App, name: string): Promise<{ entries: Record<string, Dict> } | null> {
    const store = apiOf<LoreStore>(app, 'loreStore');
    let data: unknown;
    try {
        data = store ? await store.load(name) : await app.host.ctx().loadWorldInfo?.(name);
    } catch {
        return null;
    }
    if (!isDict(data) || !isDict(data.entries)) return null;
    return data as { entries: Record<string, Dict> };
}

/** True when lorebooks can be read (the Lore Studio's store or ST's loadWorldInfo). */
export function canReadLore(app: App): boolean {
    if (apiOf<LoreStore>(app, 'loreStore')) return true;
    return safely(() => typeof app.host.ctx().loadWorldInfo === 'function', false);
}

/** World Info scan settings (depth, case, whole words); ST's defaults when world-info.js is not available. */
export async function wiSettings(app: App): Promise<WiGlobalSettings> {
    try {
        const module = await withTimeout(app.host.modules.worldInfo(), 3000, {} as Dict);
        const getter = module.getWorldInfoSettings;
        const raw: unknown = typeof getter === 'function' ? (getter as () => unknown)() : module;
        return readWiSettings(isDict(raw) ? raw : {});
    } catch {
        return readWiSettings({});
    }
}

/** Entry keys as strings. */
export function keysOf(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string' && !!item) : [];
}

/** Builds a read tool (kind 'read'). */
export function readTool(spec: Omit<ToolSpec, 'kind' | 'plan'> & { run: NonNullable<ToolSpec['run']> }): ToolSpec {
    return { ...spec, kind: 'read' };
}
