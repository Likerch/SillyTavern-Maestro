// «Персонажи в DES» of M37 «Подготовить к игре» (release 1.18, plan-2 §7 п. 4): the prepared starting scenes become
// Doom's Enhancement Suite's tracker of message 0, one record per greeting (the alternate greetings are its swipes), so
// the portrait bar and the scene panel show the right people — looks, behaviour, clothes, relationship to the player,
// thoughts, stats — and the scene's date, time, place and weather from the very first message.
// - Applying (service.applyItems, after every item: passports, places, mechanics and the active scene's outfits are
//   there): one interactive model task per prepared greeting ('prepare.desSeed', strict schema made from DES's live
//   config, src/domain/prepare-des-seed.ts), validated and completed in code (presence from the scene ∪ Dramatis's
//   startCast, stats from the mechanics, the place as the places registry names it); a failed or absent model gives a
//   record of names only. The saved character-level preparation never calls the model. The language is «Язык
//   истории» (core/language), the names the prepared ones (Russian in a Russian story).
// - Writing the way DES does (adapters/des/kit.ts): the shown greeting's record into `extra.dooms_tracker_swipes`, the
//   others into `swipe_info[n].extra` (ST swaps the whole `extra` on a swipe), an explicit empty record for greetings
//   without a prepared scene; the shown one adopted into lastGeneratedData and committedTrackerData; present names into
//   DES's per-chat roster through its accessors; DES's renderers; saveChatData. Never while the Workshop is open, never
//   DES's global per-name stores (portraits, appearance, aliases, relationships: NAI Studio, DES-RU and the user own
//   them), never `mes`. NAI Studio is asked for the portraits of the new faces (requestDesPortrait).
// - The records are kept in the chat document 'prepare-des': DES writes an empty record over the shown greeting on every
//   MESSAGE_RECEIVED(0, 'first_message') (each opening of a greeting-only chat, a card saved again — which rebuilds
//   message 0 —, a Continue of the greeting): a last listener puts the seeds back where a record is missing while the
//   player has not written.
// - A swipe of message 0 (last listener, after DES's own): the shown greeting's record is what DES shows and generates
//   from, roster names that only the previous greeting brought leave.
// - The first turn in DES's together mode: DES puts the previous tracker into the prompt only when an assistant message
//   precedes the user's (injector.js, chat.length guards), so the opening tracker goes in once, as DES's example block
//   (system, in chat at depth 1: after the greeting, before the player's message). Separate and external modes commit
//   lastGeneratedData themselves.
// - One journal record per apply with undo: the previous records of message 0 (every swipe written), the display state
//   and the roster names it added come back.
import { adaptersOf, dramatisOf } from '../../adapters';
import { loadDesKit } from '../../adapters/des/kit';
import { storyLanguage } from '../../core/language';
import type { DesKit, DesStartSections } from '../../adapters/des/kit';
import { cardView } from '../../domain/assistant-chat';
import { normName } from '../../domain/dossier-names';
import { desStatsAttributes, initialValueOf } from '../../domain/mechanics-defs';
import type { HolderSpec } from '../../domain/mechanics-defs';
import { characterNamed } from '../../domain/prepare-apply';
import {
    DES_SEED_TASK,
    buildDesSeedMessages,
    composeDesSeed,
    desSeedSchema,
    desStartExample,
    greetingSwipes,
    isEmptyRecord,
    nullRecord,
    readDesSeedAnswer,
    readDesSeedConfig,
    readRecord,
    sameRecord,
    seedSwipe,
    seedsAnything,
    shownSwipe,
    swipePiece,
    swipeTexts,
} from '../../domain/prepare-des-seed';
import type {
    ComposedSeed,
    DesSeedConfig,
    DesSeedRecord,
    SeedAnswer,
    SeedCast,
    SeedInput,
} from '../../domain/prepare-des-seed';
import { clonePlan } from '../../domain/prepare-plan';
import type { AnyPrepareItem } from '../../domain/prepare-plan';
import type { App, GenerationInfo, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { MechanicsApi } from '../mechanics/api';
import type { PlacesApi } from '../places/api';
import { sceneName } from './apply';
import type { ItemOutcome } from './apply';
import { apiOf, currentCard, hasUserMessages, isDict, loadCharacter, safely } from './collect';
import type { StoredScene } from './scenes';
import { APPLY_KIND, PREPARE_ID, PREPARE_STEP_TARGET } from './settings';

/** Per-chat document of the starting scenes' DES records. */
export const DES_DOC = 'prepare-des';
/** Item id of the seed's line in the apply summary and the chat's applied list. */
export const DES_ITEM = 'des';
/** Ephemeral injection slot of the first turn (`maestro_prepare_des_start`). */
export const DES_INJECTION = 'prepare_des_start';
/** DES's tracker instruction slot (injector.js): empty when DES suppressed itself for this generation. */
const DES_INSTRUCTION_SLOT = 'dooms-tracker-inject';
const START_LEAD =
    '[Tracker of the opening message, the start of the story — continue from it: keep these character names exactly, change values only as the story moves]';
const SEED_CONCURRENCY = 2;
const SEED_MAX_TOKENS = 3000;
const RETRY_MS = 2000;
const RETRY_ROUNDS = 30;
const PORTRAIT_REASON = 'Maestro: a prepared starting scene';

type Dict = Record<string, unknown>;

/** A greeting's record kept for the chat. */
export interface StoredSeed {
    greeting: number;
    /** The swipe of message 0 it was written to, and the piece of its text that finds it again. */
    swipe: number;
    piece: string;
    record: DesSeedRecord;
    /** Present characters (the portrait bar's), every character of the record. */
    present: string[];
    names: string[];
    /** The model wrote it (false: names only). */
    model: boolean;
    at: number;
}

export interface DesSeedDoc {
    seeds: StoredSeed[];
    /** Names in DES's roster before the first seed (normalised; null: not recorded yet). */
    rosterBefore: string[] | null;
    /** Names NAI Studio was asked to draw (once per chat). */
    portraits: string[];
}

/** What the apply step passes. */
export interface SeedRequest {
    /** The plan as chosen (edits laid over): the characters' prepared texts. */
    plan: readonly AnyPrepareItem[];
    /** Every stored starting scene of the chat. */
    scenes: readonly StoredScene[];
    /** Greetings whose scene was applied now (written again; the others only when they have no record yet). */
    fresh: readonly number[];
    /** Ask the model (false: the saved preparation — names only, no model call). */
    useModel: boolean;
}

/** The undo payload (the journal change's `ref`: technical, never shown). */
interface SeedRef {
    step: 'desSeed';
    chatId: string;
    /** What the swipes held before (null: no record). */
    before: { swipe: number; record: unknown }[];
    /** What the seed wrote there. */
    written: { swipe: number; record: DesSeedRecord }[];
    /** DES's display and generation state before. */
    last: DesStartSections | null;
    committed: DesStartSections | null;
    /** Names the seed added to DES's roster. */
    roster: string[];
    /** The greetings' seeds before (null: none). */
    previous: { greeting: number; seed: StoredSeed | null }[];
}

function str(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

function readSeed(raw: unknown): StoredSeed | null {
    if (!isDict(raw) || typeof raw.greeting !== 'number' || !Number.isInteger(raw.greeting) || raw.greeting < 0) {
        return null;
    }
    const record = readRecord(raw.record);
    if (!record) return null;
    return {
        greeting: raw.greeting,
        swipe: typeof raw.swipe === 'number' && Number.isInteger(raw.swipe) && raw.swipe >= 0 ? raw.swipe : 0,
        piece: str(raw.piece),
        record,
        present: strings(raw.present),
        names: strings(raw.names),
        model: raw.model === true,
        at: typeof raw.at === 'number' ? raw.at : 0,
    };
}

export function emptyDesDoc(): DesSeedDoc {
    return { seeds: [], rosterBefore: null, portraits: [] };
}

export function readDesDoc(raw: unknown): DesSeedDoc {
    const doc = emptyDesDoc();
    if (!isDict(raw)) return doc;
    if (Array.isArray(raw.seeds)) {
        for (const item of raw.seeds) {
            const seed = readSeed(item);
            if (seed && !doc.seeds.some((other) => other.greeting === seed.greeting)) doc.seeds.push(seed);
        }
        doc.seeds.sort((a, b) => a.greeting - b.greeting);
    }
    if (Array.isArray(raw.rosterBefore)) doc.rosterBefore = strings(raw.rosterBefore);
    doc.portraits = strings(raw.portraits);
    return doc;
}

/* ------------------------------------------------------------------ message 0's records */

function extraOf(owner: Dict): Dict {
    if (!isDict(owner.extra)) owner.extra = {};
    return owner.extra as Dict;
}

/** The record a swipe of message 0 holds now (the shown one in `extra`, the others in `swipe_info`). */
export function recordAt(first: STChatMessage, swipe: number): unknown {
    const message = first as unknown as Dict;
    const holder =
        swipe === shownSwipe(first)
            ? message
            : Array.isArray(message.swipe_info)
              ? message.swipe_info[swipe]
              : undefined;
    const extra = isDict(holder) && isDict(holder.extra) ? holder.extra : null;
    const swipes = extra && isDict(extra.dooms_tracker_swipes) ? extra.dooms_tracker_swipes : null;
    return swipes ? swipes[String(swipe)] : undefined;
}

function setIn(owner: Dict, swipe: number, record: DesSeedRecord | null): void {
    const extra = extraOf(owner);
    const swipes = isDict(extra.dooms_tracker_swipes) ? { ...extra.dooms_tracker_swipes } : {};
    if (record) swipes[String(swipe)] = { ...record };
    else delete swipes[String(swipe)];
    extra.dooms_tracker_swipes = swipes;
}

/**
 * Writes (or with null removes) the record of a swipe of message 0 where DES and ST look for it: the shown swipe's in
 * `extra` (mirrored into its `swipe_info`, DES's fallback on load), another swipe's in `swipe_info[n].extra` — the
 * `swipe_info` list is made like ST makes it when the message has swipes without one.
 */
export function writeAt(first: STChatMessage, swipe: number, record: DesSeedRecord | null): void {
    const message = first as unknown as Dict;
    const swipes = Array.isArray(message.swipes) ? message.swipes : null;
    if (swipes && !Array.isArray(message.swipe_info)) {
        message.swipe_info = swipes.map(() => ({
            send_date: message.send_date,
            gen_started: undefined,
            gen_finished: undefined,
            extra: {},
        }));
    }
    const info = Array.isArray(message.swipe_info) ? (message.swipe_info as unknown[]) : null;
    if (info && swipe < (swipes?.length ?? info.length) && !isDict(info[swipe])) {
        info[swipe] = { send_date: message.send_date, gen_started: undefined, gen_finished: undefined, extra: {} };
    }
    const slot = info && isDict(info[swipe]) ? (info[swipe] as Dict) : null;
    if (swipe === shownSwipe(first)) {
        setIn(message, swipe, record);
        if (slot) setIn(slot, swipe, record);
        return;
    }
    if (slot) setIn(slot, swipe, record);
}

function sectionsOf(record: unknown): DesStartSections {
    const value = readRecord(record);
    return { infoBox: value?.infoBox ?? null, characterThoughts: value?.characterThoughts ?? null };
}

function holdsName(holders: HolderSpec, name: string): boolean {
    if (holders.kind === 'characters') return true;
    return holders.kind === 'named' && holders.names.some((item) => normName(item) === normName(name));
}

async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
    const out: R[] = new Array<R>(items.length);
    let next = 0;
    const worker = async () => {
        while (next < items.length) {
            const index = next++;
            out[index] = await run(items[index]!);
        }
    };
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
    return out;
}

interface Prepared {
    scene: StoredScene;
    swipe: number;
    piece: string;
    composed: ComposedSeed | null;
    model: boolean;
}

export class DesSeeder {
    private doc: DesSeedDoc | null = null;
    private docChat: string | null = null;
    private loading: { chatId: string; job: Promise<DesSeedDoc> } | null = null;
    private chain: Promise<unknown> = Promise.resolve();
    private kitPromise: Promise<DesKit | null> | null = null;
    /** DES saw only the greeting when this generation started (its example block is missing). */
    private firstTurn = false;
    private retry: ReturnType<typeof setTimeout> | null = null;
    private retries = 0;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {}

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    install(): Unsubscribe[] {
        const offs: Unsubscribe[] = [];
        const on = (event: string, handler: (...args: unknown[]) => unknown, last = false) => {
            try {
                offs.push(this.app.host.events.on(event, handler, last ? { order: 'last' } : undefined));
            } catch (error) {
                this.log.debug(`prepare: no ${event} event`, error);
            }
        };
        // After DES's own handlers (and DES-RU's): DES has just written its empty record of the greeting.
        on('MESSAGE_RECEIVED', (messageId) => this.onReceived(messageId), true);
        on('MESSAGE_SWIPED', (messageId) => this.onSwiped(messageId), true);
        on('GENERATION_STARTED', (type, _params, dryRun) => this.onStarted(type, dryRun));
        if (typeof this.app.ephemeral?.addProducer === 'function') {
            offs.push(this.app.ephemeral.addProducer(DES_INJECTION, (gen) => this.produce(gen)));
        }
        offs.push(
            this.app.bus.on('chat:changed', () => {
                this.doc = null;
                this.docChat = null;
                this.firstTurn = false;
                this.stopRetry();
                if (this.available()) void this.load().catch(() => null);
            }),
        );
        offs.push(
            this.app.bus.on('generation:ended', () => {
                this.firstTurn = false;
            }),
        );
        offs.push(() => {
            this.disposed = true;
            this.stopRetry();
        });
        return offs;
    }

    /* ---------------------------------------------------------------- DES */

    private des() {
        return safely(() => adaptersOf(this.app).des, undefined);
    }

    /** DES is there and on. */
    available(): boolean {
        const des = this.des();
        return !!des && safely(() => des.present() && des.enabled(), false);
    }

    /** What DES asks for now; null without DES. */
    config(): DesSeedConfig | null {
        const des = this.des();
        if (!des || !this.available()) return null;
        return readDesSeedConfig(safely(() => des.settings(), null));
    }

    /** DES shows something a seed would fill (the review's switch is offered). */
    offered(): boolean {
        const config = this.config();
        return !!config && seedsAnything(config);
    }

    private workshopOpen(): boolean {
        const des = this.des();
        return !!des && safely(() => des.isWorkshopOpen(), false);
    }

    /** DES's modules (cached; a failed load is tried again next time). */
    private kit(): Promise<DesKit | null> {
        if (!this.kitPromise) {
            const pending = loadDesKit(this.app, this.log).catch((error: unknown) => {
                this.log.warn('prepare: DES modules could not be loaded', error);
                return null;
            });
            this.kitPromise = pending;
            void pending.then((kit) => {
                if (!kit && this.kitPromise === pending) this.kitPromise = null;
            });
        }
        return this.kitPromise;
    }

    /** DES keeps the roster per chat and this chat has its tracker state (else the roster is DES's global one). */
    private perChatRoster(): boolean {
        const des = this.des() as unknown as { rosterPerChat?(): boolean } | undefined;
        return safely(() => des?.rosterPerChat?.() === true, false);
    }

    /* ---------------------------------------------------------------- the document */

    private exclusive<T>(run: () => Promise<T>): Promise<T> {
        const next = this.chain.then(run, run);
        this.chain = next.catch(() => undefined);
        return next;
    }

    load(): Promise<DesSeedDoc> {
        const chatId = safely(() => this.app.host.chatId(), null);
        if (!chatId) return Promise.resolve(emptyDesDoc());
        if (this.doc && this.docChat === chatId) return Promise.resolve(this.doc);
        if (this.loading?.chatId === chatId) return this.loading.job;
        const job = (async () => {
            let raw: unknown = null;
            try {
                raw = await this.app.chat.get<Record<string, unknown>>(DES_DOC, () => ({}));
            } catch (error) {
                this.log.debug('prepare: the DES seeds did not load', error);
            }
            const doc = readDesDoc(raw);
            if (safely(() => this.app.host.chatId(), null) === chatId) {
                this.doc = doc;
                this.docChat = chatId;
            }
            return doc;
        })();
        const slot = { chatId, job };
        this.loading = slot;
        void job.finally(() => {
            if (this.loading === slot) this.loading = null;
        });
        return job;
    }

    private async save(doc: DesSeedDoc, chatId: string): Promise<void> {
        if (safely(() => this.app.host.chatId(), null) !== chatId) return;
        this.doc = doc;
        this.docChat = chatId;
        try {
            const ok = await this.app.chat.put(DES_DOC, clonePlan(doc) as unknown as Record<string, unknown>);
            if (!ok) this.log.warn('prepare: another tab wrote the DES seeds; this one is kept in memory');
        } catch (error) {
            this.log.warn('prepare: the DES seeds were not saved', error);
        }
    }

    /** The loaded document of the current chat (null before it is read; the read starts). */
    private current(): DesSeedDoc | null {
        const chatId = safely(() => this.app.host.chatId(), null);
        if (!chatId) return null;
        if (this.docChat === chatId && this.doc) return this.doc;
        void this.load().catch(() => null);
        return null;
    }

    /* ---------------------------------------------------------------- the chat */

    private chat(): STChatMessage[] {
        return safely(() => this.app.host.ctx().chat ?? [], [] as STChatMessage[]);
    }

    /** Only the greeting so far: the player has not written. */
    private pristine(): boolean {
        const chat = this.chat();
        const first = chat[0];
        return !!first && !first.is_user && !hasUserMessages(chat);
    }

    /** The seed of a swipe of message 0 (by its text, see seedSwipe). */
    private seedAt(doc: DesSeedDoc, first: STChatMessage, swipe: number): StoredSeed | undefined {
        return doc.seeds.find((seed) => seedSwipe(first, seed) === swipe);
    }

    /** The greeting message 0 shows now carries a prepared record (sync; false before the document is read). */
    seeded(): boolean {
        const doc = this.current();
        const first = this.chat()[0];
        if (!doc?.seeds.length || !first || first.is_user) return false;
        return !!this.seedAt(doc, first, shownSwipe(first));
    }

    /* ---------------------------------------------------------------- seeding */

    /**
     * Seeds the prepared greetings (the apply step, after every item). Null when there is nothing to do: DES absent or
     * off, nothing it shows, no prepared scene that needs a record.
     */
    async seed(request: SeedRequest): Promise<ItemOutcome | null> {
        const config = this.config();
        const chatId = safely(() => this.app.host.chatId(), null);
        if (!config || !seedsAnything(config) || !chatId) return null;
        const doc = await this.load();
        const fresh = new Set(request.fresh);
        const known = new Set(doc.seeds.map((seed) => seed.greeting));
        const targets = request.scenes.filter((scene) => fresh.has(scene.greeting) || !known.has(scene.greeting));
        if (!targets.length) return null;
        const outcome: ItemOutcome = {
            itemId: DES_ITEM,
            kind: 'des',
            title: this.t('m37.des.title'),
            done: [],
            skipped: [],
            failed: [],
            forCard: false,
        };
        if (!this.pristine()) {
            outcome.skipped.push(this.t('m37.des.started'));
            return outcome;
        }
        const card = currentCard(this.app);
        const character = card ? await loadCharacter(this.app, card).catch(() => null) : null;
        const view = cardView(character);
        const greetings = view ? [view.firstMessage, ...view.alternateGreetings] : [];
        const first = this.chat()[0]!;
        const mapping = greetingSwipes(first, greetings);
        const shown = shownSwipe(first);
        const persona = safely(() => this.app.host.ctx().name1, '');
        // The greeting on screen first: it is the one DES shows at once.
        const ordered = [...targets].sort(
            (a, b) => Number(mapping.indexOf(b.greeting) === shown) - Number(mapping.indexOf(a.greeting) === shown),
        );
        const prepared = await mapLimit(ordered, SEED_CONCURRENCY, async (scene): Promise<Prepared> => {
            const swipe = mapping.indexOf(scene.greeting);
            if (swipe < 0) return { scene, swipe, piece: '', composed: null, model: false };
            const raw = swipeTexts(first)[swipe] ?? greetings[scene.greeting] ?? '';
            const text = safely(() => this.app.host.ctx().substituteParams(raw), raw);
            const input = this.inputOf(scene, request.plan, text, persona, config);
            const answer = request.useModel ? await this.ask(input, config) : null;
            return {
                scene,
                swipe,
                piece: swipePiece(raw),
                composed: composeDesSeed(input, config, answer),
                model: !!answer,
            };
        });
        return this.exclusive(() => this.write(chatId, first, prepared, request, outcome));
    }

    /** The task's input for one greeting: the prepared scene and cast, Dramatis's start, the mechanics' stats. */
    inputOf(
        scene: StoredScene,
        plan: readonly AnyPrepareItem[],
        text: string,
        persona: string,
        config: DesSeedConfig,
    ): SeedInput {
        const self = normName(persona);
        const cast: SeedCast[] = [];
        const add = (raw: string, present: boolean): SeedCast | undefined => {
            const character = characterNamed(plan, raw);
            if (character?.data.persona) return undefined;
            const name = (character?.data.name || raw).trim();
            if (!name || normName(name) === self) return undefined;
            let member = cast.find((item) => normName(item.name) === normName(name));
            if (!member) {
                const relation = character?.data.relations.find(
                    (row) => normName(row.to) === self || characterNamed(plan, row.to)?.data.persona === true,
                );
                member = {
                    name,
                    present: false,
                    role: character?.data.role ?? '',
                    appearance: character?.data.appearance ?? '',
                    personality: character?.data.personality ?? '',
                    outfit: '',
                    relation: relation?.relation ?? '',
                    doing: '',
                    goal: '',
                    mood: '',
                    stats: [],
                };
                cast.push(member);
            }
            if (present) member.present = true;
            return member;
        };
        for (const name of scene.data.present) add(name, true);
        const start = safely(() => dramatisOf(this.app)?.startCast?.(scene.greeting) ?? [], []);
        for (const item of start) {
            const member = add(item.name, item.present);
            if (!member) continue;
            if (item.doing) member.doing = item.doing;
            if (item.goal) member.goal = item.goal;
            if (item.mood) member.mood = item.mood;
            if (typeof item.stance === 'number') {
                member.stance = { value: item.stance, label: item.stanceLabel ?? '', reason: item.reason ?? '' };
            }
        }
        for (const item of plan) {
            if (item.kind === 'character' && !item.data.persona) add(item.data.name, false);
        }
        for (const member of cast) {
            if (!member.present) continue;
            const character = characterNamed(plan, member.name);
            const names = new Set(
                [
                    member.name,
                    ...(character ? [character.data.name, character.data.english, ...character.data.forms] : []),
                ]
                    .map((name) => normName(name))
                    .filter(Boolean),
            );
            const outfit = scene.outfits.find((row) => names.has(normName(row.name)));
            member.outfit = outfit?.wearing ?? character?.data.outfit ?? '';
            member.stats = this.statsOf(member.name, config);
        }
        const ordered = [...cast.filter((member) => member.present), ...cast.filter((member) => !member.present)];
        const places = apiOf<PlacesApi>(this.app, 'places');
        const place = scene.data.place.trim()
            ? (safely(() => places?.resolve(scene.data.place)?.name, undefined) ?? scene.data.place.trim())
            : '';
        return {
            greeting: scene.greeting,
            text,
            language: storyLanguage(this.app),
            persona,
            scene: { place, date: scene.data.date, time: scene.data.time, situation: scene.data.situation },
            cast: ordered,
        };
    }

    /** DES stats the mechanics hold for a character (attributes tracked as DES stats, DES's stat names). */
    private statsOf(name: string, config: DesSeedConfig): { name: string; value: number }[] {
        if (!config.stats.length) return [];
        const api = apiOf<MechanicsApi>(this.app, 'mechanics');
        if (!api) return [];
        const defs = safely(() => api.active(), []);
        const out: { name: string; value: number }[] = [];
        for (const stat of config.stats) {
            for (const def of defs) {
                const attribute = desStatsAttributes(def).find((item) =>
                    [item.promptName, item.name, item.id].some(
                        (label) => !!label && normName(label) === normName(stat),
                    ),
                );
                if (!attribute) continue;
                const held = safely(() => api.value(def.id, name, attribute.id), null);
                let value = typeof held === 'number' && Number.isFinite(held) ? held : undefined;
                if (value === undefined && holdsName(def.holders, name)) {
                    const initial = initialValueOf(attribute);
                    if (typeof initial === 'number') value = initial;
                }
                if (value !== undefined) {
                    out.push({ name: stat, value });
                    break;
                }
            }
        }
        return out;
    }

    /** One model task per greeting; null when it cannot run or fails (the record is built from the cast then). */
    private async ask(input: SeedInput, config: DesSeedConfig): Promise<SeedAnswer | null> {
        const schema = desSeedSchema(config, input);
        if (!schema || !safely(() => this.app.llm.available(DES_SEED_TASK), false)) return null;
        try {
            const result = await this.app.llm.request({
                task: DES_SEED_TASK,
                messages: buildDesSeedMessages(input, config),
                maxTokens: SEED_MAX_TOKENS,
                temperature: 0.3,
                schema,
                interactive: true,
            });
            if (!result.ok) {
                this.log.warn(`prepare: DES seed of greeting ${input.greeting} failed`, result.error ?? '');
                return null;
            }
            return readDesSeedAnswer(result.data, input, config);
        } catch (error) {
            this.log.warn(`prepare: DES seed of greeting ${input.greeting} failed`, error);
            return null;
        }
    }

    private async write(
        chatId: string,
        first: STChatMessage,
        prepared: readonly Prepared[],
        request: SeedRequest,
        outcome: ItemOutcome,
    ): Promise<ItemOutcome> {
        const chat = this.chat();
        if (safely(() => this.app.host.chatId(), null) !== chatId || chat[0] !== first || !this.pristine()) {
            outcome.skipped.push(this.t('m37.des.started'));
            return outcome;
        }
        if (this.workshopOpen()) {
            outcome.failed.push(this.t('m37.des.workshop'));
            return outcome;
        }
        const kit = await this.kit();
        const doc = clonePlan(await this.load());
        const count = swipeTexts(first).length;
        const ref: SeedRef = {
            step: 'desSeed',
            chatId,
            before: [],
            written: [],
            last: kit?.startState().last ?? null,
            committed: kit?.startState().committed ?? null,
            roster: [],
            previous: [],
        };
        const writeSwipe = (swipe: number, record: DesSeedRecord) => {
            if (!ref.before.some((item) => item.swipe === swipe)) {
                const before = recordAt(first, swipe);
                ref.before.push({ swipe, record: before === undefined ? null : clonePlan(before) });
            }
            writeAt(first, swipe, record);
            ref.written = ref.written.filter((item) => item.swipe !== swipe);
            ref.written.push({ swipe, record: { ...record } });
        };
        const lines: string[] = [];
        const noModel: string[] = [];
        for (const item of prepared) {
            const title = sceneName(this.t.bind(this), item.scene.data);
            if (item.swipe < 0 || item.swipe >= count || !item.composed) {
                outcome.skipped.push(this.t('m37.des.noSwipe', { scene: title }));
                continue;
            }
            const composed = item.composed;
            if (isEmptyRecord(composed.record)) {
                outcome.skipped.push(this.t('m37.des.empty', { scene: title }));
                continue;
            }
            writeSwipe(item.swipe, composed.record);
            const previous = doc.seeds.find((seed) => seed.greeting === item.scene.greeting) ?? null;
            ref.previous.push({ greeting: item.scene.greeting, seed: previous ? clonePlan(previous) : null });
            const seed: StoredSeed = {
                greeting: item.scene.greeting,
                swipe: item.swipe,
                piece: item.piece,
                record: { ...composed.record },
                present: [...composed.present],
                names: [...composed.names],
                model: item.model,
                at: Date.now(),
            };
            doc.seeds = [...doc.seeds.filter((other) => other.greeting !== seed.greeting), seed].sort(
                (a, b) => a.greeting - b.greeting,
            );
            lines.push(
                composed.present.length
                    ? this.t('m37.des.scene', { scene: title, names: composed.present.join(', ') })
                    : this.t('m37.des.sceneOnly', { scene: title }),
            );
            if (request.useModel && !item.model) noModel.push(title);
        }
        if (!ref.written.length) return outcome;
        // Greetings without a prepared scene: an explicit empty record, so a swipe to one clears the previous cast.
        for (let swipe = 0; swipe < count; swipe++) {
            if (this.seedAt(doc, first, swipe) || recordAt(first, swipe) !== undefined) continue;
            writeSwipe(swipe, nullRecord());
        }
        const shownSeed = this.seedAt(doc, first, shownSwipe(first));
        if (!doc.rosterBefore) doc.rosterBefore = this.rosterNames(kit);
        if (kit && shownSeed) {
            kit.setStart(sectionsOf(shownSeed.record));
            ref.roster = this.syncRoster(kit, doc, shownSeed);
        }
        const portraits = shownSeed ? this.requestPortraits(doc, shownSeed.present) : [];
        doc.portraits = [...doc.portraits, ...portraits];
        await this.persist(kit);
        await this.save(doc, chatId);
        outcome.done.push(lines.join('; '));
        if (noModel.length) outcome.failed.push(this.t('m37.des.noModel', { scenes: noModel.join(', ') }));
        const change: JournalChange = {
            target: PREPARE_STEP_TARGET,
            ref: ref as unknown as Dict,
            before: null,
            after: {
                what: this.t('m37.des.part'),
                name: lines.join('; '),
                detail: ref.written.map((item) => JSON.stringify(item.record)).join('\n'),
            },
        };
        try {
            outcome.journalId = await this.app.journal.record({
                module: PREPARE_ID,
                kind: APPLY_KIND,
                summary: this.t('m37.journal.apply', { title: outcome.title, parts: lines.join('; ') }),
                changes: [change],
            });
        } catch (error) {
            this.log.warn('prepare: the DES seed was not journaled', error);
        }
        const names = shownSeed?.present ?? [];
        this.app.ui.notice(
            names.length
                ? this.t('m37.des.notice', { names: names.join(', ') })
                : this.t('m37.des.noticeScenes', { count: doc.seeds.length }),
            { importance: 'info' },
        );
        return outcome;
    }

    /** DES's save of the chat (its metadata rebuilt), else ST's own. */
    private async persist(kit: DesKit | null, index = 0): Promise<void> {
        try {
            if (kit) {
                kit.renderStart(index);
                await kit.save();
            } else {
                await this.app.host.ctx().saveChat();
            }
        } catch (error) {
            this.log.warn('prepare: the chat was not saved after the DES seed', error);
        }
    }

    /* ---------------------------------------------------------------- the roster and portraits */

    /** Names in DES's per-chat roster now (normalised); [] when DES keeps it globally. */
    private rosterNames(kit: DesKit | null): string[] {
        if (!kit || !this.perChatRoster()) return [];
        return Object.keys(kit.roster() ?? {})
            .map((name) => normName(name))
            .filter(Boolean);
    }

    /**
     * The roster for the shown greeting (per-chat rosters only, through DES's accessor): its present characters in,
     * names only other greetings brought (and that were not there before Maestro) out. The names it added.
     */
    private syncRoster(kit: DesKit, doc: DesSeedDoc, shown: StoredSeed | undefined): string[] {
        if (!this.perChatRoster() || this.workshopOpen()) return [];
        const roster = kit.roster();
        if (!roster) return [];
        const before = new Set(doc.rosterBefore ?? []);
        const keep = new Set((shown?.present ?? []).map((name) => normName(name)));
        const ours = new Set(doc.seeds.flatMap((seed) => seed.present).map((name) => normName(name)));
        let changed = false;
        for (const key of Object.keys(roster)) {
            const name = normName(key);
            if (ours.has(name) && !before.has(name) && !keep.has(name)) {
                delete roster[key];
                changed = true;
            }
        }
        const added: string[] = [];
        const emojis = new Map<string, string>();
        const data = safely(() => JSON.parse(shown?.record.characterThoughts ?? '[]') as unknown, []);
        for (const item of Array.isArray(data) ? data : []) {
            if (isDict(item) && typeof item.name === 'string') emojis.set(normName(item.name), str(item.emoji));
        }
        for (const name of shown?.present ?? []) {
            if (Object.keys(roster).some((key) => normName(key) === normName(name))) continue;
            roster[name] = { emoji: emojis.get(normName(name)) || '👤' };
            added.push(name);
            changed = true;
        }
        if (changed) kit.saveRoster();
        return added;
    }

    /** Takes names out of DES's per-chat roster (undo). */
    private dropFromRoster(kit: DesKit, names: readonly string[]): void {
        if (!names.length || !this.perChatRoster()) return;
        const roster = kit.roster();
        if (!roster) return;
        const wanted = new Set(names.map((name) => normName(name)));
        let changed = false;
        for (const key of Object.keys(roster)) {
            if (!wanted.has(normName(key))) continue;
            delete roster[key];
            changed = true;
        }
        if (changed) kit.saveRoster();
    }

    /**
     * NAI Studio draws the DES portraits of the present characters that have none yet (once per chat; never the card's
     * own character or the player's: NAI Studio uses their avatars). Returns the names asked for.
     */
    private requestPortraits(doc: DesSeedDoc, names: readonly string[]): string[] {
        const nai = safely(() => adaptersOf(this.app).nai, undefined) as
            | {
                  present?(): boolean;
                  canRequestDesPortrait?(): boolean;
                  requestDesPortrait?(name: string, options?: { reason?: string }): Promise<boolean>;
              }
            | undefined;
        if (!nai || typeof nai.requestDesPortrait !== 'function') return [];
        if (!safely(() => nai.present?.() !== false && nai.canRequestDesPortrait?.() !== false, false)) return [];
        const card = normName(currentCard(this.app)?.name ?? '');
        const persona = normName(safely(() => this.app.host.ctx().name1, ''));
        const asked = new Set(doc.portraits.map((name) => normName(name)));
        const settings = safely(() => this.des()?.settings() ?? null, null);
        const avatars = new Set(
            Object.keys(isDict(settings) && isDict(settings.npcAvatars) ? settings.npcAvatars : {}).map((name) =>
                normName(name),
            ),
        );
        const out: string[] = [];
        for (const name of names) {
            const key = normName(name);
            if (!key || key === card || key === persona || asked.has(key) || avatars.has(key)) continue;
            asked.add(key);
            out.push(name);
            void nai.requestDesPortrait(name, { reason: PORTRAIT_REASON }).catch((error: unknown) => {
                this.log.debug(`prepare: the portrait of ${name} was not requested`, error);
                return false;
            });
        }
        return out;
    }

    /* ---------------------------------------------------------------- DES wrote over the greeting */

    private onReceived(messageId: unknown): Promise<void> | void {
        if (Number(messageId) !== 0 || !this.pristine() || !this.available()) return;
        return this.exclusive(() => this.reseed()).catch((error: unknown) =>
            this.log.warn('prepare: the DES seeds were not put back', error),
        );
    }

    /**
     * The seeds go back where message 0 has no record (DES's empty record of the greeting, a rebuilt message after the
     * card was saved, a Continue): written at once — the save ST makes next takes them along — then shown again.
     */
    private async reseed(): Promise<void> {
        if (!this.pristine()) return;
        const chatId = safely(() => this.app.host.chatId(), null);
        const doc = this.docChat === chatId && this.doc ? this.doc : await this.load();
        if (!doc.seeds.length || !chatId) return;
        if (this.workshopOpen()) {
            this.retryLater();
            return;
        }
        const first = this.chat()[0];
        if (!first) return;
        let wrote = false;
        const count = swipeTexts(first).length;
        for (const seed of doc.seeds) {
            const swipe = seedSwipe(first, seed);
            if (swipe === undefined || !isEmptyRecord(recordAt(first, swipe))) continue;
            writeAt(first, swipe, seed.record);
            wrote = true;
        }
        for (let swipe = 0; swipe < count; swipe++) {
            if (this.seedAt(doc, first, swipe) || recordAt(first, swipe) !== undefined) continue;
            writeAt(first, swipe, nullRecord());
            wrote = true;
        }
        if (!wrote) return;
        const kit = await this.kit();
        const shown = this.seedAt(doc, first, shownSwipe(first));
        if (kit && shown) kit.setStart(sectionsOf(shown.record));
        // The records are in the chat now; DES's save and redraw need not hold ST's event.
        void this.persist(kit);
    }

    private retryLater(): void {
        if (this.retry || this.disposed) return;
        this.retry = setTimeout(() => {
            this.retry = null;
            if (this.disposed || this.retries++ >= RETRY_ROUNDS) {
                this.retries = 0;
                return;
            }
            if (this.workshopOpen()) {
                this.retryLater();
                return;
            }
            this.retries = 0;
            void this.exclusive(() => this.reseed()).catch(() => undefined);
        }, RETRY_MS);
    }

    private stopRetry(): void {
        if (this.retry) clearTimeout(this.retry);
        this.retry = null;
        this.retries = 0;
    }

    /* ---------------------------------------------------------------- the greeting swipe */

    private onSwiped(messageId: unknown): void {
        if (Number(messageId) !== 0 || !this.pristine() || !this.available()) return;
        void this.exclusive(() => this.follow()).catch((error: unknown) =>
            this.log.warn('prepare: DES did not follow the greeting', error),
        );
    }

    /**
     * The greeting on screen changed: its record (a seed, or the empty one) is what DES shows and generates from; the
     * roster follows; NAI Studio is asked for the portraits of new faces.
     */
    async follow(): Promise<void> {
        const chatId = safely(() => this.app.host.chatId(), null);
        const doc = clonePlan(await this.load());
        const first = this.chat()[0];
        if (!chatId || !doc.seeds.length || !first || !this.pristine()) return;
        if (this.workshopOpen()) return;
        const swipe = shownSwipe(first);
        const shown = this.seedAt(doc, first, swipe);
        if (shown && isEmptyRecord(recordAt(first, swipe))) writeAt(first, swipe, shown.record);
        const kit = await this.kit();
        if (kit) {
            kit.setStart(sectionsOf(shown?.record ?? nullRecord()));
            this.syncRoster(kit, doc, shown);
        }
        const portraits = shown ? this.requestPortraits(doc, shown.present) : [];
        await this.persist(kit);
        if (portraits.length) {
            doc.portraits = [...doc.portraits, ...portraits];
            await this.save(doc, chatId);
        }
    }

    /* ---------------------------------------------------------------- the first turn */

    private onStarted(type: unknown, dryRun: unknown): void {
        this.firstTurn = false;
        if (dryRun === true || String(type ?? 'normal') !== 'normal') return;
        const chat = this.chat();
        const visible = chat.filter((item) => !item.is_system);
        this.firstTurn = visible.length === 1 && chat[0] === visible[0] && !visible[0]?.is_user;
    }

    /**
     * The opening tracker for the first reply in DES's together mode (DES left its example out: no assistant message
     * preceded the player's when the generation started).
     */
    private produce(gen: GenerationInfo): void {
        const first = this.firstTurn;
        this.firstTurn = false;
        if (!first || gen.quiet || gen.dryRun || gen.sheetCommand || gen.type !== 'normal') return;
        const des = this.des();
        if (!des || !this.available() || safely(() => des.generationMode(), 'together') !== 'together') return;
        const config = this.config();
        if (!config) return;
        const chat = this.chat();
        const visible = chat.filter((item) => !item.is_system);
        const opening = chat[0];
        if (!opening || visible.length !== 2 || visible[0] !== opening || opening.is_user || !visible[1]?.is_user) {
            return;
        }
        if (!this.seeded()) return;
        const slot = safely(() => this.app.host.ctx().extensionPrompts?.[DES_INSTRUCTION_SLOT], undefined);
        if (slot && !str(slot.value).trim()) return;
        const example = desStartExample(recordAt(opening, shownSwipe(opening)), {
            quests: config.quests,
            infoBox: config.infoBox,
            characters: config.characters,
        });
        if (!example) return;
        this.app.ephemeral.setInjection(DES_INJECTION, {
            text: `${START_LEAD}\n${example}`,
            position: 1,
            depth: 1,
            role: 0,
            scan: false,
        });
    }

    /* ---------------------------------------------------------------- undo */

    /**
     * Takes a seed back: every swipe it wrote gets its previous record (one changed since — DES's own edit — stays),
     * the greetings get their previous seeds, DES shows what the greeting on screen holds now (else what it showed
     * before), the roster names it added leave. Not while the Workshop is open.
     */
    async undo(change: JournalChange): Promise<boolean> {
        const ref = change.ref as unknown as Partial<SeedRef>;
        if (ref.step !== 'desSeed' || !Array.isArray(ref.written)) return false;
        const chatId = safely(() => this.app.host.chatId(), null);
        if (!chatId || ref.chatId !== chatId) return false;
        if (this.workshopOpen()) {
            this.app.ui.notice(this.t('m37.des.undoWorkshop'), { level: 'warn', importance: 'important' });
            return false;
        }
        return this.exclusive(async () => {
            const first = this.chat()[0];
            if (!first) return false;
            for (const written of ref.written ?? []) {
                const now = recordAt(first, written.swipe);
                if (now !== undefined && !sameRecord(now, written.record) && !isEmptyRecord(now)) continue;
                const before = (ref.before ?? []).find((item) => item.swipe === written.swipe)?.record;
                writeAt(first, written.swipe, readRecord(before));
            }
            const doc = clonePlan(await this.load());
            for (const item of ref.previous ?? []) {
                const index = doc.seeds.findIndex((seed) => seed.greeting === item.greeting);
                const restored = item.seed ? readSeed(item.seed) : null;
                if (index >= 0) doc.seeds.splice(index, 1);
                if (restored) doc.seeds.push(restored);
            }
            doc.seeds.sort((a, b) => a.greeting - b.greeting);
            if (!doc.seeds.length) doc.rosterBefore = null;
            const kit = await this.kit();
            // Once the player has written, DES shows and generates from later replies: only the records go back.
            if (kit && this.pristine()) {
                const shown = recordAt(first, shownSwipe(first));
                if (!isEmptyRecord(shown)) kit.setStart(sectionsOf(shown));
                else kit.setStart(ref.last ?? sectionsOf(null), ref.committed ?? ref.last ?? sectionsOf(null));
                this.dropFromRoster(kit, ref.roster ?? []);
            }
            await this.persist(kit);
            await this.save(doc, chatId);
            return true;
        });
    }
}
