// M25 «Механики», checks part (plan M25 п.3, §5 phase 1 «Делает броски механик», §8 «броски механик — Само», P15):
// - auto checks: at ST's MESSAGE_SENT (the user's message index, before the generate interceptor runs the producers)
//   the story part of the message is read for the trigger words of the checks on in this chat (domain detection,
//   string work only) and at most one check is rolled at once; the save, the journal entry and the message badge
//   follow without being awaited (P15);
// - the roll belongs to the user message: swipes, regenerations and continues never roll again (MESSAGE_SENT does not
//   fire for them; the prompt part repeats the delivered fact); an edit of the last user message keeps the roll while
//   the same check is called for and replaces it otherwise; deleting the message drops its undelivered roll;
// - rolls by the pult button and `/maestro-roll <check> [who] [difficulty]` are 'user' rolls; one made before the
//   message is sent belongs to that message and stops the auto roll for it;
// - the log is a small per-chat Maestro document `mechanics-checks` (newest last, bounded); results not yet given to
//   the model are «pending» until the prompt part marks them delivered after a finished generation;
// - every roll is journaled (kind 'mechanics.check', nothing to undo); an autonomy level 'off' stops auto rolls;
// - plan-2 §6: a check's effects (consequences per outcome) are resolved when it is rolled (formulas over the actor's
//   values, the roll's total and margin) and applied at once (source 'check', the roll's id: undoRoll takes them
//   back); the fact names them. Skills used by a check grow by use. Statuses and equipped items add their modifiers.
//   Advantage / disadvantage and opposed checks ("vs Guard.Perception"); the model may ask for rolls in its service
//   block (`roll: …`, by 'model'): rolled as the reply arrives, they belong to the reply (a swipe drops them) and reach
//   the next generation as facts. A secret mechanic's roll gives the model only its outcomes; a hidden one is marked
//   so the player surfaces skip it.
import { stableHash } from '../../domain/hash';
import { resolveRollHead } from '../../domain/mechanics-block';
import type { BlockRoll, RollCheckRef } from '../../domain/mechanics-block';
import { detectCheck, difficultyWord, normalizeWord } from '../../domain/mechanics-checks';
import type { ActorNames, CheckTrigger } from '../../domain/mechanics-checks';
import { criticalsOf, diceAttributes, initialValueOf, parseDice } from '../../domain/mechanics-defs';
import type { DiceFormula } from '../../domain/mechanics-defs';
import { checkFact, difficultyFor, marginOf, opposedFact, opposedOutcome, rollDice } from '../../domain/mechanics-dice';
import type { DiceOutcome, DiceRoll, DifficultyLevel, RollMode, Rng } from '../../domain/mechanics-dice';
import { resolveActions } from '../../domain/mechanics-effects';
import { resolveHolder as resolveStateHolder } from '../../domain/mechanics-state';
import { grownValue } from '../../domain/mechanics-time';
import { resolveVisibility } from '../../domain/mechanics-visibility';
import { detectSheetCommand } from '../../domain/sheets';
import { cleanForAnalysis } from '../../domain/text-clean';
import type { I18n, JournalAction, SlashCommandSpec, Unsubscribe } from '../../shared/contracts';
import type { WorldModelApi } from '../world/api';
import type { CheckDef, CheckOutcome, CheckResult, MechanicDef } from './api';
import { MECHANICS_ID } from './parts';
import type { ChecksPart, DefinitionsPart, PartDeps, RollOptions, StateOp, StatePart } from './parts';
import { BATCH_UNDO_TARGET } from './state';
import { holderContextOf } from './state-holders';

// The domain's outcomes are exactly the API's (src/domain cannot import feature types).
type Exact<T, U> = [T] extends [U] ? ([U] extends [T] ? true : never) : never;
const sameOutcomes: Exact<DiceOutcome, CheckOutcome> = true;
void sameOutcomes;

/** Per-chat document of the roll log. */
export const CHECKS_DOC = 'mechanics-checks';
/** Journal and autonomy kind of a roll. */
export const CHECK_KIND = 'mechanics.check';
export const ROLL_COMMAND = 'maestro-roll';
const RESULTS_KEPT = 100;
/** Rolls the model may ask for in one reply. */
const MODEL_ROLLS_MAX = 3;
/** Journal kind of taking a roll's consequences back. */
export const UNDO_ROLL_KIND = 'mechanics.undoRoll';
const BADGES_SHOWN = 20;
const DEFAULT_SAVE_MS = 300;
const OUTCOMES: readonly CheckOutcome[] = ['critical', 'success', 'failure', 'fumble', 'none'];
/** Words of a check name tried at the start of the command (multi-word names such as «Взлом замков»). */
const NAME_WORDS_MAX = 4;

interface StoredCheck extends CheckResult {
    delivered?: boolean;
    /** Rolled for a user message whose reply never came before the next one: never given to the model. */
    expired?: boolean;
    /** Hash of the user message text: badges and edits find their message by it. */
    stamp?: string;
    /** Model rolls: the swipe of the reply that asked. */
    swipe?: number;
}

interface ChecksDoc {
    results: StoredCheck[];
}

export interface ChecksOptions {
    rng?: Rng;
    saveMs?: number;
}

type Dict = Record<string, unknown>;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function emptyDoc(): ChecksDoc {
    return { results: [] };
}

function readResult(raw: unknown): StoredCheck | null {
    if (!isDict(raw)) return null;
    const { id, mechanicId, checkId, holder, dice, text } = raw;
    if (typeof id !== 'string' || !id || typeof mechanicId !== 'string' || typeof checkId !== 'string') return null;
    if (typeof holder !== 'string' || typeof text !== 'string') return null;
    const number = (value: unknown, fallback: number): number =>
        typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    const result: StoredCheck = {
        id,
        mechanicId,
        checkId,
        holder,
        dice: typeof dice === 'string' ? dice : '',
        rolls: Array.isArray(raw.rolls) ? raw.rolls.filter((item): item is number => typeof item === 'number') : [],
        modifier: number(raw.modifier, 0),
        total: number(raw.total, 0),
        target: typeof raw.target === 'number' && Number.isFinite(raw.target) ? raw.target : null,
        outcome: OUTCOMES.includes(raw.outcome as CheckOutcome) ? (raw.outcome as CheckOutcome) : 'none',
        text,
        messageIndex: Math.trunc(number(raw.messageIndex, -1)),
        by: raw.by === 'auto' ? 'auto' : 'user',
        at: number(raw.at, 0),
    };
    if (raw.by === 'model') result.by = 'model';
    if (raw.delivered === true) result.delivered = true;
    if (raw.expired === true) result.expired = true;
    if (typeof raw.stamp === 'string') result.stamp = raw.stamp;
    if (typeof raw.swipe === 'number') result.swipe = raw.swipe;
    if (raw.mode === 'adv' || raw.mode === 'dis') result.mode = raw.mode;
    if (typeof raw.other === 'number') result.other = raw.other;
    if (isDict(raw.vs) && typeof raw.vs.holder === 'string' && typeof raw.vs.checkId === 'string') {
        result.vs = {
            holder: raw.vs.holder,
            mechanicId: typeof raw.vs.mechanicId === 'string' ? raw.vs.mechanicId : mechanicId,
            checkId: raw.vs.checkId,
            total: number(raw.vs.total, 0),
            rolls: Array.isArray(raw.vs.rolls)
                ? raw.vs.rolls.filter((item): item is number => typeof item === 'number')
                : [],
        };
    }
    if (Array.isArray(raw.consequences)) {
        result.consequences = raw.consequences.filter((item): item is string => typeof item === 'string');
    }
    if (Array.isArray(raw.changes))
        result.changes = raw.changes.filter((item): item is string => typeof item === 'string');
    if (raw.hidden === true) result.hidden = true;
    if (raw.undone === true) result.undone = true;
    return result;
}

function readResults(doc: unknown): StoredCheck[] {
    const list = isDict(doc) && Array.isArray(doc.results) ? doc.results : [];
    return list.map(readResult).filter((item): item is StoredCheck => item !== null);
}

function publicResult(result: StoredCheck): CheckResult {
    const out: CheckResult = {
        id: result.id,
        mechanicId: result.mechanicId,
        checkId: result.checkId,
        holder: result.holder,
        dice: result.dice,
        rolls: [...result.rolls],
        modifier: result.modifier,
        total: result.total,
        target: result.target,
        outcome: result.outcome,
        text: result.text,
        messageIndex: result.messageIndex,
        by: result.by,
        at: result.at,
    };
    if (result.mode) out.mode = result.mode;
    if (result.other !== undefined) out.other = result.other;
    if (result.vs) out.vs = { ...result.vs, rolls: [...result.vs.rolls] };
    if (result.consequences?.length) out.consequences = [...result.consequences];
    if (result.changes?.length) out.changes = [...result.changes];
    if (result.hidden) out.hidden = true;
    if (result.undone) out.undone = true;
    return out;
}

function pending(result: StoredCheck): boolean {
    return !result.delivered && !result.expired;
}

/** Name comparison key: case, ё, underscores and spaces do not matter. */
export function nameKey(name: string): string {
    return normalizeWord(name)
        .replace(/[_\s]+/g, ' ')
        .trim();
}

function stampOf(message: STChatMessage | undefined): string {
    return stableHash(typeof message?.mes === 'string' ? message.mes : '');
}

function lastUserIndex(chat: readonly STChatMessage[]): number {
    for (let i = chat.length - 1; i >= 0; i--) if (chat[i]?.is_user) return i;
    return -1;
}

/** A random number in [0, 1) from the platform's cryptographic source (Math.random where it is missing). */
export function secureRng(): number {
    try {
        const buffer = new Uint32Array(1);
        globalThis.crypto.getRandomValues(buffer);
        return (buffer[0] as number) / 4294967296;
    } catch {
        return Math.random();
    }
}

/** The display name of a result's check (its definition may be gone: the id then). */
export function checkNameOf(defs: Pick<DefinitionsPart, 'get'>, result: Pick<CheckResult, 'mechanicId' | 'checkId'>) {
    try {
        return defs.get(result.mechanicId)?.checks.find((check) => check.id === result.checkId)?.name ?? result.checkId;
    } catch {
        return result.checkId;
    }
}

/** One localized line: «Убеждение (Kai): 16 против 15 — успех». */
export function describeCheck(
    result: Pick<CheckResult, 'holder' | 'total' | 'target' | 'outcome' | 'dice'>,
    i18n: Pick<I18n, 't'>,
    checkName: string,
): string {
    const under = result.dice.includes('<=');
    if (result.outcome === 'none' && result.target === null) {
        return i18n.t('m25.check.line.plain', { check: checkName, holder: result.holder, total: result.total });
    }
    const target =
        result.target === null ? '' : i18n.t(under ? 'm25.check.under' : 'm25.check.vs', { target: result.target });
    return i18n.t('m25.check.line', {
        check: checkName,
        holder: result.holder,
        total: result.total,
        target,
        outcome: i18n.t(`m25.check.outcome.${result.outcome}`),
    });
}

interface Found {
    def: MechanicDef;
    check: CheckDef;
    holder: string;
    explicit: number | null;
    level: DifficultyLevel | null;
}

interface RollSpec {
    explicit: number | null;
    level: DifficultyLevel | null;
    by: 'auto' | 'user' | 'model';
    messageIndex: number;
    /** Auto rolls: nothing is rolled when the formula or a value is missing (instead of an error). */
    strict: boolean;
    mode?: RollMode | null;
    /** The other side of an opposed check. */
    vs?: { def: MechanicDef; check: CheckDef; holder: string } | null;
    swipe?: number;
}

/** A roll and the state operations its consequences make. */
interface Rolled {
    result: StoredCheck;
    ops: StateOp[];
}

export class MechanicChecks implements ChecksPart {
    private results: StoredCheck[] = [];
    private chatId: string | null = null;
    private loaded = false;
    private loading: Promise<void> = Promise.resolve();
    private generation = 0;
    private readonly listeners = new Set<() => void>();
    private readonly offs: Unsubscribe[] = [];
    private readonly badges = new Map<string, Unsubscribe>();
    private saveTimer: ReturnType<typeof setTimeout> | null = null;
    private disposed = false;
    private readonly rng: Rng;
    private readonly saveMs: number;

    constructor(
        private readonly deps: PartDeps,
        private readonly defs: DefinitionsPart,
        private readonly state: StatePart,
        options: ChecksOptions = {},
    ) {
        this.rng = options.rng ?? secureRng;
        this.saveMs = options.saveMs ?? DEFAULT_SAVE_MS;
    }

    private t(key: string, params?: Record<string, string | number>): string {
        return this.deps.app.i18n.t(key, params);
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(): void {
        const { app } = this.deps;
        const sent = app.host.events.name('MESSAGE_SENT');
        if (sent) this.offs.push(app.host.events.on(sent, (messageId) => this.onSent(messageId)));
        else this.deps.log.warn('ST event MESSAGE_SENT is missing: no auto checks');
        this.offs.push(app.bus.on('chat:changed', () => this.open()));
        this.offs.push(
            app.bus.on('message:invalidated', ({ messageIndex, reason }) => this.onInvalidated(messageIndex, reason)),
        );
        this.offs.push(app.ui.addSlashCommand(this.command()));
        this.open();
    }

    dispose(): void {
        if (this.disposed) return;
        if (this.saveTimer !== null) {
            clearTimeout(this.saveTimer);
            this.saveTimer = null;
            void this.save().catch((error: unknown) => this.deps.log.warn('roll log was not saved', error));
        }
        this.disposed = true;
        this.generation++;
        for (const off of this.offs.splice(0)) {
            try {
                off();
            } catch (error) {
                this.deps.log.debug('checks: release failed', error);
            }
        }
        this.clearBadges();
        this.listeners.clear();
    }

    /** Resolves once the log of the open chat is loaded. */
    ready(): Promise<void> {
        return this.loading;
    }

    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    private changed(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.deps.log.error('checks listener failed', error);
            }
        }
    }

    /* ---------------------------------------------------------------- chat open */

    private open(): void {
        const generation = ++this.generation;
        this.clearBadges();
        this.results = [];
        this.loaded = false;
        this.chatId = this.deps.app.host.chatId();
        this.changed();
        const chatId = this.chatId;
        if (!chatId || this.disposed) {
            this.loading = Promise.resolve();
            return;
        }
        this.loading = this.load(chatId, generation).catch((error: unknown) =>
            this.deps.log.warn('roll log could not be loaded', error),
        );
    }

    private async load(chatId: string, generation: number): Promise<void> {
        let doc: unknown;
        try {
            doc = await this.deps.app.chat.get<ChecksDoc>(CHECKS_DOC, emptyDoc);
        } catch (error) {
            this.deps.log.warn('roll log could not be read', error);
            doc = emptyDoc();
        }
        if (generation !== this.generation || this.disposed || chatId !== this.chatId) return;
        const stored = readResults(doc);
        const ids = new Set(stored.map((result) => result.id));
        // Rolls made while the log was loading (a message sent right after opening the chat) stay, newest last.
        const fresh = this.results.filter((result) => !ids.has(result.id));
        this.results = [...stored, ...fresh].slice(-RESULTS_KEPT);
        this.loaded = true;
        if (fresh.length) this.saveSoon();
        for (const result of this.results.slice(-BADGES_SHOWN)) this.badge(result);
        this.changed();
    }

    /* ---------------------------------------------------------------- the send path */

    private onSent(messageId: unknown): void {
        try {
            this.sent(Number(messageId));
        } catch (error) {
            this.deps.log.warn('mechanics auto check failed', error);
        }
    }

    private autoAllowed(): boolean {
        const { app } = this.deps;
        if (!this.deps.settings().autoChecks || app.host.isGroupChat()) return false;
        try {
            return app.autonomy.level(CHECK_KIND, 'auto') !== 'off';
        } catch {
            return true;
        }
    }

    /** The user sent message `index`: earlier undelivered rolls expire, his own pending rolls join it, then detection. */
    private sent(index: number): void {
        if (this.disposed || !Number.isInteger(index) || index < 0) return;
        const { app } = this.deps;
        const chatId = app.host.chatId();
        if (!chatId || chatId !== this.chatId) return;
        const message = app.host.ctx().chat?.[index];
        if (!message?.is_user) return;
        let touched = false;
        let manual = false;
        const stamp = stampOf(message);
        for (const result of this.results) {
            if (!pending(result)) continue;
            // The model asked for it in the reply this message answers: it goes to the next generation.
            if (result.by === 'model' && result.messageIndex === index - 1) continue;
            if (result.messageIndex < 0) {
                result.messageIndex = index;
                result.stamp = stamp;
                manual = true;
                touched = true;
                this.badge(result);
            } else if (result.messageIndex < index) {
                result.expired = true;
                touched = true;
            } else if (result.messageIndex === index) {
                manual = true;
            }
        }
        if (touched) {
            this.saveSoon();
            this.changed();
        }
        if (manual || !this.autoAllowed()) return;
        if (this.results.some((result) => result.messageIndex === index && result.by === 'auto' && !result.expired))
            return;
        if (detectSheetCommand(message.mes)) return;
        const found = this.detect(message);
        if (!found) return;
        const rolled = this.makeRoll(found.def, found.check, found.holder, {
            explicit: found.explicit,
            level: found.level,
            by: 'auto',
            messageIndex: index,
            strict: true,
        });
        if (rolled) this.record(rolled);
    }

    /** The check the message calls for, with its actor, or null (no roll). */
    private detect(message: STChatMessage): Found | null {
        const text = cleanForAnalysis(message);
        if (!text) return null;
        const active = this.defs.active();
        const withChecks = active.filter((def) => def.checks.length > 0);
        if (!withChecks.length) return null;
        const triggers: CheckTrigger[] = withChecks.flatMap((def) =>
            def.checks.map((check) => ({ mechanicId: def.id, checkId: check.id, triggers: check.triggers })),
        );
        const detected = detectCheck(text, triggers, this.actors(active));
        if (!detected) return null;
        const def = withChecks.find((item) => item.id === detected.mechanicId);
        const check = def?.checks.find((item) => item.id === detected.checkId);
        if (!def || !check) return null;
        const holder = this.actingHolder(def, detected.holder);
        if (!holder) return null;
        return { def, check, holder, explicit: detected.difficulty, level: detected.level };
    }

    /* ---------------------------------------------------------------- holders */

    private personaName(): string {
        return (this.deps.app.host.ctx().name1 ?? '').trim();
    }

    private holdersOf(def: MechanicDef): string[] {
        try {
            return this.state.holdersInScene(def);
        } catch (error) {
            this.deps.log.debug('holders in the scene are not available', error);
            return [];
        }
    }

    private isHolder(def: MechanicDef, holder: string): boolean {
        const key = nameKey(holder);
        if (this.holdersOf(def).some((name) => nameKey(name) === key)) return true;
        try {
            return this.state.state(holder).some((item) => item.mechanicId === def.id);
        } catch {
            return false;
        }
    }

    /** Who rolls when nobody is named: the persona as the mechanic's holder, else the persona, else the first holder. */
    defaultHolder(def: MechanicDef): string {
        const persona = this.personaName();
        const holders = this.holdersOf(def);
        const key = nameKey(persona);
        return holders.find((name) => nameKey(name) === key) ?? (persona || holders[0] || '');
    }

    /** The actor named in the message must hold the mechanic (someone else acting is not the persona's roll). */
    private actingHolder(def: MechanicDef, named: string | null): string | null {
        if (!named) return this.defaultHolder(def) || null;
        const key = nameKey(named);
        return this.holdersOf(def).find((name) => nameKey(name) === key) ?? null;
    }

    private world(): WorldModelApi | undefined {
        try {
            return this.deps.app.modules.api<WorldModelApi>('world');
        } catch {
            return undefined;
        }
    }

    /** Everyone who may act: character holders of the mechanics on (with their world names and forms), the persona. */
    private actors(defs: readonly MechanicDef[]): ActorNames[] {
        const world = this.world();
        const actors = new Map<string, ActorNames>();
        const add = (holder: string) => {
            const key = nameKey(holder);
            if (!key || actors.has(key)) return;
            const names = [holder];
            try {
                const entity = world?.resolve(holder);
                if (entity) names.push(entity.name, ...entity.aliases, ...entity.forms);
            } catch (error) {
                this.deps.log.debug('world names are not available', error);
            }
            actors.set(key, { holder, names });
        };
        for (const def of defs) {
            if (def.holders.kind === 'world' || def.holders.kind === 'factions') continue;
            for (const holder of this.holdersOf(def)) add(holder);
        }
        const persona = this.personaName();
        if (persona) add(persona);
        return [...actors.values()];
    }

    private resolveHolder(def: MechanicDef, text: string): string {
        const wanted = nameKey(text);
        let known: string[] = this.holdersOf(def);
        try {
            known = [
                ...known,
                ...this.state
                    .state()
                    .filter((item) => item.mechanicId === def.id)
                    .map((item) => item.holder),
            ];
        } catch {
            // the scene's holders are enough
        }
        const direct = known.find((name) => nameKey(name) === wanted);
        if (direct) return direct;
        try {
            const entity = this.world()?.resolve(text.trim());
            if (entity) return known.find((name) => nameKey(name) === nameKey(entity.name)) ?? entity.name;
        } catch {
            // typed name as is
        }
        return text.trim();
    }

    /* ---------------------------------------------------------------- rolling */

    /**
     * A number for the dice: the value with status and item modifiers (a scale's level index); the initial value for
     * a holder without one yet.
     */
    private numeric(def: MechanicDef, holder: string, attributeId: string, known: boolean): number | null {
        const attribute = def.attributes.find((item) => item.id === attributeId);
        if (!attribute) return null;
        if (this.state.numberOf && known) {
            const number = this.state.numberOf(def.id, holder, attributeId);
            if (number !== null) return number;
        }
        let value = this.state.value(def.id, holder, attributeId);
        if (value === null && known) value = initialValueOf(attribute);
        if (typeof value === 'number' && Number.isFinite(value)) return value;
        if (attribute.kind === 'scale' && typeof value === 'string') {
            const index = (attribute.levels ?? []).indexOf(value);
            return index >= 0 ? index : null;
        }
        return null;
    }

    private targetOf(check: CheckDef, formula: DiceFormula, explicit: number | null, level: DifficultyLevel | null) {
        if (formula.under) return null;
        if (explicit !== null && Number.isFinite(explicit)) return explicit;
        if (level && level !== 'normal') return difficultyFor(level, check.difficulty, formula);
        return check.difficulty;
    }

    private attributeName(def: MechanicDef, id: string): string {
        return def.attributes.find((attribute) => attribute.id === id)?.name ?? id;
    }

    private bonusOf(def: MechanicDef, check: CheckDef, holder: string): number {
        try {
            return this.state.checkBonus?.(def, check.id, holder) ?? 0;
        } catch {
            return 0;
        }
    }

    /** One side's roll (the actor's, or the other side of an opposed check). */
    private rollFor(
        def: MechanicDef,
        check: CheckDef,
        formula: DiceFormula,
        holder: string,
        spec: Pick<RollSpec, 'explicit' | 'level' | 'mode'>,
        opposed: boolean,
    ): DiceRoll {
        const known = this.isHolder(def, holder);
        return rollDice(formula, (attribute) => this.numeric(def, holder, attribute, known), this.rng, {
            difficulty: opposed ? null : this.targetOf(check, formula, spec.explicit, spec.level),
            level: formula.under ? spec.level : null,
            criticals: criticalsOf(check),
            mode: spec.mode ?? null,
            bonus: this.bonusOf(def, check, holder),
        });
    }

    /** The consequences of an outcome: state operations and English notes (the actor's values, the roll). */
    private consequences(
        def: MechanicDef,
        check: CheckDef,
        holder: string,
        target: string | null,
        roll: DiceRoll,
        outcome: DiceOutcome,
        formula: DiceFormula,
        messageIndex: number,
        margin: number,
    ): { ops: StateOp[]; notes: string[] } {
        const ops: StateOp[] = [];
        const notes: string[] = [];
        const matches = (on: string) =>
            on === 'any' ||
            on === outcome ||
            (on === 'success' && outcome === 'critical') ||
            (on === 'failure' && outcome === 'fumble');
        const context = holderContextOf(this.deps.app);
        for (const effect of (check.effects ?? []).filter((item) => matches(item.on))) {
            const resolved = resolveActions(effect.changes, {
                def,
                actor: holder,
                target,
                persona: context.persona,
                getDef: (id) => this.defs.get(id),
                resolveHolder: (owner, raw) => resolveStateHolder(owner, raw, context),
                numberOf: (mechanicId, who, attribute) =>
                    this.state.numberOf?.(mechanicId, who, attribute) ??
                    numberValue(this.state.value(mechanicId, who, attribute)),
                roll: { total: roll.total, margin, natural: roll.natural },
                rng: this.rng,
                base: { source: 'check', messageIndex, reason: check.promptName || check.name },
            });
            ops.push(...resolved.ops);
            notes.push(...resolved.notes);
            if (effect.text) notes.push(effect.text);
        }
        // Growth by use: the attributes the dice read.
        for (const attributeId of diceAttributes(formula)) {
            const attribute = def.attributes.find((item) => item.id === attributeId);
            if (!attribute?.growth || attribute.formula) continue;
            const current = numberValue(this.state.value(def.id, holder, attributeId));
            if (current === null) continue;
            const next = grownValue(current, attribute.growth, outcome, attribute.max);
            if (next === null || next === current) continue;
            ops.push({
                mechanicId: def.id,
                holder,
                attribute: attributeId,
                value: next,
                source: 'check',
                messageIndex,
                reason: check.promptName || check.name,
            });
        }
        return { ops, notes };
    }

    private makeRoll(def: MechanicDef, check: CheckDef, holder: string, spec: RollSpec): Rolled | null {
        const formula = parseDice(check.dice);
        if (!formula) {
            if (spec.strict) {
                this.deps.log.debug(`check ${def.id}.${check.id}: formula "${check.dice}" cannot be rolled`);
                return null;
            }
            throw new Error(this.t('m25.check.error.formula', { dice: check.dice }));
        }
        const known = this.isHolder(def, holder);
        // An auto roll that lacks a value is not made at all (and spends no randomness).
        if (spec.strict && diceAttributes(formula).some((id) => this.numeric(def, holder, id, known) === null)) {
            return null;
        }
        const vs = spec.vs ?? null;
        const roll = this.rollFor(def, check, formula, holder, spec, !!vs && !formula.under);
        if (formula.under && roll.target === null) {
            throw new Error(
                this.t('m25.check.error.noValue', {
                    attribute: this.attributeName(def, roll.missing[0] as string),
                    holder,
                }),
            );
        }
        let outcome: DiceOutcome = roll.outcome;
        let text = checkFact(check.promptName || check.name, holder, roll);
        let other: DiceRoll | null = null;
        if (vs) {
            const otherFormula = parseDice(vs.check.dice);
            if (otherFormula) {
                other = this.rollFor(
                    vs.def,
                    vs.check,
                    otherFormula,
                    vs.holder,
                    { explicit: null, level: null },
                    !otherFormula.under,
                );
                outcome = opposedOutcome(roll, other);
                text = opposedFact(
                    { check: check.promptName || check.name, holder, roll },
                    { check: vs.check.promptName || vs.check.name, holder: vs.holder, roll: other },
                    outcome,
                );
            }
        }
        // How far the actor won (or lost): over the target, or over the other side of an opposed check.
        const margin = other
            ? formula.under
                ? marginOf(roll) - marginOf(other)
                : roll.total - other.total
            : marginOf(roll);
        const { ops, notes } = this.consequences(
            def,
            check,
            holder,
            vs?.holder ?? null,
            roll,
            outcome,
            formula,
            spec.messageIndex,
            margin,
        );
        const visibility = resolveVisibility(def);
        if (visibility.preset === 'secret') {
            // The model gets only what came of it.
            const outcomes = (check.effects ?? [])
                .filter((effect) => effect.text)
                .map((effect) => effect.text as string);
            const said = notes.filter((note) => outcomes.includes(note));
            text = said.length ? `${check.promptName || check.name}: ${said.join('; ')}.` : '';
        } else if (notes.length) {
            text = `${text} Consequences: ${notes.join('; ')}.`;
        }
        const result: StoredCheck = {
            // Not from this.rng: an injected (seeded) RNG serves the dice only.
            id: `m25c-${Date.now().toString(36)}-${Math.floor(Math.random() * 1e9).toString(36)}`,
            mechanicId: def.id,
            checkId: check.id,
            holder,
            dice: formula.text,
            rolls: roll.rolls,
            modifier: roll.modifier,
            total: roll.total,
            target: other ? other.total : roll.target,
            outcome,
            text,
            messageIndex: spec.messageIndex,
            by: spec.by,
            at: Date.now(),
        };
        if (roll.mode && roll.other) {
            result.mode = roll.mode;
            result.other = roll.other.total;
        }
        if (vs && other) {
            result.vs = {
                holder: vs.holder,
                mechanicId: vs.def.id,
                checkId: vs.check.id,
                total: other.total,
                rolls: other.rolls,
            };
        }
        if (notes.length) result.consequences = notes;
        if (visibility.preset === 'secret' || visibility.preset === 'hidden') result.hidden = true;
        if (spec.swipe !== undefined) result.swipe = spec.swipe;
        if (spec.messageIndex >= 0 && spec.by !== 'model') {
            result.stamp = stampOf(this.deps.app.host.ctx().chat?.[spec.messageIndex]);
        }
        return { result, ops: ops.map((op) => ({ ...op, rollId: result.id })) };
    }

    private record(rolled: Rolled): void {
        const { result, ops } = rolled;
        this.results.push(result);
        if (this.results.length > RESULTS_KEPT) this.results.splice(0, this.results.length - RESULTS_KEPT);
        this.badge(result);
        this.journal(result, ops.length);
        this.saveSoon();
        this.changed();
        this.state.emitEvent?.({ type: 'roll', result: publicResult(result) });
        if (ops.length) {
            // Off the send path: the consequences land in the state when its queue gets to them.
            void Promise.resolve()
                .then(() => this.applyConsequences(result, ops))
                .catch((error: unknown) => this.deps.log.warn('roll consequences were not applied', error));
        }
    }

    private async applyConsequences(result: StoredCheck, ops: StateOp[]): Promise<void> {
        let changes: { id: string }[] = [];
        if (this.state.applyOps) changes = await this.state.applyOps(ops, { journal: false });
        else {
            const values = ops.filter((op) => op.kind === undefined || op.kind === 'value');
            if (values.length) changes = await this.state.apply(values as never);
        }
        if (!changes.length) return;
        result.changes = changes.map((change) => change.id);
        this.saveSoon();
        this.changed();
    }

    /** The roll in the journal; with consequences its undo takes them back (target 'mechanics.batch', by roll id). */
    private journal(result: StoredCheck, consequences = 0): void {
        const line = describeCheck(result, this.deps.app.i18n, checkNameOf(this.defs, result));
        const chatId = this.deps.app.host.chatId();
        const action: JournalAction = {
            module: MECHANICS_ID,
            kind: CHECK_KIND,
            // A hidden or secret roll: not even the journal tells its result.
            summary: result.hidden ? this.t('m25.check.journal.hidden') : this.t('m25.check.journal', { line }),
            changes:
                consequences > 0 && chatId
                    ? [
                          {
                              target: BATCH_UNDO_TARGET,
                              ref: { chatId, rollId: result.id },
                              before: { count: consequences },
                              after: null,
                          },
                      ]
                    : [],
        };
        if (result.messageIndex >= 0) action.sourceMessage = result.messageIndex;
        // Off the send path: the journal writes its file on its own schedule.
        void Promise.resolve()
            .then(() => this.deps.app.journal.record(action))
            .catch((error: unknown) => this.deps.log.warn('roll was not journaled', error));
    }

    private require(mechanicId: string, checkId: string): { def: MechanicDef; check: CheckDef } {
        const def = this.defs.get(mechanicId);
        if (!def) throw new Error(this.t('m25.check.error.unknownMechanic', { id: mechanicId }));
        const check = def.checks.find((item) => item.id === checkId);
        if (!check) throw new Error(this.t('m25.check.error.unknownCheck', { name: checkId }));
        return { def, check };
    }

    private rollNow(
        def: MechanicDef,
        check: CheckDef,
        holder: string,
        difficulty: { explicit: number | null; level: DifficultyLevel | null },
        extra: Pick<RollSpec, 'mode' | 'vs'> = {},
    ): StoredCheck {
        if (!this.deps.app.host.chatId()) throw new Error(this.t('m25.check.error.noChat'));
        const name = holder.trim() || this.defaultHolder(def);
        if (!name) throw new Error(this.t('m25.check.error.noHolder'));
        const rolled = this.makeRoll(def, check, name, {
            ...difficulty,
            ...extra,
            by: 'user',
            messageIndex: -1,
            strict: false,
        });
        if (!rolled) throw new Error(this.t('m25.check.error.formula', { dice: check.dice }));
        this.record(rolled);
        return rolled.result;
    }

    async roll(mechanicId: string, checkId: string, holder: string, options: RollOptions = {}): Promise<CheckResult> {
        const { def, check } = this.require(mechanicId, checkId);
        const explicit = typeof options.difficulty === 'number' ? options.difficulty : null;
        let vs: RollSpec['vs'] = null;
        if (options.vs?.holder) {
            const other = this.require(options.vs.mechanicId ?? def.id, options.vs.checkId ?? check.id);
            vs = { ...other, holder: this.resolveHolder(other.def, options.vs.holder) };
        }
        return publicResult(
            this.rollNow(def, check, holder, { explicit, level: null }, { mode: options.mode ?? null, vs }),
        );
    }

    /* ---------------------------------------------------------------- rolls the model asks for */

    /** Names of the checks the model may ask for (the block instruction lists them). */
    checkNames(): string[] {
        try {
            return this.defs
                .active()
                .filter((def) => resolveVisibility(def).prompt !== 'none')
                .flatMap((def) => def.checks.map((check) => check.promptName || check.name))
                .filter(Boolean);
        } catch {
            return [];
        }
    }

    private checkRefs(): RollCheckRef[] {
        return this.defs.active().flatMap((def) =>
            def.checks.map((check) => ({
                mechanicId: def.id,
                checkId: check.id,
                names: [`${def.id}.${check.id}`, check.id, check.name, check.promptName].filter(Boolean),
            })),
        );
    }

    /**
     * The block of a reply asks for rolls (`roll: Stealth Kai vs Guard.Perception adv`): rolled now, they belong to
     * the reply (a swipe drops them) and reach the next generation as facts.
     */
    requested(index: number, swipeId: number, rolls: readonly BlockRoll[]): void {
        if (this.disposed || !this.deps.settings().modelRolls || !Number.isInteger(index) || index < 0) return;
        if (!this.deps.app.host.chatId() || this.deps.app.host.chatId() !== this.chatId) return;
        const refs = this.checkRefs();
        let made = this.results.filter(
            (result) => result.by === 'model' && result.messageIndex === index && result.swipe === swipeId,
        ).length;
        for (const request of rolls) {
            if (made >= MODEL_ROLLS_MAX) break;
            try {
                const head = resolveRollHead(request.head, refs);
                if (!head) continue;
                const { def, check } = this.require(head.check.mechanicId, head.check.checkId);
                const holder = head.actor ? this.resolveHolder(def, head.actor) : this.defaultHolder(def);
                if (!holder) continue;
                let vs: RollSpec['vs'] = null;
                if (request.vs?.holder) {
                    const named = request.vs.check ? resolveRollHead(request.vs.check, refs) : null;
                    const other = named ? this.require(named.check.mechanicId, named.check.checkId) : { def, check };
                    vs = { ...other, holder: this.resolveHolder(other.def, request.vs.holder) };
                }
                const rolled = this.makeRoll(def, check, holder, {
                    explicit: request.difficulty ?? null,
                    level: request.level ?? null,
                    by: 'model',
                    messageIndex: index,
                    strict: false,
                    mode: request.mode ?? null,
                    vs,
                    swipe: swipeId,
                });
                if (!rolled) continue;
                this.record(rolled);
                made++;
            } catch (error) {
                this.deps.log.debug(`mechanics: the roll "${request.line}" was not made`, error);
            }
        }
    }

    /* ---------------------------------------------------------------- per message and undo */

    rollsOf(messageIndex: number): CheckResult[] {
        return this.results.filter((result) => result.messageIndex === messageIndex).map(publicResult);
    }

    async undoRoll(rollId: string): Promise<boolean> {
        const result = this.results.find((item) => item.id === rollId);
        if (!result || result.undone) return false;
        const line = describeCheck(result, this.deps.app.i18n, checkNameOf(this.defs, result));
        const removed =
            (await this.state.undoWhere?.((change) => change.rollId === rollId, {
                kind: UNDO_ROLL_KIND,
                summary: this.t('m25.check.journal.undone', { line }),
            })) ?? [];
        result.undone = true;
        this.saveSoon();
        this.changed();
        return removed.length > 0 || !result.changes?.length;
    }

    /* ---------------------------------------------------------------- the log */

    checks(limit = 20): CheckResult[] {
        return [...this.results].reverse().slice(0, Math.max(0, limit)).map(publicResult);
    }

    pendingChecks(): CheckResult[] {
        return this.results.filter(pending).map(publicResult);
    }

    markChecksDelivered(results: CheckResult[]): void {
        const ids = new Set(results.map((result) => result.id));
        let touched = false;
        for (const result of this.results) {
            if (!ids.has(result.id) || result.delivered) continue;
            result.delivered = true;
            touched = true;
        }
        if (!touched) return;
        this.saveSoon();
        this.changed();
    }

    /* ---------------------------------------------------------------- swipes, edits, deletions */

    private onInvalidated(index: number, reason: 'swiped' | 'deleted' | 'edited'): void {
        if (this.disposed || !Number.isInteger(index) || index < 0) return;
        try {
            if (reason === 'deleted') this.deleted(index);
            else if (reason === 'edited') this.edited(index);
            else this.swiped(index);
        } catch (error) {
            this.deps.log.warn('mechanics checks: invalidation failed', error);
        }
    }

    /** A reply was swiped: the rolls it asked for go (the state takes their consequences back with the reply). */
    private swiped(index: number): void {
        const before = this.results.length;
        this.results = this.results.filter(
            (result) => !(result.by === 'model' && result.messageIndex >= index && pending(result)),
        );
        if (this.results.length === before) return;
        this.saveSoon();
        this.changed();
    }

    /** Messages from `index` on are gone: their undelivered rolls go too, delivered ones stay as history. */
    private deleted(index: number): void {
        let touched = false;
        this.results = this.results.filter((result) => {
            if (result.messageIndex < index) return true;
            this.unbadge(result.id);
            if (!pending(result)) return true;
            touched = true;
            return false;
        });
        if (!touched) return;
        this.saveSoon();
        this.changed();
    }

    /** The last user message was edited: its auto roll stays while it calls for the same check, else it is redone. */
    private edited(index: number): void {
        const chat = this.deps.app.host.ctx().chat ?? [];
        const message = chat[index];
        if (!message?.is_user || lastUserIndex(chat) !== index) return;
        const stamp = stampOf(message);
        const mine = this.results.filter((result) => result.messageIndex === index && !result.expired);
        if (mine.length && mine.every((result) => result.stamp === stamp)) return;
        // A roll by hand belongs to the message whatever its text says: no auto roll next to it.
        const manual = mine.filter((result) => result.by === 'user');
        if (manual.length || !this.autoAllowed()) {
            for (const result of manual) {
                result.stamp = stamp;
                this.badge(result);
            }
            if (manual.length) this.saveSoon();
            return;
        }
        const autos = mine;
        const found = detectSheetCommand(message.mes) ? null : this.detect(message);
        if (!autos.length && !found) return;
        const same = found
            ? autos.find(
                  (result) =>
                      result.mechanicId === found.def.id &&
                      result.checkId === found.check.id &&
                      nameKey(result.holder) === nameKey(found.holder),
              )
            : undefined;
        const dropped = new Set(autos.filter((result) => result !== same).map((result) => result.id));
        for (const id of dropped) this.unbadge(id);
        if (dropped.size && this.state.undoWhere) {
            void this.state
                .undoWhere((change) => !!change.rollId && dropped.has(change.rollId))
                .catch((error: unknown) => this.deps.log.debug('roll consequences were not taken back', error));
        }
        this.results = this.results.filter((result) => !dropped.has(result.id));
        if (same) {
            same.stamp = stamp;
            this.badge(same);
        } else if (found) {
            const rolled = this.makeRoll(found.def, found.check, found.holder, {
                explicit: found.explicit,
                level: found.level,
                by: 'auto',
                messageIndex: index,
                strict: true,
            });
            if (rolled) {
                this.record(rolled);
                return;
            }
        }
        this.saveSoon();
        this.changed();
    }

    /* ---------------------------------------------------------------- badges on the user's messages */

    private badge(result: StoredCheck): void {
        if (result.messageIndex < 0 || !result.stamp || this.disposed || result.hidden) return;
        const message = this.deps.app.host.ctx().chat?.[result.messageIndex];
        if (!message?.is_user || stampOf(message) !== result.stamp) return;
        this.unbadge(result.id);
        try {
            const line = describeCheck(result, this.deps.app.i18n, checkNameOf(this.defs, result));
            const off = this.deps.app.ui.messageBadge(result.messageIndex, {
                id: `m25-check-${result.id}`,
                text: this.t('m25.check.badge', { line }),
            });
            this.badges.set(result.id, off);
        } catch (error) {
            this.deps.log.debug('roll badge failed', error);
        }
    }

    private unbadge(id: string): void {
        const off = this.badges.get(id);
        if (!off) return;
        this.badges.delete(id);
        try {
            off();
        } catch {
            // the badge is gone with its message
        }
    }

    private clearBadges(): void {
        for (const id of [...this.badges.keys()]) this.unbadge(id);
    }

    /* ---------------------------------------------------------------- /maestro-roll */

    private command(): SlashCommandSpec {
        return {
            name: ROLL_COMMAND,
            helpKey: 'm25.check.slash.help',
            args: [
                { name: 'value', descriptionKey: 'm25.check.slash.value' },
                { name: 'holder', descriptionKey: 'm25.check.slash.holder', optional: true },
                { name: 'difficulty', descriptionKey: 'm25.check.slash.difficulty', optional: true },
            ],
            callback: (args, value) => this.runCommand(args, value),
        };
    }

    private async runCommand(args: Record<string, unknown>, value: string): Promise<string> {
        const { app } = this.deps;
        try {
            const result = this.commandRoll(args, typeof value === 'string' ? value : String(value ?? ''));
            const line = describeCheck(result, app.i18n, checkNameOf(this.defs, result));
            app.ui.notice(this.t('m25.check.rolled', { line }), { urgent: true });
            return result.text;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            app.ui.notice(message, { urgent: true, level: 'warn' });
            return message;
        }
    }

    /** A check by any of its names: `magic.fireball`, the id, the display name, the English name. */
    findCheck(name: string): { def: MechanicDef; check: CheckDef } | null {
        const wanted = nameKey(name);
        if (!wanted) return null;
        for (const def of this.defs.active()) {
            for (const check of def.checks) {
                const names = [
                    `${def.id}.${check.id}`,
                    `${def.id}:${check.id}`,
                    check.id,
                    check.name,
                    check.promptName,
                ];
                if (names.some((item) => typeof item === 'string' && nameKey(item) === wanted)) return { def, check };
            }
        }
        return null;
    }

    private commandRoll(args: Record<string, unknown>, value: string): StoredCheck {
        const words = value.trim().split(/\s+/).filter(Boolean);
        if (!words.length) throw new Error(this.t('m25.check.slash.usage'));
        let found: { def: MechanicDef; check: CheckDef } | null = null;
        let rest: string[] = [];
        for (let count = Math.min(NAME_WORDS_MAX, words.length); count >= 1 && !found; count--) {
            found = this.findCheck(words.slice(0, count).join(' '));
            if (found) rest = words.slice(count);
        }
        if (!found) throw new Error(this.t('m25.check.error.unknownCheck', { name: words[0] as string }));

        let explicit: number | null = null;
        let level: DifficultyLevel | null = null;
        const named = typeof args.difficulty === 'string' && args.difficulty.trim() ? args.difficulty.trim() : null;
        if (named !== null) {
            const parsed = parseDifficulty(named);
            if (!parsed) throw new Error(this.t('m25.check.error.difficulty', { value: named }));
            ({ explicit, level } = parsed);
        } else {
            for (const size of [2, 1]) {
                if (rest.length < size) continue;
                const parsed = parseDifficulty(rest.slice(-size).join(' '));
                if (!parsed) continue;
                ({ explicit, level } = parsed);
                rest = rest.slice(0, -size);
                break;
            }
        }
        const holderText = typeof args.holder === 'string' && args.holder.trim() ? args.holder : rest.join(' ');
        const holder = holderText.trim() ? this.resolveHolder(found.def, holderText) : '';
        return this.rollNow(found.def, found.check, holder, { explicit, level });
    }

    /* ---------------------------------------------------------------- persistence */

    private saveSoon(): void {
        if (this.disposed) return;
        if (this.saveTimer !== null) clearTimeout(this.saveTimer);
        this.saveTimer = setTimeout(() => {
            this.saveTimer = null;
            void this.save().catch((error: unknown) => this.deps.log.warn('roll log was not saved', error));
        }, this.saveMs);
    }

    private async save(): Promise<void> {
        const { app } = this.deps;
        const chatId = this.chatId;
        if (!chatId || !this.loaded || chatId !== app.host.chatId()) return;
        const generation = this.generation;
        if (await app.chat.put<ChecksDoc>(CHECKS_DOC, { results: this.results.map((result) => ({ ...result })) })) {
            return;
        }
        // Another tab wrote first: both logs merged by id (this tab's flags win), then one more write.
        const theirs = readResults(await app.chat.get<ChecksDoc>(CHECKS_DOC, emptyDoc));
        if (generation !== this.generation || chatId !== this.chatId) return;
        const mine = new Map(this.results.map((result) => [result.id, result]));
        const merged = [...theirs.filter((result) => !mine.has(result.id)), ...this.results]
            .sort((a, b) => a.at - b.at)
            .slice(-RESULTS_KEPT);
        this.results = merged;
        await app.chat.put<ChecksDoc>(CHECKS_DOC, { results: merged.map((result) => ({ ...result })) });
        this.changed();
    }
}

function numberValue(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/** A typed difficulty: a number ("15") or words («трудно», "very hard"); null when it is neither. */
export function parseDifficulty(text: string): { explicit: number | null; level: DifficultyLevel | null } | null {
    const trimmed = text.trim();
    if (/^\d{1,4}$/.test(trimmed)) return { explicit: Number(trimmed), level: null };
    const level = difficultyWord(trimmed);
    return level ? { explicit: null, level } : null;
}
