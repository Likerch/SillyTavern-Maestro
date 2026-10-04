// Lorebook checks of M5 «Доктор» that look at entries one by one or pairwise: duplicate packs and version
// conflicts (research/bunnymo-carrotkernel.md §1.5–1.6), assistant role at depth (audit A9) and key problems
// (English-only keys in a Russian chat, the Cyrillic whole-word bug, broken Localizer regexes; audit T2).
// P13: BunnyMo books never get a file fix, never Russian keys.
import { DOCTOR_RULES, entryLabel, sample } from './doctor-types';
import type { BunnyBookKind, DoctorEntry, DoctorIssue } from './doctor-types';
import {
    hasCyrillic,
    isCyrillicWholeWordKey,
    isTagKey,
    looksLikeRegexKey,
    normalizePackKey,
    regexKeyProblem,
} from './doctor-keys';

export type BunnyBooks = ReadonlyMap<string, BunnyBookKind>;

/* ------------------------------------------------------------------ duplicates and version conflicts */

/** Comments of the intended BSM-5 + CoT Lenses pairing (same keys, different content by design). */
/** CoT Lenses pair with BSM-5 on purpose; real titles start with an emoji («💊 CoT LENS — DEPRESSION»). */
const INTENDED_PAIR_RE = /^\s*[^\sA-Za-z0-9]*\s*CoT\s+LENS/i;
const OLD_EDITION_RE = /retired|legacy|\bold\b|deprecated|устар/i;
const VERSION_RE = /(?:^|[^a-z])v(?:er(?:sion)?)?\.?\s?(\d+(?:\.\d+)*)/i;

/** Version numbers found in a book name or comment (`MBTI V2` → [2], `V3.0` → [3, 0]); null when none. */
export function versionOf(text: string): number[] | null {
    const match = VERSION_RE.exec(text);
    return match?.[1] ? match[1].split('.').map(Number) : null;
}

function compareVersions(a: number[], b: number[]): number {
    for (let i = 0; i < Math.max(a.length, b.length); i++) {
        const diff = (a[i] ?? 0) - (b[i] ?? 0);
        if (diff !== 0) return diff;
    }
    return 0;
}

/** Which of two books looks newer: by "retired/old" in the name, then by version numbers. Null when unclear. */
export function newerBook(a: string, b: string): string | null {
    const oldA = OLD_EDITION_RE.test(a);
    const oldB = OLD_EDITION_RE.test(b);
    if (oldA !== oldB) return oldA ? b : a;
    const versionA = versionOf(a);
    const versionB = versionOf(b);
    if (!versionA || !versionB) return null;
    const diff = compareVersions(versionA, versionB);
    return diff === 0 ? null : diff > 0 ? a : b;
}

/** The activation signature of an entry: its normalised primary keys, or "constant". Null when it never fires. */
export function keySignature(entry: DoctorEntry): string | null {
    if (entry.constant) return '#constant';
    const keys = [...new Set(entry.key.map(normalizePackKey))].sort();
    return keys.length ? JSON.stringify(keys) : null;
}

/** Content compared up to whitespace (packs are re-saved by different editors). */
export function contentSignature(content: string): string {
    return content.replace(/\s+/g, ' ').trim();
}

interface PairAggregate {
    first: string;
    second: string;
    labels: string[];
    keys: string[];
    uids: number[];
    chars: number;
    count: number;
}

function pairKey(first: string, second: string): string {
    return JSON.stringify([first, second]);
}

function bump(map: Map<string, PairAggregate>, first: string, second: string, entry: DoctorEntry): void {
    const id = pairKey(first, second);
    const pair = map.get(id) ?? { first, second, labels: [], keys: [], uids: [], chars: 0, count: 0 };
    pair.count += 1;
    pair.chars += entry.content.length;
    pair.labels.push(entryLabel(entry));
    if (entry.key[0]) pair.keys.push(entry.key[0]);
    pair.uids.push(entry.uid);
    map.set(id, pair);
}

/**
 * Duplicates across books: same activation signature and same text (`pack.duplicate`, suppressed on the fly by
 * rule `pack.duplicates`) or, between two BunnyMo books, same signature and different text
 * (`pack.versionConflict`, one question at stage 2). Results are aggregated per book pair; `first` is the book that
 * comes first in `entries` (the copy that stays).
 */
export function findPackDuplicates(entries: readonly DoctorEntry[], bunnyBooks: BunnyBooks): DoctorIssue[] {
    const bookOrder = new Map<string, number>();
    for (const entry of entries) if (!bookOrder.has(entry.book)) bookOrder.set(entry.book, bookOrder.size);
    const groups = new Map<string, DoctorEntry[]>();
    for (const entry of entries) {
        if (entry.disable || !entry.content.trim()) continue;
        const signature = keySignature(entry);
        if (signature === null) continue;
        const list = groups.get(signature) ?? [];
        list.push(entry);
        groups.set(signature, list);
    }
    const duplicates = new Map<string, PairAggregate>();
    const conflicts = new Map<string, PairAggregate>();
    const order = (book: string) => bookOrder.get(book) ?? 0;
    for (const group of groups.values()) {
        const books = [...new Set(group.map((entry) => entry.book))].sort((a, b) => order(a) - order(b));
        if (books.length < 2) continue;
        for (let i = 0; i < books.length; i++) {
            for (let j = i + 1; j < books.length; j++) {
                const first = books[i] as string;
                const second = books[j] as string;
                const left = group.filter((entry) => entry.book === first);
                const right = group.filter((entry) => entry.book === second);
                const leftTexts = new Set(left.map((entry) => contentSignature(entry.content)));
                const same = right.filter((entry) => leftTexts.has(contentSignature(entry.content)));
                if (same.length) {
                    for (const entry of same) bump(duplicates, first, second, entry);
                    continue;
                }
                // Version conflicts are a pack matter: in other books one key often opens different entries.
                // Constants have no keys to collide on (every pack's read-me would "conflict").
                const packs = bunnyBooks.has(first) && bunnyBooks.has(second) && !left[0]?.constant;
                const intended = [...left, ...right].some((entry) => INTENDED_PAIR_RE.test(entry.comment));
                if (packs && !intended && right[0]) bump(conflicts, first, second, right[0]);
            }
        }
    }
    const isBunny = (pair: PairAggregate) => bunnyBooks.has(pair.first) || bunnyBooks.has(pair.second);
    const issues: DoctorIssue[] = [];
    for (const pair of duplicates.values()) {
        issues.push({
            kind: 'pack.duplicate',
            severity: 'warn',
            messageKey: 'm5.f.packDuplicate',
            params: {
                a: pair.first,
                b: pair.second,
                count: pair.count,
                chars: pair.chars,
                sample: sample(pair.labels),
            },
            target: { books: [pair.first, pair.second], book: pair.second, uids: pair.uids.slice(0, 100) },
            fixRule: DOCTOR_RULES.duplicates,
            fileFix: !isBunny(pair),
        });
    }
    for (const pair of conflicts.values()) {
        const newer = newerBook(pair.first, pair.second);
        issues.push({
            kind: 'pack.versionConflict',
            severity: 'warn',
            messageKey: newer ? 'm5.f.packVersionConflict' : 'm5.f.packVersionConflictUnsure',
            params: {
                a: pair.first,
                b: pair.second,
                count: pair.count,
                sample: sample(pair.keys.length ? pair.keys : pair.labels),
                ...(newer ? { newer } : {}),
            },
            target: { books: [pair.first, pair.second], book: pair.second, uids: pair.uids.slice(0, 100) },
            fixRule: DOCTOR_RULES.packVersion,
            fileFix: false,
        });
    }
    return issues;
}

/* ------------------------------------------------------------------ assistant role at depth */

/** At-depth entries with the assistant role: fake model turns for DeepSeek V4. User-role entries are left alone (A9). */
export function findAssistantAtDepth(entries: readonly DoctorEntry[], bunnyBooks: BunnyBooks): DoctorIssue[] {
    return entries
        .filter((entry) => !entry.disable && entry.position === 4 && entry.role === 2)
        .map((entry) => ({
            kind: 'role.assistantAtDepth' as const,
            severity: 'warn' as const,
            messageKey: 'm5.f.assistantAtDepth',
            params: { entry: entryLabel(entry), book: entry.book, depth: entry.depth },
            target: { book: entry.book, uid: entry.uid, comment: entry.comment },
            fixRule: DOCTOR_RULES.assistantToSystem,
            fileFix: !bunnyBooks.has(entry.book),
        }));
}

/* ------------------------------------------------------------------ keys */

export interface KeyCheckOptions {
    /** The current chat is written in Russian. */
    russianChat: boolean;
    /** Global `world_info_match_whole_words`. */
    wholeWordsGlobal: boolean;
    bunnyBooks: BunnyBooks;
}

/** Keys that never fire from prose and need no translation: tags, sheet commands, pure punctuation. */
function proseKey(key: string): boolean {
    return !isTagKey(key) && !key.startsWith('!') && /\p{L}/u.test(key);
}

function russianReady(entry: DoctorEntry): boolean {
    return [...entry.key, ...entry.localizerKeys].some((key) => hasCyrillic(key) || looksLikeRegexKey(key));
}

function perBook(entries: DoctorEntry[]): Map<string, DoctorEntry[]> {
    const map = new Map<string, DoctorEntry[]>();
    for (const entry of entries) {
        const list = map.get(entry.book) ?? [];
        list.push(entry);
        map.set(entry.book, list);
    }
    return map;
}

/** English-only keys in a Russian chat, Cyrillic keys under whole-word matching, broken Localizer regexes. */
export function findKeyIssues(entries: readonly DoctorEntry[], options: KeyCheckOptions): DoctorIssue[] {
    const issues: DoctorIssue[] = [];
    const enabled = entries.filter((entry) => !entry.disable);

    if (options.russianChat) {
        const english = enabled.filter(
            (entry) =>
                !options.bunnyBooks.has(entry.book) &&
                !entry.constant &&
                entry.key.some(proseKey) &&
                !russianReady(entry),
        );
        for (const [book, list] of perBook(english)) {
            issues.push({
                kind: 'keys.noRussian',
                severity: 'warn',
                messageKey: 'm5.f.noRussian',
                params: { book, count: list.length, sample: sample(list.map(entryLabel)) },
                target: { book, uids: list.slice(0, 100).map((entry) => entry.uid) },
                fileFix: true,
            });
        }
    }

    const wholeWord = enabled.flatMap((entry) =>
        (entry.matchWholeWords ?? options.wholeWordsGlobal)
            ? [...entry.key, ...entry.keysecondary].filter(isCyrillicWholeWordKey).map((key) => ({ entry, key }))
            : [],
    );
    const wholeWordBooks = new Map<string, { entry: DoctorEntry; key: string }[]>();
    for (const item of wholeWord) {
        const list = wholeWordBooks.get(item.entry.book) ?? [];
        list.push(item);
        wholeWordBooks.set(item.entry.book, list);
    }
    for (const [book, list] of wholeWordBooks) {
        issues.push({
            kind: 'keys.cyrillicWholeWord',
            severity: 'info',
            messageKey: 'm5.f.cyrillicWholeWord',
            params: { book, count: list.length, sample: sample(list.map((item) => item.key)) },
            target: { book, uids: [...new Set(list.map((item) => item.entry.uid))].slice(0, 100) },
            fixRule: DOCTOR_RULES.cyrillicLeftBoundary,
            fileFix: !options.bunnyBooks.has(book),
        });
    }

    for (const entry of enabled) {
        const broken = entry.localizerKeys
            .map((key) => ({ key, problem: regexKeyProblem(key) }))
            .filter((item) => item.problem !== null);
        const first = broken[0];
        if (!first?.problem) continue;
        issues.push({
            kind: 'keys.localizerBroken',
            severity: first.problem === 'braces' ? 'warn' : 'error',
            messageKey: `m5.f.localizerBroken.${first.problem}`,
            params: { entry: entryLabel(entry), book: entry.book, key: first.key, count: broken.length },
            target: { book: entry.book, uid: entry.uid, comment: entry.comment },
            fileFix: !options.bunnyBooks.has(entry.book),
        });
    }
    return issues;
}
