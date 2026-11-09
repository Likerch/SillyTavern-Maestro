// M45 «Мизансцена» (plan docs/agents-plan.md §3.16, release 1.32): where everyone is and how — pose, place in the scene,
// who they are next to, what they hold, what is visible on them. Pure: merging an agent's changes into the record of a
// reply, and the short prompt line «кто где и как» (≤ ~80 tokens).

export interface StagingEntry {
    name: string;
    /** Stands, sits, lies, kneels… */
    pose?: string;
    /** At the window, at the table, in the door. */
    where?: string;
    /** Next to whom and how: facing Kai, behind Mira, holding her hand. */
    near?: string;
    holding?: string;
    /** What is visible on the body: wet, wounded, bound. */
    state?: string;
}

export const STAGING_FIELDS = ['pose', 'where', 'near', 'holding', 'state'] as const;
export type StagingField = (typeof STAGING_FIELDS)[number];

/** The prompt line's limit in characters (about 80 tokens). */
export const STAGING_LINE_MAX = 340;

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function fold(name: string): string {
    return name.trim().toLowerCase().replace(/ё/g, 'е');
}

function clean(value: unknown, max = 120): string | undefined {
    if (typeof value !== 'string') return undefined;
    const text = value.replace(/\s+/g, ' ').trim().slice(0, max);
    return text || undefined;
}

/** One entry from stored or proposed data; null without a name. */
export function sanitizeEntry(raw: unknown): StagingEntry | null {
    if (!isDict(raw)) return null;
    const name = clean(raw.name, 80);
    if (!name) return null;
    const entry: StagingEntry = { name };
    for (const field of STAGING_FIELDS) {
        const value = clean(raw[field]);
        if (value) entry[field] = value;
    }
    return entry;
}

export function sanitizeEntries(raw: unknown): StagingEntry[] {
    if (!Array.isArray(raw)) return [];
    const out: StagingEntry[] = [];
    for (const item of raw) {
        const entry = sanitizeEntry(item);
        if (entry && !out.some((other) => fold(other.name) === fold(entry.name))) out.push(entry);
        if (out.length >= 12) break;
    }
    return out;
}

/**
 * The record after a reply: the previous one with the changes on top (a field the change gives replaces the old one;
 * one it leaves out stays); `gone` names leave the scene.
 */
export function mergeStaging(
    previous: readonly StagingEntry[],
    changes: readonly StagingEntry[],
    gone: readonly string[] = [],
): StagingEntry[] {
    const goneSet = new Set(gone.map(fold));
    const out = previous.filter((entry) => !goneSet.has(fold(entry.name))).map((entry) => ({ ...entry }));
    for (const change of changes) {
        if (goneSet.has(fold(change.name))) continue;
        const current = out.find((entry) => fold(entry.name) === fold(change.name));
        if (!current) {
            out.push({ ...change });
            continue;
        }
        for (const field of STAGING_FIELDS) if (change[field] !== undefined) current[field] = change[field];
    }
    return out.slice(0, 12);
}

/** «Mira: sits at the table by the window, holding a cup; next to Kai.» */
export function describeEntry(entry: StagingEntry): string {
    const parts = [entry.pose, entry.where].filter(Boolean).join(' ');
    const rest = [entry.holding ? `holding ${entry.holding}` : '', entry.near ?? '', entry.state ?? ''].filter(Boolean);
    const body = [parts, ...rest].filter(Boolean).join('; ');
    return body ? `${entry.name}: ${body}` : entry.name;
}

/** The prompt line (empty when nothing is known), cut to STAGING_LINE_MAX. */
export function stagingLine(entries: readonly StagingEntry[]): string {
    if (!entries.length) return '';
    const text = `[Staging now — keep it consistent: ${entries.map(describeEntry).join(' | ')}]`;
    return text.length <= STAGING_LINE_MAX ? text : `${text.slice(0, STAGING_LINE_MAX - 2).trimEnd()}…]`;
}
