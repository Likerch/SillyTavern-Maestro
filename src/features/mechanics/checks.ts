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
// - every roll is journaled (kind 'mechanics.check', nothing to undo); an autonomy level 'off' stops auto rolls.
import { stableHash } from '../../domain/hash';
import { detectCheck, difficultyWord, normalizeWord } from '../../domain/mechanics-checks';
import type { ActorNames, CheckTrigger } from '../../domain/mechanics-checks';
import { diceAttributes, initialValueOf, parseDice } from '../../domain/mechanics-defs';
import type { DiceFormula } from '../../domain/mechanics-defs';
import { checkFact, difficultyFor, rollDice } from '../../domain/mechanics-dice';
import type { DiceOutcome, DifficultyLevel, Rng } from '../../domain/mechanics-dice';
import { detectSheetCommand } from '../../domain/sheets';
import { cleanForAnalysis } from '../../domain/text-clean';
import type { I18n, JournalAction, SlashCommandSpec, Unsubscribe } from '../../shared/contracts';
import type { WorldModelApi } from '../world/api';
import type { CheckDef, CheckOutcome, CheckResult, MechanicDef } from './api';
import { MECHANICS_ID } from './parts';
import type { ChecksPart, DefinitionsPart, PartDeps, StatePart } from './parts';

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
    if (raw.delivered === true) result.delivered = true;
    if (raw.expired === true) result.expired = true;
    if (typeof raw.stamp === 'string') result.stamp = raw.stamp;
    return result;
}

function readResults(doc: unknown): StoredCheck[] {
    const list = isDict(doc) && Array.isArray(doc.results) ? doc.results : [];
    return list.map(readResult).filter((item): item is StoredCheck => item !== null);
}

function publicResult(result: StoredCheck): CheckResult {
    return {
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
    by: 'auto' | 'user';
    messageIndex: number;
    /** Auto rolls: nothing is rolled when the formula or a value is missing (instead of an error). */
    strict: boolean;
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
        const result = this.makeRoll(found.def, found.check, found.holder, {
            explicit: found.explicit,
            level: found.level,
            by: 'auto',
            messageIndex: index,
            strict: true,
        });
        if (result) this.record(result);
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

    /** A number for the dice: the value, a scale's level index; the initial value for a holder without one yet. */
    private numeric(def: MechanicDef, holder: string, attributeId: string, known: boolean): number | null {
        const attribute = def.attributes.find((item) => item.id === attributeId);
        if (!attribute) return null;
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

    private makeRoll(def: MechanicDef, check: CheckDef, holder: string, spec: RollSpec): StoredCheck | null {
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
        const roll = rollDice(formula, (attribute) => this.numeric(def, holder, attribute, known), this.rng, {
            difficulty: this.targetOf(check, formula, spec.explicit, spec.level),
            level: formula.under ? spec.level : null,
            criticals: typeof check.criticals === 'boolean' ? check.criticals : undefined,
        });
        if (formula.under && roll.target === null) {
            throw new Error(
                this.t('m25.check.error.noValue', {
                    attribute: this.attributeName(def, roll.missing[0] as string),
                    holder,
                }),
            );
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
            target: roll.target,
            outcome: roll.outcome,
            text: checkFact(check.promptName || check.name, holder, roll),
            messageIndex: spec.messageIndex,
            by: spec.by,
            at: Date.now(),
        };
        if (spec.messageIndex >= 0) result.stamp = stampOf(this.deps.app.host.ctx().chat?.[spec.messageIndex]);
        return result;
    }

    private record(result: StoredCheck): void {
        this.results.push(result);
        if (this.results.length > RESULTS_KEPT) this.results.splice(0, this.results.length - RESULTS_KEPT);
        this.badge(result);
        this.journal(result);
        this.saveSoon();
        this.changed();
    }

    private journal(result: StoredCheck): void {
        const line = describeCheck(result, this.deps.app.i18n, checkNameOf(this.defs, result));
        const action: JournalAction = {
            module: MECHANICS_ID,
            kind: CHECK_KIND,
            summary: this.t('m25.check.journal', { line }),
            changes: [],
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
    ): StoredCheck {
        if (!this.deps.app.host.chatId()) throw new Error(this.t('m25.check.error.noChat'));
        const name = holder.trim() || this.defaultHolder(def);
        if (!name) throw new Error(this.t('m25.check.error.noHolder'));
        const result = this.makeRoll(def, check, name, { ...difficulty, by: 'user', messageIndex: -1, strict: false });
        if (!result) throw new Error(this.t('m25.check.error.formula', { dice: check.dice }));
        this.record(result);
        return result;
    }

    async roll(
        mechanicId: string,
        checkId: string,
        holder: string,
        options: { difficulty?: number } = {},
    ): Promise<CheckResult> {
        const { def, check } = this.require(mechanicId, checkId);
        const explicit = typeof options.difficulty === 'number' ? options.difficulty : null;
        return publicResult(this.rollNow(def, check, holder, { explicit, level: null }));
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
        } catch (error) {
            this.deps.log.warn('mechanics checks: invalidation failed', error);
        }
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
        this.results = this.results.filter((result) => !dropped.has(result.id));
        if (same) {
            same.stamp = stamp;
            this.badge(same);
        } else if (found) {
            const result = this.makeRoll(found.def, found.check, found.holder, {
                explicit: found.explicit,
                level: found.level,
                by: 'auto',
                messageIndex: index,
                strict: true,
            });
            if (result) {
                this.record(result);
                return;
            }
        }
        this.saveSoon();
        this.changed();
    }

    /* ---------------------------------------------------------------- badges on the user's messages */

    private badge(result: StoredCheck): void {
        if (result.messageIndex < 0 || !result.stamp || this.disposed) return;
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

/** A typed difficulty: a number ("15") or words («трудно», "very hard"); null when it is neither. */
export function parseDifficulty(text: string): { explicit: number | null; level: DifficultyLevel | null } | null {
    const trimmed = text.trim();
    if (/^\d{1,4}$/.test(trimmed)) return { explicit: Number(trimmed), level: null };
    const level = difficultyWord(trimmed);
    return level ? { explicit: null, level } : null;
}
