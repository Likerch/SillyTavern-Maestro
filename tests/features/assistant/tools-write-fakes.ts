// Fakes for the assistant's write tools (M33, part C) on top of the shared tool fakes (tools-helpers.ts): a journal
// that runs the registered undo handlers, an autonomy service with setLevel, and recording fakes of the APIs the
// tools write through — mechanics, the Preset Studio's store and layer, the Lore Studio's store, book roles and
// passports. Every fake keeps what it was asked to do, so tests check the exact calls.
import { defFromTemplate } from '../../../src/domain/mechanics-templates';
import type { ToolContext, ToolSpec, WritePlan } from '../../../src/features/assistant/api';
import { writeTools } from '../../../src/features/assistant/tools/write';
import type { BookRoleInfo, BookRolesApi } from '../../../src/features/bookRoles/api';
import type { LorePassport, LorePassportsApi, PassportPlace } from '../../../src/features/lorePassports/api';
import type { LoreStore, SaveReason, WiBookData, WiEntry } from '../../../src/features/loreStudio/store-api';
import type { MechanicDef, MechanicsApi, MechanicTemplate } from '../../../src/features/mechanics/api';
import type { Layer, LayerOp, PresetLayerApi } from '../../../src/features/presetStudio/layer-api';
import type {
    PresetBody,
    PresetOrderItem,
    PresetPrompt,
    PresetStore,
} from '../../../src/features/presetStudio/store-api';
import type { AutonomyLevel, Journal, JournalAction, JournalRecord, UndoHandler } from '../../../src/shared/contracts';
import { fakeApp, fakeSettings, toolContext, toolNamed } from './tools-helpers';
import type { FakeApp, FakeAppOptions, FakeSettingsAccess } from './tools-helpers';

/* ------------------------------------------------------------------ journal and autonomy */

export class UndoJournal implements Journal {
    readonly records: JournalRecord[] = [];
    readonly handlers = new Map<string, UndoHandler>();

    async record(action: JournalAction): Promise<string> {
        const id = `j${this.records.length + 1}`;
        this.records.push({ ...structuredClone(action), id, at: Date.now(), chatId: 'chat-1' });
        return id;
    }

    async undo(id: string): Promise<boolean> {
        const record = this.records.find((item) => item.id === id);
        if (!record || record.undone) return false;
        for (const change of [...record.changes].reverse()) {
            const handler = this.handlers.get(change.target);
            if (!handler || !(await handler(change))) return false;
        }
        record.undone = true;
        return true;
    }

    /** Undoes the newest record. */
    undoLast(): Promise<boolean> {
        const last = this.records[this.records.length - 1];
        return last ? this.undo(last.id) : Promise.resolve(false);
    }

    async undoForMessage(): Promise<number> {
        return 0;
    }

    list(): JournalRecord[] {
        return this.records;
    }

    registerUndo(target: string, handler: UndoHandler): void {
        this.handlers.set(target, handler);
    }
}

export interface FakeAutonomy {
    neverAuto: Set<string>;
    stats: string[];
    setLevelCalls: { kind: string; level: AutonomyLevel }[];
    /** Remove setLevel (an older autonomy service). */
    withoutSetLevel(): void;
}

export interface WriteFake extends FakeApp {
    undoJournal: UndoJournal;
    autonomy: FakeAutonomy;
    /** Core settings (shared object: `app.settings.core().autonomy` is this one). */
    core: { autonomy: Record<string, AutonomyLevel> };
    saves: number;
    tools: ToolSpec[];
    ctx(locale?: 'en' | 'ru', settings?: FakeSettingsAccess): ToolContext;
    plan(name: string, args: Record<string, unknown>, locale?: 'en' | 'ru'): Promise<WritePlan>;
}

export function writeFake(options: FakeAppOptions = {}): WriteFake {
    const core = { autonomy: {} as Record<string, AutonomyLevel> };
    const fake = fakeApp({ ...options, coreSettings: { ...(options.coreSettings ?? {}), autonomy: core.autonomy } });
    const undoJournal = new UndoJournal();
    const autonomy: FakeAutonomy = {
        neverAuto: new Set(),
        stats: [],
        setLevelCalls: [],
        withoutSetLevel: () => {
            delete (service as Partial<typeof service>).setLevel;
        },
    };
    const service = {
        level: (kind: string, fallback: AutonomyLevel) => core.autonomy[kind] ?? fallback,
        decide: async () => 'applied' as const,
        record: () => {},
        stats: () =>
            autonomy.stats.map((kind) => ({ kind, accepted: 0, edited: 0, rejected: 0, undone: 0, streak: 0 })),
        neverAuto: (kind: string) => autonomy.neverAuto.add(kind),
        isNeverAuto: (kind: string) => autonomy.neverAuto.has(kind),
        setLevel: (kind: string, level: AutonomyLevel) => {
            if (level === 'auto' && autonomy.neverAuto.has(kind)) return false;
            autonomy.setLevelCalls.push({ kind, level });
            core.autonomy[kind] = level;
            return true;
        },
    };
    const result = fake as WriteFake;
    result.saves = 0;
    const settings = fake.app.settings as unknown as Record<string, unknown>;
    settings.save = () => {
        result.saves += 1;
    };
    Object.assign(fake.app, { journal: undoJournal, autonomy: service });
    result.undoJournal = undoJournal;
    result.autonomy = autonomy;
    result.core = core;
    result.tools = writeTools(fake.app, fake.log);
    result.ctx = (locale = 'en', access) => toolContext(fake, { locale, settings: access ?? fakeSettings({}) });
    result.plan = async (name, args, locale = 'en') => {
        const tool = toolNamed(result.tools, name);
        if (!tool.plan) throw new Error(`${name} has no plan()`);
        return tool.plan(args, result.ctx(locale));
    };
    return result;
}

/** The error message of a rejected plan (fails the test when the plan succeeds). */
export async function planError(promise: Promise<unknown>): Promise<string> {
    try {
        await promise;
    } catch (error) {
        return error instanceof Error ? error.message : String(error);
    }
    throw new Error('the plan was expected to fail');
}

/* ------------------------------------------------------------------ mechanics */

export interface FakeMechanics extends MechanicsApi {
    defs: MechanicDef[];
    off: Set<string>;
    saved: MechanicDef[];
    chatCalls: { id: string; on: boolean }[];
}

export function fakeMechanics(defs: MechanicDef[] = [], templates: MechanicTemplate[] = []): FakeMechanics {
    const api = {
        defs,
        off: new Set<string>(),
        saved: [] as MechanicDef[],
        chatCalls: [] as { id: string; on: boolean }[],
        list: () => api.defs,
        active: () => api.defs.filter((def) => !api.off.has(def.id)),
        get: (id: string) => api.defs.find((def) => def.id === id) ?? null,
        save: async (def: MechanicDef) => {
            const stored = { ...structuredClone(def), book: def.book ?? 'Maestro Mechanics', uid: def.uid ?? 7 };
            api.saved.push(stored);
            const index = api.defs.findIndex((item) => item.id === def.id);
            if (index >= 0) api.defs[index] = stored;
            else api.defs.push(stored);
            return stored;
        },
        remove: async () => {},
        templates: () => templates,
        fromTemplate: (id: string) => {
            const template = templates.find((item) => item.id === id);
            if (!template) return null;
            const taken = api.defs.map((def) => def.id);
            return defFromTemplate(template, 'en', { kind: 'card', avatar: 'kai.png' }, taken) as MechanicDef;
        },
        setEnabledInChat: async (id: string, on: boolean) => {
            api.chatCalls.push({ id, on });
            if (on) api.off.delete(id);
            else api.off.add(id);
        },
        state: () => [],
        value: () => null,
        set: async () => {},
        history: () => [],
        roll: async () => {
            throw new Error('not in tests');
        },
        checks: () => [],
        events: () => [],
        onChange: () => () => {},
    };
    return api as unknown as FakeMechanics;
}

export function healthDef(patch: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'health',
        name: 'Здоровье',
        summary: 'Physical condition.',
        rules: 'At 0 the holder falls unconscious.',
        attributes: [{ id: 'hp', name: 'HP', promptName: 'Health', kind: 'number', min: 0, max: 100, initial: 100 }],
        holders: { kind: 'characters' },
        checks: [],
        tracking: 'block',
        scope: { kind: 'global' },
        book: 'Maestro Mechanics',
        uid: 3,
        ...patch,
    };
}

/* ------------------------------------------------------------------ preset studio */

export interface FakePreset {
    store: PresetStore;
    layer: PresetLayerApi;
    current: { name: string };
    prompts: PresetPrompt[];
    order: PresetOrderItem[];
    saved: Map<string, PresetBody>;
    layers: Map<string, LayerOp[]>;
    calls: { method: string; args: unknown[] }[];
}

export function fakePreset(
    prompts: PresetPrompt[],
    options: { base?: string; savedPrompts?: PresetPrompt[] } = {},
): FakePreset {
    const current = { name: options.base ?? 'Marinara' };
    const order: PresetOrderItem[] = prompts.map((prompt) => ({ identifier: prompt.identifier, enabled: true }));
    const saved = new Map<string, PresetBody>([
        [current.name, { prompts: structuredClone(options.savedPrompts ?? prompts) }],
    ]);
    const layers = new Map<string, LayerOp[]>();
    const calls: FakePreset['calls'] = [];
    const log = (method: string, ...args: unknown[]) => calls.push({ method, args: structuredClone(args) });
    const store = {
        names: () => [current.name],
        current: () => current.name,
        working: (): PresetBody => ({ prompts: structuredClone(prompts) }),
        saved: (name: string) => saved.get(name) ?? null,
        draft: () => ({ dirty: false, changedPrompts: [], changedKeys: [] }),
        prompts: () =>
            order.map((item) => ({
                item: { ...item },
                prompt: structuredClone(prompts.find((prompt) => prompt.identifier === item.identifier) ?? null),
            })),
        updatePrompt: async (identifier: string, patch: Partial<PresetPrompt>) => {
            log('updatePrompt', identifier, patch);
            const prompt = prompts.find((item) => item.identifier === identifier);
            if (prompt) Object.assign(prompt, patch);
        },
        addPrompt: async (prompt: PresetPrompt, after?: string) => {
            log('addPrompt', prompt, after);
            const { enabled, ...rest } = prompt as PresetPrompt & { enabled?: boolean };
            prompts.push(rest as PresetPrompt);
            const index = after === undefined ? 0 : order.findIndex((item) => item.identifier === after) + 1;
            order.splice(index, 0, { identifier: prompt.identifier, enabled: enabled !== false });
            return prompt.identifier;
        },
        setEnabled: async (identifiers: string[], enabled: boolean) => {
            log('setEnabled', identifiers, enabled);
            for (const item of order) if (identifiers.includes(item.identifier)) item.enabled = enabled;
        },
        save: async (...args: unknown[]) => log('save', ...args),
        saveAs: async (...args: unknown[]) => {
            log('saveAs', ...args);
            return '';
        },
        removePrompt: async (...args: unknown[]) => log('removePrompt', ...args),
        reorder: async (...args: unknown[]) => log('reorder', ...args),
        setKeys: async (...args: unknown[]) => log('setKeys', ...args),
        onChange: () => () => {},
    } as unknown as PresetStore;
    const layer = {
        get: (base: string): Layer | null => {
            const ops = layers.get(base);
            return ops?.length ? { base, ops: structuredClone(ops), updatedAt: 1 } : null;
        },
        record: async (base: string, op: LayerOp) => {
            log('layer.record', base, op);
            layers.set(base, [...(layers.get(base) ?? []), structuredClone(op)]);
        },
        remove: async (...args: unknown[]) => log('layer.remove', ...args),
        onChange: () => () => {},
    } as unknown as PresetLayerApi;
    return { store, layer, current, prompts, order, saved, layers, calls };
}

export function prompt(
    identifier: string,
    name: string,
    content = '',
    patch: Partial<PresetPrompt> = {},
): PresetPrompt {
    return { identifier, name, role: 'system', content, system_prompt: false, marker: false, ...patch };
}

/* ------------------------------------------------------------------ lore */

export interface FakeLore {
    store: LoreStore;
    books: Map<string, WiBookData>;
    created: { book: string; partial: Partial<WiEntry>; reason?: SaveReason }[];
    updated: { book: string; uid: number; patch: Partial<WiEntry>; reason: SaveReason }[];
}

export function wiEntry(uid: number, patch: Record<string, unknown> = {}): WiEntry {
    return { uid, key: [], keysecondary: [], content: '', comment: '', disable: false, constant: false, ...patch };
}

export function fakeLore(books: Record<string, Record<string, WiEntry>>): FakeLore {
    const map = new Map<string, WiBookData>(
        Object.entries(books).map(([name, entries]) => [name, { entries: structuredClone(entries) }]),
    );
    const created: FakeLore['created'] = [];
    const updated: FakeLore['updated'] = [];
    const store = {
        books: () => [...map.keys()],
        load: async (name: string) => (map.has(name) ? structuredClone(map.get(name)!) : null),
        createEntry: async (book: string, partial: Partial<WiEntry> = {}, reason?: SaveReason) => {
            created.push({ book, partial: structuredClone(partial), ...(reason ? { reason } : {}) });
            const data = map.get(book)!;
            let uid = 0;
            while (String(uid) in data.entries) uid++;
            data.entries[String(uid)] = wiEntry(uid, partial as Record<string, unknown>);
            return uid;
        },
        updateEntry: async (book: string, uid: number, patch: Partial<WiEntry>, reason: SaveReason) => {
            updated.push({ book, uid, patch: structuredClone(patch), reason });
            const entry = map.get(book)!.entries[String(uid)]!;
            Object.assign(entry, patch);
        },
        onChange: () => () => {},
    } as unknown as LoreStore;
    return { store, books: map, created, updated };
}

export interface FakeRoles extends BookRolesApi {
    roles: Map<string, Partial<BookRoleInfo>>;
    meta: Map<string, Record<string, unknown>>;
    metaWrites: { book: string; uid: number; meta: Record<string, unknown> | undefined }[];
}

export function fakeRoles(roles: Record<string, Partial<BookRoleInfo>> = {}): FakeRoles {
    const api = {
        roles: new Map(Object.entries(roles)),
        meta: new Map<string, Record<string, unknown>>(),
        metaWrites: [] as FakeRoles['metaWrites'],
        roleOf: (book: string) => {
            const info = api.roles.get(book);
            return info
                ? ({
                      book,
                      source: 'user',
                      fingerprint: '',
                      readOnly: false,
                      localizable: true,
                      ...info,
                  } as BookRoleInfo)
                : undefined;
        },
        all: () => [],
        setRole: async () => {},
        refresh: async () => {},
        entryMeta: (book: string, uid: number) => api.meta.get(`${book}#${uid}`),
        loadEntryMeta: async (book: string, uid: number) => api.meta.get(`${book}#${uid}`),
        setEntryMeta: async (book: string, uid: number, meta: Record<string, unknown> | undefined) => {
            api.metaWrites.push({ book, uid, meta: structuredClone(meta) });
            if (meta) api.meta.set(`${book}#${uid}`, meta);
            else api.meta.delete(`${book}#${uid}`);
        },
        onChange: () => () => {},
    };
    return api as unknown as FakeRoles;
}

export interface FakePassports extends LorePassportsApi {
    stored: Map<string, LorePassport>;
    sets: { world: string; uid: number; passport: Record<string, unknown>; by?: string }[];
    place: PassportPlace;
}

export function fakePassports(place: PassportPlace = 'sidecar'): FakePassports {
    const api = {
        stored: new Map<string, LorePassport>(),
        sets: [] as FakePassports['sets'],
        place,
        get: async (world: string, uid: number) => api.stored.get(`${world}#${uid}`) ?? null,
        set: async (world: string, uid: number, passport: Record<string, unknown>, by?: string) => {
            api.sets.push({ world, uid, passport: structuredClone(passport), ...(by ? { by } : {}) });
        },
        remove: async () => {},
        generate: async () => null,
        forScene: () => [],
        onChange: () => () => {},
        storageOf: async () => api.place,
    };
    return api as unknown as FakePassports;
}
