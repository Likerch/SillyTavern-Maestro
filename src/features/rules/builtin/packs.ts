// BunnyMo pack rules of stage 2 (plan M22, P13, Q33; research/bunnymo-carrotkernel.md §1.2, §1.5):
// - 'pack.versionConflict': entries with the same keys and different text in two or more BunnyMo books. Which book
//   stays is asked once per group of books (autonomy kind 'rules.packVersion', default 'ask', the newest book offered);
//   until the answer nothing is suppressed, afterwards the copies of the other books are switched off in every scan.
//   The question never waits on the send path: it is asked after the generation (or right away outside one).
// - 'wrapper.nsfwCollision': CarrotCast entries keyed by the bare tag `<NSFW>` get `excludeRecursion` on the scan copy,
//   so archive text wrapped in `<NSFW>…</NSFW>` no longer pulls them in; a direct mention in the chat still does.
// Both are technical runtime fixes (P13): pack files are never touched.
import { adaptersOf } from '../../../adapters';
import { classifyWorlds } from '../../../domain/bunnymo';
import { findVersionConflicts, hasNsfwKey, isCarrotCastEntry, losersOf } from '../../../domain/rules-packs';
import type { VersionConflict } from '../../../domain/rules-packs';
import { isPlainObject } from '../../../domain/rules-lore';
import type { JournalChange, Unsubscribe } from '../../../shared/contracts';
import type { BookRolesApi } from '../../bookRoles/api';
import type { EntryCopy, EntryLists, PackGroupInfo, RuleChange, RuleDefinition } from '../api';
import { entriesOf } from '../env';
import type { RuleEnv } from '../env';

export const PACK_VERSION_RULE_ID = 'pack.versionConflict';
export const PACK_VERSION_KIND = 'rules.packVersion';
/** Journal target of a stored answer; undo returns the group to "keep every version" (no new question). */
export const PACK_CHOICE_TARGET = 'm22.packChoice';
export const NSFW_RULE_ID = 'wrapper.nsfwCollision';

interface PackChoicePayload {
    group: string;
    book: string;
}

function isChoicePayload(value: unknown): value is PackChoicePayload {
    return isPlainObject(value) && typeof value.group === 'string' && typeof value.book === 'string';
}

/** Stores an answer ('' = keep every version) and forgets the pending question. */
export function setPackChoice(env: RuleEnv, group: string, book: string | null): void {
    const settings = env.settings();
    if (book === null) delete settings.packChoices[group];
    else settings.packChoices[group] = book;
    settings.packAsked[group] = settings.packAsked[group] ?? Date.now();
    env.app.settings.save();
    env.app.settings.notify('m22.packChoices');
}

/** Pack test for one scan: M35 roles, the BunnyMo adapter's classification, then the content heuristics. */
function packTester(env: RuleEnv, entries: EntryCopy[]): (world: string) => boolean {
    const packs = new Set<string>();
    try {
        const roles = env.app.modules.api<BookRolesApi>('bookRoles');
        for (const info of roles?.all() ?? []) {
            if (info.role === 'bunnymo.pack' || info.role === 'bunnymo.core') packs.add(info.book);
        }
    } catch (error) {
        env.log.debug('book roles are not available', error);
    }
    try {
        const known = adaptersOf(env.app).bunnymo.books();
        for (const book of [...known.packs, ...known.core]) packs.add(book);
    } catch {
        // A fake or not-ready adapter: the heuristics below decide.
    }
    let classified: Set<string> | null = null;
    return (world) => {
        if (packs.has(world)) return true;
        if (!classified) {
            const result = classifyWorlds(entries);
            classified = new Set([...result.packs, ...result.core]);
        }
        return classified.has(world);
    };
}

export function packVersionRule(env: RuleEnv): RuleDefinition {
    /** Groups of the latest real scan, for the pult. */
    let groups: VersionConflict<EntryCopy>[] = [];
    /** Groups waiting for the question, and groups asked in this session. */
    const pending = new Map<string, VersionConflict<EntryCopy>>();
    const asked = new Set<string>();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let running = false;

    const t = env.t;

    const ask = async (group: VersionConflict<EntryCopy>): Promise<void> => {
        const settings = env.settings();
        if (asked.has(group.id) || settings.packChoices[group.id] !== undefined || settings.packAsked[group.id]) return;
        asked.add(group.id);
        const others = group.books.filter((book) => book !== group.newest);
        const payload: PackChoicePayload = { group: group.id, book: group.newest };
        const decision = await env.app.autonomy.decide<PackChoicePayload>(
            {
                module: 'M22',
                kind: PACK_VERSION_KIND,
                title: t('m22.packVersion.title', { book: group.newest }),
                description: t('m22.packVersion.description', {
                    books: group.books.join(' · '),
                    count: group.count,
                    book: group.newest,
                    others: others.join(', '),
                }),
                // BunnyMo tags (<INTJ-U>) are technical: «Подробнее».
                details: group.sample.length ? t('m22.packVersion.details', { sample: group.sample.join(', ') }) : '',
                changes: [{ target: PACK_CHOICE_TARGET, ref: { group: group.id }, before: null, after: group.newest }],
                payload,
                stillValid: async () => env.settings().packChoices[group.id] === undefined,
                apply: async (value) => setPackChoice(env, value.group, value.book),
            },
            'ask',
        );
        if (decision === 'rejected') {
            setPackChoice(env, group.id, '');
        } else if (decision === 'queued' || decision === 'notified') {
            env.settings().packAsked[group.id] = Date.now();
            env.app.settings.save();
            env.app.settings.notify('m22.packAsked');
        } else if (decision === 'skipped') {
            // Autonomy is off or the UI is not ready: ask again in a later session.
            env.log.debug(`pack version question for ${group.id} skipped`);
        }
    };

    const flush = async (): Promise<void> => {
        if (running) return;
        running = true;
        try {
            while (pending.size) {
                const [id, group] = pending.entries().next().value as [string, VersionConflict<EntryCopy>];
                pending.delete(id);
                if (!env.isActive(PACK_VERSION_RULE_ID)) continue;
                try {
                    await ask(group);
                } catch (error) {
                    env.log.warn('pack version question failed', error);
                }
            }
        } finally {
            running = false;
        }
    };

    /** Asks after the current generation, or on the next tick when none runs (P15: never on the send path). */
    const schedule = (): void => {
        if (timer !== null || env.app.turn.current()) return;
        timer = setTimeout(() => {
            timer = null;
            void flush();
        }, 0);
    };

    return {
        id: PACK_VERSION_RULE_ID,
        titleKey: 'm22.rule.pack.versionConflict.title',
        descriptionKey: 'm22.rule.pack.versionConflict.description',
        owner: 'maestro',
        stage: 2,
        kind: 'lore',
        defaultLevel: 'auto',
        enabledByDefault: true,
        requires: ['st.events.entriesLoaded'],
        // After the byte-identical duplicates (20): identical copies are already off.
        order: 25,
        applyEntries(lists: EntryLists, changes: RuleChange[]): void {
            const entries = entriesOf(lists);
            const conflicts = findVersionConflicts(entries, packTester(env, entries));
            const simulated = env.simulating();
            if (!simulated) groups = conflicts;
            const settings = env.settings();
            for (const group of conflicts) {
                const choice = settings.packChoices[group.id];
                if (choice === undefined) {
                    if (!simulated && !settings.packAsked[group.id] && !asked.has(group.id)) {
                        pending.set(group.id, group);
                    }
                    continue;
                }
                for (const entry of losersOf(group, choice)) {
                    if (entry.disable === true) continue;
                    changes.push({ world: entry.world, uid: entry.uid, field: 'disable', before: false, after: true });
                    entry.disable = true;
                }
            }
            if (pending.size) schedule();
        },
        start(): Unsubscribe {
            const off = env.app.bus.on('generation:ended', () => {
                if (pending.size) schedule();
            });
            return () => {
                off();
                if (timer !== null) clearTimeout(timer);
                timer = null;
                pending.clear();
            };
        },
        options(): Record<string, unknown> {
            const settings = env.settings();
            const info: PackGroupInfo[] = groups.map((group) => ({
                id: group.id,
                books: [...group.books],
                newest: group.newest,
                count: group.count,
                sample: [...group.sample],
                ...(settings.packChoices[group.id] !== undefined ? { choice: settings.packChoices[group.id] } : {}),
                asked: settings.packAsked[group.id] !== undefined || asked.has(group.id),
            }));
            return { groups: info, choices: { ...settings.packChoices } };
        },
        setOptions(options: Record<string, unknown>): void {
            if (!isPlainObject(options.choices)) return;
            for (const [group, book] of Object.entries(options.choices)) {
                if (typeof book === 'string') setPackChoice(env, group, book);
                else if (book === null) setPackChoice(env, group, null);
            }
        },
    };
}

export function nsfwRule(): RuleDefinition {
    return {
        id: NSFW_RULE_ID,
        titleKey: 'm22.rule.wrapper.nsfwCollision.title',
        descriptionKey: 'm22.rule.wrapper.nsfwCollision.description',
        owner: 'maestro',
        stage: 2,
        kind: 'lore',
        defaultLevel: 'auto',
        enabledByDefault: true,
        requires: ['st.events.entriesLoaded'],
        order: 40,
        applyEntries(lists: EntryLists, changes: RuleChange[]): void {
            for (const entry of entriesOf(lists)) {
                if (entry.disable === true || entry.excludeRecursion === true) continue;
                if (!hasNsfwKey(entry.key) || !isCarrotCastEntry(entry)) continue;
                changes.push({
                    world: entry.world,
                    uid: entry.uid,
                    field: 'excludeRecursion',
                    before: entry.excludeRecursion ?? false,
                    after: true,
                });
                entry.excludeRecursion = true;
            }
        },
    };
}

/** Inbox applier of the question and the undo of an answer; the module owns the returned disposers. */
export function registerPackHandlers(env: RuleEnv): Unsubscribe[] {
    env.app.journal.registerUndo(PACK_CHOICE_TARGET, async (change: JournalChange) => {
        const group = isPlainObject(change.ref) ? change.ref.group : undefined;
        if (typeof group !== 'string') return false;
        setPackChoice(env, group, typeof change.before === 'string' ? change.before : '');
        return true;
    });
    return [
        env.app.inbox.registerApplier(
            PACK_VERSION_KIND,
            async (payload) => {
                if (isChoicePayload(payload)) setPackChoice(env, payload.group, payload.book);
            },
            async (payload) => isChoicePayload(payload) && env.settings().packChoices[payload.group] === undefined,
        ),
    ];
}
