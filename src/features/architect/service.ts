// M20 «Архитектор промпта»: ties the lore rules (registered in M22), the prompt stage, the cache meter and the
// consents together, builds the per-turn report (before/after of every rule, п. 7) and implements ArchitectApi.
//
// Send path (P15): the lore rules and the PROMPT_READY stage only do cached lookups and string work on the texts
// they change; duplicate detection and the P16 check run on a timer right after PROMPT_READY (the request is on
// its way by then), token counts and mention look-backs are filled after the generation ends.
import { cleanBudget } from '../../domain/architect-budget';
import { findDuplicateFacts } from '../../domain/architect-dupes';
import type { DupeSourceText } from '../../domain/architect-dupes';
import { findInMessages, slotNeedles } from '../../domain/architect-prompt';
import { findOrderViolations, hashMessages } from '../../domain/architect-cache';
import type { LocatedSlot } from '../../domain/architect-cache';
import { slotOwner } from '../../domain/lore-inspector';
import type { App, GenerationInfo, JournalChange, Logger, Unsubscribe } from '../../shared/contracts';
import type { RulesApi } from '../rules/api';
import type {
    ArchitectApi,
    ArchitectReport,
    BudgetSource,
    CacheStats,
    DuplicateFact,
    RuleEffect,
    SourceBudget,
} from './api';
import { CacheMeter } from './cache';
import { ConsentStore } from './consents';
import type { DuplicateConsent } from './consents';
import { SceneContext } from './context';
import { ArchitectLore } from './lore';
import { PromptStage } from './prompt';
import type { PromptCapture } from './prompt';
import { ARCHITECT_ID, ARCHITECT_KEY, BUDGET_SOURCES, readArchitectSettings } from './settings';
import type { ArchitectSettings } from './settings';
import { TokenMeter } from './tokens';

/** Autonomy kind of a duplicate consent (the user acts directly: 'auto' by default). */
export const CONSENT_KIND = 'architect.duplicate';
/** Journal target of a consent; undo restores the previous consent. */
export const CONSENT_TARGET = 'm20.consent';
const KEEP_REPORTS = 30;
const NOT_A_TURN = new Set(['quiet', 'impersonate']);
/** Slot owners whose text is lore again (WI depth/outlet injections) or Maestro's own: not duplicate sources. */
const SKIPPED_OWNERS: ReadonlySet<string> = new Set(['wiDepth', 'wiOutlet', 'maestro']);

interface ConsentPayload {
    id: string;
    consent: DuplicateConsent | null;
}

function isDict(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isConsentPayload(value: unknown): value is ConsentPayload {
    return isDict(value) && typeof value.id === 'string' && (value.consent === null || isDict(value.consent));
}

export class ArchitectService implements ArchitectApi {
    readonly tokens: TokenMeter;
    readonly scene: SceneContext;
    readonly consents: ConsentStore;
    readonly lore: ArchitectLore;
    readonly prompt: PromptStage;
    readonly meter: CacheMeter;
    private awaiting: { type: string } | null = null;
    private history: ArchitectReport[] = [];
    private facts: DuplicateFact[] = [];
    private readonly factKeys = new Map<string, string[]>();
    private previousPrompt: { chatId: string | null; hashes: Set<number> } | null = null;
    private rulesLink: { api: RulesApi | undefined; offs: Unsubscribe[] } = { api: undefined, offs: [] };
    private readonly listeners = new Set<(report: ArchitectReport) => void>();
    private readonly changeListeners = new Set<() => void>();
    private readonly timers = new Set<ReturnType<typeof setTimeout>>();
    private disposed = false;

    constructor(
        private readonly app: App,
        private readonly log: Logger,
    ) {
        this.tokens = new TokenMeter(async (text) => this.app.host.ctx().getTokenCountAsync(text), log);
        this.scene = new SceneContext(app, () => this.settings(), log);
        this.consents = new ConsentStore(app, log);
        this.lore = new ArchitectLore(app, this.scene, () => this.settings(), this.tokens, this.consents, log);
        this.prompt = new PromptStage(app, () => this.settings(), this.consents, log);
        this.meter = new CacheMeter(app, () => this.settings().cache.measure, log);
    }

    settings(): ArchitectSettings {
        return readArchitectSettings(this.app.settings.module<Partial<ArchitectSettings>>(ARCHITECT_KEY));
    }

    /* ---------------------------------------------------------------- lifecycle */

    install(own: (dispose: Unsubscribe | (() => void | Promise<void>)) => void): void {
        const { host, bus } = this.app;
        const on = (key: string, handler: (...args: unknown[]) => unknown, order?: 'last'): void => {
            const name = host.events.name(key);
            if (!name) {
                this.log.debug(`ST event ${key} is missing`);
                return;
            }
            own(host.events.on(name, handler, order ? { order } : undefined));
        };
        // Last: every other listener (DES history, NAI Studio, the inspector's capture) has shaped the prompt.
        on('CHAT_COMPLETION_PROMPT_READY', (data) => this.onPromptReady(data), 'last');
        on('WORLD_INFO_ACTIVATED', (entries) => this.prompt.onActivated(entries));
        on('GENERATION_STARTED', (type, _params, dryRun) => this.onGenerationStarted(type, dryRun));
        own(bus.on('generation:before', (info) => this.onGenerationBefore(info)));
        own(
            bus.on('generation:ended', () => {
                this.idle(() => {
                    void this.tokens.fill();
                    this.scene.warmMentions();
                });
            }),
        );
        own(bus.on('reply:ready', ({ messageIndex }) => this.onReplyReady(messageIndex)));
        own(
            bus.on('chat:changed', () => {
                this.awaiting = null;
                this.facts = [];
                this.factKeys.clear();
                this.history = [];
                this.previousPrompt = null;
                this.meter.reset();
                this.prompt.reset();
                void this.consents.load();
                this.changed();
            }),
        );
        own(this.app.settings.onChange(() => this.ensureRules()));
        own(this.consents.onChange(() => this.changed()));
        own(this.meter.onChange(() => this.changed()));
        for (const off of this.meter.install()) own(off);

        this.app.journal.registerUndo(CONSENT_TARGET, async (change: JournalChange) => {
            const id = isDict(change.ref) ? change.ref.id : undefined;
            if (typeof id !== 'string') return false;
            const before = isDict(change.before) ? (change.before as unknown as DuplicateConsent) : null;
            await this.consents.save(before, id);
            this.refreshKeeps();
            return true;
        });
        own(
            this.app.inbox.registerApplier(CONSENT_KIND, async (payload) => {
                if (isConsentPayload(payload)) await this.applyConsent(payload);
            }),
        );
        own(() => this.dispose());
        this.ensureRules();
        void this.consents.load();
    }

    private dispose(): void {
        this.disposed = true;
        for (const timer of this.timers) clearTimeout(timer);
        this.timers.clear();
        this.releaseRules();
        this.scene.dispose();
        this.listeners.clear();
        this.changeListeners.clear();
    }

    private idle(task: () => void): void {
        if (this.disposed) return;
        const timer = setTimeout(() => {
            this.timers.delete(timer);
            if (this.disposed) return;
            try {
                task();
            } catch (error) {
                this.log.warn('architect background step failed', error);
            }
        }, 0);
        this.timers.add(timer);
    }

    /**
     * Registers the lore rules in M22's engine; re-registers when M22 restarted (a new API object). False while M22
     * is off: the lore part then does nothing (the tab says so).
     */
    ensureRules(): boolean {
        if (this.disposed) return false;
        const api = this.app.modules.api<RulesApi>('rules');
        if (api === this.rulesLink.api) return !!api;
        this.releaseRules();
        const offs: Unsubscribe[] = [];
        if (api) {
            for (const rule of this.lore.rules()) {
                try {
                    offs.push(api.register(rule));
                } catch (error) {
                    this.log.warn(`rule ${rule.id} could not be registered`, error);
                }
            }
        }
        this.rulesLink = { api, offs };
        return !!api;
    }

    rulesActive(): boolean {
        return !!this.app.modules.api<RulesApi>('rules');
    }

    private releaseRules(): void {
        for (const off of this.rulesLink.offs) {
            try {
                off();
            } catch (error) {
                this.log.debug('rule could not be unregistered', error);
            }
        }
        this.rulesLink = { api: undefined, offs: [] };
    }

    /* ---------------------------------------------------------------- send path */

    private onGenerationStarted(type: unknown, dryRun: unknown): void {
        const kind = typeof type === 'string' && type ? type : 'normal';
        if (dryRun === true) return;
        this.awaiting = NOT_A_TURN.has(kind) ? null : { type: kind };
    }

    private onGenerationBefore(info: GenerationInfo): void {
        this.ensureRules();
        this.prompt.reset();
        this.scene.track();
        // Starts reading the canon's pins (async) before the scan, so the lore budget knows them.
        this.scene.canonPins();
        if (!info.dryRun) this.lore.resetTurn();
        if (info.quiet || info.dryRun || NOT_A_TURN.has(info.type)) return;
        this.awaiting = { type: info.type };
    }

    onPromptReady(data: unknown): PromptCapture | null {
        let capture: PromptCapture | null = null;
        try {
            capture = this.prompt.onPromptReady(data);
        } catch (error) {
            this.log.error('prompt stage failed', error);
        }
        if (!capture) return null;
        const turn = this.awaiting;
        this.awaiting = null;
        // Quiet and background prompts get their budgets too, but they are not turns: no report, no cache sample.
        if (!turn) return capture;
        this.meter.arm();
        const ready = capture;
        this.idle(() => this.finish(ready, turn.type));
        return capture;
    }

    private onReplyReady(messageIndex: number): void {
        const last = this.history[this.history.length - 1];
        if (last && last.messageIndex === undefined) last.messageIndex = messageIndex;
    }

    /* ---------------------------------------------------------------- report (after the send) */

    /** Builds the turn's report: budgets, lore rule results, duplicates and the P16 check. Exposed for tests. */
    finish(capture: PromptCapture, type: string): ArchitectReport {
        const settings = this.settings();
        const loreTurn = this.lore.latest();
        const loreLimit = settings.budgets.lore;
        const loreCut = Math.max(0, loreTurn.loreBefore - loreTurn.loreAfter);
        const loreStatus = !(loreLimit > 0)
            ? 'off'
            : !this.rulesActive()
              ? 'na'
              : loreTurn.cuts.length
                ? 'cut'
                : loreTurn.loreAfter > loreLimit
                  ? 'over'
                  : 'ok';
        const budgets: ArchitectReport['budgets'] = [
            { source: 'lore', limit: loreLimit, used: loreTurn.loreAfter, cut: loreCut, status: loreStatus },
            ...capture.budgets,
        ];

        let duplicates: DuplicateFact[] = [];
        try {
            if (settings.duplicates.detect) duplicates = this.detectDuplicates(capture);
            else {
                this.factKeys.clear();
                duplicates = this.consentedFacts(new Set());
            }
        } catch (error) {
            this.log.warn('duplicate facts could not be checked', error);
        }
        this.facts = duplicates;

        let order: ArchitectReport['order'] = [];
        try {
            order = this.checkOrder(capture, settings.cache.orderCheck);
        } catch (error) {
            this.log.debug('P16 check failed', error);
        }

        const dropped = [...loreTurn.dropped, ...capture.dropped];
        const effects: RuleEffect[] = [];
        if (settings.presence.damp || loreTurn.damped.length) {
            effects.push({ rule: 'damp', before: loreTurn.dampedTokens, after: 0, count: loreTurn.damped.length });
        }
        if (settings.presence.pin || loreTurn.pinned.length) {
            const added = loreTurn.pinned.reduce((sum, item) => sum + item.tokens, 0);
            effects.push({ rule: 'pin', before: 0, after: added, count: loreTurn.pinned.length });
        }
        if (loreLimit > 0) {
            effects.push({
                rule: 'loreBudget',
                before: loreTurn.loreBefore,
                after: loreTurn.loreAfter,
                count: loreTurn.cuts.length,
            });
        }
        for (const trim of capture.trims) {
            if (trim.source === 'ckRag' || trim.source === 'qvink' || trim.source === 'des') {
                effects.push({ rule: trim.source, before: trim.before, after: trim.after, count: trim.units });
            }
        }
        if (dropped.length) {
            const tokens = dropped.reduce((sum, item) => sum + item.tokens, 0);
            effects.push({ rule: 'dedup', before: tokens, after: 0, count: dropped.length });
        }

        const report: ArchitectReport = {
            at: capture.at,
            generationType: type,
            budgets,
            damped: loreTurn.damped,
            duplicates,
            pinned: loreTurn.pinned,
            cuts: loreTurn.cuts,
            trims: capture.trims,
            dropped,
            order,
            effects,
        };
        this.history.push(report);
        if (this.history.length > KEEP_REPORTS) this.history = this.history.slice(-KEEP_REPORTS);
        for (const listener of [...this.listeners]) {
            try {
                listener(report);
            } catch (error) {
                this.log.error('architect report listener failed', error);
            }
        }
        this.changed();
        return report;
    }

    /** Owner of a lore activation: the chat canon, a CK archive, or plain lore (its book is its group). */
    private loreSource(world: string, entry: Record<string, unknown>): { owner: string; group: string } | null {
        if (this.scene.isBunnyMoBook(world)) return null;
        if (this.scene.isCanonEntry(entry)) return { owner: 'canon', group: 'canon' };
        if (this.scene.isArchiveBook(world)) return { owner: 'ckArchive', group: `ckArchive:${world}` };
        return { owner: 'lore', group: `lore:${world}` };
    }

    private detectDuplicates(capture: PromptCapture): DuplicateFact[] {
        const sources: DupeSourceText[] = [];
        for (const item of capture.lore) {
            const owner = this.loreSource(item.world, item.entry);
            if (!owner || !item.content) continue;
            sources.push({
                owner: owner.owner,
                group: owner.group,
                ref: `${item.world}#${item.uid}`,
                text: item.content,
            });
        }
        for (const slot of capture.slots) {
            const owner = slotOwner(slot.key);
            if (SKIPPED_OWNERS.has(owner)) continue;
            sources.push({ owner, ref: slot.key, text: slot.value });
        }
        const groups = findDuplicateFacts(sources);
        this.factKeys.clear();
        const matched = new Set<string>();
        const facts: DuplicateFact[] = groups.map((group) => {
            this.factKeys.set(group.id, group.keys);
            const consent = this.consents.find(group.id, group.keys);
            if (consent) matched.add(consent.id);
            return {
                id: group.id,
                text: group.text,
                sources: group.members.map((member) => ({
                    owner: member.owner,
                    ref: member.ref,
                    tokens: member.tokens,
                })),
                keep: consent?.keep ?? null,
            };
        });
        return [...facts, ...this.consentedFacts(matched)];
    }

    /**
     * Facts deduplicated by consent no longer repeat (or are not looked for): they stay listed so the consent can
     * be withdrawn. `matched`: consents already shown with a detected fact.
     */
    private consentedFacts(matched: ReadonlySet<string>): DuplicateFact[] {
        const facts: DuplicateFact[] = [];
        for (const consent of this.consents.list()) {
            if (matched.has(consent.id) || this.factKeys.has(consent.id)) continue;
            this.factKeys.set(consent.id, consent.keys);
            facts.push({
                id: consent.id,
                text: consent.text,
                sources: consent.sources.map((source) => ({ ...source })),
                keep: consent.keep,
            });
        }
        return facts;
    }

    /** P16: Maestro's changing injections (`maestro_*` slots) must sit after content that did not change. */
    private checkOrder(capture: PromptCapture, enabled: boolean): NonNullable<ArchitectReport['order']> {
        if (!enabled) {
            this.previousPrompt = null;
            return [];
        }
        const hashes = hashMessages(capture.messages);
        const located: LocatedSlot[] = [];
        for (const slot of capture.slots) {
            if (!slot.key.startsWith('maestro_')) continue;
            const hit = findInMessages(
                capture.messages,
                slotNeedles(slot.value, (text) => this.substitute(text)),
            );
            if (hit) located.push({ key: slot.key, index: hit.message, position: slot.position, depth: slot.depth });
        }
        const previous =
            this.previousPrompt && this.previousPrompt.chatId === capture.chatId ? this.previousPrompt.hashes : null;
        this.previousPrompt = { chatId: capture.chatId, hashes: new Set(hashes) };
        return findOrderViolations(located, hashes, previous);
    }

    private substitute(text: string): string {
        try {
            return this.app.host.ctx().substituteParams(text);
        } catch {
            return text;
        }
    }

    /* ---------------------------------------------------------------- API */

    budgets(): SourceBudget[] {
        const budgets = this.settings().budgets;
        return BUDGET_SOURCES.map((source) => ({ source, tokens: budgets[source] }));
    }

    async setBudget(source: BudgetSource, tokens: number): Promise<void> {
        if (!BUDGET_SOURCES.includes(source)) return;
        this.settings().budgets[source] = cleanBudget(tokens);
        this.app.settings.save();
        this.app.settings.notify('m20.budgets');
        this.changed();
    }

    lastReport(): ArchitectReport | null {
        return this.history[this.history.length - 1] ?? null;
    }

    reports(): ArchitectReport[] {
        return [...this.history];
    }

    duplicates(): DuplicateFact[] {
        return this.facts.map((fact) => ({ ...fact, sources: fact.sources.map((source) => ({ ...source })) }));
    }

    async keepSource(duplicateId: string, owner: string | null): Promise<void> {
        const fact = this.facts.find((item) => item.id === duplicateId);
        const keys = this.factKeys.get(duplicateId);
        if (!fact || !keys) return;
        const previous = this.consents.find(duplicateId, keys) ?? null;
        let next: DuplicateConsent | null = null;
        let label = '';
        if (owner !== null) {
            const source =
                fact.sources.find((item) => item.ref === owner) ?? fact.sources.find((item) => item.owner === owner);
            if (!source) return;
            label = this.ownerName(source.owner);
            next = {
                id: duplicateId,
                keys: [...keys],
                text: fact.text,
                sources: fact.sources.map((item) => ({ ...item })),
                keep: source.ref,
                at: Date.now(),
            };
        }
        const t = (key: string, params?: Record<string, string | number>) => this.app.i18n.t(key, params);
        // The main text names the kind of source only («память Qvink», «лор»); books and entries go to «Подробнее».
        const sources = fact.sources.map((item) => this.sourceLabel(item.owner, item.ref)).join('; ');
        await this.app.autonomy.decide<ConsentPayload>(
            {
                module: ARCHITECT_ID,
                kind: CONSENT_KIND,
                title: next ? t('m20.dup.journal.keep', { source: label }) : t('m20.dup.journal.report'),
                description: t(next ? 'm20.dup.proposal.keep' : 'm20.dup.proposal.report'),
                details: t('m20.dup.details', { sources }),
                appliedNotice: {
                    text: next ? t('m20.dup.notice.keep', { source: label }) : t('m20.dup.notice.report'),
                },
                changes: [{ target: CONSENT_TARGET, ref: { id: duplicateId }, before: previous, after: next }],
                payload: { id: duplicateId, consent: next },
                apply: (payload) => this.applyConsent(payload),
            },
            'auto',
        );
    }

    private async applyConsent(payload: ConsentPayload): Promise<void> {
        await this.consents.save(payload.consent, payload.id);
        this.refreshKeeps();
    }

    /** Facts of the last report follow the stored consents. */
    private refreshKeeps(): void {
        this.facts = this.facts.map((fact) => ({
            ...fact,
            keep: this.consents.find(fact.id, this.factKeys.get(fact.id) ?? [])?.keep ?? null,
        }));
        this.changed();
    }

    /** «лор», «память Qvink» — the kind of source in words (no book or entry). */
    ownerName(owner: string): string {
        const ownerKey = `m20.owner.${owner}`;
        const name = this.app.i18n.t(ownerKey);
        return name === ownerKey ? owner : name;
    }

    /** «лор · Book #12», «память Qvink» — how a source is named in the UI. */
    sourceLabel(owner: string, ref: string): string {
        const name = this.ownerName(owner);
        if (owner === 'lore' || owner === 'ckArchive' || owner === 'canon') {
            const hash = ref.lastIndexOf('#');
            return hash > 0 ? `${name} · ${ref.slice(0, hash)} #${ref.slice(hash + 1)}` : name;
        }
        return name;
    }

    cache(): CacheStats {
        return this.meter.stats();
    }

    onReport(listener: (report: ArchitectReport) => void): Unsubscribe {
        this.listeners.add(listener);
        return () => this.listeners.delete(listener);
    }

    onCache(listener: () => void): Unsubscribe {
        return this.meter.onChange(listener);
    }

    /** Any change the tab shows (reports, consents, cache, settings). */
    onChange(listener: () => void): Unsubscribe {
        this.changeListeners.add(listener);
        return () => this.changeListeners.delete(listener);
    }

    changed(): void {
        for (const listener of [...this.changeListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('architect listener failed', error);
            }
        }
    }

    /** The public facade (internal helpers stay private to the module). */
    api(): ArchitectApi {
        return {
            budgets: () => this.budgets(),
            setBudget: (source, tokens) => this.setBudget(source, tokens),
            lastReport: () => this.lastReport(),
            duplicates: () => this.duplicates(),
            keepSource: (id, owner) => this.keepSource(id, owner),
            cache: () => this.cache(),
            onReport: (listener) => this.onReport(listener),
            reports: () => this.reports(),
            onCache: (listener) => this.onCache(listener),
        };
    }
}
