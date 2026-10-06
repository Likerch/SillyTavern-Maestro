// Where the sheet scenario gets its material (M31 п. 1-2): the BunnyMo command entry, the target's CK archive, the
// card / persona, DES tracker facts and a cleaned chat excerpt.
// The command entry is loaded from the active BunnyMo core book in `generation:before` (ST serves it from its WI
// cache): only when it is there does the WI filter of the sheet generation drop the rest of the lore — otherwise
// the generation falls back to ST's own prompt and must keep its lore. Archives are taken from the entries ST loads
// for this generation (seen through keepEntry) and, failing that, from the CK repo books.
// Other stories (plan-2 §9): an archive with the target's name may be a namesake's. With the world model only the
// target's own archives count (its entity's sources); without it, archives in the chat's own books, archives Maestro
// wrote for this chat, and any archive only for the card's own names. The card data comes from the chat's own cards.
import { adaptersOf } from '../../adapters';
import type { BunnyMoEntryLike } from '../../domain/bunnymo';
import {
    archiveMatch,
    cleanExcerptText,
    exactName,
    findByName,
    formatExcerpt,
    preferExact,
    sameCharacter,
    sheetCommandOfEntry,
    stripDecorators,
} from '../../domain/sheet-context';
import type { ExcerptLine, SheetCharacterData } from '../../domain/sheet-context';
import { detectSheetCommand } from '../../domain/sheets';
import type { SheetCommand } from '../../domain/sheets';
import { cardNameMatcher, cardTexts, chatOriginTag, entryOrigin, localBookNames } from '../../domain/world-scope';
import type { App, Logger } from '../../shared/contracts';
import type { WorldModelApi } from '../world/api';
import { sheetMark } from './marks';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How far back the DES tracker of the target is looked for. */
const TRACKER_LOOKBACK = 30;

/** Which archives may speak for a target in this chat. */
interface ArchiveReach {
    /** The world model knows the target: only its own archives (`book#uid`). */
    refs: Set<string> | null;
    /** The target is the card's own name: any archive of that name. */
    wide: boolean;
    /** The chat's own books. */
    local: Set<string>;
    /** Origin tag of entries Maestro wrote for this chat. */
    origin: string | null;
}

export class SheetSources {
    private command: SheetCommand | null = null;
    private target: string | null = null;
    /** Command entry content loaded from the BunnyMo core book for this generation. */
    private instructionLoaded: string | null = null;
    /** Command entry content seen in this generation's WI entries. */
    private instructionSeen: string | null = null;
    private readonly archivesSeen = new Map<string, { item: string; match: 'exact' | 'fuzzy' }>();
    private reachNow: ArchiveReach | null = null;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    /** Starts a sheet generation: what keepEntry keeps and records. */
    begin(command: SheetCommand, target: string): void {
        this.command = command;
        this.target = target;
        this.instructionLoaded = null;
        this.instructionSeen = null;
        this.archivesSeen.clear();
        this.reachNow = this.reach(target);
    }

    end(): void {
        this.command = null;
        this.target = null;
        this.instructionLoaded = null;
        this.instructionSeen = null;
        this.reachNow = null;
    }

    /** The chat's own cards: the current character, or every member of a group. */
    private chatCards(): STCharacter[] {
        const ctx = this.app.host.ctx();
        const characters = Array.isArray(ctx.characters) ? ctx.characters : [];
        if (ctx.groupId) {
            const group = (ctx.groups ?? []).find((item) => item.id === ctx.groupId);
            return (group?.members ?? [])
                .map((avatar) => characters.find((character) => character?.avatar === avatar))
                .filter((character): character is STCharacter => !!character);
        }
        const current = ctx.characterId === undefined ? undefined : characters[Number(ctx.characterId)];
        return current ? [current] : [];
    }

    /** Which archives may speak for the target (plan-2 §9). */
    private reach(target: string): ArchiveReach {
        const ctx = this.app.host.ctx();
        const cards = this.chatCards();
        const chatId = this.app.host.chatId();
        const books = localBookNames({ chatBook: ctx.chatMetadata?.world_info, cards });
        const reach: ArchiveReach = {
            refs: null,
            wide: false,
            local: new Set([...books.chat, ...books.card]),
            origin: chatId ? chatOriginTag(chatId) : null,
        };
        let entity: ReturnType<WorldModelApi['resolve']>;
        try {
            const world = this.app.modules.api<WorldModelApi>('world');
            entity = world?.resolve(target, 'character') ?? world?.resolve(target);
        } catch (error) {
            this.log.debug('world model is not available for the sheet', error);
        }
        if (entity) {
            reach.refs = new Set(
                entity.sources
                    .filter((source) => (source.kind === 'ck.archive' || source.kind === 'lore.entry') && source.world)
                    .map((source) => `${source.world}#${source.uid}`),
            );
            return reach;
        }
        const persona = typeof ctx.name1 === 'string' ? ctx.name1 : '';
        const ofCard = cardNameMatcher({
            names: [...cards.map((character) => character.name), persona].filter(Boolean),
            texts: cards.flatMap((character) => cardTexts(character)),
        });
        reach.wide = cards.some((character) => exactName(character.name, target)) || ofCard(target);
        return reach;
    }

    /** An archive entry may speak for the target in this chat. */
    private allowed(entry: Dict, reach: ArchiveReach): boolean {
        const book = typeof entry.world === 'string' ? entry.world : '';
        if (reach.refs) return reach.refs.has(`${book}#${String(entry.uid ?? '')}`);
        return reach.wide || reach.local.has(book) || (!!reach.origin && entryOrigin(entry) === reach.origin);
    }

    /** Loads the command entry before the WI scan; the lore filter is on only when it was found. */
    async preload(): Promise<void> {
        const command = this.command;
        if (!command) return;
        const content = await this.loadInstruction(command);
        if (this.command === command) this.instructionLoaded = content;
    }

    /**
     * WI filter for the sheet generation: only the BunnyMo command entries and the target's archives stay, so the
     * rest of the lore neither reaches the scan nor gets sticky/cooldown. Records what it sees for build().
     */
    keepEntry(entry: Dict): boolean {
        // Disabled entries are kept (ST drops them itself) but never used as material.
        const usable = entry.disable !== true && typeof entry.content === 'string';
        const command = sheetCommandOfEntry(entry as BunnyMoEntryLike);
        if (command) {
            if (command === this.command && usable) this.instructionSeen = entry.content as string;
            return true;
        }
        const match = this.target ? archiveMatch(entry as BunnyMoEntryLike, this.target) : null;
        if (match) {
            // A namesake's archive of another story stays out of the scan as well (plan-2 §9).
            if (this.reachNow && !this.allowed(entry, this.reachNow)) return false;
            if (usable) {
                const key = `${String(entry.world ?? '')}::${String(entry.uid ?? '')}`;
                this.archivesSeen.set(key, { item: entry.content as string, match });
            }
            return true;
        }
        return this.instructionLoaded === null;
    }

    /** The command entry text, decorators stripped and macros substituted; null without the BunnyMo core. */
    async instruction(command: SheetCommand): Promise<string | null> {
        const current = command === this.command;
        const content =
            (current ? (this.instructionLoaded ?? this.instructionSeen) : null) ??
            (await this.loadInstruction(command));
        if (content === null) return null;
        const text = this.substitute(stripDecorators(content)).trim();
        return text || null;
    }

    private async loadInstruction(command: SheetCommand): Promise<string | null> {
        const bunnymo = adaptersOf(this.app).bunnymo;
        let books = bunnymo.books().core;
        if (!books.length) {
            await bunnymo.refresh().catch((error: unknown) => this.log.debug('BunnyMo refresh failed', error));
            books = bunnymo.books().core;
        }
        const entry = await this.findEntry(books, (item) => sheetCommandOfEntry(item) === command);
        return typeof entry?.content === 'string' ? entry.content : null;
    }

    /** Contents of the target's archive entries (seen in this generation's WI, else from CK repos). */
    async archives(target: string): Promise<string[]> {
        if (target === this.target && this.archivesSeen.size) return preferExact([...this.archivesSeen.values()]);
        const adapters = adaptersOf(this.app);
        const reach = this.reach(target);
        const books = [...new Set([...adapters.ck.repoBooks(), ...adapters.bunnymo.books().archives, ...reach.local])];
        const found: { item: string; match: 'exact' | 'fuzzy' }[] = [];
        for (const book of books) {
            for (const entry of await this.entriesOf(book)) {
                const match = archiveMatch(entry, target);
                if (!match || typeof entry.content !== 'string' || !this.allowed(entry as Dict, reach)) continue;
                found.push({ item: entry.content, match });
            }
        }
        return preferExact(found);
    }

    /** Card, persona and DES data of the target. */
    characterData(target: string, beforeIndex: number, archives: string[]): SheetCharacterData {
        const ctx = this.app.host.ctx();
        const data: SheetCharacterData = { target, archives };
        const current = ctx.characterId === undefined ? undefined : ctx.characters[Number(ctx.characterId)];
        // Only the chat's own cards: another card with the same name belongs to another story (plan-2 §9).
        const card =
            current && exactName(current.name, target)
                ? current
                : (findByName(this.chatCards(), (character) => character?.name, target) ??
                  (current && sameCharacter(current.name, target) ? current : undefined));
        if (card) {
            data.card = {
                description: this.substitute(card.description ?? ''),
                personality: this.substitute(card.personality ?? ''),
            };
        }
        if (sameCharacter(ctx.name1, target)) {
            const persona = ctx.powerUserSettings?.persona_description;
            if (typeof persona === 'string') data.persona = this.substitute(persona);
        }
        data.tracker = this.tracker(target, beforeIndex);
        return data;
    }

    /** The cleaned excerpt of the last `limit` story messages before `beforeIndex`. */
    excerpt(beforeIndex: number, limit: number): string {
        const chat = this.app.host.ctx().chat;
        const lines: ExcerptLine[] = [];
        for (let i = Math.min(beforeIndex, chat.length) - 1; i >= 0 && lines.length < limit; i--) {
            const message = chat[i];
            if (!message || message.is_system || sheetMark(message)) continue;
            if (message.is_user && detectSheetCommand(message.mes)) continue;
            const text = cleanExcerptText(message);
            if (!text) continue;
            lines.push({ name: String(message.name ?? ''), text });
        }
        return formatExcerpt(lines.reverse());
    }

    private tracker(target: string, beforeIndex: number): SheetCharacterData['tracker'] {
        const des = adaptersOf(this.app).des;
        const chat = this.app.host.ctx().chat;
        const stop = Math.max(0, beforeIndex - TRACKER_LOOKBACK);
        for (let i = Math.min(beforeIndex, chat.length) - 1; i >= stop; i--) {
            if (chat[i]?.is_user) continue;
            let snapshot: ReturnType<typeof des.trackerFor> = null;
            try {
                snapshot = des.trackerFor(i);
            } catch (error) {
                this.log.debug('DES tracker unreadable', error);
            }
            const character = snapshot?.characters.find((item) => sameCharacter(item.name, target));
            if (character) {
                return {
                    details: { ...character.details },
                    relationship: character.relationship,
                    thoughts: character.thoughts,
                };
            }
        }
        return null;
    }

    private substitute(text: string): string {
        try {
            return this.app.host.ctx().substituteParams(text);
        } catch {
            return text;
        }
    }

    private async findEntry(
        books: readonly string[],
        predicate: (entry: BunnyMoEntryLike) => boolean,
    ): Promise<BunnyMoEntryLike | null> {
        for (const book of books) {
            const entry = (await this.entriesOf(book)).find(predicate);
            if (entry) return entry;
        }
        return null;
    }

    /** Enabled entries of a lorebook (ST serves loadWorldInfo from its cache after the first load). */
    private async entriesOf(book: string): Promise<BunnyMoEntryLike[]> {
        const load = this.app.host.ctx().loadWorldInfo;
        if (typeof load !== 'function') return [];
        try {
            const data = await load(book);
            if (!isDict(data) || !isDict(data.entries)) return [];
            return Object.values(data.entries)
                .filter((entry): entry is Dict => isDict(entry) && entry.disable !== true)
                .map((entry) => ({
                    key: entry.key,
                    keysecondary: entry.keysecondary,
                    comment: entry.comment,
                    content: entry.content,
                    world: book,
                    uid: entry.uid,
                    extensions: entry.extensions,
                }));
        } catch (error) {
            this.log.debug(`lorebook ${book} did not load`, error);
            return [];
        }
    }
}
