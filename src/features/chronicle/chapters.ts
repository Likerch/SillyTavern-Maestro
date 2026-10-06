// M9 п. 1–2 «Летопись» and «Склейка глав» (plan M9, M6 п. 7, §8 «глава летописи — Само»).
//
// After a turn is committed (and the generation is over, P15) the leader tab reads Qvink's flags of every message,
// updates the tracking in the chat document and turns memories that fell out of the long-term budget into canon
// chapters: canon additions of type 'chapter', origin 'chronicle', with AND keys (src/domain/chronicle-chapters.ts).
// Every chapter, merge and archive goes through app.autonomy (kinds 'chronicle.chapter', 'chronicle.merge',
// 'chronicle.archive', default «auto») and is journaled with an undo of its own; the canon also journals its writes.
// The canon budget is obeyed three ways: a chapter is at most a quarter of the budget, chapters rank below other
// canon (order 90 — the budget cuts them first) and active chapters take at most half of the budget (older ones go
// to the archive and come back when mentioned).
import { tPlural } from '../../core/labels';
import {
    chapterCap,
    chapterContent,
    chapterFields,
    chapterId,
    chapterInfoOf,
    chapterKeys,
    chapterShare,
    chapterTitle,
    isChapterRangeTitle,
    countTerms,
    distinctiveWords,
    eventLine,
    groupMemories,
    mergedKeys,
    mergedMeta,
    planArchive,
    planMerges,
    textLanguage,
    trackMemories,
} from '../../domain/chronicle-chapters';
import type {
    ChapterInfo,
    ChapterMemory,
    ChapterTerm,
    ChronicleMeta,
    MemoryGroup,
    MemorySnapshot,
    MemoryState,
} from '../../domain/chronicle-chapters';
import { chatLanguage } from '../../domain/chronicle-recap';
import { hasCyrillic, uniqueStrings } from '../../domain/canon-keys';
import { TYPED_FIELDS_KEY } from '../../domain/entry-types';
import { normalizeName } from '../../domain/world-names';
import { cleanForAnalysis } from '../../domain/text-clean';
import type { JournalChange, Unsubscribe } from '../../shared/contracts';
import type { CanonDraft, CanonItem } from '../canon/api';
import type { Entity } from '../world/api';
import type { Chapter } from './api';
import type { ChronicleEnv } from './env';
import { CHRONICLE_ID } from './settings';
import type { ChronicleDoc } from './store';

export const CHAPTER_KIND = 'chronicle.chapter';
export const MERGE_KIND = 'chronicle.merge';
export const ARCHIVE_KIND = 'chronicle.archive';
export const CHAPTER_TARGET = 'm9.chapter';
export const MERGE_TARGET = 'm9.merge';
export const ARCHIVE_TARGET = 'm9.archive';
/** Below the WI default (100): under the canon budget chapters are cut before facts. */
export const CHAPTER_ORDER = 90;
/** ST world_info_logic.AND_ANY. */
export const AND_ANY = 0;

const COMMIT_DELAY_MS = 2000;
const REPLY_DELAY_MS = 4000;
const OPEN_DELAY_MS = 3000;
const BUSY_RETRY_MS = 5000;
const BUSY_RETRIES = 6;
const IDLE_DELAY_MS = 500;
/** Messages whose language decides whether the event's own words can be keys. */
const LANGUAGE_MESSAGES = 6;
const MAX_ALIASES = 4;

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/* ------------------------------------------------------------------ payloads (JSON: Inbox cards survive reloads) */

export interface ChapterPayload {
    id: string;
    comment: string;
    content: string;
    keys: string[];
    secondary: string[];
    fields: Dict;
    chronicle: ChronicleMeta;
    /** send_date of every covered message (still the same messages?). */
    dates: string[];
}

export interface MergePayload {
    keep: number;
    drop: number;
    keepId: string;
    dropId: string;
    comment: string;
    content: string;
    keys: string[];
    secondary: string[];
    fields: Dict;
    chronicle: ChronicleMeta;
}

export interface ArchivePayload {
    uids: number[];
}

function isChapterPayload(value: unknown): value is ChapterPayload {
    return (
        isDict(value) &&
        typeof value.id === 'string' &&
        typeof value.content === 'string' &&
        Array.isArray(value.keys) &&
        Array.isArray(value.dates) &&
        isDict(value.chronicle)
    );
}

function isMergePayload(value: unknown): value is MergePayload {
    return (
        isDict(value) &&
        typeof value.keep === 'number' &&
        typeof value.drop === 'number' &&
        typeof value.content === 'string' &&
        isDict(value.chronicle)
    );
}

function isArchivePayload(value: unknown): value is ArchivePayload {
    return isDict(value) && Array.isArray(value.uids) && value.uids.every((uid) => Number.isInteger(uid));
}

/** A canon item as a draft that recreates it (undo of a merge). */
export function draftOf(item: CanonItem): CanonDraft {
    const entry: Dict = { ...item.entry };
    delete entry.extensions;
    delete entry.uid;
    const meta: Dict = { ...(item.meta as unknown as Dict) };
    delete meta.createdAt;
    delete meta.updatedAt;
    return structuredClone({ entry, meta }) as unknown as CanonDraft;
}

function isDraft(value: unknown): value is CanonDraft {
    return isDict(value) && isDict(value.entry) && isDict(value.meta);
}

/** The canon draft of a chapter: a selective AND ANY addition, typed «chapter», origin 'chronicle'. */
function chapterDraft(input: {
    comment: string;
    content: string;
    keys: string[];
    secondary: string[];
    fields: Dict;
    chronicle: ChronicleMeta;
}): CanonDraft {
    const meta: Dict = {
        kind: 'addition',
        status: 'active',
        origin: 'chronicle',
        type: 'chapter',
        sourceMessage: input.chronicle.to,
        [TYPED_FIELDS_KEY]: { ...input.fields },
        chronicle: structuredClone(input.chronicle),
    };
    return {
        entry: {
            comment: input.comment,
            content: input.content,
            key: [...input.keys],
            keysecondary: [...input.secondary],
            selective: true,
            selectiveLogic: AND_ANY,
            order: CHAPTER_ORDER,
        },
        meta: meta as unknown as CanonDraft['meta'],
    };
}

export class ChapterService {
    private timer: ReturnType<typeof setTimeout> | null = null;
    private waitingForIdle = false;
    private busyRetries = 0;
    private chain: Promise<unknown> = Promise.resolve();
    private disposed = false;
    private readonly listeners = new Set<() => void>();
    private canonOff: { api: unknown; off: Unsubscribe } | null = null;
    /** Merge and archive proposals already sent in this chat (an Inbox level would otherwise repeat them). */
    private readonly proposed = new Set<string>();

    constructor(private readonly env: ChronicleEnv) {}

    private get app() {
        return this.env.app;
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(): Unsubscribe[] {
        const { app } = this;
        app.journal.registerUndo(CHAPTER_TARGET, (change) => this.undoChapter(change));
        app.journal.registerUndo(MERGE_TARGET, (change) => this.undoMerge(change));
        app.journal.registerUndo(ARCHIVE_TARGET, (change) => this.undoArchive(change));
        return [
            app.bus.on('chat:changed', () => {
                this.proposed.clear();
                this.arm(OPEN_DELAY_MS);
            }),
            app.bus.on('turn:committed', () => this.arm(COMMIT_DELAY_MS)),
            app.bus.on('reply:ready', () => this.arm(REPLY_DELAY_MS)),
            app.bus.on('generation:ended', () => {
                if (!this.waitingForIdle) return;
                this.waitingForIdle = false;
                this.arm(IDLE_DELAY_MS);
            }),
            app.leader.onChange((leader) => {
                if (leader) this.arm(IDLE_DELAY_MS);
            }),
            app.inbox.registerApplier(
                CHAPTER_KIND,
                async (payload) => {
                    if (!isChapterPayload(payload)) throw new Error('bad chronicle card');
                    await this.applyChapter(payload);
                },
                async (payload) => isChapterPayload(payload) && (await this.chapterStillValid(payload)),
                async (payload) => {
                    if (isChapterPayload(payload)) await this.markMemories(payload.chronicle.indexes, 'dismissed');
                },
            ),
            app.inbox.registerApplier(
                MERGE_KIND,
                async (payload) => {
                    if (!isMergePayload(payload)) throw new Error('bad chronicle card');
                    await this.applyMerge(payload);
                },
                async (payload) => isMergePayload(payload) && (await this.mergeStillValid(payload)),
            ),
            app.inbox.registerApplier(ARCHIVE_KIND, async (payload) => {
                if (!isArchivePayload(payload)) throw new Error('bad chronicle card');
                await this.applyArchive(payload);
            }),
            () => this.dispose(),
        ];
    }

    start(): void {
        this.arm(OPEN_DELAY_MS);
    }

    private dispose(): void {
        this.disposed = true;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        this.canonOff?.off();
        this.canonOff = null;
        this.listeners.clear();
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        this.listenCanon();
        return () => this.listeners.delete(listener);
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.env.log.error('chronicle listener failed', error);
            }
        }
    }

    /** Canon changes (undo from the journal, edits in the Lore Studio) change the chapter list too. */
    private listenCanon(): void {
        const canon = this.env.canon();
        if (canon === this.canonOff?.api) return;
        this.canonOff?.off();
        this.canonOff = null;
        if (!canon) return;
        try {
            this.canonOff = { api: canon, off: canon.onChange(() => this.emit()) };
        } catch (error) {
            this.env.log.debug('cannot listen to the canon', error);
        }
    }

    /* ---------------------------------------------------------------- scheduling (off the send path) */

    arm(delay: number): void {
        if (this.disposed) return;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.timer = null;
            void this.flush();
        }, delay);
    }

    private async flush(): Promise<void> {
        if (this.disposed) return;
        if (this.app.turn.current() !== null) {
            this.waitingForIdle = true;
            return;
        }
        if (!this.app.leader.isLeader() || !this.app.host.chatId()) return;
        try {
            if (this.env.qvinkReady() && this.env.qvink().isBusy()) {
                // Qvink is still summarising: its flags are about to change.
                if (this.busyRetries++ < BUSY_RETRIES) this.arm(BUSY_RETRY_MS);
                return;
            }
        } catch (error) {
            this.env.log.debug('Qvink busy check failed', error);
        }
        this.busyRetries = 0;
        await this.scan();
    }

    /** One pass: tracking, new chapters, merges, archive. Serialised. */
    scan(): Promise<void> {
        const run = () => this.scanNow().catch((error: unknown) => this.env.log.warn('chronicle pass failed', error));
        const next = this.chain.then(run, run);
        this.chain = next;
        return next;
    }

    private async scanNow(): Promise<void> {
        const { app, env } = this;
        if (!env.settings().chapters || !app.leader.isLeader() || !app.host.chatId()) return;
        if (!env.qvinkReady() || !env.canon()) return;
        const epoch = env.store.epoch();
        const chat = app.host.ctx().chat ?? [];
        const snapshots = this.snapshots(chat);
        let fallen: number[] = [];
        let tracked: ChronicleDoc['memories'] = {};
        await env.store.mutate((doc) => {
            const result = trackMemories(doc.memories, snapshots, chat.length);
            fallen = result.fallen;
            tracked = result.tracked;
            if (!result.changed) return false;
            doc.memories = result.tracked;
            return true;
        });
        if (epoch !== env.store.epoch()) return;
        if (fallen.length && app.autonomy.level(CHAPTER_KIND, 'auto') !== 'off') {
            await this.proposeChapters(fallen, tracked, epoch);
        }
        if (epoch !== env.store.epoch()) return;
        await this.maintain();
    }

    private snapshots(chat: readonly STChatMessage[]): MemorySnapshot[] {
        const qvink = this.env.qvink();
        const out: MemorySnapshot[] = [];
        for (let index = 0; index < chat.length; index++) {
            const record = qvink.memoryOf(index);
            if (!record) continue;
            out.push({
                index,
                date: String(chat[index]?.send_date ?? ''),
                memory: record.memory,
                remember: record.remember,
                include: record.include,
                lagging: record.lagging,
            });
        }
        return out;
    }

    /* ---------------------------------------------------------------- reading chapters */

    /** Chronicle chapters of the current chat's canon, oldest first. */
    async infos(): Promise<ChapterInfo[]> {
        const canon = this.env.canon();
        if (!canon || !this.app.host.chatId()) return [];
        this.listenCanon();
        try {
            const items = await canon.list({ origin: 'chronicle' });
            return items
                .map((item) => chapterInfoOf(item as unknown as { uid: number; meta: unknown; entry: Dict }))
                .filter((info): info is ChapterInfo => info !== null)
                .sort((a, b) => a.from - b.from || a.uid - b.uid);
        } catch (error) {
            this.env.log.debug('canon list failed', error);
            return [];
        }
    }

    async chapters(): Promise<Chapter[]> {
        return (await this.infos()).map((info) => ({
            uid: info.uid,
            title: this.shownTitle(info),
            from: info.from,
            to: info.to,
            keys: [...info.keys],
            secondary: [...info.secondary],
            chars: info.chars,
            status: info.status,
        }));
    }

    private async canonItem(uid: number): Promise<CanonItem | undefined> {
        const canon = this.env.canon();
        if (!canon) return undefined;
        return (await canon.list({ origin: 'chronicle' })).find((item) => item.uid === uid);
    }

    /* ---------------------------------------------------------------- card texts */

    /** «сообщения №3–8» / «сообщение №3». */
    private range(from: number, to: number): string {
        return this.env.t(from === to ? 'm9.range.one' : 'm9.range.many', { from, to });
    }

    /** A chapter in a card: «Alice — Tavern» (сообщения №2–4); the stored title when it has no name. */
    private label(info: ChapterInfo): string {
        if (!info.name) return `«${this.shownTitle(info)}»`;
        // Nothing names it: the range in the user's words, not the English fallback name.
        if (isChapterRangeTitle(info.name)) return this.range(info.from, info.to);
        return this.env.t('m9.chapter.label', { name: info.name, range: this.range(info.from, info.to) });
    }

    /**
     * The entry title (comment) the user reads: «Летопись: Алиса — Таверна (№2–4)»; a chapter nothing names reads as
     * «Летопись: сообщения №2–4» (its stored English name «Messages 2–4» stays for the model).
     */
    private comment(title: string, from: number, to: number): string {
        if (isChapterRangeTitle(title)) return this.env.t('m9.chapter.comment.range', { range: this.range(from, to) });
        return this.env.t('m9.chapter.comment', { title, from, to });
    }

    /** The title of a chapter made before 1.11 with the English range fallback in it, shown in the user's words. */
    private shownTitle(info: ChapterInfo): string {
        if (info.name && isChapterRangeTitle(info.name) && info.title.includes(info.name)) {
            return this.env.t('m9.chapter.comment.range', { range: this.range(info.from, info.to) });
        }
        return info.title;
    }

    /** What happened and what Maestro does, then the remembered events (in the chat's language) one per line. */
    private story(intro: string, events: readonly string[]): string {
        const lines = events.map(eventLine).filter(Boolean);
        if (!lines.length) return intro;
        return [intro, this.env.t('m9.chapter.events'), ...lines.map((line) => `— ${line}`)].join('\n');
    }

    /** «Подробнее»: the AND keys and the canon text (typed fields with English labels). */
    private details(payload: { keys: string[]; secondary: string[]; content: string }): string {
        const keys = this.env.t('m9.chapter.keys', {
            primary: payload.keys.join(', '),
            secondary: payload.secondary.join(', '),
        });
        return `${keys}\n\n${payload.content}`;
    }

    /* ---------------------------------------------------------------- terms */

    private mainIds(): Set<string> {
        const ids = new Set<string>();
        try {
            for (const entity of this.env.world()?.entities() ?? []) {
                if (entity.kind === 'persona' || entity.sources.some((source) => source.kind === 'card')) {
                    ids.add(entity.id);
                }
            }
        } catch (error) {
            this.env.log.debug('world entities failed', error);
        }
        return ids;
    }

    private term(entity: Entity, main: boolean): ChapterTerm {
        const keys = uniqueStrings([entity.name, ...entity.aliases.slice(0, MAX_ALIASES), ...entity.forms]);
        return { id: entity.id, name: entity.name, keys, main };
    }

    /** Russian forms for terms without any (DES-RU declensions through the canon), in a Russian chat. */
    private async withRussianKeys(term: ChapterTerm, cache: Map<string, string[]>): Promise<ChapterTerm> {
        if (term.keys.some((key) => hasCyrillic(key))) return term;
        const canon = this.env.canon();
        if (!canon) return term;
        let forms = cache.get(term.name);
        if (!forms) {
            try {
                forms = await canon.russianKeys(term.name);
            } catch {
                forms = [];
            }
            cache.set(term.name, forms);
        }
        return { ...term, keys: uniqueStrings([...term.keys, ...forms]) };
    }

    private placeAt(index: number): ChapterTerm | null {
        let places;
        try {
            places = this.env.places()?.list() ?? [];
        } catch {
            return null;
        }
        let best: { term: ChapterTerm; from: number } | null = null;
        for (const place of places) {
            for (const visit of place.visits) {
                if (visit.from > index || (visit.to !== null && index > visit.to)) continue;
                if (best && best.from >= visit.from) continue;
                best = {
                    from: visit.from,
                    term: {
                        id: `place:${place.id}`,
                        name: place.name,
                        keys: uniqueStrings([place.name, ...place.aliases, ...place.forms]),
                    },
                };
            }
        }
        return best?.term ?? null;
    }

    /** Main heroes by name when the world model is off: the persona and the character of the chat. */
    private heroesByName(text: string): ChapterTerm[] {
        const ctx = this.app.host.ctx();
        const normalized = normalizeName(text);
        const out: ChapterTerm[] = [];
        for (const [kind, name] of [
            ['persona', ctx.name1],
            ['character', ctx.name2],
        ] as const) {
            const trimmed = typeof name === 'string' ? name.trim() : '';
            if (trimmed && normalized.includes(normalizeName(trimmed))) {
                out.push({ id: `${kind}:${normalizeName(trimmed)}`, name: trimmed, keys: [trimmed], main: true });
            }
        }
        return out;
    }

    private async describe(
        index: number,
        text: string,
        fallenAt: number | undefined,
        main: Set<string>,
        russian: boolean,
        cache: Map<string, string[]>,
    ): Promise<ChapterMemory> {
        const world = this.env.world();
        let entities: Entity[] = [];
        try {
            entities = world?.mentions(text) ?? [];
        } catch (error) {
            this.env.log.debug('world mentions failed', error);
        }
        let participants = world
            ? entities
                  .filter((entity) => entity.kind === 'character' || entity.kind === 'persona')
                  .map((entity) => this.term(entity, main.has(entity.id) || entity.kind === 'persona'))
            : this.heroesByName(text);
        let items = entities.filter((entity) => entity.kind === 'item').map((entity) => this.term(entity, false));
        let place = this.placeAt(index);
        if (russian) {
            participants = await Promise.all(participants.map((term) => this.withRussianKeys(term, cache)));
            items = await Promise.all(items.map((term) => this.withRussianKeys(term, cache)));
            if (place) place = await this.withRussianKeys(place, cache);
        }
        const memory: ChapterMemory = { index, text, participants, place, items };
        if (fallenAt !== undefined) memory.fallenAt = fallenAt;
        return memory;
    }

    private chatLanguage(chat: readonly STChatMessage[]): 'ru' | 'en' {
        const texts: string[] = [];
        for (let i = chat.length - 1; i >= 0 && texts.length < LANGUAGE_MESSAGES; i--) {
            const message = chat[i];
            if (!message || message.is_system) continue;
            const text = cleanForAnalysis(message);
            if (text) texts.push(text);
        }
        return chatLanguage(texts);
    }

    /* ---------------------------------------------------------------- new chapters */

    private async proposeChapters(fallen: number[], tracked: ChronicleDoc['memories'], epoch: number): Promise<void> {
        const { app, env } = this;
        const canon = env.canon();
        if (!canon) return;
        const chat = app.host.ctx().chat ?? [];
        const language = this.chatLanguage(chat);
        const main = this.mainIds();
        const cache = new Map<string, string[]>();
        const memories: ChapterMemory[] = [];
        for (const index of fallen) {
            const text = env.qvink().memoryOf(index)?.memory.trim();
            if (!text) continue;
            memories.push(
                await this.describe(index, text, tracked[String(index)]?.fallenAt, main, language === 'ru', cache),
            );
        }
        const cap = chapterCap(canon.budget().limitChars, env.settings().maxChapterChars);
        const groups = groupMemories(memories, { maxChars: cap, chatLength: chat.length });
        const existing = new Set((await this.infos()).map((info) => info.id));
        for (const group of groups) {
            if (!group.ready || epoch !== env.store.epoch()) continue;
            await this.proposeChapter(group, language, chat, existing);
        }
    }

    private async proposeChapter(
        group: MemoryGroup,
        language: 'ru' | 'en',
        chat: readonly STChatMessage[],
        existing: ReadonlySet<string>,
    ): Promise<void> {
        const { app, env } = this;
        const indexes = group.memories.map((memory) => memory.index);
        const dates = indexes.map((index) => String(chat[index]?.send_date ?? ''));
        const id = chapterId(indexes, dates);
        if (existing.has(id)) {
            // Made already (its tracking was not saved, or by another tab): only the bookkeeping is missing.
            await this.markMemories(indexes, 'chaptered', id);
            return;
        }
        const texts = group.memories.map((memory) => memory.text);
        const participants = countTerms(group.memories.map((memory) => memory.participants));
        const place = countTerms(group.memories.map((memory) => (memory.place ? [memory.place] : [])))[0] ?? null;
        const items = countTerms(group.memories.map((memory) => memory.items));
        const known = [...participants, ...items, ...(place ? [place] : [])].flatMap((term) => [
            term.name,
            ...term.keys,
        ]);
        const words = textLanguage(texts.join(' ')) === language ? distinctiveWords(texts, known) : [];
        const keys = chapterKeys(group.memories, { words });
        if (!keys) {
            env.log.info(`chronicle: no AND keys for memories ${indexes.join(', ')}; left out`);
            await this.markMemories(indexes, 'nokeys');
            return;
        }
        const from = indexes[0] as number;
        const to = indexes[indexes.length - 1] as number;
        // Characteristic participants first: they name the chapter.
        const ordered = [...participants.filter((term) => !term.main), ...participants.filter((term) => term.main)];
        const characters = ordered.map((term) => term.name);
        const title = chapterTitle(characters, place?.name ?? null, from, to);
        const chronicle: ChronicleMeta = {
            id,
            from,
            to,
            indexes,
            participants: ordered.map((term) => term.id),
            primary: keys.primaryId,
            place: place?.id ?? null,
            characters,
        };
        const payload: ChapterPayload = {
            id: chronicle.id,
            comment: this.comment(title, from, to),
            content: chapterContent(title, texts, characters),
            keys: keys.primary,
            secondary: keys.secondary,
            fields: chapterFields(title, texts, characters),
            chronicle,
            dates,
        };
        // Without participants or a place the domain's title is a message range in English: the range says it better.
        const range = this.range(from, to);
        const named = characters.length > 0 || place !== null;
        const heading = named
            ? env.t('m9.chapter.proposal', { title, range })
            : env.t('m9.chapter.proposal.range', { range });
        const decision = await app.autonomy.decide<ChapterPayload>(
            {
                module: CHRONICLE_ID,
                kind: CHAPTER_KIND,
                title: heading,
                description: this.story(env.t('m9.chapter.description', { range }), texts),
                details: this.details(payload),
                appliedNotice: {
                    text: env.t('m9.chapter.applied', { title: named ? `${title} (${range})` : range }),
                    group: 'm9.chapter.applied',
                    groupText: (count) => tPlural(app.i18n, 'm9.chapter.appliedMany', count),
                },
                changes: [
                    {
                        target: CHAPTER_TARGET,
                        ref: { id: payload.id, from, to },
                        before: null,
                        after: {
                            title: payload.comment,
                            keys: payload.keys,
                            secondary: payload.secondary,
                            content: payload.content,
                        },
                    },
                ],
                payload,
                stillValid: () => this.chapterStillValid(payload),
                apply: (value) => this.applyChapter(value),
            },
            'auto',
        );
        if (decision === 'queued' || decision === 'notified') {
            await this.markMemories(indexes, 'proposed', payload.id);
        }
    }

    private async chapterStillValid(payload: ChapterPayload): Promise<boolean> {
        if (!this.env.canon()) return false;
        const chat = this.app.host.ctx().chat ?? [];
        const sameMessages = payload.chronicle.indexes.every(
            (index, position) => String(chat[index]?.send_date ?? '') === payload.dates[position],
        );
        if (!sameMessages) return false;
        return !(await this.infos()).some((info) => info.id === payload.id);
    }

    async applyChapter(payload: ChapterPayload): Promise<void> {
        const canon = this.env.canon();
        if (!canon) throw new Error(this.env.t('m9.error.noCanon'));
        if ((await this.infos()).some((info) => info.id === payload.id)) return;
        await canon.put(chapterDraft(payload));
        await this.markMemories(payload.chronicle.indexes, 'chaptered', payload.id);
        this.emit();
    }

    private async markMemories(indexes: readonly number[], state: MemoryState, chapter?: string): Promise<void> {
        const wanted = new Set(indexes.map(String));
        await this.env.store.mutate((doc) => {
            let changed = false;
            for (const [key, record] of Object.entries(doc.memories)) {
                if (!wanted.has(key)) continue;
                if (record.state === state && record.chapter === chapter) continue;
                record.state = state;
                if (chapter) record.chapter = chapter;
                else delete record.chapter;
                changed = true;
            }
            return changed;
        });
    }

    private async undoChapter(change: JournalChange): Promise<boolean> {
        const id = change.ref.id;
        if (typeof id !== 'string') return false;
        const canon = this.env.canon();
        const info = (await this.infos()).find((item) => item.id === id);
        if (info) {
            if (!canon) return false;
            await canon.remove(info.uid);
        }
        // An undone chapter is not made again from the same memories.
        await this.env.store.mutate((doc) => {
            let changed = false;
            for (const record of Object.values(doc.memories)) {
                if (record.chapter !== id) continue;
                record.state = 'dismissed';
                changed = true;
            }
            return changed;
        });
        this.emit();
        return true;
    }

    /* ---------------------------------------------------------------- merges and the budget */

    private async maintain(): Promise<void> {
        const { app, env } = this;
        const canon = env.canon();
        if (!canon) return;
        const limit = canon.budget().limitChars;
        const cap = chapterCap(limit, env.settings().maxChapterChars);
        if (app.autonomy.level(MERGE_KIND, 'auto') !== 'off') {
            for (const plan of planMerges(await this.infos(), { maxChars: cap })) await this.proposeMerge(plan);
        }
        if (app.autonomy.level(ARCHIVE_KIND, 'auto') !== 'off') {
            const infos = await this.infos();
            const uids = planArchive(infos, chapterShare(limit));
            if (uids.length) await this.proposeArchive(uids, infos);
        }
    }

    private async proposeMerge(plan: { keep: ChapterInfo; drop: ChapterInfo }): Promise<void> {
        const { app, env } = this;
        const keepItem = await this.canonItem(plan.keep.uid);
        const dropItem = await this.canonItem(plan.drop.uid);
        if (!keepItem || !dropItem) return;
        const signature = `merge:${keepItem.uid}:${keepItem.meta.updatedAt}:${dropItem.uid}:${dropItem.meta.updatedAt}`;
        if (this.proposed.has(signature)) return;
        this.proposed.add(signature);
        const chronicle = mergedMeta(plan.keep, plan.drop);
        const name = plan.keep.name || chapterTitle(chronicle.characters, null, chronicle.from, chronicle.to);
        const events = [...plan.keep.events, ...plan.drop.events];
        const keys = mergedKeys(plan.keep, plan.drop);
        const payload: MergePayload = {
            keep: plan.keep.uid,
            drop: plan.drop.uid,
            keepId: plan.keep.id,
            dropId: plan.drop.id,
            comment: this.comment(name, chronicle.from, chronicle.to),
            content: chapterContent(name, events, chronicle.characters),
            keys: keys.primary,
            secondary: keys.secondary,
            fields: chapterFields(name, events, chronicle.characters),
            chronicle,
        };
        const stamps = { keep: keepItem.meta.updatedAt, drop: dropItem.meta.updatedAt };
        await app.autonomy.decide<MergePayload>(
            {
                module: CHRONICLE_ID,
                kind: MERGE_KIND,
                title: env.t('m9.merge.proposal', { first: this.label(plan.keep), second: this.label(plan.drop) }),
                description: this.story(env.t('m9.merge.description', { name }), events),
                details: this.details(payload),
                appliedNotice: {
                    text: env.t('m9.merge.applied', { name }),
                    group: 'm9.merge.applied',
                    groupText: (count) => tPlural(app.i18n, 'm9.merge.appliedMany', count),
                },
                changes: [
                    {
                        target: MERGE_TARGET,
                        ref: { keep: payload.keep, drop: payload.drop, keepId: payload.keepId, dropId: payload.dropId },
                        before: { keep: draftOf(keepItem), drop: draftOf(dropItem) },
                        after: { title: payload.comment, keys: payload.keys, secondary: payload.secondary },
                    },
                ],
                payload,
                stillValid: () => this.mergeStillValid(payload, stamps),
                apply: (value) => this.applyMerge(value),
            },
            'auto',
        );
    }

    private async mergeStillValid(payload: MergePayload, stamps?: { keep: number; drop: number }): Promise<boolean> {
        const keep = await this.canonItem(payload.keep);
        const drop = await this.canonItem(payload.drop);
        if (!keep || !drop || keep.meta.status !== 'active' || drop.meta.status !== 'active') return false;
        return !stamps || (keep.meta.updatedAt === stamps.keep && drop.meta.updatedAt === stamps.drop);
    }

    async applyMerge(payload: MergePayload): Promise<void> {
        const canon = this.env.canon();
        if (!canon) throw new Error(this.env.t('m9.error.noCanon'));
        await canon.put(chapterDraft(payload), { uid: payload.keep });
        await canon.remove(payload.drop);
        const indexes = new Set(payload.chronicle.indexes.map(String));
        await this.env.store.mutate((doc) => {
            let changed = false;
            for (const [key, record] of Object.entries(doc.memories)) {
                if (!indexes.has(key) || record.chapter === payload.keepId) continue;
                record.chapter = payload.keepId;
                record.state = 'chaptered';
                changed = true;
            }
            return changed;
        });
        this.emit();
    }

    private async undoMerge(change: JournalChange): Promise<boolean> {
        const canon = this.env.canon();
        const keep = change.ref.keep;
        const drop = change.ref.drop;
        const before = isDict(change.before) ? change.before : {};
        if (!canon || typeof keep !== 'number' || typeof drop !== 'number') return false;
        if (!isDraft(before.keep) || !isDraft(before.drop)) return false;
        await canon.put(structuredClone(before.keep), { uid: keep });
        await canon.put(structuredClone(before.drop), { uid: drop });
        const dropMeta = before.drop.meta as unknown as Dict;
        const dropChronicle = isDict(dropMeta.chronicle) ? dropMeta.chronicle : {};
        const dropId = typeof change.ref.dropId === 'string' ? change.ref.dropId : '';
        const indexes = new Set(
            (Array.isArray(dropChronicle.indexes) ? dropChronicle.indexes : []).map((index) => String(index)),
        );
        if (dropId) {
            await this.env.store.mutate((doc) => {
                let changed = false;
                for (const [key, record] of Object.entries(doc.memories)) {
                    if (!indexes.has(key) || record.chapter === dropId) continue;
                    record.chapter = dropId;
                    changed = true;
                }
                return changed;
            });
        }
        this.emit();
        return true;
    }

    private async proposeArchive(uids: number[], infos: readonly ChapterInfo[]): Promise<void> {
        const { app, env } = this;
        const signature = `archive:${uids.join(',')}`;
        if (this.proposed.has(signature)) return;
        this.proposed.add(signature);
        const payload: ArchivePayload = { uids };
        const names = uids
            .map((uid) => infos.find((info) => info.uid === uid))
            .filter((info): info is ChapterInfo => !!info)
            .map((info) => this.label(info));
        await app.autonomy.decide<ArchivePayload>(
            {
                module: CHRONICLE_ID,
                kind: ARCHIVE_KIND,
                title: tPlural(app.i18n, 'm9.archive.proposal', uids.length),
                description: env.t('m9.archive.description', { list: names.join(', ') }),
                appliedNotice: { text: tPlural(app.i18n, 'm9.archive.applied', uids.length) },
                changes: uids.map((uid) => ({
                    target: ARCHIVE_TARGET,
                    ref: { uid },
                    before: 'active',
                    after: 'archived',
                })),
                payload,
                apply: (value) => this.applyArchive(value),
            },
            'auto',
        );
    }

    async applyArchive(payload: ArchivePayload): Promise<void> {
        const canon = this.env.canon();
        if (!canon) throw new Error(this.env.t('m9.error.noCanon'));
        for (const uid of payload.uids) await canon.setStatus(uid, 'archived');
        this.emit();
    }

    private async undoArchive(change: JournalChange): Promise<boolean> {
        const canon = this.env.canon();
        const uid = change.ref.uid;
        if (!canon || typeof uid !== 'number') return false;
        await canon.setStatus(uid, 'active');
        this.emit();
        return true;
    }

    /* ---------------------------------------------------------------- counters for the tab */

    /** How many followed memories are in each state. */
    counts(): Record<MemoryState, number> {
        const counts: Record<MemoryState, number> = {
            tracked: 0,
            fallen: 0,
            proposed: 0,
            chaptered: 0,
            dismissed: 0,
            nokeys: 0,
        };
        for (const record of Object.values(this.env.store.peek()?.memories ?? {})) counts[record.state]++;
        return counts;
    }
}
