// M22 rules engine (plan M22, dev-plan 1.6): one registry of on-the-fly rules, one WORLDINFO_ENTRIES_LOADED and one
// WORLDINFO_SCAN_DONE listener applying the enabled lore rules in a fixed order, start/stop of the other rules, the
// before/after comparison through M1, and the on/off switches through autonomy and the journal.
//
// Host facts this relies on (research/st-world-info.md §1, audit T1, T3, T4):
// - ENTRIES_LOADED gives per-scan shallow copies `{uid, world, ...entry}`; nested arrays alias ST's cache, so rules
//   assign new values and never mutate `key`/`keysecondary`/`characterFilter`/`triggers` in place;
// - ST hashes every entry after the event (sticky/cooldown follow the hash): rules must give the same result on
//   every scan, and switching a rule resets those effects for the entries it touches;
// - SCAN_DONE fires after every loop with the live `activated.entries` map and `sortedEntries` (a structured clone,
//   safe to mark `disable`); the event also fires for M1's dry runs.
import { diffActivations, isPlainObject } from '../../domain/rules-lore';
import type { App, Decision, JournalChange, Logger, NeighbourAdapter, Unsubscribe } from '../../shared/contracts';
import type { BunnyMoModeApi } from '../bunnymoMode/api';
import type { LoreJournalApi } from '../loreJournal/api';
import type {
    BookCap,
    CutEntry,
    EntryCopy,
    EntryLists,
    RuleChange,
    RuleDefinition,
    RuleImpact,
    RulesApi,
    RulesSettings,
    RuleState,
    ScanInfo,
} from './api';
import { TokenCache } from './env';
import type { RuleEnv } from './env';

export const RULES_KEY = 'rules';
export const RULES_MODULE_ID = 'M22';
export const LORE_JOURNAL_KEY = 'loreJournal';
/** Autonomy kind of switching a rule (the user acts directly, so the default level is 'auto'). */
export const RULE_TOGGLE_KIND = 'rules.toggle';
/** Journal target of a rule switch; undo restores the previous explicit flag. */
export const RULE_FLAG_TARGET = 'm22.rule';
export const DEFAULT_GAP_GUARD_LIMIT = 20;
/** ST `scan_state.RECURSION` (world-info.js). */
const SCAN_RECURSION = 2;
const DEFAULT_ORDER = 100;
/** Rules with parameters in options()/setOptions() (ids of the built-ins, see builtin/lore.ts and qvink.ts). */
const CAP_OPTIONS_RULE = 'book.cap';
const GAP_OPTIONS_RULE = 'qvink.gapGuard';

export function defaultRulesSettings(): RulesSettings {
    return {
        enabled: {},
        bookCaps: {},
        gapGuardLimit: DEFAULT_GAP_GUARD_LIMIT,
        packChoices: {},
        packAsked: {},
        archiveProposals: {},
    };
}

interface TogglePayload {
    id: string;
    enabled: boolean;
}

function isTogglePayload(value: unknown): value is TogglePayload {
    return isPlainObject(value) && typeof value.id === 'string' && typeof value.enabled === 'boolean';
}

function arrayOf(value: unknown): EntryCopy[] {
    return Array.isArray(value) ? (value as EntryCopy[]) : [];
}

function cleanCap(cap: BookCap | null): BookCap | null {
    if (!cap) return null;
    const result: BookCap = {};
    if (typeof cap.maxTokens === 'number' && Number.isFinite(cap.maxTokens) && cap.maxTokens > 0) {
        result.maxTokens = Math.floor(cap.maxTokens);
    }
    if (
        typeof cap.maxRecursionLevel === 'number' &&
        Number.isFinite(cap.maxRecursionLevel) &&
        cap.maxRecursionLevel >= 0
    ) {
        result.maxRecursionLevel = Math.floor(cap.maxRecursionLevel);
    }
    return Object.keys(result).length ? result : null;
}

export class RulesEngine implements RulesApi {
    readonly tokens: TokenCache;
    private readonly rules = new Map<string, RuleDefinition>();
    private readonly running = new Map<string, Unsubscribe | null>();
    private readonly failed = new Set<string>();
    private readonly changes = new Map<string, RuleChange[]>();
    private readonly listeners = new Set<() => void>();
    private cuts: CutEntry[] = [];
    private realCuts: CutEntry[] = [];
    private books: string[] = [];
    private forced: ReadonlySet<string> = new Set();
    private scan: { entries: unknown; recursionLevel: number } | null = null;
    private comparing = false;
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {
        this.tokens = new TokenCache(async (text) => this.app.host.ctx().getTokenCountAsync(text), log);
    }

    /* ---------------------------------------------------------------- environment */

    env(): RuleEnv {
        return {
            app: this.app,
            log: this.log,
            t: (key, params) => this.app.i18n.t(key, params),
            settings: () => this.settings(),
            isActive: (id) => this.isActive(id),
            reportCuts: (cuts) => this.reportCuts(cuts),
            tokens: this.tokens,
            capability: (id) => this.capability(id),
            simulating: () => this.lore()?.simulating() === true,
            activeBooks: () => this.activeBooks(),
        };
    }

    /** The settings slice, repaired in place when a stored value has the wrong shape. */
    settings(): RulesSettings {
        const slice = this.app.settings.module<Partial<RulesSettings>>(RULES_KEY);
        if (!isPlainObject(slice.enabled)) slice.enabled = {};
        if (!isPlainObject(slice.bookCaps)) slice.bookCaps = {};
        if (typeof slice.gapGuardLimit !== 'number' || !Number.isFinite(slice.gapGuardLimit)) {
            slice.gapGuardLimit = DEFAULT_GAP_GUARD_LIMIT;
        }
        if (!isPlainObject(slice.packChoices)) slice.packChoices = {};
        if (!isPlainObject(slice.packAsked)) slice.packAsked = {};
        if (!isPlainObject(slice.archiveProposals)) slice.archiveProposals = {};
        return slice as RulesSettings;
    }

    /** ST and Maestro listeners; every returned disposer must be owned by the module. */
    install(): Unsubscribe[] {
        const { host, bus, settings } = this.app;
        const offs: Unsubscribe[] = [];
        const on = (key: string, handler: (...args: unknown[]) => unknown, order?: 'first') => {
            const name = host.events.name(key);
            if (!name) {
                this.log.debug(`ST event ${key} is missing`);
                return;
            }
            offs.push(host.events.on(name, handler, order ? { order } : undefined));
        };
        on('WORLDINFO_ENTRIES_LOADED', (payload) => this.onEntriesLoaded(payload));
        // First on SCAN_DONE: caps apply before M1 and other observers read the activations of the loop.
        on('WORLDINFO_SCAN_DONE', (args) => this.onScanDone(args), 'first');
        on('CHAT_CHANGED', () => this.sync());
        on('APP_READY', () => this.sync());
        offs.push(settings.onChange(() => this.sync()));
        // Neighbour state (Qvink per chat, DES/CK loaded late) is re-checked right before each generation.
        offs.push(bus.on('generation:before', () => this.sync()));

        this.app.journal.registerUndo(RULE_FLAG_TARGET, async (change: JournalChange) => {
            const id = isPlainObject(change.ref) ? change.ref.id : undefined;
            if (typeof id !== 'string') return false;
            this.applyFlag(id, typeof change.before === 'boolean' ? change.before : null);
            return true;
        });
        offs.push(
            this.app.inbox.registerApplier(RULE_TOGGLE_KIND, async (payload) => {
                if (isTogglePayload(payload)) this.applyFlag(payload.id, payload.enabled);
            }),
        );
        return offs;
    }

    dispose(): void {
        this.disposed = true;
        for (const id of [...this.running.keys()]) this.stopRule(id);
        this.listeners.clear();
    }

    /** Facade exposed to other modules (internal methods stay private to the module). */
    api(): RulesApi {
        return {
            register: (rule) => this.register(rule),
            list: () => this.list(),
            isEnabled: (id) => this.isEnabled(id),
            setEnabled: (id, enabled) => this.setEnabled(id, enabled),
            compare: (ids) => this.compare(ids),
            suspended: (id) => this.suspended(id),
            cutEntries: () => this.cutEntries(),
            activeBooks: () => this.activeBooks(),
            bookCaps: () => this.bookCaps(),
            setBookCap: (book, cap) => this.setBookCap(book, cap),
            options: (id) => this.options(id),
            setOptions: (id, options) => this.setOptions(id, options),
        };
    }

    /** Generic parameters of a rule (see RulesApi.options). */
    options(id: string): Record<string, unknown> | undefined {
        if (id === CAP_OPTIONS_RULE) {
            const caps: Record<string, number> = {};
            const recursion: Record<string, number> = {};
            for (const [book, cap] of Object.entries(this.settings().bookCaps)) {
                if (cap.maxTokens !== undefined) caps[book] = cap.maxTokens;
                if (cap.maxRecursionLevel !== undefined) recursion[book] = cap.maxRecursionLevel;
            }
            return { caps, recursion };
        }
        if (id === GAP_OPTIONS_RULE) return { limit: this.settings().gapGuardLimit };
        const rule = this.rules.get(id);
        try {
            return rule?.options?.();
        } catch (error) {
            this.log.error(`rule ${id} options failed`, error);
            return undefined;
        }
    }

    /** Sets parameters in the shape of options(); 'book.cap' `caps` replace every token cap, `recursion` every limit. */
    setOptions(id: string, options: Record<string, unknown>): void | Promise<void> {
        if (id === GAP_OPTIONS_RULE && typeof options.limit === 'number') {
            this.setGapGuardLimit(options.limit);
            return;
        }
        if (id !== CAP_OPTIONS_RULE) {
            const result = this.rules.get(id)?.setOptions?.(options);
            this.emit();
            return result;
        }
        const current = this.settings().bookCaps;
        const next: Record<string, BookCap> = Object.fromEntries(
            Object.entries(current).map(([book, cap]) => [book, { ...cap }]),
        );
        const replace = (field: keyof BookCap, value: unknown) => {
            if (!isPlainObject(value)) return;
            for (const cap of Object.values(next)) delete cap[field];
            for (const [book, limit] of Object.entries(value)) {
                if (typeof limit === 'number') next[book] = { ...next[book], [field]: limit };
            }
        };
        replace('maxTokens', options.caps);
        replace('maxRecursionLevel', options.recursion);
        for (const book of new Set([...Object.keys(current), ...Object.keys(next)])) {
            const clean = cleanCap(next[book] ?? null);
            if (clean) current[book] = clean;
            else delete current[book];
        }
        this.app.settings.save();
        this.app.settings.notify('m22.bookCaps');
        this.emit();
    }

    /** Called after scans and switches (the pult redraws on demand). */
    onChange(listener: () => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    /* ---------------------------------------------------------------- registry */

    register(rule: RuleDefinition): Unsubscribe {
        if (this.rules.has(rule.id)) {
            this.log.warn(`rule ${rule.id} replaced`);
            this.stopRule(rule.id);
        }
        this.rules.set(rule.id, rule);
        this.failed.delete(rule.id);
        this.sync();
        return () => {
            if (this.rules.get(rule.id) !== rule) return;
            this.stopRule(rule.id);
            this.rules.delete(rule.id);
            this.changes.delete(rule.id);
            this.emit();
        };
    }

    list(): RuleState[] {
        return [...this.rules.values()].map((definition) => {
            const missing = this.missing(definition);
            return {
                id: definition.id,
                enabled: this.isEnabled(definition.id),
                waiting: this.isEnabled(definition.id) && this.waitsForWizard(definition),
                definition,
                lastChanges: this.changes.get(definition.id) ?? [],
                available: missing.length === 0,
                missing,
                explicit: this.explicitFlag(definition.id) !== undefined,
                running: this.running.has(definition.id),
            };
        });
    }

    rule(id: string): RuleDefinition | undefined {
        return this.rules.get(id);
    }

    /** The user's switch, or the rule's default: what the rule is meant to be (the wizard reads and sets this). */
    isEnabled(id: string): boolean {
        const rule = this.rules.get(id);
        if (!rule) return false;
        return this.explicitFlag(id) ?? rule.enabledByDefault;
    }

    /**
     * Lore, prompt and neighbour rules do not act before the first-run wizard decided about them (plan §8) unless the
     * user switched them explicitly; display and interface rules act at once.
     */
    waitsForWizard(rule: RuleDefinition): boolean {
        if (rule.kind === 'display' || rule.kind === 'ui' || rule.safeBeforeWizard === true) return false;
        if (this.app.settings.core().firstRunDone) return false;
        return this.explicitFlag(rule.id) === undefined;
    }

    /** Enabled and not waiting for the wizard (availability is checked separately). */
    isActive(id: string): boolean {
        const rule = this.rules.get(id);
        return !!rule && this.isEnabled(id) && !this.waitsForWizard(rule);
    }

    async setEnabled(id: string, enabled: boolean): Promise<void> {
        await this.toggle(id, enabled);
    }

    /** Switches a rule through autonomy (journal + undo); returns how autonomy routed it. */
    async toggle(id: string, enabled: boolean): Promise<Decision> {
        const rule = this.rules.get(id);
        if (!rule) return 'skipped';
        const t = (key: string, params?: Record<string, string | number>) => this.app.i18n.t(key, params);
        const before = this.explicitFlag(id) ?? null;
        return this.app.autonomy.decide<TogglePayload>(
            {
                module: RULES_MODULE_ID,
                kind: RULE_TOGGLE_KIND,
                title: t(enabled ? 'm22.toggle.on' : 'm22.toggle.off', { rule: t(rule.titleKey) }),
                description: rule.kind === 'lore' ? t('m22.toggle.loreHint') : t(rule.descriptionKey),
                changes: [{ target: RULE_FLAG_TARGET, ref: { id }, before, after: enabled }],
                payload: { id, enabled },
                apply: async (payload) => this.applyFlag(payload.id, payload.enabled),
            },
            rule.defaultLevel,
        );
    }

    /** True while M1 asks to suspend this rule in a simulation. */
    suspended(id: string): boolean {
        const lore = this.lore();
        return !!lore && lore.simulating() && lore.suspendedRules().includes(id);
    }

    cutEntries(): CutEntry[] {
        return [...this.cuts];
    }

    /** Cuts of the latest real (non-simulated) scan, for the pult. */
    lastRealCuts(): CutEntry[] {
        return [...this.realCuts];
    }

    activeBooks(): string[] {
        return [...this.books];
    }

    bookCaps(): Record<string, BookCap> {
        const caps = this.settings().bookCaps;
        return Object.fromEntries(Object.entries(caps).map(([book, cap]) => [book, { ...cap }]));
    }

    setBookCap(book: string, cap: BookCap | null): void {
        if (!book) return;
        const caps = this.settings().bookCaps;
        const clean = cleanCap(cap);
        if (clean) caps[book] = clean;
        else delete caps[book];
        this.app.settings.save();
        this.app.settings.notify('m22.bookCaps');
        this.emit();
    }

    setGapGuardLimit(limit: number): void {
        const value = Number.isFinite(limit) ? Math.max(0, Math.min(200, Math.floor(limit))) : DEFAULT_GAP_GUARD_LIMIT;
        this.settings().gapGuardLimit = value;
        this.app.settings.save();
        this.app.settings.notify('m22.gapGuardLimit');
    }

    /** Simulates the current chat with and without the given rules (via M1); rules that are off are forced on. */
    async compare(ids: string[]): Promise<RuleImpact> {
        const lore = this.lore();
        if (!lore) throw new Error(this.app.i18n.t('m22.compare.noJournal'));
        if (this.comparing) throw new Error(this.app.i18n.t('m22.compare.busy'));
        this.comparing = true;
        try {
            const before = await lore.simulate({ deterministic: true, suspendRules: [...ids] });
            this.forced = new Set(ids);
            let after;
            try {
                after = await lore.simulate({ deterministic: true, suspendRules: [] });
            } finally {
                this.forced = new Set();
            }
            return { before, after, ...diffActivations(before.activations, after.activations) };
        } finally {
            this.comparing = false;
        }
    }

    /* ---------------------------------------------------------------- start / stop */

    /** Starts rules that should run and stops the others (idempotent and cheap). */
    sync(): void {
        if (this.disposed) return;
        for (const rule of this.rules.values()) {
            if (!rule.start) continue;
            const wanted = this.isActive(rule.id) && this.missing(rule).length === 0;
            const running = this.running.has(rule.id);
            if (wanted && !running && !this.failed.has(rule.id)) {
                try {
                    const stop = rule.start();
                    this.running.set(rule.id, typeof stop === 'function' ? stop : null);
                } catch (error) {
                    this.failed.add(rule.id);
                    this.log.error(`rule ${rule.id} did not start`, error);
                }
            } else if (!wanted && running) {
                this.stopRule(rule.id);
            }
        }
    }

    private stopRule(id: string): void {
        if (!this.running.has(id)) return;
        const stop = this.running.get(id);
        this.running.delete(id);
        try {
            stop?.();
        } catch (error) {
            this.log.error(`rule ${id} did not stop cleanly`, error);
        }
    }

    private applyFlag(id: string, enabled: boolean | null): void {
        const flags = this.settings().enabled;
        if (enabled === null) delete flags[id];
        else flags[id] = enabled;
        this.failed.delete(id);
        this.app.settings.save();
        this.app.settings.notify('m22.enabled');
        this.sync();
        this.emit();
    }

    private explicitFlag(id: string): boolean | undefined {
        const value = this.settings().enabled[id];
        return typeof value === 'boolean' ? value : undefined;
    }

    /* ---------------------------------------------------------------- capabilities */

    /** Required capabilities missing now: adapter capabilities are probed live, host ones come from the registry. */
    missing(rule: RuleDefinition): string[] {
        return (rule.requires ?? []).filter((id) => !this.capability(id));
    }

    capability(id: string): boolean {
        const prefix = id.split('.')[0] ?? '';
        const adapter = (this.app.adapters as Partial<Record<string, NeighbourAdapter>>)[prefix];
        if (adapter && prefix !== 'st') {
            try {
                return adapter.capabilities().includes(id);
            } catch {
                return false;
            }
        }
        return this.app.host.caps.has(id);
    }

    /* ---------------------------------------------------------------- scan listeners */

    private lore(): LoreJournalApi | undefined {
        return this.app.modules.api<LoreJournalApi>(LORE_JOURNAL_KEY);
    }

    /** Lore rules in their fixed order (order, then registration). */
    private loreRules(): RuleDefinition[] {
        const rules = [...this.rules.values()].filter((rule) => rule.applyEntries || rule.applyScanDone);
        return rules
            .map((rule, index) => ({ rule, index }))
            .sort((a, b) => (a.rule.order ?? DEFAULT_ORDER) - (b.rule.order ?? DEFAULT_ORDER) || a.index - b.index)
            .map((item) => item.rule);
    }

    /** The rule acts on this scan: available, and enabled and not suspended — or forced by compare(). */
    private appliesNow(rule: RuleDefinition, lore: LoreJournalApi | undefined): boolean {
        if (this.missing(rule).length) return false;
        const simulating = lore?.simulating() === true;
        if (simulating && this.forced.has(rule.id)) return true;
        if (!this.isActive(rule.id)) return false;
        return !(simulating && lore?.suspendedRules().includes(rule.id));
    }

    onEntriesLoaded(payload: unknown): void {
        if (!isPlainObject(payload)) return;
        // M35 per-chat pack selection first (idempotent): pack rules never pair a suppressed pack with a kept one.
        try {
            this.app.modules.api<BunnyMoModeApi>('bunnymoMode')?.applySelection?.(payload);
        } catch (error) {
            this.log.warn('BunnyMo pack selection failed', error);
        }
        const lists: EntryLists = {
            globalLore: arrayOf(payload.globalLore),
            characterLore: arrayOf(payload.characterLore),
            chatLore: arrayOf(payload.chatLore),
            personaLore: arrayOf(payload.personaLore),
        };
        const lore = this.lore();
        const simulating = lore?.simulating() === true;
        if (!simulating) this.books = booksOf(lists);
        for (const rule of this.loreRules()) {
            if (!rule.applyEntries) continue;
            if (!this.appliesNow(rule, lore)) {
                if (!simulating) this.changes.set(rule.id, []);
                continue;
            }
            const changes: RuleChange[] = [];
            try {
                rule.applyEntries(lists, changes);
            } catch (error) {
                this.log.error(`rule ${rule.id} failed on entries`, error);
            }
            // Simulations (M1 "what if", compare) must not overwrite what the last real scan did.
            if (!simulating) this.changes.set(rule.id, changes);
        }
        if (!simulating) this.emit();
    }

    onScanDone(args: unknown): void {
        if (!isPlainObject(args)) return;
        const lore = this.lore();
        const info = this.scanInfo(args, lore?.simulating() === true);
        for (const rule of this.loreRules()) {
            if (!rule.applyScanDone || !this.appliesNow(rule, lore)) continue;
            try {
                rule.applyScanDone(args, info);
            } catch (error) {
                this.log.error(`rule ${rule.id} failed after a scan loop`, error);
            }
        }
    }

    /** Loop bookkeeping: a new scan starts at loop 1 (or with another sortedEntries array). */
    private scanInfo(args: Record<string, unknown>, simulated: boolean): ScanInfo {
        const state = isPlainObject(args.state) ? args.state : {};
        const loop = typeof state.loopCount === 'number' && state.loopCount > 0 ? state.loopCount : 1;
        let scan = this.scan;
        if (loop <= 1 || !scan || scan.entries !== args.sortedEntries) {
            scan = { entries: args.sortedEntries, recursionLevel: 0 };
            this.scan = scan;
            this.cuts = [];
            if (!simulated) this.realCuts = this.cuts;
        }
        if (loop > 1 && Number(state.current) === SCAN_RECURSION) scan.recursionLevel += 1;
        return { loop, recursionLevel: scan.recursionLevel, final: Number(state.next) === 0, simulated };
    }

    private reportCuts(cuts: CutEntry[]): void {
        this.cuts.push(...cuts);
        // M1 labels these activations "cut by a Maestro rule" instead of "budget"/"another extension".
        const lore = this.lore();
        for (const cut of cuts) lore?.markCut?.(cut.world, cut.uid);
    }

    private emit(): void {
        for (const listener of [...this.listeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('rules listener failed', error);
            }
        }
    }
}

/** Book names present in a scan, in first-seen order. */
export function booksOf(lists: EntryLists): string[] {
    const books = new Set<string>();
    for (const list of [lists.globalLore, lists.characterLore, lists.chatLore, lists.personaLore]) {
        for (const entry of list) {
            if (isPlainObject(entry) && typeof entry.world === 'string' && entry.world) books.add(entry.world);
        }
    }
    return [...books];
}
