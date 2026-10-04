// BunnyMo V3.0: not an extension but a set of lorebooks, recognised by content (src/domain/bunnymo.ts,
// research/bunnymo-carrotkernel.md §1). To stay cheap, only books active right now are classified — the global
// selection, the chat book, the persona book and the books of the current character(s) — and each book's result
// is cached until ST reports the book saved (WORLDINFO_UPDATED). "Present" means BunnyMo is in use: its core or a
// pack is among the active books. Pack files are never edited (P13).
//
// Capabilities (all refreshed from the active books when Capabilities refreshes):
// - `bunnymo.core`     the BunnyMo core lorebook is active;
// - `bunnymo.packs`    at least one BunnyMo pack is active;
// - `bunnymo.archives` an active book holds character archives (`<BunnymoTags>` blocks with a real name or tags).
import { archiveWorlds, classifyWorlds } from '../../domain/bunnymo';
import type { BunnyMoEntryLike } from '../../domain/bunnymo';
import type { Unsubscribe } from '../../shared/contracts';
import { NeighbourBase, extras, isDict, stringList } from '../base';
import type { AdapterDeps } from '../base';

export interface BunnyMoBooks {
    /** Active books holding the BunnyMo core. */
    core: string[];
    /** Active BunnyMo packs. */
    packs: string[];
    /** Active books with character archives (CK repos and any other book). */
    archives: string[];
}

interface BookFacts {
    core: boolean;
    pack: boolean;
    archives: boolean;
}

/** ST's `getCharaFilename`: the avatar file name without its extension (key of `world_info.charLore`). */
function avatarKey(avatar: string): string {
    return avatar.replace(/\.[^/.]+$/, '');
}

export class BunnyMoAdapter extends NeighbourBase<'bunnymo'> {
    readonly id = 'bunnymo' as const;
    private state: BunnyMoBooks = { core: [], packs: [], archives: [] };
    private readonly facts = new Map<string, BookFacts>();
    private refreshing: Promise<void> | null = null;
    private readonly listeners: Unsubscribe[] = [];

    constructor(deps: AdapterDeps) {
        super(deps);
        const refresh = (): Promise<void> => this.refresh();
        this.capability('bunnymo.core', () => this.state.core.length > 0, undefined, refresh);
        this.capability('bunnymo.packs', () => this.state.packs.length > 0, undefined, refresh);
        this.capability('bunnymo.archives', () => this.state.archives.length > 0, undefined, refresh);
    }

    /** BunnyMo is in use: its core or a pack is active (as of the last refresh). */
    present(): boolean {
        return this.state.core.length > 0 || this.state.packs.length > 0;
    }

    /** BunnyMo has no manifest; the core version is not recorded in its files. */
    override version(): string | undefined {
        return undefined;
    }

    /** Last classification of the active books (a copy). */
    books(): BunnyMoBooks {
        return { core: [...this.state.core], packs: [...this.state.packs], archives: [...this.state.archives] };
    }

    /** Re-reads which books are active and classifies the ones not cached yet. Concurrent calls share one run. */
    refresh(): Promise<void> {
        this.refreshing ??= this.classifyActive().finally(() => {
            this.refreshing = null;
        });
        return this.refreshing;
    }

    /** Stops listening to ST (the host also drops its listeners on dispose). */
    dispose(): void {
        for (const unsubscribe of this.listeners.splice(0)) unsubscribe();
    }

    protected async connect(): Promise<boolean> {
        if (!this.listeners.length) this.listen();
        await this.refresh();
        return true;
    }

    /**
     * Names of the books ST scans now: global selection, chat book, persona book, the primary and extra books of
     * the current character (every member in a group chat). Unknown names (deleted books) are skipped.
     */
    async activeBooks(): Promise<string[]> {
        const ctx = this.host.ctx();
        const names = new Set<string>();
        let charLore: unknown[] = [];
        try {
            const worldInfo = await this.host.modules.worldInfo();
            for (const name of stringList(worldInfo.selected_world_info)) names.add(name);
            const settings = worldInfo.world_info;
            if (isDict(settings) && Array.isArray(settings.charLore)) charLore = settings.charLore;
        } catch (error) {
            this.log.debug('world-info.js is not available; global books are skipped', error);
        }
        const chatBook = ctx.chatMetadata.world_info;
        if (typeof chatBook === 'string' && chatBook) names.add(chatBook);
        const personaBook = ctx.powerUserSettings.persona_description_lorebook;
        if (typeof personaBook === 'string' && personaBook) names.add(personaBook);

        const members = ctx.groupId
            ? (ctx.groups.find((group) => group.id === ctx.groupId)?.members ?? []).map((avatar) =>
                  ctx.characters.find((character) => character.avatar === avatar),
              )
            : [ctx.characterId === undefined ? undefined : ctx.characters[Number(ctx.characterId)]];
        for (const character of members) {
            if (!character) continue;
            const primary = character.data?.extensions?.world;
            if (typeof primary === 'string' && primary) names.add(primary);
            const key = avatarKey(character.avatar ?? '');
            for (const lore of charLore) {
                if (isDict(lore) && lore.name === key) for (const book of stringList(lore.extraBooks)) names.add(book);
            }
        }

        const known = extras(this.host).getWorldInfoNames?.() ?? [];
        return known.length ? [...names].filter((name) => known.includes(name)) : [...names];
    }

    private listen(): void {
        const on = (key: string, handler: (...args: unknown[]) => unknown): void => {
            const name = this.host.events.name(key);
            if (name) this.listeners.push(this.host.events.on(name, handler));
        };
        // A saved book may have changed its kind; the next refresh reloads it.
        on('WORLDINFO_UPDATED', (name) => {
            if (typeof name === 'string') this.facts.delete(name);
        });
        // Which books are active changes with the chat and the global selection.
        const refresh = (): void => void this.refresh();
        on('CHAT_CHANGED', refresh);
        on('WORLDINFO_SETTINGS_UPDATED', refresh);
    }

    private async classifyActive(): Promise<void> {
        const books = await this.activeBooks();
        const next: BunnyMoBooks = { core: [], packs: [], archives: [] };
        for (const book of books) {
            const facts = this.facts.get(book) ?? (await this.classifyBook(book));
            if (!facts) continue;
            if (facts.core) next.core.push(book);
            else if (facts.pack) next.packs.push(book);
            if (facts.archives) next.archives.push(book);
        }
        this.state = next;
    }

    private async classifyBook(book: string): Promise<BookFacts | null> {
        const load = extras(this.host).loadWorldInfo;
        if (typeof load !== 'function') return null;
        let data: unknown;
        try {
            data = await load(book);
        } catch (error) {
            this.log.debug(`lorebook ${book} did not load`, error);
            return null;
        }
        if (!isDict(data) || !isDict(data.entries)) return null;
        const entries: BunnyMoEntryLike[] = [];
        const enabled: BunnyMoEntryLike[] = [];
        for (const raw of Object.values(data.entries)) {
            if (!isDict(raw)) continue;
            // Light copies: only the fields the heuristics read (the book object itself is ST's clone).
            const entry: BunnyMoEntryLike = {
                key: raw.key,
                keysecondary: raw.keysecondary,
                comment: raw.comment,
                content: raw.content,
                world: book,
            };
            entries.push(entry);
            if (raw.disable !== true) enabled.push(entry);
        }
        const { core, packs } = classifyWorlds(entries);
        const facts: BookFacts = {
            core: core.has(book),
            pack: packs.has(book),
            archives: archiveWorlds(enabled).has(book),
        };
        this.facts.set(book, facts);
        return facts;
    }
}
