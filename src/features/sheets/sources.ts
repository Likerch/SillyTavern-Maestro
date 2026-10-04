// Where the sheet scenario gets its material (M31 п. 1-2): the BunnyMo command entry, the target's CK archive, the
// card / persona, DES tracker facts and a cleaned chat excerpt.
// The command entry is loaded from the active BunnyMo core book in `generation:before` (ST serves it from its WI
// cache): only when it is there does the WI filter of the sheet generation drop the rest of the lore — otherwise
// the generation falls back to ST's own prompt and must keep its lore. Archives are taken from the entries ST loads
// for this generation (seen through keepEntry) and, failing that, from the CK repo books.
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
import type { App, Logger } from '../../shared/contracts';
import { sheetMark } from './marks';

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** How far back the DES tracker of the target is looked for. */
const TRACKER_LOOKBACK = 30;

export class SheetSources {
    private command: SheetCommand | null = null;
    private target: string | null = null;
    /** Command entry content loaded from the BunnyMo core book for this generation. */
    private instructionLoaded: string | null = null;
    /** Command entry content seen in this generation's WI entries. */
    private instructionSeen: string | null = null;
    private readonly archivesSeen = new Map<string, { item: string; match: 'exact' | 'fuzzy' }>();

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
    }

    end(): void {
        this.command = null;
        this.target = null;
        this.instructionLoaded = null;
        this.instructionSeen = null;
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
        const books = [...new Set([...adapters.ck.repoBooks(), ...adapters.bunnymo.books().archives])];
        const found: { item: string; match: 'exact' | 'fuzzy' }[] = [];
        for (const book of books) {
            for (const entry of await this.entriesOf(book)) {
                const match = archiveMatch(entry, target);
                if (match && typeof entry.content === 'string') found.push({ item: entry.content, match });
            }
        }
        return preferExact(found);
    }

    /** Card, persona and DES data of the target. */
    characterData(target: string, beforeIndex: number, archives: string[]): SheetCharacterData {
        const ctx = this.app.host.ctx();
        const data: SheetCharacterData = { target, archives };
        const current = ctx.characterId === undefined ? undefined : ctx.characters[Number(ctx.characterId)];
        const card =
            current && exactName(current.name, target)
                ? current
                : (findByName(ctx.characters, (character) => character?.name, target) ??
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
                }));
        } catch (error) {
            this.log.debug(`lorebook ${book} did not load`, error);
            return [];
        }
    }
}
