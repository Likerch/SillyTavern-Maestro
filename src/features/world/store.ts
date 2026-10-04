// The world model's per-chat decisions (plan §2.1 «карта алиасов чата», §4.8): one chat document of kind 'world'
// holding the chat alias map, the user's merges and separations, and the merge pairs already proposed in the Inbox
// (so a rejected or expired card is not proposed again). Writes are compare-and-swap with a re-read on conflict.
import { normalizeName, pairKey } from '../../domain/world-names';
import type { App, Logger } from '../../shared/contracts';

export const WORLD_DOC = 'world';
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
}

export function emptyWorldDoc(): WorldDoc {
    return { aliases: {}, separated: [], merged: {}, proposed: [] };
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

/** Repairs a stored document in place (missing or junk fields) and returns it. */
export function readWorldDoc(doc: Record<string, unknown>): WorldDoc {
    doc.aliases = stringMap(doc.aliases);
    doc.separated = stringList(doc.separated);
    doc.merged = stringMap(doc.merged);
    doc.proposed = stringList(doc.proposed);
    return doc as unknown as WorldDoc;
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
