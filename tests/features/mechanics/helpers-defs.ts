// Test environment of the M25 definitions part: the canon test app (ST mock with an in-memory World Info, real
// i18n, settings, chat store and bus, recording journal and UI) with the definitions strings, a fake of the M35 roles
// API, the current character, and in-memory fakes of the parts for the views and the service.
import { desStatsAttributes } from '../../../src/domain/mechanics-defs';
import type { BookRole, BookRoleInfo, BookRolesApi } from '../../../src/features/bookRoles/api';
import type { MechanicDef } from '../../../src/features/mechanics/api';
import { MechanicDefinitions } from '../../../src/features/mechanics/definitions';
import type { DefinitionsPart, MechanicsSettings, PartDeps, TrackingPart } from '../../../src/features/mechanics/parts';
import { readMechanicsSettings } from '../../../src/features/mechanics/settings';
import { DEF_STRINGS } from '../../../src/features/mechanics/strings-defs';
import type { Unsubscribe } from '../../../src/shared/contracts';
import { createCanonTestApp, settle } from '../canon/helpers';
import type { CanonTestApp, Dict } from '../canon/helpers';

export { settle };
export type { Dict };

export const BOOK = 'Maestro · механики';
export const AVATAR = 'kai.png';

export class FakeRoles implements BookRolesApi {
    readonly roles = new Map<string, BookRole>();
    readonly calls: [string, BookRole][] = [];
    private readonly listeners = new Set<() => void>();

    private info(book: string, role: BookRole): BookRoleInfo {
        const bunny = role === 'bunnymo.core' || role === 'bunnymo.pack';
        return { book, role, source: 'user', fingerprint: '', readOnly: bunny, localizable: !bunny };
    }

    roleOf(book: string): BookRoleInfo | undefined {
        const role = this.roles.get(book);
        return role ? this.info(book, role) : undefined;
    }

    all(): BookRoleInfo[] {
        return [...this.roles].map(([book, role]) => this.info(book, role));
    }

    async setRole(book: string, role: BookRole): Promise<void> {
        this.calls.push([book, role]);
        this.roles.set(book, role);
        this.emit();
    }

    async refresh(): Promise<void> {}

    entryMeta<T>(): T | undefined {
        return undefined;
    }

    async setEntryMeta(): Promise<void> {}

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    emit(): void {
        for (const listener of [...this.listeners]) listener();
    }

    listenerCount(): number {
        return this.listeners.size;
    }
}

export interface DefsEnv extends CanonTestApp {
    roles: FakeRoles;
    slice: Partial<MechanicsSettings>;
    deps: PartDeps;
    /** Sets the open character (avatar) or a group chat of several avatars. */
    character(avatar: string | null): void;
}

export function createDefsEnv(): DefsEnv {
    const env = createCanonTestApp();
    env.app.i18n.register(DEF_STRINGS);
    const roles = new FakeRoles();
    env.modules.expose('bookRoles', roles);
    const slice: Partial<MechanicsSettings> = {};
    const deps: PartDeps = { app: env.app, log: env.log, settings: () => readMechanicsSettings(slice) };
    const context = env.mock.context as unknown as Dict;
    const character = (avatar: string | null) => {
        context.characters = avatar ? [{ name: 'Kai', avatar }] : [];
        context.characterId = avatar ? 0 : undefined;
    };
    character(AVATAR);
    return Object.assign(env, { roles, slice, deps, character });
}

export function createDefinitions(env: DefsEnv): MechanicDefinitions {
    const defs = new MechanicDefinitions(env.deps);
    defs.install();
    return defs;
}

/** A small valid definition. */
export function mechanic(partial: Partial<MechanicDef> = {}): MechanicDef {
    return {
        id: 'magic',
        name: 'Магия',
        summary: 'Spellcasting powered by mana.',
        rules: 'Casting costs mana.',
        attributes: [{ id: 'mana', name: 'Мана', promptName: 'Mana', kind: 'number', min: 0, max: 100, initial: 100 }],
        holders: { kind: 'characters', includePersona: true },
        checks: [
            {
                id: 'spell',
                name: 'Заклинание',
                promptName: 'Spellcasting',
                dice: '1d100<=@mana',
                difficulty: null,
                triggers: ['заклин'],
            },
        ],
        tracking: 'desStats',
        scope: { kind: 'global' },
        ...partial,
    };
}

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** In-memory definitions part for the views and the service. */
export class FakeDefs implements DefinitionsPart {
    defs: MechanicDef[] = [];
    readonly off = new Set<string>();
    readonly saved: MechanicDef[] = [];
    readonly removed: string[] = [];
    readonly switches: [string, boolean][] = [];
    failSave: Error | null = null;
    private nextUid = 1;
    private readonly listeners = new Set<() => void>();

    list(): MechanicDef[] {
        return clone(this.defs);
    }
    all(): MechanicDef[] {
        return clone(this.defs);
    }
    active(): MechanicDef[] {
        return this.list().filter((def) => !this.off.has(def.id));
    }
    get(id: string): MechanicDef | null {
        return this.list().find((def) => def.id === id) ?? null;
    }
    async save(def: MechanicDef): Promise<MechanicDef> {
        if (this.failSave) throw this.failSave;
        const stored = { ...clone(def), book: def.book ?? BOOK, uid: def.uid ?? this.nextUid++ };
        this.defs = [...this.defs.filter((item) => item.id !== def.id), stored];
        this.saved.push(clone(stored));
        this.emit();
        return clone(stored);
    }
    async remove(id: string): Promise<void> {
        this.removed.push(id);
        this.defs = this.defs.filter((def) => def.id !== id);
        this.emit();
    }
    async setEnabledInChat(id: string, on: boolean): Promise<void> {
        this.switches.push([id, on]);
        if (on) this.off.delete(id);
        else this.off.add(id);
        this.emit();
    }
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }
    emit(): void {
        for (const listener of [...this.listeners]) listener();
    }
    listenerCount(): number {
        return this.listeners.size;
    }
    dispose(): void {
        this.listeners.clear();
    }
}

/** Tracking part that only knows DES stats (what the constructor uses). */
export class FakeTracking implements TrackingPart {
    readonly inDes = new Set<string>();
    readonly enabled: MechanicDef[] = [];
    result = true;

    blockInstruction(): string {
        return '';
    }
    desStatsStatus(def: MechanicDef): { attribute: string; inDes: boolean }[] {
        return desStatsAttributes(def).map((item) => ({ attribute: item.id, inDes: this.inDes.has(item.id) }));
    }
    async enableDesStats(def: MechanicDef): Promise<boolean> {
        this.enabled.push(clone(def));
        if (this.result) for (const item of desStatsAttributes(def)) this.inDes.add(item.id);
        return this.result;
    }
    dispose(): void {}
}
