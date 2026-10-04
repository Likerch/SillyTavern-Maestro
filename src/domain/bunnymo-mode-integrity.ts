// BunnyMo mode (M35 п. 9): integrity checks of the BunnyMo setup, pure parts. The feature gathers the facts (books,
// global selection, CK settings, loaded book contents) and translates the findings.
//
// - core: present when packs are active, and of the version Maestro is checked against (V3.0); two cores at once;
// - a core or pack marked as a CK Character Repo: CK would scan the core's `<Name:NAME>` templates as characters
//   (research §3.2 п. 8);
// - CK's «BunnyMo tag wrapping» rewrites lorebook files (`<BunnymoTags:Title>\n…\n</BunnymoTags:Title>`) and leaves
//   `<name>.carrot_backup` copies (CK index.js 891-1143). Shipped packs already carry that wrapper, so the wrapper alone
//   proves nothing: a rewrite is an entry that differs from its `.carrot_backup` only by CK wrappers, or a double
//   wrapper (CK wraps again when the title changed); a pending rewrite is a BunnyMo book in CK's Tag Libraries while
//   wrapping is on and some entry is not wrapped yet;
// - a canon book or the chat book switched on globally.
import { EXPECTED_CORE_VERSION, compareVersions } from './bunnymo-mode-packs';
import type { UidEntry } from './bunnymo-mode-tags';

type Dict = Record<string, unknown>;

export const CK_BACKUP_SUFFIX = '.carrot_backup';

export type IntegrityKind =
    'coreMissing' | 'coreVersion' | 'packAsRepo' | 'ckWrapRewrite' | 'ckBackup' | 'canonGlobal' | 'chatBookGlobal';

export interface IntegrityItem {
    kind: IntegrityKind;
    /** Variant of the message (i18n key suffix): 'inactive', 'several', 'pending', 'nested', … */
    variant: string;
    book?: string;
    params: Record<string, string | number>;
}

export interface WrapFacts {
    book: string;
    /** Entries that differ from the `.carrot_backup` copy only by CK wrappers. */
    rewritten: number;
    /** Entries with two CK wrappers one inside the other. */
    nested: number;
    /** CK will wrap this book on its next load (Tag Library + wrapping on + unwrapped entries). */
    pending: boolean;
    /** A BunnyMo core or pack (P13: its file must never change). */
    bunnymo: boolean;
}

export interface IntegrityFacts {
    /** Every lorebook name. */
    books: readonly string[];
    /** Globally selected books. */
    global: readonly string[];
    cores: readonly { book: string; active: boolean; named: string | null; detected: string }[];
    packs: readonly { book: string; active: boolean }[];
    ckRepos: readonly string[];
    wraps: readonly WrapFacts[];
    /** Canon book test (src/domain/roles-detect.ts isCanonBookName). */
    isCanon(book: string): boolean;
    /** The chat books of this chat (and books with the chat role). */
    chatBooks: readonly string[];
}

const WRAP_OPEN_RE = /^<BunnymoTags:([^>\n]*)>\n?/i;
const NESTED_RE = /^<BunnymoTags:[^>\n]*>\s*<BunnymoTags:[^>\n]*>/i;

/** CK's wrapper title of an entry: its title, else its first key, else «Entry», without `<` and `>`. */
export function ckWrapperName(entry: Dict): string {
    const comment = typeof entry.comment === 'string' ? entry.comment : '';
    const first = Array.isArray(entry.key) && typeof entry.key[0] === 'string' ? entry.key[0] : '';
    return (comment || first || 'Entry').replace(/[<>]/g, '');
}

/** CK's own test: the trimmed content starts with this entry's wrapper. */
export function isCkWrapped(entry: Dict): boolean {
    const content = typeof entry.content === 'string' ? entry.content : '';
    return content.trim().startsWith(`<BunnymoTags:${ckWrapperName(entry)}>`);
}

/** The text with every outer `<BunnymoTags:X>…</BunnymoTags:X>` wrapper removed (whitespace-trimmed). */
export function stripCkWrappers(content: string): string {
    let text = content.trim();
    for (let guard = 0; guard < 8; guard++) {
        const open = WRAP_OPEN_RE.exec(text);
        if (!open) break;
        const close = `</BunnymoTags:${open[1] ?? ''}>`;
        if (!text.toLowerCase().endsWith(close.toLowerCase())) break;
        text = text.slice(open[0].length, text.length - close.length).trim();
    }
    return text;
}

/** Two CK wrappers one inside the other (CK wrapped again after the entry title changed). */
export function hasNestedWrapper(content: unknown): boolean {
    return typeof content === 'string' && NESTED_RE.test(content.trim());
}

/**
 * Wrap facts of one book: compared with its `.carrot_backup` copy when there is one; `pending` when CK will wrap it on
 * its next load (the book is a Tag Library and CK's wrapping is on).
 */
export function wrapFacts(
    book: string,
    entries: readonly UidEntry[],
    backup: readonly UidEntry[] | null,
    options: { tagLibrary: boolean; wrapping: boolean; bunnymo: boolean },
): WrapFacts {
    const copies = new Map(backup?.map(({ uid, entry }) => [uid, entry]) ?? []);
    let rewritten = 0;
    let nested = 0;
    let unwrapped = false;
    for (const { uid, entry } of entries) {
        const content = typeof entry.content === 'string' ? entry.content : '';
        if (hasNestedWrapper(content)) nested++;
        if (content.trim() && !isCkWrapped(entry)) unwrapped = true;
        const copy = copies.get(uid);
        if (!copy) continue;
        const before = typeof copy.content === 'string' ? copy.content : '';
        if (before !== content && stripCkWrappers(before) === stripCkWrappers(content)) rewritten++;
    }
    return {
        book,
        rewritten,
        nested,
        pending: options.tagLibrary && options.wrapping && unwrapped,
        bunnymo: options.bunnymo,
    };
}

/** Findings in a stable order: core, repos, CK rewrites and copies, global books. */
export function integrityFindings(facts: IntegrityFacts): IntegrityItem[] {
    const items: IntegrityItem[] = [];
    const activeCores = facts.cores.filter((core) => core.active);
    const activePacks = facts.packs.filter((pack) => pack.active);
    if (activePacks.length && !activeCores.length) {
        const idle = facts.cores[0];
        items.push(
            idle
                ? {
                      kind: 'coreMissing',
                      variant: 'inactive',
                      book: idle.book,
                      params: { book: idle.book, count: activePacks.length },
                  }
                : { kind: 'coreMissing', variant: 'absent', params: { count: activePacks.length } },
        );
    }
    if (activeCores.length > 1) {
        items.push({
            kind: 'coreVersion',
            variant: 'several',
            params: { books: activeCores.map((core) => core.book).join(', ') },
        });
    }
    for (const core of activeCores) {
        if (compareVersions(core.detected, EXPECTED_CORE_VERSION) >= 0) continue;
        items.push({
            kind: 'coreVersion',
            variant: 'old',
            book: core.book,
            params: { book: core.book, version: core.detected, expected: EXPECTED_CORE_VERSION },
        });
    }

    const system = new Set([...facts.cores.map((core) => core.book), ...facts.packs.map((pack) => pack.book)]);
    for (const book of facts.ckRepos) {
        if (system.has(book)) items.push({ kind: 'packAsRepo', variant: 'repo', book, params: { book } });
    }

    for (const wrap of facts.wraps) {
        const variant = (base: string) => (wrap.bunnymo ? `${base}Pack` : base);
        if (wrap.rewritten) {
            items.push({
                kind: 'ckWrapRewrite',
                variant: variant('backup'),
                book: wrap.book,
                params: { book: wrap.book, count: wrap.rewritten },
            });
        }
        if (wrap.nested) {
            items.push({
                kind: 'ckWrapRewrite',
                variant: variant('nested'),
                book: wrap.book,
                params: { book: wrap.book, count: wrap.nested },
            });
        }
        if (wrap.pending) {
            items.push({
                kind: 'ckWrapRewrite',
                variant: variant('pending'),
                book: wrap.book,
                params: { book: wrap.book },
            });
        }
    }

    const names = new Set(facts.books);
    for (const book of facts.books) {
        if (!book.toLowerCase().endsWith(CK_BACKUP_SUFFIX)) continue;
        const original = book.slice(0, book.length - CK_BACKUP_SUFFIX.length);
        items.push({
            kind: 'ckBackup',
            variant: names.has(original) ? 'copy' : 'orphan',
            book,
            params: { book, original },
        });
    }

    const chatBooks = new Set(facts.chatBooks);
    for (const book of facts.global) {
        if (facts.isCanon(book)) items.push({ kind: 'canonGlobal', variant: 'global', book, params: { book } });
        else if (chatBooks.has(book)) items.push({ kind: 'chatBookGlobal', variant: 'global', book, params: { book } });
    }
    return items;
}
