// Rule 'ck.archiveDepth' (plan M22 «Архив CK по последнему сообщению»; research/bunnymo-carrotkernel.md §2.2): Baby
// Bunny saves archives with scan depth 1, so a character fires only when the name is in the very last message. Not a
// scan rule: for every active archive book of the user (M35 role 'ck.archive'; BunnyMo books never) with such entries,
// one Inbox card per book (autonomy kind 'rules.ckArchiveDepth', default 'inbox') proposes a file fix: scan depth →
// global and, when DES-RU's API is there, Russian case forms for the name keys (`nameFormsKey`). The check runs after a
// chat change and after a generation, off the send path, and proposes the same set of entries only once.
import { adaptersOf } from '../../../adapters';
import { enabledEntriesOf, hasArchives, patchBookData, planArchiveDepthFix } from '../../../domain/doctor-fixes';
import type { EntryPatch } from '../../../domain/doctor-fixes';
import { isCharacterArchive } from '../../../domain/bunnymo';
import { isPlainObject } from '../../../domain/rules-lore';
import type { Unsubscribe } from '../../../shared/contracts';
import type { BookRolesApi } from '../../bookRoles/api';
import type { RuleDefinition } from '../api';
import type { RuleEnv } from '../env';
import { bookIo, isEntryPatch, isProtectedBook, patchChanges, writePatches } from '../lore-write';

export const ARCHIVE_DEPTH_RULE_ID = 'ck.archiveDepth';
export const ARCHIVE_DEPTH_KIND = 'rules.ckArchiveDepth';
/** Lets a chat finish loading before the books are read. */
const CHECK_DELAY_MS = 1500;
const PREVIEW_LINES = 8;

export interface ArchiveFixPayload {
    book: string;
    patches: EntryPatch[];
}

function isArchivePayload(value: unknown): value is ArchiveFixPayload {
    return (
        isPlainObject(value) &&
        typeof value.book === 'string' &&
        Array.isArray(value.patches) &&
        value.patches.every(isEntryPatch)
    );
}

/** DES-RU's `nameFormsKey` (adapter `api()` → `globalThis.DESRU_API`), when available. */
export function desruFormsKey(env: RuleEnv): ((name: string) => string | null) | null {
    let api: unknown;
    try {
        const adapter = adaptersOf(env.app).desru as unknown as { api?: () => unknown };
        api = typeof adapter.api === 'function' ? adapter.api() : undefined;
    } catch (error) {
        env.log.debug('DES-RU API is not available', error);
        return null;
    }
    const formsKey = isPlainObject(api) ? api.nameFormsKey : undefined;
    if (typeof formsKey !== 'function') return null;
    return (name) => {
        const result: unknown = (formsKey as (name: string) => unknown)(name);
        return typeof result === 'string' && result ? result : null;
    };
}

/** Active books: the latest real scan plus the BunnyMo adapter's list of active books. */
async function candidateBooks(env: RuleEnv): Promise<string[]> {
    const books = new Set(env.activeBooks());
    try {
        const bunnymo = adaptersOf(env.app).bunnymo as unknown as { activeBooks?: () => Promise<string[]> };
        if (typeof bunnymo.activeBooks === 'function') for (const book of await bunnymo.activeBooks()) books.add(book);
    } catch (error) {
        env.log.debug('active books are not available', error);
    }
    return [...books];
}

/**
 * Books worth loading (the check runs after every generation): with the BunnyMo adapter's classification, only the
 * active books that hold archives; without it, every candidate (its content decides).
 */
function archiveCandidates(env: RuleEnv, books: string[]): string[] {
    try {
        const known = (adaptersOf(env.app).bunnymo as unknown as { books?: () => { archives: string[] } }).books?.();
        if (known && Array.isArray(known.archives)) return books.filter((book) => known.archives.includes(book));
    } catch (error) {
        env.log.debug('BunnyMo classification is not available', error);
    }
    return books;
}

/**
 * One proposal per archive book with scan-depth-1 archives (not proposed before for the same entries). Returns how
 * many proposals were made.
 */
export async function proposeArchiveFixes(env: RuleEnv): Promise<number> {
    if (!env.isActive(ARCHIVE_DEPTH_RULE_ID)) return 0;
    const io = bookIo(env.app);
    if (!io) return 0;
    const roles = env.app.modules.api<BookRolesApi>('bookRoles');
    const formsKey = desruFormsKey(env);
    let proposed = 0;
    const books = await candidateBooks(env);
    const withArchives = new Set(archiveCandidates(env, books));
    for (const book of books) {
        const role = roles?.roleOf(book);
        if (role ? role.role !== 'ck.archive' : !withArchives.has(book)) continue;
        const data = await io.load(book);
        if (!data || isProtectedBook(env.app, book, data) || (!role && !hasArchives(data))) continue;
        const patches = enabledEntriesOf(data)
            .filter(({ entry }) => isCharacterArchive(entry))
            .map(({ uid, entry }) => planArchiveDepthFix(uid, entry, formsKey ?? undefined))
            .filter((patch): patch is EntryPatch => patch !== null);
        const settings = env.settings();
        if (!patches.length) {
            if (settings.archiveProposals[book] !== undefined) {
                delete settings.archiveProposals[book];
                env.app.settings.save();
            }
            continue;
        }
        const signature = patches
            .map((patch) => patch.uid)
            .sort((a, b) => a - b)
            .join(',');
        if (settings.archiveProposals[book] === signature) continue;
        const payload: ArchiveFixPayload = { book, patches };
        const withForms = patches.some((patch) => 'key' in patch.after);
        // The card names the characters (the first key of an archive is the name); uids and entry titles go to
        // «Подробнее».
        const names: string[] = [];
        const preview = patches.slice(0, PREVIEW_LINES).map((patch) => {
            const entry = data.entries[String(patch.uid)];
            const comment = isPlainObject(entry) && typeof entry.comment === 'string' ? entry.comment : '';
            const first = isPlainObject(entry) && Array.isArray(entry.key) ? entry.key[0] : undefined;
            const name = typeof first === 'string' && first.trim() ? first.trim() : comment.trim();
            if (name) names.push(`«${name}»`);
            return `#${patch.uid} ${comment}`.trim();
        });
        if (patches.length > PREVIEW_LINES) {
            const more = env.t('m22.archiveDepth.more', { count: patches.length - PREVIEW_LINES });
            preview.push(more);
            if (names.length) names.push(more);
        }
        const decision = await env.app.autonomy.decide<ArchiveFixPayload>(
            {
                module: 'M22',
                kind: ARCHIVE_DEPTH_KIND,
                title: env.t('m22.archiveDepth.title', { book }),
                description: [
                    env.t('m22.archiveDepth.description', { book, count: patches.length }),
                    names.length ? env.t('m22.archiveDepth.entries', { list: names.join(', ') }) : '',
                    withForms ? env.t('m22.archiveDepth.forms') : formsKey ? '' : env.t('m22.archiveDepth.noForms'),
                ]
                    .filter(Boolean)
                    .join('\n\n'),
                details: preview.join('\n'),
                changes: patchChanges(book, patches),
                payload,
                stillValid: () => archiveFixValid(env, payload),
                apply: (value) => applyArchiveFix(env, value),
            },
            'inbox',
        );
        if (decision === 'skipped') continue;
        settings.archiveProposals[book] = signature;
        env.app.settings.save();
        proposed += 1;
    }
    return proposed;
}

async function applyArchiveFix(env: RuleEnv, payload: ArchiveFixPayload): Promise<void> {
    const result = await writePatches(env.app, payload.book, payload.patches);
    if (!result.ok) {
        throw new Error(env.t(`m22.archiveDepth.failed.${result.reason ?? 'missing'}`, { book: payload.book }));
    }
}

/** Every entry still holds the values the proposal was made for. */
async function archiveFixValid(env: RuleEnv, payload: ArchiveFixPayload): Promise<boolean> {
    const io = bookIo(env.app);
    const data = io ? await io.load(payload.book) : null;
    if (!data || isProtectedBook(env.app, payload.book, data)) return false;
    return patchBookData(data, payload.patches).ok;
}

export function archiveDepthRule(env: RuleEnv): RuleDefinition {
    return {
        id: ARCHIVE_DEPTH_RULE_ID,
        titleKey: 'm22.rule.ck.archiveDepth.title',
        descriptionKey: 'm22.rule.ck.archiveDepth.description',
        owner: 'maestro',
        stage: 2,
        kind: 'lore',
        defaultLevel: 'auto',
        enabledByDefault: true,
        start(): Unsubscribe {
            let timer: ReturnType<typeof setTimeout> | null = null;
            let running = false;
            const run = async () => {
                if (running) return;
                running = true;
                try {
                    await proposeArchiveFixes(env);
                } catch (error) {
                    env.log.warn('CK archive check failed', error);
                } finally {
                    running = false;
                }
            };
            const schedule = () => {
                if (timer !== null) clearTimeout(timer);
                timer = setTimeout(() => {
                    timer = null;
                    void run();
                }, CHECK_DELAY_MS);
            };
            const offs: Unsubscribe[] = [env.app.bus.on('generation:ended', schedule)];
            const chatChanged = env.app.host.events.name('CHAT_CHANGED');
            if (chatChanged) offs.push(env.app.host.events.on(chatChanged, schedule));
            schedule();
            return () => {
                for (const off of offs) off();
                if (timer !== null) clearTimeout(timer);
                timer = null;
            };
        },
    };
}

/** Inbox applier (cards survive reloads); the module owns the returned disposer. */
export function registerArchiveHandlers(env: RuleEnv): Unsubscribe[] {
    return [
        env.app.inbox.registerApplier(
            ARCHIVE_DEPTH_KIND,
            async (payload) => {
                if (!isArchivePayload(payload)) throw new Error('bad CK archive card');
                await applyArchiveFix(env, payload);
            },
            async (payload) => isArchivePayload(payload) && archiveFixValid(env, payload),
        ),
    ];
}
