// The world model's per-chat decisions (plan §2.1 «карта алиасов чата», §4.8; plan-2 §9): one chat document of kind
// 'world' holding the chat alias map, the user's merges and separations, the merge pairs already proposed in the Inbox
// (so a rejected or expired card is not proposed again) and, since schema 2, the identity decisions about card and
// global sources: bound to this chat («Тот же»), declared another one's («Другой») and the questions already asked.
// Writes are compare-and-swap with a re-read on conflict.
import { normalizeName, pairKey } from '../../domain/world-names';
import type { App, ChatStore, Logger } from '../../shared/contracts';

export const WORLD_DOC = 'world';
/** Schema of the document (chat-store envelope): 2 added bound, apart and asked. */
export const WORLD_SCHEMA = 2;
const PUT_ATTEMPTS = 3;

export interface WorldDoc {
    /** Chat alias map: alias (as typed) → entity id. */
    aliases: Record<string, string>;
    /** Pair keys (pairKey) of entities declared different. */
    separated: string[];
    /** Merged entity id → kept entity id. */
    merged: Record<string, string>;
    /** Pair keys already proposed as Inbox cards. */
    proposed: string[];
    /** Source keys (domain/world-scope.ts) of card/global records bound to this chat («Тот же»). */
    bound: string[];
    /** Source keys declared another one's in this chat («Другой»). */
    apart: string[];
    /** Foreign groups asked about in the Inbox: group key → the source keys the question listed. */
    asked: Record<string, string[]>;
}

export function emptyWorldDoc(): WorldDoc {
    return { aliases: {}, separated: [], merged: {}, proposed: [], bound: [], apart: [], asked: {} };
}

/** Schema 1 → 2: the identity decisions start empty (nothing was bound or declared another one's before). */
export function migrateWorldDoc1(doc: Record<string, unknown>): Record<string, unknown> {
    return { ...doc, bound: [], apart: [], asked: {} };
}

const migrated = new WeakSet<object>();

/** Registers the document's migrations once per chat store (a module restart must not register them again). */
export function registerWorldMigrations(chat: ChatStore): void {
    if (migrated.has(chat) || typeof chat.migration !== 'function') return;
    migrated.add(chat);
    chat.migration(WORLD_DOC, 1, migrateWorldDoc1);
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringMap(value: unknown): Record<string, string> {
    const out: Record<string, string> = {};
    if (!isDict(value)) return out;
    for (const [key, item] of Object.entries(value))
        if (key.trim() && typeof item === 'string' && item) out[key] = item;
    return out;
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === 'string'))] : [];
}

function listMap(value: unknown): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    if (!isDict(value)) return out;
    for (const [key, list] of Object.entries(value)) if (key && Array.isArray(list)) out[key] = stringList(list);
    return out;
}

/** Repairs a stored document in place (missing or junk fields) and returns it. */
export function readWorldDoc(doc: Record<string, unknown>): WorldDoc {
    doc.aliases = stringMap(doc.aliases);
    doc.separated = stringList(doc.separated);
    doc.merged = stringMap(doc.merged);
    doc.proposed = stringList(doc.proposed);
    doc.bound = stringList(doc.bound);
    doc.apart = stringList(doc.apart);
    doc.asked = listMap(doc.asked);
    return doc as unknown as WorldDoc;
}

/**
 * «Тот же» (`same`) or «Другой» (`apart`) for these source keys; null takes the decision back. A key is either bound
 * or apart, never both. Returns whether the document changed.
 */
export function putIdentity(doc: WorldDoc, keys: readonly string[], decision: 'same' | 'apart' | null): boolean {
    let changed = false;
    for (const key of new Set(keys)) {
        if (!key) continue;
        for (const [list, wanted] of [
            [doc.bound, decision === 'same'],
            [doc.apart, decision === 'apart'],
        ] as const) {
            const index = list.indexOf(key);
            if (wanted && index < 0) {
                list.push(key);
                changed = true;
            } else if (!wanted && index >= 0) {
                list.splice(index, 1);
                changed = true;
            }
        }
    }
    return changed;
}

/** Remembers (or, with `asked` false, forgets) that a question about these keys was put to the user. */
export function putAsked(doc: WorldDoc, group: string, keys: readonly string[], asked: boolean): boolean {
    const list = doc.asked[group] ?? [];
    let changed = false;
    for (const key of new Set(keys)) {
        const index = list.indexOf(key);
        if (asked && index < 0) {
            list.push(key);
            changed = true;
        } else if (!asked && index >= 0) {
            list.splice(index, 1);
            changed = true;
        }
    }
    if (list.length) doc.asked[group] = list;
    else if (doc.asked[group]) {
        delete doc.asked[group];
        changed = true;
    }
    return changed;
}

/** Sets or removes one alias; other spellings of the same alias (case, ё) are replaced. */
export function putAlias(doc: WorldDoc, alias: string, entityId: string | null): boolean {
    const key = normalizeName(alias);
    if (!key) return false;
    let changed = false;
    for (const existing of Object.keys(doc.aliases)) {
        if (normalizeName(existing) === key && (existing !== alias.trim() || entityId === null)) {
            delete doc.aliases[existing];
            changed = true;
        }
    }
    if (entityId !== null && doc.aliases[alias.trim()] !== entityId) {
        doc.aliases[alias.trim()] = entityId;
        changed = true;
    }
    return changed;
}

/** The alias (any spelling) → entity id, if set. */
export function aliasTarget(doc: WorldDoc, alias: string): string | null {
    const key = normalizeName(alias);
    for (const [existing, target] of Object.entries(doc.aliases)) if (normalizeName(existing) === key) return target;
    return null;
}

export function addPair(list: string[], a: string, b: string): boolean {
    const key = pairKey(a, b);
    if (list.includes(key)) return false;
    list.push(key);
    return true;
}

/** Loads and writes the decisions document of the current chat. */
export class WorldStore {
    private doc: WorldDoc | null = null;
    private loading: Promise<WorldDoc> | null = null;
    private generation = 0;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /** What is loaded for the current chat (empty until load() finished). */
    current(): WorldDoc {
        return this.doc ?? emptyWorldDoc();
    }

    loaded(): boolean {
        return this.doc !== null;
    }

    /** Forgets the loaded document (chat switch). */
    reset(): void {
        this.generation++;
        this.doc = null;
        this.loading = null;
    }

    load(): Promise<WorldDoc> {
        if (this.doc) return Promise.resolve(this.doc);
        if (this.loading) return this.loading;
        const startedIn = this.generation;
        const loading = this.app.chat
            .get<Record<string, unknown>>(WORLD_DOC, () => emptyWorldDoc() as unknown as Record<string, unknown>)
            .then((raw) => {
                const doc = readWorldDoc(raw);
                if (startedIn === this.generation) this.doc = doc;
                return doc;
            })
            .catch((error: unknown) => {
                this.log.warn('world decisions could not be read', error);
                return emptyWorldDoc();
            })
            .finally(() => {
                if (this.loading === loading) this.loading = null;
            });
        this.loading = loading;
        return loading;
    }

    /**
     * Read-modify-write with retries: on a version conflict the chat store reloads the newer document and the change
     * is applied again. Returns false when nothing changed, the chat changed meanwhile or every attempt lost.
     */
    async mutate(change: (doc: WorldDoc) => boolean): Promise<boolean> {
        const startedIn = this.generation;
        for (let attempt = 0; attempt < PUT_ATTEMPTS; attempt++) {
            if (startedIn !== this.generation || !this.app.host.chatId()) return false;
            const raw = await this.app.chat.get<Record<string, unknown>>(
                WORLD_DOC,
                () => emptyWorldDoc() as unknown as Record<string, unknown>,
            );
            if (startedIn !== this.generation) return false;
            // A copy: a failed write must not leave the change in the chat store's cached document.
            const doc = readWorldDoc(structuredClone(raw));
            if (!change(doc)) {
                this.doc = readWorldDoc(raw);
                return false;
            }
            if (await this.app.chat.put(WORLD_DOC, doc)) {
                if (startedIn === this.generation) this.doc = doc;
                return true;
            }
        }
        this.log.warn(`world decisions could not be saved after ${PUT_ATTEMPTS} attempts`);
        return false;
    }
}
