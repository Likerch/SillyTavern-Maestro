// Settings snapshots and their comparison (M4 «Страж настроек и вкладок», plan M4, audit T11/A17).
// A snapshot is a flat map `path → value` over a curated list of keys; drift is the difference between two
// snapshots. Values are compared by stable JSON (object key order does not matter). Also here: the tab stamp
// Maestro keeps inside settings.json (ST has no settings revision) and the "what would this tab overwrite"
// comparison of two settings objects. Pure: no DOM, network or SillyTavern.
import { stableHash } from './hash';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ stable comparison */

/** JSON with sorted object keys; `undefined` (also nested) becomes null. Throws on cycles, like JSON. */
export function stableStringify(value: unknown): string {
    return (
        JSON.stringify(value === undefined ? null : value, (_key, item: unknown) => {
            if (item === undefined) return null;
            if (!isDict(item)) return item;
            const sorted: Dict = {};
            for (const key of Object.keys(item).sort()) sorted[key] = item[key];
            return sorted;
        }) ?? 'null'
    );
}

/** Deep equality by stable JSON. Values that cannot be serialised are never equal. */
export function valuesEqual(a: unknown, b: unknown): boolean {
    if (a === b) return true;
    try {
        return stableStringify(a) === stableStringify(b);
    } catch {
        return false;
    }
}

/** Short stable hash of any JSON value (used for large values: prompt texts, preset bodies, regexes). */
export function valueHash(value: unknown): string {
    try {
        return stableHash(stableStringify(value));
    } catch {
        return 'unhashable';
    }
}

/** JSON deep copy (drops functions and undefined like JSON does). */
export function jsonCopy<T>(value: T): T {
    if (value === undefined) return value;
    return JSON.parse(JSON.stringify(value)) as T;
}

/* ------------------------------------------------------------------ dotted paths */

/** `a.b.c` inside nested plain objects; undefined when any step is missing. */
export function getPath(source: unknown, path: string): unknown {
    let current: unknown = source;
    for (const part of path.split('.')) {
        if (!isDict(current)) return undefined;
        current = current[part];
    }
    return current;
}

/** Sets `a.b.c`, creating plain objects on the way. `undefined` deletes the last key. */
export function setPath(target: Dict, path: string, value: unknown): void {
    const parts = path.split('.');
    const last = parts.pop();
    if (last === undefined || last === '') return;
    let current: Dict = target;
    for (const part of parts) {
        const next = current[part];
        if (isDict(next)) {
            current = next;
        } else {
            const created: Dict = {};
            current[part] = created;
            current = created;
        }
    }
    if (value === undefined) delete current[last];
    else current[last] = value;
}

/** True when `path` equals one of the patterns or lies under one (`preset` covers `preset.body`). */
export function pathMatches(path: string, patterns: readonly string[]): boolean {
    return patterns.some((pattern) => path === pattern || path.startsWith(`${pattern}.`));
}

/* ------------------------------------------------------------------ tracked keys */

/** One tracked key of a settings object (curated lists live with M4). */
export interface KeySpec {
    /** Dotted path inside the source object. */
    path: string;
    /** Track only a hash of the value (long texts); the full value goes to the restore map. */
    hash?: boolean;
    /** Keys left out of an object value (volatile or private parts). */
    omit?: readonly string[];
}

export interface TrackedPart {
    /** Compared values by path. */
    values: Dict;
    /** Full values for paths whose tracked value is only a hash. */
    restore: Dict;
}

function omitKeys(value: unknown, omit: readonly string[] | undefined): unknown {
    if (!omit?.length || !isDict(value)) return value;
    const copy: Dict = { ...value };
    for (const key of omit) delete copy[key];
    return copy;
}

/**
 * The tracked form of one key's full value: a JSON copy without `spec.omit`, or (for `spec.hash`) a hash of it
 * with the copy kept for restore. Null when the value cannot be copied.
 */
export function trackedValue(raw: unknown, spec: KeySpec): { value: unknown; restore?: unknown } | null {
    let value: unknown;
    try {
        value = jsonCopy(omitKeys(raw, spec.omit));
    } catch {
        return null;
    }
    return spec.hash ? { value: valueHash(value), restore: value } : { value };
}

/**
 * Picks the tracked keys of `source` under `prefix` (`ck.enabled`). Missing keys are skipped, so a key that
 * appears or disappears shows as added or removed drift. Values are JSON copies.
 */
export function pickTracked(source: unknown, specs: readonly KeySpec[], prefix: string): TrackedPart {
    const part: TrackedPart = { values: {}, restore: {} };
    if (!isDict(source)) return part;
    for (const spec of specs) {
        const raw = getPath(source, spec.path);
        if (raw === undefined) continue;
        const tracked = trackedValue(raw, spec);
        if (!tracked) continue;
        const path = `${prefix}.${spec.path}`;
        part.values[path] = tracked.value;
        if (spec.hash) part.restore[path] = tracked.restore;
    }
    return part;
}

/** A copy of `part` with only the paths `keep` accepts (in `values` and in `restore`). */
export function filterTracked(part: TrackedPart, keep: (path: string) => boolean): TrackedPart {
    const pick = (source: Dict): Dict => Object.fromEntries(Object.entries(source).filter(([path]) => keep(path)));
    return { values: pick(part.values), restore: pick(part.restore) };
}

/** Merges tracked parts (later parts win on equal paths). */
export function mergeTracked(...parts: TrackedPart[]): TrackedPart {
    const merged: TrackedPart = { values: {}, restore: {} };
    for (const part of parts) {
        Object.assign(merged.values, part.values);
        Object.assign(merged.restore, part.restore);
    }
    return merged;
}

/* ------------------------------------------------------------------ drift */

export interface DriftEntry {
    path: string;
    kind: 'added' | 'removed' | 'changed';
    baseline: unknown;
    current: unknown;
}

/** Paths whose value differs between two snapshots, sorted by path. */
export function diffTracked(baseline: Dict, current: Dict): DriftEntry[] {
    const paths = new Set([...Object.keys(baseline), ...Object.keys(current)]);
    const entries: DriftEntry[] = [];
    for (const path of [...paths].sort()) {
        const inBaseline = Object.hasOwn(baseline, path);
        const inCurrent = Object.hasOwn(current, path);
        const before = inBaseline ? baseline[path] : undefined;
        const after = inCurrent ? current[path] : undefined;
        if (inBaseline && inCurrent) {
            if (!valuesEqual(before, after)) entries.push({ path, kind: 'changed', baseline: before, current: after });
        } else if (inCurrent) {
            entries.push({ path, kind: 'added', baseline: undefined, current: after });
        } else {
            entries.push({ path, kind: 'removed', baseline: before, current: undefined });
        }
    }
    return entries;
}

/** The group a path belongs to: its first segment (`preset`, `regex`, `qvink`, …). */
export function groupOf(path: string): string {
    const dot = path.indexOf('.');
    return dot < 0 ? path : path.slice(0, dot);
}

/** Identity of a drift set: the same changes give the same hash (Inbox de-duplication). */
export function driftHash(entries: readonly { path: string; current: unknown }[]): string {
    return valueHash(entries.map((entry) => [entry.path, entry.current]));
}

/**
 * Applies acknowledged paths to a baseline: each matching path takes its current value (or disappears when the
 * current snapshot no longer has it). Returns the paths that changed.
 */
export function acknowledgePaths(baseline: TrackedPart, current: TrackedPart, patterns: readonly string[]): string[] {
    const changed: string[] = [];
    const paths = new Set([...Object.keys(baseline.values), ...Object.keys(current.values)]);
    for (const path of paths) {
        if (!pathMatches(path, patterns)) continue;
        const has = Object.hasOwn(current.values, path);
        if (has && valuesEqual(baseline.values[path], current.values[path]) && Object.hasOwn(baseline.values, path))
            continue;
        if (has) {
            baseline.values[path] = current.values[path];
            if (Object.hasOwn(current.restore, path)) baseline.restore[path] = current.restore[path];
            else delete baseline.restore[path];
        } else {
            delete baseline.values[path];
            delete baseline.restore[path];
        }
        changed.push(path);
    }
    return changed.sort();
}

/* ------------------------------------------------------------------ settings.json comparison */

export interface TopLevelDiffOptions {
    /** Prefix for reported keys (`extension_settings`). */
    prefix: string;
    /** Keys to skip. */
    ignore?: readonly string[];
    /** Stop after this many differences. */
    limit?: number;
}

/**
 * Top-level keys whose values differ between this tab's object and the server copy (what a save from this
 * tab would overwrite). Keys that cannot be serialised are skipped. Best effort by design.
 */
export function topLevelDiff(local: unknown, server: unknown, options: TopLevelDiffOptions): string[] {
    if (!isDict(local) || !isDict(server)) return [];
    const keys = [...new Set([...Object.keys(local), ...Object.keys(server)])].sort();
    const result: string[] = [];
    for (const key of keys) {
        if (options.ignore?.includes(key)) continue;
        let same: boolean;
        try {
            same = stableStringify(local[key]) === stableStringify(server[key]);
        } catch {
            continue;
        }
        if (!same) result.push(`${options.prefix}.${key}`);
        if (options.limit !== undefined && result.length >= options.limit) break;
    }
    return result;
}

/* ------------------------------------------------------------------ tab stamp */

/** Written into Maestro's settings slice; every save from a guarded tab carries its own stamp. */
export interface TabStamp {
    tabId: string;
    /** Bumped after each successful settings save of that tab. */
    seq: number;
    at: number;
}

/** What this tab believes the server holds. */
export type KnownStamp =
    /** The last settings save came from this tab (any stamp with our tab id). */
    | { kind: 'mine' }
    /** Exactly this stamp (null = no stamp at all), e.g. the one loaded with the page. */
    | { kind: 'exact'; stamp: TabStamp | null };

export function readStamp(value: unknown): TabStamp | null {
    if (!isDict(value)) return null;
    const { tabId, seq, at } = value;
    if (typeof tabId !== 'string' || !tabId) return null;
    if (typeof seq !== 'number' || !Number.isFinite(seq)) return null;
    return { tabId, seq, at: typeof at === 'number' && Number.isFinite(at) ? at : 0 };
}

export function sameStamp(a: TabStamp | null, b: TabStamp | null): boolean {
    if (a === null || b === null) return a === b;
    return a.tabId === b.tabId && a.seq === b.seq;
}

/**
 * The stamp inside the `settings` string of `/api/settings/get` (settings.json as text). `undefined` when the
 * text is not JSON (the check failed), null when the file has no stamp.
 */
export function stampFromSettingsText(text: unknown, path: string): TabStamp | null | undefined {
    const parsed = parseSettingsText(text);
    if (parsed === undefined) return undefined;
    return readStamp(getPath(parsed, path));
}

/** Parses settings.json text; undefined when it is not a JSON object. */
export function parseSettingsText(text: unknown): Dict | undefined {
    if (typeof text !== 'string') return undefined;
    try {
        const parsed: unknown = JSON.parse(text);
        return isDict(parsed) ? parsed : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Fresh = nobody else saved settings since this tab last did (or since it loaded them). A stamp with our tab id
 * means the last save was ours: seq races inside one tab (two saves in flight) do not make it stale.
 */
export function isTabFresh(known: KnownStamp, server: TabStamp | null, myTabId: string): boolean {
    if (known.kind === 'mine') return server !== null && server.tabId === myTabId;
    if (server !== null && server.tabId === myTabId) return true;
    return sameStamp(known.stamp, server);
}
