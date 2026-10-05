// Read tools over the story itself (M33, 1.10.0): the current chat's messages (chat_read, chat_search), the character
// card with its starting scenes — the first message and every alternate greeting — (card_read), the persona
// (persona_read), and one overview for «propose mechanics for this chat» (scenario_overview). Text is cleaned of the
// service noise (the DES tracker JSON becomes a compact `tracker`; CK dumps, NAI placeholders, mechanics blocks and
// HTML go) and capped so the whole answer fits the core's result size. All of it is the user's or a card author's
// content: untrusted. Offered while a chat is open.
import {
    PERSONA_POSITIONS,
    PROMPT_ROLES,
    cardView,
    greetingInChat,
    latestTracker,
    matchTerms,
    messageRole,
    messageTracker,
    messageView,
    personaAvatarByName,
    personaLock,
    searchTerms,
    snippetAround,
    trackerBrief,
    trackerScene,
} from '../../../../domain/assistant-chat';
import type { CardView, MessageView, TrackerBrief } from '../../../../domain/assistant-chat';
import { normalizeText } from '../../../../domain/assistant-docs';
import { cleanForAnalysis } from '../../../../domain/text-clean';
import type { App } from '../../../../shared/contracts';
import type { DirectorApi } from '../../../director/api';
import type { MechanicDef, MechanicTemplate, MechanicsApi } from '../../../mechanics/api';
import type { ToolContext, ToolSpec } from '../../api';
import {
    activeBooks,
    apiOf,
    argsOf,
    boolArg,
    compact,
    cut,
    enumArg,
    fitToSize,
    intArg,
    isDict,
    notice,
    objectSchema,
    optIntArg,
    prop,
    readTool,
    safely,
    say,
    strArg,
    withTimeout,
} from './common';
import type { Dict } from './common';

/** JSON size the answers aim at: under the core's default result cap (12 000), which also adds its wrapper. */
const OUTPUT_CHARS = 11000;

/* ------------------------------------------------------------------ host access */

/** available(): a chat is open. */
function chatIsOpen(app: App): boolean {
    return safely(() => {
        const id = app.host.chatId();
        return id !== null && id !== undefined && id !== '';
    }, false);
}

function chatOf(app: App): unknown[] {
    return safely(() => {
        const chat = app.host.ctx().chat;
        return Array.isArray(chat) ? (chat as unknown[]) : [];
    }, [] as unknown[]);
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function contextDict(app: App): Dict {
    return safely(() => app.host.ctx() as unknown as Dict, {} as Dict);
}

interface CardTarget {
    /** Index in ST's characters array. */
    id: number;
    name: string;
    avatar: string;
    /** A muted group member. */
    muted?: boolean;
}

interface GroupInfo {
    id: string;
    name: string;
    members: CardTarget[];
}

function targetOf(characters: unknown[], id: number): CardTarget | null {
    const character = characters[id];
    if (!isDict(character)) return null;
    return { id, name: str(character.name).trim() || '?', avatar: str(character.avatar) };
}

/** The group of a group chat with its members found among ST's characters; null in a one-on-one chat. */
function groupOf(app: App): GroupInfo | null {
    const ctx = contextDict(app);
    const groupId = ctx.groupId;
    if (typeof groupId !== 'string' && typeof groupId !== 'number') return null;
    const groups = Array.isArray(ctx.groups) ? ctx.groups : [];
    const group = groups.find((item) => isDict(item) && String(item.id) === String(groupId));
    if (!isDict(group)) return null;
    const characters = Array.isArray(ctx.characters) ? (ctx.characters as unknown[]) : [];
    const disabled = new Set(Array.isArray(group.disabled_members) ? group.disabled_members : []);
    const members: CardTarget[] = [];
    for (const member of Array.isArray(group.members) ? group.members : []) {
        const id = characters.findIndex(
            (character) => isDict(character) && (character.avatar === member || character.name === member),
        );
        const target = id >= 0 ? targetOf(characters, id) : null;
        if (!target) continue;
        if (disabled.has(member)) target.muted = true;
        members.push(target);
    }
    return { id: String(groupId), name: str(group.name).trim() || String(groupId), members };
}

/** The character of a one-on-one chat. */
function currentTarget(app: App): CardTarget | null {
    const ctx = contextDict(app);
    const raw = ctx.characterId;
    const id = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() ? Number(raw) : NaN;
    if (!Number.isInteger(id) || id < 0) return null;
    return targetOf(Array.isArray(ctx.characters) ? (ctx.characters as unknown[]) : [], id);
}

/** A target by name: exact (any case, ё = е), else the only one whose name contains it. */
function findByName(targets: readonly CardTarget[], name: string): CardTarget | undefined {
    const wanted = normalizeText(name.trim());
    const exact = targets.find((target) => normalizeText(target.name) === wanted);
    if (exact) return exact;
    const partial = targets.filter((target) => normalizeText(target.name).includes(wanted));
    return partial.length === 1 ? partial[0] : undefined;
}

/**
 * A character's full card: ST loads characters lazily (shallow ones have only the list fields), so a shallow one is
 * loaded first (read-only, from the server).
 */
async function loadCard(app: App, target: CardTarget): Promise<CardView | null> {
    const ctx = contextDict(app);
    const characters = Array.isArray(ctx.characters) ? (ctx.characters as unknown[]) : [];
    let character = characters[target.id];
    if (isDict(character) && character.shallow === true && typeof ctx.unshallowCharacter === 'function') {
        const load = ctx.unshallowCharacter as (id: number) => Promise<void>;
        await withTimeout(
            Promise.resolve().then(() => load(target.id)),
            4000,
            undefined,
        );
        const fresh = contextDict(app).characters;
        character = Array.isArray(fresh) ? (fresh as unknown[])[target.id] : character;
    }
    return cardView(character);
}

/** ST's tags of a character (tag_map by avatar → tag names). */
function stTags(app: App, avatar: string): string[] {
    const ctx = contextDict(app);
    const map = isDict(ctx.tagMap) ? ctx.tagMap : {};
    const ids = Array.isArray(map[avatar]) ? (map[avatar] as unknown[]) : [];
    const tags = Array.isArray(ctx.tags) ? ctx.tags : [];
    return ids.flatMap((id) => {
        const tag = tags.find((item) => isDict(item) && item.id === id);
        return isDict(tag) && typeof tag.name === 'string' && tag.name ? [tag.name] : [];
    });
}

function tagsOf(app: App, card: CardView): string[] {
    return [...new Set([...card.tags, ...stTags(app, card.avatar)])];
}

function chatMetadata(app: App): Dict {
    const metadata = contextDict(app).chatMetadata;
    return isDict(metadata) ? metadata : {};
}

/* ------------------------------------------------------------------ chat_read */

const ROLES = ['all', 'user', 'char'] as const;
const READ_DEFAULT = 20;
const READ_MAX = 60;

type ChatRow = MessageView & { cut?: number; tracker?: TrackerBrief };

function trackerOf(message: unknown): TrackerBrief | null {
    return trackerBrief(messageTracker(message));
}

const chatRead = (app: App): ToolSpec =>
    readTool({
        name: 'chat_read',
        description:
            'Messages of the current chat (the story itself): index, author name, role (user / char / system), ' +
            'swipe n/m, date, `hidden` (excluded from the prompt), the text cleaned of service noise (DES tracker ' +
            "JSON, CK dumps, NAI image placeholders, mechanics blocks, HTML) and the message's DES tracker as a " +
            'compact `tracker` (location, time, characters present). Default: the latest 20 messages; `from`/`to` ' +
            "for a range (0-based indices; the chat's size is in `chat`). Long texts are cut (`cut` = the full " +
            'length): read fewer messages to get them whole.',
        parameters: objectSchema({
            from: prop.integer('First message index (0-based, inclusive); reads forward from it.', { minimum: 0 }),
            to: prop.integer('Last message index (inclusive); without `from`, the messages up to it.', {
                minimum: 0,
            }),
            last: prop.integer('How many messages at most (1-60, default 20); without `from`, the latest ones.', {
                minimum: 1,
                maximum: READ_MAX,
            }),
            role: prop.enum("Only the user's messages, only the characters' (default all).", ROLES),
            clean: prop.boolean('Strip the service noise from the texts (default true; false = the raw text).'),
        }),
        available: chatIsOpen,
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const chat = chatOf(app);
            if (!chat.length) return notice(ctx, 'The chat is empty.', 'Чат пуст.', { chat: { messages: 0 } });
            const lastIndex = chat.length - 1;
            const count = intArg(args, 'last', READ_DEFAULT, 1, READ_MAX);
            const from = optIntArg(args, 'from');
            const to = optIntArg(args, 'to');
            const role = enumArg(args, 'role', ROLES, 'all') ?? 'all';
            const clean = boolArg(args, 'clean', true);
            const low = Math.min(Math.max(from ?? 0, 0), lastIndex);
            const high = Math.min(Math.max(to ?? lastIndex, 0), lastIndex);
            const totals = { messages: chat.length, first: 0, last: lastIndex };
            if (low > high) {
                return notice(ctx, '`from` is after `to`.', '`from` больше, чем `to`.', { chat: totals });
            }
            const candidates: number[] = [];
            for (let index = low; index <= high; index++) {
                if (role === 'all' || messageRole(chat[index]) === role) candidates.push(index);
            }
            if (!candidates.length) {
                return notice(ctx, 'No messages of that kind in the range.', 'В этом диапазоне таких сообщений нет.', {
                    chat: totals,
                });
            }
            const picked = from !== undefined ? candidates.slice(0, count) : candidates.slice(-count);
            const more = candidates.length - picked.length;
            const views = picked.map((index) => ({
                view: messageView(chat[index], index, clean),
                tracker: trackerOf(chat[index]),
            }));
            const lastTracked = views.reduce((found, row, position) => (row.tracker ? position : found), -1);
            const baseCap = Math.min(7000, Math.max(300, Math.floor(9000 / picked.length)));
            const { data } = fitToSize((scale) => {
                const cap = Math.max(80, Math.round(baseCap * scale));
                let anyCut = false;
                const messages: ChatRow[] = views.map(({ view, tracker }, position) => {
                    const row: ChatRow = { ...view, text: cut(view.text, cap) };
                    if (view.text.length > cap) {
                        row.cut = view.text.length;
                        anyCut = true;
                    }
                    // Short of room: the tracker of the last message only.
                    if (tracker && (scale >= 0.4 || position === lastTracked)) row.tracker = tracker;
                    return row;
                });
                const notes: string[] = [];
                if (anyCut) {
                    notes.push(
                        `Texts over ${cap} characters are cut (\`cut\` = the full length): read fewer messages (from/to) to get them whole.`,
                    );
                }
                if (more > 0) notes.push(`${more} more messages in this range: use from/to.`);
                return compact({
                    chat: totals,
                    shown: compact({
                        from: picked[0],
                        to: picked[picked.length - 1],
                        count: picked.length,
                        role: role === 'all' ? undefined : role,
                        raw: clean ? undefined : true,
                    }),
                    messages,
                    truncated: anyCut || more > 0,
                    note: notes.length ? notes.join(' ') : undefined,
                });
            }, OUTPUT_CHARS);
            const first = picked[0]!;
            const last = picked[picked.length - 1]!;
            return {
                data,
                untrusted: true,
                summary: say(
                    ctx,
                    `Chat: #${first}–#${last} (${picked.length} of ${chat.length})`,
                    `Чат: №${first}–№${last} (${picked.length} из ${chat.length})`,
                ),
            };
        },
    });

/* ------------------------------------------------------------------ chat_search */

const chatSearch = (app: App): ToolSpec =>
    readTool({
        name: 'chat_search',
        description:
            'Finds messages of the current chat that contain words (Russian or English, case-insensitive, word ' +
            'forms matched by simple stems, so a Russian case form of a name finds the name): index, author, how ' +
            'many of the words matched, and a snippet around the first match. Best matches first (all words, then ' +
            'fewer), newest first among equals; read a hit in full with chat_read(from, to).',
        parameters: objectSchema(
            {
                query: prop.string('Words to look for (a name, a place, a thing, a phrase).'),
                limit: prop.integer('Hits (1-30, default 10).', { minimum: 1, maximum: 30 }),
            },
            ['query'],
        ),
        available: chatIsOpen,
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const query = strArg(args, 'query', 200);
            const terms = query ? searchTerms(query) : [];
            if (!query || !terms.length) {
                return notice(ctx, 'Give words to search for.', 'Нужны слова для поиска.');
            }
            const chat = chatOf(app);
            const found: { index: number; matched: number; at: number; text: string }[] = [];
            chat.forEach((message, index) => {
                const text = cleanForAnalysis(message);
                const match = matchTerms(text, terms);
                if (match) found.push({ index, matched: match.matched, at: match.at, text });
            });
            found.sort((a, b) => b.matched - a.matched || b.index - a.index);
            const limit = intArg(args, 'limit', 10, 1, 30);
            const full = found.filter((hit) => hit.matched === terms.length).length;
            const hits = found.slice(0, limit).map((hit) => {
                const view = messageView(chat[hit.index], hit.index, false);
                return compact({
                    index: hit.index,
                    name: view.name,
                    role: view.role,
                    hidden: view.hidden,
                    matched: terms.length > 1 ? `${hit.matched}/${terms.length}` : undefined,
                    snippet: snippetAround(hit.text, hit.at, 110),
                });
            });
            return {
                data: compact({
                    query,
                    terms,
                    found: found.length,
                    allWords: terms.length > 1 ? full : undefined,
                    messages: chat.length,
                    hits,
                    note:
                        terms.length > 1 && found.length && !full
                            ? 'No message has all the words: partial matches are shown.'
                            : undefined,
                }),
                untrusted: true,
                summary: say(
                    ctx,
                    `Chat search «${query}»: ${found.length} messages`,
                    `Поиск по чату «${query}»: сообщений — ${found.length}`,
                ),
            };
        },
    });

/* ------------------------------------------------------------------ card_read */

const PARTS = [
    'all',
    'description',
    'personality',
    'scenario',
    'first_message',
    'greetings',
    'examples',
    'creator_notes',
    'system_prompt',
    'post_history',
    'depth_prompt',
    'book',
] as const;
type Part = (typeof PARTS)[number];

const PART_TEXT: Partial<Record<Part, (card: CardView) => string>> = {
    description: (card) => card.description,
    personality: (card) => card.personality,
    scenario: (card) => card.scenario,
    first_message: (card) => card.firstMessage,
    examples: (card) => card.examples,
    creator_notes: (card) => card.creatorNotes,
    system_prompt: (card) => card.systemPrompt,
    post_history: (card) => card.postHistory,
};

/** Full texts of one part: as much as fits. */
const FULL_TEXT = 9000;

function sizesOf(card: CardView): Dict {
    const size = (text: string) => text.length || undefined;
    return compact({
        description: size(card.description),
        personality: size(card.personality),
        scenario: size(card.scenario),
        firstMessage: size(card.firstMessage),
        greetings: card.alternateGreetings.length ? card.alternateGreetings.map((text) => text.length) : undefined,
        examples: size(card.examples),
        creatorNotes: size(card.creatorNotes),
        systemPrompt: size(card.systemPrompt),
        postHistory: size(card.postHistory),
        depthPrompt: card.depthPrompt ? card.depthPrompt.text.length : undefined,
    });
}

/** The chat's own overrides of card fields (Chat options → scenario / examples / system prompt override). */
function chatOverrides(app: App, scale: number): Dict | undefined {
    const metadata = chatMetadata(app);
    const part = (key: string, max: number) => {
        const text = str(metadata[key]).trim();
        return text ? cut(text, Math.max(80, Math.round(max * scale))) : undefined;
    };
    const overrides = compact({
        scenario: part('scenario', 800),
        examples: part('mes_example', 400),
        systemPrompt: part('system_prompt', 400),
    });
    return Object.keys(overrides).length ? overrides : undefined;
}

function bookView(card: CardView, names: number): Dict | undefined {
    if (!card.book) return undefined;
    const entries = card.book.entries;
    return compact({
        name: card.book.name,
        entries: entries.length,
        disabled: entries.filter((entry) => !entry.enabled).length || undefined,
        names: names > 0 ? entries.slice(0, names).map((entry) => cut(entry.title, 50)) : undefined,
    });
}

function cardOverview(app: App, card: CardView, chat: readonly unknown[], groupName?: string): Dict {
    const inChat = groupName ? undefined : greetingInChat(chat, card);
    const { data } = fitToSize((scale) => {
        let anyCut = false;
        const c = (text: string, max: number): string | undefined => {
            if (!text) return undefined;
            const limit = Math.max(80, Math.round(max * scale));
            if (text.length > limit) anyCut = true;
            return cut(text, limit);
        };
        const alternates = card.alternateGreetings;
        return compact({
            name: card.name,
            avatar: card.avatar || undefined,
            group: groupName,
            creator: card.creator,
            version: card.version,
            sizes: sizesOf(card),
            description: c(card.description, 2500),
            personality: c(card.personality, 800),
            scenario: c(card.scenario, 1500),
            chatOverrides: chatOverrides(app, scale),
            firstMessage: c(card.firstMessage, 1500),
            alternateGreetings: alternates.length
                ? {
                      total: alternates.length,
                      items: alternates.map((text, index) => ({ n: index + 1, text: c(text, 700) ?? '' })),
                  }
                : undefined,
            greetingInChat:
                inChat === undefined ? undefined : inChat === 0 ? 'first message' : `alternate greeting ${inChat}`,
            examples: c(card.examples, 800),
            creatorNotes: c(card.creatorNotes, 600),
            systemPrompt: c(card.systemPrompt, 500),
            postHistory: c(card.postHistory, 500),
            depthPrompt: card.depthPrompt
                ? compact({
                      depth: card.depthPrompt.depth,
                      role: card.depthPrompt.role,
                      text: c(card.depthPrompt.text, 500),
                  })
                : undefined,
            tags: (() => {
                const tags = tagsOf(app, card);
                return tags.length ? tags.slice(0, 20) : undefined;
            })(),
            world: card.world,
            book: bookView(card, Math.round(30 * scale)),
            note: anyCut
                ? 'Long fields are cut (`sizes` = full lengths): read one whole with `part`, a starting scene with `greeting` (0 = the first message, n = alternate greeting n).'
                : undefined,
        });
    }, OUTPUT_CHARS);
    return data;
}

function cardPart(card: CardView, part: Part, chat: readonly unknown[], inGroup: boolean): Dict {
    const text = PART_TEXT[part];
    if (text) {
        const value = text(card);
        return compact({
            name: card.name,
            part,
            size: value.length,
            text: value ? cut(value, FULL_TEXT) : undefined,
            note: value ? undefined : 'This part of the card is empty.',
        });
    }
    if (part === 'depth_prompt') {
        return compact({
            name: card.name,
            part,
            depth: card.depthPrompt?.depth,
            role: card.depthPrompt?.role,
            size: card.depthPrompt?.text.length ?? 0,
            text: card.depthPrompt ? cut(card.depthPrompt.text, FULL_TEXT) : undefined,
            note: card.depthPrompt ? undefined : 'The card has no depth prompt.',
        });
    }
    if (part === 'book') {
        const entries = card.book?.entries ?? [];
        return compact({
            name: card.name,
            part,
            world: card.world,
            book: card.book?.name,
            entries: entries.length,
            items: entries.slice(0, 80).map((entry) =>
                compact({
                    title: cut(entry.title, 60),
                    keys: entry.keys.slice(0, 6).map((key) => cut(key, 40)),
                    off: entry.enabled ? undefined : true,
                }),
            ),
            note: card.book ? undefined : 'The card has no embedded character book.',
        });
    }
    // greetings: every starting scene, as much of each as fits.
    const greetings = [card.firstMessage, ...card.alternateGreetings];
    const inChat = inGroup ? undefined : greetingInChat(chat, card);
    const { data } = fitToSize(
        (scale) =>
            compact({
                name: card.name,
                part,
                total: greetings.length,
                greetingInChat: inChat,
                items: greetings.map((value, n) =>
                    compact({
                        n,
                        kind: n === 0 ? 'first message' : 'alternate greeting',
                        size: value.length,
                        text: cut(value, Math.max(120, Math.round(3000 * scale))),
                    }),
                ),
            }),
        OUTPUT_CHARS,
        0.02,
    );
    return data;
}

const cardRead = (app: App): ToolSpec =>
    readTool({
        name: 'card_read',
        description:
            'The character card of the current chat (in a group chat: the member list, or one member by `name`): ' +
            'description, personality, scenario, the first message and ALL alternate greetings (the starting ' +
            'scenes, numbered; which one this chat opened with), example dialogues, creator notes, system prompt and ' +
            "post-history instructions, depth prompt, tags, the embedded character book (entries) and the card's " +
            'linked lorebook, with the size of each field. The overview cuts long fields: `part` reads one whole, ' +
            '`greeting` one starting scene whole (0 = the first message, n = alternate greeting n).',
        parameters: objectSchema({
            name: prop.string('A group member (or the current character) by name; omit for the current character.'),
            part: prop.enum('One part of the card in full instead of the overview (default all).', PARTS),
            greeting: prop.integer('One starting scene in full: 0 = the first message, n = alternate greeting n.', {
                minimum: 0,
            }),
        }),
        available: chatIsOpen,
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const name = strArg(args, 'name', 80);
            const part = enumArg(args, 'part', PARTS, 'all') ?? 'all';
            const greeting = optIntArg(args, 'greeting');
            const chat = chatOf(app);
            const group = groupOf(app);
            let target: CardTarget | null | undefined;
            if (group) {
                if (!name) return groupOverview(app, group, ctx);
                target = findByName(group.members, name);
            } else {
                target = currentTarget(app);
                if (target && name && !findByName([target], name)) target = undefined;
            }
            if (target === null) {
                return notice(ctx, 'No character card is open.', 'Карточка персонажа не открыта.');
            }
            if (!target) {
                const known = (group?.members ?? [currentTarget(app)]).flatMap((item) => (item ? [item.name] : []));
                return notice(ctx, `No card named «${name ?? ''}» here.`, `Здесь нет карточки «${name ?? ''}».`, {
                    known,
                });
            }
            const card = await loadCard(app, target);
            if (!card) return notice(ctx, 'The card could not be read.', 'Карточку не удалось прочитать.');
            const alternates = card.alternateGreetings.length;
            if (greeting !== undefined) {
                const text = greeting === 0 ? card.firstMessage : card.alternateGreetings[greeting - 1];
                if (text === undefined || greeting < 0) {
                    return notice(
                        ctx,
                        `No starting scene ${greeting}: the card has the first message and ${alternates} alternate greetings.`,
                        `Нет стартовой сцены ${greeting}: в карточке первое сообщение и ещё приветствий — ${alternates}.`,
                    );
                }
                const inChat = group ? undefined : greetingInChat(chat, card);
                return {
                    data: compact({
                        name: card.name,
                        greeting,
                        kind: greeting === 0 ? 'first message' : 'alternate greeting',
                        alternateGreetings: alternates,
                        inChat: inChat === greeting || undefined,
                        size: text.length,
                        text: cut(text, FULL_TEXT),
                    }),
                    untrusted: true,
                    summary: say(
                        ctx,
                        `Card ${card.name}: starting scene ${greeting}`,
                        `Карточка ${card.name}: стартовая сцена ${greeting}`,
                    ),
                };
            }
            const data =
                part === 'all'
                    ? cardOverview(app, card, chat, group?.name)
                    : cardPart(card, part, chat, group !== null);
            return {
                data,
                untrusted: true,
                summary:
                    part === 'all'
                        ? say(
                              ctx,
                              `Card: ${card.name}${alternates ? ` (+${alternates} greetings)` : ''}`,
                              `Карточка: ${card.name}${alternates ? ` (доп. приветствий: ${alternates})` : ''}`,
                          )
                        : say(ctx, `Card ${card.name}: ${part}`, `Карточка ${card.name}: ${part}`),
            };
        },
    });

async function groupOverview(app: App, group: GroupInfo, ctx: ToolContext) {
    const cards = await Promise.all(group.members.map((member) => loadCard(app, member)));
    const { data } = fitToSize(
        (scale) =>
            compact({
                group: group.name,
                members: group.members.map((member, index) => {
                    const card = cards[index];
                    return compact({
                        name: member.name,
                        avatar: member.avatar || undefined,
                        muted: member.muted,
                        description: card?.description
                            ? cut(card.description, Math.max(80, Math.round(300 * scale)))
                            : undefined,
                        alternateGreetings: card?.alternateGreetings.length || undefined,
                    });
                }),
                chatOverrides: chatOverrides(app, scale),
                note: "Group chat: read one member's card with `name`.",
            }),
        OUTPUT_CHARS,
    );
    return {
        data,
        untrusted: true,
        summary: say(
            ctx,
            `Group «${group.name}»: ${group.members.length} members`,
            `Группа «${group.name}»: участников ${group.members.length}`,
        ),
    };
}

/* ------------------------------------------------------------------ persona_read */

/** The active persona's avatar id: personas.js `user_avatar`, else the only persona with this name. */
async function personaAvatar(app: App, power: Dict, name: string): Promise<string> {
    try {
        const module = await withTimeout(app.host.modules.load('personas.js'), 3000, {} as Record<string, unknown>);
        if (typeof module.user_avatar === 'string' && module.user_avatar) return module.user_avatar;
    } catch {
        // personas.js not available: by name
    }
    return personaAvatarByName(power, name) ?? '';
}

interface PersonaInfo {
    name: string;
    avatar: string;
    description: string;
    power: Dict;
}

async function personaInfo(app: App): Promise<PersonaInfo> {
    const ctx = contextDict(app);
    const power = isDict(ctx.powerUserSettings) ? ctx.powerUserSettings : {};
    const name = str(ctx.name1).trim();
    return {
        name,
        avatar: await personaAvatar(app, power, name),
        description: str(power.persona_description).trim(),
        power,
    };
}

const personaRead = (app: App): ToolSpec =>
    readTool({
        name: 'persona_read',
        description:
            "The user's active persona: name, title, description (cut), where its description goes in the prompt, " +
            'its lorebook, and its lock state: locked to this chat, connected to this character/group, or the ' +
            'default persona.',
        parameters: objectSchema(),
        available: chatIsOpen,
        async run(_rawArgs, ctx) {
            const persona = await personaInfo(app);
            const power = persona.power;
            const descriptions = isDict(power.persona_descriptions) ? power.persona_descriptions : {};
            const descriptor =
                persona.avatar && isDict(descriptions[persona.avatar]) ? descriptions[persona.avatar] : {};
            const descriptorDict = isDict(descriptor) ? descriptor : {};
            const group = groupOf(app);
            const lock = personaLock(power, chatMetadata(app), persona.avatar, {
                characterAvatar: currentTarget(app)?.avatar,
                groupId: group?.id ?? null,
            });
            const position =
                typeof power.persona_description_position === 'number' ? power.persona_description_position : 0;
            const atDepth = position === 4;
            const connections = Array.isArray(descriptorDict.connections) ? descriptorDict.connections.length : 0;
            const lockLabel = lock.chat
                ? say(ctx, ' (locked to this chat)', ' (закреплена за чатом)')
                : lock.character
                  ? say(ctx, ' (connected to this character)', ' (привязана к персонажу)')
                  : lock.default
                    ? say(ctx, ' (default)', ' (по умолчанию)')
                    : '';
            return {
                data: compact({
                    name: persona.name || undefined,
                    avatar: persona.avatar || undefined,
                    title: str(descriptorDict.title).trim() || undefined,
                    size: persona.description.length,
                    description: persona.description ? cut(persona.description, 3000) : undefined,
                    position: PERSONA_POSITIONS[position] ?? String(position),
                    depth:
                        atDepth && typeof power.persona_description_depth === 'number'
                            ? power.persona_description_depth
                            : undefined,
                    role:
                        atDepth && typeof power.persona_description_role === 'number'
                            ? PROMPT_ROLES[power.persona_description_role]
                            : undefined,
                    lorebook: str(power.persona_description_lorebook).trim() || undefined,
                    lock,
                    connections: connections || undefined,
                    note: persona.avatar
                        ? undefined
                        : 'The persona avatar is unknown: the lock states may be incomplete.',
                }),
                untrusted: true,
                summary: say(
                    ctx,
                    `Persona: ${persona.name || '?'}${lockLabel}`,
                    `Персона: ${persona.name || '?'}${lockLabel}`,
                ),
            };
        },
    });

/* ------------------------------------------------------------------ scenario_overview */

function mechanicView(def: MechanicDef, active: boolean): Dict {
    return compact({
        id: def.id,
        name: def.name,
        active,
        holders: def.holders.kind,
        attributes: def.attributes.slice(0, 10).map((attribute) => {
            const range =
                attribute.kind === 'number' && (attribute.min !== undefined || attribute.max !== undefined)
                    ? ` ${attribute.min ?? ''}–${attribute.max ?? ''}`
                    : '';
            return `${cut(attribute.name, 40)}: ${attribute.kind}${range}`;
        }),
        checks: def.checks.length ? def.checks.slice(0, 6).map((check) => cut(check.name, 40)) : undefined,
    });
}

function mechanicsView(app: App): Dict {
    const api = apiOf<MechanicsApi>(app, 'mechanics');
    if (!api) {
        return {
            off: true,
            note: 'The Mechanics module is off: mechanic_save is unavailable until the user switches it on (Settings → Modules).',
        };
    }
    const active = new Set(safely(() => api.active(), [] as MechanicDef[]).map((def) => def.id));
    const defs = safely(() => api.list(), [] as MechanicDef[]);
    const templates = safely(() => api.templates(), [] as MechanicTemplate[]);
    return compact({
        existing: defs.slice(0, 12).map((def) => mechanicView(def, active.has(def.id))),
        more: defs.length > 12 ? defs.length - 12 : undefined,
        templates: templates.slice(0, 20).map((template) => ({
            id: template.id,
            title: cut(
                safely(() => app.i18n.t(template.titleKey), template.id),
                60,
            ),
        })),
    });
}

const NEXT_STEP =
    'To propose mechanics: fit them to this story (genre, conflicts, resources, relationships, what the starting ' +
    "scenes set up), don't duplicate existing ones, and make one mechanic_save call per proposal (a template id with " +
    'overrides, or a full definition) — each is shown to the user as a card and saved only after confirmation.';

const scenarioOverview = (app: App): ToolSpec =>
    readTool({
        name: 'scenario_overview',
        description:
            'Everything needed to propose mechanics (or to understand the story) in one call: the card essentials ' +
            '(description and scenario cut; members in a group chat), the persona, the starting scenes (the first ' +
            'message and every alternate greeting, ~400 characters each, and which one this chat opened with), the ' +
            "latest chat messages cleaned, the DES tracker's last state (location, time, characters, relationships, " +
            'stats, quests), the existing Maestro mechanics (names, attributes, checks) and templates, the active ' +
            'lorebooks and the scene type. Then propose with mechanic_save.',
        parameters: objectSchema({
            messages: prop.integer('How many of the latest messages to include (1-20, default 10).', {
                minimum: 1,
                maximum: 20,
            }),
        }),
        available: chatIsOpen,
        async run(rawArgs, ctx) {
            const args = argsOf(rawArgs);
            const count = intArg(args, 'messages', 10, 1, 20);
            const chat = chatOf(app);
            const group = groupOf(app);
            const target = group ? null : currentTarget(app);
            const card = target ? await loadCard(app, target) : null;
            const memberCards = group
                ? await Promise.all(group.members.slice(0, 8).map((member) => loadCard(app, member)))
                : [];
            const persona = await personaInfo(app);
            const metadata = chatMetadata(app);
            const tracker = latestTracker(chat);
            const recentStart = Math.max(0, chat.length - count);
            const recent = chat.slice(recentStart).map((message, offset) => messageView(message, recentStart + offset));
            const books = (await activeBooks(app)).slice(0, 15);
            const director = apiOf<DirectorApi>(app, 'director');
            const scene = director ? safely(() => director.scene()?.type, undefined) : undefined;
            const mechanics = mechanicsView(app);
            const inChat = card ? greetingInChat(chat, card) : undefined;
            const { data } = fitToSize((scale) => {
                const c = (text: string, max: number): string | undefined =>
                    text ? cut(text, Math.max(60, Math.round(max * scale))) : undefined;
                const greetings = card ? [card.firstMessage, ...card.alternateGreetings] : [];
                return compact({
                    chat: compact({
                        messages: chat.length,
                        group: group?.name,
                        character: card?.name,
                        scene,
                    }),
                    card: card
                        ? compact({
                              name: card.name,
                              description: c(card.description, 1500),
                              personality: c(card.personality, 300),
                              scenario: c(str(metadata.scenario).trim() || card.scenario, 800),
                              scenarioOverride: str(metadata.scenario).trim() ? true : undefined,
                              creatorNotes: c(card.creatorNotes, 300),
                              tags: (() => {
                                  const tags = tagsOf(app, card);
                                  return tags.length ? tags.slice(0, 12) : undefined;
                              })(),
                              world: card.world,
                              book: bookView(card, Math.round(15 * scale)),
                          })
                        : undefined,
                    members: group
                        ? group.members.slice(0, 8).map((member, index) =>
                              compact({
                                  name: member.name,
                                  muted: member.muted,
                                  description: c(memberCards[index]?.description ?? '', 400),
                              }),
                          )
                        : undefined,
                    groupScenario: group ? c(str(metadata.scenario).trim(), 600) : undefined,
                    persona: compact({ name: persona.name || undefined, description: c(persona.description, 400) }),
                    startingScenes: greetings.length
                        ? compact({
                              total: greetings.length,
                              chatOpenedWith: inChat,
                              items: greetings.map((text, n) => ({ n, text: c(text, 400) ?? '' })),
                          })
                        : undefined,
                    recent: recent.map((view) =>
                        compact({
                            index: view.index,
                            name: view.name,
                            role: view.role,
                            hidden: view.hidden,
                            image: view.image,
                            text: c(view.text, 600) ?? '',
                        }),
                    ),
                    tracker: tracker
                        ? { message: tracker.index, ...(trackerScene(tracker.snapshot) ?? {}) }
                        : undefined,
                    mechanics,
                    lorebooks: compact({
                        active: books.length ? books : undefined,
                        chat: str(metadata.world_info).trim() || undefined,
                        card: card?.world,
                    }),
                    next: NEXT_STEP,
                });
            }, OUTPUT_CHARS);
            const title = card?.name ?? group?.name ?? '?';
            return {
                data,
                untrusted: true,
                summary: say(
                    ctx,
                    `Scenario: ${title}, ${chat.length} messages`,
                    `Сценарий: ${title}, сообщений ${chat.length}`,
                ),
            };
        },
    });

export function chatTools(app: App): ToolSpec[] {
    return [chatRead(app), chatSearch(app), cardRead(app), personaRead(app), scenarioOverview(app)];
}
