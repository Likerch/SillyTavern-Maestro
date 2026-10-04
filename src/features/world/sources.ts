// Where the world model's records come from (plan §4.2 «Сборка», research/des.md §2, qvink-nai-studio.md §B1,
// bunnymo-carrotkernel.md §2.2). Two speeds:
// - cheap(): the chat's card(s), the persona, the DES roster with presence from the committed tracker, DES and DES-RU
//   canonical aliases, NAI passports, the place registry. Synchronous reads of live state, no lorebooks — fit for
//   every committed turn;
// - lore(): lorebooks of the active books and the CarrotKernel repos (typed entries, archives, entries named after a
//   known entity) and the chat canon. Read lazily and never on the send path.
// Read-only: nothing here writes to a neighbour.
import { adaptersOf } from '../../adapters';
import { archiveTags, isCharacterArchive } from '../../domain/bunnymo';
import type { DesTrackerSnapshot } from '../../domain/des-tracker';
import { readTypedMeta } from '../../domain/entry-types';
import type { WorldAttach, WorldRecord, WorldSource } from '../../domain/world-identity';
import type { WorldKind } from '../../domain/world-names';
import { looksLikeName, nameList, normalizeName, splitAliases } from '../../domain/world-names';
import type { App, Logger } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { CanonApi, CanonItem } from '../canon/api';
import type { PlacesApi } from '../places/api';

type Dict = Record<string, unknown>;

/** Canonical-name priority of each store (lower wins; DES canonical aliases override them all). */
export const RANK = { card: 1, persona: 1, place: 1, entry: 2, archive: 3, passport: 4, roster: 5 } as const;

/** Entry types that are world entities (rules, chapters and notes are not). */
const ENTRY_KINDS: ReadonlySet<string> = new Set([
    'character',
    'place',
    'item',
    'faction',
    'event',
    'tradition',
    'mechanic',
]);
/** Book roles whose entries never describe the story's world (P13: BunnyMo is a vocabulary, not a cast). */
const SKIPPED_ROLES: ReadonlySet<string> = new Set(['bunnymo.core', 'bunnymo.pack', 'backup']);
const PASSPORT_KINDS: Readonly<Record<string, WorldKind>> = {
    character: 'character',
    location: 'place',
    object: 'item',
};

export interface CheapSources {
    records: WorldRecord[];
    aliasGroups: Record<string, string[]>[];
}

export interface LoreSources {
    records: WorldRecord[];
    attach: WorldAttach[];
    /** Books read (WORLDINFO_UPDATED of one of them makes the result stale). */
    books: Set<string>;
    canonBook: string;
    canonItems: CanonItem[];
    at: number;
}

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

/** A copy of a DES alias map with only string lists. */
function aliasMap(value: unknown): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    if (!isDict(value)) return out;
    for (const [canonical, list] of Object.entries(value)) {
        if (canonical.trim() && Array.isArray(list)) out[canonical] = strings(list);
    }
    return out;
}

/** Name of an entry: typed name field, else the first name-like key, else a name-like comment. */
export function entryName(entry: Dict, typedName?: string): string {
    if (typedName && typedName.trim()) return typedName.trim();
    const key = strings(entry.key).find((item) => looksLikeName(item));
    if (key) return key.trim();
    const comment = text(entry.comment);
    return looksLikeName(comment) ? comment : '';
}

function entryLabel(entry: Dict, uid: number): string {
    return text(entry.comment) || strings(entry.key)[0]?.trim() || `#${uid}`;
}

function entryKeys(entry: Dict): string[] {
    return [...strings(entry.key), ...strings(entry.keysecondary)];
}

/** Minimal tolerant view of a NAI Studio passport: id, kind, name, aliases. */
interface PassportView {
    id: string;
    kind: string;
    name: string;
    aliases: string[];
}

export function passportView(raw: unknown): PassportView | null {
    if (!isDict(raw)) return null;
    return {
        id: text(raw.id) || 'main',
        kind: text(raw.kind) || 'character',
        name: text(raw.name),
        aliases: strings(raw.aliases),
    };
}

function passportList(value: unknown): PassportView[] {
    const list = Array.isArray(value)
        ? value
        : isDict(value) && Array.isArray(value.passports)
          ? value.passports
          : [value];
    return list.map(passportView).filter((item): item is PassportView => item !== null);
}

/** The chat's character cards with their index in ctx.characters (every member in a group chat). */
export function chatCards(ctx: STContext): { index: number; character: STCharacter }[] {
    const out: { index: number; character: STCharacter }[] = [];
    const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
    if (ctx.groupId) {
        const group = (ctx.groups ?? []).find((item) => item.id === ctx.groupId);
        for (const avatar of group?.members ?? []) {
            const index = characters.findIndex((character) => character?.avatar === avatar);
            if (index >= 0) out.push({ index, character: characters[index] as STCharacter });
        }
        return out;
    }
    if (ctx.characterId === undefined || ctx.characterId === null || ctx.characterId === '') return out;
    const index = Number(ctx.characterId);
    const character = Number.isInteger(index) ? characters[index] : undefined;
    if (character?.name) out.push({ index, character });
    return out;
}

export class WorldSources {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /* ---------------------------------------------------------------- cheap */

    cheap(snapshot: DesTrackerSnapshot | null): CheapSources {
        const records: WorldRecord[] = [];
        const ctx = this.app.host.ctx();
        const cards = chatCards(ctx);
        for (const { character } of cards) {
            records.push({
                kind: 'character',
                name: character.name,
                source: { kind: 'card', ref: character.avatar, label: character.name, avatar: character.avatar },
                rank: RANK.card,
            });
        }
        const persona = text(ctx.name1);
        if (persona) {
            records.push({
                kind: 'persona',
                name: persona,
                source: { kind: 'persona', ref: this.personaAvatars(persona)[0] ?? persona, label: persona },
                rank: RANK.persona,
            });
        }
        records.push(...this.roster(snapshot));
        records.push(...this.passports(cards, persona));
        records.push(...this.places());
        return { records, aliasGroups: this.aliasGroups() };
    }

    /** DES canonical aliases and DES-RU's view of them (DES-RU 0.8.0+). */
    aliasGroups(): Record<string, string[]>[] {
        const groups: Record<string, string[]>[] = [];
        const adapters = adaptersOf(this.app);
        try {
            groups.push(aliasMap(adapters.des.aliases()));
        } catch (error) {
            this.log.debug('DES aliases are not available', error);
        }
        try {
            const api = adapters.desru.api();
            if (api) groups.push(aliasMap(api.aliases()));
        } catch (error) {
            this.log.debug('DES-RU aliases are not available', error);
        }
        return groups;
    }

    /** DES roster minus hidden names, plus whoever the committed tracker shows; presence from that tracker. */
    private roster(snapshot: DesTrackerSnapshot | null): WorldRecord[] {
        const des = adaptersOf(this.app).des;
        let known: string[] = [];
        let removed = new Set<string>();
        try {
            known = des.knownCharacters();
            removed = new Set(des.removedCharacters().map(normalizeName));
        } catch (error) {
            this.log.debug('DES roster is not available', error);
        }
        const inScene = new Map<string, boolean>();
        for (const character of snapshot?.characters ?? []) {
            const key = normalizeName(character.name);
            inScene.set(key, (inScene.get(key) ?? false) || !character.offScene);
        }
        const names = new Map<string, string>();
        for (const name of [...known, ...(snapshot?.characters ?? []).map((character) => character.name)]) {
            const key = normalizeName(name);
            if (key && !removed.has(key) && !names.has(key)) names.set(key, name.trim());
        }
        const out: WorldRecord[] = [];
        for (const [key, name] of names) {
            const record: WorldRecord = {
                kind: 'character',
                name,
                source: { kind: 'des.character', ref: name, label: name },
                rank: RANK.roster,
            };
            if (snapshot) record.present = inScene.get(key) ?? false;
            out.push(record);
        }
        return out;
    }

    private personaAvatars(persona: string): string[] {
        const personas = this.app.host.ctx().powerUserSettings?.personas;
        if (!isDict(personas)) return [];
        const key = normalizeName(persona);
        return Object.entries(personas)
            .filter(([, name]) => typeof name === 'string' && normalizeName(name) === key)
            .map(([avatar]) => avatar);
    }

    /**
     * NAI passports. With NAI Studio's API (0.10.0+) they are read as the chat sees them (chat overrides applied):
     * per card, the persona's and the chat's own. Without it: the card field, and the persona passport from NAI's
     * settings; chat-level passports need the API.
     */
    private passports(cards: { index: number; character: STCharacter }[], persona: string): WorldRecord[] {
        const nai = adaptersOf(this.app).nai;
        const out: WorldRecord[] = [];
        const push = (passport: PassportView, owner: string, ownerKind: WorldKind | 'chat', avatar?: string) => {
            const kind = PASSPORT_KINDS[passport.kind];
            if (!kind) return;
            const name = passport.name || (kind === 'character' ? owner : '');
            if (!name) return;
            const source: WorldSource = {
                kind: 'nai.passport',
                ref: `${avatar ?? ownerKind}#${passport.id}`,
                label: name,
                passportId: passport.id,
            };
            if (avatar) source.avatar = avatar;
            out.push({
                kind: !passport.name && ownerKind === 'persona' ? 'persona' : kind,
                name,
                aliases: nameList(passport.aliases),
                source,
                rank: RANK.passport,
            });
        };
        const views = (list: unknown[]): PassportView[] =>
            list.map(passportView).filter((item): item is PassportView => item !== null);
        let api: boolean;
        try {
            api = nai.api() !== undefined;
        } catch {
            api = false;
        }
        for (const { index, character } of cards) {
            try {
                const list = api ? nai.chatPassports({ avatar: character.avatar }) : nai.passportsOf(index);
                for (const passport of views(list)) push(passport, character.name, 'character', character.avatar);
            } catch (error) {
                this.log.debug('NAI passports are not available', error);
            }
        }
        if (persona) {
            let list: PassportView[] = [];
            try {
                list = api ? views(nai.chatPassports({ persona: true })) : this.personaPassportsFromSettings(persona);
            } catch (error) {
                this.log.debug('NAI persona passport is not available', error);
            }
            for (const passport of list) push(passport, persona, 'persona');
        }
        if (api) {
            try {
                for (const passport of views(nai.chatPassports({ chat: true }))) push(passport, '', 'chat');
            } catch (error) {
                this.log.debug('NAI chat passports are not available', error);
            }
        }
        return out;
    }

    /** `extension_settings.nai_studio.scene.personaPassports[<persona avatar>]` (NAI falls back to 'default'). */
    private personaPassportsFromSettings(persona: string): PassportView[] {
        let settings: Dict | null;
        try {
            settings = adaptersOf(this.app).nai.settings();
        } catch {
            settings = null;
        }
        const scene = isDict(settings?.scene) ? (settings.scene as Dict) : null;
        const stored = isDict(scene?.personaPassports) ? (scene.personaPassports as Dict) : null;
        if (!stored) return [];
        const avatars = this.personaAvatars(persona).filter((avatar) => stored[avatar] !== undefined);
        const keys = avatars.length ? avatars : stored.default !== undefined ? ['default'] : [];
        return keys.flatMap((key) => passportList(stored[key]));
    }

    private places(): WorldRecord[] {
        const places = this.app.modules.api<PlacesApi>('places');
        if (!places) return [];
        try {
            return places.list().map((place) => ({
                kind: 'place' as const,
                id: `place:${place.id}`,
                name: place.name,
                aliases: nameList(place.aliases),
                forms: strings(place.forms),
                source: { kind: 'place' as const, ref: place.id, label: place.name },
                rank: RANK.place,
            }));
        } catch (error) {
            this.log.debug('places are not available', error);
            return [];
        }
    }

    /* ---------------------------------------------------------------- lorebooks (lazy) */

    async lore(isCurrent: () => boolean): Promise<LoreSources | null> {
        const adapters = adaptersOf(this.app);
        const result: LoreSources = {
            records: [],
            attach: [],
            books: new Set(),
            canonBook: '',
            canonItems: [],
            at: Date.now(),
        };
        let active: string[] = [];
        try {
            active = await adapters.bunnymo.activeBooks();
        } catch (error) {
            this.log.debug('active books are not available', error);
        }
        let repos: string[] = [];
        try {
            repos = adapters.ck.repoBooks();
        } catch (error) {
            this.log.debug('CarrotKernel repos are not available', error);
        }
        const roles = this.app.modules.api<BookRolesApi>('bookRoles');
        const canon = this.app.modules.api<CanonApi>('canon');
        result.canonBook = canon ? canon.bookName() : '';
        const activeSet = new Set(active);
        const repoSet = new Set(repos);
        for (const book of [...new Set([...active, ...repos])]) {
            if (!isCurrent()) return null;
            const role = roles?.roleOf(book)?.role;
            if (role && SKIPPED_ROLES.has(role)) continue;
            if (book === result.canonBook || (role === 'canon' && canon)) continue;
            result.books.add(book);
            await this.readBook(
                book,
                role,
                activeSet.has(book),
                repoSet.has(book) || role === 'ck.archive',
                roles,
                result,
            );
        }
        if (canon && result.canonBook) {
            try {
                result.canonItems = await canon.list();
            } catch (error) {
                this.log.debug('canon items are not available', error);
            }
            result.books.add(result.canonBook);
            for (const item of result.canonItems) this.canonItem(item, result);
        }
        return isCurrent() ? result : null;
    }

    private async readBook(
        book: string,
        role: string | undefined,
        active: boolean,
        archives: boolean,
        roles: BookRolesApi | undefined,
        result: LoreSources,
    ): Promise<void> {
        const load = this.app.host.ctx().loadWorldInfo;
        if (typeof load !== 'function') return;
        let data: unknown;
        try {
            data = await load(book);
        } catch (error) {
            this.log.debug(`lorebook ${book} did not load`, error);
            return;
        }
        if (!isDict(data) || !isDict(data.entries)) return;
        const entries = Object.values(data.entries).filter(isDict);
        // Base books keep entry types in the bookRoles sidecar; the first read primes its content hashes.
        const sidecar = roles && role !== 'maestro' && role !== 'canon';
        const first = entries.find((entry) => typeof entry.uid === 'number');
        if (sidecar && roles.loadEntryMeta && first) {
            try {
                await roles.loadEntryMeta(book, first.uid as number);
            } catch (error) {
                this.log.debug(`entry types of ${book} are not available`, error);
            }
        }
        for (const entry of entries) {
            const uid = typeof entry.uid === 'number' ? entry.uid : Number(entry.uid);
            if (entry.disable === true || !Number.isFinite(uid)) continue;
            const source: WorldSource = {
                kind: 'lore.entry',
                ref: `${book}#${uid}`,
                label: entryLabel(entry, uid),
                world: book,
                uid,
            };
            if (archives && isCharacterArchive(entry)) {
                const name = archiveTags(entry).name ?? entryName(entry);
                if (!name) continue;
                result.records.push({
                    kind: 'character',
                    name,
                    aliases: nameList(entryKeys(entry)),
                    source: { ...source, kind: 'ck.archive' },
                    rank: RANK.archive,
                    // Repos that are not active hold archives of other stories: only names known here join.
                    optional: !active,
                });
                continue;
            }
            if (!active) continue;
            let typed = readTypedMeta(isDict(entry.extensions) ? entry.extensions.maestro : undefined);
            if (!typed && sidecar) {
                try {
                    typed = readTypedMeta(roles.entryMeta(book, uid));
                } catch {
                    typed = null;
                }
            }
            this.entry(entry, typed, source, result);
        }
    }

    private entry(
        entry: Dict,
        typed: { type: string; fields: Record<string, string> } | null,
        source: WorldSource,
        result: LoreSources,
    ): void {
        if (typed && ENTRY_KINDS.has(typed.type)) {
            const name = entryName(entry, typed.fields.name);
            if (!name) return;
            result.records.push({
                kind: typed.type as WorldKind,
                name,
                aliases: nameList([...entryKeys(entry), ...splitAliases(typed.fields.aliases)]),
                source,
                rank: RANK.entry,
            });
            return;
        }
        const names = nameList([text(entry.comment), strings(entry.key)[0] ?? '']);
        if (names.length) result.attach.push({ names, source });
    }

    private canonItem(item: CanonItem, result: LoreSources): void {
        const entry = item.entry;
        const source: WorldSource = {
            kind: 'canon.entry',
            ref: `${result.canonBook}#${item.uid}`,
            label: entryLabel(entry, item.uid),
            world: result.canonBook,
            uid: item.uid,
        };
        const typed = readTypedMeta(isDict(entry.extensions) ? entry.extensions.maestro : undefined);
        const type = item.meta.type ?? typed?.type;
        this.entry(entry, type ? { type, fields: typed?.fields ?? {} } : null, source, result);
    }
}
