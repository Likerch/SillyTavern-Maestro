// MAESTRO_API service facades (release 1.24, docs/integration-officina.md): thin doors to Maestro's own services for a
// neighbour (Officina) — the shared daily cost cap, the Lore Studio's store (M23), book roles (M35), mechanics (M25),
// the Preset Studio's store and layer (M34), the prompt audit (M38), the persona creator (M41) and the service card of
// M42. Each one validates its arguments, goes through the very service the studios use (so the rules of the stack hold:
// one save queue per book, BunnyMo never written, ST's editors refreshed, the working preset kept), journals with undo
// under the neighbour's module ('officina' unless `by` says 'dramatis') and answers `{ok: true, …}` or
// `{ok: false, error}`: 'off' while the owning module is off or paused (a service chat pauses the story modules),
// 'bad-args' when validation fails. Types: src/shared/public-api-types.ts.
import {
    ENTRY_TYPES,
    ENTRY_TYPE_IDS,
    composeContent,
    isEntryType,
    readTypedMeta,
    withTypedMeta,
} from '../domain/entry-types';
import type { EntryTypeId } from '../domain/entry-types';
import { parseBlock } from '../domain/mechanics-block';
import { hasErrors, normalizeDef, validateDef } from '../domain/mechanics-defs';
import { MECHANIC_TEMPLATES, defFromTemplate, templateById } from '../domain/mechanics-templates';
import { validateOp } from '../domain/preset-layer-ops';
import { isCanonBookName } from '../domain/roles-detect';
import type { BookRole, BookRolesApi } from '../features/bookRoles/api';
import { canonMetaOf } from '../features/loreStudio/form/canon-panel';
import { LoreStudioError } from '../features/loreStudio/st-lore';
import type { LoreStore, WiEntry } from '../features/loreStudio/store-api';
import type { MechanicDef, MechanicScope, MechanicsApi } from '../features/mechanics/api';
import type { PersonaCreator } from '../features/personaCreator/service';
import type { LayerOp, LayerScope, PresetLayerApi } from '../features/presetStudio/layer-api';
import { PresetStoreError } from '../features/presetStudio/st-preset';
import type { PresetBody, PresetPrompt, PresetStore } from '../features/presetStudio/store-api';
import type { PromptAuditApi } from '../features/promptAudit/api';
import { storyLanguage } from '../core/language';
import type { App, Logger, Unsubscribe } from '../shared/contracts';
import type {
    ApiBookRole,
    ApiEntryType,
    ApiError,
    ApiLayerOp,
    ApiMechanicDef,
    ApiPresetPrompt,
    ApiResult,
    ApiWriteOptions,
    MaestroApi,
} from '../shared/public-api-types';

type Dict = Record<string, unknown>;
type Failure = { ok: false; error: ApiError; message?: string };

/** Mutual assignability: the public types are structural copies of the internal ones (they must not drift apart). */
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const sameMechanicDef: Exact<ApiMechanicDef, MechanicDef> = true;
const sameLayerOp: Exact<ApiLayerOp, LayerOp> = true;
const samePrompt: Exact<ApiPresetPrompt, PresetPrompt> = true;
const sameRole: Exact<ApiBookRole, BookRole> = true;
const sameEntryType: Exact<ApiEntryType, EntryTypeId> = true;
void [sameMechanicDef, sameLayerOp, samePrompt, sameRole, sameEntryType];

const BOOK_ROLES: readonly ApiBookRole[] = [
    'bunnymo.core',
    'bunnymo.pack',
    'ck.archive',
    'world',
    'card',
    'npc',
    'canon',
    'maestro',
    'chat',
    'persona',
    'backup',
    'unknown',
];
const LAYER_SCOPES: readonly LayerScope[] = ['global', 'character', 'chat'];
const NEIGHBOUR_MODULES = ['officina', 'dramatis'] as const;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function jsonCopy<T>(value: T): T {
    const json = JSON.stringify(value);
    return json === undefined ? value : (JSON.parse(json) as T);
}

function fail(error: ApiError, message?: string): Failure {
    return message ? { ok: false, error, message } : { ok: false, error };
}

function messageOf(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** A thrown error of a service in the contract's words. */
function failure(error: unknown): Failure {
    if (error instanceof LoreStudioError) {
        const code = error.code;
        if (code === 'readOnly') return fail('read-only', code);
        if (code === 'missing' || code === 'missingEntry' || code === 'noCharacter') return fail('not-found', code);
        if (code === 'exists' || code === 'sameName') return fail('exists', code);
        if (code === 'emptyName') return fail('bad-args', code);
        if (code === 'noChat') return fail('no-chat', code);
        if (code === 'unavailable' || code === 'desUnavailable' || code === 'workshopOpen') {
            return fail('unavailable', code);
        }
        return fail('failed', code);
    }
    if (error instanceof PresetStoreError) {
        if (error.code === 'exists') return fail('exists', error.message);
        if (error.code === 'not-found') return fail('not-found', error.message);
        if (error.code === 'invalid') return fail('bad-args', error.message);
        if (error.code === 'unavailable' || error.code === 'busy') return fail('unavailable', error.message);
        if (error.code === 'protected') return fail('read-only', error.message);
        return fail('failed', error.message);
    }
    return fail('failed', messageOf(error));
}

/** The journal module of a facade write: the neighbour named by `by`, 'officina' by default. */
function moduleOf(options: ApiWriteOptions | undefined): string {
    return NEIGHBOUR_MODULES.find((module) => module === options?.by) ?? 'officina';
}

function summaryOf(options: ApiWriteOptions | undefined): string {
    return text(options?.summary);
}

/** A string list as World Info keeps keys (blank ones dropped); null when it is not a list of strings. */
function keyList(value: unknown): string[] | null {
    if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) return null;
    return (value as string[]).map((item) => item.trim()).filter(Boolean);
}

/** An entry patch a neighbour may write: a plain object, `uid` never, keys as lists of strings, content a string. */
function entryPatch(value: unknown): Partial<WiEntry> | null {
    if (!isDict(value)) return null;
    const patch = jsonCopy(value) as Dict;
    delete patch.uid;
    for (const field of ['key', 'keysecondary'] as const) {
        if (!(field in patch)) continue;
        const list = keyList(patch[field]);
        if (!list) return null;
        patch[field] = list;
    }
    for (const field of ['content', 'comment'] as const) {
        if (field in patch && typeof patch[field] !== 'string') return null;
    }
    return patch as Partial<WiEntry>;
}

function isUid(value: unknown): value is number {
    return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isScope(value: unknown): value is MechanicScope {
    if (!isDict(value)) return false;
    if (value.kind === 'global') return true;
    if (value.kind === 'card') return typeof value.avatar === 'string' && !!value.avatar.trim();
    if (value.kind === 'chat') return typeof value.chatId === 'string' && !!value.chatId.trim();
    return false;
}

export interface ServiceFacadeDeps {
    app: App;
    log: Logger;
    /** Maestro stopped: every call answers 'maestro-stopped'. */
    disposed(): boolean;
    /** Releases a remover when Maestro stops (MAESTRO_API's own). */
    own(off: Unsubscribe): Unsubscribe;
}

export type ServiceFacades = Required<
    Pick<MaestroApi, 'cost' | 'lore' | 'bookRoles' | 'mechanics' | 'presets' | 'promptAudit' | 'persona'>
> & {
    /** The 1.24 members of MAESTRO_API.workshop. */
    serviceCard: {
        isServiceCard(avatar: string): boolean;
        setCard(avatar: string, on: boolean, options?: ApiWriteOptions): Promise<ApiResult>;
    };
};

export function createServiceFacades(deps: ServiceFacadeDeps): ServiceFacades {
    const { app, log } = deps;
    const api = <T>(key: string): T | undefined => {
        try {
            return app.modules.api<T>(key) ?? undefined;
        } catch {
            return undefined;
        }
    };
    const stopped = (): Failure | null => (deps.disposed() ? fail('maestro-stopped') : null);
    /** Runs a write; a thrown error of the service becomes a failure in the contract's words. */
    const attempt = async <T extends object>(what: string, run: () => Promise<ApiResult<T>>): Promise<ApiResult<T>> => {
        const halt = stopped();
        if (halt) return halt;
        try {
            return await run();
        } catch (error) {
            log.warn(`MAESTRO_API ${what} failed`, error);
            return failure(error);
        }
    };
    const characters = (): { avatar: string; name: string; index: number }[] => {
        try {
            return (app.host.ctx().characters ?? []).map((character, index) => ({
                avatar: typeof character?.avatar === 'string' ? character.avatar : '',
                name: typeof character?.name === 'string' ? character.name : '',
                index,
            }));
        } catch {
            return [];
        }
    };
    const knownCard = (avatar: unknown): avatar is string =>
        typeof avatar === 'string' && !!avatar && characters().some((item) => item.avatar === avatar);

    /* ---------------------------------------------------------------- cost */

    const cost: ServiceFacades['cost'] = {
        record(spend) {
            const halt = stopped();
            if (halt) return halt;
            if (!isDict(spend)) return fail('bad-args');
            const task = text(spend.task);
            if (!/^officina\.[A-Za-z0-9_][A-Za-z0-9_.-]{0,80}$/.test(task)) return fail('bad-args', 'task');
            if (typeof spend.usd !== 'number' || !Number.isFinite(spend.usd) || spend.usd < 0) {
                return fail('bad-args', 'usd');
            }
            const count = (value: unknown) =>
                typeof value === 'number' && Number.isFinite(value) && value > 0 ? Math.round(value) : 0;
            const tokens = isDict(spend.tokens) ? spend.tokens : {};
            const cached = count(tokens.cached);
            app.cost.record({
                source: 'officina',
                task,
                usd: spend.usd,
                tokens: {
                    prompt: count(tokens.prompt),
                    completion: count(tokens.completion),
                    ...(cached ? { cached } : {}),
                },
                ...(spend.usd === 0 ? { estimated: true } : {}),
                ...(text(spend.model) ? { model: text(spend.model) } : {}),
                ...(text(spend.provider) ? { provider: text(spend.provider) } : {}),
                ...(typeof spend.at === 'number' ? { at: spend.at } : {}),
                // A neighbour's work belongs to no turn of the chat open now.
                chatId: null,
            });
            return { ok: true };
        },
        remaining() {
            try {
                const budget = app.cost.backgroundBudget?.();
                if (budget) return { ...budget };
                // A meter without the budget: the cap of the settings against today's background spend.
                const cap = app.settings.core().backgroundDailyCapUsd;
                const spent = app.cost.summary().backgroundTodayUsd;
                return cap > 0
                    ? { capUsd: cap, spentUsd: spent, remainingUsd: Math.max(0, cap - spent) }
                    : { capUsd: null, spentUsd: spent, remainingUsd: null };
            } catch (error) {
                log.debug('MAESTRO_API cost.remaining: no meter', error);
                return { capUsd: null, spentUsd: 0, remainingUsd: null };
            }
        },
        claim(signal) {
            if (deps.disposed() || typeof AbortSignal === 'undefined' || !(signal instanceof AbortSignal)) {
                return () => {};
            }
            if (typeof app.cost.beginOwn !== 'function') return () => {};
            app.cost.beginOwn(signal);
            return deps.own(() => app.cost.endOwn?.(signal));
        },
    };

    /* ---------------------------------------------------------------- lore */

    const store = () => api<LoreStore>('loreStore');
    const roles = () => api<BookRolesApi>('bookRoles');

    /** Where the typed fields of an entry live: in the entry (Maestro and canon books), else the roles sidecar (P2). */
    const typedStorage = (book: string, entry: Dict): 'entry' | 'sidecar' => {
        const role = roles()?.roleOf(book)?.role;
        if (role === 'maestro' || role === 'canon' || isCanonBookName(book) || canonMetaOf(entry) !== null)
            return 'entry';
        return 'sidecar';
    };

    /**
     * A book whose role M35 does not know yet (made a moment ago, by Officina or by hand) is read-only for the store
     * until it is detected (P13): it is detected now, before a write.
     */
    const detected = async (book: string): Promise<void> => {
        const known = roles();
        if (!known || known.roleOf(book) || typeof known.detect !== 'function') return;
        await known.detect([book]);
    };

    const loadEntry = async (lore: LoreStore, book: string, uid: number): Promise<WiEntry | null> => {
        const data = await lore.load(book);
        const entry = data?.entries[String(uid)];
        return entry ?? null;
    };

    const lore: ServiceFacades['lore'] = {
        listBooks() {
            const halt = stopped();
            if (halt) return halt;
            const lore = store();
            if (!lore) return fail('off');
            const known = roles();
            return {
                ok: true,
                books: lore.books().map((name) => ({
                    name,
                    role: known?.roleOf(name)?.role ?? null,
                    readOnly: lore.isReadOnly?.(name) ?? known?.roleOf(name)?.readOnly ?? false,
                })),
            };
        },
        load: (book) =>
            attempt('lore.load', async () => {
                const lore = store();
                if (!lore) return fail('off');
                if (!text(book)) return fail('bad-args');
                const data = await lore.load(book);
                return data ? { ok: true, book: data } : fail('not-found');
            }),
        createBook: (name, options) =>
            attempt('lore.createBook', async () => {
                const lore = store();
                if (!lore) return fail('off');
                if (!text(name)) return fail('bad-args');
                const created = await lore.createBook(text(name), {
                    module: moduleOf(options),
                    ...(summaryOf(options) ? { summary: summaryOf(options) } : {}),
                });
                await detected(created);
                return { ok: true, name: created };
            }),
        createEntry: (book, entry, options) =>
            attempt('lore.createEntry', async () => {
                const lore = store();
                if (!lore) return fail('off');
                const patch = entryPatch(entry);
                if (!text(book) || !patch) return fail('bad-args');
                if (!lore.books().includes(book)) return fail('not-found');
                await detected(book);
                if (lore.isReadOnly?.(book)) return fail('read-only');
                const uid = await lore.createEntry(book, patch, {
                    module: moduleOf(options),
                    summary: summaryOf(options) || app.i18n.t('m23.journal.createEntry', { book }),
                });
                return { ok: true, uid };
            }),
        updateEntry: (book, uid, patch, options) =>
            attempt('lore.updateEntry', async () => {
                const lore = store();
                if (!lore) return fail('off');
                const clean = entryPatch(patch);
                if (!text(book) || !isUid(uid) || !clean) return fail('bad-args');
                if (!lore.books().includes(book)) return fail('not-found');
                await detected(book);
                if (lore.isReadOnly?.(book)) return fail('read-only');
                await lore.updateEntry(book, uid, clean, {
                    module: moduleOf(options),
                    summary: summaryOf(options) || app.i18n.t('core.api.lore.update', { book, uid }),
                });
                return { ok: true };
            }),
        deleteEntry: (book, uid, options) =>
            attempt('lore.deleteEntry', async () => {
                const lore = store();
                if (!lore) return fail('off');
                if (!text(book) || !isUid(uid)) return fail('bad-args');
                if (!lore.books().includes(book)) return fail('not-found');
                await detected(book);
                if (lore.isReadOnly?.(book)) return fail('read-only');
                if (!(await loadEntry(lore, book, uid))) return fail('not-found');
                await lore.deleteEntry(book, uid, {
                    module: moduleOf(options),
                    summary: summaryOf(options) || app.i18n.t('core.api.lore.delete', { book, uid }),
                });
                return { ok: true };
            }),
        setCharacterBook: (avatar, book, options) =>
            attempt('lore.setCharacterBook', async () => {
                const lore = store();
                if (!lore) return fail('off');
                if (book !== null && !text(book)) return fail('bad-args');
                if (!knownCard(avatar)) return fail('not-found', 'card');
                if (book !== null && !lore.books().includes(book)) return fail('not-found', 'book');
                if (typeof lore.setCharacterPrimaryOf !== 'function') return fail('unavailable');
                await lore.setCharacterPrimaryOf(avatar, book, moduleOf(options));
                return { ok: true };
            }),
        entryTypes: () =>
            ENTRY_TYPE_IDS.map((id) => ({
                id,
                label: ENTRY_TYPES[id].label,
                fields: ENTRY_TYPES[id].fields.map((field) => ({ ...field })),
            })),
        composeContent(type, fields) {
            if (!isEntryType(type) || !isDict(fields)) return '';
            const values: Record<string, string> = {};
            for (const [key, value] of Object.entries(fields)) if (typeof value === 'string') values[key] = value;
            return composeContent({ type, fields: values });
        },
        typeFields: (book, uid) =>
            attempt('lore.typeFields', async () => {
                const lore = store();
                if (!lore) return fail('off');
                if (!text(book) || !isUid(uid)) return fail('bad-args');
                const entry = await loadEntry(lore, book, uid);
                if (!entry) return fail('not-found');
                if (typedStorage(book, entry) === 'entry') {
                    return { ok: true, typed: readTypedMeta((entry.extensions as Dict | undefined)?.maestro) };
                }
                const known = roles();
                if (!known) return fail('off');
                const meta = known.loadEntryMeta
                    ? await known.loadEntryMeta<Dict>(book, uid)
                    : known.entryMeta<Dict>(book, uid);
                return { ok: true, typed: readTypedMeta(meta) };
            }),
        setTypeFields: (book, uid, typed, options) =>
            attempt('lore.setTypeFields', async () => {
                const lore = store();
                if (!lore) return fail('off');
                if (!text(book) || !isUid(uid)) return fail('bad-args');
                if (typed !== null && (!isDict(typed) || !isEntryType(typed.type) || !isDict(typed.fields))) {
                    return fail('bad-args');
                }
                await detected(book);
                if (lore.isReadOnly?.(book)) return fail('read-only');
                const entry = await loadEntry(lore, book, uid);
                if (!entry) return fail('not-found');
                const meta = typed
                    ? {
                          type: typed.type,
                          fields: Object.fromEntries(
                              Object.entries(typed.fields).filter(
                                  (pair): pair is [string, string] => typeof pair[1] === 'string',
                              ),
                          ),
                      }
                    : null;
                const reason = {
                    module: moduleOf(options),
                    summary: summaryOf(options) || app.i18n.t('core.api.lore.update', { book, uid }),
                };
                const content = options?.compose && meta ? { content: composeContent(meta) } : {};
                const storage = typedStorage(book, entry);
                if (storage === 'entry') {
                    await lore.updateEntry(
                        book,
                        uid,
                        { ...content, extensions: withTypedMeta(entry.extensions, meta) },
                        reason,
                    );
                    return { ok: true, storage };
                }
                const known = roles();
                if (!known) return fail('off');
                // The sidecar is bound to the content hash: the content first, then the record (as the entry form does).
                if ('content' in content) await lore.updateEntry(book, uid, content, reason);
                const stored =
                    (known.loadEntryMeta
                        ? await known.loadEntryMeta<Dict>(book, uid)
                        : known.entryMeta<Dict>(book, uid)) ?? {};
                const record: Dict = { ...stored };
                if (meta) {
                    record.type = meta.type;
                    record.typeFields = { ...meta.fields };
                } else {
                    delete record.type;
                    delete record.typeFields;
                }
                await known.setEntryMeta(book, uid, Object.keys(record).length ? record : undefined);
                return { ok: true, storage };
            }),
    };

    /* ---------------------------------------------------------------- book roles */

    const bookRoles: ServiceFacades['bookRoles'] = {
        get(book) {
            const halt = stopped();
            if (halt) return halt;
            const known = roles();
            if (!known) return fail('off');
            if (!text(book)) return fail('bad-args');
            const info = known.roleOf(book);
            return { ok: true, info: info ? jsonCopy(info) : null };
        },
        set: (book, role, options) =>
            attempt('bookRoles.set', async () => {
                const known = roles();
                if (!known) return fail('off');
                if (!text(book) || !BOOK_ROLES.includes(role)) return fail('bad-args');
                const info = known.roleOf(book);
                // P13: a BunnyMo book stays what it is (its role is what keeps it read-only).
                if (info?.readOnly || info?.role === 'bunnymo.core' || info?.role === 'bunnymo.pack') {
                    return fail('read-only');
                }
                await known.setRole(book, role, moduleOf(options));
                return { ok: true };
            }),
    };

    /* ---------------------------------------------------------------- mechanics */

    const mechanicsApi = () => api<MechanicsApi>('mechanics');
    const allDefs = (mechanics: MechanicsApi): MechanicDef[] => mechanics.all?.() ?? mechanics.list();

    const mechanics: ServiceFacades['mechanics'] = {
        list(filter) {
            const halt = stopped();
            if (halt) return halt;
            const mechanics = mechanicsApi();
            if (!mechanics) return fail('off');
            const kind = filter?.scope;
            const defs = allDefs(mechanics).filter((def) => {
                if (!kind) return true;
                if (def.scope.kind !== kind) return false;
                if (def.scope.kind === 'card' && filter?.avatar) return def.scope.avatar === filter.avatar;
                if (def.scope.kind === 'chat' && filter?.chatId) return def.scope.chatId === filter.chatId;
                return true;
            });
            return { ok: true, defs: jsonCopy(defs) };
        },
        get(id) {
            const halt = stopped();
            if (halt) return halt;
            const mechanics = mechanicsApi();
            if (!mechanics) return fail('off');
            if (!text(id)) return fail('bad-args');
            const def = mechanics.get(id);
            return { ok: true, def: def ? jsonCopy(def) : null };
        },
        save: (def, options) =>
            attempt('mechanics.save', async () => {
                const mechanics = mechanicsApi();
                if (!mechanics) return fail('off');
                if (!isDict(def) || !isScope(options?.scope)) return fail('bad-args', 'scope');
                const draft = normalizeDef({ ...jsonCopy(def), scope: jsonCopy(options.scope) });
                if (!draft) return fail('bad-args', 'id');
                const issue = validateDef(draft).find((item) => item.level === 'error');
                if (issue || hasErrors(validateDef(draft))) return fail('bad-args', issue?.code ?? 'invalid');
                const saved = await mechanics.save(draft, moduleOf(options));
                return { ok: true, def: jsonCopy(saved) };
            }),
        remove: (id, options) =>
            attempt('mechanics.remove', async () => {
                const mechanics = mechanicsApi();
                if (!mechanics) return fail('off');
                if (!text(id)) return fail('bad-args');
                if (!mechanics.get(id)) return fail('not-found');
                await mechanics.remove(id, moduleOf(options));
                return { ok: true };
            }),
        templates() {
            const halt = stopped();
            if (halt) return halt;
            const list = mechanicsApi()?.templates() ?? [...MECHANIC_TEMPLATES];
            return {
                ok: true,
                templates: list.map((item) => ({
                    id: item.id,
                    title: app.i18n.t(item.titleKey),
                    description: app.i18n.t(item.descriptionKey),
                })),
            };
        },
        fromTemplate(id, options) {
            const halt = stopped();
            if (halt) return halt;
            const item = templateById(text(id));
            if (!item) return fail('not-found');
            if (options?.scope !== undefined && !isScope(options.scope)) return fail('bad-args', 'scope');
            const scope: MechanicScope = options?.scope ? jsonCopy(options.scope) : { kind: 'global' };
            const mechanics = mechanicsApi();
            // The module's own (lore factions for a reputation template); the scope is the caller's.
            const made = mechanics?.fromTemplate(item.id);
            if (made) return { ok: true, def: { ...made, scope } };
            const locale = app.i18n.locale() === 'ru' ? 'ru' : 'en';
            const taken = mechanics ? allDefs(mechanics).map((def) => def.id) : [];
            return { ok: true, def: defFromTemplate(item, locale, scope, taken) };
        },
        parseBlock: (value) => parseBlock(typeof value === 'string' ? value : ''),
        setEnabledInChat: (id, on) =>
            attempt('mechanics.setEnabledInChat', async () => {
                const mechanics = mechanicsApi();
                if (!mechanics) return fail('off');
                if (!text(id) || typeof on !== 'boolean') return fail('bad-args');
                if (!app.host.chatId()) return fail('no-chat');
                if (!mechanics.get(id)) return fail('not-found');
                await mechanics.setEnabledInChat(id, on);
                return { ok: true };
            }),
    };

    /* ---------------------------------------------------------------- presets */

    const presetStore = () => api<PresetStore>('presetStore');
    const presetLayer = () => api<PresetLayerApi>('presetLayer');

    /** The owner of a layer part a call names, or a failure: a known card, the open chat. */
    const layerOwner = (scope: unknown, owner: unknown): Failure | null => {
        if (!LAYER_SCOPES.includes(scope as LayerScope)) return fail('bad-args', 'scope');
        if (owner !== undefined && (typeof owner !== 'string' || !owner)) return fail('bad-args', 'owner');
        if (scope === 'character' && owner !== undefined && !knownCard(owner)) return fail('not-found', 'card');
        if (scope === 'chat') {
            const chatId = app.host.chatId();
            if (!chatId) return fail('no-chat');
            if (owner !== undefined && owner !== chatId) return fail('bad-args', 'owner');
        }
        return null;
    };

    const presets: ServiceFacades['presets'] = {
        list() {
            const halt = stopped();
            if (halt) return halt;
            const presetsStore = presetStore();
            if (!presetsStore) return fail('off');
            return { ok: true, names: presetsStore.names(), current: presetsStore.current() };
        },
        working() {
            const halt = stopped();
            if (halt) return halt;
            const presetsStore = presetStore();
            if (!presetsStore) return fail('off');
            return { ok: true, name: presetsStore.current(), body: jsonCopy(presetsStore.working()) };
        },
        saved(name) {
            const halt = stopped();
            if (halt) return halt;
            const presetsStore = presetStore();
            if (!presetsStore) return fail('off');
            const body = text(name) ? presetsStore.saved(name) : null;
            return body ? { ok: true, body: jsonCopy(body) } : fail('not-found');
        },
        select: (name, options) =>
            attempt('presets.select', async () => {
                const presetsStore = presetStore();
                if (!presetsStore) return fail('off');
                if (!text(name)) return fail('bad-args');
                if (!presetsStore.names().includes(name)) return fail('not-found');
                if (presetsStore.current() === name) return { ok: true };
                // A switch drops unsaved edits of the working copy (ST has no «dirty» flag): never silently.
                if (options?.force !== true && presetsStore.draft({ ignoreConnection: true }).dirty)
                    return fail('unsaved');
                await presetsStore.select(name, { keepConnection: true });
                return { ok: true };
            }),
        saveAs: (name, body, options) =>
            attempt('presets.saveAs', async () => {
                const presetsStore = presetStore();
                if (!presetsStore) return fail('off');
                if (!text(name) || (body !== undefined && !isDict(body))) return fail('bad-args');
                const module = moduleOf(options);
                const summary = summaryOf(options);
                if (body) {
                    if (typeof presetsStore.createFromBody !== 'function') return fail('unavailable');
                    const saved = await presetsStore.createFromBody(text(name), jsonCopy(body) as PresetBody, {
                        module,
                        ...(summary ? { summary } : {}),
                        ...(options?.select ? { select: true } : {}),
                        ...(options?.overwrite ? { overwrite: true } : {}),
                    });
                    return { ok: true, name: saved };
                }
                const saved = await presetsStore.saveAs(text(name), { module, ...(summary ? { summary } : {}) });
                return { ok: true, name: saved };
            }),
        ops: (scope, owner) =>
            attempt('presets.ops', async () => {
                const layer = presetLayer();
                if (!layer) return fail('off');
                const wrong = layerOwner(scope, owner);
                if (wrong) return wrong;
                if (typeof layer.part !== 'function') return fail('unavailable');
                const part = await layer.part(scope, owner);
                return { ok: true, layers: part.layers, binding: part.binding };
            }),
        record: (base, op, scope, owner, options) =>
            attempt('presets.record', async () => {
                const layer = presetLayer();
                const presetsStore = presetStore();
                if (!layer || !presetsStore) return fail('off');
                const wrong = layerOwner(scope, owner);
                if (wrong) return wrong;
                const invalid = validateOp(op);
                if (!text(base) || invalid) return fail('bad-args', invalid ?? 'base');
                if (!presetsStore.names().includes(base)) return fail('not-found', 'base');
                if (typeof layer.recordFor !== 'function') return fail('unavailable');
                const summary = summaryOf(options);
                await layer.recordFor(base, jsonCopy(op) as LayerOp, scope, {
                    by: moduleOf(options),
                    ...(owner ? { owner } : {}),
                    ...(summary ? { summary } : {}),
                });
                return { ok: true };
            }),
        remove: (base, index, scope, owner, options) =>
            attempt('presets.remove', async () => {
                const layer = presetLayer();
                if (!layer) return fail('off');
                const wrong = layerOwner(scope, owner);
                if (wrong) return wrong;
                if (!text(base) || !isUid(index)) return fail('bad-args');
                if (typeof layer.part !== 'function' || typeof layer.removeFor !== 'function')
                    return fail('unavailable');
                const part = await layer.part(scope, owner);
                if (!part.layers[base]?.[index]) return fail('not-found');
                const summary = summaryOf(options);
                await layer.removeFor(base, index, scope, {
                    by: moduleOf(options),
                    ...(owner ? { owner } : {}),
                    ...(summary ? { summary } : {}),
                });
                return { ok: true };
            }),
        bind: (scope, preset, owner, options) =>
            attempt('presets.bind', async () => {
                const layer = presetLayer();
                const presetsStore = presetStore();
                if (!layer || !presetsStore) return fail('off');
                if (scope !== 'character' && scope !== 'chat') return fail('bad-args', 'scope');
                const wrong = layerOwner(scope, owner);
                if (wrong) return wrong;
                if (!text(preset)) return fail('bad-args');
                if (!presetsStore.names().includes(preset)) return fail('not-found');
                if (typeof layer.bindFor !== 'function') return fail('unavailable');
                await layer.bindFor(scope, preset, { by: moduleOf(options), ...(owner ? { owner } : {}) });
                return { ok: true };
            }),
        unbind: (scope, owner, options) =>
            attempt('presets.unbind', async () => {
                const layer = presetLayer();
                if (!layer) return fail('off');
                if (scope !== 'character' && scope !== 'chat') return fail('bad-args', 'scope');
                const wrong = layerOwner(scope, owner);
                if (wrong) return wrong;
                if (typeof layer.bindFor !== 'function') return fail('unavailable');
                await layer.bindFor(scope, null, { by: moduleOf(options), ...(owner ? { owner } : {}) });
                return { ok: true };
            }),
    };

    /* ---------------------------------------------------------------- prompt audit */

    const promptAudit: ServiceFacades['promptAudit'] = {
        run: (options) =>
            attempt('promptAudit.run', async () => {
                const audit = api<PromptAuditApi>('promptAudit');
                if (!audit) return fail('off');
                await audit.ready();
                const dry = options?.dry === true;
                if (audit.busy()) return fail('unavailable', 'busy');
                if (dry && !audit.dryRunAvailable()) return fail('unavailable', 'dry');
                const report = await audit.check({ dry });
                if (!report) return { ok: true, report: null };
                const side = (value: { ref: string; quote: string }) => ({ ref: value.ref, quote: value.quote });
                return {
                    ok: true,
                    report: {
                        at: report.at,
                        source: report.source,
                        hidden: report.hidden,
                        conflicts: report.conflicts.map((conflict) => ({
                            id: conflict.id,
                            source: conflict.source,
                            topic: conflict.topic,
                            severity: conflict.severity,
                            title: conflict.title,
                            why: conflict.why,
                            ...(conflict.risk ? { risk: conflict.risk } : {}),
                            a: side(conflict.a),
                            ...(conflict.b ? { b: side(conflict.b) } : {}),
                            ...(conflict.also?.length ? { also: conflict.also.map(side) } : {}),
                        })),
                    },
                };
            }),
    };

    /* ---------------------------------------------------------------- persona */

    const persona: ServiceFacades['persona'] = {
        create: (input) =>
            attempt('persona.create', async () => {
                const creator = api<PersonaCreator>('personaCreator');
                if (!creator) return fail('off');
                if (!isDict(input) || !text(input.name) || !text(input.description)) return fail('bad-args');
                const wardrobe = input.wardrobe ?? [];
                if (!Array.isArray(wardrobe) || wardrobe.some((item) => !isDict(item) || !text(item.name))) {
                    return fail('bad-args', 'wardrobe');
                }
                const outfits = wardrobe.map((item) => ({
                    name: text(item.name),
                    wording: text(item.wording),
                    tags: text(item.tags),
                }));
                let card = { index: -1, avatar: '', name: '' };
                if (input.linkAvatar !== undefined) {
                    const found = characters().find((item) => item.avatar === input.linkAvatar);
                    if (!found || !found.avatar) return fail('not-found', 'card');
                    card = found;
                }
                const passport = input.passport === true;
                const outcome = await creator.create({
                    card,
                    name: text(input.name),
                    title: text(input.title),
                    description: text(input.description),
                    outfits,
                    draft: {
                        name: text(input.name),
                        title: text(input.title),
                        appearance: text(input.description),
                        appearanceEn: text(input.appearanceEn),
                        background: '',
                        personality: '',
                        outfits,
                    },
                    language: storyLanguage(app),
                    options: {
                        passport,
                        picture: input.picture ?? passport,
                        link: !!card.avatar,
                        makeCurrent: input.makeCurrent === true,
                    },
                });
                if (!outcome.ok) return fail('failed', outcome.error);
                const done = (id: string) => outcome.steps.some((step) => step.id === id && step.status === 'done');
                return {
                    ok: true,
                    avatarId: outcome.avatarId,
                    name: outcome.name,
                    linked: done('link'),
                    passport: done('passport'),
                    picture: outcome.picture,
                    current: outcome.current,
                    steps: outcome.steps.map((step) => ({ ...step })),
                };
            }),
    };

    /* ---------------------------------------------------------------- the service card (M42) */

    interface ServiceCardApi {
        isWorkshopCard(avatar: string): boolean;
        setCard(avatar: string, on: boolean, options?: { by?: string; quiet?: boolean }): Promise<boolean>;
    }
    const workshop = () => api<ServiceCardApi>('workshop');

    const serviceCard: ServiceFacades['serviceCard'] = {
        isServiceCard(avatar) {
            if (deps.disposed() || typeof avatar !== 'string' || !avatar) return false;
            try {
                return workshop()?.isWorkshopCard(avatar) === true;
            } catch {
                return false;
            }
        },
        setCard: (avatar, on, options) =>
            attempt('workshop.setCard', async () => {
                const service = workshop();
                if (!service) return fail('off');
                if (typeof on !== 'boolean') return fail('bad-args');
                if (!knownCard(avatar)) return fail('not-found');
                const ok = await service.setCard(avatar, on, { by: moduleOf(options), quiet: true });
                return ok ? { ok: true } : fail('failed', 'SillyTavern did not take the tag');
            }),
    };

    return { cost, lore, bookRoles, mechanics, presets, promptAudit, persona, serviceCard };
}
