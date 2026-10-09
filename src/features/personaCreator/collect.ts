// What M41 reads for the request (read only): the card the character editor shows (or the character of the chat, for
// the slash command), loaded fully (ST keeps characters shallow), its fields and the starting scene the chat opened
// with, the player's present persona and the personas already linked to the card, and the card's lore — its books
// (primary and extra when it is the chat's character, plus the chat book; else its linked book), or the embedded book
// when no world book is linked. Maestro's own books, the canon, backups, BunnyMo packs and CarrotKernel archives are
// never read; the lore is cut to a budget with entries about the world and the player's role first.
import { cardView, greetingInChat } from '../../domain/assistant-chat';
import type { CardView } from '../../domain/assistant-chat';
import { isBunnyMoBook } from '../../domain/doctor-fixes';
import type { BookData } from '../../domain/doctor-fixes';
import { pickLore, storyLanguage, userMentions } from '../../domain/persona-create';
import type { LoreDigest, PersonaLoreEntry, PersonaRequest, StoryLanguage } from '../../domain/persona-create';
import { isBackupBookName, isCanonBookName, isMaestroBookName } from '../../domain/roles-detect';
import type { App, Logger } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { LoreStore } from '../loreStudio/store-api';
import type { PersonaHost } from './st-personas';

type Dict = Record<string, unknown>;

/** Book roles never read (Maestro's own books, BunnyMo, CarrotKernel archives of other characters). */
const SKIPPED_ROLES: ReadonlySet<string> = new Set([
    'bunnymo.core',
    'bunnymo.pack',
    'canon',
    'maestro',
    'backup',
    'ck.archive',
]);
const READ_TIMEOUT_MS = 4000;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
    return Array.isArray(value)
        ? value.filter((item): item is string => typeof item === 'string' && !!item.trim())
        : [];
}

function safely<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch {
        return fallback;
    }
}

function apiOf<T>(app: App, key: string): T | undefined {
    try {
        return app.modules.api<T>(key) ?? undefined;
    } catch {
        return undefined;
    }
}

async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        return await Promise.race([
            promise.catch(() => fallback),
            new Promise<T>((resolve) => {
                timer = setTimeout(() => resolve(fallback), ms);
            }),
        ]);
    } finally {
        if (timer !== undefined) clearTimeout(timer);
    }
}

/* ------------------------------------------------------------------ which card */

export interface CardRef {
    /** Index in ST's characters array. */
    index: number;
    /** The card's avatar file (its key). */
    avatar: string;
    name: string;
}

function cardAt(app: App, index: number): CardRef | null {
    if (!Number.isInteger(index) || index < 0) return null;
    const character = safely(() => app.host.ctx().characters?.[index] as unknown, undefined);
    if (!isDict(character)) return null;
    const avatar = str(character.avatar);
    if (!avatar) return null;
    return { index, avatar, name: str(character.name).trim() || '?' };
}

function indexOf(raw: unknown): number {
    if (typeof raw === 'number') return raw;
    if (typeof raw === 'string' && raw.trim()) return Number(raw);
    return NaN;
}

/** No group is selected (a group chat, the group editor, or a member's card peeked from a group). */
function noGroup(app: App): boolean {
    return safely(() => !app.host.ctx().groupId && !app.host.isGroupChat(), false);
}

/**
 * The card ST's character editor shows: the form in edit mode (`#form_create[actiontype=editcharacter]`) for one
 * character, found by the avatar file the form holds (`#avatar_url_pole`), else by the id of CHARACTER_EDITOR_OPENED,
 * else the current character. Null for the create form, a group, or when nothing matches.
 */
export function editedCard(app: App, hint?: number | null): CardRef | null {
    if (!noGroup(app)) return null;
    const doc = typeof document === 'undefined' ? null : document;
    const form = doc?.getElementById('form_create');
    if (form && form.getAttribute('actiontype') !== 'editcharacter') return null;
    const field = doc?.getElementById('avatar_url_pole');
    const avatar = field instanceof HTMLInputElement ? field.value.trim() : '';
    const characters = safely(() => app.host.ctx().characters ?? [], [] as STCharacter[]);
    if (avatar) {
        const index = characters.findIndex((character) => isDict(character) && character.avatar === avatar);
        if (index >= 0) return cardAt(app, index);
    }
    if (typeof hint === 'number' && Number.isInteger(hint)) {
        const card = cardAt(app, hint);
        if (card) return card;
    }
    return cardAt(app, indexOf(safely(() => app.host.ctx().characterId, undefined)));
}

/** The character of the current one-on-one chat; null in a group or without a character. */
export function chatCard(app: App): CardRef | null {
    if (!noGroup(app)) return null;
    return cardAt(app, indexOf(safely(() => app.host.ctx().characterId, undefined)));
}

/** The card is the character of the current one-on-one chat (its chat, greeting and chat book belong to it). */
export function isChatCard(app: App, card: CardRef): boolean {
    const current = chatCard(app);
    return !!current && current.avatar === card.avatar && !!safely(() => app.host.chatId(), null);
}

/** The full card: a shallow character is loaded from the server first. */
export async function loadCharacter(app: App, card: CardRef): Promise<Dict | null> {
    const ctx = app.host.ctx();
    let character = ctx.characters?.[card.index] as unknown;
    if (isDict(character) && character.shallow === true && typeof ctx.unshallowCharacter === 'function') {
        await withTimeout(
            Promise.resolve().then(() => ctx.unshallowCharacter(card.index)),
            READ_TIMEOUT_MS,
            undefined,
        );
        character = app.host.ctx().characters?.[card.index] as unknown;
    }
    return isDict(character) && character.avatar === card.avatar ? character : null;
}

/* ------------------------------------------------------------------ the lore */

/** A book's data (Lore Studio's store, else ST's loadWorldInfo); null when missing. */
async function readBook(app: App, name: string): Promise<Dict | null> {
    const store = apiOf<LoreStore>(app, 'loreStore');
    let data: unknown;
    try {
        const ctx = app.host.ctx();
        const names = ctx.getWorldInfoNames?.();
        if (Array.isArray(names) && !names.includes(name)) return null;
        data = store ? await store.load(name) : await ctx.loadWorldInfo?.(name);
    } catch {
        return null;
    }
    return isDict(data) && isDict(data.entries) ? data : null;
}

/** Entries of a world book with their texts and the constant flag. */
export function worldBookEntries(book: string, data: unknown): PersonaLoreEntry[] {
    if (!isDict(data) || !isDict(data.entries)) return [];
    const list = Object.entries(data.entries)
        .filter((pair): pair is [string, Dict] => isDict(pair[1]))
        .map(([key, raw]) => ({ uid: typeof raw.uid === 'number' ? raw.uid : Number(key), raw }))
        .sort((a, b) => (Number.isFinite(a.uid) ? a.uid : 0) - (Number.isFinite(b.uid) ? b.uid : 0));
    return list.map(({ raw }) => ({
        book,
        title: str(raw.comment).trim(),
        keys: strings(raw.key),
        content: str(raw.content),
        constant: raw.constant === true,
        disabled: raw.disable === true,
    }));
}

/** Entries of the card's embedded book (character_book). */
export function embeddedBookEntries(book: string, character: Dict): PersonaLoreEntry[] {
    const data = isDict(character.data) ? character.data : {};
    const raw = isDict(data.character_book) ? data.character_book : null;
    if (!raw) return [];
    const list = Array.isArray(raw.entries) ? raw.entries : isDict(raw.entries) ? Object.values(raw.entries) : [];
    return list.filter(isDict).map((entry) => ({
        book,
        title: str(entry.comment).trim() || str(entry.name).trim(),
        keys: strings(entry.keys ?? entry.key),
        content: str(entry.content),
        constant: entry.constant === true,
        disabled: entry.enabled === false || entry.disable === true,
    }));
}

/** Maestro's own books and backups by name (when no role is known). */
export function skippedBookName(name: string): boolean {
    return isMaestroBookName(name) || isCanonBookName(name) || isBackupBookName(name);
}

/* ------------------------------------------------------------------ the request */

export interface Collected {
    card: CardRef;
    view: CardView;
    /** Everything but the comment, the earlier attempts and a retry note. */
    request: Omit<PersonaRequest, 'comment' | 'avoid' | 'fix'>;
    lore: LoreDigest;
    /** Books whose entries were read. */
    books: string[];
    language: StoryLanguage;
}

export class PersonaCollector {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly personas: PersonaHost,
    ) {}

    /**
     * Maestro's «Язык истории» when it is set to a language. On «авто» the card decides here, not the open chat: the
     * button works from the character editor, often for a card whose chat is not the one open.
     */
    private languageSetting(): unknown {
        return safely(() => this.app.settings.core().storyLanguage, undefined);
    }

    async collect(card: CardRef, loreChars: number): Promise<Collected | null> {
        const character = await loadCharacter(this.app, card);
        const view = cardView(character);
        if (!character || !view) return null;
        const ctx = this.app.host.ctx();
        const own = isChatCard(this.app, card);
        const metadata = own && isDict(ctx.chatMetadata) ? ctx.chatMetadata : {};
        const scenario = str(metadata.scenario).trim() || view.scenario;
        const chat = own && Array.isArray(ctx.chat) ? (ctx.chat as unknown[]) : [];
        const shown = own ? (greetingInChat(chat, view) ?? 0) : 0;
        const greetingText = shown > 0 ? (view.alternateGreetings[shown - 1] ?? '') : '';
        const userLines = userMentions([
            view.description,
            view.personality,
            scenario,
            greetingText || view.firstMessage,
            ...(greetingText ? [view.firstMessage] : []),
            ...view.alternateGreetings,
            view.creatorNotes,
        ]);
        const existingPersonas = safely(() => this.personas.connectedTo(card.avatar), [] as string[])
            .map((key) => safely(() => this.personas.nameOf(key), ''))
            .filter(Boolean);
        const { entries, books } = await this.lore(view, character, own, metadata);
        const lore = pickLore(entries, { budgetChars: loreChars, cardName: view.name });
        const language = storyLanguage({
            setting: this.languageSetting(),
            cardText: `${view.description}\n${view.firstMessage}`,
            uiLocale: safely(() => this.app.i18n.locale(), 'en'),
        });
        return {
            card,
            view,
            request: {
                card: {
                    name: view.name,
                    description: view.description,
                    personality: view.personality,
                    scenario,
                    firstMessage: view.firstMessage,
                    greeting: greetingText ? { index: shown, text: greetingText } : null,
                    creatorNotes: view.creatorNotes,
                },
                userLines,
                currentPersona: safely(() => this.personas.currentPersona(), null),
                existingPersonas,
                lore: lore.entries,
                language,
            },
            lore,
            books,
            language,
        };
    }

    /** The card's books in reading order, each once (the chat book only for the chat's own character). */
    private async bookNames(view: CardView, own: boolean, metadata: Dict): Promise<string[]> {
        const out: string[] = [];
        const add = (name: unknown) => {
            const value = str(name).trim();
            if (value && !out.includes(value)) out.push(value);
        };
        const store = own ? apiOf<LoreStore>(this.app, 'loreStore') : undefined;
        const bindings = store ? await withTimeout(store.bindings(), READ_TIMEOUT_MS, null) : null;
        if (bindings) {
            add(bindings.character.primary);
            for (const name of bindings.character.extra) add(name);
            add(bindings.chat);
        } else {
            add(view.world);
            if (own) add(metadata.world_info);
        }
        return out;
    }

    private async lore(
        view: CardView,
        character: Dict,
        own: boolean,
        metadata: Dict,
    ): Promise<{ entries: PersonaLoreEntry[]; books: string[] }> {
        const roles = apiOf<BookRolesApi>(this.app, 'bookRoles');
        const entries: PersonaLoreEntry[] = [];
        const books: string[] = [];
        const names = await this.bookNames(view, own, metadata);
        for (const name of names) {
            const role = safely(() => roles?.roleOf(name)?.role, undefined);
            if ((role && SKIPPED_ROLES.has(role)) || skippedBookName(name)) continue;
            const data = await readBook(this.app, name);
            if (!data) {
                this.log.debug(`persona: lorebook ${name} did not load`);
                continue;
            }
            // A BunnyMo pack is a tag vocabulary, never a story source (P13), even when no role says so.
            if (!role && safely(() => isBunnyMoBook(name, data as BookData), false)) continue;
            const read = worldBookEntries(name, data);
            if (!read.length) continue;
            entries.push(...read);
            books.push(name);
        }
        // The embedded book of a card nobody imported into a world book.
        if (!view.world) {
            const name = view.book?.name || view.name;
            const read = embeddedBookEntries(name, character);
            if (read.length) {
                entries.push(...read);
                books.push(name);
            }
        }
        return { entries, books };
    }
}
