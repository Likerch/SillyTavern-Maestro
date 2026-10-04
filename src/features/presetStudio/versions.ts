// Versions of Chat Completion presets (M34 п.4): one Maestro user file per preset name,
// `maestro-preset-versions-<hash(name)>.json` (plan §4.8), packed by domain/preset-store-versions (last 30 bodies,
// long prompt texts stored once). Every write is a fresh read-modify-write, serialised per file, so two tabs merge
// instead of overwriting each other; the newest hash per name is remembered so the outside-save check of the store
// does not read the file on every SETTINGS_UPDATED.
import { readFresh } from '../../core/files';
import {
    VERSION_LIMIT,
    appendVersion,
    makeVersion,
    newestFileState,
    packVersionsDoc,
    readVersionsDoc,
} from '../../domain/preset-store-versions';
import type { StoredVersion } from '../../domain/preset-store-versions';
import type { FileStore, Logger } from '../../shared/contracts';
import type { PresetBody, PresetVersion } from './store-api';

export const VERSIONS_KIND = 'preset-versions';

export interface VersionInput {
    by: string;
    summary: string;
    body: Record<string, unknown>;
}

export class PresetVersions {
    private readonly chains = new Map<string, Promise<unknown>>();
    /** name → hash of its newest file state (null = none; drafts do not count); filled by reads and writes. */
    private readonly fileHash = new Map<string, string | null>();
    private salt = 0;

    constructor(
        private readonly files: FileStore,
        private readonly log: Logger,
        private readonly now: () => number = () => Date.now(),
    ) {}

    fileName(name: string): string {
        return this.files.fileName(VERSIONS_KIND, name);
    }

    /** Hash of the newest file state if it is already known in this tab (undefined = not read yet). */
    knownHash(name: string): string | null | undefined {
        return this.fileHash.get(name);
    }

    /** Hash of the newest file state (reads the file when this tab does not know it yet). */
    async newestFileHash(name: string): Promise<string | null> {
        const known = this.fileHash.get(name);
        if (known !== undefined) return known;
        return newestFileState(await this.load(name))?.hash ?? null;
    }

    /** Versions of a preset, newest first. */
    async list(name: string): Promise<PresetVersion[]> {
        const versions = await this.load(name);
        return [...versions].reverse().map(publicVersion);
    }

    async get(name: string, id: string): Promise<StoredVersion | null> {
        return (await this.load(name)).find((version) => version.id === id) ?? null;
    }

    async newest(name: string): Promise<StoredVersion | null> {
        const versions = await this.load(name);
        return versions[versions.length - 1] ?? null;
    }

    /**
     * Appends versions in order in one write; a body that repeats the newest file state (or, for a draft, the
     * newest version) is not added again. Returns, for each input, the version that now holds its body; null
     * inputs are skipped and give null.
     */
    record(name: string, inputs: readonly (VersionInput | null)[]): Promise<(StoredVersion | null)[]> {
        return this.serial(name, async () => {
            let versions = await this.load(name);
            const result: (StoredVersion | null)[] = [];
            let changed = false;
            for (const input of inputs) {
                if (!input) {
                    result.push(null);
                    continue;
                }
                const version = makeVersion(input.body, {
                    at: this.now(),
                    by: input.by,
                    summary: input.summary,
                    salt: String(this.salt++),
                });
                const next = appendVersion(versions, version, VERSION_LIMIT);
                versions = next.versions;
                changed ||= next.added;
                result.push(next.holder);
            }
            if (changed) await this.files.write(this.fileName(name), packVersionsDoc(name, versions));
            this.fileHash.set(name, newestFileState(versions)?.hash ?? null);
            return result;
        });
    }

    /** Versions follow a rename (P-181); they merge with versions an earlier preset of the new name left. */
    rename(oldName: string, newName: string): Promise<void> {
        return this.serial(oldName, () =>
            this.serial(newName, async () => {
                const moving = await this.load(oldName);
                if (!moving.length) return;
                const existing = await this.load(newName);
                const merged = [...existing, ...moving].sort((a, b) => a.at - b.at).slice(-VERSION_LIMIT);
                await this.files.write(this.fileName(newName), packVersionsDoc(newName, merged));
                await this.files.remove(this.fileName(oldName));
                this.fileHash.set(newName, newestFileState(merged)?.hash ?? null);
                this.fileHash.set(oldName, null);
            }),
        );
    }

    private async load(name: string): Promise<StoredVersion[]> {
        const doc = readVersionsDoc(await readFresh(this.files, this.fileName(name)));
        if (doc && doc.name && doc.name !== name) {
            // Another name with the same hash: not ours (practically never with a 53-bit hash).
            this.log.warn(`versions file of "${name}" belongs to "${doc.name}"`);
            return [];
        }
        const versions = doc?.versions ?? [];
        this.fileHash.set(name, newestFileState(versions)?.hash ?? null);
        return versions;
    }

    private serial<R>(name: string, job: () => Promise<R>): Promise<R> {
        const key = this.fileName(name);
        const previous = this.chains.get(key) ?? Promise.resolve();
        const next = previous.then(job, job);
        const settled = next.catch(() => undefined);
        this.chains.set(key, settled);
        void settled.then(() => {
            if (this.chains.get(key) === settled) this.chains.delete(key);
        });
        return next;
    }
}

function publicVersion(version: StoredVersion): PresetVersion {
    return {
        id: version.id,
        at: version.at,
        by: version.by,
        summary: version.summary,
        body: JSON.parse(JSON.stringify(version.body)) as PresetBody,
    };
}
