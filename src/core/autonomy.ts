// Autonomy levels and trust (plan §4.7, §8). Every change to user-visible data goes through decide():
// auto (apply + journal + a short «Сделал: …» notice with undo, grouped per kind within a turn), notify
// (badge/notice with an action), inbox (card), ask (modal), off.
// Decision statistics per kind feed trust growth: N accepted-without-edit in a row → offer "auto".
import type {
    Autonomy,
    AutonomyLevel,
    AutonomyStats,
    Decision,
    FileStore,
    I18n,
    Inbox,
    Journal,
    JournalRecord,
    Logger,
    Proposal,
    SettingsService,
    Ui,
    Unsubscribe,
} from '../shared/contracts';
import { readFresh } from './files';
import { kindLabel as humanKind, tPlural } from './labels';

type Outcome = 'accepted' | 'edited' | 'rejected' | 'undone';

export interface AutonomyDeps {
    settings: SettingsService;
    journal: Journal & { onUndone?(listener: (record: JournalRecord) => void): Unsubscribe };
    log: Logger;
    /** Where stats persist (`maestro-autonomy.json`); without it they live in memory only. */
    files?: FileStore;
}

export interface AutonomyOptions {
    /** Accepted-without-edit streak that triggers the "switch to auto" offer (plan §8: 5). */
    trustStreak?: number;
    saveDelayMs?: number;
}

export type AutonomyService = Autonomy & {
    bind(deps: { inbox: Inbox; ui: Ui; i18n: I18n }): void;
    /** Resolves when stored stats are loaded. */
    ready(): Promise<void>;
    /** Writes pending stats now. */
    flush(): Promise<void>;
    dispose(): void;
};

interface Counters {
    accepted: number;
    edited: number;
    rejected: number;
    undone: number;
    streak: number;
}

/** Changes since the last save; merged into the stored file so tabs do not overwrite each other's counts. */
interface Delta extends Counters {
    /** The streak was broken here: the stored streak is replaced, not extended. */
    reset: boolean;
}

interface StatsFile {
    schema: 1;
    stats: Record<string, Counters>;
}

const STATS_KIND = 'autonomy';
const TRUST_STREAK = 5;
const SAVE_DELAY_MS = 2_000;

function zero(): Counters {
    return { accepted: 0, edited: 0, rejected: 0, undone: 0, streak: 0 };
}

function zeroDelta(): Delta {
    return { ...zero(), reset: false };
}

function readCounters(value: unknown): Counters {
    const source = (value && typeof value === 'object' ? value : {}) as Partial<Record<keyof Counters, unknown>>;
    const num = (field: keyof Counters) => {
        const raw = source[field];
        return typeof raw === 'number' && Number.isFinite(raw) && raw >= 0 ? Math.floor(raw) : 0;
    };
    return {
        accepted: num('accepted'),
        edited: num('edited'),
        rejected: num('rejected'),
        undone: num('undone'),
        streak: num('streak'),
    };
}

function applyDelta(base: Counters, delta: Delta): Counters {
    return {
        accepted: base.accepted + delta.accepted,
        edited: base.edited + delta.edited,
        rejected: base.rejected + delta.rejected,
        undone: base.undone + delta.undone,
        streak: delta.reset ? delta.streak : base.streak + delta.streak,
    };
}

export function createAutonomy(deps: AutonomyDeps, options: AutonomyOptions = {}): AutonomyService {
    const { settings, journal, log, files } = deps;
    const trustStreak = options.trustStreak ?? TRUST_STREAK;
    const saveDelay = options.saveDelayMs ?? SAVE_DELAY_MS;
    const never = new Set<string>();
    /** Module default seen for each kind (trust growth needs the effective level outside decide()). */
    const fallbacks = new Map<string, AutonomyLevel>();
    const stats = new Map<string, Counters>();
    const deltas = new Map<string, Delta>();
    const fileName = files?.fileName(STATS_KIND);
    let bound: { inbox: Inbox; ui: Ui; i18n: I18n } | null = null;
    let saveTimer: ReturnType<typeof setTimeout> | null = null;
    let saving: Promise<void> = Promise.resolve();
    let badgeSeq = 0;

    const loaded: Promise<void> =
        files && fileName
            ? readFresh<StatsFile>(files, fileName)
                  .then((file) => {
                      const stored = file && typeof file.stats === 'object' && file.stats ? file.stats : {};
                      for (const [kind, value] of Object.entries(stored)) {
                          const base = readCounters(value);
                          const delta = deltas.get(kind);
                          stats.set(kind, delta ? applyDelta(base, delta) : base);
                      }
                  })
                  .catch((error: unknown) => log.warn('could not load autonomy stats', error))
            : Promise.resolve();

    const save = async (): Promise<void> => {
        if (!files || !fileName) return;
        await loaded;
        if (deltas.size === 0) return;
        const pending = new Map(deltas);
        deltas.clear();
        try {
            const file = await readFresh<StatsFile>(files, fileName);
            const merged: Record<string, Counters> = {};
            const stored = file && typeof file.stats === 'object' && file.stats ? file.stats : {};
            for (const [kind, value] of Object.entries(stored)) merged[kind] = readCounters(value);
            for (const [kind, delta] of pending) merged[kind] = applyDelta(merged[kind] ?? zero(), delta);
            await files.write(fileName, { schema: 1, stats: merged } satisfies StatsFile);
            // Adopt other tabs' counts, keeping changes recorded while this save was in flight.
            for (const [kind, counters] of Object.entries(merged)) {
                const later = deltas.get(kind);
                stats.set(kind, later ? applyDelta(counters, later) : counters);
            }
        } catch (error) {
            log.warn('could not save autonomy stats', error);
            for (const [kind, delta] of pending) {
                const later = deltas.get(kind);
                deltas.set(kind, later ? mergeDeltas(delta, later) : delta);
            }
        }
    };

    const flush = (): Promise<void> => {
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = null;
        saving = saving.then(save, save);
        return saving;
    };

    const scheduleSave = () => {
        if (!files) return;
        if (saveTimer !== null) clearTimeout(saveTimer);
        saveTimer = setTimeout(() => void flush(), saveDelay);
    };

    const level = (kind: string, fallback: AutonomyLevel): AutonomyLevel => {
        const stored = settings.core().autonomy[kind];
        const value = stored ?? fallback;
        if (value === 'auto' && never.has(kind)) return fallback === 'auto' ? 'ask' : fallback;
        return value;
    };

    const kindLabel = (kind: string): string => (bound ? (humanKind(bound.i18n, kind) ?? kind) : kind);

    const offerPromotion = (kind: string) => {
        if (!bound || never.has(kind)) return;
        const current = level(kind, fallbacks.get(kind) ?? 'inbox');
        if (current !== 'inbox' && current !== 'notify') return;
        const { ui, i18n } = bound;
        const label = kindLabel(kind);
        ui.notice(i18n.t('core.autonomy.promote', { kind: label, count: trustStreak }), {
            importance: 'important',
            level: 'info',
            action: {
                label: i18n.t('core.autonomy.promoteAction'),
                run: () => {
                    if (never.has(kind)) return;
                    settings.core().autonomy[kind] = 'auto';
                    settings.save();
                    settings.notify(`core.autonomy.${kind}`);
                    // A reply to the user's own click: always shown.
                    ui.notice(i18n.t('core.autonomy.promoted', { kind: label }), { importance: 'urgent' });
                },
            },
        });
    };

    const record = (kind: string, outcome: Outcome): void => {
        const current = stats.get(kind) ?? zero();
        const delta = deltas.get(kind) ?? zeroDelta();
        current[outcome]++;
        delta[outcome]++;
        if (outcome === 'accepted') {
            current.streak++;
            delta.streak++;
        } else {
            current.streak = 0;
            delta.streak = 0;
            delta.reset = true;
        }
        stats.set(kind, current);
        deltas.set(kind, delta);
        scheduleSave();
        if (outcome === 'accepted' && current.streak === trustStreak) offerPromotion(kind);
    };

    /** Validates, applies and journals a proposal; false when it was not applied, else the journal id ('' if none). */
    const applyNow = async <T>(proposal: Proposal<T>, quiet: boolean): Promise<string | false> => {
        try {
            if (proposal.stillValid && !(await proposal.stillValid())) {
                log.info(`${proposal.kind}: proposal is out of date; skipped`);
                if (!quiet && bound) bound.ui.notice(bound.i18n.t('core.autonomy.stale'), { level: 'warn' });
                return false;
            }
            await proposal.apply(proposal.payload);
        } catch (error) {
            log.error(`${proposal.kind}: apply failed`, error);
            if (bound) {
                bound.ui.notice(bound.i18n.t('core.autonomy.failed', { title: proposal.title }), { level: 'error' });
            }
            return false;
        }
        try {
            return await journal.record({
                module: proposal.module,
                kind: proposal.kind,
                summary: proposal.title,
                changes: proposal.changes,
                sourceMessage: proposal.sourceMessage,
            });
        } catch (error) {
            log.error(`${proposal.kind}: applied but not journaled`, error);
            return '';
        }
    };

    /** «Сделал: …» after an automatic action, with undo through the journal; grouped per kind within a turn. */
    const announceApplied = <T>(proposal: Proposal<T>, recordId: string): void => {
        if (!bound) return;
        const { ui, i18n } = bound;
        const custom = proposal.appliedNotice;
        const label = humanKind(i18n, proposal.kind);
        const title = proposal.title;
        const undo = async () => {
            const ok = await journal.undo(recordId);
            ui.notice(i18n.t(ok ? 'core.autonomy.undone' : 'core.autonomy.undoFailed', { title }), {
                level: ok ? 'info' : 'warn',
                importance: ok ? 'info' : 'important',
            });
        };
        ui.notice(custom?.text ?? i18n.t('core.autonomy.done', { title }), {
            importance: 'info',
            level: 'info',
            group: custom?.group ?? `autonomy.auto:${proposal.kind}`,
            groupText:
                custom?.groupText ??
                ((count) =>
                    label
                        ? tPlural(i18n, 'core.autonomy.doneMany', count, { kind: label })
                        : tPlural(i18n, 'core.autonomy.doneManyPlain', count)),
            action: recordId ? { label: i18n.t('core.autonomy.undo'), run: () => void undo() } : undefined,
        });
    };

    const notify = <T>(proposal: Proposal<T>, ui: Ui, i18n: I18n): Decision => {
        let off: Unsubscribe | null = null;
        let done = false;
        const run = () => {
            if (done) return;
            done = true;
            off?.();
            void applyNow(proposal, false).then((id) => {
                if (id !== false) record(proposal.kind, 'accepted');
            });
        };
        const action = { label: i18n.t('core.autonomy.apply'), run };
        if (proposal.sourceMessage !== undefined) {
            off = ui.messageBadge(proposal.sourceMessage, {
                id: `maestro-autonomy-${++badgeSeq}`,
                text: proposal.title,
                action,
            });
        } else {
            ui.notice(proposal.title, { action, importance: 'important' });
        }
        return 'notified';
    };

    const offUndone = journal.onUndone?.((entry) => record(entry.kind, 'undone')) ?? (() => {});

    return {
        level,

        async decide<T>(proposal: Proposal<T>, fallback: AutonomyLevel): Promise<Decision> {
            fallbacks.set(proposal.kind, fallback);
            let chosen = level(proposal.kind, fallback);
            if ((chosen === 'notify' || chosen === 'ask') && !bound) {
                log.warn(`${proposal.kind}: UI is not ready; treating '${chosen}' as 'inbox'`);
                chosen = 'inbox';
            }
            switch (chosen) {
                case 'off':
                    return 'skipped';
                case 'auto': {
                    const id = await applyNow(proposal, true);
                    if (id === false) return 'skipped';
                    announceApplied(proposal, id);
                    return 'applied';
                }
                case 'notify':
                    return bound ? notify(proposal, bound.ui, bound.i18n) : 'skipped';
                case 'inbox':
                    if (!bound) {
                        log.warn(`${proposal.kind}: Inbox is not ready; proposal skipped`);
                        return 'skipped';
                    }
                    await bound.inbox.add(proposal as Proposal);
                    return 'queued';
                case 'ask': {
                    if (!bound) return 'skipped';
                    const yes = await bound.ui.confirm(
                        proposal.title,
                        proposal.description ?? '',
                        proposal.details ? { details: proposal.details } : undefined,
                    );
                    if (!yes) {
                        record(proposal.kind, 'rejected');
                        return 'rejected';
                    }
                    if ((await applyNow(proposal, false)) === false) return 'skipped';
                    record(proposal.kind, 'accepted');
                    return 'applied';
                }
            }
        },

        record,

        stats(): AutonomyStats[] {
            return [...stats.entries()].map(([kind, counters]) => ({ kind, ...counters }));
        },

        neverAuto(kind: string): void {
            never.add(kind);
        },

        isNeverAuto(kind: string): boolean {
            return never.has(kind);
        },

        setLevel(kind: string, next: AutonomyLevel): boolean {
            if (next === 'auto' && never.has(kind)) return false;
            settings.core().autonomy[kind] = next;
            settings.save();
            settings.notify(`core.autonomy.${kind}`);
            return true;
        },

        bind(next: { inbox: Inbox; ui: Ui; i18n: I18n }): void {
            bound = next;
        },

        ready: () => loaded,

        flush,

        dispose(): void {
            offUndone();
            if (saveTimer !== null) void flush();
        },
    };
}

function mergeDeltas(first: Delta, second: Delta): Delta {
    return {
        accepted: first.accepted + second.accepted,
        edited: first.edited + second.edited,
        rejected: first.rejected + second.rejected,
        undone: first.undone + second.undone,
        streak: second.reset ? second.streak : first.streak + second.streak,
        reset: first.reset || second.reset,
    };
}
