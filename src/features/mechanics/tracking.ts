// M25 «Механики», the tracking part (plan M25 п. 4; §5; §10; P8, P14, P15): the three ways changes are noticed.
// - 'desStats': when a reply is committed (a settle pause after turn:committed, leader tab only) the committed DES
//   tracker's `characters[].stats` are read for the attributes tracked as DES stats (stat name = the attribute's
//   prompt name, name or id, any case) → state.apply(source 'desStats'). enableDesStats() adds the attributes to
//   DES's `trackerConfig.presentCharacters.characterStats` (the user's own stats stay) through autonomy
//   'mechanics.desStats' (fallback 'ask', never auto), journaled with an undo that takes back only what it added;
// - 'block': the model ends its reply with `<mechanics>…</mechanics>`. On MESSAGE_RECEIVED (last listener: after
//   NAI Studio's markers and DES's tracker parse, before CHARACTER_MESSAGE_RENDERED → reply:ready, so the quality
//   check never sees it) the block is parsed (repairs in the domain), the lines are kept in
//   `extra.maestro_mechanics` of the message and its swipe (with the swipe id), and the block leaves the stored text
//   and the render. A display hook of ST's message formatter hides it while it streams. The changes are applied when
//   the reply is committed (P14). Leftover blocks of older replies never reach the prompt
//   (CHAT_COMPLETION_PROMPT_READY, assistant messages only — the block instruction itself is a system message);
// - 'background': after the commit, when a mechanic in the scene has background attributes (or DES-stat attributes
//   DES does not track yet), one cheap task 'mechanics.extract' with a strict JSON schema reads the committed reply
//   (under the background cost cap) → validated edits → autonomy 'mechanics.change' (fallback 'auto') → state.apply.
// - the block also carries statuses (`Kai.status += Poisoned (3 turns)`), items (`Kai.items += rope x2`), roll requests
//   (`roll: Stealth Kai vs Guard.Perception adv`, rolled by the checks part as soon as the reply arrives) and fights
//   (`combat: start|enemy|out|end`, run by the combat part at the commit);
// - the user's character: DES does not list {{user}}, so his DES-stat attributes are read by the background parse (or
//   the block, settings.personaFallback);
// - after the tracking of a committed reply its turn runs (state.processTurn: the clock, statuses, time rules, rounds).
// A committed reply is processed once per source (the state's change log tells); an edit of the latest committed
// reply is processed again after the state took its changes back.
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
import { desStatsAttributes, initialValueOf, trackingOf } from '../../domain/mechanics-defs';
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
import type { App, JournalChange, Proposal, TaskInfo, Unsubscribe } from '../../shared/contracts';
import type { AttributeValue, MechanicDef } from './api';
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
const EXTRACT_MAX_TOKENS = 700;
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

/** What the tracking reads of the DES adapter (duck-typed: fakes in tests, older adapters). */
interface DesLike {
    present(): boolean;
    settings?(): Record<string, unknown> | null;
    trackerFor?(
        index: number,
    ): { characters: { name: string; stats: { name: string; value: number | string }[] }[] } | null;
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
    /** Background parses enqueued in this page session (chat|message|swipe). */
    private readonly enqueued = new Set<string>();
    /** Bumped on chat change: work of the previous chat stops. */
    private generation = 0;
    private disposed = false;
    private readonly settleMs: number;

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
            app.bus.on('reply:ready', ({ messageIndex }) => {
                this.takeBlock(messageIndex, false);
            }),
            app.bus.on('message:invalidated', ({ messageIndex, reason }) => this.onInvalidated(messageIndex, reason)),
            app.bus.on('chat:changed', () => this.onChatChanged()),
        );
        this.onSt(
            'MESSAGE_RECEIVED',
            (messageId, type) => {
                const kind = String(type ?? '') || 'normal';
                if (!FOREIGN_TYPES.has(kind)) this.takeBlock(Number(messageId), APPEND_TYPES.has(kind));
            },
            'last',
        );
        this.onSt('MESSAGE_EDITED', (messageId) => {
            this.takeBlock(Number(messageId), false);
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
        this.pending.clear();
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
        this.pending.clear();
        this.enqueued.clear();
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
     * its lines to the record of the same swipe. True when a block was taken.
     */
    takeBlock(index: number, merge: boolean): boolean {
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
        try {
            ctx.updateMessageBlock?.(index, message);
        } catch (error) {
            this.deps.log.debug('mechanics: the message could not be re-rendered', error);
        }
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

    /* ---------------------------------------------------------------- commit */

    private onCommitted(index: number): void {
        if (this.disposed || !Number.isInteger(index) || index < 0) return;
        this.schedule(index);
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

    private async processCommitted(index: number, generation: number): Promise<void> {
        if (generation !== this.generation || this.disposed || !this.isLeader()) return;
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
            await this.maybeExtract(defs, index, swipeIdOf(message), desStats);
        }
        if (generation === this.generation) {
            try {
                await this.state.processTurn?.(index);
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

    /** Effective mode: a DES-stat attribute DES does not track (yet) is parsed in the background. */
    private modeOf(def: MechanicDef, attr: AttributeDef, enabled: ReadonlySet<string>) {
        const mode = trackingOf(def, attr);
        return mode === 'desStats' && !this.inDes(attr, enabled) ? 'background' : mode;
    }

    /** The persona's DES-stat attributes go to the fallback (DES never lists the user's character). */
    private personaMode(def: MechanicDef, attr: AttributeDef, enabled: ReadonlySet<string>) {
        return trackingOf(def, attr) === 'desStats'
            ? this.deps.settings().personaFallback
            : this.modeOf(def, attr, enabled);
    }

    /** The model knows the attribute (secret ones are Maestro's alone). */
    private known(def: MechanicDef, attr: AttributeDef): boolean {
        return !attr.formula && resolveVisibility(def, attr).prompt !== 'none';
    }

    desStatsStatus(def: MechanicDef): { attribute: string; inDes: boolean }[] {
        const enabled = this.desStatus();
        return desStatsAttributes(def).map((attr) => ({ attribute: attr.id, inDes: this.inDes(attr, enabled) }));
    }

    private desStatsChanges(defs: readonly MechanicDef[], index: number, enabled: ReadonlySet<string>): ChangeInput[] {
        const des = this.des();
        if (!des || typeof des.trackerFor !== 'function') return [];
        let snapshot: ReturnType<NonNullable<DesLike['trackerFor']>> = null;
        try {
            snapshot = des.trackerFor(index);
        } catch (error) {
            this.deps.log.debug('mechanics: the DES tracker is not readable', error);
        }
        if (!snapshot?.characters.length) return [];
        const changes: ChangeInput[] = [];
        for (const def of defs) {
            const attributes = desStatsAttributes(def).filter((attr) => this.inDes(attr, enabled));
            if (!attributes.length) continue;
            for (const character of snapshot.characters) {
                for (const stat of character.stats ?? []) {
                    const attr = attributes.find((item) => statMatches(stat.name, item));
                    const value = toNumber(stat.value);
                    if (!attr || value === null) continue;
                    changes.push({
                        mechanicId: def.id,
                        holder: character.name,
                        attribute: attr.id,
                        value,
                        source: 'desStats',
                        messageIndex: index,
                    });
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
        const attributes = desStatsAttributes(def);
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
        const fallback = this.deps.settings().personaFallback === 'block';
        const resolved = resolveBlock(record.items, defs, {
            resolveHolder: (def, raw) => resolveHolder(def, raw, context),
            allows: (def, attr, holder) => {
                if (!this.known(def, attr)) return false;
                const mode = trackingOf(def, attr);
                if (mode === 'block') return true;
                return fallback && mode === 'desStats' && !!persona && nameKey(holder ?? '') === nameKey(persona);
            },
        });
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

    /** A duration from parsed words, else a phrase placed in story time by the calendar («до заката» → until). */
    private durationOf(parsed: StatusDuration | null, text: string | undefined): StatusDuration | null {
        if (parsed) return parsed;
        if (!text) return null;
        const due = parseDueExpression(text);
        const clock = this.state.clock?.() ?? null;
        if (!due || !clock) return null;
        const moment = resolveDue(due, { ...clock });
        if (moment.day === null) return null;
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
        const fallback = this.deps.settings().personaFallback === 'block';
        return buildBlockInstruction(defs, holdersByMechanic, {
            ...(options.checks?.length ? { checks: options.checks } : {}),
            ...(options.combat ? { combat: true } : {}),
            ...(fallback && persona
                ? {
                      persona: {
                          name: persona,
                          attributes: (def: MechanicDef) =>
                              def.attributes.filter(
                                  (attr) => this.known(def, attr) && this.personaMode(def, attr, enabled) === 'block',
                              ),
                      },
                  }
                : {}),
        });
    }

    /* ---------------------------------------------------------------- background parse */

    private backgroundTargets(defs: readonly MechanicDef[], enabled: ReadonlySet<string>): ExtractTarget[] {
        const targets: ExtractTarget[] = [];
        const persona = personaOf(this.app);
        const isPersona = (name: string) => !!persona && nameKey(name) === nameKey(persona);
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
                (attr) => this.known(def, attr) && this.modeOf(def, attr, enabled) === 'background',
            );
            const own = def.attributes.filter(
                (attr) => this.known(def, attr) && this.personaMode(def, attr, enabled) === 'background',
            );
            const statuses = def.statuses !== undefined && def.tracking === 'background';
            const inventory = def.inventory !== undefined && def.tracking === 'background';
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

    private canSpend(): boolean {
        try {
            return this.app.llm.available(EXTRACT_TASK) && !this.app.cost.backgroundCapReached();
        } catch {
            return false;
        }
    }

    private async maybeExtract(
        defs: readonly MechanicDef[],
        index: number,
        swipeId: number,
        enabled: ReadonlySet<string>,
    ): Promise<void> {
        if (!this.deps.settings().background) return;
        if (!this.backgroundTargets(defs, enabled).length) return;
        const key = `${this.app.host.chatId() ?? ''}|${index}|${swipeId}`;
        if (this.enqueued.has(key)) return;
        if (!this.canSpend()) {
            this.deps.log.debug('mechanics: the background parse is not available or over the cap');
            return;
        }
        this.enqueued.add(key);
        await this.app.tasks.enqueue({
            kind: EXTRACT_TASK,
            dedupeKey: `mechanics:${index}`,
            payload: { messageIndex: index, swipeId },
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
        await this.stateReady();
        if (
            this.state
                .history(HISTORY_LOOKUP)
                .some((change) => change.messageIndex === index && change.source === 'background')
        ) {
            return;
        }
        const targets = this.backgroundTargets(this.activeDefs(), this.desStatus());
        if (!targets.length || !this.canSpend()) return;
        const reply = stripBlock(cleanForAnalysis(message));
        if (!reply.trim()) return;
        const generation = this.generation;
        const schema = extractSchemaFor({
            statuses: targets.some((target) => target.statuses),
            items: targets.some((target) => target.inventory),
        });
        const response = await this.app.llm.request<unknown>({
            task: EXTRACT_TASK,
            messages: buildExtractMessages({ targets, reply }),
            maxTokens: EXTRACT_MAX_TOKENS,
            temperature: 0.1,
            schema: { name: EXTRACT_SCHEMA_NAME, schema },
        });
        if (!response.ok) {
            this.deps.log.info(`mechanics: the background parse failed (${response.error ?? 'unknown error'})`);
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
            return;
        }
        if (parsed.rejected.length) this.deps.log.debug('mechanics: background items dropped', parsed.rejected);
        const changes = this.toChanges(parsed.edits, 'background', index);
        const ops = this.extractOps(parsed.statuses, parsed.items, index);
        if (changes.length || ops.length) await this.propose(changes, index, swipeId, chatId, ops);
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

    private onInvalidated(index: number, reason: 'swiped' | 'deleted' | 'edited'): void {
        if (this.disposed || !Number.isInteger(index) || index < 0) return;
        if (reason !== 'edited') {
            for (const pending of [...this.pending]) if (pending >= index) this.pending.delete(pending);
            const chatId = this.app.host.chatId() ?? '';
            for (const key of [...this.enqueued]) {
                const [chat, at] = key.split('|');
                if (chat === chatId && Number(at) >= index) this.enqueued.delete(key);
            }
            return;
        }
        // An edit of the latest committed reply: the state took its changes back; derive them again.
        const committed = committedIndices(this.app.host.ctx().chat);
        if (committed[committed.length - 1] !== index) return;
        const chatId = this.app.host.chatId() ?? '';
        for (const key of [...this.enqueued]) if (key.startsWith(`${chatId}|${index}|`)) this.enqueued.delete(key);
        this.schedule(index);
    }
}
