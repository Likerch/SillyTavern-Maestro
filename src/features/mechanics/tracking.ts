// M25 «Механики», the tracking part (plan M25 п. 4; §5; §10; P8, P14, P15): how changes are noticed.
// - when: a story reply is processed as soon as it is shown (reply:ready + a settle pause, leader tab only; release
//   1.25 — before, only at the user's next message, so the model and the HUD saw every change a turn late). Its
//   changes are provisional until the user answers: a swipe, a regeneration, a continuation or an edit takes them
//   back and the reply is processed again (a swipe back to an older variant too). The commit (turn:committed, P14)
//   stays as the safety net: what was not processed yet (DES's tracker of the separate mode, a missed tab) runs then;
//   a tab that becomes the leader processes the replies it skipped while another tab led (release 1.26: the latest
//   reply never stays unread because the leader changed while it arrived). Processing is idempotent per source;
// - 'auto' (release 1.26, the default): per attribute and holder — a character's (not the user's character's) number
//   DES keeps as a stat comes from DES; everything else (the user's character, scales, lists, texts, statuses, items)
//   from the service block, which the model then always writes (`<mechanics>none</mechanics>` when nothing changed).
//   A reply without a block record, or with an unreadable one (lines dropped, none read), is the safety net's: the
//   background parse reads its 'auto' attributes, statuses and items. A block that is there (even `none`) is
//   authoritative for them;
// - 'desStats': DES's tracker of the reply `characters[].stats` are read for the attributes DES keeps (stat name = the
//   attribute's prompt name, name or id, any case). Release 1.26: as changes, not absolute values — the difference to
//   the same character's stat in the latest earlier reply whose tracker has it (looking back up to DES_LOOKBACK
//   messages) is added to Maestro's value (source 'desStats'), so Maestro-side changes (roll costs, regeneration)
//   survive; without an earlier value the stat is set (first sight). enableDesStats() adds the attributes ('desStats'
//   and the 'auto' numbers of character mechanics) to DES's `trackerConfig.presentCharacters.characterStats` (the
//   user's own stats stay) through autonomy 'mechanics.desStats' (fallback 'ask', never auto), journaled with an undo
//   that takes back only what it added;
// - 'block': the model ends its reply with `<mechanics>…</mechanics>`. On MESSAGE_RECEIVED (last listener: after
//   NAI Studio's markers and DES's tracker parse, before CHARACTER_MESSAGE_RENDERED → reply:ready, so the quality
//   check never sees it) the block is parsed (repairs in the domain), the lines are kept in
//   `extra.maestro_mechanics` of the message and its swipe (with the swipe id, `none` and the story minutes of a
//   `time: +3h` line), and the block leaves the stored text and the render. A display hook of ST's message formatter
//   hides it while it streams. Leftover blocks of older replies never reach the prompt (CHAT_COMPLETION_PROMPT_READY,
//   assistant messages only — the block instruction itself is a system message);
// - 'background': when a mechanic in the scene has background attributes (or DES-stat attributes DES does not track
//   yet, or 'auto' ones of a reply without a block), one cheap task 'mechanics.extract' with a strict JSON schema
//   reads the reply with the user's action before it and who «you» is (under the background cost cap) → validated
//   edits → autonomy 'mechanics.change' (fallback 'auto') → state.apply;
// - the block also carries statuses (`Kai.status += Poisoned (3 turns)`), items (`Kai.items += rope x2`), roll requests
//   (`roll: Stealth Kai vs Guard.Perception adv`, rolled by the checks part as soon as the reply arrives), fights
//   (`combat: start|enemy|out|end`, run by the combat part with the other changes) and story time (`time: +30m`,
//   asked only when hour / day rules or timed statuses are in the scene and DES gives no time);
// - the user's character: DES does not list {{user}}, so his DES-stat attributes are read by the background parse (or
//   the block, settings.personaFallback); his 'auto' ones by the block;
// - after the tracking of a reply its turn runs (state.processTurn: the clock — DES's time, else the block's or the
//   parse's minutes —, statuses, time rules, rounds). A duration «until sunset» that cannot be placed without a real
//   clock lasts UNTIL_FALLBACK_TURNS turns;
// - «Пересчитать» (recount, release 1.26): the reply's tracked changes are taken back and it is read again, the
//   background parse included (its dedupe cleared). Reading a readable block again would only repeat it, so when the
//   parse can run it reads the reply's 'auto' attributes, statuses and items afresh instead of the block (the record
//   is marked `recounted` and the chat saved: no later pass counts both).
// health() says what keeps the values from following the story (no profile, the cap, DES stats not set up, another
// tab, a failed parse): the HUD's ⚠ — a warning when the background parse is the only way, a note when it is only the
// safety net of 'auto'.
import { adaptersOf } from '../../adapters';
import { parseDueExpression, resolveDue } from '../../domain/calendar-time';
import {
    hasBlockMarker,
    parseBlock,
    resolveBlock,
    stripBlock,
    blockInstruction as buildBlockInstruction,
} from '../../domain/mechanics-block';
import type { BlockCombat, BlockItem, BlockRoll } from '../../domain/mechanics-block';
import {
    desStatCandidates,
    desStatsAttributes,
    holdsCharacters,
    initialValueOf,
    trackingOf,
} from '../../domain/mechanics-defs';
import type { AttributeDef, StatusDuration } from '../../domain/mechanics-defs';
import {
    buildExtractMessages,
    EXTRACT_SCHEMA_NAME,
    extractSchemaFor,
    parseExtractAnswer,
} from '../../domain/mechanics-extract';
import type { ExtractItem, ExtractStatus, ExtractTarget } from '../../domain/mechanics-extract';
import { itemsText } from '../../domain/mechanics-status';
import { playerSees, resolveVisibility } from '../../domain/mechanics-visibility';
import {
    editsToChanges,
    findAttribute,
    formatValue,
    nameKey,
    previewChange,
    resolveHolder,
    toNumber,
    WORLD_HOLDER,
} from '../../domain/mechanics-state';
import type { Edit } from '../../domain/mechanics-state';
import { committedIndices } from '../../domain/places-registry';
import { cleanForAnalysis } from '../../domain/text-clean';
import { rerenderMessage } from '../../host/messages';
import type { App, JournalChange, Proposal, TaskInfo, Unsubscribe } from '../../shared/contracts';
import type { AttributeValue, MechanicDef, TrackingProblem } from './api';
import { MECHANICS_ID } from './parts';
import type { ChangeInput, DefinitionsPart, PartDeps, StateOp, StatePart, TrackingPart } from './parts';
import { holderContextOf, isDict, personaOf, swipeIdOf } from './state-holders';
import { VALUE_UNDO_TARGET } from './state';

/** Maestro's record of the parsed service block on a chat message (and its swipe). */
export const EXTRA_KEY = 'maestro_mechanics';
export const EXTRACT_TASK = 'mechanics.extract';
export const CHANGE_KIND = 'mechanics.change';
export const DES_STATS_KIND = 'mechanics.desStats';
export const DES_STATS_UNDO_TARGET = 'mechanics.desStats';

const SETTLE_MS = 500;
const EXTRACT_TTL_MS = 10 * 60 * 1000;
/** Release 1.26: room for the action, the longer rules and the elapsed time (700 cut answers short). */
const EXTRACT_MAX_TOKENS = 1200;
/** Messages looked back for a character's earlier DES stat (its change is the difference). */
const DES_LOOKBACK = 40;
/** Messages looked back for the latest DES time (does DES give the story clock now?). */
const DES_TIME_LOOKBACK = 10;
/** «Until sunset» without a real clock to place it on: it lasts this many turns instead of forever. */
export const UNTIL_FALLBACK_TURNS = 8;
/** Changes of the log looked at to tell whether a reply was processed. */
const HISTORY_LOOKUP = 1000;
/** MESSAGE_RECEIVED types that are no story reply of the model. */
const FOREIGN_TYPES: ReadonlySet<string> = new Set(['impersonate', 'first_message', 'extension', 'quiet', 'command']);
/** MESSAGE_RECEIVED types that add to the reply already there. */
const APPEND_TYPES: ReadonlySet<string> = new Set(['continue', 'append', 'appendFinal']);

export interface BlockRecord {
    v: 1;
    swipeId: number;
    items: BlockItem[];
    repaired?: string[];
    /** Lines that could not be read. */
    dropped?: number;
    at: number;
    /** Rolls the model asked for (rolled on arrival). */
    rolls?: BlockRoll[];
    /** Fight lines (run at the commit). */
    combat?: BlockCombat[];
    /** The model wrote that nothing changed (`<mechanics>none</mechanics>`, release 1.26). */
    none?: true;
    /** Story minutes the block says pass (`time: +3h`, release 1.26). */
    elapsed?: number;
    /**
     * «Пересчитать» handed the reply's 'auto' attributes, statuses and items to the background parse (release 1.26):
     * the block's lines for them are no longer applied (the parse would count them twice).
     */
    recounted?: true;
}

/**
 * The record says nothing: lines were dropped and none was read (nor a roll, a fight, the time or «none»). Such a
 * reply is the background parse's like a reply without a block (release 1.26).
 */
export function unreadableRecord(record: BlockRecord): boolean {
    return (
        !record.none &&
        !record.items.length &&
        (record.dropped ?? 0) > 0 &&
        !record.rolls?.length &&
        !record.combat?.length &&
        record.elapsed === undefined
    );
}

export interface DesStat {
    id: string;
    name: string;
    enabled: boolean;
}

interface CharacterStats {
    enabled: boolean;
    customStats: DesStat[];
}

/** Inbox payload of background changes (JSON): values, and the statuses and items the reply gave or took. */
export interface ChangePayload {
    m25: 1;
    messageIndex: number;
    swipeId: number;
    changes: ChangeInput[];
    ops?: StateOp[];
}

/** Inbox payload of the DES stats (JSON): stats to add or switch on, merged into DES's list when applied. */
export interface DesStatsPayload {
    m25: 1;
    mechanicId: string;
    stats: { id: string; name: string }[];
}

export interface TrackingOptions {
    /** Pause between the send (turn:committed) and reading the committed reply: keeps it off the send path. */
    settleMs?: number;
}

/** What the tracking reads of the DES adapter's tracker of a reply. */
interface DesSnapshot {
    characters: { name: string; stats: { name: string; value: number | string }[] }[];
    infoBox?: { date?: string; time?: { start?: string; end?: string } } | null;
}

/** What the tracking reads of the DES adapter (duck-typed: fakes in tests, older adapters). */
interface DesLike {
    present(): boolean;
    settings?(): Record<string, unknown> | null;
    trackerFor?(index: number): DesSnapshot | null;
    setCharacterStats?(next: DesStat[], options?: { enable?: boolean }): boolean;
    isWorkshopOpen?(): boolean;
}

/** ST's message formatter hooks cannot be removed: one hook per formatter, active while a tracking part runs. */
const DISPLAY_HOOKS = new WeakMap<object, { active: number }>();

/** The block record of a message for its current swipe; null without one. */
export function readBlockRecord(message: STChatMessage | null | undefined): BlockRecord | null {
    if (!message) return null;
    const swipeId = swipeIdOf(message);
    const info = Array.isArray(message.swipe_info) ? (message.swipe_info[swipeId] as unknown) : undefined;
    const candidates = [
        message.extra?.[EXTRA_KEY],
        isDict(info) && isDict(info.extra) ? info.extra[EXTRA_KEY] : undefined,
    ];
    for (const raw of candidates) {
        if (!isDict(raw) || raw.swipeId !== swipeId || !Array.isArray(raw.items)) continue;
        const items = raw.items.filter(
            (item): item is BlockItem =>
                isDict(item) &&
                typeof item.holder === 'string' &&
                typeof item.attribute === 'string' &&
                ['set', 'add', 'sub', 'mul'].includes(String(item.op)) &&
                (typeof item.value === 'string' || typeof item.value === 'number'),
        );
        const record: BlockRecord = { v: 1, swipeId, items, at: typeof raw.at === 'number' ? raw.at : 0 };
        if (Array.isArray(raw.repaired))
            record.repaired = raw.repaired.filter((item): item is string => typeof item === 'string');
        if (typeof raw.dropped === 'number') record.dropped = raw.dropped;
        if (raw.none === true) record.none = true;
        if (raw.recounted === true) record.recounted = true;
        if (typeof raw.elapsed === 'number' && Number.isFinite(raw.elapsed) && raw.elapsed > 0)
            record.elapsed = raw.elapsed;
        if (Array.isArray(raw.rolls)) {
            record.rolls = raw.rolls.filter(
                (item): item is BlockRoll =>
                    isDict(item) && typeof item.head === 'string' && typeof item.line === 'string',
            );
        }
        if (Array.isArray(raw.combat)) {
            record.combat = raw.combat.filter(
                (item): item is BlockCombat =>
                    isDict(item) &&
                    ['start', 'end', 'enemy', 'out'].includes(String(item.action)) &&
                    Array.isArray(item.names),
            );
        }
        return record;
    }
    return null;
}

/** Writes the record on the message and on its current swipe (ST copies `swipe_info[i].extra` back on swipes). */
export function writeBlockRecord(message: STChatMessage, record: BlockRecord): void {
    const extra = isDict(message.extra) ? message.extra : (message.extra = {});
    extra[EXTRA_KEY] = record;
    const info = Array.isArray(message.swipe_info) ? (message.swipe_info[record.swipeId] as unknown) : undefined;
    if (isDict(info)) {
        const infoExtra = isDict(info.extra) ? info.extra : (info.extra = {});
        infoExtra[EXTRA_KEY] = structuredClone(record);
    }
}

/** Replaces the text of a message and of its current swipe (ST keeps them equal). */
function setMessageText(message: STChatMessage, text: string): void {
    message.mes = text;
    const swipeId = swipeIdOf(message);
    if (Array.isArray(message.swipes) && swipeId < message.swipes.length) message.swipes[swipeId] = text;
}

function sameStat(a: { id?: string; name: string }, b: { id?: string; name: string }): boolean {
    return (!!a.id && a.id === b.id) || nameKey(a.name) === nameKey(b.name);
}

function statMatches(statName: string, attr: AttributeDef): boolean {
    const key = nameKey(statName);
    return [attr.promptName, attr.name, attr.id].some((name) => !!name && nameKey(name) === key);
}

function statsOf(raw: unknown): CharacterStats {
    const dict = isDict(raw) ? raw : {};
    const list = Array.isArray(dict.customStats) ? dict.customStats : [];
    return {
        enabled: dict.enabled === true,
        customStats: list
            .filter(isDict)
            .filter((item) => typeof item.name === 'string' && item.name.trim())
            .map((item) => ({
                id: typeof item.id === 'string' && item.id ? item.id : String(item.name),
                name: String(item.name),
                enabled: item.enabled !== false,
            })),
    };
}

function isChangePayload(value: unknown): value is ChangePayload {
    return (
        isDict(value) &&
        value.m25 === 1 &&
        typeof value.messageIndex === 'number' &&
        typeof value.swipeId === 'number' &&
        Array.isArray(value.changes)
    );
}

function isDesStatsPayload(value: unknown): value is DesStatsPayload {
    return isDict(value) && value.m25 === 1 && typeof value.mechanicId === 'string' && Array.isArray(value.stats);
}

/** Fight lines of a committed reply's block (the combat part runs them). */
export type CombatLinesListener = (index: number, lines: BlockCombat[]) => Promise<void> | void;

export class MechanicTracking implements TrackingPart {
    private readonly offs: Unsubscribe[] = [];
    private readonly rollListeners = new Set<(index: number, swipeId: number, rolls: BlockRoll[]) => void>();
    private readonly combatListeners = new Set<CombatLinesListener>();
    private queue: Promise<unknown> = Promise.resolve();
    private timer: ReturnType<typeof setTimeout> | null = null;
    private pending = new Set<number>();
    /** Replies this tab did not read because another tab was the leader then (read when it becomes the leader). */
    private readonly missed = new Set<number>();
    /** Background parses enqueued in this page session (chat|message|swipe). */
    private readonly enqueued = new Set<string>();
    /** Bumped on chat change: work of the previous chat stops. */
    private generation = 0;
    private disposed = false;
    private readonly settleMs: number;
    /** The latest background parse failed (cleared by the next one that works): the HUD's ⚠. */
    private extractError: string | null = null;
    private readonly healthListeners = new Set<() => void>();
    /** A swipe back to a variant already there: processed once no generation follows. */
    private swipeTimer: ReturnType<typeof setTimeout> | null = null;

    constructor(
        private readonly deps: PartDeps,
        private readonly defs: DefinitionsPart,
        private readonly state: StatePart,
        options: TrackingOptions = {},
    ) {
        this.settleMs = options.settleMs ?? SETTLE_MS;
    }

    private get app(): App {
        return this.deps.app;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.app.i18n.t(key, params);
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(): void {
        const { app } = this;
        // Journal records outlive the module: undo keeps working when it is off.
        app.journal.registerUndo(DES_STATS_UNDO_TARGET, (change) => this.undoDesStats(change));
        try {
            app.autonomy.neverAuto(DES_STATS_KIND);
        } catch (error) {
            this.deps.log.debug('mechanics: neverAuto is not available', error);
        }
        this.offs.push(
            app.inbox.registerApplier(CHANGE_KIND, (payload) => this.applyChangePayload(payload)),
            app.inbox.registerApplier(DES_STATS_KIND, (payload) => this.applyDesStatsPayload(payload)),
            app.tasks.register(EXTRACT_TASK, (payload, info) => this.runExtract(payload, info)),
            app.bus.on('turn:committed', ({ messageIndex }) => this.onCommitted(messageIndex)),
            app.bus.on('reply:ready', ({ messageIndex, type }) => {
                this.takeBlock(messageIndex, false);
                this.onReplyReady(messageIndex, type);
            }),
            app.bus.on('message:invalidated', ({ messageIndex, reason, removedAt }) =>
                this.onInvalidated(messageIndex, reason, removedAt),
            ),
            app.bus.on('chat:changed', () => this.onChatChanged()),
        );
        // Release 1.26: a tab that becomes the leader reads the latest reply (another tab was the leader when it came).
        try {
            this.offs.push(
                app.leader.onChange((leader) => {
                    if (leader) this.onLeader();
                }),
            );
        } catch (error) {
            this.deps.log.debug('mechanics: leader changes are not available', error);
        }
        this.onSt(
            'MESSAGE_RECEIVED',
            (messageId, type) => {
                const kind = String(type ?? '') || 'normal';
                if (!FOREIGN_TYPES.has(kind)) this.takeBlock(Number(messageId), APPEND_TYPES.has(kind), false);
            },
            'last',
        );
        this.onSt('MESSAGE_EDITED', (messageId) => {
            this.takeBlock(Number(messageId), false, false);
        });
        this.onSt('CHAT_COMPLETION_PROMPT_READY', (data) => this.onPromptReady(data));
        this.installDisplayHook();
    }

    dispose(): void {
        if (this.disposed) return;
        this.disposed = true;
        this.generation++;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (this.swipeTimer !== null) clearTimeout(this.swipeTimer);
        this.swipeTimer = null;
        this.pending.clear();
        this.healthListeners.clear();
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.log.debug('mechanics tracking: unsubscribe failed', error);
            }
        }
    }

    onRollRequests(listener: (index: number, swipeId: number, rolls: BlockRoll[]) => void): Unsubscribe {
        this.rollListeners.add(listener);
        return () => this.rollListeners.delete(listener);
    }

    onCombatLines(listener: CombatLinesListener): Unsubscribe {
        this.combatListeners.add(listener);
        return () => this.combatListeners.delete(listener);
    }

    private onSt(key: string, handler: (...args: unknown[]) => unknown, order?: 'last'): void {
        const name = this.app.host.events.name(key);
        if (!name) {
            this.deps.log.debug(`mechanics: ST event ${key} is missing`);
            return;
        }
        this.offs.push(this.app.host.events.on(name, handler, order ? { order } : undefined));
    }

    private onChatChanged(): void {
        this.generation++;
        if (this.timer !== null) clearTimeout(this.timer);
        this.timer = null;
        if (this.swipeTimer !== null) clearTimeout(this.swipeTimer);
        this.swipeTimer = null;
        this.pending.clear();
        this.missed.clear();
        this.enqueued.clear();
        this.setExtractError(null);
    }

    private enqueue<R>(job: () => Promise<R>): Promise<R> {
        const next = this.queue.then(job, job);
        this.queue = next.catch(() => undefined);
        return next;
    }

    private des(): DesLike | null {
        try {
            const des = adaptersOf(this.app).des as unknown as DesLike | undefined;
            return des && des.present() ? des : null;
        } catch {
            return null;
        }
    }

    private activeDefs(): MechanicDef[] {
        try {
            return this.defs.active();
        } catch (error) {
            this.deps.log.debug('mechanics: definitions are not readable', error);
            return [];
        }
    }

    private isLeader(): boolean {
        try {
            return this.app.leader.isLeader();
        } catch {
            return false;
        }
    }

    /* ---------------------------------------------------------------- the service block: arrival */

    /**
     * Parses and strips the block of a reply (arrival, edit, the reply:ready safety net). `merge`: a continuation adds
     * its lines to the record of the same swipe. `announce`: the re-render is followed by MESSAGE_UPDATED, so the
     * neighbours that decorate the text (DES speaker cards) redo it — not on arrival (CHARACTER_MESSAGE_RENDERED
     * follows) and not on an edit (ST re-renders and announces after MESSAGE_EDITED). True when a block was taken.
     */
    takeBlock(index: number, merge: boolean, announce = true): boolean {
        if (this.disposed || !Number.isInteger(index) || index < 0) return false;
        const ctx = this.app.host.ctx();
        const message = ctx.chat[index];
        if (!message || message.is_user || typeof message.mes !== 'string' || !hasBlockMarker(message.mes))
            return false;
        const parsed = parseBlock(message.mes);
        if (!parsed.found) return false;
        const stripped = stripBlock(message.mes);
        const swipeId = swipeIdOf(message);
        const previous = merge ? readBlockRecord(message) : null;
        const record: BlockRecord = {
            v: 1,
            swipeId,
            items: [...(previous?.items ?? []), ...parsed.items],
            at: Date.now(),
        };
        if (parsed.repaired.length) record.repaired = parsed.repaired;
        if (parsed.dropped.length) record.dropped = parsed.dropped.length;
        const rolls = [...(previous?.rolls ?? []), ...parsed.rolls];
        if (rolls.length) record.rolls = rolls;
        const combat = [...(previous?.combat ?? []), ...parsed.combat];
        if (combat.length) record.combat = combat;
        const elapsed = (previous?.elapsed ?? 0) + (parsed.elapsed ?? 0);
        if (elapsed > 0) record.elapsed = elapsed;
        // «Nothing changed» holds while the block (with a continuation's) says nothing else.
        if ((parsed.none || previous?.none) && !record.items.length && !rolls.length && !combat.length && !elapsed) {
            if (!parsed.dropped.length) record.none = true;
        }
        setMessageText(message, stripped);
        writeBlockRecord(message, record);
        if (parsed.rolls.length) {
            for (const listener of [...this.rollListeners]) {
                try {
                    listener(index, swipeId, parsed.rolls);
                } catch (error) {
                    this.deps.log.warn('mechanics: a roll request failed', error);
                }
            }
        }
        void rerenderMessage(this.app.host, index, message, { announce, log: this.deps.log });
        if (parsed.repaired.length) this.deps.log.debug(`mechanics: block of #${index} repaired`, parsed.repaired);
        if (parsed.dropped.length) {
            this.deps.log.debug(`mechanics: ${parsed.dropped.length} block lines of #${index} dropped`, parsed.dropped);
            const key = parsed.items.length ? 'm25.track.block.partial' : 'm25.track.block.dropped';
            this.app.ui.notice(this.t(key, { index, count: parsed.dropped.length }), { level: 'warn' });
        }
        return true;
    }

    /** Leftover blocks of older replies never reach the model (assistant messages only). */
    private onPromptReady(data: unknown): void {
        if (this.disposed || !isDict(data) || !Array.isArray(data.chat)) return;
        for (const message of data.chat) {
            if (!isDict(message) || message.role !== 'assistant') continue;
            const content = message.content;
            if (typeof content === 'string') {
                if (hasBlockMarker(content)) {
                    const next = stripBlock(content);
                    if (next !== content) message.content = next;
                }
            } else if (Array.isArray(content)) {
                for (const part of content) {
                    if (!isDict(part) || typeof part.text !== 'string' || !hasBlockMarker(part.text)) continue;
                    const next = stripBlock(part.text);
                    if (next !== part.text) part.text = next;
                }
            }
        }
    }

    /** Hides a block while it streams (ST renders the text before MESSAGE_RECEIVED). */
    private installDisplayHook(): void {
        let formatter: { addHook?: unknown } | undefined;
        try {
            formatter = this.app.host.ctx().messageFormatter as { addHook?: unknown } | undefined;
        } catch {
            formatter = undefined;
        }
        if (!formatter || typeof formatter.addHook !== 'function') return;
        if (!this.app.host.caps.has('st.messageFormatter')) return;
        let state = DISPLAY_HOOKS.get(formatter);
        if (!state) {
            const created = { active: 0 };
            // beforeRegex: the user's regexes never see the block. A plain function: ST rejects async hooks.
            (formatter.addHook as (hook: (mes: string, info: unknown) => string, options: { stage: string }) => void)(
                function maestroMechanicsBlock(mes: string, info: unknown): string {
                    if (created.active <= 0 || typeof mes !== 'string') return mes;
                    if (isDict(info) && (info.isUser === true || info.isReasoning === true)) return mes;
                    return stripBlock(mes, { partial: true });
                },
                { stage: 'beforeRegex' },
            );
            DISPLAY_HOOKS.set(formatter, created);
            state = created;
        }
        const current = state;
        current.active++;
        this.offs.push(() => {
            current.active = Math.max(0, current.active - 1);
        });
    }

    /* ---------------------------------------------------------------- arrival and commit */

    /**
     * A story reply is shown: its changes go into the values now (release 1.25), provisional until the user answers.
     * A continuation changed the text of a reply already processed: its changes are taken back and derived again.
     */
    private onReplyReady(index: number, type: string): void {
        if (this.disposed || !Number.isInteger(index) || index < 0 || FOREIGN_TYPES.has(type)) return;
        const message = this.app.host.ctx().chat[index];
        if (!message || message.is_user || message.is_system) return;
        if (APPEND_TYPES.has(type)) {
            void this.reread(index);
            return;
        }
        this.schedule(index);
    }

    private onCommitted(index: number): void {
        if (this.disposed || !Number.isInteger(index) || index < 0) return;
        this.schedule(index);
    }

    /** The changes of a continued reply are taken back (the state) and the reply is processed again. */
    private async reread(index: number): Promise<void> {
        this.forget(index);
        try {
            await this.state.retrack?.(index);
        } catch (error) {
            this.deps.log.warn('mechanics: the changes of a continued reply were not taken back', error);
        }
        this.schedule(index);
    }

    /** Saves the chat (a block record changed outside ST's own saves); not while a reply is generated. */
    private async saveChat(): Promise<void> {
        try {
            if (this.app.turn.current() !== null) return;
            await this.app.host.ctx().saveChat?.();
        } catch (error) {
            this.deps.log.debug('mechanics: the chat was not saved', error);
        }
    }

    /** The background parse of a reply may be enqueued again. */
    private forget(index: number): void {
        const chatId = this.app.host.chatId() ?? '';
        for (const key of [...this.enqueued]) if (key.startsWith(`${chatId}|${index}|`)) this.enqueued.delete(key);
    }

    /** The latest story reply of the chat (-1: none). */
    private latestReply(): number {
        const chat = this.app.host.ctx().chat ?? [];
        for (let i = chat.length - 1; i >= 0; i--) {
            const message = chat[i];
            if (message && !message.is_user && !message.is_system) return i;
        }
        return -1;
    }

    /**
     * This tab became the leader: the replies it skipped while another tab led are read now — the latest one first of
     * all (idempotent per source: what the other tab took already is not taken twice). Only those: the election on
     * every chat open must not read the latest reply of each chat again.
     */
    private onLeader(): void {
        if (this.disposed || !this.missed.size) return;
        const chat = this.app.host.ctx().chat ?? [];
        const latest = this.latestReply();
        const indexes = [...this.missed].filter((index) => {
            const message = chat[index];
            return index <= latest && !!message && !message.is_user && !message.is_system;
        });
        this.missed.clear();
        for (const index of indexes) this.schedule(index);
    }

    /**
     * «Пересчитать ход» (release 1.26): the reply's tracked changes are taken back and it is read again — the block
     * record, DES, and the background parse (its dedupe cleared, so it runs again). False when it is not a story reply
     * of the model, this tab is not the leader, or the chat changed meanwhile.
     */
    async recount(index: number): Promise<boolean> {
        if (this.disposed || !Number.isInteger(index) || index < 0) return false;
        const message = this.app.host.ctx().chat?.[index];
        if (!message || message.is_user || message.is_system || typeof message.mes !== 'string') return false;
        if (!this.isLeader() || !this.app.host.chatId()) return false;
        const generation = this.generation;
        this.forget(index);
        this.pending.delete(index);
        // A reply with a readable block would read the same again: when the background parse can run, it reads the
        // reply's 'auto' attributes afresh instead of the block (marked on the record, so no later pass counts both).
        const record = readBlockRecord(message);
        if (record && !record.recounted && !unreadableRecord(record) && this.deps.settings().background) {
            if (this.canSpend()) {
                record.recounted = true;
                writeBlockRecord(message, record);
                await this.saveChat();
            }
        }
        try {
            await this.state.retrack?.(index);
        } catch (error) {
            this.deps.log.warn('mechanics: the changes of a recounted reply were not taken back', error);
            return false;
        }
        if (generation !== this.generation) return false;
        await this.enqueue(() => this.processCommitted(index, generation, true));
        return generation === this.generation;
    }

    /**
     * The latest story reply whose changes are in the values while the user has not answered it yet (-1: none). A swipe,
     * a regeneration or an edit takes them back.
     */
    provisionalIndex(): number {
        const chat = this.app.host.ctx().chat ?? [];
        const index = chat.length - 1;
        const message = chat[index];
        if (!message || message.is_user || message.is_system) return -1;
        try {
            return this.state
                .history(HISTORY_LOOKUP)
                .some((change) => change.messageIndex === index && change.source !== 'user')
                ? index
                : -1;
        } catch {
            return -1;
        }
    }

    private schedule(index: number): void {
        this.pending.add(index);
        if (this.timer !== null) clearTimeout(this.timer);
        const generation = this.generation;
        this.timer = setTimeout(() => {
            this.timer = null;
            const indexes = [...this.pending].sort((a, b) => a - b);
            this.pending.clear();
            if (generation !== this.generation) return;
            for (const pending of indexes) {
                void this.enqueue(() => this.processCommitted(pending, generation)).catch((error: unknown) =>
                    this.deps.log.error('mechanics: a committed reply could not be processed', error),
                );
            }
        }, this.settleMs);
    }

    /** `force`: «Пересчитать» — the background parse runs even when this page enqueued it for the reply already. */
    private async processCommitted(index: number, generation: number, force = false): Promise<void> {
        if (generation !== this.generation || this.disposed) return;
        if (!this.isLeader()) {
            // Another tab leads: it reads the reply; should this tab become the leader first, it reads it then.
            this.missed.add(index);
            return;
        }
        const message = this.app.host.ctx().chat[index];
        if (!message || message.is_user || message.is_system) return;
        // A block still in the text: it arrived while the module was off.
        if (typeof message.mes === 'string' && hasBlockMarker(message.mes)) this.takeBlock(index, false);
        const defs = this.activeDefs();
        if (!defs.length) return;
        await this.stateReady();
        if (generation !== this.generation) return;
        const done = new Set(
            this.state
                .history(HISTORY_LOOKUP)
                .filter((change) => change.messageIndex === index)
                .map((change) => change.source),
        );
        const desStats = this.desStatus();
        if (!done.has('desStats')) {
            const changes = this.desStatsChanges(defs, index, desStats);
            if (changes.length) await this.state.apply(changes);
        }
        if (!done.has('block') && generation === this.generation) {
            const ops = this.blockOps(defs, message, index);
            if (ops.length) await this.applyOps(ops);
            const lines = readBlockRecord(message)?.combat ?? [];
            if (lines.length) await this.runCombatLines(index, lines);
        }
        if (!done.has('background') && generation === this.generation) {
            await this.maybeExtract(defs, index, message, desStats, force);
        }
        if (generation === this.generation) {
            // The block's story time moves the clock when DES gives none for the reply (the state checks).
            const elapsed = readBlockRecord(message)?.elapsed;
            try {
                await this.state.processTurn?.(index, elapsed ? { elapsed } : {});
            } catch (error) {
                this.deps.log.warn('mechanics: the turn could not be processed', error);
            }
        }
    }

    /** Values through apply() (fakes of the stage-11 contract), everything else through applyOps(). */
    private async applyOps(ops: StateOp[]): Promise<void> {
        const values = ops.filter((op): op is ChangeInput => op.kind === undefined || op.kind === 'value');
        if (this.state.applyOps) await this.state.applyOps(ops);
        else if (values.length) await this.state.apply(values);
    }

    private async runCombatLines(index: number, lines: BlockCombat[]): Promise<void> {
        for (const listener of [...this.combatListeners]) {
            try {
                await listener(index, lines);
            } catch (error) {
                this.deps.log.warn('mechanics: the fight lines failed', error);
            }
        }
    }

    /** The state's queued writes are done and its document is loaded (the change log tells what was processed). */
    private async stateReady(): Promise<void> {
        const state = this.state as Partial<{ settled(): Promise<void>; load(): Promise<unknown> }>;
        try {
            await state.settled?.();
            await state.load?.();
        } catch (error) {
            this.deps.log.debug('mechanics: the state is not ready', error);
        }
    }

    /* ---------------------------------------------------------------- DES stats */

    /** DES's character stats config (copy); null when DES is not available. */
    private characterStats(des: DesLike | null = this.des()): CharacterStats | null {
        if (!des || typeof des.settings !== 'function') return null;
        const settings = des.settings();
        const tracker = isDict(settings?.trackerConfig) ? settings.trackerConfig : {};
        const present = isDict(tracker.presentCharacters) ? tracker.presentCharacters : {};
        return statsOf(present.characterStats);
    }

    /** Names (matching form) of the stats DES asks the model for now; empty when off or DES is not available. */
    private desStatus(): Set<string> {
        const stats = this.characterStats();
        if (!stats?.enabled) return new Set();
        return new Set(stats.customStats.filter((stat) => stat.enabled).map((stat) => nameKey(stat.name)));
    }

    private inDes(attr: AttributeDef, enabled: ReadonlySet<string>): boolean {
        return [attr.promptName, attr.name, attr.id].some((name) => !!name && enabled.has(nameKey(name)));
    }

    /**
     * How an attribute of a holder is tracked now. 'desStats': a character's stat DES keeps (explicit, or an 'auto'
     * number of a character mechanic DES tracks); an explicit DES-stat attribute DES does not track (yet) is parsed in
     * the background, the user's character's goes to settings.personaFallback (DES never lists him); 'auto': the
     * service block, with the background parse as the safety net; else the mode itself.
     */
    private route(
        def: MechanicDef,
        attr: AttributeDef,
        enabled: ReadonlySet<string>,
        persona: boolean,
    ): 'desStats' | 'block' | 'background' | 'manual' | 'auto' {
        const mode = trackingOf(def, attr);
        if (mode === 'desStats') {
            if (persona) return this.deps.settings().personaFallback;
            return this.inDes(attr, enabled) ? 'desStats' : 'background';
        }
        if (mode === 'auto' && !persona && this.desKeeps(def, attr, enabled)) return 'desStats';
        return mode;
    }

    /** DES keeps this 'auto' attribute as a character stat now. */
    private desKeeps(def: MechanicDef, attr: AttributeDef, enabled: ReadonlySet<string>): boolean {
        return attr.kind === 'number' && !attr.formula && holdsCharacters(def.holders) && this.inDes(attr, enabled);
    }

    /** The model knows the attribute (secret ones are Maestro's alone). */
    private known(def: MechanicDef, attr: AttributeDef): boolean {
        return !attr.formula && resolveVisibility(def, attr).prompt !== 'none';
    }

    /** The numbers of a mechanic DES may keep ('desStats', and 'auto' numbers of characters) and whether it does. */
    desStatsStatus(def: MechanicDef): { attribute: string; inDes: boolean }[] {
        const enabled = this.desStatus();
        return desStatCandidates(def).map((attr) => ({ attribute: attr.id, inDes: this.inDes(attr, enabled) }));
    }

    /** DES's tracker of a message; null without one. */
    private snapshotOf(des: DesLike, index: number): DesSnapshot | null {
        if (typeof des.trackerFor !== 'function') return null;
        try {
            return des.trackerFor(index);
        } catch (error) {
            this.deps.log.debug('mechanics: the DES tracker is not readable', error);
            return null;
        }
    }

    /**
     * Release 1.26: DES stats as changes. For each stat of a character in the reply's tracker, the difference to the
     * same character's same stat in the latest earlier reply whose tracker has it (up to DES_LOOKBACK messages back)
     * is added to Maestro's value — roll costs, regeneration and other changes Maestro made in between stay. Without an
     * earlier value the stat is set (first sight). No difference, no change.
     */
    private desStatsChanges(defs: readonly MechanicDef[], index: number, enabled: ReadonlySet<string>): ChangeInput[] {
        const des = this.des();
        if (!des) return [];
        const snapshot = this.snapshotOf(des, index);
        if (!snapshot?.characters.length) return [];
        const context = holderContextOf(this.app);
        const persona = personaOf(this.app);
        const chat = this.app.host.ctx().chat ?? [];
        const earlier = new Map<number, DesSnapshot | null>();
        const snapshotAt = (at: number): DesSnapshot | null => {
            if (!earlier.has(at)) earlier.set(at, this.snapshotOf(des, at));
            return earlier.get(at) ?? null;
        };
        /** The stat of the same holder in the latest earlier reply that has it; null when none does. */
        const previous = (def: MechanicDef, holder: string, attr: AttributeDef): number | null => {
            for (let at = index - 1; at >= 0 && at >= index - DES_LOOKBACK; at--) {
                const message = chat[at];
                if (!message || message.is_user || message.is_system) continue;
                for (const character of snapshotAt(at)?.characters ?? []) {
                    const name = resolveHolder(def, character.name, context) ?? character.name;
                    if (nameKey(name) !== nameKey(holder)) continue;
                    const stat = (character.stats ?? []).find((item) => statMatches(item.name, attr));
                    const value = stat ? toNumber(stat.value) : null;
                    if (value !== null) return value;
                }
            }
            return null;
        };
        const changes: ChangeInput[] = [];
        for (const def of defs) {
            const attributes = desStatCandidates(def).filter((attr) => !attr.formula && this.inDes(attr, enabled));
            if (!attributes.length) continue;
            for (const character of snapshot.characters) {
                const holder = resolveHolder(def, character.name, context) ?? character.name;
                const isPersona = !!persona && nameKey(holder) === nameKey(persona);
                for (const stat of character.stats ?? []) {
                    const attr = attributes.find((item) => statMatches(stat.name, item));
                    const value = toNumber(stat.value);
                    if (!attr || value === null) continue;
                    // 'auto': DES keeps the characters' numbers; the user's character's come from the block.
                    if (isPersona && trackingOf(def, attr) === 'auto') continue;
                    const before = previous(def, holder, attr);
                    const base = {
                        mechanicId: def.id,
                        holder: character.name,
                        attribute: attr.id,
                        source: 'desStats' as const,
                        messageIndex: index,
                    };
                    if (before === null) changes.push({ ...base, value });
                    else if (value !== before) changes.push({ ...base, value: value - before, delta: true });
                }
            }
        }
        return changes;
    }

    async enableDesStats(def: MechanicDef): Promise<boolean> {
        const des = this.des();
        const current = this.characterStats(des);
        if (!des || !current || typeof des.setCharacterStats !== 'function') {
            this.deps.log.info('mechanics: DES is not available for stats');
            return false;
        }
        if (des.isWorkshopOpen?.()) {
            this.app.ui.notice(this.t('m25.track.desStats.workshop'), { level: 'warn' });
            return false;
        }
        const attributes = desStatCandidates(def);
        if (!attributes.length) return false;
        const stats = attributes.map((attr) => ({
            id: `maestro_${def.id}_${attr.id}`,
            name: attr.promptName || attr.name || attr.id,
        }));
        const after = this.mergeStats(current, stats);
        if (current.enabled && JSON.stringify(after.customStats) === JSON.stringify(current.customStats)) return true;
        const payload: DesStatsPayload = { m25: 1, mechanicId: def.id, stats };
        const proposal: Proposal<DesStatsPayload> = {
            module: MECHANICS_ID,
            kind: DES_STATS_KIND,
            title: this.t('m25.track.desStats.title', { name: def.name }),
            description: this.t('m25.track.desStats.description', { list: stats.map((stat) => stat.name).join(', ') }),
            changes: [{ target: DES_STATS_UNDO_TARGET, ref: { mechanicId: def.id }, before: current, after }],
            payload,
            apply: (value) => this.applyDesStatsPayload(isDesStatsPayload(value) ? value : payload),
        };
        try {
            return (await this.app.autonomy.decide(proposal, 'ask')) === 'applied';
        } catch (error) {
            this.deps.log.warn('mechanics: the DES stats decision failed', error);
            return false;
        }
    }

    /** DES's list with the stats added (an existing one of the same id or name is switched on), switch on. */
    private mergeStats(current: CharacterStats, stats: readonly { id: string; name: string }[]): CharacterStats {
        const customStats = current.customStats.map((stat) => ({ ...stat }));
        for (const stat of stats) {
            const existing = customStats.find((item) => sameStat(item, stat));
            if (existing) existing.enabled = true;
            else customStats.push({ id: stat.id, name: stat.name, enabled: true });
        }
        return { enabled: true, customStats };
    }

    private async applyDesStatsPayload(payload: unknown): Promise<void> {
        if (!isDesStatsPayload(payload)) throw new Error('bad mechanics DES stats card');
        const des = this.des();
        const current = this.characterStats(des);
        if (!des || !current || typeof des.setCharacterStats !== 'function') {
            throw new Error(this.t('m25.track.desStats.noDes'));
        }
        if (des.isWorkshopOpen?.()) throw new Error(this.t('m25.track.desStats.workshop'));
        const next = this.mergeStats(current, payload.stats);
        if (!des.setCharacterStats(next.customStats, { enable: true }))
            throw new Error(this.t('m25.track.desStats.noDes'));
    }

    /** Takes back what the change added: its new stats go, the stats it switched on go off, the switch as before. */
    private async undoDesStats(change: JournalChange): Promise<boolean> {
        const des = this.des();
        const current = this.characterStats(des);
        if (!des || !current || typeof des.setCharacterStats !== 'function' || des.isWorkshopOpen?.()) return false;
        const before = statsOf(change.before);
        const after = statsOf(change.after);
        const added = after.customStats.filter((stat) => !before.customStats.some((item) => sameStat(item, stat)));
        const switched = after.customStats.filter((stat) =>
            before.customStats.some((item) => sameStat(item, stat) && !item.enabled && stat.enabled),
        );
        const next = current.customStats
            .filter((stat) => !added.some((item) => sameStat(item, stat)))
            .map((stat) => (switched.some((item) => sameStat(item, stat)) ? { ...stat, enabled: false } : stat));
        return des.setCharacterStats(next, { enable: before.enabled });
    }

    /* ---------------------------------------------------------------- the service block: commit */

    private blockOps(defs: readonly MechanicDef[], message: STChatMessage, index: number): StateOp[] {
        const record = readBlockRecord(message);
        if (!record?.items.length) return [];
        const context = holderContextOf(this.app);
        const persona = personaOf(this.app);
        const enabled = this.desStatus();
        // 'block' attributes, 'auto' ones DES does not keep for that holder, the persona's DES-stat fallback. A
        // recounted reply's 'auto' ones (and the statuses and items of 'auto' mechanics) are the background parse's.
        const recounted = record.recounted === true;
        const resolved = resolveBlock(record.items, defs, {
            resolveHolder: (def, raw) => resolveHolder(def, raw, context),
            allows: (def, attr, holder) => {
                if (!this.known(def, attr)) return false;
                const isPersona = !!persona && nameKey(holder ?? '') === nameKey(persona);
                const route = this.route(def, attr, enabled, isPersona);
                return route === 'block' || (route === 'auto' && !recounted);
            },
        });
        if (recounted) {
            const parsedByNet = (mechanicId: string) => this.defs.get(mechanicId)?.tracking === 'auto';
            resolved.statuses = resolved.statuses.filter((edit) => !parsedByNet(edit.mechanicId));
            resolved.inventory = resolved.inventory.filter((edit) => !parsedByNet(edit.mechanicId));
        }
        if (resolved.rejected.length) {
            this.deps.log.debug(
                `mechanics: ${resolved.rejected.length} block lines of #${index} not applied`,
                resolved.rejected.map((item) => `${item.item.line}: ${item.reason}`),
            );
        }
        const ops: StateOp[] = this.toChanges(resolved.edits, 'block', index);
        for (const edit of resolved.statuses) {
            const base = {
                source: 'block' as const,
                messageIndex: index,
                mechanicId: edit.mechanicId,
                holder: edit.holder,
            };
            if (edit.op === 'remove') {
                ops.push({
                    ...base,
                    kind: 'status',
                    op: 'remove',
                    ref: edit.name,
                    ...(edit.reason ? { reason: edit.reason } : {}),
                });
                continue;
            }
            const duration = this.durationOf(edit.duration, edit.durationText);
            ops.push({
                ...base,
                kind: 'status',
                op: 'add',
                status: { name: edit.name, ...(duration ? { duration } : {}) },
                ...(edit.reason ? { reason: edit.reason } : {}),
            });
        }
        for (const edit of resolved.inventory) {
            const base = {
                source: 'block' as const,
                messageIndex: index,
                mechanicId: edit.mechanicId,
                holder: edit.holder,
                ...(edit.reason ? { reason: edit.reason } : {}),
            };
            if (edit.op === 'equip') {
                ops.push({ ...base, kind: 'item', op: 'equip', item: { name: edit.name }, slot: edit.slot ?? null });
            } else if (edit.op === 'take') {
                ops.push({ ...base, kind: 'item', op: 'take', item: { name: edit.name }, qty: edit.qty });
            } else {
                const item = edit.slot ? { name: edit.name, equipped: edit.slot } : { name: edit.name };
                ops.push({ ...base, kind: 'item', op: 'give', item, qty: edit.qty });
            }
        }
        return ops;
    }

    /**
     * A duration from parsed words, else a phrase placed in story time by the calendar («до заката» → until). A phrase
     * the calendar understands but cannot place — no clock, a clock counted only from the block's or the parse's minutes
     * (no real time of day), a weekday it does not know — lasts UNTIL_FALLBACK_TURNS turns instead of forever (1.26).
     */
    private durationOf(parsed: StatusDuration | null, text: string | undefined): StatusDuration | null {
        if (parsed) return parsed;
        if (!text) return null;
        const due = parseDueExpression(text);
        if (!due) return null;
        const clock = this.state.clock?.() ?? null;
        if (!clock || clock.relative) return { turns: UNTIL_FALLBACK_TURNS };
        const moment = resolveDue(due, { day: clock.day, label: clock.label, ...minutesOf(clock) });
        if (moment.day === null) return { turns: UNTIL_FALLBACK_TURNS };
        return { until: { day: moment.day, ...(moment.minutes !== undefined ? { minutes: moment.minutes } : {}) } };
    }

    private toChanges(edits: readonly Edit[], source: 'block' | 'background', index: number): ChangeInput[] {
        const { changes, rejected } = editsToChanges(
            edits,
            (id) => this.defs.get(id),
            (mechanicId, holder, attribute) => this.state.value(mechanicId, holder, attribute),
        );
        if (rejected.length) this.deps.log.debug(`mechanics: ${rejected.length} ${source} edits invalid`, rejected);
        return changes.map((change) => ({ ...change, source, messageIndex: index }));
    }

    blockInstruction(
        defs: MechanicDef[],
        holdersByMechanic: Record<string, string[]>,
        options: { checks?: string[]; combat?: boolean } = {},
    ): string {
        const persona = personaOf(this.app);
        const enabled = this.desStatus();
        const inScene = defs.filter((def) => (holdersByMechanic[def.id] ?? []).length > 0);
        return buildBlockInstruction(defs, holdersByMechanic, {
            ...(options.checks?.length ? { checks: options.checks } : {}),
            ...(options.combat ? { combat: true } : {}),
            // 'auto' numbers DES keeps for the characters leave the block; the user's character's stay.
            desTracked: (def, attr) => this.desKeeps(def, attr, enabled),
            ...(persona
                ? {
                      persona: {
                          name: persona,
                          attributes: (def: MechanicDef) =>
                              def.attributes.filter((attr) => {
                                  if (!this.known(def, attr)) return false;
                                  const route = this.route(def, attr, enabled, true);
                                  return route === 'block' || route === 'auto';
                              }),
                      },
                  }
                : {}),
            ...(this.clockMatters(inScene) && !this.desGivesTime() ? { time: true } : {}),
        });
    }

    /** The story clock matters for these mechanics: rules by the hour or day, or statuses counted in story time. */
    private clockMatters(defs: readonly MechanicDef[]): boolean {
        if (defs.some((def) => def.time?.some((rule) => rule.per !== 'turn'))) return true;
        const timed = (duration: StatusDuration | null | undefined) => !!duration?.minutes || !!duration?.until;
        if (defs.some((def) => def.statuses?.some((status) => timed(status.duration)))) return true;
        if (!defs.length) return false;
        const current = safely(() => this.state.statuses?.() ?? [], []);
        return current.some((entry) => entry.statuses.some((status) => !!status.remaining?.minutes || !!status.until));
    }

    /** DES gives the story time now: the latest reply with a DES tracker (a few back) has a date or a time. */
    private desGivesTime(): boolean {
        const des = this.des();
        if (!des) return false;
        const chat = this.app.host.ctx().chat ?? [];
        for (let i = chat.length - 1; i >= 0 && i >= chat.length - DES_TIME_LOOKBACK; i--) {
            const message = chat[i];
            if (!message || message.is_user || message.is_system) continue;
            const snapshot = this.snapshotOf(des, i);
            if (!snapshot) continue;
            const box = snapshot.infoBox;
            return !!(box?.date || box?.time?.start || box?.time?.end);
        }
        return false;
    }

    /** The mechanics on in the chat with holders in the scene now. */
    private sceneDefs(): MechanicDef[] {
        return this.activeDefs().filter((def) => safely(() => this.state.holdersInScene(def).length > 0, false));
    }

    /* ---------------------------------------------------------------- background parse */

    /**
     * What the background parse reads: 'background' attributes (and explicit DES-stat ones DES does not keep, the
     * persona's per settings.personaFallback), statuses and items of 'background' mechanics; with `auto` (a reply
     * without a readable block, release 1.26) also the 'auto' attributes DES does not keep and 'auto' statuses / items.
     */
    private backgroundTargets(
        defs: readonly MechanicDef[],
        enabled: ReadonlySet<string>,
        options: { auto?: boolean } = {},
    ): ExtractTarget[] {
        const targets: ExtractTarget[] = [];
        const persona = personaOf(this.app);
        const isPersona = (name: string) => !!persona && nameKey(name) === nameKey(persona);
        const wanted = (route: string) => route === 'background' || (options.auto === true && route === 'auto');
        for (const def of defs) {
            // A secret mechanic is Maestro's alone: never sent to the model, the background one included.
            if (resolveVisibility(def).prompt === 'none') continue;
            let holders: string[] = [];
            try {
                holders = this.state.holdersInScene(def);
            } catch (error) {
                this.deps.log.debug('mechanics: the scene is not readable', error);
            }
            if (!holders.length) continue;
            const attributes = def.attributes.filter(
                (attr) => this.known(def, attr) && wanted(this.route(def, attr, enabled, false)),
            );
            const own = def.attributes.filter(
                (attr) => this.known(def, attr) && wanted(this.route(def, attr, enabled, true)),
            );
            const partsParsed = def.tracking === 'background' || (options.auto === true && def.tracking === 'auto');
            const statuses = def.statuses !== undefined && partsParsed;
            const inventory = def.inventory !== undefined && partsParsed;
            const holderOf = (name: string, list: AttributeDef[]) => {
                const entry: ExtractTarget['holders'][number] = {
                    name,
                    values: Object.fromEntries(
                        list.map((attr) => [attr.id, this.state.value(def.id, name, attr.id) ?? initialValueOf(attr)]),
                    ),
                };
                if (statuses) {
                    entry.statuses = (this.state.statuses?.(name)[0]?.statuses ?? []).map(
                        (status) => status.promptName,
                    );
                }
                if (inventory) entry.items = itemsText(this.state.items?.(name)[0]?.items ?? []);
                return entry;
            };
            const others = holders.filter((name) => !isPersona(name));
            const parts = { ...(statuses ? { statuses: true } : {}), ...(inventory ? { inventory: true } : {}) };
            if ((attributes.length || statuses || inventory) && others.length) {
                targets.push({ def, attributes, holders: others.map((name) => holderOf(name, attributes)), ...parts });
            }
            const me = holders.find(isPersona);
            if (me && (own.length || statuses || inventory)) {
                targets.push({ def, attributes: own, holders: [holderOf(me, own)], ...parts });
            }
        }
        return targets;
    }

    /**
     * The reply's block is missing or unreadable, or «Пересчитать» handed it to the parse: the background parse reads
     * its 'auto' attributes (release 1.26).
     */
    private needsSafetyNet(message: STChatMessage): boolean {
        const record = readBlockRecord(message);
        return !record || unreadableRecord(record) || record.recounted === true;
    }

    /* ---------------------------------------------------------------- health */

    onHealthChange(listener: () => void): Unsubscribe {
        this.healthListeners.add(listener);
        return () => this.healthListeners.delete(listener);
    }

    private setExtractError(error: string | null): void {
        if (this.extractError === error) return;
        this.extractError = error;
        for (const listener of [...this.healthListeners]) {
            try {
                listener();
            } catch (failure) {
                this.deps.log.debug('mechanics: a health listener failed', failure);
            }
        }
    }

    /** What keeps the values of the mechanics in the scene from following the story now (empty: all is well). */
    health(): TrackingProblem[] {
        if (this.disposed) return [];
        const defs = this.activeDefs().filter((def) => {
            try {
                return this.state.holdersInScene(def).length > 0;
            } catch {
                return false;
            }
        });
        if (!defs.length) return [];
        const problems: TrackingProblem[] = [];
        const names = (ids: readonly string[]) =>
            ids.map((id) => defs.find((def) => def.id === id)?.name ?? id).join(', ');
        const enabled = this.desStatus();
        const ids = (targets: ExtractTarget[]) => [...new Set(targets.map((target) => target.def.id))];
        // The parse is the only way for 'background' attributes; for 'auto' ones only the safety net (release 1.26):
        // a warning for the first, a note for the second.
        const background = ids(this.backgroundTargets(defs, enabled));
        const net = ids(this.backgroundTargets(defs, enabled, { auto: true })).filter((id) => !background.includes(id));
        const affected = [...background, ...net];
        const primary = background.length > 0;
        const level: TrackingProblem['level'] = primary ? 'warn' : 'info';
        const key = (code: string) => `m25.health.${code}${primary ? '' : '.auto'}`;
        if (affected.length) {
            const list = names(primary ? background : net);
            const settings = this.deps.settings();
            if (!settings.background) {
                problems.push({
                    code: 'backgroundOff',
                    level,
                    mechanics: affected,
                    text: this.t(key('backgroundOff'), { list }),
                });
            } else if (!safely(() => this.app.llm.available(EXTRACT_TASK), false)) {
                problems.push({
                    code: 'noProfile',
                    level,
                    mechanics: affected,
                    text: this.t(key('noProfile'), { list }),
                });
            } else if (safely(() => this.app.cost.backgroundCapReached(), false)) {
                problems.push({ code: 'cap', level, mechanics: affected, text: this.t(key('cap'), { list }) });
            }
        }
        if (this.extractError !== null && affected.length) {
            problems.push({
                code: 'extractFailed',
                level,
                mechanics: affected,
                text: this.t('m25.health.extractFailed'),
                detail: this.extractError,
            });
        }
        const des = this.des();
        const pending: string[] = [];
        const noDes: string[] = [];
        for (const def of defs) {
            const attributes = desStatsAttributes(def).filter((attr) => this.known(def, attr));
            if (!attributes.length) continue;
            if (!des) noDes.push(def.id);
            else if (attributes.some((attr) => !this.inDes(attr, enabled))) pending.push(def.id);
        }
        if (pending.length)
            problems.push({
                code: 'desStatsPending',
                level: 'info',
                mechanics: pending,
                text: this.t('m25.health.desStatsPending', { list: names(pending) }),
            });
        if (noDes.length)
            problems.push({
                code: 'noDes',
                level: 'info',
                mechanics: noDes,
                text: this.t('m25.health.noDes', { list: names(noDes) }),
            });
        if (!this.isLeader())
            problems.push({ code: 'otherTab', level: 'info', mechanics: [], text: this.t('m25.health.otherTab') });
        return problems;
    }

    private canSpend(): boolean {
        try {
            return this.app.llm.available(EXTRACT_TASK) && !this.app.cost.backgroundCapReached();
        } catch {
            return false;
        }
    }

    /**
     * Enqueues the background parse of a reply when it has something to read: 'background' attributes, or (release
     * 1.26) the 'auto' ones of a reply whose block is missing or unreadable. Once per reply and swipe in this page
     * session unless `force` («Пересчитать»).
     */
    private async maybeExtract(
        defs: readonly MechanicDef[],
        index: number,
        message: STChatMessage,
        enabled: ReadonlySet<string>,
        force = false,
    ): Promise<void> {
        if (!this.deps.settings().background) return;
        const auto = this.needsSafetyNet(message);
        if (!this.backgroundTargets(defs, enabled, { auto }).length) return;
        const swipeId = swipeIdOf(message);
        const key = `${this.app.host.chatId() ?? ''}|${index}|${swipeId}`;
        if (this.enqueued.has(key) && !force) return;
        if (!this.canSpend()) {
            this.deps.log.debug('mechanics: the background parse is not available or over the cap');
            return;
        }
        this.enqueued.add(key);
        // The send date pins the message: a deletion above it moves the index, the task must not read another reply.
        const sent = typeof message.send_date === 'string' && message.send_date ? { sent: message.send_date } : {};
        await this.app.tasks.enqueue({
            kind: EXTRACT_TASK,
            dedupeKey: `mechanics:${index}`,
            payload: { messageIndex: index, swipeId, ...sent },
            ttlMs: EXTRACT_TTL_MS,
        });
    }

    /** The reply the payload names, still the same swipe; null otherwise. */
    private replyOf(index: number, swipeId: number): STChatMessage | null {
        const message = this.app.host.ctx().chat[index];
        if (!message || message.is_user || message.is_system || swipeIdOf(message) !== swipeId) return null;
        return message;
    }

    private async runExtract(payload: Record<string, unknown>, info: TaskInfo): Promise<void> {
        if (this.disposed || !this.isLeader()) return;
        const chatId = this.app.host.chatId();
        if (!chatId || (info.chatId && info.chatId !== chatId)) return;
        const index = Number(payload.messageIndex);
        const swipeId = Number(payload.swipeId);
        const message = Number.isInteger(index) ? this.replyOf(index, swipeId) : null;
        if (!message) return;
        if (typeof payload.sent === 'string' && payload.sent && message.send_date !== payload.sent) return;
        await this.stateReady();
        if (
            this.state
                .history(HISTORY_LOOKUP)
                .some((change) => change.messageIndex === index && change.source === 'background')
        ) {
            return;
        }
        const targets = this.backgroundTargets(this.activeDefs(), this.desStatus(), {
            auto: this.needsSafetyNet(message),
        });
        if (!targets.length || !this.canSpend()) return;
        const reply = stripBlock(cleanForAnalysis(message));
        if (!reply.trim()) return;
        const generation = this.generation;
        // Story time is asked only when the clock matters and neither DES nor the block says it (release 1.26).
        const elapsed =
            this.clockMatters(this.sceneDefs()) &&
            !safely(() => this.state.hasObservedTime?.(index) ?? false, false) &&
            readBlockRecord(message)?.elapsed === undefined;
        const schema = extractSchemaFor({
            statuses: targets.some((target) => target.statuses),
            items: targets.some((target) => target.inventory),
            elapsed,
        });
        const action = this.actionBefore(index);
        const persona = personaOf(this.app);
        const response = await this.app.llm.request<unknown>({
            task: EXTRACT_TASK,
            messages: buildExtractMessages({
                targets,
                reply,
                ...(action ? { action } : {}),
                ...(persona ? { persona } : {}),
                ...(elapsed ? { elapsed: true } : {}),
            }),
            maxTokens: EXTRACT_MAX_TOKENS,
            temperature: 0.1,
            schema: { name: EXTRACT_SCHEMA_NAME, schema },
        });
        if (!response.ok) {
            this.deps.log.info(`mechanics: the background parse failed (${response.error ?? 'unknown error'})`);
            this.setExtractError(response.error ?? 'unknown error');
            return;
        }
        if (generation !== this.generation || this.app.host.chatId() !== chatId || !this.replyOf(index, swipeId))
            return;
        const context = holderContextOf(this.app);
        const parsed = parseExtractAnswer(response.data ?? response.text, targets, {
            resolveHolder: (def, raw) => resolveHolder(def, raw, context),
        });
        if (!parsed) {
            this.deps.log.warn('mechanics: the background parse answer is not the expected JSON');
            this.setExtractError('not the expected JSON');
            return;
        }
        this.setExtractError(null);
        if (parsed.rejected.length) this.deps.log.debug('mechanics: background items dropped', parsed.rejected);
        const changes = this.toChanges(parsed.edits, 'background', index);
        const ops = this.extractOps(parsed.statuses, parsed.items, index);
        if (changes.length || ops.length) await this.propose(changes, index, swipeId, chatId, ops);
        // The story time it took: the turn (or, when the turn ran already, the latest turn's clock) moves by it.
        if (elapsed && parsed.elapsed !== null && generation === this.generation) {
            try {
                await this.state.processTurn?.(index, { elapsed: parsed.elapsed });
            } catch (error) {
                this.deps.log.warn('mechanics: the story time of a reply was not applied', error);
            }
        }
    }

    /** The user's message right before a reply (narrator messages skipped); '' when another reply comes first. */
    private actionBefore(index: number): string {
        const chat = this.app.host.ctx().chat ?? [];
        for (let i = index - 1; i >= 0; i--) {
            const message = chat[i];
            if (!message || message.is_system) continue;
            if (!message.is_user) return '';
            return cleanForAnalysis(message).trim();
        }
        return '';
    }

    private extractOps(statuses: readonly ExtractStatus[], items: readonly ExtractItem[], index: number): StateOp[] {
        const ops: StateOp[] = [];
        for (const status of statuses) {
            const base = {
                source: 'background' as const,
                messageIndex: index,
                mechanicId: status.mechanicId,
                holder: status.holder,
                ...(status.reason ? { reason: status.reason } : {}),
            };
            if (!status.add) {
                ops.push({ ...base, kind: 'status', op: 'remove', ref: status.name });
                continue;
            }
            const duration = this.durationOf(status.duration, status.durationText);
            ops.push({
                ...base,
                kind: 'status',
                op: 'add',
                status: { name: status.name, ...(duration ? { duration } : {}) },
            });
        }
        for (const item of items) {
            const base = {
                source: 'background' as const,
                messageIndex: index,
                mechanicId: item.mechanicId,
                holder: item.holder,
                item: { name: item.name },
                qty: Math.abs(item.qty),
                ...(item.reason ? { reason: item.reason } : {}),
            };
            ops.push(item.qty > 0 ? { ...base, kind: 'item', op: 'give' } : { ...base, kind: 'item', op: 'take' });
        }
        return ops;
    }

    private holderLabel(holder: string): string {
        return holder === WORLD_HOLDER ? this.t('m25.state.holder.world') : holder;
    }

    /** The player may see this change (plan-2 §6.А: hidden values never reach cards, notices or the journal). */
    private seen(op: StateOp): boolean {
        if (op.kind === 'clock' || op.kind === 'combat') return true;
        const def = this.defs.get(op.mechanicId);
        if (!def) return true;
        if (op.kind === 'status' || op.kind === 'item') return playerSees(resolveVisibility(def));
        const attr = findAttribute(def, op.attribute);
        if (!attr) return true;
        const revealed = this.state.isRevealed?.(def.id, op.holder, attr.id) ?? false;
        return playerSees(resolveVisibility(def, attr), revealed);
    }

    private async propose(
        allChanges: ChangeInput[],
        index: number,
        swipeId: number,
        chatId: string,
        allOps: StateOp[] = [],
    ): Promise<void> {
        const changes = allChanges.filter((change) => this.seen(change));
        const ops = allOps.filter((op) => this.seen(op));
        const silent = [...allChanges.filter((change) => !this.seen(change)), ...allOps.filter((op) => !this.seen(op))];
        if (silent.length)
            await this.applyOps(silent.map((op) => ({ ...op, source: 'background' as const, messageIndex: index })));
        if (!changes.length && !ops.length) return;
        const running = new Map<string, AttributeValue | null>();
        const preview: JournalChange[] = [];
        const lines: string[] = [];
        for (const change of changes) {
            const def = this.defs.get(change.mechanicId);
            const attr = def ? findAttribute(def, change.attribute) : null;
            if (!def || !attr) continue;
            const key = `${def.id}|${nameKey(change.holder)}|${attr.id}`;
            const before = running.has(key)
                ? (running.get(key) ?? null)
                : this.state.value(def.id, change.holder, attr.id);
            const after = previewChange(attr, before, change);
            running.set(key, after);
            preview.push({
                target: VALUE_UNDO_TARGET,
                ref: {
                    chatId,
                    mechanicId: def.id,
                    holder: change.holder,
                    attribute: attr.id,
                    messageIndex: index,
                    source: 'background',
                },
                before,
                after,
            });
            const quote = change.reason ? ` («${change.reason}»)` : '';
            lines.push(
                `${this.holderLabel(change.holder)} · ${attr.name}: ${formatValue(before)} → ${formatValue(after)}${quote}`,
            );
        }
        for (const op of ops) {
            if (op.kind === 'status') {
                const name = op.op === 'add' ? op.status.name : op.op === 'remove' ? op.ref : op.instance.name;
                const key = op.op === 'remove' ? 'm25.track.change.statusOff' : 'm25.track.change.statusOn';
                lines.push(this.t(key, { holder: this.holderLabel(op.holder), status: name }));
            } else if (op.kind === 'item') {
                const key = op.op === 'take' ? 'm25.track.change.itemOff' : 'm25.track.change.itemOn';
                const qty = op.op === 'equip' ? 1 : (op.qty ?? 1);
                lines.push(this.t(key, { holder: this.holderLabel(op.holder), item: op.item.name, qty }));
            }
        }
        const payload: ChangePayload = { m25: 1, messageIndex: index, swipeId, changes };
        if (ops.length) payload.ops = ops;
        const proposal: Proposal<ChangePayload> = {
            module: MECHANICS_ID,
            kind: CHANGE_KIND,
            title: this.t('m25.track.change.title', { count: changes.length + ops.length, index }),
            description: lines.join('\n'),
            appliedNotice: { text: this.t('m25.track.change.done', { index }) },
            changes: preview,
            payload,
            sourceMessage: index,
            apply: (value) => this.applyChangePayload(isChangePayload(value) ? value : payload),
            stillValid: async () => this.replyOf(index, swipeId) !== null,
        };
        try {
            await this.app.autonomy.decide(proposal, 'auto');
        } catch (error) {
            this.deps.log.warn('mechanics: the change decision failed', error);
        }
    }

    private async applyChangePayload(payload: unknown): Promise<void> {
        if (!isChangePayload(payload)) throw new Error('bad mechanics change card');
        if (!this.replyOf(payload.messageIndex, payload.swipeId)) return;
        const changes: StateOp[] = payload.changes.map((change) => ({
            ...change,
            source: 'background' as const,
            messageIndex: payload.messageIndex,
        }));
        const ops = (Array.isArray(payload.ops) ? payload.ops : []).map((op) => ({
            ...op,
            source: 'background' as const,
            messageIndex: payload.messageIndex,
        })) as StateOp[];
        await this.applyOps([...changes, ...ops]);
    }

    /* ---------------------------------------------------------------- invalidation */

    private onInvalidated(index: number, reason: 'swiped' | 'deleted' | 'edited', removedAt?: number): void {
        if (this.disposed || !Number.isInteger(index) || index < 0) return;
        if (reason !== 'edited') {
            // Messages deleted from the middle (release 1.26): everything from the first deleted one on is stale here.
            const from =
                reason === 'deleted' && removedAt !== undefined && Number.isInteger(removedAt) && removedAt >= 0
                    ? Math.min(index, removedAt)
                    : index;
            for (const pending of [...this.pending]) if (pending >= from) this.pending.delete(pending);
            for (const missed of [...this.missed]) if (missed >= from) this.missed.delete(missed);
            const chatId = this.app.host.chatId() ?? '';
            for (const key of [...this.enqueued]) {
                const [chat, at] = key.split('|');
                if (chat === chatId && Number(at) >= from) this.enqueued.delete(key);
            }
            if (reason === 'swiped') this.afterSwipe(index);
            return;
        }
        // An edit of the latest committed reply or of a later one (its changes are in the values since it arrived):
        // the state took its changes back; derive them again.
        const committed = committedIndices(this.app.host.ctx().chat);
        const last = committed[committed.length - 1];
        if (last !== undefined && index < last) return;
        const chatId = this.app.host.chatId() ?? '';
        for (const key of [...this.enqueued]) if (key.startsWith(`${chatId}|${index}|`)) this.enqueued.delete(key);
        this.schedule(index);
    }

    /**
     * A swipe took the reply's changes back. A new variant is generated next (reply:ready processes it); a swipe back to
     * a variant already there generates nothing, so that variant is processed here once the swipe settled.
     */
    private afterSwipe(index: number): void {
        if (this.swipeTimer !== null) clearTimeout(this.swipeTimer);
        const generation = this.generation;
        this.swipeTimer = setTimeout(() => {
            this.swipeTimer = null;
            if (this.disposed || generation !== this.generation) return;
            if (this.app.turn.current() !== null) return;
            const chat = this.app.host.ctx().chat ?? [];
            const message = chat[index];
            if (index !== chat.length - 1 || !message || message.is_user || message.is_system) return;
            if (typeof message.mes !== 'string' || !message.mes.trim()) return;
            if (hasBlockMarker(message.mes)) this.takeBlock(index, false);
            this.schedule(index);
        }, this.settleMs * 2);
    }
}

/** The minutes of a clock as an optional field. */
function minutesOf(clock: { minutes?: number }): { minutes?: number } {
    return clock.minutes !== undefined ? { minutes: clock.minutes } : {};
}

function safely<T>(run: () => T, fallback: T): T {
    try {
        return run();
    } catch {
        return fallback;
    }
}
