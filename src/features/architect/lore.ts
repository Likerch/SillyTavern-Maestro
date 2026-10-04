// M20's lore-side rules, registered in M22's engine (RulesApi.register) so that they run in M22's fixed order, show
// in the «Правила» tab with their changes, can be compared before/after through M1 and are suspended in M1's
// "before" simulations. All of them work on ST's per-scan copies only (never the books, never nested arrays):
//
// - 'architect.damp'       (order 40, WORLDINFO_ENTRIES_LOADED): entries about absent characters and far places,
//                          not mentioned in the last K messages, get `disable` on the copy (plan M20 п. 3);
// - 'architect.pin'        (order 41, ENTRIES_LOADED picks, SCAN_DONE loop 1 forces): entries about present
//                          characters and the current place join the first loop's `activated.entries`, the way M6
//                          forces canon pins;
// - 'architect.loreBudget' (order 50, WORLDINFO_SCAN_DONE, every loop): when the lore of the scan is over the lore
//                          budget, the lowest-order activations that are not pinned, canon, present or ignoreBudget
//                          leave `activated.entries` and are marked `disable` on their sortedEntries copy (п. 1). It
//                          runs after M22's book caps (order 30) and after M6, whose SCAN_DONE listener is in front;
// - 'architect.dedup'      (order 60, ENTRIES_LOADED): facts the user chose to keep elsewhere are cut out of the
//                          entry's copy (or the copy is disabled when nothing else is left) (п. 4).
//
// The handlers are idempotent (every ENTRIES_LOADED gets fresh copies; results are recomputed, not accumulated)
// and cheap: subjects and the scene are cached (see context.ts).
import { planLoreBudget } from '../../domain/architect-budget';
import type { LoreBudgetItem } from '../../domain/architect-budget';
import { isPinnable } from '../../domain/architect-presence';
import { hasStoryText, removeSentences } from '../../domain/architect-text';
import { activationKey } from '../../domain/canon-inject';
import { estimateTokens } from '../../domain/rules-lore';
import type { App, Logger } from '../../shared/contracts';
import type { LoreJournalApi } from '../loreJournal/api';
import type { EntryCopy, EntryLists, RuleChange, RuleDefinition, ScanInfo } from '../rules/api';
import type { DampedEntry, DroppedCopy, LoreCut, PinnedEntry } from './api';
import type { ConsentStore } from './consents';
import type { SceneContext } from './context';
import type { ArchitectSettings } from './settings';
import type { TokenMeter } from './tokens';

type Dict = Record<string, unknown>;

export const DAMP_RULE_ID = 'architect.damp';
export const PIN_RULE_ID = 'architect.pin';
export const LORE_BUDGET_RULE_ID = 'architect.loreBudget';
export const DEDUP_RULE_ID = 'architect.dedup';
export const ARCHITECT_RULE_IDS = [DAMP_RULE_ID, PIN_RULE_ID, LORE_BUDGET_RULE_ID, DEDUP_RULE_ID] as const;

/** Most entries one scan pins (pins bypass ST's budget). */
export const MAX_PINS = 12;

function isDict(value: unknown): value is Dict {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown): string {
    return typeof value === 'string' ? value : '';
}

/** Valid entry copies of every list, in ST's list order. */
export function entriesOf(lists: EntryLists): EntryCopy[] {
    const result: EntryCopy[] = [];
    for (const list of [lists.globalLore, lists.characterLore, lists.chatLore, lists.personaLore]) {
        if (!Array.isArray(list)) continue;
        for (const entry of list) {
            if (isDict(entry) && typeof entry.world === 'string' && entry.uid !== undefined) result.push(entry);
        }
    }
    return result;
}

/** What the lore rules did in the latest real (non-simulated) scan. */
export interface LoreTurn {
    at: number;
    damped: DampedEntry[];
    /** Tokens of the damped entries (what they would have cost had they all activated). */
    dampedTokens: number;
    pinned: PinnedEntry[];
    cuts: LoreCut[];
    /** Lore tokens of the scan before and after the lore budget. */
    loreBefore: number;
    loreAfter: number;
    dropped: DroppedCopy[];
    droppedTokens: number;
}

export function emptyLoreTurn(): LoreTurn {
    return {
        at: 0,
        damped: [],
        dampedTokens: 0,
        pinned: [],
        cuts: [],
        loreBefore: 0,
        loreAfter: 0,
        dropped: [],
        droppedTokens: 0,
    };
}

interface PinCandidate {
    entity: string;
    reason: PinnedEntry['reason'];
    order: number;
}

/** State of one scan (new sortedEntries array = new scan). */
interface ScanRun {
    sorted: unknown;
    pinsDone: boolean;
    /** Forced into the scan by the pin rule. */
    pinned: PinnedEntry[];
    /** Pin candidates already active on their own: protected from the budget like forced ones. */
    protect: Set<string>;
    cuts: LoreCut[];
    cutTokens: number;
    used: number;
}

export class ArchitectLore {
    private pinCandidates = new Map<string, PinCandidate>();
    /** Copies this rule disabled (WeakMap: they die with the scan). */
    private readonly dampedCopies = new WeakMap<object, DampedEntry>();
    /** Copies the dedup rule rewrote, with what it did. */
    private readonly dedupCopies = new WeakMap<object, { change: RuleChange; dropped: DroppedCopy }>();
    private run: ScanRun | null = null;
    private real: LoreTurn = emptyLoreTurn();

    constructor(
        private readonly app: App,
        private readonly scene: SceneContext,
        private readonly settings: () => ArchitectSettings,
        private readonly tokens: TokenMeter,
        private readonly consents: ConsentStore,
        private readonly log: Logger,
    ) {}

    /** Results of the latest real scan. */
    latest(): LoreTurn {
        return {
            ...this.real,
            damped: [...this.real.damped],
            pinned: [...this.real.pinned],
            cuts: [...this.real.cuts],
            dropped: [...this.real.dropped],
        };
    }

    /**
     * A generation starts (before its scan): results of the previous scan must not be reported for this one — ST skips
     * the scan loops entirely when no entry is active.
     */
    resetTurn(): void {
        this.real = emptyLoreTurn();
    }

    rules(): RuleDefinition[] {
        const base = {
            owner: 'maestro' as const,
            stage: 7,
            kind: 'lore' as const,
            defaultLevel: 'auto' as const,
            enabledByDefault: true,
            // Nothing happens until the user sets a budget or turns damping/pinning on in the architect's tab.
            safeBeforeWizard: true,
        };
        return [
            {
                ...base,
                id: DAMP_RULE_ID,
                titleKey: 'm20.rule.damp.title',
                descriptionKey: 'm20.rule.damp.description',
                requires: ['st.events.entriesLoaded'],
                order: 40,
                applyEntries: (lists, changes) => this.damp(lists, changes),
            },
            {
                ...base,
                id: PIN_RULE_ID,
                titleKey: 'm20.rule.pin.title',
                descriptionKey: 'm20.rule.pin.description',
                requires: ['st.events.entriesLoaded', 'st.events.scanDone'],
                order: 41,
                applyEntries: (lists) => this.pickPins(lists),
                applyScanDone: (args, scan) => this.forcePins(args, scan),
            },
            {
                ...base,
                id: LORE_BUDGET_RULE_ID,
                titleKey: 'm20.rule.loreBudget.title',
                descriptionKey: 'm20.rule.loreBudget.description',
                requires: ['st.events.scanDone'],
                order: 50,
                applyScanDone: (args, scan) => this.budget(args, scan),
            },
            {
                ...base,
                id: DEDUP_RULE_ID,
                titleKey: 'm20.rule.dedup.title',
                descriptionKey: 'm20.rule.dedup.description',
                requires: ['st.events.entriesLoaded'],
                order: 60,
                applyEntries: (lists, changes) => this.dedup(lists, changes),
            },
        ];
    }

    private simulating(): boolean {
        return this.app.modules.api<LoreJournalApi>('loreJournal')?.simulating() === true;
    }

    /** Per-call memo of «M20 never touches this book» (role lookups allocate). */
    private protectedBooks(): (book: string) => boolean {
        const memo = new Map<string, boolean>();
        return (book) => {
            let value = memo.get(book);
            if (value === undefined) {
                value = this.scene.isProtectedBook(book);
                memo.set(book, value);
            }
            return value;
        };
    }

    /* ---------------------------------------------------------------- damping (ENTRIES_LOADED) */

    damp(lists: EntryLists, changes: RuleChange[]): DampedEntry[] {
        const damped: DampedEntry[] = [];
        let tokens = 0;
        if (this.settings().presence.damp) {
            this.scene.track();
            const scene = this.scene.snapshot();
            if (scene) {
                const pins = this.scene.canonPins();
                const isProtected = this.protectedBooks();
                for (const entry of entriesOf(lists)) {
                    // The same copies handled again (a listener re-emitting the payload): same result, same report.
                    const known = this.dampedCopies.get(entry);
                    if (known && entry.disable === true) {
                        changes.push({
                            world: entry.world,
                            uid: entry.uid,
                            field: 'disable',
                            before: false,
                            after: true,
                        });
                        damped.push(known);
                        tokens += this.tokens.entry(entry);
                        continue;
                    }
                    if (entry.disable === true || entry.constant === true) continue;
                    if (isProtected(entry.world) || this.scene.isCanonEntry(entry)) continue;
                    if (pins.has(activationKey(entry.world, entry.uid))) continue;
                    const verdict = this.scene.verdict(entry, scene);
                    if (verdict.action !== 'damp' || !verdict.subject) continue;
                    changes.push({ world: entry.world, uid: entry.uid, field: 'disable', before: false, after: true });
                    // A per-scan copy: assigning a scalar is safe (nested arrays alias ST's cache and stay untouched).
                    entry.disable = true;
                    const item: DampedEntry = {
                        world: entry.world,
                        uid: Number(entry.uid),
                        comment: text(entry.comment),
                        entity: verdict.subject.id,
                        reason: verdict.reason,
                        sinceMention: verdict.sinceMention,
                    };
                    this.dampedCopies.set(entry, item);
                    damped.push(item);
                    tokens += this.tokens.entry(entry);
                }
            }
        }
        if (!this.simulating()) {
            this.real.damped = damped;
            this.real.dampedTokens = tokens;
            this.real.at = Date.now();
        }
        return damped;
    }

    /* ---------------------------------------------------------------- pinning */

    /** ENTRIES_LOADED: which entries the first loop will force (present characters, the current place). */
    pickPins(lists: EntryLists): void {
        const candidates: [string, PinCandidate][] = [];
        if (this.settings().presence.pin) {
            this.scene.track();
            const scene = this.scene.snapshot();
            if (scene) {
                const isProtected = this.protectedBooks();
                for (const entry of entriesOf(lists)) {
                    if (!isPinnable(entry) || isProtected(entry.world) || this.scene.isCanonEntry(entry)) continue;
                    const verdict = this.scene.verdict(entry, scene);
                    if (verdict.action !== 'pin' || !verdict.subject) continue;
                    candidates.push([
                        activationKey(entry.world, entry.uid),
                        {
                            entity: verdict.subject.id,
                            reason: verdict.subject.kind === 'place' ? 'currentPlace' : 'present',
                            order: Number(entry.order) || 0,
                        },
                    ]);
                }
            }
        }
        candidates.sort((a, b) => b[1].order - a[1].order);
        this.pinCandidates = new Map(candidates.slice(0, MAX_PINS));
    }

    /** The state of this scan; a new sortedEntries array starts a new one (and a new real result). */
    private runFor(args: Dict, scan: ScanInfo): ScanRun {
        if (!this.run || this.run.sorted !== args.sortedEntries) {
            this.run = {
                sorted: args.sortedEntries,
                pinsDone: false,
                pinned: [],
                protect: new Set(),
                cuts: [],
                cutTokens: 0,
                used: 0,
            };
            if (!scan.simulated) {
                this.real.pinned = [];
                this.real.cuts = [];
                this.real.loreBefore = 0;
                this.real.loreAfter = 0;
            }
        }
        return this.run;
    }

    /** SCAN_DONE, first loop: pinned entries join the activations (their sortedEntries object, macros resolved). */
    forcePins(args: Dict, scan: ScanInfo): void {
        const run = this.runFor(args, scan);
        if (run.pinsDone || scan.loop > 1 || !this.settings().presence.pin) return;
        run.pinsDone = true;
        const activated = isDict(args.activated) ? args.activated.entries : undefined;
        if (!(activated instanceof Map) || !this.pinCandidates.size) return;
        const map = activated as Map<unknown, unknown>;
        const sorted: unknown[] = Array.isArray(args.sortedEntries) ? args.sortedEntries : [];
        let byKey: Map<string, Dict> | null = null;
        for (const [key, candidate] of this.pinCandidates) {
            if (map.has(key)) {
                run.protect.add(key);
                continue;
            }
            byKey ??= new Map(
                sorted.filter(isDict).map((item) => [activationKey(item.world, item.uid), item] as [string, Dict]),
            );
            const entry = byKey.get(key);
            if (!entry || entry.disable === true) continue;
            if (typeof entry.content === 'string' && entry.content.includes('{{')) {
                try {
                    entry.content = this.app.host.ctx().substituteParams(entry.content);
                } catch (error) {
                    this.log.debug('macros of a pinned entry were not substituted', error);
                }
            }
            map.set(key, entry);
            run.protect.add(key);
            run.pinned.push({
                world: String(entry.world),
                uid: Number(entry.uid),
                comment: text(entry.comment),
                entity: candidate.entity,
                reason: candidate.reason,
                tokens: this.tokens.entry(entry),
            });
        }
        if (!scan.simulated) this.real.pinned = [...run.pinned];
    }

    /* ---------------------------------------------------------------- lore budget (SCAN_DONE) */

    budget(args: Dict, scan: ScanInfo): LoreCut[] {
        const run = this.runFor(args, scan);
        const activated = isDict(args.activated) ? args.activated.entries : undefined;
        if (!(activated instanceof Map)) return [];
        const map = activated as Map<unknown, unknown>;
        const limit = this.settings().budgets.lore;
        const sorted: unknown[] = Array.isArray(args.sortedEntries) ? args.sortedEntries : [];
        let positions: Map<unknown, number> | null = null;
        const position = (entry: unknown): number => {
            positions ??= new Map(sorted.map((item, index) => [item, index]));
            return positions.get(entry) ?? Number.MAX_SAFE_INTEGER;
        };
        const items: LoreBudgetItem[] = [];
        const byKey = new Map<string, Dict>();
        let exemptOf: ((key: string, entry: Dict) => boolean) | null = null;
        if (limit > 0) {
            this.scene.track();
            const scene = this.scene.snapshot();
            const pins = this.scene.canonPins();
            const isProtected = this.protectedBooks();
            exemptOf = (key, entry) =>
                run.protect.has(key) ||
                pins.has(key) ||
                entry.ignoreBudget === true ||
                isProtected(text(entry.world)) ||
                this.scene.isCanonEntry(entry) ||
                (scene !== null && this.scene.verdict(entry, scene).action === 'pin');
        }
        for (const [rawKey, entry] of map) {
            if (!isDict(entry)) continue;
            const key = String(rawKey);
            byKey.set(key, entry);
            items.push({
                key,
                tokens: this.tokens.entry(entry),
                order: Number(entry.order) || 0,
                priority: limit > 0 ? position(entry) : 0,
                exempt: exemptOf ? exemptOf(key, entry) : true,
                constant: entry.constant === true,
            });
        }
        const plan = planLoreBudget(items, limit);
        const lore = this.app.modules.api<LoreJournalApi>('loreJournal');
        const cuts: LoreCut[] = [];
        for (const key of plan.cut) {
            const entry = byKey.get(key);
            if (!entry) continue;
            map.delete(key);
            entry.disable = true;
            // Force-activated entries are other objects than their sortedEntries twin: mark the twin as well.
            if (position(entry) === Number.MAX_SAFE_INTEGER) {
                const twin = sorted.find(
                    (item) => isDict(item) && item.world === entry.world && item.uid === entry.uid,
                );
                if (isDict(twin)) twin.disable = true;
            }
            lore?.markCut?.(text(entry.world), Number(entry.uid));
            cuts.push({
                world: text(entry.world),
                uid: Number(entry.uid),
                comment: text(entry.comment),
                tokens: this.tokens.entry(entry),
                order: Number(entry.order) || 0,
            });
        }
        run.cuts.push(...cuts);
        run.cutTokens += plan.cutTokens;
        run.used = plan.used;
        if (!scan.simulated) {
            this.real.cuts = [...run.cuts];
            this.real.loreBefore = run.used + run.cutTokens;
            this.real.loreAfter = run.used;
            this.real.at = Date.now();
            // Exact counts for the next scans, in the background (never on the send path).
            if (scan.final) this.tokens.want([...map.values()].filter(isDict));
        }
        return cuts;
    }

    /* ---------------------------------------------------------------- consented duplicates (ENTRIES_LOADED) */

    dedup(lists: EntryLists, changes: RuleChange[]): DroppedCopy[] {
        const dropped: DroppedCopy[] = [];
        let droppedTokens = 0;
        const drops = this.consents.loreDrops();
        if (drops.size) {
            for (const entry of entriesOf(lists)) {
                // The same copies handled again: report what was done to them, do nothing more.
                const known = this.dedupCopies.get(entry);
                if (known) {
                    changes.push(known.change);
                    dropped.push(known.dropped);
                    droppedTokens += known.dropped.tokens;
                    continue;
                }
                if (entry.disable === true) continue;
                const ref = `${entry.world}#${String(entry.uid)}`;
                const keys = drops.get(ref);
                // Canon copies are Maestro's own and may lose a sentence; BunnyMo entries are never touched (P13).
                if (!keys || this.scene.isBunnyMoBook(entry.world)) continue;
                let content = text(entry.content);
                if (!content) continue;
                if (content.includes('{{')) {
                    try {
                        content = this.app.host.ctx().substituteParams(content);
                    } catch {
                        // match the raw text
                    }
                }
                const result = removeSentences(content, keys);
                if (!result.removed) continue;
                let change: RuleChange;
                if (hasStoryText(result.text)) {
                    change = {
                        world: entry.world,
                        uid: entry.uid,
                        field: 'content.length',
                        before: content.length,
                        after: result.text.length,
                    };
                    entry.content = result.text;
                } else {
                    change = { world: entry.world, uid: entry.uid, field: 'disable', before: false, after: true };
                    entry.disable = true;
                }
                const consent = this.consents.consentFor(ref)[0];
                const item: DroppedCopy = {
                    duplicateId: consent?.id ?? '',
                    owner: consent?.sources.find((source) => source.ref === ref)?.owner ?? 'lore',
                    ref,
                    tokens: estimateTokens(result.removedChars),
                };
                this.dedupCopies.set(entry, { change, dropped: item });
                changes.push(change);
                dropped.push(item);
                droppedTokens += item.tokens;
            }
        }
        if (!this.simulating()) {
            this.real.dropped = dropped;
            this.real.droppedTokens = droppedTokens;
        }
        return dropped;
    }
}
