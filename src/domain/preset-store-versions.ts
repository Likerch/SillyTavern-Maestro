// Versions of a Chat Completion preset (Preset Studio, M34 п.4): one Maestro file per preset name with the last 30
// saved bodies (sensitive keys stripped), who saved each (`user`, `layer`, `import`, `st` — saved outside Maestro,
// `draft` — unsaved edits snapped before a preset switch, `migration`) and a summary. Prompt texts repeat from
// version to version, so long ones are stored once per file in `blobs` and referenced by key: a 30-version file of a
// large preset stays close to the size of one body. Pure: no DOM, network or SillyTavern.
import { bodyHash } from './preset-store-diff';
import { jsonClean, SENSITIVE_PRESET_KEYS, withoutKeys } from './preset-store-keys';
import { stableHash } from './hash';

type Dict = Record<string, unknown>;

export const VERSION_LIMIT = 30;
export const VERSIONS_SCHEMA = 1;
/** Prompt texts at least this long go to `blobs`. */
export const BLOB_MIN_CHARS = 200;

export interface StoredVersion {
    id: string;
    at: number;
    by: string;
    summary: string;
    /** bodyHash() of the body: detects saves made outside Maestro. */
    hash: string;
    body: Dict;
}

export interface VersionsDoc {
    schema: typeof VERSIONS_SCHEMA;
    /** The preset name (the file name only carries its hash). */
    name: string;
    versions: StoredVersion[];
    blobs: Record<string, string>;
}

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function makeVersionId(at: number, salt: string): string {
    return `v-${at.toString(36)}-${stableHash(`${at}:${salt}`).slice(0, 6)}`;
}

/** A version entry for `body` (copied, sensitive keys stripped). */
export function makeVersion(
    body: Dict,
    meta: { at: number; by: string; summary: string; salt?: string },
): StoredVersion {
    const clean = jsonClean(withoutKeys(body, SENSITIVE_PRESET_KEYS));
    const hash = bodyHash(clean);
    return {
        id: makeVersionId(meta.at, `${meta.salt ?? ''}:${hash}`),
        at: meta.at,
        by: meta.by,
        summary: meta.summary,
        hash,
        body: clean,
    };
}

/** `by` of a snapshot of unsaved edits: not a state the file ever had. */
export const DRAFT_BY = 'draft';

/** The newest version that is a state of the file (not a draft snapshot), or null. */
export function newestFileState(versions: readonly StoredVersion[]): StoredVersion | null {
    for (let i = versions.length - 1; i >= 0; i--) {
        const version = versions[i];
        if (version && version.by !== DRAFT_BY) return version;
    }
    return null;
}

/**
 * Appends a version unless it repeats what is there: a file state equal to the newest file state, or a draft
 * equal to the newest version or to the file. Keeps the newest `limit`; versions are stored oldest first.
 * `holder` is the version that now holds the body (the new one, or the one it repeated).
 */
export function appendVersion(
    versions: readonly StoredVersion[],
    version: StoredVersion,
    limit = VERSION_LIMIT,
): { versions: StoredVersion[]; added: boolean; holder: StoredVersion } {
    const file = newestFileState(versions);
    const last = versions[versions.length - 1];
    const same = version.by === DRAFT_BY ? [last, file] : [file];
    const repeated = same.find((item) => item?.hash === version.hash);
    if (repeated) return { versions: [...versions], added: false, holder: repeated };
    const next = [...versions, version];
    if (next.length > limit) next.splice(0, next.length - limit);
    return { versions: next, added: true, holder: version };
}

function blobKey(text: string, blobs: Record<string, string>): string {
    const base = `${stableHash(text)}.${text.length}`;
    let key = base;
    for (let n = 1; blobs[key] !== undefined && blobs[key] !== text; n++) key = `${base}-${n}`;
    return key;
}

function packBody(body: Dict, blobs: Record<string, string>): Dict {
    if (!Array.isArray(body.prompts)) return body;
    return {
        ...body,
        prompts: body.prompts.map((prompt: unknown) => {
            if (!isDict(prompt) || typeof prompt.content !== 'string' || prompt.content.length < BLOB_MIN_CHARS) {
                return prompt;
            }
            const key = blobKey(prompt.content, blobs);
            blobs[key] = prompt.content;
            return { ...prompt, content: { $blob: key } };
        }),
    };
}

/** The file content: versions with long prompt texts moved to `blobs` (only blobs still referenced are kept). */
export function packVersionsDoc(name: string, versions: readonly StoredVersion[]): VersionsDoc {
    const blobs: Record<string, string> = {};
    const packed = versions.map((version) => ({ ...version, body: packBody(version.body, blobs) }));
    return { schema: VERSIONS_SCHEMA, name, versions: packed, blobs };
}

function unpackBody(body: Dict, blobs: Record<string, string>): Dict | null {
    if (!Array.isArray(body.prompts)) return body;
    let broken = false;
    const prompts = body.prompts.map((prompt: unknown) => {
        if (!isDict(prompt) || !isDict(prompt.content)) return prompt;
        const key = prompt.content.$blob;
        const text = typeof key === 'string' ? blobs[key] : undefined;
        if (text === undefined) broken = true;
        return { ...prompt, content: text ?? '' };
    });
    return broken ? null : { ...body, prompts };
}

function readVersion(raw: unknown, blobs: Record<string, string>): StoredVersion | null {
    if (!isDict(raw) || typeof raw.id !== 'string' || !isDict(raw.body)) return null;
    const body = unpackBody(raw.body, blobs);
    if (!body) return null;
    return {
        id: raw.id,
        at: typeof raw.at === 'number' ? raw.at : 0,
        by: typeof raw.by === 'string' ? raw.by : 'st',
        summary: typeof raw.summary === 'string' ? raw.summary : '',
        hash: typeof raw.hash === 'string' && raw.hash ? raw.hash : bodyHash(body),
        body,
    };
}

/** Validates a stored file; versions that cannot be restored (missing blob, no body) are dropped. */
export function readVersionsDoc(raw: unknown): { name: string; versions: StoredVersion[] } | null {
    if (!isDict(raw) || raw.schema !== VERSIONS_SCHEMA || !Array.isArray(raw.versions)) return null;
    const blobs: Record<string, string> = {};
    if (isDict(raw.blobs)) {
        for (const [key, value] of Object.entries(raw.blobs)) if (typeof value === 'string') blobs[key] = value;
    }
    const versions = raw.versions
        .map((item) => readVersion(item, blobs))
        .filter((item): item is StoredVersion => item !== null);
    return { name: typeof raw.name === 'string' ? raw.name : '', versions };
}
