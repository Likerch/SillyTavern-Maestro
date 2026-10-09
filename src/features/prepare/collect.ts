// «Подготовить к игре» (M37, plan-2 §7 п. 1): reading what the analysis needs from the host and the modules — the card
// (loaded fully: ST keeps characters shallow) with every starting scene (the alternate greetings are the swipes of
// message 0; which one it shows now), the persona, the card's books
// (primary and extra, or the embedded book), the chat book, the persona book, the active DES Lore Library campaign,
// the CarrotKernel archives of the characters this card names, the BunnyMo tag vocabulary (a hint only; packs are
// never read as sources and never written), and what the chat already has (canon, places, mechanics, NAI passports,
// promises, secrets). Read only: nothing here writes.
import { adaptersOf } from '../../adapters';
import { storyLanguage } from '../../core/language';
import { cardView, greetingInChat } from '../../domain/assistant-chat';
import type { CardView } from '../../domain/assistant-chat';
import { isBunnyMoBook } from '../../domain/doctor-fixes';
import type { BookData } from '../../domain/doctor-fixes';
import { normName } from '../../domain/dossier-names';
import { libraryView } from '../../domain/lore-studio-campaigns';
import { isBackupBookName, isCanonBookName, isMaestroBookName } from '../../domain/roles-detect';
import type { ExistingEntry, ExistingSnapshot } from '../../domain/prepare-merge';
import { bookSources, cardSources, clipText, greetingOpening } from '../../domain/prepare-sources';
import type { BookEntryInput, PrepareSource, SourceOrigin } from '../../domain/prepare-sources';
import type { StoryLanguage } from '../../domain/story-language';
import type { App, Logger } from '../../shared/contracts';
import type { BookRolesApi } from '../bookRoles/api';
import type { BunnyMoModeApi } from '../bunnymoMode/api';
import type { CalendarApi } from '../calendar/api';
import type { CanonApi } from '../canon/api';
import type { KnowledgeApi } from '../knowledge/api';
import type { LoreStore } from '../loreStudio/store-api';
import type { MechanicsApi } from '../mechanics/api';
import type { PlacesApi } from '../places/api';
import type { PrepareSettings } from './settings';

type Dict = Record<string, unknown>;

/** Book roles never read as story sources (P13: BunnyMo packs are a vocabulary only; Maestro's own books). */
const SKIPPED_ROLES: ReadonlySet<string> = new Set(['bunnymo.core', 'bunnymo.pack', 'canon', 'maestro', 'backup']);

/** Maestro's own books and backups by name (when no role is known). */
function skippedByName(name: string): boolean {
    return isMaestroBookName(name) || isCanonBookName(name) || isBackupBookName(name);
}
const CONTEXT_CHARS = 1500;
const VOCABULARY_CHARS = 1200;
const READ_TIMEOUT_MS = 4000;

export function isDict(value: unknown): value is Dict {
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

/** Another module's API, undefined when it is off or its getter throws. */
export function apiOf<T>(app: App, key: string): T | undefined {
    try {
        return app.modules.api<T>(key) ?? undefined;
    } catch {
        return undefined;
    }
}

/** A promise with a deadline: the fallback when it is late or fails. */
export async function withTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
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

export function safely<T>(read: () => T, fallback: T): T {
    try {
        return read();
    } catch {
        return fallback;
    }
}

/* ------------------------------------------------------------------ the chat and the card */

export interface CardRef {
    /** Index in ST's characters array. */
    index: number;
    avatar: string;
    name: string;
}

/** The character of a one-on-one chat; null in a group chat or without a character. */
export function currentCard(app: App): CardRef | null {
    return safely(() => {
        const ctx = app.host.ctx();
        if (ctx.groupId || app.host.isGroupChat()) return null;
        const raw = ctx.characterId;
        const index = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
        if (!Number.isInteger(index) || index < 0) return null;
        const character = ctx.characters?.[index] as unknown;
        if (!isDict(character)) return null;
        return { index, avatar: str(character.avatar), name: str(character.name).trim() || '?' };
    }, null);
}

/** A user message in the chat (the greeting and its swipes are the character's). */
export function hasUserMessages(chat: readonly unknown[]): boolean {
    return chat.some((message) => isDict(message) && message.is_user === true);
}

/**
 * The greeting message 0 shows now (0 the first message, n alternate greeting n; the alternate greetings are the swipes
 * of message 0), from the card as ST holds it — no load. Null when unknown (no card, a shallow card, a text that is no
 * greeting of the card).
 */
export function shownGreetingNow(app: App): number | null {
    return safely(() => {
        const card = currentCard(app);
        if (!card) return null;
        const ctx = app.host.ctx();
        const view = cardView(ctx.characters?.[card.index] as unknown);
        if (!view) return null;
        return greetingInChat(Array.isArray(ctx.chat) ? ctx.chat : [], view) ?? null;
    }, null);
}

/** The greeting message 0 shows now, the card loaded fully first when ST keeps it shallow. */
export async function shownGreeting(app: App): Promise<number | null> {
    const card = currentCard(app);
    if (!card) return null;
    try {
        const view = cardView(await loadCharacter(app, card));
        if (!view) return null;
        const chat = safely(() => app.host.ctx().chat ?? [], [] as STChatMessage[]);
        return greetingInChat(Array.isArray(chat) ? chat : [], view) ?? null;
    } catch {
        return null;
    }
}

/** Runs a call that journals itself and returns the ids of the records it added (the module's own undo). */
export async function linkedRecords(app: App, module: string, run: () => Promise<unknown>): Promise<string[]> {
    const before = new Set(safely(() => app.journal.list({ module, limit: 20 }), []).map((record) => record.id));
    const result = await run();
    if (result === null || result === undefined || result === '') return [];
    return safely(() => app.journal.list({ module, limit: 20 }), [])
        .filter((record) => !before.has(record.id) && !record.undone)
        .map((record) => record.id);
}

/** The full card: a shallow character is loaded from the server first (read-only). */
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
    return isDict(character) ? character : null;
}

/** Entries of the card's embedded book with their texts (cardView keeps titles and keys only). */
export function embeddedEntries(character: Dict): BookEntryInput[] {
    const data = isDict(character.data) ? character.data : {};
    const book = isDict(data.character_book) ? data.character_book : null;
    if (!book) return [];
    const list = Array.isArray(book.entries) ? book.entries : isDict(book.entries) ? Object.values(book.entries) : [];
    const out: BookEntryInput[] = [];
    list.forEach((raw, index) => {
        if (!isDict(raw)) return;
        const keys = strings(raw.keys ?? raw.key);
        out.push({
            uid: typeof raw.id === 'number' ? raw.id : index,
            title: str(raw.comment).trim() || str(raw.name).trim(),
            keys,
            content: str(raw.content),
            disabled: raw.enabled === false || raw.disable === true,
        });
    });
    return out;
}

/** Entries of a lorebook as inputs (enabled flag, keys, title). */
export function bookEntries(data: unknown): BookEntryInput[] {
    if (!isDict(data) || !isDict(data.entries)) return [];
    const out: BookEntryInput[] = [];
    for (const [key, raw] of Object.entries(data.entries)) {
        if (!isDict(raw)) continue;
        const uid = typeof raw.uid === 'number' ? raw.uid : Number(key);
        out.push({
            uid: Number.isFinite(uid) ? uid : out.length,
            title: str(raw.comment).trim(),
            keys: strings(raw.key),
            content: str(raw.content),
            disabled: raw.disable === true,
        });
    }
    return out.sort((a, b) => a.uid - b.uid);
}

/** A book's data (Lore Studio's store, else ST's loadWorldInfo); null when missing. */
export async function readBook(app: App, name: string): Promise<Dict | null> {
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

/* ------------------------------------------------------------------ what is collected */

export interface CollectedBook {
    name: string;
    origin: SourceOrigin;
    /** Entries read as sources. */
    entries: number;
}

export interface Collected {
    card: CardRef;
    view: CardView;
    personaName: string;
    greeting: number;
    /** The first words of every greeting of the card (index = greeting number). */
    openings: string[];
    sources: PrepareSource[];
    books: CollectedBook[];
    /** A short summary of the card for parts without the card itself. */
    context: string;
    vocabulary: string;
    snapshot: ExistingSnapshot;
    templates: { id: string; title: string }[];
    mechanics: { id: string; name: string; attributes: string[] }[];
    /** «Язык истории» the plan is read for (core/language). */
    language: StoryLanguage;
}

export class Collector {
    constructor(
        private readonly app: App,
        private readonly log: Logger,
        private readonly settings: () => PrepareSettings,
    ) {}

    private ctx(): Dict {
        return safely(() => this.app.host.ctx() as unknown as Dict, {} as Dict);
    }

    personaName(): string {
        return str(this.ctx().name1).trim();
    }

    /** Everything the analysis reads, for the current one-on-one chat; null without a card. */
    async collect(): Promise<Collected | null> {
        const card = currentCard(this.app);
        if (!card) return null;
        const character = await loadCharacter(this.app, card);
        const view = cardView(character);
        if (!character || !view) return null;
        const ctx = this.ctx();
        const chat = Array.isArray(ctx.chat) ? (ctx.chat as unknown[]) : [];
        const metadata = isDict(ctx.chatMetadata) ? ctx.chatMetadata : {};
        const power = isDict(ctx.powerUserSettings) ? ctx.powerUserSettings : {};
        const greeting = greetingInChat(chat, view) ?? 0;
        const personaName = this.personaName();
        const sources = cardSources(
            {
                name: view.name,
                description: view.description,
                personality: view.personality,
                scenario: str(metadata.scenario).trim() || view.scenario,
                firstMessage: view.firstMessage,
                alternateGreetings: view.alternateGreetings,
                examples: view.examples,
                creatorNotes: view.creatorNotes,
                systemPrompt: view.systemPrompt,
                postHistory: view.postHistory,
                depthPrompt: view.depthPrompt?.text ?? '',
                greeting,
            },
            { name: personaName, description: str(power.persona_description) },
        );
        const books: CollectedBook[] = [];
        const coreText = normName(sources.map((item) => item.text).join('\n'));
        await this.collectBooks(view, character, metadata, coreText, sources, books);
        const [snapshot, vocabulary] = await Promise.all([this.snapshot(personaName), this.vocabulary()]);
        const names = { user: personaName, char: view.name };
        return {
            card,
            view,
            personaName,
            greeting,
            openings: [view.firstMessage, ...view.alternateGreetings].map((text) => greetingOpening(text, names)),
            sources,
            books,
            context: clipText(`${view.name}: ${view.description}\n${view.scenario}`, CONTEXT_CHARS),
            vocabulary,
            snapshot,
            templates: this.templates(),
            mechanics: this.mechanics(),
            language: storyLanguage(this.app),
        };
    }

    private roles(): BookRolesApi | undefined {
        return apiOf<BookRolesApi>(this.app, 'bookRoles');
    }

    /** The books of this story in reading order (card, chat, persona, campaign), each once. */
    private async storyBooks(view: CardView, metadata: Dict): Promise<{ name: string; origin: SourceOrigin }[]> {
        const out: { name: string; origin: SourceOrigin }[] = [];
        const add = (name: unknown, origin: SourceOrigin) => {
            const value = str(name).trim();
            if (value && !out.some((item) => item.name === value)) out.push({ name: value, origin });
        };
        const store = apiOf<LoreStore>(this.app, 'loreStore');
        const bindings = store ? await withTimeout(store.bindings(), READ_TIMEOUT_MS, null) : null;
        if (bindings) {
            add(bindings.character.primary, 'book');
            for (const name of bindings.character.extra) add(name, 'book');
            add(bindings.chat, 'chat');
            add(bindings.persona, 'book');
        } else {
            add(view.world, 'book');
            add(metadata.world_info, 'chat');
        }
        // The active campaign of DES's Lore Library: the books of this story the user filed together.
        const campaign = safely(() => {
            const des = adaptersOf(this.app).des;
            if (!des.present()) return [] as string[];
            const settings = des.settings();
            const names = this.app.host.ctx().getWorldInfoNames?.() ?? [];
            const library = libraryView(isDict(settings) ? settings.lorebook : null, names, []);
            return library.campaigns.find((item) => item.id === library.activeId)?.books ?? [];
        }, [] as string[]);
        for (const name of campaign) add(name, 'campaign');
        return out;
    }

    private async collectBooks(
        view: CardView,
        character: Dict,
        metadata: Dict,
        coreText: string,
        sources: PrepareSource[],
        books: CollectedBook[],
    ): Promise<void> {
        const { entryChars } = this.settings();
        const roles = this.roles();
        const storyBooks = await this.storyBooks(view, metadata);
        const hasPrimary = storyBooks.some((item) => item.origin === 'book');
        for (const { name, origin } of storyBooks) {
            const role = safely(() => roles?.roleOf(name)?.role, undefined);
            if ((role && SKIPPED_ROLES.has(role)) || skippedByName(name)) continue;
            const data = await readBook(this.app, name);
            if (!data) {
                this.log.debug(`prepare: lorebook ${name} did not load`);
                continue;
            }
            // P13: a BunnyMo pack is a vocabulary, never a source, even when no role says so.
            if (!role && isBunnyMoBook(name, data as BookData)) continue;
            const entries = bookEntries(data);
            const picked = role === 'ck.archive' ? entries.filter((entry) => namedIn(entry, coreText)) : entries;
            const read = bookSources(name, picked, role === 'ck.archive' ? 'archive' : origin, entryChars);
            if (!read.length) continue;
            sources.push(...read);
            books.push({ name, origin: role === 'ck.archive' ? 'archive' : origin, entries: read.length });
        }
        // The embedded book of a card nobody imported into a world book.
        if (!hasPrimary) {
            const embedded = embeddedEntries(character);
            const name = view.book?.name || `${view.name}`;
            const read = bookSources(name, embedded, 'book', entryChars);
            if (read.length) {
                sources.push(...read);
                books.push({ name, origin: 'book', entries: read.length });
            }
        }
        // CarrotKernel archives of the characters this card names (the archive books themselves are shared).
        const archives = safely(() => adaptersOf(this.app).bunnymo.books().archives, [] as string[]);
        for (const name of archives) {
            if (books.some((book) => book.name === name) || skippedByName(name)) continue;
            const role = safely(() => roles?.roleOf(name)?.role, undefined);
            if (role && SKIPPED_ROLES.has(role)) continue;
            const data = await readBook(this.app, name);
            if (!data) continue;
            const picked = bookEntries(data).filter((entry) => namedIn(entry, coreText));
            const read = bookSources(name, picked, 'archive', entryChars);
            if (!read.length) continue;
            sources.push(...read);
            books.push({ name, origin: 'archive', entries: read.length });
        }
    }

    /** BunnyMo tags by category («SPECIES: ELF, HUMAN…»), a hint for traits; '' without the mode. */
    private async vocabulary(): Promise<string> {
        const api = apiOf<BunnyMoModeApi>(this.app, 'bunnymoMode');
        if (!api) return '';
        const dictionary = await withTimeout(api.dictionary(), READ_TIMEOUT_MS, null);
        if (!dictionary) return '';
        const byCategory = new Map<string, string[]>();
        for (const tag of dictionary.tags) {
            if (!tag.value) continue;
            const list = byCategory.get(tag.category) ?? [];
            if (list.length < 12) list.push(tag.value);
            byCategory.set(tag.category, list);
        }
        const lines = [...byCategory.entries()].map(([category, values]) => `${category}: ${values.join(', ')}`);
        return clipText(lines.join('\n'), VOCABULARY_CHARS);
    }

    /** What the chat already has (the plan marks it «уже есть»). */
    async snapshot(personaName = this.personaName()): Promise<ExistingSnapshot> {
        const canon = apiOf<CanonApi>(this.app, 'canon');
        const items =
            canon && this.app.host.chatId()
                ? await withTimeout(canon.list({ kind: 'addition' }), READ_TIMEOUT_MS, [])
                : [];
        const entries: ExistingEntry[] = items.map((item) => ({
            uid: item.uid,
            type: item.meta.type,
            title: str(item.entry.comment).trim() || strings(item.entry.key)[0] || `#${item.uid}`,
            keys: strings(item.entry.key),
            content: str(item.entry.content),
        }));
        const places = safely(() => apiOf<PlacesApi>(this.app, 'places')?.list() ?? [], []);
        const mechanics = safely(() => apiOf<MechanicsApi>(this.app, 'mechanics')?.list() ?? [], []);
        const passports = safely(() => adaptersOf(this.app).nai.chatPassports(), []);
        const promises = safely(() => apiOf<CalendarApi>(this.app, 'calendar')?.promises() ?? [], []);
        const facts = safely(() => apiOf<KnowledgeApi>(this.app, 'knowledge')?.facts() ?? [], []);
        return {
            canon: entries,
            places: places.map((place) => ({
                id: place.id,
                name: place.name,
                aliases: place.aliases,
                forms: place.forms,
            })),
            mechanics: mechanics.map((def) => ({
                id: def.id,
                name: def.name,
                ...(def.promptName ? { promptName: def.promptName } : {}),
                ...(def.template ? { template: def.template } : {}),
            })),
            passports: passports.map((passport) => ({
                id: passport.id,
                name: passport.name,
                aliases: passport.aliases,
            })),
            personaName,
            // The stored texts and their English copies (a Russian story keeps both): a plan matches either.
            promises: promises.flatMap((promise) => [promise.what, promise.english ?? ''].filter(Boolean)),
            secrets: facts
                .filter((fact) => fact.secret)
                .flatMap((fact) => [fact.text, fact.english ?? ''].filter(Boolean)),
        };
    }

    private templates(): { id: string; title: string }[] {
        const api = apiOf<MechanicsApi>(this.app, 'mechanics');
        if (!api) return [];
        return safely(() => api.templates(), []).map((template) => ({
            id: template.id,
            title: safely(() => this.app.i18n.t(template.titleKey), template.id),
        }));
    }

    private mechanics(): { id: string; name: string; attributes: string[] }[] {
        const api = apiOf<MechanicsApi>(this.app, 'mechanics');
        if (!api) return [];
        return safely(() => api.list(), []).map((def) => ({
            id: def.id,
            name: def.name,
            attributes: def.attributes.slice(0, 10).map((attribute) => attribute.name),
        }));
    }
}

/** An archive entry of a character the card's own text names (its title or a key, whole words). */
function namedIn(entry: BookEntryInput, coreText: string): boolean {
    const names = [entry.title, ...entry.keys]
        .map((name) => normName(name.replace(/^[^:]*:/, '')))
        .filter((name) => name.length >= 3 && !/[<>]/.test(name));
    return names.some((name) => new RegExp(`(^|[^\\p{L}])${escape(name)}($|[^\\p{L}])`, 'u').test(coreText));
}

function escape(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
