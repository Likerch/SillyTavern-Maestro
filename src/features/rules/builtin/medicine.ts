// Quiet mode of BunnyMo's «Medicine Check» for Dramatis (release 1.17; Dramatis docs/model.md §10.5, Maestro
// docs/integration-dramatis.md): the core's per-turn medication instruction (V3.0 #41, «💉 Master - Medicine Check», key
// `/^/`) overlaps with the dependence state Dramatis keeps for its characters. While Dramatis claims
// 'bunnymo.medicineCheck' (MAESTRO_API.quiet) and every character of the scene whose CK archive carries `<MED:…>` /
// `<REC:…>` tags — the present characters of the committed reply, and the persona — is one whose dependence Dramatis
// owns (DRAMATIS_API.dependenceOwned), the entry's scan copy is switched off. Nobody tagged in the scene, an archive not
// read yet, or one tagged character Dramatis does not own: the entry stays. The pack file is never touched (P13); without
// the claim, without Dramatis or with the rule off BunnyMo works as before.
import { adaptersOf, dramatisOf } from '../../../adapters';
import { archiveTags, classifyWorlds, hasDependenceTags, isMedicineCheckEntry } from '../../../domain/bunnymo';
import { sceneCast } from '../../../domain/scene-cast';
import { sceneTracker } from '../../../domain/voices-cards';
import { normalizeName } from '../../../domain/world-names';
import type { Unsubscribe } from '../../../shared/contracts';
import type { BookRolesApi } from '../../bookRoles/api';
import type { Entity, WorldModelApi } from '../../world/api';
import type { EntryCopy, EntryLists, RuleChange, RuleDefinition } from '../api';
import { entriesOf } from '../env';
import type { RuleEnv } from '../env';

export const MEDICINE_RULE_ID = 'bunnymo.medicineQuiet';
const CACHE_LIMIT = 200;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Why the entry stayed or left in the latest real scan (the pult shows it through options()). */
export type MedicineVerdict = 'off' | 'noEntry' | 'none' | 'loading' | 'notOwned' | 'dropped';

export interface MedicineState {
    verdict: MedicineVerdict;
    /** Characters of the scene whose archive carries MED/REC tags. */
    tagged: string[];
    /** Of them, the ones Dramatis does not own. */
    notOwned: string[];
}

interface Member {
    name: string;
    entity: Entity;
    /** `book#uid` of the CK archive. */
    archive: string | null;
}

function archiveRef(entity: Entity): string | null {
    const source = entity.sources.find(
        (item) => item.kind === 'ck.archive' && typeof item.world === 'string' && typeof item.uid === 'number',
    );
    return source?.world !== undefined && source.uid !== undefined ? `${source.world}#${source.uid}` : null;
}

function splitRef(ref: string): { book: string; uid: number } {
    const at = ref.lastIndexOf('#');
    return { book: ref.slice(0, at), uid: Number(ref.slice(at + 1)) };
}

export function medicineRule(env: RuleEnv): RuleDefinition {
    /** Archive tags by `book#uid` (null: no archive entry there); filled in the background, never on a scan. */
    const tags = new Map<string, string[] | null>();
    /** Books being read, and the archives waiting for them. */
    const loading = new Set<string>();
    const wanted = new Set<string>();
    let state: MedicineState = { verdict: 'off', tagged: [], notOwned: [] };

    const world = (): WorldModelApi | undefined => env.app.modules.api<WorldModelApi>('world');

    const resolve = (name: string): Entity | undefined => {
        const api = world();
        if (!api) return undefined;
        try {
            return api.resolve(name, 'character') ?? api.resolve(name);
        } catch {
            return undefined;
        }
    };

    /** The scene's characters with an entity (an archive needs one), and the persona. */
    const scene = (): Member[] => {
        const ctx = env.app.host.ctx();
        const ownName = String(ctx.name1 ?? '').trim();
        let persona: Entity | undefined;
        try {
            persona = ownName ? world()?.resolve(ownName, 'persona') : undefined;
        } catch {
            persona = undefined;
        }
        const hidden = ((): string[] => {
            try {
                const des = adaptersOf(env.app).des as { removedCharacters?: () => string[] } | undefined;
                return typeof des?.removedCharacters === 'function' ? des.removedCharacters() : [];
            } catch {
                return [];
            }
        })();
        const chat = (ctx.chat ?? []) as unknown[];
        const tracker = env.app.host.chatId() ? sceneTracker(chat) : null;
        const members: Member[] = [];
        for (const member of sceneCast<Entity>(tracker, {
            persona: persona?.name ?? ownName,
            ownName,
            hidden,
            resolve,
        })) {
            if (member.entity)
                members.push({ name: member.name, entity: member.entity, archive: archiveRef(member.entity) });
        }
        if (persona) members.push({ name: persona.name, entity: persona, archive: archiveRef(persona) });
        return members;
    };

    /** Reads the archive's book once for every archive of it the scene asks for. */
    const load = (ref: string): void => {
        if (tags.has(ref)) return;
        const read = env.app.host.ctx().loadWorldInfo;
        if (typeof read !== 'function') return;
        wanted.add(ref);
        const { book } = splitRef(ref);
        if (loading.has(book)) return;
        loading.add(book);
        void Promise.resolve(read(book))
            .then((data) => {
                const entries = isDict(data) && isDict(data.entries) ? data.entries : {};
                for (const item of [...wanted]) {
                    const at = splitRef(item);
                    if (at.book !== book) continue;
                    wanted.delete(item);
                    const entry =
                        Object.values(entries).find((value) => isDict(value) && Number(value.uid) === at.uid) ??
                        entries[String(at.uid)];
                    if (tags.size >= CACHE_LIMIT) tags.clear();
                    tags.set(item, isDict(entry) ? archiveTags(entry).tags : null);
                }
            })
            .catch((error: unknown) => env.log.debug(`archive book ${book} could not be read`, error))
            .finally(() => loading.delete(book));
    };

    /** Reads the archives of the scene ahead of the next scan (P15: nothing is awaited on a scan). */
    const warm = (): void => {
        if (!dramatisOf(env.app)?.claimsMedicineCheck()) return;
        try {
            for (const member of scene()) if (member.archive) load(member.archive);
        } catch (error) {
            env.log.debug('Medicine Check: the scene could not be read', error);
        }
    };

    /** Tags of an archive: its scan copy when the book is in this scan, else the background cache. */
    const tagsOf = (ref: string, copies: Map<string, EntryCopy>): string[] | null | undefined => {
        const copy = copies.get(ref);
        if (copy) return archiveTags(copy).tags;
        if (tags.has(ref)) return tags.get(ref);
        load(ref);
        return undefined;
    };

    /** The core book test: M35 roles, the BunnyMo adapter, then the content heuristics of this scan. */
    const coreBooks = (entries: EntryCopy[]): Set<string> => {
        const core = new Set<string>();
        try {
            for (const info of env.app.modules.api<BookRolesApi>('bookRoles')?.all() ?? []) {
                if (info.role === 'bunnymo.core') core.add(info.book);
            }
        } catch (error) {
            env.log.debug('book roles are not available', error);
        }
        try {
            for (const book of adaptersOf(env.app).bunnymo.books().core) core.add(book);
        } catch {
            // A fake or not-ready adapter: the classification below decides.
        }
        for (const book of classifyWorlds(entries).core) core.add(book);
        return core;
    };

    const owns = (owned: readonly string[], member: Member): boolean => {
        const names = new Set(
            [member.name, member.entity.name, ...member.entity.aliases, ...member.entity.forms].map(normalizeName),
        );
        return owned.some((name) => names.has(normalizeName(name)) || resolve(name)?.id === member.entity.id);
    };

    const decide = (entries: EntryCopy[]): MedicineState => {
        const dramatis = dramatisOf(env.app);
        if (!dramatis) return { verdict: 'off', tagged: [], notOwned: [] };
        const copies = new Map(entries.map((entry) => [`${entry.world}#${entry.uid}`, entry]));
        const tagged: Member[] = [];
        let unknown = false;
        for (const member of scene()) {
            if (!member.archive) continue;
            const list = tagsOf(member.archive, copies);
            if (list === undefined) unknown = true;
            else if (list && hasDependenceTags(list)) tagged.push(member);
        }
        const names = tagged.map((member) => member.name);
        if (unknown) return { verdict: 'loading', tagged: names, notOwned: [] };
        if (!tagged.length) return { verdict: 'none', tagged: [], notOwned: [] };
        const owned = dramatis.dependenceOwned();
        const notOwned = tagged.filter((member) => !owns(owned, member)).map((member) => member.name);
        return { verdict: notOwned.length ? 'notOwned' : 'dropped', tagged: names, notOwned };
    };

    return {
        id: MEDICINE_RULE_ID,
        titleKey: 'm22.rule.bunnymo.medicineQuiet.title',
        descriptionKey: 'm22.rule.bunnymo.medicineQuiet.description',
        owner: 'maestro',
        stage: 3,
        kind: 'lore',
        defaultLevel: 'auto',
        enabledByDefault: true,
        // It acts only when Dramatis asks for it (its claim is the user's choice in Dramatis).
        safeBeforeWizard: true,
        requires: ['st.events.entriesLoaded', 'dramatis.api'],
        // After the pack rules: a suppressed pack copy is no longer there.
        order: 60,
        applyEntries(lists: EntryLists, changes: RuleChange[]): void {
            const simulated = env.simulating();
            if (!dramatisOf(env.app)?.claimsMedicineCheck()) {
                if (!simulated) state = { verdict: 'off', tagged: [], notOwned: [] };
                return;
            }
            const entries = entriesOf(lists);
            const core = coreBooks(entries);
            const targets = entries.filter(
                (entry) => entry.disable !== true && core.has(entry.world) && isMedicineCheckEntry(entry),
            );
            if (!targets.length) {
                if (!simulated) state = { verdict: 'noEntry', tagged: [], notOwned: [] };
                return;
            }
            const verdict = decide(entries);
            if (!simulated) state = verdict;
            if (verdict.verdict !== 'dropped') return;
            for (const entry of targets) {
                changes.push({ world: entry.world, uid: entry.uid, field: 'disable', before: false, after: true });
                entry.disable = true;
            }
        },
        start(): Unsubscribe {
            const offs: Unsubscribe[] = [
                env.app.bus.on('chat:changed', () => {
                    tags.clear();
                    warm();
                }),
                env.app.bus.on('turn:committed', () => warm()),
                env.app.bus.on('reply:ready', () => warm()),
                env.app.bus.on('message:invalidated', () => warm()),
            ];
            const dramatis = dramatisOf(env.app);
            if (dramatis) offs.push(dramatis.onQuietChange(() => warm()));
            const updated = env.app.host.events.name('WORLDINFO_UPDATED');
            if (updated) {
                offs.push(
                    env.app.host.events.on(updated, (name) => {
                        if (typeof name !== 'string') return;
                        for (const ref of [...tags.keys()]) if (splitRef(ref).book === name) tags.delete(ref);
                        warm();
                    }),
                );
            }
            warm();
            return () => {
                for (const off of offs.splice(0)) off();
                tags.clear();
            };
        },
        options(): Record<string, unknown> {
            return { ...state, tagged: [...state.tagged], notOwned: [...state.notOwned] };
        },
    };
}
