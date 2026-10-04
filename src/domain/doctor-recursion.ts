// Static recursion graph of the active lorebooks (plan M5 п. 2, M20 п. 2). Edge A → B: B's primary key matches A's
// content, so once A is in the prompt, ST's recursion activates B (A without preventRecursion, B without
// excludeRecursion; research/st-world-info.md §2, §4). The graph ignores chat text, secondary keys, probability and
// timed effects, so it is an upper bound of what recursion can pull in.
//
// Matching follows ST (domain/doctor-keys.ts). For speed, plain keys are searched once in all contents joined into
// one string with offsets (a key list of ~3000 against ~1000 contents stays well under a second).
import { escapeRegexLikeSt, isAsciiWordChar, parseRegexKey } from './doctor-keys';
import { DOCTOR_RULES, entryLabel, sample } from './doctor-types';
import type { DoctorEntry, DoctorIssue } from './doctor-types';

export interface RecursionSettings {
    /** `world_info_recursive`. */
    recursive: boolean;
    caseSensitive: boolean;
    wholeWords: boolean;
    /** `world_info_max_recursion_steps`; 0 = unlimited (counts the initial scan: 1 = no recursion). */
    maxSteps: number;
}

export interface RecursionGraph {
    /** Enabled entries; indexes are node ids. */
    nodes: DoctorEntry[];
    /** Out-edges (sorted, unique). */
    out: number[][];
}

const SEPARATOR = String.fromCharCode(0);

function lowerBound(offsets: number[], position: number): number {
    let low = 0;
    let high = offsets.length - 1;
    while (low < high) {
        const mid = (low + high + 1) >> 1;
        if ((offsets[mid] ?? 0) <= position) low = mid;
        else high = mid - 1;
    }
    return low;
}

function trigram(text: string, at: number): number {
    return text.charCodeAt(at) * 4294967296 + text.charCodeAt(at + 1) * 65536 + text.charCodeAt(at + 2);
}

/** Every 3-character window of a text, as numbers. */
function trigrams(text: string): Set<number> {
    const set = new Set<number>();
    for (let at = 0; at + 2 < text.length; at++) set.add(trigram(text, at));
    return set;
}

/** False when some 3-character window of the needle occurs nowhere (then the needle cannot occur either). */
function mayOccur(grams: Set<number>, needle: string): boolean {
    for (let at = 0; at + 2 < needle.length; at++) if (!grams.has(trigram(needle, at))) return false;
    return true;
}

/** Builds the recursion graph over enabled entries. */
export function buildRecursionGraph(entries: readonly DoctorEntry[], settings: RecursionSettings): RecursionGraph {
    const nodes = entries.filter((entry) => !entry.disable);
    const edges = nodes.map(() => new Set<number>());
    if (!settings.recursive) return { nodes, out: edges.map(() => []) };

    const sources: number[] = [];
    nodes.forEach((entry, index) => {
        if (!entry.preventRecursion && entry.content) sources.push(index);
    });
    const offsets: number[] = [];
    const rawParts: string[] = [];
    let cursor = 0;
    for (const index of sources) {
        offsets.push(cursor);
        const content = (nodes[index] as DoctorEntry).content;
        rawParts.push(content);
        cursor += content.length + 1;
    }
    const raw = rawParts.join(SEPARATOR);
    const lower = raw.toLowerCase();
    // toLowerCase keeps string length for everything but a few exotic letters; fall back to per-source checks then.
    const aligned = lower.length === raw.length;
    // Most pack keys never occur in any content: a trigram test skips them without scanning the whole text.
    let lowerGrams: Set<number> | null = null;
    let rawGrams: Set<number> | null = null;

    nodes.forEach((target, targetIndex) => {
        if (target.constant || target.excludeRecursion || !target.key.length) return;
        const caseSensitive = target.caseSensitive ?? settings.caseSensitive;
        const wholeWords = target.matchWholeWords ?? settings.wholeWords;
        for (const rawKey of target.key) {
            const key = rawKey.trim();
            if (!key || key.includes('{{')) continue;
            const regex = parseRegexKey(key);
            if (regex) {
                // One pass over all contents first; anchors (^, $) behave differently in the joined text.
                if (!/[\^$]/.test(regex.source)) {
                    regex.lastIndex = 0;
                    if (!regex.test(raw)) continue;
                }
                for (const source of sources) {
                    if (source === targetIndex) continue;
                    regex.lastIndex = 0;
                    if (regex.test((nodes[source] as DoctorEntry).content)) edges[source]?.add(targetIndex);
                }
                continue;
            }
            const needle = caseSensitive ? key : key.toLowerCase();
            const grams = caseSensitive ? (rawGrams ??= trigrams(raw)) : (lowerGrams ??= trigrams(lower));
            if (!mayOccur(grams, needle)) continue;
            const single = !wholeWords || needle.split(/\s+/).length === 1;
            const checkBoundary = wholeWords && single;
            if (!aligned && !caseSensitive) {
                const boundary = new RegExp(`(?:^|\\W)(${escapeRegexLikeSt(needle)})(?:$|\\W)`);
                for (const source of sources) {
                    if (source === targetIndex) continue;
                    const hay = (nodes[source] as DoctorEntry).content.toLowerCase();
                    if (checkBoundary ? boundary.test(hay) : hay.includes(needle)) edges[source]?.add(targetIndex);
                }
                continue;
            }
            const hay = caseSensitive ? raw : lower;
            let position = hay.indexOf(needle);
            while (position >= 0) {
                const slot = lowerBound(offsets, position);
                const start = offsets[slot] ?? 0;
                const end = start + (nodes[sources[slot] as number] as DoctorEntry).content.length;
                const inside = position + needle.length <= end;
                const before = position > start ? hay[position - 1] : undefined;
                const after = position + needle.length < end ? hay[position + needle.length] : undefined;
                const ok = inside && (!checkBoundary || (!isAsciiWordChar(before) && !isAsciiWordChar(after)));
                const source = sources[slot] as number;
                if (ok && source !== targetIndex) {
                    edges[source]?.add(targetIndex);
                    const next = offsets[slot + 1];
                    if (next === undefined) break;
                    position = hay.indexOf(needle, next);
                } else {
                    position = hay.indexOf(needle, position + 1);
                }
            }
        }
    });
    return { nodes, out: edges.map((set) => [...set].sort((a, b) => a - b)) };
}

export interface NodeStats {
    /** Direct out-edges. */
    out: number;
    /** Recursion steps needed to pull in everything reachable (BFS depth). */
    depth: number;
    /** Entries reachable through recursion. */
    reach: number;
    /** Characters of the reachable entries. */
    reachChars: number;
    /** A longest shortest path from this entry (node ids, this entry first). */
    path: number[];
}

/** BFS from every entry. O(N·(N+E)); callers cap N (see findRecursionIssues). */
export function analyzeGraph(graph: RecursionGraph, starts?: readonly number[]): Map<number, NodeStats> {
    const count = graph.nodes.length;
    const result = new Map<number, NodeStats>();
    const distance = new Int32Array(count);
    const parent = new Int32Array(count);
    const queue = new Int32Array(count);
    for (const start of starts ?? graph.nodes.map((_, index) => index)) {
        distance.fill(-1);
        distance[start] = 0;
        parent[start] = -1;
        let head = 0;
        let tail = 0;
        queue[tail++] = start;
        let far = start;
        let reachChars = 0;
        while (head < tail) {
            const node = queue[head++] as number;
            for (const next of graph.out[node] ?? []) {
                if ((distance[next] ?? 0) !== -1) continue;
                distance[next] = (distance[node] ?? 0) + 1;
                parent[next] = node;
                queue[tail++] = next;
                reachChars += (graph.nodes[next] as DoctorEntry).content.length;
                if ((distance[next] ?? 0) > (distance[far] ?? 0)) far = next;
            }
        }
        const path: number[] = [];
        for (let node = far; node !== -1; node = parent[node] ?? -1) path.unshift(node);
        result.set(start, {
            out: graph.out[start]?.length ?? 0,
            depth: distance[far] ?? 0,
            reach: tail - 1,
            reachChars,
            path,
        });
    }
    return result;
}

export interface BookRecursionStats {
    book: string;
    /** Enabled entries. */
    entries: number;
    /** Characters of enabled entries. */
    chars: number;
    /** Characters of enabled constant entries (always in the prompt). */
    constantChars: number;
    /** Recursion links that start in this book. */
    links: number;
    /** Longest chain of recursion steps starting in this book. */
    maxDepth: number;
    /** Entries pulling in `vacuumThreshold` or more others directly. */
    vacuums: number;
    /** Most characters one entry of this book can pull in through recursion. */
    maxReachChars: number;
}

export interface RecursionReport {
    issues: DoctorIssue[];
    books: BookRecursionStats[];
    /** Longest chain over all books (0 without recursion). */
    maxDepth: number;
}

export interface RecursionOptions {
    /** Direct links that make an entry a "vacuum" (default 5). */
    vacuumThreshold?: number;
    /** Chain depth worth reporting (default 3). */
    chainThreshold?: number;
    /** Vacuums reported per book (default 5). */
    vacuumsPerBook?: number;
    /** BFS starts when the graph is bigger (default 1500): the entries with most links are analysed. */
    maxStarts?: number;
}

/** Step limit to suggest: the initial scan plus two recursion levels keeps direct entries and their nearest links. */
export const SUGGESTED_RECURSION_STEPS = 3;

function chainText(graph: RecursionGraph, path: number[]): string {
    const labels = path.map((index) => entryLabel(graph.nodes[index] as DoctorEntry));
    return labels.length > 6
        ? `${labels.slice(0, 5).join(' → ')} → … → ${labels[labels.length - 1]}`
        : labels.join(' → ');
}

/** Per-book statistics plus `recursion.chain` / `recursion.vacuum` issues (fixed on the fly by rule `book.cap`). */
export function findRecursionIssues(
    entries: readonly DoctorEntry[],
    settings: RecursionSettings,
    options: RecursionOptions = {},
): RecursionReport {
    const vacuumThreshold = options.vacuumThreshold ?? 5;
    const chainThreshold = options.chainThreshold ?? 3;
    const vacuumsPerBook = options.vacuumsPerBook ?? 5;
    const maxStarts = options.maxStarts ?? 1500;
    const graph = buildRecursionGraph(entries, settings);
    let starts: number[] | undefined;
    if (graph.nodes.length > maxStarts) {
        starts = graph.nodes
            .map((_, index) => index)
            .filter((index) => (graph.out[index]?.length ?? 0) > 0)
            .sort((a, b) => (graph.out[b]?.length ?? 0) - (graph.out[a]?.length ?? 0))
            .slice(0, maxStarts);
    }
    const stats = settings.recursive ? analyzeGraph(graph, starts) : new Map<number, NodeStats>();

    const books = new Map<string, BookRecursionStats & { best: number; vacuumNodes: number[] }>();
    graph.nodes.forEach((entry, index) => {
        const book = books.get(entry.book) ?? {
            book: entry.book,
            entries: 0,
            chars: 0,
            constantChars: 0,
            links: 0,
            maxDepth: 0,
            vacuums: 0,
            maxReachChars: 0,
            best: -1,
            vacuumNodes: [],
        };
        book.entries += 1;
        book.chars += entry.content.length;
        if (entry.constant) book.constantChars += entry.content.length;
        book.links += graph.out[index]?.length ?? 0;
        const node = stats.get(index);
        if (node) {
            if (node.depth > book.maxDepth) {
                book.maxDepth = node.depth;
                book.best = index;
            }
            book.maxReachChars = Math.max(book.maxReachChars, node.reachChars);
            if (node.out >= vacuumThreshold) {
                book.vacuums += 1;
                book.vacuumNodes.push(index);
            }
        }
        books.set(entry.book, book);
    });

    const issues: DoctorIssue[] = [];
    let maxDepth = 0;
    for (const book of books.values()) {
        maxDepth = Math.max(maxDepth, book.maxDepth);
        if (book.maxDepth >= chainThreshold && book.best >= 0) {
            const path = stats.get(book.best)?.path ?? [];
            issues.push({
                kind: 'recursion.chain',
                severity: book.maxDepth >= 5 ? 'warn' : 'info',
                messageKey: 'm5.f.recursionChain',
                params: {
                    book: book.book,
                    depth: book.maxDepth,
                    path: chainText(graph, path),
                    links: book.links,
                    vacuums: book.vacuums,
                    chars: book.maxReachChars,
                },
                target: { book: book.book, uid: (graph.nodes[book.best] as DoctorEntry).uid },
                fixRule: DOCTOR_RULES.bookCap,
            });
        }
        const top = [...book.vacuumNodes]
            .sort((a, b) => (stats.get(b)?.out ?? 0) - (stats.get(a)?.out ?? 0))
            .slice(0, vacuumsPerBook);
        for (const index of top) {
            const entry = graph.nodes[index] as DoctorEntry;
            const node = stats.get(index) as NodeStats;
            issues.push({
                kind: 'recursion.vacuum',
                severity: 'warn',
                messageKey: 'm5.f.recursionVacuum',
                params: {
                    entry: entryLabel(entry),
                    book: entry.book,
                    count: node.out,
                    reach: node.reach,
                    chars: node.reachChars,
                    sample: sample(
                        (graph.out[index] ?? []).map((next) => entryLabel(graph.nodes[next] as DoctorEntry)),
                    ),
                },
                target: { book: entry.book, uid: entry.uid, comment: entry.comment },
                fixRule: DOCTOR_RULES.bookCap,
            });
        }
    }
    if (settings.recursive && maxDepth >= chainThreshold) {
        const limit = settings.maxSteps;
        if (limit === 0 || limit > SUGGESTED_RECURSION_STEPS) {
            issues.push({
                kind: 'recursion.chain',
                severity: 'warn',
                messageKey: limit === 0 ? 'm5.f.recursionNoLimit' : 'm5.f.recursionHighLimit',
                params: { depth: maxDepth, limit, suggested: SUGGESTED_RECURSION_STEPS },
                target: { setting: 'world_info_max_recursion_steps' },
                fixRule: DOCTOR_RULES.bookCap,
            });
        }
    }
    const list = [...books.values()].map(({ best: _best, vacuumNodes: _nodes, ...rest }) => rest);
    return { issues, books: list, maxDepth };
}
