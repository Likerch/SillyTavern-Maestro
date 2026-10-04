// CarrotKernel archive checks and wrapper collisions (research/bunnymo-carrotkernel.md §1.2, §2.2–§2.3, §3.2).
// An archive is an entry with a `<BunnymoTags>` block holding a real name or tags (domain/bunnymo.ts). CK reads
// only the first block, only `<BunnymoTags>` spelled exactly, and Baby Bunny saves archives with scan depth 1.
// Wrapper collision: archive text enters the recursion buffer, so a section wrapper such as `<NSFW>…</NSFW>` fires
// a pack entry keyed by the bare tag `<NSFW>` (CarrotCast Limited "Erotic").
import { isCharacterArchive } from './bunnymo';
import type { BunnyMoEntryLike } from './bunnymo';
import { isBareTagKey, isMbtiTag, matchKey } from './doctor-keys';
import { DOCTOR_RULES, entryLabel, sample } from './doctor-types';
import { isCarrotCastEntry } from './rules-packs';
import type { BunnyBookKind, DoctorEntry, DoctorIssue } from './doctor-types';

const BLOCK_OPEN_G = /<(bunnymotags)>/gi;
const BLOCK_RE = /<bunnymotags>([\s\S]*?)(?:<\/bunnymotags>|$)/i;
const TAG_G = /<([A-Za-z][A-Za-z0-9_-]*):([^<>\n]+)>/g;
/** Template values of BunnyMo sheets (same list as domain/bunnymo.ts; NONE and OLD are real pack values). */
const PLACEHOLDER_RE = /^(?:BLANK|NEW|VALUE|TARGET|NAME|NAME[\s_]HERE|PLACEHOLDER|TBD|X{3,})$/i;
/** The only spelling both CK parsers accept (scan-time and activation-time). */
const CK_BLOCK = 'BunnymoTags';

function likeBunnyMo(entry: DoctorEntry): BunnyMoEntryLike {
    return { key: entry.key, keysecondary: entry.keysecondary, comment: entry.comment, content: entry.content };
}

export function isArchive(entry: DoctorEntry): boolean {
    return !entry.disable && isCharacterArchive(likeBunnyMo(entry));
}

/** Opening `<BunnymoTags>` tags as written (any case). */
export function archiveBlocks(content: string): string[] {
    return [...content.matchAll(BLOCK_OPEN_G)].map((match) => match[1] ?? '');
}

/** `<KEY:VALUE>` tags of the first block whose value is a template placeholder (`<GENRE:BLANK>`). */
export function placeholderTags(content: string): string[] {
    const block = BLOCK_RE.exec(content)?.[1] ?? '';
    const found: string[] = [];
    for (const match of block.matchAll(TAG_G)) {
        const key = (match[1] ?? '').trim();
        const value = (match[2] ?? '').trim();
        if (key.toUpperCase() !== 'NAME' && PLACEHOLDER_RE.test(value)) found.push(`<${key}:${value}>`);
    }
    return found;
}

export interface ArchiveCheckOptions {
    /** CarrotKernel is installed and running. */
    ckPresent: boolean;
    /** Books marked as Character Repos in CK. */
    repoBooks: readonly string[];
    bunnyBooks: ReadonlyMap<string, BunnyBookKind>;
}

/** Scan depth 1, several blocks, placeholders, wrong block spelling, book not marked as a Character Repo. */
export function findArchiveIssues(entries: readonly DoctorEntry[], options: ArchiveCheckOptions): DoctorIssue[] {
    const issues: DoctorIssue[] = [];
    const perBook = new Map<string, DoctorEntry[]>();
    for (const entry of entries) {
        if (options.bunnyBooks.has(entry.book) || !isArchive(entry)) continue;
        const list = perBook.get(entry.book) ?? [];
        list.push(entry);
        perBook.set(entry.book, list);
        const where = { entry: entryLabel(entry), book: entry.book };
        const target = { book: entry.book, uid: entry.uid, comment: entry.comment };
        if (entry.scanDepth === 1) {
            issues.push({
                kind: 'ck.archiveScanDepth',
                severity: 'warn',
                messageKey: 'm5.f.archiveScanDepth',
                params: where,
                target,
                fileFix: true,
            });
        }
        const blocks = archiveBlocks(entry.content);
        if (blocks.length > 1) {
            issues.push({
                kind: 'ck.archiveMultiBlock',
                severity: 'warn',
                messageKey: 'm5.f.archiveMultiBlock',
                params: { ...where, count: blocks.length },
                target,
                fileFix: true,
            });
        }
        const wrong = blocks.filter((name) => name !== CK_BLOCK);
        if (wrong[0] !== undefined) {
            issues.push({
                kind: 'ck.archiveTagCase',
                severity: 'warn',
                messageKey: 'm5.f.archiveTagCase',
                params: { ...where, found: `<${wrong[0]}>` },
                target,
                fileFix: true,
            });
        }
        const placeholders = placeholderTags(entry.content);
        if (placeholders.length) {
            issues.push({
                kind: 'ck.archivePlaceholder',
                severity: 'warn',
                messageKey: 'm5.f.archivePlaceholder',
                params: { ...where, tags: sample(placeholders, 4) },
                target,
                fileFix: true,
            });
        }
    }
    if (options.ckPresent) {
        for (const [book, list] of perBook) {
            if (options.repoBooks.includes(book)) continue;
            issues.push({
                kind: 'ck.archiveNotRepo',
                severity: 'warn',
                messageKey: 'm5.f.archiveNotRepo',
                params: { book, count: list.length, sample: sample(list.map(entryLabel)) },
                target: { book },
                fileFix: false,
            });
        }
    }
    return issues;
}

export interface WrapperCheckOptions {
    /** Global `world_info_recursive`: without recursion archive text never fires other entries. */
    recursive: boolean;
    caseSensitiveGlobal: boolean;
    wholeWordsGlobal: boolean;
}

interface Collision {
    tag: string;
    wrapper: boolean;
    archives: DoctorEntry[];
    targets: DoctorEntry[];
}

/**
 * Archives whose text contains a bare tag that is the key of another active entry (`<NSFW>` → "Erotic",
 * `<DERE>` → Deredere, `<ELF>`, `<ANXIETY>`). Used as a wrapper (`<NSFW>…</NSFW>`) it is almost surely accidental
 * (warn); a bare tag without a closing pair may be intended (info). MBTI archetypes are intended triggers.
 */
export function findWrapperCollisions(entries: readonly DoctorEntry[], options: WrapperCheckOptions): DoctorIssue[] {
    if (!options.recursive) return [];
    const targets = entries.filter(
        (entry) => !entry.disable && !entry.constant && !entry.excludeRecursion && entry.key.length > 0,
    );
    const byTag = new Map<string, { key: string; entries: DoctorEntry[] }>();
    for (const entry of targets) {
        for (const key of entry.key) {
            if (!isBareTagKey(key) || isMbtiTag(key)) continue;
            const tag = key.trim().toUpperCase();
            const slot = byTag.get(tag) ?? { key: key.trim(), entries: [] };
            if (!slot.entries.includes(entry)) slot.entries.push(entry);
            byTag.set(tag, slot);
        }
    }
    if (!byTag.size) return [];
    const collisions = new Map<string, Collision>();
    for (const archive of entries) {
        if (archive.preventRecursion || !isArchive(archive)) continue;
        const lower = archive.content.toLowerCase();
        for (const [tag, slot] of byTag) {
            const fired = slot.entries.filter(
                (target) =>
                    target !== archive &&
                    matchKey(archive.content, slot.key, {
                        caseSensitive: target.caseSensitive ?? options.caseSensitiveGlobal,
                        wholeWords: target.matchWholeWords ?? options.wholeWordsGlobal,
                    }),
            );
            if (!fired.length) continue;
            const wrapper = lower.includes(`</${tag.slice(1).toLowerCase()}`);
            const id = `${tag}|${wrapper ? 'w' : 'b'}`;
            const collision = collisions.get(id) ?? { tag: slot.key, wrapper, archives: [], targets: [] };
            collision.archives.push(archive);
            for (const target of fired) if (!collision.targets.includes(target)) collision.targets.push(target);
            collisions.set(id, collision);
        }
    }
    return [...collisions.values()].map((collision) => {
        const first = collision.targets[0] as DoctorEntry;
        // CarrotCast's `<NSFW>` entries are handled on the fly by rule `wrapper.nsfwCollision`.
        const handled =
            collision.tag.toUpperCase() === '<NSFW>' && collision.targets.every((target) => isCarrotCastEntry(target));
        return {
            kind: 'wrapper.collision' as const,
            severity: collision.wrapper ? ('warn' as const) : ('info' as const),
            messageKey: collision.wrapper ? 'm5.f.wrapperCollision' : 'm5.f.bareTagCollision',
            params: {
                tag: collision.tag,
                closing: `</${collision.tag.slice(1)}`,
                count: collision.archives.length,
                archives: sample(collision.archives.map(entryLabel)),
                target: entryLabel(first),
                targetBook: first.book,
                targets: collision.targets.length,
            },
            target: {
                tag: collision.tag,
                book: first.book,
                uid: first.uid,
                comment: first.comment,
                archives: collision.archives.slice(0, 50).map((entry) => ({ book: entry.book, uid: entry.uid })),
            },
            ...(handled ? { fixRule: DOCTOR_RULES.nsfwCollision } : {}),
            fileFix: false,
        };
    });
}
