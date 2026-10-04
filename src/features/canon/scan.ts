// M6 «Канон чата» — mixing the canon into ST's World Info scan (plan M6 п. 3–7, §5 step 2; audit T1, B4).
//
// - WORLDINFO_ENTRIES_LOADED, registered FIRST: the canon must be in place before M22's rules and DES-RU's patched
//   copies see the entries. Canon books found in the lists are stripped (a canon book is never active by itself;
//   a warning tells the user once), then additions, overrides (replaced in place), suppressions and pins are
//   applied by src/domain/canon-inject.ts. The event fires several times per generation and for dry runs, so the
//   handler is idempotent and cheap (the canon book is cached until ST reports it saved).
// - WORLDINFO_SCAN_DONE, registered first as well: in the first loop pinned base entries are forced into
//   `activated.entries`; after every loop canon activations above the canon budget are removed and marked `disable`
//   on their sortedEntries copies (ST's structured clone, safe to mark), so later loops cannot bring them back.
import {
    activationKey,
    applyCanon,
    isCanonActivation,
    itemKeys,
    keysMentioned,
    listsOf,
    planCanonBudget,
    recentText,
    stripCanonBooks,
} from '../../domain/canon-inject';
import type { BudgetCandidate, InjectResult } from '../../domain/canon-inject';
import { isDict } from '../../domain/canon-book';
import type { App, Logger, Unsubscribe } from '../../shared/contracts';
import type { LoreJournalApi } from '../loreJournal/api';
import type { CanonScanReport } from './api';
import type { CanonGlosses } from './glosses';
import type { CanonStore } from './store';

type Dict = Record<string, unknown>;

export interface CanonSettings {
    /** Most characters of canon entries per turn (plan M6 п. 7, audit B4); 0 = no limit. */
    budgetChars: number;
    /** Scan-only English names for Russian mentions (M20 п. 5). */
    scanGlosses: boolean;
    /** Messages the glosses look at. */
    glossMessages: number;
}

export function defaultCanonSettings(): CanonSettings {
    return { budgetChars: 8000, scanGlosses: true, glossMessages: 6 };
}

/** Archived items come back when their keys appear in this many last messages. */
const MENTION_MESSAGES = 2;
const LORE_JOURNAL_KEY = 'loreJournal';

function strings(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [];
}

interface ScanState {
    sorted: unknown;
    accepted: Set<string>;
    pinned: Set<string>;
    used: number;
    cut: number;
}

export class CanonScan {
    private pins: string[] = [];
    private scan: ScanState | null = null;
    private pending: InjectResult | null = null;
    private report: CanonScanReport | null = null;
    private usedChars = 0;
    private readonly warned = new Set<string>();
    private readonly reportListeners = new Set<() => void>();

    constructor(
        private readonly app: App,
        private readonly store: CanonStore,
        private readonly settings: () => CanonSettings,
        private readonly glosses: CanonGlosses | null,
        private readonly log: Logger,
    ) {}

    install(): Unsubscribe[] {
        const offs: Unsubscribe[] = [];
        const { host } = this.app;
        const on = (key: string, handler: (...args: unknown[]) => unknown) => {
            const name = host.events.name(key);
            if (!name) {
                this.log.warn(`ST event ${key} is missing; the chat canon is not mixed in`);
                return;
            }
            offs.push(host.events.on(name, handler, { order: 'first' }));
        };
        on('WORLDINFO_ENTRIES_LOADED', (payload) => this.onEntriesLoaded(payload));
        on('WORLDINFO_SCAN_DONE', (args) => this.onScanDone(args));
        return offs;
    }

    budget(): { limitChars: number; usedChars: number } {
        return { limitChars: Math.max(0, this.settings().budgetChars || 0), usedChars: this.usedChars };
    }

    lastScan(): CanonScanReport | null {
        return this.report ? { ...this.report } : null;
    }

    /** Called after every real scan (the pult redraws its budget bar). */
    onReport(listener: () => void): Unsubscribe {
        this.reportListeners.add(listener);
        return () => this.reportListeners.delete(listener);
    }

    private lore(): LoreJournalApi | undefined {
        return this.app.modules.api<LoreJournalApi>(LORE_JOURNAL_KEY);
    }

    private simulating(): boolean {
        return this.lore()?.simulating() === true;
    }

    /* ---------------------------------------------------------------- ENTRIES_LOADED */

    async onEntriesLoaded(payload: unknown): Promise<void> {
        const lists = listsOf(payload);
        if (!lists) return;
        const real = !this.simulating();
        if (this.glosses && this.settings().scanGlosses) this.glosses.collectLocalizer(lists);
        const stray = stripCanonBooks(lists);
        if (real) this.warnActive(stray);
        const book = this.store.bookName();
        if (!book) {
            this.pins = [];
            return;
        }
        const state = this.store.peek(book) ?? (await this.store.state(book));
        if (!state.items.length) {
            this.pins = [];
            if (real) this.pending = null;
            return;
        }
        let recent: string | null = null;
        const text = () => (recent ??= recentText(this.app.host.ctx().chat ?? [], MENTION_MESSAGES));
        const result = applyCanon(lists, state.items, {
            canonBook: book,
            mentioned: (item, base) =>
                keysMentioned(itemKeys(item), text()) ||
                (base ? keysMentioned([...strings(base.key), ...strings(base.keysecondary)], text()) : false),
            pinActive: (item) => !!item.meta.pinWhen && keysMentioned([item.meta.pinWhen], text()),
            // Provisional facts of the living canon act only while M26 runs (P11: a disabled module leaves no trace).
            silentProvisional: this.app.modules.api('livingCanon') ? [] : ['living'],
        });
        this.pins = result.pins;
        if (real) this.pending = result;
    }

    private warnActive(books: string[]): void {
        for (const book of books) {
            if (this.warned.has(book)) continue;
            this.warned.add(book);
            this.log.warn(`canon book ${book} is active in ST; its entries are left out of the scan`);
            this.app.ui.notice(this.app.i18n.t('m6.warn.active', { book }), { urgent: true, level: 'warn' });
        }
    }

    /* ---------------------------------------------------------------- SCAN_DONE */

    onScanDone(args: unknown): void {
        if (!isDict(args)) return;
        const book = this.store.bookName();
        const activated = isDict(args.activated) ? args.activated.entries : undefined;
        if (!book || !(activated instanceof Map)) return;
        const state = isDict(args.state) ? args.state : {};
        const loop = typeof state.loopCount === 'number' && state.loopCount > 0 ? state.loopCount : 1;
        const sorted: unknown[] = Array.isArray(args.sortedEntries) ? args.sortedEntries : [];
        let scan = this.scan;
        if (loop <= 1 || !scan || scan.sorted !== args.sortedEntries) {
            scan = { sorted: args.sortedEntries, accepted: new Set(), pinned: new Set(), used: 0, cut: 0 };
            this.scan = scan;
        }
        const map = activated as Map<unknown, unknown>;
        if (loop <= 1) this.forcePins(map, sorted, scan);
        this.applyBudget(map, sorted, scan, book);
        if (Number(state.next) === 0 && !this.simulating()) this.finish(scan);
    }

    /** Pinned base entries join the first loop's activations (the sortedEntries object, with macros resolved). */
    private forcePins(activated: Map<unknown, unknown>, sorted: unknown[], scan: ScanState): void {
        for (const key of this.pins) {
            if (activated.has(key)) continue;
            const entry = sorted.find((item) => isDict(item) && activationKey(item.world, item.uid) === key);
            if (!isDict(entry)) continue;
            if (typeof entry.content === 'string') {
                try {
                    entry.content = this.app.host.ctx().substituteParams(entry.content);
                } catch (error) {
                    this.log.debug('macros of a pinned entry were not substituted', error);
                }
            }
            activated.set(key, entry);
            scan.pinned.add(key);
        }
    }

    private applyBudget(activated: Map<unknown, unknown>, sorted: unknown[], scan: ScanState, book: string): void {
        const limit = this.budget().limitChars;
        const items = this.store.peek(book)?.items ?? [];
        const updated = new Map(items.map((item) => [item.uid, item.meta.updatedAt]));
        const candidates: BudgetCandidate[] = [];
        const byKey = new Map<string, Dict>();
        for (const [rawKey, entry] of activated) {
            const key = String(rawKey);
            if (scan.accepted.has(key) || scan.pinned.has(key) || !isCanonActivation(entry, book)) continue;
            const copy = entry as Dict;
            const marker = isDict(copy.extensions) && isDict(copy.extensions.maestro) ? copy.extensions.maestro : {};
            const uid = copy.world === book ? Number(copy.uid) : Number(marker.canonUid);
            byKey.set(key, copy);
            candidates.push({
                key,
                chars: typeof copy.content === 'string' ? copy.content.length : 0,
                order: Number(copy.order) || 0,
                updatedAt: updated.get(uid) ?? 0,
            });
        }
        if (!candidates.length) return;
        const plan = planCanonBudget(scan.used, candidates, limit);
        for (const key of plan.keep) scan.accepted.add(key);
        scan.used = plan.used;
        const lore = this.lore();
        for (const key of plan.cut) {
            const entry = byKey.get(key);
            if (!entry) continue;
            activated.delete(key);
            entry.disable = true;
            // Force-activated entries are other objects than their sortedEntries twin.
            if (!sorted.includes(entry)) {
                const twin = sorted.find((item) => isDict(item) && activationKey(item.world, item.uid) === key);
                if (isDict(twin)) twin.disable = true;
            }
            scan.cut++;
            lore?.markCut?.(String(entry.world), Number(entry.uid));
        }
    }

    private finish(scan: ScanState): void {
        this.usedChars = scan.used;
        const pending = this.pending;
        this.report = {
            at: Date.now(),
            added: pending?.added ?? 0,
            replaced: pending?.replaced ?? 0,
            suppressed: pending?.suppressed ?? 0,
            pinned: scan.pinned.size,
            dormant: pending?.dormant ?? 0,
            missing: pending?.missing ?? 0,
            cut: scan.cut,
        };
        for (const listener of [...this.reportListeners]) {
            try {
                listener();
            } catch (error) {
                this.log.error('canon scan listener failed', error);
            }
        }
    }
}
